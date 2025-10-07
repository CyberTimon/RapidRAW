use memmap2::{Mmap, MmapOptions};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use chrono::{DateTime, Utc};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma};
use little_exif::exif_tag::ExifTag;
use little_exif::metadata::Metadata;
use num_cpus;
use rayon::ThreadPoolBuilder;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::AppState;
use crate::formats::is_supported_image_file;
use crate::gpu_processing;
use crate::image_loader;
use crate::image_processing::GpuContext;
use crate::image_processing::{
    Crop, ImageMetadata, apply_coarse_rotation, apply_crop, apply_flip, apply_rotation,
    auto_results_to_json, get_all_adjustments_from_json, perform_auto_analysis,
};
use crate::mask_generation::{MaskDefinition, generate_mask_bitmap};
use crate::preset_converter;
use crate::tagging::COLOR_TAG_PREFIX;

const THUMBNAIL_WIDTH: u32 = 640;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub adjustments: Value,
}

#[derive(Serialize)]
struct ExportPresetFile<'a> {
    creator: &'a str,
    presets: &'a [PresetItem],
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PresetFolder {
    pub id: String,
    pub name: String,
    pub children: Vec<Preset>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum PresetItem {
    Preset(Preset),
    Folder(PresetFolder),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PresetFile {
    pub presets: Vec<PresetItem>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SortCriteria {
    pub key: String,
    pub order: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterCriteria {
    pub rating: u8,
    pub raw_status: String,
    #[serde(default)]
    pub colors: Vec<String>,
}

impl Default for FilterCriteria {
    fn default() -> Self {
        Self {
            rating: 0,
            raw_status: "all".to_string(),
            colors: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum ReadFileError {
    Io(std::io::Error),
    Locked,
    Empty,
    NotFound,
    Invalid,
}

impl fmt::Display for ReadFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadFileError::Io(err) => write!(f, "IO error: {}", err),
            ReadFileError::Locked => write!(f, "File is locked"),
            ReadFileError::Empty => write!(f, "File is empty"),
            ReadFileError::NotFound => write!(f, "File not found"),
            ReadFileError::Invalid => write!(f, "Invalid file"),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LastFolderState {
    pub current_folder_path: String,
    pub expanded_folders: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUIWorkflowConfig {
    pub workflow_path: Option<String>,
    pub model_checkpoints: HashMap<String, String>,
    pub vae_loaders: HashMap<String, String>,
    pub controlnet_loaders: HashMap<String, String>,
    pub source_image_node_id: String,
    pub mask_image_node_id: String,
    pub text_prompt_node_id: String,
    pub final_output_node_id: String,
    pub sampler_node_id: String,
    pub sampler_steps: u32,
    pub transfer_resolution: Option<u32>,
    pub inpaint_resolution_node_id: String,
    pub inpaint_resolution: u32,
}

impl Default for ComfyUIWorkflowConfig {
    fn default() -> Self {
        let mut model_checkpoints = HashMap::new();
        model_checkpoints.insert(
            "1".to_string(),
            "XL_RealVisXL_V5.0_Lightning.safetensors".to_string(),
        );

        let mut vae_loaders = HashMap::new();
        vae_loaders.insert("49".to_string(), "sdxl_vae.safetensors".to_string());

        let mut controlnet_loaders = HashMap::new();
        controlnet_loaders.insert(
            "12".to_string(),
            "diffusion_pytorch_model_promax.safetensors".to_string(),
        );

        Self {
            workflow_path: None,
            model_checkpoints,
            vae_loaders,
            controlnet_loaders,
            source_image_node_id: "30".to_string(),
            mask_image_node_id: "47".to_string(),
            text_prompt_node_id: "7".to_string(),
            final_output_node_id: "41".to_string(),
            sampler_node_id: "28".to_string(),
            sampler_steps: 10,
            transfer_resolution: Some(3072),
            inpaint_resolution_node_id: "37".to_string(),
            inpaint_resolution: 1280,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub last_root_path: Option<String>,
    pub editor_preview_resolution: Option<u32>,
    pub sort_criteria: Option<SortCriteria>,
    pub filter_criteria: Option<FilterCriteria>,
    pub theme: Option<String>,
    pub transparent: Option<bool>,
    pub decorations: Option<bool>,
    pub comfyui_address: Option<String>,
    #[serde(default)]
    pub comfyui_workflow_config: ComfyUIWorkflowConfig,
    pub last_folder_state: Option<LastFolderState>,
    pub adaptive_editor_theme: Option<bool>,
    pub ui_visibility: Option<Value>,
    pub enable_ai_tagging: Option<bool>,
    pub tagging_thread_count: Option<u32>,
    pub thumbnail_size: Option<String>,
    pub thumbnail_aspect_ratio: Option<String>,
    pub ai_provider: Option<String>,
    #[serde(default = "default_adjustment_visibility")]
    pub adjustment_visibility: HashMap<String, bool>,
    pub enable_exif_reading: Option<bool>,
}

fn default_adjustment_visibility() -> HashMap<String, bool> {
    let mut map = HashMap::new();
    map.insert("sharpening".to_string(), true);
    map.insert("presence".to_string(), true);
    map.insert("noiseReduction".to_string(), true);
    map.insert("chromaticAberration".to_string(), false);
    map.insert("negativeConversion".to_string(), false);
    map.insert("vignette".to_string(), true);
    map.insert("colorCalibration".to_string(), false);
    map.insert("grain".to_string(), true);
    map
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            last_root_path: None,
            editor_preview_resolution: Some(1920),
            sort_criteria: None,
            filter_criteria: None,
            theme: Some("dark".to_string()),
            transparent: Some(true),
            #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
            decorations: Some(true),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            decorations: Some(false),
            comfyui_address: None,
            comfyui_workflow_config: ComfyUIWorkflowConfig::default(),
            last_folder_state: None,
            adaptive_editor_theme: Some(false),
            ui_visibility: None,
            enable_ai_tagging: Some(false),
            tagging_thread_count: Some(3),
            thumbnail_size: Some("medium".to_string()),
            thumbnail_aspect_ratio: Some("cover".to_string()),
            ai_provider: Some("cpu".to_string()),
            adjustment_visibility: default_adjustment_visibility(),
            enable_exif_reading: Some(false),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageFile {
    path: String,
    modified: u64,
    is_edited: bool,
    tags: Option<Vec<String>>,
    exif: Option<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettings {
    pub filename_template: String,
    pub organize_by_date: bool,
    pub date_folder_format: String,
    pub delete_after_import: bool,
}

#[tauri::command]
pub async fn read_exif_for_paths(
    paths: Vec<String>,
) -> Result<HashMap<String, HashMap<String, String>>, String> {
    let exif_data: HashMap<String, HashMap<String, String>> = paths
        .par_iter()
        .filter_map(|path_str| {
            let path = Path::new(path_str);
            let file = match fs::File::open(path) {
                Ok(f) => f,
                Err(_) => return None,
            };
            let mut buf_reader = BufReader::new(&file);
            let exif_reader = exif::Reader::new();

            if let Ok(exif) = exif_reader.read_from_container(&mut buf_reader) {
                let mut exif_map = HashMap::new();
                for field in exif.fields() {
                    exif_map.insert(
                        field.tag.to_string(),
                        field.display_value().with_unit(&exif).to_string(),
                    );
                }
                if exif_map.is_empty() {
                    None
                } else {
                    Some((path_str.clone(), exif_map))
                }
            } else {
                None
            }
        })
        .collect();
    Ok(exif_data)
}

#[tauri::command]
pub fn list_images_in_dir(path: String) -> Result<Vec<ImageFile>, String> {
    let entries: Vec<ImageFile> = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            !path
                .file_name()
                .and_then(|s| s.to_str())
                .map_or(false, |s| s.starts_with('.'))
        })
        .filter(|path| path.is_file())
        .filter(|path| path.to_str().map_or(false, is_supported_image_file))
        .map(|path| {
            let path_str = path.to_string_lossy().into_owned();
            let modified = fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let sidecar_path = get_sidecar_path(&path_str);
            let (is_edited, tags) = if sidecar_path.exists() {
                if let Ok(content) = fs::read_to_string(sidecar_path) {
                    if let Ok(metadata) = serde_json::from_str::<ImageMetadata>(&content) {
                        let edited = metadata.adjustments.as_object().map_or(false, |a| {
                            a.keys().len() > 1 || (a.keys().len() == 1 && !a.contains_key("rating"))
                        });
                        (edited, metadata.tags)
                    } else {
                        (false, None)
                    }
                } else {
                    (false, None)
                }
            } else {
                (false, None)
            };

            ImageFile {
                path: path_str,
                modified,
                is_edited,
                tags,
                exif: None,
            }
        })
        .collect();
    Ok(entries)
}

#[derive(Serialize, Debug)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub children: Vec<FolderNode>,
    pub is_dir: bool,
}

fn scan_dir_recursive(path: &Path) -> Result<Vec<FolderNode>, std::io::Error> {
    let mut children = Vec::new();

    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("Could not scan directory '{}': {}", path.display(), e);
            return Ok(Vec::new());
        }
    };

    for entry in entries.filter_map(std::result::Result::ok) {
        let current_path = entry.path();
        let is_hidden = current_path
            .file_name()
            .and_then(|s| s.to_str())
            .map_or(false, |s| s.starts_with('.'));

        if current_path.is_dir() && !is_hidden {
            let sub_children = scan_dir_recursive(&current_path)?;
            children.push(FolderNode {
                name: current_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: current_path.to_string_lossy().into_owned(),
                children: sub_children,
                is_dir: current_path.is_dir(),
            });
        }
    }

    children.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(children)
}

fn get_folder_tree_sync(path: String) -> Result<FolderNode, String> {
    let root_path = Path::new(&path);
    if !root_path.is_dir() {
        return Err(format!(
            "Could not scan directory '{}': No such file or directory (os error 2)",
            path
        ));
    }
    let name = root_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let children = scan_dir_recursive(root_path).map_err(|e| e.to_string())?;
    Ok(FolderNode {
        name,
        path: path.clone(),
        children,
        is_dir: root_path.is_dir(),
    })
}

#[tauri::command]
pub async fn get_folder_tree(path: String) -> Result<FolderNode, String> {
    match tauri::async_runtime::spawn_blocking(move || get_folder_tree_sync(path)).await {
        Ok(Ok(folder_node)) => Ok(folder_node),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Failed to execute folder tree task: {}", e)),
    }
}

pub fn get_sidecar_path(image_path: &str) -> PathBuf {
    let path = PathBuf::from(image_path);
    let original_filename = path.file_name().unwrap_or_default().to_string_lossy();
    let new_filename = format!("{}.rrdata", original_filename);
    path.with_file_name(new_filename)
}

pub fn read_file_mapped(path: &Path) -> Result<Mmap, ReadFileError> {
    if !path.is_file() {
        return Err(ReadFileError::Invalid);
    }
    if !path.exists() {
        return Err(ReadFileError::NotFound);
    }
    if path.metadata().map_err(ReadFileError::Io)?.len() == 0 {
        return Err(ReadFileError::Empty);
    }
    let file = fs::File::open(path).map_err(ReadFileError::Io)?;
    if file.try_lock_shared().is_err() {
        return Err(ReadFileError::Locked);
    }
    let mmap = unsafe {
        MmapOptions::new()
            .len(file.metadata().map_err(ReadFileError::Io)?.len() as usize)
            .map(&file)
            .map_err(ReadFileError::Io)?
    };
    Ok(mmap)
}

/*pub fn image_to_bytes(img: &DynamicImage) -> Vec<u8> {
    img.to_rgba8().into_raw()
}
*/

pub fn generate_thumbnail_data(
    path_str: &str,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<&DynamicImage>,
    app_handle: &AppHandle,
) -> anyhow::Result<DynamicImage> {
    let sidecar_path = get_sidecar_path(path_str);
    let metadata: Option<ImageMetadata> = fs::read_to_string(sidecar_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok());

    let adjustments = metadata
        .as_ref()
        .map_or(serde_json::Value::Null, |m| m.adjustments.clone());
    
    let composite_image = if let Some(img) = preloaded_image {
            
            image_loader::composite_patches_on_image(img, &adjustments)?
        } else {
            let mmap = read_file_mapped(Path::new(path_str)).
                map_err(|e| anyhow::anyhow!("Failed to map file {}: {:?}", path_str, e))?;
            let bytes = Path::new(path_str);
            let img = fs::read(bytes).map_err(|e| anyhow::anyhow!("Failed to read file {}: {:?}", path_str, e))?;
            image_loader::load_and_composite(&img, path_str, &adjustments, true)?
        };

    let composite_image = if let Some(img) = preloaded_image {
        image_loader::composite_patches_on_image(img, &adjustments)?
    } else {
        let mmap = read_file_mapped(Path::new(path_str))
            .map_err(|e| anyhow::anyhow!("Failed to map file {}: {:?}", path_str, e))?;

        image_loader::load_and_composite(&mmap, path_str, &adjustments, true)?
    };

    if let (Some(context), Some(meta)) = (gpu_context, metadata) {
        if !meta.adjustments.is_null() {
            let state = app_handle.state::<AppState>();
            const THUMBNAIL_PROCESSING_DIM: u32 = 1280;
            let orientation_steps =
                meta.adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
            let coarse_rotated_image = apply_coarse_rotation(composite_image, orientation_steps);
            let (full_w, full_h) = coarse_rotated_image.dimensions();

            let (processing_base, scale_for_gpu) =
                if full_w > THUMBNAIL_PROCESSING_DIM || full_h > THUMBNAIL_PROCESSING_DIM {
                    let base = coarse_rotated_image
                        .thumbnail(THUMBNAIL_PROCESSING_DIM, THUMBNAIL_PROCESSING_DIM);
                    let scale = if full_w > 0 {
                        base.width() as f32 / full_w as f32
                    } else {
                        1.0
                    };
                    (base, scale)
                } else {
                    (coarse_rotated_image.clone(), 1.0)
                };

            let rotation_degrees = meta.adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
            let flip_horizontal = meta.adjustments["flipHorizontal"]
                .as_bool()
                .unwrap_or(false);
            let flip_vertical = meta.adjustments["flipVertical"].as_bool().unwrap_or(false);

            let flipped_image = apply_flip(processing_base, flip_horizontal, flip_vertical);
            let rotated_image = apply_rotation(&flipped_image, rotation_degrees);

            let crop_data: Option<Crop> =
                serde_json::from_value(meta.adjustments["crop"].clone()).ok();
            let scaled_crop_json = if let Some(c) = &crop_data {
                serde_json::to_value(Crop {
                    x: c.x * scale_for_gpu as f64,
                    y: c.y * scale_for_gpu as f64,
                    width: c.width * scale_for_gpu as f64,
                    height: c.height * scale_for_gpu as f64,
                })
                .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            };

            let cropped_preview = apply_crop(rotated_image, &scaled_crop_json);
            let (preview_w, preview_h) = cropped_preview.dimensions();

            let unscaled_crop_offset = crop_data.map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));

            let mask_definitions: Vec<MaskDefinition> = meta
                .adjustments
                .get("masks")
                .and_then(|m| serde_json::from_value(m.clone()).ok())
                .unwrap_or_else(Vec::new);

            let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
                .iter()
                .filter_map(|def| {
                    generate_mask_bitmap(
                        def,
                        preview_w,
                        preview_h,
                        scale_for_gpu,
                        (
                            unscaled_crop_offset.0 * scale_for_gpu,
                            unscaled_crop_offset.1 * scale_for_gpu,
                        ),
                    )
                })
                .collect();

            let gpu_adjustments = get_all_adjustments_from_json(&meta.adjustments);
            let lut_path = meta.adjustments["lutPath"].as_str();
            let lut = lut_path.and_then(|p| {
                let mut cache = state.lut_cache.lock().unwrap();
                if let Some(cached_lut) = cache.get(p) {
                    return Some(cached_lut.clone());
                }
                if let Ok(loaded_lut) = crate::lut_processing::parse_lut_file(p) {
                    let arc_lut = Arc::new(loaded_lut);
                    cache.insert(p.to_string(), arc_lut.clone());
                    return Some(arc_lut);
                }
                None
            });

            let mut hasher = DefaultHasher::new();
            path_str.hash(&mut hasher);
            meta.adjustments.to_string().hash(&mut hasher);
            let unique_hash = hasher.finish();

            if let Ok(processed_image) = gpu_processing::process_and_get_dynamic_image(
                context,
                &state,
                &cropped_preview,
                unique_hash,
                gpu_adjustments,
                &mask_bitmaps,
                lut,
                "generate_thumbnail_data",
            ) {
                return Ok(processed_image);
            } else {
                return Ok(cropped_preview);
            }
        }
    }

    let fallback_orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    Ok(apply_coarse_rotation(
        composite_image,
        fallback_orientation_steps,
    ))
}

fn encode_thumbnail(image: &DynamicImage) -> Result<Vec<u8>> {
    let thumbnail = image.thumbnail(THUMBNAIL_WIDTH, THUMBNAIL_WIDTH);
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 75);
    encoder.encode_image(&thumbnail.to_rgba8())?;
    Ok(buf.into_inner())
}

fn generate_single_thumbnail_and_cache(
    path_str: &str,
    thumb_cache_dir: &Path,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<&DynamicImage>,
    force_regenerate: bool,
    app_handle: &AppHandle,
) -> Option<(String, u8)> {
    let original_path = Path::new(path_str);
    let sidecar_path = get_sidecar_path(path_str);

    let img_mod_time = fs::metadata(original_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let (sidecar_mod_time, rating) = if let Ok(content) = fs::read_to_string(&sidecar_path) {
        let mod_time = fs::metadata(&sidecar_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let rating_val = serde_json::from_str::<ImageMetadata>(&content)
            .ok()
            .map(|m| m.rating)
            .unwrap_or(0);
        (mod_time, rating_val)
    } else {
        (0, 0)
    };

    let mut hasher = blake3::Hasher::new();
    hasher.update(path_str.as_bytes());
    hasher.update(&img_mod_time.to_le_bytes());
    hasher.update(&sidecar_mod_time.to_le_bytes());
    let hash = hasher.finalize();
    let cache_filename = format!("{}.jpg", hash.to_hex());
    let cache_path = thumb_cache_dir.join(cache_filename);

    if !force_regenerate && cache_path.exists() {
        if let Ok(data) = fs::read(&cache_path) {
            let base64_str = general_purpose::STANDARD.encode(&data);
            return Some((format!("data:image/jpeg;base64,{}", base64_str), rating));
        }
    }

    if let Ok(thumb_image) =
        generate_thumbnail_data(path_str, gpu_context, preloaded_image, app_handle)
    {
        if let Ok(thumb_data) = encode_thumbnail(&thumb_image) {
            let _ = fs::write(&cache_path, &thumb_data);
            let base64_str = general_purpose::STANDARD.encode(&thumb_data);
            return Some((format!("data:image/jpeg;base64,{}", base64_str), rating));
        }
    }
    None
}

#[tauri::command]
pub async fn generate_thumbnails(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<HashMap<String, String>, String> {
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = app_handle_clone
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?;
        let thumb_cache_dir = cache_dir.join("thumbnails");
        if !thumb_cache_dir.exists() {
            fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
        }

        let state = app_handle_clone.state::<AppState>();
        let gpu_context = gpu_processing::get_or_init_gpu_context(&state).ok();

        let thumbnails: HashMap<String, String> = paths
            .par_iter()
            .filter_map(|path_str| {
                generate_single_thumbnail_and_cache(
                    path_str,
                    &thumb_cache_dir,
                    gpu_context.as_ref(),
                    None,
                    false,
                    &app_handle_clone,
                )
                .map(|(data, _rating)| (path_str.clone(), data))
            })
            .collect();

        Ok(thumbnails)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn generate_thumbnails_progressive(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    state
        .thumbnail_cancellation_token
        .store(false, Ordering::SeqCst);
    let cancellation_token = state.thumbnail_cancellation_token.clone();

    let pool = ThreadPoolBuilder::new()
        .num_threads(num_cpus::get_physical() - 1)
        .build()
        .unwrap();
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");
    if !thumb_cache_dir.exists() {
        fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
    }

    let app_handle_clone = app_handle.clone();
    let total_count = paths.len();
    let completed_count = Arc::new(AtomicUsize::new(0));

    pool.spawn(move || {
        let state = app_handle_clone.state::<AppState>();
        let gpu_context = gpu_processing::get_or_init_gpu_context(&state).ok();

        let _ = paths.par_iter().try_for_each(|path_str| -> Result<(), ()> {
            if cancellation_token.load(Ordering::Relaxed) {
                return Err(());
            }

            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                false,
                &app_handle_clone,
            );

            if let Some((thumbnail_data, rating)) = result {
                if cancellation_token.load(Ordering::Relaxed) {
                    return Err(());
                }
                let _ = app_handle_clone.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "rating": rating }),
                );
            }

            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            if cancellation_token.load(Ordering::Relaxed) {
                return Err(());
            }
            let _ = app_handle_clone.emit(
                "thumbnail-progress",
                serde_json::json!({ "completed": completed, "total": total_count }),
            );
            Ok(())
        });

        if !cancellation_token.load(Ordering::Relaxed) {
            let _ = app_handle_clone.emit("thumbnail-generation-complete", true);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    let path_obj = Path::new(&path);
    if let (Some(parent), Some(new_folder_name_os)) = (path_obj.parent(), path_obj.file_name()) {
        if let Some(new_folder_name) = new_folder_name_os.to_str() {
            if parent.exists() {
                for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
                    if let Ok(entry) = entry {
                        if entry.file_name().to_string_lossy().to_lowercase()
                            == new_folder_name.to_lowercase()
                        {
                            return Err("A folder with that name already exists.".to_string());
                        }
                    }
                }
            }
        }
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_folder(path: String, new_name: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    if let Some(parent) = p.parent() {
        for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry {
                if entry.file_name().to_string_lossy().to_lowercase() == new_name.to_lowercase() {
                    if entry.path() != p {
                        return Err("A folder with that name already exists.".to_string());
                    }
                }
            }
        }
        let new_path = parent.join(&new_name);
        fs::rename(p, new_path).map_err(|e| e.to_string())
    } else {
        Err("Could not determine parent directory.".to_string())
    }
}

#[tauri::command]
pub fn delete_folder(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn duplicate_file(path: String) -> Result<(), String> {
    let source_path = Path::new(&path);
    if !source_path.is_file() {
        return Err("Source path is not a file.".to_string());
    }

    let parent = source_path
        .parent()
        .ok_or("Could not get parent directory")?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Could not get file stem")?;
    let extension = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let mut counter = 1;
    let mut dest_path;
    loop {
        let new_stem = if counter == 1 {
            format!("{}_copy", stem)
        } else {
            format!("{}_copy_{}", stem, counter - 1)
        };
        dest_path = parent.join(format!("{}.{}", new_stem, extension));
        if !dest_path.exists() {
            break;
        }
        counter += 1;
    }

    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;

    let sidecar_path = get_sidecar_path(&path);
    if sidecar_path.exists() {
        if let Some(dest_str) = dest_path.to_str() {
            let dest_sidecar_path = get_sidecar_path(dest_str);
            fs::copy(&sidecar_path, &dest_sidecar_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn copy_files(source_paths: Vec<String>, destination_folder: String) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            destination_folder
        ));
    }

    for source_str in source_paths {
        let source_path = Path::new(&source_str);

        let canon_dest = fs::canonicalize(dest_path).map_err(|e| e.to_string())?;
        let canon_source_parent = source_path.parent().and_then(|p| fs::canonicalize(p).ok());

        if Some(canon_dest) == canon_source_parent {
            duplicate_file(source_str.clone())?;
        } else {
            if let Some(file_name) = source_path.file_name() {
                let dest_file_path = dest_path.join(file_name);

                fs::copy(&source_path, &dest_file_path).map_err(|e| e.to_string())?;

                let sidecar_path = get_sidecar_path(&source_str);
                if sidecar_path.exists() {
                    if let Some(dest_str) = dest_file_path.to_str() {
                        let dest_sidecar_path = get_sidecar_path(dest_str);
                        fs::copy(&sidecar_path, &dest_sidecar_path).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn move_files(source_paths: Vec<String>, destination_folder: String) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            destination_folder
        ));
    }

    let mut files_to_delete = Vec::new();
    let mut sidecars_to_delete = Vec::new();

    for source_str in &source_paths {
        let source_path = Path::new(source_str);
        if let Some(file_name) = source_path.file_name() {
            let dest_file_path = dest_path.join(file_name);

            if dest_file_path.exists() {
                return Err(format!(
                    "File already exists at destination: {}",
                    dest_file_path.display()
                ));
            }

            fs::copy(&source_path, &dest_file_path).map_err(|e| e.to_string())?;
            files_to_delete.push(source_path.to_path_buf());

            let sidecar_path = get_sidecar_path(source_str);
            if sidecar_path.exists() {
                if let Some(dest_str) = dest_file_path.to_str() {
                    let dest_sidecar_path = get_sidecar_path(dest_str);
                    fs::copy(&sidecar_path, &dest_sidecar_path).map_err(|e| e.to_string())?;
                    sidecars_to_delete.push(sidecar_path);
                }
            }
        }
    }

    trash::delete_all(&files_to_delete).map_err(|e| e.to_string())?;
    trash::delete_all(&sidecars_to_delete).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn save_metadata_and_update_thumbnail(
    path: String,
    adjustments: Value,
    app_handle: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let sidecar_path = get_sidecar_path(&path);

    let mut metadata: ImageMetadata = if sidecar_path.exists() {
        fs::read_to_string(&sidecar_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    } else {
        ImageMetadata::default()
    };

    metadata.rating = adjustments["rating"].as_u64().unwrap_or(0) as u8;
    metadata.adjustments = adjustments;

    let json_string = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    std::fs::write(sidecar_path, json_string).map_err(|e| e.to_string())?;

    let loaded_image_lock = state.original_image.lock().unwrap();
    let preloaded_image_option = if let Some(loaded_image) = loaded_image_lock.as_ref() {
        if loaded_image.path == path {
            Some(loaded_image.image.clone())
        } else {
            None
        }
    } else {
        None
    };
    drop(loaded_image_lock);

    let gpu_context = gpu_processing::get_or_init_gpu_context(&state).ok();
    let app_handle_clone = app_handle.clone();
    let path_clone = path.clone();

    thread::spawn(move || {
        let _ = app_handle_clone.emit(
            "thumbnail-progress",
            serde_json::json!({ "completed": 0, "total": 1 }),
        );

        let cache_dir = app_handle_clone.path().app_cache_dir().unwrap();
        let thumb_cache_dir = cache_dir.join("thumbnails");
        if !thumb_cache_dir.exists() {
            fs::create_dir_all(&thumb_cache_dir).unwrap();
        }

        let result = generate_single_thumbnail_and_cache(
            &path_clone,
            &thumb_cache_dir,
            gpu_context.as_ref(),
            preloaded_image_option.as_ref(),
            true,
            &app_handle_clone,
        );

        if let Some((thumbnail_data, rating)) = result {
            let _ = app_handle_clone.emit(
                "thumbnail-generated",
                serde_json::json!({ "path": path_clone, "data": thumbnail_data, "rating": rating }),
            );
        }

        let _ = app_handle_clone.emit(
            "thumbnail-progress",
            serde_json::json!({ "completed": 1, "total": 1 }),
        );
        let _ = app_handle_clone.emit("thumbnail-generation-complete", true);
    });

    Ok(())
}

#[tauri::command]
pub fn apply_adjustments_to_paths(
    paths: Vec<String>,
    adjustments: Value,
    app_handle: AppHandle,
) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let sidecar_path = get_sidecar_path(path);

        let mut existing_metadata: ImageMetadata = if sidecar_path.exists() {
            fs::read_to_string(&sidecar_path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default()
        } else {
            ImageMetadata::default()
        };

        let mut new_adjustments = existing_metadata.adjustments;
        if new_adjustments.is_null() {
            new_adjustments = serde_json::json!({});
        }

        if let (Some(new_map), Some(pasted_map)) =
            (new_adjustments.as_object_mut(), adjustments.as_object())
        {
            for (k, v) in pasted_map {
                new_map.insert(k.clone(), v.clone());
            }
        }

        existing_metadata.rating = new_adjustments["rating"].as_u64().unwrap_or(0) as u8;
        existing_metadata.adjustments = new_adjustments;

        if let Ok(json_string) = serde_json::to_string_pretty(&existing_metadata) {
            let _ = std::fs::write(sidecar_path, json_string);
        }
    });

    thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let cache_dir = app_handle.path().app_cache_dir().unwrap();
        let thumb_cache_dir = cache_dir.join("thumbnails");
        if !thumb_cache_dir.exists() {
            fs::create_dir_all(&thumb_cache_dir).unwrap();
        }

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state).ok();
        let total_count = paths.len();
        let completed_count = Arc::new(AtomicUsize::new(0));

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
            );

            if let Some((thumbnail_data, rating)) = result {
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "rating": rating }),
                );
            }

            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_handle.emit(
                "thumbnail-progress",
                serde_json::json!({ "completed": completed, "total": total_count }),
            );
        });

        let _ = app_handle.emit("thumbnail-generation-complete", true);
    });

    Ok(())
}

#[tauri::command]
pub fn reset_adjustments_for_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let sidecar_path = get_sidecar_path(path);

        let mut existing_metadata: ImageMetadata = if sidecar_path.exists() {
            fs::read_to_string(&sidecar_path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default()
        } else {
            ImageMetadata::default()
        };

        let new_adjustments = serde_json::json!({
            "rating": existing_metadata.rating
        });

        existing_metadata.adjustments = new_adjustments;

        if let Ok(json_string) = serde_json::to_string_pretty(&existing_metadata) {
            let _ = std::fs::write(sidecar_path, json_string);
        }
    });

    thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let cache_dir = app_handle.path().app_cache_dir().unwrap();
        let thumb_cache_dir = cache_dir.join("thumbnails");
        if !thumb_cache_dir.exists() {
            fs::create_dir_all(&thumb_cache_dir).unwrap();
        }

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state).ok();
        let total_count = paths.len();
        let completed_count = Arc::new(AtomicUsize::new(0));

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
            );

            if let Some((thumbnail_data, rating)) = result {
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "rating": rating }),
                );
            }

            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_handle.emit(
                "thumbnail-progress",
                serde_json::json!({ "completed": completed, "total": total_count }),
            );
        });

        let _ = app_handle.emit("thumbnail-generation-complete", true);
    });

    Ok(())
}

