use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::file_management::parse_virtual_path;
use crate::formats::is_raw_file;
use crate::image_processing::{apply_linear_to_srgb, apply_srgb_to_linear, linear_channel_to_srgb};
use crate::panorama_utils::log::{self as stitch_log, StitchLog};
use crate::panorama_utils::message::PanoMessage;
use crate::panorama_utils::overlay::{encode_png, generate_overlay};
use crate::panorama_utils::raster::{
    Rgb32f, fit_long_edge, into_pixels, long_edge_size, resize_box,
};
use crate::panorama_utils::session::{DroppedImage, NormalizedCrop, PanoramaSession};
use crate::panorama_utils::stitch::project::Projection;
use crate::panorama_utils::stitch::{self, Composed, Frame, FrameMeta, PanoOptions};
use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, Rgb32FImage};

type Rgb16Buf = image::ImageBuffer<image::Rgb<u16>, Vec<u16>>;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

pub const PREVIEW_EDGE: usize = 1024;
const DISPLAY_EDGE: usize = 1920;

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
pub async fn stitch_panorama(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), PanoMessage> {
    if paths.len() < 2 {
        return Err(PanoMessage::NeedTwo);
    }
    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();
    let session_handle = state.panorama_session.clone();
    let stop = StitchLog::new(arm_stop(&state));
    stitch_log::phase(&format!("merge started files={}", source_paths.len()));
    let task = tokio::task::spawn_blocking(move || {
        if stop.halted() {
            stop.note_stop();
            return Ok(());
        }
        match run_stitch(&source_paths, &app_handle, &stop) {
            Ok(session) => {
                let payload = complete_payload(&session);
                {
                    let mut slot = session_handle.lock().unwrap_or_else(|e| e.into_inner());
                    if stop.halted() {
                        stop.note_stop();
                        return Ok(());
                    }
                    *slot = Some(session);
                }
                stitch_log::phase("preview ready");
                let _ = app_handle.emit("panorama-complete", payload);
                Ok(())
            }
            Err(e) if e == PanoMessage::Cancelled || stop.halted() => {
                stop.note_stop();
                Ok(())
            }
            Err(e) => {
                log::error!("Panorama failed: {e:?}");
                let _ = app_handle.emit("panorama-error", e.clone());
                Err(e)
            }
        }
    });
    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(PanoMessage::TaskFailed {
            detail: join_err.to_string(),
        }),
    }
}

#[tauri::command]
pub async fn reproject_panorama(
    projection: Projection,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), PanoMessage> {
    let session_handle = state.panorama_session.clone();
    let stop = StitchLog::new(arm_stop(&state));
    stitch_log::phase(&format!("reproject {projection:?}"));
    let task = tokio::task::spawn_blocking(move || {
        if stop.halted() {
            stop.note_stop();
            return Ok(());
        }
        let (frames, reg, opts) = {
            let guard = session_handle.lock().unwrap_or_else(|e| e.into_inner());
            let session = guard.as_ref().ok_or(PanoMessage::NoSession)?;
            let opts = PanoOptions {
                projection,
                ..session.options.clone()
            };
            (session.frames.clone(), session.registration.clone(), opts)
        };
        let emit = progress_emitter(&app_handle, &stop);
        emit(PanoMessage::Reprojecting);
        let progress = |msg: PanoMessage, _frac: f64| emit(msg);
        let rendered = match stitch::compose_frames(&frames, &reg, &opts, &progress, &stop) {
            Ok(r) => r,
            Err(e) if e == PanoMessage::Cancelled || stop.halted() => {
                stop.note_stop();
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        let preview = render_display(&rendered)?;
        let payload = {
            let mut guard = session_handle.lock().unwrap_or_else(|e| e.into_inner());
            if stop.halted() {
                stop.note_stop();
                return Ok(());
            }
            let session = guard.as_mut().ok_or(PanoMessage::NoSession)?;
            session.options.projection = projection;
            fill_preview(session, &rendered, preview);
            complete_payload(session)
        };
        stitch_log::phase("preview ready");
        let _ = app_handle.emit("panorama-complete", payload);
        Ok(())
    });
    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(PanoMessage::ReprojectFailed {
            detail: join_err.to_string(),
        }),
    }
}

#[tauri::command]
pub async fn cancel_panorama(
    keep_session: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), PanoMessage> {
    if keep_session {
        state
            .panorama_stop
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .store(true, Ordering::SeqCst);
    } else {
        arm_stop(&state);
        *state
            .panorama_session
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }
    Ok(())
}

fn arm_stop(state: &AppState) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut slot = state
        .panorama_stop
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    slot.store(true, Ordering::SeqCst);
    *slot = flag.clone();
    flag
}

