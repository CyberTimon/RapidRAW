use crate::panorama_stitching::{BRIEF_DESCRIPTOR_SIZE, Descriptor, Feature, KeyPoint, Match};
use image::{GrayImage, ImageBuffer, Luma};
use imageproc::corners::{Corner, corners_fast9};
use imageproc::filter::gaussian_blur_f32;
use nalgebra::{Matrix3, Point2, SVD};
use rand::prelude::*;
use rand::rng;
use rayon::prelude::*;

const MAX_PROCESSING_DIMENSION: u32 = 1600;
const FAST_THRESHOLD: u8 = 15;
const NON_MAXIMA_SUPPRESSION_RADIUS: f32 = 12.0;
const BRIEF_PATCH_SIZE: u32 = 32;
pub const MATCH_RATIO_THRESHOLD: f32 = 0.75;
const RANSAC_ITERATIONS: usize = 2500;
const RANSAC_INLIER_THRESHOLD: f64 = 5.0;
pub const MIN_INLIERS_FOR_CONNECTION: usize = 15;
const LOW_DETAIL_WINDOW_RADIUS: u32 = 16;
const LOW_DETAIL_VARIANCE_THRESHOLD: f64 = 60.0;

pub fn calculate_downscale_dimensions(width: u32, height: u32) -> (u32, u32, f64) {
    calculate_downscale_dimensions_capped(width, height, MAX_PROCESSING_DIMENSION)
}

pub fn calculate_downscale_dimensions_capped(
    width: u32,
    height: u32,
    max_dimension: u32,
) -> (u32, u32, f64) {
    assert!(max_dimension > 0, "max_dimension must be positive");
    let long_side = width.max(height);
    if long_side <= max_dimension {
        return (width, height, 1.0);
    }
    let scale_factor = long_side as f64 / max_dimension as f64;
    let new_width = (width as f64 / scale_factor).round() as u32;
    let new_height = (height as f64 / scale_factor).round() as u32;
    (new_width, new_height, scale_factor)
}

pub fn normalize_grayscale(img: &GrayImage) -> GrayImage {
    let mut minimum = u8::MAX;
    let mut maximum = u8::MIN;
    for pixel in img.pixels() {
        let value = pixel[0];
        if value < minimum {
            minimum = value;
        }
        if value > maximum {
            maximum = value;
        }
    }
    if maximum <= minimum {
        return img.clone();
    }
    let span = (maximum - minimum) as f32;
    let (width, height) = img.dimensions();
    GrayImage::from_fn(width, height, |x, y| {
        let value = img.get_pixel(x, y)[0];
        let stretched = ((value - minimum) as f32 / span * 255.0).round();
        Luma([stretched as u8])
    })
}

const ANMS_TARGET_FEATURES_PER_SCALE: usize = 600;
const ANMS_ROBUSTNESS_COEFF: f32 = 0.9;

/// Multi-Scale Steered ORB Feature Extractor with Adaptive Non-Maximal Suppression (ANMS)
pub fn find_features(img: &GrayImage, brief_pairs: &[(Point2<i32>, Point2<i32>)]) -> Vec<Feature> {
    find_features_tuned(
        img,
        brief_pairs,
        FAST_THRESHOLD,
        NON_MAXIMA_SUPPRESSION_RADIUS,
    )
}

