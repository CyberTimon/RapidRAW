use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, GrayImage, ImageFormat, ImageReader, RgbaImage};
use mozjpeg_rs::{Preset, Subsampling};
use ort::session::Session;
use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager};

use crate::ai::commands::{encode_png, png_data_url};
use crate::ai::models::{effect_map_session, park_effect_map_session};
use crate::ai::processing::{run_depth_anything_raw, run_normal_model, run_normal_models};
use crate::app::state::AppState;
use crate::decode::formats::is_video_file;
use crate::effects::maps::{EffectMapKind, EffectMapUse, build_depth_preview, frame_map};
use crate::library::sidecars::parse_virtual_path;
use crate::video::ai_frames::{self, Analyzer, CANCELLED, Map, Plan, Run, SequenceWriter};
use crate::video::camera_log::CameraLog;
use crate::video::commands::shown_info;
use crate::video::ffmpeg::{self, MediaInfo};
use crate::video::jobs::{JobContext, JobManager, JobState};
use crate::video::media::even_fit;
use crate::video::model::{ClipItem, FrameRate, VideoProject, ramp_offsets, seconds};
use crate::video::{blocking, frames, hash_of, proxy};

const DIR: &str = "ai-maps";
const VERSION: u32 = 2;
const BLOCK_SECONDS: f64 = 4.0;
const PREFETCH: usize = 2;
const FALLBACK_BLOCKS: usize = 4;
const KEY_LONGEST: u32 = 960;
const FLOW_LONGEST: f32 = 480.0;
const MAX_GAP_SECONDS: f64 = 0.5;
const MOTION_SHARE: f32 = 0.05;
const KEY_RANGE: (f32, f32) = (0.01, 0.99);
const FRAME_RANGE: (f32, f32) = (0.002, 0.998);
const RANGE_STRIDE: usize = 4;
const ENCODE_BATCH: usize = 32;
const WAIT_INTERVAL: Duration = Duration::from_millis(250);
pub const DEPTH_MASK: &str = "ai-depth";
const CLIP_MAPS: &str = "video:frames";
const SCOPE_LONGEST: u32 = 512;
const SAME_FRAME_SECONDS: f64 = 1e-3;
const NORMAL_MAGIC: &[u8; 4] = b"RRN1";
const NORMAL_QUALITY: u8 = 92;
const NORMAL_DEPTH_LEVEL: i32 = 3;
const NORMAL_BATCH: usize = 4;

pub const KINDS: [&str; 2] = ["depth", "surfaces"];

static CLIP_MAP_RUNS: Mutex<Vec<(String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

fn kind_name(kind: EffectMapKind) -> &'static str {
    match kind {
        EffectMapKind::Depth => KINDS[0],
        EffectMapKind::Normal => KINDS[1],
    }
}

fn kind_of(name: &str) -> Option<EffectMapKind> {
    EffectMapKind::ALL
        .into_iter()
        .find(|kind| kind_name(*kind) == name)
}

fn requested_uses(
    look: &Value,
    kind: EffectMapKind,
) -> impl Iterator<Item = &'static EffectMapUse> {
    kind.uses().iter().filter(move |map_use| {
        map_use.is_enabled(look)
            && look[map_use.map_key]
                .as_str()
                .is_some_and(|map| !map.is_empty())
    })
}

pub fn has_depth_masks(look: &Value) -> bool {
    let visible = |value: &Value| value["visible"].as_bool() != Some(false);
    look["masks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mask| visible(mask))
        .flat_map(|mask| mask["subMasks"].as_array().into_iter().flatten())
        .any(|sub_mask| sub_mask["type"] == DEPTH_MASK && visible(sub_mask))
}

pub fn drop_clip_maps(adjustments: &mut Value, source: &Path) -> bool {
    if is_video_file(source) {
        return false;
    }
    let mut dropped = false;
    for map_use in EffectMapKind::ALL.iter().flat_map(|kind| kind.uses()) {
        if let Some(map) = adjustments
            .get_mut(map_use.map_key)
            .filter(|map| map.as_str() == Some(CLIP_MAPS))
        {
            *map = Value::Null;
            dropped = true;
        }
    }
    dropped
}

fn kinds(look: &Value) -> impl Iterator<Item = EffectMapKind> + '_ {
    EffectMapKind::ALL.into_iter().filter(move |kind| {
        requested_uses(look, *kind).next().is_some()
            || (*kind == EffectMapKind::Depth && has_depth_masks(look))
    })
}

