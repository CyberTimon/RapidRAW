use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::file_management::parse_virtual_path;
use crate::formats::is_raw_file;
use crate::image_processing::{apply_linear_to_srgb, apply_srgb_to_linear};
use crate::panorama_utils::camera::parse_focal_mm_35eq;
use crate::panorama_utils::log::{self as stitch_log, StitchLog};
use crate::panorama_utils::overlay::generate_overlay;
use crate::panorama_utils::raster::{Rgb32f, fit_long_edge, fit_rgb};
use crate::panorama_utils::session::{
    DroppedImage, NormalizedCrop, PanoramaSession, WorkingFrame, drop_session,
};
use crate::panorama_utils::stitch::project::Projection;
use crate::panorama_utils::stitch::{self, Composed, Frame, FrameMeta, PanoOptions};
use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, ImageFormat, Rgb32FImage};

type Rgb16Buf = image::ImageBuffer<image::Rgb<u16>, Vec<u16>>;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

pub const PREVIEW_EDGE: usize = 1024;

pub const BRIEF_DESCRIPTOR_SIZE: usize = 256;

pub type Descriptor = [u8; BRIEF_DESCRIPTOR_SIZE / 8];

#[derive(Debug, Clone, Copy)]
pub struct KeyPoint {
    pub x: u32,
    pub y: u32,
}

pub struct Feature {
    pub keypoint: KeyPoint,
    pub descriptor: Descriptor,
}

#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub index1: usize,
    pub index2: usize,
}
#[tauri::command]
// Builds a preview from the selected photos.
pub async fn stitch_panorama(
    paths: Vec<String>,
    crop_factor: f64,
    focal35: f64,
    estimate_intrinsics: bool,
    scale: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _ = (&crop_factor, &focal35, &estimate_intrinsics);
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }
    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();
    let session_handle = state.panorama_session.clone();
    let stop = arm_stop(&state);
    let log_path = pano_log_path(&source_paths[0]);
    let log = StitchLog::create(&log_path, stop.clone())?;
    log.line(&format!(
        "merge started files={} scale={scale}",
        source_paths.len()
    ));
    let task = tokio::task::spawn_blocking(move || {
        let _guard = stitch_log::install(log);
        if stitch_log::halted() {
            stitch_log::note_stop();
            return Ok(());
        }
        match run_stitch(&source_paths, &scale, true, &app_handle) {
            Ok(session) => {
                let payload = complete_payload(&session);
                {
                    let mut slot = session_handle.lock().unwrap();
                    if stitch_log::halted() {
                        drop_session(&mut slot);
                        stitch_log::note_stop();
                        return Ok(());
                    }
                    *slot = Some(session);
                }
                if stitch_log::halted() {
                    if let Ok(mut slot) = session_handle.try_lock() {
                        drop_session(&mut slot);
                    }
                    stitch_log::note_stop();
                    return Ok(());
                }
                stitch_log::line("preview ready");
                let _ = app_handle.emit("panorama-complete", payload);
                Ok(())
            }
            Err(e) if e == "stopped" || stitch_log::halted() => {
                stitch_log::note_stop();
                Ok(())
            }
            Err(e) => {
                stitch_log::line(&format!("failed: {e}"));
                log::error!("Panorama failed:\n{}", e);
                let _ = app_handle.emit("panorama-error", e.clone());
                Err(e)
            }
        }
    });
    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(format!("Panorama task failed: {}", join_err)),
    }
}

#[tauri::command]
// Rebuilds the preview in another projection.
pub async fn reproject_panorama(
    projection: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let proj = Projection::parse(&projection)
        .ok_or_else(|| format!("Unknown projection: {}", projection))?;
    let session_handle = state.panorama_session.clone();
    let stop = arm_stop(&state);
    let log_path = {
        let guard = state.panorama_session.lock().unwrap();
        guard
            .as_ref()
            .and_then(|session| session.source_paths.first().map(|p| pano_log_path(p)))
    };
    let log = match log_path {
        Some(path) => StitchLog::append(&path, stop.clone())?,
        None => return Err("No panorama session. Run stitch first.".into()),
    };
    log.line(&format!("reproject {projection}"));
    let task = tokio::task::spawn_blocking(move || {
        let _guard = stitch_log::install(log);
        if stitch_log::halted() {
            stitch_log::note_stop();
            return Ok(());
        }
        let mut guard = session_handle.lock().unwrap();
        let session = guard
            .as_mut()
            .ok_or_else(|| "No panorama session. Run stitch first.".to_string())?;
        session.selected_projection = proj;
        session.crop_edited = false;
        let _ = app_handle.emit("panorama-progress", "Reprojecting preview...");
        let progress = |msg: &str, _frac: f64| {
            let _ = app_handle.emit("panorama-progress", msg.to_string());
        };
        let rendered = match render_preview(session, proj, &progress) {
            Ok(r) => r,
            Err(e) if e == "stopped" || stitch_log::halted() => {
                stitch_log::note_stop();
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        if stitch_log::halted() {
            stitch_log::note_stop();
            return Ok(());
        }
        fill_preview(session, &rendered)?;
        let payload = complete_payload(session);
        stitch_log::line("preview ready");
        let _ = app_handle.emit("panorama-complete", payload);
        Ok(())
    });
    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(format!("Reproject task failed: {}", join_err)),
    }
}

#[tauri::command]
// Stops the stitch that is running.
pub async fn cancel_panorama(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .panorama_stop
        .lock()
        .unwrap()
        .store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.panorama_session.try_lock() {
        drop_session(&mut guard);
    }
    Ok(())
}

fn arm_stop(state: &AppState) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut slot = state.panorama_stop.lock().unwrap();
    slot.store(true, Ordering::SeqCst);
    *slot = flag.clone();
    flag
}

