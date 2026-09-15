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
pub struct ImageColorStats {
    pub mean_oklab_l: f32,
    pub mean_oklab_a: f32,
    pub mean_oklab_b: f32,
    pub std_oklab_l: f32,
    pub std_oklab_a: f32,
    pub std_oklab_b: f32,
    pub mean_r: f32,
    pub mean_g: f32,
    pub mean_b: f32,
    pub shadow_tint: (f32, f32, f32),
    pub highlight_tint: (f32, f32, f32),
    pub skin_presence_ratio: f32,
    pub mean_skin_oklab_b: Option<f32>,
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

    let mut sum_skin_b = 0.0f32;
    let mut skin_count = 0.0f32;

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

        if is_skin_tone_oklab(ok_l, ok_a, ok_b) {
            sum_skin_b += ok_b;
            skin_count += 1.0;
        }

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

    let skin_presence_ratio = (skin_count / n).clamp(0.0, 1.0);
    let mean_skin_oklab_b = if skin_count > 15.0 {
        Some(sum_skin_b / skin_count)
    } else {
        None
    };

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
        skin_presence_ratio,
        mean_skin_oklab_b,
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

/// Configuration options for Pro 3D LUT Studio generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CubeLutConfig {
    pub title: String,
    pub exposure_ev: f32,
    pub temp_shift: f32,
    pub contrast_mult: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub tint: f32,
    pub vibrance: f32,
    pub lut_size: usize,
    pub protect_skin: bool,
}

impl Default for CubeLutConfig {
    fn default() -> Self {
        Self {
            title: "RapidRAW Look".to_string(),
            exposure_ev: 0.0,
            temp_shift: 0.0,
            contrast_mult: 1.0,
            highlights: 0.0,
            shadows: 0.0,
            tint: 0.0,
            vibrance: 0.0,
            lut_size: 33,
            protect_skin: true,
        }
    }
}

/// Calculates continuous skin tone weight in Oklab space [0.0..1.0]
/// Uses smooth quadratic bell curves around the human skin chromatic locus to prevent edge banding
pub fn calculate_skin_tone_weight(l: f32, a: f32, b: f32) -> f32 {
    if l < 0.15 || l > 0.98 {
        return 0.0;
    }
    let chroma = (a * a + b * b).sqrt();
    if chroma < 0.015 || chroma > 0.25 {
        return 0.0;
    }
    let hue = b.atan2(a);
    if !(0.50..=1.45).contains(&hue) {
        return 0.0;
    }

    // Lightness bell curve centered at ~0.55
    let l_mid = 0.55;
    let l_dist = ((l - l_mid) / 0.40).abs();
    let l_weight = (1.0 - l_dist * l_dist).clamp(0.0, 1.0);

    // Hue bell curve centered at ~0.95 rad (~54.4 deg)
    let hue_mid = 0.95;
    let hue_dist = ((hue - hue_mid) / 0.45).abs();
    let hue_weight = (1.0 - hue_dist * hue_dist).clamp(0.0, 1.0);

    // Chroma bell curve centered at ~0.09
    let chroma_mid = 0.09;
    let chroma_dist = ((chroma - chroma_mid) / 0.12).abs();
    let chroma_weight = (1.0 - chroma_dist * chroma_dist).clamp(0.0, 1.0);

    (l_weight * hue_weight * chroma_weight).clamp(0.0, 1.0)
}

