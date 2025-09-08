use image::{DynamicImage, GenericImageView, GrayImage, Rgb, RgbImage, Rgba, RgbaImage};
use rand::seq::SliceRandom;
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

const PIXEL_KNOWN: u8 = 0;
const PIXEL_HOLE: u8 = 1;
const PIXEL_FRONT: u8 = 2;

#[derive(Debug, Copy, Clone, PartialEq)]
struct FloatOrd(f32);
impl Eq for FloatOrd {}
impl PartialOrd for FloatOrd {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        self.0.partial_cmp(&other.0)
    }
}
impl Ord for FloatOrd {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).unwrap_or(Ordering::Equal)
    }
}

struct HeapItem {
    priority: FloatOrd,
    x: u32,
    y: u32,
    confidence: f32,
}
impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other.priority.cmp(&self.priority)
    }
}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.priority == other.priority
    }
}
impl Eq for HeapItem {}

/// Performs Criminisi inpainting algorithm on the source image using the provided mask and patch radius.
///
/// # Arguments
/// * `source_image` - The source RGB image.
/// * `mask` - The mask indicating regions to inpaint.
/// * `patch_radius` - The radius of the patch used for inpainting.
///
/// # Returns
/// * `RgbImage` - The inpainted image.
fn inpaint_criminisi(source_image: &RgbImage, mask: &GrayImage, patch_radius: u32) -> RgbImage {
    let (width, height) = source_image.dimensions();
    let mut output = source_image.clone();
    let mut pixel_states = vec![PIXEL_KNOWN; (width * height) as usize];
    let mut confidence = vec![0.0f32; (width * height) as usize];
    let mut narrow_band = BinaryHeap::new();

    let mut float_output = vec![[0.0f32; 3]; (width * height) as usize];
    let mut total_weights = vec![0.0f32; (width * height) as usize];

    let gaussian_kernel = get_gaussian_kernel(patch_radius, patch_radius as f32 / 2.0);

    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            if mask.get_pixel(x, y)[0] > 0 {
                pixel_states[idx] = PIXEL_HOLE;
            } else {
                confidence[idx] = 1.0;
                let p = source_image.get_pixel(x, y);
                float_output[idx] = [p[0] as f32, p[1] as f32, p[2] as f32];
                total_weights[idx] = 1.0;
            }
        }
    }

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            if pixel_states[(y * width + x) as usize] == PIXEL_HOLE
                && get_neighbors(x, y, width, height)
                    .iter()
                    .any(|(nx, ny)| pixel_states[(ny * width + nx) as usize] == PIXEL_KNOWN)
            {
                pixel_states[(y * width + x) as usize] = PIXEL_FRONT;
            }
        }
    }

    loop {
        let smoothed_normals = calculate_and_smooth_normals(&pixel_states, width, height, 2);
        if smoothed_normals.is_empty() {
            break;
        }

        narrow_band.clear();
        for (&(x, y), &normal) in &smoothed_normals {
            let (priority, confidence_term) = calculate_priority(
                &output,
                &pixel_states,
                &confidence,
                width,
                height,
                x,
                y,
                patch_radius,
                normal,
            );
            narrow_band.push(HeapItem {
                priority: FloatOrd(priority),
                x,
                y,
                confidence: confidence_term,
            });
        }

        if narrow_band.is_empty() {
            break;
        }

        let num_patches_per_iteration = 1;

        for _ in 0..num_patches_per_iteration {
            if let Some(p_hat_item) = narrow_band.pop() {
                let (px, py) = (p_hat_item.x, p_hat_item.y);
                let p_idx = (py * width + px) as usize;

                if pixel_states[p_idx] != PIXEL_FRONT {
                    continue;
                }

                let p_hat_confidence = p_hat_item.confidence;

                let search_radius = (patch_radius * 7).max(30);
                let max_samples = 500;
                let (best_match_x, best_match_y) = find_best_match_local(
                    &output,
                    &pixel_states,
                    width,
                    height,
                    px,
                    py,
                    patch_radius,
                    search_radius,
                    max_samples,
                    &gaussian_kernel,
                );

                let r = patch_radius as i32;
                let patch_diameter = (patch_radius * 2 + 1) as usize;
                let mut filled_pixels_coords = Vec::new();

                for dy in -r..=r {
                    for dx in -r..=r {
                        let target_x = (px as i32 + dx).clamp(0, (width - 1) as i32) as u32;
                        let target_y = (py as i32 + dy).clamp(0, (height - 1) as i32) as u32;
                        let idx = (target_y * width + target_x) as usize;

                        if mask.get_pixel(target_x, target_y)[0] > 0 {
                            let source_x =
                                (best_match_x as i32 + dx).clamp(0, (width - 1) as i32) as u32;
                            let source_y =
                                (best_match_y as i32 + dy).clamp(0, (height - 1) as i32) as u32;

                            let weight = gaussian_kernel
                                [((dy + r) as usize * patch_diameter) + (dx + r) as usize];
                            let source_pixel = output.get_pixel(source_x, source_y);

                            for i in 0..3 {
                                float_output[idx][i] += source_pixel[i] as f32 * weight;
                            }
                            total_weights[idx] += weight;

                            if total_weights[idx] > 0.0 {
                                let final_color = Rgb([
                                    (float_output[idx][0] / total_weights[idx]).clamp(0.0, 255.0)
                                        as u8,
                                    (float_output[idx][1] / total_weights[idx]).clamp(0.0, 255.0)
                                        as u8,
                                    (float_output[idx][2] / total_weights[idx]).clamp(0.0, 255.0)
                                        as u8,
                                ]);
                                output.put_pixel(target_x, target_y, final_color);
                            }

                            if pixel_states[idx] != PIXEL_KNOWN {
                                confidence[idx] = p_hat_confidence;
                                pixel_states[idx] = PIXEL_KNOWN;
                                filled_pixels_coords.push((target_x, target_y));
                            }
                        }
                    }
                }

                for (x_filled, y_filled) in filled_pixels_coords {
                    for (nx, ny) in get_neighbors(x_filled, y_filled, width, height) {
                        let n_idx = (ny * width + nx) as usize;
                        if pixel_states[n_idx] == PIXEL_HOLE {
                            pixel_states[n_idx] = PIXEL_FRONT;
                        }
                    }
                }
            } else {
                break;
            }
        }
    }
    output
}

