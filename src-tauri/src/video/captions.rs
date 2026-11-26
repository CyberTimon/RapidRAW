use std::sync::atomic::{AtomicU64, Ordering};

use tauri::AppHandle;
use tauri::ipc::Channel;

use crate::ai::speech::{SAMPLE_RATE, SpeechRecognizer, Word};
use crate::video::audio::{MixGraph, s16_to_f32};
use crate::video::blocking;
use crate::video::model::{VideoProject, seconds};

const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;
const MIN_CHUNK: usize = 12 * SAMPLE_RATE;
const MAX_CHUNK: usize = 28 * SAMPLE_RATE;
const READ_BLOCK: usize = 4 * SAMPLE_RATE;
const ENERGY_HOP: usize = SAMPLE_RATE / 100;
const QUIET_WINDOW: usize = 20;
const AUDIBLE_PEAK: f32 = 0.002;
const CANCELLED: &str = "cancelled";

static RUN: AtomicU64 = AtomicU64::new(0);

fn quiet_cut(samples: &[f32]) -> usize {
    let end = samples.len().min(MAX_CHUNK);
    if end <= MIN_CHUNK {
        return end;
    }
    let energy: Vec<f32> = samples[MIN_CHUNK..end]
        .chunks(ENERGY_HOP)
        .map(|hop| hop.iter().map(|sample| sample * sample).sum())
        .collect();
    let window = QUIET_WINDOW.min(energy.len());
    let mut sum: f32 = energy[..window].iter().sum();
    let (mut best, mut best_sum) = (0, sum);
    for index in window..energy.len() {
        sum += energy[index] - energy[index - window];
        if sum < best_sum {
            best = index + 1 - window;
            best_sum = sum;
        }
    }
    (MIN_CHUNK + (best * 2 + window) * ENERGY_HOP / 2).min(end)
}

fn transcribe_project(
    project: &VideoProject,
    model_dir: &std::path::Path,
    run: u64,
    on_progress: &Channel<f32>,
) -> Result<Vec<Word>, String> {
    let mix = MixGraph::new(project, None);
    if mix.is_empty() {
        return Ok(Vec::new());
    }
    let total = (seconds(project.end_ticks()) * SAMPLE_RATE as f64).round() as usize;
    let mut audio = mix.open_libav("s16", SAMPLE_RATE as u32, "mono", Some(READ_BLOCK as u32))?;
    let mut recognizer = SpeechRecognizer::load(model_dir)
        .map_err(|e| format!("Could not load the speech model: {}", e))?;
    let (mut buffer, mut bytes, mut read, mut done) = (Vec::new(), Vec::new(), 0, 0);
    let mut words = Vec::new();
    while done < total {
        if RUN.load(Ordering::Acquire) != run {
            return Err(CANCELLED.to_string());
        }
        while buffer.len() < MAX_CHUNK && read < total {
            let block = READ_BLOCK.min(total - read);
            bytes.clear();
            audio.read_interleaved(&mut bytes, block * 2)?;
            buffer.extend(s16_to_f32(&bytes));
            read += block;
        }
        let cut = if read == total && buffer.len() <= MAX_CHUNK {
            buffer.len()
        } else {
            quiet_cut(&buffer)
        };
        let chunk = &buffer[..cut];
        if chunk.iter().any(|sample| sample.abs() > AUDIBLE_PEAK) {
            words.extend(
                recognizer
                    .transcribe(chunk, done as f64 / SAMPLE_RATE as f64)
                    .map_err(|e| format!("Speech recognition failed: {}", e))?,
            );
        }
        buffer.drain(..cut);
        done += cut;
        let _ = on_progress.send(done as f32 / total as f32);
    }
    Ok(words)
}

#[tauri::command]
pub async fn video_transcribe(
    project: VideoProject,
    on_progress: Channel<f32>,
    app_handle: AppHandle,
) -> Result<Vec<Word>, String> {
    let run = RUN.fetch_add(1, Ordering::AcqRel) + 1;
    let cancelled = || RUN.load(Ordering::Acquire) != run;
    let model_dir = crate::ai::models::get_or_download_speech_model(&app_handle, &cancelled).await;
    if cancelled() {
        return Err(CANCELLED.to_string());
    }
    let model_dir = model_dir.map_err(|e| format!("Could not download the speech model: {}", e))?;
    blocking(move || transcribe_project(&project, &model_dir, run, &on_progress)).await?
}

#[tauri::command]
pub fn video_cancel_transcription() {
    RUN.fetch_add(1, Ordering::AcqRel);
}

#[tauri::command]
pub fn video_speech_model_ready(app_handle: AppHandle) -> bool {
    crate::ai::models::speech_model_downloaded(&app_handle)
}

#[tauri::command]
pub fn video_read_subtitles(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_SUBTITLE_BYTES {
        return Err("The subtitle file is too large".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned())
}

#[tauri::command]
pub fn video_write_subtitles(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}