/// Maps an input sRGB coordinate [0.0, 1.0] through Oklab perceptual color space
/// applying exposure, contrast, highlights/shadows, temperature, tint, vibrance,
/// and skin-tone anchor protection.
pub fn map_rgb_through_oklab(
    r_in: f32,
    g_in: f32,
    b_in: f32,
    exposure_ev: f32,
    temp_shift: f32,
    contrast_mult: f32,
    highlights: f32,
    shadows: f32,
    tint: f32,
    vibrance: f32,
    protect_skin: bool,
) -> (f32, f32, f32) {
    let (l, a, b) = srgb_to_oklab(r_in * 255.0, g_in * 255.0, b_in * 255.0);

    // 1. Exposure shift in Oklab L space (proportional to Y^(1/3))
    // 2.0^(EV/3.0) gives accurate perceptual energy scaling
    let l_exp = (l * 2.0f32.powf(exposure_ev / 3.0)).clamp(0.0, 1.0);

    // 2. Contrast around midtone (L = 0.5)
    let c_factor = if contrast_mult.is_finite() && contrast_mult > 0.0 {
        contrast_mult
    } else {
        1.0
    };
    let l_contrast = 0.5 + (l_exp - 0.5) * c_factor;

    // 3. Highlight and shadow rolloff
    let shadow_term = if l_contrast < 0.5 {
        (shadows / 100.0) * 0.20 * (1.0 - 2.0 * l_contrast.max(0.0))
    } else {
        0.0
    };
    let highlight_term = if l_contrast > 0.5 {
        (highlights / 100.0) * 0.20 * (2.0 * (l_contrast.min(1.0) - 0.5))
    } else {
        0.0
    };
    let l_final = (l_contrast + shadow_term + highlight_term).clamp(0.0, 1.0);

    // 4. Chromatic shifts: temperature on b (yellow-blue), tint on a (green-magenta)
    let delta_b = temp_shift * 0.0012;
    let delta_a = tint * 0.0012;

    let a_shifted = a + delta_a;
    let b_shifted = b + delta_b;

    // 5. Vibrance (non-linear saturation boost favoring muted tones)
    let chroma = (a_shifted * a_shifted + b_shifted * b_shifted).sqrt();
    let vib_factor = 1.0 + (vibrance / 100.0) * (1.0 - (chroma * 4.0).min(1.0)).max(0.0) * 0.5;
    let a_vib = a_shifted * vib_factor;
    let b_vib = b_shifted * vib_factor;

    // 6. Skin Tone Anchor Protection
    // Preserves natural skin locus hue and chroma during aggressive grading using polar LCh anchoring
    let (a_final, b_final) = if protect_skin {
        let skin_w = calculate_skin_tone_weight(l, a, b);
        if skin_w > 0.001 {
            let orig_chroma = (a * a + b * b).sqrt();
            let orig_hue = b.atan2(a);

            let shifted_chroma = (a_vib * a_vib + b_vib * b_vib).sqrt();
            let shifted_hue = b_vib.atan2(a_vib);

            // Polar LCh anchoring: blend hue angle back toward original natural human skin locus
            let blend = skin_w.clamp(0.0, 1.0);
            let mut target_hue = orig_hue * blend + shifted_hue * (1.0 - blend);

            // Anchor strictly within the physiological skin corridor [0.62..1.32] when skin presence is significant
            if blend > 0.3 {
                target_hue = target_hue.clamp(0.62, 1.32);
            }

            // Preserve natural healthy chroma, avoiding extreme desaturation or sickly cast
            let target_chroma = orig_chroma * blend + shifted_chroma * (1.0 - blend);
            let final_chroma = target_chroma.max(orig_chroma * 0.85);

            (final_chroma * target_hue.cos(), final_chroma * target_hue.sin())
        } else {
            (a_vib, b_vib)
        }
    } else {
        (a_vib, b_vib)
    };

    // 7. Convert back to sRGB and clamp to [0.0, 1.0]
    let (r_out, g_out, b_out) = oklab_to_srgb(l_final, a_final, b_final);
    (
        (r_out / 255.0).clamp(0.0, 1.0),
        (g_out / 255.0).clamp(0.0, 1.0),
        (b_out / 255.0).clamp(0.0, 1.0),
    )
}

/// Generates a valid Adobe/DaVinci .CUBE 3D LUT string using Rayon multi-threading
pub fn generate_cube_lut_string(config: &CubeLutConfig) -> String {
    use rayon::prelude::*;
    let size = config.lut_size.clamp(17, 65);
    let mut cube_data = String::with_capacity(size * size * size * 26 + 256);

    cube_data.push_str("# Created by RapidRAW Pro Color Studio\n");
    cube_data.push_str(&format!("TITLE \"{}\"\n", config.title));
    cube_data.push_str(&format!("LUT_3D_SIZE {}\n", size));
    cube_data.push_str("DOMAIN_MIN 0.0 0.0 0.0\n");
    cube_data.push_str("DOMAIN_MAX 1.0 1.0 1.0\n\n");

    let b_slices: Vec<String> = (0..size)
        .into_par_iter()
        .map(|b_idx| {
            let b_in = b_idx as f32 / (size - 1) as f32;
            let mut slice = String::with_capacity(size * size * 26);
            for g_idx in 0..size {
                let g_in = g_idx as f32 / (size - 1) as f32;
                for r_idx in 0..size {
                    let r_in = r_idx as f32 / (size - 1) as f32;
                    let (r_out, g_out, b_out) = map_rgb_through_oklab(
                        r_in,
                        g_in,
                        b_in,
                        config.exposure_ev,
                        config.temp_shift,
                        config.contrast_mult,
                        config.highlights,
                        config.shadows,
                        config.tint,
                        config.vibrance,
                        config.protect_skin,
                    );
                    use std::fmt::Write;
                    let _ = writeln!(slice, "{:.6} {:.6} {:.6}", r_out, g_out, b_out);
                }
            }
            slice
        })
        .collect();

    for slice in b_slices {
        cube_data.push_str(&slice);
    }

    cube_data
}