fn clip_range(fps: FrameRate, clip: &ClipItem, info: &MediaInfo) -> (f64, f64) {
    let start = seconds(clip.source_in);
    if clip.freeze {
        return (start, start);
    }
    let span = match clip.ramp() {
        Some(keys) => ramp_offsets(clip.duration, keys, fps)
            .last()
            .copied()
            .unwrap_or(0.0),
        None => seconds(clip.duration) * clip.speed(),
    };
    if clip.reverse {
        (start - span - 1.0 / info.fps.max(1.0), start)
    } else {
        (start, start + span)
    }
}

fn block_of(time: f64) -> u64 {
    (time.max(0.0) / BLOCK_SECONDS).floor() as u64
}

#[derive(Clone)]
pub struct Block {
    source: PathBuf,
    kind: EffectMapKind,
    frames: (u64, u64),
    id: String,
    target: PathBuf,
}

impl Block {
    fn new(
        app: &AppHandle,
        source: &Path,
        kind: EffectMapKind,
        info: &MediaInfo,
        index: u64,
    ) -> Option<Self> {
        let fps = info.fps.max(1.0);
        let last = ((info.duration * fps).ceil() as u64).saturating_sub(1);
        let frame = |block: u64| (block as f64 * BLOCK_SECONDS * fps).round() as u64;
        let first = frame(index);
        if first > last {
            return None;
        }
        let fingerprint = proxy::fingerprint(source).ok()?;
        let id = format!(
            "{}-{}-v{}-{}",
            &fingerprint[..16],
            kind_name(kind),
            VERSION,
            index
        );
        Some(Self {
            source: source.to_path_buf(),
            kind,
            frames: (first, frame(index + 1).min(last)),
            target: proxy::cache_file(app, DIR, &id, "seq").ok()?,
            id,
        })
    }

    fn len(&self) -> u64 {
        self.frames.1 - self.frames.0 + 1
    }

    fn request(&self, app: &AppHandle) {
        if self.submit(app, false).is_some() {
            return;
        }
        let stalled = app
            .state::<JobManager>()
            .list()
            .iter()
            .rfind(|job| job.key == self.id)
            .is_none_or(|job| matches!(job.state, JobState::Done | JobState::Cancelled));
        if stalled {
            self.submit(app, true);
        }
    }

    fn submit(&self, app: &AppHandle, force: bool) -> Option<String> {
        if !ai_frames::first_request(&self.id) && !force {
            return None;
        }
        let name = self
            .source
            .file_name()
            .unwrap_or(self.source.as_os_str())
            .to_string_lossy();
        let (block, handle) = (self.clone(), app.clone());
        Some(app.state::<JobManager>().submit_grouped(
            app,
            kind_name(self.kind),
            &self.id,
            &name,
            Some(self.source.to_string_lossy().into_owned()),
            move |job| compute(&handle, &block, job),
        ))
    }
}

fn frame_reference(
    sequence: &ai_frames::Sequence,
    block: &Block,
    stream: &str,
    time: f64,
) -> Option<String> {
    let (index, bytes) = sequence.frame(time)?;
    let map = decode_map(&bytes)?;
    Some(frame_map(
        hash_of((stream, kind_name(block.kind))),
        hash_of((&block.id, index)),
        map,
    ))
}