fn pano_log_path(first: &str) -> PathBuf {
    let (path, _) = parse_virtual_path(first);
    let parent = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");
    parent.join(format!("{stem}_Pano.pano.log"))
}

#[tauri::command]
// Writes the full panorama so it matches the preview.
pub async fn save_panorama(
    first_path_str: String,
    crop: Option<NormalizedCrop>,
    quality: Option<f64>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let stop = arm_stop(&state);
    let session_slot = state.panorama_session.clone();
    let mut session = {
        let mut guard = state.panorama_session.lock().unwrap();
        guard
            .take()
            .ok_or_else(|| "No panorama session found to save.".to_string())?
    };
    let log_path = match session.source_paths.first() {
        Some(path) => pano_log_path(path),
        None => {
            if let Ok(mut guard) = session_slot.lock() {
                *guard = Some(session);
            }
            return Err("No panorama session found to save.".to_string());
        }
    };
    let log = match StitchLog::append_since(&log_path, stop, session.log_origin) {
        Ok(log) => log,
        Err(err) => {
            if let Ok(mut guard) = session_slot.lock() {
                *guard = Some(session);
            }
            return Err(err);
        }
    };
    let crop = crop.unwrap_or_else(|| session.crop.copy());
    session.quality = quality.unwrap_or(1.0).clamp(MIN_QUALITY, 1.0);
    let task = tokio::task::spawn_blocking(move || {
        let _guard = stitch_log::install(log);
        stitch_log::line("save started");
        let result = save_composite(&mut session, &first_path_str, &crop, &app_handle);
        match &result {
            Ok(_) => {}
            Err(e) if e == "stopped" || stitch_log::halted() => stitch_log::note_stop(),
            Err(e) => stitch_log::line(&format!("failed: {e}")),
        }
        let mut session = session;
        session.clear_temps();
        (result, session)
    });
    match task.await {
        Ok((Ok(path), _session)) => Ok(path),
        Ok((Err(e), session)) => {
            if let Ok(mut guard) = session_slot.lock() {
                *guard = Some(session);
            }
            Err(e)
        }
        Err(join_err) => Err(format!("Save panorama failed: {}", join_err)),
    }
}

const MIN_QUALITY: f64 = 0.25;

const QUALITY_STEP: f64 = 0.90;

const MAX_ATTEMPTS: usize = 5;

