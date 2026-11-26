use crate::masks::morphology::{apply_grow_and_feather, for_each_mask_row};
use image::{GenericImageView, GrayImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f32::consts::PI;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ParametricMaskParameters {
    target_x: f64,
    target_y: f64,
    #[serde(default = "default_tolerance")]
    tolerance: f32,
    #[serde(default)]
    grow: f32,
    #[serde(default)]
    feather: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default)]
    flip_horizontal: bool,
    #[serde(default)]
    flip_vertical: bool,
    #[serde(default)]
    orientation_steps: u8,
    #[serde(default)]
    reference: Option<[f32; 3]>,
}

fn default_tolerance() -> f32 {
    20.0
}

impl Default for ParametricMaskParameters {
    fn default() -> Self {
        Self {
            target_x: 0.0,
            target_y: 0.0,
            tolerance: default_tolerance(),
            grow: 0.0,
            feather: 35.0,
            rotation: 0.0,
            flip_horizontal: false,
            flip_vertical: false,
            orientation_steps: 0,
            reference: None,
        }
    }
}

fn color_tolerance_sq(tolerance: f32) -> f32 {
    (tolerance * 2.55).max(1.0).powi(2) * 3.0
}

fn luminance_tolerance(tolerance: f32) -> f32 {
    (tolerance * 2.55).max(1.0)
}

fn reference_pixel(
    params: &ParametricMaskParameters,
    warped: &image::DynamicImage,
) -> Option<[f32; 3]> {
    if params.reference.is_some() {
        return params.reference;
    }
    let (full_w, full_h) = warped.dimensions();
    let target_x = params.target_x.round() as i32;
    let target_y = params.target_y.round() as i32;
    if target_x < 0 || target_y < 0 || target_x >= full_w as i32 || target_y >= full_h as i32 {
        return None;
    }
    let pixel = warped.get_pixel(target_x as u32, target_y as u32);
    Some([pixel[0] as f32, pixel[1] as f32, pixel[2] as f32])
}

pub enum RangeReference {
    Color([f32; 3]),
    Target(f32, f32),
}

pub struct RangeMask {
    pub luminance: bool,
    pub reference: RangeReference,
    pub tolerance: f32,
    pub grow: f32,
    pub feather: f32,
}

pub fn range_mask(mask_type: &str, params_value: &Value) -> Option<RangeMask> {
    let luminance = match mask_type {
        "color" => false,
        "luminance" => true,
        _ => return None,
    };
    let params: ParametricMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let reference = match params.reference {
        Some(color) => RangeReference::Color(color),
        None if params.target_x.round() >= 0.0 && params.target_y.round() >= 0.0 => {
            RangeReference::Target(
                params.target_x.round() as f32,
                params.target_y.round() as f32,
            )
        }
        None => return None,
    };
    Some(RangeMask {
        luminance,
        reference,
        tolerance: if luminance {
            luminance_tolerance(params.tolerance)
        } else {
            color_tolerance_sq(params.tolerance)
        },
        grow: params.grow,
        feather: params.feather,
    })
}