/// Generates a Gaussian kernel for patch weighting.
///
/// # Arguments
/// * `radius` - The radius of the kernel.
/// * `sigma` - The standard deviation of the Gaussian.
///
/// # Returns
/// * `Vec<f32>` - The Gaussian kernel.
fn get_gaussian_kernel(radius: u32, sigma: f32) -> Vec<f32> {
    let diameter = (radius * 2 + 1) as usize;
    let mut kernel = vec![0.0; diameter * diameter];
    let r_i32 = radius as i32;
    let sigma2 = 2.0 * sigma * sigma;
    let mut sum = 0.0;

    for dy in -r_i32..=r_i32 {
        for dx in -r_i32..=r_i32 {
            let distance_sq = (dx * dx + dy * dy) as f32;
            let val = (-distance_sq / sigma2).exp();
            kernel[((dy + r_i32) as usize * diameter) + (dx + r_i32) as usize] = val;
            sum += val;
        }
    }
    if sum > 0.0 {
        kernel.iter_mut().for_each(|v| *v /= sum);
    }
    kernel
}

/// Computes the luminance of an RGB pixel.
///
/// # Arguments
/// * `p` - The RGB pixel.
///
/// # Returns
/// * `f32` - The luminance value.
fn get_pixel_luma(p: &Rgb<u8>) -> f32 {
    0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
}

/// Returns the coordinates of neighboring pixels for a given pixel.
///
/// # Arguments
/// * `x`, `y` - Pixel coordinates.
/// * `width`, `height` - Image dimensions.
///
/// # Returns
/// * `Vec<(u32, u32)>` - Neighbor coordinates.
fn get_neighbors(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut neighbors = Vec::with_capacity(8);
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let nx = x as i32 + dx;
            let ny = y as i32 + dy;
            if nx >= 0 && nx < width as i32 && ny >= 0 && ny < height as i32 {
                neighbors.push((nx as u32, ny as u32));
            }
        }
    }
    neighbors
}

