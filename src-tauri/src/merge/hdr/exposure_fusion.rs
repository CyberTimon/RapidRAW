use crate::merge::blending::MultiBandBlender;
use crate::merge::raster::{Raster, Rect, crop, map_pixels, srgb_decoded, srgb_encoded};
use crate::render::color_space::luminance;
use rayon::prelude::*;

const WELL_EXPOSED_SIGMA: f32 = 0.2;
const WEIGHT_FLOOR: f32 = 1e-6;
const COARSEST_LEVEL: usize = 16;
const MAX_BANDS: usize = 8;

pub fn weights(linear: &Raster, valid: &[f32]) -> Vec<f32> {
    let encoded = srgb_encoded(linear);
    let gray = map_pixels(&encoded, 1, |p, o| o[0] = luminance(p));
    let (w, h) = (encoded.width, encoded.height);
    let inv = 1.0 / (2.0 * WELL_EXPOSED_SIGMA * WELL_EXPOSED_SIGMA);
    (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (x, y) = ((i % w) as isize, (i / w) as isize);
            let center = gray.data[i];
            let contrast = (gray.get_clamped(x - 1, y, 0)
                + gray.get_clamped(x + 1, y, 0)
                + gray.get_clamped(x, y - 1, 0)
                + gray.get_clamped(x, y + 1, 0)
                - 4.0 * center)
                .abs();
            let p = encoded.pixel_at(i);
            let mean = (p[0] + p[1] + p[2]) / 3.0;
            let saturation =
                (((p[0] - mean).powi(2) + (p[1] - mean).powi(2) + (p[2] - mean).powi(2)) / 3.0)
                    .sqrt();
            let exposedness = p
                .iter()
                .map(|v| (-(v.min(1.0) - 0.5).powi(2) * inv).exp())
                .product::<f32>();
            (contrast * saturation * exposedness + WEIGHT_FLOOR) * valid[i]
        })
        .collect()
}

pub struct ExposureFusion {
    width: usize,
    height: usize,
    blender: MultiBandBlender,
}

impl ExposureFusion {
    pub fn new(width: usize, height: usize) -> Self {
        let bands =
            ((width.min(height) / COARSEST_LEVEL).max(2).ilog2() as usize).clamp(1, MAX_BANDS);
        ExposureFusion {
            width,
            height,
            blender: MultiBandBlender::new(width, height, bands),
        }
    }

    pub fn add(&mut self, linear: &Raster, weights: &[f32], total: &[f32]) {
        let normalized: Vec<f32> = weights
            .par_iter()
            .zip(total.par_iter())
            .map(|(&w, &t)| if t > 0.0 { w / t } else { 0.0 })
            .collect();
        self.blender.feed(&srgb_encoded(linear), &normalized, 0, 0);
    }

    pub fn finish(self) -> Raster {
        srgb_decoded(crop(
            &self.blender.finish(),
            &Rect::full(self.width, self.height),
        ))
    }
}
