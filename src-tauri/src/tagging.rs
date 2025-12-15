use anyhow::Result;
use futures::stream::{self, StreamExt};
use image::{DynamicImage, imageops::FilterType};
use ndarray::{Array, Axis};
use ort::session::Session;
use ort::value::Tensor; 
use rayon::prelude::*;
use serde_json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokenizers::Tokenizer;
use tokio::task::JoinHandle;
use walkdir::WalkDir;

use crate::AppState;
use crate::candidates::TAG_CANDIDATES;
use crate::file_management::{self, parse_virtual_path};
use crate::formats::is_supported_image_file;
use crate::hierarchy::TAG_HIERARCHY;
use crate::image_processing::ImageMetadata;

pub const COLOR_TAG_PREFIX: &str = "color:";
pub const USER_TAG_PREFIX: &str = "user:";

fn preprocess_clip_image(image: &DynamicImage) -> Array<f32, ndarray::Dim<[usize; 4]>> {
    let input_size = 224;
    let resized = image.resize_to_fill(input_size, input_size, FilterType::Triangle);
    let rgb_image = resized.to_rgb8();

    let mean = [0.48145466, 0.4578275, 0.40821073];
    let std = [0.26862954, 0.26130258, 0.27577711];

    let mut array = Array::zeros((1, 3, input_size as usize, input_size as usize));
    for (x, y, pixel) in rgb_image.enumerate_pixels() {
        array[[0, 0, y as usize, x as usize]] = (pixel[0] as f32 / 255.0 - mean[0]) / std[0];
        array[[0, 1, y as usize, x as usize]] = (pixel[1] as f32 / 255.0 - mean[1]) / std[1];
        array[[0, 2, y as usize, x as usize]] = (pixel[2] as f32 / 255.0 - mean[2]) / std[2];
    }
    array
}

fn softmax(array: &Array<f32, ndarray::Dim<[usize; 2]>>) -> Array<f32, ndarray::Dim<[usize; 2]>> {
    let mut new_array = array.clone();
    for mut row in new_array.axis_iter_mut(Axis(0)) {
        let max_val = row.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
        row.mapv_inplace(|x| (x - max_val).exp());
        let sum = row.sum();
        if sum > 0.0 {
            row.mapv_inplace(|x| x / sum);
        }
    }
    new_array
}

