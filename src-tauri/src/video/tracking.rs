use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer};
use serde_json::Value;
use tauri::ipc::Channel;

use crate::library::sidecars::parse_virtual_path;
use crate::video::blocking;
use crate::video::ffmpeg;
use crate::video::geometry::{map_corners, scaling};
use crate::video::media::GrayVideo;
use crate::video::vision::{
    GrayFrame, Homography, PlaneTracker, Quad, Region, RegionTracker, TrackSample, strong_corners,
};

const TRACKING_SIDE: u32 = 720;
const PLANE_SIDE: u32 = 1920;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const BACKWARD_CHUNK_FRAMES: i64 = 48;
const FRAME_EPSILON: f64 = 1e-6;

static CANCEL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRequest {
    path: String,
    times: Vec<f64>,
    region: Region,
    #[serde(default)]
    quad: Option<Quad>,
    #[serde(default)]
    max_gap: Option<usize>,
}

#[derive(Clone, Copy)]
pub enum Target {
    Region(Region),
    Plane(Quad),
}

enum Follower {
    Region(Box<RegionTracker>),
    Plane(Box<PlaneTracker>),
}

impl Follower {
    fn start(target: Target, frame: &GrayFrame) -> Result<(Self, TrackSample), String> {
        match target {
            Target::Region(region) => Ok((
                Self::Region(Box::new(RegionTracker::new(frame, region))),
                TrackSample {
                    cx: region.cx,
                    cy: region.cy,
                    scale: 1.0,
                    rotation: 0.0,
                    confidence: 1.0,
                    corners: None,
                },
            )),
            Target::Plane(quad) => {
                let mut tracker = PlaneTracker::new(frame, quad)?;
                let sample = tracker.first_sample();
                Ok((Self::Plane(Box::new(tracker)), sample))
            }
        }
    }