pub fn find_features_tuned(
    img: &GrayImage,
    brief_pairs: &[(Point2<i32>, Point2<i32>)],
    fast_threshold: u8,
    _non_maxima_suppression_radius: f32,
) -> Vec<Feature> {
    let (w, h) = img.dimensions();
    let mut all_features = Vec::new();

    // 4-Scale Octave Pyramid for robust scale invariance across zoom/focal shifts
    let scales = [1.0f32, 0.75f32, 0.50f32, 0.35f32];

    for &scale in &scales {
        let cur_img = if (scale - 1.0).abs() < 1e-4 {
            img.clone()
        } else {
            let nw = ((w as f32) * scale).round().max(100.0) as u32;
            let nh = ((h as f32) * scale).round().max(100.0) as u32;
            image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle)
        };

        let blurred_u8 = imageproc::filter::gaussian_blur_f32(&cur_img, 1.2);
        // Adaptive FAST threshold per scale
        let scale_fast_thresh = if scale < 0.6 {
            fast_threshold.saturating_sub(4).max(8)
        } else {
            fast_threshold
        };
        let corners = corners_fast9(&blurred_u8, scale_fast_thresh);

        // Adaptive Non-Maximal Suppression (Brown, Szeliski, Winder CVPR 2005)
        let keypoints = adaptive_non_maximal_suppression(&corners, ANMS_TARGET_FEATURES_PER_SCALE);
        let blurred_f32 = gaussian_blur_f32(&convert_gray_u8_to_f32(&cur_img), 1.8);

        let scale_inv = 1.0 / scale;
        let mut level_features: Vec<Feature> = keypoints
            .par_iter()
            .filter_map(|kp| {
                // Compute local patch intensity moments for rotation invariance
                let angle = compute_patch_orientation(&blurred_f32, kp, BRIEF_PATCH_SIZE);
                compute_steered_brief_descriptor(&blurred_f32, kp, BRIEF_PATCH_SIZE, brief_pairs, angle)
                    .map(|descriptor| Feature {
                        keypoint: KeyPoint {
                            x: (kp.x as f32 * scale_inv).round() as u32,
                            y: (kp.y as f32 * scale_inv).round() as u32,
                        },
                        descriptor,
                    })
            })
            .collect();

        all_features.append(&mut level_features);
    }

    all_features
}

/// Computes centroid intensity orientation angle theta = atan2(m01, m10)
fn compute_patch_orientation(
    img: &ImageBuffer<Luma<f32>, Vec<f32>>,
    kp: &KeyPoint,
    patch_size: u32,
) -> f32 {
    let half = patch_size as i32 / 2;
    let (width, height) = img.dimensions();
    let (cx, cy) = (kp.x as i32, kp.y as i32);

    if cx < half || cx >= width as i32 - half || cy < half || cy >= height as i32 - half {
        return 0.0;
    }

    let mut m10 = 0.0f32;
    let mut m01 = 0.0f32;

    for dy in -half..=half {
        for dx in -half..=half {
            let px = (cx + dx) as u32;
            let py = (cy + dy) as u32;
            let val = img.get_pixel(px, py)[0];
            m10 += dx as f32 * val;
            m01 += dy as f32 * val;
        }
    }

    m01.atan2(m10)
}

/// Adaptive Non-Maximal Suppression (ANMS)
/// Guarantees a mathematically uniform spatial distribution of keypoints across the entire canvas,
/// including image corners, low-contrast skylines, and horizons.
pub fn adaptive_non_maximal_suppression(corners: &[Corner], target_k: usize) -> Vec<KeyPoint> {
    if corners.is_empty() {
        return Vec::new();
    }
    if corners.len() <= target_k {
        return corners
            .iter()
            .map(|c| KeyPoint { x: c.x, y: c.y })
            .collect();
    }

    // 1. Sort all candidate corners by response score descending
    let mut sorted_corners = corners.to_vec();
    sorted_corners.sort_by(|a, b| b.score.total_cmp(&a.score));

    // Cap search set to top 2500 candidates for sub-millisecond execution
    let search_len = sorted_corners.len().min(2500);
    let active_corners = &sorted_corners[..search_len];

    // 2. Compute minimum suppression radius r_i for each corner
    // r_i = min_j ||x_i - x_j|| subject to score_j * c_robust > score_i
    let mut radii: Vec<(f32, usize)> = Vec::with_capacity(search_len);

    // Strongest corner has infinite suppression radius
    radii.push((f32::INFINITY, 0));

    for i in 1..search_len {
        let ci = &active_corners[i];
        let score_thresh = ci.score as f32;
        let mut min_dist_sq = f32::INFINITY;

        for j in 0..i {
            let cj = &active_corners[j];
            if (cj.score as f32) > (score_thresh * ANMS_ROBUSTNESS_COEFF) {
                let dx = ci.x as f32 - cj.x as f32;
                let dy = ci.y as f32 - cj.y as f32;
                let dist_sq = dx * dx + dy * dy;
                if dist_sq < min_dist_sq {
                    min_dist_sq = dist_sq;
                }
            }
        }

        radii.push((min_dist_sq.sqrt(), i));
    }

    // 3. Sort corners by suppression radius descending
    radii.sort_by(|a, b| b.0.total_cmp(&a.0));

    // 4. Select top target_k keypoints
    let select_count = target_k.min(radii.len());
    radii[..select_count]
        .iter()
        .map(|&(_, idx)| {
            let c = &active_corners[idx];
            KeyPoint { x: c.x, y: c.y }
        })
        .collect()
}

