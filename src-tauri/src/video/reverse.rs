use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;

use crate::library::sidecars::parse_virtual_path;
use crate::video::blocking;
use crate::video::ffmpeg::{self, MediaInfo};
use crate::video::jobs::{CachedJob, JobContext, prepare_video};
use crate::video::libav::encode::Muxer;
use crate::video::libav::q2d;
use crate::video::libav::video::{VideoPipe, VideoSpec};
use crate::video::model::{Item, MediaKind, VideoProject};
use crate::video::proxy::{self, PROXY_FORMAT, write_cache_file};
use crate::video::stabilization::{AnalysisState, job_state};

pub(crate) const JOB: CachedJob = CachedJob {
    kind: "reverse",
    dir: "reversed",
    extension: "mov",
};
const AUDIO_EXTENSION: &str = "wav";
const PRORES_STANDARD: &str = "2";
const SEGMENT_BYTES: usize = 768 << 20;
const MIN_SEGMENT_FRAMES: usize = 8;
const MAX_SEGMENT_FRAMES: usize = 240;
const WAIT_INTERVAL: Duration = Duration::from_millis(250);
const CANCELLED: &str = "Reverse cancelled";

fn cached(app: &AppHandle, source: &Path, extension: &str) -> Option<PathBuf> {
    let path = JOB.file_for(app, source)?.with_extension(extension);
    path.is_file().then_some(path)
}

pub fn video_for(app: &AppHandle, source: &Path) -> Option<PathBuf> {
    cached(app, source, JOB.extension)
}

pub fn audio_for(app: &AppHandle, source: &Path) -> Option<(PathBuf, f64)> {
    let path = cached(app, source, AUDIO_EXTENSION)?;
    let duration = ffmpeg::probe(&path).ok()?.duration;
    Some((path, duration))
}

