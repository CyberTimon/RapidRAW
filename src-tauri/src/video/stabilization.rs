use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::video::blocking;
use crate::video::ffmpeg::MediaInfo;
use crate::video::jobs::{Cached, CachedJob, JobContext, JobState, prepare_video};
use crate::video::media::GrayVideo;
use crate::video::proxy::{read_json_cache, write_json_cache};
use crate::video::vision::{
    ANALYSIS_SIDE, GrayFrame, MotionFrame, Similarity, estimate_motion, stabilize,
};

pub(crate) const JOB: CachedJob = CachedJob {
    kind: "stabilize",
    dir: "motion",
    extension: "v2.json",
};
const BATCH: usize = 32;
const SEGMENT_FRAMES: usize = 240;
const SEGMENTS: usize = 3;
const LEVELS: [(f64, f64, f64); 4] = [
    (0.0, 1.0, 1.0),
    (0.34, 0.3, 1.06),
    (0.67, 0.1, 1.12),
    (1.0, 0.03, 1.25),
];
pub const MAX_ZOOM: f32 = LEVELS[LEVELS.len() - 1].2 as f32;

#[derive(Serialize, Deserialize)]
pub struct MotionAnalysis {
    pub fps: f64,
    pub motions: Vec<Option<Similarity>>,
}

pub struct ClipStabilization {
    first: i64,
    fps: f64,
    corrections: Vec<Similarity>,
}

impl ClipStabilization {
    fn position(&self, source_seconds: f64) -> Option<(f64, usize)> {
        let last = self.corrections.len().checked_sub(1)?;
        let position = (source_seconds * self.fps - self.first as f64).clamp(0.0, last as f64);
        Some((position, last))
    }

    pub fn frame_at(&self, source_seconds: f64) -> Option<Similarity> {
        let (position, _) = self.position(source_seconds)?;
        self.corrections.get(position.round() as usize).copied()
    }

    pub fn at(&self, source_seconds: f64) -> Option<Similarity> {
        let (position, last) = self.position(source_seconds)?;
        let index = position.floor() as usize;
        let (from, to) = (
            self.corrections[index],
            self.corrections[(index + 1).min(last)],
        );
        let t = (position - index as f64) as f32;
        let mix = |a: f32, b: f32| a + (b - a) * t;
        Some(Similarity {
            dx: mix(from.dx, to.dx),
            dy: mix(from.dy, to.dy),
            angle: mix(from.angle, to.angle),
            scale: mix(from.scale, to.scale),
        })
    }
}

pub fn load_analysis(app: &AppHandle, source: &Path) -> Option<MotionAnalysis> {
    read_json_cache(&JOB.file_for(app, source)?)
}

fn level(strength: f64) -> (f64, f64) {
    let strength = strength.clamp(0.0, 1.0);
    let upper = LEVELS
        .iter()
        .position(|&(at, _, _)| at >= strength)
        .unwrap_or(LEVELS.len() - 1)
        .max(1);
    let (a, b) = (LEVELS[upper - 1], LEVELS[upper]);
    let t = ((strength - a.0) / (b.0 - a.0).max(1e-6)).clamp(0.0, 1.0);
    (a.1 + (b.1 - a.1) * t, a.2 + (b.2 - a.2) * t)
}

pub fn for_clip(
    analysis: &MotionAnalysis,
    source_start: f64,
    source_end: f64,
    strength: f64,
    aspect: f32,
) -> Option<ClipStabilization> {
    let count = analysis.motions.len() as i64 + 1;
    let first = ((source_start * analysis.fps).floor() as i64).clamp(0, count - 1);
    let last = ((source_end * analysis.fps).ceil() as i64).clamp(first, count - 1);
    if last <= first {
        return None;
    }
    let (follow, max_zoom) = level(strength);
    let result = stabilize(
        &analysis.motions[first as usize..last as usize],
        analysis.fps as f32,
        follow,
        max_zoom as f32,
        aspect,
    );
    Some(ClipStabilization {
        first,
        fps: analysis.fps,
        corrections: result
            .corrections
            .iter()
            .map(|correction| Similarity {
                scale: correction.scale * result.zoom,
                angle: correction.angle,
                dx: correction.dx * result.zoom,
                dy: correction.dy * result.zoom,
            })
            .collect(),
    })
}

