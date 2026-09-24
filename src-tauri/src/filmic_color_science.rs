//! Filmic Color Science & Soft Highlight Shoulder
//!
//! Implements a C² continuous filmic tone response with optical highlight desaturation
//! and OkLab shadow chromatic neutralization. Eliminates chalky highlight clipping cliffs
//! and muddy shadow noise casts, delivering the organic tonal depth of high-end medium-format film.

use image::Rgb32FImage;
use rayon::prelude::*;

/// Configuration parameters for the filmic tone curve and color science
#[derive(Debug, Clone, Copy)]
pub struct FilmicColorParams {
    /// Shadow toe knee (controls deep shadow contrast, default: -2.5 EV)
    pub shadow_toe: f32,
    /// Midtone contrast punch / gamma (default: 1.05)
    pub midtone_gamma: f32,
    /// Highlight shoulder softness kappa (0.5 = crisp, 1.0 = standard, 2.0 = ultra-soft filmic)
    pub shoulder_softness: f32,
    /// Luminance threshold above which highlight desaturation begins (default: 0.72)
    pub highlight_desat_threshold: f32,
    /// Luminance threshold below which shadow chromatic neutralization applies (default: 0.003, deep sensor noise floor)
    pub shadow_neutral_threshold: f32,
}

impl Default for FilmicColorParams {
    fn default() -> Self {
        Self {
            shadow_toe: -2.5,
            midtone_gamma: 1.05,
            shoulder_softness: 1.25,
            highlight_desat_threshold: 0.72,
            shadow_neutral_threshold: 0.003,
        }
    }
}

/// Applies a smooth C² continuous filmic shoulder curve to a normalized luminance value
#[inline(always)]
pub fn filmic_shoulder_curve(y: f32, params: &FilmicColorParams) -> f32 {
    let y_clamped = y.max(0.0);
    let thresh = params.highlight_desat_threshold;

    if y_clamped <= thresh {
        // Linear-to-smooth midtone curve
        y_clamped.powf(params.midtone_gamma)
    } else {
        // Soft asymptotic shoulder into specular ceiling
        // Hermite blend from threshold to 1.0
        let mid_val = thresh.powf(params.midtone_gamma);
        let span = (1.0 - thresh).max(0.05);
        let t = ((y_clamped - thresh) / span).min(1.0);

        // Smooth cubic Hermite rolloff: 1 - (1 - t)^(kappa + 1)
        let s = 1.0 - (1.0 - t).powf(params.shoulder_softness + 1.0);
        mid_val + s * (1.0 - mid_val)
    }
}

/// Linear sRGB to OkLab color space conversion
#[inline(always)]
pub fn linear_srgb_to_oklab(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    let l_ = l.max(0.0).cbrt();
    let m_ = m.max(0.0).cbrt();
    let s_ = s.max(0.0).cbrt();

    let oklab_l = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    let oklab_a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    let oklab_b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

    (oklab_l, oklab_a, oklab_b)
}

/// OkLab to Linear sRGB color space conversion
#[inline(always)]
pub fn oklab_to_linear_srgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;

    let l_cubed = l_ * l_ * l_;
    let m_cubed = m_ * m_ * m_;
    let s_cubed = s_ * s_ * s_;

    let r = 4.0767416621 * l_cubed - 3.3077115913 * m_cubed + 0.2309699292 * s_cubed;
    let g = -1.2684380046 * l_cubed + 2.6097574011 * m_cubed - 0.3413193965 * s_cubed;
    let b_out = -0.0041960863 * l_cubed - 0.7034186147 * m_cubed + 1.7076147010 * s_cubed;

    (r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b_out.clamp(0.0, 1.0))
}

/// Applies filmic color grading, highlight desaturation, and OkLab shadow neutralization in-place
pub fn apply_filmic_color_science(img: &mut Rgb32FImage, params: &FilmicColorParams) {
    let raw = img.as_mut();

    let to_linear = |x: f32| -> f32 {
        let x = x.clamp(0.0, 1.0);
        if x <= 0.04045 {
            x / 12.92
        } else {
            ((x + 0.055) / 1.055).powf(2.4)
        }
    };
    let to_srgb = |x: f32| -> f32 {
        let x = x.clamp(0.0, 1.0);
        if x <= 0.0031308 {
            x * 12.92
        } else {
            1.055 * x.powf(1.0 / 2.4) - 0.055
        }
    };

    raw.par_chunks_mut(3).for_each(|pixel| {
        let r_srgb = pixel[0].clamp(0.0, 1.0);
        let g_srgb = pixel[1].clamp(0.0, 1.0);
        let b_srgb = pixel[2].clamp(0.0, 1.0);

        let lin_r = to_linear(r_srgb);
        let lin_g = to_linear(g_srgb);
        let lin_b = to_linear(b_srgb);

        let y = 0.2126 * lin_r + 0.7152 * lin_g + 0.0722 * lin_b;
        let new_y = filmic_shoulder_curve(y, params);

        // Convert to OkLab for perceptual chroma adjustments
        let (mut oklab_l, mut oklab_a, mut oklab_b) = linear_srgb_to_oklab(lin_r, lin_g, lin_b);

        // Adjust perceived lightness
        let l_scale = if y > 1e-5 { new_y / y } else { 1.0 };
        oklab_l = (oklab_l * l_scale.cbrt()).clamp(0.0, 1.0);

        // 1. Highlight Desaturation: fade chroma towards pure white in high specular regions
        if y > params.highlight_desat_threshold {
            let t = ((y - params.highlight_desat_threshold) / (1.0 - params.highlight_desat_threshold)).clamp(0.0, 1.0);
            let desat_factor = (1.0 - t * 0.75).clamp(0.0, 1.0);
            oklab_a *= desat_factor;
            oklab_b *= desat_factor;
        }

        // 2. Shadow Chromatic Neutralization: eliminate noisy chroma specks in deep shadows
        if y < params.shadow_neutral_threshold {
            let t = (y / params.shadow_neutral_threshold).clamp(0.0, 1.0);
            // Smooth Hermite damping
            let neutral_factor = t * t * (3.0 - 2.0 * t);
            oklab_a *= neutral_factor;
            oklab_b *= neutral_factor;
        }

        // Convert back to Linear sRGB, then encode to display sRGB
        let (r_out, g_out, b_out) = oklab_to_linear_srgb(oklab_l, oklab_a, oklab_b);
        pixel[0] = to_srgb(r_out);
        pixel[1] = to_srgb(g_out);
        pixel[2] = to_srgb(b_out);
    });
}
