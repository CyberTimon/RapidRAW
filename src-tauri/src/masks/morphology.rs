use image::GrayImage;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

fn grayscale_dilate(image: &GrayImage, k: u8) -> GrayImage {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let w = width as usize;
    let h = height as usize;
    let r = k as i32;
    let src = image.as_raw();

    let mut temp = vec![0u8; w * h];
    let mut out = vec![0u8; w * h];

    temp.par_chunks_mut(w)
        .zip(src.par_chunks(w))
        .for_each(|(temp_row, src_row)| {
            for (x, slot) in temp_row.iter_mut().enumerate() {
                let mut max_val = 0;
                let start = (x as i32 - r).max(0) as usize;
                let end = (x as i32 + r).min((w - 1) as i32) as usize;
                for &value in &src_row[start..=end] {
                    max_val = max_val.max(value);
                }
                *slot = max_val;
            }
        });

    let r = r as usize;
    out.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let start = y.saturating_sub(r);
        let end = (y + r).min(h - 1);
        out_row.copy_from_slice(&temp[start * w..(start + 1) * w]);
        for yi in (start + 1)..=end {
            for (o, &t) in out_row.iter_mut().zip(&temp[yi * w..(yi + 1) * w]) {
                *o = (*o).max(t);
            }
        }
    });

    GrayImage::from_raw(width, height, out).unwrap()
}

fn grayscale_erode(image: &GrayImage, k: u8) -> GrayImage {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let w = width as usize;
    let h = height as usize;
    let r = k as i32;
    let src = image.as_raw();

    let mut temp = vec![0u8; w * h];
    let mut out = vec![0u8; w * h];

    temp.par_chunks_mut(w)
        .zip(src.par_chunks(w))
        .for_each(|(temp_row, src_row)| {
            for (x, slot) in temp_row.iter_mut().enumerate() {
                let mut min_val = 255;
                let start = (x as i32 - r).max(0) as usize;
                let end = (x as i32 + r).min((w - 1) as i32) as usize;
                for &value in &src_row[start..=end] {
                    min_val = min_val.min(value);
                }
                *slot = min_val;
            }
        });

    let r = r as usize;
    out.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let start = y.saturating_sub(r);
        let end = (y + r).min(h - 1);
        out_row.copy_from_slice(&temp[start * w..(start + 1) * w]);
        for yi in (start + 1)..=end {
            for (o, &t) in out_row.iter_mut().zip(&temp[yi * w..(yi + 1) * w]) {
                *o = (*o).min(t);
            }
        }
    });

    GrayImage::from_raw(width, height, out).unwrap()
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (2.0 * sigma).ceil() as usize;
    let pdf =
        |x: f32| (sigma * (2.0 * PI).sqrt()).recip() * (-x.powi(2) / (2.0 * sigma.powi(2))).exp();
    let mut kernel = vec![0.0f32; 2 * radius + 1];
    for i in 0..=radius {
        let value = pdf(i as f32);
        kernel[radius + i] = value;
        kernel[radius - i] = value;
    }
    let sum: f32 = kernel.iter().sum();
    kernel.iter_mut().for_each(|k| *k /= sum);
    kernel
}

fn saturate_u8(value: f32) -> u8 {
    if value < 255.0 {
        if value > 0.0 { value as u8 } else { 0 }
    } else {
        255
    }
}

fn gaussian_blur_mask(mask: &GrayImage, sigma: f32) -> GrayImage {
    let (w, h) = (mask.width() as usize, mask.height() as usize);
    if w == 0 || h == 0 {
        return mask.clone();
    }
    let kernel = gaussian_kernel(sigma);
    let radius = (kernel.len() / 2) as isize;
    let tap = |center: usize, offset: usize, len: usize| {
        (center as isize + offset as isize - radius).clamp(0, len as isize - 1) as usize
    };

    let mut horizontal = vec![0u8; w * h];
    horizontal
        .par_chunks_exact_mut(w)
        .zip(mask.as_raw().par_chunks_exact(w))
        .for_each(|(out, row)| {
            for (x, value) in out.iter_mut().enumerate() {
                let mut acc = 0.0f32;
                for (i, k) in kernel.iter().enumerate() {
                    acc += row[tap(x, i, w)] as f32 * k;
                }
                *value = saturate_u8(acc);
            }
        });

    let mut blurred = vec![0u8; w * h];
    blurred
        .par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, out)| {
            let mut acc = vec![0.0f32; w];
            for (i, k) in kernel.iter().enumerate() {
                let row = &horizontal[tap(y, i, h) * w..][..w];
                for (a, &v) in acc.iter_mut().zip(row) {
                    *a += v as f32 * k;
                }
            }
            for (value, a) in out.iter_mut().zip(acc) {
                *value = saturate_u8(a);
            }
        });

    GrayImage::from_raw(w as u32, h as u32, blurred).expect("mask buffer size")
}

pub fn apply_grow_and_feather(
    mask: &mut GrayImage,
    grow: f32,
    feather: f32,
    width: u32,
    height: u32,
) {
    let base_dimension = width.min(height) as f32;

    if grow.abs() > 0.01 {
        const MAX_GROW_PERCENTAGE: f32 = 0.01;
        let grow_pixels = (grow / 100.0) * base_dimension * MAX_GROW_PERCENTAGE;

        let amount = grow_pixels.abs().round() as u8;

        if amount > 0 {
            if grow_pixels > 0.0 {
                *mask = grayscale_dilate(mask, amount);
            } else {
                *mask = grayscale_erode(mask, amount);
            }
        }
    }

    if feather > 0.0 {
        const MAX_FEATHER_SIGMA_PERCENTAGE: f32 = 0.005;
        let sigma = (feather / 100.0) * base_dimension * MAX_FEATHER_SIGMA_PERCENTAGE;

        if sigma > 0.01 {
            *mask = gaussian_blur_mask(mask, sigma);
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrowFeatherParameters {
    #[serde(default)]
    pub grow: f32,
    #[serde(default)]
    pub feather: f32,
}

pub fn for_each_mask_row(mask: &mut GrayImage, fill_row: impl Fn(u32, &mut [u8]) + Sync) {
    let width = mask.width() as usize;
    if width == 0 {
        return;
    }
    mask.par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| fill_row(y as u32, row));
}
