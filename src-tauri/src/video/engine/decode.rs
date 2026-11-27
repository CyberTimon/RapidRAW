use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, sync_channel};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::render::gpu::compute::Slot;
use crate::render::gpu::context::shared_gpu_context;
use crate::video::camera_log::CameraLog;
use crate::video::ffmpeg::MediaInfo;
use crate::video::frames::{FrameRange, FrameReader, PendingFrame};
use crate::video::gpu::PlaneUploads;
use crate::video::libav::video::Demand;
use crate::video::timelapse::Deflicker;

use super::flow::Frame;

const PREFETCH_FRAMES: usize = 3;
const MAX_SKIP_FRAMES: u64 = 90;
const STREAMS_PER_KEY: usize = 2;
const MAX_REACH: u64 = 4;
pub const SOURCE_REACH: u64 = 2;
const ON_FRAME: f64 = 1.0e-4;
const SAME_FRAME: f64 = 0.01;
const CANCEL_POLL: Duration = Duration::from_millis(5);

pub const PREEMPTED: &str = "Frame wait preempted";

#[derive(PartialEq, Debug)]
pub struct FramePlan {
    runs: Vec<(u64, u64)>,
}

impl FramePlan {
    pub fn new(frames: impl IntoIterator<Item = u64>, margin: u64) -> Self {
        let mut frames: Vec<u64> = frames.into_iter().collect();
        frames.sort_unstable();
        frames.dedup();
        let mut runs: Vec<(u64, u64)> = Vec::new();
        for frame in frames {
            let (start, end) = (frame.saturating_sub(margin), frame.saturating_add(margin));
            match runs.last_mut() {
                Some(last) if start <= last.1.saturating_add(1) => last.1 = last.1.max(end),
                _ => runs.push((start, end)),
            }
        }
        Self { runs }
    }

    pub fn keeps(&self, index: u64) -> bool {
        self.runs
            .get(self.runs.partition_point(|run| run.1 < index))
            .is_some_and(|run| run.0 <= index)
    }

    fn ends_before(&self, index: u64) -> bool {
        self.runs.last().is_none_or(|run| run.1 < index)
    }

    fn first_from(&self, index: u64) -> Option<u64> {
        self.runs
            .get(self.runs.partition_point(|run| run.1 < index))
            .map(|run| run.0.max(index))
    }

    fn last_through(&self, index: u64) -> Option<u64> {
        let after = self.runs.partition_point(|run| run.0 <= index);
        after
            .checked_sub(1)
            .map(|position| self.runs[position].1.min(index))
    }

    fn same(theirs: Option<&Arc<Self>>, ours: Option<&Arc<Self>>) -> bool {
        match (theirs, ours) {
            (None, None) => true,
            (Some(theirs), Some(ours)) => Arc::ptr_eq(theirs, ours) || theirs == ours,
            _ => false,
        }
    }
}

#[derive(Clone)]
pub struct StreamRequest<'a> {
    pub path: &'a Path,
    pub info: &'a MediaInfo,
    pub source_time: f64,
    pub speed: f64,
    pub fps: f64,
    pub size: (u32, u32),
    pub hwaccel: bool,
    pub preview: bool,
    pub reach: u64,
    pub plan: Option<Arc<FramePlan>>,
}

impl<'a> StreamRequest<'a> {
    pub fn reach_for(info: &MediaInfo, speed: f64, fps: f64) -> u64 {
        if info.fps > 0.0 {
            ((fps / (speed * info.fps)).ceil() as u64).clamp(1, MAX_REACH)
        } else {
            1
        }
    }

    pub fn source_index(info: &MediaInfo, time: f64) -> u64 {
        (time.max(0.0) * info.fps + ON_FRAME).floor() as u64
    }

    pub fn bracket_frames(index: u64) -> impl Iterator<Item = u64> {
        index..=index + SOURCE_REACH
    }

    pub fn source_frames(
        path: &'a Path,
        info: &'a MediaInfo,
        time: f64,
        size: (u32, u32),
        hwaccel: bool,
        preview: bool,
    ) -> (Self, u64) {
        let index = Self::source_index(info, time);
        let request = Self {
            path,
            info,
            source_time: index as f64 / info.fps,
            speed: 1.0,
            fps: info.fps,
            size,
            hwaccel,
            preview,
            reach: SOURCE_REACH,
            plan: None,
        };
        (request, index)
    }