/// Exports extracted color match as a standard .CUBE 3D LUT (33x33x33 or 65x65x65)
#[tauri::command]
pub fn export_color_match_as_cube_lut(
    title: String,
    exposure_ev: f32,
    temp_shift: f32,
    contrast_mult: f32,
    output_path: String,
    highlights: Option<f32>,
    shadows: Option<f32>,
    tint: Option<f32>,
    vibrance: Option<f32>,
    lut_size: Option<usize>,
    protect_skin: Option<bool>,
) -> Result<String, String> {
    let config = CubeLutConfig {
        title,
        exposure_ev,
        temp_shift,
        contrast_mult,
        highlights: highlights.unwrap_or(0.0),
        shadows: shadows.unwrap_or(0.0),
        tint: tint.unwrap_or(0.0),
        vibrance: vibrance.unwrap_or(0.0),
        lut_size: lut_size.unwrap_or(33),
        protect_skin: protect_skin.unwrap_or(true),
    };

    let cube_content = generate_cube_lut_string(&config);
    std::fs::write(&output_path, cube_content).map_err(|e| e.to_string())?;
    Ok(output_path)
}

use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
pub struct HarmonizeSummary {
    pub total_harmonized: usize,
    pub hero_luminance: f32,
    pub hero_skin_temp_offset: f32,
}

/// Computes non-destructive harmonization offsets (EV, temp, tint, contrast)
/// matching target image stats to hero reference stats with skin tone prioritization
pub fn compute_harmonize_deltas(
    hero_stats: &ImageColorStats,
    target_stats: &ImageColorStats,
) -> (f32, f32, f32, f32) {
    // 1. Exposure delta in EV (proportional to Oklab L delta)
    let lum_diff = hero_stats.mean_oklab_l - target_stats.mean_oklab_l;
    let exposure_ev = (lum_diff * 2.5).clamp(-2.5, 2.5);

    // 2. Skin warmth delta: if both hero and target contain identified human skin,
    // match skin warmth directly to prevent background color changes from distorting faces
    let warmth_offset = match (hero_stats.mean_skin_oklab_b, target_stats.mean_skin_oklab_b) {
        (Some(hero_skin), Some(t_skin)) => (hero_skin - t_skin) * 160.0,
        _ => (hero_stats.mean_oklab_b - target_stats.mean_oklab_b) * 150.0,
    };
    let delta_temp = warmth_offset.clamp(-35.0, 35.0);

    // 3. Tint delta (Oklab a green-magenta balance)
    let delta_tint = ((hero_stats.mean_oklab_a - target_stats.mean_oklab_a) * 140.0).clamp(-25.0, 25.0);

    // 4. Perceptual contrast delta
    let delta_contrast = ((hero_stats.std_oklab_l - target_stats.std_oklab_l) * 45.0).clamp(-20.0, 20.0);

    (exposure_ev, delta_temp, delta_tint, delta_contrast)
}