pub fn generate_color_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&image::DynamicImage>,
) -> Option<GrayImage> {
    let params: ParametricMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let warped = warped_image?;
    let (full_w, full_h) = warped.dimensions();

    let [ref_r, ref_g, ref_b] = reference_pixel(&params, warped)?;

    let mut mask = GrayImage::new(width, height);

    let angle_rad = params.rotation * PI / 180.0;
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if params.orientation_steps % 2 == 1 {
        (full_h, full_w)
    } else {
        (full_w, full_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    let tolerance_sq = color_tolerance_sq(params.tolerance);
    let inv_scale = 1.0 / scale;

    for_each_mask_row(&mut mask, |y_out, row| {
        let y_uncrop = y_out as f32 + crop_offset.1;
        let y_centered = y_uncrop - center_y;
        let y_sin = y_centered * sin_a;
        let y_cos = y_centered * cos_a;

        for (x_out, value) in row.iter_mut().enumerate() {
            let x_uncrop = x_out as f32 + crop_offset.0;
            let x_centered = x_uncrop - center_x;

            let x_unrotated = x_centered * cos_a + y_sin + center_x;
            let y_unrotated = -x_centered * sin_a + y_cos + center_y;

            let x_unflipped = if params.flip_horizontal {
                scaled_coarse_rotated_w - x_unrotated
            } else {
                x_unrotated
            };
            let y_unflipped = if params.flip_vertical {
                scaled_coarse_rotated_h - y_unrotated
            } else {
                y_unrotated
            };

            let (x_unrotated_coarse, y_unrotated_coarse) = match params.orientation_steps {
                0 => (x_unflipped, y_unflipped),
                1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
                2 => (
                    scaled_coarse_rotated_w - x_unflipped,
                    scaled_coarse_rotated_h - y_unflipped,
                ),
                3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
                _ => (x_unflipped, y_unflipped),
            };

            if x_unrotated_coarse >= 0.0 && y_unrotated_coarse >= 0.0 {
                let x_src = (x_unrotated_coarse * inv_scale) as u32;
                let y_src = (y_unrotated_coarse * inv_scale) as u32;

                if x_src < full_w && y_src < full_h {
                    let pixel = warped.get_pixel(x_src, y_src);
                    let dist_sq = (pixel[0] as f32 - ref_r).powi(2)
                        + (pixel[1] as f32 - ref_g).powi(2)
                        + (pixel[2] as f32 - ref_b).powi(2);

                    if dist_sq <= tolerance_sq {
                        let intensity = 1.0 - (dist_sq.sqrt() / tolerance_sq.sqrt());
                        *value = (intensity * 255.0) as u8;
                    }
                }
            }
        }
    });

    apply_grow_and_feather(&mut mask, params.grow, params.feather, width, height);
    Some(mask)
}

pub fn generate_luminance_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&image::DynamicImage>,
) -> Option<GrayImage> {
    let params: ParametricMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let warped = warped_image?;
    let (full_w, full_h) = warped.dimensions();

    let ref_pixel = reference_pixel(&params, warped)?;
    let ref_luma = 0.299 * ref_pixel[0] + 0.587 * ref_pixel[1] + 0.114 * ref_pixel[2];

    let mut mask = GrayImage::new(width, height);

    let angle_rad = params.rotation * PI / 180.0;
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if params.orientation_steps % 2 == 1 {
        (full_h, full_w)
    } else {
        (full_w, full_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    let tolerance_val = luminance_tolerance(params.tolerance);
    let inv_scale = 1.0 / scale;

    for_each_mask_row(&mut mask, |y_out, row| {
        let y_uncrop = y_out as f32 + crop_offset.1;
        let y_centered = y_uncrop - center_y;
        let y_sin = y_centered * sin_a;
        let y_cos = y_centered * cos_a;

        for (x_out, value) in row.iter_mut().enumerate() {
            let x_uncrop = x_out as f32 + crop_offset.0;
            let x_centered = x_uncrop - center_x;

            let x_unrotated = x_centered * cos_a + y_sin + center_x;
            let y_unrotated = -x_centered * sin_a + y_cos + center_y;

            let x_unflipped = if params.flip_horizontal {
                scaled_coarse_rotated_w - x_unrotated
            } else {
                x_unrotated
            };
            let y_unflipped = if params.flip_vertical {
                scaled_coarse_rotated_h - y_unrotated
            } else {
                y_unrotated
            };

            let (x_unrotated_coarse, y_unrotated_coarse) = match params.orientation_steps {
                0 => (x_unflipped, y_unflipped),
                1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
                2 => (
                    scaled_coarse_rotated_w - x_unflipped,
                    scaled_coarse_rotated_h - y_unflipped,
                ),
                3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
                _ => (x_unflipped, y_unflipped),
            };

            if x_unrotated_coarse >= 0.0 && y_unrotated_coarse >= 0.0 {
                let x_src = (x_unrotated_coarse * inv_scale) as u32;
                let y_src = (y_unrotated_coarse * inv_scale) as u32;

                if x_src < full_w && y_src < full_h {
                    let pixel = warped.get_pixel(x_src, y_src);
                    let luma =
                        0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32;
                    let dist = (luma - ref_luma).abs();

                    if dist <= tolerance_val {
                        let intensity = 1.0 - (dist / tolerance_val);
                        *value = (intensity * 255.0) as u8;
                    }
                }
            }
        }
    });

    apply_grow_and_feather(&mut mask, params.grow, params.feather, width, height);
    Some(mask)
}
