use image::{GrayImage, ImageBuffer, Luma, Rgb, Rgb32FImage};
use imageproc::corners::{Corner, corners_fast9};
use imageproc::filter::gaussian_blur_f32;
use nalgebra::{Matrix3, Point2, Point3, SVD};
use rand::prelude::*;
use rand::rng;
use rayon::prelude::*;

pub const BRIEF_DESCRIPTOR_SIZE: usize = 256;
pub type Descriptor = [u8; BRIEF_DESCRIPTOR_SIZE / 8];

#[derive(Debug, Clone, Copy)]
pub struct KeyPoint {
    pub x: u32,
    pub y: u32,
}

pub struct Feature {
    pub keypoint: KeyPoint,
    pub descriptor: Descriptor,
}

#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub index1: usize,
    pub index2: usize,
}

const BRIEF_PATCH_SIZE: u32 = 32;
const MATCH_RATIO_THRESHOLD: f32 = 0.8;
const RANSAC_ITERATIONS: usize = 2500;
const RANSAC_INLIER_THRESHOLD: f64 = 5.0;
pub const MIN_INLIERS_FOR_CONNECTION: usize = 15;

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

pub fn find_features_tuned(
    img: &GrayImage,
    brief_pairs: &[(Point2<i32>, Point2<i32>)],
    fast_threshold: u8,
    non_maxima_suppression_radius: f32,
) -> Vec<Feature> {
    let blurred_img_u8 = imageproc::filter::gaussian_blur_f32(img, 1.5);
    let corners = corners_fast9(&blurred_img_u8, fast_threshold);
    let keypoints = non_maximal_suppression(&corners, non_maxima_suppression_radius);
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

fn compute_homography(points: &[(Point2<f64>, Point2<f64>)]) -> Option<Matrix3<f64>> {
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

pub fn warp_image_homography(
    source: &Rgb32FImage,
    homography: &Matrix3<f64>,
    width: u32,
    height: u32,
) -> Rgb32FImage {
    assert!(width > 0 && height > 0, "warp output must be non-empty");
    let mut buffer = vec![0.0f32; (width as usize) * (height as usize) * 3];
    buffer
        .par_chunks_mut(width as usize * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..width {
                let mapped = homography * Point3::new(x as f64, y as f64, 1.0);
                let pixel = if mapped.z.abs() < 1e-8 {
                    Rgb([0.0, 0.0, 0.0])
                } else {
                    get_interpolated_pixel(source, mapped.x / mapped.z, mapped.y / mapped.z)
                };
                let base = x as usize * 3;
                row[base] = pixel[0];
                row[base + 1] = pixel[1];
                row[base + 2] = pixel[2];
            }
        });
    Rgb32FImage::from_raw(width, height, buffer)
        .expect("warp buffer dimensions must match output image")
}

fn get_interpolated_pixel(img: &Rgb32FImage, x: f64, y: f64) -> Rgb<f32> {
    let (width, height) = img.dimensions();
    let x_floor = x.floor() as u32;
    let y_floor = y.floor() as u32;
    if x_floor + 1 >= width || y_floor + 1 >= height || x < 0.0 || y < 0.0 {
        return *img.get_pixel(
            x.max(0.0).min(width as f64 - 1.0) as u32,
            y.max(0.0).min(height as f64 - 1.0) as u32,
        );
    }
    let dx = x - x_floor as f64;
    let dy = y - y_floor as f64;
    let p00 = img.get_pixel(x_floor, y_floor);
    let p10 = img.get_pixel(x_floor + 1, y_floor);
    let p01 = img.get_pixel(x_floor, y_floor + 1);
    let p11 = img.get_pixel(x_floor + 1, y_floor + 1);
    let mut final_pixel = [0.0; 3];
    for i in 0..3 {
        let c00 = p00[i] as f64;
        let c10 = p10[i] as f64;
        let c01 = p01[i] as f64;
        let c11 = p11[i] as f64;
        let top = c00 * (1.0 - dx) + c10 * dx;
        let bottom = c01 * (1.0 - dx) + c11 * dx;
        final_pixel[i] = top * (1.0 - dy) + bottom * dy;
    }
    Rgb([
        final_pixel[0] as f32,
        final_pixel[1] as f32,
        final_pixel[2] as f32,
    ])
}
