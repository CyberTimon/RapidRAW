use crate::AppState;
use crate::formats::is_raw_file;
use crate::guided_perspective::{cross, unit_norm};
use crate::image_processing::{Crop, apply_coarse_rotation, apply_flip, downscale_f32_image};
use crate::mask_generation::build_full_warped_image;
use image::{DynamicImage, GrayImage};
use serde_json::{Value, json};

const ANALYSIS_MAX_DIM: u32 = 1024;
const LSD_SCALE: f64 = 0.8;
const MAX_AXIS_DEVIATION_DEGREES: f64 = 30.0;
const MIN_SEGMENT_LENGTH_FRACTION: f64 = 0.02;
const MIN_VANISHING_DISTANCE: f64 = 5.0;
const MIN_CLASS_LINES: usize = 3;
const MIN_CLASS_LENGTH_FRACTION: f64 = 0.25;
const MAX_ROTATION_DEGREES: f64 = 10.0;
const MAX_CANDIDATE_LINES: usize = 60;
const TUNING_ROUNDS: usize = 5;
const ELIMINATION_RATIO: f64 = 0.6;

struct LineSegment {
    line: [f64; 3],
    deviation: f64,
    length: f64,
    vertical: bool,
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn detect_segments(gray: &GrayImage) -> Vec<LineSegment> {
    let (width, height) = gray.dimensions();
    let min_length = width.max(height) as f64 * MIN_SEGMENT_LENGTH_FRACTION;
    lsdetect::detect(gray.as_raw(), width as usize, height as usize, LSD_SCALE)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|segment| {
            let length = segment.length();
            if length < min_length {
                return None;
            }
            let angle = segment.angle();
            let (vertical, deviation) = if angle.abs() <= MAX_AXIS_DEVIATION_DEGREES {
                (false, angle)
            } else if angle.abs() >= 90.0 - MAX_AXIS_DEVIATION_DEGREES {
                (true, angle - 90.0 * angle.signum())
            } else {
                return None;
            };
            let line = cross([segment.x1, segment.y1, 1.0], [segment.x2, segment.y2, 1.0]);
            let norm = line[0].hypot(line[1]);
            (norm > f64::EPSILON).then(|| LineSegment {
                line: [line[0] / norm, line[1] / norm, line[2] / norm],
                deviation,
                length,
                vertical,
            })
        })
        .collect()
}

fn vanishing_point(a: &LineSegment, b: &LineSegment, width: f64, height: f64) -> Option<[f64; 3]> {
    let point = cross(a.line, b.line);
    if point.iter().all(|component| component.abs() < 1e-12) {
        return None;
    }
    if point[2].abs() > 1e-12 {
        let (x, y) = (point[0] / point[2], point[1] / point[2]);
        if (0.0..=width).contains(&x) && (0.0..=height).contains(&y) {
            return None;
        }
    }
    Some(unit_norm(point))
}

fn candidate_points(
    lines: &[&LineSegment],
    width: f64,
    height: f64,
) -> Vec<(usize, usize, [f64; 3])> {
    let mut longest: Vec<usize> = (0..lines.len()).collect();
    longest.sort_by(|&a, &b| lines[b].length.total_cmp(&lines[a].length));
    longest.truncate(MAX_CANDIDATE_LINES);
    longest
        .iter()
        .enumerate()
        .flat_map(|(n, &i)| longest[n + 1..].iter().map(move |&j| (i, j)))
        .filter_map(|(i, j)| {
            vanishing_point(lines[i], lines[j], width, height).map(|point| (i, j, point))
        })
        .collect()
}