fn compose_with_retries(
    frames: &[stitch::Frame],
    reg: &stitch::Registration,
    opts: &PanoOptions,
    output_path: &std::path::Path,
    progress: &stitch::ComposeProgress<'_>,
    note: &std::sync::Mutex<Option<serde_json::Value>>,
    app: &AppHandle,
) -> Result<stitch::Composed, String> {
    let gb = 1e9;
    let mut quality = opts.quality.clamp(MIN_QUALITY, 1.0);
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        let attempt_opts = PanoOptions {
            quality,
            ..opts.clone()
        };
        let scratch = crate::panorama_utils::spill::Scratch::new(output_path, SPILL_PERCENT);
        progress("Rendering full resolution...", 0.0);
        let result = stitch::compose(
            frames,
            reg,
            opts.projection,
            &attempt_opts,
            Some(&scratch),
            progress,
        );
        match result {
            Ok(mut rendered) => {
                if let Some(at) = scratch.spilled_at() {
                    let note_payload = Some(serde_json::json!({
                        "code": "spilling",
                        "percent": (at as f64 / 1e9 * 10.0).round() / 10.0,
                    }));
                    *note.lock().unwrap() = note_payload.clone();
                    let _ = app.emit(
                        "panorama-save-progress",
                        serde_json::json!({
                            "percent": BAR_AFTER_FINISH,
                            "message": "spilling",
                            "note": note_payload,
                        }),
                    );
                }
                if attempt > 1 {
                    stitch_log::line(&format!(
                        "save succeeded at {:.0}% after {attempt} attempts",
                        quality * 100.0
                    ));
                }
                rendered.saved_quality = quality;
                rendered.saved_attempts = attempt as u32;
                return Ok(rendered);
            }
            Err(err) if err == "stopped" || stitch_log::halted() => {
                stitch_log::note_stop();
                return Err("stopped".to_string());
            }
            Err(err) => {
                last_error = err.clone();
                let peak = scratch.peak_resident();
                let disk = scratch.disk_bytes();
                stitch_log::line(&format!(
                    "attempt {attempt} at {:.0}% failed: {err} (peak {:.1} GB, disk {:.1} GB)",
                    quality * 100.0,
                    peak as f64 / gb,
                    disk as f64 / gb
                ));
                let step = if attempt >= MAX_ATTEMPTS {
                    MIN_QUALITY
                } else if attempt == 1 {
                    fit_quality(frames, reg, opts.projection, quality, peak)
                } else {
                    quality * QUALITY_STEP
                };
                let next = step.clamp(MIN_QUALITY, quality * QUALITY_STEP);
                if next >= quality {
                    break;
                }
                let from = quality;
                quality = next;
                let note_payload = Some(serde_json::json!({
                    "code": "retrying",
                    "percent": (from * 100.0).round(),
                    "next": (quality * 100.0).round(),
                }));
                *note.lock().unwrap() = note_payload.clone();
                let _ = app.emit(
                    "panorama-save-progress",
                    serde_json::json!({
                        "percent": 10,
                        "message": "retrying",
                        "note": note_payload,
                    }),
                );
            }
        }
    }
    stitch_log::line(&format!(
        "impossible after {MAX_ATTEMPTS} attempts: {last_error}"
    ));
    Err("impossible".to_string())
}

const SPILL_PERCENT: u64 = 95;

const BAR_AFTER_LOAD: f64 = 8.0;
const BAR_AFTER_REGISTER: f64 = 12.0;
const BAR_AFTER_PROJECT: f64 = 18.0;
const BAR_AFTER_EXPOSURE: f64 = 22.0;
const BAR_AFTER_BLEND: f64 = 64.0;
const BAR_AFTER_FINISH: f64 = 68.0;

fn save_phase_percent(msg: &str, frac: f64) -> f64 {
    let frac = frac.clamp(0.0, 1.0);
    let (start, end) = match msg {
        "Projecting" => (BAR_AFTER_REGISTER, BAR_AFTER_PROJECT),
        "Exposure compensation" => (BAR_AFTER_PROJECT, BAR_AFTER_EXPOSURE),
        "Blending" => (BAR_AFTER_EXPOSURE, BAR_AFTER_BLEND),
        "Finishing" => (BAR_AFTER_BLEND, BAR_AFTER_FINISH),
        _ => (BAR_AFTER_REGISTER, BAR_AFTER_REGISTER),
    };
    start + (end - start) * frac
}

fn fit_quality(
    frames: &[stitch::Frame],
    reg: &stitch::Registration,
    projection: Projection,
    tried: f64,
    measured_peak: u64,
) -> f64 {
    let used_cams: Vec<Option<stitch::camera::Camera>> =
        reg.used.iter().map(|&i| reg.cameras[i]).collect();
    let sizes: Vec<(usize, usize)> = reg
        .used
        .iter()
        .map(|&i| (frames[i].width(), frames[i].height()))
        .collect();
    let fmed = {
        let mut f: Vec<f64> = used_cams.iter().flatten().map(|c| c.f).collect();
        f.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        f.get(f.len() / 2).copied().unwrap_or(1.0)
    };
    let Some(m) = stitch::Measure::new(&sizes, &used_cams, projection, fmed) else {
        return tried * QUALITY_STEP;
    };
    if measured_peak == 0 {
        return tried * QUALITY_STEP;
    }
    let ceiling = measured_peak.saturating_mul(9) / 10;
    let (mut lo, mut hi) = (0.0f64, tried);
    for _ in 0..40 {
        let mid = 0.5 * (lo + hi);
        let cost = m.cost_at(mid).total(m.canvas_pixels(mid) as u64);
        if cost <= ceiling {
            lo = mid;
        } else {
            hi = mid;
        }
        if (hi - lo).abs() < 0.01 {
            break;
        }
    }
    lo.clamp(MIN_QUALITY, tried)
}