#[tauri::command]
pub async fn save_panorama(
    crop: NormalizedCrop,
    quality: f64,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, PanoMessage> {
    let flag = arm_stop(&state);
    let stop = StitchLog::new(flag.clone());
    let stop_slot = state.panorama_stop.clone();
    let session_slot = state.panorama_session.clone();
    let session = state
        .panorama_session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or(PanoMessage::NoSessionSave)?;
    let task = tokio::task::spawn_blocking(move || {
        stitch_log::phase("save started");
        let result = save_composite(&session, &crop, quality, &app_handle, &stop);
        if let Err(e) = &result {
            if *e == PanoMessage::Cancelled || stop.halted() {
                stop.note_stop();
            } else {
                log::error!("Panorama save failed: {e:?}");
            }
            let current = stop_slot.lock().unwrap_or_else(|e| e.into_inner());
            if Arc::ptr_eq(&current, &flag) {
                *session_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
            }
        }
        result
    });
    match task.await {
        Ok(result) => result,
        Err(join_err) => Err(PanoMessage::SaveFailed {
            detail: join_err.to_string(),
        }),
    }
}

const BAR_AFTER_PROJECT: f64 = 4.0;
const BAR_AFTER_BLEND: f64 = 64.0;
const BAR_AFTER_FINISH: f64 = 68.0;

const PREFETCH: usize = 1;

fn progress_emitter<'a>(
    app: &'a AppHandle,
    stop: &'a StitchLog,
) -> impl Fn(PanoMessage) + Sync + 'a {
    move |msg| {
        if !stop.halted() {
            let _ = app.emit("panorama-progress", msg);
        }
    }
}

fn save_phase_percent(msg: &PanoMessage, frac: f64) -> f64 {
    let frac = frac.clamp(0.0, 1.0);
    let (start, end) = match msg {
        PanoMessage::Projecting => (0.0, BAR_AFTER_PROJECT),
        PanoMessage::Blending => (BAR_AFTER_PROJECT, BAR_AFTER_BLEND),
        PanoMessage::Finishing => (BAR_AFTER_BLEND, BAR_AFTER_FINISH),
        _ => (0.0, 0.0),
    };
    start + (end - start) * frac
}

fn load_frames(
    source_paths: &[String],
    settings: &crate::app_settings::AppSettings,
    progress: &(dyn Fn(PanoMessage) + Sync),
    stop: &StitchLog,
) -> Result<Vec<Frame>, PanoMessage> {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .build()
        .map_err(|e| PanoMessage::LoaderFailed {
            detail: e.to_string(),
        })?;
    pool.install(|| {
        source_paths
            .par_iter()
            .enumerate()
            .map(|(i, path)| {
                stop.gate()?;
                let name = file_name(path);
                progress(PanoMessage::LoadingFile {
                    current: i + 1,
                    total: source_paths.len(),
                    name: name.clone(),
                });
                let (img, exif) = load_linear(path, settings)?;
                let meta = frame_meta(&exif);
                let (fw, fh) = (img.width, img.height);
                let clip = stitch::detect_clip(&img);
                let img = if img.width.max(img.height) > PREVIEW_EDGE {
                    fit_long_edge(&img, PREVIEW_EDGE)
                } else {
                    img
                };
                Ok(Frame {
                    name,
                    image: img,
                    native_width: fw,
                    native_height: fh,
                    clip,
                    exposure: exposure_value(&meta),
                    focal35: [meta.focal35, meta.native_mm]
                        .into_iter()
                        .flatten()
                        .find(|mm| (8.0..=400.0).contains(mm)),
                    meta,
                })
            })
            .collect()
    })
}

