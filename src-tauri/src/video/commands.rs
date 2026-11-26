use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use image::{DynamicImage, GenericImage, GenericImageView};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use crate::app::settings::load_settings;
use crate::app::state::{AppState, PreviewTask};
use crate::decode::formats::{is_audio_file, is_raw_file, is_video_file};
use crate::decode::image_loader::get_or_decode_pristine;
use crate::decode::white_balance::WhiteBalance;
use crate::library::sidecars::parse_virtual_path;
use crate::video::blocking;
use crate::video::camera_log::CameraLog;
use crate::video::engine::shutter::StillShutter;
use crate::video::ffmpeg::{self, MediaInfo};
use crate::video::libav;
use crate::video::libav::video::{VideoPipe, VideoSpec};
use crate::video::proxy::{cache_file, fingerprint, write_cache_file};
use crate::video::timelapse::Deflicker;

const LONG_MEDIA_SECONDS: f64 = 60.0;
const STRIP_BUILDS: usize = 2;
const CANCELLED: &str = "Cancelled";
const CANCELLED_TICKETS: usize = 64;
const STRIPS_DIR: &str = "strips";
const FILMSTRIP_QUALITY: u8 = 82;
const WAVEFORM_RATE: u32 = 8000;

#[derive(Serialize)]
pub struct FrameSize {
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_raw: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    as_shot_white_balance: Option<WhiteBalance>,
}

fn source_path(path: &str) -> std::path::PathBuf {
    parse_virtual_path(path).0
}

#[tauri::command]
pub async fn video_probe(path: String, app_handle: AppHandle) -> Result<MediaInfo, String> {
    let source = source_path(&path);
    crate::integrations::immich::ensure_media(&app_handle, &source).await?;
    blocking(move || {
        if is_video_file(&source) || is_audio_file(&source) {
            crate::video::warm_up();
            return crate::video::timelapse::probe(&source);
        }
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let state = app_handle.state::<AppState>();
        let (image, _) = get_or_decode_pristine(&state, &source, &settings, None)?;
        let (width, height) = image.dimensions();
        Ok(MediaInfo::still(width, height, is_raw_file(&source)))
    })
    .await?
}

pub fn shown_info(
    source: &Path,
    log: Option<CameraLog>,
    deflicker: Option<bool>,
) -> Result<MediaInfo, String> {
    Ok(MediaInfo {
        deflicker: crate::video::timelapse::deflicker(source, deflicker.unwrap_or_default(), false),
        ..ffmpeg::probe(source)?.with_log(log)
    })
}

#[tauri::command]
pub async fn video_seek(
    path: String,
    time: f64,
    log: Option<CameraLog>,
    deflicker: Option<bool>,
    shutter: Option<StillShutter>,
    app_handle: AppHandle,
) -> Result<FrameSize, String> {
    let load_epoch = current_load_epoch(&app_handle);
    let seek_path = path.clone();
    let app = app_handle.clone();
    let image = blocking(move || {
        let source = source_path(&seek_path);
        let info = shown_info(&source, log, deflicker)?;
        crate::decode::as_shot::record_source_peak(&seek_path, info.source_peak());
        let blurred = match &shutter {
            Some(shutter) => {
                crate::video::engine::shutter::still(&app, &source, &info, time, shutter)?
            }
            None => None,
        };
        blurred.map_or_else(
            || crate::video::frames::decode_frame(&source, &info, time, None),
            Ok,
        )
    })
    .await??;
    install_image(
        &app_handle,
        &path,
        image,
        time,
        deflicker.unwrap_or_default(),
        load_epoch,
    )
    .await
}

pub fn current_load_epoch(app_handle: &AppHandle) -> usize {
    app_handle
        .state::<AppState>()
        .image_load_epoch
        .load(std::sync::atomic::Ordering::SeqCst)
}

pub async fn install_image(
    app_handle: &AppHandle,
    path: &str,
    image: Arc<DynamicImage>,
    time: f64,
    deflicker: bool,
    load_epoch: usize,
) -> Result<FrameSize, String> {
    let (width, height) = image.dimensions();
    let worker = app_handle
        .state::<AppState>()
        .preview_worker_tx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("Preview worker not running")?;
    let source = crate::video::frame_source(path, image, time, deflicker);
    let size = FrameSize {
        width,
        height,
        is_raw: source.is_raw.then_some(true),
        as_shot_white_balance: source.is_raw.then_some(source.as_shot.white_balance),
    };
    let (installed, done) = tokio::sync::oneshot::channel();
    worker
        .send(PreviewTask::InstallFrame(source, load_epoch, installed))
        .map_err(|e| format!("Failed to send the frame to the preview worker: {}", e))?;
    let installed = done
        .await
        .map_err(|_| "The preview worker dropped the frame".to_string())?;
    if !installed {
        return Err("Frame install cancelled".to_string());
    }
    Ok(size)
}

