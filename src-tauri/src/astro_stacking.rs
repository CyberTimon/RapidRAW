use crate::AppState;
use crate::app_settings::AppSettings;
use crate::formats::is_raw_file;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::apply_srgb_to_linear;
use image::{DynamicImage, ImageBuffer, Rgb, Rgb32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AstroStackOptions {
    pub paths: Vec<String>,
    pub sigma_clip: f32, // e.g. 2.5
    pub stack_mode: String, // "kappa_sigma", "median", "mean"
    pub auto_dark_subtract: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AstroStackResult {
    pub output_path: Option<String>,
    pub frames_stacked: usize,
    pub stars_aligned: usize,
    pub noise_reduction_ratio: f32,
    pub message: String,
}

#[derive(Debug, Clone)]
struct StarPoint {
    x: f32,
    y: f32,
    brightness: f32,
}

/// Detects bright star centroids in a downscaled grayscale frame
fn detect_star_centroids(img: &Rgb32FImage) -> Vec<StarPoint> {
    let (width, height) = img.dimensions();
    let mut stars = Vec::new();

    // Step sampling for speed
    let step = 2;
    for y in (8..(height - 8)).step_by(step) {
        for x in (8..(width - 8)).step_by(step) {
            let p = img.get_pixel(x, y);
            let lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

            if lum > 0.15 {
                // Check if local 5x5 maximum
                let mut is_max = true;
                let mut sum_x = 0.0f32;
                let mut sum_y = 0.0f32;
                let mut sum_w = 0.0f32;

                for dy in -2..=2 {
                    for dx in -2..=2 {
                        let nx = (x as i32 + dx) as u32;
                        let ny = (y as i32 + dy) as u32;
                        let np = img.get_pixel(nx, ny);
                        let nlum = 0.2126 * np[0] + 0.7152 * np[1] + 0.0722 * np[2];
                        if (dx != 0 || dy != 0) && nlum >= lum {
                            is_max = false;
                            break;
                        }
                        sum_x += nx as f32 * nlum;
                        sum_y += ny as f32 * nlum;
                        sum_w += nlum;
                    }
                    if !is_max {
                        break;
                    }
                }

                if is_max && sum_w > 0.0 {
                    let cx = sum_x / sum_w;
                    let cy = sum_y / sum_w;
                    stars.push(StarPoint {
                        x: cx,
                        y: cy,
                        brightness: lum,
                    });
                }
            }
        }
    }

    stars.sort_by(|a, b| b.brightness.partial_cmp(&a.brightness).unwrap_or(std::cmp::Ordering::Equal));
    stars.truncate(100); // Keep top 100 brightest stars
    stars
}

/// Computes average translation offset (dx, dy) between star sets
fn calculate_translation(ref_stars: &[StarPoint], target_stars: &[StarPoint], max_dist: f32) -> (f32, f32) {
    if ref_stars.is_empty() || target_stars.is_empty() {
        return (0.0, 0.0);
    }

    let mut dx_votes = Vec::new();
    let mut dy_votes = Vec::new();

    for r in ref_stars.iter().take(30) {
        for t in target_stars.iter().take(30) {
            let dx = r.x - t.x;
            let dy = r.y - t.y;
            if dx.abs() < max_dist && dy.abs() < max_dist {
                dx_votes.push(dx);
                dy_votes.push(dy);
            }
        }
    }

    if dx_votes.is_empty() {
        return (0.0, 0.0);
    }

    // Median of votes
    dx_votes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    dy_votes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let med_dx = dx_votes[dx_votes.len() / 2];
    let med_dy = dy_votes[dy_votes.len() / 2];

    (med_dx, med_dy)
}

/// Stacks a series of astro frames using Kappa-Sigma clipping or Median
pub fn process_astro_stack(
    options: &AstroStackOptions,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    if options.paths.len() < 2 {
        return Err("Astro Stacking requires at least 2 frames".to_string());
    }

    let _ = app_handle.emit("astro-progress", "Loading astronomical frames...");

    let mut loaded_frames: Vec<Rgb32FImage> = Vec::new();
    let mut dims: Option<(u32, u32)> = None;

    for (idx, path) in options.paths.iter().enumerate() {
        let _ = app_handle.emit(
            "astro-progress",
            format!(
                "Decoding frame {}/{} ('{}')...",
                idx + 1,
                options.paths.len(),
                Path::new(path).file_name().unwrap_or_default().to_string_lossy()
            ),
        );

        let file_bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
        let mut dynamic_img = load_base_image_from_bytes(&file_bytes, path, false, settings, None)
            .map_err(|e| format!("Failed to decode {}: {}", path, e))?;

        if !is_raw_file(path) {
            dynamic_img = apply_srgb_to_linear(dynamic_img);
        }

        let rgb32f = dynamic_img.to_rgb32f();
        let (w, h) = rgb32f.dimensions();

        if let Some((dw, dh)) = dims {
            if dw != w || dh != h {
                return Err(format!("Frame dimension mismatch: expected {}x{}, got {}x{}", dw, dh, w, h));
            }
        } else {
            dims = Some((w, h));
        }

        loaded_frames.push(rgb32f);
    }

    let (width, height) = dims.unwrap();
    let total_frames = loaded_frames.len();

    let _ = app_handle.emit("astro-progress", "Aligning star fields...");

    // Star detection on reference frame (frame 0)
    let ref_stars = detect_star_centroids(&loaded_frames[0]);

    // Align each frame to frame 0
    for i in 1..total_frames {
        let target_stars = detect_star_centroids(&loaded_frames[i]);
        let (dx, dy) = calculate_translation(&ref_stars, &target_stars, (width as f32 * 0.15).max(50.0));

        if dx.abs() > 0.2 || dy.abs() > 0.2 {
            let mut shifted = Rgb32FImage::new(width, height);
            let frame_ref = &loaded_frames[i];

            for y in 0..height {
                for x in 0..width {
                    let sx = (x as f32 - dx).round() as i32;
                    let sy = (y as f32 - dy).round() as i32;

                    if sx >= 0 && sx < width as i32 && sy >= 0 && sy < height as i32 {
                        shifted.put_pixel(x, y, *frame_ref.get_pixel(sx as u32, sy as u32));
                    }
                }
            }
            loaded_frames[i] = shifted;
        }
    }

    let _ = app_handle.emit("astro-progress", "Performing Kappa-Sigma clipping stack...");

    let kappa = if options.sigma_clip > 0.5 { options.sigma_clip } else { 2.5 };

    // Parallel per-row pixel stacking
    let row_stride = (width * 3) as usize;
    let mut out_raw = vec![0.0f32; (width * height * 3) as usize];

    out_raw
        .par_chunks_mut(row_stride)
        .enumerate()
        .for_each(|(y_idx, row_slice)| {
            let y = y_idx as u32;
            let mut pixel_r = vec![0.0f32; total_frames];
            let mut pixel_g = vec![0.0f32; total_frames];
            let mut pixel_b = vec![0.0f32; total_frames];

            for x in 0..width {
                for i in 0..total_frames {
                    let p = loaded_frames[i].get_pixel(x, y);
                    pixel_r[i] = p[0];
                    pixel_g[i] = p[1];
                    pixel_b[i] = p[2];
                }

                let (final_r, final_g, final_b) = if options.stack_mode == "median" {
                    pixel_r.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    pixel_g.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    pixel_b.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    (
                        pixel_r[total_frames / 2],
                        pixel_g[total_frames / 2],
                        pixel_b[total_frames / 2],
                    )
                } else {
                    // Kappa-Sigma Clipping
                    (
                        kappa_sigma_mean(&pixel_r, kappa),
                        kappa_sigma_mean(&pixel_g, kappa),
                        kappa_sigma_mean(&pixel_b, kappa),
                    )
                };

                let out_idx = (x * 3) as usize;
                row_slice[out_idx] = final_r;
                row_slice[out_idx + 1] = final_g;
                row_slice[out_idx + 2] = final_b;
            }
        });

    let buffer = ImageBuffer::<Rgb<f32>, _>::from_raw(width, height, out_raw)
        .ok_or_else(|| "Failed to construct stacked image buffer".to_string())?;

    let final_dyn = DynamicImage::ImageRgb32F(buffer);
    let _ = app_handle.emit("astro-progress", "Astro stacking complete!");

    Ok(final_dyn)
}

fn kappa_sigma_mean(values: &[f32], kappa: f32) -> f32 {
    let n = values.len() as f32;
    if n <= 2.0 {
        return values.iter().sum::<f32>() / n;
    }

    let mean = values.iter().sum::<f32>() / n;
    let variance = values.iter().map(|&v| (v - mean).powi(2)).sum::<f32>() / (n - 1.0);
    let std_dev = variance.sqrt();

    let mut kept_sum = 0.0f32;
    let mut kept_count = 0.0f32;

    for &v in values {
        if (v - mean).abs() <= kappa * std_dev {
            kept_sum += v;
            kept_count += 1.0;
        }
    }

    if kept_count > 0.0 {
        kept_sum / kept_count
    } else {
        mean
    }
}

#[tauri::command]
pub fn stack_astro_frames(
    options: AstroStackOptions,
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    let settings = AppSettings::default();
    let stacked_image = process_astro_stack(&options, &app_handle, &settings)?;

    let mut hdr_guard = state.hdr_result.lock().map_err(|e| e.to_string())?;
    *hdr_guard = Some(stacked_image);

    Ok("Astro stack completed successfully".to_string())
}
