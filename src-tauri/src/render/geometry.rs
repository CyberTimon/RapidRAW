use crate::adjustments::guided_perspective::{
    GuideLine, compute_guided_homography, count_valid_lines,
};
use crate::adjustments::lens_correction::{LensProfile, lens_profile};
use image::{DynamicImage, Rgb32FImage, Rgba};
use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};
use nalgebra::{Matrix3 as NaMatrix3, Vector3 as NaVector3};
use rawler::decoders::Orientation;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::f32::consts::PI;

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GeometryParams {
    pub distortion: f32,
    pub vertical: f32,
    pub horizontal: f32,
    pub rotate: f32,
    pub aspect: f32,
    pub scale: f32,
    pub x_offset: f32,
    pub y_offset: f32,
    pub lens_distortion_amount: f32,
    pub lens_vignette_amount: f32,
    pub lens_tca_amount: f32,
    pub lens_distortion_enabled: bool,
    pub lens_tca_enabled: bool,
    pub lens_vignette_enabled: bool,
    #[serde(default)]
    pub lens: Option<LensProfile>,
    #[serde(default)]
    pub guided_lines: Vec<GuideLine>,
    #[serde(default)]
    pub guided_perspective_enabled: bool,
}

impl Default for GeometryParams {
    fn default() -> Self {
        Self {
            distortion: 0.0,
            vertical: 0.0,
            horizontal: 0.0,
            rotate: 0.0,
            aspect: 0.0,
            scale: 100.0,
            x_offset: 0.0,
            y_offset: 0.0,
            lens_distortion_amount: 1.0,
            lens_vignette_amount: 1.0,
            lens_tca_amount: 1.0,
            lens_distortion_enabled: true,
            lens_tca_enabled: true,
            lens_vignette_enabled: true,
            lens: None,
            guided_lines: Vec::new(),
            guided_perspective_enabled: false,
        }
    }
}

impl GeometryParams {
    fn lens_distortion(&self) -> Option<&[f64; 5]> {
        self.lens
            .as_ref()
            .and_then(|l| l.distortion.as_ref())
            .filter(|_| self.lens_distortion_enabled && self.lens_distortion_amount != 0.0)
    }

    fn lens_tca(&self) -> Option<&[f64; 6]> {
        self.lens
            .as_ref()
            .and_then(|l| l.tca.as_ref())
            .filter(|_| self.lens_tca_enabled && self.lens_tca_amount != 0.0)
    }

    fn lens_vignetting(&self) -> Option<&[f64; 3]> {
        self.lens
            .as_ref()
            .and_then(|l| l.vignetting.as_ref())
            .filter(|_| self.lens_vignette_enabled && self.lens_vignette_amount != 0.0)
    }
}

pub fn get_geometry_params_from_json(
    path: &str,
    adjustments: &serde_json::Value,
) -> GeometryParams {
    GeometryParams {
        lens: lens_profile(path, adjustments),
        ..user_geometry_params(adjustments)
    }
}

