#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mimalloc::MiMalloc;
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

mod ai_processing;
mod comfyui_connector;
mod culling;
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

use log;
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::panic;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use base64::{Engine as _, engine::general_purpose};
use chrono::{DateTime, Utc};
use image::codecs::jpeg::JpegEncoder;
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageBuffer, ImageFormat, Luma, Rgb, RgbImage, Rgba,
    RgbaImage,
};
use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use little_exif::metadata::Metadata;
use little_exif::rational::uR64;
use rayon::prelude::*;
use reqwest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::sync::Mutex;
use tauri::{Emitter, Manager, ipc::Response};
use tempfile::NamedTempFile;
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;
use wgpu::{Texture, TextureView};

use crate::ai_processing::{
    AiForegroundMaskParameters, AiSkyMaskParameters, AiState, AiSubjectMaskParameters,
    generate_image_embeddings, get_or_init_ai_models, run_sam_decoder, run_sky_seg_model,
    run_u2netp_model,
};
use crate::file_management::{AppSettings, get_sidecar_path, load_settings, read_file_mapped};
use crate::formats::is_raw_file;
use crate::image_loader::{
    composite_patches_on_image, load_and_composite, load_base_image_from_bytes,
};
use crate::image_processing::{
    Crop, GpuContext, ImageMetadata, apply_coarse_rotation, apply_crop, apply_flip, apply_rotation,
    get_all_adjustments_from_json, get_or_init_gpu_context, process_and_get_dynamic_image,
};
use crate::lut_processing::Lut;
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, generate_mask_bitmap};
use tagging_utils::{candidates, hierarchy};

#[derive(Clone)]
pub struct LoadedImage {
    path: String,
    image: DynamicImage,
}

#[derive(Clone)]
pub struct CachedPreview {
    image: DynamicImage,
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

pub struct AppState {
    original_image: Mutex<Option<LoadedImage>>,
    cached_preview: Mutex<Option<CachedPreview>>,
    gpu_context: Mutex<Option<GpuContext>>,
    gpu_image_cache: Mutex<Option<GpuImageCache>>,
    ai_state: Mutex<Option<AiState>>,
    ai_init_lock: TokioMutex<()>,
    export_task_handle: Mutex<Option<JoinHandle<()>>>,
    panorama_result: Arc<Mutex<Option<RgbImage>>>,
    indexing_task_handle: Mutex<Option<JoinHandle<()>>>,
    pub lut_cache: Mutex<HashMap<String, Arc<Lut>>>,
    thumbnail_cancellation_token: Arc<AtomicBool>,
}

#[derive(serde::Serialize)]
struct LoadImageResult {
    #[serde(with = "serde_bytes")]
    original_image_bytes: Vec<u8>,
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

fn apply_all_transformations(
    image: &DynamicImage,
    adjustments: &serde_json::Value,
) -> (DynamicImage, (f32, f32)) {
    let start_time = std::time::Instant::now();

    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    let rotation_degrees = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
    let flip_horizontal = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);

