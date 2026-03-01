#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mimalloc::MiMalloc;
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

mod ai_processing;
mod ai_connector;
mod culling;
mod denoising;
mod exif_processing;
mod file_management;
mod formats;
mod gpu_processing;
mod image_loader;
mod image_processing;
mod inpainting;
mod lut_processing;
mod mask_generation;
mod panorama_stitching;
mod panorama_utils;
mod preset_converter;
mod raw_processing;
mod tagging;
mod tagging_utils;
mod lens_correction;
mod negative_conversion;

use log;
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use std::time::Duration;
use std::sync::{Arc, Mutex};

use base64::{Engine as _, engine::general_purpose};
use image::codecs::jpeg::JpegEncoder;
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageBuffer, ImageFormat, Luma, Rgb, RgbImage, Rgba,
    RgbaImage, imageops,
};
use image_hdr::hdr_merge_images;
use image_hdr::input::HDRInput;
use imageproc::drawing::draw_line_segment_mut;
use imageproc::edges::canny;
use imageproc::hough::{LineDetectionOptions, detect_lines};
use rayon::prelude::*;
use reqwest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, ipc::Response};
use tempfile::NamedTempFile;
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;
use wgpu::{Texture, TextureView};
use mozjpeg_rs::{Encoder, Preset};

use crate::ai_processing::{
    AiForegroundMaskParameters, AiSkyMaskParameters, AiState, AiSubjectMaskParameters,
    generate_image_embeddings, get_or_init_ai_models, run_sam_decoder, run_sky_seg_model,
    run_u2netp_model,
};
use crate::exif_processing::{read_exposure_time_secs, read_iso};
use crate::file_management::{AppSettings, load_settings, parse_virtual_path, read_file_mapped};
use crate::formats::is_raw_file;
use crate::image_loader::{
    composite_patches_on_image, load_and_composite, load_base_image_from_bytes,
};
use crate::image_processing::{
    AllAdjustments, Crop, GeometryParams, GpuContext, ImageMetadata, apply_coarse_rotation,
    apply_cpu_default_raw_processing, apply_crop, apply_flip, apply_geometry_warp, apply_rotation,
    apply_unwarp_geometry, downscale_f32_image, get_all_adjustments_from_json,
    get_or_init_gpu_context, process_and_get_dynamic_image, warp_image_geometry,
};
use crate::lut_processing::Lut;
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, generate_mask_bitmap};
use tagging_utils::{candidates, hierarchy};

#[derive(serde::Serialize, serde::Deserialize)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Clone)]
pub struct LoadedImage {
    path: String,
    image: Arc<DynamicImage>, 
    is_raw: bool,
}

#[derive(Clone)]
pub struct CachedPreview {
    image: DynamicImage,
    small_image: DynamicImage,
    transform_hash: u64,
    scale: f32,
    unscaled_crop_offset: (f32, f32),
}

pub struct GpuImageCache {
    pub texture: Texture,
    pub texture_view: TextureView,
    pub width: u32,
    pub height: u32,
    pub transform_hash: u64,
}

pub struct GpuProcessorState {
    pub processor: crate::gpu_processing::GpuProcessor,
    pub width: u32,
    pub height: u32,
}

struct PreviewJob {
    adjustments: serde_json::Value,
    is_interactive: bool,
    responder: tokio::sync::oneshot::Sender<Vec<u8>>,
}

pub struct AppState {
    window_setup_complete: AtomicBool,
    original_image: Mutex<Option<LoadedImage>>,
    cached_preview: Mutex<Option<CachedPreview>>,
    gpu_context: Mutex<Option<GpuContext>>,
    gpu_image_cache: Mutex<Option<GpuImageCache>>,
    gpu_processor: Mutex<Option<GpuProcessorState>>,
    ai_state: Mutex<Option<AiState>>,
    ai_init_lock: TokioMutex<()>,
    export_task_handle: Mutex<Option<JoinHandle<()>>>,
    hdr_result: Arc<Mutex<Option<DynamicImage>>>,
    panorama_result: Arc<Mutex<Option<DynamicImage>>>,
    denoise_result: Arc<Mutex<Option<DynamicImage>>>,
    negative_conversion_result: Arc<Mutex<Option<DynamicImage>>>,
    indexing_task_handle: Mutex<Option<JoinHandle<()>>>,
    pub lut_cache: Mutex<HashMap<String, Arc<Lut>>>,
    initial_file_path: Mutex<Option<String>>,
    thumbnail_cancellation_token: Arc<AtomicBool>,
    preview_worker_tx: Mutex<Option<Sender<PreviewJob>>>,
    pub mask_cache: Mutex<HashMap<u64, GrayImage>>,
    pub patch_cache: Mutex<HashMap<String, serde_json::Value>>,
    pub geometry_cache: Mutex<HashMap<u64, DynamicImage>>,
    pub thumbnail_geometry_cache: Mutex<HashMap<String, (u64, DynamicImage, f32)>>,
    pub lens_db: Mutex<Option<lens_correction::LensDatabase>>,
    pub load_image_generation: Arc<AtomicUsize>,
}

#[derive(serde::Serialize)]
struct LoadImageResult {
    width: u32,
    height: u32,
    metadata: ImageMetadata,
    exif: HashMap<String, String>,
    is_raw: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
enum ResizeMode {
    LongEdge,
    ShortEdge,
    Width,
    Height,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ResizeOptions {
    mode: ResizeMode,
    value: u32,
    dont_enlarge: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportSettings {
    jpeg_quality: u8,
    resize: Option<ResizeOptions>,
    keep_metadata: bool,
    strip_gps: bool,
    filename_template: Option<String>,
    watermark: Option<WatermarkSettings>,
    #[serde(default)]
    export_masks: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CommunityPreset {
    pub name: String,
    pub creator: String,
    pub adjustments: Value,
}

#[derive(Serialize)]
struct LutParseResult {
    size: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkSettings {
    path: String,
    anchor: WatermarkAnchor,
    scale: f32,
    spacing: f32,
    opacity: f32,
}

#[derive(serde::Serialize)]
struct ImageDimensions {
    width: u32,
    height: u32,
}

fn apply_all_transformations(
    image: &DynamicImage,
    adjustments: &serde_json::Value,
) -> (DynamicImage, (f32, f32)) {
    let start_time = std::time::Instant::now();

    let warped_image = apply_geometry_warp(image, adjustments);

    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    let rotation_degrees = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
    let flip_horizontal = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);

    let coarse_rotated_image = apply_coarse_rotation(warped_image, orientation_steps);
    let flipped_image = apply_flip(coarse_rotated_image, flip_horizontal, flip_vertical);
    let rotated_image = apply_rotation(&flipped_image, rotation_degrees);

    let crop_data: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();
    let crop_json = serde_json::to_value(crop_data.clone()).unwrap_or(serde_json::Value::Null);
    let cropped_image = apply_crop(rotated_image, &crop_json);

    let unscaled_crop_offset = crop_data.map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));

    let duration = start_time.elapsed();
    log::info!("apply_all_transformations took: {:?}", duration);
    (cropped_image, unscaled_crop_offset)
}

const GEOMETRY_KEYS: &[&str] = &[
    "transformDistortion", "transformVertical", "transformHorizontal",
    "transformRotate", "transformAspect", "transformScale",
    "transformXOffset", "transformYOffset", "lensDistortionAmount",
    "lensVignetteAmount", "lensTcaAmount", "lensDistortionParams",
    "lensMaker", "lensModel", "lensDistortionEnabled",
    "lensTcaEnabled", "lensVignetteEnabled",
];

pub fn calculate_geometry_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    if let Some(patches) = adjustments.get("aiPatches") {
        patches.to_string().hash(&mut hasher);
    }

    adjustments["orientationSteps"].as_u64().hash(&mut hasher);

    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut hasher);
            val.to_string().hash(&mut hasher);
        }
    }

    hasher.finish()
}

fn calculate_visual_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);

    if let Some(obj) = adjustments.as_object() {
        for (key, value) in obj {
            if GEOMETRY_KEYS.contains(&key.as_str()) {
                continue;
            }

            match key.as_str() {
                "crop" | "rotation" | "orientationSteps" | "flipHorizontal" | "flipVertical" => (),
                _ => {
                    key.hash(&mut hasher);
                    value.to_string().hash(&mut hasher);
                }
            }
        }
    }

    hasher.finish()
}

fn calculate_transform_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0);
    orientation_steps.hash(&mut hasher);

    let rotation = adjustments["rotation"].as_f64().unwrap_or(0.0);
    (rotation.to_bits()).hash(&mut hasher);

    let flip_h = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    flip_h.hash(&mut hasher);

    let flip_v = adjustments["flipVertical"].as_bool().unwrap_or(false);
    flip_v.hash(&mut hasher);

    if let Some(crop_val) = adjustments.get("crop") {
        if !crop_val.is_null() {
            crop_val.to_string().hash(&mut hasher);
        }
    }

    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut hasher);
            val.to_string().hash(&mut hasher);
        }
    }

    if let Some(patches_val) = adjustments.get("aiPatches") {
        if let Some(patches_arr) = patches_val.as_array() {
            patches_arr.len().hash(&mut hasher);

            for patch in patches_arr {
                if let Some(id) = patch.get("id").and_then(|v| v.as_str()) {
                    id.hash(&mut hasher);
                }

                let is_visible = patch
                    .get("visible")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                is_visible.hash(&mut hasher);

                if let Some(patch_data) = patch.get("patchData") {
                    let color_len = patch_data
                        .get("color")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .len();
                    color_len.hash(&mut hasher);

                    let mask_len = patch_data
                        .get("mask")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .len();
                    mask_len.hash(&mut hasher);
                } else {
                    let data_len = patch
                        .get("patchDataBase64")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .len();
                    data_len.hash(&mut hasher);
                }

                if let Some(sub_masks_val) = patch.get("subMasks") {
                    sub_masks_val.to_string().hash(&mut hasher);
                }

                let invert = patch
                    .get("invert")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                invert.hash(&mut hasher);
            }
        }
    }

    hasher.finish()
}

fn calculate_full_job_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    adjustments.to_string().hash(&mut hasher);
    hasher.finish()
}