fn load_frames(
    source_paths: &[String],
    settings: &crate::app_settings::AppSettings,
    preview: bool,
    half: bool,
    progress: &(dyn Fn(&str) + Sync),
) -> Result<Vec<Frame>, String> {
    let log = stitch_log::current();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .build()
        .map_err(|e| format!("Could not start the loader: {e}"))?;
    let edge = if preview { Some(PREVIEW_EDGE) } else { None };
    let loaded: Result<Vec<Frame>, String> = pool.install(|| {
        source_paths
            .par_iter()
            .enumerate()
            .map(|(i, path)| {
                let _guard = log.clone().map(stitch_log::install);
                stitch_log::gate()?;
                let name = file_name(path);
                progress(&format!(
                    "Loading {}/{}: {}",
                    i + 1,
                    source_paths.len(),
                    name
                ));
                let (rgb, fw, fh, exif) = load_linear(path, settings)?;
                let mut img = Rgb32f {
                    width: fw as usize,
                    height: fh as usize,
                    data: rgb_to_pixels(&rgb),
                };
                for p in img.data.iter_mut() {
                    for v in p.iter_mut() {
                        *v = v.max(0.0);
                    }
                }
                let clip = stitch::detect_clip(&img);
                if let Some(m) = edge
                    && img.width.max(img.height) > m
                {
                    img = fit_long_edge(&img, m);
                } else if half {
                    img = fit_rgb(&img, (img.width / 2).max(1), (img.height / 2).max(1));
                }
                stitch_log::line(&format!(
                    "loaded {}/{} {name} {}x{} clip {:.4} half={half} preview={preview}",
                    i + 1,
                    source_paths.len(),
                    img.width,
                    img.height,
                    clip
                ));
                Ok(Frame {
                    name,
                    width: img.width,
                    height: img.height,
                    native_width: fw as usize,
                    native_height: fh as usize,
                    rgb: img.data.iter().flat_map(|p| p.to_vec()).collect(),
                    clip,
                    exposure: exposure_value(&exif),
                    focal35: Some(parse_focal_mm_35eq(&exif)),
                    meta: Some(frame_meta(&exif)),
                })
            })
            .collect()
    });
    loaded
}

fn plan_scale(source_paths: &[String], scale: &str, app: &AppHandle) -> Result<bool, String> {
    if source_paths.is_empty() {
        return Err("No photos to stitch.".into());
    }
    if scale == "half" {
        let _ = app.emit("panorama-progress", "Using half size as requested.");
        return Ok(true);
    }
    Ok(false)
}

fn run_stitch(
    source_paths: &[String],
    scale: &str,
    preview: bool,
    app: &AppHandle,
) -> Result<PanoramaSession, String> {
    let half = if preview {
        false
    } else {
        plan_scale(source_paths, scale, app)?
    };
    let settings = load_settings(app.clone()).unwrap_or_default();
    let frames = load_frames(source_paths, &settings, preview, half, &|m| {
        let _ = app.emit("panorama-progress", m.to_string());
    })?;
    let progress = |msg: &str, _frac: f64| {
        let _ = app.emit("panorama-progress", msg.to_string());
    };
    stitch_log::line(&format!("run preview={preview} half={half}"));
    let reg = stitch::register(&frames)?;
    stitch_log::line(&format!(
        "registered used={} rmsPx {:.3} -> {:.3}",
        reg.used.len(),
        reg.rms_before,
        reg.rms
    ));
    let opts = PanoOptions {
        projection: Projection::Auto,
        boundary_warp: 0.0,
        auto_crop: true,
        fill_edges: false,
        quality: 1.0,
        preview_canvas: None,
        save_scale: 1.0,
        frame_scale: if preview {
            median_ratio(
                frames
                    .iter()
                    .filter(|f| f.width > 0)
                    .map(|f| f.native_width as f64 / f.width as f64),
            )
        } else {
            1.0
        },
    };
    let recommended = stitch::choose_projection(&frames, &reg.cameras);
    let meta: std::collections::HashMap<String, FrameMeta> = frames
        .iter()
        .filter_map(|f| f.meta.clone().map(|m| (f.name.clone(), m)))
        .collect();
    let focal_outliers: std::collections::HashMap<String, bool> = frames
        .iter()
        .enumerate()
        .filter(|(i, _)| reg.focal_outlier.get(*i).copied().unwrap_or(false))
        .map(|(_, f)| (f.name.clone(), true))
        .collect();
    let dropped: Vec<DroppedImage> = (0..frames.len())
        .filter(|i| !reg.used.contains(i))
        .map(|i| DroppedImage {
            filename: frames[i].name.clone(),
            reason: frames[i]
                .meta
                .as_ref()
                .and_then(|m| m.focal35.or(m.native_mm))
                .map(|f| format!("no overlap with the rest of the set ({f:.0} mm 35mm-equivalent)"))
                .unwrap_or_else(|| "no overlap with the rest of the set".to_string()),
        })
        .collect();
    let mut session = PanoramaSession {
        quality: 1.0,
        source_paths: source_paths.to_vec(),
        kept_indices: reg.used.clone(),
        meta,
        focal_outliers,
        dropped,
        preview_png_base64: String::new(),
        overlay_png_base64: String::new(),
        winner_map_png_base64: String::new(),
        filenames: reg
            .used
            .iter()
            .filter_map(|&i| frames.get(i).map(|f| f.name.clone()))
            .collect(),
        recommended_projection: recommended,
        selected_projection: recommended,
        crop: NormalizedCrop::default(),
        crop_edited: false,
        registration: reg.clone(),
        preview_width: 0,
        preview_height: 0,
        temp_dir: None,
        composite: Vec::new(),
        composite_width: 0,
        composite_height: 0,
        frames: frames
            .iter()
            .map(|f| WorkingFrame {
                name: f.name.clone(),
                width: f.width,
                height: f.height,
                native_width: f.native_width,
                native_height: f.native_height,
                rgb: f.rgb.clone(),
                clip: f.clip,
                exposure: f.exposure,
                focal35: f.focal35,
            })
            .collect(),
        options: opts,
        half,
        preview_scale: 1.0,
        log_origin: stitch_log::started().unwrap_or_else(std::time::Instant::now),
    };
    let rendered = stitch::compose(
        &frames,
        &reg,
        recommended,
        &session.options.clone(),
        None,
        &progress,
    )?;
    fill_preview(&mut session, &rendered)?;
    Ok(session)
}

