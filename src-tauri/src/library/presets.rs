use crate::app::settings::load_settings;
use crate::app::state::AppState;
use crate::decode::formats::is_raw_file;
use crate::library::file_ops::write_file_atomic;
use crate::library::preset_converter;
use crate::library::sidecars::parse_virtual_path;
use crate::masks::generation::{
    MaskDefinition, generate_mask_bitmap, get_cached_or_generate_masks,
};
use crate::render::cache_utils::calculate_patch_hash;
use crate::render::geometry::Crop;
use crate::render::gpu::context::get_or_init_gpu_context;
use crate::render::gpu::output::process_and_get_dynamic_image;
use crate::render::gpu::processor::RenderRequest;
use crate::render::image_processing::downscale_f32_image;
use crate::render::options::resolve_render_options_from_handle;
use crate::render::preview::prepare_preview_source;
use crate::render::source::RenderSource;
use crate::render::uniforms::get_all_adjustments_from_json;
use anyhow::Result;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, RgbImage};
use regex::regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashSet;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    AppHandle, Manager,
    ipc::{Channel, InvokeResponseBody, Response},
};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CommunityPreset {
    pub name: String,
    pub creator: String,
    pub adjustments: Value,
    #[serde(rename = "includeMasks")]
    pub include_masks: Option<bool>,
    #[serde(rename = "includeCropTransform")]
    pub include_crop_transform: Option<bool>,
}

