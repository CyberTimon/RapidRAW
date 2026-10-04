use crate::AppState;
use crate::image_processing::{apply_coarse_rotation, apply_flip, downscale_f32_image};
use crate::mask_generation::build_full_warped_image;
use image::imageops::{self, FilterType};
use image::{GrayImage, ImageBuffer, Luma};
use imageproc::filter::gaussian_blur_f32;
use imageproc::gradients::{horizontal_sobel, vertical_sobel};
use rayon::prelude::*;

const ANALYSIS_MAX_DIM: u32 = 1024;
const COARSE_MAX_DIM: u32 = 256;
const MAX_TILT_DEGREES: f32 = 15.0;
const REFINE_HALF_RANGE_DEGREES: f32 = 1.5;
const ANGLE_STEP_DEGREES: f32 = 0.1;
const ORIENTATION_TOLERANCE_DEGREES: f32 = 2.0;
const TENSOR_SIGMA: f32 = 2.0;
const ENERGY_PERCENTILE: f32 = 0.8;
const MIN_COHERENCE: f32 = 0.7;
const BORDER_FRACTION: f32 = 0.04;
const MIN_LINE_FRACTION: f32 = 0.15;

struct EdgeSample {
    x: f32,
    y: f32,
    tilt: f32,
    weight: f32,
}

struct AngleProfile {
    tilt: f32,
    score: f64,
    support: u32,
}

fn collect_edge_samples(gray: &GrayImage) -> Vec<EdgeSample> {
    let (width, height) = gray.dimensions();
    let gx = horizontal_sobel(gray);
    let gy = vertical_sobel(gray);
    let tensor = |product: fn(f32, f32) -> f32| {
        let field: ImageBuffer<Luma<f32>, Vec<f32>> =
            ImageBuffer::from_fn(width, height, |x, y| {
                Luma([product(
                    gx.get_pixel(x, y)[0] as f32,
                    gy.get_pixel(x, y)[0] as f32,
                )])
            });
        gaussian_blur_f32(&field, TENSOR_SIGMA)
    };
    let jxx = tensor(|a, _| a * a);
    let jxy = tensor(|a, b| a * b);
    let jyy = tensor(|_, b| b * b);

    let border = ((width.min(height) as f32 * BORDER_FRACTION) as u32).max(2);
    if width <= border * 2 || height <= border * 2 {
        return Vec::new();
    }
    let interior = || {
        (border..height - border).flat_map(move |y| (border..width - border).map(move |x| (x, y)))
    };

    let mut energies: Vec<f32> = interior()
        .map(|(x, y)| jxx.get_pixel(x, y)[0] + jyy.get_pixel(x, y)[0])
        .collect();
    let percentile_index = ((energies.len() - 1) as f32 * ENERGY_PERCENTILE) as usize;
    let energy_threshold = *energies
        .select_nth_unstable_by(percentile_index, f32::total_cmp)
        .1;

    interior()
        .filter_map(|(x, y)| {
            let xx = jxx.get_pixel(x, y)[0];
            let xy = jxy.get_pixel(x, y)[0];
            let yy = jyy.get_pixel(x, y)[0];
            let energy = xx + yy;
            if energy <= energy_threshold || energy <= f32::EPSILON {
                return None;
            }
            let coherence = ((xx - yy).powi(2) + 4.0 * xy * xy).sqrt() / energy;
            if coherence < MIN_COHERENCE {
                return None;
            }
            let gradient_angle = 0.5 * (2.0 * xy).atan2(xx - yy).to_degrees();
            let tilt = if gradient_angle > 0.0 {
                gradient_angle - 90.0
            } else {
                gradient_angle + 90.0
            };
            if tilt.abs() > MAX_TILT_DEGREES + ORIENTATION_TOLERANCE_DEGREES {
                return None;
            }
            Some(EdgeSample {
                x: x as f32,
                y: y as f32,
                tilt,
                weight: energy.sqrt() * coherence,
            })
        })
        .collect()
}

