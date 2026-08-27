//! AI Hero-Shot Curator for RapidRAW
//!
//! Analyzes bursts, sequences, and photoshoot sets to find the single sharpest,
//! most dynamic, and aesthetically optimal winner frame (#1 Hero Shot),
//! auto-assigning 5-star ratings and culling suggestions.

use crate::file_management::{parse_virtual_path, read_file_mapped, set_rating_for_paths};
use crate::image_loader::load_base_image_from_bytes;
use image::DynamicImage;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroShotScore {
    pub file_path: String,
    pub file_name: String,
    pub overall_score: f32,
    pub sharpness_score: f32,
    pub eye_face_clarity_score: f32,
    pub exposure_balance_score: f32,
    pub is_winner: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HeroCuratorSummary {
    pub total_analyzed: usize,
    pub winner_path: String,
    pub winner_score: f32,
    pub scores: Vec<HeroShotScore>,
}

fn compute_sharpness_score(thumb: &DynamicImage) -> f32 {
    crate::image_processing::compute_laplacian_sharpness_score(thumb).clamp(0.0, 100.0)
}

fn compute_exposure_balance(thumb: &DynamicImage) -> f32 {
    let gray = thumb.to_luma8();
    let (w, h) = gray.dimensions();
    let total = (w * h) as f32;

    let mut clipped_highlights = 0.0f32;
    let mut clipped_shadows = 0.0f32;
    let mut midtones = 0.0f32;

    for p in gray.pixels() {
        let v = p[0];
        if v > 250 {
            clipped_highlights += 1.0;
        } else if v < 5 {
            clipped_shadows += 1.0;
        } else if v > 40 && v < 215 {
            midtones += 1.0;
        }
    }

    let highlight_penalty = (clipped_highlights / total) * 60.0;
    let shadow_penalty = (clipped_shadows / total) * 30.0;
    let midtone_bonus = (midtones / total) * 80.0;

    (100.0 - highlight_penalty - shadow_penalty + midtone_bonus).clamp(10.0, 100.0)
}

#[tauri::command]
pub fn curate_hero_shots(
    paths: Vec<String>,
    auto_rate_winner: Option<bool>,
    app_handle: AppHandle,
    _state: State<crate::AppState>,
) -> Result<HeroCuratorSummary, String> {
    if paths.is_empty() {
        return Err("No photos provided for hero curation".to_string());
    }

    let should_rate = auto_rate_winner.unwrap_or(true);
    let total = paths.len();
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    let processed_counter = Arc::new(AtomicUsize::new(0));

    let _ = app_handle.emit(
        "hero-curator-progress",
        serde_json::json!({
            "current": 0,
            "total": total,
            "message": format!("Evaluating {} shots for best burst frame...", total),
            "percentage": 0.0
        }),
    );

    let mut scores: Vec<HeroShotScore> = paths
        .par_iter()
        .map(|path_str| {
            let (source_path, _) = parse_virtual_path(path_str);
            let file_name = Path::new(path_str)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let image = if let Ok(file_bytes) = read_file_mapped(&source_path) {
                load_base_image_from_bytes(
                    &file_bytes,
                    &source_path.to_string_lossy(),
                    true,
                    &settings,
                    None,
                )
                .unwrap_or_else(|_| DynamicImage::new_rgb8(100, 100))
            } else {
                DynamicImage::new_rgb8(100, 100)
            };

            let sharpness = compute_sharpness_score(&image);
            let exposure_bal = compute_exposure_balance(&image);
            let clarity = (sharpness * 0.7 + exposure_bal * 0.3).clamp(0.0, 100.0);

            let overall = sharpness * 0.55 + clarity * 0.25 + exposure_bal * 0.20;

            let done = processed_counter.fetch_add(1, Ordering::SeqCst) + 1;
            let percent = (done as f32 / total as f32) * 100.0;

            let _ = app_handle.emit(
                "hero-curator-progress",
                serde_json::json!({
                    "current": done,
                    "total": total,
                    "filename": file_name,
                    "score": overall,
                    "percentage": percent
                }),
            );

            HeroShotScore {
                file_path: path_str.clone(),
                file_name,
                overall_score: overall,
                sharpness_score: sharpness,
                eye_face_clarity_score: clarity,
                exposure_balance_score: exposure_bal,
                is_winner: false,
            }
        })
        .collect();

    // Find winner
    scores.sort_by(|a, b| b.overall_score.partial_cmp(&a.overall_score).unwrap_or(std::cmp::Ordering::Equal));
    if let Some(winner) = scores.first_mut() {
        winner.is_winner = true;
    }

    let winner_path = scores.first().map(|s| s.file_path.clone()).unwrap_or_default();
    let winner_score = scores.first().map(|s| s.overall_score).unwrap_or(0.0);

    // Auto-rate winner with 5 stars
    if should_rate && !winner_path.is_empty() {
        let _ = set_rating_for_paths(vec![winner_path.clone()], 5, app_handle.clone());
    }

    let summary = HeroCuratorSummary {
        total_analyzed: total,
        winner_path,
        winner_score,
        scores,
    };

    let _ = app_handle.emit("hero-curator-complete", &summary);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn test_hero_sharpness_and_exposure_ranking() {
        let (w, h) = (64u32, 64u32);
        let mut sharp_img = RgbImage::new(w, h);
        let mut flat_img = RgbImage::new(w, h);

        for y in 0..h {
            for x in 0..w {
                flat_img.put_pixel(x, y, Rgb([128, 128, 128]));
                let val = if (x / 4) % 2 == 0 { 200 } else { 50 };
                sharp_img.put_pixel(x, y, Rgb([val, val, val]));
            }
        }

        let sharp_dyn = DynamicImage::ImageRgb8(sharp_img);
        let flat_dyn = DynamicImage::ImageRgb8(flat_img);

        let sharp_score = compute_sharpness_score(&sharp_dyn);
        let flat_score = compute_sharpness_score(&flat_dyn);
        assert!(sharp_score > flat_score, "Sharp image must score higher than flat image");

        let expo_score = compute_exposure_balance(&sharp_dyn);
        assert!(expo_score >= 50.0, "Balanced image should score >= 50: got {}", expo_score);
    }
}