#[tauri::command]
pub async fn generate_preset_preview(
    js_adjustments: serde_json::Value,
    app_handle: tauri::AppHandle,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let context = get_or_init_gpu_context(&state, &app_handle)?;

        let loaded_image = state
            .original_image
            .lock()
            .unwrap()
            .clone()
            .ok_or("No original image loaded for preset preview")?;
        let is_raw = loaded_image.is_raw;

        let mut js_adjustments = js_adjustments;
        if crate::ai::jobs::has_ai_results(&js_adjustments) {
            let (source_path, sidecar_path) =
                crate::library::sidecars::parse_virtual_path(&loaded_image.path);
            if let Some(source_id) = crate::ai::jobs::source_id(&source_path) {
                let existing = crate::metadata::sidecar::load_sidecar(&sidecar_path).adjustments;
                crate::ai::jobs::reconcile_ai_results(
                    &mut js_adjustments,
                    &existing,
                    &source_id,
                    false,
                );
            }
        }

        const PRESET_PREVIEW_DIM: u32 = 400;

        let preview = prepare_preview_source(
            &state,
            &context,
            &loaded_image,
            &js_adjustments,
            PRESET_PREVIEW_DIM,
        )?;
        let source = preview.render_source(&js_adjustments);
        let (scale_for_gpu, unscaled_crop_offset) = (preview.scale, preview.unscaled_crop_offset);
        let (img_w, img_h) = source.size();

        let mask_definitions: Vec<MaskDefinition> = js_adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();

        let scaled_crop_offset = (
            unscaled_crop_offset.0 * scale_for_gpu,
            unscaled_crop_offset.1 * scale_for_gpu,
        );

        let mask_bitmaps = get_cached_or_generate_masks(
            &state,
            &loaded_image.path,
            &mask_definitions,
            img_w,
            img_h,
            scale_for_gpu,
            scaled_crop_offset,
            &js_adjustments,
        )
        .bitmaps;

        let render = resolve_render_options_from_handle(&app_handle, is_raw);
        let mut all_adjustments =
            get_all_adjustments_from_json(&js_adjustments, is_raw, loaded_image.as_shot, render);
        all_adjustments.global.show_clipping = 0;
        let lut_path = js_adjustments["lutPath"].as_str();
        let lut = lut_path
            .and_then(|p| crate::adjustments::lut_processing::get_or_load_lut(&state, p).ok());

        let processed_image = process_and_get_dynamic_image(
            &context,
            &state,
            &source,
            RenderRequest {
                adjustments: all_adjustments,
                mask_bitmaps: &mask_bitmaps,
                mask_cache_key: None,
                lut,
                roi: None,
                hsl_probe: false,
                motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                    &loaded_image.path,
                    &js_adjustments,
                    (img_w, img_h),
                    scaled_crop_offset,
                    loaded_image.image.width().max(loaded_image.image.height()) as f32
                        * scale_for_gpu,
                ),
            },
            "generate_preset_preview",
        )?;

        let mut buf = Cursor::new(Vec::new());
        processed_image
            .to_rgb8()
            .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
            .map_err(|e| e.to_string())?;

        Ok(Response::new(buf.into_inner()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fetch_community_presets() -> Result<Vec<CommunityPreset>, String> {
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

static COMMUNITY_PREVIEW_RUN: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn generate_all_community_previews(
    image_paths: Vec<String>,
    presets: Vec<CommunityPreset>,
    on_preview: Channel,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let run = COMMUNITY_PREVIEW_RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let is_superseded = move || COMMUNITY_PREVIEW_RUN.load(Ordering::SeqCst) != run;

    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let context = get_or_init_gpu_context(&state, &app_handle)?;

        const TILE_DIM: u32 = 360;
        const PROCESSING_DIM: u32 = TILE_DIM * 2;

        let settings = load_settings(app_handle.clone()).unwrap_or_default();

        let mut base_thumbnails: Vec<(
            DynamicImage,
            bool,
            crate::decode::as_shot::AsShot,
            f32,
            u64,
            String,
        )> = Vec::new();
        for image_path in image_paths.iter() {
            if is_superseded() {
                return Ok(());
            }
            let (source_path, _) = parse_virtual_path(image_path);
            let source_path_str = source_path.to_string_lossy().to_string();
            let image_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
            let original_image = crate::decode::image_loader::load_base_image_from_bytes(
                &image_bytes,
                &source_path_str,
                true,
                &settings,
                None,
            )
            .map_err(|e| e.to_string())?;

            let is_raw = is_raw_file(&source_path_str);
            let (orig_w, orig_h) = original_image.dimensions();
            let (base_image, base_scale) = if orig_w > PROCESSING_DIM || orig_h > PROCESSING_DIM {
                let downscaled =
                    downscale_f32_image(&original_image, PROCESSING_DIM, PROCESSING_DIM);
                let scale = downscaled.width() as f32 / orig_w as f32;
                (downscaled, scale)
            } else {
                (original_image, 1.0)
            };

            let mut sample_hasher = DefaultHasher::new();
            image_path.hash(&mut sample_hasher);

            base_thumbnails.push((
                base_image,
                is_raw,
                crate::decode::as_shot::as_shot(&source_path_str),
                base_scale,
                sample_hasher.finish(),
                image_path.clone(),
            ));
        }

        for preset in presets.iter() {
            if is_superseded() {
                return Ok(());
            }

            let mut processed_tiles: Vec<RgbImage> = Vec::new();
            let js_adjustments = &preset.adjustments;

            for (base_image, is_raw, as_shot, base_scale, sample_id, image_path) in
                base_thumbnails.iter()
            {
                let mut scaled_adjustments = js_adjustments.clone();
                if let Some(crop_val) = scaled_adjustments.get_mut("crop")
                    && let Ok(c) = serde_json::from_value::<Crop>(crop_val.clone())
                {
                    *crop_val = serde_json::to_value(Crop {
                        x: c.x * (*base_scale as f64),
                        y: c.y * (*base_scale as f64),
                        width: c.width * (*base_scale as f64),
                        height: c.height * (*base_scale as f64),
                    })
                    .unwrap_or(serde_json::Value::Null);
                }

                let converted = crate::adjustments::negative_conversion::apply_negative_conversion(
                    Cow::Borrowed(base_image),
                    &scaled_adjustments,
                );
                let source_id = {
                    let mut hasher = DefaultHasher::new();
                    sample_id.hash(&mut hasher);
                    calculate_patch_hash(&scaled_adjustments).hash(&mut hasher);
                    hasher.finish()
                };
                let source =
                    RenderSource::edited(&converted, source_id, image_path, &scaled_adjustments);
                let (img_w, img_h) = source.size();

                let mask_definitions: Vec<MaskDefinition> = scaled_adjustments
                    .get("masks")
                    .and_then(|m| serde_json::from_value(m.clone()).ok())
                    .unwrap_or_else(Vec::new);

                let unscaled_crop_offset = js_adjustments
                    .get("crop")
                    .and_then(|c| serde_json::from_value::<Crop>(c.clone()).ok())
                    .map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));
                let actual_scaled_crop_offset = (
                    unscaled_crop_offset.0 * base_scale,
                    unscaled_crop_offset.1 * base_scale,
                );

                let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
                    .iter()
                    .filter_map(|def| {
                        generate_mask_bitmap(
                            def,
                            img_w,
                            img_h,
                            *base_scale,
                            actual_scaled_crop_offset,
                            None,
                        )
                    })
                    .collect();

                let render = resolve_render_options_from_handle(&app_handle, *is_raw);
                let all_adjustments =
                    get_all_adjustments_from_json(&scaled_adjustments, *is_raw, *as_shot, render);
                let lut_path = js_adjustments["lutPath"].as_str();
                let lut = lut_path.and_then(|p| {
                    crate::adjustments::lut_processing::get_or_load_lut(&state, p).ok()
                });

                let processed_image_dynamic =
                    crate::render::gpu::output::process_and_get_dynamic_image(
                        &context,
                        &state,
                        &source,
                        RenderRequest {
                            adjustments: all_adjustments,
                            mask_bitmaps: &mask_bitmaps,
                            mask_cache_key: None,
                            lut,
                            roi: None,
                            hsl_probe: false,
                            motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                                image_path,
                                &scaled_adjustments,
                                (img_w, img_h),
                                actual_scaled_crop_offset,
                                base_image.width().max(base_image.height()) as f32,
                            ),
                        },
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

            let mut jpeg = Cursor::new(Vec::new());
            if final_image_buffer
                .write_with_encoder(JpegEncoder::new_with_quality(&mut jpeg, 75))
                .is_ok()
            {
                let jpeg = jpeg.into_inner();
                let mut packet = Vec::with_capacity(4 + preset.name.len() + jpeg.len());
                packet.extend_from_slice(&(preset.name.len() as u32).to_le_bytes());
                packet.extend_from_slice(preset.name.as_bytes());
                packet.extend_from_slice(&jpeg);
                on_preview
                    .send(InvokeResponseBody::Raw(packet))
                    .map_err(|e| e.to_string())?;
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub adjustments: Value,
    #[serde(rename = "includeMasks", skip_serializing_if = "Option::is_none")]
    pub include_masks: Option<bool>,
    #[serde(
        rename = "includeCropTransform",
        skip_serializing_if = "Option::is_none"
    )]
    pub include_crop_transform: Option<bool>,
    #[serde(rename = "presetType", skip_serializing_if = "Option::is_none")]
    pub preset_type: Option<String>,
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

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PresetImportFailure {
    pub file_name: String,
    pub error: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PresetImportResult {
    pub presets: Vec<PresetItem>,
    pub failures: Vec<PresetImportFailure>,
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
    write_file_atomic(&path, json_string.as_bytes()).map_err(|e| e.to_string())
}

fn preset_file_display_name(file_path: &str) -> String {
    Path::new(file_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string())
}

fn collect_top_level_preset_names(items: &[PresetItem]) -> HashSet<String> {
    items
        .iter()
        .map(|item| match item {
            PresetItem::Preset(p) => p.name.clone(),
            PresetItem::Folder(f) => f.name.clone(),
        })
        .collect()
}

fn parse_preset_file(file_path: &str) -> Result<Vec<PresetItem>, String> {
    let lower_path = file_path.to_lowercase();
    let is_legacy = lower_path.ends_with(".xmp") || lower_path.ends_with(".lrtemplate");

    if !is_legacy {
        let content = fs::read_to_string(file_path)
            .map_err(|e| format!("Failed to read preset file: {}", e))?;
        let preset_file: PresetFile = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse preset file: {}", e))?;
        return Ok(preset_file.presets);
    }

    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read legacy preset file: {}", e))?;

    let xmp_content = if lower_path.ends_with(".lrtemplate") {
        if let Some(caps) = regex!(r#"(?s)s.xmp = "(.*)""#).captures(&content) {
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
    Ok(vec![PresetItem::Preset(converted_preset)])
}

fn merge_imported_items(
    target: &mut Vec<PresetItem>,
    taken_names: &mut HashSet<String>,
    imported: Vec<PresetItem>,
) {
    for mut imported_item in imported {
        let original_name = match &mut imported_item {
            PresetItem::Preset(p) => {
                p.id = Uuid::new_v4().to_string();
                p.name.clone()
            }
            PresetItem::Folder(f) => {
                f.id = Uuid::new_v4().to_string();
                for child in &mut f.children {
                    child.id = Uuid::new_v4().to_string();
                }
                f.name.clone()
            }
        };

        let mut new_name = original_name.clone();
        let mut counter = 1;
        while taken_names.contains(&new_name) {
            new_name = format!("{} ({})", original_name, counter);
            counter += 1;
        }

        match &mut imported_item {
            PresetItem::Preset(p) => p.name = new_name.clone(),
            PresetItem::Folder(f) => f.name = new_name.clone(),
        }

        taken_names.insert(new_name);
        target.push(imported_item);
    }
}

fn import_preset_file_into_library(
    file_path: &str,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    let imported = parse_preset_file(file_path)?;

    let mut current_presets = load_presets(app_handle.clone())?;
    let mut taken_names = collect_top_level_preset_names(&current_presets);
    merge_imported_items(&mut current_presets, &mut taken_names, imported);

    save_presets(current_presets.clone(), app_handle)?;
    Ok(current_presets)
}

#[tauri::command]
pub fn handle_import_presets_from_file(
    file_path: String,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    import_preset_file_into_library(&file_path, app_handle)
}

#[tauri::command]
pub fn handle_import_legacy_presets_from_file(
    file_path: String,
    app_handle: AppHandle,
) -> Result<Vec<PresetItem>, String> {
    import_preset_file_into_library(&file_path, app_handle)
}

#[tauri::command]
pub fn handle_import_presets_from_files(
    file_paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<PresetImportResult, String> {
    let mut current_presets = load_presets(app_handle.clone())?;
    let mut taken_names = collect_top_level_preset_names(&current_presets);

    let mut failures: Vec<PresetImportFailure> = Vec::new();
    let mut library_changed = false;

    for file_path in &file_paths {
        match parse_preset_file(file_path) {
            Ok(imported) => {
                library_changed |= !imported.is_empty();
                merge_imported_items(&mut current_presets, &mut taken_names, imported);
            }
            Err(error) => failures.push(PresetImportFailure {
                file_name: preset_file_display_name(file_path),
                error,
            }),
        }
    }

    if library_changed {
        save_presets(current_presets.clone(), app_handle)?;
    }

    Ok(PresetImportResult {
        presets: current_presets,
        failures,
    })
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
    include_masks: Option<bool>,
    include_crop_transform: Option<bool>,
    preset_type: Option<String>,
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
        include_masks,
        include_crop_transform,
        preset_type: preset_type.or(Some("style".to_string())),
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