#[allow(clippy::too_many_arguments)]
fn lookup(
    app: &AppHandle,
    source: &Path,
    stream: &str,
    look: &Value,
    time: f64,
    range: impl FnOnce(&MediaInfo) -> Option<(f64, f64)>,
    forward: bool,
    missing: &mut Vec<Block>,
) -> Vec<(&'static str, String)> {
    let mut found = Vec::new();
    if kinds(look).next().is_none() {
        return found;
    }
    let Ok(info) = ffmpeg::probe(source) else {
        return found;
    };
    let current = block_of(time);
    let mut nearby: Vec<u64> = range(&info)
        .map(|(from, to)| {
            (block_of(from)..=block_of(to))
                .filter(|index| *index != current)
                .collect()
        })
        .unwrap_or_default();
    nearby.sort_by_key(|index| ((*index > current) != forward, index.abs_diff(current)));
    for kind in kinds(look) {
        let Some(block) = Block::new(app, source, kind, &info, current) else {
            continue;
        };
        let reference = match ai_frames::load(&block.target) {
            Some(sequence) => frame_reference(&sequence, &block, stream, time),
            None => {
                block.request(app);
                missing.push(block);
                nearest_reference(app, source, kind, &info, &nearby, stream, time)
            }
        };
        if let Some(reference) = reference {
            found.extend(
                requested_uses(look, kind).map(|map_use| (map_use.map_key, reference.clone())),
            );
        }
        for index in nearby.iter().take(PREFETCH) {
            if let Some(block) = Block::new(app, source, kind, &info, *index)
                && !block.target.is_file()
            {
                block.request(app);
            }
        }
    }
    found
}