pub fn user_geometry_params(adjustments: &serde_json::Value) -> GeometryParams {
    let guided = adjustments.get("guidedPerspective");
    let guided_perspective_enabled = guided
        .and_then(|g| g.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let guided_lines: Vec<GuideLine> = guided
        .and_then(|g| g.get("lines"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    GeometryParams {
        distortion: adjustments["transformDistortion"].as_f64().unwrap_or(0.0) as f32,
        vertical: adjustments["transformVertical"].as_f64().unwrap_or(0.0) as f32,
        horizontal: adjustments["transformHorizontal"].as_f64().unwrap_or(0.0) as f32,
        rotate: adjustments["transformRotate"].as_f64().unwrap_or(0.0) as f32,
        aspect: adjustments["transformAspect"].as_f64().unwrap_or(0.0) as f32,
        scale: adjustments["transformScale"].as_f64().unwrap_or(100.0) as f32,
        x_offset: adjustments["transformXOffset"].as_f64().unwrap_or(0.0) as f32,
        y_offset: adjustments["transformYOffset"].as_f64().unwrap_or(0.0) as f32,

        lens_distortion_amount: adjustments["lensDistortionAmount"]
            .as_f64()
            .unwrap_or(100.0) as f32
            / 100.0,
        lens_vignette_amount: adjustments["lensVignetteAmount"].as_f64().unwrap_or(100.0) as f32
            / 100.0,
        lens_tca_amount: adjustments["lensTcaAmount"].as_f64().unwrap_or(100.0) as f32 / 100.0,
        lens_distortion_enabled: adjustments["lensDistortionEnabled"]
            .as_bool()
            .unwrap_or(true),
        lens_tca_enabled: adjustments["lensTcaEnabled"].as_bool().unwrap_or(true),
        lens_vignette_enabled: adjustments["lensVignetteEnabled"].as_bool().unwrap_or(true),

        lens: None,
        guided_lines,
        guided_perspective_enabled,
    }
}

#[inline(always)]
fn interpolate_pixel(
    src_raw: &[f32],
    src_width: usize,
    src_height: usize,
    x: f32,
    y: f32,
    pixel_out: &mut [f32],
) {
    if x.is_nan()
        || y.is_nan()
        || x < 0.0
        || y < 0.0
        || x >= (src_width as f32 - 1.0)
        || y >= (src_height as f32 - 1.0)
    {
        return;
    }

    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;

    let wx = x - x0 as f32;
    let wy = y - y0 as f32;
    let one_minus_wx = 1.0 - wx;
    let one_minus_wy = 1.0 - wy;

    let stride = src_width * 3;
    let idx_row0 = y0 * stride;
    let idx_row1 = idx_row0 + stride;
    let idx_p00 = idx_row0 + x0 * 3;

    unsafe {
        let p00 = src_raw.get_unchecked(idx_p00..idx_p00 + 3);
        let p10 = src_raw.get_unchecked(idx_p00 + 3..idx_p00 + 6);
        let p01 = src_raw.get_unchecked(idx_row1 + x0 * 3..idx_row1 + x0 * 3 + 3);
        let p11 = src_raw.get_unchecked(idx_row1 + x0 * 3 + 3..idx_row1 + x0 * 3 + 6);

        let top_r = p00[0] * one_minus_wx + p10[0] * wx;
        let top_g = p00[1] * one_minus_wx + p10[1] * wx;
        let top_b = p00[2] * one_minus_wx + p10[2] * wx;

        let bot_r = p01[0] * one_minus_wx + p11[0] * wx;
        let bot_g = p01[1] * one_minus_wx + p11[1] * wx;
        let bot_b = p01[2] * one_minus_wx + p11[2] * wx;

        pixel_out[0] = top_r * one_minus_wy + bot_r * wy;
        pixel_out[1] = top_g * one_minus_wy + bot_g * wy;
        pixel_out[2] = top_b * one_minus_wy + bot_b * wy;
    }
}

fn build_transform_matrices(
    params: &GeometryParams,
    width: f32,
    height: f32,
) -> (NaMatrix3<f32>, f32, f32, f64) {
    let cx = width / 2.0;
    let cy = height / 2.0;
    let ref_dim = 2000.0;

    let p_vert = (params.vertical / 100000.0) * (ref_dim / height);
    let p_horiz = (-params.horizontal / 100000.0) * (ref_dim / width);
    let theta = params.rotate.to_radians();

    let aspect_factor = if params.aspect >= 0.0 {
        1.0 + params.aspect / 100.0
    } else {
        1.0 / (1.0 + params.aspect.abs() / 100.0)
    };

    let scale_factor = params.scale / 100.0;
    let off_x = (params.x_offset / 100.0) * width;
    let off_y = (params.y_offset / 100.0) * height;

    let t_center = NaMatrix3::new(1.0, 0.0, cx, 0.0, 1.0, cy, 0.0, 0.0, 1.0);
    let t_uncenter = NaMatrix3::new(1.0, 0.0, -cx, 0.0, 1.0, -cy, 0.0, 0.0, 1.0);
    let m_perspective = NaMatrix3::new(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, p_horiz, p_vert, 1.0);

    let (sin_t, cos_t) = theta.sin_cos();
    let m_rotate = NaMatrix3::new(cos_t, -sin_t, 0.0, sin_t, cos_t, 0.0, 0.0, 0.0, 1.0);
    let m_scale = NaMatrix3::new(
        scale_factor * aspect_factor,
        0.0,
        0.0,
        0.0,
        scale_factor,
        0.0,
        0.0,
        0.0,
        1.0,
    );
    let m_offset = NaMatrix3::new(1.0, 0.0, off_x, 0.0, 1.0, off_y, 0.0, 0.0, 1.0);

    let guided_m = if params.guided_perspective_enabled
        && count_valid_lines(&params.guided_lines, width as f64, height as f64) >= 2
    {
        if let Some(res) =
            compute_guided_homography(&params.guided_lines, width as f64, height as f64)
        {
            let h = res.forward_h;
            NaMatrix3::new(
                h[0][0] as f32,
                h[0][1] as f32,
                h[0][2] as f32,
                h[1][0] as f32,
                h[1][1] as f32,
                h[1][2] as f32,
                h[2][0] as f32,
                h[2][1] as f32,
                h[2][2] as f32,
            )
        } else {
            NaMatrix3::identity()
        }
    } else {
        NaMatrix3::identity()
    };

    let forward = t_center * m_offset * m_perspective * m_rotate * m_scale * guided_m * t_uncenter;
    let half_diagonal =
        ((width as f64 * width as f64 + height as f64 * height as f64).sqrt()) / 2.0;

    (forward, cx, cy, half_diagonal)
}

struct TcaContext<'a> {
    src_raw: &'a [f32],
    src_width: usize,
    src_height: usize,
    cx: f32,
    cy: f32,
}

#[inline(always)]
fn interpolate_pixel_with_tca(
    tca: &TcaContext,
    base_x: f32,
    base_y: f32,
    vr: f32,
    vb: f32,
    pixel_out: &mut [f32],
) {
    let src_raw = tca.src_raw;
    let src_width = tca.src_width;
    let src_height = tca.src_height;
    let cx = tca.cx;
    let cy = tca.cy;
    let gx = base_x;
    let gy = base_y;

    let rx = cx + (base_x - cx) * vr;
    let ry = cy + (base_y - cy) * vr;

    let bx = cx + (base_x - cx) * vb;
    let by = cy + (base_y - cy) * vb;

    let sample_channel = |target_x: f32, target_y: f32, channel_idx: usize| -> f32 {
        if target_x.is_nan() || target_y.is_nan() {
            return 0.0;
        }

        let x_clamped = target_x.clamp(0.0, src_width as f32 - 1.0);
        let y_clamped = target_y.clamp(0.0, src_height as f32 - 1.0);

        let mut x0 = x_clamped.floor() as usize;
        let mut y0 = y_clamped.floor() as usize;

        if x0 >= src_width - 1 {
            x0 = src_width.saturating_sub(2);
        }
        if y0 >= src_height - 1 {
            y0 = src_height.saturating_sub(2);
        }

        let wx = x_clamped - x0 as f32;
        let wy = y_clamped - y0 as f32;
        let one_minus_wx = 1.0 - wx;
        let one_minus_wy = 1.0 - wy;

        let stride = src_width * 3;
        let idx_row0 = y0 * stride;
        let idx_row1 = idx_row0 + stride;

        let idx_p00 = idx_row0 + x0 * 3 + channel_idx;

        unsafe {
            let p00 = *src_raw.get_unchecked(idx_p00);
            let p10 = *src_raw.get_unchecked(idx_p00 + 3);
            let p01 = *src_raw.get_unchecked(idx_row1 + x0 * 3 + channel_idx);
            let p11 = *src_raw.get_unchecked(idx_row1 + x0 * 3 + 3 + channel_idx);

            let top = p00 * one_minus_wx + p10 * wx;
            let bot = p01 * one_minus_wx + p11 * wx;
            top * one_minus_wy + bot * wy
        }
    };

    pixel_out[0] = sample_channel(rx, ry, 0);
    pixel_out[1] = sample_channel(gx, gy, 1);
    pixel_out[2] = sample_channel(bx, by, 2);
}

pub struct WarpModel {
    pub forward: NaMatrix3<f32>,
    pub inverse: NaMatrix3<f32>,
    pub cx: f32,
    pub cy: f32,
    pub max_radius_sq_inv: f64,
    pub k_distortion: f64,
    pub lens_k: [f64; 4],
    pub lens_scale: f64,
    pub has_lens_correction: bool,
    pub auto_crop_scale: f32,
    pub tca_red: [f64; 3],
    pub tca_blue: [f64; 3],
    pub tca_scale: f64,
    pub has_tca: bool,
    pub vignette_k: [f64; 3],
    pub vignette_scale: f64,
    pub vignette_amount: f64,
    pub has_vignetting: bool,
}

impl WarpModel {
    pub fn new(params: &GeometryParams, width: u32, height: u32) -> Self {
        let (forward, cx, cy, half_diagonal) =
            build_transform_matrices(params, width as f32, height as f32);
        let inverse = forward.try_inverse().unwrap_or(NaMatrix3::identity());
        let lens = params.lens.as_ref();
        let radial_scale = lens.map_or(0.0, |l| l.distortion_scale) / half_diagonal;

        let amount = params.lens_distortion_amount as f64;
        let (lens_k, lens_scale) = params.lens_distortion().map_or(([0.0; 4], 0.0), |c| {
            (
                [c[1], c[2], c[3], c[4]].map(|k| k / c[0] * amount),
                radial_scale / c[0],
            )
        });

        let tca_amount = params.lens_tca_amount as f64;
        let tca_channel =
            |v: f64, c: f64, b: f64| [1.0 + (v - 1.0) * tca_amount, c * tca_amount, b * tca_amount];
        let (tca_red, tca_blue) = params
            .lens_tca()
            .map_or(([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]), |t| {
                (tca_channel(t[0], t[2], t[4]), tca_channel(t[1], t[3], t[5]))
            });

        let mut model = Self {
            forward,
            inverse,
            cx,
            cy,
            max_radius_sq_inv: 1.0 / (half_diagonal * half_diagonal),
            k_distortion: (params.distortion as f64 / 100.0) * 2.5,
            lens_k,
            lens_scale,
            has_lens_correction: params.lens_distortion().is_some(),
            auto_crop_scale: 1.0,
            tca_red,
            tca_blue,
            tca_scale: radial_scale,
            has_tca: params.lens_tca().is_some(),
            vignette_k: params.lens_vignetting().copied().unwrap_or_default(),
            vignette_scale: lens.map_or(0.0, |l| l.vignetting_scale) / half_diagonal,
            vignette_amount: params.lens_vignette_amount as f64,
            has_vignetting: params.lens_vignetting().is_some(),
        };
        model.auto_crop_scale = model.compute_auto_crop_scale();
        model
    }

    fn radial_factor(&self, radius: f64) -> f64 {
        let user = 1.0 + self.k_distortion * radius * radius * self.max_radius_sq_inv;
        let r = radius * user * self.lens_scale;
        let [k1, k2, k3, k4] = self.lens_k;
        user * (1.0 + r * (k1 + r * (k2 + r * (k3 + r * k4))))
    }

    fn compute_auto_crop_scale(&self) -> f32 {
        if !self.has_lens_correction && self.k_distortion.abs() <= 1e-5 {
            return 1.0;
        }
        const RADIUS_STEPS: usize = 512;
        const BORDER_SAMPLES: usize = 64;

        let (cx, cy) = (self.cx as f64, self.cy as f64);
        let half_diagonal = cx.hypot(cy);
        let mut furthest = 0.0f64;
        let reach: Vec<(f64, f64)> = (0..=RADIUS_STEPS)
            .map(|i| {
                let radius = half_diagonal * i as f64 / RADIUS_STEPS as f64;
                furthest = furthest.max(radius * self.radial_factor(radius));
                (radius, furthest)
            })
            .collect();

        let shortest = cx.min(cy);
        let scale = (0..=BORDER_SAMPLES)
            .filter_map(|j| {
                let border =
                    shortest + (half_diagonal - shortest) * j as f64 / BORDER_SAMPLES as f64;
                let i = reach.partition_point(|&(_, source)| source < border);
                let ((r0, s0), (r1, s1)) = (*reach.get(i.checked_sub(1)?)?, *reach.get(i)?);
                Some(border / (r0 + (border - s0) / (s1 - s0) * (r1 - r0)))
            })
            .fold(1.0f64, f64::max);

        if scale > 1.0 {
            (scale * 1.002) as f32
        } else {
            1.0
        }
    }

    pub fn source_point(&self, x: f64, y: f64) -> (f64, f64) {
        let (cx, cy) = (self.cx as f64, self.cy as f64);
        let crop = self.auto_crop_scale as f64;
        let (dx, dy) = ((x - cx) / crop, (y - cy) / crop);
        let factor = self.radial_factor(dx.hypot(dy));
        (cx + dx * factor, cy + dy * factor)
    }

    fn output_point(&self, x: f64, y: f64) -> (f64, f64) {
        let (cx, cy) = (self.cx as f64, self.cy as f64);
        let (dx, dy) = (x - cx, y - cy);
        let source_radius = dx.hypot(dy);
        let mapped = |r: f64| r * self.radial_factor(r);
        let mut radius = source_radius;
        for _ in 0..20 {
            let h = (radius.abs() * 1e-4).max(1e-3);
            let slope = (mapped(radius + h) - mapped(radius - h)) / (2.0 * h);
            if slope.abs() < 1e-9 {
                break;
            }
            let step = (mapped(radius) - source_radius) / slope;
            radius -= step;
            if step.abs() < 1e-4 {
                break;
            }
        }
        let scale = if source_radius > 1e-6 {
            radius / source_radius
        } else {
            1.0
        } * self.auto_crop_scale as f64;
        (cx + dx * scale, cy + dy * scale)
    }

    fn tca_scales(&self, dx: f64, dy: f64) -> (f32, f32) {
        let r = dx.hypot(dy) * self.tca_scale;
        let scale = |[v, c, b]: [f64; 3]| (v + r * (c + r * b)) as f32;
        (scale(self.tca_red), scale(self.tca_blue))
    }

    fn vignette_gain(&self, dx: f64, dy: f64) -> f32 {
        let r = dx.hypot(dy) * self.vignette_scale;
        let r2 = r * r;
        let [k1, k2, k3] = self.vignette_k;
        let falloff = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3));
        if falloff > 1e-6 {
            (1.0 + (1.0 / falloff - 1.0) * self.vignette_amount) as f32
        } else {
            1.0
        }
    }
}

