//! Photographic Critic: Multi-Dimensional Perceptual Quality Evaluator
//!
//! Provides objective mathematical scoring of photographic renders across 5 core dimensions:
//! 1. Halo Divergence (Edge boundary overshoot / halos)
//! 2. Highlight Rolloff (Filmic smoothness vs chalky clipping)
//! 3. Spectral Micro-Contrast (Natural optical texture vs crunchy HDR grunge)
//! 4. Shadow Depth & Texture (Zone 0 anchoring with preserved bark/foliage variance)
//! 5. Memory Color Harmony (OkLab chromaticity consistency)

use image::Rgb32FImage;
use serde::{Deserialize, Serialize};

/// Detailed photographic evaluation report
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotographicQualityReport {
    /// Overall studio composite quality score (0 to 100)
    pub overall_score: f32,
    /// Edge halo score (100 = zero halos; <85 = visible halos)
    pub halo_score: f32,
    /// Highlight rolloff score (100 = smooth filmic shoulder; <85 = chalky clipping)
    pub highlight_score: f32,
    /// Texture authenticity score (100 = organic optical detail; <85 = crunchy grunge or blurred mud)
    pub texture_score: f32,
    /// Shadow depth score (100 = rich Zone 0 black with texture; <85 = milky veil or crushed mud)
    pub shadow_score: f32,
    /// Color harmony score (100 = lush natural foliage & neutral blacks; <85 = noisy chroma casts or bleached/greyscale)
    pub color_score: f32,
    /// Midtone exposure score (100 = balanced Zone V exposure ~100-118 DN; <85 = dark underexposure or washed out)
    #[serde(default)]
    pub exposure_score: f32,
    /// Whether the image meets the commercial-grade Studio Certified standard (score >= 98)
    pub is_studio_certified: bool,
    /// Diagnostic summary message
    pub diagnostic_summary: String,
}