pub fn generate_brief_pairs() -> Vec<(Point2<i32>, Point2<i32>)> {
    let mut rng = StdRng::seed_from_u64(12345);
    let half_patch = BRIEF_PATCH_SIZE as i32 / 2;
    let distribution = match rand::distr::Uniform::new(-half_patch, half_patch) {
        Ok(dist) => dist,
        Err(e) => panic!("Failed to create uniform distribution: {}", e),
    };

    (0..BRIEF_DESCRIPTOR_SIZE)
        .map(|_| {
            (
                Point2::new(distribution.sample(&mut rng), distribution.sample(&mut rng)),
                Point2::new(distribution.sample(&mut rng), distribution.sample(&mut rng)),
            )
        })
        .collect()
}

fn compute_steered_brief_descriptor(
    img: &ImageBuffer<Luma<f32>, Vec<f32>>,
    kp: &KeyPoint,
    patch_size: u32,
    pairs: &[(Point2<i32>, Point2<i32>)],
    angle: f32,
) -> Option<Descriptor> {
    let mut descriptor = [0u8; BRIEF_DESCRIPTOR_SIZE / 8];
    let (width, height) = img.dimensions();
    let half_patch_size = patch_size / 2;
    if kp.x < half_patch_size
        || kp.x >= width - half_patch_size
        || kp.y < half_patch_size
        || kp.y >= height - half_patch_size
    {
        return None;
    }

    let cos_a = angle.cos();
    let sin_a = angle.sin();

    for (i, pair) in pairs.iter().enumerate() {
        // Rotate pair offset by patch orientation angle
        let r1_x = ((pair.0.x as f32 * cos_a - pair.0.y as f32 * sin_a).round() as i32)
            .clamp(-(half_patch_size as i32), half_patch_size as i32);
        let r1_y = ((pair.0.x as f32 * sin_a + pair.0.y as f32 * cos_a).round() as i32)
            .clamp(-(half_patch_size as i32), half_patch_size as i32);

        let r2_x = ((pair.1.x as f32 * cos_a - pair.1.y as f32 * sin_a).round() as i32)
            .clamp(-(half_patch_size as i32), half_patch_size as i32);
        let r2_y = ((pair.1.x as f32 * sin_a + pair.1.y as f32 * cos_a).round() as i32)
            .clamp(-(half_patch_size as i32), half_patch_size as i32);

        let p1_x = (kp.x as i32 + r1_x).clamp(0, width as i32 - 1) as u32;
        let p1_y = (kp.y as i32 + r1_y).clamp(0, height as i32 - 1) as u32;
        let p2_x = (kp.x as i32 + r2_x).clamp(0, width as i32 - 1) as u32;
        let p2_y = (kp.y as i32 + r2_y).clamp(0, height as i32 - 1) as u32;

        let intensity1 = img.get_pixel(p1_x, p1_y)[0];
        let intensity2 = img.get_pixel(p2_x, p2_y)[0];
        if intensity1 < intensity2 {
            let byte_index = i / 8;
            let bit_index = i % 8;
            descriptor[byte_index] |= 1 << bit_index;
        }
    }
    Some(descriptor)
}

fn hamming_distance(d1: &Descriptor, d2: &Descriptor) -> u32 {
    d1.iter()
        .zip(d2.iter())
        .map(|(b1, b2)| (b1 ^ b2).count_ones())
        .sum()
}

