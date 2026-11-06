//! Film simulation engine integration (spektrafilm).
//!
//! This module routes renders through the spektrafilm spectral film chain
//! instead of RapidRAW's built-in adjustment pipeline when the
//! `filmSimulation.enabled` adjustment is set. In film mode the engine owns
//! the whole scene-referred -> display-referred transform; from RapidRAW's
//! editing stack only white balance (applied upstream, in camera space) and
//! mask-based local exposure (film EV / print EV per mask) are fed in.
//!
//! Data flow:
//!   decoded linear-sRGB source -> CPU geometry warp -> WB multiply
//!   -> spektrafilm pipeline (GPU-resident on the shared wgpu device)
//!   -> clamped sRGB output -> display texture / DynamicImage readback.
//!
//! Per-mask local adjustment ("dodging & burning") is delivered as two
//! per-pixel EV offset maps composed from the cached mask bitmaps and each
//! mask's `adjustments.filmEv` / `adjustments.printEv` values.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

use image::{DynamicImage, ImageBuffer, Rgba};
use rayon::prelude::*;
use serde_json::Value;

use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::pipeline::{ExposureMaps, Pipeline};
use spektrafilm_core::profile::{load_profile, load_profile_by_name};
use spektrafilm_gpu::ComputeBackend;
use spektrafilm_gpu::cpu_backend::CpuBackend;
use spektrafilm_gpu::wgpu_backend::WgpuBackend;
use spektrafilm_math::image::ImageBuf;

use tauri::Manager;

use crate::app_state::AppState;
use crate::gpu_processing::DisplayOutput;
use crate::image_processing::{GpuContext, RenderOutputPrecision, get_geometry_params_from_json};
use crate::gpu_processing::RenderRequest;
use crate::render_source::RenderSource;

pub struct FilmEngineState {
    /// GPU backend sharing RapidRAW's device/queue (zero-copy interop).
    gpu: Option<WgpuBackend>,
    cpu: CpuBackend,
    /// Pipeline cache keyed by the full filmSimulation params hash.
    pipelines: HashMap<u64, Arc<Pipeline>>,
    data_dir: PathBuf,
}

static FILM_DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Called once from the app setup hook: resolves the bundled resource path
/// while an AppHandle is available and stashes it for the render path.
pub fn init_film_data_dir(app: &tauri::App) {
    let _ = FILM_DATA_DIR.set(film_data_dir_resolve(Some(app.handle())));
}

fn film_data_dir(app_handle: Option<&tauri::AppHandle>) -> PathBuf {
    if let Some(dir) = FILM_DATA_DIR.get() {
        return dir.clone();
    }
    film_data_dir_resolve(app_handle)
}

fn film_data_dir_resolve(app_handle: Option<&tauri::AppHandle>) -> PathBuf {
    if let Some(handle) = app_handle {
        if let Ok(p) = handle
            .path()
            .resolve("resources/film_data", tauri::path::BaseDirectory::Resource)
        {
            if p.exists() {
                return p;
            }
        }
    }
    // Dev fallback: vendored copy in the repo.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("film_data");
    if dev.exists() {
        return dev;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vendor")
        .join("spektrafilm-rs")
        .join("data")
}

fn get_or_init_film_engine<'a>(
    state: &'a tauri::State<'a, AppState>,
    context: &GpuContext,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<std::sync::MutexGuard<'a, Option<FilmEngineState>>, String> {
    let mut guard = state
        .film_engine
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let data_dir = film_data_dir(app_handle);
        log::info!("Film engine data dir: {}", data_dir.display());
        let gpu = Some(WgpuBackend::from_device(
            (*context.device).clone(),
            (*context.queue).clone(),
        ));
        *guard = Some(FilmEngineState {
            gpu,
            cpu: CpuBackend,
            pipelines: HashMap::new(),
            data_dir,
        });
    }
    Ok(guard)
}