/// Calculates the normal vector at a given pixel on the front.
///
/// # Arguments
/// * `pixel_states` - State of each pixel.
/// * `width`, `height` - Image dimensions.
/// * `x`, `y` - Pixel coordinates.
///
/// # Returns
/// * `(f32, f32)` - The normal vector.
fn calculate_normal(pixel_states: &[u8], width: u32, height: u32, x: u32, y: u32) -> (f32, f32) {
    let x_p1 = (x + 1).min(width - 1);
    let x_m1 = x.saturating_sub(1);
    let y_p1 = (y + 1).min(height - 1);
    let y_m1 = y.saturating_sub(1);
    let state_at = |x, y| {
        if pixel_states[(y * width + x) as usize] == PIXEL_KNOWN {
            0
        } else {
            1
        }
    };
    let grad_x = (state_at(x_p1, y) as i32 - state_at(x_m1, y) as i32) as f32;
    let grad_y = (state_at(x, y_p1) as i32 - state_at(x, y_m1) as i32) as f32;
    let mag = (grad_x * grad_x + grad_y * grad_y).sqrt();
    if mag > 1e-6 {
        (-grad_y / mag, grad_x / mag)
    } else {
        (0.0, 0.0)
    }
}

/// Calculates and smooths normals for all front pixels.
///
/// # Arguments
/// * `pixel_states` - State of each pixel.
/// * `width`, `height` - Image dimensions.
/// * `smoothing_window` - Window size for smoothing.
///
/// # Returns
/// * `HashMap<(u32, u32), (f32, f32)>` - Smoothed normals.
fn calculate_and_smooth_normals(
    pixel_states: &[u8],
    width: u32,
    height: u32,
    smoothing_window: i32,
) -> HashMap<(u32, u32), (f32, f32)> {
    let mut front_points = Vec::new();
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            if pixel_states[(y * width + x) as usize] == PIXEL_FRONT {
                front_points.push((x, y));
            }
        }
    }

    let mut raw_normals = HashMap::new();
    for &(x, y) in &front_points {
        raw_normals.insert((x, y), calculate_normal(pixel_states, width, height, x, y));
    }

    let mut smoothed_normals = HashMap::new();
    for &(x, y) in &front_points {
        let mut avg_normal = (0.0, 0.0);
        let mut count = 0;
        for dy in -smoothing_window..=smoothing_window {
            for dx in -smoothing_window..=smoothing_window {
                let nx = (x as i32 + dx) as u32;
                let ny = (y as i32 + dy) as u32;
                if let Some(normal) = raw_normals.get(&(nx, ny)) {
                    avg_normal.0 += normal.0;
                    avg_normal.1 += normal.1;
                    count += 1;
                }
            }
        }

        if count > 0 {
            let mag = (avg_normal.0 * avg_normal.0 + avg_normal.1 * avg_normal.1).sqrt();
            if mag > 1e-6 {
                smoothed_normals.insert((x, y), (avg_normal.0 / mag, avg_normal.1 / mag));
            } else {
                smoothed_normals.insert((x, y), raw_normals[&(x, y)]);
            }
        } else {
            smoothed_normals.insert((x, y), raw_normals[&(x, y)]);
        }
    }
    smoothed_normals
}

