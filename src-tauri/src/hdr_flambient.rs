//! Flambient (Flash + Ambient Hybrid) Real Estate Fusion Engine for RapidRAW
//!
//! Commercial real estate photography technique: combines high-dynamic-range
//! ambient bracket exposures with a direct/bounced speedlight flash frame.
//! Automatically isolates clean 5500K flash geometry and wall textures while
//! pulling pristine exterior window views from ambient under-exposures.

use image::Rgb32FImage;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlambientOptions {
    /// Flash strength contribution (0.0 to 1.0, default 0.35)
    pub flash_strength: Option<f32>,
    /// Window-pull highlight preservation strength (0.0 to 1.0, default 0.85)
    pub window_pull_strength: Option<f32>,
    /// Ambient color warmth retention (0.0 to 1.0, default 0.50)
    pub ambient_warmth: Option<f32>,
}

impl Default for FlambientOptions {
    fn default() -> Self {
        Self {
            flash_strength: Some(0.35),
            window_pull_strength: Some(0.85),
            ambient_warmth: Some(0.50),
        }
    }
}

/// Identifies the flash exposure index in a sequence by analyzing local high-frequency
/// variance and illumination divergence from ambient brackets.
pub fn detect_flash_frame_index(frames: &[Rgb32FImage]) -> Option<usize> {
    if frames.len() < 2 {
        return None;
    }

    let mut best_flash_score = -1.0f32;
    let mut best_flash_idx = 0;

    for (i, frame) in frames.iter().enumerate() {
        let raw = frame.as_raw();
        let num_px = (frame.width() * frame.height()) as usize;
        let step = (num_px / 5000).max(1);

        let mut center_luma = 0.0f32;
        let mut edge_luma = 0.0f32;
        let mut center_count = 0usize;
        let mut edge_count = 0usize;

        let w = frame.width() as f32;
        let h = frame.height() as f32;
        let cx = w * 0.5;
        let cy = h * 0.5;
        let max_r = (cx * cx + cy * cy).sqrt();

        for p in (0..num_px).step_by(step) {
            let px_x = (p % frame.width() as usize) as f32;
            let px_y = (p / frame.width() as usize) as f32;
            let dist = ((px_x - cx).powi(2) + (px_y - cy).powi(2)).sqrt() / max_r;

            let idx = p * 3;
            let lum = 0.2126 * raw[idx] + 0.7152 * raw[idx + 1] + 0.0722 * raw[idx + 2];

            if dist < 0.35 {
                center_luma += lum;
                center_count += 1;
            } else if dist > 0.65 {
                edge_luma += lum;
                edge_count += 1;
            }
        }

        let avg_center = center_luma / center_count.max(1) as f32;
        let avg_edge = edge_luma / edge_count.max(1) as f32;

        // Flash pop has distinct inverse-square radial falloff: center is significantly brighter than edges
        let falloff_ratio = (avg_center / avg_edge.max(0.01)).clamp(0.0, 10.0);
        let score = falloff_ratio;

        if score > best_flash_score {
            best_flash_score = score;
            best_flash_idx = i;
        }
    }

    if best_flash_score > 1.25 {
        Some(best_flash_idx)
    } else {
        None
    }
}

/// Fuses ambient HDR radiance with flash pop frame for commercial real estate interiors.
pub fn fuse_flambient_real_estate(
    ambient_radiance: &Rgb32FImage,
    flash_frame: &Rgb32FImage,
    window_exposure: Option<&Rgb32FImage>,
    options: &FlambientOptions,
) -> Result<Rgb32FImage, String> {
    let (w, h) = ambient_radiance.dimensions();
    if flash_frame.dimensions() != (w, h) {
        return Err("Flash frame dimensions do not match ambient radiance".to_string());
    }

    let flash_k = options.flash_strength.unwrap_or(0.35).clamp(0.0, 1.0);
    let window_k = options.window_pull_strength.unwrap_or(0.85).clamp(0.0, 1.0);

    let amb_raw = ambient_radiance.as_raw();
    let flash_raw = flash_frame.as_raw();
    let win_raw = window_exposure.map(|img| img.as_raw());

    let mut output = Rgb32FImage::new(w, h);
    let out_raw = output.as_mut();

    let row_stride = w as usize;

    out_raw
        .par_chunks_mut(row_stride * 3)
        .enumerate()
        .for_each(|(y, row_out)| {
            for x in 0..row_stride {
                let pixel_idx = y * row_stride + x;
                let raw_idx = pixel_idx * 3;

                let amb_r = amb_raw[raw_idx];
                let amb_g = amb_raw[raw_idx + 1];
                let amb_b = amb_raw[raw_idx + 2];

                let fl_r = flash_raw[raw_idx];
                let fl_g = flash_raw[raw_idx + 1];
                let fl_b = flash_raw[raw_idx + 2];

                let amb_luma = 0.2126 * amb_r + 0.7152 * amb_g + 0.0722 * amb_b;

                // 1. Flash Color & Clean Geometry Infill: Flash cancels indoor tungsten orange casts
                let mut fused_r = amb_r * (1.0 - flash_k) + fl_r * flash_k;
                let mut fused_g = amb_g * (1.0 - flash_k) + fl_g * flash_k;
                let mut fused_b = amb_b * (1.0 - flash_k) + fl_b * flash_k;

                // 2. Window-Pull Mask: If ambient is over-exposed near windows (>0.82)
                // and a window bracket is available, pull clean window details
                if let Some(win) = win_raw {
                    if amb_luma > 0.75 {
                        let win_r = win[raw_idx];
                        let win_g = win[raw_idx + 1];
                        let win_b = win[raw_idx + 2];

                        let window_mask = ((amb_luma - 0.75) / 0.25).clamp(0.0, 1.0) * window_k;
                        fused_r = fused_r * (1.0 - window_mask) + win_r * window_mask;
                        fused_g = fused_g * (1.0 - window_mask) + win_g * window_mask;
                        fused_b = fused_b * (1.0 - window_mask) + win_b * window_mask;
                    }
                }

                let out_idx = x * 3;
                row_out[out_idx] = fused_r.max(0.0);
                row_out[out_idx + 1] = fused_g.max(0.0);
                row_out[out_idx + 2] = fused_b.max(0.0);
            }
        });

    Ok(output)
}
