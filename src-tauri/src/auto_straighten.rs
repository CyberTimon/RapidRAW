use crate::AppState;
use crate::image_processing::{apply_coarse_rotation, apply_flip, downscale_f32_image};
use crate::mask_generation::build_full_warped_image;
use image::GrayImage;

const ANALYSIS_MAX_DIM: u32 = 1024;
const LSD_SCALE: f64 = 0.8;
const MAX_AXIS_DEVIATION_DEGREES: f64 = 30.0;
const MIN_SEGMENT_LENGTH_FRACTION: f64 = 0.02;
const MIN_VANISHING_DISTANCE: f64 = 5.0;
const MIN_CLASS_LINES: usize = 3;
const MIN_CLASS_LENGTH_FRACTION: f64 = 0.25;
const MAX_ROTATION_DEGREES: f64 = 10.0;
const RANSAC_TUNING_ROUNDS: usize = 5;
const RANSAC_TUNING_RUNS: usize = 50;
const RANSAC_RUNS: usize = 400;
const RANSAC_ELIMINATION_RATIO: f64 = 0.6;

struct LineSegment {
    line: [f64; 3],
    deviation: f64,
    length: f64,
    vertical: bool,
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
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

struct Xorshift(u64);

impl Xorshift {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }

    fn pair(&mut self, bound: usize) -> (usize, usize) {
        let first = self.below(bound);
        let second = (first + 1 + self.below(bound - 1)) % bound;
        (first, second)
    }
}

fn vanishing_point(a: &LineSegment, b: &LineSegment, width: f64, height: f64) -> Option<[f64; 3]> {
    let point = cross(a.line, b.line);
    let norm = dot(point, point).sqrt();
    if norm < 1e-12 {
        return None;
    }
    if point[2].abs() > 1e-12 {
        let (x, y) = (point[0] / point[2], point[1] / point[2]);
        if (0.0..=width).contains(&x) && (0.0..=height).contains(&y) {
            return None;
        }
    }
    Some([point[0] / norm, point[1] / norm, point[2] / norm])
}

fn vanishing_consensus(
    lines: &[&LineSegment],
    width: f64,
    height: f64,
) -> (Vec<bool>, Option<[f64; 3]>) {
    let count = lines.len();
    if count < MIN_CLASS_LINES {
        return (vec![false; count], None);
    }
    let total_length: f64 = lines.iter().map(|line| line.length).sum();
    let mut rng = Xorshift(0x9E37_79B9_7F4A_7C15);
    let mut epsilon = 1e-2f64;
    let mut step = 1.0f64;

    for _ in 0..RANSAC_TUNING_ROUNDS {
        let (mut eliminated, mut valid) = (0usize, 0usize);
        for _ in 0..RANSAC_TUNING_RUNS {
            let (i, j) = rng.pair(count);
            let Some(point) = vanishing_point(lines[i], lines[j], width, height) else {
                continue;
            };
            valid += 1;
            eliminated += (0..count)
                .filter(|&k| k != i && k != j && dot(point, lines[k].line).abs() >= epsilon)
                .count();
        }
        if valid > 0 {
            let ratio = eliminated as f64 / (count * valid) as f64;
            if ratio < RANSAC_ELIMINATION_RATIO {
                epsilon = 10f64.powf(epsilon.log10() - step);
            } else if ratio > RANSAC_ELIMINATION_RATIO {
                epsilon = 10f64.powf(epsilon.log10() + step);
            }
        }
        step /= 2.0;
    }

    let mut best_quality = 0.0;
    let mut best_inliers = vec![false; count];
    let mut best_point = None;
    for _ in 0..RANSAC_RUNS {
        let (i, j) = rng.pair(count);
        let Some(point) = vanishing_point(lines[i], lines[j], width, height) else {
            continue;
        };
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

    Ok(detect_rotation(&flipped.to_luma8()))
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
