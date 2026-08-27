//! "Steal the Look" Color & Tone Transfer Engine for RapidRAW
//!
//! Analyzes a reference image (cinematic still, vintage film, master photographer portfolio)
//! and extracts its color moments, tone curves, and split-toning palette, applying them
//! to the active RAW image.

use crate::AppState;
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorMatchResult {
    pub adjustments: serde_json::Value,
    pub extracted_palette: Vec<String>,
    pub reference_tone_curve_summary: String,
}

#[derive(Debug, Clone)]
struct ImageColorStats {
    mean_oklab_l: f32,
    mean_oklab_a: f32,
    mean_oklab_b: f32,
    std_oklab_l: f32,
    std_oklab_a: f32,
    std_oklab_b: f32,
    mean_r: f32,
    mean_g: f32,
    mean_b: f32,
    shadow_tint: (f32, f32, f32),
    highlight_tint: (f32, f32, f32),
}

pub fn srgb_to_oklab(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let norm_r = (r / 255.0).clamp(0.0, 1.0);
    let norm_g = (g / 255.0).clamp(0.0, 1.0);
    let norm_b = (b / 255.0).clamp(0.0, 1.0);

    let lin_r = if norm_r <= 0.04045 { norm_r / 12.92 } else { ((norm_r + 0.055) / 1.055).powf(2.4) };
    let lin_g = if norm_g <= 0.04045 { norm_g / 12.92 } else { ((norm_g + 0.055) / 1.055).powf(2.4) };
    let lin_b = if norm_b <= 0.04045 { norm_b / 12.92 } else { ((norm_b + 0.055) / 1.055).powf(2.4) };

    let l = (0.4122214708 * lin_r + 0.5363325363 * lin_g + 0.0514459929 * lin_b).max(0.0).cbrt();
    let m = (0.2119034982 * lin_r + 0.6806995451 * lin_g + 0.1073969566 * lin_b).max(0.0).cbrt();
    let s = (0.0883024619 * lin_r + 0.2817188376 * lin_g + 0.6299787005 * lin_b).max(0.0).cbrt();

    let oklab_l = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    let oklab_a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    let oklab_b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

    (oklab_l, oklab_a, oklab_b)
}

pub fn oklab_to_srgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;

    let l_cubed = l_ * l_ * l_;
    let m_cubed = m_ * m_ * m_;
    let s_cubed = s_ * s_ * s_;

    let lin_r = 4.0767434036 * l_cubed - 3.3077115913 * m_cubed + 0.2309699292 * s_cubed;
    let lin_g = -1.2684380046 * l_cubed + 2.6097574011 * m_cubed - 0.3413193965 * s_cubed;
    let lin_b = -0.0041960863 * l_cubed - 0.7034186147 * m_cubed + 1.7076147010 * s_cubed;

    let gamma = |v: f32| -> f32 {
        let v_clamped = v.clamp(0.0, 1.0);
        if v_clamped <= 0.0031308 {
            v_clamped * 12.92
        } else {
            1.055 * v_clamped.powf(1.0 / 2.4) - 0.055
        }
    };

    (gamma(lin_r) * 255.0, gamma(lin_g) * 255.0, gamma(lin_b) * 255.0)
}

/// Checks if an OKLab color coordinate falls into the physiological human skin locus
pub fn is_skin_tone_oklab(ok_l: f32, ok_a: f32, ok_b: f32) -> bool {
    if ok_l < 0.20 || ok_l > 0.95 {
        return false;
    }
    // In OKLab, human skin tones lie in quadrant 1 with a specific hue angle
    if ok_a < 0.015 || ok_a > 0.18 || ok_b < 0.015 || ok_b > 0.22 {
        return false;
    }
    let hue_angle = ok_b.atan2(ok_a); // in radians
    // Approx 35 deg to 75 deg (0.61 rad to 1.31 rad)
    (0.60..=1.35).contains(&hue_angle)
}

