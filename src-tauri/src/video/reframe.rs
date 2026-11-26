use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use image::DynamicImage;
use image::imageops::{self, FilterType};
use ort::session::Session;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::ai::models::{AiMaskModel, get_or_init_ai_models};
use crate::ai::processing::run_birefnet_pass;
use crate::app::state::AppState;
use crate::app::storage::mark_used;
use crate::library::sidecars::parse_virtual_path;
use crate::video::ai_frames::{self, Analyzer, CANCELLED, Map, Plan, Run};
use crate::video::geometry::{ClipGeometry, scaling};
use crate::video::jobs::{Cached, JobContext, JobManager};
use crate::video::media::even_fit;
use crate::video::model::VideoProject;
use crate::video::stabilization::{AnalysisState, job_state};
use crate::video::vision::{FrameView, Framing, Homography, reframe};
use crate::video::{VideoState, blocking, ffmpeg, hash_of, proxy};

pub const KIND: &str = "reframe";
const DIR: &str = "reframe";
const EXTENSION: &str = "bin";
const MAGIC: &[u8; 4] = b"RRRF";
const HEADER_BYTES: usize = 12;
const ENTRY_HEADER_BYTES: usize = 9;
const MAP_LONGEST: u32 = 64;
const KEY_LONGEST: u32 = 1024;
const FLOW_LONGEST: f32 = 480.0;
const MAX_GAP_SECONDS: f64 = 1.0;
const COVER_TOLERANCE: f64 = 1.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    path: String,
    times: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRequest {
    analysis: String,
    project: VideoProject,
    item_id: String,
    times: Vec<i64>,
}

#[derive(Serialize)]
pub struct Analysis {
    id: String,
    job: Option<String>,
}

struct Entry {
    time: f64,
    cut: bool,
    map: Vec<u8>,
}

struct Saved {
    size: (u32, u32),
    entries: Vec<Entry>,
}

struct Saliency {
    session: Arc<Mutex<Session>>,
    size: (u32, u32),
    cut: Option<f64>,
    entries: Vec<Entry>,
}

impl Analyzer for Saliency {
    fn key(&mut self, image: &DynamicImage, _time: f64) -> Result<Map, String> {
        let mask = run_birefnet_pass(
            image,
            &mut self.session.lock().unwrap_or_else(|e| e.into_inner()),
        )
        .map_err(|e| e.to_string())?;
        let small = imageops::resize(&mask, self.size.0, self.size.1, FilterType::Triangle);
        Ok(Map {
            size: self.size,
            channels: 1,
            values: small.iter().map(|&level| level as f32 / 255.0).collect(),
        })
    }

    fn cut(&mut self, time: f64) {
        self.cut = Some(time);
    }

    fn emit(&mut self, time: f64, map: Map) -> Result<(), String> {
        self.entries.push(Entry {
            time,
            cut: self.cut == Some(time),
            map: map
                .values
                .iter()
                .map(|value| (value * 255.0).round().clamp(0.0, 255.0) as u8)
                .collect(),
        });
        Ok(())
    }
}

fn cover_box(spare_u: f64, spare_v: f64, cos: f64, sin: f64) -> [f64; 2] {
    if spare_u < -COVER_TOLERANCE || spare_v < -COVER_TOLERANCE {
        return [0.0, 0.0];
    }
    let (u, v) = (spare_u.max(0.0), spare_v.max(0.0));
    let limit = |spare: f64, factor: f64| {
        if factor > 1e-9 {
            spare / factor
        } else {
            f64::INFINITY
        }
    };
    let x = limit(u, cos).min(limit(v, sin));
    let y = limit(u, sin).min(limit(v, cos));
    let share = |spare: f64, used: f64| if used > 1e-9 { spare / used } else { 1.0 };
    let fit = share(u, x * cos + y * sin)
        .min(share(v, x * sin + y * cos))
        .min(1.0);
    [x * fit, y * fit]
}