fn nearest_reference(
    app: &AppHandle,
    source: &Path,
    kind: EffectMapKind,
    info: &MediaInfo,
    nearby: &[u64],
    stream: &str,
    time: f64,
) -> Option<String> {
    let mut closest = nearby.to_vec();
    closest.sort_by_key(|index| index.abs_diff(block_of(time)));
    closest.into_iter().take(FALLBACK_BLOCKS).find_map(|index| {
        let block = Block::new(app, source, kind, info, index)?;
        let sequence = ai_frames::load(&block.target)?;
        frame_reference(&sequence, &block, stream, time)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn overrides(
    app: &AppHandle,
    project: &VideoProject,
    clip: &ClipItem,
    source: &Path,
    stream: &str,
    look: &Value,
    time: f64,
    missing: &mut Vec<Block>,
) -> Vec<(&'static str, String)> {
    lookup(
        app,
        source,
        stream,
        look,
        time,
        |info| Some(clip_range(project.settings.fps, clip, info)),
        !clip.reverse,
        missing,
    )
}

pub fn frame_overrides(
    app: &AppHandle,
    path: &str,
    look: &Value,
    time: f64,
) -> Vec<(&'static str, String)> {
    let source = parse_virtual_path(path).0;
    if !is_video_file(&source) {
        return Vec::new();
    }
    lookup(
        app,
        &source,
        path,
        look,
        time,
        |_| None,
        true,
        &mut Vec::new(),
    )
}

fn block_at(app: &AppHandle, path: &str, kind: EffectMapKind, time: f64) -> Option<Block> {
    let source = parse_virtual_path(path).0;
    if !is_video_file(&source) {
        return None;
    }
    let info = ffmpeg::probe(&source).ok()?;
    Block::new(app, &source, kind, &info, block_of(time))
}

fn map_reference(
    app: &AppHandle,
    path: &str,
    key: &str,
    stream: &str,
    time: f64,
) -> Option<String> {
    let kind = EffectMapKind::ALL
        .into_iter()
        .find(|kind| kind.uses().iter().any(|map_use| map_use.map_key == key))?;
    let block = block_at(app, path, kind, time)?;
    let sequence = ai_frames::load(&block.target)?;
    frame_reference(&sequence, &block, stream, time)
}

pub fn depth_frame(app: &AppHandle, path: &str, time: f64) -> Option<(Vec<u8>, u32)> {
    let block = block_at(app, path, EffectMapKind::Depth, time)?;
    let (_, png) = ai_frames::load(&block.target)?.frame(time)?;
    let (width, _) = ImageReader::new(Cursor::new(&png))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    Some((png, width))
}

fn affordable(blocks: &[Block], stored: &HashMap<&str, u64>, budget: Option<u64>) -> usize {
    let Some(budget) = budget else {
        return blocks.len();
    };
    let (bytes, frames) = blocks
        .iter()
        .filter_map(|block| {
            stored
                .get(block.id.as_str())
                .map(|&bytes| (bytes, block.len()))
        })
        .fold((0, 0), |(bytes, frames), block| {
            (bytes + block.0, frames + block.1)
        });
    if frames == 0 {
        return blocks.len();
    }
    let per_frame = bytes as f64 / frames as f64;
    let mut used = 0.0;
    blocks
        .iter()
        .position(|block| {
            used += stored
                .get(block.id.as_str())
                .map_or(per_frame * block.len() as f64, |&bytes| bytes as f64);
            used > budget as f64
        })
        .map_or(blocks.len(), |index| index.max(1))
}

pub fn wait(
    app: &AppHandle,
    blocks: &[Block],
    cancel: &AtomicBool,
    progress: &dyn Fn(f32),
) -> Result<(), String> {
    wait_within(app, blocks, None, cancel, progress)
}

fn wait_within(
    app: &AppHandle,
    blocks: &[Block],
    budget: Option<u64>,
    cancel: &AtomicBool,
    progress: &dyn Fn(f32),
) -> Result<(), String> {
    let mut followed: HashMap<&str, String> = HashMap::new();
    let mut finished: HashSet<&str> = HashSet::new();
    let mut retried: HashSet<&str> = HashSet::new();
    let mut stored: HashMap<&str, u64> = HashMap::new();
    loop {
        let jobs = app.state::<JobManager>().list();
        let mut queued: HashMap<&str, usize> = HashMap::new();
        let mut done = 0.0;
        let planned = &blocks[..affordable(blocks, &stored, budget)];
        let total = planned.iter().map(Block::len).sum::<u64>().max(1) as f32;
        for block in planned {
            let id = block.id.as_str();
            if finished.contains(id) || block.target.is_file() {
                finished.insert(id);
                if let Ok(meta) = std::fs::metadata(&block.target) {
                    stored.entry(id).or_insert(meta.len());
                }
                done += block.len() as f32;
                continue;
            }
            let job = followed
                .get(id)
                .and_then(|followed| jobs.iter().find(|job| job.id == *followed));
            let mut submit = false;
            match job {
                Some(job) if matches!(job.state, JobState::Queued | JobState::Running) => {
                    *queued.entry(kind_name(block.kind)).or_default() += 1;
                    done += block.len() as f32 * job.progress;
                }
                Some(job) if job.state == JobState::Done => {
                    finished.insert(id);
                    done += block.len() as f32;
                }
                Some(job) if job.state == JobState::Cancelled => {
                    return Err(CANCELLED.to_string());
                }
                Some(job) => {
                    if !retried.insert(id) {
                        return Err(job.error.clone().unwrap_or_else(|| {
                            "The depth analysis for a clip did not finish".to_string()
                        }));
                    }
                    followed.remove(id);
                    submit = true;
                }
                None if followed.contains_key(id) => {
                    finished.insert(id);
                    done += block.len() as f32;
                }
                None => submit = true,
            }
            let active = jobs.iter().any(|job| {
                job.key == id && matches!(job.state, JobState::Queued | JobState::Running)
            });
            let slots = queued.entry(kind_name(block.kind)).or_default();
            if submit && (active || *slots < PREFETCH) {
                *slots += 1;
                if let Some(job) = block.submit(app, true) {
                    followed.insert(id, job);
                }
            }
        }
        progress(done / total);
        if planned
            .iter()
            .all(|block| finished.contains(block.id.as_str()))
        {
            return Ok(());
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Export cancelled".to_string());
        }
        std::thread::sleep(WAIT_INTERVAL);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMapsRequest {
    id: String,
    path: String,
    clip: ClipItem,
    fps: FrameRate,
    kind: String,
    at: f64,
}

#[tauri::command]
pub async fn video_clip_maps(
    request: ClipMapsRequest,
    on_progress: Channel<f32>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    CLIP_MAP_RUNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((request.id.clone(), Arc::clone(&stop)));
    let flag = Arc::clone(&stop);
    let result = blocking(move || {
        let kind = kind_of(&request.kind).ok_or("Unknown video analysis")?;
        let source = parse_virtual_path(&request.path).0;
        let info = ffmpeg::probe(&source)?;
        let (from, to) = clip_range(request.fps, &request.clip, &info);
        let current = block_of(request.at.clamp(from, to));
        let mut indices: Vec<u64> = (block_of(from)..=block_of(to)).collect();
        indices.sort_by_key(|index| index.abs_diff(current));
        let blocks: Vec<Block> = indices
            .into_iter()
            .filter_map(|index| Block::new(&app_handle, &source, kind, &info, index))
            .collect();
        let _pin = ai_frames::Pin::new(blocks.iter().map(|block| block.target.clone()).collect());
        let budget = ai_frames::MAX_CACHED_BYTES / KINDS.len() as u64;
        wait_within(&app_handle, &blocks, Some(budget), &flag, &|value| {
            let _ = on_progress.send(value);
        })
    })
    .await;
    CLIP_MAP_RUNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(_, flag)| !Arc::ptr_eq(flag, &stop));
    result?
}

#[tauri::command]
pub fn video_clip_maps_stop(id: String) {
    CLIP_MAP_RUNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(run, stop)| {
            let stopped = *run == id;
            if stopped {
                stop.store(true, Ordering::Relaxed);
            }
            !stopped
        });
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn video_depth_preview(
    path: String,
    time: f64,
    log: Option<CameraLog>,
    deflicker: Option<bool>,
    js_adjustments: Value,
    map_key: Option<String>,
    map_data: Option<String>,
    max_size: u32,
    app_handle: AppHandle,
) -> Result<Response, String> {
    blocking(move || {
        let installed = app_handle
            .state::<AppState>()
            .original_image
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .filter(|frame| {
                frame.path == path
                    && frame
                        .source_time
                        .is_some_and(|at| (at - time).abs() < SAME_FRAME_SECONDS)
            });
        let image = match installed {
            Some(frame) => frame.image,
            None => {
                let source = parse_virtual_path(&path).0;
                let info = shown_info(&source, log, deflicker)?;
                let size = even_fit((info.width, info.height), SCOPE_LONGEST, 2);
                frames::decode_frame(&source, &info, time, Some(size))?
            }
        };
        let mut adjustments = js_adjustments;
        let stream = format!("{}#scope", path);
        if let Some(key) = map_key.as_deref()
            && let Some(reference) = map_reference(&app_handle, &path, key, &stream, time)
        {
            adjustments[key] = Value::String(reference);
        }
        let map_data = map_data.map(|data| {
            depth_frame(&app_handle, &path, time).map_or(data, |(png, _)| png_data_url(&png))
        });
        build_depth_preview(
            &image,
            false,
            &path,
            &adjustments,
            map_key.as_deref(),
            map_data.as_deref(),
            max_size.clamp(16, SCOPE_LONGEST),
        )
        .map(Response::new)
        .ok_or_else(|| "Depth map unavailable".to_string())
    })
    .await?
}

fn quantiles(values: &[f32], (low, high): (f32, f32)) -> (f32, f32) {
    let mut sample: Vec<f32> = values
        .iter()
        .step_by(RANGE_STRIDE)
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if sample.is_empty() {
        return (0.0, 1.0);
    }
    let last = sample.len() - 1;
    let at = |share: f32| ((last as f32 * share) as usize).min(last);
    let low = *sample.select_nth_unstable_by(at(low), f32::total_cmp).1;
    let high = *sample.select_nth_unstable_by(at(high), f32::total_cmp).1;
    (low, high)
}

struct Spilled {
    time: f64,
    size: (u32, u32),
    range: (f32, f32),
}

struct DepthFrames<'a> {
    session: &'a Mutex<Session>,
    spill: Option<BufWriter<File>>,
    spill_path: PathBuf,
    frames: Vec<Spilled>,
}

impl Drop for DepthFrames<'_> {
    fn drop(&mut self) {
        self.spill.take();
        let _ = std::fs::remove_file(&self.spill_path);
    }
}

impl Analyzer for DepthFrames<'_> {
    fn key(&mut self, image: &DynamicImage, _time: f64) -> Result<Map, String> {
        let (width, height, mut values) = run_depth_anything_raw(
            image,
            &mut self.session.lock().unwrap_or_else(|e| e.into_inner()),
        )
        .map_err(|e| e.to_string())?;
        let (low, high) = quantiles(&values, KEY_RANGE);
        let span = (high - low).max(1e-6);
        values
            .iter_mut()
            .for_each(|value| *value = (*value - low) / span);
        Ok(Map {
            size: (width, height),
            channels: 1,
            values,
        })
    }

    fn aligned(&self) -> bool {
        true
    }

    fn emit(&mut self, time: f64, map: Map) -> Result<(), String> {
        let range = quantiles(&map.values, FRAME_RANGE);
        let mut halves = vec![f16::ZERO; map.values.len()];
        halves.convert_from_f32_slice(&map.values);
        self.spill
            .as_mut()
            .ok_or("The depth analysis already finished")?
            .write_all(bytemuck::cast_slice(&halves))
            .map_err(|e| e.to_string())?;
        self.frames.push(Spilled {
            time,
            size: map.size,
            range,
        });
        Ok(())
    }
}

impl<'a> DepthFrames<'a> {
    fn create(session: &'a Mutex<Session>, target: &Path) -> Result<Self, String> {
        let spill_path = target.with_extension("spill");
        if let Some(dir) = spill_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            session,
            spill: Some(BufWriter::new(
                File::create(&spill_path).map_err(|e| e.to_string())?,
            )),
            spill_path,
            frames: Vec::new(),
        })
    }

    fn finish(
        &mut self,
        target: &Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<SequenceWriter, String> {
        self.spill
            .take()
            .ok_or("The depth analysis already finished")?
            .into_inner()
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(File::open(&self.spill_path).map_err(|e| e.to_string())?);
        let mut writer = SequenceWriter::create(target)?;
        for batch in self.frames.chunks(ENCODE_BATCH) {
            if cancelled() {
                return Err(CANCELLED.to_string());
            }
            let mut maps = Vec::with_capacity(batch.len());
            for frame in batch {
                let (width, height) = frame.size;
                let mut bytes = vec![0u8; width as usize * height as usize * 2];
                reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                maps.push((frame.time, (width, height, bytes, frame.range)));
            }
            writer.push_encoded(&maps, |(width, height, bytes, (low, high))| {
                let scale = 255.0 / (high - low).max(1e-6);
                let levels = bytemuck::cast_slice::<u8, f16>(bytes)
                    .iter()
                    .map(|half| ((half.to_f32() - low) * scale).round().clamp(0.0, 255.0) as u8)
                    .collect();
                encode_png(
                    &GrayImage::from_raw(*width, *height, levels)
                        .ok_or("Depth frame size mismatch")?,
                )
            })?;
        }
        Ok(writer)
    }
}