pub fn warp_image_geometry(image: &DynamicImage, params: GeometryParams) -> DynamicImage {
    let converted;
    let src_img = match image.as_rgb32f() {
        Some(buffer) => buffer,
        None => {
            converted = image.to_rgb32f();
            &converted
        }
    };
    let (width, height) = src_img.dimensions();
    let mut out_buffer = vec![0.0f32; (width * height * 3) as usize];

    let model = WarpModel::new(&params, width, height);
    let inv = model.inverse;
    let step_vec_x = NaVector3::new(inv[(0, 0)], inv[(1, 0)], inv[(2, 0)]);
    let step_vec_y = NaVector3::new(inv[(0, 1)], inv[(1, 1)], inv[(2, 1)]);
    let origin_vec = NaVector3::new(inv[(0, 2)], inv[(1, 2)], inv[(2, 2)]);
    let (cx, cy) = (model.cx as f64, model.cy as f64);

    let src_raw = src_img.as_raw();
    let width_usize = width as usize;
    let height_usize = height as usize;
    let tca_ctx = TcaContext {
        src_raw,
        src_width: width_usize,
        src_height: height_usize,
        cx: model.cx,
        cy: model.cy,
    };

    out_buffer
        .par_chunks_exact_mut(width_usize * 3)
        .enumerate()
        .for_each(|(y, row_pixel_data)| {
            let row_origin = origin_vec + (step_vec_y * y as f32);

            for (x, pixel) in row_pixel_data.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let current_vec = row_origin + step_vec_x * x as f32;
                if current_vec.z.abs() <= 1e-6 {
                    continue;
                }
                let inv_z = 1.0 / current_vec.z as f64;
                let (sx, sy) =
                    model.source_point(current_vec.x as f64 * inv_z, current_vec.y as f64 * inv_z);
                let (src_x, src_y) = (sx as f32, sy as f32);

                if model.has_tca {
                    let (vr, vb) = model.tca_scales(sx - cx, sy - cy);
                    interpolate_pixel_with_tca(&tca_ctx, src_x, src_y, vr, vb, pixel);
                } else {
                    interpolate_pixel(src_raw, width_usize, height_usize, src_x, src_y, pixel);
                }

                if model.has_vignetting {
                    let gain = model.vignette_gain(sx - cx, sy - cy);
                    pixel.iter_mut().for_each(|c| *c *= gain);
                }
            }
        });

    let out_img = Rgb32FImage::from_vec(width, height, out_buffer).unwrap();
    DynamicImage::ImageRgb32F(out_img)
}