fn room(geometry: &ClipGeometry, canvas: [f64; 2]) -> Option<[f64; 4]> {
    let map = geometry.content_to_canvas()?;
    let (width, height) = (
        geometry.framing.content.0 as f64,
        geometry.framing.content.1 as f64,
    );
    let center = map.apply([width * 0.5, height * 0.5])?;
    let reach = |point: [f64; 2]| -> Option<[f64; 2]> {
        let [x, y] = map.apply(point)?;
        Some([x - center[0], y - center[1]])
    };
    let across = reach([width, height * 0.5])?;
    let down = reach([width * 0.5, height])?;
    let angle = across[1].atan2(across[0]);
    let (cos, sin) = (angle.cos().abs(), angle.sin().abs());
    let [x, y] = cover_box(
        across[0].hypot(across[1]) - canvas[0] * 0.5 * cos - canvas[1] * 0.5 * sin,
        down[0].hypot(down[1]) - canvas[0] * 0.5 * sin - canvas[1] * 0.5 * cos,
        cos,
        sin,
    );
    let offset = [canvas[0] * 0.5 - center[0], canvas[1] * 0.5 - center[1]];
    Some([
        (offset[0] - x).min(0.0),
        (offset[0] + x).max(0.0),
        (offset[1] - y).min(0.0),
        (offset[1] + y).max(0.0),
    ])
}

fn rows(map: &Homography) -> [f64; 6] {
    let m = map.0;
    let w = if m[8].abs() > 1e-12 { m[8] } else { 1.0 };
    [m[0], m[1], m[2], m[3], m[4], m[5]].map(|value| value / w)
}

fn cache_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    proxy::cache_file(app, DIR, id, EXTENSION)
}

fn store(target: &Path, analysis: &Saved) -> Result<(), String> {
    let (width, height) = analysis.size;
    let stride = ENTRY_HEADER_BYTES + (width * height) as usize;
    let mut bytes = Vec::with_capacity(HEADER_BYTES + analysis.entries.len() * stride);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    for entry in &analysis.entries {
        bytes.extend_from_slice(&entry.time.to_le_bytes());
        bytes.push(entry.cut as u8);
        bytes.extend_from_slice(&entry.map);
    }
    proxy::write_cache_file(target, &bytes).map_err(|e| e.to_string())
}

