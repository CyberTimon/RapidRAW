use glam::Vec3;
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use rayon::prelude::*;
use std::sync::OnceLock;

use crate::render::color_space::calculate_agx_matrices_glam;

pub fn downscale_f32_image(image: &DynamicImage, nwidth: u32, nheight: u32) -> DynamicImage {
    downscale_f32_image_if_needed(image, nwidth, nheight).unwrap_or_else(|| image.clone())
}

fn u8_to_f32_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let ramp = image::RgbImage::from_fn(256, 1, |x, _| image::Rgb([x as u8; 3]));
        let converted = DynamicImage::ImageRgb8(ramp).to_rgb32f();
        let mut lut = [0.0f32; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = converted.get_pixel(i as u32, 0)[0];
        }
        lut
    })
}

pub fn fitted_size(
    (width, height): (u32, u32),
    (nwidth, nheight): (u32, u32),
) -> Option<(u32, u32)> {
    if nwidth == 0 || nheight == 0 || (nwidth >= width && nheight >= height) {
        return None;
    }

    let ratio = (nwidth as f32 / width as f32).min(nheight as f32 / height as f32);
    let new_w = (width as f32 * ratio).round() as u32;
    let new_h = (height as f32 * ratio).round() as u32;

    (new_w > 0 && new_h > 0).then_some((new_w, new_h))
}

pub fn downscale_f32_image_if_needed(
    image: &DynamicImage,
    nwidth: u32,
    nheight: u32,
) -> Option<DynamicImage> {
    let start = std::time::Instant::now();

    let (width, height) = image.dimensions();
    let (new_w, new_h) = fitted_size((width, height), (nwidth, nheight))?;

    let x_ratio = width as f32 / new_w as f32;
    let y_ratio = height as f32 / new_h as f32;
    let width_usize = width as usize;

    let mut x_bounds = Vec::with_capacity(new_w as usize);
    let mut x_weights = Vec::new();
    for x_out in 0..new_w as usize {
        let x_start = x_out as f32 * x_ratio;
        let x_end = (x_out + 1) as f32 * x_ratio;
        let x_in_start = x_start.floor() as usize;
        let x_in_end = (x_end.ceil() as usize).min(width as usize);

        let weight_start_idx = x_weights.len();
        let mut w_sum = 0.0;
        let mut tmp_w = Vec::with_capacity(x_in_end.saturating_sub(x_in_start));

        let mut actual_start = x_in_end;
        let mut actual_end = x_in_start;

        for x_in in x_in_start..x_in_end {
            let overlap_start = x_start.max(x_in as f32);
            let overlap_end = x_end.min((x_in + 1) as f32);
            let w = (overlap_end - overlap_start).max(0.0);
            if w > 0.0 {
                actual_start = actual_start.min(x_in);
                actual_end = actual_end.max(x_in + 1);
                tmp_w.push(w);
                w_sum += w;
            }
        }

        if w_sum > 0.0 {
            let inv_w = 1.0 / w_sum;
            for w in tmp_w {
                x_weights.push(w * inv_w);
            }
            x_bounds.push((actual_start, actual_end, weight_start_idx));
        } else {
            x_bounds.push((0, 0, weight_start_idx));
        }
    }

    let mut y_bounds = Vec::with_capacity(new_h as usize);
    let mut y_weights = Vec::new();
    for y_out in 0..new_h as usize {
        let y_start = y_out as f32 * y_ratio;
        let y_end = (y_out + 1) as f32 * y_ratio;
        let y_in_start = y_start.floor() as usize;
        let y_in_end = (y_end.ceil() as usize).min(height as usize);

        let weight_start_idx = y_weights.len();
        let mut w_sum = 0.0;
        let mut tmp_w = Vec::with_capacity(y_in_end.saturating_sub(y_in_start));

        let mut actual_start = y_in_end;
        let mut actual_end = y_in_start;

        for y_in in y_in_start..y_in_end {
            let overlap_start = y_start.max(y_in as f32);
            let overlap_end = y_end.min((y_in + 1) as f32);
            let w = (overlap_end - overlap_start).max(0.0);
            if w > 0.0 {
                actual_start = actual_start.min(y_in);
                actual_end = actual_end.max(y_in + 1);
                tmp_w.push(w);
                w_sum += w;
            }
        }

        if w_sum > 0.0 {
            let inv_w = 1.0 / w_sum;
            for w in tmp_w {
                y_weights.push(w * inv_w);
            }
            y_bounds.push((actual_start, actual_end, weight_start_idx));
        } else {
            y_bounds.push((0, 0, weight_start_idx));
        }
    }

    let mut out_buf = vec![0.0f32; (new_w * new_h * 3) as usize];
    let filter = BoxFilter {
        width_usize,
        new_w,
        x_bounds: &x_bounds,
        x_weights: &x_weights,
        y_bounds: &y_bounds,
        y_weights: &y_weights,
    };

    match image {
        DynamicImage::ImageRgb32F(rgb) => filter.run::<3, f32>(rgb.as_raw(), |v| v, &mut out_buf),
        DynamicImage::ImageRgb8(rgb) => {
            let lut = u8_to_f32_lut();
            filter.run::<3, u8>(rgb.as_raw(), |v| lut[v as usize], &mut out_buf)
        }
        DynamicImage::ImageRgba8(rgba) => {
            let lut = u8_to_f32_lut();
            filter.run::<4, u8>(rgba.as_raw(), |v| lut[v as usize], &mut out_buf)
        }
        _ => {
            let converted = image.to_rgb32f();
            filter.run::<3, f32>(converted.as_raw(), |v| v, &mut out_buf)
        }
    }

    let out = Rgb32FImage::from_raw(new_w, new_h, out_buf).expect("buffer size mismatch");
    let result = DynamicImage::ImageRgb32F(out);

    log::info!("downscale_f32_image took {:.2?}", start.elapsed());

    Some(result)
}