/// Bidirectional Cross-Check Feature Matcher with Lowe's Ratio Test (0.75)
pub fn match_features(features1: &[Feature], features2: &[Feature]) -> Vec<Match> {
    if features1.is_empty() || features2.is_empty() {
        return Vec::new();
    }

    // 1. Forward matching (1 -> 2)
    let forward_matches: Vec<Option<(usize, u32)>> = features1
        .par_iter()
        .map(|f1| {
            let mut best_dist = u32::MAX;
            let mut second_best_dist = u32::MAX;
            let mut best_idx = 0;
            for (j, f2) in features2.iter().enumerate() {
                let dist = hamming_distance(&f1.descriptor, &f2.descriptor);
                if dist < best_dist {
                    second_best_dist = best_dist;
                    best_dist = dist;
                    best_idx = j;
                } else if dist < second_best_dist {
                    second_best_dist = dist;
                }
            }
            if second_best_dist > 0
                && (best_dist as f32 / second_best_dist as f32) < MATCH_RATIO_THRESHOLD
            {
                Some((best_idx, best_dist))
            } else {
                None
            }
        })
        .collect();

    // 2. Backward matching (2 -> 1)
    let backward_matches: Vec<Option<usize>> = features2
        .par_iter()
        .map(|f2| {
            let mut best_dist = u32::MAX;
            let mut second_best_dist = u32::MAX;
            let mut best_idx = 0;
            for (i, f1) in features1.iter().enumerate() {
                let dist = hamming_distance(&f2.descriptor, &f1.descriptor);
                if dist < best_dist {
                    second_best_dist = best_dist;
                    best_dist = dist;
                    best_idx = i;
                } else if dist < second_best_dist {
                    second_best_dist = dist;
                }
            }
            if second_best_dist > 0
                && (best_dist as f32 / second_best_dist as f32) < MATCH_RATIO_THRESHOLD
            {
                Some(best_idx)
            } else {
                None
            }
        })
        .collect();

    // 3. Keep only reciprocal matches
    let mut mutual_matches = Vec::new();
    for (i, fwd) in forward_matches.into_iter().enumerate() {
        if let Some((j, _)) = fwd {
            if let Some(Some(reciprocal_i)) = backward_matches.get(j) {
                if *reciprocal_i == i {
                    mutual_matches.push(Match {
                        index1: i,
                        index2: j,
                    });
                }
            }
        }
    }

    mutual_matches
}

pub fn find_homography_ransac(
    matches: &[Match],
    keypoints1: &[KeyPoint],
    keypoints2: &[KeyPoint],
) -> Option<(Matrix3<f64>, Vec<Match>)> {
    let mut rng = rng();
    let mut best_h: Option<Matrix3<f64>> = None;
    let mut best_inliers: Vec<Match> = Vec::new();

    let points: Vec<(Point2<f64>, Point2<f64>)> = matches
        .iter()
        .map(|m| {
            let p1 = keypoints1[m.index1];
            let p2 = keypoints2[m.index2];
            (
                Point2::new(p1.x as f64, p1.y as f64),
                Point2::new(p2.x as f64, p2.y as f64),
            )
        })
        .collect();

    if points.len() < 4 {
        return None;
    }

    let ransac_inlier_threshold_sq = RANSAC_INLIER_THRESHOLD.powi(2);

    for _ in 0..RANSAC_ITERATIONS {
        let sample_indices: Vec<usize> = (0..points.len()).collect();
        let sample_indices = sample_indices
            .sample(&mut rng, 4)
            .cloned()
            .collect::<Vec<_>>();
        if sample_indices.len() < 4 {
            continue;
        }

        let sample_points: Vec<(Point2<f64>, Point2<f64>)> =
            sample_indices.iter().map(|&i| points[i]).collect();

        if are_points_collinear(sample_points[0].0, sample_points[1].0, sample_points[2].0)
            || are_points_collinear(sample_points[0].0, sample_points[1].0, sample_points[3].0)
            || are_points_collinear(sample_points[0].0, sample_points[2].0, sample_points[3].0)
            || are_points_collinear(sample_points[1].0, sample_points[2].0, sample_points[3].0)
        {
            continue;
        }

        if let Some(h) = compute_homography(&sample_points) {
            let current_inliers: Vec<Match> = matches
                .par_iter()
                .enumerate()
                .filter_map(|(i, m)| {
                    let (p1, p2) = points[i];
                    let p1_h = nalgebra::Point3::new(p1.x, p1.y, 1.0);
                    let p2_h_transformed = h * p1_h;
                    if p2_h_transformed.z.abs() < 1e-8 {
                        return None;
                    }
                    let p2_transformed = Point2::new(
                        p2_h_transformed.x / p2_h_transformed.z,
                        p2_h_transformed.y / p2_h_transformed.z,
                    );
                    let dist_sq =
                        (p2.x - p2_transformed.x).powi(2) + (p2.y - p2_transformed.y).powi(2);
                    if dist_sq < ransac_inlier_threshold_sq {
                        Some(*m)
                    } else {
                        None
                    }
                })
                .collect();

            if current_inliers.len() > best_inliers.len() {
                best_inliers = current_inliers;
                best_h = Some(h);
            }
        }
    }

    if best_inliers.len() >= MIN_INLIERS_FOR_CONNECTION {
        Some((best_h.unwrap(), best_inliers))
    } else {
        None
    }
}