fn segment_motions(
    source: &Path,
    info: &MediaInfo,
    first: usize,
    frames: Option<u64>,
    job: &JobContext,
    report: &(impl Fn(usize) + Sync),
) -> Result<Vec<Option<Similarity>>, String> {
    let start = first as f64 / info.fps;
    let mut video = GrayVideo::open(source, info, ANALYSIS_SIDE, start, frames)?;
    let (width, height) = video.size();
    std::thread::scope(|scope| {
        let (sender, decoded) = mpsc::sync_channel::<Vec<u8>>(2 * BATCH);
        let (recycle, buffers) = mpsc::channel::<Vec<u8>>();
        scope.spawn(move || {
            loop {
                let mut luma = buffers.try_recv().unwrap_or_default();
                if !video.read(&mut luma) || sender.send(luma).is_err() {
                    break;
                }
            }
        });
        let mut motions = Vec::new();
        let mut previous: Option<MotionFrame> = None;
        loop {
            let batch: Vec<Vec<u8>> = decoded.iter().take(BATCH).collect();
            if batch.is_empty() {
                break;
            }
            if job.is_cancelled() {
                return Err("Stabilization cancelled".to_string());
            }
            let prepared: Vec<MotionFrame> = batch
                .par_iter()
                .map(|luma| MotionFrame::new(GrayFrame::from_luma8(width, height, luma)))
                .collect();
            for luma in batch {
                let _ = recycle.send(luma);
            }
            let before = motions.len();
            motions.extend(
                previous
                    .as_ref()
                    .map(|previous| estimate_motion(previous, &prepared[0])),
            );
            motions.par_extend(
                prepared
                    .par_windows(2)
                    .map(|pair| estimate_motion(&pair[0], &pair[1])),
            );
            previous = prepared.into_iter().last();
            report(motions.len() - before);
        }
        Ok(motions)
    })
}

fn analyze(source: &Path, info: &MediaInfo, target: &Path, job: &JobContext) -> Result<(), String> {
    let expected = (info.duration * info.fps).round().max(1.0) as usize;
    let count = (expected / SEGMENT_FRAMES).clamp(1, SEGMENTS);
    let starts: Vec<usize> = (0..count).map(|index| index * expected / count).collect();
    let done = AtomicUsize::new(0);
    let report = |added: usize| {
        let total = done.fetch_add(added, Ordering::Relaxed) + added;
        job.progress(total as f32 / expected as f32);
    };
    let parts: Vec<Result<Vec<Option<Similarity>>, String>> = std::thread::scope(|scope| {
        let segments: Vec<_> = starts
            .iter()
            .enumerate()
            .map(|(index, &first)| {
                let frames = starts.get(index + 1).map(|&next| (next - first + 1) as u64);
                let report = &report;
                scope.spawn(move || segment_motions(source, info, first, frames, job, report))
            })
            .collect();
        segments
            .into_iter()
            .map(|segment| {
                segment
                    .join()
                    .unwrap_or_else(|_| Err("The motion analysis crashed".to_string()))
            })
            .collect()
    });
    let mut motions = Vec::new();
    for (index, part) in parts.into_iter().enumerate() {
        let mut part = part?;
        if let Some(&next) = starts.get(index + 1) {
            part.resize(next - starts[index], None);
        }
        motions.extend(part);
    }
    if motions.is_empty() {
        return Err("The video has too few frames to stabilize".to_string());
    }
    write_json_cache(
        target,
        &MotionAnalysis {
            fps: info.fps,
            motions,
        },
    )
    .map_err(|e| format!("Could not save the motion analysis: {}", e))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AnalysisState {
    None,
    Running { progress: f32 },
    Failed,
    Ready,
}

pub fn job_state(cached: Cached) -> AnalysisState {
    match cached {
        Cached::Ready => AnalysisState::Ready,
        Cached::Job(JobState::Queued, _) => AnalysisState::Running { progress: 0.0 },
        Cached::Job(JobState::Running, progress) => AnalysisState::Running { progress },
        Cached::Job(JobState::Failed, _) => AnalysisState::Failed,
        _ => AnalysisState::None,
    }
}

#[tauri::command]
pub async fn video_stabilize(paths: Vec<String>, app_handle: AppHandle) -> Result<(), String> {
    blocking(move || JOB.submit(&app_handle, &paths, prepare_video, analyze)).await?
}

#[tauri::command]
pub async fn video_stabilize_status(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<HashMap<String, AnalysisState>, String> {
    blocking(move || JOB.states(&app_handle, paths, job_state)).await
}
