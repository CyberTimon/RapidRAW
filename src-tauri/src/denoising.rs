use crate::app_settings::{AppSettings, load_settings};
use crate::app_state::AppState;
use crate::file_management::parse_virtual_path;
use crate::formats::is_raw_file;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::apply_cpu_default_raw_processing;
use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, Rgb32FImage};
use rayon::prelude::*;
use sha2::Digest;
use std::cmp::Ordering;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) type DenoiseProgress = Arc<dyn Fn(f32, &str) + Send + Sync>;

/// Cooperative cancellation at native work boundaries; never publishes partial pixels.
#[derive(Clone)]
pub(crate) struct DenoiseControl {
    pub cancelled: Arc<AtomicBool>,
    pub progress: DenoiseProgress,
}
impl DenoiseControl {
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(AtomicOrdering::Acquire) {
            Err("JOB_CANCELLED: Denoising cancelled".into())
        } else {
            Ok(())
        }
    }
    pub fn report(&self, fraction: f32, stage: &str) {
        (self.progress)(fraction.clamp(0.0, 1.0), stage);
    }
}

struct ProgressReporter<'a> {
    counter: &'a Arc<AtomicUsize>,
    total_work: usize,
    app_handle: &'a AppHandle,
    control: Option<&'a DenoiseControl>,
}

const BLOCK_SIZE: usize = 8;
const BLOCK_AREA: usize = 64;
const MAX_GROUP_SIZE: usize = 16;
const STRIDE: usize = 6;
const SEARCH_WINDOW: usize = 19;
const FIXED_POINT_SCALE: f32 = 100_000.0;

#[derive(Clone, Copy)]
struct Bm3dParams {
    sigma: f32,
    hard_th_lambda: f32,
    max_dist_hard: f32,
    chroma_sigma_scale: f32,
}

impl Bm3dParams {
    fn from_intensity(i: f32) -> Self {
        let val = i.clamp(0.001, 1.0);
        Self {
            sigma: val * 80.0,
            hard_th_lambda: 2.0 + (val * 2.5),
            max_dist_hard: 3000.0 + (val * 20000.0),
            chroma_sigma_scale: 1.8,
        }
    }
}

#[tauri::command]
pub async fn apply_denoising(
    path: String,
    intensity: f32,
    method: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (source_path, _) = parse_virtual_path(&path);
    let path_str = source_path.to_string_lossy().to_string();

    let mut ai_session = None;
    if method == "ai" {
        let session = crate::ai_processing::get_or_init_denoise_model(
            &app_handle,
            &state.ai_state,
            &state.ai_init_lock,
        )
        .await
        .map_err(|e| e.to_string())?;
        ai_session = Some(session);
    }

    let denoise_result_handle = state.denoise_result.clone();

    tokio::task::spawn_blocking(move || {
        match denoise_image(path_str, intensity, method, app_handle.clone(), ai_session) {
            Ok((image, _)) => {
                *denoise_result_handle.lock().unwrap() = Some(image);
            }
            Err(e) => {
                let _ = app_handle.emit("denoise-error", e);
            }
        }
    })
    .await
    .map_err(|e| format!("Denoising task failed: {}", e))
}