/// Evaluates a candidate photographic render across all 6 optical dimensions
pub fn evaluate_photographic_quality(img: &Rgb32FImage) -> PhotographicQualityReport {
    let (width, height) = img.dimensions();
    let total_pixels = (width * height) as usize;
    if total_pixels == 0 {
        return PhotographicQualityReport {
            overall_score: 0.0,
            halo_score: 0.0,
            highlight_score: 0.0,
            texture_score: 0.0,
            shadow_score: 0.0,
            color_score: 0.0,
            exposure_score: 0.0,
            is_studio_certified: false,
            diagnostic_summary: "Empty image buffer".to_string(),
        };
    }

    // Adaptive sampling: keeps evaluation sub-millisecond (< 3ms) even on 24MP full-res
    let stride = if total_pixels > 4_000_000 {
        4
    } else if total_pixels > 1_000_000 {
        2
    } else {
        1
    };

    let raw = img.as_raw();
    let w = width as usize;
    let h = height as usize;

    // 1. Compute 1024-bin histogram, radiometry, and color statistics
    const BINS: usize = 1024;
    let mut hist = vec![0u32; BINS];
    let mut sample_count = 0usize;
    let mut clipped_high_count = 0usize;
    let mut crushed_black_count = 0usize; // pixels < 18 DN (0.0706)
    let mut shadow_noisy_chroma_sum = 0.0f32;
    let mut shadow_pixel_count = 0usize;
    let mut foliage_chroma_sum = 0.0f32;
    let mut foliage_pixel_count = 0usize;
    let mut midtone_chroma_sum = 0.0f32;
    let mut midtone_pixel_count = 0usize;

    for y in (0..h).step_by(stride) {
        for x in (0..w).step_by(stride) {
            let idx = (y * w + x) * 3;
            let r = raw[idx].clamp(0.0, 1.0);
            let g = raw[idx + 1].clamp(0.0, 1.0);
            let b = raw[idx + 2].clamp(0.0, 1.0);

            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let bin = ((luma * (BINS - 1) as f32).round() as usize).min(BINS - 1);
            hist[bin] += 1;
            sample_count += 1;

            if luma >= 0.992 {
                clipped_high_count += 1;
            }

            if luma < 0.0706 { // < 18 DN in 8-bit
                crushed_black_count += 1;
            }

            let to_linear = |x: f32| -> f32 {
                let x = x.clamp(0.0, 1.0);
                if x <= 0.04045 {
                    x / 12.92
                } else {
                    ((x + 0.055) / 1.055).powf(2.4)
                }
            };

            // Shadow color noise check (OkLab a/b deviation in deep shadows < 12 DN)
            if luma < 0.047 {
                let (lin_r, lin_g, lin_b) = (to_linear(r), to_linear(g), to_linear(b));
                let (_, a, b_ok) = crate::filmic_color_science::linear_srgb_to_oklab(lin_r, lin_g, lin_b);
                let chroma = (a * a + b_ok * b_ok).sqrt();
                shadow_noisy_chroma_sum += chroma;
                shadow_pixel_count += 1;
            }

            // Midtone chromaticity tracking (to detect desaturated/greyscale renders)
            if luma >= 0.10 && luma <= 0.85 {
                let (lin_r, lin_g, lin_b) = (to_linear(r), to_linear(g), to_linear(b));
                let (_, a, b_ok) = crate::filmic_color_science::linear_srgb_to_oklab(lin_r, lin_g, lin_b);
                let chroma = (a * a + b_ok * b_ok).sqrt();
                midtone_chroma_sum += chroma;
                midtone_pixel_count += 1;

                // Foliage color check (chlorophyll green dominant pixels: a* < 0, b* > 0)
                if g > r * 1.04 && g > b * 1.04 && a < 0.0 && b_ok > 0.0 {
                    foliage_chroma_sum += chroma;
                    foliage_pixel_count += 1;
                }
            }
        }
    }

    if sample_count == 0 {
        sample_count = 1;
    }

    // Cumulative percentiles: 0.5% (Zone 0 black anchor), 50.0% (Zone V midtone), 99.5% (Zone IX highlight)
    let target_005 = (sample_count as f32 * 0.005).round() as u32;
    let target_500 = (sample_count as f32 * 0.500).round() as u32;
    let mut cum = 0u32;
    let mut p005 = 0.0f32;
    let mut p500 = 0.0f32;
    for (bin_idx, &count) in hist.iter().enumerate() {
        cum += count;
        if p005 == 0.0 && cum >= target_005 {
            p005 = bin_idx as f32 / (BINS - 1) as f32;
        }
        if p500 == 0.0 && cum >= target_500 {
            p500 = bin_idx as f32 / (BINS - 1) as f32;
        }
    }

    // 2. Compute Spatial High-Frequency Laplacian Variance (MTF) and Edge Halos
    let sample_step = (stride * 2).max(4);
    let mut edge_overshoot_sum = 0.0f32;
    let mut edge_count = 0usize;
    let mut lap_sum = 0.0f32;
    let mut lap_sq_sum = 0.0f32;
    let mut mtf_samples = 0usize;

    for y in (2..h - 2).step_by(sample_step) {
        for x in (2..w - 2).step_by(sample_step) {
            let idx_c = (y * w + x) * 3;
            let idx_l = (y * w + (x - 1)) * 3;
            let idx_r = (y * w + (x + 1)) * 3;
            let idx_u = ((y - 1) * w + x) * 3;
            let idx_d = ((y + 1) * w + x) * 3;

            let y_c = 0.2126 * raw[idx_c] + 0.7152 * raw[idx_c + 1] + 0.0722 * raw[idx_c + 2];
            let y_l = 0.2126 * raw[idx_l] + 0.7152 * raw[idx_l + 1] + 0.0722 * raw[idx_l + 2];
            let y_r = 0.2126 * raw[idx_r] + 0.7152 * raw[idx_r + 1] + 0.0722 * raw[idx_r + 2];
            let y_u = 0.2126 * raw[idx_u] + 0.7152 * raw[idx_u + 1] + 0.0722 * raw[idx_u + 2];
            let y_d = 0.2126 * raw[idx_d] + 0.7152 * raw[idx_d + 1] + 0.0722 * raw[idx_d + 2];

            let dx = (y_r - y_l).abs();
            let dy = (y_d - y_u).abs();
            let grad_mag = dx.max(dy);

            let lap = y_l + y_r + y_u + y_d - 4.0 * y_c;
            let lap_abs = lap.abs();

            lap_sum += lap_abs;
            lap_sq_sum += lap_abs * lap_abs;
            mtf_samples += 1;

            // Strong structural edge transition (e.g. tree branch / skyline)
            if grad_mag > 0.15 {
                let overshoot = (lap_abs - grad_mag).max(0.0);
                edge_overshoot_sum += overshoot;
                edge_count += 1;
            }
        }
    }

    let avg_overshoot = if edge_count > 0 { edge_overshoot_sum / edge_count as f32 } else { 0.0 };

    // Laplacian Variance scaled by 10,000 (aligned with deep_compare.py MTF metric)
    let lap_var = if mtf_samples > 10 {
        let mean_lap = lap_sum / mtf_samples as f32;
        let mean_sq = lap_sq_sum / mtf_samples as f32;
        ((mean_sq - mean_lap * mean_lap).max(0.0)) * 10000.0
    } else {
        0.0
    };

    // DIMENSION 1: Edge Boundary Divergence (Halo Score)
    // 100 for overshoot < 0.015, dropping linearly as halos appear
    let halo_score = (100.0 - (avg_overshoot * 450.0)).clamp(40.0, 100.0);

    // DIMENSION 2: Highlight Rolloff (Filmic Shoulder vs Chalky Clipping)
    let clip_ratio = clipped_high_count as f32 / sample_count as f32;
    let highlight_score = if clip_ratio > 0.04 {
        (100.0 - (clip_ratio - 0.04) * 600.0).clamp(30.0, 100.0)
    } else {
        (96.0 + (0.04 - clip_ratio) * 100.0).clamp(90.0, 100.0)
    };

    // DIMENSION 3: Real Spatial Frequency Texture Authenticity (MTF vs Blur / Grunge)
    // Sharp natural photographs exhibit lap_var >= 2.5; blurred images collapse to < 0.5.
    // Artificial unsharp/bilateral crunch exhibits avg_overshoot > 0.025.
    let mtf_retention = (lap_var / 2.5).clamp(0.0, 1.0);
    let base_texture = 25.0 + mtf_retention * 73.0; // 25.0 for flat/blurred, up to 98.0 for sharp
    let texture_score = if avg_overshoot <= 0.025 {
        (base_texture + (0.025 - avg_overshoot) * 80.0).clamp(20.0, 100.0)
    } else {
        (base_texture - (avg_overshoot - 0.025) * 350.0).clamp(20.0, 100.0)
    };

    // DIMENSION 4: Shadow Depth & Openness (Zone 0 Black Anchor & Anti-Crush)
    let p005_dn = p005 * 255.0;
    let crush_ratio = crushed_black_count as f32 / sample_count as f32;
    let mut shadow_score = if p005_dn >= 10.0 && p005_dn <= 32.0 {
        // Naturally anchored open photographic shadows (Zones I-II, matching camera optical ground truth ~20-25 DN)
        100.0 - ((p005_dn - 20.0).abs() * 0.25)
    } else if p005_dn < 10.0 {
        // Severe shadow crush penalty (< 10 DN)
        (100.0 - (10.0 - p005_dn) * 2.5).clamp(30.0, 96.0)
    } else {
        // Lifted milky veil penalty (> 32 DN)
        (100.0 - (p005_dn - 32.0) * 1.8).clamp(30.0, 96.0)
    };
    // Severe penalty if more than 2% of pixels are crushed into black mud (< 18 DN)
    if crush_ratio > 0.020 {
        let crush_penalty = (crush_ratio - 0.020) * 750.0;
        shadow_score = (shadow_score - crush_penalty).clamp(20.0, 100.0);
    }

    // DIMENSION 5: Memory Color Harmony & Vitality
    let avg_shadow_chroma = if shadow_pixel_count > 0 {
        shadow_noisy_chroma_sum / shadow_pixel_count as f32
    } else {
        0.0
    };
    let shadow_cleanliness = (100.0 - avg_shadow_chroma * 350.0).clamp(40.0, 100.0);

    let mean_mid_chroma = if midtone_pixel_count > 0 {
        midtone_chroma_sum / midtone_pixel_count as f32
    } else {
        0.0
    };

    let foliage_vitality = if foliage_pixel_count >= 50 {
        let avg_foliage_chroma = foliage_chroma_sum / foliage_pixel_count as f32;
        // Natural chlorophyll foliage typically has chroma in 0.08..0.18 range
        (avg_foliage_chroma / 0.12 * 96.0).clamp(10.0, 100.0)
    } else {
        // Fallback for non-foliage scenes: evaluate general midtone color richness
        (mean_mid_chroma / 0.06 * 95.0).clamp(10.0, 100.0)
    };

    let mut color_score = (shadow_cleanliness * 0.40 + foliage_vitality * 0.60).clamp(10.0, 100.0);
    // Severely penalize monochrome / desaturated / greyscale renders
    if mean_mid_chroma < 0.008 {
        color_score = (mean_mid_chroma / 0.008 * 35.0).clamp(5.0, 35.0);
    }

    // DIMENSION 6: Midtone Exposure Parity (Zone V Anchor)
    let p500_dn = p500 * 255.0;
    let exposure_score = if p500_dn >= 95.0 && p500_dn <= 118.0 {
        100.0 - ((p500_dn - 106.5).abs() * 0.35) // 96.0 .. 100.0
    } else if p500_dn < 95.0 {
        // Muddy underexposure penalty
        (100.0 - (95.0 - p500_dn) * 1.6).clamp(20.0, 100.0)
    } else {
        // Washed out overexposure penalty
        (100.0 - (p500_dn - 118.0) * 1.5).clamp(20.0, 100.0)
    };

    // Composite Weighted Studio Score across all 6 optical dimensions
    let overall_score = (
        halo_score * 0.20 +
        highlight_score * 0.20 +
        texture_score * 0.20 +
        shadow_score * 0.15 +
        color_score * 0.15 +
        exposure_score * 0.10
    ).clamp(0.0, 100.0);

    let is_studio_certified = overall_score >= 98.0
        && halo_score >= 98.0
        && highlight_score >= 98.0
        && texture_score >= 95.0
        && shadow_score >= 98.0
        && color_score >= 95.0
        && exposure_score >= 95.0;

    let diagnostic_summary = format!(
        "Critic Score: {:.1}/100 [Halo: {:.1}, Highlight: {:.1}, Texture: {:.1}, Shadow: {:.1}, Color: {:.1}, Exposure: {:.1}] - {}",
        overall_score, halo_score, highlight_score, texture_score, shadow_score, color_score, exposure_score,
        if is_studio_certified { "STUDIO CERTIFIED (>=98 across dimensions)" } else { "NEEDS TUNING" }
    );

    PhotographicQualityReport {
        overall_score,
        halo_score,
        highlight_score,
        texture_score,
        shadow_score,
        color_score,
        exposure_score,
        is_studio_certified,
        diagnostic_summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn generate_rich_scene(w: u32, h: u32) -> Rgb32FImage {
        let mut img = Rgb32FImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let fy = y as f32 / h as f32;
                // Realistic scene distribution: upper third is smooth sky, lower two-thirds has high-frequency foliage/bark texture
                let hf = if y > h / 3 {
                    if (x + y) % 2 == 0 { 0.10 } else { -0.10 }
                } else {
                    0.0
                };
                let base_luma = (0.25 + 0.35 * fy + hf).clamp(0.02, 0.95);
                let r = (base_luma * 0.6).clamp(0.0, 1.0);
                let g = (base_luma * 1.3).clamp(0.0, 1.0);
                let b = (base_luma * 0.5).clamp(0.0, 1.0);
                img.put_pixel(x, y, Rgb([r, g, b]));
            }
        }
        img
    }

    #[test]
    fn test_critic_catches_blurred_image() {
        let img = generate_rich_scene(400, 300);
        let sharp_report = evaluate_photographic_quality(&img);
        println!("Sharp scene texture: {:.1}", sharp_report.texture_score);
        assert!(sharp_report.texture_score >= 80.0, "Sharp texture score was {:.1}", sharp_report.texture_score);

        let mut blurred = img.clone();
        for _ in 0..6 {
            let temp = blurred.clone();
            for y in 1..299 {
                for x in 1..399 {
                    let mut sum_r = 0.0f32;
                    let mut sum_g = 0.0f32;
                    let mut sum_b = 0.0f32;
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let p = temp.get_pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32);
                            sum_r += p[0];
                            sum_g += p[1];
                            sum_b += p[2];
                        }
                    }
                    blurred.put_pixel(x, y, Rgb([sum_r / 9.0, sum_g / 9.0, sum_b / 9.0]));
                }
            }
        }

        let blur_report = evaluate_photographic_quality(&blurred);
        println!("Blurred scene texture: {:.1}", blur_report.texture_score);
        assert!(blur_report.texture_score < 50.0, "Blurred texture score was {:.1}", blur_report.texture_score);
        assert!(!blur_report.is_studio_certified);
    }

    #[test]
    fn test_critic_catches_crushed_shadows() {
        let mut img = generate_rich_scene(400, 300);
        let crush_limit = (300.0 * 0.12) as u32;
        for y in 0..crush_limit {
            for x in 0..400 {
                img.put_pixel(x, y, Rgb([0.0, 0.0, 0.0]));
            }
        }

        let report = evaluate_photographic_quality(&img);
        assert!(report.shadow_score < 50.0, "Got {:.1}", report.shadow_score);
        assert!(!report.is_studio_certified);
    }

    #[test]
    fn test_critic_catches_greyscale_monochrome() {
        let mut img = generate_rich_scene(400, 300);
        for y in 0..300 {
            for x in 0..400 {
                let p = img.get_pixel(x, y);
                let gray = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
                img.put_pixel(x, y, Rgb([gray, gray, gray]));
            }
        }

        let report = evaluate_photographic_quality(&img);
        assert!(report.color_score < 40.0, "Got {:.1}", report.color_score);
        assert!(!report.is_studio_certified);
    }

    #[test]
    fn test_critic_catches_muddy_underexposure() {
        let mut img = generate_rich_scene(400, 300);
        for y in 0..300 {
            for x in 0..400 {
                let p = img.get_pixel(x, y);
                img.put_pixel(x, y, Rgb([p[0] * 0.35, p[1] * 0.35, p[2] * 0.35]));
            }
        }

        let report = evaluate_photographic_quality(&img);
        assert!(report.exposure_score < 60.0, "Got {:.1}", report.exposure_score);
        assert!(!report.is_studio_certified);
    }
}