fn vanishing_consensus(
    lines: &[&LineSegment],
    width: f64,
    height: f64,
) -> (Vec<bool>, Option<[f64; 3]>) {
    let count = lines.len();
    let candidates = candidate_points(lines, width, height);
    if count < MIN_CLASS_LINES || candidates.is_empty() {
        return (vec![false; count], None);
    }
    let total_length: f64 = lines.iter().map(|line| line.length).sum();
    let mut epsilon = 1e-2f64;
    let mut step = 1.0f64;

    for _ in 0..TUNING_ROUNDS {
        let eliminated: usize = candidates
            .iter()
            .map(|&(i, j, point)| {
                (0..count)
                    .filter(|&k| k != i && k != j && dot(point, lines[k].line).abs() >= epsilon)
                    .count()
            })
            .sum();
        let ratio = eliminated as f64 / (count * candidates.len()) as f64;
        if ratio < ELIMINATION_RATIO {
            epsilon = 10f64.powf(epsilon.log10() - step);
        } else if ratio > ELIMINATION_RATIO {
            epsilon = 10f64.powf(epsilon.log10() + step);
        }
        step /= 2.0;
    }

    let mut best_quality = 0.0;
    let mut best_inliers = vec![false; count];
    let mut best_point = None;
    for &(i, j, point) in &candidates {
        let mut quality = 0.0;
        let inliers: Vec<bool> = (0..count)
            .map(|k| {
                if k == i || k == j {
                    return true;
                }
                let distance = dot(point, lines[k].line).abs();
                if distance >= epsilon {
                    return false;
                }
                let share = lines[k].length / total_length;
                quality += 0.33 / count as f64
                    + 0.33 * share
                    + 0.33 * (1.0 - distance / epsilon) * count as f64 * share;
                true
            })
            .collect();
        if quality > best_quality {
            best_quality = quality;
            best_inliers = inliers;
            best_point = Some(point);
        }
    }
    (best_inliers, best_point)
}
fn trusted_lines(
    segments: &[LineSegment],
    vertical: bool,
    width: f64,
    height: f64,
) -> Vec<&LineSegment> {
    let class: Vec<&LineSegment> = segments
        .iter()
        .filter(|segment| segment.vertical == vertical)
        .collect();
    let (inliers, point) = vanishing_consensus(&class, width, height);
    let kept: Vec<&LineSegment> = class
        .into_iter()
        .zip(inliers)
        .filter_map(|(segment, keep)| keep.then_some(segment))
        .collect();
    let far = point.is_some_and(|p| {
        p[2].abs() < 1e-12
            || (p[0] / p[2] - width / 2.0).hypot(p[1] / p[2] - height / 2.0)
                >= MIN_VANISHING_DISTANCE * width.hypot(height)
    });
    let length: f64 = kept.iter().map(|segment| segment.length).sum();
    if far
        && kept.len() >= MIN_CLASS_LINES
        && length >= width.max(height) * MIN_CLASS_LENGTH_FRACTION
    {
        kept
    } else {
        Vec::new()
    }
}

fn fit_rotation(lines: &[&LineSegment]) -> f64 {
    let total = lines.len() as f64;
    let class_totals = |vertical: bool| -> (f64, f64) {
        lines
            .iter()
            .filter(|line| line.vertical == vertical)
            .fold((0.0, 0.0), |(length, count), line| {
                (length + line.length, count + 1.0)
            })
    };
    let vertical_totals = class_totals(true);
    let horizontal_totals = class_totals(false);
    let (sin_sum, cos_sum) = lines.iter().fold((0.0, 0.0), |(sin_sum, cos_sum), line| {
        let (class_length, class_count) = if line.vertical {
            vertical_totals
        } else {
            horizontal_totals
        };
        let weight = line.length / class_length * class_count / total;
        let doubled = (2.0 * line.deviation).to_radians();
        (
            sin_sum + weight * doubled.sin(),
            cos_sum + weight * doubled.cos(),
        )
    });
    -0.5 * sin_sum.atan2(cos_sum).to_degrees()
}

fn detect_rotation(gray: &GrayImage) -> Option<f32> {
    let (width, height) = (gray.width() as f64, gray.height() as f64);
    let segments = detect_segments(gray);
    let mut selected = trusted_lines(&segments, true, width, height);
    selected.extend(trusted_lines(&segments, false, width, height));
    if selected.is_empty() {
        return None;
    }
    let rotation = fit_rotation(&selected);
    (rotation.abs() <= MAX_ROTATION_DEGREES).then_some(rotation as f32)
}

fn rotation_for_image(image: &DynamicImage, is_raw: bool, adjustments: &Value) -> Option<f64> {
    let proxy = downscale_f32_image(image, ANALYSIS_MAX_DIM, ANALYSIS_MAX_DIM);
    let warped = build_full_warped_image(&proxy, is_raw, adjustments);
    let oriented = apply_coarse_rotation(
        warped,
        adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8,
    );
    let flipped = apply_flip(
        oriented,
        adjustments["flipHorizontal"].as_bool().unwrap_or(false),
        adjustments["flipVertical"].as_bool().unwrap_or(false),
    );
    detect_rotation(&flipped.to_luma8()).map(|rotation| (rotation as f64 * 10.0).round() / 10.0)
}

fn crop_within_bounds(crop: &Crop, width: f64, height: f64, rotation: f64) -> bool {
    let (sin, cos) = (-rotation).to_radians().sin_cos();
    let (cx, cy) = (width / 2.0, height / 2.0);
    [
        (crop.x, crop.y),
        (crop.x + crop.width, crop.y),
        (crop.x, crop.y + crop.height),
        (crop.x + crop.width, crop.y + crop.height),
    ]
    .iter()
    .all(|&(x, y)| {
        let rx = cos * (x - cx) - sin * (y - cy) + cx;
        let ry = sin * (x - cx) + cos * (y - cy) + cy;
        (-1.0..=width + 1.0).contains(&rx) && (-1.0..=height + 1.0).contains(&ry)
    })
}