/// Returns a skin presence ratio [0.0..1.0] across an image thumbnail
pub fn calculate_skin_presence_ratio(thumb: &image::RgbImage) -> f32 {
    let (w, h) = thumb.dimensions();
    let total = (w * h) as f32;
    if total < 1.0 { return 0.0; }

    let mut skin_count = 0.0f32;
    for p in thumb.pixels() {
        let (ok_l, ok_a, ok_b) = srgb_to_oklab(p[0] as f32, p[1] as f32, p[2] as f32);
        if is_skin_tone_oklab(ok_l, ok_a, ok_b) {
            skin_count += 1.0;
        }
    }
    (skin_count / total).clamp(0.0, 1.0)
}

fn compute_color_stats(image: &DynamicImage) -> ImageColorStats {
    let thumb = image.thumbnail(256, 256).to_rgb8();
    let (w, h) = thumb.dimensions();
    let n = (w * h) as f32;

    let mut sum_r = 0.0f32;
    let mut sum_g = 0.0f32;
    let mut sum_b = 0.0f32;
    let mut sum_luma = 0.0f32;

    let mut sum_ok_l = 0.0f32;
    let mut sum_ok_a = 0.0f32;
    let mut sum_ok_b = 0.0f32;

    let mut shadow_r = 0.0f32;
    let mut shadow_g = 0.0f32;
    let mut shadow_b = 0.0f32;
    let mut shadow_count = 0.0f32;

    let mut highlight_r = 0.0f32;
    let mut highlight_g = 0.0f32;
    let mut highlight_b = 0.0f32;
    let mut highlight_count = 0.0f32;

    let mut oklab_pixels = Vec::with_capacity(n as usize);

    for p in thumb.pixels() {
        let r = p[0] as f32;
        let g = p[1] as f32;
        let b = p[2] as f32;
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        let (ok_l, ok_a, ok_b) = srgb_to_oklab(r, g, b);
        oklab_pixels.push((ok_l, ok_a, ok_b));

        sum_r += r;
        sum_g += g;
        sum_b += b;
        sum_luma += luma;
        sum_ok_l += ok_l;
        sum_ok_a += ok_a;
        sum_ok_b += ok_b;

        if luma < 60.0 {
            shadow_r += r;
            shadow_g += g;
            shadow_b += b;
            shadow_count += 1.0;
        } else if luma > 190.0 {
            highlight_r += r;
            highlight_g += g;
            highlight_b += b;
            highlight_count += 1.0;
        }
    }

    let mean_r = sum_r / n;
    let mean_g = sum_g / n;
    let mean_b = sum_b / n;
    let _mean_luma = sum_luma / n;

    let mean_oklab_l = sum_ok_l / n;
    let mean_oklab_a = sum_ok_a / n;
    let mean_oklab_b = sum_ok_b / n;

    let mut var_ok_l = 0.0f32;
    let mut var_ok_a = 0.0f32;
    let mut var_ok_b = 0.0f32;

    for (ok_l, ok_a, ok_b) in &oklab_pixels {
        var_ok_l += (ok_l - mean_oklab_l).powi(2);
        var_ok_a += (ok_a - mean_oklab_a).powi(2);
        var_ok_b += (ok_b - mean_oklab_b).powi(2);
    }

    let std_oklab_l = (var_ok_l / n).sqrt();
    let std_oklab_a = (var_ok_a / n).sqrt();
    let std_oklab_b = (var_ok_b / n).sqrt();

    let shadow_tint = if shadow_count > 10.0 {
        (
            shadow_r / shadow_count,
            shadow_g / shadow_count,
            shadow_b / shadow_count,
        )
    } else {
        (mean_r * 0.4, mean_g * 0.4, mean_b * 0.4)
    };

    let highlight_tint = if highlight_count > 10.0 {
        (
            highlight_r / highlight_count,
            highlight_g / highlight_count,
            highlight_b / highlight_count,
        )
    } else {
        (mean_r * 1.4, mean_g * 1.4, mean_b * 1.4)
    };

    ImageColorStats {
        mean_oklab_l,
        mean_oklab_a,
        mean_oklab_b,
        std_oklab_l,
        std_oklab_a,
        std_oklab_b,
        mean_r,
        mean_g,
        mean_b,
        shadow_tint,
        highlight_tint,
    }
}

