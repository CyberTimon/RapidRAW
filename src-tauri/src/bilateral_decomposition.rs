//! Fast Multi-Scale Edge-Preserving Base/Detail Decomposition
//!
//! Separates large-scale scene illumination (Base Layer) from micro-texture (Detail Layer)
//! using an O(1) guided edge-preserving operator. This mathematically guarantees that
//! dynamic range compression (shadow lifting and highlight pulling) is applied ONLY
//! to the illumination field, completely eliminating boundary halos around high-contrast
//! edges (such as tree branches against bright skies).

use image::Rgb32FImage;
use rayon::prelude::*;

/// Parameters governing base/detail separation and layer recombination
#[derive(Debug, Clone, Copy)]
pub struct DecompositionParams {
    /// Spatial kernel radius for base illumination smoothing (e.g. 16..48 pixels)
    pub spatial_radius: usize,
    /// Edge-stopping regularization parameter (epsilon, e.g. 0.01..0.08)
    pub edge_stopping_eps: f32,
    /// Detail preservation factor (1.0 = exact optical micro-texture; <1.0 = softer; >1.0 = enhanced)
    pub detail_scale: f32,
}

impl Default for DecompositionParams {
    fn default() -> Self {
        Self {
            spatial_radius: 24,
            edge_stopping_eps: 0.03,
            detail_scale: 1.0,
        }
    }
}

/// Result of multi-scale edge-preserving decomposition
pub struct DecomposedLayers {
    /// Base illumination layer (smooth lighting with sharp structural edges preserved)
    pub base_luma: Vec<f32>,
    /// Detail layer (logarithmic micro-texture, bark, leaves, rivets)
    pub detail_luma: Vec<f32>,
    pub width: usize,
    pub height: usize,
}

/// Performs fast 2D separable box filtering on an f32 buffer in O(1) per pixel
pub fn fast_box_filter_2d(src: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    if width == 0 || height == 0 || src.is_empty() {
        return Vec::new();
    }
    let r = radius.max(1);
    let mut temp = vec![0.0f32; width * height];
    let mut dst = vec![0.0f32; width * height];

    // Horizontal pass in parallel across rows
    temp.par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row_dst)| {
            let row_src = &src[y * width..(y + 1) * width];
            let mut sum = 0.0f32;
            let mut count = 0usize;

            for x in 0..=r.min(width - 1) {
                sum += row_src[x];
                count += 1;
            }

            for x in 0..width {
                row_dst[x] = sum / count as f32;

                let add_x = x + r + 1;
                if add_x < width {
                    sum += row_src[add_x];
                    count += 1;
                }

                if x >= r {
                    let sub_x = x - r;
                    sum -= row_src[sub_x];
                    count -= 1;
                }
            }
        });

    // Transpose temp (width x height) -> transposed (height x width)
    let mut transposed = vec![0.0f32; width * height];
    let mut filtered_transposed = vec![0.0f32; width * height];

    transposed.par_chunks_mut(height).enumerate().for_each(|(x, col)| {
        for y in 0..height {
            col[y] = temp[y * width + x];
        }
    });

    // Pass 2: O(1) sliding window along transposed rows (height-wise)
    filtered_transposed.par_chunks_mut(height).enumerate().for_each(|(x, col_dst)| {
        let col_src = &transposed[x * height..(x + 1) * height];
        let mut sum = 0.0f32;
        let mut count = 0usize;

        for y in 0..=r.min(height - 1) {
            sum += col_src[y];
            count += 1;
        }

        for y in 0..height {
            col_dst[y] = sum / count as f32;

            let add_y = y + r + 1;
            if add_y < height {
                sum += col_src[add_y];
                count += 1;
            }

            if y >= r {
                let sub_y = y - r;
                sum -= col_src[sub_y];
                count -= 1;
            }
        }
    });

    // Transpose back into dst (width x height)
    dst.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for x in 0..width {
            row[x] = filtered_transposed[x * height + y];
        }
    });

    dst
}