fn reversed_sources(project: &VideoProject) -> Vec<String> {
    let mut paths: Vec<String> = project
        .items()
        .filter_map(|item| match item {
            Item::Clip(clip) if clip.reverse && !clip.freeze => Some(&clip.media),
            Item::Audio(audio) if audio.reverse => Some(&audio.media),
            _ => None,
        })
        .filter_map(|media| project.media_path(media))
        .filter(|(_, kind)| *kind == MediaKind::Video)
        .map(|(path, _)| path.to_string())
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

pub fn pending_audio(app: &AppHandle, project: &VideoProject) -> usize {
    reversed_sources(project)
        .iter()
        .filter(|path| audio_for(app, &parse_virtual_path(path).0).is_none())
        .count()
}

struct SourceFrame {
    at: i64,
    duration: i64,
    pixels: Vec<u8>,
}

#[derive(Default)]
struct Segment {
    frames: Vec<SourceFrame>,
    size: (u32, u32),
    time_base: (i32, i32),
}

fn read_segment(
    source: &Path,
    filter: &str,
    (lower, upper): (f64, f64),
    fps: f64,
    job: &JobContext,
) -> Result<Segment, String> {
    let start = (lower - 0.5 / fps).max(0.0);
    let mut pipe = VideoPipe::open(&VideoSpec {
        path: source,
        start,
        timing: "",
        filters: filter,
        pixel_format: PROXY_FORMAT,
        frames: None,
        hwaccel: true,
        keyframes_only: false,
        low_delay: false,
        device_scale: None,
    })?;
    let mut segment = Segment::default();
    let mut buffer = Vec::new();
    while let Some(frame) = pipe.read(&mut buffer)? {
        if job.is_cancelled() {
            return Err(CANCELLED.to_string());
        }
        let tick = |time: f64| (time / q2d(frame.time_base)).round() as i64;
        let at = tick(start) + frame.pts;
        if at >= tick(upper) {
            break;
        }
        if at < tick(lower) || segment.frames.last().is_some_and(|last| at <= last.at) {
            continue;
        }
        segment.size = (frame.width, frame.height);
        segment.time_base = (frame.time_base.num, frame.time_base.den);
        segment.frames.push(SourceFrame {
            at,
            duration: if frame.duration > 0 {
                frame.duration
            } else {
                tick(1.0 / fps)
            },
            pixels: std::mem::take(&mut buffer),
        });
    }
    Ok(segment)
}

fn reverse_video(
    source: &Path,
    info: &MediaInfo,
    output: &Path,
    job: &JobContext,
) -> Result<(), String> {
    crate::video::libav::require()?;
    let (filter, encoding) =
        proxy::intermediate(info, info.width.max(info.height), PRORES_STANDARD, None);
    let fps = info.fps.max(1.0);
    let frame_bytes = (info.width as usize * info.height as usize * 4).max(1);
    let per_segment = (SEGMENT_BYTES / frame_bytes).clamp(MIN_SEGMENT_FRAMES, MAX_SEGMENT_FRAMES);
    let total = ((info.duration * fps).round() as usize).max(1);
    let last = (total - 1) / per_segment;
    let boundary = |index: usize| match index {
        0 => f64::NEG_INFINITY,
        index if index > last => f64::INFINITY,
        index => (index * per_segment) as f64 / fps,
    };
    let mut muxer: Option<Muxer> = None;
    let mut mirror: Option<(i64, i64)> = None;
    let mut written = 0usize;
    for index in (0..=last).rev() {
        let segment = read_segment(
            source,
            &filter,
            (boundary(index), boundary(index + 1)),
            fps,
            job,
        )?;
        for frame in segment.frames.iter().rev() {
            let muxer = match &mut muxer {
                Some(muxer) => muxer,
                None => muxer.insert(proxy::open_intermediate(
                    output,
                    &encoding,
                    segment.size,
                    fps,
                    segment.time_base,
                )?),
            };
            let frame_end = frame.at + frame.duration;
            let (end, next) = mirror.unwrap_or((frame_end, frame_end));
            muxer.write_video(&frame.pixels, end - next, Some(next - frame.at))?;
            mirror = Some((end, frame.at));
            written += 1;
        }
        job.progress(written as f32 / total as f32);
    }
    muxer
        .ok_or_else(|| "The video has no frames".to_string())?
        .finish()
}

fn build(source: &Path, info: &MediaInfo, target: &Path, job: &JobContext) -> Result<(), String> {
    if info.has_audio {
        let audio = crate::video::audio::reversed_wav(source)?;
        write_cache_file(&target.with_extension(AUDIO_EXTENSION), &audio)
            .map_err(|e| format!("Could not save the reversed audio: {}", e))?;
    }
    if job.is_cancelled() {
        return Err(CANCELLED.to_string());
    }
    proxy::write_atomically(target, |temp| reverse_video(source, info, temp, job))
}

fn create(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    JOB.submit(app, paths, prepare_video, build)
}

pub fn ensure(app: &AppHandle, project: &VideoProject, cancel: &AtomicBool) -> Result<(), String> {
    let paths = reversed_sources(project);
    if paths.is_empty() {
        return Ok(());
    }
    create(app, &paths)?;
    loop {
        let states = JOB.states(app, paths.clone(), job_state);
        if states.values().all(|state| *state == AnalysisState::Ready) {
            return Ok(());
        }
        if states
            .values()
            .any(|state| matches!(state, AnalysisState::Failed | AnalysisState::None))
        {
            return Err("A reversed clip could not be prepared".to_string());
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Export cancelled".to_string());
        }
        std::thread::sleep(WAIT_INTERVAL);
    }
}

#[tauri::command]
pub async fn video_reverse(paths: Vec<String>, app_handle: AppHandle) -> Result<(), String> {
    blocking(move || create(&app_handle, &paths)).await?
}

#[tauri::command]
pub async fn video_reverse_status(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<HashMap<String, AnalysisState>, String> {
    blocking(move || JOB.states(&app_handle, paths, job_state)).await
}