/// Matches the color and tone look of a reference image to the active image
#[tauri::command]
pub fn steal_color_look(
    reference_base64: String,
    intensity: Option<f32>,
    state: State<AppState>,
) -> Result<ColorMatchResult, String> {
    let intensity_val = intensity.unwrap_or(100.0) / 100.0;

    // Decode reference image
    let ref_clean = reference_base64
        .trim()
        .trim_start_matches("data:image/jpeg;base64,")
        .trim_start_matches("data:image/png;base64,")
        .trim_start_matches("data:image/webp;base64,");

    use base64::Engine;
    let ref_bytes = base64::engine::general_purpose::STANDARD
        .decode(ref_clean)
        .map_err(|e| format!("Failed to decode reference image base64: {}", e))?;

    let ref_img = image::load_from_memory(&ref_bytes)
        .map_err(|e| format!("Failed to parse reference image: {}", e))?;

    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    let active_img = if let Some(loaded) = &*orig_guard {
        &loaded.image
    } else {
        return Err("No active image loaded in RapidRAW".to_string());
    };

    let ref_stats = compute_color_stats(&ref_img);
    let target_stats = compute_color_stats(active_img);

    // Compute perceptual OKLab delta shifts
    let delta_luma = ref_stats.mean_oklab_l - target_stats.mean_oklab_l;
    let delta_contrast = (ref_stats.std_oklab_l - target_stats.std_oklab_l) * 2.5;

    // OKLab a (green-red) and b (blue-yellow) perceptual shifts
    let delta_a = (ref_stats.mean_oklab_a - target_stats.mean_oklab_a) * 120.0;
    let delta_b = (ref_stats.mean_oklab_b - target_stats.mean_oklab_b) * 120.0;

    let delta_temp = delta_b.clamp(-50.0, 50.0);
    let delta_tint = delta_a.clamp(-40.0, 40.0);

    // Compute target adjustments scaled by intensity
    let exposure = (delta_luma * 2.2 * intensity_val).clamp(-2.5, 2.5) as f64;
    let contrast = (delta_contrast * 40.0 * intensity_val).clamp(-35.0, 40.0) as f64;
    let highlights = if ref_stats.highlight_tint.0 > 220.0 { -15.0 } else { 10.0 } * intensity_val as f64;
    let shadows = if ref_stats.shadow_tint.0 < 40.0 { -12.0 } else { 16.0 } * intensity_val as f64;
    let whites = (delta_contrast * 15.0 * intensity_val).clamp(-20.0, 20.0) as f64;
    let blacks = (-delta_contrast * 18.0 * intensity_val).clamp(-20.0, 20.0) as f64;
    let temperature = delta_temp * intensity_val;
    let tint = delta_tint * intensity_val;
    let vibrance = ((ref_stats.std_oklab_a + ref_stats.std_oklab_b) * 200.0 - 20.0) * 0.4 * intensity_val;

    // Extract dominant 5-color palette for UI preview
    let palette = vec![
        format!(
            "#{:02X}{:02X}{:02X}",
            ref_stats.shadow_tint.0 as u8,
            ref_stats.shadow_tint.1 as u8,
            ref_stats.shadow_tint.2 as u8
        ),
        format!(
            "#{:02X}{:02X}{:02X}",
            (ref_stats.mean_r * 0.7) as u8,
            (ref_stats.mean_g * 0.7) as u8,
            (ref_stats.mean_b * 0.7) as u8
        ),
        format!(
            "#{:02X}{:02X}{:02X}",
            ref_stats.mean_r as u8,
            ref_stats.mean_g as u8,
            ref_stats.mean_b as u8
        ),
        format!(
            "#{:02X}{:02X}{:02X}",
            (ref_stats.mean_r * 1.2).min(255.0) as u8,
            (ref_stats.mean_g * 1.2).min(255.0) as u8,
            (ref_stats.mean_b * 1.2).min(255.0) as u8
        ),
        format!(
            "#{:02X}{:02X}{:02X}",
            ref_stats.highlight_tint.0 as u8,
            ref_stats.highlight_tint.1 as u8,
            ref_stats.highlight_tint.2 as u8
        ),
    ];

    let adjustments = serde_json::json!({
        "exposure": exposure,
        "contrast": contrast,
        "highlights": highlights,
        "shadows": shadows,
        "whites": whites,
        "blacks": blacks,
        "temperature": temperature as f64,
        "tint": tint as f64,
        "vibrance": vibrance as f64,
        "clarity": (delta_contrast * 10.0 * intensity_val).clamp(-10.0, 20.0) as f64,
        "dehaze": (delta_contrast * 8.0 * intensity_val).clamp(-8.0, 18.0) as f64,
    });

    let summary = format!(
        "Luma delta: {:.2} EV • Warmth: {:+.1} • Contrast: {:+.1}",
        exposure, temperature, contrast
    );

    Ok(ColorMatchResult {
        adjustments,
        extracted_palette: palette,
        reference_tone_curve_summary: summary,
    })
}