fn centered_crop(width: f64, height: f64, aspect_ratio: f64, rotation: f64) -> Crop {
    let (sin, cos) = (rotation.abs() % 180.0).to_radians().sin_cos();
    let crop_height = (height / (aspect_ratio * sin + cos)).min(width / (aspect_ratio * cos + sin));
    let crop_width = aspect_ratio * crop_height;
    Crop {
        x: ((width - crop_width) / 2.0).round(),
        y: ((height - crop_height) / 2.0).round(),
        width: crop_width.round(),
        height: crop_height.round(),
    }
}

fn crop_for_rotation(
    width: f64,
    height: f64,
    aspect_ratio: Option<f64>,
    rotation: f64,
    current: Option<Crop>,
    rotation_delta: f64,
) -> Crop {
    let aspect_ratio = aspect_ratio
        .filter(|ratio| *ratio > 0.0)
        .unwrap_or(width / height);
    let Some(current) = current else {
        return centered_crop(width, height, aspect_ratio, rotation);
    };

    let (sin, cos) = rotation_delta.to_radians().sin_cos();
    let (px, py) = (
        current.x + current.width / 2.0 - width / 2.0,
        current.y + current.height / 2.0 - height / 2.0,
    );
    let followed = Crop {
        x: (width / 2.0 + px * cos - py * sin - current.width / 2.0).round(),
        y: (height / 2.0 + px * sin + py * cos - current.height / 2.0).round(),
        ..current
    };
    if crop_within_bounds(&followed, width, height, rotation) {
        return followed;
    }

    let (center_x, center_y) = (
        followed.x + followed.width / 2.0,
        followed.y + followed.height / 2.0,
    );
    let scaled = |scale: f64| Crop {
        x: center_x - followed.width * scale / 2.0,
        y: center_y - followed.height * scale / 2.0,
        width: followed.width * scale,
        height: followed.height * scale,
    };
    let (mut low, mut high) = (0.1, 1.0);
    let mut best = followed;
    for _ in 0..12 {
        let mid = (low + high) / 2.0;
        let candidate = scaled(mid);
        if crop_within_bounds(&candidate, width, height, rotation) {
            best = candidate;
            low = mid;
        } else {
            high = mid;
        }
    }
    if low < 0.15 {
        return centered_crop(width, height, aspect_ratio, rotation);
    }
    Crop {
        x: best.x.ceil(),
        y: best.y.ceil(),
        width: best.width.floor(),
        height: best.height.floor(),
    }
}

pub fn straighten_adjustments(image: &DynamicImage, source_path: &str, adjustments: &mut Value) {
    let Some(rotation) = rotation_for_image(image, is_raw_file(source_path), adjustments) else {
        return;
    };

    let (image_width, image_height) = (image.width() as f64, image.height() as f64);
    let (width, height) = match adjustments["orientationSteps"].as_u64().unwrap_or(0) {
        1 | 3 => (image_height, image_width),
        _ => (image_width, image_height),
    };
    let previous_rotation = adjustments["rotation"].as_f64().unwrap_or(0.0);
    let current_crop: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();
    let crop = crop_for_rotation(
        width,
        height,
        adjustments["aspectRatio"].as_f64(),
        rotation,
        current_crop,
        rotation - previous_rotation,
    );

    adjustments["rotation"] = json!(rotation);
    adjustments["crop"] = json!({
        "unit": "px",
        "x": crop.x,
        "y": crop.y,
        "width": crop.width,
        "height": crop.height,
    });
}

