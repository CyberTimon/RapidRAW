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
use std::time::Instant;

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

use crate::{AppState, LutCacheEntry, MAX_LUT_CACHE};
use crate::formats::{is_raw_file, is_supported_image_file};
use crate::gpu_processing;
use crate::image_loader;
use crate::image_processing::GpuContext;
use crate::image_processing::{
    Crop, ImageMetadata, apply_coarse_rotation, apply_crop, apply_flip, apply_rotation,
    auto_results_to_json, get_all_adjustments_from_json, perform_auto_analysis, apply_cpu_default_raw_processing,
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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PasteMode {
    Merge,
    Replace,
}

fn default_included_adjustments() -> HashSet<String> {
    [
        "blacks", "brightness", "clarity", "centré", "chromaticAberrationBlueYellow",
        "chromaticAberrationRedCyan", "colorCalibration", "colorGrading", "colorNoiseReduction",
        "contrast", "curves", "dehaze", "enableNegativeConversion", "exposure", "filmBaseColor",
        "grainAmount", "grainRoughness", "grainSize", "highlights", "hsl", "lutIntensity",
        "lutName", "lutPath", "lutSize", "lumaNoiseReduction", "negativeBlueBalance",
        "negativeGreenBalance", "negativeRedBalance", "saturation", "sectionVisibility",
        "shadows", "sharpness", "showClipping", "structure", "temperature", "tint",
        "toneMapper", "vibrance", "vignetteAmount", "vignetteFeather", "vignetteMidpoint",
        "vignetteRoundness", "whites",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopyPasteSettings {
    pub mode: PasteMode,
    #[serde(default = "default_included_adjustments")]
    pub included_adjustments: HashSet<String>,
}

impl Default for CopyPasteSettings {
    fn default() -> Self {
        Self {
            mode: PasteMode::Merge,
            included_adjustments: default_included_adjustments(),
        }
    }
}

fn default_tagging_shortcuts_option() -> Option<Vec<String>> {
    Some(vec![
        "portrait".to_string(),
        "landscape".to_string(),
        "architecture".to_string(),
        "travel".to_string(),
        "street".to_string(),
        "family".to_string(),
        "nature".to_string(),
        "food".to_string(),
        "event".to_string(),
    ])
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub last_root_path: Option<String>,
    #[serde(default)]
    pub pinned_folders: Vec<String>,
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
    #[serde(default = "default_tagging_shortcuts_option")]
    pub tagging_shortcuts: Option<Vec<String>>,
    pub thumbnail_size: Option<String>,
    pub thumbnail_aspect_ratio: Option<String>,
    pub thumbnail_memory_limit: Option<usize>,
    pub ai_provider: Option<String>,
    #[serde(default = "default_adjustment_visibility")]
    pub adjustment_visibility: HashMap<String, bool>,
    pub enable_exif_reading: Option<bool>,
    #[serde(default)]
    pub active_tree_section: Option<String>,
    #[serde(default)]
    pub copy_paste_settings: CopyPasteSettings,
    #[serde(default)]
    pub raw_highlight_compression: Option<f32>,
    #[serde(default)]
    pub processing_backend: Option<String>,
    #[serde(default)]
    pub linux_gpu_optimization: Option<bool>,
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
            pinned_folders: Vec::new(),
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
            tagging_shortcuts: default_tagging_shortcuts_option(),
            thumbnail_size: Some("medium".to_string()),
            thumbnail_aspect_ratio: Some("cover".to_string()),
            thumbnail_memory_limit: Some(300),
            ai_provider: Some("cpu".to_string()),
            adjustment_visibility: default_adjustment_visibility(),
            enable_exif_reading: Some(false),
            active_tree_section: Some("current".to_string()),
            copy_paste_settings: CopyPasteSettings::default(),
            raw_highlight_compression: Some(2.5),
            processing_backend: Some("auto".to_string()),
            #[cfg(target_os = "linux")]
            linux_gpu_optimization: Some(true),
            #[cfg(not(target_os = "linux"))]
            linux_gpu_optimization: Some(false),
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
    is_virtual_copy: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettings {
    pub filename_template: String,
    pub organize_by_date: bool,
    pub date_folder_format: String,
    pub delete_after_import: bool,
}

pub fn parse_virtual_path(virtual_path: &str) -> (PathBuf, PathBuf) {
    let (source_path_str, copy_id) =
        if let Some((base, id)) = virtual_path.rsplit_once("?vc=") {
            (base.to_string(), Some(id.to_string()))
        } else {
            (virtual_path.to_string(), None)
        };

    let source_path = PathBuf::from(source_path_str);

    let sidecar_filename = if let Some(id) = copy_id {
        format!(
            "{}.{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            &id
        )
    } else {
        format!(
            "{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    };

    let sidecar_path = source_path.with_file_name(sidecar_filename);
    (source_path, sidecar_path)
}

#[tauri::command]
pub async fn read_exif_for_paths(
    paths: Vec<String>,
) -> Result<HashMap<String, HashMap<String, String>>, String> {
    let exif_data: HashMap<String, HashMap<String, String>> = paths
        .par_iter()
        .filter_map(|path_str| {
            let (source_path, _) = parse_virtual_path(path_str);
            let file = match fs::File::open(source_path) {
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
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut image_files = HashMap::new();
    let mut sidecars_by_source = HashMap::new();

    let sidecar_re = Regex::new(r"^(.*)\.([a-f0-9]{6})\.rrdata$").unwrap();
    let original_sidecar_re = Regex::new(r"^(.*)\.rrdata$").unwrap();

    for entry in entries.filter_map(Result::ok) {
        let entry_path = entry.path();
        let file_name = entry_path.file_name().unwrap_or_default().to_string_lossy();

        if is_supported_image_file(&entry_path.to_string_lossy()) {
            let path_str = entry_path.to_string_lossy().into_owned();
            image_files.insert(path_str, entry_path.clone());
        } else if file_name.ends_with(".rrdata") {
            if let Some(caps) = sidecar_re.captures(&file_name) {
                let source_filename = caps.get(1).map_or("", |m| m.as_str());
                let copy_id = caps.get(2).map_or("", |m| m.as_str());
                let source_path = Path::new(&path).join(source_filename);
                sidecars_by_source
                    .entry(source_path.to_string_lossy().into_owned())
                    .or_insert_with(Vec::new)
                    .push(Some(copy_id.to_string()));
            } else if let Some(caps) = original_sidecar_re.captures(&file_name) {
                let source_filename = caps.get(1).map_or("", |m| m.as_str());
                let source_path = Path::new(&path).join(source_filename);
                sidecars_by_source
                    .entry(source_path.to_string_lossy().into_owned())
                    .or_insert_with(Vec::new)
                    .push(None);
            }
        }
    }

    let mut result_list = Vec::new();
    for (path_str, path_buf) in image_files {
        let modified = fs::metadata(&path_buf)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let sidecar_versions = sidecars_by_source.entry(path_str.clone()).or_insert_with(|| vec![None]);

        for copy_id_opt in sidecar_versions {
            let (virtual_path, sidecar_path, is_virtual_copy) = match copy_id_opt {
                Some(id) => {
                    let new_virtual_path = format!("{}?vc={}", path_str, id);
                    (
                        new_virtual_path.clone(),
                        parse_virtual_path(&new_virtual_path).1,
                        true,
                    )
                }
                None => (path_str.clone(), parse_virtual_path(&path_str).1, false),
            };

            let (is_edited, tags) = if sidecar_path.exists() {
                if let Ok(content) = fs::read_to_string(sidecar_path) {
                    if let Ok(metadata) = serde_json::from_str::<ImageMetadata>(&content) {
                        let edited = metadata.adjustments.as_object().map_or(false, |a| {
                            a.keys().len() > 1 || (a.keys().len() == 1 && !a.contains_key("rating"))
                        });
                        (edited, metadata.tags)
                    } else { (false, None) }
                } else { (false, None) }
            } else { (false, None) };

            result_list.push(ImageFile {
                path: virtual_path,
                modified,
                is_edited,
                tags,
                exif: None,
                is_virtual_copy,
            });
        }
    }

    Ok(result_list)
}

#[tauri::command]
pub fn list_images_recursive(path: String) -> Result<Vec<ImageFile>, String> {
    let root_path = Path::new(&path);
    let mut image_files = HashMap::new();
    let mut sidecars_by_source = HashMap::new();

    let sidecar_re = Regex::new(r"^(.*)\.([a-f0-9]{6})\.rrdata$").unwrap();
    let original_sidecar_re = Regex::new(r"^(.*)\.rrdata$").unwrap();

    for entry in WalkDir::new(root_path).into_iter().filter_map(Result::ok) {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        
        let file_name = entry_path.file_name().unwrap_or_default().to_string_lossy();

        if is_supported_image_file(&entry_path.to_string_lossy()) {
            let path_str = entry_path.to_string_lossy().into_owned();
            image_files.insert(path_str, entry_path.to_path_buf());
        } else if file_name.ends_with(".rrdata") {
            if let Some(caps) = sidecar_re.captures(&file_name) {
                let source_filename = caps.get(1).map_or("", |m| m.as_str());
                let copy_id = caps.get(2).map_or("", |m| m.as_str());
                if let Some(parent) = entry_path.parent() {
                    let source_path = parent.join(source_filename);
                    sidecars_by_source
                        .entry(source_path.to_string_lossy().into_owned())
                        .or_insert_with(Vec::new)
                        .push(Some(copy_id.to_string()));
                }
            } else if let Some(caps) = original_sidecar_re.captures(&file_name) {
                let source_filename = caps.get(1).map_or("", |m| m.as_str());
                if let Some(parent) = entry_path.parent() {
                    let source_path = parent.join(source_filename);
                    sidecars_by_source
                        .entry(source_path.to_string_lossy().into_owned())
                        .or_insert_with(Vec::new)
                        .push(None);
                }
            }
        }
    }

    let mut result_list = Vec::new();
    for (path_str, path_buf) in image_files {
        let modified = fs::metadata(&path_buf)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let sidecar_versions = sidecars_by_source.entry(path_str.clone()).or_insert_with(|| vec![None]);

        for copy_id_opt in sidecar_versions {
            let (virtual_path, sidecar_path, is_virtual_copy) = match copy_id_opt {
                Some(id) => {
                    let new_virtual_path = format!("{}?vc={}", path_str, id);
                    (
                        new_virtual_path.clone(),
                        parse_virtual_path(&new_virtual_path).1,
                        true,
                    )
                }
                None => (path_str.clone(), parse_virtual_path(&path_str).1, false),
            };

            let (is_edited, tags) = if sidecar_path.exists() {
                if let Ok(content) = fs::read_to_string(sidecar_path) {
                    if let Ok(metadata) = serde_json::from_str::<ImageMetadata>(&content) {
                        let edited = metadata.adjustments.as_object().map_or(false, |a| {
                            a.keys().len() > 1 || (a.keys().len() == 1 && !a.contains_key("rating"))
                        });
                        (edited, metadata.tags)
                    } else { (false, None) }
                } else { (false, None) }
            } else { (false, None) };

            result_list.push(ImageFile {
                path: virtual_path,
                modified,
                is_edited,
                tags,
                exif: None,
                is_virtual_copy,
            });
        }
    }

    Ok(result_list)
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

#[tauri::command]
pub async fn get_pinned_folder_trees(paths: Vec<String>) -> Result<Vec<FolderNode>, String> {
    let results: Vec<Result<FolderNode, String>> = paths
        .par_iter()
        .map(|path| get_folder_tree_sync(path.clone()))
        .collect();

    let mut folder_nodes = Vec::new();
    for result in results {
        match result {
            Ok(node) => folder_nodes.push(node),
            Err(e) => log::warn!("Failed to get tree for pinned folder: {}", e),
        }
    }
    Ok(folder_nodes)
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

pub fn generate_thumbnail_data(
    path_str: &str,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<&DynamicImage>,
    app_handle: &AppHandle,
) -> anyhow::Result<DynamicImage> {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);
    let source_path_str = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source_path_str);

    let metadata: Option<ImageMetadata> = fs::read_to_string(sidecar_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok());

    let adjustments = metadata
        .as_ref()
        .map_or(serde_json::Value::Null, |m| m.adjustments.clone());

    let settings = crate::file_management::load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);

    let composite_image = if let Some(img) = preloaded_image {
        image_loader::composite_patches_on_image(img, &adjustments)?
    } else {
        match read_file_mapped(&source_path) {
            Ok(mmap) => image_loader::load_and_composite(
                &mmap,
                &source_path_str,
                &adjustments,
                true,
                highlight_compression,
            )?,
            Err(e) => {
                log::warn!(
                    "Failed to memory-map file '{}': {}. Falling back to standard read.",
                    source_path_str,
                    e
                );
                let file_bytes = fs::read(&source_path).map_err(|io_err| {
                    anyhow::anyhow!("Fallback read failed for {}: {}", source_path_str, io_err)
                })?;
                image_loader::load_and_composite(
                    &file_bytes,
                    &source_path_str,
                    &adjustments,
                    true,
                    highlight_compression,
                )?
            }
        }
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
                    let base = crate::image_processing::downscale_f32_image(
                        &coarse_rotated_image,
                        THUMBNAIL_PROCESSING_DIM,
                        THUMBNAIL_PROCESSING_DIM,
                    );
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

            let gpu_adjustments = get_all_adjustments_from_json(&meta.adjustments, is_raw);
            let lut_path = meta.adjustments["lutPath"].as_str();
            let lut = lut_path.and_then(|p| {
                let mut cache = state.lut_cache.lock().unwrap();
                if let Some(cached_lut) = cache.get(p) {
                    return Some(cached_lut.lut.clone());
                }
                if let Ok(loaded_lut) = crate::lut_processing::parse_lut_file(p) {
                    let arc_lut = Arc::new(loaded_lut);
                    cache.insert(
                        p.to_string(),
                        LutCacheEntry {
                            lut: arc_lut.clone(),
                            loaded_at: Instant::now(),
                        },
                    );
                    if cache.len() > MAX_LUT_CACHE {
                        if let Some(oldest_key) = cache
                            .iter()
                            .min_by_key(|(_, entry)| entry.loaded_at)
                            .map(|(k, _)| k.clone())
                        {
                            if oldest_key != p {
                                cache.remove(&oldest_key);
                            }
                        }
                    }
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

    let mut final_image = composite_image;

    if is_raw && adjustments.is_null() {
        apply_cpu_default_raw_processing(&mut final_image);
    }

    let fallback_orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    Ok(apply_coarse_rotation(
        final_image,
        fallback_orientation_steps,
    ))
}

fn encode_thumbnail(image: &DynamicImage) -> Result<Vec<u8>> {
    let thumbnail =
        crate::image_processing::downscale_f32_image(image, THUMBNAIL_WIDTH, THUMBNAIL_WIDTH);
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 75);
    encoder.encode_image(&thumbnail.to_rgb8())?;
    Ok(buf.into_inner())
}

fn generate_single_thumbnail_and_cache(
    path_str: &str,
    thumb_cache_dir: &Path,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<&DynamicImage>,
    force_regenerate: bool,
    app_handle: &AppHandle,
) -> Option<(String, String, u8)> {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);

    let img_mod_time = fs::metadata(source_path)
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
            return Some((format!("data:image/jpeg;base64,{}", base64_str), cache_path.to_string_lossy().to_string(), rating));
        }
    }

    if let Ok(thumb_image) =
        generate_thumbnail_data(path_str, gpu_context, preloaded_image, app_handle)
    {
        if let Ok(thumb_data) = encode_thumbnail(&thumb_image) {
            let _ = fs::write(&cache_path, &thumb_data);
            let base64_str = general_purpose::STANDARD.encode(&thumb_data);
            return Some((
                format!("data:image/jpeg;base64,{}", base64_str),
                cache_path.to_string_lossy().to_string(),
                rating,
            ));
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
                .map(|(data, _cache_path, _rating)| (path_str.clone(), data))
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

    const MAX_THUMBNAIL_THREADS: usize = 6;
    let num_threads = (num_cpus::get_physical().saturating_sub(1))
        .min(MAX_THUMBNAIL_THREADS)
        .max(1);

    let pool = ThreadPoolBuilder::new()
        .num_threads(num_threads)
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

            if let Some((thumbnail_data, thumbnail_path, rating)) = result {
                if cancellation_token.load(Ordering::Relaxed) {
                    return Err(());
                }
                let _ = app_handle_clone.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "cachePath": thumbnail_path, "rating": rating }),
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
    let (source_path, source_sidecar_path) = parse_virtual_path(&path);
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

    if source_sidecar_path.exists() {
        if let Some(dest_str) = dest_path.to_str() {
            let (_, dest_sidecar_path) = parse_virtual_path(dest_str);
            fs::copy(&source_sidecar_path, &dest_sidecar_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn find_all_associated_files(source_image_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut associated_files = vec![source_image_path.to_path_buf()];

    let parent_dir = source_image_path.parent().ok_or("Could not determine parent directory")?;
    let source_filename = source_image_path.file_name().ok_or("Could not get source filename")?.to_string_lossy();

    let primary_sidecar_name = format!("{}.rrdata", source_filename);
    let virtual_copy_prefix = format!("{}.", source_filename);

    if let Ok(entries) = fs::read_dir(parent_dir) {
        for entry in entries.filter_map(Result::ok) {
            let entry_path = entry.path();
            if !entry_path.is_file() {
                continue;
            }

            let entry_os_filename = entry.file_name();
            let entry_filename = entry_os_filename.to_string_lossy();

            if entry_filename == primary_sidecar_name || 
               (entry_filename.starts_with(&virtual_copy_prefix) && entry_filename.ends_with(".rrdata")) {
                associated_files.push(entry_path);
            }
        }
    }

    Ok(associated_files)
}

#[tauri::command]
pub fn copy_files(source_paths: Vec<String>, destination_folder: String) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!("Destination is not a folder: {}", destination_folder));
    }

    let unique_source_images: HashSet<PathBuf> = source_paths
        .iter()
        .map(|p| parse_virtual_path(p).0)
        .collect();

    for source_image_path in unique_source_images {
        let all_files_to_copy = find_all_associated_files(&source_image_path)?;

        let source_parent = source_image_path.parent().ok_or("Could not get parent directory")?;
        if source_parent == dest_path {
            let stem = source_image_path.file_stem().and_then(|s| s.to_str()).ok_or("Could not get file stem")?;
            let extension = source_image_path.extension().and_then(|s| s.to_str()).unwrap_or("");

            let mut counter = 1;
            let new_base_path = loop {
                let new_stem = format!("{}_copy_{}", stem, counter);
                let temp_path = source_parent.join(format!("{}.{}", new_stem, extension));
                if !temp_path.exists() {
                    break temp_path;
                }
                counter += 1;
            };
            let new_filename = new_base_path.file_name().unwrap().to_string_lossy();

            for original_file in all_files_to_copy {
                let original_full_filename = original_file.file_name().unwrap().to_string_lossy();
                let source_base_filename = source_image_path.file_name().unwrap().to_string_lossy();
                let new_dest_filename = original_full_filename.replacen(&*source_base_filename, &*new_filename, 1);
                let final_dest_path = dest_path.join(new_dest_filename);

                fs::copy(&original_file, &final_dest_path).map_err(|e| e.to_string())?;
            }
        } else {
            for file_to_copy in all_files_to_copy {
                if let Some(file_name) = file_to_copy.file_name() {
                    let dest_file_path = dest_path.join(file_name);
                    fs::copy(&file_to_copy, &dest_file_path).map_err(|e| e.to_string())?;
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
        return Err(format!("Destination is not a folder: {}", destination_folder));
    }

    let unique_source_images: HashSet<PathBuf> = source_paths
        .iter()
        .map(|p| parse_virtual_path(p).0)
        .collect();

    let mut all_files_to_trash = Vec::new();

    for source_image_path in unique_source_images {
        let source_parent = source_image_path.parent().ok_or("Could not get parent directory")?;
        if source_parent == dest_path {
            return Err("Cannot move files into the same folder they are already in.".to_string());
        }

        let files_to_move = find_all_associated_files(&source_image_path)?;

        for file_to_move in &files_to_move {
            if let Some(file_name) = file_to_move.file_name() {
                let dest_file_path = dest_path.join(file_name);
                if dest_file_path.exists() {
                    return Err(format!("File already exists at destination: {}", dest_file_path.display()));
                }
            }
        }

        for file_to_move in &files_to_move {
            if let Some(file_name) = file_to_move.file_name() {
                let dest_file_path = dest_path.join(file_name);
                fs::copy(file_to_move, &dest_file_path).map_err(|e| e.to_string())?;
            }
        }
        all_files_to_trash.extend(files_to_move);
    }

    if !all_files_to_trash.is_empty() {
        trash::delete_all(&all_files_to_trash).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_metadata_and_update_thumbnail(
    path: String,
    adjustments: Value,
    app_handle: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let (source_path, sidecar_path) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

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
        if loaded_image.path == source_path_str {
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

        if let Some((thumbnail_data, cache_path, rating)) = result {
            let _ = app_handle_clone.emit(
                "thumbnail-generated",
                serde_json::json!({ "path": path_clone, "data": thumbnail_data, "cachePath": cache_path, "rating": rating }),
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
        let (_, sidecar_path) = parse_virtual_path(path);

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

            if let Some((thumbnail_data, cache_path, rating)) = result {
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "cachePath": cache_path, "rating": rating }),
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
        let (_, sidecar_path) = parse_virtual_path(path);

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

            if let Some((thumbnail_data, cache_path, rating)) = result {
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "cachePath": cache_path, "rating": rating }),
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
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);

    paths.par_iter().for_each(|path| {
        let result: Result<(), String> = (|| {
            let (source_path, sidecar_path) = parse_virtual_path(path);
            let source_path_str = source_path.to_string_lossy().to_string();

            let file_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
            let image = image_loader::load_base_image_from_bytes(
                &file_bytes,
                &source_path_str,
                false,
                highlight_compression,
            )
            .map_err(|e| e.to_string())?;

            let auto_results = perform_auto_analysis(&image);
            let auto_adjustments_json = auto_results_to_json(&auto_results);

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

            if let Some((thumbnail_data, cache_path, rating)) = result {
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    serde_json::json!({ "path": path_str, "data": thumbnail_data, "cachePath": cache_path, "rating": rating }),
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
        let (_, sidecar_path) = parse_virtual_path(path);

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
    let (_, sidecar_path) = parse_virtual_path(&path);
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
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &source_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &source_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Some(parent) = Path::new(&source_path_str).parent() {
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
    let mut files_to_trash = HashSet::new();

    for path_str in paths {
        let (source_path, sidecar_path) = parse_virtual_path(&path_str);

        if path_str.contains("?vc=") {
            if sidecar_path.exists() {
                files_to_trash.insert(sidecar_path);
            }
        } else {
            if source_path.exists() {
                match find_all_associated_files(&source_path) {
                    Ok(associated_files) => {
                        for file in associated_files {
                            files_to_trash.insert(file);
                        }
                    }
                    Err(e) => {
                        log::warn!("Could not find associated files for {}: {}", source_path.display(), e);
                    }
                }
            }
        }
    }

    if files_to_trash.is_empty() {
        return Ok(());
    }

    let final_paths_to_delete: Vec<PathBuf> = files_to_trash.into_iter().collect();
    trash::delete_all(&final_paths_to_delete).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_files_with_associated(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut stems_to_delete = HashSet::new();
    let mut parent_dirs = HashSet::new();

    for path_str in &paths {
        let (source_path, _) = parse_virtual_path(path_str);
        if let Some(file_name) = source_path.file_name().and_then(|s| s.to_str()) {
            if let Some(stem) = file_name.split('.').next() {
                stems_to_delete.insert(stem.to_string());
            }
        }
        if let Some(parent) = source_path.parent() {
            parent_dirs.insert(parent.to_path_buf());
        }
    }

    if stems_to_delete.is_empty() {
        return Ok(());
    }

    let mut files_to_trash = HashSet::new();

    for parent_dir in parent_dirs {
        if let Ok(entries) = fs::read_dir(parent_dir) {
            for entry in entries.filter_map(Result::ok) {
                let entry_path = entry.path();
                if !entry_path.is_file() {
                    continue;
                }

                let entry_filename = entry.file_name();
                let entry_filename_str = entry_filename.to_string_lossy();

                if let Some(base_stem) = entry_filename_str.split('.').next() {
                    if stems_to_delete.contains(base_stem) {
                        if is_supported_image_file(&entry_filename_str)
                            || entry_filename_str.ends_with(".rrdata")
                        {
                            files_to_trash.insert(entry_path);
                        }
                    }
                }
            }
        }
    }

    if files_to_trash.is_empty() {
        return Ok(());
    }

    let final_paths_to_delete: Vec<PathBuf> = files_to_trash.into_iter().collect();
    trash::delete_all(&final_paths_to_delete).map_err(|e| e.to_string())
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
    let (source_path, sidecar_path) = parse_virtual_path(path_str);

    let img_mod_time = fs::metadata(source_path)
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
                let (source_path, source_sidecar) = parse_virtual_path(source_path_str);
                if !source_path.exists() {
                    return Err(format!("Source file not found: {}", source_path_str));
                }

                let file_date: DateTime<Utc> = Metadata::new_from_path(&source_path)
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
                        fs::metadata(&source_path)
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
                    &source_path,
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

                fs::copy(&source_path, &dest_file_path).map_err(|e| e.to_string())?;
                if source_sidecar.exists() {
                    if let Some(dest_str) = dest_file_path.to_str() {
                        let (_, dest_sidecar) = parse_virtual_path(dest_str);
                        fs::copy(&source_sidecar, &dest_sidecar).map_err(|e| e.to_string())?;
                    }
                }

                if settings.delete_after_import {
                    trash::delete(&source_path).map_err(|e| e.to_string())?;
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

    let mut operations: HashMap<PathBuf, PathBuf> = HashMap::new();
    let mut final_new_paths = Vec::with_capacity(paths.len());

    for (i, path_str) in paths.iter().enumerate() {
        let (original_path, _) = parse_virtual_path(path_str);
        if !original_path.exists() {
            return Err(format!("File not found: {}", path_str));
        }

        let parent = original_path.parent().ok_or("Could not get parent directory")?;
        let extension = original_path.extension().and_then(|s| s.to_str()).unwrap_or("");

        let file_date: DateTime<Utc> = Metadata::new_from_path(&original_path)
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
                fs::metadata(&original_path)
                    .ok()
                    .and_then(|m| m.created().ok())
                    .map(DateTime::<Utc>::from)
                    .unwrap_or_else(Utc::now)
            });

        let new_stem = generate_filename_from_template(
            &name_template,
            &original_path,
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

        operations.insert(original_path, new_path);
    }

    let mut sidecar_operations: HashMap<PathBuf, PathBuf> = HashMap::new();
    for (original_path, new_path) in &operations {
        let parent = original_path.parent().ok_or("Could not get parent directory")?;
        let original_filename_str = original_path.file_name().unwrap().to_string_lossy();
        let new_filename_str = new_path.file_name().unwrap().to_string_lossy();

        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.filter_map(Result::ok) {
                let entry_path = entry.path();
                let entry_os_filename = entry.file_name();
                let entry_filename = entry_os_filename.to_string_lossy();

                if entry_filename.starts_with(&format!("{}.", original_filename_str)) && entry_filename.ends_with(".rrdata") {
                    let new_sidecar_filename = entry_filename.replacen(&*original_filename_str, &*new_filename_str, 1);
                    let new_sidecar_path = parent.join(new_sidecar_filename);
                    sidecar_operations.insert(entry_path, new_sidecar_path);
                } else if entry_filename == format!("{}.rrdata", original_filename_str) {
                     let new_sidecar_path = new_path.with_extension("rrdata");
                     sidecar_operations.insert(entry_path, new_sidecar_path);
                }
            }
        }
    }
    operations.extend(sidecar_operations);

    for (old_path, new_path) in operations {
        fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename {} to {}: {}", old_path.display(), new_path.display(), e))?;
        if is_supported_image_file(&new_path.to_string_lossy()) {
             final_new_paths.push(new_path.to_string_lossy().into_owned());
        }
    }

    Ok(final_new_paths)
}

#[tauri::command]
pub fn create_virtual_copy(source_virtual_path: String) -> Result<String, String> {
    let (source_path, source_sidecar_path) = parse_virtual_path(&source_virtual_path);

    let new_copy_id = Uuid::new_v4().to_string()[..6].to_string();
    let new_virtual_path = format!("{}?vc={}", source_path.to_string_lossy(), new_copy_id);
    let (_, new_sidecar_path) = parse_virtual_path(&new_virtual_path);

    if source_sidecar_path.exists() {
        fs::copy(&source_sidecar_path, &new_sidecar_path)
            .map_err(|e| format!("Failed to copy sidecar file: {}", e))?;
    } else {
        let default_metadata = ImageMetadata::default();
        let json_string =
            serde_json::to_string_pretty(&default_metadata).map_err(|e| e.to_string())?;
        fs::write(new_sidecar_path, json_string).map_err(|e| e.to_string())?;
    }

    Ok(new_virtual_path)
}