fn rgb_to_hsv((r, g, b): (u8, u8, u8)) -> (f32, f32, f32) {
    let r = r as f32 / 255.0;
    let g = g as f32 / 255.0;
    let b = b as f32 / 255.0;

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    let h = if delta.abs() < f32::EPSILON {
        0.0
    } else if (max - r).abs() < f32::EPSILON {
        60.0 * (((g - b) / delta) % 6.0)
    } else if (max - g).abs() < f32::EPSILON {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    let h = if h < 0.0 { h + 360.0 } else { h };

    let s = if max.abs() < f32::EPSILON {
        0.0
    } else {
        delta / max
    };
    let v = max;

    (h, s, v)
}

pub fn extract_color_tags(image: &DynamicImage) -> Vec<String> {
    let resized = image.resize(100, 100, FilterType::Triangle);
    let rgb_image = resized.to_rgb8();
    let mut color_counts: HashMap<String, u32> = HashMap::new();

    for pixel in rgb_image.pixels() {
        let rgb = (pixel[0], pixel[1], pixel[2]);
        let (h, s, v) = rgb_to_hsv(rgb);

        let color_name = if v < 0.2 {
            "black".to_string()
        } else if s < 0.1 {
            if v > 0.8 {
                "white".to_string()
            } else {
                "gray".to_string()
            }
        } else {
            match h {
                _ if h >= 340.0 || h < 20.0 => "red".to_string(),
                _ if h >= 20.0 && h < 45.0 => "orange".to_string(),
                _ if h >= 45.0 && h < 70.0 => "yellow".to_string(),
                _ if h >= 70.0 && h < 160.0 => "green".to_string(),
                _ if h >= 160.0 && h < 260.0 => "blue".to_string(),
                _ if h >= 260.0 && h < 340.0 => "purple".to_string(),
                _ => "unknown".to_string(),
            }
        };

        if (color_name == "orange" || color_name == "red") && v < 0.6 && s < 0.7 {
            *color_counts.entry("brown".to_string()).or_insert(0) += 1;
        } else {
            *color_counts.entry(color_name).or_insert(0) += 1;
        }
    }

    let mut colorful_tags: Vec<(String, u32)> = color_counts
        .iter()
        .filter(|(name, _)| !matches!(name.as_str(), "black" | "white" | "gray"))
        .map(|(name, &count)| (name.clone(), count))
        .collect();

    colorful_tags.sort_by(|a, b| b.1.cmp(&a.1));

    if !colorful_tags.is_empty() {
        colorful_tags
            .into_iter()
            .take(2)
            .map(|(name, _)| name)
            .collect()
    } else {
        color_counts
            .into_iter()
            .max_by_key(|&(_, count)| count)
            .map(|(name, _)| vec![name])
            .unwrap_or_default()
    }
}

pub fn generate_tags_with_clip(
    image: &DynamicImage,
    clip_session_mutex: &Mutex<Session>,
    tokenizer: &Tokenizer,
) -> Result<Vec<String>> {
    let image_input = preprocess_clip_image(image);

    let text_inputs = TAG_CANDIDATES.to_vec();
    let encodings = tokenizer
        .encode_batch(text_inputs.clone(), true)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    let max_len = encodings
        .iter()
        .map(|e| e.get_ids().len())
        .max()
        .unwrap_or(0);

    let mut ids_data = Vec::new();
    let mut mask_data = Vec::new();
    for encoding in encodings {
        let mut ids = encoding
            .get_ids()
            .iter()
            .map(|&i| i as i64)
            .collect::<Vec<_>>();
        let mut mask = encoding
            .get_attention_mask()
            .iter()
            .map(|&m| m as i64)
            .collect::<Vec<_>>();
        ids.resize(max_len, 0);
        mask.resize(max_len, 0);
        ids_data.extend_from_slice(&ids);
        mask_data.extend_from_slice(&mask);
    }

    let ids_array = Array::from_shape_vec((text_inputs.len(), max_len), ids_data)?;
    let mask_array = Array::from_shape_vec((text_inputs.len(), max_len), mask_data)?;

    let image_input_dyn = image_input.into_dyn();
    let ids_array_dyn = ids_array.into_dyn();
    let mask_array_dyn = mask_array.into_dyn();

    let image_layout = image_input_dyn.as_standard_layout();
    let ids_layout = ids_array_dyn.as_standard_layout();
    let mask_layout = mask_array_dyn.as_standard_layout();

    let image_val = Tensor::from_array(image_layout.into_owned())?;
    let ids_val = Tensor::from_array(ids_layout.into_owned())?;
    let mask_val = Tensor::from_array(mask_layout.into_owned())?;

    let mut clip_session = clip_session_mutex.lock().unwrap();
    let outputs = clip_session.run(ort::inputs![ids_val, image_val, mask_val])?;

    let logits_dyn = outputs[0].try_extract_array::<f32>()?.to_owned();
    let logits = logits_dyn.into_dimensionality::<ndarray::Dim<[usize; 2]>>()?;
    let probs = softmax(&logits);

    let confidence_threshold = 0.005;
    let mut scored_tags: Vec<(String, f32)> = Vec::new();

    let prob_row = probs.row(0);
    for (i, &prob) in prob_row.iter().enumerate() {
        if prob > confidence_threshold {
            scored_tags.push((TAG_CANDIDATES[i].to_string(), prob));
        }
    }

    scored_tags.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let initial_tags: Vec<String> = scored_tags
        .into_iter()
        .take(10)
        .map(|(tag, _)| tag)
        .collect();

    let mut final_tags_set: HashSet<String> = initial_tags.iter().cloned().collect();

    let color_tags = extract_color_tags(image);
    for color_tag in color_tags {
        final_tags_set.insert(color_tag);
    }

    for tag in &initial_tags {
        if let Some(parents) = TAG_HIERARCHY.get(tag.as_str()) {
            for &parent in parents {
                final_tags_set.insert(parent.to_string());
            }
        }
    }

    let final_tags = final_tags_set.into_iter().collect();

    Ok(final_tags)
}

#[tauri::command]
pub async fn start_background_indexing(
    folder_path: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(handle) = state.indexing_task_handle.lock().unwrap().take() {
        println!("Cancelling previous indexing task.");
        handle.abort();
    }

    let settings = file_management::load_settings(app_handle.clone())?;
    if !settings.enable_ai_tagging.unwrap_or(false) {
        return Ok(());
    }

    let max_concurrent_tasks = settings.tagging_thread_count.unwrap_or(3).max(1) as usize;

    let models = crate::ai_processing::get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
    )
    .await
    .map_err(|e| e.to_string())?;

    let app_handle_clone = app_handle.clone();

    let task: JoinHandle<()> = tokio::spawn(async move {
        let _ = app_handle_clone.emit("indexing-started", ());
        println!("Starting background indexing for: {}", folder_path);
        println!(
            "Using {} concurrent threads for AI tagging.",
            max_concurrent_tasks
        );

        let state_clone = app_handle_clone.state::<AppState>();
        let gpu_context = crate::gpu_processing::get_or_init_gpu_context(&state_clone).ok();

        let image_paths: Vec<PathBuf> = match fs::read_dir(&folder_path) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && is_supported_image_file(&path.to_string_lossy()))
                .collect(),
            Err(e) => {
                eprintln!("Failed to read directory '{}': {}", folder_path, e);
                let _ = app_handle_clone
                    .emit("indexing-error", format!("Failed to read directory: {}", e));
                *app_handle_clone
                    .state::<AppState>()
                    .indexing_task_handle
                    .lock()
                    .unwrap() = None;
                return;
            }
        };

        println!(
            "Found {} images to process in {}",
            image_paths.len(),
            folder_path
        );
        let total_images = image_paths.len();
        let processed_count = Arc::new(Mutex::new(0));

        stream::iter(image_paths)
            .for_each_concurrent(max_concurrent_tasks, |path| {
                let app_handle_inner = app_handle_clone.clone();
                let models_inner = models.clone();
                let gpu_context_inner = gpu_context.clone();
                let processed_count_inner = Arc::clone(&processed_count);

                async move {
                    let path_str = path.to_string_lossy().to_string();
                    let (_, sidecar_path) = parse_virtual_path(&path_str);

                    let mut metadata: ImageMetadata = if sidecar_path.exists() {
                        fs::read_to_string(&sidecar_path)
                            .ok()
                            .and_then(|c| serde_json::from_str(&c).ok())
                            .unwrap_or_default()
                    } else {
                        ImageMetadata::default()
                    };

                    let should_generate_tags = match &metadata.tags {
                        None => true,
                        Some(tags) => {
                            !tags.iter().any(|tag| {
                                !tag.starts_with(COLOR_TAG_PREFIX) && !tag.starts_with(USER_TAG_PREFIX)
                            })
                        }
                    };

                    if should_generate_tags {
                        match file_management::get_cached_or_generate_thumbnail_image(
                            &path_str,
                            &app_handle_inner,
                            gpu_context_inner.as_ref(),
                        ) {
                            Ok(image) => {
                                if let (Some(clip_model), Some(clip_tokenizer)) =
                                    (&models_inner.clip_model, &models_inner.clip_tokenizer)
                                {
                                    if let Ok(ai_tags) =
                                        generate_tags_with_clip(&image, clip_model, clip_tokenizer)
                                    {
                                        println!("Found AI tags for {}: {:?}", path_str, ai_tags);

                                        let mut existing_tags: HashSet<String> = metadata
                                            .tags
                                            .unwrap_or_default()
                                            .into_iter()
                                            .collect();

                                        for tag in ai_tags {
                                            existing_tags.insert(tag);
                                        }

                                        let mut final_tags: Vec<String> = existing_tags.into_iter().collect();
                                        final_tags.sort_unstable();

                                        metadata.tags = Some(final_tags);

                                        if let Ok(json_string) =
                                            serde_json::to_string_pretty(&metadata)
                                        {
                                            let _ = fs::write(sidecar_path, json_string);
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!(
                                    "Could not get or generate image for tagging {}: {}",
                                    path_str, e
                                );
                            }
                        }
                    }

                    let mut count = processed_count_inner.lock().unwrap();
                    *count += 1;
                    let _ = app_handle_inner.emit(
                        "indexing-progress",
                        serde_json::json!({
                            "current": *count,
                            "total": total_images
                        }),
                    );
                }
            })
            .await;

        println!("Background indexing finished for: {}", folder_path);
        let _ = app_handle_clone.emit("indexing-finished", ());

        *app_handle_clone
            .state::<AppState>()
            .indexing_task_handle
            .lock()
            .unwrap() = None;
    });

    *state.indexing_task_handle.lock().unwrap() = Some(task);

    Ok(())
}

fn modify_tags_for_path(path_str: &str, modify_fn: impl Fn(&mut Vec<String>)) -> Result<(), String> {
    let (_, sidecar_path) = parse_virtual_path(path_str);

    let mut metadata: ImageMetadata = if sidecar_path.exists() {
        fs::read_to_string(&sidecar_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    } else {
        ImageMetadata::default()
    };

    let mut tags = metadata.tags.unwrap_or_else(Vec::new);
    modify_fn(&mut tags);

    tags.sort_unstable();
    tags.dedup();

    if tags.is_empty() {
        metadata.tags = None;
    } else {
        metadata.tags = Some(tags);
    }

    let json_string = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(sidecar_path, json_string).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_tag_for_paths(paths: Vec<String>, tag: String) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let tag_clone = tag.clone();
        if let Err(e) = modify_tags_for_path(path, |tags| {
            if !tags.contains(&tag_clone) {
                tags.push(tag_clone.clone());
            }
        }) {
            eprintln!("Failed to add tag to {}: {}", path, e);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn remove_tag_for_paths(paths: Vec<String>, tag: String) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let tag_clone = tag.clone();
        if let Err(e) = modify_tags_for_path(path, |tags| {
            tags.retain(|t| t != &tag_clone);
        }) {
            eprintln!("Failed to remove tag from {}: {}", path, e);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn clear_ai_tags(root_path: String) -> Result<usize, String> {
    if !Path::new(&root_path).exists() {
        return Err(format!("Root path does not exist: {}", root_path));
    }

    let mut updated_count = 0;
    let walker = WalkDir::new(root_path).into_iter();

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("rrdata") {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(mut metadata) = serde_json::from_str::<ImageMetadata>(&content) {
                    if let Some(tags) = &mut metadata.tags {
                        let original_len = tags.len();
                        // Keep color tags and user tags, remove others (AI tags)
                        tags.retain(|tag| {
                            tag.starts_with(COLOR_TAG_PREFIX) || tag.starts_with(USER_TAG_PREFIX)
                        });

                        if tags.len() < original_len {
                            if tags.is_empty() {
                                metadata.tags = None;
                            }
                            if let Ok(json_string) = serde_json::to_string_pretty(&metadata) {
                                if fs::write(path, json_string).is_ok() {
                                    updated_count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(updated_count)
}

#[tauri::command]
pub fn clear_all_tags(root_path: String) -> Result<usize, String> {
    if !Path::new(&root_path).exists() {
        return Err(format!("Root path does not exist: {}", root_path));
    }

    let mut updated_count = 0;
    let walker = WalkDir::new(root_path).into_iter();

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("rrdata") {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(mut metadata) = serde_json::from_str::<ImageMetadata>(&content) {
                    if let Some(tags) = &mut metadata.tags {
                        let original_len = tags.len();
                        // Keep only color tags, remove AI and user tags
                        tags.retain(|tag| tag.starts_with(COLOR_TAG_PREFIX));

                        if tags.len() < original_len {
                            if tags.is_empty() {
                                metadata.tags = None;
                            }
                            if let Ok(json_string) = serde_json::to_string_pretty(&metadata) {
                                if fs::write(path, json_string).is_ok() {
                                    updated_count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(updated_count)
}