struct NormalFrames<'a> {
    session: &'a Mutex<Session>,
    writer: SequenceWriter,
    pending: Vec<(f64, RgbaImage)>,
}

fn normal_map(normals: RgbaImage) -> Map {
    Map {
        size: normals.dimensions(),
        channels: 4,
        values: normals
            .pixels()
            .flat_map(|pixel| {
                [
                    pixel[0] as f32 / 127.5 - 1.0,
                    pixel[1] as f32 / 127.5 - 1.0,
                    pixel[2] as f32 / 127.5 - 1.0,
                    pixel[3] as f32 / 255.0,
                ]
            })
            .collect(),
    }
}

impl NormalFrames<'_> {
    fn flush(&mut self) -> Result<(), String> {
        self.writer.push_encoded(&self.pending, encode_normals)?;
        self.pending.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<SequenceWriter, String> {
        self.flush()?;
        Ok(self.writer)
    }
}

impl Analyzer for NormalFrames<'_> {
    fn key(&mut self, image: &DynamicImage, _time: f64) -> Result<Map, String> {
        run_normal_model(image, self.session)
            .map(normal_map)
            .map_err(|e| e.to_string())
    }

    fn keys(&mut self, frames: &[(Arc<DynamicImage>, f64)]) -> Result<Vec<Map>, String> {
        let images: Vec<&DynamicImage> = frames.iter().map(|(image, _)| image.as_ref()).collect();
        run_normal_models(&images, self.session)
            .map(|maps| maps.into_iter().map(normal_map).collect())
            .map_err(|e| e.to_string())
    }

    fn batch(&self) -> usize {
        NORMAL_BATCH
    }

    fn emit(&mut self, time: f64, map: Map) -> Result<(), String> {
        let pack = |value: f32| ((value * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0).round() as u8;
        let texels = map
            .values
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|texel| {
                let length = (texel[0] * texel[0] + texel[1] * texel[1] + texel[2] * texel[2])
                    .sqrt()
                    .max(1e-6);
                [
                    pack(texel[0] / length),
                    pack(texel[1] / length),
                    pack(texel[2] / length),
                    (texel[3] * 255.0).round().clamp(0.0, 255.0) as u8,
                ]
            })
            .collect();
        let image = RgbaImage::from_raw(map.size.0, map.size.1, texels)
            .ok_or("Normal frame size mismatch")?;
        self.pending.push((time, image));
        if self.pending.len() >= ENCODE_BATCH {
            self.flush()?;
        }
        Ok(())
    }
}