/// True when the adjustments request the film simulation engine.
pub fn film_mode_active(adjustments: &Value) -> bool {
    adjustments
        .get("filmSimulation")
        .and_then(|fs| fs.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
}

struct FilmSelection {
    film_stock: String,
    print_paper: String,
    params: RuntimeParams,
    hash: u64,
}

fn parse_film_params(js: &Value) -> FilmSelection {
    let fs = js.get("filmSimulation").cloned().unwrap_or(Value::Null);
    let film_stock = fs
        .get("filmStock")
        .and_then(|v| v.as_str())
        .unwrap_or("kodak_portra_400")
        .to_string();
    let print_paper = fs
        .get("printPaper")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut params = RuntimeParams::default();
    if let Some(overrides) = fs.get("params") {
        // Merge the frontend overrides on top of the defaults field-wise via
        // serde: serialize defaults, deep-merge, deserialize back.
        let mut base = serde_json::to_value(&params).unwrap_or(Value::Null);
        deep_merge(&mut base, overrides);
        if let Ok(p) = serde_json::from_value::<RuntimeParams>(base) {
            params = p;
        }
    }

    // Hard contract with the host pipeline: RapidRAW hands us linear sRGB
    // pixels; we return clamped, sRGB-encoded pixels.
    params.io.input_color_space = "sRGB".to_string();
    params.io.input_cctf_decoding = false;
    params.io.output_color_space = "sRGB".to_string();
    params.io.output_cctf_encoding = true;

    let mut hasher = DefaultHasher::new();
    // Hash the fully-resolved params (post-merge) plus the stock selection so
    // any UI change rebuilds the pipeline exactly once.
    serde_json::to_string(&params).unwrap_or_default().hash(&mut hasher);
    film_stock.hash(&mut hasher);
    print_paper.hash(&mut hasher);

    FilmSelection {
        film_stock,
        print_paper,
        params,
        hash: hasher.finish(),
    }
}

fn deep_merge(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                deep_merge(b.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (b, o) => *b = o.clone(),
    }
}

fn get_or_build_pipeline(
    engine: &mut FilmEngineState,
    sel: &FilmSelection,
) -> Result<Arc<Pipeline>, String> {
    if let Some(p) = engine.pipelines.get(&sel.hash) {
        return Ok(Arc::clone(p));
    }
    let t = std::time::Instant::now();
    let film = load_profile_by_name(&engine.data_dir, &sel.film_stock)
        .map_err(|e| format!("Unknown film stock '{}': {}", sel.film_stock, e))?;
    let print_name = if sel.print_paper.is_empty() {
        film.info
            .target_print
            .clone()
            .unwrap_or_else(|| "fujifilm_crystal_archive_typeii".to_string())
    } else {
        sel.print_paper.clone()
    };
    let print = load_profile_by_name(&engine.data_dir, &print_name)
        .map_err(|e| format!("Unknown print paper '{}': {}", print_name, e))?;
    let pipeline = Pipeline::new_with_spectral(film, print, sel.params.clone(), &engine.data_dir)
        .map_err(|e| format!("Film pipeline build failed: {}", e))?;
    log::info!(
        "Film pipeline built for {} / {} in {:?}",
        sel.film_stock,
        print_name,
        t.elapsed()
    );
    let pipeline = Arc::new(pipeline);
    engine.pipelines.insert(sel.hash, Arc::clone(&pipeline));
    // Keep the cache bounded; rebuilds are tens of ms.
    while engine.pipelines.len() > 8 {
        let oldest = *engine.pipelines.keys().next().unwrap();
        engine.pipelines.remove(&oldest);
    }
    Ok(pipeline)
}

/// Effective white-balance multiplier as an RGB 3x3 matrix, computed with
/// exactly the math the shader path uses: M_lms->rgb * diag(exp(log_gains))
/// * M_rgb->lms.
fn wb_matrix(request: &RenderRequest) -> [[f32; 3]; 3] {
    let g = &request.adjustments.global;
    let gains = [
        g.wb_log_gain_l.exp(),
        g.wb_log_gain_m.exp(),
        g.wb_log_gain_s.exp(),
    ];
    let to_lms = |m: &crate::image_processing::GpuMat3| -> [[f32; 3]; 3] {
        // GpuMat3 stores columns (col0..col2) with padding.
        [
            [m.col0[0], m.col1[0], m.col2[0]],
            [m.col0[1], m.col1[1], m.col2[1]],
            [m.col0[2], m.col1[2], m.col2[2]],
        ]
    };
    let rgb_to_lms = to_lms(&g.wb_rgb_to_lms_matrix);
    let lms_to_rgb = to_lms(&g.wb_lms_to_rgb_matrix);
    let mut out = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let mut s = 0.0;
            for k in 0..3 {
                // (lms_to_rgb * diag(gains) * rgb_to_lms)[i][j]
                s += lms_to_rgb[i][k] * gains[k] * rgb_to_lms[k][j];
            }
            out[i][j] = s;
        }
    }
    out
}