struct Waiter {
    ticket: Option<u64>,
    cancel: Arc<AtomicBool>,
    wake: tokio::sync::oneshot::Sender<Turn>,
}

struct LaneState {
    active: usize,
    waiting: Vec<Waiter>,
    running: Vec<(u64, Arc<AtomicBool>)>,
    cancelled: Vec<u64>,
}

struct Lane {
    limit: usize,
    state: Mutex<LaneState>,
}

struct Turn {
    lane: &'static Lane,
    ticket: Option<u64>,
    cancel: Arc<AtomicBool>,
}

static FILMSTRIPS: Lane = Lane::new(STRIP_BUILDS);
static WAVEFORMS: Lane = Lane::new(STRIP_BUILDS);

impl Lane {
    const fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(LaneState {
                active: 0,
                waiting: Vec::new(),
                running: Vec::new(),
                cancelled: Vec::new(),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, LaneState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn turn(&'static self, ticket: Option<u64>) -> Result<Turn, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        let woken = {
            let mut state = self.state();
            if let Some(index) = ticket.and_then(|ticket| {
                state
                    .cancelled
                    .iter()
                    .position(|cancelled| *cancelled == ticket)
            }) {
                state.cancelled.remove(index);
                return Err(CANCELLED.to_string());
            }
            if state.active >= self.limit {
                let (wake, woken) = tokio::sync::oneshot::channel();
                state.waiting.push(Waiter {
                    ticket,
                    cancel,
                    wake,
                });
                woken
            } else {
                state.active += 1;
                if let Some(ticket) = ticket {
                    state.running.push((ticket, Arc::clone(&cancel)));
                }
                return Ok(Turn {
                    lane: self,
                    ticket,
                    cancel,
                });
            }
        };
        woken.await.map_err(|_| CANCELLED.to_string())
    }

    fn cancel(&self, ticket: u64) {
        let mut state = self.state();
        let waiting = state.waiting.len();
        state.waiting.retain(|waiter| waiter.ticket != Some(ticket));
        let running = state.running.iter().find(|(running, _)| *running == ticket);
        if let Some((_, cancel)) = running {
            cancel.store(true, Ordering::Relaxed);
        } else if state.waiting.len() == waiting {
            if state.cancelled.len() >= CANCELLED_TICKETS {
                state.cancelled.remove(0);
            }
            state.cancelled.push(ticket);
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut state = self.lane.state();
        if let Some(ticket) = self.ticket {
            state.running.retain(|(running, _)| *running != ticket);
        }
        let Some(waiter) = state.waiting.pop() else {
            state.active -= 1;
            return;
        };
        if let Some(ticket) = waiter.ticket {
            state.running.push((ticket, Arc::clone(&waiter.cancel)));
        }
        drop(state);
        let _ = waiter.wake.send(Turn {
            lane: self.lane,
            ticket: waiter.ticket,
            cancel: waiter.cancel,
        });
    }
}

fn filmstrip(
    path: &Path,
    count: u32,
    height: u32,
    deflicker: Option<&Deflicker>,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let info = ffmpeg::probe(path)?;
    let mut pipe = VideoPipe::open(&VideoSpec {
        path,
        start: 0.0,
        timing: &format!("fps={:.6}", count as f64 / info.duration.max(0.01)),
        filters: &format!("scale=-2:{}", height),
        pixel_format: "rgb24",
        frames: Some(count as u64),
        hwaccel: true,
        keyframes_only: info.duration > LONG_MEDIA_SECONDS,
        low_delay: false,
        device_scale: None,
    })?;
    let mut sprite: Option<image::RgbImage> = None;
    let mut pixels = Vec::new();
    for index in 0..count {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let Some(frame) = pipe.read(&mut pixels)? else {
            break;
        };
        if let Some(deflicker) = deflicker {
            deflicker.apply_codes(&mut pixels, pipe.source_time());
        }
        let tile =
            image::RgbImage::from_raw(frame.width, frame.height, std::mem::take(&mut pixels))
                .ok_or("The filmstrip has an unexpected size")?;
        sprite
            .get_or_insert_with(|| image::RgbImage::new(frame.width * count, frame.height))
            .copy_from(&tile, index * frame.width, 0)
            .map_err(|e| e.to_string())?;
        pixels = tile.into_raw();
    }
    let sprite =
        sprite.ok_or_else(|| format!("Could not read frames from '{}'", path.display()))?;
    encode_filmstrip(&sprite)
}

pub fn encode_filmstrip(sprite: &image::RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, FILMSTRIP_QUALITY)
        .encode_image(sprite)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

async fn cached_strip(
    app: AppHandle,
    lane: &'static Lane,
    ticket: Option<u64>,
    source: PathBuf,
    name: String,
    extension: &'static str,
    build: impl FnOnce(&Path, &AtomicBool) -> Result<Vec<u8>, String> + Send + 'static,
) -> Result<Response, String> {
    let (cached, bytes) = blocking(move || {
        let cached = cache_file(
            &app,
            STRIPS_DIR,
            &format!("{}-{}", fingerprint(&source)?, name),
            extension,
        )?;
        let bytes = std::fs::read(&cached).ok();
        Ok::<_, String>(((cached, source), bytes))
    })
    .await??;
    if let Some(bytes) = bytes {
        return Ok(Response::new(bytes));
    }
    let turn = lane.turn(ticket).await?;
    let bytes = blocking(move || {
        let (cached, source) = cached;
        if let Ok(bytes) = std::fs::read(&cached) {
            return Ok(bytes);
        }
        let bytes = build(&source, &turn.cancel)?;
        let _ = write_cache_file(&cached, &bytes);
        Ok::<_, String>(bytes)
    })
    .await??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn video_filmstrip(
    path: String,
    count: u32,
    height: u32,
    deflicker: Option<bool>,
    ticket: Option<u64>,
    app_handle: AppHandle,
) -> Result<Response, String> {
    let source = source_path(&path);
    let (count, height) = (count.clamp(1, 64), height.clamp(16, 256));
    let deflicker = match deflicker {
        Some(true) => {
            let source = source.clone();
            blocking(move || crate::video::timelapse::deflicker(&source, true, false)).await?
        }
        _ => None,
    };
    let name = match &deflicker {
        Some(deflicker) => format!(
            "filmstrip-{}x{}-d{:016x}",
            count,
            height,
            crate::video::hash_of(deflicker)
        ),
        None => format!("filmstrip-{}x{}", count, height),
    };
    cached_strip(
        app_handle,
        &FILMSTRIPS,
        ticket,
        source,
        name,
        "jpg",
        move |source, cancel| filmstrip(source, count, height, deflicker.as_ref(), cancel),
    )
    .await
}

fn waveform(path: &Path, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let samples = crate::video::audio::decode_mono(path, WAVEFORM_RATE)?;
    let mut picture = image::RgbaImage::new(width, height);
    if !samples.is_empty() {
        for x in 0..width {
            let from = samples.len() * x as usize / width as usize;
            let to = (samples.len() * (x as usize + 1) / width as usize).max(from + 1);
            let peak = samples[from..to.min(samples.len())]
                .iter()
                .map(|sample| sample.abs())
                .fold(0.0f32, f32::max);
            let extent = (peak.sqrt() * height as f32 * 0.5).round() as i64;
            let center = height as i64 / 2;
            for y in (center - extent).max(0)..(center + extent).min(height as i64) {
                picture.put_pixel(x, y as u32, image::Rgba([255, 255, 255, 255]));
            }
        }
    }
    let mut bytes = Vec::new();
    picture
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[tauri::command]
pub async fn video_waveform(
    path: String,
    width: u32,
    height: u32,
    ticket: Option<u64>,
    app_handle: AppHandle,
) -> Result<Response, String> {
    let (width, height) = (width.clamp(64, 8192), height.clamp(16, 512));
    cached_strip(
        app_handle,
        &WAVEFORMS,
        ticket,
        source_path(&path),
        format!("waveform-{}x{}", width, height),
        "png",
        move |source, _| waveform(source, width, height),
    )
    .await
}

#[tauri::command]
pub fn video_cancel_strip(ticket: u64) {
    FILMSTRIPS.cancel(ticket);
    WAVEFORMS.cancel(ticket);
}

#[tauri::command]
pub fn video_ffmpeg_version() -> Option<String> {
    libav::version()
}