pub fn unwarp_image_geometry(warped_image: &DynamicImage, params: GeometryParams) -> DynamicImage {
    let converted;
    let src_img = match warped_image.as_rgb32f() {
        Some(buffer) => buffer,
        None => {
            converted = warped_image.to_rgb32f();
            &converted
        }
    };
    let (width, height) = src_img.dimensions();
    let mut out_buffer = vec![0.0f32; (width * height * 3) as usize];

    let model = WarpModel::new(&params, width, height);
    let src_raw = src_img.as_raw();
    let width_usize = width as usize;
    let height_usize = height as usize;

    out_buffer
        .par_chunks_exact_mut(width_usize * 3)
        .enumerate()
        .for_each(|(y, row_pixel_data)| {
            for (x, pixel) in row_pixel_data.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let (ox, oy) = model.output_point(x as f64, y as f64);
                let target_vec = model.forward * NaVector3::new(ox as f32, oy as f32, 1.0);

                if target_vec.z.abs() > 1e-6 {
                    let inv_z = 1.0 / target_vec.z;

                    let src_x = target_vec.x * inv_z;
                    let src_y = target_vec.y * inv_z;

                    interpolate_pixel(src_raw, width_usize, height_usize, src_x, src_y, pixel);
                }
            }
        });

    let out_img = Rgb32FImage::from_vec(width, height, out_buffer).unwrap();
    DynamicImage::ImageRgb32F(out_img)
}