    pub fn planned(self, plan: Option<Arc<FramePlan>>) -> Self {
        Self { plan, ..self }
    }

    fn step(&self) -> f64 {
        self.speed / self.fps
    }
}

#[derive(Clone)]
pub struct Neighbour {
    pub slot: Slot,
    pub key: u64,
    pub gap: f64,
}

impl Neighbour {
    pub fn frame(&self) -> Frame<'_> {
        Frame {
            key: self.key,
            slot: &self.slot,
        }
    }
}

pub struct Neighbours {
    pub stream: u64,
    pub key: u64,
    pub previous: Option<Neighbour>,
    pub next: Option<Neighbour>,
}

pub struct Bracket {
    pub stream: u64,
    pub before: Neighbour,
    pub after: Option<Neighbour>,
}

pub struct Picture {
    pub slot: Slot,
    pub source: Option<f64>,
}

struct Decoded {
    index: u64,
    slot: Slot,
    source: Option<f64>,
}

impl Decoded {
    fn key(&self) -> u64 {
        self.source.map_or(self.index, f64::to_bits)
    }
}

enum Delivered {
    Converted(Slot, Option<f64>),
    Pending(PendingFrame),
}

impl Delivered {
    fn slot(self, uploads: &mut PlaneUploads) -> Option<(Slot, Option<f64>)> {
        match self {
            Delivered::Converted(slot, source) => Some((slot, source)),
            Delivered::Pending(pending) => {
                let source = pending.source_time();
                pending.slot(uploads).map(|slot| (slot, source))
            }
        }
    }
}

enum Produced {
    Frame(u64, Delivered),
    Skipped(u64),
    Failed(String),
    End,
}

pub struct FrameStream {
    id: u64,
    path: PathBuf,
    size: (u32, u32),
    speed_bits: u64,
    fps_bits: u64,
    log: Option<CameraLog>,
    deflicker: Option<Deflicker>,
    preview: bool,
    origin: f64,
    offset: i64,
    next_frame: u64,
    floor: u64,
    wanted: Arc<AtomicU64>,
    tick: Arc<AtomicU64>,
    frames: Receiver<Produced>,
    uploads: PlaneUploads,
    history: VecDeque<Decoded>,
    plan: Option<Arc<FramePlan>>,
}

fn demand(
    anchor: f64,
    step: f64,
    frame: f64,
    wanted: Arc<AtomicU64>,
    plan: Option<Arc<FramePlan>>,
) -> Option<Demand> {
    if !frame.is_finite() || frame <= 0.0 || step < 0.5 * frame {
        return None;
    }
    Some(Box::new(move |time| {
        let slot = |edge: f64| ((edge - anchor) / step - 0.5).floor();
        let (low, high) = (slot(time - frame) + 1.0, slot(time + 2.0 * frame));
        if high < 0.0 {
            return false;
        }
        let from = (low.max(0.0) as u64).max(wanted.load(Ordering::Relaxed));
        (from..=high as u64).any(|index| plan.as_ref().is_none_or(|plan| plan.keeps(index)))
    }))
}

fn origin(request: &StreamRequest, frame: u64) -> f64 {
    request.source_time - frame as f64 * request.step()
}