fn projection_profile(samples: &[EdgeSample], tilt: f32, width: u32, height: u32) -> AngleProfile {
    let start = samples.partition_point(|s| s.tilt < tilt - ORIENTATION_TOLERANCE_DEGREES);
    let end = samples.partition_point(|s| s.tilt <= tilt + ORIENTATION_TOLERANCE_DEGREES);
    let (sin, cos) = tilt.to_radians().sin_cos();
    let bins = (width + height + 2) as usize;
    let mut weights = vec![0.0f64; bins];
    let mut counts = vec![0u32; bins];

    for sample in &samples[start..end] {
        let rho = sample.y * cos - sample.x * sin + width as f32;
        let bin = (rho.round().max(0.0) as usize).min(bins - 1);
        weights[bin] += sample.weight as f64;
        counts[bin] += 1;
    }

    AngleProfile {
        tilt,
        score: weights.iter().map(|w| w * w).sum(),
        support: counts.into_iter().max().unwrap_or(0),
    }
}

fn search_angles(gray: &GrayImage, center: f32, half_range: f32) -> Vec<AngleProfile> {
    let (width, height) = gray.dimensions();
    let mut samples = collect_edge_samples(gray);
    samples.sort_unstable_by(|a, b| a.tilt.total_cmp(&b.tilt));

    let steps = (half_range / ANGLE_STEP_DEGREES).round() as i32;
    (-steps..=steps)
        .into_par_iter()
        .map(|step| {
            projection_profile(
                &samples,
                center + step as f32 * ANGLE_STEP_DEGREES,
                width,
                height,
            )
        })
        .collect()
}

fn find_peak(profiles: &[AngleProfile]) -> Option<(usize, f32)> {
    let best = profiles
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.score.total_cmp(&b.1.score))?
        .0;
    if best == 0 || best == profiles.len() - 1 || profiles[best].score <= 0.0 {
        return None;
    }

    let (left, center, right) = (
        profiles[best - 1].score,
        profiles[best].score,
        profiles[best + 1].score,
    );
    let curvature = left - 2.0 * center + right;
    let offset = if curvature.abs() > f64::EPSILON {
        (0.5 * (left - right) / curvature).clamp(-0.5, 0.5) as f32
    } else {
        0.0
    };

    Some((best, profiles[best].tilt + offset * ANGLE_STEP_DEGREES))
}

fn confident_peak(gray: &GrayImage) -> Option<(f32, f32)> {
    let profiles = search_angles(gray, 0.0, MAX_TILT_DEGREES);
    let (best, tilt) = find_peak(&profiles)?;
    let min_support = gray.width() as f32 * MIN_LINE_FRACTION;
    (profiles[best].support as f32 >= min_support).then_some((profiles[best].tilt, tilt))
}

fn detect_horizon_rotation(gray: &GrayImage) -> Option<f32> {
    if let Some((_, tilt)) = confident_peak(gray) {
        return Some(-tilt);
    }

    let (width, height) = gray.dimensions();
    let scale = (COARSE_MAX_DIM as f32 / width.max(height) as f32).min(1.0);
    let coarse = imageops::resize(
        gray,
        ((width as f32 * scale).round() as u32).max(1),
        ((height as f32 * scale).round() as u32).max(1),
        FilterType::Triangle,
    );
    let (coarse_center, coarse_tilt) = confident_peak(&coarse)?;

    let fine_profiles = search_angles(gray, coarse_center, REFINE_HALF_RANGE_DEGREES);
    let tilt = find_peak(&fine_profiles).map_or(coarse_tilt, |(_, tilt)| tilt);

    Some(-tilt)
}