struct BoxFilter<'a> {
    width_usize: usize,
    new_w: u32,
    x_bounds: &'a [(usize, usize, usize)],
    x_weights: &'a [f32],
    y_bounds: &'a [(usize, usize, usize)],
    y_weights: &'a [f32],
}

impl BoxFilter<'_> {
    fn run<const C: usize, T: Copy + Sync>(
        &self,
        src: &[T],
        to_f32: impl Fn(T) -> f32 + Sync,
        out_buf: &mut [f32],
    ) {
        let width_usize = self.width_usize;
        out_buf
            .par_chunks_exact_mut(self.new_w as usize * 3)
            .enumerate()
            .for_each(|(y_out, row)| {
                let (y_in_start, y_in_end, y_wt_offset) = self.y_bounds[y_out];
                let y_len = y_in_end - y_in_start;
                let y_wts = &self.y_weights[y_wt_offset..y_wt_offset + y_len];

                for (x_out, &(x_in_start, x_in_end, x_wt_offset)) in
                    self.x_bounds.iter().enumerate()
                {
                    let mut r_sum = 0.0;
                    let mut g_sum = 0.0;
                    let mut b_sum = 0.0;

                    let x_len = x_in_end - x_in_start;
                    let x_wts = &self.x_weights[x_wt_offset..x_wt_offset + x_len];

                    for (dy, &w_y) in y_wts.iter().enumerate() {
                        let y_in = y_in_start + dy;
                        let row_offset = y_in * width_usize * C;

                        let src_start = row_offset + x_in_start * C;
                        let src_end = row_offset + x_in_end * C;
                        let src_slice = &src[src_start..src_end];

                        for (&w_x, chunk) in x_wts.iter().zip(src_slice.as_chunks::<C>().0) {
                            let w = w_x * w_y;

                            let r = to_f32(chunk[0]).max(0.0);
                            let g = to_f32(chunk[1]).max(0.0);
                            let b = to_f32(chunk[2]).max(0.0);

                            r_sum += r * w;
                            g_sum += g * w;
                            b_sum += b * w;
                        }
                    }

                    let out_idx = x_out * 3;

                    row[out_idx] = r_sum;
                    row[out_idx + 1] = g_sum;
                    row[out_idx + 2] = b_sum;
                }
            });
    }
}