fn hydrate_adjustments(state: &tauri::State<AppState>, adjustments: &mut serde_json::Value) {
    let mut cache = state.patch_cache.lock().unwrap();

    if let Some(patches) = adjustments.get_mut("aiPatches").and_then(|v| v.as_array_mut()) {
        for patch in patches {
            let id = patch.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if id.is_empty() { continue; }

            let has_data = patch.get("patchData").map_or(false, |v| !v.is_null());

            if has_data {
                if let Some(data) = patch.get("patchData") {
                    cache.insert(id.clone(), data.clone());
                }
            } else {
                if let Some(cached_data) = cache.get(&id) {
                    patch["patchData"] = cached_data.clone();
                }
            }
        }
    }

    if let Some(masks) = adjustments.get_mut("masks").and_then(|v| v.as_array_mut()) {
        for mask_container in masks {
            if let Some(sub_masks) = mask_container.get_mut("subMasks").and_then(|v| v.as_array_mut()) {
                for sub_mask in sub_masks {
                    let id = sub_mask.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    if id.is_empty() { continue; }

                    if let Some(params) = sub_mask.get_mut("parameters").and_then(|p| p.as_object_mut()) {
                        if params.contains_key("mask_data_base64") {
                            let val = params.get("mask_data_base64").unwrap();
                            if !val.is_null() {
                                cache.insert(id.clone(), val.clone());
                            } else {
                                if let Some(cached_data) = cache.get(&id) {
                                    params.insert("mask_data_base64".to_string(), cached_data.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn generate_transformed_preview(
    loaded_image: &LoadedImage,
    adjustments: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> Result<(DynamicImage, f32, (f32, f32)), String> {
    let patched_original_image = composite_patches_on_image(&loaded_image.image, adjustments)
        .map_err(|e| format!("Failed to composite AI patches: {}", e))?;

    let (transformed_full_res, unscaled_crop_offset) =
        apply_all_transformations(&patched_original_image, adjustments);

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let final_preview_dim = settings.editor_preview_resolution.unwrap_or(1920);

    let (full_res_w, full_res_h) = transformed_full_res.dimensions();

    let final_preview_base = if full_res_w > final_preview_dim || full_res_h > final_preview_dim {
        downscale_f32_image(&transformed_full_res, final_preview_dim, final_preview_dim)
    } else {
        transformed_full_res
    };

    let scale_for_gpu = if full_res_w > 0 {
        final_preview_base.width() as f32 / full_res_w as f32
    } else {
        1.0
    };

    Ok((final_preview_base, scale_for_gpu, unscaled_crop_offset))
}

fn encode_to_base64_png(image: &GrayImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    image
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

fn get_or_load_lut(state: &tauri::State<AppState>, path: &str) -> Result<Arc<Lut>, String> {
    let mut cache = state.lut_cache.lock().unwrap();
    if let Some(lut) = cache.get(path) {
        return Ok(lut.clone());
    }

    let lut = lut_processing::parse_lut_file(path).map_err(|e| e.to_string())?;
    let arc_lut = Arc::new(lut);
    cache.insert(path.to_string(), arc_lut.clone());
    Ok(arc_lut)
}

#[tauri::command]
async fn load_image(
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<LoadImageResult, String> {
    let my_generation = state.load_image_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let generation_tracker = state.load_image_generation.clone();
    let cancel_token = Some((generation_tracker.clone(), my_generation));

    {
        *state.original_image.lock().unwrap() = None;
        *state.cached_preview.lock().unwrap() = None;
        *state.gpu_image_cache.lock().unwrap() = None;

        state.mask_cache.lock().unwrap().clear();
        state.patch_cache.lock().unwrap().clear();
        state.geometry_cache.lock().unwrap().clear();

        *state.denoise_result.lock().unwrap() = None;
        *state.hdr_result.lock().unwrap() = None;
        *state.panorama_result.lock().unwrap() = None;
        *state.negative_conversion_result.lock().unwrap() = None;
    }

    let (source_path, sidecar_path) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let metadata: ImageMetadata = if sidecar_path.exists() {
        let file_content = fs::read_to_string(sidecar_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&file_content).unwrap_or_default()
    } else {
        ImageMetadata::default()
    };

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    let path_clone = source_path_str.clone();

    let (pristine_img, exif_data) = tokio::task::spawn_blocking(move || {
        if generation_tracker.load(Ordering::SeqCst) != my_generation {
            return Err("Load cancelled".to_string());
        }

        let result: Result<(DynamicImage, HashMap<String, String>), String> = (|| {
            match read_file_mapped(Path::new(&path_clone)) {
                Ok(mmap) => {
                    if generation_tracker.load(Ordering::SeqCst) != my_generation {
                        return Err("Load cancelled".to_string());
                    }

                    let img =
                        load_base_image_from_bytes(
                            &mmap, 
                            &path_clone, 
                            false, 
                            highlight_compression, 
                            linear_mode.clone(), 
                            cancel_token.clone()
                        )
                            .map_err(|e| e.to_string())?;
                    let exif = exif_processing::read_exif_data(&path_clone, &mmap);
                    Ok((img, exif))
                }
                Err(e) => {
                    log::warn!(
                        "Failed to memory-map file '{}': {}. Falling back to standard read.",
                        path_clone,
                        e
                    );
                    let bytes = fs::read(&path_clone).map_err(|io_err| {
                        format!("Fallback read failed for {}: {}", path_clone, io_err)
                    })?;

                    if generation_tracker.load(Ordering::SeqCst) != my_generation {
                        return Err("Load cancelled".to_string());
                    }

                    let img = load_base_image_from_bytes(
                        &bytes,
                        &path_clone,
                        false,
                        highlight_compression,
                        linear_mode.clone(),
                        cancel_token.clone()
                    )
                    .map_err(|e| e.to_string())?;
                    let exif = exif_processing::read_exif_data(&path_clone, &bytes);
                    Ok((img, exif))
                }
            }
        })();
        result
    })
    .await
    .map_err(|e| e.to_string())??;

    if state.load_image_generation.load(Ordering::SeqCst) != my_generation {
        return Err("Load cancelled".to_string());
    }

    let is_raw = is_raw_file(&source_path_str);

    if state.load_image_generation.load(Ordering::SeqCst) != my_generation {
        return Err("Load cancelled".to_string());
    }

    let (orig_width, orig_height) = pristine_img.dimensions();

    *state.original_image.lock().unwrap() = Some(LoadedImage {
        path: source_path_str.clone(),
        image: Arc::new(pristine_img),
        is_raw,
    });

    Ok(LoadImageResult {
        width: orig_width,
        height: orig_height,
        metadata,
        exif: exif_data,
        is_raw,
    })
}

#[tauri::command]
fn get_image_dimensions(path: String) -> Result<ImageDimensions, String> {
    let (source_path, _) = parse_virtual_path(&path);
    image::image_dimensions(&source_path)
        .map(|(width, height)| ImageDimensions { width, height })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_thumbnail_generation(state: tauri::State<AppState>) -> Result<(), String> {
    state
        .thumbnail_cancellation_token
        .store(true, Ordering::SeqCst);
    Ok(())
}

fn apply_watermark(
    base_image: &mut DynamicImage,
    watermark_settings: &WatermarkSettings,
) -> Result<(), String> {
    let watermark_img = image::open(&watermark_settings.path)
        .map_err(|e| format!("Failed to open watermark image: {}", e))?;

    let (base_w, base_h) = base_image.dimensions();
    let base_min_dim = base_w.min(base_h) as f32;

    let watermark_scale_factor =
        (base_min_dim * (watermark_settings.scale / 100.0)) / watermark_img.width().max(1) as f32;
    let new_wm_w = (watermark_img.width() as f32 * watermark_scale_factor).round() as u32;
    let new_wm_h = (watermark_img.height() as f32 * watermark_scale_factor).round() as u32;

    if new_wm_w == 0 || new_wm_h == 0 {
        return Ok(());
    }

    let scaled_watermark =
        watermark_img.resize_exact(new_wm_w, new_wm_h, image::imageops::FilterType::Lanczos3);
    let mut scaled_watermark_rgba = scaled_watermark.to_rgba8();

    let opacity_factor = (watermark_settings.opacity / 100.0).clamp(0.0, 1.0);
    for pixel in scaled_watermark_rgba.pixels_mut() {
        pixel[3] = (pixel[3] as f32 * opacity_factor) as u8;
    }
    let final_watermark = DynamicImage::ImageRgba8(scaled_watermark_rgba);

    let spacing_pixels = (base_min_dim * (watermark_settings.spacing / 100.0)) as i64;
    let (wm_w, wm_h) = final_watermark.dimensions();

    let x = match watermark_settings.anchor {
        WatermarkAnchor::TopLeft | WatermarkAnchor::CenterLeft | WatermarkAnchor::BottomLeft => {
            spacing_pixels
        }
        WatermarkAnchor::TopCenter | WatermarkAnchor::Center | WatermarkAnchor::BottomCenter => {
            (base_w as i64 - wm_w as i64) / 2
        }
        WatermarkAnchor::TopRight | WatermarkAnchor::CenterRight | WatermarkAnchor::BottomRight => {
            base_w as i64 - wm_w as i64 - spacing_pixels
        }
    };

    let y = match watermark_settings.anchor {
        WatermarkAnchor::TopLeft | WatermarkAnchor::TopCenter | WatermarkAnchor::TopRight => {
            spacing_pixels
        }
        WatermarkAnchor::CenterLeft | WatermarkAnchor::Center | WatermarkAnchor::CenterRight => {
            (base_h as i64 - wm_h as i64) / 2
        }
        WatermarkAnchor::BottomLeft
        | WatermarkAnchor::BottomCenter
        | WatermarkAnchor::BottomRight => base_h as i64 - wm_h as i64 - spacing_pixels,
    };

    image::imageops::overlay(base_image, &final_watermark, x, y);

    Ok(())
}

pub fn get_cached_or_generate_mask(
    state: &tauri::State<AppState>,
    def: &MaskDefinition,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let mut hasher = DefaultHasher::new();

    let def_json = serde_json::to_string(&def).unwrap_or_default();
    def_json.hash(&mut hasher);

    width.hash(&mut hasher);
    height.hash(&mut hasher);
    scale.to_bits().hash(&mut hasher);
    crop_offset.0.to_bits().hash(&mut hasher);
    crop_offset.1.to_bits().hash(&mut hasher);

    let key = hasher.finish();

    {
        let cache = state.mask_cache.lock().unwrap();
        if let Some(img) = cache.get(&key) {
            return Some(img.clone());
        }
    }

    let generated = generate_mask_bitmap(def, width, height, scale, crop_offset);

    if let Some(img) = &generated {
        let mut cache = state.mask_cache.lock().unwrap();
        if cache.len() > 50 {
            cache.clear();
        }
        cache.insert(key, img.clone());
    }

    generated
}

fn process_preview_job(
    app_handle: &tauri::AppHandle,
    state: tauri::State<AppState>,
    mut adjustments_json: serde_json::Value,
    is_interactive: bool,
) -> Result<Vec<u8>, String> {
    let fn_start = std::time::Instant::now();
    let context = get_or_init_gpu_context(&state)?;
    hydrate_adjustments(&state, &mut adjustments_json);
    let adjustments_clone = adjustments_json;

    let loaded_image_guard = state.original_image.lock().unwrap();
    let loaded_image = loaded_image_guard.as_ref().ok_or("No original image loaded")?.clone();
    drop(loaded_image_guard);

    let new_transform_hash = calculate_transform_hash(&adjustments_clone);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let hq_live = settings.enable_high_quality_live_previews.unwrap_or(false);
    let interactive_divisor = if hq_live { 1.5 } else { 2.0 };
    let interactive_quality = if hq_live { 70 } else { 60 };

    let mut cached_preview_lock = state.cached_preview.lock().unwrap();

    let (final_preview_base, small_preview_base, scale_for_gpu, unscaled_crop_offset) =
        if let Some(cached) = &*cached_preview_lock {
            if cached.transform_hash == new_transform_hash {
                (
                    cached.image.clone(),
                    cached.small_image.clone(),
                    cached.scale,
                    cached.unscaled_crop_offset,
                )
            } else {
                *state.gpu_image_cache.lock().unwrap() = None;
                let (base, scale, offset) =
                    generate_transformed_preview(&loaded_image, &adjustments_clone, &app_handle)?;

                let final_preview_dim = settings.editor_preview_resolution.unwrap_or(1920);
                let target_size = (final_preview_dim as f32 / interactive_divisor) as u32;

                let (w, h) = base.dimensions();
                let (small_w, small_h) = if w > h {
                    let ratio = h as f32 / w as f32;
                    (target_size, (target_size as f32 * ratio) as u32)
                } else {
                    let ratio = w as f32 / h as f32;
                    ((target_size as f32 * ratio) as u32, target_size)
                };
                let small_base = image_processing::downscale_f32_image(&base, small_w, small_h);

                *cached_preview_lock = Some(CachedPreview {
                    image: base.clone(),
                    small_image: small_base.clone(),
                    transform_hash: new_transform_hash,
                    scale,
                    unscaled_crop_offset: offset,
                });
                (base, small_base, scale, offset)
            }
        } else {
            *state.gpu_image_cache.lock().unwrap() = None;
            let (base, scale, offset) =
                generate_transformed_preview(&loaded_image, &adjustments_clone, &app_handle)?;

            let final_preview_dim = settings.editor_preview_resolution.unwrap_or(1920);
            let target_size = (final_preview_dim as f32 / interactive_divisor) as u32;

            let (w, h) = base.dimensions();
            let (small_w, small_h) = if w > h {
                let ratio = h as f32 / w as f32;
                (target_size, (target_size as f32 * ratio) as u32)
            } else {
                let ratio = w as f32 / h as f32;
                ((target_size as f32 * ratio) as u32, target_size)
            };
            let small_base = image_processing::downscale_f32_image(&base, small_w, small_h);

            *cached_preview_lock = Some(CachedPreview {
                image: base.clone(),
                small_image: small_base.clone(),
                transform_hash: new_transform_hash,
                scale,
                unscaled_crop_offset: offset,
            });
            (base, small_base, scale, offset)
        };

    drop(cached_preview_lock);

    let (processing_image, effective_scale, jpeg_quality) = if is_interactive {
        let orig_w = final_preview_base.width() as f32;
        let small_w = small_preview_base.width() as f32;
        let scale_factor = if orig_w > 0.0 { small_w / orig_w } else { 1.0 };
        let new_scale = scale_for_gpu * scale_factor;
        (small_preview_base, new_scale, interactive_quality)
    } else {
        (final_preview_base, scale_for_gpu, 90)
    };

    let (preview_width, preview_height) = processing_image.dimensions();

    let mask_definitions: Vec<MaskDefinition> = adjustments_clone
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);

    let scaled_crop_offset = (
        unscaled_crop_offset.0 * effective_scale,
        unscaled_crop_offset.1 * effective_scale,
    );

    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| {
            get_cached_or_generate_mask(
                &state,
                def,
                preview_width,
                preview_height,
                effective_scale,
                scaled_crop_offset,
            )
        })
        .collect();

    let is_raw = loaded_image.is_raw;
    let final_adjustments = get_all_adjustments_from_json(&adjustments_clone, is_raw);
    let lut_path = adjustments_clone["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

    let final_processed_image_result = process_and_get_dynamic_image(
        &context,
        &state,
        &processing_image,
        new_transform_hash,
        final_adjustments,
        &mask_bitmaps,
        lut,
        "apply_adjustments",
    );

    if let Ok(final_processed_image) = final_processed_image_result {
        if let Ok(histogram_data) =
            image_processing::calculate_histogram_from_image(&final_processed_image)
        {
            let _ = app_handle.emit("histogram-update", histogram_data);
        }
        if !is_interactive {
            if let Ok(waveform_data) =
                image_processing::calculate_waveform_from_image(&final_processed_image)
            {
                let _ = app_handle.emit("waveform-update", waveform_data);
            }
        }

        let (width, height) = final_processed_image.dimensions();
        let rgb_pixels = final_processed_image.to_rgb8().into_vec();

        match Encoder::new(Preset::BaselineFastest)
            .quality(jpeg_quality as u8)
            .encode_rgb(&rgb_pixels, width as u32, height as u32)
        {
            Ok(bytes) => {
                log::info!("[process_preview_job] completed in {:?}", fn_start.elapsed());
                return Ok(bytes);
            },
            Err(e) => {
                return Err(format!("Failed to encode preview: {}", e));
            }
        }
    }

    Err("Processing failed".to_string())
}

fn start_preview_worker(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let (tx, rx): (Sender<PreviewJob>, Receiver<PreviewJob>) = mpsc::channel();

    *state.preview_worker_tx.lock().unwrap() = Some(tx);

    std::thread::spawn(move || {
        while let Ok(mut job) = rx.recv() {
            while let Ok(latest_job) = rx.try_recv() {
                job = latest_job;
            }

            let state = app_handle.state::<AppState>();
            let responder = job.responder;
            match process_preview_job(&app_handle, state, job.adjustments, job.is_interactive) {
                Ok(bytes) => {
                    let _ = responder.send(bytes);
                }
                Err(e) => {
                    log::error!("Preview worker error: {}", e);
                }
            }
        }
    });
}

#[tauri::command]
async fn apply_adjustments(
    js_adjustments: serde_json::Value,
    is_interactive: bool,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    {
        let tx_guard = state.preview_worker_tx.lock().unwrap();
        if let Some(worker_tx) = &*tx_guard {
            let job = PreviewJob {
                adjustments: js_adjustments,
                is_interactive,
                responder: tx,
            };
            worker_tx.send(job).map_err(|e| format!("Failed to send to preview worker: {}", e))?;
        } else {
            return Err("Preview worker not running".to_string());
        }
    }

    match rx.await {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(_) => Err("Superseded or worker failed".to_string()),
    }
}

#[tauri::command]
fn generate_uncropped_preview(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let context = get_or_init_gpu_context(&state)?;
    let mut adjustments_clone = js_adjustments.clone();
    hydrate_adjustments(&state, &mut adjustments_clone);

    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;

    thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let path = loaded_image.path.clone();
        let is_raw = loaded_image.is_raw;
        let unique_hash = calculate_full_job_hash(&path, &adjustments_clone);
        let patched_image =
            match composite_patches_on_image(&loaded_image.image, &adjustments_clone) {
                Ok(img) => img,
                Err(e) => {
                    eprintln!("Failed to composite patches for uncropped preview: {}", e);
                    loaded_image.image.as_ref().clone()
                }
            };

        let warped_image = apply_geometry_warp(&patched_image, &adjustments_clone);

        let orientation_steps = adjustments_clone["orientationSteps"].as_u64().unwrap_or(0) as u8;
        let coarse_rotated_image = apply_coarse_rotation(warped_image, orientation_steps);

        let flip_horizontal = adjustments_clone["flipHorizontal"].as_bool().unwrap_or(false);
        let flip_vertical = adjustments_clone["flipVertical"].as_bool().unwrap_or(false);

        let flipped_image = apply_flip(coarse_rotated_image, flip_horizontal, flip_vertical);

        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let preview_dim = settings.editor_preview_resolution.unwrap_or(1920);

        let (rotated_w, rotated_h) = flipped_image.dimensions();

        let (processing_base, scale_for_gpu) = if rotated_w > preview_dim || rotated_h > preview_dim
        {
            let base = downscale_f32_image(&flipped_image, preview_dim, preview_dim);
            let scale = if rotated_w > 0 {
                base.width() as f32 / rotated_w as f32
            } else {
                1.0
            };
            (base, scale)
        } else {
            (flipped_image.clone(), 1.0)
        };

        let (preview_width, preview_height) = processing_base.dimensions();

        let mask_definitions: Vec<MaskDefinition> = adjustments_clone
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_else(Vec::new);

        let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
            .iter()
            .filter_map(|def| {
                get_cached_or_generate_mask(
                    &state,
                    def,
                    preview_width,
                    preview_height,
                    scale_for_gpu,
                    (0.0, 0.0),
                )
            })
            .collect();

        let uncropped_adjustments = get_all_adjustments_from_json(&adjustments_clone, is_raw);
        let lut_path = adjustments_clone["lutPath"].as_str();
        let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

        if let Ok(processed_image) = process_and_get_dynamic_image(
            &context,
            &state,
            &processing_base,
            unique_hash,
            uncropped_adjustments,
            &mask_bitmaps,
            lut,
            "generate_uncropped_preview",
        ) {
            let (width, height) = processed_image.dimensions();
            let rgb_pixels = processed_image.to_rgb8().into_vec();
            match Encoder::new(Preset::BaselineFastest)
                .quality(80)
                .encode_rgb(&rgb_pixels, width as u32, height as u32)
            {
                Ok(bytes) => {
                    let base64_str = general_purpose::STANDARD.encode(&bytes);
                    let data_url = format!("data:image/jpeg;base64,{}", base64_str);
                    let _ = app_handle.emit("preview-update-uncropped", data_url);
                }
                Err(e) => {
                    log::error!("Failed to encode uncropped preview with mozjpeg-rs: {}", e);
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn generate_original_transformed_preview(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;

    let mut adjustments_clone = js_adjustments.clone();
    hydrate_adjustments(&state, &mut adjustments_clone);

    let mut image_for_preview = loaded_image.image.as_ref().clone();
    if loaded_image.is_raw {
        apply_cpu_default_raw_processing(&mut image_for_preview);
    }

    let (transformed_full_res, _unscaled_crop_offset) =
        apply_all_transformations(&image_for_preview, &adjustments_clone);

    let settings = load_settings(app_handle).unwrap_or_default();
    let preview_dim = settings.editor_preview_resolution.unwrap_or(1920);

    let (w, h) = transformed_full_res.dimensions();
    let transformed_image = if w > preview_dim || h > preview_dim {
        downscale_f32_image(&transformed_full_res, preview_dim, preview_dim)
    } else {
        transformed_full_res
    };

    let (width, height) = transformed_image.dimensions();
    let rgb_pixels = transformed_image.to_rgb8().into_vec();

    let bytes = Encoder::new(Preset::BaselineFastest)
        .quality(80)
        .encode_rgb(&rgb_pixels, width as u32, height as u32)
        .map_err(|e| format!("Failed to encode with mozjpeg-rs: {}", e))?;

    let base64_str = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

#[tauri::command]
async fn preview_geometry_transform(
    params: GeometryParams,
    js_adjustments: serde_json::Value,
    show_lines: bool,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let (loaded_image_path, is_raw) = {
        let guard = state.original_image.lock().unwrap();
        let loaded = guard.as_ref().ok_or("No image loaded")?;
        (loaded.path.clone(), loaded.is_raw)
    };

    let visual_hash = calculate_visual_hash(&loaded_image_path, &js_adjustments);

    let base_image_to_warp = {
        let maybe_cached_image = state.geometry_cache.lock().unwrap().get(&visual_hash).cloned();

        if let Some(cached_image) = maybe_cached_image {
            cached_image
        } else {
            let context = get_or_init_gpu_context(&state)?;

            let original_image = {
                let guard = state.original_image.lock().unwrap();
                let loaded = guard.as_ref().ok_or("No image loaded")?;
                loaded.image.clone()
            };

            let settings = load_settings(app_handle.clone()).unwrap_or_default();
            let interactive_divisor = 1.5;
            let final_preview_dim = settings.editor_preview_resolution.unwrap_or(1920);
            let target_dim = (final_preview_dim as f32 / interactive_divisor) as u32;

            let preview_base = tokio::task::spawn_blocking(move || -> DynamicImage {
                downscale_f32_image(&original_image, target_dim, target_dim)
            }).await.map_err(|e| e.to_string())?;

            let mut temp_adjustments = js_adjustments.clone();
            hydrate_adjustments(&state, &mut temp_adjustments);

            if let Some(obj) = temp_adjustments.as_object_mut() {
                obj.insert("crop".to_string(), serde_json::Value::Null);
                obj.insert("rotation".to_string(), serde_json::json!(0.0));
                obj.insert("orientationSteps".to_string(), serde_json::json!(0));
                obj.insert("flipHorizontal".to_string(), serde_json::json!(false));
                obj.insert("flipVertical".to_string(), serde_json::json!(false));
                for key in GEOMETRY_KEYS {
                    match *key {
                        "transformScale" |
                        "lensDistortionAmount" |
                        "lensVignetteAmount" |
                        "lensTcaAmount" => {
                            obj.insert(key.to_string(), serde_json::json!(100.0));
                        },
                        "lensDistortionParams" |
                        "lensMaker" |
                        "lensModel" => {
                            obj.insert(key.to_string(), serde_json::Value::Null);
                        },
                        "lensDistortionEnabled" |
                        "lensTcaEnabled" |
                        "lensVignetteEnabled" => {
                            obj.insert(key.to_string(), serde_json::json!(true));
                        },
                        _ => {
                            obj.insert(key.to_string(), serde_json::json!(0.0));
                        }
                    }
                }
            }

            let all_adjustments = get_all_adjustments_from_json(&temp_adjustments, is_raw);
            let lut_path = temp_adjustments["lutPath"].as_str();
            let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
            let mask_bitmaps = Vec::new();

            let processed_base = process_and_get_dynamic_image(
                &context,
                &state,
                &preview_base,
                visual_hash,
                all_adjustments,
                &mask_bitmaps,
                lut,
                "preview_geometry_transform_base_gen",
            )?;

            let mut cache = state.geometry_cache.lock().unwrap();
            if cache.len() > 5 {
                cache.clear();
            }
            cache.insert(visual_hash, processed_base.clone());

            processed_base
        }
    };

    let final_image = tokio::task::spawn_blocking(move || -> DynamicImage {
        let mut adjusted_params = params;

        if is_raw { // approximate linear vignetting correction on gamma-baked & tonemapped geometry preview
            adjusted_params.lens_vignette_amount *= 0.4;
        } else {
            adjusted_params.lens_vignette_amount *= 0.8;
        }

        let warped_image = warp_image_geometry(&base_image_to_warp, adjusted_params);
        let orientation_steps = js_adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
        let flip_horizontal = js_adjustments["flipHorizontal"].as_bool().unwrap_or(false);
        let flip_vertical = js_adjustments["flipVertical"].as_bool().unwrap_or(false);

        let coarse_rotated_image = apply_coarse_rotation(warped_image, orientation_steps);
        let flipped_image = apply_flip(coarse_rotated_image, flip_horizontal, flip_vertical);

        if show_lines {
            let gray_image = flipped_image.to_luma8();
            let mut visualization = flipped_image.to_rgba8();
            let edges = canny(&gray_image, 50.0, 100.0);

            let min_dim = gray_image.width().min(gray_image.height());

            let options = LineDetectionOptions {
                vote_threshold: (min_dim as f32 * 0.24) as u32,
                suppression_radius: 15,
            };

            let lines = detect_lines(&edges, options);

            for line in lines {
                let angle_deg = line.angle_in_degrees as f32;
                let angle_norm = angle_deg % 180.0;
                let alignment_threshold = 0.5;
                let is_vertical = angle_norm < alignment_threshold || angle_norm > (180.0 - alignment_threshold);
                let is_horizontal = (angle_norm - 90.0).abs() < alignment_threshold;

                let color = if is_vertical || is_horizontal {
                    Rgba([0, 255, 0, 255])
                } else {
                    Rgba([255, 0, 0, 255])
                };

                let r = line.r;
                let theta_rad = angle_deg.to_radians();
                let a = theta_rad.cos();
                let b = theta_rad.sin();
                let x0 = a * r;
                let y0 = b * r;

                let dist = (visualization.width().max(visualization.height()) * 2) as f32;

                let x1 = x0 + dist * (-b);
                let y1 = y0 + dist * (a);
                let x2 = x0 - dist * (-b);
                let y2 = y0 - dist * (a);

                draw_line_segment_mut(
                    &mut visualization,
                    (x1, y1),
                    (x2, y2),
                    color,
                );
                draw_line_segment_mut(
                    &mut visualization,
                    (x1 + a, y1 + b),
                    (x2 + a, y2 + b),
                    color,
                );
            }

            DynamicImage::ImageRgba8(visualization)
        } else {
            flipped_image
        }
    }).await.map_err(|e| e.to_string())?;

    let (width, height) = final_image.dimensions();
    let rgb_pixels = final_image.to_rgb8().into_vec();

    let bytes = Encoder::new(Preset::BaselineFastest)
        .quality(75)
        .encode_rgb(&rgb_pixels, width as u32, height as u32)
        .map_err(|e| format!("Failed to encode with mozjpeg-rs: {}", e))?;

    let base64_str = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

fn get_full_image_for_processing(
    state: &tauri::State<AppState>,
) -> Result<(DynamicImage, bool), String> {
    let original_image_lock = state.original_image.lock().unwrap();
    let loaded_image = original_image_lock
        .as_ref()
        .ok_or("No original image loaded")?;
    Ok((loaded_image.image.clone().as_ref().clone(), loaded_image.is_raw))
}

#[tauri::command]
async fn generate_fullscreen_preview(
    js_adjustments: serde_json::Value,
    app_handle: tauri::AppHandle,
) -> Result<Response, String> {
    let app_handle_clone = app_handle.clone();
    tokio::task::spawn_blocking(move || {
        let state = app_handle_clone.state::<AppState>();
        let context = get_or_init_gpu_context(&state)?;

        let mut adjustments_clone = js_adjustments.clone();
        hydrate_adjustments(&state, &mut adjustments_clone);

        let (original_image, is_raw) = get_full_image_for_processing(&state)?;

        let path = state
            .original_image
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Original image path not found")?
            .path
            .clone();

        let unique_hash = calculate_full_job_hash(&path, &adjustments_clone);
        let base_image = composite_patches_on_image(&original_image, &adjustments_clone)
            .map_err(|e| format!("Failed to composite AI patches for fullscreen: {}", e))?;

        let (transformed_image, unscaled_crop_offset) =
            apply_all_transformations(&base_image, &adjustments_clone);
        let (img_w, img_h) = transformed_image.dimensions();

        let mask_definitions: Vec<MaskDefinition> = adjustments_clone
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_else(Vec::new);

        let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
            .iter()
            .filter_map(|def| generate_mask_bitmap(def, img_w, img_h, 1.0, unscaled_crop_offset))
            .collect();

        let all_adjustments = get_all_adjustments_from_json(&adjustments_clone, is_raw);
        let lut_path = adjustments_clone["lutPath"].as_str();
        let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

        let final_image = process_and_get_dynamic_image(
            &context,
            &state,
            &transformed_image,
            unique_hash,
            all_adjustments,
            &mask_bitmaps,
            lut,
            "generate_fullscreen_preview",
        )?;

        let (width, height) = final_image.dimensions();
        let rgb_pixels = final_image.to_rgb8().into_vec();

        let bytes = Encoder::new(Preset::BaselineFastest)
            .quality(92)
            .encode_rgb(&rgb_pixels, width as u32, height as u32)
            .map_err(|e| format!("Failed to encode fullscreen preview with mozjpeg-rs: {}", e))?;

        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn calculate_resize_target(
    current_w: u32,
    current_h: u32,
    resize_opts: &ResizeOptions,
) -> (u32, u32) {
    if resize_opts.dont_enlarge {
        let exceeds = match resize_opts.mode {
            ResizeMode::LongEdge => current_w.max(current_h) > resize_opts.value,
            ResizeMode::ShortEdge => current_w.min(current_h) > resize_opts.value,
            ResizeMode::Width => current_w > resize_opts.value,
            ResizeMode::Height => current_h > resize_opts.value,
        };
        if !exceeds {
            return (current_w, current_h);
        }
    }

    let fix_width = match resize_opts.mode {
        ResizeMode::LongEdge => current_w >= current_h,
        ResizeMode::ShortEdge => current_w <= current_h,
        ResizeMode::Width => true,
        ResizeMode::Height => false,
    };

    let value = resize_opts.value;
    if fix_width {
        let h = (value as f32 * (current_h as f32 / current_w as f32)).round() as u32;
        (value, h)
    } else {
        let w = (value as f32 * (current_w as f32 / current_h as f32)).round() as u32;
        (w, value)
    }
}

fn apply_export_resize_and_watermark(
    mut image: DynamicImage,
    export_settings: &ExportSettings,
) -> Result<DynamicImage, String> {
    if let Some(resize_opts) = &export_settings.resize {
        let (current_w, current_h) = image.dimensions();
        let (target_w, target_h) = calculate_resize_target(current_w, current_h, resize_opts);
        
        if target_w != current_w || target_h != current_h {
            image = image.resize(target_w, target_h, imageops::FilterType::Lanczos3);
        }
    }

    if let Some(watermark_settings) = &export_settings.watermark {
        apply_watermark(&mut image, watermark_settings)?;
    }
    Ok(image)
}

fn process_image_for_export_pipeline(
    path: &str,
    base_image: &DynamicImage,
    js_adjustments: &Value,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    is_raw: bool,
    debug_tag: &str,
) -> Result<DynamicImage, String> {
    let (transformed_image, unscaled_crop_offset) =
        apply_all_transformations(&base_image, &js_adjustments);
    let (img_w, img_h) = transformed_image.dimensions();

    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);

    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, img_w, img_h, 1.0, unscaled_crop_offset))
        .collect();

    let mut all_adjustments = get_all_adjustments_from_json(&js_adjustments, is_raw);
    all_adjustments.global.show_clipping = 0;

    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

    let unique_hash = calculate_full_job_hash(path, js_adjustments);

    process_and_get_dynamic_image(
        &context,
        &state,
        &transformed_image,
        unique_hash,
        all_adjustments,
        &mask_bitmaps,
        lut,
        debug_tag,
    )
}

fn save_image_with_metadata(
    image: &DynamicImage,
    output_path: &std::path::Path,
    source_path_str: &str,
    export_settings: &ExportSettings,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut image_bytes =
        encode_image_to_bytes(image, &extension, export_settings.jpeg_quality)?;

    exif_processing::write_image_with_metadata(
        &mut image_bytes,
        source_path_str,
        &extension,
        export_settings.keep_metadata,
        export_settings.strip_gps,
    )?;

    fs::write(output_path, image_bytes).map_err(|e| e.to_string())?;
    Ok(())
}

fn process_image_for_export(
    path: &str,
    base_image: &DynamicImage,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    is_raw: bool,
) -> Result<DynamicImage, String> {
    let processed_image = process_image_for_export_pipeline(
        path,
        base_image,
        js_adjustments,
        context,
        state,
        is_raw,
        "process_image_for_export",
    )?;

    apply_export_resize_and_watermark(processed_image, export_settings)
}

fn build_single_mask_adjustments(all: &AllAdjustments, mask_index: usize) -> AllAdjustments {
    let mut single = AllAdjustments {
        global: all.global,
        mask_adjustments: all.mask_adjustments,
        mask_count: 1,
        tile_offset_x: all.tile_offset_x,
        tile_offset_y: all.tile_offset_y,
        mask_atlas_cols: all.mask_atlas_cols,
    };
    single.mask_adjustments[0] = all.mask_adjustments[mask_index];
    for i in 1..single.mask_adjustments.len() {
        single.mask_adjustments[i] = Default::default();
    }
    single
}

fn encode_grayscale_to_png(bitmap: &GrayImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    bitmap
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn encode_image_to_bytes(
    image: &DynamicImage,
    output_format: &str,
    jpeg_quality: u8,
) -> Result<Vec<u8>, String> {
    let mut image_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut image_bytes);

    match output_format.to_lowercase().as_str() {
        "jpg" | "jpeg" => {
            let rgb_image = image.to_rgb8();
            let encoder = JpegEncoder::new_with_quality(&mut cursor, jpeg_quality);
            rgb_image
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        "png" => {
            let image_to_encode = if image.as_rgb32f().is_some() {
                DynamicImage::ImageRgb16(image.to_rgb16())
            } else {
                image.clone()
            };

            image_to_encode
                .write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
        "tiff" => {
            DynamicImage::ImageRgb16(image.to_rgb16())
                .write_to(&mut cursor, image::ImageFormat::Tiff)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unsupported file format: {}", output_format)),
    };
    Ok(image_bytes)
}

fn export_masks_for_image(
    base_image: &DynamicImage,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    output_path_obj: &std::path::Path,
    source_path_str: &str,
    context: &Arc<GpuContext>,
    state: &tauri::State<AppState>,
    is_raw: bool,
) -> Result<(), String> {
    let (transformed_image, unscaled_crop_offset) =
        apply_all_transformations(&base_image, &js_adjustments);
    let (img_w, img_h) = transformed_image.dimensions();
    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);
    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, img_w, img_h, 1.0, unscaled_crop_offset))
        .collect();

    if !mask_bitmaps.is_empty() {
        let all_adjustments = get_all_adjustments_from_json(&js_adjustments, is_raw);
        let lut_path = js_adjustments["lutPath"].as_str();
        let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
        let unique_hash = calculate_full_job_hash(&source_path_str, &js_adjustments);
        let output_dir = output_path_obj.parent().unwrap_or_else(|| output_path_obj.as_ref());
        let stem = output_path_obj
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export");
        let extension = output_path_obj.extension().and_then(|s| s.to_str()).unwrap_or("jpg");

        for (i, _) in mask_bitmaps.iter().enumerate() {
            let single_adjustments = build_single_mask_adjustments(&all_adjustments, i);
            let full_white_mask = ImageBuffer::from_fn(img_w, img_h, |_, _| Luma([255u8]));
            let single_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = vec![full_white_mask];
            
            let processed = process_and_get_dynamic_image(
                &context,
                &state,
                &transformed_image,
                unique_hash,
                single_adjustments,
                &single_bitmaps,
                lut.clone(),
                "export_mask_image",
            )?;
            
            let with_options = apply_export_resize_and_watermark(processed, &export_settings)?;
            let (out_w, out_h) = with_options.dimensions();
            
            let alpha_resized = imageops::resize(
                &mask_bitmaps[i],
                out_w,
                out_h,
                imageops::FilterType::Lanczos3,
            );

            let mask_image_path = output_dir.join(format!("{}_mask_{}_image.{}", stem, i, extension));
            let mask_alpha_path = output_dir.join(format!("{}_mask_{}_alpha.png", stem, i));

            save_image_with_metadata(&with_options, &mask_image_path, &source_path_str, &export_settings)?;

            let alpha_bytes = encode_grayscale_to_png(&alpha_resized)?;
            fs::write(&mask_alpha_path, alpha_bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn export_image(
    original_path: String,
    output_path: String,
    js_adjustments: Value,
    export_settings: ExportSettings,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if state.export_task_handle.lock().unwrap().is_some() {
        return Err("An export is already in progress.".to_string());
    }

    let context = get_or_init_gpu_context(&state)?;
    let (original_image_data, is_raw) = get_full_image_for_processing(&state)?;
    let context = Arc::new(context);

    let task = tokio::spawn(async move {
        let state = app_handle.state::<AppState>();
        let processing_result: Result<(), String> = (|| {
            let (source_path, _) = parse_virtual_path(&original_path);
            let source_path_str = source_path.to_string_lossy().to_string();

            let base_image = composite_patches_on_image(&original_image_data, &js_adjustments)
                .map_err(|e| format!("Failed to composite AI patches for export: {}", e))?;

            let mut main_export_adjustments = js_adjustments.clone();
            if export_settings.export_masks {
                if let Some(obj) = main_export_adjustments.as_object_mut() {
                    obj.insert("masks".to_string(), serde_json::json!([]));
                }
            }

            let final_image = process_image_for_export(
                &source_path_str,
                &base_image,
                &main_export_adjustments,
                &export_settings,
                &context,
                &state,
                is_raw,
            )?;

            let output_path_obj = std::path::Path::new(&output_path);
            save_image_with_metadata(&final_image, output_path_obj, &source_path_str, &export_settings)?;

            if export_settings.export_masks {
                export_masks_for_image(
                    &base_image,
                    &js_adjustments,
                    &export_settings,
                    output_path_obj,
                    &source_path_str,
                    &context,
                    &state,
                    is_raw
                )?;
            }

            Ok(())
        })();

        if let Err(e) = processing_result {
            let _ = app_handle.emit("export-error", e);
        } else {
            let _ = app_handle.emit("export-complete", ());
        }

        *app_handle
            .state::<AppState>()
            .export_task_handle
            .lock()
            .unwrap() = None;
    });

    *state.export_task_handle.lock().unwrap() = Some(task);
    Ok(())
}

#[tauri::command]
async fn batch_export_images(
    output_folder: String,
    paths: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if state.export_task_handle.lock().unwrap().is_some() {
        return Err("An export is already in progress.".to_string());
    }

    let context = get_or_init_gpu_context(&state)?;
    let context = Arc::new(context);
    let progress_counter = Arc::new(AtomicUsize::new(0));

    let available_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let num_threads = (available_cores / 2).clamp(1, 4);

    log::info!("Starting batch export. System cores: {}, Export threads: {}", available_cores, num_threads);

    let task = tokio::spawn(async move {
        let state = app_handle.state::<AppState>();
        let output_folder_path = std::path::Path::new(&output_folder);
        let total_paths = paths.len();
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
        let linear_mode = settings.linear_raw_mode;

        let pool_result = rayon::ThreadPoolBuilder::new()
            .num_threads(num_threads)
            .build();

        if let Err(e) = pool_result {
            let _ = app_handle.emit("export-error", format!("Failed to initialize worker threads: {}", e));
            *app_handle.state::<AppState>().export_task_handle.lock().unwrap() = None;
            return;
        }
        let pool = pool_result.unwrap();

        let results: Vec<Result<(), String>> = pool.install(|| {
            paths
                .par_iter()
                .enumerate()
                .map(|(global_index, image_path_str)| {
                    if app_handle
                        .state::<AppState>()
                        .export_task_handle
                        .lock()
                        .unwrap()
                        .is_none()
                    {
                        return Err("Export cancelled".to_string());
                    }

                    let current_progress = progress_counter.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app_handle.emit(
                        "batch-export-progress",
                        serde_json::json!({
                            "current": current_progress,
                            "total": total_paths,
                            "path": image_path_str
                        }),
                    );

                    let result: Result<(), String> = (|| {
                        let (source_path, sidecar_path) = parse_virtual_path(image_path_str);
                        let source_path_str = source_path.to_string_lossy().to_string();

                        let metadata: ImageMetadata = if sidecar_path.exists() {
                            let file_content = fs::read_to_string(sidecar_path)
                                .map_err(|e| format!("Failed to read sidecar: {}", e))?;
                            serde_json::from_str(&file_content).unwrap_or_default()
                        } else {
                            ImageMetadata::default()
                        };
                        let mut js_adjustments = metadata.adjustments;
                        hydrate_adjustments(&state, &mut js_adjustments);
                        let is_raw = is_raw_file(&source_path_str);

                        let base_image = match read_file_mapped(Path::new(&source_path_str)) {
                            Ok(mmap) => load_and_composite(
                                &mmap,
                                &source_path_str,
                                &js_adjustments,
                                false,
                                highlight_compression,
                                linear_mode.clone(),
                                None,
                            )
                            .map_err(|e| format!("Failed to load image from mmap: {}", e))?,
                            Err(e) => {
                                log::warn!(
                                    "Failed to memory-map file '{}': {}. Falling back to standard read.",
                                    source_path_str,
                                    e
                                );
                                let bytes = fs::read(&source_path_str).map_err(|io_err| {
                                    format!("Fallback read failed for {}: {}", source_path_str, io_err)
                                })?;
                                load_and_composite(
                                    &bytes,
                                    &source_path_str,
                                    &js_adjustments,
                                    false,
                                    highlight_compression,
                                    linear_mode.clone(),
                                    None,
                                )
                                .map_err(|e| format!("Failed to load image from bytes: {}", e))?
                            }
                        };

                        let mut main_export_adjustments = js_adjustments.clone();
                        if export_settings.export_masks {
                            if let Some(obj) = main_export_adjustments.as_object_mut() {
                                obj.insert("masks".to_string(), serde_json::json!([]));
                            }
                        }

                        let final_image = process_image_for_export(
                            &source_path_str,
                            &base_image,
                            &main_export_adjustments,
                            &export_settings,
                            &context,
                            &state,
                            is_raw,
                        )?;

                        let original_path = std::path::Path::new(&source_path_str);
                        let file_date = exif_processing::get_creation_date_from_path(original_path);

                        let filename_template = export_settings
                            .filename_template
                            .as_deref()
                            .unwrap_or("{original_filename}_edited");
                        let new_stem = crate::file_management::generate_filename_from_template(
                            filename_template,
                            original_path,
                            global_index + 1,
                            total_paths,
                            &file_date,
                        );
                        let new_filename = format!("{}.{}", new_stem, output_format);
                        let output_path = output_folder_path.join(new_filename);

                        save_image_with_metadata(&final_image, &output_path, &source_path_str, &export_settings)?;
                        
                        if export_settings.export_masks {
                            export_masks_for_image(
                                &base_image,
                                &js_adjustments,
                                &export_settings,
                                &output_path,
                                &source_path_str,
                                &context,
                                &state,
                                is_raw
                            )?;
                        }

                        Ok(())
                    })();

                    result
                })
                .collect()
        });

        let mut error_count = 0;
        for result in results {
            if let Err(e) = result {
                error_count += 1;
                log::error!("Batch export error: {}", e);
                let _ = app_handle.emit("export-error", e);
            }
        }

        if error_count > 0 {
            let _ = app_handle.emit(
                "export-complete-with-errors",
                serde_json::json!({ "errors": error_count, "total": total_paths }),
            );
        } else {
            let _ = app_handle.emit(
                "batch-export-progress",
                serde_json::json!({ "current": total_paths, "total": total_paths, "path": "" }),
            );
            let _ = app_handle.emit("export-complete", ());
        }

        *app_handle
            .state::<AppState>()
            .export_task_handle
            .lock()
            .unwrap() = None;
    });

    *state.export_task_handle.lock().unwrap() = Some(task);
    Ok(())
}

#[tauri::command]
fn cancel_export(state: tauri::State<AppState>) -> Result<(), String> {
    match state.export_task_handle.lock().unwrap().take() {
        Some(handle) => {
            handle.abort();
            println!("Export task cancellation requested.");
        }
        _ => {
            return Err("No export task is currently running.".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn estimate_export_size(
    js_adjustments: Value,
    export_settings: ExportSettings,
    output_format: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<usize, String> {
    let context = get_or_init_gpu_context(&state)?;
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;
    let is_raw = loaded_image.is_raw;

    let mut adjustments_clone = js_adjustments.clone();
    hydrate_adjustments(&state, &mut adjustments_clone);

    let new_transform_hash = calculate_transform_hash(&adjustments_clone);
    let cached_preview_lock = state.cached_preview.lock().unwrap();

    let (preview_image, scale, unscaled_crop_offset) = if let Some(cached) = &*cached_preview_lock {
        if cached.transform_hash == new_transform_hash {
            (
                cached.image.clone(),
                cached.scale,
                cached.unscaled_crop_offset,
            )
        } else {
            drop(cached_preview_lock);
            generate_transformed_preview(&loaded_image, &adjustments_clone, &app_handle)?
        }
    } else {
        drop(cached_preview_lock);
        generate_transformed_preview(&loaded_image, &adjustments_clone, &app_handle)?
    };

    let (img_w, img_h) = preview_image.dimensions();
    let mask_definitions: Vec<MaskDefinition> = adjustments_clone
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);

    let scaled_crop_offset = (
        unscaled_crop_offset.0 * scale,
        unscaled_crop_offset.1 * scale,
    );

    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, img_w, img_h, scale, scaled_crop_offset))
        .collect();

    let mut all_adjustments = get_all_adjustments_from_json(&adjustments_clone, is_raw);
    all_adjustments.global.show_clipping = 0;

    let lut_path = adjustments_clone["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
    let unique_hash = calculate_full_job_hash(&loaded_image.path, &adjustments_clone).wrapping_add(1);

    let processed_preview = process_and_get_dynamic_image(
        &context,
        &state,
        &preview_image,
        unique_hash,
        all_adjustments,
        &mask_bitmaps,
        lut,
        "estimate_export_size",
    )?;

    let preview_bytes = encode_image_to_bytes(
        &processed_preview,
        &output_format,
        export_settings.jpeg_quality,
    )?;
    let preview_byte_size = preview_bytes.len();

    let (transformed_full_res, _unscaled_crop_offset) =
        apply_all_transformations(&loaded_image.image, &adjustments_clone);
    let (full_w, full_h) = transformed_full_res.dimensions();

    let (final_full_w, final_full_h) = if let Some(resize_opts) = &export_settings.resize {
        calculate_resize_target(full_w, full_h, resize_opts)
    } else {
        (full_w, full_h)
    };

    let (processed_preview_w, processed_preview_h) = processed_preview.dimensions();

    let pixel_ratio = if processed_preview_w > 0 && processed_preview_h > 0 {
        (final_full_w as f64 * final_full_h as f64)
            / (processed_preview_w as f64 * processed_preview_h as f64)
    } else {
        1.0
    };

    let estimated_size = (preview_byte_size as f64 * pixel_ratio) as usize;

    Ok(estimated_size)
}

#[tauri::command]
async fn estimate_batch_export_size(
    paths: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let context = get_or_init_gpu_context(&state)?;
    let first_path = &paths[0];
    let (source_path, sidecar_path) = parse_virtual_path(first_path);
    let source_path_str = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source_path_str);

    let metadata: ImageMetadata = if sidecar_path.exists() {
        let file_content = fs::read_to_string(sidecar_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&file_content).unwrap_or_default()
    } else {
        ImageMetadata::default()
    };
    let js_adjustments = metadata.adjustments;

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    const ESTIMATE_DIM: u32 = 1280;

    let mmap_guard; 
    let vec_guard; 

    let file_slice: &[u8] = match read_file_mapped(Path::new(&source_path_str)) {
        Ok(mmap) => {
            mmap_guard = Some(mmap);
            mmap_guard.as_ref().unwrap()
        }
        Err(e) => {
            log::warn!(
                "Failed to memory-map file '{}': {}. Falling back to standard read.",
                source_path_str,
                e
            );
            let bytes = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
            vec_guard = Some(bytes);
            vec_guard.as_ref().unwrap()
        }
    };

    let original_image = load_base_image_from_bytes(
        file_slice, 
        &source_path_str, 
        true,
        highlight_compression, 
        linear_mode.clone(),
        None
    ).map_err(|e| e.to_string())?;

    let raw_scale_factor = if is_raw {
        crate::raw_processing::get_fast_demosaic_scale_factor(
            file_slice, 
            original_image.width(), 
            original_image.height()
        )
    } else {
        1.0
    };

    let mut scaled_adjustments = js_adjustments.clone();
    if let Some(crop_val) = scaled_adjustments.get_mut("crop") {
        if let Ok(c) = serde_json::from_value::<Crop>(crop_val.clone()) {
            *crop_val = serde_json::to_value(Crop {
                x: c.x * raw_scale_factor as f64,
                y: c.y * raw_scale_factor as f64,
                width: c.width * raw_scale_factor as f64,
                height: c.height * raw_scale_factor as f64,
            }).unwrap_or(serde_json::Value::Null);
        }
    }

    let (transformed_shrunk_res, unscaled_crop_offset) =
        apply_all_transformations(&original_image, &scaled_adjustments);
    let (shrunk_w, shrunk_h) = transformed_shrunk_res.dimensions();

    let preview_base = if shrunk_w > ESTIMATE_DIM || shrunk_h > ESTIMATE_DIM {
        downscale_f32_image(&transformed_shrunk_res, ESTIMATE_DIM, ESTIMATE_DIM)
    } else {
        transformed_shrunk_res.clone()
    };

    let (preview_w, preview_h) = preview_base.dimensions();
    let gpu_scale = if shrunk_w > 0 { preview_w as f32 / shrunk_w as f32 } else { 1.0 };

    let total_scale = gpu_scale * raw_scale_factor;

    let mask_definitions: Vec<MaskDefinition> = scaled_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);

    let scaled_crop_offset = (
        unscaled_crop_offset.0 * gpu_scale,
        unscaled_crop_offset.1 * gpu_scale,
    );

    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, preview_w, preview_h, total_scale, scaled_crop_offset))
        .collect();

    let mut all_adjustments = get_all_adjustments_from_json(&scaled_adjustments, is_raw);
    all_adjustments.global.show_clipping = 0;

    let lut_path = scaled_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
    let unique_hash = calculate_full_job_hash(&source_path_str, &scaled_adjustments).wrapping_add(1);

    let processed_preview = process_and_get_dynamic_image(
        &context,
        &state,
        &preview_base,
        unique_hash,
        all_adjustments,
        &mask_bitmaps,
        lut,
        "estimate_batch_export_size",
    )?;

    let preview_bytes = encode_image_to_bytes(
        &processed_preview,
        &output_format,
        export_settings.jpeg_quality,
    )?;
    let single_image_estimated_size = preview_bytes.len();

    let full_w = (shrunk_w as f32 / raw_scale_factor).round() as u32;
    let full_h = (shrunk_h as f32 / raw_scale_factor).round() as u32;

    let (final_full_w, final_full_h) = if let Some(resize_opts) = &export_settings.resize {
        calculate_resize_target(full_w, full_h, resize_opts)
    } else {
        (full_w, full_h)
    };

    let (processed_preview_w, processed_preview_h) = processed_preview.dimensions();

    let pixel_ratio = if processed_preview_w > 0 && processed_preview_h > 0 {
        (final_full_w as f64 * final_full_h as f64)
            / (processed_preview_w as f64 * processed_preview_h as f64)
    } else {
        1.0
    };

    let single_image_extrapolated_size =
        (single_image_estimated_size as f64 * pixel_ratio) as usize;

    Ok(single_image_extrapolated_size * paths.len())
}

#[tauri::command]
fn generate_mask_overlay(
    mask_def: MaskDefinition,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Result<String, String> {
    let scaled_crop_offset = (crop_offset.0 * scale, crop_offset.1 * scale);

    if let Some(gray_mask) =
        generate_mask_bitmap(&mask_def, width, height, scale, scaled_crop_offset)
    {
        let mut rgba_mask = RgbaImage::new(width, height);
        for (x, y, pixel) in gray_mask.enumerate_pixels() {
            let intensity = pixel[0];
            let alpha = (intensity as f32 * 0.5) as u8;
            rgba_mask.put_pixel(x, y, Rgba([255, 0, 0, alpha]));
        }

        let mut buf = Cursor::new(Vec::new());
        rgba_mask
            .write_to(&mut buf, ImageFormat::Png)
            .map_err(|e| e.to_string())?;

        let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
        let data_url = format!("data:image/png;base64,{}", base64_str);

        Ok(data_url)
    } else {
        Ok("".to_string())
    }
}

#[tauri::command]
async fn generate_ai_foreground_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiForegroundMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let (mut full_image, is_raw) = get_full_image_for_processing(&state)?;

    if is_raw {
        apply_cpu_default_raw_processing(&mut full_image);
    }

    let warped_image = apply_geometry_warp(&full_image, &js_adjustments);
    let full_mask_image =
        run_u2netp_model(&warped_image, &models.u2netp).map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiForegroundMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
async fn generate_ai_sky_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSkyMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let (mut full_image, is_raw) = get_full_image_for_processing(&state)?;

    if is_raw {
        apply_cpu_default_raw_processing(&mut full_image);
    }
    let warped_image = apply_geometry_warp(&full_image, &js_adjustments);
    let full_mask_image =
        run_sky_seg_model(&warped_image, &models.sky_seg).map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiSkyMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
async fn generate_ai_subject_mask(
    js_adjustments: serde_json::Value,
    path: String,
    start_point: (f64, f64),
    end_point: (f64, f64),
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSubjectMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let (mut full_image, is_raw) = get_full_image_for_processing(&state)?;

    if is_raw {
        apply_cpu_default_raw_processing(&mut full_image);
    }
    let warped_image = apply_geometry_warp(&full_image, &js_adjustments);

    let embeddings = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        let mut hasher = blake3::Hasher::new();
        hasher.update(path.as_bytes());
        let mut geo_hasher = DefaultHasher::new();
        for key in GEOMETRY_KEYS {
            if let Some(val) = js_adjustments.get(key) {
                key.hash(&mut geo_hasher);
                val.to_string().hash(&mut geo_hasher);
            }
        }
        hasher.update(&geo_hasher.finish().to_le_bytes());


        let path_hash = hasher.finalize().to_hex().to_string();

        if let Some(cached_embeddings) = &ai_state.embeddings {
            if cached_embeddings.path_hash == path_hash {
                cached_embeddings.clone()
            } else {
                let mut new_embeddings =
                    generate_image_embeddings(&warped_image, &models.sam_encoder)
                        .map_err(|e| e.to_string())?;
                new_embeddings.path_hash = path_hash;
                ai_state.embeddings = Some(new_embeddings.clone());
                new_embeddings
            }
        } else {
            let mut new_embeddings = generate_image_embeddings(&warped_image, &models.sam_encoder)
                .map_err(|e| e.to_string())?;
            new_embeddings.path_hash = path_hash;
            ai_state.embeddings = Some(new_embeddings.clone());
            new_embeddings
        }
    };

    let (img_w, img_h) = embeddings.original_size;

    let (coarse_rotated_w, coarse_rotated_h) = if orientation_steps % 2 == 1 {
        (img_h as f64, img_w as f64)
    } else {
        (img_w as f64, img_h as f64)
    };

    let center = (coarse_rotated_w / 2.0, coarse_rotated_h / 2.0);

    let p1 = start_point;
    let p2 = (start_point.0, end_point.1);
    let p3 = end_point;
    let p4 = (end_point.0, start_point.1);

    let angle_rad = (rotation as f64).to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let unrotate = |p: (f64, f64)| {
        let px = p.0 - center.0;
        let py = p.1 - center.1;
        let new_px = px * cos_a + py * sin_a + center.0;
        let new_py = -px * sin_a + py * cos_a + center.1;
        (new_px, new_py)
    };

    let up1 = unrotate(p1);
    let up2 = unrotate(p2);
    let up3 = unrotate(p3);
    let up4 = unrotate(p4);

    let unflip = |p: (f64, f64)| {
        let mut new_px = p.0;
        let mut new_py = p.1;
        if flip_horizontal {
            new_px = coarse_rotated_w - p.0;
        }
        if flip_vertical {
            new_py = coarse_rotated_h - p.1;
        }
        (new_px, new_py)
    };

    let ufp1 = unflip(up1);
    let ufp2 = unflip(up2);
    let ufp3 = unflip(up3);
    let ufp4 = unflip(up4);

    let un_coarse_rotate = |p: (f64, f64)| -> (f64, f64) {
        match orientation_steps {
            0 => p,
            1 => (p.1, img_h as f64 - p.0),
            2 => (img_w as f64 - p.0, img_h as f64 - p.1),
            3 => (img_w as f64 - p.1, p.0),
            _ => p,
        }
    };

    let ucrp1 = un_coarse_rotate(ufp1);
    let ucrp2 = un_coarse_rotate(ufp2);
    let ucrp3 = un_coarse_rotate(ufp3);
    let ucrp4 = un_coarse_rotate(ufp4);

    let min_x = ucrp1.0.min(ucrp2.0).min(ucrp3.0).min(ucrp4.0);
    let min_y = ucrp1.1.min(ucrp2.1).min(ucrp3.1).min(ucrp4.1);
    let max_x = ucrp1.0.max(ucrp2.0).max(ucrp3.0).max(ucrp4.0);
    let max_y = ucrp1.1.max(ucrp2.1).max(ucrp3.1).max(ucrp4.1);

    let unrotated_start_point = (min_x, min_y);
    let unrotated_end_point = (max_x, max_y);

    let mask_bitmap = run_sam_decoder(
        &models.sam_decoder,
        &embeddings,
        unrotated_start_point,
        unrotated_end_point,
    )
    .map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&mask_bitmap)?;

    Ok(AiSubjectMaskParameters {
        start_x: start_point.0,
        start_y: start_point.1,
        end_x: end_point.0,
        end_y: end_point.1,
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
fn generate_preset_preview(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<Response, String> {
    let context = get_or_init_gpu_context(&state)?;

    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded for preset preview")?;
    let original_image = loaded_image.image;
    let path = loaded_image.path;
    let is_raw = loaded_image.is_raw;
    let unique_hash = calculate_full_job_hash(&path, &js_adjustments);

    const PRESET_PREVIEW_DIM: u32 = 200;
    let preview_base = downscale_f32_image(&original_image, PRESET_PREVIEW_DIM, PRESET_PREVIEW_DIM);

    let (transformed_image, unscaled_crop_offset) =
        apply_all_transformations(&preview_base, &js_adjustments);
    let (img_w, img_h) = transformed_image.dimensions();

    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);

    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, img_w, img_h, 1.0, unscaled_crop_offset))
        .collect();

    let all_adjustments = get_all_adjustments_from_json(&js_adjustments, is_raw);
    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

    let processed_image = process_and_get_dynamic_image(
        &context,
        &state,
        &transformed_image,
        unique_hash,
        all_adjustments,
        &mask_bitmaps,
        lut,
        "generate_preset_preview",
    )?;

    let mut buf = Cursor::new(Vec::new());
    processed_image
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 50))
        .map_err(|e| e.to_string())?;

    Ok(Response::new(buf.into_inner()))
}

#[tauri::command]
fn update_window_effect(theme: String, window: tauri::Window) {
    apply_window_effect(theme, window);
}

#[tauri::command]
async fn check_ai_connector_status(app_handle: tauri::AppHandle) {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let is_connected = if let Some(address) = settings.ai_connector_address {
        ai_connector::check_status(&address).await.unwrap_or(false)
    } else {
        false
    };
    let _ = app_handle.emit(
        "ai-connector-status-update",
        serde_json::json!({ "connected": is_connected }),
    );
}

#[tauri::command]
async fn test_ai_connector_connection(address: String) -> Result<(), String> {
    match ai_connector::check_status(&address).await {
        Ok(true) => Ok(()),
        Ok(false) => Err("Server reachable but returned bad health status".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

fn calculate_dynamic_patch_radius(width: u32, height: u32) -> u32 {
    const MIN_RADIUS: u32 = 2;
    const MAX_RADIUS: u32 = 32;
    const BASE_DIMENSION: f32 = 192.0;

    let min_dim = width.min(height) as f32;
    let scaled_radius = (min_dim / BASE_DIMENSION).round() as u32;
    scaled_radius.clamp(MIN_RADIUS, MAX_RADIUS)
}

#[tauri::command]
async fn invoke_generative_replace_with_mask_def(
    path: String,
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    use_fast_inpaint: bool,
    token: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let mut source_image_adjustments = current_adjustments.clone();
    if let Some(patches) = source_image_adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        patches.retain(|p| p.get("id").and_then(|id| id.as_str()) != Some(&patch_definition.id));
    }

    let (base_image, _) = get_full_image_for_processing(&state)?;
    let source_image = composite_patches_on_image(&base_image, &source_image_adjustments)
        .map_err(|e| format!("Failed to prepare source image: {}", e))?;

    let (img_w, img_h) = source_image.dimensions();
    let mask_def_for_generation = MaskDefinition {
        id: patch_definition.id.clone(),
        name: patch_definition.name.clone(),
        visible: patch_definition.visible,
        invert: patch_definition.invert,
        opacity: 100.0,
        adjustments: serde_json::Value::Null,
        sub_masks: patch_definition.sub_masks,
    };

    let mask_bitmap = generate_mask_bitmap(&mask_def_for_generation, img_w, img_h, 1.0, (0.0, 0.0))
        .ok_or("Failed to generate mask bitmap for AI replace")?;

    let mask_dynamic = DynamicImage::ImageLuma8(mask_bitmap);
    let unwarped_dynamic = apply_unwarp_geometry(&mask_dynamic, &current_adjustments);
    let mask_bitmap = unwarped_dynamic.to_luma8();

    let patch_rgba = if use_fast_inpaint {
        // cpu based inpainting, low quality but no setup required
        let patch_radius = calculate_dynamic_patch_radius(img_w, img_h);
        inpainting::perform_fast_inpaint(&source_image, &mask_bitmap, patch_radius)?
    } else if let Some(address) = settings.ai_connector_address {
        // self hosted generative ai service
        let mut rgba_mask = RgbaImage::new(img_w, img_h);
        for (x, y, luma_pixel) in mask_bitmap.enumerate_pixels() {
            let intensity = luma_pixel[0];
            rgba_mask.put_pixel(x, y, Rgba([intensity, intensity, intensity, 255]));
        }
        let mask_image_dynamic = DynamicImage::ImageRgba8(rgba_mask);

        let (real_path_buf, _) = crate::file_management::parse_virtual_path(&path);
        let real_path_str = real_path_buf.to_string_lossy().to_string();

        ai_connector::process_inpainting(
            &address,
            &real_path_str,
            &source_image,
            &mask_image_dynamic,
            patch_definition.prompt
        ).await.map_err(|e| e.to_string())?
    } else if let Some(auth_token) = token {
        // convenience cloud service
        let client = reqwest::Client::new();
        let api_url = "https://api.letshopeitcompiles.com/inpaint"; // endpoint not yet built

        let mut source_buf = Cursor::new(Vec::new());
        source_image
            .write_to(&mut source_buf, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let source_base64 = general_purpose::STANDARD.encode(source_buf.get_ref());

        let mut mask_buf = Cursor::new(Vec::new());
        mask_bitmap
            .write_to(&mut mask_buf, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let mask_base64 = general_purpose::STANDARD.encode(mask_buf.get_ref());

        let request_body = serde_json::json!({
            "prompt": patch_definition.prompt,
            "image": source_base64,
            "mask": mask_base64,
        });

        let response = client
            .post(api_url)
            .header("Authorization", format!("Bearer {}", auth_token))
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("Failed to send request to cloud service: {}", e))?;

        if response.status().is_success() {
            let response_bytes = response.bytes().await.map_err(|e| e.to_string())?;
            image::load_from_memory(&response_bytes)
                .map_err(|e| format!("Failed to decode cloud service response: {}", e))?
                .to_rgba8()
        } else {
            let status = response.status();
            let error_body = response
                .text()
                .await
                .unwrap_or_else(|_| "Could not read error body".to_string());
            return Err(format!(
                "Cloud service returned an error ({}): {}",
                status, error_body
            ));
        }
    } else {
        return Err(
            "No generative backend available. Connect to a RapidRAW AI Connector or upgrade to Pro for Cloud AI."
                .to_string(),
        );
    };

    let (patch_w, patch_h) = patch_rgba.dimensions();
    let scaled_mask_bitmap = image::imageops::resize(
        &mask_bitmap,
        patch_w,
        patch_h,
        image::imageops::FilterType::Lanczos3,
    );
    let mut color_image = RgbImage::new(patch_w, patch_h);
    let mask_image = scaled_mask_bitmap.clone();

    for y in 0..patch_h {
        for x in 0..patch_w {
            let mask_value = scaled_mask_bitmap.get_pixel(x, y)[0];

            if mask_value > 0 {
                let patch_pixel = patch_rgba.get_pixel(x, y);
                color_image.put_pixel(x, y, Rgb([patch_pixel[0], patch_pixel[1], patch_pixel[2]]));
            } else {
                color_image.put_pixel(x, y, Rgb([0, 0, 0]));
            }
        }
    }

    let quality = 92;

    let mut color_buf = Cursor::new(Vec::new());
    color_image
        .write_with_encoder(JpegEncoder::new_with_quality(&mut color_buf, quality))
        .map_err(|e| e.to_string())?;
    let color_base64 = general_purpose::STANDARD.encode(color_buf.get_ref());

    let mut mask_buf = Cursor::new(Vec::new());
    mask_image
        .write_with_encoder(JpegEncoder::new_with_quality(&mut mask_buf, quality))
        .map_err(|e| e.to_string())?;
    let mask_base64 = general_purpose::STANDARD.encode(mask_buf.get_ref());

    let result_json = serde_json::json!({
        "color": color_base64,
        "mask": mask_base64
    })
    .to_string();

    Ok(result_json)
}

#[tauri::command]
fn get_supported_file_types() -> Result<serde_json::Value, String> {
    let raw_extensions: Vec<&str> = crate::formats::RAW_EXTENSIONS
        .iter()
        .map(|(ext, _)| *ext)
        .collect();
    let non_raw_extensions: Vec<&str> = crate::formats::NON_RAW_EXTENSIONS.to_vec();

    Ok(serde_json::json!({
        "raw": raw_extensions,
        "nonRaw": non_raw_extensions
    }))
}

#[tauri::command]
async fn fetch_community_presets() -> Result<Vec<CommunityPreset>, String> {
    let client = reqwest::Client::new();
    let url = "https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/manifest.json";

    let response = client
        .get(url)
        .header("User-Agent", "RapidRAW-App")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch manifest from GitHub: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub returned an error: {}", response.status()));
    }

    let presets: Vec<CommunityPreset> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse manifest.json: {}", e))?;

    Ok(presets)
}

#[tauri::command]
async fn generate_all_community_previews(
    image_paths: Vec<String>,
    presets: Vec<CommunityPreset>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let context = crate::image_processing::get_or_init_gpu_context(&state)?;
    let mut results: HashMap<String, Vec<u8>> = HashMap::new();

    const TILE_DIM: u32 = 360;
    const PROCESSING_DIM: u32 = TILE_DIM * 2;

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    let mut base_thumbnails: Vec<(DynamicImage, bool)> = Vec::new();
    for image_path in image_paths.iter() {
        let (source_path, _) = parse_virtual_path(image_path);
        let source_path_str = source_path.to_string_lossy().to_string();
        let image_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
        let original_image =
            crate::image_loader::load_base_image_from_bytes(&image_bytes, &source_path_str, true, highlight_compression, linear_mode.clone(), None)
                .map_err(|e| e.to_string())?;
        let is_raw = is_raw_file(&source_path_str);
        base_thumbnails.push((
            downscale_f32_image(&original_image, PROCESSING_DIM, PROCESSING_DIM),
            is_raw,
        ));
    }

    for preset in presets.iter() {
        let mut processed_tiles: Vec<RgbImage> = Vec::new();
        let js_adjustments = &preset.adjustments;

        let mut preset_hasher = DefaultHasher::new();
        preset.name.hash(&mut preset_hasher);
        let preset_hash = preset_hasher.finish();

        for (i, (base_image, is_raw)) in base_thumbnails.iter().enumerate() {
            let (transformed_image, unscaled_crop_offset) =
                crate::apply_all_transformations(&base_image, &js_adjustments);
            let (img_w, img_h) = transformed_image.dimensions();

            let mask_definitions: Vec<MaskDefinition> = js_adjustments
                .get("masks")
                .and_then(|m| serde_json::from_value(m.clone()).ok())
                .unwrap_or_else(Vec::new);

            let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
                .iter()
                .filter_map(|def| {
                    generate_mask_bitmap(def, img_w, img_h, 1.0, unscaled_crop_offset)
                })
                .collect();

            let all_adjustments = get_all_adjustments_from_json(&js_adjustments, *is_raw);
            let lut_path = js_adjustments["lutPath"].as_str();
            let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

            let unique_hash = preset_hash.wrapping_add(i as u64);

            let processed_image_dynamic = crate::image_processing::process_and_get_dynamic_image(
                &context,
                &state,
                &transformed_image,
                unique_hash,
                all_adjustments,
                &mask_bitmaps,
                lut,
                "generate_all_community_previews",
            )?;

            let processed_image = processed_image_dynamic.to_rgb8();

            let (proc_w, proc_h) = processed_image.dimensions();
            let size = proc_w.min(proc_h);
            let cropped_processed_image = image::imageops::crop_imm(
                &processed_image,
                (proc_w - size) / 2,
                (proc_h - size) / 2,
                size,
                size,
            )
            .to_image();

            let final_tile = image::imageops::resize(
                &cropped_processed_image,
                TILE_DIM,
                TILE_DIM,
                image::imageops::FilterType::Lanczos3,
            );
            processed_tiles.push(final_tile);
        }

        let final_image_buffer = match processed_tiles.len() {
            1 => processed_tiles.remove(0),
            2 => {
                let mut canvas = RgbImage::new(TILE_DIM * 2, TILE_DIM);
                image::imageops::overlay(&mut canvas, &processed_tiles[0], 0, 0);
                image::imageops::overlay(&mut canvas, &processed_tiles[1], TILE_DIM as i64, 0);
                canvas
            }
            4 => {
                let mut canvas = RgbImage::new(TILE_DIM * 2, TILE_DIM * 2);
                image::imageops::overlay(&mut canvas, &processed_tiles[0], 0, 0);
                image::imageops::overlay(&mut canvas, &processed_tiles[1], TILE_DIM as i64, 0);
                image::imageops::overlay(&mut canvas, &processed_tiles[2], 0, TILE_DIM as i64);
                image::imageops::overlay(
                    &mut canvas,
                    &processed_tiles[3],
                    TILE_DIM as i64,
                    TILE_DIM as i64,
                );
                canvas
            }
            _ => continue,
        };

        let mut buf = Cursor::new(Vec::new());
        if final_image_buffer
            .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 75))
            .is_ok()
        {
            results.insert(preset.name.clone(), buf.into_inner());
        }
    }

    Ok(results)
}

#[tauri::command]
async fn save_temp_file(bytes: Vec<u8>) -> Result<String, String> {
    let mut temp_file = NamedTempFile::new().map_err(|e| e.to_string())?;
    temp_file.write_all(&bytes).map_err(|e| e.to_string())?;
    let (_file, path) = temp_file.keep().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn stitch_panorama(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }

    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();

    let panorama_result_handle = state.panorama_result.clone();

    let task = tokio::task::spawn_blocking(move || {
        let panorama_result = panorama_stitching::stitch_images(source_paths, app_handle.clone());

        match panorama_result {
            Ok(panorama_image) => {
                let _ = app_handle.emit("panorama-progress", "Creating preview...");

                let (w, h) = panorama_image.dimensions();
                let (new_w, new_h) = if w > h {
                    (800, (800.0 * h as f32 / w as f32).round() as u32)
                } else {
                    ((800.0 * w as f32 / h as f32).round() as u32, 800)
                };

                let preview_f32 = crate::image_processing::downscale_f32_image(
                    &panorama_image,
                    new_w,
                    new_h
                );

                let preview_u8 = preview_f32.to_rgb8();

                let mut buf = Cursor::new(Vec::new());

                if let Err(e) = preview_u8.write_to(&mut buf, ImageFormat::Png) {
                    return Err(format!("Failed to encode panorama preview: {}", e));
                }

                let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
                let final_base64 = format!("data:image/png;base64,{}", base64_str);

                *panorama_result_handle.lock().unwrap() = Some(panorama_image);

                let _ = app_handle.emit(
                    "panorama-complete",
                    serde_json::json!({
                        "base64": final_base64,
                    }),
                );
                Ok(())
            }
            Err(e) => {
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
async fn save_panorama(
    first_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let panorama_image = state
        .panorama_result
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            "No panorama image found in memory to save. It might have already been saved."
                .to_string()
        })?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");

    let (output_filename, image_to_save): (String, DynamicImage) = if panorama_image.color().has_alpha() {
        (format!("{}_Pano.png", stem), DynamicImage::ImageRgba8(panorama_image.to_rgba8()))
    } else if panorama_image.as_rgb32f().is_some() {
        (format!("{}_Pano.tiff", stem), panorama_image)
    } else {
        (format!("{}_Pano.png", stem), DynamicImage::ImageRgb8(panorama_image.to_rgb8()))
    };

    let output_path = parent_dir.join(output_filename);

    image_to_save
        .save(&output_path)
        .map_err(|e| format!("Failed to save panorama image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn merge_hdr(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to merge.".to_string());
    }

    let hdr_result_handle = state.hdr_result.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    let loaded_items: Vec<(String, DynamicImage, Duration, f32)> = paths
        .iter()
        .map(|path| {
            let _ = app_handle.emit(
                "hdr-progress",
                format!(
                    "Processing '{}'",
                    Path::new(path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ),
            );

            let file_bytes =
                fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
            let dynamic_image = load_base_image_from_bytes(
                &file_bytes, 
                path, 
                false, 
                highlight_compression, 
                linear_mode.clone(),
                None
            )
            .map_err(|e| format!("Failed to load image {}: {}", path, e))?;

            let gains = match read_iso(&path, &file_bytes) {
                None => return Err(format!("Image {} is missing ISO/Sensitivity data", path)),
                Some(gains) => gains as f32,
            };

            let exposure = match read_exposure_time_secs(&path, &file_bytes) {
                None => return Err(format!("Image {} is missing ExposureTime data", path)),
                Some(exp) => Duration::from_secs_f32(exp),
            };

            Ok((path.clone(), dynamic_image, exposure, gains))
        })
        .collect::<Result<Vec<_>, String>>()?;

    if let Some((first_path, first_img, _, _)) = loaded_items.first() {
        let (width, height) = (first_img.width(), first_img.height());

        for (path, img, _, _) in loaded_items.iter().skip(1) {
            if img.width() != width || img.height() != height {
                return Err(format!(
                    "Dimension mismatch detected.\n\nBase image ({}): {}x{}\nTarget image ({}): {}x{}\n\nHDR merge requires all images to be exactly the same size.",
                    Path::new(first_path).file_name().unwrap_or_default().to_string_lossy(),
                    width, height,
                    Path::new(path).file_name().unwrap_or_default().to_string_lossy(),
                    img.width(), img.height()
                ));
            }
        }
    }

    let images: Vec<HDRInput> = loaded_items
        .iter()
        .map(|(path, img, exposure, gains)| {
            HDRInput::with_image(img, *exposure, *gains)
                .map_err(|e| format!("Failed to prepare HDR input for {}: {}", path, e))
        })
        .collect::<Result<Vec<HDRInput>, String>>()?;

    log::info!("Starting HDR merge of {} images", images.len());
    let hdr_merged = hdr_merge_images(&mut images.into()).map_err(|e| e.to_string())?;
    log::info!("HDR merge completed");

    let mut buf = Cursor::new(Vec::new());
    if let Err(e) = hdr_merged.to_rgb8().write_to(&mut buf, ImageFormat::Png) {
        return Err(format!("Failed to encode hdr preview: {}", e));
    }

    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    let final_base64 = format!("data:image/png;base64,{}", base64_str);

    let _ = app_handle.emit("hdr-progress", "Creating preview...");

    *hdr_result_handle.lock().unwrap() = Some(hdr_merged);

    let _ = app_handle.emit(
        "hdr-complete",
        serde_json::json!({
            "base64": final_base64,
        }),
    );
    Ok(())
}

#[tauri::command]
async fn save_hdr(
    first_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let hdr_image = state.hdr_result.lock().unwrap().take().ok_or_else(|| {
        "No hdr image found in memory to save. It might have already been saved.".to_string()
    })?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("hdr");

    let (output_filename, image_to_save): (String, DynamicImage) = if hdr_image.color().has_alpha()
    {
        (
            format!("{}_Hdr.png", stem),
            DynamicImage::ImageRgba8(hdr_image.to_rgba8()),
        )
    } else if hdr_image.as_rgb32f().is_some() {
        (format!("{}_Hdr.tiff", stem), hdr_image)
    } else {
        (
            format!("{}_Hdr.png", stem),
            DynamicImage::ImageRgb8(hdr_image.to_rgb8()),
        )
    };

    let output_path = parent_dir.join(output_filename);

    image_to_save
        .save(&output_path)
        .map_err(|e| format!("Failed to save hdr image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn apply_denoising(
    path: String,
    intensity: f32,
    use_cbm3d: bool,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (source_path, _) = parse_virtual_path(&path);
    let path_str = source_path.to_string_lossy().to_string();

    let denoise_result_handle = state.denoise_result.clone();

    tokio::task::spawn_blocking(move || {
        match denoising::denoise_image(path_str, intensity, use_cbm3d, app_handle.clone()) {
            Ok((image, _base64_ignored_in_this_handler_logic)) => {
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
async fn save_denoised_image(
    original_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let denoised_image = state
        .denoise_result
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            "No denoised image found in memory. It might have already been saved or cleared."
                .to_string()
        })?;

    let is_raw = crate::formats::is_raw_file(&original_path_str);

    let (first_path, _) = parse_virtual_path(&original_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("denoised");

    let (output_filename, image_to_save): (String, DynamicImage) = if is_raw {
        let filename = format!("{}_Denoised.tiff", stem);
        (filename, DynamicImage::ImageRgb16(denoised_image.to_rgb16()))
    } else {
        let filename = format!("{}_Denoised.png", stem);
        (filename, DynamicImage::ImageRgb8(denoised_image.to_rgb8()))
    };

    let output_path = parent_dir.join(output_filename);

    image_to_save
        .save(&output_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_collage(base64_data: String, first_path_str: String) -> Result<String, String> {
    let data_url_prefix = "data:image/png;base64,";
    if !base64_data.starts_with(data_url_prefix) {
        return Err("Invalid base64 data format".to_string());
    }
    let encoded_data = &base64_data[data_url_prefix.len()..];

    let decoded_bytes = general_purpose::STANDARD
        .decode(encoded_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("collage");

    let output_filename = format!("{}_Collage.png", stem);
    let output_path = parent_dir.join(output_filename);

    fs::write(&output_path, &decoded_bytes)
        .map_err(|e| format!("Failed to save collage image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn generate_preview_for_path(
    path: String,
    js_adjustments: Value,
    state: tauri::State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Response, String> {
    let context = get_or_init_gpu_context(&state)?;
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source_path_str);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    let base_image = match read_file_mapped(&source_path) {
        Ok(mmap) => load_and_composite(
            &mmap,
            &source_path_str,
            &js_adjustments,
            false,
            highlight_compression,
            linear_mode.clone(),
            None,
        )
        .map_err(|e| e.to_string())?,
        Err(e) => {
            log::warn!(
                "Failed to memory-map file '{}': {}. Falling back to standard read.",
                source_path_str,
                e
            );
            let bytes = fs::read(&source_path).map_err(|io_err| io_err.to_string())?;
            load_and_composite(
                &bytes,
                &source_path_str,
                &js_adjustments,
                false,
                highlight_compression,
                linear_mode.clone(),
                None,
            )
            .map_err(|e| e.to_string())?
        }
    };

    let (transformed_image, unscaled_crop_offset) =
        apply_all_transformations(&base_image, &js_adjustments);
    let (img_w, img_h) = transformed_image.dimensions();
    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_else(Vec::new);
    let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, img_w, img_h, 1.0, unscaled_crop_offset))
        .collect();
    let all_adjustments = get_all_adjustments_from_json(&js_adjustments, is_raw);
    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
    let unique_hash = calculate_full_job_hash(&source_path_str, &js_adjustments);
    let final_image = process_and_get_dynamic_image(
        &context,
        &state,
        &transformed_image,
        unique_hash,
        all_adjustments,
        &mask_bitmaps,
        lut,
        "generate_preview_for_path",
    )?;
    let (width, height) = final_image.dimensions();
    let rgb_pixels = final_image.to_rgb8().into_vec();

    let bytes = Encoder::new(Preset::BaselineFastest)
        .quality(92)
        .encode_rgb(&rgb_pixels, width as u32, height as u32)
        .map_err(|e| format!("Failed to encode with mozjpeg-rs: {}", e))?;

    Ok(Response::new(bytes))
}

#[tauri::command]
async fn load_and_parse_lut(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<LutParseResult, String> {
    let lut = lut_processing::parse_lut_file(&path).map_err(|e| e.to_string())?;
    let lut_size = lut.size;

    let mut cache = state.lut_cache.lock().unwrap();
    cache.insert(path, Arc::new(lut));

    Ok(LutParseResult { size: lut_size })
}

fn apply_window_effect(theme: String, window: impl raw_window_handle::HasWindowHandle) {
    #[cfg(target_os = "windows")]
    {
        let color = match theme.as_str() {
            "light" => Some((250, 250, 250, 150)),
            "muted-green" => Some((44, 56, 54, 100)),
            _ => Some((26, 29, 27, 60)),
        };

        let info = os_info::get();

        let is_win11_or_newer = match info.version() {
            os_info::Version::Semantic(major, _, build) => *major == 10 && *build >= 22000,
            _ => false,
        };

        if is_win11_or_newer {
            if let Err(e) = window_vibrancy::apply_acrylic(&window, color) {
                log::warn!("Failed to apply acrylic effect on Windows 11: {}", e);
            }
        } else {
            if let Err(e) = window_vibrancy::apply_blur(&window, color) {
                log::warn!("Failed to apply blur effect on Windows 10 or older: {}", e);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let material = match theme.as_str() {
            "light" => window_vibrancy::NSVisualEffectMaterial::ContentBackground,
            _ => window_vibrancy::NSVisualEffectMaterial::HudWindow,
        };
        if let Err(e) = window_vibrancy::apply_vibrancy(&window, material, None, None) {
            log::warn!("Failed to apply macOS vibrancy effect: {}", e);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = (theme, window);
    }
}

fn setup_logging(app_handle: &tauri::AppHandle) {
    let log_dir = match app_handle.path().app_log_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("Failed to get app log directory: {}", e);
            return;
        }
    };

    if let Err(e) = fs::create_dir_all(&log_dir) {
        eprintln!("Failed to create log directory at {:?}: {}", log_dir, e);
    }

    let log_file_path = log_dir.join("app.log");

    let log_file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&log_file_path)
        .ok();

    let var = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    let level: log::LevelFilter = var.parse().unwrap_or(log::LevelFilter::Info);

    let mut dispatch = fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} [{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                message
            ))
        })
        .level(level)
        .chain(std::io::stderr());

    if let Some(file) = log_file {
        dispatch = dispatch.chain(file);
    } else {
        eprintln!(
            "Failed to open log file at {:?}. Logging to console only.",
            log_file_path
        );
    }

    if let Err(e) = dispatch.apply() {
        eprintln!("Failed to apply logger configuration: {}", e);
    }

    panic::set_hook(Box::new(|info| {
        let message = if let Some(s) = info.payload().downcast_ref::<&'static str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            format!("{:?}", info.payload())
        };
        let location = info.location().map_or_else(
            || "at an unknown location".to_string(),
            |loc| format!("at {}:{}:{}", loc.file(), loc.line(), loc.column()),
        );
        log::error!("PANIC! {} - {}", location, message.trim());
    }));

    log::info!(
        "Logger initialized successfully. Log file at: {:?}",
        log_file_path
    );
}

#[tauri::command]
fn get_log_file_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let log_dir = app_handle.path().app_log_dir().map_err(|e| e.to_string())?;
    let log_file_path = log_dir.join("app.log");
    Ok(log_file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn frontend_log(level: String, message: String) -> Result<(), String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let log_line = |line: &str| match level.to_lowercase().as_str() {
        "error" => log::error!("[frontend] {}", line),
        "warn" => log::warn!("[frontend] {}", line),
        "debug" => log::debug!("[frontend] {}", line),
        "trace" => log::trace!("[frontend] {}", line),
        _ => log::info!("[frontend] {}", line),
    };

    for line in trimmed.lines().map(str::trim).filter(|line| !line.is_empty()) {
        log_line(line);
    }

    Ok(())
}

fn handle_file_open(app_handle: &tauri::AppHandle, path: PathBuf) {
    if let Some(path_str) = path.to_str() {
        if let Err(e) = app_handle.emit("open-with-file", path_str) {
            log::error!("Failed to emit open-with-file event: {}", e);
        }
    }
}

#[tauri::command]
fn frontend_ready(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<AppState>
) -> Result<(), String> {
    let is_first_run = !state.window_setup_complete.swap(true, std::sync::atomic::Ordering::Relaxed);
    let mut should_maximize = false;
    let mut should_fullscreen = false;

    if is_first_run {
        if let Ok(config_dir) = app_handle.path().app_config_dir() {
            let path = config_dir.join("window_state.json");

            if let Ok(contents) = std::fs::read_to_string(&path) {
                if let Ok(saved_state) = serde_json::from_str::<WindowState>(&contents) {
                    #[cfg(any(windows, target_os = "linux"))]
                    {
                        should_maximize = saved_state.maximized;
                        should_fullscreen = saved_state.fullscreen;
                    }

                    if should_maximize || should_fullscreen {
                        if let Some(monitor) = window.current_monitor().ok().flatten()
                            .or_else(|| window.primary_monitor().ok().flatten())
                            .or_else(|| window.available_monitors().ok().and_then(|m| m.into_iter().next()))
                        {
                            let monitor_size = monitor.size();
                            let monitor_pos = monitor.position();
                            let default_width = 1280i32;
                            let default_height = 720i32;
                            let center_x = monitor_pos.x + (monitor_size.width as i32 - default_width) / 2;
                            let center_y = monitor_pos.y + (monitor_size.height as i32 - default_height) / 2;

                            let _ = window.set_size(tauri::PhysicalSize::new(default_width as u32, default_height as u32));
                            let _ = window.set_position(tauri::PhysicalPosition::new(center_x, center_y));
                        }
                    }
                }
            }
        }
    }

    if let Err(e) = window.show() {
        log::error!("Failed to show window: {}", e);
    }
    if let Err(e) = window.set_focus() {
        log::error!("Failed to focus window: {}", e);
    }
    if is_first_run {
        if should_maximize {
            let _ = window.maximize();
        }
        if should_fullscreen {
            let _ = window.set_fullscreen(true);
        }
    }

    if let Some(path) = state.initial_file_path.lock().unwrap().take() {
        log::info!("Frontend is ready, emitting open-with-file for initial path: {}", &path);
        handle_file_open(&app_handle, PathBuf::from(path));
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!("New instance launched with args: {:?}. Focusing main window.", argv);
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.unminimize() {
                    log::error!("Failed to unminimize window: {}", e);
                }
                if let Err(e) = window.set_focus() {
                    log::error!("Failed to set focus on window: {}", e);
                }
            }

            if argv.len() > 1 {
                let path_str = &argv[1];
                if let Err(e) = app.emit("open-with-file", path_str) {
                    log::error!("Failed to emit open-with-file from single-instance handler: {}", e);
                }
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                if let Some(arg) = std::env::args().nth(1) {
                     let state = app.state::<AppState>();
                     log::info!("Windows/Linux initial open: Storing path {} for later.", &arg);
                     *state.initial_file_path.lock().unwrap() = Some(arg);
                }
            }

            let app_handle = app.handle().clone();
            let settings: AppSettings = load_settings(app_handle.clone()).unwrap_or_default();

            let lens_db = lens_correction::load_lensfun_db(&app_handle);
            let state = app.state::<AppState>();
            *state.lens_db.lock().unwrap() = Some(lens_db);

            unsafe {
                if let Some(backend) = &settings.processing_backend {
                    if backend != "auto" {
                        std::env::set_var("WGPU_BACKEND", backend);
                    }
                }

                if settings.linux_gpu_optimization.unwrap_or(true) {
                    #[cfg(target_os = "linux")]
                    {
                        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
                        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
                        std::env::set_var("NODEVICE_SELECT", "1");
                    }
                }

                let resource_path = app_handle
                    .path()
                    .resolve("resources", tauri::path::BaseDirectory::Resource)
                    .expect("failed to resolve resource directory");

                let ort_library_name = {
                    #[cfg(target_os = "windows")] { "onnxruntime.dll" }
                    #[cfg(target_os = "linux")] { "libonnxruntime.so" }
                    #[cfg(target_os = "macos")] { "libonnxruntime.dylib" }
                };
                let ort_library_path = resource_path.join(ort_library_name);
                std::env::set_var("ORT_DYLIB_PATH", &ort_library_path);
                println!("Set ORT_DYLIB_PATH to: {}", ort_library_path.display());
            }

            setup_logging(&app_handle);

            if let Some(backend) = &settings.processing_backend {
                if backend != "auto" {
                    log::info!("Applied processing backend setting: {}", backend);
                }
            }
            if settings.linux_gpu_optimization.unwrap_or(false) {
                #[cfg(target_os = "linux")]
                {
                    log::info!("Applied Linux GPU optimizations.");
                }
            }

            start_preview_worker(app_handle.clone());

            let window_cfg = app.config().app.windows.get(0).unwrap().clone();
            let transparent = settings.transparent.unwrap_or(window_cfg.transparent);
            let decorations = settings.decorations.unwrap_or(window_cfg.decorations);

            let main_window_cfg = app.config().app.windows.iter()
                .find(|w| w.label == "main")
                .expect("Main window config not found")
                .clone();

            let mut window_builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &main_window_cfg)
                .unwrap()
                .transparent(transparent)
                .decorations(decorations)
                .visible(false);

            if !transparent {
                window_builder = window_builder.background_color(tauri::window::Color(100, 100, 100, 255));
            } else {
                window_builder = window_builder.background_color(tauri::window::Color(0, 0, 0, 0));
            }

            let window = window_builder.build().expect("Failed to build window");

            if transparent {
                let theme = settings.theme.unwrap_or("dark".to_string());
                apply_window_effect(theme, &window);
            }

            if let Ok(config_dir) = app.path().app_config_dir() {
                let path = config_dir.join("window_state.json");
                if let Ok(contents) = std::fs::read_to_string(&path) {
                    if let Ok(state) = serde_json::from_str::<WindowState>(&contents) {
                        if state.width >= 200 && state.height >= 150 {
                            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(state.width, state.height)));
                            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(state.x, state.y)));
                        } else {
                            log::warn!("Saved window state had unreasonable dimensions ({}x{}), centering instead.", state.width, state.height);
                            let _ = window.center();
                        }
                    } else { let _ = window.center(); }
                } else { let _ = window.center(); }
            } else { let _ = window.center(); }

            let window_failsafe = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                if let Ok(false) = window_failsafe.is_visible() {
                    log::warn!("Frontend failed to report ready within timeout. Forcing window visibility.");
                    let _ = window_failsafe.show();
                    let _ = window_failsafe.set_focus();
                }
            });

            let pending_window_state = Arc::new(Mutex::new(None::<WindowState>));
            let pending_state_for_saver = pending_window_state.clone();
            let app_handle_for_saver = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;

                    let state_to_save = {
                        let mut lock = pending_state_for_saver.lock().unwrap();
                        lock.take()
                    };

                    if let Some(state) = state_to_save {
                        if let Ok(config_dir) = app_handle_for_saver.path().app_config_dir() {
                            let path = config_dir.join("window_state.json");
                            let _ = std::fs::create_dir_all(&config_dir);
                            if let Ok(json) = serde_json::to_string(&state) {
                                let _ = std::fs::write(&path, json); 
                            }
                        }
                    }
                }
            });

            let window_for_handler = window.clone();
            let pending_state_for_handler = pending_window_state.clone();

            window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {

                        #[cfg(any(windows, target_os = "linux"))]
                        let maximized = window_for_handler.is_maximized().unwrap_or(false);
                        #[cfg(not(any(windows, target_os = "linux")))]
                        let maximized = false;

                        #[cfg(any(windows, target_os = "linux"))]
                        let fullscreen = window_for_handler.is_fullscreen().unwrap_or(false);
                        #[cfg(not(any(windows, target_os = "linux")))]
                        let fullscreen = false;

                        if window_for_handler.is_minimized().unwrap_or(false) {
                            return;
                        }

                        let mut state = WindowState {
                            width: 1280,
                            height: 720,
                            x: 0,
                            y: 0,
                            maximized,
                            fullscreen,
                        };

                        if let Ok(position) = window_for_handler.outer_position() {
                            state.x = position.x;
                            state.y = position.y;
                        }

                        if !maximized && !fullscreen {
                            if let Ok(size) = window_for_handler.outer_size() {
                                if size.width >= 200 && size.height >= 150 {
                                    state.width = size.width;
                                    state.height = size.height;
                                }
                            }
                        }

                        *pending_state_for_handler.lock().unwrap() = Some(state);
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .manage(AppState {
            window_setup_complete: AtomicBool::new(false),
            original_image: Mutex::new(None),
            cached_preview: Mutex::new(None),
            gpu_context: Mutex::new(None),
            gpu_image_cache: Mutex::new(None),
            gpu_processor: Mutex::new(None),
            ai_state: Mutex::new(None),
            ai_init_lock: TokioMutex::new(()),
            export_task_handle: Mutex::new(None),
            hdr_result: Arc::new(Mutex::new(None)),
            panorama_result: Arc::new(Mutex::new(None)),
            denoise_result: Arc::new(Mutex::new(None)),
            negative_conversion_result: Arc::new(Mutex::new(None)),
            indexing_task_handle: Mutex::new(None),
            lut_cache: Mutex::new(HashMap::new()),
            initial_file_path: Mutex::new(None),
            thumbnail_cancellation_token: Arc::new(AtomicBool::new(false)),
            preview_worker_tx: Mutex::new(None),
            mask_cache: Mutex::new(HashMap::new()),
            patch_cache: Mutex::new(HashMap::new()),
            geometry_cache: Mutex::new(HashMap::new()),
            thumbnail_geometry_cache: Mutex::new(HashMap::new()),
            lens_db: Mutex::new(None),
            load_image_generation: Arc::new(AtomicUsize::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            load_image,
            apply_adjustments,
            export_image,
            batch_export_images,
            cancel_export,
            estimate_export_size,
            estimate_batch_export_size,
            generate_fullscreen_preview,
            generate_preview_for_path,
            generate_original_transformed_preview,
            generate_preset_preview,
            generate_uncropped_preview,
            preview_geometry_transform,
            generate_mask_overlay,
            generate_ai_subject_mask,
            generate_ai_foreground_mask,
            generate_ai_sky_mask,
            update_window_effect,
            check_ai_connector_status,
            test_ai_connector_connection,
            invoke_generative_replace_with_mask_def,
            get_supported_file_types,
            get_log_file_path,
            frontend_log,
            save_collage,
            stitch_panorama,
            save_panorama,
            merge_hdr,
            save_hdr,
            apply_denoising,
            save_denoised_image,
            load_and_parse_lut,
            fetch_community_presets,
            generate_all_community_previews,
            save_temp_file,
            get_image_dimensions,
            frontend_ready,
            cancel_thumbnail_generation,
            image_processing::generate_histogram,
            image_processing::generate_waveform,
            image_processing::calculate_auto_adjustments,
            file_management::read_exif_for_paths,
            file_management::list_images_in_dir,
            file_management::list_images_recursive,
            file_management::get_folder_tree,
            file_management::get_pinned_folder_trees,
            file_management::generate_thumbnails,
            file_management::generate_thumbnails_progressive,
            file_management::create_folder,
            file_management::delete_folder,
            file_management::copy_files,
            file_management::move_files,
            file_management::rename_folder,
            file_management::rename_files,
            file_management::duplicate_file,
            file_management::show_in_finder,
            file_management::delete_files_from_disk,
            file_management::delete_files_with_associated,
            file_management::save_metadata_and_update_thumbnail,
            file_management::apply_adjustments_to_paths,
            file_management::load_metadata,
            file_management::load_presets,
            file_management::save_presets,
            file_management::load_settings,
            file_management::save_settings,
            file_management::reset_adjustments_for_paths,
            file_management::apply_auto_adjustments_to_paths,
            file_management::handle_import_presets_from_file,
            file_management::handle_import_legacy_presets_from_file,
            file_management::handle_export_presets_to_file,
            file_management::save_community_preset,
            file_management::clear_all_sidecars,
            file_management::clear_thumbnail_cache,
            file_management::set_color_label_for_paths,
            file_management::import_files,
            file_management::create_virtual_copy,
            tagging::start_background_indexing,
            tagging::clear_ai_tags,
            tagging::clear_all_tags,
            tagging::add_tag_for_paths,
            tagging::remove_tag_for_paths,
            culling::cull_images,
            lens_correction::get_lensfun_makers,
            lens_correction::get_lensfun_lenses_for_maker,
            lens_correction::autodetect_lens,
            lens_correction::get_lens_distortion_params,
            negative_conversion::preview_negative_conversion,
            negative_conversion::convert_negative_full,
            negative_conversion::save_converted_negative,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(#[allow(unused_variables)] |app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    if let Some(url) = urls.first() {
                        if let Ok(path) = url.to_file_path() {
                            if let Some(path_str) = path.to_str() {
                                let state = app_handle.state::<AppState>();
                                *state.initial_file_path.lock().unwrap() = Some(path_str.to_string());
                                log::info!("macOS initial open: Stored path {} for later.", path_str);
                            }
                        }
                    }
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    std::process::exit(0);
                }
                _ => {}
            }
        });
}