fn are_points_collinear(p1: Point2<f64>, p2: Point2<f64>, p3: Point2<f64>) -> bool {
    let area = p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y);
    area.abs() < 1e-6
}

pub fn compute_homography(points: &[(Point2<f64>, Point2<f64>)]) -> Option<Matrix3<f64>> {
    if points.len() < 4 {
        return None;
    }
    let mut a_rows = Vec::with_capacity(points.len() * 2);
    for (p1, p2) in points {
        let (x, y) = (p1.x, p1.y);
        let (xp, yp) = (p2.x, p2.y);
        a_rows.push(nalgebra::RowDVector::from_vec(vec![
            -x,
            -y,
            -1.0,
            0.0,
            0.0,
            0.0,
            x * xp,
            y * xp,
            xp,
        ]));
        a_rows.push(nalgebra::RowDVector::from_vec(vec![
            0.0,
            0.0,
            0.0,
            -x,
            -y,
            -1.0,
            x * yp,
            y * yp,
            yp,
        ]));
    }
    let a = nalgebra::DMatrix::from_rows(&a_rows);
    let svd = SVD::new(a, true, true);
    let v_t = svd.v_t.expect("SVD failed to compute V_t");
    let h_vec = v_t.row(v_t.nrows() - 1).transpose();
    Some(Matrix3::from_iterator(h_vec.iter().cloned()).transpose())
}

fn convert_gray_u8_to_f32(img: &GrayImage) -> ImageBuffer<Luma<f32>, Vec<f32>> {
    let (width, height) = img.dimensions();
    ImageBuffer::from_fn(width, height, |x, y| {
        Luma([img.get_pixel(x, y)[0] as f32 / 255.0])
    })
}

fn build_integral_images(gray: &GrayImage) -> (Vec<u64>, Vec<u128>) {
    let (width, height) = gray.dimensions();
    let mut sat = vec![0u64; (width * height) as usize];
    let mut sat_sq = vec![0u128; (width * height) as usize];

    for y in 0..height {
        let mut row_sum = 0u64;
        let mut row_sum_sq = 0u128;
        for x in 0..width {
            let pixel_val = gray.get_pixel(x, y)[0] as u64;
            let pixel_val_sq = pixel_val as u128 * pixel_val as u128;
            row_sum += pixel_val;
            row_sum_sq += pixel_val_sq;

            let idx = (y * width + x) as usize;
            let above_idx = if y > 0 {
                ((y - 1) * width + x) as usize
            } else {
                usize::MAX
            };

            sat[idx] = row_sum
                + if above_idx != usize::MAX {
                    sat[above_idx]
                } else {
                    0
                };
            sat_sq[idx] = row_sum_sq
                + if above_idx != usize::MAX {
                    sat_sq[above_idx]
                } else {
                    0
                };
        }
    }
    (sat, sat_sq)
}

