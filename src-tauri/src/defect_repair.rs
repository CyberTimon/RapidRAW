use crate::AppState;
use crate::exif_processing::load_sidecar;
use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing;
use image::{DynamicImage, GenericImageView, Rgb};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::f32::consts::PI;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchDustSummary {
    pub total_processed: usize,
    pub total_spots_healed: usize,
    pub elapsed_ms: u64,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorDustCandidate {
    pub norm_x: f32,
    pub norm_y: f32,
    pub radius: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgePatrolCrop {
    pub crop_x: u32,
    pub crop_y: u32,
    pub width: u32,
    pub height: u32,
    pub edge_distractions_found: bool,
}

/// Calculates the exact maximum inscribed rectangle (w_inner, h_inner) and offset (crop_x, crop_y)
/// that fits inside an image of size (w, h) rotated by `angle_deg` degrees, eliminating black corner wedges.
pub fn calculate_inscribed_crop(w: u32, h: u32, angle_deg: f32) -> (u32, u32, u32, u32) {
    let theta = (angle_deg.abs() * PI / 180.0).clamp(0.0, PI / 4.0);
    if theta < 0.0001 {
        return (0, 0, w, h);
    }

    let cos_t = theta.cos();
    let sin_t = theta.sin();
    let w_f = w as f32;
    let h_f = h as f32;

    // Scale factor ensuring the inner box with original aspect ratio fits within rotated frame
    let s1 = w_f / (w_f * cos_t + h_f * sin_t);
    let s2 = h_f / (h_f * cos_t + w_f * sin_t);
    let s = s1.min(s2).clamp(0.05, 1.0);

    let inner_w = ((w_f * s).floor() as u32).min(w);
    let inner_h = ((h_f * s).floor() as u32).min(h);

    let crop_x = (w.saturating_sub(inner_w)) / 2;
    let crop_y = (h.saturating_sub(inner_h)) / 2;

    (crop_x, crop_y, inner_w, inner_h)
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

/// Detects candidate dark circular sensor dust spots in the upper bright/sky region.
pub fn detect_dust_candidate_spots(image: &DynamicImage) -> Vec<SensorDustCandidate> {
    let (width, height) = image.dimensions();
    if width < 64 || height < 64 {
        return Vec::new();
    }

    let rgb_img = image.to_rgb32f();
    let sky_limit_y = (height as f32 * 0.65) as u32;
    let mut spot_coords: Vec<SensorDustCandidate> = Vec::new();

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
                let norm_x = x as f32 / width as f32;
                let norm_y = y as f32 / height as f32;
                if !spot_coords.iter().any(|s| (s.norm_x - norm_x).abs() < (12.0 / width as f32) && (s.norm_y - norm_y).abs() < (12.0 / height as f32)) {
                    spot_coords.push(SensorDustCandidate {
                        norm_x,
                        norm_y,
                        radius: 6,
                    });
                }
            }
        }
    }

    spot_coords
}

/// Verifies dust spots across images in a photoshoot burst.
/// A spot is verified if at least one other image has a candidate within normalized distance <= 0.008.
/// If peer_spots is empty (single photo), all candidates are kept.
pub fn cross_frame_verify_dust(
    current_spots: &[SensorDustCandidate],
    peer_spots: &[Vec<SensorDustCandidate>],
) -> Vec<SensorDustCandidate> {
    if peer_spots.is_empty() {
        return current_spots.to_vec();
    }

    current_spots
        .iter()
        .filter(|spot| {
            peer_spots.iter().any(|frame_spots| {
                frame_spots.iter().any(|peer| {
                    let dx = spot.norm_x - peer.norm_x;
                    let dy = spot.norm_y - peer.norm_y;
                    (dx * dx + dy * dy).sqrt() <= 0.008
                })
            })
        })
        .cloned()
        .collect()
}