#[tauri::command]
pub fn calculate_auto_straighten(
    js_adjustments: Value,
    state: tauri::State<AppState>,
) -> Result<Option<f64>, String> {
    let (image, is_raw) = {
        let guard = state.original_image.lock().unwrap();
        let loaded = guard
            .as_ref()
            .ok_or("No image loaded for auto straighten")?;
        (loaded.image.clone(), loaded.is_raw)
    };
    Ok(rotation_for_image(&image, is_raw, &js_adjustments))
}
#[cfg(test)]
mod tests {
    use super::*;
    use image::Luma;
    use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};

    const WIDTH: u32 = 1000;
    const HEIGHT: u32 = 700;

    fn coverage(distance: f32, half_width: f32) -> f32 {
        (half_width + 0.5 - distance).clamp(0.0, 1.0)
    }

    fn render(distances: impl Fn(f32, f32) -> f32) -> GrayImage {
        GrayImage::from_fn(WIDTH, HEIGHT, |x, y| {
            let ink = coverage(distances(x as f32, y as f32), 3.0);
            Luma([(200.0 - 140.0 * ink).round() as u8])
        })
    }

    fn level_scene() -> GrayImage {
        render(|x, y| {
            let horizontal = [150.0, 300.0, 450.0, 600.0]
                .iter()
                .map(|row| (y - row).abs())
                .fold(f32::MAX, f32::min);
            let vertical = [200.0, 500.0, 800.0]
                .iter()
                .map(|column| (x - column).abs())
                .fold(f32::MAX, f32::min);
            horizontal.min(vertical)
        })
    }

    fn rotated(scene: &GrayImage, degrees: f32) -> GrayImage {
        rotate_about_center(
            scene,
            degrees.to_radians(),
            Interpolation::Bilinear,
            Border::Constant(Luma([200])),
        )
    }

    fn assert_rotation(detected: Option<f32>, expected: f32) {
        let rotation = detected.expect("no rotation detected");
        assert!(
            (rotation - expected).abs() < 0.2,
            "expected {expected}, detected {rotation}"
        );
    }

    #[test]
    fn keeps_level_scene() {
        assert_rotation(detect_rotation(&level_scene()), 0.0);
    }

    #[test]
    fn undoes_clockwise_roll() {
        assert_rotation(detect_rotation(&rotated(&level_scene(), 3.0)), -3.0);
    }

    #[test]
    fn undoes_counter_clockwise_roll() {
        assert_rotation(detect_rotation(&rotated(&level_scene(), -6.0)), 6.0);
    }

    #[test]
    fn levels_from_verticals_alone() {
        let posts = render(|x, _| {
            [150.0, 400.0, 650.0, 900.0]
                .iter()
                .map(|column| (x - column).abs())
                .fold(f32::MAX, f32::min)
        });
        assert_rotation(detect_rotation(&rotated(&posts, 2.5)), -2.5);
    }

    #[test]
    fn detected_rotation_levels_the_render() {
        let tilted = rotated(&level_scene(), 4.5);
        let rotation = detect_rotation(&tilted).expect("no rotation detected");
        assert_rotation(detect_rotation(&rotated(&tilted, rotation)), 0.0);
    }

    #[test]
    fn ignores_converging_perspective_lines() {
        let vanishing = (-400.0f32, 350.0f32);
        let fan = render(|x, y| {
            [60.0f32, 220.0, 480.0, 640.0]
                .iter()
                .map(|end_y| {
                    let (dx, dy) = (WIDTH as f32 - vanishing.0, end_y - vanishing.1);
                    ((x - vanishing.0) * dy - (y - vanishing.1) * dx).abs() / dx.hypot(dy)
                })
                .fold(f32::MAX, f32::min)
        });
        assert!(detect_rotation(&fan).is_none());
    }

    #[test]
    fn missing_crop_becomes_centered_crop_inside_rotation() {
        let crop = crop_for_rotation(6000.0, 4000.0, None, 3.0, None, 3.0);
        assert!(crop_within_bounds(&crop, 6000.0, 4000.0, 3.0));
        assert!((crop.width / crop.height - 1.5).abs() < 0.01);
        assert!((crop.x + crop.width / 2.0 - 3000.0).abs() <= 1.0);
    }

    #[test]
    fn crop_that_still_fits_is_kept() {
        let small = Crop {
            x: 2000.0,
            y: 1500.0,
            width: 2000.0,
            height: 1000.0,
        };
        let crop = crop_for_rotation(6000.0, 4000.0, None, 2.0, Some(small), 2.0);
        assert_eq!(
            (crop.x, crop.y, crop.width, crop.height),
            (2000.0, 1500.0, 2000.0, 1000.0)
        );
    }

    #[test]
    fn full_frame_crop_shrinks_to_fit_rotation() {
        let full = Crop {
            x: 0.0,
            y: 0.0,
            width: 6000.0,
            height: 4000.0,
        };
        let crop = crop_for_rotation(6000.0, 4000.0, None, -5.0, Some(full), -5.0);
        assert!(crop_within_bounds(&crop, 6000.0, 4000.0, -5.0));
        assert!(crop.width < 6000.0 && crop.width > 4000.0);
    }

    #[test]
    fn ignores_flat_image() {
        let flat = GrayImage::from_pixel(WIDTH, HEIGHT, Luma([128]));
        assert!(detect_rotation(&flat).is_none());
    }

    #[test]
    fn ignores_noise() {
        let mut state: u32 = 0x1234_5678;
        let noise = GrayImage::from_fn(WIDTH, HEIGHT, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            Luma([(state >> 24) as u8])
        });
        assert!(detect_rotation(&noise).is_none());
    }
}