fn load(path: &Path) -> Option<Saved> {
    let bytes = std::fs::read(path).ok()?;
    let word = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    if bytes.get(..4)? != MAGIC {
        return None;
    }
    let size = (word(4)?, word(8)?);
    let stride = ENTRY_HEADER_BYTES + (size.0 * size.1) as usize;
    let entries = bytes[HEADER_BYTES..]
        .chunks_exact(stride)
        .map(|chunk| {
            Some(Entry {
                time: f64::from_le_bytes(chunk[..8].try_into().ok()?),
                cut: chunk[8] != 0,
                map: chunk[ENTRY_HEADER_BYTES..].to_vec(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    mark_used(path);
    (!entries.is_empty()).then_some(Saved { size, entries })
}

fn analyze(
    app: &AppHandle,
    source: &Path,
    frames: &[u64],
    target: &Path,
    job: &JobContext,
) -> Result<(), String> {
    let info = ffmpeg::probe(source)?;
    let state = app.state::<AppState>();
    let models = tauri::async_runtime::block_on(get_or_init_ai_models(
        app,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Foreground,
    ))
    .map_err(|e| e.to_string())?;
    let context = crate::render::gpu::context::shared_gpu_context()?;
    let size = (info.width, info.height);
    let mut saliency = Saliency {
        session: models.birefnet().map_err(|e| e.to_string())?,
        size: even_fit(size, MAP_LONGEST, 2),
        cut: None,
        entries: Vec::with_capacity(frames.len()),
    };
    let cancelled = || job.is_cancelled();
    ai_frames::analyze(
        &Run {
            context: &context,
            source,
            info: &info,
            frames,
            cancelled: &cancelled,
            progress: &|value| job.progress(value),
        },
        &Plan {
            key_size: even_fit(size, KEY_LONGEST, 2),
            flow_longest: FLOW_LONGEST,
            max_gap: MAX_GAP_SECONDS,
            motion: f32::INFINITY,
        },
        &mut saliency,
    )?;
    if cancelled() {
        return Err(CANCELLED.to_string());
    }
    if saliency.entries.is_empty() {
        return Err("The video could not be read for the analysis".to_string());
    }
    store(
        target,
        &Saved {
            size: saliency.size,
            entries: saliency.entries,
        },
    )
}

#[tauri::command]
pub async fn video_reframe_analyze(
    request: AnalyzeRequest,
    app_handle: AppHandle,
) -> Result<Analysis, String> {
    blocking(move || {
        crate::video::libav::require()?;
        let source = parse_virtual_path(&request.path).0;
        let info = ffmpeg::probe(&source)?;
        if !info.has_video || info.is_still {
            return Err("Only video clips can be reframed".to_string());
        }
        let frames = ai_frames::frame_indices(&request.times, info.fps);
        let fingerprint = proxy::fingerprint(&source)?;
        let id = format!(
            "{}-{:016x}",
            &fingerprint[..16],
            hash_of((&fingerprint, &frames))
        );
        let target = cache_path(&app_handle, &id)?;
        if target.is_file() {
            return Ok(Analysis { id, job: None });
        }
        let label = source
            .file_name()
            .unwrap_or(source.as_os_str())
            .to_string_lossy()
            .into_owned();
        let handle = app_handle.clone();
        let job =
            app_handle
                .state::<JobManager>()
                .submit(&app_handle, KIND, &id, &label, move |job| {
                    analyze(&handle, &source, &frames, &target, job)
                });
        Ok(Analysis { id, job: Some(job) })
    })
    .await?
}

#[tauri::command]
pub fn video_reframe_status(
    ids: Vec<String>,
    app_handle: AppHandle,
) -> HashMap<String, AnalysisState> {
    let jobs = app_handle.state::<JobManager>().list();
    ids.into_iter()
        .map(|id| {
            let cached = if cache_path(&app_handle, &id).is_ok_and(|path| path.is_file()) {
                Cached::Ready
            } else {
                jobs.iter()
                    .rev()
                    .find(|status| status.kind == KIND && status.key == id)
                    .map_or(Cached::Missing, |status| {
                        Cached::Job(status.state, status.progress)
                    })
            };
            (id, job_state(cached))
        })
        .collect()
}

#[tauri::command]
pub async fn video_reframe_path(
    request: PathRequest,
    app_handle: AppHandle,
) -> Result<Vec<[f64; 2]>, String> {
    blocking(move || {
        let placings = {
            let video = app_handle.state::<VideoState>();
            let mut engine = video.batch(&app_handle)?;
            request
                .times
                .iter()
                .map(|&ticks| {
                    engine
                        .clip_geometry_at(&request.project, &request.item_id, ticks)?
                        .ok_or_else(|| "The clip cannot be reframed".to_string())
                })
                .collect::<Result<Vec<ClipGeometry>, String>>()?
        };
        let settings = &request.project.settings;
        let canvas = [settings.width as f64, settings.height as f64];
        let first = placings
            .first()
            .ok_or("The reframe request is incomplete")?;
        let content = rows(&first.framing.map.then(&scaling(
            1.0 / first.framing.content.0.max(1) as f64,
            1.0 / first.framing.content.1.max(1) as f64,
        )));
        let rooms = placings
            .iter()
            .map(|placing| room(placing, canvas).unwrap_or([0.0; 4]))
            .collect::<Vec<_>>();
        let analysis = load(&cache_path(&app_handle, &request.analysis)?)
            .ok_or("The reframe analysis is missing")?;
        let times: Vec<f64> = analysis.entries.iter().map(|entry| entry.time).collect();
        let mut cuts = Vec::with_capacity(times.len());
        let mut seen = 0usize;
        for entry in &analysis.entries {
            seen += entry.cut as usize;
            cuts.push(seen);
        }
        let nearest: Vec<usize> = placings
            .iter()
            .map(|placing| ai_frames::nearest(&times, placing.source_time).unwrap_or(0))
            .collect();
        let frames: Vec<FrameView> = nearest
            .iter()
            .enumerate()
            .map(|(index, &entry)| {
                let cut = index > 0 && {
                    let previous = nearest[index - 1];
                    cuts[entry.max(previous)] != cuts[entry.min(previous)]
                };
                FrameView {
                    saliency: &analysis.entries[entry].map,
                    place: rows(&placings[index].to_canvas),
                    room: rooms[index],
                    cut,
                }
            })
            .collect();
        Ok(reframe(
            &Framing {
                content,
                canvas,
                fps: request.project.fps(),
            },
            analysis.size,
            &frames,
        ))
    })
    .await?
}