pub fn generate_low_detail_mask(gray_full: &GrayImage) -> GrayImage {
    let (width, height) = gray_full.dimensions();
    let mut mask = GrayImage::new(width, height);
    let (sat, sat_sq) = build_integral_images(gray_full);
    let r = LOW_DETAIL_WINDOW_RADIUS as i32;

    let get_sat_val = |s: &Vec<u64>, x: i32, y: i32| -> u64 {
        if x < 0 || y < 0 {
            0
        } else {
            s[(y as u32 * width + x as u32) as usize]
        }
    };
    let get_sat_sq_val = |s: &Vec<u128>, x: i32, y: i32| -> u128 {
        if x < 0 || y < 0 {
            0
        } else {
            s[(y as u32 * width + x as u32) as usize]
        }
    };

    mask.par_chunks_mut(width as usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..width as i32 {
                let x1 = x - r - 1;
                let y1 = y as i32 - r - 1;
                let x2 = (x + r).min(width as i32 - 1);
                let y2 = (y as i32 + r).min(height as i32 - 1);

                let n_x = (x2 - (x1 + 1) + 1) as f64;
                let n_y = (y2 - (y1 + 1) + 1) as f64;
                let n = n_x * n_y;
                if n < 1.0 {
                    continue;
                }

                let sum = get_sat_val(&sat, x2, y2) + get_sat_val(&sat, x1, y1)
                    - get_sat_val(&sat, x2, y1)
                    - get_sat_val(&sat, x1, y2);
                let sum_sq = get_sat_sq_val(&sat_sq, x2, y2) + get_sat_sq_val(&sat_sq, x1, y1)
                    - get_sat_sq_val(&sat_sq, x2, y1)
                    - get_sat_sq_val(&sat_sq, x1, y2);

                let mean = sum as f64 / n;
                let variance = (sum_sq as f64 / n) - mean.powi(2);

                if variance < LOW_DETAIL_VARIANCE_THRESHOLD {
                    row[x as usize] = 255;
                } else {
                    row[x as usize] = 0;
                }
            }
        });
    mask
}

#[cfg(test)]
mod tests {
    use super::*;
    use imageproc::corners::Corner;

    #[test]
    fn test_anms_uniform_distribution() {
        // Create a dense cluster of high-scoring corners in one region, plus sparse corners elsewhere
        let mut corners = Vec::new();
        // Clustered high score corners at (10, 10)
        for i in 0..20 {
            corners.push(Corner {
                x: 10 + i % 5,
                y: 10 + i / 5,
                score: 1000.0 - i as f32,
            });
        }
        // Distant corners across canvas
        corners.push(Corner { x: 500, y: 100, score: 200.0 });
        corners.push(Corner { x: 100, y: 500, score: 200.0 });
        corners.push(Corner { x: 500, y: 500, score: 200.0 });

        let selected = adaptive_non_maximal_suppression(&corners, 5);
        assert_eq!(selected.len(), 5);

        // Verify ANMS selected corners spread out across the canvas instead of all from the cluster
        let has_distant_corner = selected.iter().any(|kp| kp.x > 200 || kp.y > 200);
        assert!(has_distant_corner, "ANMS must select spatially distributed distant corners");
    }

    #[test]
    fn test_bidirectional_match_filtering() {
        // Descriptors with 1 exact pair and 1 ambiguous pair
        let d1 = [0u8; 32];
        let mut d2 = [0u8; 32];
        d2[0] = 0b00000001; // Distance 1

        let f1 = vec![
            Feature { keypoint: KeyPoint { x: 10, y: 10 }, descriptor: d1 },
        ];
        let f2 = vec![
            Feature { keypoint: KeyPoint { x: 12, y: 10 }, descriptor: d2 },
            Feature { keypoint: KeyPoint { x: 100, y: 100 }, descriptor: [255u8; 32] },
        ];

        let matches = match_features(&f1, &f2);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].index1, 0);
        assert_eq!(matches[0].index2, 0);
    }
}
