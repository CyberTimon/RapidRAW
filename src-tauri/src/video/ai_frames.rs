use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use half::f16;
use half::slice::HalfFloatSliceExt;
use image::DynamicImage;
use rayon::prelude::*;

use crate::app::storage::{mark_used, record_video_cache_write};
use crate::render::gpu::compute::{self, IMAGE_FORMAT, Out, Slot};
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::processor::{read_buffer, read_texture_rows};
use crate::video::engine::flow::{self, End, FlowCache, Frame, LINK_BINS};
use crate::video::ffmpeg::MediaInfo;
use crate::video::frames::{FrameRange, FrameReader};
use crate::video::gpu;

const MAGIC: &[u8; 4] = b"RRAS";
const ENTRY_BYTES: usize = 20;
const FOOTER_BYTES: usize = 12;
const MAX_LOADED: usize = 16;
pub const MAX_CACHED_BYTES: u64 = 2 << 30;
const CUT_SHARE: f32 = 0.35;
const LOST_SHARE: f32 = 0.35;
const MOTION_QUANTILE: f32 = 0.9;
const FIT_ROUNDS: usize = 3;
const FIT_KEEP: f32 = 0.8;
const FIT_MIN_SHARE: f32 = 0.05;
const END_SLACK: u64 = 2;
const STREAM: u64 = 1;
const QUEUED_FRAMES: usize = 48;
pub const CANCELLED: &str = "Analysis cancelled";

static LOADED: LazyLock<Mutex<HashMap<PathBuf, Arc<Sequence>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static REVISION: AtomicU64 = AtomicU64::new(0);
static REQUESTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static PINNED: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn nearest(times: &[f64], time: f64) -> Option<usize> {
    let after = times.partition_point(|&at| at < time);
    [after.checked_sub(1), Some(after)]
        .into_iter()
        .flatten()
        .filter(|&index| index < times.len())
        .min_by(|&a, &b| (times[a] - time).abs().total_cmp(&(times[b] - time).abs()))
}

fn number(bytes: &[u8]) -> u64 {
    let mut word = [0u8; 8];
    word[..bytes.len()].copy_from_slice(bytes);
    u64::from_le_bytes(word)
}

pub struct Sequence {
    path: PathBuf,
    times: Vec<f64>,
    spans: Vec<(u64, u32)>,
}

impl Sequence {
    fn open(path: &Path) -> std::io::Result<Option<Self>> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        let header = MAGIC.len() as u64;
        let Some(table_end) = length
            .checked_sub(FOOTER_BYTES as u64)
            .filter(|end| *end >= header)
        else {
            return Ok(None);
        };
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Ok(None);
        }
        let mut footer = [0u8; FOOTER_BYTES];
        file.seek(SeekFrom::End(-(FOOTER_BYTES as i64)))?;
        file.read_exact(&mut footer)?;
        let count = number(&footer[..4]);
        let table_start = number(&footer[4..]);
        if table_start < header
            || table_start > table_end
            || count * ENTRY_BYTES as u64 != table_end - table_start
        {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(table_start))?;
        let mut table = vec![0u8; (table_end - table_start) as usize];
        file.read_exact(&mut table)?;
        let (times, spans): (Vec<f64>, Vec<(u64, u32)>) = table
            .as_chunks::<ENTRY_BYTES>()
            .0
            .iter()
            .map(|entry| {
                (
                    f64::from_bits(number(&entry[..8])),
                    (number(&entry[8..16]), number(&entry[16..]) as u32),
                )
            })
            .unzip();
        if spans.iter().any(|&(offset, length)| {
            offset < header || offset > table_start || u64::from(length) > table_start - offset
        }) {
            return Ok(None);
        }
        Ok(Some(Self {
            path: path.to_path_buf(),
            times,
            spans,
        }))
    }

    pub fn frame(&self, time: f64) -> Option<(usize, Vec<u8>)> {
        let index = nearest(&self.times, time)?;
        let (offset, length) = self.spans[index];
        if length == 0 {
            return None;
        }
        let mut file = File::open(&self.path).ok()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes).ok()?;
        Some((index, bytes))
    }
}

pub fn revision() -> u64 {
    REVISION.load(Ordering::Relaxed)
}

pub fn forget_all() {
    LOADED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
    REQUESTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
    REVISION.fetch_add(1, Ordering::Relaxed);
}

