use crate::AppState;
use crate::image_processing;
use image::{DynamicImage, GenericImageView, Rgb};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::f32::consts::PI;
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct AutoHorizonResult {
    pub angle_degrees: f32,
    pub confidence: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaliencyCropResult {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub target_aspect_ratio: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DustSpotHealResult {
    pub spots_detected: usize,
    pub message: String,
}

/// Detects the dominant horizon angle within [-15.0, 15.0] degrees.
pub fn detect_horizon_angle(image: &DynamicImage) -> AutoHorizonResult {
    let (width, height) = image.dimensions();
    if width < 32 || height < 32 {
        return AutoHorizonResult { angle_degrees: 0.0, confidence: 0.0 };
    }

    // Work on a fast downscaled grayscale representation
    let thumb = image.thumbnail(512, 512).to_luma8();
    let (tw, th) = thumb.dimensions();

    let mut angle_histogram = vec![0.0f32; 301]; // -15.0 to +15.0 degrees in 0.1 deg steps

    let rad_to_deg = 180.0 / PI;

    for y in 1..(th - 1) {
        for x in 1..(tw - 1) {
            let p_left = thumb.get_pixel(x - 1, y)[0] as f32;
            let p_right = thumb.get_pixel(x + 1, y)[0] as f32;
            let p_top = thumb.get_pixel(x, y - 1)[0] as f32;
            let p_bot = thumb.get_pixel(x, y + 1)[0] as f32;

            let gx = p_right - p_left;
            let gy = p_bot - p_top;
            let mag = (gx * gx + gy * gy).sqrt();

            if mag > 15.0 {
                // Gradient is perpendicular to the edge; edge angle is atan2(gy, gx) - 90 deg
                let raw_angle_rad = gy.atan2(gx);
                let edge_angle_deg = (raw_angle_rad * rad_to_deg) - 90.0;
                let mut norm_angle = edge_angle_deg;
                while norm_angle > 90.0 { norm_angle -= 180.0; }
                while norm_angle < -90.0 { norm_angle += 180.0; }

                if norm_angle >= -15.0 && norm_angle <= 15.0 {
                    let bin = ((norm_angle + 15.0) * 10.0).round().clamp(0.0, 300.0) as usize;
                    angle_histogram[bin] += mag;
                }
            }
        }
    }

    // Find smoothed peak in histogram
    let mut smoothed = vec![0.0f32; angle_histogram.len()];
    for i in 2..(angle_histogram.len() - 2) {
        smoothed[i] = (angle_histogram[i - 2] * 0.1)
            + (angle_histogram[i - 1] * 0.2)
            + (angle_histogram[i] * 0.4)
            + (angle_histogram[i + 1] * 0.2)
            + (angle_histogram[i + 2] * 0.1);
    }

    let mut max_val = 0.0f32;
    let mut best_bin = 150; // default 0.0 degrees
    let total_energy: f32 = smoothed.iter().sum();

    for (bin, &val) in smoothed.iter().enumerate() {
        if val > max_val {
            max_val = val;
            best_bin = bin;
        }
    }

    let detected_angle = (best_bin as f32 / 10.0) - 15.0;
    let confidence = if total_energy > 0.0 { (max_val / total_energy) * 10.0 } else { 0.0 }.clamp(0.0, 1.0);

    AutoHorizonResult {
        angle_degrees: -detected_angle, // Counter-rotation to level horizon
        confidence,
    }
}

/// Calculates rule-of-thirds & golden-ratio saliency crop recommendation.
pub fn calculate_saliency_crop(image: &DynamicImage, aspect_ratio: f32) -> SaliencyCropResult {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return SaliencyCropResult {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            target_aspect_ratio: 1.0,
        };
    }

    let thumb = image.thumbnail(256, 256).to_luma8();
    let (tw, th) = thumb.dimensions();

    let mut total_saliency = 0.0f32;
    let mut cx_sum = 0.0f32;
    let mut cy_sum = 0.0f32;

    if tw > 2 && th > 2 {
        for y in 1..(th - 1) {
            for x in 1..(tw - 1) {
                let p = thumb.get_pixel(x, y)[0] as f32;
                let p_r = thumb.get_pixel(x + 1, y)[0] as f32;
                let p_b = thumb.get_pixel(x, y + 1)[0] as f32;
                let grad = ((p_r - p).abs() + (p_b - p).abs()).max(0.0);
                
                // Prioritize center-weighted and high-contrast regions
                let nx = (x as f32 / tw as f32) - 0.5;
                let ny = (y as f32 / th as f32) - 0.5;
                let dist_center = 1.0 - (nx * nx + ny * ny).sqrt() * 0.5;

                let sal = grad * dist_center;
                total_saliency += sal;
                cx_sum += (x as f32 / tw as f32) * sal;
                cy_sum += (y as f32 / th as f32) * sal;
            }
        }
    }

    let focal_x = if total_saliency > 0.0 { cx_sum / total_saliency } else { 0.5 };
    let focal_y = if total_saliency > 0.0 { cy_sum / total_saliency } else { 0.5 };

    let img_ar = width as f32 / height as f32;
    let target_ar = if aspect_ratio > 0.01 { aspect_ratio } else { img_ar };

    // Ratio of target aspect ratio to image aspect ratio
    let r = target_ar / img_ar;

    // Standard high-quality crop box coverage (88% of constraining dimension)
    let (crop_w, crop_h) = if r >= 1.0 {
        let w = 0.88f32;
        let h = (w / r).clamp(0.05, 1.0);
        (w, h)
    } else {
        let h = 0.88f32;
        let w = (h * r).clamp(0.05, 1.0);
        (w, h)
    };

    // Compositional anchor placement:
    // Place focal point at golden ratio (~0.382 / 0.618) or center (0.5)
    let anchor_x = if focal_x < 0.45 {
        0.382f32
    } else if focal_x > 0.55 {
        0.618f32
    } else {
        0.5f32
    };

    let anchor_y = if focal_y < 0.45 {
        0.382f32
    } else if focal_y > 0.55 {
        0.618f32
    } else {
        0.5f32
    };

    let max_x = (1.0f32 - crop_w).max(0.0);
    let max_y = (1.0f32 - crop_h).max(0.0);

    let crop_x = (focal_x - crop_w * anchor_x).clamp(0.0, max_x);
    let crop_y = (focal_y - crop_h * anchor_y).clamp(0.0, max_y);

    SaliencyCropResult {
        x: crop_x * 100.0,
        y: crop_y * 100.0,
        width: crop_w * 100.0,
        height: crop_h * 100.0,
        target_aspect_ratio: target_ar,
    }
}

/// Detects and heals dark circular sensor dust spots in the upper sky region.
pub fn heal_sky_dust_spots(image: &mut DynamicImage) -> DustSpotHealResult {
    let (width, height) = image.dimensions();
    if width < 64 || height < 64 {
        return DustSpotHealResult { spots_detected: 0, message: "Image too small".to_string() };
    }

    let mut rgb_img = image.to_rgb32f();
    let sky_limit_y = (height as f32 * 0.65) as u32;

    let mut spot_coords: Vec<(u32, u32, u32)> = Vec::new(); // (x, y, radius)

    // Detect dust spots using 5x5 Laplacian of Gaussian kernel
    for y in 12..(sky_limit_y.saturating_sub(12)) {
        for x in 12..(width - 12) {
            let center_p = rgb_img.get_pixel(x, y);
            let lum_center = 0.2126 * center_p[0] + 0.7152 * center_p[1] + 0.0722 * center_p[2];

            // Only check bright / sky regions (luminance > 0.35)
            if lum_center < 0.35 {
                continue;
            }

            // Sample surrounding ring at radius r=6
            let mut ring_lum = 0.0f32;
            let samples = 8;
            for s in 0..samples {
                let angle = (s as f32 / samples as f32) * 2.0 * PI;
                let sx = (x as f32 + angle.cos() * 6.0).round() as u32;
                let sy = (y as f32 + angle.sin() * 6.0).round() as u32;
                let sp = rgb_img.get_pixel(sx.min(width - 1), sy.min(height - 1));
                ring_lum += 0.2126 * sp[0] + 0.7152 * sp[1] + 0.0722 * sp[2];
            }
            ring_lum /= samples as f32;

            // Dust spot is darker than surrounding smooth sky by at least 3.5%
            let diff = ring_lum - lum_center;
            if diff > 0.035 && diff < 0.25 {
                // Check if not already near a detected spot
                if !spot_coords.iter().any(|&(sx, sy, _)| (sx as i32 - x as i32).abs() < 12 && (sy as i32 - y as i32).abs() < 12) {
                    spot_coords.push((x, y, 6));
                }
            }
        }
    }

    let spots_count = spot_coords.len();

    // Inpaint each detected dust spot
    for &(sx, sy, r) in &spot_coords {
        let r_f = r as f32;
        for dy in -(r as i32)..=(r as i32) {
            for dx in -(r as i32)..=(r as i32) {
                let dist = ((dx * dx + dy * dy) as f32).sqrt();
                if dist <= r_f {
                    let px = (sx as i32 + dx).clamp(0, width as i32 - 1) as u32;
                    let py = (sy as i32 + dy).clamp(0, height as i32 - 1) as u32;

                    // Interpolate smoothly from outer boundary ring
                    let factor = (dist / r_f).clamp(0.0, 1.0);
                    let edge_x = (sx as f32 + (dx as f32 / dist.max(0.1)) * (r_f + 2.0)).clamp(0.0, width as f32 - 1.0) as u32;
                    let edge_y = (sy as f32 + (dy as f32 / dist.max(0.1)) * (r_f + 2.0)).clamp(0.0, height as f32 - 1.0) as u32;
                    let edge_p = *rgb_img.get_pixel(edge_x, edge_y);

                    let orig_p = rgb_img.get_pixel(px, py);
                    let blend_w = (1.0 - factor).powi(2);

                    let healed = Rgb([
                        orig_p[0] * (1.0 - blend_w) + edge_p[0] * blend_w,
                        orig_p[1] * (1.0 - blend_w) + edge_p[1] * blend_w,
                        orig_p[2] * (1.0 - blend_w) + edge_p[2] * blend_w,
                    ]);
                    rgb_img.put_pixel(px, py, healed);
                }
            }
        }
    }

    if spots_count > 0 {
        *image = DynamicImage::ImageRgb32F(rgb_img);
    }

    DustSpotHealResult {
        spots_detected: spots_count,
        message: format!("Successfully healed {} dust spot(s)", spots_count),
    }
}

#[tauri::command]
pub fn detect_auto_horizon(state: State<AppState>) -> Result<AutoHorizonResult, String> {
    if let Ok(preview_guard) = state.cached_preview.lock()
        && let Some(cached) = &*preview_guard
    {
        return Ok(detect_horizon_angle(&cached.image));
    }

    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded_image) = &*orig_guard {
        Ok(detect_horizon_angle(&loaded_image.image))
    } else {
        Err("No active image loaded".to_string())
    }
}

#[tauri::command]
pub fn get_saliency_crop_recommendation(
    aspect_ratio: f32,
    orientation_steps: Option<u8>,
    flip_horizontal: Option<bool>,
    flip_vertical: Option<bool>,
    state: State<AppState>,
) -> Result<SaliencyCropResult, String> {
    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded_image) = &*orig_guard {
        let mut cow_img = Cow::Borrowed(loaded_image.image.as_ref());
        let flip_h = flip_horizontal.unwrap_or(false);
        let flip_v = flip_vertical.unwrap_or(false);
        if flip_h || flip_v {
            cow_img = image_processing::apply_flip(cow_img, flip_h, flip_v);
        }
        if let Some(steps) = orientation_steps {
            if steps > 0 {
                cow_img = image_processing::apply_coarse_rotation(cow_img, steps);
            }
        }
        Ok(calculate_saliency_crop(&cow_img, aspect_ratio))
    } else {
        Err("No active image loaded".to_string())
    }
}