/// Compose the per-pixel EV offset maps from the cached mask bitmaps and the
/// per-mask filmEv / printEv values in the raw adjustments JSON.
fn compose_exposure_maps(
    adjustments: &Value,
    mask_bitmaps: &[image::ImageBuffer<image::Luma<u8>, Vec<u8>>],
    width: u32,
    height: u32,
) -> Option<ExposureMaps> {
    let masks = adjustments.get("masks")?.as_array()?;
    let n = (width as usize) * (height as usize);
    let mut film_ev = vec![0.0f32; n];
    let mut print_ev = vec![0.0f32; n];
    let mut any = false;

    for (i, bitmap) in mask_bitmaps.iter().enumerate() {
        let Some(mask) = masks.get(i) else { break };
        let adj = mask.get("adjustments").cloned().unwrap_or(Value::Null);
        let film = adj
            .get("filmEv")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        let print = adj
            .get("printEv")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        if film == 0.0 && print == 0.0 {
            continue;
        }
        if bitmap.width() != width || bitmap.height() != height {
            continue;
        }
        any = true;
        let data = bitmap.as_raw();
        film_ev
            .par_iter_mut()
            .zip(print_ev.par_iter_mut())
            .zip(data.par_iter())
            .for_each(|((f, p), &b)| {
                let w = b as f32 / 255.0;
                *f += film * w;
                *p += print * w;
            });
    }

    if !any {
        return None;
    }
    Some(ExposureMaps {
        film_ev,
        print_ev,
        width,
        height,
    })
}

fn to_image_buf(img: &DynamicImage) -> ImageBuf {
    let rgb = img.to_rgb32f();
    let (w, h) = rgb.dimensions();
    ImageBuf::from_data(w, h, rgb.into_raw())
}

