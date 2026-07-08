use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::image_loader::load_base_image_raw;
use image::{DynamicImage, Rgb32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use tauri::AppHandle;

use crate::AppState;
use crate::image_processing::downscale_f32_image;
use crate::load_settings;
use tauri::Emitter;

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct NegativeConversionParams {
    pub red_weight: f32,
    pub green_weight: f32,
    pub blue_weight: f32,

    pub exposure: f32,
    pub contrast: f32,
}

impl Default for NegativeConversionParams {
    fn default() -> Self {
        Self {
            red_weight: 1.0,
            green_weight: 1.0,
            blue_weight: 1.0,
            exposure: 0.0,
            contrast: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ChannelBounds {
    pub min: f32,
    pub max: f32,
}

fn analyze_bounds(log_data: &[f32], width: usize, height: usize) -> [ChannelBounds; 3] {
    let margin_x = (width as f32 * 0.12) as usize;
    let margin_y = (height as f32 * 0.12) as usize;

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

        let min_idx = (len * 0.001) as usize;
        let max_idx = (len * 0.999) as usize;

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

    let log_pixels: Vec<f32> = raw_pixels
        .par_iter()
        .map(|&v| -v.clamp(1e-6, 1.0).log10())
        .collect();

    let bounds = if let Some(b) = override_bounds {
        b
    } else {
        analyze_bounds(&log_pixels, width as usize, height as usize)
    };

    let mut out_buffer = vec![0.0f32; raw_pixels.len()];

    let k = 4.0 * params.contrast.max(0.1);
    let x0 = 0.6 - (params.exposure * 0.25);
    let gamma_inv = 1.0 / 2.2;

    let y0 = 1.0 / (1.0 + (k * x0).exp());
    let y1 = 1.0 / (1.0 + (-k * (1.0 - x0)).exp());
    let scale = 1.0 / (y1 - y0);

    out_buffer
        .par_chunks_mut(3)
        .enumerate()
        .for_each(|(i, out_pixel)| {
            let idx = i * 3;

            let mut n_r = (log_pixels[idx] - bounds[0].min) / (bounds[0].max - bounds[0].min);
            let mut n_g = (log_pixels[idx + 1] - bounds[1].min) / (bounds[1].max - bounds[1].min);
            let mut n_b = (log_pixels[idx + 2] - bounds[2].min) / (bounds[2].max - bounds[2].min);

            n_r = n_r.max(0.0) * params.red_weight;
            n_g = n_g.max(0.0) * params.green_weight;
            n_b = n_b.max(0.0) * params.blue_weight;

            let apply_curve = |x: f32| -> f32 {
                let sigmoid = 1.0 / (1.0 + (-k * (x - x0)).exp());
                let s_norm = (sigmoid - y0) * scale;
                s_norm.clamp(0.0, 1.0)
            };

            let mut r = apply_curve(n_r);
            let mut g = apply_curve(n_g);
            let mut b = apply_curve(n_b);

            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let max_ch = r.max(g).max(b);

            if max_ch > 0.9 {
                let overflow = ((max_ch - 0.9) * 10.0).clamp(0.0, 1.0);
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

fn stored_negative(
    adjustments: &serde_json::Value,
) -> Option<(NegativeConversionParams, [ChannelBounds; 3])> {
    let nc = adjustments.get("negativeConversion")?;
    if !nc.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false) {
        return None;
    }
    let get = |k: &str, d: f32| {
        nc.get(k)
            .and_then(|v| v.as_f64())
            .map(|v| v as f32)
            .unwrap_or(d)
    };
    let params = NegativeConversionParams {
        red_weight: get("redWeight", 1.0),
        green_weight: get("greenWeight", 1.0),
        blue_weight: get("blueWeight", 1.0),
        exposure: get("exposure", 0.0),
        contrast: get("contrast", 1.0),
    };
    let arr = nc.get("bounds")?.as_array()?;
    if arr.len() != 3 {
        return None;
    }
    let mut bounds = [ChannelBounds { min: 0.0, max: 1.0 }; 3];
    for (i, b) in bounds.iter_mut().enumerate() {
        let pair = arr[i].as_array()?;
        b.min = pair.first()?.as_f64()? as f32;
        b.max = pair.get(1)?.as_f64()? as f32;
    }
    Some((params, bounds))
}

/// Invert a flagged negative to a positive on load; a no-op for normal images.
pub fn maybe_apply_negative(image: DynamicImage, real_path: &str) -> DynamicImage {
    let sidecar = crate::exif_processing::get_primary_sidecar_path(Path::new(real_path));
    if !sidecar.exists() {
        return image;
    }
    let meta = crate::exif_processing::load_sidecar(&sidecar);
    match stored_negative(&meta.adjustments) {
        Some((params, bounds)) => run_pipeline(&image, &params, Some(bounds)),
        None => image,
    }
}

fn analyze_bounds_for(image: &DynamicImage) -> [ChannelBounds; 3] {
    let ref_img = downscale_f32_image(image, 1080, 1080);
    let ref_rgb = ref_img.to_rgb32f();
    let (w, h) = ref_rgb.dimensions();
    let log_pixels: Vec<f32> = ref_rgb
        .as_raw()
        .par_iter()
        .map(|&v| -v.clamp(1e-6, 1.0).log10())
        .collect();
    analyze_bounds(&log_pixels, w as usize, h as usize)
}

/// Turn the in-library negative conversion on (`enabled = true`, stores auto-bounds in
/// the sidecar) or off (`enabled = false`, removes it) for the given raws.
#[tauri::command]
pub async fn set_negative_conversion(
    paths: Vec<String>,
    enabled: bool,
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Vec<String>, String> {
    let handle = app_handle.clone();
    let results = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let mut results = Vec::new();

        for (i, path_str) in paths.iter().enumerate() {
            let _ = handle.emit(
                "negative-batch-progress",
                serde_json::json!({ "current": i + 1, "total": paths.len(), "path": path_str }),
            );

            let (source_path, _) = parse_virtual_path(path_str);
            let sidecar = crate::exif_processing::get_primary_sidecar_path(&source_path);
            let mut meta = crate::exif_processing::load_sidecar(&sidecar);
            if !meta.adjustments.is_object() {
                meta.adjustments = serde_json::json!({});
            }

            if enabled {
                let real_path = source_path.to_string_lossy().to_string();
                let settings = load_settings(handle.clone()).unwrap_or_default();
                let img = match read_file_mapped(Path::new(&real_path)) {
                    Ok(mmap) => load_base_image_raw(&mmap, &real_path, false, &settings, None),
                    Err(_) => {
                        let bytes = fs::read(&real_path).map_err(|e| e.to_string())?;
                        load_base_image_raw(&bytes, &real_path, false, &settings, None)
                    }
                }
                .map_err(|e| e.to_string())?;

                let bounds = analyze_bounds_for(&img);
                meta.adjustments["negativeConversion"] = serde_json::json!({
                    "enabled": true,
                    "bounds": [
                        [bounds[0].min, bounds[0].max],
                        [bounds[1].min, bounds[1].max],
                        [bounds[2].min, bounds[2].max],
                    ],
                });
            } else if let Some(obj) = meta.adjustments.as_object_mut() {
                obj.remove("negativeConversion");
            }

            let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
            fs::write(&sidecar, json).map_err(|e| e.to_string())?;
            results.push(path_str.clone());
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())??;

    // The base image changed; drop cached decodes/previews so the new render is used.
    if let Ok(mut c) = state.decoded_image_cache.lock() {
        c.clear();
    }
    if let Ok(mut c) = state.geometry_cache.lock() {
        c.clear();
    }
    if let Ok(mut c) = state.cached_preview.lock() {
        *c = None;
    }
    if let Ok(mut c) = state.full_warped_cache.lock() {
        *c = None;
    }
    if let Ok(mut c) = state.full_transformed_cache.lock() {
        *c = None;
    }

    // Thumbnails don't refresh from a sidecar edit on their own — regenerate off-thread.
    let regen_paths = results.clone();
    let regen_handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_management::regenerate_thumbnails_for_paths(&regen_paths, &regen_handle);
    });

    let _ = app_handle.emit("negatives-converted", &results);

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_negative_reads_the_written_shape() {
        let adjustments = serde_json::json!({
            "exposure": 0.3, // an unrelated adjustment coexists in the sidecar
            "negativeConversion": {
                "enabled": true,
                "redWeight": 1.2, "greenWeight": 1.0, "blueWeight": 0.9,
                "exposure": 0.5, "contrast": 1.3,
                "bounds": [[0.1, 0.8], [0.2, 0.9], [0.15, 0.85]],
            }
        });
        let (params, bounds) = stored_negative(&adjustments).expect("enabled conversion parses");
        assert!((params.red_weight - 1.2).abs() < 1e-6);
        assert!((params.blue_weight - 0.9).abs() < 1e-6);
        assert!((params.contrast - 1.3).abs() < 1e-6);
        assert!((bounds[0].min - 0.1).abs() < 1e-6);
        assert!((bounds[2].max - 0.85).abs() < 1e-6);

        // Absent or disabled → no-op on load.
        assert!(stored_negative(&serde_json::json!({})).is_none());
        assert!(
            stored_negative(&serde_json::json!({ "negativeConversion": { "enabled": false } }))
                .is_none()
        );
    }
}