impl FrameStream {
    fn open(request: &StreamRequest, frame: u64, id: u64) -> Self {
        let step = request.step();
        let back = request
            .reach
            .min(frame)
            .min((request.source_time / step + 1e-6).floor() as u64);
        let first = frame - back;
        let range = FrameRange {
            start: (request.source_time - back as f64 * step).max(0.0),
            speed: request.speed,
            fps: Some(request.fps),
            frames: None,
            size: Some(request.size),
            hwaccel: request.hwaccel,
            preview: request.preview,
            keyframe: false,
        };
        let (path, info) = (request.path.to_path_buf(), request.info.clone());
        let anchor = origin(request, frame);
        let wanted = Arc::new(AtomicU64::new(first));
        let skip_before = Arc::clone(&wanted);
        let tick = Arc::new(AtomicU64::new(0));
        let source_tick = Arc::clone(&tick);
        let (sender, frames) = sync_channel(PREFETCH_FRAMES);
        let deferred = shared_gpu_context().is_ok_and(|context| context.shares_one_gl_context());
        let plan = request.plan.clone();
        let keeps = plan.clone();
        let demand = (!info.variable_frame_rate)
            .then(|| {
                demand(
                    anchor,
                    step,
                    1.0 / info.fps,
                    Arc::clone(&wanted),
                    plan.clone(),
                )
            })
            .flatten();
        std::thread::spawn(move || {
            let mut reader = match FrameReader::open_at(&path, &info, &range, anchor) {
                Ok(reader) => reader,
                Err(error) => {
                    let _ = sender.send(Produced::Failed(error));
                    return;
                }
            };
            if let Some(demand) = demand {
                reader.demand(demand);
            }
            source_tick.store(reader.source_tick().to_bits(), Ordering::Relaxed);
            for index in first.. {
                if keeps.as_ref().is_some_and(|plan| plan.ends_before(index)) {
                    break;
                }
                let unplanned = keeps.as_ref().is_some_and(|plan| !plan.keeps(index));
                let produced = if unplanned || index < skip_before.load(Ordering::Relaxed) {
                    match (reader.skip_frame(), unplanned) {
                        (false, _) => Produced::End,
                        (true, true) => continue,
                        (true, false) => Produced::Skipped(index),
                    }
                } else if deferred {
                    reader.next_pending().map_or(Produced::End, |pending| {
                        Produced::Frame(index, Delivered::Pending(pending))
                    })
                } else {
                    reader.next_slot().map_or(Produced::End, |slot| {
                        Produced::Frame(index, Delivered::Converted(slot, reader.source_time()))
                    })
                };
                let done = matches!(produced, Produced::End);
                if sender.send(produced).is_err() || done {
                    break;
                }
            }
        });
        Self {
            id,
            path: request.path.to_path_buf(),
            size: request.size,
            speed_bits: request.speed.to_bits(),
            fps_bits: request.fps.to_bits(),
            log: request.info.color.log,
            deflicker: request.info.deflicker.clone(),
            preview: request.preview,
            origin: anchor,
            offset: 0,
            next_frame: first,
            floor: if back < request.reach.min(frame) {
                first
            } else {
                0
            },
            wanted,
            tick,
            frames,
            uploads: PlaneUploads::default(),
            history: VecDeque::new(),
            plan,
        }
    }

    fn serves(&self, index: u64, reach: u64) -> bool {
        let Some(plan) = &self.plan else {
            return index >= self.earliest(reach);
        };
        let front = self
            .history
            .front()
            .map_or(self.next_frame, |decoded| decoded.index);
        plan.keeps(index)
            && index >= front
            && (front <= self.floor
                || plan
                    .first_from(index.saturating_sub(reach))
                    .is_none_or(|first| first >= front))
    }

    fn earliest(&self, reach: u64) -> u64 {
        if reach == 0 {
            return self.next_frame.saturating_sub(1);
        }
        let front = self
            .history
            .front()
            .map_or(self.next_frame, |decoded| decoded.index);
        if front <= self.floor {
            front
        } else {
            front + reach
        }
    }

    fn index_for(&self, request: &StreamRequest, frame: u64, aligned: bool) -> Option<u64> {
        let same = self.path == request.path
            && self.size == request.size
            && self.speed_bits == request.speed.to_bits()
            && self.fps_bits == request.fps.to_bits()
            && self.log == request.info.color.log
            && self.deflicker == request.info.deflicker
            && self.preview == request.preview
            && FramePlan::same(self.plan.as_ref(), request.plan.as_ref());
        if !same {
            return None;
        }
        let exact = (request.source_time - self.origin) / request.step();
        let index = if aligned {
            let index = exact.round();
            ((exact - index).abs() < SAME_FRAME && index >= 0.0).then_some(index as u64)?
        } else {
            frame
                .checked_add_signed(self.offset)
                .filter(|index| (exact - *index as f64).abs() < 0.5)?
        };
        (self.serves(index, request.reach)
            && index < self.next_frame.saturating_add(MAX_SKIP_FRAMES))
        .then_some(index)
    }