fn median(left: u8, up: u8, corner: u8) -> u8 {
    let (low, high) = (left.min(up), left.max(up));
    if corner >= high {
        low
    } else if corner <= low {
        high
    } else {
        (left as i16 + up as i16 - corner as i16) as u8
    }
}

fn encode_normals(map: &RgbaImage) -> Result<Vec<u8>, String> {
    let (width, height) = map.dimensions();
    let count = width as usize * height as usize;
    let (mut rgb, mut alpha) = (Vec::with_capacity(count * 3), Vec::with_capacity(count));
    for pixel in map.as_raw().as_chunks::<4>().0 {
        rgb.extend_from_slice(&pixel[..3]);
        alpha.push(pixel[3]);
    }
    let jpeg = mozjpeg_rs::Encoder::new(Preset::BaselineFastest)
        .quality(NORMAL_QUALITY)
        .subsampling(Subsampling::S444)
        .encode_rgb(&rgb, width, height)
        .map_err(|e| e.to_string())?;
    let columns = width as usize;
    let zeros = vec![0u8; columns];
    let mut residuals = Vec::with_capacity(count);
    for (y, row) in alpha.chunks_exact(columns).enumerate() {
        let above = match y {
            0 => &zeros[..],
            _ => &alpha[(y - 1) * columns..y * columns],
        };
        let (mut left, mut corner) = (above[0], above[0]);
        for (&value, &up) in row.iter().zip(above) {
            residuals.push(value.wrapping_sub(median(left, up, corner)));
            (left, corner) = (value, up);
        }
    }
    let packed = zstd::bulk::compress(&residuals, NORMAL_DEPTH_LEVEL).map_err(|e| e.to_string())?;
    let mut frame = Vec::with_capacity(NORMAL_MAGIC.len() + 4 + jpeg.len() + packed.len());
    frame.extend_from_slice(NORMAL_MAGIC);
    frame.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
    frame.extend_from_slice(&jpeg);
    frame.extend_from_slice(&packed);
    Ok(frame)
}

