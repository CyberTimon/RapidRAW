use image::DynamicImage;
use rayon::prelude::*;
use serde_json::Value;
use std::borrow::Cow;
use std::cmp::Ordering;

use crate::image_processing::downscale_f32_image_if_needed;

pub const PARAM_KEYS: &[&str] = &[
    "negativeRedWeight",
    "negativeGreenWeight",
    "negativeBlueWeight",
    "negativeExposure",
    "negativeContrast",
];

const BOUNDS_REFERENCE_DIM: u32 = 1080;
const PIXEL_CHUNK: usize = 3 * 4096;

#[derive(Debug, Clone, Copy)]
struct NegativeConversionParams {
    red_weight: f32,
    green_weight: f32,
    blue_weight: f32,

    exposure: f32,
    contrast: f32,
}

impl NegativeConversionParams {
    fn from_adjustments(adjustments: &Value) -> Self {
        let get = |key: &str, default: f32| adjustments[key].as_f64().map_or(default, |v| v as f32);
        Self {
            red_weight: get("negativeRedWeight", 1.0),
            green_weight: get("negativeGreenWeight", 1.0),
            blue_weight: get("negativeBlueWeight", 1.0),
            exposure: get("negativeExposure", 0.0),
            contrast: get("negativeContrast", 1.0),
        }
    }
}

pub fn is_enabled(adjustments: &Value) -> bool {
    crate::image_processing::is_effect_enabled(
        adjustments,
        "negativeConversion",
        "negativeConversionEnabled",
    )
}

pub fn effective_is_raw(is_raw: bool, adjustments: &Value) -> bool {
    is_raw && !is_enabled(adjustments)
}

pub fn apply_negative_conversion<'a>(
    image: Cow<'a, DynamicImage>,
    adjustments: &Value,
) -> Cow<'a, DynamicImage> {
    if !is_enabled(adjustments) {
        return image;
    }
    let params = NegativeConversionParams::from_adjustments(adjustments);
    Cow::Owned(convert(image.into_owned(), &params))
}

#[derive(Debug, Clone, Copy)]
struct ChannelBounds {
    min: f32,
    max: f32,
}

fn analyze_bounds(log_data: &[f32], width: usize, height: usize) -> [ChannelBounds; 3] {
    let margin_x = (width as f32 * 0.12) as usize;
    let margin_y = (height as f32 * 0.12) as usize;

    let est_pixels = (width.saturating_sub(margin_x * 2)) * (height.saturating_sub(margin_y * 2));
    let step = (est_pixels / 40_000).max(1);

    let mut r_vals = Vec::with_capacity(est_pixels / step);
    let mut g_vals = Vec::with_capacity(est_pixels / step);
    let mut b_vals = Vec::with_capacity(est_pixels / step);

    for y in (margin_y..(height - margin_y)).step_by(3) {
        let row_offset = y * width * 3;

        for x in (margin_x..(width - margin_x)).step_by(step) {
            let idx = row_offset + (x * 3);

            if idx + 2 < log_data.len() {
                let r = log_data[idx];
                let g = log_data[idx + 1];
                let b = log_data[idx + 2];

                if r.is_finite() {
                    r_vals.push(r);
                }
                if g.is_finite() {
                    g_vals.push(g);
                }
                if b.is_finite() {
                    b_vals.push(b);
                }
            }
        }
    }

    let get_bounds = |mut vals: Vec<f32>| -> ChannelBounds {
        if vals.is_empty() {
            return ChannelBounds { min: 0.0, max: 1.0 };
        }

        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

        let len = vals.len() as f32;

        let min_idx = (len * 0.001) as usize;
        let max_idx = (len * 0.999) as usize;

        let min = vals[min_idx.min(vals.len().saturating_sub(1))];
        let max = vals[max_idx.min(vals.len().saturating_sub(1))];

        let safe_max = if max <= min + 0.0001 { min + 1.0 } else { max };

        ChannelBounds { min, max: safe_max }
    };

    [get_bounds(r_vals), get_bounds(g_vals), get_bounds(b_vals)]
}

fn density(v: f32) -> f32 {
    -v.clamp(1e-6, 1.0).log10()
}

fn channel_bounds(image: &DynamicImage) -> [ChannelBounds; 3] {
    let downscaled =
        downscale_f32_image_if_needed(image, BOUNDS_REFERENCE_DIM, BOUNDS_REFERENCE_DIM);
    let reference = downscaled.as_ref().unwrap_or(image);
    let converted;
    let rgb = match reference.as_rgb32f() {
        Some(buf) => buf,
        None => {
            converted = reference.to_rgb32f();
            &converted
        }
    };
    let (width, height) = rgb.dimensions();
    let log_pixels: Vec<f32> = rgb.as_raw().par_iter().map(|&v| density(v)).collect();
    analyze_bounds(&log_pixels, width as usize, height as usize)
}

fn convert(input: DynamicImage, params: &NegativeConversionParams) -> DynamicImage {
    let bounds = channel_bounds(&input);
    let mut rgb = input.into_rgb32f();

    let k = 4.0 * params.contrast.max(0.1);
    let x0 = 0.6 - (params.exposure * 0.25);
    let gamma_inv = 1.0 / 2.2;

    let y0 = 1.0 / (1.0 + (k * x0).exp());
    let y1 = 1.0 / (1.0 + (-k * (1.0 - x0)).exp());
    let scale = 1.0 / (y1 - y0);

    let apply_curve = |x: f32| -> f32 {
        let sigmoid = 1.0 / (1.0 + (-k * (x - x0)).exp());
        let s_norm = (sigmoid - y0) * scale;
        s_norm.clamp(0.0, 1.0)
    };
    let weights = [params.red_weight, params.green_weight, params.blue_weight];

    rgb.par_chunks_mut(PIXEL_CHUNK).for_each(|chunk| {
        for px in chunk.as_chunks_mut::<3>().0 {
            let [mut r, mut g, mut b] = [0, 1, 2].map(|c| {
                let n = (density(px[c]) - bounds[c].min) / (bounds[c].max - bounds[c].min);
                apply_curve(n.max(0.0) * weights[c])
            });

            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let max_ch = r.max(g).max(b);

            if max_ch > 0.9 {
                let overflow = ((max_ch - 0.9) * 10.0).clamp(0.0, 1.0);
                let sat_reduction = overflow * overflow;

                r = r + (luma - r) * sat_reduction;
                g = g + (luma - g) * sat_reduction;
                b = b + (luma - b) * sat_reduction;
            }

            px[0] = r.clamp(0.0, 1.0).powf(gamma_inv);
            px[1] = g.clamp(0.0, 1.0).powf(gamma_inv);
            px[2] = b.clamp(0.0, 1.0).powf(gamma_inv);
        }
    });

    DynamicImage::ImageRgb32F(rgb)
}
