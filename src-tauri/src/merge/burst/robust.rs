use crate::merge::noise::{NoiseModel, for_band_rows, lookup};
use crate::merge::raster::{Raster, gaussian_blur, max_filter};
use crate::render::image_processing::smoothstep;
use rayon::prelude::*;

const ACCEPT: f32 = 2.5;
const REJECT: f32 = 5.0;
const SPREAD: usize = 2;
const FEATHER: f32 = 2.0;
const DETAIL_WINDOW: f32 = 1.5;
const DETAIL_KEEP: f32 = 1.5;
const DETAIL_DROP: f32 = 4.0;
const PREFER_MARGIN: f32 = 0.25;

pub struct Contribution {
    pub image: Raster,
    pub weights: Vec<f32>,
}

impl Contribution {
    pub fn prefer(mut self, other: Contribution) -> Contribution {
        self.image
            .data
            .par_chunks_mut(3)
            .zip(self.weights.par_iter_mut())
            .zip(other.image.data.par_chunks(3).zip(other.weights.par_iter()))
            .for_each(|((pixel, weight), (candidate, &better))| {
                let t = smoothstep(0.0, PREFER_MARGIN, better - *weight);
                if t > 0.0 {
                    for c in 0..3 {
                        pixel[c] += t * (candidate[c] - pixel[c]);
                    }
                    *weight += t * (better - *weight);
                }
            });
        self
    }
}

pub fn contribution(
    model: &NoiseModel,
    reference: &Raster,
    aligned: &Raster,
    valid: &[f32],
) -> Contribution {
    let (width, height) = (reference.width, reference.height);
    let rows = for_band_rows(
        reference,
        aligned,
        |_| true,
        |_, bands| {
            let mut rejection = Vec::with_capacity(width);
            let mut energy = Vec::with_capacity(width);
            for x in 0..width {
                let mut distance = 0.0f32;
                let mut detail = 0.0f32;
                for c in 0..3 {
                    let i = x * 3 + c;
                    let low = bands.low[i];
                    distance = distance.max(low.abs() / lookup(&model.low, c, bands.reference[i]));
                    let high =
                        (bands.difference[i] - low) / lookup(&model.detail, c, bands.reference[i]);
                    detail += high * high;
                }
                rejection.push(smoothstep(ACCEPT, REJECT, distance));
                energy.push(detail / 3.0);
            }
            (rejection, energy, bands.low.to_vec())
        },
    );
    let mut rejection = Vec::with_capacity(width * height);
    let mut energy = Vec::with_capacity(width * height);
    let mut low = Vec::with_capacity(width * height * 3);
    for (r, e, l) in rows {
        rejection.extend(r);
        energy.extend(e);
        low.extend(l);
    }
    let spread = max_filter(&Raster::from_data(width, height, 1, rejection), SPREAD);
    let weights = gaussian_blur(&spread, FEATHER)
        .data
        .par_iter()
        .zip(valid.par_iter())
        .map(|(&r, &v)| (1.0 - r.clamp(0.0, 1.0)) * v)
        .collect();
    let energy = gaussian_blur(&Raster::from_data(width, height, 1, energy), DETAIL_WINDOW);
    low.par_chunks_mut(3)
        .zip(energy.data.par_iter())
        .enumerate()
        .for_each(|(i, (pixel, &e))| {
            let keep = 1.0 - smoothstep(DETAIL_KEEP, DETAIL_DROP, e);
            let r = reference.pixel_at(i);
            let a = aligned.pixel_at(i);
            for c in 0..3 {
                let l = pixel[c];
                pixel[c] = r[c] + l + keep * (a[c] - r[c] - l);
            }
        });
    Contribution {
        image: Raster::from_data(width, height, 3, low),
        weights,
    }
}

pub struct Merger {
    numerator: Raster,
    denominator: Vec<f32>,
}

impl Merger {
    pub fn new(width: usize, height: usize) -> Self {
        Merger {
            numerator: Raster::new(width, height, 3),
            denominator: vec![0.0; width * height],
        }
    }

    pub fn add(&mut self, aligned: &Raster, weights: Option<&[f32]>) {
        let width = aligned.width;
        self.numerator
            .data
            .par_chunks_mut(width * 3)
            .zip(self.denominator.par_chunks_mut(width))
            .enumerate()
            .for_each(|(y, (num, den))| {
                for x in 0..width {
                    let w = weights.map_or(1.0, |weights| weights[y * width + x]);
                    if w <= 0.0 {
                        continue;
                    }
                    let p = aligned.pixel(x, y);
                    for c in 0..3 {
                        num[x * 3 + c] += w * p[c];
                    }
                    den[x] += w;
                }
            });
    }

    pub fn finish(mut self) -> Raster {
        self.numerator
            .data
            .par_chunks_mut(3)
            .zip(self.denominator.par_iter())
            .for_each(|(p, &d)| {
                let inverse = if d > 0.0 { 1.0 / d } else { 0.0 };
                p.iter_mut().for_each(|v| *v *= inverse);
            });
        self.numerator
    }
}