fn rgb32f_mut(image: &mut DynamicImage) -> &mut Rgb32FImage {
    if image.as_rgb32f().is_none() {
        *image = DynamicImage::ImageRgb32F(image.to_rgb32f());
    }
    match image {
        DynamicImage::ImageRgb32F(buffer) => buffer,
        _ => unreachable!(),
    }
}

pub fn apply_cpu_default_raw_processing(image: &mut DynamicImage) {
    let f32_image = rgb32f_mut(image);

    const GAMMA: f32 = 2.38;
    const INV_GAMMA: f32 = 1.0 / GAMMA;
    const CONTRAST: f32 = 1.28;

    f32_image.par_chunks_mut(3).for_each(|pixel_chunk| {
        let r_gamma = pixel_chunk[0].powf(INV_GAMMA);
        let g_gamma = pixel_chunk[1].powf(INV_GAMMA);
        let b_gamma = pixel_chunk[2].powf(INV_GAMMA);

        let r_contrast = (r_gamma - 0.5) * CONTRAST + 0.5;
        let g_contrast = (g_gamma - 0.5) * CONTRAST + 0.5;
        let b_contrast = (b_gamma - 0.5) * CONTRAST + 0.5;

        pixel_chunk[0] = r_contrast.clamp(0.0, 1.0);
        pixel_chunk[1] = g_contrast.clamp(0.0, 1.0);
        pixel_chunk[2] = b_contrast.clamp(0.0, 1.0);
    });
}

pub fn srgb_channel_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn map_color_channels(
    mut image: DynamicImage,
    map: impl Fn(f32) -> f32 + Send + Sync,
) -> DynamicImage {
    match &mut image {
        DynamicImage::ImageRgb32F(img) => {
            img.as_mut().par_iter_mut().for_each(|c| *c = map(*c));
        }
        DynamicImage::ImageRgba32F(img) => {
            img.par_chunks_mut(4).for_each(|p| {
                p[0] = map(p[0]);
                p[1] = map(p[1]);
                p[2] = map(p[2]);
            });
        }
        _ => {}
    }
    image
}

pub fn apply_exposure(image: DynamicImage, exposure: f32) -> DynamicImage {
    if exposure == 0.0 {
        return image;
    }
    let gain = exposure.exp2();
    map_color_channels(image, |x| x * gain)
}

pub fn apply_srgb_to_linear(image: DynamicImage) -> DynamicImage {
    map_color_channels(image, |x| srgb_channel_to_linear(x.max(0.0)))
}