    fn update(&mut self, frame: &GrayFrame) -> Option<TrackSample> {
        match self {
            Self::Region(tracker) => tracker.update(frame),
            Self::Plane(tracker) => tracker.update(frame),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct TrackKey {
    time: f64,
    x: f64,
    y: f64,
    #[serde(default = "unit")]
    scale: f64,
    #[serde(default)]
    rotation: f64,
    #[serde(default, deserialize_with = "lenient_corners")]
    corners: Option<Corners>,
}

pub type Corners = [[f64; 2]; 4];

fn unit() -> f64 {
    1.0
}

pub fn lenient_corners<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Corners>, D::Error> {
    Ok(Value::deserialize(deserializer)
        .ok()
        .and_then(|value| serde_json::from_value::<Option<Corners>>(value).ok())
        .flatten()
        .filter(|corners| corners.iter().flatten().all(|value| value.is_finite())))
}

#[derive(Clone, Debug, Deserialize)]
pub struct Anchor {
    pub clip: String,
    pub media: String,
    canvas: [f64; 9],
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct MotionTrack {
    #[serde(default)]
    keys: Vec<TrackKey>,
    #[serde(default)]
    reference: Option<TrackKey>,
    #[serde(default, rename = "positionOnly")]
    position_only: bool,
    #[serde(default)]
    pub anchor: Option<Anchor>,
}

#[derive(Clone, Debug)]
pub struct TrackWarp {
    pub from: (f64, f64),
    pub to: (f64, f64),
    pub scale: f64,
    pub cos: f64,
    pub sin: f64,
    pub degrees: f64,
}

impl TrackWarp {
    fn new(from: [f64; 2], to: [f64; 2], scale: f64, angle: f64) -> Self {
        Self {
            from: (from[0], from[1]),
            to: (to[0], to[1]),
            scale,
            cos: angle.cos(),
            sin: angle.sin(),
            degrees: angle.to_degrees(),
        }
    }

    pub fn turn(&self, dx: f64, dy: f64) -> (f64, f64) {
        (
            self.scale * (self.cos * dx - self.sin * dy),
            self.scale * (self.sin * dx + self.cos * dy),
        )
    }

    pub fn map(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = self.turn(x - self.from.0, y - self.from.1);
        (self.to.0 + dx, self.to.1 + dy)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Follow {
    pub similar: Option<TrackWarp>,
    pub plane: Option<Homography>,
    pub corners: Option<Corners>,
}

type Linear = [[f64; 2]; 2];

fn product(a: Linear, b: Linear) -> Linear {
    std::array::from_fn(|row| {
        std::array::from_fn(|column| a[row][0] * b[0][column] + a[row][1] * b[1][column])
    })
}

fn inverse(m: Linear) -> Option<Linear> {
    let determinant = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    (determinant.abs() > 1e-12).then(|| {
        [
            [m[1][1] / determinant, -m[0][1] / determinant],
            [-m[1][0] / determinant, m[0][0] / determinant],
        ]
    })
}

impl MotionTrack {
    fn pose_at(&self, time: f64) -> Option<TrackKey> {
        let after = self.keys.partition_point(|key| key.time <= time);
        match (
            after.checked_sub(1).map(|index| self.keys[index]),
            self.keys.get(after).copied(),
        ) {
            (Some(from), Some(to)) => {
                let t = ((time - from.time) / (to.time - from.time).max(1e-9)).clamp(0.0, 1.0);
                let mix = |a: f64, b: f64| a + (b - a) * t;
                Some(TrackKey {
                    time,
                    x: mix(from.x, to.x),
                    y: mix(from.y, to.y),
                    scale: mix(from.scale, to.scale),
                    rotation: mix(from.rotation, to.rotation),
                    corners: from.corners.zip(to.corners).map(|(start, end)| {
                        std::array::from_fn(|index| {
                            [0, 1].map(|axis| mix(start[index][axis], end[index][axis]))
                        })
                    }),
                })
            }
            (Some(pose), None) | (None, Some(pose)) => Some(pose),
            (None, None) => None,
        }
    }

    fn reference(&self) -> Option<TrackKey> {
        self.reference.or_else(|| self.keys.first().copied())
    }

    fn planar(&self) -> bool {
        self.keys.iter().all(|key| key.corners.is_some())
    }

    fn warp(&self, time: f64, (width, height): (f64, f64)) -> Option<TrackWarp> {
        let reference = self.reference()?;
        let pose = self.pose_at(time)?;
        let (scale, angle) = if self.position_only {
            (1.0, 0.0)
        } else {
            (
                pose.scale.max(1e-3) / reference.scale.max(1e-3),
                pose.rotation - reference.rotation,
            )
        };
        Some(TrackWarp {
            from: (reference.x * width, reference.y * height),
            to: (pose.x * width, pose.y * height),
            scale,
            cos: angle.cos(),
            sin: angle.sin(),
            degrees: angle.to_degrees(),
        })
    }

    fn planes(
        &self,
        (width, height): (f64, f64),
    ) -> Option<impl Fn(f64) -> Option<Homography> + '_> {
        if !self.planar() {
            return None;
        }
        let scaled = move |corners: Corners| corners.map(|[x, y]| [x * width, y * height]);
        let from = Homography::from_square(&scaled(self.reference()?.corners?))?.inverse();
        Some(move |time| {
            let to = Homography::from_square(&scaled(self.pose_at(time)?.corners?))?;
            Some(from?.then(&to))
        })
    }

    pub fn follow(&self, time: f64, frame: (f64, f64)) -> Option<Follow> {
        if self.anchor.is_some() {
            return None;
        }
        Some(Follow {
            similar: self.warp(time, frame),
            plane: self.planes(frame).and_then(|planes| planes(time)),
            corners: self
                .pose_at(time)
                .and_then(|pose| pose.corners)
                .filter(|_| self.planar())
                .map(|corners| corners.map(|[x, y]| [x * frame.0, y * frame.1])),
        })
    }

    pub fn follow_in(
        &self,
        time: f64,
        source: (u32, u32),
        to_canvas: &Homography,
        canvas: (f64, f64),
    ) -> Option<Follow> {
        let anchor = self.anchor.as_ref()?;
        let reference = self.reference()?;
        let pose = self.pose_at(time)?;
        let at_reference = Homography(anchor.canvas).then(&scaling(canvas.0, canvas.1));
        let (width, height) = (source.0.max(1) as f64, source.1.max(1) as f64);
        let placed = |key: &TrackKey, map: &Homography| -> Option<([f64; 2], Linear)> {
            let point = [key.x, key.y];
            let (sin, cos) = key.rotation.sin_cos();
            let local = [
                [key.scale * cos / width, -key.scale * sin / width],
                [key.scale * sin / height, key.scale * cos / height],
            ];
            Some((map.apply(point)?, product(map.jacobian(point)?, local)))
        };
        let (from, before) = placed(&reference, &at_reference)?;
        let (to, after) = placed(&pose, to_canvas)?;
        let linear = product(after, inverse(before)?);
        let (scale, angle) = if self.position_only {
            (1.0, 0.0)
        } else {
            (
                (linear[0][0] * linear[1][1] - linear[0][1] * linear[1][0])
                    .abs()
                    .sqrt(),
                (linear[1][0] - linear[0][1]).atan2(linear[0][0] + linear[1][1]),
            )
        };
        let corners = pose
            .corners
            .filter(|_| self.planar())
            .and_then(|corners| map_corners(&corners, to_canvas));
        let plane = corners.and_then(|to| {
            let from = map_corners(&reference.corners?, &at_reference)?;
            Some(
                Homography::from_square(&from)?
                    .inverse()?
                    .then(&Homography::from_square(&to)?),
            )
        });
        Some(Follow {
            similar: Some(TrackWarp::new(from, to, scale, angle)),
            plane,
            corners,
        })
    }

    pub fn max_scale(&self) -> f64 {
        if self.position_only {
            return 1.0;
        }
        let reference = self.reference().map_or(1.0, |key| key.scale.max(1e-3));
        self.keys
            .iter()
            .map(|key| key.scale / reference)
            .fold(1.0, f64::max)
    }
}

pub fn pin_corners(pin: &Corners, follow: Option<&Follow>, canvas: (f64, f64)) -> Corners {
    let scaled = pin.map(|[x, y]| [x * canvas.0, y * canvas.1]);
    let Some(follow) = follow else {
        return scaled;
    };
    if let Some(plane) = &follow.plane {
        return map_corners(&scaled, plane).unwrap_or(scaled);
    }
    follow.similar.as_ref().map_or(scaled, |warp| {
        scaled.map(|[x, y]| {
            let (x, y) = warp.map(x, y);
            [x, y]
        })
    })
}

pub fn pin_extent(
    pin: &Corners,
    track: Option<&MotionTrack>,
    canvas: (f64, f64),
    current: Option<&Follow>,
) -> [f64; 2] {
    let length = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).hypot(a[1] - b[1]);
    let quads: Vec<Corners> = match track.filter(|track| track.anchor.is_none()) {
        Some(track) if !track.keys.is_empty() => track
            .keys
            .iter()
            .map(|key| pin_corners(pin, track.follow(key.time, canvas).as_ref(), canvas))
            .collect(),
        _ => vec![pin_corners(pin, current, canvas)],
    };
    quads
        .into_iter()
        .fold([0.0f64; 2], |[across, down], [a, b, c, d]| {
            [
                across.max(length(a, b)).max(length(d, c)),
                down.max(length(a, d)).max(length(b, c)),
            ]
        })
}

pub struct Exclusive;

impl Drop for Exclusive {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn begin() -> Result<Exclusive, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Another tracking job is already running".to_string());
    }
    CANCEL.store(false, Ordering::SeqCst);
    Ok(Exclusive)
}

pub fn cancelled() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

struct Run<'a> {
    target: Target,
    indices: Vec<i64>,
    backward: bool,
    tracker: Option<Follower>,
    samples: Vec<Option<TrackSample>>,
    next: usize,
    missing: usize,
    max_gap: usize,
    visited: usize,
    total: usize,
    reported: Instant,
    progress: &'a dyn Fn(f32),
}

impl Run<'_> {
    fn visit(&mut self, index: i64, frame: &GrayFrame) -> Result<(), String> {
        if cancelled() {
            return Err("Tracking cancelled".to_string());
        }
        let sample = match self.tracker.as_mut() {
            Some(tracker) => tracker.update(frame),
            None => {
                let (tracker, sample) = Follower::start(self.target, frame)?;
                self.tracker = Some(tracker);
                Some(sample)
            }
        };
        while let Some(&wanted) = self.indices.get(self.next) {
            let reached = if self.backward {
                wanted >= index
            } else {
                wanted <= index
            };
            if !reached {
                break;
            }
            if wanted == index {
                self.samples[self.next] = sample;
            }
            self.missing = if wanted == index && sample.is_some() {
                0
            } else {
                self.missing + 1
            };
            self.next += 1;
        }
        self.visited += 1;
        if self.reported.elapsed() >= PROGRESS_INTERVAL {
            self.reported = Instant::now();
            (self.progress)(self.visited as f32 / self.total.max(1) as f32);
        }
        Ok(())
    }

    fn lost(&self) -> bool {
        self.missing > self.max_gap
    }
}

pub fn track_region(
    path: &str,
    times: &[f64],
    target: Target,
    max_gap: Option<usize>,
    progress: &dyn Fn(f32),
) -> Result<Vec<Option<TrackSample>>, String> {
    if times.is_empty() {
        return Ok(Vec::new());
    }
    let backward = times.len() > 1 && times[1] < times[0];
    if times
        .windows(2)
        .any(|pair| (pair[1] - pair[0]) * if backward { -1.0 } else { 1.0 } < 0.0)
    {
        return Err("Tracking times must move in one direction".to_string());
    }
    let source = parse_virtual_path(path).0;
    let info = ffmpeg::probe(&source)?;
    if !info.has_video || info.is_still {
        return Err("Only video clips can be tracked".to_string());
    }
    let indices: Vec<i64> = times
        .iter()
        .enumerate()
        .map(|(index, &time)| {
            let step = times
                .get(index + 1)
                .or_else(|| {
                    index
                        .checked_sub(1)
                        .and_then(|previous| times.get(previous))
                })
                .map(|&other| (other - time).abs())
                .filter(|&step| step > FRAME_EPSILON)
                .unwrap_or(1.0 / info.fps);
            shown_frame(time, step, info.fps)
        })
        .collect();
    let first = indices[0].min(indices[indices.len() - 1]);
    let last = indices[0].max(indices[indices.len() - 1]);
    let open = |from: i64, count: i64| {
        GrayVideo::open(
            &source,
            &info,
            match target {
                Target::Region(_) => TRACKING_SIDE,
                Target::Plane(_) => PLANE_SIDE,
            },
            from as f64 / info.fps,
            Some(count as u64),
        )
    };
    let mut run = Run {
        target,
        samples: vec![None; indices.len()],
        indices,
        backward,
        tracker: None,
        next: 0,
        missing: 0,
        max_gap: max_gap.unwrap_or(usize::MAX),
        visited: 0,
        total: (last - first + 1) as usize,
        reported: Instant::now(),
        progress,
    };
    if backward {
        let mut chunk_end = last;
        while chunk_end >= first && !run.lost() {
            let chunk_start = (chunk_end - BACKWARD_CHUNK_FRAMES + 1).max(first);
            let mut source_frames = open(chunk_start, chunk_end - chunk_start + 1)?;
            let mut frames = Vec::new();
            while frames.len() as i64 <= chunk_end - chunk_start
                && let Some(frame) = source_frames.next_frame()
            {
                frames.push(frame);
            }
            for (offset, frame) in frames.iter().enumerate().rev() {
                if run.lost() {
                    break;
                }
                run.visit(chunk_start + offset as i64, frame)?;
            }
            chunk_end = chunk_start - 1;
        }
    } else {
        let mut source_frames = open(first, last - first + 1)?;
        let mut index = first;
        while index <= last
            && !run.lost()
            && let Some(frame) = source_frames.next_frame()
        {
            run.visit(index, &frame)?;
            index += 1;
        }
    }
    Ok(run.samples)
}

fn shown_frame(time: f64, step: f64, fps: f64) -> i64 {
    (((time.max(0.0) + 0.5 * step) * fps - FRAME_EPSILON).ceil() as i64 - 1).max(0)
}

#[tauri::command]
pub async fn video_track(
    request: TrackRequest,
    on_progress: Channel<f32>,
) -> Result<Vec<Option<TrackSample>>, String> {
    let exclusive = begin()?;
    blocking(move || {
        let _exclusive = exclusive;
        track_region(
            &request.path,
            &request.times,
            request
                .quad
                .map_or(Target::Region(request.region), Target::Plane),
            request.max_gap,
            &|value| {
                let _ = on_progress.send(value);
            },
        )
    })
    .await?
}

#[tauri::command]
pub async fn video_track_corners(path: String, time: f64) -> Result<Vec<[f32; 2]>, String> {
    blocking(move || {
        let source = parse_virtual_path(&path).0;
        let info = ffmpeg::probe(&source)?;
        if !info.has_video || info.is_still {
            return Err("Only video clips can be tracked".to_string());
        }
        let index = shown_frame(time, 1.0 / info.fps, info.fps);
        let mut video =
            GrayVideo::open(&source, &info, PLANE_SIDE, index as f64 / info.fps, Some(1))?;
        let frame = video
            .next_frame()
            .ok_or_else(|| "Could not read the frame".to_string())?;
        Ok(strong_corners(&frame))
    })
    .await?
}

#[tauri::command]
pub fn video_cancel_track() {
    CANCEL.store(true, Ordering::SeqCst);
}