pub fn first_request(id: &str) -> bool {
    REQUESTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id.to_string())
}

pub fn is_loaded(path: &Path) -> bool {
    LOADED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains_key(path)
}

pub fn in_use(path: &Path) -> bool {
    is_loaded(path) || is_pinned(path)
}

pub struct Pin(Vec<PathBuf>);

impl Pin {
    pub fn new(paths: Vec<PathBuf>) -> Self {
        let mut pinned = PINNED.lock().unwrap_or_else(PoisonError::into_inner);
        for path in &paths {
            *pinned.entry(path.clone()).or_default() += 1;
        }
        Self(paths)
    }
}

impl Drop for Pin {
    fn drop(&mut self) {
        let mut pinned = PINNED.lock().unwrap_or_else(PoisonError::into_inner);
        for path in &self.0 {
            if let Some(count) = pinned.get_mut(path) {
                *count -= 1;
                if *count == 0 {
                    pinned.remove(path);
                }
            }
        }
    }
}

fn is_pinned(path: &Path) -> bool {
    PINNED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains_key(path)
}

fn remember(path: &Path, sequence: Arc<Sequence>) {
    let mut loaded = LOADED.lock().unwrap_or_else(PoisonError::into_inner);
    if loaded.len() >= MAX_LOADED {
        loaded.clear();
    }
    loaded.insert(path.to_path_buf(), sequence);
}

pub fn load(path: &Path) -> Option<Arc<Sequence>> {
    let loaded = LOADED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
        .cloned();
    let sequence = match loaded {
        Some(sequence) => sequence,
        None => {
            let sequence = match Sequence::open(path) {
                Ok(Some(sequence)) => Arc::new(sequence),
                Ok(None) => {
                    log::warn!("Removing a damaged analysis cache: {}", path.display());
                    let _ = std::fs::remove_file(path);
                    return None;
                }
                Err(_) => return None,
            };
            remember(path, Arc::clone(&sequence));
            sequence
        }
    };
    mark_used(path);
    Some(sequence)
}

pub struct SequenceWriter {
    target: PathBuf,
    temp: PathBuf,
    file: Option<BufWriter<File>>,
    entries: Vec<(f64, u64, u32)>,
    offset: u64,
}

impl SequenceWriter {
    pub fn create(target: &Path) -> Result<Self, String> {
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let temp = target.with_extension("part");
        let mut file = BufWriter::new(File::create(&temp).map_err(|e| e.to_string())?);
        file.write_all(MAGIC).map_err(|e| e.to_string())?;
        Ok(Self {
            target: target.to_path_buf(),
            temp,
            file: Some(file),
            entries: Vec::new(),
            offset: MAGIC.len() as u64,
        })
    }

    pub fn push(&mut self, time: f64, frame: Option<&[u8]>) -> Result<(), String> {
        let length = frame.map_or(0, <[u8]>::len) as u32;
        if let (Some(file), Some(frame)) = (self.file.as_mut(), frame) {
            file.write_all(frame).map_err(|e| e.to_string())?;
        }
        self.entries.push((time, self.offset, length));
        self.offset += length as u64;
        Ok(())
    }