pub fn inverse_transform_mask(
    mask: image::GrayImage,
    path: &str,
    adjustments: &serde_json::Value,
) -> image::GrayImage {
    let rotation_degrees = adjustments
        .get("rotation")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as f32;
    let mask_dyn = image::DynamicImage::ImageLuma8(mask);

    let unrotated_fine = if rotation_degrees.abs() > 1e-5 {
        apply_rotation(mask_dyn, -rotation_degrees).into_owned()
    } else {
        mask_dyn
    };

    let flip_h = adjustments
        .get("flipHorizontal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let flip_v = adjustments
        .get("flipVertical")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let flipped = apply_flip(unrotated_fine, flip_h, flip_v).into_owned();

    let steps = adjustments
        .get("orientationSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u8;
    let inverse_steps = (4 - (steps % 4)) % 4;
    let unrotated_coarse = apply_coarse_rotation(flipped, inverse_steps).into_owned();

    let unwarped = apply_unwarp_geometry(unrotated_coarse, path, adjustments).into_owned();

    unwarped.into_luma8()
}

pub fn inverse_transform_point(
    mut x: f64,
    mut y: f64,
    mut curr_w: f64,
    mut curr_h: f64,
    path: &str,
    adjustments: &serde_json::Value,
) -> (f64, f64) {
    let rotation_degrees = adjustments
        .get("rotation")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if rotation_degrees.abs() > 1e-5 {
        let cx = curr_w / 2.0;
        let cy = curr_h / 2.0;
        let theta_rad = -rotation_degrees * std::f64::consts::PI / 180.0;
        let cos_t = theta_rad.cos();
        let sin_t = theta_rad.sin();

        let dx = x - cx;
        let dy = y - cy;
        x = cx + dx * cos_t - dy * sin_t;
        y = cy + dx * sin_t + dy * cos_t;
    }

    let flip_h = adjustments
        .get("flipHorizontal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let flip_v = adjustments
        .get("flipVertical")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if flip_h {
        x = curr_w - x;
    }
    if flip_v {
        y = curr_h - y;
    }

    let steps = adjustments
        .get("orientationSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u8;
    let inverse_steps = (4 - (steps % 4)) % 4;
    for _ in 0..inverse_steps {
        let new_x = curr_h - y;
        let new_y = x;
        x = new_x;
        y = new_y;
        std::mem::swap(&mut curr_w, &mut curr_h);
    }

    let params = get_geometry_params_from_json(path, adjustments);
    let model = WarpModel::new(&params, curr_w as u32, curr_h as u32);
    let vec = model.inverse * nalgebra::Vector3::new(x as f32, y as f32, 1.0);
    if vec.z.abs() > 1e-6 {
        let inv_z = 1.0 / (vec.z as f64);
        return model.source_point(vec.x as f64 * inv_z, vec.y as f64 * inv_z);
    }

    (x, y)
}

pub fn apply_orientation(image: DynamicImage, orientation: Orientation) -> DynamicImage {
    if let DynamicImage::ImageRgb32F(buffer) = &image
        && !matches!(orientation, Orientation::Normal | Orientation::Unknown)
    {
        return DynamicImage::ImageRgb32F(orient_rgb32f(buffer, orientation));
    }
    match orientation {
        Orientation::Normal | Orientation::Unknown => image,
        Orientation::HorizontalFlip => image.fliph(),
        Orientation::Rotate180 => image.rotate180(),
        Orientation::VerticalFlip => image.flipv(),
        Orientation::Transpose => image.rotate90().fliph(),
        Orientation::Rotate90 => image.rotate90(),
        Orientation::Transverse => image.rotate270().fliph(),
        Orientation::Rotate270 => image.rotate270(),
    }
}

fn orient_rgb32f(src: &Rgb32FImage, orientation: Orientation) -> Rgb32FImage {
    let width = src.width() as usize;
    let data = src.as_raw();
    oriented_rgb32f(width, src.height() as usize, orientation, |x, y| {
        let i = (y * width + x) * 3;
        [data[i], data[i + 1], data[i + 2]]
    })
}

pub fn oriented_rgb32f(
    width: usize,
    height: usize,
    orientation: Orientation,
    pixel: impl Fn(usize, usize) -> [f32; 3] + Sync,
) -> Rgb32FImage {
    fn remap(
        out_w: usize,
        out_h: usize,
        pixel: impl Fn(usize, usize) -> [f32; 3] + Sync,
    ) -> Rgb32FImage {
        const BAND: usize = 16;
        let mut out = vec![0.0f32; out_w * out_h * 3];
        out.par_chunks_mut(out_w * 3 * BAND)
            .enumerate()
            .for_each(|(band, chunk)| {
                let y0 = band * BAND;
                let rows = chunk.len() / (out_w * 3);
                for x in 0..out_w {
                    for dy in 0..rows {
                        let d = (dy * out_w + x) * 3;
                        chunk[d..d + 3].copy_from_slice(&pixel(x, y0 + dy));
                    }
                }
            });
        Rgb32FImage::from_raw(out_w as u32, out_h as u32, out).unwrap()
    }

    let (w, h) = (width, height);
    match orientation {
        Orientation::Normal | Orientation::Unknown => remap(w, h, pixel),
        Orientation::HorizontalFlip => remap(w, h, |x, y| pixel(w - 1 - x, y)),
        Orientation::Rotate180 => remap(w, h, |x, y| pixel(w - 1 - x, h - 1 - y)),
        Orientation::VerticalFlip => remap(w, h, |x, y| pixel(x, h - 1 - y)),
        Orientation::Transpose => remap(h, w, |x, y| pixel(y, x)),
        Orientation::Rotate90 => remap(h, w, |x, y| pixel(y, h - 1 - x)),
        Orientation::Transverse => remap(h, w, |x, y| pixel(w - 1 - y, h - 1 - x)),
        Orientation::Rotate270 => remap(h, w, |x, y| pixel(w - 1 - y, x)),
    }
}

pub fn apply_geometry_warp<'a>(
    image: impl IntoCowImage<'a>,
    path: &str,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let image = image.into_cow();
    let params = get_geometry_params_from_json(path, adjustments);
    if !is_geometry_identity(&params) {
        Cow::Owned(warp_image_geometry(image.as_ref(), params))
    } else {
        image
    }
}

pub fn apply_unwarp_geometry<'a>(
    image: impl IntoCowImage<'a>,
    path: &str,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let image = image.into_cow();
    let params = get_geometry_params_from_json(path, adjustments);
    if !is_geometry_identity(&params) {
        Cow::Owned(unwarp_image_geometry(image.as_ref(), params))
    } else {
        image
    }
}

pub fn apply_coarse_rotation<'a>(
    image: impl IntoCowImage<'a>,
    orientation_steps: u8,
) -> Cow<'a, DynamicImage> {
    let image = image.into_cow();
    match orientation_steps {
        1 => Cow::Owned(image.rotate90()),
        2 => Cow::Owned(image.rotate180()),
        3 => Cow::Owned(image.rotate270()),
        _ => image,
    }
}

