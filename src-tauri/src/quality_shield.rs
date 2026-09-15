//! Photographic Quality Shield
//!
//! Provides automated quality gate invariant enforcement to ensure that no rendered,
//! merged, or stitched image leaves the processing pipeline with collapsed dynamic range,
//! lifted milky black floors, or inverted geometric projections.

use image::Rgb32FImage;
use rayon::prelude::*;

/// Photographic quality gate configuration options
#[derive(Debug, Clone)]
pub struct QualityGateOptions {
    /// Target luminance for Ansel Adams Zone 0 / deep black (default: 0.012 ≈ 3 DN)
    pub target_min_black: f32,
    /// Target luminance for Zone IX/X specular highlights (default: 0.985 ≈ 251 DN)
    pub target_white_ceiling: f32,
    /// Maximum acceptable 0.5th percentile luminance before triggering automatic contrast anchoring (default: 0.040 ≈ 10 DN)
    pub max_acceptable_black_floor: f32,
    /// Minimum acceptable luminance standard deviation (default: 0.110 ≈ 28 DN on 0..255 scale)
    pub min_acceptable_contrast_std: f32,
    /// Whether to enforce automatic histogram contrast normalization if out of bounds
    pub enforce_histogram_stretch: bool,
}

impl Default for QualityGateOptions {
    fn default() -> Self {
        Self {
            target_min_black: 0.012,
            target_white_ceiling: 0.985,
            max_acceptable_black_floor: 0.12,
            min_acceptable_contrast_std: 0.110,
            enforce_histogram_stretch: false,
        }
    }
}

/// Measured photographic histogram and contrast metrics
#[derive(Debug, Clone)]
pub struct QualityGateMetrics {
    pub min_luminance: f32,
    pub max_luminance: f32,
    pub p005_luminance: f32,
    pub p995_luminance: f32,
    pub mean_luminance: f32,
    pub std_luminance: f32,
    pub dynamic_range_span: f32,
    pub was_stretched: bool,
}

/// Fast O(N) calculation of photographic histogram and percentile metrics
pub fn measure_photographic_histogram(img: &Rgb32FImage) -> QualityGateMetrics {
    let (width, height) = img.dimensions();
    let total_pixels = (width * height) as usize;
    if total_pixels == 0 {
        return QualityGateMetrics {
            min_luminance: 0.0,
            max_luminance: 0.0,
            p005_luminance: 0.0,
            p995_luminance: 0.0,
            mean_luminance: 0.0,
            std_luminance: 0.0,
            dynamic_range_span: 0.0,
            was_stretched: false,
        };
    }

    // Step size for sampling to keep measurement sub-millisecond even on 100MP composites
    let stride = if total_pixels > 4_000_000 {
        (total_pixels / 2_000_000).max(1)
    } else {
        1
    };

    const BINS: usize = 1024;
    let mut hist = vec![0u32; BINS];
    let mut sum_y = 0.0f64;
    let mut sum_y2 = 0.0f64;
    let mut sample_count = 0usize;
    let mut min_y = 1.0f32;
    let mut max_y = 0.0f32;

    let raw_buf = img.as_raw();
    for i in (0..total_pixels).step_by(stride) {
        let r = raw_buf[i * 3].clamp(0.0, 1.0);
        let g = raw_buf[i * 3 + 1].clamp(0.0, 1.0);
        let b = raw_buf[i * 3 + 2].clamp(0.0, 1.0);

        // Standard Rec.709 relative luminance
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        min_y = min_y.min(y);
        max_y = max_y.max(y);
        sum_y += y as f64;
        sum_y2 += (y * y) as f64;

        let bin = ((y * (BINS - 1) as f32).round() as usize).min(BINS - 1);
        hist[bin] += 1;
        sample_count += 1;
    }

    let mean = (sum_y / sample_count as f64) as f32;
    let variance = ((sum_y2 / sample_count as f64) - (mean as f64 * mean as f64)).max(0.0);
    let std = (variance.sqrt()) as f32;

    // Determine 0.5% (shadows) and 99.5% (specular) thresholds from histogram
    let target_005 = (sample_count as f32 * 0.005).round() as u32;
    let target_995 = (sample_count as f32 * 0.995).round() as u32;

    let mut cum = 0u32;
    let mut p005 = min_y;
    let mut p995 = max_y;
    let mut found_005 = false;

    for (bin_idx, &count) in hist.iter().enumerate() {
        cum += count;
        let luma_at_bin = bin_idx as f32 / (BINS - 1) as f32;
        if !found_005 && cum >= target_005 {
            p005 = luma_at_bin;
            found_005 = true;
        }
        if cum >= target_995 {
            p995 = luma_at_bin;
            break;
        }
    }

    QualityGateMetrics {
        min_luminance: min_y,
        max_luminance: max_y,
        p005_luminance: p005,
        p995_luminance: p995,
        mean_luminance: mean,
        std_luminance: std,
        dynamic_range_span: (max_y - min_y).max(0.0),
        was_stretched: false,
    }
}