    fn receive(&self, cancel: Option<&AtomicBool>) -> Result<Option<Produced>, String> {
        let Some(cancel) = cancel else {
            return Ok(self.frames.recv().ok());
        };
        loop {
            match self.frames.recv_timeout(CANCEL_POLL) {
                Ok(produced) => return Ok(Some(produced)),
                Err(RecvTimeoutError::Disconnected) => return Ok(None),
                Err(RecvTimeoutError::Timeout) if cancel.load(Ordering::Relaxed) => {
                    return Err(PREEMPTED.to_string());
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn read(
        &mut self,
        frame: u64,
        reach: u64,
        cancel: Option<&AtomicBool>,
    ) -> Result<Option<Picture>, String> {
        let kept = 2 * reach as usize + 1;
        self.wanted
            .fetch_max(frame - reach.min(frame), Ordering::Relaxed);
        let last = match &self.plan {
            Some(plan) => plan.last_through(frame + reach),
            None => Some(frame + reach),
        };
        while last.is_some_and(|last| self.next_frame <= last) {
            match self.receive(cancel)? {
                Some(Produced::Frame(index, delivered)) => {
                    let Some((slot, source)) = delivered.slot(&mut self.uploads) else {
                        self.next_frame = u64::MAX;
                        break;
                    };
                    self.history.push_back(Decoded {
                        index,
                        slot,
                        source,
                    });
                    if self.history.len() > kept {
                        self.history.pop_front();
                    }
                    self.next_frame = index + 1;
                }
                Some(Produced::Skipped(index)) => {
                    self.history.clear();
                    self.next_frame = index + 1;
                }
                Some(Produced::Failed(error)) => return Err(error),
                Some(Produced::End) | None => {
                    self.next_frame = u64::MAX;
                    break;
                }
            }
        }
        Ok(self
            .history
            .iter()
            .rev()
            .find(|decoded| decoded.index <= frame)
            .map(|decoded| Picture {
                slot: decoded.slot.clone(),
                source: decoded.source,
            }))
    }

    fn neighbours(&self, frame: u64, step: f64) -> Option<Neighbours> {
        let current = self.history.iter().find(|decoded| decoded.index == frame)?;
        let distinct = |decoded: &&Decoded| match (decoded.source, current.source) {
            (Some(theirs), Some(ours)) => theirs != ours,
            _ => true,
        };
        let neighbour = |decoded: &Decoded| Neighbour {
            slot: decoded.slot.clone(),
            key: decoded.key(),
            gap: match (decoded.source, current.source) {
                (Some(theirs), Some(ours)) => (theirs - ours).abs(),
                _ => decoded.index.abs_diff(frame) as f64 * step,
            },
        };
        Some(Neighbours {
            stream: self.id,
            key: current.key(),
            previous: self
                .history
                .iter()
                .rev()
                .filter(|decoded| decoded.index < frame)
                .find(distinct)
                .map(neighbour),
            next: self
                .history
                .iter()
                .filter(|decoded| decoded.index > frame)
                .find(distinct)
                .map(neighbour),
        })
    }

    fn bracket(&self, time: f64, step: f64) -> Option<Bracket> {
        let at = |decoded: &Decoded| {
            decoded
                .source
                .unwrap_or(self.origin + decoded.index as f64 * step)
        };
        let slack =
            (0.5 * f64::from_bits(self.tick.load(Ordering::Relaxed))).max(SAME_FRAME * step);
        let earlier = |a: &&Decoded, b: &&Decoded| at(a).total_cmp(&at(b));
        let neighbour = |decoded: &Decoded| Neighbour {
            slot: decoded.slot.clone(),
            key: decoded.key(),
            gap: (at(decoded) - time).abs(),
        };
        let before = self
            .history
            .iter()
            .filter(|decoded| at(decoded) <= time + slack)
            .max_by(earlier)
            .or_else(|| self.history.iter().min_by(earlier))?;
        Some(Bracket {
            stream: self.id,
            before: neighbour(before),
            after: self
                .history
                .iter()
                .filter(|decoded| at(decoded) > time + slack)
                .min_by(earlier)
                .filter(|_| at(before) < time - slack)
                .map(neighbour),
        })
    }
}

#[derive(Default)]
pub struct Decoders {
    streams: HashMap<String, Vec<FrameStream>>,
    warming: bool,
    warmed: HashSet<String>,
    touched: HashSet<String>,
    opened: u64,
    cancel: Option<Arc<AtomicBool>>,
}

impl Decoders {
    pub fn frame(
        &mut self,
        key: &str,
        request: &StreamRequest,
        frame: u64,
    ) -> Result<Option<Picture>, String> {
        let unplanned;
        let request = if request.plan.as_ref().is_some_and(|plan| !plan.keeps(frame)) {
            unplanned = request.clone().planned(None);
            &unplanned
        } else {
            request
        };
        let streams = self.streams.entry(key.to_string()).or_default();
        let found = streams.iter().enumerate().find_map(|(position, stream)| {
            stream
                .index_for(request, frame, false)
                .map(|index| (position, index))
        });
        if self.warming {
            if found.is_none() {
                self.opened += 1;
                streams.insert(
                    streams.len().min(1),
                    FrameStream::open(request, frame, self.opened),
                );
                streams.truncate(STREAMS_PER_KEY);
            }
            self.warmed.insert(key.to_string());
            return Ok(None);
        }
        self.warmed.remove(key);
        let (stream, index) = match found {
            Some((position, index)) => (streams.remove(position), index),
            None => self.adopt(request, frame).unwrap_or_else(|| {
                self.opened += 1;
                (FrameStream::open(request, frame, self.opened), frame)
            }),
        };
        self.touched.insert(key.to_string());
        let streams = self.streams.entry(key.to_string()).or_default();
        streams.insert(0, stream);
        streams.truncate(STREAMS_PER_KEY);
        let read = streams[0].read(index, request.reach, self.cancel.as_deref());
        if read.as_ref().is_err_and(|error| error != PREEMPTED) {
            streams.remove(0);
        }
        read
    }

    fn adopt(&mut self, request: &StreamRequest, frame: u64) -> Option<(FrameStream, u64)> {
        if !request.preview || request.plan.is_some() {
            return None;
        }
        let (donor, position, index) = self
            .streams
            .iter()
            .filter(|(donor, _)| !self.touched.contains(*donor))
            .find_map(|(donor, streams)| {
                streams.iter().enumerate().find_map(|(position, stream)| {
                    stream
                        .index_for(request, frame, true)
                        .map(|index| (donor.clone(), position, index))
                })
            })?;
        let mut stream = self.streams.get_mut(&donor)?.remove(position);
        stream.offset = index as i64 - frame as i64;
        Some((stream, index))
    }

    pub fn neighbours(&self, key: &str, request: &StreamRequest, frame: u64) -> Option<Neighbours> {
        let stream = self.streams.get(key)?.first()?;
        stream.neighbours(frame.checked_add_signed(stream.offset)?, request.step())
    }

    pub fn bracket(&self, key: &str, request: &StreamRequest, time: f64) -> Option<Bracket> {
        self.streams
            .get(key)?
            .first()?
            .bracket(time, request.step())
    }

    pub fn warm(&mut self, warming: bool) {
        if warming {
            self.warmed.clear();
        }
        self.warming = warming;
    }

    pub fn warming(&self) -> bool {
        self.warming
    }

    pub fn cancel_on(&mut self, cancel: Option<Arc<AtomicBool>>) {
        self.cancel = cancel;
    }

    pub fn preemptible(&self) -> bool {
        self.cancel.is_some()
    }

    pub fn check(&self) -> Result<(), String> {
        match &self.cancel {
            Some(cancel) if cancel.load(Ordering::Relaxed) => Err(PREEMPTED.to_string()),
            _ => Ok(()),
        }
    }

    pub fn join<T>(&self, task: JoinHandle<T>) -> Result<std::thread::Result<T>, JoinHandle<T>> {
        if let Some(cancel) = &self.cancel {
            while !task.is_finished() {
                if cancel.load(Ordering::Relaxed) {
                    return Err(task);
                }
                std::thread::sleep(CANCEL_POLL);
            }
        }
        Ok(task.join())
    }

    pub fn opened(&self) -> u64 {
        self.opened
    }

    pub fn retain(&mut self, keys: &HashSet<String>) {
        self.touched.clear();
        self.streams
            .retain(|key, _| keys.contains(key) || self.warmed.contains(key));
    }
}