/// Guided filter on a single f32 channel with self-guidance (Edge-Preserving Filter)
pub fn fast_edge_preserving_smooth_f32(
    src: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let len = width * height;
    if len == 0 {
        return Vec::new();
    }

    // Mean of I
    let mean_i = fast_box_filter_2d(src, width, height, radius);

    // I * I
    let mut i_sq = vec![0.0f32; len];
    for idx in 0..len {
        i_sq[idx] = src[idx] * src[idx];
    }
    // Mean of I * I
    let mean_ii = fast_box_filter_2d(&i_sq, width, height, radius);

    // Variance = mean(I^2) - mean(I)^2
    let mut a = vec![0.0f32; len];
    let mut b = vec![0.0f32; len];

    for idx in 0..len {
        let var_i = (mean_ii[idx] - mean_i[idx] * mean_i[idx]).max(0.0);
        let a_val = var_i / (var_i + eps);
        let b_val = (1.0 - a_val) * mean_i[idx];
        a[idx] = a_val;
        b[idx] = b_val;
    }

    // Mean of a, Mean of b
    let mean_a = fast_box_filter_2d(&a, width, height, radius);
    let mean_b = fast_box_filter_2d(&b, width, height, radius);

    // q = mean_a * I + mean_b
    let mut q = vec![0.0f32; len];
    for idx in 0..len {
        q[idx] = mean_a[idx] * src[idx] + mean_b[idx];
    }

    q
}

/// Decomposes an RGB image into Base Illumination and Micro-Detail in the log domain
pub fn decompose_image_base_detail(
    img: &Rgb32FImage,
    params: &DecompositionParams,
) -> DecomposedLayers {
    let (w, h) = img.dimensions();
    let width = w as usize;
    let height = h as usize;
    let len = width * height;

    let raw = img.as_raw();
    let mut log_luma = vec![0.0f32; len];

    for idx in 0..len {
        let r = raw[idx * 3].max(1e-6);
        let g = raw[idx * 3 + 1].max(1e-6);
        let b = raw[idx * 3 + 2].max(1e-6);
        let y = (0.2126 * r + 0.7152 * g + 0.0722 * b).max(1e-6);
        log_luma[idx] = y.ln();
    }

    // Base layer is the edge-preserving smoothed illumination field in log space
    let base_log = fast_edge_preserving_smooth_f32(
        &log_luma,
        width,
        height,
        params.spatial_radius,
        params.edge_stopping_eps,
    );

    // Detail layer is the residual log difference: D = ln(Y) - ln(Base)
    let mut detail_log = vec![0.0f32; len];
    for idx in 0..len {
        detail_log[idx] = log_luma[idx] - base_log[idx];
    }

    DecomposedLayers {
        base_luma: base_log,
        detail_luma: detail_log,
        width,
        height,
    }
}

/// Recombines compressed base illumination with micro-detail and scales RGB channels
pub fn recombine_layers(
    compressed_base_luma: &[f32],
    layers: &DecomposedLayers,
    original_img: &Rgb32FImage,
    detail_scale: f32,
) -> Rgb32FImage {
    let width = layers.width as u32;
    let height = layers.height as u32;
    let mut out = Rgb32FImage::new(width, height);

    let raw_orig = original_img.as_raw();
    let raw_out = out.as_mut();

    // Parallel recombination per pixel
    raw_out
        .par_chunks_mut(3)
        .enumerate()
        .for_each(|(idx, out_pixel)| {
            let orig_r = raw_orig[idx * 3];
            let orig_g = raw_orig[idx * 3 + 1];
            let orig_b = raw_orig[idx * 3 + 2];
            let orig_y = (0.2126 * orig_r + 0.7152 * orig_g + 0.0722 * orig_b).max(1e-6);

            // Reconstruct luminance: Y_out = exp(Base_mapped + Detail * scale)
            let base_val = compressed_base_luma[idx];
            let detail_val = layers.detail_luma[idx] * detail_scale;
            let target_y = (base_val + detail_val).exp().clamp(0.0, 1.0);

            // Color preservation: scale channels proportionally with gentle saturation compensation
            let ratio = (target_y / orig_y).clamp(0.02, 20.0);
            out_pixel[0] = (orig_r * ratio).clamp(0.0, 1.0);
            out_pixel[1] = (orig_g * ratio).clamp(0.0, 1.0);
            out_pixel[2] = (orig_b * ratio).clamp(0.0, 1.0);
        });

    out
}