fn fill_preview(session: &mut PanoramaSession, rendered: &Composed) -> Result<(), String> {
    session.preview_scale = rendered.scale;
    let (w, h) = (rendered.width, rendered.height);
    session.composite = rendered
        .image
        .data
        .iter()
        .flat_map(|p| p.to_vec())
        .collect();
    session.composite_width = w as u32;
    session.composite_height = h as u32;
    if !session.crop_edited {
        session.crop = match rendered.crop {
            Some(c) => NormalizedCrop {
                x: c[0],
                y: c[1],
                width: c[2],
                height: c[3],
            },
            None => NormalizedCrop::default(),
        };
    }
    let (dw, dh) = display_size(w as u32, h as u32);
    let img = Rgb32FImage::from_raw(w as u32, h as u32, session.composite.clone())
        .ok_or_else(|| "Could not build preview.".to_string())?;
    let small = image::imageops::resize(&img, dw, dh, image::imageops::FilterType::Lanczos3);
    let display = apply_linear_to_srgb(DynamicImage::ImageRgb32F(small));
    session.preview_png_base64 = encode_png(&display.to_rgb8())?;
    let winners = resize_winners(&rendered.label, w as u32, h as u32, dw, dh);
    let overlay = generate_overlay(&winners, dw, dh)?;
    session.overlay_png_base64 = general_purpose::STANDARD.encode(overlay.boundary_png);
    session.winner_map_png_base64 = general_purpose::STANDARD.encode(overlay.winner_map_png);
    session.preview_width = dw;
    session.preview_height = dh;
    Ok(())
}

fn render_preview(
    session: &mut PanoramaSession,
    projection: Projection,
    progress: &stitch::ComposeProgress<'_>,
) -> Result<Composed, String> {
    let frames: Vec<Frame> = session
        .frames
        .iter()
        .map(|f| Frame {
            name: f.name.clone(),
            width: f.width,
            height: f.height,
            native_width: f.native_width,
            native_height: f.native_height,
            rgb: f.rgb.clone(),
            clip: f.clip,
            exposure: f.exposure,
            focal35: f.focal35,
            meta: session.meta.get(&f.name).cloned(),
        })
        .collect();
    let reg = stitch::register(&frames)?;
    stitch_log::line(&format!(
        "reproject registered used={} rmsPx {:.3} -> {:.3}",
        reg.used.len(),
        reg.rms_before,
        reg.rms
    ));
    let opts = PanoOptions {
        projection,
        ..session.options.clone()
    };
    let rendered = stitch::compose(&frames, &reg, projection, &opts, None, progress)?;
    session.registration = reg;
    Ok(rendered)
}