fn stream_sources<R>(
    paths: &[String],
    layout: &stitch::Layout,
    settings: &crate::app_settings::AppSettings,
    progress: &(dyn Fn(PanoMessage) + Sync),
    stop: &StitchLog,
    consume: impl FnOnce(
        &mut dyn Iterator<Item = Result<(usize, Rgb32f), PanoMessage>>,
    ) -> Result<R, PanoMessage>,
) -> Result<R, PanoMessage> {
    let order: Vec<usize> = layout.frames().collect();
    std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::sync_channel(PREFETCH);
        scope.spawn(move || {
            for (k, &i) in order.iter().enumerate() {
                if stop.halted() {
                    break;
                }
                let path = &paths[i];
                progress(PanoMessage::LoadingFile {
                    current: k + 1,
                    total: order.len(),
                    name: file_name(path),
                });
                let item = load_linear(path, settings)
                    .map(|(img, _)| (i, fit_source(img, layout.source_size(i))));
                let failed = item.is_err();
                if tx.send(item).is_err() || failed {
                    break;
                }
            }
        });
        consume(&mut rx.into_iter())
    })
}

fn fit_source(img: Rgb32f, (w, h): (usize, usize)) -> Rgb32f {
    if (img.width, img.height) == (w, h) {
        img
    } else {
        resize_box(&img, w, h)
    }
}

fn native_scale(native_width: usize, width: usize) -> Option<f64> {
    (width > 0).then_some(native_width as f64 / width as f64)
}

fn run_stitch(
    source_paths: &[String],
    app: &AppHandle,
    stop: &StitchLog,
) -> Result<PanoramaSession, PanoMessage> {
    let settings = load_settings(app.clone()).unwrap_or_default();
    let emit = progress_emitter(app, stop);
    let frames = load_frames(source_paths, &settings, &emit, stop)?;
    let progress = |msg: PanoMessage, _frac: f64| emit(msg);
    let reg = stitch::register(&frames, stop)?;
    stitch_log::phase(&format!(
        "registered used={} rmsPx {:.3}",
        reg.used.len(),
        reg.rms
    ));
    let recommended = stitch::choose_projection(&stitch::frame_sizes(&frames), &reg.cameras);
    let opts = PanoOptions {
        projection: recommended,
        auto_crop: true,
        quality: 1.0,
        preview_canvas: None,
        save_scale: 1.0,
        frame_scale: stitch::median(
            frames
                .iter()
                .filter_map(|f| native_scale(f.native_width, f.width()))
                .filter(|r| r.is_finite() && *r > 0.0)
                .collect(),
        ),
    };
    let dropped: Vec<DroppedImage> = (0..frames.len())
        .filter(|i| !reg.used.contains(i))
        .map(|i| DroppedImage {
            filename: frames[i].name.clone(),
            reason: frames[i]
                .meta
                .focal35
                .or(frames[i].meta.native_mm)
                .map(|f| PanoMessage::DroppedNoOverlapFocal { focal: f.round() })
                .unwrap_or(PanoMessage::DroppedNoOverlap),
        })
        .collect();
    let rendered = stitch::compose_frames(&frames, &reg, &opts, &progress, stop)?;
    let preview = render_display(&rendered)?;
    let mut session = PanoramaSession {
        source_paths: source_paths.to_vec(),
        dropped,
        preview_png: String::new(),
        overlay_png: String::new(),
        winner_map_png: String::new(),
        recommended_projection: recommended,
        crop: NormalizedCrop::default(),
        registration: reg,
        preview_width: 0,
        preview_height: 0,
        composite_width: 0,
        composite_height: 0,
        frames: frames.into(),
        options: opts,
        gains: Vec::new(),
    };
    fill_preview(&mut session, &rendered, preview);
    Ok(session)
}

struct PreviewImages {
    png: String,
    overlay: String,
    winner_map: String,
    width: u32,
    height: u32,
}

fn render_display(rendered: &Composed) -> Result<PreviewImages, PanoMessage> {
    let (w, h) = (rendered.width as u32, rendered.height as u32);
    let (dw, dh) = long_edge_size(rendered.width, rendered.height, DISPLAY_EDGE);
    let small = resize_box(&rendered.image, dw, dh);
    let (dw, dh) = (dw as u32, dh as u32);
    let img =
        Rgb32FImage::from_raw(dw, dh, small.data.into_flattened()).ok_or(PanoMessage::NoPreview)?;
    let display = apply_linear_to_srgb(DynamicImage::ImageRgb32F(img));
    let png = encode_png(&display.to_rgb8())?;
    let winners = resize_winners(&rendered.label, w, h, dw, dh);
    let overlay = generate_overlay(&winners, dw, dh)?;
    Ok(PreviewImages {
        png: png_data_url(&png),
        overlay: png_data_url(&overlay.boundary_png),
        winner_map: png_data_url(&overlay.winner_map_png),
        width: dw,
        height: dh,
    })
}

