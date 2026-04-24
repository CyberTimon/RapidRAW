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
const NON_MAXIMA_SUPPRESSION_RADIUS: f32 = 15.0;
const BRIEF_PATCH_SIZE: u32 = 32;
const MATCH_RATIO_THRESHOLD: f32 = 0.8;
const RANSAC_ITERATIONS: usize = 2500;
const RANSAC_INLIER_THRESHOLD: f64 = 5.0;
pub const MIN_INLIERS_FOR_CONNECTION: usize = 15;
const LOW_DETAIL_WINDOW_RADIUS: u32 = 16;
const LOW_DETAIL_VARIANCE_THRESHOLD: f64 = 60.0;

pub fn calculate_downscale_dimensions(width: u32, height: u32) -> (u32, u32, f64) {
    let long_side = width.max(height);
    if long_side <= MAX_PROCESSING_DIMENSION {
        return (width, height, 1.0);
    }
    let scale_factor = long_side as f64 / MAX_PROCESSING_DIMENSION as f64;
    let new_width = (width as f64 / scale_factor).round() as u32;
    let new_height = (height as f64 / scale_factor).round() as u32;
    (new_width, new_height, scale_factor)
}

pub fn find_features(img: &GrayImage, brief_pairs: &[(Point2<i32>, Point2<i32>)]) -> Vec<Feature> {
    let blurred_img_u8 = imageproc::filter::gaussian_blur_f32(img, 1.5);
    let corners = corners_fast9(&blurred_img_u8, FAST_THRESHOLD);
    let keypoints = non_maximal_suppression(&corners, NON_MAXIMA_SUPPRESSION_RADIUS);
    let blurred_img_f32 = gaussian_blur_f32(&convert_gray_u8_to_f32(img), 2.0);
    let features: Vec<Feature> = keypoints
        .par_iter()
        .filter_map(|kp| {
            compute_brief_descriptor(&blurred_img_f32, kp, BRIEF_PATCH_SIZE, brief_pairs).map(
                |descriptor| Feature {
                    keypoint: *kp,
                    descriptor,
                },
            )
        })
        .collect();
    features
}

fn non_maximal_suppression(corners: &[Corner], radius: f32) -> Vec<KeyPoint> {
    let mut sorted_corners = corners.to_vec();
    sorted_corners.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    let mut result = Vec::new();
    let radius_sq = radius * radius;
    let mut is_suppressed_grid = vec![false; sorted_corners.len()];
    for i in 0..sorted_corners.len() {
        if is_suppressed_grid[i] {
            continue;
        }
        let corner_i = sorted_corners[i];
        result.push(KeyPoint {
            x: corner_i.x,
            y: corner_i.y,
        });
        for j in (i + 1)..sorted_corners.len() {
            if is_suppressed_grid[j] {
                continue;
            }
            let corner_j = sorted_corners[j];
            let dx = corner_i.x as f32 - corner_j.x as f32;
            let dy = corner_i.y as f32 - corner_j.y as f32;
            if dx * dx + dy * dy < radius_sq {
                is_suppressed_grid[j] = true;
            }
        }
    }
    result
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

fn compute_brief_descriptor(
    img: &ImageBuffer<Luma<f32>, Vec<f32>>,
    kp: &KeyPoint,
    patch_size: u32,
    pairs: &[(Point2<i32>, Point2<i32>)],
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
    for (i, pair) in pairs.iter().enumerate() {
        let p1_x = (kp.x as i32 + pair.0.x) as u32;
        let p1_y = (kp.y as i32 + pair.0.y) as u32;
        let p2_x = (kp.x as i32 + pair.1.x) as u32;
        let p2_y = (kp.y as i32 + pair.1.y) as u32;
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

pub fn match_features(features1: &[Feature], features2: &[Feature]) -> Vec<Match> {
    if features1.is_empty() || features2.is_empty() {
        return Vec::new();
    }
    features1
        .par_iter()
        .enumerate()
        .filter_map(|(i, f1)| {
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
                Some(Match {
                    index1: i,
                    index2: best_idx,
                })
            } else {
                None
            }
        })
        .collect()
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
    println!("    - Generating low-detail mask...");
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