pub fn apply_rotation<'a>(
    image: impl IntoCowImage<'a>,
    rotation_degrees: f32,
) -> Cow<'a, DynamicImage> {
    let image = image.into_cow();
    if rotation_degrees % 360.0 == 0.0 {
        return image;
    }

    let rgba_image = image.to_rgba32f();
    let rotated = rotate_about_center(
        &rgba_image,
        rotation_degrees * PI / 180.0,
        Interpolation::Bilinear,
        Border::Constant(Rgba([0.0f32, 0.0, 0.0, 0.0])),
    );

    Cow::Owned(DynamicImage::ImageRgba32F(rotated))
}

pub fn crop_rect(crop: &Crop, (img_w, img_h): (u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let (x, y) = (crop.x.round() as u32, crop.y.round() as u32);
    let (width, height) = (crop.width.round() as u32, crop.height.round() as u32);
    (width > 0 && height > 0 && x < img_w && y < img_h)
        .then(|| (x, y, (img_w - x).min(width), (img_h - y).min(height)))
}

pub fn apply_flip<'a>(
    image: impl IntoCowImage<'a>,
    horizontal: bool,
    vertical: bool,
) -> Cow<'a, DynamicImage> {
    let image = image.into_cow();
    if !horizontal && !vertical {
        return image;
    }

    let mut img = image.into_owned();
    if horizontal {
        img = img.fliph();
    }
    if vertical {
        img = img.flipv();
    }
    Cow::Owned(img)
}

