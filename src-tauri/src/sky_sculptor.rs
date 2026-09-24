//! AI Sky Sculptor & Isolated Sky Gradient Engine for RapidRAW
//!
//! Uses AI Sky Segmentation to apply targeted atmospheric enhancements
//! (Deep Polar Sky, Sunset Amber/Magenta, Stormy Cloud Drama, Horizon Dehaze)
//! with zero bleed onto foreground subjects.

use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkyPreset {
    PolarBlue,
    SunsetGlow,
    StormyDrama,
    GoldenHour,
    GentleDehaze,
}

impl SkyPreset {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "polar" | "polarblue" => SkyPreset::PolarBlue,
            "sunset" | "sunsetglow" => SkyPreset::SunsetGlow,
            "stormy" | "stormydrama" => SkyPreset::StormyDrama,
            "golden" | "goldenhour" => SkyPreset::GoldenHour,
            _ => SkyPreset::GentleDehaze,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SkySculptResult {
    pub preset_name: String,
    pub mask_adjustments: serde_json::Value,
    pub global_adjustments_patch: Option<serde_json::Value>,
}

/// Computes specialized adjustments for the sky mask layer
#[tauri::command]
pub fn apply_ai_sky_sculpt(
    preset: String,
    intensity: Option<f32>,
    _state: State<AppState>,
) -> Result<SkySculptResult, String> {
    let int_val = (intensity.unwrap_or(100.0) / 100.0).clamp(0.1, 2.0);
    let sky_type = SkyPreset::parse(&preset);

    let (name, exp, contrast, highlights, shadows, whites, blacks, temp, tint, dehaze, clarity, vibrance) =
        match sky_type {
            SkyPreset::PolarBlue => (
                "Deep Polar Sky",
                -0.35 * int_val as f64,
                14.0 * int_val as f64,
                -25.0 * int_val as f64,
                8.0 * int_val as f64,
                12.0 * int_val as f64,
                -10.0 * int_val as f64,
                -16.0 * int_val as f64,
                4.0 * int_val as f64,
                26.0 * int_val as f64,
                12.0 * int_val as f64,
                22.0 * int_val as f64,
            ),
            SkyPreset::SunsetGlow => (
                "Sunset Amber & Magenta Glow",
                0.10 * int_val as f64,
                10.0 * int_val as f64,
                -30.0 * int_val as f64,
                15.0 * int_val as f64,
                10.0 * int_val as f64,
                -8.0 * int_val as f64,
                22.0 * int_val as f64,
                14.0 * int_val as f64,
                16.0 * int_val as f64,
                8.0 * int_val as f64,
                28.0 * int_val as f64,
            ),
            SkyPreset::StormyDrama => (
                "Dramatic Stormy Cloud Contrast",
                -0.20 * int_val as f64,
                32.0 * int_val as f64,
                -35.0 * int_val as f64,
                10.0 * int_val as f64,
                20.0 * int_val as f64,
                -22.0 * int_val as f64,
                -6.0 * int_val as f64,
                2.0 * int_val as f64,
                38.0 * int_val as f64,
                30.0 * int_val as f64,
                10.0 * int_val as f64,
            ),
            SkyPreset::GoldenHour => (
                "Golden Hour Radiance",
                0.15 * int_val as f64,
                8.0 * int_val as f64,
                -20.0 * int_val as f64,
                18.0 * int_val as f64,
                14.0 * int_val as f64,
                -6.0 * int_val as f64,
                18.0 * int_val as f64,
                6.0 * int_val as f64,
                14.0 * int_val as f64,
                10.0 * int_val as f64,
                20.0 * int_val as f64,
            ),
            SkyPreset::GentleDehaze => (
                "Clean Horizon Dehaze",
                -0.10 * int_val as f64,
                12.0 * int_val as f64,
                -15.0 * int_val as f64,
                6.0 * int_val as f64,
                8.0 * int_val as f64,
                -8.0 * int_val as f64,
                -4.0 * int_val as f64,
                0.0,
                20.0 * int_val as f64,
                12.0 * int_val as f64,
                14.0 * int_val as f64,
            ),
        };

    let foreground_patch = match sky_type {
        SkyPreset::SunsetGlow => Some(serde_json::json!({
            "temperature": 8.0 * int_val as f64,
            "tint": 4.0 * int_val as f64,
            "shadows": 4.0 * int_val as f64,
        })),
        SkyPreset::GoldenHour => Some(serde_json::json!({
            "temperature": 6.0 * int_val as f64,
            "tint": 2.0 * int_val as f64,
            "highlights": 2.0 * int_val as f64,
        })),
        SkyPreset::StormyDrama => Some(serde_json::json!({
            "temperature": -4.0 * int_val as f64,
            "contrast": 6.0 * int_val as f64,
        })),
        _ => None,
    };

    let mask_adjustments = serde_json::json!({
        "exposure": exp,
        "contrast": contrast,
        "highlights": highlights,
        "shadows": shadows,
        "whites": whites,
        "blacks": blacks,
        "temperature": temp,
        "tint": tint,
        "dehaze": dehaze,
        "clarity": clarity,
        "vibrance": vibrance,
    });

    Ok(SkySculptResult {
        preset_name: name.to_string(),
        mask_adjustments,
        global_adjustments_patch: foreground_patch,
    })
}