/// One-Click Photoshoot Batch Exposure & Skin Warmth Harmonizer
/// Matches exposure and perceived skin warmth of 100+ frames to a single perfected "Hero" photo
#[tauri::command]
pub async fn harmonize_photoshoot_series(
    hero_path: String,
    target_paths: Vec<String>,
    app_handle: tauri::AppHandle,
    _state: State<'_, AppState>,
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
        let (t_src, _) = crate::file_management::parse_virtual_path(target_str);
        if let Ok(bytes) = std::fs::read(&t_src) {
            if let Ok(dyn_img) = crate::image_loader::load_base_image_from_bytes(&bytes, &t_src.to_string_lossy(), false, &settings, None) {
                let t_stats = compute_color_stats(&dyn_img);

                let (exposure_ev, delta_temp, delta_tint, delta_contrast) =
                    compute_harmonize_deltas(&hero_stats, &t_stats);

                let adj_json = serde_json::json!({
                    "exposure": exposure_ev,
                    "temperature": delta_temp,
                    "tint": delta_tint,
                    "contrast": delta_contrast,
                });

                let _ = crate::file_management::apply_adjustments_to_paths(
                    vec![target_str.clone()],
                    adj_json,
                    app_handle.clone(),
                ).await;

                let _ = app_handle.emit(
                    "harmonize-progress",
                    serde_json::json!({
                        "current": idx + 1,
                        "total": total,
                        "message": format!("Harmonized shot {}/{} ({:+.2} EV, {:+.1}° warmth)", idx + 1, total, exposure_ev, delta_temp)
                    }),
                );
            }
        }
    }

    Ok(HarmonizeSummary {
        total_harmonized: total,
        hero_luminance: target_lum,
        hero_skin_temp_offset: hero_stats.mean_skin_oklab_b.unwrap_or(hero_stats.mean_oklab_b),
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

    #[test]
    fn test_cube_lut_syntax_and_dimensions() {
        let config = CubeLutConfig {
            title: "Test 17x17".to_string(),
            lut_size: 17,
            ..Default::default()
        };

        let lut_str = generate_cube_lut_string(&config);
        let lines: Vec<&str> = lut_str.lines().collect();

        assert!(lines.iter().any(|l| l.contains("TITLE \"Test 17x17\"")));
        assert!(lines.iter().any(|l| l.contains("LUT_3D_SIZE 17")));
        assert!(lines.iter().any(|l| l.contains("DOMAIN_MIN 0.0 0.0 0.0")));
        assert!(lines.iter().any(|l| l.contains("DOMAIN_MAX 1.0 1.0 1.0")));

        // Count data lines (lines with 3 floats)
        let data_lines = lines
            .iter()
            .filter(|l| {
                let parts: Vec<&str> = l.split_whitespace().collect();
                parts.len() == 3 && parts[0].parse::<f32>().is_ok()
            })
            .count();

        assert_eq!(data_lines, 17 * 17 * 17, "Expected 17^3 data lines in .cube");
    }

    #[test]
    fn test_cube_lut_identity_neutral() {
        let config = CubeLutConfig {
            title: "Identity".to_string(),
            exposure_ev: 0.0,
            temp_shift: 0.0,
            contrast_mult: 1.0,
            highlights: 0.0,
            shadows: 0.0,
            tint: 0.0,
            vibrance: 0.0,
            lut_size: 17,
            protect_skin: true,
        };

        let size = config.lut_size;
        for b_idx in 0..size {
            let b_in = b_idx as f32 / (size - 1) as f32;
            for g_idx in 0..size {
                let g_in = g_idx as f32 / (size - 1) as f32;
                for r_idx in 0..size {
                    let r_in = r_idx as f32 / (size - 1) as f32;
                    let (r_out, g_out, b_out) = map_rgb_through_oklab(
                        r_in,
                        g_in,
                        b_in,
                        config.exposure_ev,
                        config.temp_shift,
                        config.contrast_mult,
                        config.highlights,
                        config.shadows,
                        config.tint,
                        config.vibrance,
                        config.protect_skin,
                    );

                    assert!(
                        (r_out - r_in).abs() < 0.015,
                        "Red channel delta too high: {} vs {}",
                        r_out,
                        r_in
                    );
                    assert!(
                        (g_out - g_in).abs() < 0.015,
                        "Green channel delta too high: {} vs {}",
                        g_out,
                        g_in
                    );
                    assert!(
                        (b_out - b_in).abs() < 0.015,
                        "Blue channel delta too high: {} vs {}",
                        b_out,
                        b_in
                    );
                }
            }
        }
    }

    #[test]
    fn test_cube_lut_skin_protection_anchoring() {
        // Natural human skin tone RGB (220, 175, 140)
        let r_skin = 220.0 / 255.0;
        let g_skin = 175.0 / 255.0;
        let b_skin = 140.0 / 255.0;

        // Apply aggressive cold blue/green color grade
        let temp_shift = -80.0;
        let tint = -60.0;

        // 1. Without skin protection: skin shifts drastically out of human range
        let (r_unprot, g_unprot, b_unprot) = map_rgb_through_oklab(
            r_skin, g_skin, b_skin,
            0.0, temp_shift, 1.0, 0.0, 0.0, tint, 0.0, false,
        );
        let (_l_unprot, a_unprot, b_unprot) = srgb_to_oklab(r_unprot * 255.0, g_unprot * 255.0, b_unprot * 255.0);
        let unprot_hue = b_unprot.atan2(a_unprot);

        // 2. With skin protection: skin stays anchored in natural human locus
        let (r_prot, g_prot, b_prot) = map_rgb_through_oklab(
            r_skin, g_skin, b_skin,
            0.0, temp_shift, 1.0, 0.0, 0.0, tint, 0.0, true,
        );
        let (l_prot, a_prot, b_prot) = srgb_to_oklab(r_prot * 255.0, g_prot * 255.0, b_prot * 255.0);
        let prot_hue = b_prot.atan2(a_prot);

        assert!(
            is_skin_tone_oklab(l_prot, a_prot, b_prot),
            "Protected skin tone must remain in human skin locus: L={}, a={}, b={}, hue={}",
            l_prot, a_prot, b_prot, prot_hue
        );
        assert!(
            (prot_hue - 0.95).abs() < (unprot_hue - 0.95).abs(),
            "Protected hue ({}) must be closer to human skin anchor (0.95) than unprotected hue ({})",
            prot_hue, unprot_hue
        );
    }

    #[test]
    fn test_cube_lut_exposure_and_tonal_rolloff() {
        // Midtone gray
        let mid_in = 0.5;
        let (r_plus1, g_plus1, b_plus1) = map_rgb_through_oklab(
            mid_in, mid_in, mid_in,
            1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, false,
        );

        assert!(
            r_plus1 > mid_in && g_plus1 > mid_in && b_plus1 > mid_in,
            "+1.0 EV exposure must increase midtone brightness"
        );

        // Highlights rolloff (-50 highlights)
        let (r_hi, _, _) = map_rgb_through_oklab(
            0.9, 0.9, 0.9,
            0.0, 0.0, 1.0, -50.0, 0.0, 0.0, 0.0, false,
        );
        assert!(
            r_hi < 0.9,
            "Negative highlights must pull down near-white values"
        );
    }

    #[test]
    fn test_compute_harmonize_deltas_underexposed_and_cool() {
        let hero = ImageColorStats {
            mean_oklab_l: 0.65,
            mean_oklab_a: 0.05,
            mean_oklab_b: 0.08,
            std_oklab_l: 0.18,
            std_oklab_a: 0.04,
            std_oklab_b: 0.05,
            mean_r: 180.0,
            mean_g: 140.0,
            mean_b: 120.0,
            shadow_tint: (50.0, 40.0, 40.0),
            highlight_tint: (230.0, 210.0, 200.0),
            skin_presence_ratio: 0.40,
            mean_skin_oklab_b: Some(0.085),
        };

        // Target shot is underexposed (L = 0.45) and cool (skin_b = 0.050)
        let target = ImageColorStats {
            mean_oklab_l: 0.45,
            mean_oklab_a: 0.03,
            mean_oklab_b: 0.04,
            std_oklab_l: 0.14,
            std_oklab_a: 0.03,
            std_oklab_b: 0.03,
            mean_r: 120.0,
            mean_g: 110.0,
            mean_b: 115.0,
            shadow_tint: (30.0, 30.0, 35.0),
            highlight_tint: (170.0, 160.0, 165.0),
            skin_presence_ratio: 0.35,
            mean_skin_oklab_b: Some(0.050),
        };

        let (ev, temp, tint, contrast) = compute_harmonize_deltas(&hero, &target);

        // 1. Exposure must be positive to compensate for underexposure
        assert!(ev > 0.4, "Expected positive EV boost for dark target: got {}", ev);

        // 2. Warmth delta must be positive to warm up cool skin towards hero
        assert!(temp > 4.0, "Expected positive temperature boost for cool target: got {}", temp);

        // 3. Tint and contrast must also move in the expected direction
        assert!(tint > 0.0, "Expected magenta tint boost: got {}", tint);
        assert!(contrast > 0.0, "Expected contrast boost: got {}", contrast);
    }

    #[test]
    fn test_compute_harmonize_deltas_identical() {
        let hero = ImageColorStats {
            mean_oklab_l: 0.60,
            mean_oklab_a: 0.04,
            mean_oklab_b: 0.07,
            std_oklab_l: 0.15,
            std_oklab_a: 0.03,
            std_oklab_b: 0.04,
            mean_r: 160.0,
            mean_g: 130.0,
            mean_b: 110.0,
            shadow_tint: (40.0, 35.0, 35.0),
            highlight_tint: (220.0, 200.0, 190.0),
            skin_presence_ratio: 0.25,
            mean_skin_oklab_b: Some(0.07),
        };

        let (ev, temp, tint, contrast) = compute_harmonize_deltas(&hero, &hero);

        assert_eq!(ev, 0.0, "Identical frames must have 0 EV delta");
        assert_eq!(temp, 0.0, "Identical frames must have 0 temp delta");
        assert_eq!(tint, 0.0, "Identical frames must have 0 tint delta");
        assert_eq!(contrast, 0.0, "Identical frames must have 0 contrast delta");
    }
}