fn decode_map(bytes: &[u8]) -> Option<DynamicImage> {
    let Some(frame) = bytes.strip_prefix(NORMAL_MAGIC) else {
        return image::load_from_memory(bytes).ok();
    };
    let (length, frame) = frame.split_first_chunk::<4>()?;
    let (jpeg, packed) = frame.split_at_checked(u32::from_le_bytes(*length) as usize)?;
    let rgb = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg)
        .ok()?
        .into_rgb8();
    let (width, height) = rgb.dimensions();
    let (columns, count) = (width as usize, width as usize * height as usize);
    let residuals = zstd::bulk::decompress(packed, count)
        .ok()
        .filter(|residuals| columns > 0 && residuals.len() == count)?;
    let zeros = vec![0u8; columns];
    let mut alpha = vec![0u8; count];
    for (y, deltas) in residuals.chunks_exact(columns).enumerate() {
        let (done, rest) = alpha.split_at_mut(y * columns);
        let above = match y {
            0 => &zeros[..],
            _ => &done[(y - 1) * columns..],
        };
        let (mut left, mut corner) = (above[0], above[0]);
        for ((value, &up), &delta) in rest[..columns].iter_mut().zip(above).zip(deltas) {
            *value = delta.wrapping_add(median(left, up, corner));
            (left, corner) = (*value, up);
        }
    }
    let mut texels = vec![0u8; count * 4];
    for ((texel, pixel), depth) in texels
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(rgb.as_raw().as_chunks::<3>().0)
        .zip(&alpha)
    {
        texel[..3].copy_from_slice(pixel);
        texel[3] = *depth;
    }
    RgbaImage::from_raw(width, height, texels).map(DynamicImage::ImageRgba8)
}