    pub fn push_encoded<T: Sync>(
        &mut self,
        frames: &[(f64, T)],
        encode: impl Fn(&T) -> Result<Vec<u8>, String> + Sync,
    ) -> Result<(), String> {
        let encoded: Vec<Result<Vec<u8>, String>> =
            frames.par_iter().map(|(_, frame)| encode(frame)).collect();
        for ((time, _), bytes) in frames.iter().zip(encoded) {
            self.push(*time, Some(&bytes?))?;
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<(), String> {
        let mut file = self.file.take().ok_or("The analysis was already stored")?;
        let mut table = Vec::with_capacity(self.entries.len() * ENTRY_BYTES + FOOTER_BYTES);
        for (time, offset, length) in &self.entries {
            table.extend_from_slice(&time.to_le_bytes());
            table.extend_from_slice(&offset.to_le_bytes());
            table.extend_from_slice(&length.to_le_bytes());
        }
        table.extend_from_slice(&(self.entries.len() as u32).to_le_bytes());
        table.extend_from_slice(&self.offset.to_le_bytes());
        let stored_bytes = self.offset + table.len() as u64;
        let stored = file
            .write_all(&table)
            .and_then(|()| file.into_inner().map_err(|e| e.into_error()))
            .and_then(|file| file.sync_all())
            .and_then(|()| std::fs::rename(&self.temp, &self.target));
        if let Err(error) = stored {
            let _ = std::fs::remove_file(&self.temp);
            return Err(error.to_string());
        }
        record_video_cache_write(stored_bytes);
        let sequence = Sequence::open(&self.target)
            .ok()
            .flatten()
            .ok_or("The analysis could not be stored")?;
        remember(&self.target, Arc::new(sequence));
        REVISION.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

impl Drop for SequenceWriter {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

pub struct Map {
    pub size: (u32, u32),
    pub channels: usize,
    pub values: Vec<f32>,
}

impl Map {
    fn format(&self) -> wgpu::TextureFormat {
        match self.channels {
            1 => wgpu::TextureFormat::R32Float,
            _ => wgpu::TextureFormat::Rgba32Float,
        }
    }
}

pub struct Plan {
    pub key_size: (u32, u32),
    pub flow_longest: f32,
    pub max_gap: f64,
    pub motion: f32,
}

pub trait Analyzer {
    fn key(&mut self, image: &DynamicImage, time: f64) -> Result<Map, String>;

    fn keys(&mut self, frames: &[(Arc<DynamicImage>, f64)]) -> Result<Vec<Map>, String> {
        frames
            .iter()
            .map(|(image, time)| self.key(image, *time))
            .collect()
    }

    fn batch(&self) -> usize {
        1
    }

    fn aligned(&self) -> bool {
        false
    }

    fn cut(&mut self, _time: f64) {}

    fn emit(&mut self, time: f64, map: Map) -> Result<(), String>;
}

pub struct Run<'a> {
    pub context: &'a GpuContext,
    pub source: &'a Path,
    pub info: &'a MediaInfo,
    pub frames: &'a [u64],
    pub cancelled: &'a dyn Fn() -> bool,
    pub progress: &'a dyn Fn(f32),
}

pub fn frame_indices(times: &[f64], fps: f64) -> Vec<u64> {
    let mut indices: Vec<u64> = times
        .iter()
        .map(|time| (time.max(0.0) * fps).round() as u64)
        .collect();
    indices.sort_unstable();
    indices.dedup();
    indices
}

struct Anchor {
    index: u64,
    time: f64,
    flow: Slot,
}

struct Key {
    index: u64,
    time: f64,
    flow: Slot,
    link: Option<Slot>,
    picture: Arc<DynamicImage>,
}

struct Segment {
    anchor: Option<Anchor>,
    key: Key,
    window: Vec<Pending>,
}

struct Pending {
    index: u64,
    time: f64,
    flow: Slot,
    image: Option<Slot>,
    link: Slot,
    cut: bool,
}

struct Motion(Vec<u32>);

impl Motion {
    fn shares(&self) -> (f32, f32) {
        let total = self.0[..LINK_BINS].iter().sum::<u32>().max(1) as f32;
        (
            self.0[LINK_BINS] as f32 / total,
            self.0[LINK_BINS + 1] as f32 / total,
        )
    }

    fn cut(&self) -> bool {
        self.shares().1 > CUT_SHARE
    }

    fn quantile(&self, share: f32) -> f32 {
        let total = self.0[..LINK_BINS].iter().sum::<u32>() as f32;
        let mut seen = 0.0;
        for (bin, count) in self.0[..LINK_BINS].iter().enumerate() {
            seen += *count as f32;
            if seen >= share * total {
                return bin as f32 + 1.0;
            }
        }
        LINK_BINS as f32
    }

    fn exceeds(&self, plan: &Plan) -> bool {
        let (lost, torn) = self.shares();
        lost + torn > LOST_SHARE || self.quantile(MOTION_QUANTILE) > plan.motion
    }
}

struct Analysis<'a> {
    context: &'a GpuContext,
    analyzer: &'a mut dyn Analyzer,
    plan: &'a Plan,
    flow_size: (u32, u32),
    cache: FlowCache,
    anchor: Option<Anchor>,
    anchor_map: Option<Slot>,
    window: Vec<Pending>,
    queue: Vec<Segment>,
}

fn read_floats(context: &GpuContext, slot: &Slot, channels: usize) -> Result<Vec<f32>, String> {
    let width = slot.size.0 as usize;
    read_texture_rows(
        &context.device,
        &context.queue,
        &slot.texture,
        wgpu::Origin3d::ZERO,
        wgpu::Extent3d {
            width: slot.size.0,
            height: slot.size.1,
            depth_or_array_layers: 1,
        },
        (channels * 4) as u32,
        |mapped, stride| {
            mapped
                .chunks(stride)
                .flat_map(|row| {
                    bytemuck::cast_slice::<u8, f32>(&row[..width * channels * 4]).to_vec()
                })
                .collect()
        },
    )
}

fn read_weights(context: &GpuContext, slot: &Slot) -> Result<Vec<f32>, String> {
    let width = slot.size.0 as usize;
    read_texture_rows(
        &context.device,
        &context.queue,
        &slot.texture,
        wgpu::Origin3d::ZERO,
        wgpu::Extent3d {
            width: slot.size.0,
            height: slot.size.1,
            depth_or_array_layers: 1,
        },
        8,
        |mapped, stride| {
            let mut texel = [0.0f32; 4];
            mapped
                .chunks(stride)
                .flat_map(|row| {
                    bytemuck::cast_slice::<u8, f16>(&row[..width * 8])
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|halves| {
                            halves.convert_to_f32_slice(&mut texel);
                            texel[0]
                        })
                        .collect::<Vec<f32>>()
                })
                .collect()
        },
    )
}

fn fit(raw: &[f32], target: &[f32], weights: &[f32]) -> Option<(f32, f32)> {
    let mut used: Vec<f32> = weights.to_vec();
    let mut solution = None;
    for _ in 0..FIT_ROUNDS {
        let (mut w, mut x, mut y, mut xx, mut xy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for ((&r, &t), &weight) in raw.iter().zip(target).zip(&used) {
            let (r, t, weight) = (r as f64, t as f64, weight as f64);
            w += weight;
            x += weight * r;
            y += weight * t;
            xx += weight * r * r;
            xy += weight * r * t;
        }
        if w < FIT_MIN_SHARE as f64 * raw.len() as f64 {
            return None;
        }
        let variance = xx * w - x * x;
        if variance <= f64::EPSILON {
            return None;
        }
        let scale = (xy * w - x * y) / variance;
        let shift = (y - scale * x) / w;
        if scale <= 0.0 {
            return None;
        }
        solution = Some((scale as f32, shift as f32));
        let mut residuals: Vec<f32> = raw
            .iter()
            .zip(target)
            .zip(&used)
            .filter(|(_, weight)| **weight > 0.0)
            .map(|((&r, &t), _)| (scale as f32 * r + shift as f32 - t).abs())
            .collect();
        if residuals.is_empty() {
            break;
        }
        let keep = ((residuals.len() as f32 * FIT_KEEP) as usize).min(residuals.len() - 1);
        let limit = *residuals.select_nth_unstable_by(keep, f32::total_cmp).1;
        for ((&r, &t), weight) in raw.iter().zip(target).zip(used.iter_mut()) {
            if (scale as f32 * r + shift as f32 - t).abs() > limit {
                *weight = 0.0;
            }
        }
    }
    solution
}

impl Analysis<'_> {
    fn upload(&self, map: &Map) -> Result<Slot, String> {
        compute::encode(self.context, |enc| {
            enc.map("Analysis Map", map.size, map.format(), &map.values)
        })
    }

    fn reduce(&self, image: &Slot) -> Result<Slot, String> {
        if image.size == self.flow_size {
            return Ok(image.clone());
        }
        compute::encode(self.context, |enc| {
            let reduced = enc.texture("Analysis Frame", self.flow_size, IMAGE_FORMAT);
            crate::render::source::downscale(enc, image, &reduced);
            reduced.detach()
        })
    }

    fn open(&mut self, index: u64, time: f64, flow: Slot, image: &Slot) -> Result<(), String> {
        let picture = gpu::slot_image(self.context, image)?;
        self.anchor = Some(Anchor {
            index,
            time,
            flow: flow.clone(),
        });
        self.enqueue(Segment {
            anchor: None,
            key: Key {
                index,
                time,
                flow,
                link: None,
                picture,
            },
            window: Vec::new(),
        })
    }

    fn enqueue(&mut self, segment: Segment) -> Result<(), String> {
        self.queue.push(segment);
        let frames: usize = self
            .queue
            .iter()
            .map(|segment| segment.window.len() + 1)
            .sum();
        if self.queue.len() >= self.analyzer.batch() || frames >= QUEUED_FRAMES {
            self.flush()
        } else {
            Ok(())
        }
    }

    fn flush(&mut self) -> Result<(), String> {
        if self.queue.is_empty() {
            return Ok(());
        }
        let segments = std::mem::take(&mut self.queue);
        let pictures: Vec<(Arc<DynamicImage>, f64)> = segments
            .iter()
            .map(|segment| (Arc::clone(&segment.key.picture), segment.key.time))
            .collect();
        let maps = self.analyzer.keys(&pictures)?;
        if maps.len() != segments.len() {
            return Err("The analysis lost a key frame".to_string());
        }
        for (segment, map) in segments.into_iter().zip(maps) {
            self.resolve(segment, map)?;
        }
        Ok(())
    }

    fn link(&mut self, index: u64, flow: &Slot) -> Result<(Slot, Motion), String> {
        let anchor = self
            .anchor
            .as_ref()
            .ok_or("The analysis lost its key frame")?;
        let bytes = ((LINK_BINS + 2) * 4) as u64;
        let readback = self.context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Link Counts Readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let cache = &mut self.cache;
        cache.follow(STREAM, &[anchor.index, index]);
        let link = compute::encode(self.context, |enc| {
            let counts = enc.buffer("Link Counts", &vec![0u8; bytes as usize]);
            let field = cache.between(
                enc,
                Frame {
                    key: anchor.index,
                    slot: &anchor.flow,
                },
                Frame {
                    key: index,
                    slot: flow,
                },
            );
            let link = flow::link(enc, &field, (flow, &anchor.flow), End::To, Some(&counts));
            enc.encoder
                .copy_buffer_to_buffer(&counts, 0, &readback, 0, bytes);
            link.detach()
        })?;
        let counts = read_buffer(self.context, &readback, |bytes| {
            bytemuck::cast_slice(bytes).to_vec()
        })?;
        Ok((link, Motion(counts)))
    }

    fn push(&mut self, index: u64, time: f64, image: Slot) -> Result<(), String> {
        let flow = self.reduce(&image)?;
        let Some(anchor_time) = self.anchor.as_ref().map(|anchor| anchor.time) else {
            return self.open(index, time, flow, &image);
        };
        let (link, motion) = self.link(index, &flow)?;
        let cut = motion.cut();
        let over = cut || motion.exceeds(self.plan) || time - anchor_time > self.plan.max_gap;
        self.window.push(Pending {
            index,
            time,
            flow,
            image: Some(image),
            link,
            cut,
        });
        let count = self.window.len();
        if count >= 3 {
            self.window[count - 3].image = None;
        }
        if !over {
            return Ok(());
        }
        let current = self.window.pop().ok_or("The analysis window is empty")?;
        match self.window.pop() {
            Some(key) => {
                self.close(key)?;
                let image = current.image.ok_or("The analysis lost a frame")?;
                self.push(current.index, current.time, image)
            }
            None if current.cut => {
                let image = current.image.as_ref().ok_or("The analysis lost a frame")?;
                self.flush()?;
                self.analyzer.cut(current.time);
                self.open(current.index, current.time, current.flow.clone(), image)
            }
            None => self.close(current),
        }
    }

    fn align(&self, anchor_map: &Slot, link: &Slot, map: &mut Map) -> Result<(), String> {
        let (values, weights) = compute::encode(self.context, |enc| {
            let values = enc.texture("Aligned Map", map.size, wgpu::TextureFormat::Rgba32Float);
            let weights = enc.texture("Aligned Weights", map.size, IMAGE_FORMAT);
            flow::carry(
                enc,
                map.size,
                (anchor_map, link),
                None,
                Out::Both(&values.view, &weights.view),
            );
            (values.detach(), weights.detach())
        })?;
        let carried: Vec<f32> = read_floats(self.context, &values, 4)?
            .as_chunks::<4>()
            .0
            .iter()
            .map(|texel| texel[0])
            .collect();
        let weights = read_weights(self.context, &weights)?;
        let raw: Vec<f32> = map.values.iter().step_by(map.channels).copied().collect();
        if let Some((scale, shift)) = fit(&raw, &carried, &weights) {
            for value in map.values.iter_mut().step_by(map.channels) {
                *value = scale * *value + shift;
            }
        }
        Ok(())
    }

    fn close(&mut self, key: Pending) -> Result<(), String> {
        let anchor = self
            .anchor
            .take()
            .ok_or("The analysis lost its key frame")?;
        let image = key.image.as_ref().ok_or("The analysis lost a frame")?;
        let picture = gpu::slot_image(self.context, image)?;
        self.anchor = Some(Anchor {
            index: key.index,
            time: key.time,
            flow: key.flow.clone(),
        });
        let mut window = std::mem::take(&mut self.window);
        for pending in &mut window {
            pending.image = None;
        }
        self.enqueue(Segment {
            anchor: Some(anchor),
            key: Key {
                index: key.index,
                time: key.time,
                flow: key.flow,
                link: Some(key.link),
                picture,
            },
            window,
        })
    }

    fn resolve(&mut self, segment: Segment, mut map: Map) -> Result<(), String> {
        let Segment {
            anchor,
            key,
            window,
        } = segment;
        let Some(anchor) = anchor else {
            let slot = self.upload(&map)?;
            self.analyzer.emit(key.time, map)?;
            self.anchor_map = Some(slot);
            return Ok(());
        };
        let anchor_map = self
            .anchor_map
            .take()
            .ok_or("The analysis lost its key frame")?;
        if self.analyzer.aligned() {
            let link = key.link.as_ref().ok_or("The analysis lost a frame")?;
            self.align(&anchor_map, link, &mut map)?;
        }
        let key_map = self.upload(&map)?;
        let span = (key.time - anchor.time).max(f64::EPSILON);
        for pending in window {
            let alpha = ((pending.time - anchor.time) / span) as f32;
            let cache = &mut self.cache;
            cache.follow(STREAM, &[pending.index, key.index]);
            let (format, channels) = (map.format(), map.channels);
            let carried = compute::encode(self.context, |enc| {
                let field = cache.between(
                    enc,
                    Frame {
                        key: pending.index,
                        slot: &pending.flow,
                    },
                    Frame {
                        key: key.index,
                        slot: &key.flow,
                    },
                );
                let link = flow::link(enc, &field, (&pending.flow, &key.flow), End::From, None);
                let carried = enc.texture("Carried Map", map.size, format);
                flow::carry(
                    enc,
                    map.size,
                    (&anchor_map, &pending.link),
                    Some((&key_map, &link, alpha)),
                    if channels == 1 {
                        Out::R32(&carried.view)
                    } else {
                        Out::F32(&carried.view)
                    },
                );
                carried.detach()
            })?;
            let values = read_floats(self.context, &carried, channels)?;
            self.analyzer.emit(
                pending.time,
                Map {
                    size: map.size,
                    channels,
                    values,
                },
            )?;
        }
        self.analyzer.emit(key.time, map)?;
        self.anchor_map = Some(key_map);
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        if let Some(key) = self.window.pop() {
            self.close(key)?;
        }
        self.flush()
    }
}

pub fn analyze(run: &Run, plan: &Plan, analyzer: &mut dyn Analyzer) -> Result<(), String> {
    let (Some(&first), Some(&last)) = (run.frames.first(), run.frames.last()) else {
        return Ok(());
    };
    let fps = run.info.fps.max(1.0);
    let mut reader = FrameReader::open(
        run.source,
        run.info,
        &FrameRange {
            start: first as f64 / fps,
            speed: 1.0,
            fps: Some(fps),
            frames: Some(last - first + 1),
            size: Some(plan.key_size),
            hwaccel: true,
            preview: true,
            keyframe: false,
        },
    )?;
    let mut analysis = Analysis {
        context: run.context,
        analyzer,
        plan,
        flow_size: flow::fitted(plan.key_size, plan.flow_longest),
        cache: FlowCache::default(),
        anchor: None,
        anchor_map: None,
        window: Vec::new(),
        queue: Vec::new(),
    };
    let mut wanted = run.frames.iter().copied().peekable();
    let total = (last - first + 1) as f32;
    for index in first..=last {
        if (run.cancelled)() {
            return Err(CANCELLED.to_string());
        }
        let read = if wanted.peek() == Some(&index) {
            wanted.next();
            match reader.next_slot() {
                Some(image) => {
                    analysis.push(index, index as f64 / fps, image)?;
                    true
                }
                None => false,
            }
        } else {
            reader.skip_frame()
        };
        if !read {
            if index + END_SLACK < last {
                return Err("The video could not be read for the analysis".to_string());
            }
            break;
        }
        (run.progress)((index - first + 1) as f32 / total);
    }
    analysis.finish()
}