#[tauri::command]
pub fn apply_auto_adjustments_to_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let result: Result<(), String> = (|| {
            let file_bytes = fs::read(path).map_err(|e| e.to_string())?;
            let image = image_loader::load_base_image_from_bytes(&file_bytes, path, false)
                .map_err(|e| e.to_string())?;

            let auto_results = perform_auto_analysis(&image);
            let auto_adjustments_json = auto_results_to_json(&auto_results);

            let sidecar_path = get_sidecar_path(path);
            let mut existing_metadata: ImageMetadata = if sidecar_path.exists() {
                fs::read_to_string(&sidecar_path)
                    .ok()
                    .and_then(|content| serde_json::from_str(&content).ok())
                    .unwrap_or_default()
            } else {
                ImageMetadata::default()
            };

            if existing_metadata.adjustments.is_null() {
                existing_metadata.adjustments = serde_json::json!({});
            }

            if let (Some(existing_map), Some(auto_map)) = (
                existing_metadata.adjustments.as_object_mut(),
                auto_adjustments_json.as_object(),
            ) {
                for (k, v) in auto_map {
                    if k == "sectionVisibility" {
                        if let Some(existing_vis_val) = existing_map.get_mut(k) {
                            if let (Some(existing_vis), Some(auto_vis)) =
                                (existing_vis_val.as_object_mut(), v.as_object())
                            {
                                for (vis_k, vis_v) in auto_vis {
                                    existing_vis.insert(vis_k.clone(), vis_v.clone());
                                }
                            }
                        } else {
                            existing_map.insert(k.clone(), v.clone());
                        }
                    } else {
                        existing_map.insert(k.clone(), v.clone());
                    }
                }
            }

            existing_metadata.rating = existing_metadata.adjustments["rating"]
                .as_u64()
                .unwrap_or(0) as u8;

            if let Ok(json_string) = serde_json::to_string_pretty(&existing_metadata) {
                let _ = std::fs::write(sidecar_path, json_string);
            }
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("Failed to apply auto adjustments to {}: {}", path, e);
        }
    });

    thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let cache_dir = app_handle.path().app_cache_dir().unwrap();
        let thumb_cache_dir = cache_dir.join("thumbnails");
        if !thumb_cache_dir.exists() {
            fs::create_dir_all(&thumb_cache_dir).unwrap();
        }

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state).ok();
        let total_count = paths.len();
        let completed_count = Arc::new(AtomicUsize::new(0));

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
            );

            if let Some((thumbnail_data, rating)) = result {
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "rating": rating }),
                );
            }

            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_handle.emit(
                "thumbnail-progress",
                serde_json::json!({ "completed": completed, "total": total_count }),
            );
        });

        let _ = app_handle.emit("thumbnail-generation-complete", true);
    });

    Ok(())
}