    let coarse_rotated_image = apply_coarse_rotation(image.clone(), orientation_steps);
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
        transformed_full_res.thumbnail(final_preview_dim, final_preview_dim)
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

fn read_exif_data(file_bytes: &[u8]) -> HashMap<String, String> {
    let mut exif_data = HashMap::new();
    let exif_reader = exif::Reader::new();
    if let Ok(exif) = exif_reader.read_from_container(&mut Cursor::new(file_bytes)) {
        for field in exif.fields() {
            exif_data.insert(
                field.tag.to_string(),
                field.display_value().with_unit(&exif).to_string(),
            );
        }
    }
    exif_data
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
    let sidecar_path = get_sidecar_path(&path);
    let metadata: ImageMetadata = if sidecar_path.exists() {
        let file_content = fs::read_to_string(sidecar_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&file_content).unwrap_or_default()
    } else {
        ImageMetadata::default()
    };

    let file_bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let pristine_img =
        load_base_image_from_bytes(&file_bytes, &path, false).map_err(|e| e.to_string())?;

    let (orig_width, orig_height) = pristine_img.dimensions();
    let is_raw = is_raw_file(&path);

    let exif_data = read_exif_data(&file_bytes);

    let settings = load_settings(app_handle).unwrap_or_default();
    let display_preview_dim = settings.editor_preview_resolution.unwrap_or(1920);
    let display_preview = pristine_img.thumbnail(display_preview_dim, display_preview_dim);

    let mut buf = Cursor::new(Vec::new());
    display_preview
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
        .map_err(|e| e.to_string())?;
    let original_image_bytes = buf.into_inner();

    *state.cached_preview.lock().unwrap() = None;
    *state.gpu_image_cache.lock().unwrap() = None;
    *state.original_image.lock().unwrap() = Some(LoadedImage {
        path: path.clone(),
        image: pristine_img,
    });

    Ok(LoadImageResult {
        original_image_bytes,
        width: orig_width,
        height: orig_height,
        metadata,
        exif: exif_data,
        is_raw,
    })
}

#[tauri::command]
fn cancel_thumbnail_generation(state: tauri::State<AppState>) -> Result<(), String> {
    state
        .thumbnail_cancellation_token
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn apply_adjustments(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let context = get_or_init_gpu_context(&state)?;
    let adjustments_clone = js_adjustments.clone();
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;
    let new_transform_hash = calculate_transform_hash(&adjustments_clone);

    let mut cached_preview_lock = state.cached_preview.lock().unwrap();

    let (final_preview_base, scale_for_gpu, unscaled_crop_offset) =
        if let Some(cached) = &*cached_preview_lock {
            if cached.transform_hash == new_transform_hash {
                (
                    cached.image.clone(),
                    cached.scale,
                    cached.unscaled_crop_offset,
                )
            } else {
                *state.gpu_image_cache.lock().unwrap() = None;
                let (base, scale, offset) =
                    generate_transformed_preview(&loaded_image, &adjustments_clone, &app_handle)?;
                *cached_preview_lock = Some(CachedPreview {
                    image: base.clone(),
                    transform_hash: new_transform_hash,
                    scale,
                    unscaled_crop_offset: offset,
                });
                (base, scale, offset)
            }
        } else {
            *state.gpu_image_cache.lock().unwrap() = None;
            let (base, scale, offset) =
                generate_transformed_preview(&loaded_image, &adjustments_clone, &app_handle)?;
            *cached_preview_lock = Some(CachedPreview {
                image: base.clone(),
                transform_hash: new_transform_hash,
                scale,
                unscaled_crop_offset: offset,
            });
            (base, scale, offset)
        };

    drop(cached_preview_lock);

    thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let (preview_width, preview_height) = final_preview_base.dimensions();

        let mask_definitions: Vec<MaskDefinition> = js_adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_else(Vec::new);

        let scaled_crop_offset = (
            unscaled_crop_offset.0 * scale_for_gpu,
            unscaled_crop_offset.1 * scale_for_gpu,
        );

        let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
            .iter()
            .filter_map(|def| {
                generate_mask_bitmap(
                    def,
                    preview_width,
                    preview_height,
                    scale_for_gpu,
                    scaled_crop_offset,
                )
            })
            .collect();

        let final_adjustments = get_all_adjustments_from_json(&adjustments_clone);
        let lut_path = adjustments_clone["lutPath"].as_str();
        let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

        if let Ok(final_processed_image) = process_and_get_dynamic_image(
            &context,
            &state,
            &final_preview_base,
            new_transform_hash,
            final_adjustments,
            &mask_bitmaps,
            lut,
            "apply_adjustments",
        ) {
            if let Ok(histogram_data) =
                image_processing::calculate_histogram_from_image(&final_processed_image)
            {
                let _ = app_handle.emit("histogram-update", histogram_data);
            }

            if let Ok(waveform_data) =
                image_processing::calculate_waveform_from_image(&final_processed_image)
            {
                let _ = app_handle.emit("waveform-update", waveform_data);
            }

            let mut buf = Cursor::new(Vec::new());
            if final_processed_image
                .to_rgb8()
                .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
                .is_ok()
            {
                let _ = app_handle.emit("preview-update-final", buf.get_ref());
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn generate_uncropped_preview(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let context = get_or_init_gpu_context(&state)?;
    let adjustments_clone = js_adjustments.clone();
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;

    thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let path = loaded_image.path.clone();
        let unique_hash = calculate_full_job_hash(&path, &adjustments_clone);
        let patched_image =
            match composite_patches_on_image(&loaded_image.image, &adjustments_clone) {
                Ok(img) => img,
                Err(e) => {
                    eprintln!("Failed to composite patches for uncropped preview: {}", e);
                    loaded_image.image
                }
            };

        let orientation_steps = adjustments_clone["orientationSteps"].as_u64().unwrap_or(0) as u8;
        let coarse_rotated_image = apply_coarse_rotation(patched_image, orientation_steps);

        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let preview_dim = settings.editor_preview_resolution.unwrap_or(1920);

        let (rotated_w, rotated_h) = coarse_rotated_image.dimensions();

        let (processing_base, scale_for_gpu) = if rotated_w > preview_dim || rotated_h > preview_dim
        {
            let base = coarse_rotated_image.thumbnail(preview_dim, preview_dim);
            let scale = if rotated_w > 0 {
                base.width() as f32 / rotated_w as f32
            } else {
                1.0
            };
            (base, scale)
        } else {
            (coarse_rotated_image.clone(), 1.0)
        };

        let (preview_width, preview_height) = processing_base.dimensions();

        let mask_definitions: Vec<MaskDefinition> = js_adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_else(Vec::new);

        let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
            .iter()
            .filter_map(|def| {
                generate_mask_bitmap(
                    def,
                    preview_width,
                    preview_height,
                    scale_for_gpu,
                    (0.0, 0.0),
                )
            })
            .collect();

        let uncropped_adjustments = get_all_adjustments_from_json(&adjustments_clone);
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
            let mut buf = Cursor::new(Vec::new());
            if processed_image
                .to_rgb8()
                .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
                .is_ok()
            {
                let _ = app_handle.emit("preview-update-uncropped", buf.get_ref());
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
) -> Result<Response, String> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;

    let (transformed_full_res, _unscaled_crop_offset) =
        apply_all_transformations(&loaded_image.image, &js_adjustments);

    let settings = load_settings(app_handle).unwrap_or_default();
    let preview_dim = settings.editor_preview_resolution.unwrap_or(1920);

    let (w, h) = transformed_full_res.dimensions();
    let transformed_image = if w > preview_dim || h > preview_dim {
        transformed_full_res.thumbnail(preview_dim, preview_dim)
    } else {
        transformed_full_res
    };

    let mut buf = Cursor::new(Vec::new());
    transformed_image
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
        .map_err(|e| e.to_string())?;

    Ok(Response::new(buf.into_inner()))
}

fn get_full_image_for_processing(state: &tauri::State<AppState>) -> Result<DynamicImage, String> {
    let original_image_lock = state.original_image.lock().unwrap();
    let loaded_image = original_image_lock
        .as_ref()
        .ok_or("No original image loaded")?;
    Ok(loaded_image.image.clone())
}

#[tauri::command]
fn generate_fullscreen_preview(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<Response, String> {
    let context = get_or_init_gpu_context(&state)?;
    let original_image = get_full_image_for_processing(&state)?;
    let path = state
        .original_image
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Original image path not found")?
        .path
        .clone();
    let unique_hash = calculate_full_job_hash(&path, &js_adjustments);
    let base_image = composite_patches_on_image(&original_image, &js_adjustments)
        .map_err(|e| format!("Failed to composite AI patches for fullscreen: {}", e))?;

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

    let all_adjustments = get_all_adjustments_from_json(&js_adjustments);
    let lut_path = js_adjustments["lutPath"].as_str();
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

    let mut buf = Cursor::new(Vec::new());
    final_image
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 92))
        .map_err(|e| e.to_string())?;

    Ok(Response::new(buf.into_inner()))
}

fn process_image_for_export(
    path: &str,
    base_image: &DynamicImage,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    context: &GpuContext,
    state: &tauri::State<AppState>,
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

    let mut all_adjustments = get_all_adjustments_from_json(&js_adjustments);
    all_adjustments.global.show_clipping = 0;

    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());

    let unique_hash = calculate_full_job_hash(path, js_adjustments);

    let mut final_image = process_and_get_dynamic_image(
        &context,
        &state,
        &transformed_image,
        unique_hash,
        all_adjustments,
        &mask_bitmaps,
        lut,
        "process_image_for_export",
    )?;

    if let Some(resize_opts) = &export_settings.resize {
        let (current_w, current_h) = final_image.dimensions();
        let should_resize = if resize_opts.dont_enlarge {
            match resize_opts.mode {
                ResizeMode::LongEdge => current_w.max(current_h) > resize_opts.value,
                ResizeMode::ShortEdge => current_w.min(current_h) > resize_opts.value,
                ResizeMode::Width => current_w > resize_opts.value,
                ResizeMode::Height => current_h > resize_opts.value,
            }
        } else {
            true
        };

        if should_resize {
            final_image = match resize_opts.mode {
                ResizeMode::LongEdge => {
                    let (w, h) = if current_w > current_h {
                        (
                            resize_opts.value,
                            (resize_opts.value as f32 * (current_h as f32 / current_w as f32))
                                .round() as u32,
                        )
                    } else {
                        (
                            (resize_opts.value as f32 * (current_w as f32 / current_h as f32))
                                .round() as u32,
                            resize_opts.value,
                        )
                    };
                    final_image.thumbnail(w, h)
                }
                ResizeMode::ShortEdge => {
                    let (w, h) = if current_w < current_h {
                        (
                            resize_opts.value,
                            (resize_opts.value as f32 * (current_h as f32 / current_w as f32))
                                .round() as u32,
                        )
                    } else {
                        (
                            (resize_opts.value as f32 * (current_w as f32 / current_h as f32))
                                .round() as u32,
                            resize_opts.value,
                        )
                    };
                    final_image.thumbnail(w, h)
                }
                ResizeMode::Width => final_image.thumbnail(resize_opts.value, u32::MAX),
                ResizeMode::Height => final_image.thumbnail(u32::MAX, resize_opts.value),
            };
        }
    }
    Ok(final_image)
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
            image
                .write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
        "tiff" => {
            image
                .write_to(&mut cursor, image::ImageFormat::Tiff)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unsupported file format: {}", output_format)),
    };
    Ok(image_bytes)
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
    let original_image_data = get_full_image_for_processing(&state)?;
    let context = Arc::new(context);

    let task = tokio::spawn(async move {
        let state = app_handle.state::<AppState>();
        let processing_result: Result<(), String> = (|| {
            let base_image = composite_patches_on_image(&original_image_data, &js_adjustments)
                .map_err(|e| format!("Failed to composite AI patches for export: {}", e))?;

            let final_image = process_image_for_export(
                &original_path,
                &base_image,
                &js_adjustments,
                &export_settings,
                &context,
                &state,
            )?;

            let output_path_obj = std::path::Path::new(&output_path);
            let extension = output_path_obj
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();

            let mut image_bytes =
                encode_image_to_bytes(&final_image, &extension, export_settings.jpeg_quality)?;

            write_image_with_metadata(
                &mut image_bytes,
                &original_path,
                &extension,
                export_settings.keep_metadata,
                export_settings.strip_gps,
            )?;

            fs::write(&output_path, image_bytes).map_err(|e| e.to_string())?;

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

    let task = tokio::spawn(async move {
        let state = app_handle.state::<AppState>();
        let output_folder_path = std::path::Path::new(&output_folder);
        let total_paths = paths.len();

        let results: Vec<Result<(), String>> = paths
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

                let _ = app_handle.emit(
                    "batch-export-progress",
                    serde_json::json!({
                        "current": global_index,
                        "total": total_paths,
                        "path": image_path_str
                    }),
                );

                let result: Result<(), String> = (|| {
                    let sidecar_path = get_sidecar_path(image_path_str);
                    let metadata: ImageMetadata = if sidecar_path.exists() {
                        let file_content = fs::read_to_string(sidecar_path)
                            .map_err(|e| format!("Failed to read sidecar: {}", e))?;
                        serde_json::from_str(&file_content).unwrap_or_default()
                    } else {
                        ImageMetadata::default()
                    };
                    let js_adjustments = metadata.adjustments;

                    let mmap = read_file_mapped(Path::new(image_path_str))
                        .map_err(|e| format!("Failed to mmap file {}: {}", image_path_str, e))?;

                    let base_image =
                        load_and_composite(&mmap[..], image_path_str, &js_adjustments, false)
                            .map_err(|e| format!("Failed to load image: {}", e))?;

                    let final_image = process_image_for_export(
                        image_path_str,
                        &base_image,
                        &js_adjustments,
                        &export_settings,
                        &context,
                        &state,
                    )?;

                    let original_path = std::path::Path::new(image_path_str);

                    let file_date: DateTime<Utc> = Metadata::new_from_path(original_path)
                        .ok()
                        .and_then(|metadata| {
                            metadata
                                .get_tag(&ExifTag::DateTimeOriginal("".to_string()))
                                .next()
                                .and_then(|tag| {
                                    if let &ExifTag::DateTimeOriginal(ref dt_str) = tag {
                                        chrono::NaiveDateTime::parse_from_str(
                                            dt_str,
                                            "%Y:%m:%d %H:%M:%S",
                                        )
                                        .ok()
                                        .map(|dt| DateTime::from_naive_utc_and_offset(dt, Utc))
                                    } else {
                                        None
                                    }
                                })
                        })
                        .unwrap_or_else(|| {
                            fs::metadata(original_path)
                                .ok()
                                .and_then(|m| m.created().ok())
                                .map(DateTime::<Utc>::from)
                                .unwrap_or_else(Utc::now)
                        });

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

                    let mut image_bytes = encode_image_to_bytes(
                        &final_image,
                        &output_format,
                        export_settings.jpeg_quality,
                    )?;

                    write_image_with_metadata(
                        &mut image_bytes,
                        image_path_str,
                        &output_format,
                        export_settings.keep_metadata,
                        export_settings.strip_gps,
                    )?;

                    fs::write(&output_path, image_bytes)
                        .map_err(|e| format!("Failed to write output: {}", e))?;

                    Ok(())
                })();

                result
            })
            .collect();

        let mut error_count = 0;
        for result in results {
            if let Err(e) = result {
                error_count += 1;
                eprintln!("Export error: {}", e);
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

    let new_transform_hash = calculate_transform_hash(&js_adjustments);
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
            let (base, scale, offset) =
                generate_transformed_preview(&loaded_image, &js_adjustments, &app_handle)?;
            (base, scale, offset)
        }
    } else {
        drop(cached_preview_lock);
        let (base, scale, offset) =
            generate_transformed_preview(&loaded_image, &js_adjustments, &app_handle)?;
        (base, scale, offset)
    };

    let (img_w, img_h) = preview_image.dimensions();
    let mask_definitions: Vec<MaskDefinition> = js_adjustments
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

    let all_adjustments = get_all_adjustments_from_json(&js_adjustments);
    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
    let unique_hash = calculate_full_job_hash(&loaded_image.path, &js_adjustments).wrapping_add(1);

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

    let (final_full_w, final_full_h) = loaded_image.image.dimensions();
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
) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let context = get_or_init_gpu_context(&state)?;
    let first_path = &paths[0];

    let sidecar_path = get_sidecar_path(first_path);
    let metadata: ImageMetadata = if sidecar_path.exists() {
        let file_content = fs::read_to_string(sidecar_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&file_content).unwrap_or_default()
    } else {
        ImageMetadata::default()
    };
    let js_adjustments = metadata.adjustments;

    const ESTIMATE_DIM: u32 = 1280;
    let img_bytes = read_file_mapped(Path::new(first_path)).map_err(|e| e.to_string())?;
    let original_image =
        load_base_image_from_bytes(&img_bytes, first_path, true).map_err(|e| e.to_string())?;
    let base_image_preview = original_image.thumbnail(ESTIMATE_DIM, ESTIMATE_DIM);

    let final_image_preview = process_image_for_export(
        first_path,
        &base_image_preview,
        &js_adjustments,
        &export_settings,
        &context,
        &state,
    )?;

    let preview_bytes = encode_image_to_bytes(
        &final_image_preview,
        &output_format,
        export_settings.jpeg_quality,
    )?;
    let single_image_estimated_size = preview_bytes.len();

    let (full_w, full_h) = original_image.dimensions();
    let (preview_w, preview_h) = final_image_preview.dimensions();

    let pixel_ratio = if preview_w > 0 && preview_h > 0 {
        (full_w as f64 * full_h as f64) / (preview_w as f64 * preview_h as f64)
    } else {
        1.0
    };

    let single_image_extrapolated_size =
        (single_image_estimated_size as f64 * pixel_ratio) as usize;

    Ok(single_image_extrapolated_size * paths.len())
}

fn write_image_with_metadata(
    image_bytes: &mut Vec<u8>,
    original_path_str: &str,
    output_format: &str,
    keep_metadata: bool,
    strip_gps: bool,
) -> Result<(), String> {
    if !keep_metadata || output_format.to_lowercase() == "tiff" {
        // FIXME: temporary solution until I find a way to write metadata to TIFF
        return Ok(());
    }

    let file_type = match output_format.to_lowercase().as_str() {
        "jpg" | "jpeg" => FileExtension::JPEG,
        "png" => FileExtension::PNG {
            as_zTXt_chunk: true,
        },
        "tiff" => FileExtension::TIFF,
        _ => return Ok(()),
    };

    let original_path = std::path::Path::new(original_path_str);
    if !original_path.exists() {
        eprintln!(
            "Original file not found, cannot copy metadata: {}",
            original_path_str
        );
        return Ok(());
    }

    if let Ok(mut metadata) = Metadata::new_from_path(original_path) {
        if strip_gps {
            let dummy_rational = uR64 {
                nominator: 0,
                denominator: 1,
            };
            let dummy_rational_vec1 = vec![dummy_rational.clone()];
            let dummy_rational_vec3 = vec![
                dummy_rational.clone(),
                dummy_rational.clone(),
                dummy_rational.clone(),
            ];

            metadata.remove_tag(ExifTag::GPSVersionID([0, 0, 0, 0].to_vec()));
            metadata.remove_tag(ExifTag::GPSLatitudeRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSLatitude(dummy_rational_vec3.clone()));
            metadata.remove_tag(ExifTag::GPSLongitudeRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSLongitude(dummy_rational_vec3.clone()));
            metadata.remove_tag(ExifTag::GPSAltitudeRef(vec![0]));
            metadata.remove_tag(ExifTag::GPSAltitude(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSTimeStamp(dummy_rational_vec3.clone()));
            metadata.remove_tag(ExifTag::GPSSatellites("".to_string()));
            metadata.remove_tag(ExifTag::GPSStatus("".to_string()));
            metadata.remove_tag(ExifTag::GPSMeasureMode("".to_string()));
            metadata.remove_tag(ExifTag::GPSDOP(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSSpeedRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSSpeed(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSTrackRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSTrack(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSImgDirectionRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSImgDirection(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSMapDatum("".to_string()));
            metadata.remove_tag(ExifTag::GPSDestLatitudeRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSDestLatitude(dummy_rational_vec3.clone()));
            metadata.remove_tag(ExifTag::GPSDestLongitudeRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSDestLongitude(dummy_rational_vec3.clone()));
            metadata.remove_tag(ExifTag::GPSDestBearingRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSDestBearing(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSDestDistanceRef("".to_string()));
            metadata.remove_tag(ExifTag::GPSDestDistance(dummy_rational_vec1.clone()));
            metadata.remove_tag(ExifTag::GPSProcessingMethod(vec![]));
            metadata.remove_tag(ExifTag::GPSAreaInformation(vec![]));
            metadata.remove_tag(ExifTag::GPSDateStamp("".to_string()));
            metadata.remove_tag(ExifTag::GPSDifferential(vec![0u16]));
            metadata.remove_tag(ExifTag::GPSHPositioningError(dummy_rational_vec1.clone()));
        }

        metadata.set_tag(ExifTag::Orientation(vec![1u16]));

        if metadata.write_to_vec(image_bytes, file_type).is_err() {
            eprintln!(
                "Failed to write metadata to image vector for {}",
                original_path_str
            );
        }
    } else {
        eprintln!(
            "Failed to read metadata from original file: {}",
            original_path_str
        );
    }

    Ok(())
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

    let full_image = get_full_image_for_processing(&state)?;
    let full_mask_image =
        run_u2netp_model(&full_image, &models.u2netp).map_err(|e| e.to_string())?;
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

    let full_image = get_full_image_for_processing(&state)?;
    let full_mask_image =
        run_sky_seg_model(&full_image, &models.sky_seg).map_err(|e| e.to_string())?;
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

    let embeddings = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        let mut hasher = blake3::Hasher::new();
        hasher.update(path.as_bytes());
        let path_hash = hasher.finalize().to_hex().to_string();

        if let Some(cached_embeddings) = &ai_state.embeddings {
            if cached_embeddings.path_hash == path_hash {
                cached_embeddings.clone()
            } else {
                let full_image = get_full_image_for_processing(&state)?;
                let mut new_embeddings =
                    generate_image_embeddings(&full_image, &models.sam_encoder)
                        .map_err(|e| e.to_string())?;
                new_embeddings.path_hash = path_hash;
                ai_state.embeddings = Some(new_embeddings.clone());
                new_embeddings
            }
        } else {
            let full_image = get_full_image_for_processing(&state)?;
            let mut new_embeddings = generate_image_embeddings(&full_image, &models.sam_encoder)
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
    let unique_hash = calculate_full_job_hash(&path, &js_adjustments);

    const PRESET_PREVIEW_DIM: u32 = 200;
    let preview_base = original_image.thumbnail(PRESET_PREVIEW_DIM, PRESET_PREVIEW_DIM);

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

    let all_adjustments = get_all_adjustments_from_json(&js_adjustments);
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
async fn check_comfyui_status(app_handle: tauri::AppHandle) {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let is_connected = if let Some(address) = settings.comfyui_address {
        comfyui_connector::ping_server(&address).await.is_ok()
    } else {
        false
    };
    let _ = app_handle.emit(
        "comfyui-status-update",
        serde_json::json!({ "connected": is_connected }),
    );
}

#[tauri::command]
async fn test_comfyui_connection(address: String) -> Result<(), String> {
    comfyui_connector::ping_server(&address)
        .await
        .map_err(|e| e.to_string())
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
    _path: String,
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    use_fast_inpaint: bool,
    token: Option<String>, // reserved parameter for future authentication, when the optional generative cloud service releases
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

    let base_image = get_full_image_for_processing(&state)?;
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

    let patch_rgba = if use_fast_inpaint {
        // cpu based inpainting, low quality but no setup required
        let patch_radius = calculate_dynamic_patch_radius(img_w, img_h);
        inpainting::perform_fast_inpaint(&source_image, &mask_bitmap, patch_radius)?
    } else if let Some(address) = settings.comfyui_address {
        // self hosted generative ai service
        let comfy_config = settings.comfyui_workflow_config;

        let mut rgba_mask = RgbaImage::new(img_w, img_h);
        for (x, y, luma_pixel) in mask_bitmap.enumerate_pixels() {
            let intensity = luma_pixel[0];
            rgba_mask.put_pixel(x, y, Rgba([0, 0, 0, intensity]));
        }
        let mask_image = DynamicImage::ImageRgba8(rgba_mask);

        let result_png_bytes = comfyui_connector::execute_workflow(
            &address,
            &comfy_config,
            source_image,
            Some(mask_image),
            Some(patch_definition.prompt),
        )
        .await
        .map_err(|e| e.to_string())?;

        image::load_from_memory(&result_png_bytes)
            .map_err(|e| e.to_string())?
            .to_rgba8()
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
            "No generative backend available. Connect to ComfyUI or upgrade to Pro for Cloud AI."
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
async fn stitch_panorama(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }

    let panorama_result_handle = state.panorama_result.clone();

    let task = tokio::task::spawn_blocking(move || {
        let panorama_result = panorama_stitching::stitch_images(paths, app_handle.clone());

        match panorama_result {
            Ok(panorama_image) => {
                let _ = app_handle.emit("panorama-progress", "Creating preview...");

                let (w, h) = panorama_image.dimensions();
                let (new_w, new_h) = if w > h {
                    (800, (800.0 * h as f32 / w as f32).round() as u32)
                } else {
                    ((800.0 * w as f32 / h as f32).round() as u32, 800)
                };
                let preview_image = image::imageops::resize(
                    &panorama_image,
                    new_w,
                    new_h,
                    image::imageops::FilterType::Triangle,
                );

                let mut buf = Cursor::new(Vec::new());

                if let Err(e) = preview_image.write_to(&mut buf, ImageFormat::Png) {
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
) -> Result<HashMap<String, Vec<u8>>, String> {
    let context = crate::image_processing::get_or_init_gpu_context(&state)?;
    let mut results: HashMap<String, Vec<u8>> = HashMap::new();

    const TILE_DIM: u32 = 360;
    const PROCESSING_DIM: u32 = TILE_DIM * 2;

    let mut base_thumbnails: Vec<DynamicImage> = Vec::new();
    for image_path in image_paths.iter() {
        let image_bytes = fs::read(image_path).map_err(|e| e.to_string())?;
        let original_image =
            crate::image_loader::load_base_image_from_bytes(&image_bytes, &image_path, true)
                .map_err(|e| e.to_string())?;
        base_thumbnails.push(original_image.thumbnail(PROCESSING_DIM, PROCESSING_DIM));
    }

    for preset in presets.iter() {
        let mut processed_tiles: Vec<RgbImage> = Vec::new();
        let js_adjustments = &preset.adjustments;

        let mut preset_hasher = DefaultHasher::new();
        preset.name.hash(&mut preset_hasher);
        let preset_hash = preset_hasher.finish();

        for (i, base_image) in base_thumbnails.iter().enumerate() {
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

            let all_adjustments = get_all_adjustments_from_json(&js_adjustments);
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

    let first_path = Path::new(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");

    let output_filename = format!("{}_Pano.png", stem);
    let output_path = parent_dir.join(output_filename);

    panorama_image
        .save(&output_path)
        .map_err(|e| format!("Failed to save panorama image: {}", e))?;

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

    let first_path = Path::new(&first_path_str);
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
) -> Result<Response, String> {
    let context = get_or_init_gpu_context(&state)?;
    let new_path = Path::new(&path);
    let image = read_file_mapped(&new_path).map_err(|e| e.to_string())?;
    let base_image =
        load_and_composite(&image[..], &path, &js_adjustments, false).map_err(|e| e.to_string())?;
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
    let all_adjustments = get_all_adjustments_from_json(&js_adjustments);
    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(&state, p).ok());
    let unique_hash = calculate_full_job_hash(&path, &js_adjustments);
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
    let mut buf = Cursor::new(Vec::new());
    final_image
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 92))
        .map_err(|e| e.to_string())?;

    Ok(Response::new(buf.into_inner()))
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
            window_vibrancy::apply_acrylic(&window, color)
                .expect("Failed to apply acrylic effect on Windows 11");
        } else {
            window_vibrancy::apply_blur(&window, color)
                .expect("Failed to apply blur effect on Windows 10 or older");
        }
    }

    #[cfg(target_os = "macos")]
    {
        let material = match theme.as_str() {
            "light" => window_vibrancy::NSVisualEffectMaterial::ContentBackground,
            _ => window_vibrancy::NSVisualEffectMaterial::HudWindow,
        };
        window_vibrancy::apply_vibrancy(&window, material, None, None)
            .expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");
    }

    #[cfg(target_os = "linux")]
    {}
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
        .append(true)
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

    panic::set_hook(Box::new(|error| {
        log::error!("PANIC! {:#?}", error);
    }));

    log::info!(
        "Logger initialized successfully. Log file at: {:?}",
        log_file_path
    );
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            setup_logging(&app_handle);

            let resource_path = app_handle
                .path()
                .resolve("resources", tauri::path::BaseDirectory::Resource)
                .expect("failed to resolve resource directory");

            let ort_library_name = {
                #[cfg(target_os = "windows")]
                {
                    "onnxruntime.dll"
                }
                #[cfg(target_os = "linux")]
                {
                    "libonnxruntime.so"
                }
                #[cfg(target_os = "macos")]
                {
                    "libonnxruntime.dylib"
                }
            };
            let ort_library_path = Mutex::new(resource_path.join(ort_library_name));
            {
                let path = ort_library_path.lock().unwrap();
                unsafe {
                    std::env::set_var("ORT_DYLIB_PATH", &*path);
                }
                println!("Set ORT_DYLIB_PATH to: {}", path.display());
            }

            let settings: AppSettings = load_settings(app_handle.clone()).unwrap_or_default();
            let window_cfg = app.config().app.windows.get(0).unwrap().clone();
            let transparent = settings.transparent.unwrap_or(window_cfg.transparent);
            let decorations = settings.decorations.unwrap_or(window_cfg.decorations);

            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_cfg)
                .unwrap()
                .transparent(transparent)
                .decorations(decorations)
                .build()
                .expect("Failed to build window");

            if transparent {
                let theme = settings.theme.unwrap_or("dark".to_string());
                apply_window_effect(theme, &window);
            }

            Ok(())
        })
        .manage(AppState {
            original_image: Mutex::new(None),
            cached_preview: Mutex::new(None),
            gpu_context: Mutex::new(None),
            gpu_image_cache: Mutex::new(None),
            ai_state: Mutex::new(None),
            ai_init_lock: TokioMutex::new(()),
            export_task_handle: Mutex::new(None),
            panorama_result: Arc::new(Mutex::new(None)),
            indexing_task_handle: Mutex::new(None),
            lut_cache: Mutex::new(HashMap::new()),
            thumbnail_cancellation_token: Arc::new(AtomicBool::new(false)),
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
            generate_mask_overlay,
            generate_ai_subject_mask,
            generate_ai_foreground_mask,
            generate_ai_sky_mask,
            update_window_effect,
            check_comfyui_status,
            test_comfyui_connection,
            invoke_generative_replace_with_mask_def,
            get_supported_file_types,
            save_collage,
            stitch_panorama,
            save_panorama,
            load_and_parse_lut,
            fetch_community_presets,
            generate_all_community_previews,
            save_temp_file,
            image_processing::generate_histogram,
            image_processing::generate_waveform,
            image_processing::calculate_auto_adjustments,
            file_management::read_exif_for_paths,
            file_management::list_images_in_dir,
            file_management::get_folder_tree,
            file_management::generate_thumbnails,
            file_management::generate_thumbnails_progressive,
            cancel_thumbnail_generation,
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
            tagging::start_background_indexing,
            tagging::clear_all_tags,
            culling::cull_images,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