pub(crate) fn linear_channel_to_srgb(x: f32) -> f32 {
    let x = x.max(0.0);
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

pub fn apply_linear_to_srgb(image: DynamicImage) -> DynamicImage {
    map_color_channels(image, linear_channel_to_srgb)
}

pub fn apply_cpu_agx_tonemap(image: &mut DynamicImage) {
    const AGX_EPSILON: f32 = 1.0e-6;
    const AGX_MIN_EV: f32 = -15.2;
    const AGX_MAX_EV: f32 = 5.0;
    const AGX_RANGE_EV: f32 = AGX_MAX_EV - AGX_MIN_EV;
    const AGX_GAMMA: f32 = 2.4;
    const AGX_SLOPE: f32 = 2.3843;
    const AGX_TOE_POWER: f32 = 1.5;
    const AGX_SHOULDER_POWER: f32 = 1.5;
    const AGX_TOE_TRANSITION_X: f32 = 0.6060606;
    const AGX_TOE_TRANSITION_Y: f32 = 0.43446;
    const AGX_SHOULDER_TRANSITION_X: f32 = 0.6060606;
    const AGX_SHOULDER_TRANSITION_Y: f32 = 0.43446;
    const AGX_INTERCEPT: f32 = -1.0112;
    const AGX_TOE_SCALE: f32 = -1.0359;
    const AGX_SHOULDER_SCALE: f32 = 1.3475;

    fn agx_sigmoid(x: f32, power: f32) -> f32 {
        x / (1.0 + x.powf(power)).powf(1.0 / power)
    }

    fn agx_scaled_sigmoid(x: f32, scale: f32, slope: f32, power: f32, tx: f32, ty: f32) -> f32 {
        scale * agx_sigmoid(slope * (x - tx) / scale, power) + ty
    }

    fn agx_curve_channel(x: f32) -> f32 {
        let result = if x < AGX_TOE_TRANSITION_X {
            agx_scaled_sigmoid(
                x,
                AGX_TOE_SCALE,
                AGX_SLOPE,
                AGX_TOE_POWER,
                AGX_TOE_TRANSITION_X,
                AGX_TOE_TRANSITION_Y,
            )
        } else if x <= AGX_SHOULDER_TRANSITION_X {
            AGX_SLOPE * x + AGX_INTERCEPT
        } else {
            agx_scaled_sigmoid(
                x,
                AGX_SHOULDER_SCALE,
                AGX_SLOPE,
                AGX_SHOULDER_POWER,
                AGX_SHOULDER_TRANSITION_X,
                AGX_SHOULDER_TRANSITION_Y,
            )
        };
        result.clamp(0.0, 1.0)
    }

    const LUT_SIZE: usize = 4096;
    let mut curve_lut = [0.0f32; LUT_SIZE];
    for (i, slot) in curve_lut.iter_mut().enumerate() {
        let x = i as f32 / (LUT_SIZE - 1) as f32;
        *slot = agx_curve_channel(x).max(0.0).powf(AGX_GAMMA);
    }

    let (pipe_to_rendering, rendering_to_pipe) = calculate_agx_matrices_glam();

    let f32_image = rgb32f_mut(image);

    f32_image.par_chunks_mut(3).for_each(|pixel_chunk| {
        let r = pixel_chunk[0];
        let g = pixel_chunk[1];
        let b = pixel_chunk[2];

        let min_c = r.min(g).min(b);
        let (r, g, b) = if min_c < 0.0 {
            (r - min_c, g - min_c, b - min_c)
        } else {
            (r, g, b)
        };

        let in_rendering = pipe_to_rendering * Vec3::new(r, g, b);

        let x = Vec3::new(
            (in_rendering.x / 0.18).max(AGX_EPSILON),
            (in_rendering.y / 0.18).max(AGX_EPSILON),
            (in_rendering.z / 0.18).max(AGX_EPSILON),
        );
        let log_encoded = Vec3::new(
            (x.x.log2() - AGX_MIN_EV) / AGX_RANGE_EV,
            (x.y.log2() - AGX_MIN_EV) / AGX_RANGE_EV,
            (x.z.log2() - AGX_MIN_EV) / AGX_RANGE_EV,
        );
        let mapped = Vec3::new(
            log_encoded.x.clamp(0.0, 1.0),
            log_encoded.y.clamp(0.0, 1.0),
            log_encoded.z.clamp(0.0, 1.0),
        );

        let lut_lookup = |v: f32| -> f32 {
            let idx = (v * (LUT_SIZE - 1) as f32) as usize;
            curve_lut[idx.min(LUT_SIZE - 1)]
        };
        let curved = Vec3::new(
            lut_lookup(mapped.x),
            lut_lookup(mapped.y),
            lut_lookup(mapped.z),
        );

        let final_color = rendering_to_pipe * curved;

        pixel_chunk[0] = final_color.x.clamp(0.0, 1.0);
        pixel_chunk[1] = final_color.y.clamp(0.0, 1.0);
        pixel_chunk[2] = final_color.z.clamp(0.0, 1.0);
    });
}

pub fn into_rgb32f_parallel(image: DynamicImage) -> image::Rgb32FImage {
    match image {
        DynamicImage::ImageRgba32F(rgba) => {
            let (w, h) = rgba.dimensions();
            let mut rgb = vec![0.0f32; (w as usize) * (h as usize) * 3];
            rgb.par_chunks_exact_mut(3)
                .zip(rgba.as_raw().par_chunks_exact(4))
                .for_each(|(dst, src)| dst.copy_from_slice(&src[..3]));
            image::ImageBuffer::from_raw(w, h, rgb).expect("RGB buffer matches image dimensions")
        }
        other => other.into_rgb32f(),
    }
}
