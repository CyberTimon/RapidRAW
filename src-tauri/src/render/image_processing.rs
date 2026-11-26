use glam::Vec3;
use image::{DynamicImage, GenericImageView, Rgb32FImage, RgbImage, Rgba32FImage};
use rayon::prelude::*;
use std::sync::OnceLock;

use crate::render::agx::agx;
use crate::render::color_space::{OutputTransform, srgb_transfer};

#[inline]
pub fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

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

    let filter = BoxFilter::new(image.dimensions(), (nwidth, nheight))?;
    let out_buf = match image {
        DynamicImage::ImageRgb32F(rgb) => filter.run::<3, 3, f32>(rgb.as_raw(), |v| v),
        DynamicImage::ImageRgb8(rgb) => {
            let lut = u8_to_f32_lut();
            filter.run::<3, 3, u8>(rgb.as_raw(), |v| lut[v as usize])
        }
        DynamicImage::ImageRgba8(rgba) => {
            let lut = u8_to_f32_lut();
            filter.run::<4, 3, u8>(rgba.as_raw(), |v| lut[v as usize])
        }
        _ => {
            let converted = image.to_rgb32f();
            filter.run::<3, 3, f32>(converted.as_raw(), |v| v)
        }
    };

    let out =
        Rgb32FImage::from_raw(filter.new_w, filter.new_h, out_buf).expect("buffer size mismatch");
    let result = DynamicImage::ImageRgb32F(out);

    log::info!("downscale_f32_image took {:.2?}", start.elapsed());

    Some(result)
}

const BAND_FLOATS: usize = 1 << 24;

pub fn downscale_rgba32f(
    size: (u32, u32),
    target: (u32, u32),
    fill_row: impl Fn(usize, &mut [f32]) + Sync,
) -> Option<Rgba32FImage> {
    let filter = BoxFilter::new(size, target)?;
    let row_len = filter.width_usize * 4;
    let out_len = filter.new_w as usize * 4;
    let band_rows = (BAND_FLOATS / row_len).max(1);
    let mut out_buf = vec![0.0f32; out_len * filter.new_h as usize];
    let mut band = Vec::new();
    let mut done = 0;
    while done < filter.new_h as usize {
        let start = filter.y_bounds[done].0;
        let rows = filter.y_bounds[done..]
            .iter()
            .take_while(|bounds| bounds.1 <= start + band_rows)
            .count()
            .max(1);
        let end = filter.y_bounds[done + rows - 1].1;
        band.resize((end - start) * row_len, 0.0);
        band.par_chunks_exact_mut(row_len)
            .enumerate()
            .for_each(|(offset, line)| fill_row(start + offset, line));
        filter.run_rows::<4, 4, f32>(
            &mut out_buf[done * out_len..(done + rows) * out_len],
            done,
            &band,
            start,
            |v| v,
        );
        done += rows;
    }
    Rgba32FImage::from_raw(filter.new_w, filter.new_h, out_buf)
}

type AxisBounds = Vec<(usize, usize, usize)>;

fn axis_weights(length: u32, new_length: u32) -> (AxisBounds, Vec<f32>) {
    let ratio = length as f32 / new_length as f32;
    let mut bounds = Vec::with_capacity(new_length as usize);
    let mut weights = Vec::new();
    for out in 0..new_length as usize {
        let start = out as f32 * ratio;
        let end = (out + 1) as f32 * ratio;
        let in_start = start.floor() as usize;
        let in_end = (end.ceil() as usize).min(length as usize);

        let weight_start_idx = weights.len();
        let mut w_sum = 0.0;
        let mut tmp_w = Vec::with_capacity(in_end.saturating_sub(in_start));

        let mut actual_start = in_end;
        let mut actual_end = in_start;

        for input in in_start..in_end {
            let overlap_start = start.max(input as f32);
            let overlap_end = end.min((input + 1) as f32);
            let w = (overlap_end - overlap_start).max(0.0);
            if w > 0.0 {
                actual_start = actual_start.min(input);
                actual_end = actual_end.max(input + 1);
                tmp_w.push(w);
                w_sum += w;
            }
        }

        if w_sum > 0.0 {
            let inv_w = 1.0 / w_sum;
            for w in tmp_w {
                weights.push(w * inv_w);
            }
            bounds.push((actual_start, actual_end, weight_start_idx));
        } else {
            bounds.push((0, 0, weight_start_idx));
        }
    }
    (bounds, weights)
}

struct BoxFilter {
    width_usize: usize,
    new_w: u32,
    new_h: u32,
    x_bounds: AxisBounds,
    x_weights: Vec<f32>,
    y_bounds: AxisBounds,
    y_weights: Vec<f32>,
}