/// Enforces photographic quality invariants on an image in-place.
///
/// If the black point is lifted above `max_acceptable_black_floor` (such as flat gray veils
/// from unanchored Reinhard curves), this function smoothly anchors shadows to Zone 0
/// and expands highlights to Zone IX, guaranteeing rich contrast and deep blacks.
pub fn enforce_photographic_quality_invariants(
    img: &mut Rgb32FImage,
    options: &QualityGateOptions,
) -> QualityGateMetrics {
    let mut metrics = measure_photographic_histogram(img);

    // Check if black point is unacceptably lifted or contrast is critically flat
    let needs_black_anchor = metrics.p005_luminance > options.max_acceptable_black_floor;
    let needs_contrast_expansion = metrics.std_luminance < options.min_acceptable_contrast_std;

    if options.enforce_histogram_stretch && (needs_black_anchor || needs_contrast_expansion) {
        let p_low = metrics.p005_luminance;
        let p_high = metrics.p995_luminance.max(p_low + 0.10);
        let range = (p_high - p_low).max(0.01);

        let target_low = options.target_min_black;
        let target_high = options.target_white_ceiling;

        // Process in parallel with Rayon
        img.par_chunks_mut(3).for_each(|pixel_slice| {
            let r = pixel_slice[0].clamp(0.0, 1.0);
            let g = pixel_slice[1].clamp(0.0, 1.0);
            let b = pixel_slice[2].clamp(0.0, 1.0);

            let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

            // Normalized luminance in [p_low, p_high]
            let norm_y = ((y - p_low) / range).clamp(0.0, 1.0);

            // Toe-preserving photographic curve:
            // Pins Ansel Adams Zone 0 black floor without crushing lower midtones and shadows
            let s_curve_y = if norm_y < 0.12 {
                // Soft quadratic toe near deep sensor black
                norm_y * (0.80 + norm_y * 1.66)
            } else {
                // Linear preservation for open textured shadows, midtones, and highlights
                norm_y
            };

            // Remap to target Ansel Adams zones
            let new_y = target_low + s_curve_y * (target_high - target_low);

            // Preserve chromaticity: scale channels proportionally
            let scale = if y > 1e-5 {
                (new_y / y).clamp(0.10, 3.0)
            } else {
                1.0
            };

            pixel_slice[0] = (r * scale).clamp(0.0, 1.0);
            pixel_slice[1] = (g * scale).clamp(0.0, 1.0);
            pixel_slice[2] = (b * scale).clamp(0.0, 1.0);
        });

        metrics = measure_photographic_histogram(img);
        metrics.was_stretched = true;
    }

    metrics
}

/// Validates that panoramic geometry does not invert horizontal sweeps into vertical columns
pub fn validate_panorama_geometry(
    width: u32,
    height: u32,
    camera_yaw_span_deg: Option<f32>,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("Panorama dimensions are zero".to_string());
    }

    if let Some(yaw_span) = camera_yaw_span_deg {
        // If camera yaw progressed horizontally by >= 30 degrees, aspect ratio must be wider than tall
        if yaw_span.abs() >= 30.0 && height > width {
            return Err(format!(
                "Geometric anomaly detected: Camera yaw traversed {:.1}° horizontally, but stitched aspect ratio collapsed to vertical ({}:{})",
                yaw_span, width, height
            ));
        }
    }

    Ok(())
}