pub fn is_geometry_identity(params: &GeometryParams) -> bool {
    if params.guided_perspective_enabled && params.guided_lines.len() >= 2 {
        return false;
    }

    params.distortion == 0.0
        && params.vertical == 0.0
        && params.horizontal == 0.0
        && params.rotate == 0.0
        && params.aspect == 0.0
        && params.scale == 100.0
        && params.x_offset == 0.0
        && params.y_offset == 0.0
        && params.lens_distortion().is_none()
        && params.lens_tca().is_none()
        && params.lens_vignetting().is_none()
}

pub trait IntoCowImage<'a> {
    fn into_cow(self) -> Cow<'a, DynamicImage>;
}

impl<'a> IntoCowImage<'a> for DynamicImage {
    fn into_cow(self) -> Cow<'a, DynamicImage> {
        Cow::Owned(self)
    }
}

impl<'a> IntoCowImage<'a> for &'a DynamicImage {
    fn into_cow(self) -> Cow<'a, DynamicImage> {
        Cow::Borrowed(self)
    }
}

impl<'a> IntoCowImage<'a> for Cow<'a, DynamicImage> {
    fn into_cow(self) -> Cow<'a, DynamicImage> {
        self
    }
}

impl<'a> IntoCowImage<'a> for &'a std::sync::Arc<DynamicImage> {
    fn into_cow(self) -> Cow<'a, DynamicImage> {
        Cow::Borrowed(self.as_ref())
    }
}