/// Exports extracted color match as a standard 33x33x33 .CUBE 3D LUT
#[tauri::command]
pub fn export_color_match_as_cube_lut(
    title: String,
    exposure_ev: f32,
    temp_shift: f32,
    contrast_mult: f32,
    output_path: String,
) -> Result<String, String> {
    let size = 33usize;
    let mut cube_data = String::new();

    cube_data.push_str(&format!("# Created by RapidRAW Pro Color Studio\n"));
    cube_data.push_str(&format!("TITLE \"{}\"\n", title));
    cube_data.push_str(&format!("LUT_3D_SIZE {}\n\n", size));

    let exp_factor = 2.0f32.powf(exposure_ev);
    let r_gain = 1.0 + (temp_shift * 0.02);
    let b_gain = 1.0 - (temp_shift * 0.02);

    for b_idx in 0..size {
        let b_in = b_idx as f32 / (size - 1) as f32;
        for g_idx in 0..size {
            let g_in = g_idx as f32 / (size - 1) as f32;
            for r_idx in 0..size {
                let r_in = r_idx as f32 / (size - 1) as f32;

                // Apply exposure & contrast in linear space
                let mut r = ((r_in - 0.5) * contrast_mult + 0.5) * exp_factor * r_gain;
                let mut g = ((g_in - 0.5) * contrast_mult + 0.5) * exp_factor;
                let mut b = ((b_in - 0.5) * contrast_mult + 0.5) * exp_factor * b_gain;

                r = r.clamp(0.0, 1.0);
                g = g.clamp(0.0, 1.0);
                b = b.clamp(0.0, 1.0);

                cube_data.push_str(&format!("{:.6} {:.6} {:.6}\n", r, g, b));
            }
        }
    }

    std::fs::write(&output_path, cube_data).map_err(|e| e.to_string())?;
    Ok(output_path)
}

use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
pub struct HarmonizeSummary {
    pub total_harmonized: usize,
    pub hero_luminance: f32,
    pub hero_skin_temp_offset: f32,
}