fn scale_registration(
    reg: &stitch::Registration,
    preview: &[WorkingFrame],
    full: &[Frame],
) -> Result<stitch::Registration, String> {
    if preview.len() != full.len() || reg.cameras.len() != full.len() {
        return Err("The preview alignment does not match the photos being saved.".into());
    }
    let ratio = |prev: &WorkingFrame, frame: &Frame| -> Option<f64> {
        (prev.width > 0).then_some(frame.width as f64 / prev.width as f64)
    };
    let cameras = reg
        .cameras
        .iter()
        .zip(preview)
        .zip(full)
        .map(|((cam, prev), frame)| {
            let cam = (*cam)?;
            Some(cam.scaled(ratio(prev, frame)?))
        })
        .collect();
    let focal_px = reg
        .focal_px
        .iter()
        .zip(preview)
        .zip(full)
        .map(|((f, prev), frame)| {
            let f = (*f)?;
            Some(f * ratio(prev, frame)?)
        })
        .collect();
    Ok(stitch::Registration {
        cameras,
        focal_px,
        used: reg.used.clone(),
        rms_before: reg.rms_before,
        rms: reg.rms,
        focal_outlier: reg.focal_outlier.clone(),
    })
}

fn median_ratio(ratios: impl IntoIterator<Item = f64>) -> f64 {
    let mut v: Vec<f64> = ratios
        .into_iter()
        .filter(|r| r.is_finite() && *r > 0.0)
        .collect();
    if v.is_empty() {
        return 1.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn save_composite(
    session: &mut PanoramaSession,
    first_path_str: &str,
    crop: &NormalizedCrop,
    app: &AppHandle,
) -> Result<String, String> {

    let note: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);
    let emit_save = |percent: f64, message: &str| {
        let _ = app.emit(
            "panorama-save-progress",
            serde_json::json!({
                "percent": percent,
                "message": message,
                "note": note.lock().ok().and_then(|g| g.clone()),
            }),
        );
    };
    emit_save(0.0, "Rendering full resolution...");
    let settings = load_settings(app.clone()).unwrap_or_default();
    let paths = session.source_paths.clone();
    let loaded = AtomicUsize::new(0);
    let frame_count = paths.len().max(1);
    let frames = load_frames(&paths, &settings, false, session.half, &|m| {
        let i = loaded.fetch_add(1, Ordering::Relaxed) + 1;
        let pct = BAR_AFTER_LOAD * (i as f64 / frame_count as f64);
        emit_save(pct, m);
    })?;
    stitch_log::line(&format!(
        "save scaling preview cameras onto {} frames at {}x{}",
        frames.len(),
        frames.first().map_or(0, |f| f.width),
        frames.first().map_or(0, |f| f.height)
    ));
    emit_save(BAR_AFTER_LOAD, "Registering");
    let reg = scale_registration(&session.registration, &session.frames, &frames)?;
    emit_save(BAR_AFTER_REGISTER, "Registering");
    let save_scale = median_ratio(
        session
            .frames
            .iter()
            .zip(&frames)
            .filter_map(|(p, f)| (p.width > 0).then_some(f.width as f64 / p.width as f64)),
    );
    stitch_log::line(&format!(
        "save scaled preview cameras x{save_scale:.4} used={} rmsPx {:.3}",
        reg.used.len(),
        reg.rms
    ));
    let (first_path, _) = parse_virtual_path(first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");
    let output_path = parent_dir.join(format!("{stem}_Pano.tiff"));
    let opts = PanoOptions {
        projection: session.selected_projection,
        quality: session.quality,
        auto_crop: false,
        frame_scale: 1.0,
        save_scale,
        preview_canvas: (session.composite_width > 0 && session.composite_height > 0).then_some((
            session.composite_width as usize,
            session.composite_height as usize,
        )),
        ..session.options.clone()
    };
    stitch_log::line(&format!(
        "save starting at {:.0}% quality, {}x{} sources",
        session.quality * 100.0,
        frames.first().map_or(0, |f| f.width),
        frames.first().map_or(0, |f| f.height)
    ));
    let progress = |msg: &str, frac: f64| {
        emit_save(save_phase_percent(msg, frac), msg);
    };
    let rendered = compose_with_retries(&frames, &reg, &opts, &output_path, &progress, &note, app)?;
    stitch_log::line(&format!(
        "save rendered {}x{} at {:.0}% in {attempt_no} attempt(s)",
        rendered.width,
        rendered.height,
        rendered.saved_quality * 100.0,
        attempt_no = rendered.saved_attempts
    ));
    let (w, h) = (rendered.width, rendered.height);
    stitch_log::line(&format!(
        "save crop rect {:.4},{:.4} {:.4}x{:.4}",
        crop.x, crop.y, crop.width, crop.height
    ));
    let x0 = (crop.x * w as f64).round().clamp(0.0, w as f64) as u32;
    let y0 = (crop.y * h as f64).round().clamp(0.0, h as f64) as u32;
    let x1 = ((crop.x + crop.width) * w as f64)
        .round()
        .clamp(x0 as f64 + 1.0, w as f64) as u32;
    let y1 = ((crop.y + crop.height) * h as f64)
        .round()
        .clamp(y0 as f64 + 1.0, h as f64) as u32;
    let cw = x1 - x0;
    let ch = y1 - y0;
    let _ = app.emit(
        "panorama-save-progress",
        serde_json::json!({ "percent": 70, "message": "Encoding image..." }),
    );
    stitch_log::line(&format!("save encode {cw}x{ch}"));
    let rgb16 = encode_cropped_16(&rendered.image.data, w, h, (x0, y0), (cw, ch))?;
    let _ = app.emit(
        "panorama-save-progress",
        serde_json::json!({ "percent": 95, "message": "Writing TIFF..." }),
    );
    rgb16
        .save_with_format(&output_path, ImageFormat::Tiff)
        .map_err(|e| format!("Failed to save panorama: {}", e))?;
    let (real_path, _) = parse_virtual_path(first_path_str);
    let _ =
        crate::exif_processing::write_rrexif_sidecar(&real_path.to_string_lossy(), &output_path);
    stitch_log::line(&format!("saved {}", output_path.display()));
    let reduced = rendered.saved_attempts > 1 || rendered.saved_quality < 0.999;
    let _ = app.emit(
        "panorama-save-progress",
        serde_json::json!({
            "percent": 100,
            "message": "Save complete",
            "savedQuality": rendered.saved_quality,
            "savedAttempts": rendered.saved_attempts,
            "reduced": reduced,
            "note": note.lock().ok().and_then(|g| g.clone()),
        }),
    );
    Ok(output_path.to_string_lossy().to_string())
}

fn complete_payload(session: &PanoramaSession) -> serde_json::Value {
    serde_json::json!({
        "base64": session.preview_png_base64.clone(),
        "overlayBase64": format!("data:image/png;base64,{}", session.overlay_png_base64),
        "winnerMapBase64": format!("data:image/png;base64,{}", session.winner_map_png_base64),
        "dropped": session.dropped,
        "recommendedProjection": session.recommended_projection.as_str(),
        "selectedProjection": session.selected_projection.as_str(),
        "crop": session.crop,
        "previewWidth": session.preview_width,
        "previewHeight": session.preview_height,
        "frames": session
            .frames
            .iter()
            .map(|f| serde_json::json!({
                "name": f.name,
                "focal35": f.focal35,
                "meta": session.meta.get(&f.name).cloned(),
                "focalOutlier": session.focal_outliers.get(&f.name).copied().unwrap_or(false),
                "dropped": session.dropped.iter().any(|d| d.filename == f.name),
            }))
            .collect::<Vec<_>>(),
        "filenames": session.filenames,
        "cropEdited": session.crop_edited,
        "previewScale": session.preview_scale,
    })
}

type LinearPixels = (Vec<f32>, u32, u32, HashMap<String, String>);

fn rgb_to_pixels(rgb: &[f32]) -> Vec<[f32; 3]> {
    rgb.as_chunks::<3>()
        .0
        .iter()
        .map(|c| [c[0], c[1], c[2]])
        .collect()
}

fn load_linear(
    path: &str,
    settings: &crate::app_settings::AppSettings,
) -> Result<LinearPixels, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", file_name(path), e))?;
    let exif = crate::exif_processing::read_exif_data_from_bytes(path, &bytes);
    if let Some((rgb, w, h)) = prepared_linear(path) {
        stitch_log::line(&format!("prepared {} {w}x{h}", file_name(path)));
        return Ok((rgb, w, h, exif));
    }
    let mut dynamic =
        crate::image_loader::load_base_image_from_bytes(&bytes, path, false, settings, None)
            .map_err(|e| format!("Failed to decode {}: {}", file_name(path), e))?;
    if !is_raw_file(path) && !is_already_linear(path) {
        dynamic = apply_srgb_to_linear(dynamic);
    }
    let rgb = dynamic.to_rgb32f();
    let (w, h) = rgb.dimensions();
    Ok((rgb.into_raw(), w, h, exif))
}

fn prepared_linear(path: &str) -> Option<(Vec<f32>, u32, u32)> {
    let dir = std::env::var("PANORAMA_LINEAR_DIR").ok()?;
    let name = file_name(path);
    let stem = Path::new(&name).file_stem()?.to_string_lossy();
    let bytes = fs::read(Path::new(&dir).join(format!("{stem}.f32"))).ok()?;
    if bytes.len() < 8 {
        return None;
    }
    let w = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
    let h = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let count = (w as usize).checked_mul(h as usize)?.checked_mul(3)?;
    if bytes.len() != 8 + count * 4 {
        return None;
    }
    let rgb = bytes[8..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Some((rgb, w, h))
}

fn frame_meta(exif: &HashMap<String, String>) -> FrameMeta {
    FrameMeta {
        native_mm: exif.get("FocalLength").and_then(|v| first_number(v)),
        focal35: exif
            .get("FocalLengthIn35mmFilm")
            .and_then(|v| first_number(v)),
        shutter: exif.get("ExposureTime").cloned(),
        aperture: exif
            .get("FNumber")
            .or_else(|| exif.get("ApertureValue"))
            .and_then(|v| first_number(v)),
        iso: exif
            .get("PhotographicSensitivity")
            .or_else(|| exif.get("ISOSpeed"))
            .and_then(|v| first_number(v)),
    }
}

fn exposure_value(exif: &HashMap<String, String>) -> Option<f64> {
    let shutter = exif
        .get("ExposureTime")
        .and_then(|s| parse_shutter(s))
        .filter(|t| *t > 0.0 && t.is_finite())?;
    let iso = exif
        .get("PhotographicSensitivity")
        .or_else(|| exif.get("ISOSpeed"))
        .and_then(|s| first_number(s))
        .filter(|i| *i > 0.0)
        .unwrap_or(100.0);
    let fnum = exif
        .get("FNumber")
        .or_else(|| exif.get("ApertureValue"))
        .and_then(|s| first_number(s))
        .filter(|n| *n > 0.0 && n.is_finite())
        .unwrap_or(1.0);
    Some((shutter * iso / (fnum * fnum)).log2())
}

fn is_already_linear(path: &str) -> bool {
    is_linear_ext(
        std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or(""),
    )
}

pub fn is_linear_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "exr" | "hdr" | "pfm" | "dpx" | "cin"
    )
}