fn compute(app: &AppHandle, block: &Block, job: &JobContext) -> Result<(), String> {
    if block.target.is_file() {
        return Ok(());
    }
    let info = ffmpeg::probe(&block.source)?;
    let context = crate::render::gpu::context::shared_gpu_context()?;
    let frames: Vec<u64> = (block.frames.0..=block.frames.1).collect();
    let plan = Plan {
        key_size: even_fit((info.width, info.height), KEY_LONGEST, 2),
        flow_longest: FLOW_LONGEST,
        max_gap: MAX_GAP_SECONDS,
        motion: MOTION_SHARE * FLOW_LONGEST,
    };
    let cancelled = || job.is_cancelled();
    let run = Run {
        context: &context,
        source: &block.source,
        info: &info,
        frames: &frames,
        cancelled: &cancelled,
        progress: &|value| job.progress(value),
    };
    let state = app.state::<AppState>();
    let session = Mutex::new(
        tauri::async_runtime::block_on(effect_map_session(
            app,
            &state.ai_state,
            &state.ai_init_lock,
            block.kind,
        ))
        .map_err(|e| e.to_string())?,
    );
    let writer = match block.kind {
        EffectMapKind::Depth => {
            let mut analyzer = DepthFrames::create(&session, &block.target)?;
            ai_frames::analyze(&run, &plan, &mut analyzer)?;
            analyzer.finish(&block.target, &cancelled)?
        }
        EffectMapKind::Normal => {
            let mut analyzer = NormalFrames {
                session: &session,
                writer: SequenceWriter::create(&block.target)?,
                pending: Vec::new(),
            };
            ai_frames::analyze(&run, &plan, &mut analyzer)?;
            analyzer.finish()?
        }
    };
    if cancelled() {
        return Err(CANCELLED.to_string());
    }
    writer.finish()?;
    park_effect_map_session(
        block.kind,
        session.into_inner().unwrap_or_else(|e| e.into_inner()),
    );
    Ok(())
}