/// One-Click Photoshoot Batch Exposure & Skin Warmth Harmonizer
/// Matches exposure and perceived skin warmth of 100+ frames to a single perfected "Hero" photo
#[tauri::command]
pub fn harmonize_photoshoot_series(
    hero_path: String,
    target_paths: Vec<String>,
    app_handle: tauri::AppHandle,
    _state: State<AppState>,
) -> Result<HarmonizeSummary, String> {
    if target_paths.is_empty() {
        return Err("No target photos provided to harmonize".to_string());
    }

    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();

    // 1. Analyze Hero Photo
    let (hero_src, _) = crate::file_management::parse_virtual_path(&hero_path);
    let hero_bytes = std::fs::read(&hero_src).map_err(|e| e.to_string())?;
    let hero_img = crate::image_loader::load_base_image_from_bytes(&hero_bytes, &hero_src.to_string_lossy(), false, &settings, None)
        .map_err(|e| e.to_string())?;

    let hero_stats = compute_color_stats(&hero_img);
    let target_lum = hero_stats.mean_oklab_l;

    let total = target_paths.len();

    // 2. Harmonize Target Frames
    for (idx, target_str) in target_paths.iter().enumerate() {
        let _ = app_handle.emit(
            "harmonize-progress",
            serde_json::json!({
                "current": idx + 1,
                "total": total,
                "message": format!("Harmonizing exposure on shot {}/{}...", idx + 1, total)
            }),
        );

        let (t_src, _) = crate::file_management::parse_virtual_path(target_str);
        if let Ok(bytes) = std::fs::read(&t_src) {
            if let Ok(dyn_img) = crate::image_loader::load_base_image_from_bytes(&bytes, &t_src.to_string_lossy(), false, &settings, None) {
                let t_stats = compute_color_stats(&dyn_img);

                // Exposure delta in EV
                let lum_diff = target_lum - t_stats.mean_oklab_l;
                let exposure_ev = (lum_diff * 2.8).clamp(-2.5, 2.5);

                // Skin warmth delta
                let warmth_offset = (hero_stats.mean_oklab_b - t_stats.mean_oklab_b) * 150.0;

                let adj_json = serde_json::json!({
                    "exposure": exposure_ev,
                    "temperature": warmth_offset.clamp(-30.0, 30.0),
                });

                let _ = crate::file_management::apply_adjustments_to_paths(
                    vec![target_str.clone()],
                    adj_json,
                    app_handle.clone(),
                );
            }
        }
    }

    Ok(HarmonizeSummary {
        total_harmonized: total,
        hero_luminance: target_lum,
        hero_skin_temp_offset: hero_stats.mean_oklab_b,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn test_oklab_roundtrip_conversion() {
        let test_colors = [
            (255.0, 0.0, 0.0),     // Red
            (0.0, 255.0, 0.0),     // Green
            (0.0, 0.0, 255.0),     // Blue
            (220.0, 180.0, 140.0), // Warm skin tone
            (128.0, 128.0, 128.0), // Mid gray
        ];

        for (r, g, b) in test_colors {
            let (l, a, b_ok) = srgb_to_oklab(r, g, b);
            let (rec_r, rec_g, rec_b) = oklab_to_srgb(l, a, b_ok);
            assert!((r - rec_r).abs() < 1.5, "R channel mismatch: {} vs {}", r, rec_r);
            assert!((g - rec_g).abs() < 1.5, "G channel mismatch: {} vs {}", g, rec_g);
            assert!((b - rec_b).abs() < 1.5, "B channel mismatch: {} vs {}", b, rec_b);
        }
    }

    #[test]
    fn test_skin_tone_oklab_detection() {
        // Natural human skin tone
        let (l_skin, a_skin, b_skin) = srgb_to_oklab(220.0, 175.0, 140.0);
        assert!(is_skin_tone_oklab(l_skin, a_skin, b_skin), "Warm skin tone should be detected as human skin");

        // Blue sky
        let (l_sky, a_sky, b_sky) = srgb_to_oklab(100.0, 160.0, 240.0);
        assert!(!is_skin_tone_oklab(l_sky, a_sky, b_sky), "Sky blue should not be detected as skin");

        // Green foliage
        let (l_grass, a_grass, b_grass) = srgb_to_oklab(60.0, 160.0, 50.0);
        assert!(!is_skin_tone_oklab(l_grass, a_grass, b_grass), "Foliage green should not be detected as skin");
    }

    #[test]
    fn test_calculate_skin_presence_ratio() {
        let (w, h) = (32u32, 32u32);
        let mut skin_thumb = RgbImage::new(w, h);
        let mut blue_thumb = RgbImage::new(w, h);

        for y in 0..h {
            for x in 0..w {
                skin_thumb.put_pixel(x, y, Rgb([215, 170, 135]));
                blue_thumb.put_pixel(x, y, Rgb([50, 100, 220]));
            }
        }

        let skin_ratio = calculate_skin_presence_ratio(&skin_thumb);
        let blue_ratio = calculate_skin_presence_ratio(&blue_thumb);

        assert!(skin_ratio > 0.95, "Skin thumbnail should have ~1.0 presence: got {}", skin_ratio);
        assert_eq!(blue_ratio, 0.0, "Blue thumbnail should have 0.0 skin presence");
    }
}