fn image_buf_to_dynamic(img: &ImageBuf, precision: RenderOutputPrecision) -> DynamicImage {
    let (w, h) = (img.width, img.height);
    match precision {
        RenderOutputPrecision::SixteenBit => {
            let mut buf = ImageBuffer::<Rgba<u16>, Vec<u16>>::new(w, h);
            buf.par_chunks_exact_mut(4)
                .zip(img.data.par_chunks_exact(3))
                .for_each(|(out, px)| {
                    for c in 0..3 {
                        let v = px[c];
                        out[c] = if v.is_finite() {
                            (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16
                        } else {
                            0
                        };
                    }
                    out[3] = u16::MAX;
                });
            DynamicImage::ImageRgba16(buf)
        }
        _ => {
            let mut buf = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(w, h);
            buf.par_chunks_exact_mut(4)
                .zip(img.data.par_chunks_exact(3))
                .for_each(|(out, px)| {
                    for c in 0..3 {
                        let v = px[c];
                        out[c] = if v.is_finite() {
                            (v.clamp(0.0, 1.0) * 255.0).round() as u8
                        } else {
                            0
                        };
                    }
                    out[3] = 255;
                });
            DynamicImage::ImageRgba8(buf)
        }
    }
}

/// Film-mode replacement for the whole GPU adjustment pass. Produces the
/// final display-ready image and optionally updates the on-screen display.
pub fn render_film_frame(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    source: &RenderSource,
    request: &RenderRequest,
    caller_id: &str,
    output_precision: RenderOutputPrecision,
    display_output: Option<DisplayOutput>,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<DynamicImage, String> {
    let start = std::time::Instant::now();
    let (width, height) = source.size();

    // 1. Geometry: film mode applies the full warp (crop/rotate/lens) on CPU.
    let geometry = get_geometry_params_from_json("", source.adjustments);
    let warped = crate::image_processing::warp_image_geometry(source.image, geometry);
    if (warped.width(), warped.height()) != (width, height) {
        log::warn!(
            "[{}] film warp dims {:?} != expected {:?}",
            caller_id,
            (warped.width(), warped.height()),
            (width, height)
        );
    }

    // 2. Linear RGB buffer + white balance (same math as the shader path).
    let mut img = to_image_buf(&warped);
    let wb = wb_matrix(request);
    let identity = (0..3).all(|i| (0..3).all(|j| (wb[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-6));
    if !identity {
        img.data.par_chunks_exact_mut(3).for_each(|px| {
            let (r, g, b) = (px[0], px[1], px[2]);
            px[0] = wb[0][0] * r + wb[0][1] * g + wb[0][2] * b;
            px[1] = wb[1][0] * r + wb[1][1] * g + wb[1][2] * b;
            px[2] = wb[2][0] * r + wb[2][1] * g + wb[2][2] * b;
        });
    }

    // 3. Film pipeline (cached) + exposure maps.
    let sel = parse_film_params(source.adjustments);
    let maps = compose_exposure_maps(source.adjustments, request.mask_bitmaps, img.width, img.height);

    let mut engine_guard = get_or_init_film_engine(state, context, app_handle)?;
    let engine = engine_guard.as_mut().ok_or("film engine unavailable")?;
    let mut pipeline = get_or_build_pipeline(engine, &sel)?.as_ref().clone();
    pipeline.set_exposure_maps(maps);

    let backend: &dyn ComputeBackend = match &engine.gpu {
        Some(g) => g,
        None => &engine.cpu,
    };
    let out = pipeline.process_resident_borrowed(&img, backend)
        .ok_or("film pipeline resident path unavailable")?;
    drop(engine_guard);

    log::info!(
        "[{}] film frame {}x{} rendered in {:?}",
        caller_id,
        width,
        height,
        start.elapsed()
    );

    // 4. Display: upload to a texture and present.
    let output_to_display = display_output.is_some();
    if let Some(output) = display_output {
        let rgba = image_buf_to_dynamic(&out, RenderOutputPrecision::EightBit).into_rgba8();
        let mut display_lock = context.display.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(display) = display_lock.as_mut() {
            let tex = context.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("film_display"),
                size: wgpu::Extent3d {
                    width: out.width,
                    height: out.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                rgba.as_raw(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * out.width),
                    rows_per_image: Some(out.height),
                },
                wgpu::Extent3d {
                    width: out.width,
                    height: out.height,
                    depth_or_array_layers: 1,
                },
            );
            let view = tex.create_view(&Default::default());
            let sz = [out.width as f32, out.height as f32];
            let _ = output; // target/layer currently informational
            display.show_texture(&context.device, &context.queue, &view, sz, sz);
        }
    }

    if output_to_display {
        // Mirror the native-display contract: callers expect an empty image
        // when the frame went straight to the screen.
        return Ok(DynamicImage::new_rgba8(0, 0));
    }
    Ok(image_buf_to_dynamic(&out, output_precision))
}

// ────────────────────────────── commands ──────────────────────────────

#[derive(serde::Serialize)]
pub struct FilmProfileEntry {
    pub name: String,
    pub label: String,
    pub kind: String,
    pub target_print: String,
}

#[tauri::command]
pub fn list_film_profiles(app_handle: tauri::AppHandle) -> Result<Value, String> {
    let dir = film_data_dir(Some(&app_handle));
    let profiles_dir = dir.join("profiles");
    let mut films = Vec::new();
    let mut papers = Vec::new();
    let entries = std::fs::read_dir(&profiles_dir)
        .map_err(|e| format!("film profiles dir missing ({}): {}", profiles_dir.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(p) = load_profile(&path) else { continue };
        let item = FilmProfileEntry {
            name: p.info.stock.clone().unwrap_or_default(),
            label: p.info.name.clone().unwrap_or_default(),
            kind: p.info.film_type.clone(),
            target_print: p.info.target_print.clone().unwrap_or_default(),
        };
        match p.info.support.as_str() {
            "paper" => papers.push(item),
            _ => films.push(item),
        }
    }
    films.sort_by(|a, b| a.label.cmp(&b.label));
    papers.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(serde_json::json!({ "films": films, "papers": papers }))
}