#[tauri::command]
pub async fn batch_denoise_images(
    paths: Vec<String>,
    intensity: f32,
    method: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut ai_session = None;
    if method == "ai" {
        let session = crate::ai_processing::get_or_init_denoise_model(
            &app_handle,
            &state.ai_state,
            &state.ai_init_lock,
        )
        .await
        .map_err(|e| e.to_string())?;
        ai_session = Some(session);
    }

    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        for (i, path_str) in paths.iter().enumerate() {
            let _ = app_handle.emit(
                "denoise-batch-progress",
                serde_json::json!({
                    "current": i + 1,
                    "total": paths.len(),
                    "path": path_str
                }),
            );

            let (source_path, source_sidecar_path) =
                crate::file_management::parse_virtual_path(path_str);
            let real_path = source_path.to_string_lossy().to_string();

            match crate::denoising::denoise_image(
                real_path.clone(),
                intensity,
                method.clone(),
                app_handle.clone(),
                ai_session.clone(),
            ) {
                Ok((image, _)) => {
                    let is_raw = crate::formats::is_raw_file(&real_path);
                    let parent_dir = source_path.parent().unwrap_or(std::path::Path::new(""));
                    let stem = source_path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy();

                    let (output_filename, image_to_save) = if is_raw {
                        (
                            format!("{}_Denoised.tiff", stem),
                            DynamicImage::ImageRgb16(image.to_rgb16()),
                        )
                    } else {
                        (
                            format!("{}_Denoised.png", stem),
                            DynamicImage::ImageRgb8(image.to_rgb8()),
                        )
                    };

                    let output_path = parent_dir.join(output_filename);
                    if let Err(e) = image_to_save.save(&output_path) {
                        let _ = app_handle.emit(
                            "denoise-error",
                            format!("Failed to save {}: {}", real_path, e),
                        );
                        continue;
                    }

                    let _ = crate::exif_processing::write_rrexif_sidecar(&real_path, &output_path);

                    if source_sidecar_path.exists()
                        && let Some(output_path_str) = output_path.to_str()
                    {
                        let (_, dest_sidecar_path) =
                            crate::file_management::parse_virtual_path(output_path_str);
                        if let Err(e) = std::fs::copy(&source_sidecar_path, &dest_sidecar_path) {
                            log::warn!("Failed to copy sidecar file for denoised image: {}", e);
                        }
                    }

                    results.push(output_path.to_string_lossy().to_string());
                }
                Err(e) => {
                    let _ = app_handle.emit(
                        "denoise-error",
                        format!("Failed to denoise {}: {}", real_path, e),
                    );
                }
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| format!("Batch denoising task failed: {}", e))?
}

#[tauri::command]
pub async fn save_denoised_image(
    original_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let denoised_image = state.denoise_result.lock().unwrap().take().ok_or_else(|| {
        "No denoised image found in memory. It might have already been saved or cleared."
            .to_string()
    })?;

    let is_raw = crate::formats::is_raw_file(&original_path_str);

    let (first_path, source_sidecar_path) =
        crate::file_management::parse_virtual_path(&original_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("denoised");

    let (output_filename, image_to_save): (String, DynamicImage) = if is_raw {
        let filename = format!("{}_Denoised.tiff", stem);
        (
            filename,
            DynamicImage::ImageRgb16(denoised_image.to_rgb16()),
        )
    } else {
        let filename = format!("{}_Denoised.png", stem);
        (filename, DynamicImage::ImageRgb8(denoised_image.to_rgb8()))
    };

    let output_path = parent_dir.join(output_filename);

    image_to_save
        .save(&output_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    let (real_path, _) = crate::file_management::parse_virtual_path(&original_path_str);
    let _ =
        crate::exif_processing::write_rrexif_sidecar(&real_path.to_string_lossy(), &output_path);

    if source_sidecar_path.exists()
        && let Some(output_path_str) = output_path.to_str()
    {
        let (_, dest_sidecar_path) = crate::file_management::parse_virtual_path(output_path_str);
        if let Err(e) = std::fs::copy(&source_sidecar_path, &dest_sidecar_path) {
            log::warn!("Failed to copy sidecar file for denoised image: {}", e);
        }
    }

    Ok(output_path.to_string_lossy().to_string())
}

fn run_bm3d(
    rgb_img: &Rgb32FImage,
    intensity: f32,
    app_handle: &AppHandle,
) -> Result<DynamicImage, String> {
    run_bm3d_controlled(rgb_img, intensity, app_handle, None)
}

fn run_bm3d_controlled(
    rgb_img: &Rgb32FImage,
    intensity: f32,
    app_handle: &AppHandle,
    control: Option<&DenoiseControl>,
) -> Result<DynamicImage, String> {
    if let Some(c) = control {
        c.check()?;
    }
    let (width, height) = rgb_img.dimensions();
    let params = Bm3dParams::from_intensity(intensity);
    let dct_tables = Arc::new(DctTables::new());

    let rgb_channels = split_channels(rgb_img);
    let (y, cb, cr) = rgb_to_ycbcr(&rgb_channels[0], &rgb_channels[1], &rgb_channels[2]);
    let original_y = y.clone();
    let channels = vec![y, cb, cr];

    let patches_x = (width as usize).saturating_sub(BLOCK_SIZE) / STRIDE + 1;
    let patches_y = (height as usize).saturating_sub(BLOCK_SIZE) / STRIDE + 1;
    let total_work_units = (patches_x * patches_y) * 2;
    let progress_counter = Arc::new(AtomicUsize::new(0));

    let _ = app_handle.emit("denoise-progress", "Processing (Step 1/2)...");

    let progress = ProgressReporter {
        counter: &progress_counter,
        total_work: total_work_units,
        app_handle,
        control,
    };
    let mut denoised_channels =
        bm3d_process_joint(&channels, width, height, &params, &dct_tables, &progress);
    if let Some(c) = control {
        c.check()?;
        c.report(1.0, "blending");
    }

    {
        let _ = app_handle.emit("denoise-progress", "Blending detail...");
        let blurred_y = gaussian_blur_1ch(&original_y, width as usize, height as usize, 3.0);
        let detail_strength = (intensity * 0.5_f32).clamp(0.0_f32, 0.5_f32);
        let y_ch = &mut denoised_channels[0];
        for i in 0..y_ch.len() {
            let hf = original_y[i] - blurred_y[i];
            y_ch[i] = (y_ch[i] + detail_strength * hf).clamp(0.0, 255.0);
        }
    }

    let (r, g, b) = ycbcr_to_rgb(
        &denoised_channels[0],
        &denoised_channels[1],
        &denoised_channels[2],
    );

    let out_img_buffer = merge_channels(&[r, g, b], width, height);
    Ok(DynamicImage::ImageRgb32F(out_img_buffer))
}

/// Denoise already-decoded source pixels without baking display tone or edits.
/// This opt-in path is used by the MCP bridge; the UI preview path below keeps
/// its existing behavior. Both native filters have bounded output, so preserve
/// HDR/negative headroom with one shared, reversible RGB normalization.
#[cfg(feature = "mcp")]
pub(crate) fn denoise_source_image(
    source: &DynamicImage,
    strength: f32,
    method: &str,
    app_handle: &AppHandle,
    ai_session: Option<Arc<Mutex<ort::session::Session>>>,
) -> Result<(DynamicImage, (f32, f32)), String> {
    denoise_source_image_controlled(source, strength, method, app_handle, ai_session, None)
}

#[cfg(feature = "mcp")]
pub(crate) fn denoise_source_image_controlled(
    source: &DynamicImage,
    strength: f32,
    method: &str,
    app_handle: &AppHandle,
    ai_session: Option<Arc<Mutex<ort::session::Session>>>,
    control: Option<&DenoiseControl>,
) -> Result<(DynamicImage, (f32, f32)), String> {
    if let Some(c) = control {
        c.check()?;
    }
    if !strength.is_finite() || !(0.0..=1.0).contains(&strength) {
        return Err("Denoise strength must be finite and within 0..1".into());
    }
    if strength == 0.0 {
        return Ok((source.clone(), (0.0, 1.0)));
    }
    let original = source.to_rgb32f();
    let (normalized, range) = normalize_denoise_source(&original)?;
    let filtered = match method {
        "ai" => {
            let session = ai_session.ok_or("AI Session not provided")?;
            // The native AI argument selects tile overlap, not noise strength.
            // Keep balanced inference quality fixed; strength blends pixels.
            crate::ai_processing::run_ai_denoise_controlled(
                &normalized,
                0.5,
                &session,
                app_handle,
                control,
            )
            .map_err(|e| e.to_string())?
        }
        "bm3d" => run_bm3d_controlled(&normalized, strength, app_handle, control)?,
        _ => return Err("Denoise method must be ai or bm3d".into()),
    };
    if let Some(c) = control {
        c.check()?;
    }
    let output = restore_denoise_source(&original, &filtered.to_rgb32f(), range, strength)?;
    Ok((DynamicImage::ImageRgb32F(output), range))
}

#[cfg(any(feature = "mcp", test))]
fn normalize_denoise_source(source: &Rgb32FImage) -> Result<(Rgb32FImage, (f32, f32)), String> {
    let mut lower = 0.0_f32;
    let mut upper = 1.0_f32;
    for &value in source.as_raw() {
        if !value.is_finite() {
            return Err("Source pixels contain nonfinite values".into());
        }
        lower = lower.min(value);
        upper = upper.max(value);
    }
    let span = upper - lower;
    if !span.is_finite() {
        return Err("Source dynamic range exceeds supported float precision".into());
    }
    let normalized = Rgb32FImage::from_fn(source.width(), source.height(), |x, y| {
        Rgb(std::array::from_fn(|channel| {
            (source.get_pixel(x, y)[channel] - lower) / span
        }))
    });
    Ok((normalized, (lower, upper)))
}

#[cfg(any(feature = "mcp", test))]
fn restore_denoise_source(
    original: &Rgb32FImage,
    filtered: &Rgb32FImage,
    range: (f32, f32),
    strength: f32,
) -> Result<Rgb32FImage, String> {
    if strength == 0.0 {
        return Ok(original.clone());
    }
    if filtered.dimensions() != original.dimensions() {
        return Err("Denoiser returned different source dimensions".into());
    }
    if filtered.as_raw().iter().any(|value| !value.is_finite()) {
        return Err("Denoiser returned nonfinite pixels".into());
    }
    let span = range.1 - range.0;
    Ok(Rgb32FImage::from_fn(
        original.width(),
        original.height(),
        |x, y| {
            let source = original.get_pixel(x, y);
            let denoised = filtered.get_pixel(x, y);
            Rgb(std::array::from_fn(|channel| {
                let restored = denoised[channel] * span + range.0;
                source[channel] + strength * (restored - source[channel])
            }))
        },
    ))
}

/// Bayer-domain Nonlocal denoise for the desktop denoise modal. The resulting
/// float Bayer DNG is developed through the normal RAW pipeline below, so the
/// caller must still apply the default RAW processing for RAW sources.
/// Strength blends inside the RAW domain; no sRGB blending happens here.
/// The model bundle must already be installed (missing bundles fail with
/// `MODEL_NOT_INSTALLED`).
fn run_nonlocal_denoise(
    path_str: &str,
    file_bytes: &[u8],
    intensity: f32,
    settings: &AppSettings,
    app_handle: &AppHandle,
) -> Result<DynamicImage, String> {
    if !is_raw_file(path_str) {
        return Err("NONLOCAL_UNSUPPORTED: Nonlocal requires a Bayer RAW source".into());
    }
    let root = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let source_sha = hex::encode(sha2::Sha256::digest(file_bytes));
    let handle = app_handle.clone();
    let control = DenoiseControl {
        cancelled: Arc::new(AtomicBool::new(false)),
        progress: Arc::new(move |fraction: f32, stage: &str| {
            let _ = handle.emit(
                "denoise-progress",
                format!("Nonlocal {stage}… {:.0}%", fraction * 100.0),
            );
        }),
    };
    let output =
        crate::raw_denoise::denoise(Path::new(path_str), &source_sha, &root, intensity, &control)
            .map_err(|e| format!("{e:#}"))?;
    let dng_path = output.path();
    let dng_bytes = fs::read(&dng_path).map_err(|e| e.to_string())?;
    load_base_image_from_bytes(
        &dng_bytes,
        &dng_path.to_string_lossy(),
        false,
        settings,
        None,
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn denoise_image(
    path_str: String,
    intensity: f32,
    method: String,
    app_handle: AppHandle,
    ai_session: Option<Arc<Mutex<ort::session::Session>>>,
) -> Result<(DynamicImage, String), String> {
    let path = Path::new(&path_str);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let is_raw = is_raw_file(&path_str);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let _ = app_handle.emit("denoise-progress", "Loading image...");

    let file_bytes = fs::read(path).map_err(|e| e.to_string())?;
    let dynamic_img = load_base_image_from_bytes(&file_bytes, &path_str, false, &settings, None)
        .map_err(|e| e.to_string())?;

    let rgb_img_for_denoiser = dynamic_img.to_rgb32f();

    let mut out_dynamic = if method == "ai" {
        let session_arc = ai_session.ok_or_else(|| "AI Session not provided".to_string())?;
        crate::ai_processing::run_ai_denoise(
            &rgb_img_for_denoiser,
            intensity,
            &session_arc,
            &app_handle,
        )
        .map_err(|e| e.to_string())?
    } else if method == "nonlocal" {
        run_nonlocal_denoise(&path_str, &file_bytes, intensity, &settings, &app_handle)?
    } else {
        run_bm3d(&rgb_img_for_denoiser, intensity, &app_handle)?
    };

    if is_raw {
        apply_cpu_default_raw_processing(&mut out_dynamic);
    }

    let _ = app_handle.emit("denoise-progress", "Finalizing data...");
    let _ = app_handle.emit("denoise-progress", "Generating previews...");

    let (width, height) = out_dynamic.dimensions();
    let (new_width, new_height) = if width > height {
        if width > 4000 {
            (4000, (4000.0 * height as f32 / width as f32).round() as u32)
        } else {
            (width, height)
        }
    } else {
        if height > 4000 {
            ((4000.0 * width as f32 / height as f32).round() as u32, 4000)
        } else {
            (width, height)
        }
    };

    let denoised_preview = if new_width != width {
        out_dynamic.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
    } else {
        out_dynamic.clone()
    };

    let mut buf_denoised = Cursor::new(Vec::new());
    denoised_preview
        .to_rgb8()
        .write_to(&mut buf_denoised, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview: {}", e))?;
    let base64_str_denoised = general_purpose::STANDARD.encode(buf_denoised.get_ref());
    let data_url_denoised = format!("data:image/png;base64,{}", base64_str_denoised);

    let mut original_dynamic = DynamicImage::ImageRgb32F(rgb_img_for_denoiser);

    if is_raw {
        apply_cpu_default_raw_processing(&mut original_dynamic);
    }
    let original_preview = if new_width != width {
        original_dynamic.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
    } else {
        original_dynamic
    };

    let mut buf_orig = Cursor::new(Vec::new());
    original_preview
        .to_rgb8()
        .write_to(&mut buf_orig, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode original preview: {}", e))?;
    let base64_str_orig = general_purpose::STANDARD.encode(buf_orig.get_ref());
    let data_url_orig = format!("data:image/png;base64,{}", base64_str_orig);

    let payload = serde_json::json!({
        "denoised": data_url_denoised,
        "original": data_url_orig
    });

    let _ = app_handle.emit("denoise-complete", &payload);

    Ok((out_dynamic, data_url_denoised))
}

fn rgb_to_ycbcr(r: &[f32], g: &[f32], b: &[f32]) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let n = r.len();
    let mut y = vec![0.0f32; n];
    let mut cb = vec![0.0f32; n];
    let mut cr = vec![0.0f32; n];
    for i in 0..n {
        let rv = r[i];
        let gv = g[i];
        let bv = b[i];
        y[i] = 0.299 * rv + 0.587 * gv + 0.114 * bv;
        cb[i] = -0.168736 * rv - 0.331264 * gv + 0.5 * bv + 128.0;
        cr[i] = 0.5 * rv - 0.418688 * gv - 0.081312 * bv + 128.0;
    }
    (y, cb, cr)
}

fn ycbcr_to_rgb(y: &[f32], cb: &[f32], cr: &[f32]) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let n = y.len();
    let mut r = vec![0.0f32; n];
    let mut g = vec![0.0f32; n];
    let mut b = vec![0.0f32; n];
    for i in 0..n {
        let yv = y[i];
        let cbv = cb[i] - 128.0;
        let crv = cr[i] - 128.0;
        r[i] = yv + 1.402 * crv;
        g[i] = yv - 0.344136 * cbv - 0.714136 * crv;
        b[i] = yv + 1.772 * cbv;
    }
    (r, g, b)
}

fn bm3d_process_joint(
    noisy_channels: &[Vec<f32>],
    width: u32,
    height: u32,
    params: &Bm3dParams,
    tables: &DctTables,
    progress: &ProgressReporter,
) -> Vec<Vec<f32>> {
    let basic_estimate = run_bm3d_step_joint(
        noisy_channels,
        noisy_channels,
        width,
        height,
        params,
        true,
        tables,
        progress,
    );

    run_bm3d_step_joint(
        noisy_channels,
        &basic_estimate,
        width,
        height,
        params,
        false,
        tables,
        progress,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_bm3d_step_joint(
    noisy: &[Vec<f32>],
    guide: &[Vec<f32>],
    width: u32,
    height: u32,
    params: &Bm3dParams,
    is_step_1: bool,
    tables: &DctTables,
    progress: &ProgressReporter,
) -> Vec<Vec<f32>> {
    let w = width as usize;
    let h = height as usize;
    let count = w * h;
    let num_channels = 3;

    let mut numerators = Vec::new();
    let mut denominators = Vec::new();
    for _ in 0..num_channels {
        numerators.push(Arc::new(AtomicAccumulator::new(count)));
        denominators.push(Arc::new(AtomicAccumulator::new(count)));
    }

    let mut ref_patches = Vec::with_capacity((w / STRIDE) * (h / STRIDE));
    for y in (0..h.saturating_sub(BLOCK_SIZE)).step_by(STRIDE) {
        for x in (0..w.saturating_sub(BLOCK_SIZE)).step_by(STRIDE) {
            ref_patches.push((x, y));
        }
    }

    ref_patches.par_iter().for_each(|&(rx, ry)| {
        if progress.control.is_some_and(|c| c.check().is_err()) {
            return;
        }
        let c = progress.counter.fetch_add(1, AtomicOrdering::Relaxed);
        if c.is_multiple_of(200) {
            let pct = (c as f32 / progress.total_work as f32) * 100.0;
            let step_str = if is_step_1 { "Step 1/2" } else { "Step 2/2" };
            let msg = format!("{} - {:.0}%", step_str, pct);
            let _ = progress.app_handle.emit("denoise-progress", msg);
            if let Some(control) = progress.control {
                control.report(pct / 100.0, step_str);
            }
        }

        let mut group_locs_buf = [(0, 0); MAX_GROUP_SIZE];
        let group_size =
            block_matching_joint(guide, w, h, rx, ry, is_step_1, params, &mut group_locs_buf);
        let group_locs = &group_locs_buf[0..group_size];

        for ch in 0..num_channels {
            let guide_ch = &guide[ch];
            let noisy_ch = &noisy[ch];

            let ch_sigma = if ch == 0 {
                params.sigma
            } else {
                params.sigma * params.chroma_sigma_scale
            };

            let mut guide_stack = build_3d_group(guide_ch, w, group_locs);
            let mut noisy_stack = if is_step_1 {
                guide_stack.clone()
            } else {
                build_3d_group(noisy_ch, w, group_locs)
            };

            transform_3d(&mut guide_stack, group_size, tables);
            if !is_step_1 {
                transform_3d(&mut noisy_stack, group_size, tables);
            }

            let weight;
            if is_step_1 {
                let threshold = params.hard_th_lambda * ch_sigma;
                let nonzero = hard_threshold(&mut guide_stack, threshold);
                weight = if nonzero > 0 {
                    1.0 / (nonzero as f32)
                } else {
                    1.0
                };
                noisy_stack = guide_stack;
            } else {
                weight = wiener_filter(&mut noisy_stack, &guide_stack, ch_sigma);
            }

            inverse_transform_3d(&mut noisy_stack, group_size, tables);

            let num_acc = &numerators[ch];
            let den_acc = &denominators[ch];

            for (k, &(lx, ly)) in group_locs.iter().enumerate() {
                let patch_offset = k * BLOCK_AREA;
                for dy in 0..BLOCK_SIZE {
                    let row_global = (ly + dy) * w + lx;
                    let row_patch = dy * BLOCK_SIZE;
                    for dx in 0..BLOCK_SIZE {
                        let idx = row_global + dx;
                        let val = noisy_stack[patch_offset + row_patch + dx];
                        let w_val = tables.kaiser[row_patch + dx] * weight;
                        num_acc.add(idx, val * w_val);
                        den_acc.add(idx, w_val);
                    }
                }
            }
        }
    });

    let mut results = Vec::new();
    for ch in 0..num_channels {
        let num_vec = numerators[ch].to_vec();
        let den_vec = denominators[ch].to_vec();
        let final_ch = num_vec
            .iter()
            .zip(den_vec.iter())
            .zip(noisy[ch].iter())
            .map(|((&n, &d), &orig)| if d > 1e-6 { n / d } else { orig })
            .collect();
        results.push(final_ch);
    }
    results
}

fn hard_threshold(stack: &mut [f32], th: f32) -> usize {
    let mut c = 0;
    for (i, x) in stack.iter_mut().enumerate() {
        if i == 0 {
            c += 1;
            continue;
        }

        if x.abs() < th {
            *x = 0.0;
        } else {
            c += 1;
        }
    }
    c
}

fn wiener_filter(noisy: &mut [f32], guide: &[f32], sigma: f32) -> f32 {
    let mut sum = 0.0;
    let s2 = sigma * sigma;
    for (i, (n, g)) in noisy.iter_mut().zip(guide).enumerate() {
        if i == 0 {
            sum += 1.0;
            continue;
        }

        let energy = g * g;
        let coef = energy / (energy + s2 + 1e-5);
        *n *= coef;
        sum += coef * coef;
    }
    if sum > 0.0 { 1.0 / sum } else { 1.0 }
}

#[derive(Clone, Copy)]
struct Match {
    dist: f32,
    x: u16,
    y: u16,
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn block_matching_joint(
    channels: &[Vec<f32>],
    w: usize,
    h: usize,
    rx: usize,
    ry: usize,
    is_step_1: bool,
    params: &Bm3dParams,
    out_buf: &mut [(usize, usize)],
) -> usize {
    const MAX_CANDIDATES: usize = 1024;
    let mut candidates: [Match; MAX_CANDIDATES] = [Match {
        dist: f32::MAX,
        x: 0,
        y: 0,
    }; MAX_CANDIDATES];
    let mut cand_count = 0;

    let threshold = if is_step_1 {
        params.max_dist_hard
    } else {
        params.max_dist_hard * 0.5
    };

    let mut ref_r = [0.0; 64];
    let mut ref_g = [0.0; 64];
    let mut ref_b = [0.0; 64];
    extract_patch(&channels[0], w, rx, ry, &mut ref_r);
    extract_patch(&channels[1], w, rx, ry, &mut ref_g);
    extract_patch(&channels[2], w, rx, ry, &mut ref_b);

    let half_sw = SEARCH_WINDOW / 2;
    let sx_start = rx.saturating_sub(half_sw);
    let sx_end = (rx + half_sw).min(w.saturating_sub(BLOCK_SIZE));
    let sy_start = ry.saturating_sub(half_sw);
    let sy_end = (ry + half_sw).min(h.saturating_sub(BLOCK_SIZE));

    candidates[0] = Match {
        dist: 0.0,
        x: rx as u16,
        y: ry as u16,
    };
    cand_count += 1;

    for y in sy_start..=sy_end {
        for x in sx_start..=sx_end {
            if x == rx && y == ry {
                continue;
            }
            let d_r = compute_ssd_flat(&channels[0], w, x, y, &ref_r, threshold);
            if d_r > threshold {
                continue;
            }
            let d_g = compute_ssd_flat(&channels[1], w, x, y, &ref_g, threshold - d_r);
            if d_r + d_g > threshold {
                continue;
            }
            let d_b = compute_ssd_flat(&channels[2], w, x, y, &ref_b, threshold - (d_r + d_g));
            let total_dist = d_r + d_g + d_b;

            if total_dist < threshold && cand_count < MAX_CANDIDATES {
                candidates[cand_count] = Match {
                    dist: total_dist,
                    x: x as u16,
                    y: y as u16,
                };
                cand_count += 1;
            }
        }
    }

    let valid_slice = &mut candidates[0..cand_count];
    valid_slice.sort_unstable_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));

    let limit = MAX_GROUP_SIZE.min(cand_count);
    let p2_limit = prev_power_of_two(limit);

    for i in 0..p2_limit {
        out_buf[i] = (valid_slice[i].x as usize, valid_slice[i].y as usize);
    }
    p2_limit
}

#[inline(always)]
fn compute_ssd_flat(
    img: &[f32],
    w: usize,
    x: usize,
    y: usize,
    ref_patch: &[f32],
    stop_thr: f32,
) -> f32 {
    let mut dist = 0.0;
    for dy in 0..8 {
        let img_base = (y + dy) * w + x;
        let ref_base = dy * 8;
        for dx in 0..8 {
            let diff = img[img_base + dx] - ref_patch[ref_base + dx];
            dist += diff * diff;
        }
        if dist > stop_thr {
            return dist;
        }
    }
    dist / BLOCK_AREA as f32
}

#[inline(always)]
fn extract_patch(img: &[f32], w: usize, x: usize, y: usize, out: &mut [f32]) {
    for dy in 0..8 {
        let src_idx = (y + dy) * w + x;
        let dst_idx = dy * 8;
        out[dst_idx..dst_idx + 8].copy_from_slice(&img[src_idx..src_idx + 8]);
    }
}

fn build_3d_group(img: &[f32], w: usize, locs: &[(usize, usize)]) -> Vec<f32> {
    let mut stack = vec![0.0; locs.len() * 64];
    for (i, &(lx, ly)) in locs.iter().enumerate() {
        let offset = i * 64;
        extract_patch(img, w, lx, ly, &mut stack[offset..offset + 64]);
    }
    stack
}

struct DctTables {
    dct_coeff: [f32; 64],
    idct_coeff: [f32; 64],
    kaiser: Vec<f32>,
}

impl DctTables {
    fn new() -> Self {
        let mut dct_coeff = [0.0; 64];
        let mut idct_coeff = [0.0; 64];
        for k in 0..8 {
            for n in 0..8 {
                let c = k as f32 * std::f32::consts::PI / 8.0;
                let val = ((n as f32 + 0.5) * c).cos();
                let scale = if k == 0 { 0.35355339 } else { 0.5 };
                dct_coeff[k * 8 + n] = val * scale;
            }
        }
        for n in 0..8 {
            for k in 0..8 {
                let theta = (std::f32::consts::PI / 8.0) * (n as f32 + 0.5) * (k as f32);
                let scale = if k == 0 { 0.35355339 } else { 0.5 };
                idct_coeff[n * 8 + k] = scale * theta.cos();
            }
        }
        let mut kaiser = vec![0.0; 64];
        for y in 0..8 {
            for x in 0..8 {
                let wx = (std::f32::consts::PI * x as f32 / 7.0).sin();
                let wy = (std::f32::consts::PI * y as f32 / 7.0).sin();
                kaiser[y * 8 + x] = wx * wy;
            }
        }
        Self {
            dct_coeff,
            idct_coeff,
            kaiser,
        }
    }
}

struct AtomicAccumulator {
    data: Vec<AtomicI64>,
}

impl AtomicAccumulator {
    fn new(size: usize) -> Self {
        let mut data = Vec::with_capacity(size);
        for _ in 0..size {
            data.push(AtomicI64::new(0));
        }
        Self { data }
    }
    #[inline(always)]
    fn add(&self, index: usize, value: f32) {
        if index < self.data.len() {
            let fixed = (value * FIXED_POINT_SCALE) as i64;
            self.data[index].fetch_add(fixed, AtomicOrdering::Relaxed);
        }
    }
    fn to_vec(&self) -> Vec<f32> {
        self.data
            .iter()
            .map(|a| a.load(AtomicOrdering::Relaxed) as f32 / FIXED_POINT_SCALE)
            .collect()
    }
}

#[inline(always)]
fn transform_3d(stack: &mut [f32], group_size: usize, tables: &DctTables) {
    for i in 0..group_size {
        let offset = i * 64;
        dct_2d_8x8(&mut stack[offset..offset + 64], &tables.dct_coeff);
    }
    for i in 0..64 {
        let mut col = [0.0; MAX_GROUP_SIZE];
        for k in 0..group_size {
            col[k] = stack[k * 64 + i];
        }
        walsh_hadamard_1d(&mut col[0..group_size]);
        for k in 0..group_size {
            stack[k * 64 + i] = col[k];
        }
    }
}

#[inline(always)]
fn inverse_transform_3d(stack: &mut [f32], group_size: usize, tables: &DctTables) {
    for i in 0..64 {
        let mut col = [0.0; MAX_GROUP_SIZE];
        for k in 0..group_size {
            col[k] = stack[k * 64 + i];
        }
        walsh_hadamard_1d(&mut col[0..group_size]);
        for k in 0..group_size {
            stack[k * 64 + i] = col[k];
        }
    }
    for i in 0..group_size {
        let offset = i * 64;
        idct_2d_8x8(&mut stack[offset..offset + 64], &tables.idct_coeff);
    }
}

#[inline]
fn dct_2d_8x8(block: &mut [f32], coeffs: &[f32; 64]) {
    for i in 0..8 {
        dct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
    transpose_8x8(block);
    for i in 0..8 {
        dct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
    transpose_8x8(block);
}

#[inline]
fn idct_2d_8x8(block: &mut [f32], coeffs: &[f32; 64]) {
    transpose_8x8(block);
    for i in 0..8 {
        idct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
    transpose_8x8(block);
    for i in 0..8 {
        idct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
}

#[inline]
fn dct_1d_8(x: &mut [f32], coeffs: &[f32; 64]) {
    let mut tmp = [0.0; 8];
    tmp.copy_from_slice(x);
    for (k, x_k) in x[..8].iter_mut().enumerate() {
        let mut s = 0.0;
        let row_start = k * 8;
        for (n, &tmp_n) in tmp.iter().enumerate() {
            s += tmp_n * coeffs[row_start + n];
        }
        *x_k = s;
    }
}

#[inline]
fn idct_1d_8(x: &mut [f32], coeffs: &[f32; 64]) {
    let mut tmp = [0.0; 8];
    tmp.copy_from_slice(x);
    for (n, x_n) in x[..8].iter_mut().enumerate() {
        let mut s = 0.0;
        let row_start = n * 8;
        for (k, &tmp_k) in tmp.iter().enumerate() {
            s += tmp_k * coeffs[row_start + k];
        }
        *x_n = s;
    }
}

#[inline]
fn transpose_8x8(b: &mut [f32]) {
    for y in 0..8 {
        for x in (y + 1)..8 {
            b.swap(y * 8 + x, x * 8 + y);
        }
    }
}

#[inline]
fn walsh_hadamard_1d(data: &mut [f32]) {
    let n = data.len();
    let mut h = 1;
    while h < n {
        for i in (0..n).step_by(h * 2) {
            for j in i..i + h {
                let x = data[j];
                let y = data[j + h];
                data[j] = x + y;
                data[j + h] = x - y;
            }
        }
        h *= 2;
    }
    let scale = 1.0 / (n as f32).sqrt();
    for x in data {
        *x *= scale;
    }
}

fn split_channels(img: &Rgb32FImage) -> Vec<Vec<f32>> {
    let (w, h) = img.dimensions();
    let size = (w * h) as usize;
    let mut r = vec![0.0; size];
    let mut g = vec![0.0; size];
    let mut b = vec![0.0; size];
    for (i, p) in img.pixels().enumerate() {
        r[i] = p[0] * 255.0;
        g[i] = p[1] * 255.0;
        b[i] = p[2] * 255.0;
    }
    vec![r, g, b]
}

fn merge_channels(channels: &[Vec<f32>], w: u32, h: u32) -> Rgb32FImage {
    let mut img = Rgb32FImage::new(w, h);
    for (i, p) in img.pixels_mut().enumerate() {
        let r = channels[0][i].clamp(0.0, 255.0) / 255.0;
        let g = channels[1][i].clamp(0.0, 255.0) / 255.0;
        let b = channels[2][i].clamp(0.0, 255.0) / 255.0;
        *p = Rgb([r, g, b]);
    }
    img
}

fn prev_power_of_two(x: usize) -> usize {
    if x == 0 {
        return 0;
    }
    let mut p = 1;
    while p * 2 <= x {
        p *= 2;
    }
    p
}

fn gaussian_blur_1ch(data: &[f32], width: usize, height: usize, sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil() as usize;
    let klen = 2 * radius + 1;
    let mut kernel = vec![0.0f32; klen];
    let two_s2 = 2.0 * sigma * sigma;
    for (i, kernel_val) in kernel.iter_mut().enumerate() {
        let k = i as f32 - radius as f32;
        *kernel_val = (-k * k / two_s2).exp();
    }
    let ksum: f32 = kernel.iter().sum();
    for k in &mut kernel {
        *k /= ksum;
    }

    let mut tmp = vec![0.0f32; width * height];
    for y in 0..height {
        let row_in = &data[y * width..(y + 1) * width];
        let row_out = &mut tmp[y * width..(y + 1) * width];
        for (x, out_val) in row_out.iter_mut().enumerate() {
            let mut val = 0.0f32;
            let mut wsum = 0.0f32;
            let x0 = x as isize - radius as isize;
            for (ki, &kernel_val) in kernel.iter().enumerate() {
                let kx = x0 + ki as isize;
                if kx >= 0 && kx < width as isize {
                    val += row_in[kx as usize] * kernel_val;
                    wsum += kernel_val;
                }
            }
            *out_val = val / wsum;
        }
    }

    let mut out = vec![0.0f32; width * height];
    for y in 0..height {
        let y0 = y as isize - radius as isize;
        for x in 0..width {
            let mut val = 0.0f32;
            let mut wsum = 0.0f32;
            for (ki, &kernel_val) in kernel.iter().enumerate() {
                let ky = y0 + ki as isize;
                if ky >= 0 && ky < height as isize {
                    val += tmp[ky as usize * width + x] * kernel_val;
                    wsum += kernel_val;
                }
            }
            out[y * width + x] = val / wsum;
        }
    }

    out
}

#[cfg(test)]
mod source_domain_tests {
    use super::*;

    #[test]
    fn source_normalization_preserves_linear_midtones_and_hdr_headroom() {
        let source = Rgb32FImage::from_raw(2, 1, vec![-0.1, 0.18, 1.7, 0.2, 0.5, 0.9]).unwrap();
        let (normalized, range) = normalize_denoise_source(&source).unwrap();
        assert_eq!(range, (-0.1, 1.7));
        assert!(normalized.as_raw().iter().all(|v| (0.0..=1.0).contains(v)));
        let restored = restore_denoise_source(&source, &normalized, range, 1.0).unwrap();
        for (actual, expected) in restored.as_raw().iter().zip(source.as_raw()) {
            assert!((actual - expected).abs() < 1e-6);
        }
        // The legacy RAW display bake would move 0.18 and clip 1.7 to 1.0.
        let mut display = DynamicImage::ImageRgb32F(source.clone());
        apply_cpu_default_raw_processing(&mut display);
        assert!((display.to_rgb32f().get_pixel(0, 0)[1] - 0.18).abs() > 0.1);
        assert_eq!(display.to_rgb32f().get_pixel(0, 0)[2], 1.0);
    }

    #[test]
    fn zero_strength_is_exact_and_partial_strength_only_blends_source_domain() {
        let source = Rgb32FImage::from_pixel(1, 1, Rgb([0.18, 0.5, 1.7]));
        let filtered = Rgb32FImage::from_pixel(1, 1, Rgb([0.2, 0.3, 0.8]));
        assert_eq!(
            restore_denoise_source(&source, &filtered, (0.0, 2.0), 0.0).unwrap(),
            source
        );
        let half = restore_denoise_source(&source, &filtered, (0.0, 2.0), 0.5).unwrap();
        assert!((half.get_pixel(0, 0)[0] - 0.29).abs() < 1e-6);
        assert!((half.get_pixel(0, 0)[1] - 0.55).abs() < 1e-6);
        assert!((half.get_pixel(0, 0)[2] - 1.65).abs() < 1e-6);
    }

    #[test]
    fn nonfinite_or_mismatched_filter_outputs_fail_instead_of_corrupting_source() {
        let source = Rgb32FImage::from_pixel(1, 1, Rgb([0.18, 0.5, 0.9]));
        let invalid = Rgb32FImage::from_pixel(1, 1, Rgb([f32::NAN, 0.0, 0.0]));
        assert!(normalize_denoise_source(&invalid).is_err());
        assert!(restore_denoise_source(&source, &invalid, (0.0, 1.0), 0.5).is_err());
        assert!(restore_denoise_source(&source, &Rgb32FImage::new(2, 1), (0.0, 1.0), 0.5).is_err());
    }
}
