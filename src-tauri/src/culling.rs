use crate::app_settings::load_settings;
use image::{GenericImageView, GrayImage, imageops};
use image_hasher::{HashAlg, HasherConfig};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::image_loader;

static CULLING_GENERATION: AtomicUsize = AtomicUsize::new(0);

#[tauri::command]
pub fn cancel_culling() {
    CULLING_GENERATION.fetch_add(1, Ordering::Relaxed);
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CullingSettings {
    pub similarity_threshold: u32,
    pub blur_threshold: f64,
    pub group_similar: bool,
    pub filter_blurry: bool,
    #[serde(default = "default_burst_window")]
    pub burst_window_seconds: u32,
}

fn default_burst_window() -> u32 {
    5
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysisResult {
    pub path: String,
    pub quality_score: f64,
    pub sharpness_metric: f64,
    pub center_focus_metric: f64,
    pub exposure_metric: f64,
    pub width: u32,
    pub height: u32,
    pub capture_time: Option<i64>,
    pub camera_identity: Option<String>,
    pub analysis_source: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CullGroup {
    pub id: String,
    pub reasons: Vec<String>,
    pub representative: ImageAnalysisResult,
    pub duplicates: Vec<ImageAnalysisResult>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CullingSuggestions {
    pub similar_groups: Vec<CullGroup>,
    pub blurry_images: Vec<ImageAnalysisResult>,
    pub failed_paths: Vec<String>,
}

#[derive(Serialize, Clone)]
struct CullingProgress {
    current: usize,
    total: usize,
    stage: String,
}

struct ImageAnalysisData {
    hash: image_hasher::ImageHash,
    result: ImageAnalysisResult,
}

const WEIGHT_SHARPNESS: f64 = 0.80;
const WEIGHT_EXPOSURE: f64 = 0.20;

fn capture_metadata(exif: &HashMap<String, String>) -> (Option<i64>, Option<String>) {
    let time = exif.get("DateTimeOriginal").and_then(|value| {
        ["%Y-%m-%d %H:%M:%S%.f", "%Y:%m:%d %H:%M:%S%.f"]
            .into_iter()
            .find_map(|format| {
                chrono::NaiveDateTime::parse_from_str(value.trim_matches('"'), format).ok()
            })
            .map(|value| value.and_utc().timestamp_millis())
    });
    let camera = exif
        .get("Model")
        .filter(|model| !model.trim().is_empty())
        .map(|model| {
            format!(
                "{}|{}|{}",
                exif.get("Make").map(String::as_str).unwrap_or(""),
                model,
                exif.get("BodySerialNumber")
                    .or_else(|| exif.get("SerialNumber"))
                    .map(String::as_str)
                    .unwrap_or("")
            )
        });
    (time, camera)
}

fn group_similar_images(
    analyses: &[ImageAnalysisData],
    settings: &CullingSettings,
) -> Vec<CullGroup> {
    let mut order: Vec<usize> = (0..analyses.len()).collect();
    order.sort_by(|&a, &b| {
        let a = &analyses[a].result;
        let b = &analyses[b].result;
        (&a.camera_identity, a.capture_time, &a.path).cmp(&(
            &b.camera_identity,
            b.capture_time,
            &b.path,
        ))
    });
    let mut grouped = vec![false; analyses.len()];
    let mut groups = Vec::new();
    let window = u64::from(settings.burst_window_seconds.clamp(1, 60)) * 1000;
    for (position, &seed) in order.iter().enumerate() {
        let reference = &analyses[seed];
        let Some(time) = reference.result.capture_time else {
            continue;
        };
        if grouped[seed]
            || reference.result.camera_identity.is_none()
            || reference.result.path.contains("?vc=")
        {
            continue;
        }
        let mut members = vec![seed];
        for &candidate in order.iter().skip(position + 1).take(64) {
            let item = &analyses[candidate];
            if item.result.camera_identity != reference.result.camera_identity {
                break;
            }
            let Some(candidate_time) = item.result.capture_time else {
                continue;
            };
            if time.abs_diff(candidate_time) > window {
                break;
            }
            if grouped[candidate] || item.result.path.contains("?vc=") {
                continue;
            }
            if reference.hash.dist(&item.hash) <= settings.similarity_threshold {
                members.push(candidate);
            }
        }
        if members.len() < 2 {
            continue;
        }
        for &member in &members {
            grouped[member] = true;
        }
        let mut group_hash = blake3::Hasher::new();
        for &member in &members {
            group_hash.update(analyses[member].result.path.as_bytes());
            group_hash.update(&[0]);
        }
        members.sort_by(|&a, &b| {
            analyses[b]
                .result
                .quality_score
                .total_cmp(&analyses[a].result.quality_score)
        });
        let best = &analyses[members[0]].result;
        let mut reasons = Vec::new();
        if members[1..]
            .iter()
            .any(|&index| analyses[index].result.sharpness_metric < best.sharpness_metric)
        {
            reasons.push("detail".to_string());
        }
        if members[1..]
            .iter()
            .any(|&index| analyses[index].result.exposure_metric < best.exposure_metric)
        {
            reasons.push("exposure".to_string());
        }
        groups.push(CullGroup {
            id: group_hash.finalize().to_hex().to_string(),
            reasons,
            representative: best.clone(),
            duplicates: members[1..]
                .iter()
                .map(|&index| analyses[index].result.clone())
                .collect(),
        });
    }
    groups
}

fn calculate_laplacian_variance(image: &GrayImage) -> f64 {
    let (width, height) = image.dimensions();
    if width < 3 || height < 3 {
        return 0.0;
    }

    let mut laplacian_values = Vec::with_capacity(((width - 2) * (height - 2)) as usize);
    let mut sum = 0.0;

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let p_center = image.get_pixel(x, y)[0] as i32;
            let p_north = image.get_pixel(x, y - 1)[0] as i32;
            let p_south = image.get_pixel(x, y + 1)[0] as i32;
            let p_west = image.get_pixel(x - 1, y)[0] as i32;
            let p_east = image.get_pixel(x + 1, y)[0] as i32;
            let conv_val = (p_north + p_south + p_west + p_east - 4 * p_center) as f64;
            laplacian_values.push(conv_val);
            sum += conv_val;
        }
    }

    if laplacian_values.is_empty() {
        return 0.0;
    }
    let mean = sum / laplacian_values.len() as f64;

    laplacian_values
        .iter()
        .map(|v| (v - mean).powi(2))
        .sum::<f64>()
        / laplacian_values.len() as f64
}

fn calculate_exposure_metric(image: &GrayImage) -> f64 {
    let histogram = imageproc::stats::histogram(image);
    let total_pixels = (image.width() * image.height()) as f64;
    if total_pixels == 0.0 {
        return 0.0;
    }

    let clip_threshold_dark = 5;
    let clip_threshold_bright = 250;

    let dark_pixels = histogram.channels[0][0..clip_threshold_dark]
        .iter()
        .sum::<u32>() as f64;
    let bright_pixels = histogram.channels[0][clip_threshold_bright..256]
        .iter()
        .sum::<u32>() as f64;

    let dark_clip_ratio = dark_pixels / total_pixels;
    let bright_clip_ratio = bright_pixels / total_pixels;

    let penalty = (dark_clip_ratio * 5.0) + (bright_clip_ratio * 5.0);

    (1.0f64 - penalty).max(0.0)
}

fn analyze_image(
    path: &str,
    hasher: &image_hasher::Hasher,
    settings: &crate::app_settings::AppSettings,
    source_reader: &Mutex<()>,
    generation: usize,
) -> Result<ImageAnalysisData, String> {
    const ANALYSIS_DIM: u32 = 720;

    if crate::file_management::is_cloud_placeholder(Path::new(path)) {
        return Err(format!("'{}' is stored in iCloud and not downloaded", path));
    }

    let (source_path, _) = crate::file_management::parse_virtual_path(path);
    let file_bytes = {
        let _guard = source_reader.lock().map_err(|error| error.to_string())?;
        if CULLING_GENERATION.load(Ordering::Relaxed) != generation {
            return Err("Culling cancelled".to_string());
        }
        std::fs::read(&source_path).map_err(|e| e.to_string())?
    };
    let physical_path = source_path.to_string_lossy();
    let exif = crate::exif_processing::read_exif_data_from_bytes(&physical_path, &file_bytes);
    let (capture_time, camera_identity) = capture_metadata(&exif);

    let (img, analysis_source) = if let Some(preview) =
        image_loader::safe_embedded_preview_fallback(&file_bytes, &physical_path)
    {
        (preview, "embeddedPreview")
    } else {
        (
            image_loader::load_base_image_from_bytes(
                &file_bytes,
                &physical_path,
                true,
                settings,
                None,
            )
            .map_err(|e| e.to_string())?,
            "decodedImage",
        )
    };

    let (width, height) = img.dimensions();
    let thumbnail = img.thumbnail(ANALYSIS_DIM, ANALYSIS_DIM);
    let gray_thumbnail = thumbnail.to_luma8();

    let sharpness_metric = calculate_laplacian_variance(&gray_thumbnail);
    let exposure_metric = calculate_exposure_metric(&gray_thumbnail);

    let (thumb_w, thumb_h) = gray_thumbnail.dimensions();
    let center_crop = imageops::crop_imm(
        &gray_thumbnail,
        thumb_w / 4,
        thumb_h / 4,
        thumb_w / 2,
        thumb_h / 2,
    )
    .to_image();
    let center_focus_metric = calculate_laplacian_variance(&center_crop);

    let normalized_sharpness = ((sharpness_metric + 1.0).log10() / 3.5).min(1.0);
    let quality_score =
        (normalized_sharpness * WEIGHT_SHARPNESS) + (exposure_metric * WEIGHT_EXPOSURE);

    let hash = hasher.hash_image(&thumbnail);

    Ok(ImageAnalysisData {
        hash,
        result: ImageAnalysisResult {
            path: path.to_string(),
            quality_score,
            sharpness_metric,
            center_focus_metric,
            exposure_metric,
            width,
            height,
            capture_time,
            camera_identity,
            analysis_source: analysis_source.to_string(),
        },
    })
}

#[tauri::command]
pub async fn cull_images(
    paths: Vec<String>,
    settings: CullingSettings,
    app_handle: AppHandle,
) -> Result<CullingSuggestions, String> {
    if paths.is_empty() {
        return Ok(CullingSuggestions::default());
    }

    let generation = CULLING_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        run_culling(paths, settings, app_handle, generation)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn run_culling(
    paths: Vec<String>,
    settings: CullingSettings,
    app_handle: AppHandle,
    generation: usize,
) -> Result<CullingSuggestions, String> {
    let app_settings = load_settings(app_handle.clone()).unwrap_or_default();

    let total_count = paths.len();
    let completed_count = Arc::new(AtomicUsize::new(0));
    let source_reader = Mutex::new(());
    let _ = app_handle.emit("culling-start", total_count);

    let hasher = HasherConfig::new()
        .hash_alg(HashAlg::DoubleGradient)
        .hash_size(16, 16)
        .to_hasher();

    let analysis_results: Vec<Result<ImageAnalysisData, (String, String)>> = paths
        .par_iter()
        .map(|path| {
            let result = analyze_image(path, &hasher, &app_settings, &source_reader, generation)
                .map_err(|e| (path.to_string(), e));
            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            if CULLING_GENERATION.load(Ordering::Relaxed) == generation {
                let _ = app_handle.emit(
                    "culling-progress",
                    CullingProgress {
                        current: completed,
                        total: total_count,
                        stage: "Analyzing images...".to_string(),
                    },
                );
            }

            result
        })
        .collect();

    if CULLING_GENERATION.load(Ordering::Relaxed) != generation {
        return Err("Culling cancelled".to_string());
    }

    let mut successful_analyses = Vec::new();
    let mut failed_paths = Vec::new();
    for res in analysis_results {
        match res {
            Ok(data) => successful_analyses.push(data),
            Err((path, error)) => {
                eprintln!("Failed to analyze image {}: {}", path, error);
                failed_paths.push(path);
            }
        }
    }

    let _ = app_handle.emit(
        "culling-progress",
        CullingProgress {
            current: total_count,
            total: total_count,
            stage: "Grouping similar images...".to_string(),
        },
    );

    let mut suggestions = CullingSuggestions {
        failed_paths,
        ..Default::default()
    };
    if settings.group_similar {
        suggestions.similar_groups = group_similar_images(&successful_analyses, &settings);
    }

    if settings.filter_blurry {
        let grouped_paths: std::collections::HashSet<&str> = suggestions
            .similar_groups
            .iter()
            .flat_map(|group| std::iter::once(&group.representative).chain(group.duplicates.iter()))
            .map(|image| image.path.as_str())
            .collect();
        for item in &successful_analyses {
            if !grouped_paths.contains(item.result.path.as_str())
                && item.result.sharpness_metric < settings.blur_threshold
            {
                suggestions.blurry_images.push(item.result.clone());
            }
        }
        suggestions.blurry_images.sort_by(|a, b| {
            a.sharpness_metric
                .partial_cmp(&b.sharpness_metric)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    if CULLING_GENERATION.load(Ordering::Relaxed) != generation {
        return Err("Culling cancelled".to_string());
    }
    let _ = app_handle.emit("culling-complete", &suggestions);
    Ok(suggestions)
}
