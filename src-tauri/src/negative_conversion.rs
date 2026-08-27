use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::image_loader::load_base_image_from_bytes;
use base64::{Engine as _, engine::general_purpose};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, Rgb32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::Path;
use tauri::AppHandle;

use crate::AppState;
use crate::image_processing::downscale_f32_image;
use crate::load_settings;
use tauri::Emitter;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NegativeConversionParams {
    pub red_weight: f32,
    pub green_weight: f32,
    pub blue_weight: f32,

    pub exposure: f32,
    pub contrast: f32,
    pub film_profile: Option<String>,

    pub base_mask_r: Option<f32>,
    pub base_mask_g: Option<f32>,
    pub base_mask_b: Option<f32>,

    pub toe_compression: Option<f32>,
    pub shoulder_compression: Option<f32>,
    pub shadow_crossover: Option<f32>,
    pub highlight_crossover: Option<f32>,
}

impl Default for NegativeConversionParams {
    fn default() -> Self {
        Self {
            red_weight: 1.0,
            green_weight: 1.0,
            blue_weight: 1.0,
            exposure: 0.0,
            contrast: 1.0,
            film_profile: Some("portra_400".to_string()),
            base_mask_r: None,
            base_mask_g: None,
            base_mask_b: None,
            toe_compression: Some(0.0),
            shoulder_compression: Some(0.0),
            shadow_crossover: Some(0.0),
            highlight_crossover: Some(0.0),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ChannelBounds {
    pub min: f32,
    pub max: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BorderMaskSampleResult {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub hex: String,
}

fn analyze_bounds(log_data: &[f32], width: usize, height: usize) -> [ChannelBounds; 3] {
    let margin_x = (width as f32 * 0.08) as usize;
    let margin_y = (height as f32 * 0.08) as usize;

    let est_pixels = (width.saturating_sub(margin_x * 2)) * (height.saturating_sub(margin_y * 2));
    let step = (est_pixels / 40_000).max(1);

    let mut r_vals = Vec::with_capacity(est_pixels / step);
    let mut g_vals = Vec::with_capacity(est_pixels / step);
    let mut b_vals = Vec::with_capacity(est_pixels / step);

    for y in (margin_y..(height - margin_y)).step_by(3) {
        let row_offset = y * width * 3;

        for x in (margin_x..(width - margin_x)).step_by(step) {
            let idx = row_offset + (x * 3);

            if idx + 2 < log_data.len() {
                let r = log_data[idx];
                let g = log_data[idx + 1];
                let b = log_data[idx + 2];

                if r.is_finite() {
                    r_vals.push(r);
                }
                if g.is_finite() {
                    g_vals.push(g);
                }
                if b.is_finite() {
                    b_vals.push(b);
                }
            }
        }
    }

    let get_bounds = |mut vals: Vec<f32>| -> ChannelBounds {
        if vals.is_empty() {
            return ChannelBounds { min: 0.0, max: 1.0 };
        }

        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

        let len = vals.len() as f32;

        let min_idx = (len * 0.002) as usize;
        let max_idx = (len * 0.998) as usize;

        let min = vals[min_idx.min(vals.len().saturating_sub(1))];
        let max = vals[max_idx.min(vals.len().saturating_sub(1))];

        let safe_max = if max <= min + 0.0001 { min + 1.0 } else { max };

        ChannelBounds { min, max: safe_max }
    };

    [get_bounds(r_vals), get_bounds(g_vals), get_bounds(b_vals)]
}

fn run_pipeline(
    input: &DynamicImage,
    params: &NegativeConversionParams,
    override_bounds: Option<[ChannelBounds; 3]>,
) -> DynamicImage {
    let rgb = input.to_rgb32f();
    let (width, height) = rgb.dimensions();
    let raw_pixels = rgb.as_raw();

    // Base mask compensation (orange base subtraction)
    let mask_r = params.base_mask_r.unwrap_or(1.0).clamp(0.01, 2.0);
    let mask_g = params.base_mask_g.unwrap_or(1.0).clamp(0.01, 2.0);
    let mask_b = params.base_mask_b.unwrap_or(1.0).clamp(0.01, 2.0);

    // Compute optical transmission logarithms: D_c = -log10(I / I_base)
    let log_pixels: Vec<f32> = raw_pixels
        .par_chunks(3)
        .flat_map(|px| {
            let r_norm = (px[0] / mask_r).clamp(1e-6, 1.0);
            let g_norm = (px[1] / mask_g).clamp(1e-6, 1.0);
            let b_norm = (px[2] / mask_b).clamp(1e-6, 1.0);

            vec![-r_norm.log10(), -g_norm.log10(), -b_norm.log10()]
        })
        .collect();

    let bounds = if let Some(b) = override_bounds {
        b
    } else {
        analyze_bounds(&log_pixels, width as usize, height as usize)
    };

    let mut out_buffer = vec![0.0f32; raw_pixels.len()];

    // Calibrated film emulsion spectra & gamma characteristics
    let (emulsion_r_w, emulsion_g_w, emulsion_b_w, emulsion_gamma) = match params.film_profile.as_deref() {
        Some("portra_400") => (1.05, 0.98, 1.12, 1.0 / 2.15), // Kodak Portra warm golden skin tone
        Some("portra_160") => (1.03, 0.99, 1.08, 1.0 / 2.10), // Portra 160 fine grain portraiture
        Some("portra_800") => (1.08, 0.97, 1.15, 1.0 / 2.20), // Portra 800 saturated warmth
        Some("ektar_100") => (1.10, 0.95, 1.18, 1.0 / 2.30),  // Kodak Ektar ultra-vivid landscape
        Some("gold_200") => (1.12, 1.00, 1.05, 1.0 / 2.15),   // Kodak Gold vintage nostalgic yellow/reds
        Some("fuji_400h") => (0.94, 1.06, 1.10, 1.0 / 2.18),  // Fuji Pro 400H signature pastel cyan/green
        Some("fuji_superia") => (0.96, 1.04, 1.14, 1.0 / 2.22), // Fuji Superia punchy greens
        Some("cinestill_800t") => (1.14, 0.94, 0.88, 1.0 / 2.35), // CineStill tungsten cinema halation balance
        Some("ilford_hp5") => (1.0, 1.0, 1.0, 1.0 / 2.0),     // Ilford HP5 classic silver grain
        Some("kodak_tri_x") => (1.0, 1.0, 1.0, 1.0 / 2.4),    // Tri-X 400 punchy high contrast monochrome
        _ => (1.0, 1.0, 1.0, 1.0 / 2.2),
    };

    let k = 4.0 * params.contrast.max(0.1);
    let x0 = 0.58 - (params.exposure * 0.25);
    let gamma_inv = emulsion_gamma;

    let toe = params.toe_compression.unwrap_or(0.0).clamp(-0.5, 0.5);
    let shoulder = params.shoulder_compression.unwrap_or(0.0).clamp(-0.5, 0.5);
    let shadow_cross = params.shadow_crossover.unwrap_or(0.0).clamp(-0.5, 0.5);
    let highlight_cross = params.highlight_crossover.unwrap_or(0.0).clamp(-0.5, 0.5);

    let y0 = 1.0 / (1.0 + (k * x0).exp());
    let y1 = 1.0 / (1.0 + (-k * (1.0 - x0)).exp());
    let scale = 1.0 / (y1 - y0).max(1e-4);

    out_buffer
        .par_chunks_mut(3)
        .enumerate()
        .for_each(|(i, out_pixel)| {
            let idx = i * 3;

            let mut n_r = (log_pixels[idx] - bounds[0].min) / (bounds[0].max - bounds[0].min).max(1e-4);
            let mut n_g = (log_pixels[idx + 1] - bounds[1].min) / (bounds[1].max - bounds[1].min).max(1e-4);
            let mut n_b = (log_pixels[idx + 2] - bounds[2].min) / (bounds[2].max - bounds[2].min).max(1e-4);

            n_r = n_r.max(0.0) * params.red_weight * emulsion_r_w;
            n_g = n_g.max(0.0) * params.green_weight * emulsion_g_w;
            n_b = n_b.max(0.0) * params.blue_weight * emulsion_b_w;

            // Parametric Hurter-Driffield D-Log E curve with soft toe & shoulder rolloff
            let apply_curve = |x: f32| -> f32 {
                let sigmoid = 1.0 / (1.0 + (-k * (x - x0)).exp());
                let mut s_norm = (sigmoid - y0) * scale;

                // Toe compression for deep shadow separation
                if s_norm < 0.35 && toe.abs() > 0.001 {
                    let t_fac = (0.35 - s_norm) / 0.35;
                    s_norm += toe * 0.15 * t_fac * t_fac;
                }
                // Shoulder compression for highlight roll-off
                if s_norm > 0.65 && shoulder.abs() > 0.001 {
                    let s_fac = (s_norm - 0.65) / 0.35;
                    s_norm += shoulder * 0.15 * s_fac * s_fac;
                }

                s_norm.clamp(0.0, 1.0)
            };

            let mut r = apply_curve(n_r);
            let mut g = apply_curve(n_g);
            let mut b = apply_curve(n_b);

            // Shadow / Highlight Color Crossover Correction (prevents cyan/yellow shifts)
            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            if shadow_cross.abs() > 0.001 && luma < 0.40 {
                let s_weight = (0.40 - luma) / 0.40;
                r += shadow_cross * 0.08 * s_weight;
                b -= shadow_cross * 0.06 * s_weight;
            }
            if highlight_cross.abs() > 0.001 && luma > 0.60 {
                let h_weight = (luma - 0.60) / 0.40;
                b += highlight_cross * 0.08 * h_weight;
                r -= highlight_cross * 0.05 * h_weight;
            }

            // Monochrome profile conversion
            if let Some(prof) = params.film_profile.as_deref() {
                if prof == "ilford_hp5" || prof == "kodak_tri_x" {
                    let bw = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    r = bw;
                    g = bw;
                    b = bw;
                }
            }

            // Soft highlight gamut compression
            let max_ch = r.max(g).max(b);
            if max_ch > 0.92 {
                let overflow = ((max_ch - 0.92) * 12.5).clamp(0.0, 1.0);
                let sat_reduction = overflow * overflow;

                r = r + (luma - r) * sat_reduction;
                g = g + (luma - g) * sat_reduction;
                b = b + (luma - b) * sat_reduction;
            }

            out_pixel[0] = r.clamp(0.0, 1.0).powf(gamma_inv);
            out_pixel[1] = g.clamp(0.0, 1.0).powf(gamma_inv);
            out_pixel[2] = b.clamp(0.0, 1.0).powf(gamma_inv);
        });

    let out_img = Rgb32FImage::from_vec(width, height, out_buffer).unwrap();
    DynamicImage::ImageRgb32F(out_img)
}

/// Samples the unexposed film base mask from a user-clicked ROI point or unexposed border
#[tauri::command]
pub async fn sample_negative_border_mask(
    path: String,
    norm_x: f32,
    norm_y: f32,
    norm_radius: Option<f32>,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BorderMaskSampleResult, String> {
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let img = {
        let original_lock = state.original_image.lock().unwrap();
        if let Some(loaded) = original_lock.as_ref() {
            if loaded.path == source_path_str {
                loaded.image.clone().as_ref().clone()
            } else {
                drop(original_lock);
                let bytes = fs::read(&source_path_str).map_err(|e| e.to_string())?;
                load_base_image_from_bytes(&bytes, &source_path_str, false, &settings, None)
                    .map_err(|e| e.to_string())?
            }
        } else {
            drop(original_lock);
            let bytes = fs::read(&source_path_str).map_err(|e| e.to_string())?;
            load_base_image_from_bytes(&bytes, &source_path_str, false, &settings, None)
                .map_err(|e| e.to_string())?
        }
    };

    let rgb = img.to_rgb32f();
    let (w, h) = rgb.dimensions();

    let cx = (norm_x.clamp(0.0, 1.0) * w as f32).round() as u32;
    let cy = (norm_y.clamp(0.0, 1.0) * h as f32).round() as u32;
    let rad = ((norm_radius.unwrap_or(0.02) * (w.min(h) as f32)).round() as i32).clamp(2, 64);

    let mut sum_r = 0.0f32;
    let mut sum_g = 0.0f32;
    let mut sum_b = 0.0f32;
    let mut count = 0.0f32;

    for dy in -rad..=rad {
        for dx in -rad..=rad {
            let sx = (cx as i32 + dx).clamp(0, w as i32 - 1) as u32;
            let sy = (cy as i32 + dy).clamp(0, h as i32 - 1) as u32;
            let px = rgb.get_pixel(sx, sy);
            sum_r += px[0];
            sum_g += px[1];
            sum_b += px[2];
            count += 1.0;
        }
    }

    let avg_r = (sum_r / count).max(0.01);
    let avg_g = (sum_g / count).max(0.01);
    let avg_b = (sum_b / count).max(0.01);

    let hex = format!(
        "#{:02X}{:02X}{:02X}",
        (avg_r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (avg_g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (avg_b.clamp(0.0, 1.0) * 255.0).round() as u8
    );

    Ok(BorderMaskSampleResult {
        r: avg_r,
        g: avg_g,
        b: avg_b,
        hex,
    })
}

/// Automatically searches image edges for the unexposed orange film base mask
#[tauri::command]
pub async fn auto_detect_negative_border_mask(
    path: String,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BorderMaskSampleResult, String> {
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let img = {
        let original_lock = state.original_image.lock().unwrap();
        if let Some(loaded) = original_lock.as_ref() {
            if loaded.path == source_path_str {
                loaded.image.clone().as_ref().clone()
            } else {
                drop(original_lock);
                let bytes = fs::read(&source_path_str).map_err(|e| e.to_string())?;
                load_base_image_from_bytes(&bytes, &source_path_str, false, &settings, None)
                    .map_err(|e| e.to_string())?
            }
        } else {
            let bytes = fs::read(&source_path_str).map_err(|e| e.to_string())?;
            load_base_image_from_bytes(&bytes, &source_path_str, false, &settings, None)
                .map_err(|e| e.to_string())?
        }
    };

    let rgb = img.to_rgb32f();
    let (w, h) = rgb.dimensions();

    // Sample pixels along outer 3% margin of each edge
    let mut candidate_orange_samples: Vec<(f32, f32, f32, f32)> = Vec::new(); // (r, g, b, orange_score)

    let check_pixel = |r: f32, g: f32, b: f32| -> Option<(f32, f32, f32, f32)> {
        // Orange base in negative is bright and has R > G > B
        if r > 0.35 && r > g && g > b && b > 0.05 {
            let orange_score = (r - b) + (g - b);
            Some((r, g, b, orange_score))
        } else {
            None
        }
    };

    // Sample top and bottom rows
    let border_y = (h as f32 * 0.03).max(4.0) as u32;
    for y in 0..border_y {
        for x in (0..w).step_by(10) {
            let p = rgb.get_pixel(x, y);
            if let Some(c) = check_pixel(p[0], p[1], p[2]) { candidate_orange_samples.push(c); }
            let p_bot = rgb.get_pixel(x, h - 1 - y);
            if let Some(c) = check_pixel(p_bot[0], p_bot[1], p_bot[2]) { candidate_orange_samples.push(c); }
        }
    }

    // Sample left and right columns
    let border_x = (w as f32 * 0.03).max(4.0) as u32;
    for x in 0..border_x {
        for y in (0..h).step_by(10) {
            let p = rgb.get_pixel(x, y);
            if let Some(c) = check_pixel(p[0], p[1], p[2]) { candidate_orange_samples.push(c); }
            let p_right = rgb.get_pixel(w - 1 - x, y);
            if let Some(c) = check_pixel(p_right[0], p_right[1], p_right[2]) { candidate_orange_samples.push(c); }
        }
    }

    if candidate_orange_samples.is_empty() {
        // Fallback default Portra orange base
        return Ok(BorderMaskSampleResult {
            r: 0.85,
            g: 0.58,
            b: 0.32,
            hex: "#D99452".to_string(),
        });
    }

    // Sort by highest orange score
    candidate_orange_samples.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(Ordering::Equal));
    let top_n = candidate_orange_samples.len().min(50);
    let mut sum_r = 0.0;
    let mut sum_g = 0.0;
    let mut sum_b = 0.0;
    for s in &candidate_orange_samples[..top_n] {
        sum_r += s.0;
        sum_g += s.1;
        sum_b += s.2;
    }

    let avg_r = sum_r / top_n as f32;
    let avg_g = sum_g / top_n as f32;
    let avg_b = sum_b / top_n as f32;

    let hex = format!(
        "#{:02X}{:02X}{:02X}",
        (avg_r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (avg_g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (avg_b.clamp(0.0, 1.0) * 255.0).round() as u8
    );

    Ok(BorderMaskSampleResult {
        r: avg_r,
        g: avg_g,
        b: avg_b,
        hex,
    })
}

#[tauri::command]
pub async fn preview_negative_conversion(
    path: String,
    params: NegativeConversionParams,
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let mut hasher = DefaultHasher::new();
    source_path_str.hash(&mut hasher);
    "negative_preview_base".hash(&mut hasher);
    let cache_key = hasher.finish();

    let base_image_for_processing = {
        let mut cache = state.geometry_cache.lock().unwrap();

        if let Some(cached_img) = cache.get(&cache_key) {
            cached_img.clone()
        } else {
            let image_to_downscale = {
                let original_lock = state.original_image.lock().unwrap();
                if let Some(loaded) = original_lock.as_ref() {
                    if loaded.path == source_path_str {
                        loaded.image.clone().as_ref().clone()
                    } else {
                        drop(original_lock);
                        let settings = load_settings(app_handle.clone()).unwrap_or_default();

                        match read_file_mapped(Path::new(&source_path_str)) {
                            Ok(mmap) => load_base_image_from_bytes(
                                &mmap,
                                &source_path_str,
                                false,
                                &settings,
                                None,
                            )
                            .map_err(|e| e.to_string())?,
                            Err(_e) => {
                                let bytes = fs::read(&source_path_str)
                                    .map_err(|io_err| io_err.to_string())?;
                                load_base_image_from_bytes(
                                    &bytes,
                                    &source_path_str,
                                    false,
                                    &settings,
                                    None,
                                )
                                .map_err(|e| e.to_string())?
                            }
                        }
                    }
                } else {
                    drop(original_lock);
                    let settings = load_settings(app_handle.clone()).unwrap_or_default();

                    match read_file_mapped(Path::new(&source_path_str)) {
                        Ok(mmap) => load_base_image_from_bytes(
                            &mmap,
                            &source_path_str,
                            false,
                            &settings,
                            None,
                        )
                        .map_err(|e| e.to_string())?,
                        Err(_e) => {
                            let bytes =
                                fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                            load_base_image_from_bytes(
                                &bytes,
                                &source_path_str,
                                false,
                                &settings,
                                None,
                            )
                            .map_err(|e| e.to_string())?
                        }
                    }
                }
            };

            let downscaled = downscale_f32_image(&image_to_downscale, 1080, 1080);

            cache.insert(cache_key, downscaled.clone());
            downscaled
        }
    };

    let processed = run_pipeline(&base_image_for_processing, &params, None);

    let mut buf = Cursor::new(Vec::new());
    processed
        .to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
        .map_err(|e| e.to_string())?;

    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

#[tauri::command]
pub async fn convert_negatives(
    paths: Vec<String>,
    params: NegativeConversionParams,
    app_handle: AppHandle,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        for (i, path_str) in paths.iter().enumerate() {
            let _ = app_handle.emit(
                "negative-batch-progress",
                serde_json::json!({
                    "current": i + 1,
                    "total": paths.len(),
                    "path": path_str
                }),
            );

            let (source_path, _) = parse_virtual_path(path_str);
            let real_path = source_path.to_string_lossy().to_string();

            let settings = load_settings(app_handle.clone()).unwrap_or_default();

            let img = match read_file_mapped(Path::new(&real_path)) {
                Ok(mmap) => load_base_image_from_bytes(&mmap, &real_path, false, &settings, None),
                Err(_) => {
                    let bytes = fs::read(&real_path).unwrap_or_default();
                    load_base_image_from_bytes(&bytes, &real_path, false, &settings, None)
                }
            }
            .map_err(|e| e.to_string())?;

            let bounds_ref = downscale_f32_image(&img, 1080, 1080);
            let ref_rgb = bounds_ref.to_rgb32f();
            let (ref_w, ref_h) = ref_rgb.dimensions();
            let log_pixels: Vec<f32> = ref_rgb
                .as_raw()
                .par_iter()
                .map(|&v| -v.clamp(1e-6, 1.0).log10())
                .collect();
            let bounds = analyze_bounds(&log_pixels, ref_w as usize, ref_h as usize);

            let processed = run_pipeline(&img, &params, Some(bounds));

            let p = Path::new(&real_path);
            let parent = p.parent().unwrap_or(Path::new(""));
            let stem = p.file_stem().unwrap_or_default().to_string_lossy();
            let filename = format!("{}_Positive.tiff", stem);
            let out_path = parent.join(&filename);

            processed
                .to_rgb16()
                .save(&out_path)
                .map_err(|e| format!("Failed to save {}: {}", filename, e))?;

            let _ = crate::exif_processing::write_rrexif_sidecar(&real_path, &out_path);
            results.push(out_path.to_string_lossy().to_string());
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn test_negative_inversion_flips_density() {
        let (w, h) = (32u32, 32u32);
        let mut neg_img = Rgb32FImage::new(w, h);

        for y in 0..h {
            for x in 0..w {
                // Negative: orange film base is bright (R=0.8, G=0.4, B=0.2), exposed subject is dense/dark (0.05)
                let val = if x < 16 { 0.8 } else { 0.05 };
                neg_img.put_pixel(x, y, Rgb([val, val * 0.6, val * 0.3]));
            }
        }

        let dyn_neg = DynamicImage::ImageRgb32F(neg_img);
        let params = NegativeConversionParams {
            red_weight: 1.0,
            green_weight: 1.0,
            blue_weight: 1.0,
            exposure: 0.0,
            contrast: 1.0,
            film_profile: None,
            ..Default::default()
        };

        let positive = run_pipeline(&dyn_neg, &params, None);
        let pos_rgb = positive.to_rgb32f();

        // The dense region (0.05 in negative) must become bright in positive (> 0.5)
        let highlight_p = pos_rgb.get_pixel(24, 16);
        // The unexposed orange base (0.8 in negative) must become dark in positive (< 0.5)
        let shadow_p = pos_rgb.get_pixel(8, 16);

        assert!(highlight_p[0] > shadow_p[0], "Dense negative region must invert to brighter positive");
    }

    #[test]
    fn test_film_profile_emulsion_weights() {
        let (w, h) = (16u32, 16u32);
        let mut neg_img = Rgb32FImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                neg_img.put_pixel(x, y, Rgb([0.4, 0.3, 0.2]));
            }
        }
        let dyn_neg = DynamicImage::ImageRgb32F(neg_img);

        let test_bounds = Some([
            ChannelBounds { min: 0.1, max: 1.5 },
            ChannelBounds { min: 0.1, max: 1.5 },
            ChannelBounds { min: 0.1, max: 1.5 },
        ]);

        let params_portra = NegativeConversionParams {
            film_profile: Some("portra_400".to_string()),
            ..Default::default()
        };
        let params_fuji = NegativeConversionParams {
            film_profile: Some("fuji_400h".to_string()),
            ..Default::default()
        };

        let pos_portra = run_pipeline(&dyn_neg, &params_portra, test_bounds).to_rgb32f();
        let pos_fuji = run_pipeline(&dyn_neg, &params_fuji, test_bounds).to_rgb32f();

        assert_ne!(pos_portra.get_pixel(8, 8)[0], pos_fuji.get_pixel(8, 8)[0], "Portra and Fuji profiles must yield different spectral color balances");
    }
}