fn display_size(w: u32, h: u32) -> (u32, u32) {
    let long = w.max(h).max(1);
    if long <= stitch::DISPLAY_LONG_SIDE {
        return (w.max(1), h.max(1));
    }
    let s = stitch::DISPLAY_LONG_SIDE as f64 / long as f64;
    (
        ((w as f64) * s).round().max(1.0) as u32,
        ((h as f64) * s).round().max(1.0) as u32,
    )
}

fn resize_winners(src: &[u16], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u16> {
    let mut out = vec![u16::MAX; (dw as usize) * (dh as usize)];
    for y in 0..dh {
        let sy = ((y as u64 * sh as u64) / dh as u64) as u32;
        for x in 0..dw {
            let sx = ((x as u64 * sw as u64) / dw as u64) as u32;
            out[(y * dw + x) as usize] = src[(sy * sw + sx) as usize];
        }
    }
    out
}

fn encode_png(img: &image::RgbImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode panorama preview: {}", e))?;
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn first_number(s: &str) -> Option<f64> {
    let mut num = String::new();
    let mut seen = false;
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            seen = true;
        } else if seen {
            break;
        }
    }
    num.parse().ok()
}

fn parse_shutter(s: &str) -> Option<f64> {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("1/") {
        let denom = first_number(rest)?;
        if denom > 0.0 { Some(1.0 / denom) } else { None }
    } else {
        first_number(t)
    }
}