impl BoxFilter {
    fn new(size: (u32, u32), target: (u32, u32)) -> Option<Self> {
        let (new_w, new_h) = fitted_size(size, target)?;
        let (x_bounds, x_weights) = axis_weights(size.0, new_w);
        let (y_bounds, y_weights) = axis_weights(size.1, new_h);
        Some(Self {
            width_usize: size.0 as usize,
            new_w,
            new_h,
            x_bounds,
            x_weights,
            y_bounds,
            y_weights,
        })
    }

    fn run<const C: usize, const O: usize, T: Copy + Sync>(
        &self,
        src: &[T],
        to_f32: impl Fn(T) -> f32 + Sync,
    ) -> Vec<f32> {
        let mut out_buf = vec![0.0f32; self.new_w as usize * self.new_h as usize * O];
        self.run_rows::<C, O, T>(&mut out_buf, 0, src, 0, to_f32);
        out_buf
    }

    fn run_rows<const C: usize, const O: usize, T: Copy + Sync>(
        &self,
        out: &mut [f32],
        first_out: usize,
        src: &[T],
        first_in: usize,
        to_f32: impl Fn(T) -> f32 + Sync,
    ) {
        let width_usize = self.width_usize;
        out.par_chunks_exact_mut(self.new_w as usize * O)
            .enumerate()
            .for_each(|(index, row)| {
                let (y_in_start, y_in_end, y_wt_offset) = self.y_bounds[first_out + index];
                let y_len = y_in_end - y_in_start;
                let y_wts = &self.y_weights[y_wt_offset..y_wt_offset + y_len];

                for (x_out, &(x_in_start, x_in_end, x_wt_offset)) in
                    self.x_bounds.iter().enumerate()
                {
                    let mut sums = [0.0f32; O];

                    let x_len = x_in_end - x_in_start;
                    let x_wts = &self.x_weights[x_wt_offset..x_wt_offset + x_len];

                    for (dy, &w_y) in y_wts.iter().enumerate() {
                        let y_in = y_in_start + dy;
                        let row_offset = (y_in - first_in) * width_usize * C;

                        let src_start = row_offset + x_in_start * C;
                        let src_end = row_offset + x_in_end * C;
                        let src_slice = &src[src_start..src_end];

                        for (&w_x, chunk) in x_wts.iter().zip(src_slice.as_chunks::<C>().0) {
                            let w = w_x * w_y;
                            for (sum, &value) in sums.iter_mut().zip(chunk) {
                                *sum += to_f32(value).max(0.0) * w;
                            }
                        }
                    }

                    row[x_out * O..(x_out + 1) * O].copy_from_slice(&sums);
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
    let transfer = srgb_transfer();
    map_color_channels(image, |x| transfer.decode(x.max(0.0)))
}

pub fn apply_linear_to_srgb(image: DynamicImage) -> DynamicImage {
    let transfer = srgb_transfer();
    map_color_channels(image, |x| transfer.encode(x))
}

pub fn apply_cpu_agx_tonemap(image: &mut DynamicImage) {
    let agx = agx();
    rgb32f_mut(image).par_chunks_mut(3).for_each(|pixel| {
        pixel.copy_from_slice(&agx.tonemap(Vec3::from_slice(pixel)).to_array());
    });
}

pub fn working_display_to_srgb8(pixels: &[f32]) -> Vec<u8> {
    let output = OutputTransform::srgb(false);
    pixels
        .par_chunks_exact(3)
        .flat_map_iter(|pixel| {
            output
                .apply_srgb_encoded([pixel[0], pixel[1], pixel[2]])
                .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        })
        .collect()
}

pub fn working_display_image_to_srgb8(image: &DynamicImage) -> RgbImage {
    let converted;
    let rgb = match image.as_rgb32f() {
        Some(rgb) => rgb,
        None => {
            converted = image.to_rgb32f();
            &converted
        }
    };
    RgbImage::from_raw(
        rgb.width(),
        rgb.height(),
        working_display_to_srgb8(rgb.as_raw()),
    )
    .expect("RGB8 buffer matches image dimensions")
}

pub fn apply_working_display_to_srgb(image: &mut DynamicImage, compress_gamut: bool) {
    let output = OutputTransform::srgb(compress_gamut);
    rgb32f_mut(image).par_chunks_mut(3).for_each(|pixel| {
        pixel.copy_from_slice(&output.apply_srgb_encoded([pixel[0], pixel[1], pixel[2]]));
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