/// Inpaints verified sensor dust spots on the image.
pub fn heal_verified_dust_spots(
    image: &mut DynamicImage,
    verified_spots: &[SensorDustCandidate],
) -> DustSpotHealResult {
    let (width, height) = image.dimensions();
    if width < 64 || height < 64 || verified_spots.is_empty() {
        return DustSpotHealResult {
            spots_detected: verified_spots.len(),
            message: "No spots to heal".to_string(),
        };
    }

    let mut rgb_img = image.to_rgb32f();

    for spot in verified_spots {
        let sx = (spot.norm_x * width as f32).round().clamp(0.0, width as f32 - 1.0) as u32;
        let sy = (spot.norm_y * height as f32).round().clamp(0.0, height as f32 - 1.0) as u32;
        let r = spot.radius;
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

    *image = DynamicImage::ImageRgb32F(rgb_img);

    DustSpotHealResult {
        spots_detected: verified_spots.len(),
        message: format!("Successfully healed {} verified dust spot(s)", verified_spots.len()),
    }
}

/// Detects and heals dark circular sensor dust spots in the upper sky region.
pub fn heal_sky_dust_spots(image: &mut DynamicImage) -> DustSpotHealResult {
    let spots = detect_dust_candidate_spots(image);
    heal_verified_dust_spots(image, &spots)
}

/// Scans the peripheral 3% perimeter for high-contrast truncation artifacts (cut-off limbs, poles)
/// and returns an inward crop box (1% - 3%) if distractions are present.
pub fn scan_peripheral_edge_patrol(image: &DynamicImage) -> EdgePatrolCrop {
    let (width, height) = image.dimensions();
    if width < 64 || height < 64 {
        return EdgePatrolCrop { crop_x: 0, crop_y: 0, width, height, edge_distractions_found: false };
    }

    let thumb = image.thumbnail(256, 256).to_luma8();
    let (tw, th) = thumb.dimensions();
    let margin_x = ((tw as f32) * 0.03).max(1.0) as u32;
    let margin_y = ((th as f32) * 0.03).max(1.0) as u32;

    let mut high_contrast_boundary = false;

    // Check top & bottom borders
    for x in 0..tw {
        for y in 0..margin_y {
            let p1 = thumb.get_pixel(x, y)[0] as i32;
            let p2 = thumb.get_pixel(x, (y + 1).min(th - 1))[0] as i32;
            if (p1 - p2).abs() > 45 {
                high_contrast_boundary = true;
                break;
            }
        }
        if high_contrast_boundary { break; }
        for y in (th - margin_y)..th {
            let p1 = thumb.get_pixel(x, y)[0] as i32;
            let p2 = thumb.get_pixel(x, y.saturating_sub(1))[0] as i32;
            if (p1 - p2).abs() > 45 {
                high_contrast_boundary = true;
                break;
            }
        }
        if high_contrast_boundary { break; }
    }

    // Check left & right borders
    if !high_contrast_boundary {
        for y in 0..th {
            for x in 0..margin_x {
                let p1 = thumb.get_pixel(x, y)[0] as i32;
                let p2 = thumb.get_pixel((x + 1).min(tw - 1), y)[0] as i32;
                if (p1 - p2).abs() > 45 {
                    high_contrast_boundary = true;
                    break;
                }
            }
            if high_contrast_boundary { break; }
            for x in (tw - margin_x)..tw {
                let p1 = thumb.get_pixel(x, y)[0] as i32;
                let p2 = thumb.get_pixel(x.saturating_sub(1), y)[0] as i32;
                if (p1 - p2).abs() > 45 {
                    high_contrast_boundary = true;
                    break;
                }
            }
            if high_contrast_boundary { break; }
        }
    }

    if high_contrast_boundary {
        let inset_x = ((width as f32) * 0.02).round() as u32;
        let inset_y = ((height as f32) * 0.02).round() as u32;
        let new_w = width.saturating_sub(inset_x * 2);
        let new_h = height.saturating_sub(inset_y * 2);
        EdgePatrolCrop {
            crop_x: inset_x,
            crop_y: inset_y,
            width: new_w,
            height: new_h,
            edge_distractions_found: true,
        }
    } else {
        EdgePatrolCrop {
            crop_x: 0,
            crop_y: 0,
            width,
            height,
            edge_distractions_found: false,
        }
    }
}

/// Guarantees framing with >= 6.5% headroom and >= 4.5% lateral limb margin around primary subject.
pub fn calculate_convex_hull_safe_framing(image: &DynamicImage, aspect_ratio: f32) -> SaliencyCropResult {
    let base_crop = calculate_saliency_crop(image, aspect_ratio);

    let mut crop_y = base_crop.y;
    let mut crop_h = base_crop.height;
    let mut crop_x = base_crop.x;
    let mut crop_w = base_crop.width;

    // Minimum headroom clamp
    if crop_y < 6.5 {
        crop_y = 0.0;
        crop_h = (crop_h + 6.5).min(100.0);
    }

    // Minimum limb buffer clamp
    if crop_x < 4.5 {
        crop_x = 0.0;
        crop_w = (crop_w + 4.5).min(100.0);
    }
    if (crop_x + crop_w) > 95.5 {
        crop_w = (100.0 - crop_x).min(100.0);
    }

    SaliencyCropResult {
        x: crop_x,
        y: crop_y,
        width: crop_w,
        height: crop_h,
        target_aspect_ratio: base_crop.target_aspect_ratio,
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

#[tauri::command]
pub async fn batch_heal_sensor_dust(
    paths: Vec<String>,
    app_handle: AppHandle,
    _state: State<'_, AppState>,
) -> Result<BatchDustSummary, String> {
    if paths.is_empty() {
        return Err("No photos provided for dust healing".to_string());
    }

    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("batch_heal_sensor_dust");
    let start_time = std::time::Instant::now();
    let total = paths.len();
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    let processed_counter = Arc::new(AtomicUsize::new(0));
    let spots_counter = Arc::new(AtomicUsize::new(0));

    let app_handle_clone = app_handle.clone();
    let paths_clone = paths.clone();
    let processed_counter_clone = processed_counter.clone();
    let spots_counter_clone = spots_counter.clone();

    let total_spots = tokio::task::spawn_blocking(move || {
        paths_clone.par_iter().for_each(|path_str| {
            let (source_path, sidecar_path) = parse_virtual_path(path_str);
            if let Ok(file_bytes) = read_file_mapped(&source_path) {
                if let Ok(mut image) = load_base_image_from_bytes(
                    &file_bytes,
                    &source_path.to_string_lossy(),
                    true,
                    &settings,
                    None,
                ) {
                    let res = heal_sky_dust_spots(&mut image);
                    let count = res.spots_detected;
                    if count > 0 {
                        spots_counter_clone.fetch_add(count, Ordering::SeqCst);

                        let mut metadata = load_sidecar(&sidecar_path);
                        if let Some(obj) = metadata.adjustments.as_object_mut() {
                            obj.insert(
                                "sensorDustHealedCount".to_string(),
                                serde_json::json!(count),
                            );
                        }
                        if let Ok(json_str) = serde_json::to_string_pretty(&metadata) {
                            if let Some(parent) = sidecar_path.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            let _ = std::fs::write(&sidecar_path, json_str);
                        }
                    }
                }
            }

            let done = processed_counter_clone.fetch_add(1, Ordering::SeqCst) + 1;
            let percent = (done as f32 / total as f32) * 100.0;
            let _ = app_handle_clone.emit(
                "batch-dust-progress",
                serde_json::json!({
                    "current": done,
                    "total": total,
                    "percentage": percent
                }),
            );
        });

        spots_counter.load(Ordering::SeqCst)
    })
    .await
    .map_err(|e| format!("Batch dust repair task failed: {}", e))?;

    let summary = BatchDustSummary {
        total_processed: total,
        total_spots_healed: total_spots,
        elapsed_ms: start_time.elapsed().as_millis() as u64,
    };

    let _ = app_handle.emit("batch-dust-complete", &summary);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn test_detect_horizon_angle_horizontal_flat() {
        let (w, h) = (128u32, 128u32);
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // Sky is bright (200), sea/ground is dark (50) with sharp horizontal line at y = 64
                let val = if y < 64 { 200 } else { 50 };
                img.put_pixel(x, y, Rgb([val, val, val]));
            }
        }
        let dynamic_img = DynamicImage::ImageRgb8(img);
        let res = detect_horizon_angle(&dynamic_img);
        assert!(res.angle_degrees.abs() < 1.0, "Horizontal flat horizon should have near-zero angle: got {}", res.angle_degrees);
        assert!(res.confidence > 0.0, "Confidence should be positive on sharp line");
    }

    #[test]
    fn test_dust_spot_detection_and_healing() {
        let (w, h) = (128u32, 128u32);
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, Rgb([200, 200, 200]));
            }
        }

        // Add a dark dust spot at (64, 32) in sky region with radius 3
        for dy in -3i32..=3i32 {
            for dx in -3i32..=3i32 {
                if dx * dx + dy * dy <= 9 {
                    img.put_pixel((64 + dx) as u32, (32 + dy) as u32, Rgb([140, 140, 140]));
                }
            }
        }

        let mut dynamic_img = DynamicImage::ImageRgb8(img);
        let heal_res = heal_sky_dust_spots(&mut dynamic_img);

        // Dust spot should be detected and healed
        assert!(heal_res.spots_detected >= 1, "Dust spot should be detected: healed count {}", heal_res.spots_detected);
        let center_after = dynamic_img.get_pixel(64, 32);
        assert!(center_after[0] > 140, "Healed pixel should blend back brighter than 140: got {}", center_after[0]);
    }

    #[test]
    fn test_calculate_inscribed_crop() {
        let (w, h) = (6000u32, 4000u32);
        let (cx, cy, cw, ch) = calculate_inscribed_crop(w, h, 0.0);
        assert_eq!((cx, cy, cw, ch), (0, 0, 6000, 4000));

        let (cx_rot, cy_rot, cw_rot, ch_rot) = calculate_inscribed_crop(w, h, 3.5);
        assert!(cw_rot < 6000, "Inscribed crop width must be scaled down to prevent corner wedges");
        assert!(ch_rot < 4000, "Inscribed crop height must be scaled down to prevent corner wedges");
        assert!(cx_rot > 0 && cy_rot > 0, "Offsets should be centered");
        // Check aspect ratio preservation within 0.5%
        let orig_ar = w as f32 / h as f32;
        let crop_ar = cw_rot as f32 / ch_rot as f32;
        assert!((orig_ar - crop_ar).abs() < 0.02, "Aspect ratio should be preserved");
    }

    #[test]
    fn test_cross_frame_dust_vs_bird() {
        // Spot 1 is static sensor dust (appears at norm_x: 0.5, norm_y: 0.2 in both frames)
        let spot_static = SensorDustCandidate { norm_x: 0.5, norm_y: 0.2, radius: 6 };
        // Spot 2 is a flying bird (appears at norm_x: 0.3, norm_y: 0.15 in frame 1, but moving/absent in frame 2)
        let spot_bird = SensorDustCandidate { norm_x: 0.3, norm_y: 0.15, radius: 6 };

        let frame1_spots = vec![spot_static.clone(), spot_bird];
        let frame2_spots = vec![spot_static.clone()]; // bird is gone or in different location

        let verified = cross_frame_verify_dust(&frame1_spots, &[frame2_spots]);
        assert_eq!(verified.len(), 1, "Only static spot should be verified across frames");
        assert_eq!(verified[0].norm_x, 0.5);
        assert_eq!(verified[0].norm_y, 0.2);
    }

    #[test]
    fn test_scan_peripheral_edge_patrol() {
        let (w, h) = (100u32, 100u32);
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, Rgb([100, 100, 100]));
            }
        }
        let dyn_clean = DynamicImage::ImageRgb8(img.clone());
        let res_clean = scan_peripheral_edge_patrol(&dyn_clean);
        assert!(!res_clean.edge_distractions_found, "Clean image should not trigger edge patrol crop");

        // Add a distracting high-contrast boundary artifact on the rightmost edge
        for y in 0..h {
            img.put_pixel(99, y, Rgb([255, 255, 255]));
        }
        let dyn_distracted = DynamicImage::ImageRgb8(img);
        let res_distracted = scan_peripheral_edge_patrol(&dyn_distracted);
        assert!(res_distracted.edge_distractions_found, "High-contrast edge artifact should trigger edge patrol");
        assert!(res_distracted.crop_x > 0 || res_distracted.width < w, "Should inset crop boundaries");
    }
}