// Crops the stitched image and prepares it for the file.
pub fn encode_cropped_16(
    data: &[[f32; 3]],
    w: usize,
    h: usize,
    (x0, y0): (u32, u32),
    (cw, ch): (u32, u32),
) -> Result<Rgb16Buf, String> {
    let mut rgb: Vec<f32> = Vec::with_capacity(data.len() * 3);
    for p in data {
        rgb.push(p[0]);
        rgb.push(p[1]);
        rgb.push(p[2]);
    }
    let img = Rgb32FImage::from_raw(w as u32, h as u32, rgb)
        .ok_or_else(|| "Could not build the stitched image.".to_string())?;
    let display = apply_linear_to_srgb(DynamicImage::ImageRgb32F(img));
    let full16 = display.to_rgb16();
    drop(display);
    if x0 == 0 && y0 == 0 && cw == w as u32 && ch == h as u32 {
        return Ok(full16);
    }
    let mut out: Vec<u16> = vec![0; (cw as usize) * (ch as usize) * 3];
    for y in 0..ch {
        let s = ((y0 + y) as usize * w + x0 as usize) * 3;
        let d = (y as usize * cw as usize) * 3;
        let row = &full16.as_raw()[s..s + cw as usize * 3];
        out[d..d + row.len()].copy_from_slice(row);
    }
    Rgb16Buf::from_raw(cw, ch, out).ok_or_else(|| "Could not crop the panorama.".to_string())
}
