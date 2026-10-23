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
    "negativeAnalysisRegion",
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
    region: Option<[f32; 4]>,
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
            region: adjustments
                .get("negativeAnalysisRegion")
                .and_then(|region| {
                    let values = ["x", "y", "width", "height"]
                        .map(|key| region[key].as_f64().unwrap_or(f64::NAN) as f32);
                    (values.iter().all(|v| v.is_finite()) && values[2] > 0.0 && values[3] > 0.0)
                        .then_some(values)
                }),
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

fn analyze_bounds(
    log_data: &[f32],
    width: usize,
    height: usize,
    region: Option<[f32; 4]>,
) -> [ChannelBounds; 3] {
    let margin_x = (width as f32 * 0.12) as usize;
    let margin_y = (height as f32 * 0.12) as usize;

    let default = (margin_x, margin_y, width - margin_x, height - margin_y);
    let (left, top, right, bottom) = region
        .map(|[x, y, w, h]| {
            (
                (x.clamp(0.0, 1.0) * width as f32).floor() as usize,
                (y.clamp(0.0, 1.0) * height as f32).floor() as usize,
                ((x + w).clamp(0.0, 1.0) * width as f32).ceil() as usize,
                ((y + h).clamp(0.0, 1.0) * height as f32).ceil() as usize,
            )
        })
        .filter(|&(l, t, r, b)| r > l && b > t)
        .unwrap_or(default);
    let est_pixels = (right - left) * (bottom - top);
    let step = (est_pixels / 40_000).max(1);

    let mut r_vals = Vec::with_capacity(est_pixels / step);
    let mut g_vals = Vec::with_capacity(est_pixels / step);
    let mut b_vals = Vec::with_capacity(est_pixels / step);

    for y in (top..bottom).step_by(3) {
        let row_offset = y * width * 3;

        for x in (left..right).step_by(step) {
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

fn channel_bounds(image: &DynamicImage, region: Option<[f32; 4]>) -> [ChannelBounds; 3] {
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
    analyze_bounds(&log_pixels, width as usize, height as usize, region)
}

fn convert(input: DynamicImage, params: &NegativeConversionParams) -> DynamicImage {
    let bounds = channel_bounds(&input, params.region);
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

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, Rgb32FImage};
    use serde_json::json;

    fn bordered_negative(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb32F(Rgb32FImage::from_fn(width, height, |x, _| {
            let value = if x < width / 4 || x >= width * 3 / 4 {
                0.001
            } else {
                0.2 + 0.6 * (x - width / 4) as f32 / (width / 2 - 1) as f32
            };
            Rgb([value; 3])
        }))
    }

    #[test]
    fn selected_region_excludes_distracting_borders_without_cropping_output() {
        let image = bordered_negative(100, 60);
        let settings = json!({"negativeConversionEnabled": true,
            "negativeAnalysisRegion": {"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}});
        let selected = apply_negative_conversion(Cow::Borrowed(&image), &settings)
            .into_owned()
            .to_rgb32f();
        let default = apply_negative_conversion(
            Cow::Borrowed(&image),
            &json!({"negativeConversionEnabled": true}),
        )
        .into_owned()
        .to_rgb32f();
        assert_eq!(selected.dimensions(), (100, 60));
        assert!(selected.get_pixel(50, 30)[0] > default.get_pixel(50, 30)[0] + 0.2);
        assert!(selected.get_pixel(0, 30)[0] > 0.99);
    }
    #[test]
    fn explicit_default_preserves_existing_analysis_and_invalid_regions_fall_back_safely() {
        for width in [1, 2, 25, 75, 101, 129, 256] {
            let image = DynamicImage::ImageRgb32F(Rgb32FImage::from_fn(width, 11, |x, y| {
                Rgb([0.1 + ((x + y) % 9) as f32 * 0.08; 3])
            }));
            let baseline = apply_negative_conversion(
                Cow::Borrowed(&image),
                &json!({"negativeConversionEnabled": true}),
            )
            .into_owned()
            .to_rgb32f();
            for region in [
                json!({"x": 0.12, "y": 0.12, "width": 0.76, "height": 0.76}),
                json!({"x": 0.2, "y": 0.2, "width": 0, "height": 0}),
                json!({"x": 2, "y": 2, "width": 0.1, "height": 0.1}),
                json!({"x": null, "width": 1, "height": 1}),
            ] {
                let result = apply_negative_conversion(
                    Cow::Borrowed(&image),
                    &json!({"negativeConversionEnabled": true, "negativeAnalysisRegion": region}),
                )
                .into_owned()
                .to_rgb32f();
                assert_eq!(result.as_raw(), baseline.as_raw(), "width {width}");
                assert!(result.as_raw().iter().all(|v| v.is_finite()));
            }
        }
    }

    #[test]
    fn custom_region_uses_its_edges_without_another_inset_and_tiny_regions_stay_finite() {
        let image = DynamicImage::ImageRgb32F(Rgb32FImage::from_fn(200, 60, |x, _| {
            let density = match x {
                50..=54 => 0.0_f32,
                55..=144 => 0.5,
                145..=149 => 1.0,
                _ => 3.0,
            };
            Rgb([10.0_f32.powf(-density); 3])
        }));
        let selected = apply_negative_conversion(
            Cow::Borrowed(&image),
            &json!({"negativeConversionEnabled": true,
            "negativeAnalysisRegion": {"x": 0.25, "y": 0, "width": 0.5, "height": 1}}),
        )
        .into_owned()
        .to_rgb32f();
        // Worked result for density .5 with measured bounds [0, 1] and the existing default curve.
        assert!((selected.get_pixel(100, 30)[0] - 0.6774).abs() < 0.001);
        let tiny = apply_negative_conversion(
            Cow::Borrowed(&image),
            &json!({"negativeConversionEnabled": true,
            "negativeAnalysisRegion": {"x": 0.4, "y": 0.4, "width": 0.000001, "height": 0.000001}}),
        )
        .into_owned()
        .to_rgb32f();
        assert_eq!(tiny.dimensions(), (200, 60));
        assert!(
            tiny.as_raw()
                .iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
        );
    }

    #[test]
    fn proportional_batch_regions_analyze_each_source_independently() {
        let source = bordered_negative(100, 60).to_rgb32f();
        let larger = DynamicImage::ImageRgb32F(Rgb32FImage::from_fn(200, 120, |x, y| {
            let pixel = source.get_pixel(x / 2, y / 2);
            Rgb(pixel.0.map(|v| v * 0.5))
        }));
        let settings = json!({"negativeConversionEnabled": true, "negativeExposure": 0.3,
            "negativeAnalysisRegion": {"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}});
        let first =
            apply_negative_conversion(Cow::Owned(DynamicImage::ImageRgb32F(source)), &settings)
                .into_owned()
                .to_rgb32f();
        let second = apply_negative_conversion(Cow::Borrowed(&larger), &settings)
            .into_owned()
            .to_rgb32f();
        // Doubling dimensions preserves source proportions. Halving transmission adds a
        // density offset that each image's independent bounds must remove.
        assert!((first.get_pixel(50, 30)[0] - second.get_pixel(100, 60)[0]).abs() < 0.00001);
    }
}
