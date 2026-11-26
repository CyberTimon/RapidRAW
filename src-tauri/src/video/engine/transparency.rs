use std::borrow::Cow;
use std::path::Path;

use image::{DynamicImage, GenericImageView, Rgba32FImage};
use rayon::prelude::*;

use crate::decode::formats::is_raw_file;
use crate::decode::image_loader::decode_alpha;
use crate::library::file_ops::read_file_mapped;
use crate::render::image_processing::downscale_rgba32f;

type Level = (Vec<[f32; 4]>, usize);

pub fn transparent_still(
    image: &DynamicImage,
    source: &Path,
    size: (u32, u32),
) -> Option<Rgba32FImage> {
    if is_raw_file(source) {
        return None;
    }
    let alpha = decode_alpha(&read_file_mapped(source).ok()?)?;
    let (width, height) = image.dimensions();
    if alpha.dimensions() != (width, height) {
        log::warn!(
            "Ignoring the transparency of '{}' because its alpha does not match the image",
            source.display()
        );
        return None;
    }
    let rgb = match image.as_rgb32f() {
        Some(rgb) => Cow::Borrowed(rgb),
        None => Cow::Owned(image.to_rgb32f()),
    };
    let row = width as usize;
    let premultiply = |y: usize, out: &mut [f32]| {
        let colors = &rgb.as_raw()[y * row * 3..][..row * 3];
        let alphas = &alpha.as_raw()[y * row..][..row];
        for ((pixel, color), &alpha) in out
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(colors.as_chunks::<3>().0)
            .zip(alphas)
        {
            *pixel = [color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha];
        }
    };
    let mut scaled = downscale_rgba32f((width, height), size, premultiply).or_else(|| {
        let mut full = vec![0.0; row * height as usize * 4];
        full.par_chunks_exact_mut(row * 4)
            .enumerate()
            .for_each(|(y, out)| premultiply(y, out));
        Rgba32FImage::from_raw(width, height, full)
    })?;
    unpremultiply(&mut scaled);
    Some(scaled)
}

fn pyramid(base: &[[f32; 4]], width: usize, height: usize) -> Vec<Level> {
    let mut levels: Vec<Level> = Vec::new();
    let (mut w, mut h) = (width, height);
    while w > 1 || h > 1 {
        let (next_w, next_h) = (w.div_ceil(2), h.div_ceil(2));
        let finer = levels.last().map_or(base, |(level, _)| level.as_slice());
        let coarser = (0..next_w * next_h)
            .into_par_iter()
            .map(|index| {
                let (x, y) = (index % next_w * 2, index / next_w * 2);
                let mut sum = [0.0f32; 4];
                for (sx, sy) in [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)] {
                    if sx < w && sy < h {
                        for (total, value) in sum.iter_mut().zip(finer[sy * w + sx]) {
                            *total += value;
                        }
                    }
                }
                sum
            })
            .collect();
        levels.push((coarser, next_w));
        (w, h) = (next_w, next_h);
    }
    levels
}

fn unpremultiply(image: &mut Rgba32FImage) {
    let width = image.width() as usize;
    let height = image.height() as usize;
    let levels = pyramid(image.as_raw().as_chunks::<4>().0, width, height);
    let covered = |x: usize, y: usize| {
        levels
            .iter()
            .enumerate()
            .map(|(k, (level, w))| level[(y >> (k + 1)) * w + (x >> (k + 1))])
            .find(|sum| sum[3] > 0.0)
    };
    image
        .par_chunks_exact_mut(width * 4)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, pixel) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let alpha = pixel[3];
                let sum = if alpha > 0.0 {
                    *pixel
                } else {
                    match covered(x, y) {
                        Some(sum) => sum,
                        None => continue,
                    }
                };
                let [r, g, b, weight] = sum;
                *pixel = [r / weight, g / weight, b / weight, alpha];
            }
        });
}
