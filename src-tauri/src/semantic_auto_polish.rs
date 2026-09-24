use crate::AppState;
use crate::color_matcher::{calculate_skin_presence_ratio, srgb_to_oklab};
use crate::defect_repair::detect_horizon_angle;
use crate::exif_processing::load_sidecar;
use crate::file_management::{parse_virtual_path, read_file_mapped, sync_metadata_to_xmp};
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::{perform_auto_analysis, AutoAdjustmentResults};
use image::{DynamicImage, GenericImageView};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SemanticScene {
    Portrait,
    Animal,
    Architecture,
    Landscape,
    Sunset,
    Overcast,
    NightSky,
    Macro,
    General,
}

impl SemanticScene {
    pub fn display_name(&self) -> &'static str {
        match self {
            SemanticScene::Portrait => "👤 Portrait & People",
            SemanticScene::Animal => "🐾 Pets & Wildlife",
            SemanticScene::Architecture => "🏛️ Architecture & Urban",
            SemanticScene::Landscape => "🌲 Landscape & Nature",
            SemanticScene::Sunset => "🌅 Sunset & Golden Hour",
            SemanticScene::Overcast => "☁️ Overcast & Moody",
            SemanticScene::NightSky => "🪐 Night Sky & Astro",
            SemanticScene::Macro => "🌸 Macro & Close-up",
            SemanticScene::General => "✨ Universal Balanced",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToneCurveStyle {
    FilmicDynamic,
    PunchyCommercial,
    NaturalSoft,
}

impl Default for ToneCurveStyle {
    fn default() -> Self {
        ToneCurveStyle::FilmicDynamic
    }
}

impl ToneCurveStyle {
    pub fn from_str_opt(s: Option<&str>) -> Self {
        match s.map(|v| v.to_lowercase()).as_deref() {
            Some("punchy") | Some("punchycommercial") => ToneCurveStyle::PunchyCommercial,
            Some("soft") | Some("naturalsoft") => ToneCurveStyle::NaturalSoft,
            _ => ToneCurveStyle::FilmicDynamic,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticAnalysisResult {
    pub scene: SemanticScene,
    pub scene_name: String,
    pub confidence: f32,
    pub horizon_angle: Option<f32>,
    pub adjustments: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchPolishSummary {
    pub total_processed: usize,
    pub total_clusters: usize,
    pub scene_breakdown: std::collections::HashMap<String, usize>,
    pub elapsed_ms: u64,
}

/// Computes fast Laplacian edge variance to measure focus and sharpness
fn compute_fast_sharpness(thumb: &image::RgbImage) -> f32 {
    let (w, h) = thumb.dimensions();
    if w < 10 || h < 10 {
        return 0.0;
    }

    let mut sum = 0.0f64;
    let mut sq_sum = 0.0f64;
    let mut count = 0.0f64;

    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let p = thumb.get_pixel(x, y);
            let c = 0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64;
            let up_p = thumb.get_pixel(x, y - 1);
            let up = 0.2126 * up_p[0] as f64 + 0.7152 * up_p[1] as f64 + 0.0722 * up_p[2] as f64;
            let dn_p = thumb.get_pixel(x, y + 1);
            let dn = 0.2126 * dn_p[0] as f64 + 0.7152 * dn_p[1] as f64 + 0.0722 * dn_p[2] as f64;
            let lf_p = thumb.get_pixel(x - 1, y);
            let lf = 0.2126 * lf_p[0] as f64 + 0.7152 * lf_p[1] as f64 + 0.0722 * lf_p[2] as f64;
            let rt_p = thumb.get_pixel(x + 1, y);
            let rt = 0.2126 * rt_p[0] as f64 + 0.7152 * rt_p[1] as f64 + 0.0722 * rt_p[2] as f64;

            let lap = (4.0 * c - up - dn - lf - rt).abs();
            sum += lap;
            sq_sum += lap * lap;
            count += 1.0;
        }
    }

    if count == 0.0 {
        return 0.0;
    }
    let mean = sum / count;
    let var = (sq_sum / count) - (mean * mean);
    (var.max(0.0).sqrt() as f32).clamp(0.0, 100.0)
}

/// Analyzes an image thumbnail to determine its dominant photographic scene and subject type
pub fn detect_semantic_scene(image: &DynamicImage) -> (SemanticScene, f32) {
    let (width, height) = image.dimensions();
    if width < 32 || height < 32 {
        return (SemanticScene::General, 0.5);
    }

    let thumb = image.thumbnail(320, 320).to_rgb8();
    let (tw, th) = thumb.dimensions();
    let total_pixels = (tw * th) as f32;

    let mut green_vegetation_pixels = 0.0f32;
    let mut blue_sky_pixels = 0.0f32;
    let mut sunset_warm_pixels = 0.0f32;
    let mut deep_dark_pixels = 0.0f32;
    let mut high_contrast_edges = 0.0f32;
    let mut macro_center_detail = 0.0f32;

    let center_x1 = tw / 4;
    let center_x2 = tw * 3 / 4;
    let center_y1 = th / 4;
    let center_y2 = th * 3 / 4;

    for y in 0..th {
        for x in 0..tw {
            let p = thumb.get_pixel(x, y);
            let r = p[0] as f32;
            let g = p[1] as f32;
            let b = p[2] as f32;

            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

            // Night Sky detection
            if luma < 25.0 {
                deep_dark_pixels += 1.0;
            }

            // Green / Foliage detection
            if g > r * 1.15 && g > b * 1.15 && luma > 30.0 {
                green_vegetation_pixels += 1.0;
            }

            // Sky detection (top half biased)
            if y < th / 2 && b > r * 1.15 && b > g * 0.95 && luma > 60.0 {
                blue_sky_pixels += 1.0;
            }

            // Sunset / Golden Hour detection (high red/amber with warm glow)
            if r > g * 1.25 && g > b * 1.35 && luma > 50.0 {
                sunset_warm_pixels += 1.0;
            }

            // Edge density check
            if x > 0 && y > 0 && x < tw - 1 && y < th - 1 {
                let left_p = thumb.get_pixel(x - 1, y);
                let diff = (r - left_p[0] as f32).abs() + (g - left_p[1] as f32).abs();
                if diff > 35.0 {
                    high_contrast_edges += 1.0;
                    if x >= center_x1 && x <= center_x2 && y >= center_y1 && y <= center_y2 {
                        macro_center_detail += 1.0;
                    }
                }
            }
        }
    }

    let skin_ratio = calculate_skin_presence_ratio(&thumb);
    let green_ratio = green_vegetation_pixels / total_pixels;
    let sky_ratio = blue_sky_pixels / (total_pixels * 0.5);
    let sunset_ratio = sunset_warm_pixels / total_pixels;
    let dark_ratio = deep_dark_pixels / total_pixels;
    let edge_ratio = high_contrast_edges / total_pixels;
    let center_edge_ratio = macro_center_detail / (total_pixels * 0.25);

    // Rule-based classifier with high confidence scoring
    if dark_ratio > 0.45 && sunset_ratio < 0.05 {
        let confidence = (dark_ratio * 1.4).min(0.95);
        (SemanticScene::NightSky, confidence)
    } else if sunset_ratio > 0.15 {
        let confidence = (sunset_ratio * 2.5).clamp(0.65, 0.96);
        (SemanticScene::Sunset, confidence)
    } else if skin_ratio > 0.07 {
        let confidence = (skin_ratio * 3.5).clamp(0.60, 0.98);
        (SemanticScene::Portrait, confidence)
    } else if green_ratio > 0.20 || (green_ratio > 0.12 && sky_ratio > 0.15) {
        let confidence = ((green_ratio + sky_ratio) * 1.5).clamp(0.60, 0.95);
        (SemanticScene::Landscape, confidence)
    } else if sky_ratio < 0.05 && green_ratio < 0.05 && edge_ratio > 0.18 {
        let confidence = (edge_ratio * 2.2).clamp(0.55, 0.90);
        (SemanticScene::Architecture, confidence)
    } else if center_edge_ratio > 0.22 && edge_ratio < 0.12 {
        let confidence = (center_edge_ratio * 1.8).clamp(0.55, 0.88);
        (SemanticScene::Macro, confidence)
    } else if edge_ratio > 0.12 && skin_ratio > 0.02 {
        (SemanticScene::Animal, 0.68)
    } else if sky_ratio < 0.08 && luma_contrast(&thumb) < 35.0 {
        (SemanticScene::Overcast, 0.72)
    } else {
        (SemanticScene::General, 0.60)
    }
}

fn luma_contrast(img: &image::RgbImage) -> f32 {
    let mut min_luma = 255.0f32;
    let mut max_luma = 0.0f32;
    for p in img.pixels() {
        let luma = 0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32;
        min_luma = min_luma.min(luma);
        max_luma = max_luma.max(luma);
    }
    max_luma - min_luma
}

/// Generates tailored photographic adjustments for the detected semantic scene scaled by intensity
pub fn generate_semantic_adjustments(
    scene: SemanticScene,
    base: &AutoAdjustmentResults,
    intensity: f32,
    horizon_angle: Option<f32>,
    tone_style: Option<ToneCurveStyle>,
    skin_protection: Option<bool>,
) -> serde_json::Value {
    let mult = (intensity / 100.0).clamp(0.0, 2.0);
    let curve_style = tone_style.unwrap_or_default();
    let protect_skin = skin_protection.unwrap_or(true);

    let mut exposure = base.exposure * 0.9 * mult as f64;
    let mut contrast = base.contrast * mult as f64;
    let mut highlights = base.highlights * mult as f64;
    let mut shadows = base.shadows * mult as f64;
    let mut whites = base.whites * mult as f64;
    let mut blacks = base.blacks * mult as f64;
    let mut clarity = base.clarity * mult as f64;
    let mut dehaze = base.dehaze * mult as f64;
    let mut temperature = base.temperature * mult as f64;
    let mut tint = base.tint * mult as f64;
    let mut vibrance = base.vibrancy * mult as f64;
    let mut sharpening = 28.0 * mult as f64;
    let mut sharpness_threshold = 20.0 * mult as f64;
    let mut color_noise_reduction = 25.0 * mult as f64;
    let mut luma_noise_reduction = 10.0 * mult as f64;

    // Specialized scene treatments
    match scene {
        SemanticScene::Portrait => {
            contrast = (contrast * 0.85).max(8.0);
            highlights = (highlights - 18.0 * mult as f64).min(-10.0);
            shadows = (shadows + 14.0 * mult as f64).max(10.0);
            whites = (whites + 10.0 * mult as f64).max(8.0);
            clarity = (clarity - 6.0 * mult as f64).min(2.0);
            sharpening = 25.0 * mult as f64;
            vibrance = if protect_skin {
                (vibrance + 4.0 * mult as f64).clamp(0.0, 14.0)
            } else {
                (vibrance + 8.0 * mult as f64).min(20.0)
            };
            temperature = (temperature + 1.5 * mult as f64).min(5.0);
            color_noise_reduction = 28.0 * mult as f64;
        }
        SemanticScene::Animal => {
            clarity = (clarity + 18.0 * mult as f64).max(14.0);
            sharpening = 40.0 * mult as f64;
            sharpness_threshold = 15.0 * mult as f64;
            whites = (whites + 12.0 * mult as f64).max(10.0);
            blacks = (blacks - 10.0 * mult as f64).min(-8.0);
            vibrance = (vibrance + 12.0 * mult as f64).max(10.0);
        }
        SemanticScene::Architecture => {
            contrast = (contrast + 12.0 * mult as f64).max(15.0);
            clarity = (clarity + 22.0 * mult as f64).max(18.0);
            dehaze = (dehaze + 14.0 * mult as f64).max(10.0);
            highlights = (highlights - 15.0 * mult as f64).min(-10.0);
            whites = (whites + 15.0 * mult as f64).max(12.0);
            blacks = (blacks - 14.0 * mult as f64).min(-12.0);
            sharpening = 35.0 * mult as f64;
        }
        SemanticScene::Landscape => {
            contrast = (contrast + 14.0 * mult as f64).max(16.0);
            highlights = (highlights - 22.0 * mult as f64).min(-15.0);
            shadows = (shadows + 20.0 * mult as f64).max(15.0);
            whites = (whites + 14.0 * mult as f64).max(12.0);
            blacks = (blacks - 16.0 * mult as f64).min(-14.0);
            clarity = (clarity + 16.0 * mult as f64).max(12.0);
            dehaze = (dehaze + 16.0 * mult as f64).max(12.0);
            vibrance = (vibrance + 18.0 * mult as f64).max(14.0);
            sharpening = 36.0 * mult as f64;
        }
        SemanticScene::Sunset => {
            exposure = (exposure + 0.15 * mult as f64).min(0.8);
            contrast = (contrast + 10.0 * mult as f64).max(14.0);
            highlights = (highlights - 28.0 * mult as f64).min(-20.0);
            shadows = (shadows + 22.0 * mult as f64).max(16.0);
            whites = (whites + 8.0 * mult as f64).max(6.0);
            blacks = (blacks - 12.0 * mult as f64).min(-10.0);
            temperature = (temperature + 8.0 * mult as f64).max(6.0);
            tint = (tint + 4.0 * mult as f64).max(2.0);
            vibrance = (vibrance + 16.0 * mult as f64).max(12.0);
            clarity = (clarity + 12.0 * mult as f64).max(8.0);
        }
        SemanticScene::Overcast => {
            contrast = (contrast + 16.0 * mult as f64).max(18.0);
            clarity = (clarity + 24.0 * mult as f64).max(18.0);
            dehaze = (dehaze + 22.0 * mult as f64).max(16.0);
            whites = (whites + 18.0 * mult as f64).max(14.0);
            blacks = (blacks - 16.0 * mult as f64).min(-12.0);
            temperature = (temperature + 4.0 * mult as f64).max(2.0);
            vibrance = (vibrance + 14.0 * mult as f64).max(10.0);
        }
        SemanticScene::NightSky => {
            contrast = (contrast + 22.0 * mult as f64).max(20.0);
            highlights = (highlights - 20.0 * mult as f64).min(-16.0);
            whites = (whites + 18.0 * mult as f64).max(16.0);
            shadows = (shadows + 16.0 * mult as f64).max(12.0);
            blacks = (blacks - 20.0 * mult as f64).min(-18.0);
            temperature = (temperature - 8.0 * mult as f64).min(-6.0);
            tint = (tint + 10.0 * mult as f64).max(8.0);
            clarity = (clarity + 22.0 * mult as f64).max(18.0);
            dehaze = (dehaze + 24.0 * mult as f64).max(20.0);
            sharpening = 36.0 * mult as f64;
            sharpness_threshold = 60.0 * mult as f64;
            color_noise_reduction = 48.0 * mult as f64;
            luma_noise_reduction = 30.0 * mult as f64;
        }
        SemanticScene::Macro => {
            contrast = (contrast + 14.0 * mult as f64).max(15.0);
            highlights = (highlights - 24.0 * mult as f64).min(-18.0);
            whites = (whites + 14.0 * mult as f64).max(12.0);
            shadows = (shadows + 18.0 * mult as f64).max(14.0);
            clarity = (clarity + 20.0 * mult as f64).max(16.0);
            sharpening = 38.0 * mult as f64;
            sharpness_threshold = 25.0 * mult as f64;
            vibrance = (vibrance + 14.0 * mult as f64).max(12.0);
        }
        SemanticScene::General => {
            sharpening = 30.0 * mult as f64;
        }
    }

    // Tone Curve Profile modifier
    match curve_style {
        ToneCurveStyle::FilmicDynamic => {
            highlights = (highlights - 6.0).min(-8.0);
            shadows = (shadows + 6.0).max(8.0);
            contrast = (contrast * 0.95).clamp(-30.0, 30.0);
        }
        ToneCurveStyle::PunchyCommercial => {
            contrast = (contrast * 1.25 + 6.0).clamp(-40.0, 45.0);
            blacks = (blacks - 6.0).min(-8.0);
            clarity = (clarity + 8.0).clamp(-20.0, 35.0);
            vibrance = (vibrance + 6.0).clamp(-20.0, 35.0);
        }
        ToneCurveStyle::NaturalSoft => {
            contrast = (contrast * 0.75 - 4.0).clamp(-20.0, 20.0);
            highlights = (highlights - 4.0).min(-6.0);
            clarity = (clarity * 0.7).clamp(-10.0, 10.0);
        }
    }

    let mut json = serde_json::json!({
        "exposure": exposure,
        "contrast": contrast,
        "highlights": highlights,
        "shadows": shadows,
        "whites": whites,
        "blacks": blacks,
        "clarity": clarity,
        "dehaze": dehaze,
        "temperature": temperature,
        "tint": tint,
        "vibrance": vibrance,
        "sharpening": sharpening,
        "sharpnessThreshold": sharpness_threshold,
        "colorNoiseReduction": color_noise_reduction,
        "lumaNoiseReduction": luma_noise_reduction,
        "luminanceDenoise": luma_noise_reduction,
        "sectionVisibility": {
            "basic": true,
            "color": true,
            "detail": true,
            "effects": true
        }
    });

    if let Some(angle) = horizon_angle {
        if angle.abs() > 0.3 && angle.abs() < 10.0 {
            json["rotationAngle"] = serde_json::json!(-angle);
        }
    }

    json
}

#[derive(Debug, Clone)]
struct PreScannedImage {
    pub path_str: String,
    pub timestamp_epoch: u64,
    pub scene: SemanticScene,
    pub base_analysis: AutoAdjustmentResults,
    pub sharpness: f32,
    pub mean_luma: f32,
    pub mean_ok_a: f32,
    pub mean_ok_b: f32,
    pub horizon_angle: Option<f32>,
}

#[tauri::command]
pub fn analyze_and_polish_active_image(
    intensity: Option<f32>,
    auto_straighten: Option<bool>,
    tone_style: Option<String>,
    skin_protection: Option<bool>,
    state: State<AppState>,
) -> Result<SemanticAnalysisResult, String> {
    let intensity_val = intensity.unwrap_or(100.0);
    let straighten = auto_straighten.unwrap_or(true);
    let style = ToneCurveStyle::from_str_opt(tone_style.as_deref());

    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded_image) = &*orig_guard {
        let (scene, confidence) = detect_semantic_scene(&loaded_image.image);
        let base_analysis = perform_auto_analysis(&loaded_image.image);

        let horizon_angle = if straighten {
            let horizon = detect_horizon_angle(&loaded_image.image);
            if horizon.confidence > 0.35 {
                Some(horizon.angle_degrees)
            } else {
                None
            }
        } else {
            None
        };

        let adjustments = generate_semantic_adjustments(
            scene,
            &base_analysis,
            intensity_val,
            horizon_angle,
            Some(style),
            skin_protection,
        );

        Ok(SemanticAnalysisResult {
            scene,
            scene_name: scene.display_name().to_string(),
            confidence,
            horizon_angle,
            adjustments,
        })
    } else {
        Err("No active image loaded".to_string())
    }
}

#[tauri::command]
pub async fn batch_polish_photoshoot(
    paths: Vec<String>,
    intensity: Option<f32>,
    harmonize: Option<bool>,
    auto_straighten: Option<bool>,
    enable_xmp_sync: Option<bool>,
    tone_style: Option<String>,
    skin_protection: Option<bool>,
    app_handle: AppHandle,
    _state: State<'_, AppState>,
) -> Result<BatchPolishSummary, String> {
    if paths.is_empty() {
        return Err("No photos provided for batch polish".to_string());
    }

    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("batch_polish_photoshoot");
    let start_time = std::time::Instant::now();
    let intensity_val = intensity.unwrap_or(100.0);
    let do_harmonize = harmonize.unwrap_or(true);
    let straighten = auto_straighten.unwrap_or(true);
    let sync_xmp = enable_xmp_sync.unwrap_or(false);
    let style = ToneCurveStyle::from_str_opt(tone_style.as_deref());
    let protect_skin = skin_protection.unwrap_or(true);
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();

    let total = paths.len();
    let processed_counter = Arc::new(AtomicUsize::new(0));

    let _ = app_handle.emit(
        "batch-polish-progress",
        serde_json::json!({
            "current": 0,
            "total": total,
            "message": format!("Pre-scanning and clustering {} photos...", total),
            "percentage": 0.0
        }),
    );

    let app_handle_clone = app_handle.clone();
    let paths_clone = paths.clone();

    let (scene_breakdown, total_success, cluster_count) = tokio::task::spawn_blocking(move || {
        // Stage 1: Parallel Pre-Scan
        let pre_scanned: Vec<Option<PreScannedImage>> = paths_clone
            .par_iter()
            .map(|path_str| {
                let (source_path, _) = parse_virtual_path(path_str);
                let file_bytes = match read_file_mapped(&source_path) {
                    Ok(b) => b,
                    Err(e) => {
                        log::warn!("[BatchPolish] Failed to read file {}: {}", path_str, e);
                        return None;
                    }
                };

                let image = match load_base_image_from_bytes(
                    &file_bytes,
                    &source_path.to_string_lossy(),
                    true,
                    &settings,
                    None,
                ) {
                    Ok(img) => img,
                    Err(e) => {
                        log::warn!("[BatchPolish] Failed to decode image {}: {}", path_str, e);
                        return None;
                    }
                };

                let thumb = image.thumbnail(256, 256).to_rgb8();
                let sharpness = compute_fast_sharpness(&thumb);
                let (scene, _) = detect_semantic_scene(&image);
                let base_analysis = perform_auto_analysis(&image);

                let mut sum_luma = 0.0f32;
                let mut sum_ok_a = 0.0f32;
                let mut sum_ok_b = 0.0f32;
                let n = (thumb.width() * thumb.height()) as f32;

                for p in thumb.pixels() {
                    let r = p[0] as f32;
                    let g = p[1] as f32;
                    let b = p[2] as f32;
                    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    let (_, ok_a, ok_b) = srgb_to_oklab(r, g, b);
                    sum_luma += luma;
                    sum_ok_a += ok_a;
                    sum_ok_b += ok_b;
                }

                let mean_luma = if n > 0.0 { sum_luma / n } else { 128.0 };
                let mean_ok_a = if n > 0.0 { sum_ok_a / n } else { 0.0 };
                let mean_ok_b = if n > 0.0 { sum_ok_b / n } else { 0.0 };

                let timestamp_epoch = match fs::metadata(&source_path) {
                    Ok(meta) => meta
                        .modified()
                        .unwrap_or(SystemTime::UNIX_EPOCH)
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                    Err(_) => 0,
                };

                let horizon_angle = if straighten {
                    let horizon = detect_horizon_angle(&image);
                    if horizon.confidence > 0.35 {
                        Some(horizon.angle_degrees)
                    } else {
                        None
                    }
                } else {
                    None
                };

                Some(PreScannedImage {
                    path_str: path_str.clone(),
                    timestamp_epoch,
                    scene,
                    base_analysis,
                    sharpness,
                    mean_luma,
                    mean_ok_a,
                    mean_ok_b,
                    horizon_angle,
                })
            })
            .collect();

        let valid_scanned: Vec<PreScannedImage> = pre_scanned.into_iter().flatten().collect();

        // Stage 2: Temporal & Chromatic Shoot Clustering
        let clusters: Vec<Vec<PreScannedImage>> = if do_harmonize && !valid_scanned.is_empty() {
            let mut groups: Vec<Vec<PreScannedImage>> = Vec::new();
            let mut current_group: Vec<PreScannedImage> = vec![valid_scanned[0].clone()];

            for i in 1..valid_scanned.len() {
                let prev = &valid_scanned[i - 1];
                let curr = &valid_scanned[i];

                let time_gap = curr.timestamp_epoch.abs_diff(prev.timestamp_epoch);
                let luma_gap = (curr.mean_luma - prev.mean_luma).abs();
                let color_gap = (curr.mean_ok_a - prev.mean_ok_a).abs() + (curr.mean_ok_b - prev.mean_ok_b).abs();

                // Group together if taken within 25s, matching scene, and similar ambient light
                if time_gap <= 25 && curr.scene == prev.scene && luma_gap < 40.0 && color_gap < 0.06 {
                    current_group.push(curr.clone());
                } else {
                    groups.push(current_group);
                    current_group = vec![curr.clone()];
                }
            }
            groups.push(current_group);
            groups
        } else {
            valid_scanned.iter().cloned().map(|item| vec![item]).collect()
        };

        let total_clusters = clusters.len();
        let mut breakdown: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut success_count = 0;

        // Stage 3: Harmonized Adjustment Generation & Sidecar Sync
        clusters.par_iter().for_each(|cluster| {
            if cluster.is_empty() {
                return;
            }

            // Find cluster anchor frame (sharpest, well-exposed hero shot)
            let anchor = cluster
                .iter()
                .max_by(|a, b| {
                    let a_score = a.sharpness * (1.0 - (a.mean_luma - 128.0).abs() / 256.0);
                    let b_score = b.sharpness * (1.0 - (b.mean_luma - 128.0).abs() / 256.0);
                    a_score.partial_cmp(&b_score).unwrap_or(std::cmp::Ordering::Equal)
                })
                .unwrap_or(&cluster[0]);

            let anchor_adj = generate_semantic_adjustments(
                anchor.scene,
                &anchor.base_analysis,
                intensity_val,
                anchor.horizon_angle,
                Some(style),
                Some(protect_skin),
            );

            let anchor_exp = anchor_adj["exposure"].as_f64().unwrap_or(0.0);
            let anchor_temp = anchor_adj["temperature"].as_f64().unwrap_or(0.0);
            let anchor_tint = anchor_adj["tint"].as_f64().unwrap_or(0.0);
            let anchor_contrast = anchor_adj["contrast"].as_f64().unwrap_or(0.0);

            for item in cluster {
                let (_, sidecar_path) = parse_virtual_path(&item.path_str);
                let (source_path, _) = parse_virtual_path(&item.path_str);

                let mut item_adj = generate_semantic_adjustments(
                    item.scene,
                    &item.base_analysis,
                    intensity_val,
                    item.horizon_angle,
                    Some(style),
                    Some(protect_skin),
                );

                // Harmonize with anchor if part of a multi-shot cluster
                if cluster.len() > 1 && do_harmonize {
                    let local_exp = item_adj["exposure"].as_f64().unwrap_or(0.0);
                    let local_temp = item_adj["temperature"].as_f64().unwrap_or(0.0);
                    let local_tint = item_adj["tint"].as_f64().unwrap_or(0.0);
                    let local_contrast = item_adj["contrast"].as_f64().unwrap_or(0.0);

                    item_adj["exposure"] = serde_json::json!(0.65 * anchor_exp + 0.35 * local_exp);
                    item_adj["temperature"] = serde_json::json!(0.70 * anchor_temp + 0.30 * local_temp);
                    item_adj["tint"] = serde_json::json!(0.70 * anchor_tint + 0.30 * local_tint);
                    item_adj["contrast"] = serde_json::json!(0.60 * anchor_contrast + 0.40 * local_contrast);
                }

                // Write sidecar JSON
                let mut metadata = load_sidecar(&sidecar_path);
                metadata.adjustments = item_adj.clone();

                if let Ok(json_string) = serde_json::to_string_pretty(&metadata) {
                    if let Some(parent) = sidecar_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::write(&sidecar_path, json_string);
                }

                if sync_xmp {
                    sync_metadata_to_xmp(&source_path, &metadata, false);
                }

                let done = processed_counter.fetch_add(1, Ordering::SeqCst) + 1;
                let percent = (done as f32 / total as f32) * 100.0;

                let filename = Path::new(&item.path_str)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();

                let _ = app_handle_clone.emit(
                    "batch-polish-progress",
                    serde_json::json!({
                        "current": done,
                        "total": total,
                        "filename": filename,
                        "scene": item.scene.display_name(),
                        "percentage": percent
                    }),
                );
            }
        });

        for item in &valid_scanned {
            success_count += 1;
            *breakdown.entry(item.scene.display_name().to_string()).or_insert(0) += 1;
        }

        (breakdown, success_count, total_clusters)
    })
    .await
    .map_err(|e| format!("Batch polish task failed: {}", e))?;

    let elapsed = start_time.elapsed().as_millis() as u64;

    let _ = app_handle.emit(
        "batch-polish-complete",
        serde_json::json!({
            "totalProcessed": total_success,
            "totalClusters": cluster_count,
            "sceneBreakdown": scene_breakdown,
            "elapsedMs": elapsed
        }),
    );

    Ok(BatchPolishSummary {
        total_processed: total_success,
        total_clusters: cluster_count,
        scene_breakdown,
        elapsed_ms: elapsed,
    })
}