/// Computes the gradient at a given pixel.
///
/// # Arguments
/// * `image` - The RGB image.
/// * `pixel_states` - State of each pixel.
/// * `width`, `height` - Image dimensions.
/// * `x`, `y` - Pixel coordinates.
///
/// # Returns
/// * `(f32, f32)` - The gradient vector.
fn get_gradient_at_point(
    image: &RgbImage,
    pixel_states: &[u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
) -> (f32, f32) {
    let x_p1 = (x + 1).min(width - 1);
    let x_m1 = x.saturating_sub(1);
    let y_p1 = (y + 1).min(height - 1);
    let y_m1 = y.saturating_sub(1);

    let mut grad_x = 0.0;
    if pixel_states[(y * width + x_p1) as usize] == PIXEL_KNOWN
        && pixel_states[(y * width + x_m1) as usize] == PIXEL_KNOWN
    {
        grad_x = (get_pixel_luma(image.get_pixel(x_p1, y))
            - get_pixel_luma(image.get_pixel(x_m1, y)))
            / 2.0;
    } else if pixel_states[(y * width + x_p1) as usize] == PIXEL_KNOWN {
        grad_x = get_pixel_luma(image.get_pixel(x_p1, y)) - get_pixel_luma(image.get_pixel(x, y));
    } else if pixel_states[(y * width + x_m1) as usize] == PIXEL_KNOWN {
        grad_x = get_pixel_luma(image.get_pixel(x, y)) - get_pixel_luma(image.get_pixel(x_m1, y));
    }

    let mut grad_y = 0.0;
    if pixel_states[(y_p1 * width + x) as usize] == PIXEL_KNOWN
        && pixel_states[(y_m1 * width + x) as usize] == PIXEL_KNOWN
    {
        grad_y = (get_pixel_luma(image.get_pixel(x, y_p1))
            - get_pixel_luma(image.get_pixel(x, y_m1)))
            / 2.0;
    } else if pixel_states[(y_p1 * width + x) as usize] == PIXEL_KNOWN {
        grad_y = get_pixel_luma(image.get_pixel(x, y_p1)) - get_pixel_luma(image.get_pixel(x, y));
    } else if pixel_states[(y_m1 * width + x) as usize] == PIXEL_KNOWN {
        grad_y = get_pixel_luma(image.get_pixel(x, y)) - get_pixel_luma(image.get_pixel(x, y_m1));
    }

    (-grad_y, grad_x)
}

/// Calculates the priority for a front pixel during inpainting.
///
/// # Arguments
/// * `image` - The RGB image.
/// * `pixel_states` - State of each pixel.
/// * `confidence` - Confidence values.
/// * `width`, `height` - Image dimensions.
/// * `px`, `py` - Pixel coordinates.
/// * `patch_radius` - Patch radius.
/// * `normal` - Normal vector.
///
/// # Returns
/// * `(f32, f32)` - Priority and confidence term.
fn calculate_priority(
    image: &RgbImage,
    pixel_states: &[u8],
    confidence: &[f32],
    width: u32,
    height: u32,
    px: u32,
    py: u32,
    patch_radius: u32,
    normal: (f32, f32),
) -> (f32, f32) {
    let r = patch_radius as i32;
    let mut confidence_sum = 0.0;
    let mut count = 0;
    for dy in -r..=r {
        for dx in -r..=r {
            let qx = (px as i32 + dx).clamp(0, (width - 1) as i32) as u32;
            let qy = (py as i32 + dy).clamp(0, (height - 1) as i32) as u32;
            let idx = (qy * width + qx) as usize;
            if pixel_states[idx] == PIXEL_KNOWN {
                confidence_sum += confidence[idx];
                count += 1;
            }
        }
    }
    let confidence_term = if count > 0 {
        confidence_sum / count as f32
    } else {
        0.0
    };

    let (normal_x, normal_y) = normal;
    let (isophote_x, isophote_y) =
        get_gradient_at_point(image, pixel_states, width, height, px, py);

    let data_term = (isophote_x * normal_x + isophote_y * normal_y).abs() / 255.0;
    let priority = confidence_term * data_term + 0.001;
    (priority, confidence_term)
}

/// Calculates the sum of squared differences (SSD) between two patches.
///
/// # Arguments
/// * `image` - The RGB image.
/// * `pixel_states` - State of each pixel.
/// * `width`, `height` - Image dimensions.
/// * `px`, `py` - Target patch coordinates.
/// * `qx`, `qy` - Source patch coordinates.
/// * `patch_radius` - Patch radius.
/// * `kernel` - Gaussian kernel.
///
/// # Returns
/// * `f64` - The SSD value.
fn calculate_ssd(
    image: &RgbImage,
    pixel_states: &[u8],
    width: u32,
    height: u32,
    px: u32,
    py: u32,
    qx: u32,
    qy: u32,
    patch_radius: u32,
    kernel: &[f32],
) -> f64 {
    let mut ssd = 0.0;
    let mut total_weight = 0.0;
    let r = patch_radius as i32;
    let diameter = (patch_radius * 2 + 1) as usize;

    for dy in -r..=r {
        for dx in -r..=r {
            let target_x = (px as i32 + dx).clamp(0, (width - 1) as i32) as u32;
            let target_y = (py as i32 + dy).clamp(0, (height - 1) as i32) as u32;

            if pixel_states[(target_y * width + target_x) as usize] == PIXEL_KNOWN {
                let source_x = (qx as i32 + dx).clamp(0, (width - 1) as i32) as u32;
                let source_y = (qy as i32 + dy).clamp(0, (height - 1) as i32) as u32;

                let p_target = image.get_pixel(target_x, target_y);
                let p_source = image.get_pixel(source_x, source_y);

                let weight = kernel[((dy + r) as usize * diameter) + (dx + r) as usize] as f64;

                let mut diff_sq_sum = 0.0;
                for i in 0..3 {
                    let diff = p_target[i] as f64 - p_source[i] as f64;
                    diff_sq_sum += diff * diff;
                }
                ssd += diff_sq_sum * weight;
                total_weight += weight;
            }
        }
    }
    if total_weight == 0.0 {
        f64::MAX
    } else {
        ssd / total_weight
    }
}

/// Finds the best matching patch in the local neighborhood for inpainting.
///
/// # Arguments
/// * `image` - The RGB image.
/// * `pixel_states` - State of each pixel.
/// * `width`, `height` - Image dimensions.
/// * `px`, `py` - Target patch coordinates.
/// * `patch_radius` - Patch radius.
/// * `search_radius` - Search radius.
/// * `max_samples` - Maximum number of samples.
/// * `kernel` - Gaussian kernel.
///
/// # Returns
/// * `(u32, u32)` - Coordinates of the best matching patch.
fn find_best_match_local(
    image: &RgbImage,
    pixel_states: &[u8],
    width: u32,
    height: u32,
    px: u32,
    py: u32,
    patch_radius: u32,
    search_radius: u32,
    max_samples: usize,
    kernel: &[f32],
) -> (u32, u32) {
    let r = patch_radius as i32;
    let sr = search_radius as i32;

    let x_min = (px as i32 - sr).max(r) as u32;
    let x_max = (px as i32 + sr).min(width as i32 - 1 - r) as u32;
    let y_min = (py as i32 - sr).max(r) as u32;
    let y_max = (py as i32 + sr).min(height as i32 - 1 - r) as u32;

    let mut local_candidates = Vec::new();
    for y in (y_min..=y_max).step_by(2) {
        for x in (x_min..=x_max).step_by(2) {
            let mut is_valid = true;
            'check: for dy in -r..=r {
                for dx in -r..=r {
                    let qx = (x as i32 + dx) as u32;
                    let qy = (y as i32 + dy) as u32;
                    if pixel_states[(qy * width + qx) as usize] != PIXEL_KNOWN {
                        is_valid = false;
                        break 'check;
                    }
                }
            }
            if is_valid {
                local_candidates.push((x, y));
            }
        }
    }

    if local_candidates.is_empty() {
        return (px, py);
    }

    let mut rng = rand::rng();
    let search_sample: Vec<_> = if local_candidates.len() > max_samples {
        let mut shuffled = local_candidates.clone();
        shuffled.shuffle(&mut rng);
        shuffled.truncate(max_samples);
        shuffled
    } else {
        local_candidates
    };

    let best_match = search_sample.par_iter().min_by(|&&(ax, ay), &&(bx, by)| {
        let ssd_a = calculate_ssd(
            image,
            pixel_states,
            width,
            height,
            px,
            py,
            ax,
            ay,
            patch_radius,
            kernel,
        );
        let ssd_b = calculate_ssd(
            image,
            pixel_states,
            width,
            height,
            px,
            py,
            bx,
            by,
            patch_radius,
            kernel,
        );

        let dist_sq_a = ((px as i64 - ax as i64).pow(2) + (py as i64 - ay as i64).pow(2)) as f64;
        let dist_sq_b = ((px as i64 - bx as i64).pow(2) + (py as i64 - by as i64).pow(2)) as f64;

        let score_a = ssd_a + dist_sq_a * 0.05;
        let score_b = ssd_b + dist_sq_b * 0.05;

        score_a.partial_cmp(&score_b).unwrap_or(Ordering::Equal)
    });

    best_match.map(|v| *v).unwrap_or((px, py))
}

/// Performs fast inpainting on the source image using the provided mask and patch radius.
///
/// # Arguments
/// * `source_image` - The source image.
/// * `mask` - The mask indicating regions to inpaint.
/// * `patch_radius` - The radius of the patch used for inpainting.
///
/// # Returns
/// * `Result<RgbaImage, String>` - The inpainted image or an error.
pub fn perform_fast_inpaint(
    source_image: &DynamicImage,
    mask: &GrayImage,
    patch_radius: u32,
) -> Result<RgbaImage, String> {
    if patch_radius == 0 {
        return Err("Patch radius must be greater than 0.".to_string());
    }
    let source_rgb = source_image.to_rgb8();
    let inpainted_rgb = inpaint_criminisi(&source_rgb, mask, patch_radius);
    let (width, height) = inpainted_rgb.dimensions();
    let mut final_image = RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let original_pixel = source_image.get_pixel(x, y);
            let inpainted_pixel = inpainted_rgb.get_pixel(x, y);
            final_image.put_pixel(
                x,
                y,
                Rgba([
                    inpainted_pixel[0],
                    inpainted_pixel[1],
                    inpainted_pixel[2],
                    original_pixel[3],
                ]),
            );
        }
    }
    Ok(final_image)
}