#[tauri::command]
pub fn set_color_label_for_paths(paths: Vec<String>, color: Option<String>) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let sidecar_path = get_sidecar_path(path);

        let mut metadata: ImageMetadata = if sidecar_path.exists() {
            fs::read_to_string(&sidecar_path)
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok())
                .unwrap_or_default()
        } else {
            ImageMetadata::default()
        };

        let mut tags = metadata.tags.unwrap_or_else(Vec::new);
        tags.retain(|tag| !tag.starts_with(COLOR_TAG_PREFIX));

        if let Some(c) = &color {
            if !c.is_empty() {
                tags.push(format!("{}{}", COLOR_TAG_PREFIX, c));
            }
        }

        if tags.is_empty() {
            metadata.tags = None;
        } else {
            metadata.tags = Some(tags);
        }

        if let Ok(json_string) = serde_json::to_string_pretty(&metadata) {
            let _ = std::fs::write(sidecar_path, json_string);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn load_metadata(path: String) -> Result<ImageMetadata, String> {
    let sidecar_path = get_sidecar_path(&path);
    if sidecar_path.exists() {
        let file_content = std::fs::read_to_string(sidecar_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&file_content).map_err(|e| e.to_string())
    } else {
        Ok(ImageMetadata::default())
    }
}

fn get_presets_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let presets_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("presets");

    if !presets_dir.exists() {
        fs::create_dir_all(&presets_dir).map_err(|e| e.to_string())?;
    }

    Ok(presets_dir.join("presets.json"))
}