#[tauri::command]
pub fn calculate_auto_straighten(
    js_adjustments: serde_json::Value,
    state: tauri::State<AppState>,
) -> Result<Option<f32>, String> {
    let (image, is_raw) = {
        let guard = state.original_image.lock().unwrap();
        let loaded = guard
            .as_ref()
            .ok_or("No image loaded for auto straighten")?;
        (loaded.image.clone(), loaded.is_raw)
    };

    let proxy = downscale_f32_image(&image, ANALYSIS_MAX_DIM, ANALYSIS_MAX_DIM);
    let warped = build_full_warped_image(&proxy, is_raw, &js_adjustments);
    let oriented = apply_coarse_rotation(
        warped,
        js_adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8,
    );
    let flipped = apply_flip(
        oriented,
        js_adjustments["flipHorizontal"].as_bool().unwrap_or(false),
        js_adjustments["flipVertical"].as_bool().unwrap_or(false),
    );

    Ok(detect_horizon_rotation(&flipped.to_luma8()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};

    const WIDTH: u32 = 1000;
    const HEIGHT: u32 = 700;

    fn tilted_scene(tilt_degrees: f32) -> GrayImage {
        let slope = tilt_degrees.to_radians().tan();
        let center_x = WIDTH as f32 / 2.0;
        GrayImage::from_fn(WIDTH, HEIGHT, |x, y| {
            let offset = (x as f32 - center_x) * slope;
            let horizon = HEIGHT as f32 * 0.55 + offset;
            let stripe = HEIGHT as f32 * 0.3 + offset;
            let stripe_coverage = (6.5 - (y as f32 - stripe).abs()).clamp(0.0, 1.0);
            let ground_coverage = (y as f32 - horizon + 0.5).clamp(0.0, 1.0);
            let sky = 200.0 + (120.0 - 200.0) * stripe_coverage;
            Luma([(sky + (70.0 - sky) * ground_coverage).round() as u8])
        })
    }

    fn noise_image() -> GrayImage {
        let mut state: u32 = 0x1234_5678;
        GrayImage::from_fn(WIDTH, HEIGHT, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            Luma([(state >> 24) as u8])
        })
    }

    fn assert_rotation(detected: Option<f32>, expected: f32) {
        let rotation = detected.expect("no rotation detected");
        assert!(
            (rotation - expected).abs() < 0.2,
            "expected {expected}, detected {rotation}"
        );
    }

    #[test]
    fn levels_clockwise_tilt() {
        assert_rotation(detect_horizon_rotation(&tilted_scene(3.0)), -3.0);
    }

    #[test]
    fn levels_counter_clockwise_tilt() {
        assert_rotation(detect_horizon_rotation(&tilted_scene(-7.0)), 7.0);
    }

    #[test]
    fn keeps_level_horizon() {
        assert_rotation(detect_horizon_rotation(&tilted_scene(0.0)), 0.0);
    }

    #[test]
    fn detected_rotation_matches_render_direction() {
        let scene = tilted_scene(4.5);
        let rotation = detect_horizon_rotation(&scene).expect("no rotation detected");
        let corrected = rotate_about_center(
            &scene,
            rotation.to_radians(),
            Interpolation::Bilinear,
            Border::Constant(Luma([200])),
        );
        assert_rotation(detect_horizon_rotation(&corrected), 0.0);
    }

    #[test]
    fn levels_soft_horizon_behind_texture() {
        let slope = 2.5f32.to_radians().tan();
        let noise = noise_image();
        let scene = GrayImage::from_fn(WIDTH, HEIGHT, |x, y| {
            let horizon = HEIGHT as f32 * 0.5 + (x as f32 - WIDTH as f32 / 2.0) * slope;
            let ground = ((y as f32 - horizon) / 40.0 + 0.5).clamp(0.0, 1.0);
            let texture = (noise.get_pixel(x, y)[0] as f32 - 128.0) * 0.35;
            Luma([(190.0 - 110.0 * ground + texture).clamp(0.0, 255.0) as u8])
        });
        assert!(confident_peak(&scene).is_none());
        assert_rotation(detect_horizon_rotation(&scene), -2.5);
    }

    #[test]
    fn ignores_flat_image() {
        let flat = GrayImage::from_pixel(WIDTH, HEIGHT, Luma([128]));
        assert!(detect_horizon_rotation(&flat).is_none());
    }

    #[test]
    fn ignores_noise() {
        assert!(detect_horizon_rotation(&noise_image()).is_none());
    }

    #[test]
    fn ignores_vertical_lines() {
        let verticals = GrayImage::from_fn(WIDTH, HEIGHT, |x, _| {
            Luma([if (x / 80) % 2 == 0 { 60 } else { 190 }])
        });
        assert!(detect_horizon_rotation(&verticals).is_none());
    }
}