fn fill_preview(session: &mut PanoramaSession, rendered: &Composed, preview: PreviewImages) {
    session.gains = rendered.gains.clone();
    session.composite_width = rendered.width as u32;
    session.composite_height = rendered.height as u32;
    session.crop = match rendered.crop {
        Some(c) => NormalizedCrop {
            x: c[0],
            y: c[1],
            width: c[2],
            height: c[3],
        },
        None => NormalizedCrop::default(),
    };
    session.preview_png = preview.png;
    session.overlay_png = preview.overlay;
    session.winner_map_png = preview.winner_map;
    session.preview_width = preview.width;
    session.preview_height = preview.height;
}

fn scale_registration(
    reg: &stitch::Registration,
    frames: &[Frame],
) -> Result<stitch::Registration, PanoMessage> {
    if reg.cameras.len() != frames.len() {
        return Err(PanoMessage::AlignmentMismatch);
    }
    let ratio = |f: &Frame| native_scale(f.native_width, f.width());
    let cameras = reg
        .cameras
        .iter()
        .zip(frames)
        .map(|(cam, f)| {
            let cam = (*cam)?.scaled(ratio(f)?);
            Some(stitch::camera::Camera {
                cx: f.native_width as f64 / 2.0,
                cy: f.native_height as f64 / 2.0,
                ..cam
            })
        })
        .collect();
    Ok(stitch::Registration {
        cameras,
        used: reg.used.clone(),
        rms: reg.rms,
        focal_outlier: reg.focal_outlier.clone(),
    })
}

fn save_composite(
    session: &PanoramaSession,
    crop: &NormalizedCrop,
    quality: f64,
    app: &AppHandle,
    stop: &StitchLog,
) -> Result<String, PanoMessage> {
    let shown = AtomicU64::new(0);
    let emit_save = |percent: f64, message: PanoMessage| {
        if stop.halted() {
            return;
        }
        let bits = shown.fetch_max(percent.to_bits(), Ordering::Relaxed);
        let _ = app.emit(
            "panorama-save-progress",
            serde_json::json!({
                "percent": f64::from_bits(bits.max(percent.to_bits())),
                "message": message,
            }),
        );
    };
    emit_save(0.0, PanoMessage::Rendering);
    let settings = load_settings(app.clone()).unwrap_or_default();
    let reg = scale_registration(&session.registration, &session.frames)?;
    let sizes: Vec<(usize, usize)> = session
        .frames
        .iter()
        .map(|f| (f.native_width, f.native_height))
        .collect();
    let save_scale = session.options.frame_scale;
    let first_path = Path::new(session.source_paths.first().ok_or(PanoMessage::NoParent)?);
    let parent_dir = first_path.parent().ok_or(PanoMessage::NoParent)?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");
    let output_path = parent_dir.join(format!("{stem}_Pano.tiff"));
    let opts = PanoOptions {
        projection: session.options.projection,
        quality,
        auto_crop: false,
        frame_scale: 1.0,
        save_scale,
        preview_canvas: (session.composite_width > 0 && session.composite_height > 0).then_some((
            session.composite_width as usize,
            session.composite_height as usize,
        )),
    };
    let progress = |msg: PanoMessage, frac: f64| emit_save(save_phase_percent(&msg, frac), msg);
    let load_progress = |msg: PanoMessage| emit_save(0.0, msg);
    let layout = stitch::layout(&sizes, &reg, &opts)?;
    let rendered = stream_sources(
        &session.source_paths,
        &layout,
        &settings,
        &load_progress,
        stop,
        |sources| stitch::compose(&layout, &session.gains, sources, &opts, &progress, stop),
    )?;
    stitch_log::phase(&format!(
        "save rendered {}x{} at {:.0}%",
        rendered.width,
        rendered.height,
        quality * 100.0
    ));
    let (w, h) = (rendered.width, rendered.height);
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
    emit_save(70.0, PanoMessage::Encoding);
    let Composed { image, label, .. } = rendered;
    drop(label);
    let rgb16 = encode_cropped_16(&image.data, w, (x0, y0), (cw, ch))?;
    drop(image);
    stop.gate()?;
    emit_save(95.0, PanoMessage::WritingTiff);
    let source = first_path.to_string_lossy();
    crate::exif_processing::save_converted_image(
        &DynamicImage::ImageRgb16(rgb16),
        &output_path,
        &source,
    )
    .map_err(|e| PanoMessage::SaveWriteFailed {
        detail: e.to_string(),
    })?;
    let _ = crate::exif_processing::write_rrexif_sidecar(&source, &output_path);
    stitch_log::phase(&format!("saved {}", output_path.display()));
    emit_save(100.0, PanoMessage::SaveComplete);
    Ok(output_path.to_string_lossy().to_string())
}