#[tauri::command]
pub fn load_presets(app_handle: AppHandle) -> Result<Vec<PresetItem>, String> {
    let path = get_presets_path(&app_handle)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_presets(presets: Vec<PresetItem>, app_handle: AppHandle) -> Result<(), String> {
    let path = get_presets_path(&app_handle)?;
    let json_string = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    fs::write(path, json_string).map_err(|e| e.to_string())
}

fn get_settings_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let settings_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    if !settings_dir.exists() {
        fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;
    }

    Ok(settings_dir.join("settings.json"))
}

#[tauri::command]
pub fn load_settings(app_handle: AppHandle) -> Result<AppSettings, String> {
    let path = get_settings_path(&app_handle)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(settings: AppSettings, app_handle: AppHandle) -> Result<(), String> {
    let path = get_settings_path(&app_handle)?;
    let json_string = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json_string).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn handle_import_presets_from_file(
    file_path: String,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    let content =
        fs::read_to_string(file_path).map_err(|e| format!("Failed to read preset file: {}", e))?;
    let imported_preset_file: PresetFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse preset file: {}", e))?;

    let mut current_presets = load_presets(app_handle.clone())?;

    let mut current_names: HashSet<String> = current_presets
        .iter()
        .map(|item| match item {
            PresetItem::Preset(p) => p.name.clone(),
            PresetItem::Folder(f) => f.name.clone(),
        })
        .collect();

    for mut imported_item in imported_preset_file.presets {
        let (current_name, _new_id) = match &mut imported_item {
            PresetItem::Preset(p) => {
                p.id = Uuid::new_v4().to_string();
                (p.name.clone(), p.id.clone())
            }
            PresetItem::Folder(f) => {
                f.id = Uuid::new_v4().to_string();
                for child in &mut f.children {
                    child.id = Uuid::new_v4().to_string();
                }
                (f.name.clone(), f.id.clone())
            }
        };

        let mut new_name = current_name.clone();
        let mut counter = 1;
        while current_names.contains(&new_name) {
            new_name = format!("{} ({})", current_name, counter);
            counter += 1;
        }

        match &mut imported_item {
            PresetItem::Preset(p) => p.name = new_name.clone(),
            PresetItem::Folder(f) => f.name = new_name.clone(),
        }

        current_names.insert(new_name);
        current_presets.push(imported_item);
    }

    save_presets(current_presets.clone(), app_handle)?;
    Ok(current_presets)
}

#[tauri::command]
pub fn handle_import_legacy_presets_from_file(
    file_path: String,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read legacy preset file: {}", e))?;

    let xmp_content = if file_path.to_lowercase().ends_with(".lrtemplate") {
        let re = Regex::new(r#"(?s)s.xmp = "(.*)""#).unwrap();
        if let Some(caps) = re.captures(&content) {
            caps.get(1)
                .map(|m| m.as_str().replace(r#"\""#, r#"""#))
                .unwrap_or(content)
        } else {
            content
        }
    } else {
        content
    };

    let converted_preset = preset_converter::convert_xmp_to_preset(&xmp_content)?;

    let mut current_presets = load_presets(app_handle.clone())?;

    let current_names: HashSet<String> = current_presets
        .iter()
        .flat_map(|item| match item {
            PresetItem::Preset(p) => vec![p.name.clone()],
            PresetItem::Folder(f) => {
                let mut names = vec![f.name.clone()];
                names.extend(f.children.iter().map(|c| c.name.clone()));
                names
            }
        })
        .collect();

    let mut new_name = converted_preset.name.clone();
    let mut counter = 1;
    while current_names.contains(&new_name) {
        new_name = format!("{} ({})", converted_preset.name, counter);
        counter += 1;
    }

    let mut final_preset = converted_preset;
    final_preset.name = new_name;

    current_presets.push(PresetItem::Preset(final_preset));

    save_presets(current_presets.clone(), app_handle)?;
    Ok(current_presets)
}

#[tauri::command]
pub fn handle_export_presets_to_file(
    presets_to_export: Vec<PresetItem>,
    file_path: String,
) -> Result<(), String> {
    let preset_file = ExportPresetFile {
        creator: "Anonymous",
        presets: &presets_to_export,
    };

    let json_string = serde_json::to_string_pretty(&preset_file)
        .map_err(|e| format!("Failed to serialize presets: {}", e))?;
    fs::write(file_path, json_string).map_err(|e| format!("Failed to write preset file: {}", e))
}

#[tauri::command]
pub fn save_community_preset(
    name: String,
    adjustments: Value,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mut current_presets = load_presets(app_handle.clone())?;

    let community_folder_name = "Community";
    let community_folder_id = match current_presets.iter_mut().find(|item| {
        if let PresetItem::Folder(f) = item {
            f.name == community_folder_name
        } else {
            false
        }
    }) {
        Some(PresetItem::Folder(folder)) => folder.id.clone(),
        _ => {
            let new_folder_id = Uuid::new_v4().to_string();
            let new_folder = PresetItem::Folder(PresetFolder {
                id: new_folder_id.clone(),
                name: community_folder_name.to_string(),
                children: Vec::new(),
            });
            current_presets.insert(0, new_folder);
            new_folder_id
        }
    };

    let new_preset = Preset {
        id: Uuid::new_v4().to_string(),
        name,
        adjustments,
    };

    if let Some(PresetItem::Folder(folder)) = current_presets.iter_mut().find(|item| {
        if let PresetItem::Folder(f) = item {
            f.id == community_folder_id
        } else {
            false
        }
    }) {
        folder.children.retain(|p| p.name != new_preset.name);
        folder.children.push(new_preset);
    }

    save_presets(current_presets, app_handle)
}

#[tauri::command]
pub fn clear_all_sidecars(root_path: String) -> Result<usize, String> {
    if !Path::new(&root_path).exists() {
        return Err(format!("Root path does not exist: {}", root_path));
    }

    let mut deleted_count = 0;
    let walker = WalkDir::new(root_path).into_iter();

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(extension) = path.extension() {
                if extension == "rrdata" {
                    if fs::remove_file(path).is_ok() {
                        deleted_count += 1;
                    } else {
                        eprintln!("Failed to delete sidecar file: {:?}", path);
                    }
                }
            }
        }
    }

    Ok(deleted_count)
}

#[tauri::command]
pub fn clear_thumbnail_cache(app_handle: AppHandle) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");

    if thumb_cache_dir.exists() {
        fs::remove_dir_all(&thumb_cache_dir)
            .map_err(|e| format!("Failed to remove thumbnail cache: {}", e))?;
    }

    fs::create_dir_all(&thumb_cache_dir)
        .map_err(|e| format!("Failed to recreate thumbnail cache directory: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn show_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Some(parent) = Path::new(&path).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            return Err("Could not get parent directory".into());
        }
    }

    Ok(())
}

#[tauri::command]
pub fn delete_files_from_disk(paths: Vec<String>) -> Result<(), String> {
    trash::delete_all(&paths).map_err(|e| e.to_string())?;

    for path in paths {
        let sidecar_path = get_sidecar_path(&path);
        if sidecar_path.exists() {
            let _ = trash::delete(&sidecar_path);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn delete_files_with_associated(paths: Vec<String>) -> Result<(), String> {
    let mut files_to_delete = HashSet::new();

    for path_str in &paths {
        let path = Path::new(path_str);

        if let (Some(parent), Some(stem_os)) = (path.parent(), path.file_stem()) {
            let stem = stem_os.to_string_lossy();
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.filter_map(Result::ok) {
                    let entry_path = entry.path();
                    if entry_path.is_file() {
                        if let Some(entry_stem_os) = entry_path.file_stem() {
                            let entry_path_str = entry_path.to_string_lossy();
                            if entry_stem_os.to_string_lossy() == stem
                                && is_supported_image_file(&entry_path_str)
                            {
                                files_to_delete.insert(entry_path_str.to_string());
                            }
                        }
                    }
                }
            }
        } else {
            if is_supported_image_file(path_str) {
                files_to_delete.insert(path_str.clone());
            }
        }
    }

    let final_paths_to_delete: Vec<String> = files_to_delete.into_iter().collect();
    if final_paths_to_delete.is_empty() {
        return Ok(());
    }

    trash::delete_all(&final_paths_to_delete).map_err(|e| e.to_string())?;

    for path in final_paths_to_delete {
        let sidecar_path = get_sidecar_path(&path);
        if sidecar_path.exists() {
            if let Err(e) = trash::delete(&sidecar_path) {
                eprintln!("Failed to delete sidecar {}: {}", sidecar_path.display(), e);
            }
        }
    }

    Ok(())
}

pub fn get_thumb_cache_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");
    if !thumb_cache_dir.exists() {
        fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(thumb_cache_dir)
}

pub fn get_cache_key_hash(path_str: &str) -> Option<String> {
    let original_path = Path::new(path_str);
    let sidecar_path = get_sidecar_path(path_str);

    let img_mod_time = fs::metadata(original_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let sidecar_mod_time = if let Ok(meta) = fs::metadata(&sidecar_path) {
        meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    } else {
        0
    };

    let mut hasher = blake3::Hasher::new();
    hasher.update(path_str.as_bytes());
    hasher.update(&img_mod_time.to_le_bytes());
    hasher.update(&sidecar_mod_time.to_le_bytes());
    let hash = hasher.finalize();
    Some(hash.to_hex().to_string())
}

pub fn get_cached_or_generate_thumbnail_image(
    path_str: &str,
    app_handle: &AppHandle,
    gpu_context: Option<&GpuContext>,
) -> Result<DynamicImage> {
    let thumb_cache_dir = get_thumb_cache_dir(app_handle).map_err(|e| anyhow::anyhow!(e))?;

    if let Some(cache_hash) = get_cache_key_hash(path_str) {
        let cache_filename = format!("{}.jpg", cache_hash);
        let cache_path = thumb_cache_dir.join(cache_filename);

        if cache_path.exists() {
            if let Ok(image) = image::open(&cache_path) {
                return Ok(image);
            }
            eprintln!(
                "Could not open cached thumbnail, regenerating: {:?}",
                cache_path
            );
        }

        let thumb_image = generate_thumbnail_data(path_str, gpu_context, None, app_handle)?;
        let thumb_data = encode_thumbnail(&thumb_image)?;
        fs::write(&cache_path, &thumb_data)?;

        Ok(thumb_image)
    } else {
        generate_thumbnail_data(path_str, gpu_context, None, app_handle)
    }
}

#[tauri::command]
pub async fn import_files(
    source_paths: Vec<String>,
    destination_folder: String,
    settings: ImportSettings,
    app_handle: AppHandle,
) -> Result<(), String> {
    let total_files = source_paths.len();
    let _ = app_handle.emit("import-start", serde_json::json!({ "total": total_files }));

    tokio::spawn(async move {
        for (i, source_path_str) in source_paths.iter().enumerate() {
            let _ = app_handle.emit(
                "import-progress",
                serde_json::json!({ "current": i, "total": total_files, "path": source_path_str }),
            );

            let import_result: Result<(), String> = (|| {
                let source_path = Path::new(source_path_str);
                if !source_path.exists() {
                    return Err(format!("Source file not found: {}", source_path_str));
                }

                let file_date: DateTime<Utc> = Metadata::new_from_path(source_path)
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
                        fs::metadata(source_path)
                            .ok()
                            .and_then(|m| m.created().ok())
                            .map(DateTime::<Utc>::from)
                            .unwrap_or_else(Utc::now)
                    });

                let mut final_dest_folder = PathBuf::from(&destination_folder);
                if settings.organize_by_date {
                    let date_format_str = settings
                        .date_folder_format
                        .replace("YYYY", "%Y")
                        .replace("MM", "%m")
                        .replace("DD", "%d");
                    let subfolder = file_date.format(&date_format_str).to_string();
                    final_dest_folder.push(subfolder);
                }

                fs::create_dir_all(&final_dest_folder)
                    .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                let new_stem = generate_filename_from_template(
                    &settings.filename_template,
                    source_path,
                    i + 1,
                    total_files,
                    &file_date,
                );
                let extension = source_path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let new_filename = format!("{}.{}", new_stem, extension);
                let dest_file_path = final_dest_folder.join(new_filename);

                if dest_file_path.exists() {
                    return Err(format!(
                        "File already exists at destination: {}",
                        dest_file_path.display()
                    ));
                }

                fs::copy(source_path, &dest_file_path).map_err(|e| e.to_string())?;
                let source_sidecar = get_sidecar_path(source_path_str);
                if source_sidecar.exists() {
                    if let Some(dest_str) = dest_file_path.to_str() {
                        let dest_sidecar = get_sidecar_path(dest_str);
                        fs::copy(&source_sidecar, &dest_sidecar).map_err(|e| e.to_string())?;
                    }
                }

                if settings.delete_after_import {
                    trash::delete(source_path).map_err(|e| e.to_string())?;
                    if source_sidecar.exists() {
                        trash::delete(source_sidecar).map_err(|e| e.to_string())?;
                    }
                }

                Ok(())
            })();

            if let Err(e) = import_result {
                eprintln!("Failed to import {}: {}", source_path_str, e);
                let _ = app_handle.emit("import-error", e);
                return;
            }
        }

        let _ = app_handle.emit(
            "import-progress",
            serde_json::json!({ "current": total_files, "total": total_files, "path": "" }),
        );
        let _ = app_handle.emit("import-complete", ());
    });

    Ok(())
}

pub fn generate_filename_from_template(
    template: &str,
    original_path: &std::path::Path,
    sequence: usize,
    total: usize,
    file_date: &DateTime<Utc>,
) -> String {
    let stem = original_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let sequence_str = format!(
        "{:0width$}",
        sequence,
        width = total.to_string().len().max(1)
    );
    let local_date = file_date.with_timezone(&chrono::Local);

    let mut result = template.to_string();
    result = result.replace("{original_filename}", stem);
    result = result.replace("{sequence}", &sequence_str);
    result = result.replace("{YYYY}", &local_date.format("%Y").to_string());
    result = result.replace("{MM}", &local_date.format("%m").to_string());
    result = result.replace("{DD}", &local_date.format("%d").to_string());
    result = result.replace("{hh}", &local_date.format("%H").to_string());
    result = result.replace("{mm}", &local_date.format("%M").to_string());

    result
}

#[tauri::command]
pub fn rename_files(paths: Vec<String>, name_template: String) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut new_paths = Vec::with_capacity(paths.len());
    let mut operations: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (i, path_str) in paths.iter().enumerate() {
        let original_path = Path::new(path_str);
        if !original_path.exists() {
            return Err(format!("File not found: {}", path_str));
        }

        let parent = original_path
            .parent()
            .ok_or("Could not get parent directory")?;
        let extension = original_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        let file_date: DateTime<Utc> = Metadata::new_from_path(original_path)
            .ok()
            .and_then(|metadata| {
                metadata
                    .get_tag(&ExifTag::DateTimeOriginal("".to_string()))
                    .next()
                    .and_then(|tag| {
                        if let &ExifTag::DateTimeOriginal(ref dt_str) = tag {
                            chrono::NaiveDateTime::parse_from_str(dt_str, "%Y:%m:%d %H:%M:%S")
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

        let new_stem = generate_filename_from_template(
            &name_template,
            original_path,
            i + 1,
            paths.len(),
            &file_date,
        );
        let new_filename = format!("{}.{}", new_stem, extension);
        let new_path = parent.join(new_filename);

        if new_path.exists() && new_path != original_path {
            return Err(format!(
                "A file with the name {} already exists.",
                new_path.display()
            ));
        }

        operations.push((original_path.to_path_buf(), new_path));
    }

    for (original_path, new_path) in operations {
        fs::rename(&original_path, &new_path).map_err(|e| e.to_string())?;

        let original_sidecar = get_sidecar_path(original_path.to_str().unwrap());
        if original_sidecar.exists() {
            let new_sidecar = get_sidecar_path(new_path.to_str().unwrap());
            fs::rename(original_sidecar, new_sidecar).map_err(|e| e.to_string())?;
        }
        new_paths.push(new_path.to_string_lossy().into_owned());
    }

    Ok(new_paths)
}