fn complete_payload(session: &PanoramaSession) -> serde_json::Value {
    serde_json::json!({
        "image": session.preview_png,
        "overlay": session.overlay_png,
        "winnerMap": session.winner_map_png,
        "width": session.preview_width,
        "height": session.preview_height,
        "crop": session.crop,
        "dropped": session.dropped,
        "recommendedProjection": session.recommended_projection,
        "selectedProjection": session.options.projection,
        "projections": Projection::CHOICES,
        "minQuality": stitch::MIN_QUALITY,
        "frames": session
            .frames
            .iter()
            .enumerate()
            .map(|(i, f)| serde_json::json!({
                "name": f.name,
                "focal35": f.focal35,
                "meta": f.meta,
                "focalOutlier": session.registration.focal_outlier[i],
                "dropped": !session.registration.used.contains(&i),
            }))
            .collect::<Vec<_>>(),
    })
}

fn load_linear(
    path: &str,
    settings: &crate::app_settings::AppSettings,
) -> Result<(Rgb32f, HashMap<String, String>), PanoMessage> {
    let bytes = fs::read(path).map_err(|e| PanoMessage::ReadFailed {
        file: file_name(path),
        detail: e.to_string(),
    })?;
    let exif = crate::exif_processing::read_exif_data_from_bytes(path, &bytes);
    let mut dynamic =
        crate::image_loader::load_base_image_from_bytes(&bytes, path, false, settings, None)
            .map_err(|e| PanoMessage::ReadFailed {
                file: file_name(path),
                detail: e.to_string(),
            })?;
    if !is_raw_file(path) && !is_already_linear(path) {
        dynamic = apply_srgb_to_linear(dynamic);
    }
    let rgb = dynamic.into_rgb32f();
    let (w, h) = rgb.dimensions();
    let mut data = into_pixels(rgb.into_raw());
    data.par_iter_mut().for_each(|p| *p = p.map(|v| v.max(0.0)));
    Ok((
        Rgb32f {
            width: w as usize,
            height: h as usize,
            data,
        },
        exif,
    ))
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

fn exposure_value(meta: &FrameMeta) -> Option<f64> {
    let shutter = meta
        .shutter
        .as_deref()
        .and_then(parse_shutter)
        .filter(|t| *t > 0.0 && t.is_finite())?;
    let iso = meta.iso.filter(|i| *i > 0.0).unwrap_or(100.0);
    let fnum = meta
        .aperture
        .filter(|n| *n > 0.0 && n.is_finite())
        .unwrap_or(1.0);
    Some((shutter * iso / (fnum * fnum)).log2())
}

fn is_already_linear(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "exr" | "hdr" | "pfm" | "dpx" | "cin"
            )
        })
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

fn png_data_url(png: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(png)
    )
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

pub fn encode_cropped_16(
    data: &[[f32; 3]],
    w: usize,
    (x0, y0): (u32, u32),
    (cw, ch): (u32, u32),
) -> Result<Rgb16Buf, PanoMessage> {
    let (x0, y0, cw) = (x0 as usize, y0 as usize, cw as usize);
    let mut out: Vec<u16> = vec![0; cw * ch as usize * 3];
    out.par_chunks_mut(cw * 3).enumerate().for_each(|(y, row)| {
        let src = &data[(y0 + y) * w + x0..][..cw];
        for (o, p) in row.as_chunks_mut::<3>().0.iter_mut().zip(src) {
            *o = p.map(|v| (linear_channel_to_srgb(v).clamp(0.0, 1.0) * 65535.0).round() as u16);
        }
    });
    Rgb16Buf::from_raw(cw as u32, ch, out).ok_or(PanoMessage::CropFailed)
}
