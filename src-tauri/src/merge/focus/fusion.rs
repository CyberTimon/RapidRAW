use crate::merge::raster::{Raster, gaussian_blur, map_pixels, pyr_down, pyr_up};
use crate::render::color_space::luminance;
use rayon::prelude::*;
use serde::Deserialize;

const MAX_LEVELS: usize = 8;
const MIN_LEVEL_DIMENSION: usize = 16;
const NOISE_SCALE: f32 = 4.0;
const MIN_VALID: f32 = 1e-3;
const DEPTH_LEVEL: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    #[default]
    Detail,
    Smooth,
}

impl Method {
    fn pooling(self) -> f32 {
        match self {
            Method::Detail => 1.0,
            Method::Smooth => 4.0,
        }
    }

    fn exponent(self, level: usize) -> f32 {
        let fine = match self {
            Method::Detail => 12.0,
            Method::Smooth => 8.0,
        };
        (fine * 0.75f32.powi(level as i32)).max(3.0)
    }
}

pub fn level_count(width: usize, height: usize) -> usize {
    let mut count = 1;
    let (mut w, mut h) = (width, height);
    while count < MAX_LEVELS && w.min(h) > 2 * MIN_LEVEL_DIMENSION {
        w = w.div_ceil(2);
        h = h.div_ceil(2);
        count += 1;
    }
    count
}

fn luma(image: &Raster) -> Raster {
    map_pixels(image, 1, |p, o| o[0] = luminance(p))
}

fn subtract(a: &Raster, b: &Raster) -> Raster {
    let mut out = a.clone();
    out.data
        .par_iter_mut()
        .zip(b.data.par_iter())
        .for_each(|(o, v)| *o -= v);
    out
}

fn squared(a: &Raster) -> Raster {
    let mut out = a.clone();
    out.data.par_iter_mut().for_each(|v| *v *= *v);
    out
}

fn detail_bands(luma: &Raster) -> (Raster, Raster) {
    let g1 = pyr_down(luma);
    let g2 = pyr_down(&g1);
    let d0 = subtract(luma, &pyr_up(&g1, luma.width, luma.height));
    let d1 = subtract(&g1, &pyr_up(&g2, g1.width, g1.height));
    (d0, d1)
}

fn focus_measure(luma: &Raster, pooling: f32) -> Raster {
    let (d0, d1) = detail_bands(luma);
    let e0 = gaussian_blur(&squared(&d0), pooling);
    let e1 = gaussian_blur(&squared(&d1), pooling);
    let mut measure = pyr_up(&e1, luma.width, luma.height);
    measure
        .data
        .par_iter_mut()
        .zip(e0.data.par_iter())
        .for_each(|(m, e)| *m += e);
    measure
}

pub fn noise_floor(image: &Raster) -> f32 {
    let (d0, _) = detail_bands(&luma(image));
    let mut magnitudes: Vec<f32> = d0.data.iter().map(|v| v.abs()).collect();
    if magnitudes.is_empty() {
        return 1e-6;
    }
    let middle = magnitudes.len() / 2;
    let median = *magnitudes
        .select_nth_unstable_by(middle, |a, b| a.total_cmp(b))
        .1;
    let sigma = median / 0.6745;
    (NOISE_SCALE * sigma * sigma).max(1e-10)
}

pub struct Contribution {
    bands: Vec<Raster>,
    log_weights: Vec<Vec<f32>>,
    measure: Option<Raster>,
}

pub fn prepare(
    image: &Raster,
    valid: &[f32],
    method: Method,
    noise: f32,
    keep_measure: bool,
) -> Contribution {
    let levels = level_count(image.width, image.height);
    let measure = focus_measure(&luma(image), method.pooling());

    let mut gaussians = vec![image.clone()];
    let mut measures = vec![measure];
    let mut validity = vec![Raster::from_data(
        image.width,
        image.height,
        1,
        valid.to_vec(),
    )];
    for _ in 1..levels {
        gaussians.push(pyr_down(gaussians.last().unwrap()));
        measures.push(pyr_down(measures.last().unwrap()));
        validity.push(pyr_down(validity.last().unwrap()));
    }

    let mut bands = Vec::with_capacity(levels);
    for l in 0..levels {
        if l + 1 < levels {
            let (w, h) = (gaussians[l].width, gaussians[l].height);
            bands.push(subtract(&gaussians[l], &pyr_up(&gaussians[l + 1], w, h)));
        } else {
            bands.push(gaussians[l].clone());
        }
    }

    let log_weights = (0..levels)
        .map(|l| {
            let exponent = method.exponent(l);
            measures[l]
                .data
                .par_iter()
                .zip(validity[l].data.par_iter())
                .map(|(&m, &v)| {
                    if v < MIN_VALID {
                        f32::NEG_INFINITY
                    } else {
                        exponent * (m.max(0.0) / noise).ln_1p() + 4.0 * v.min(1.0).ln()
                    }
                })
                .collect()
        })
        .collect();

    let depth_level = DEPTH_LEVEL.min(levels - 1);
    Contribution {
        bands,
        log_weights,
        measure: keep_measure.then(|| measures.swap_remove(depth_level)),
    }
}

struct Level {
    width: usize,
    height: usize,
    numerator: Vec<f32>,
    denominator: Vec<f32>,
    maximum: Vec<f32>,
}

pub struct Depth {
    pub width: usize,
    pub height: usize,
    pub labels: Vec<u16>,
    pub best: Vec<f32>,
}

pub struct Fusion {
    levels: Vec<Level>,
    depth: Option<Depth>,
}

impl Fusion {
    pub fn new(width: usize, height: usize, track_depth: bool) -> Self {
        let count = level_count(width, height);
        let mut levels = Vec::with_capacity(count);
        let (mut w, mut h) = (width, height);
        for _ in 0..count {
            levels.push(Level {
                width: w,
                height: h,
                numerator: vec![0.0; w * h * 3],
                denominator: vec![0.0; w * h],
                maximum: vec![f32::NEG_INFINITY; w * h],
            });
            w = w.div_ceil(2);
            h = h.div_ceil(2);
        }
        let depth_level = &levels[DEPTH_LEVEL.min(count - 1)];
        let (dw, dh) = (depth_level.width, depth_level.height);
        Fusion {
            depth: track_depth.then(|| Depth {
                width: dw,
                height: dh,
                labels: vec![0; dw * dh],
                best: vec![f32::NEG_INFINITY; dw * dh],
            }),
            levels,
        }
    }

    pub fn accumulate(&mut self, index: usize, contribution: Contribution) {
        assert_eq!(
            contribution.bands.len(),
            self.levels.len(),
            "contribution must match the fusion pyramid"
        );
        for ((level, band), log_weights) in self
            .levels
            .iter_mut()
            .zip(&contribution.bands)
            .zip(&contribution.log_weights)
        {
            assert_eq!(band.width, level.width, "band width must match its level");
            level
                .numerator
                .par_chunks_mut(3)
                .zip(level.denominator.par_iter_mut())
                .zip(level.maximum.par_iter_mut())
                .zip(band.data.par_chunks(3))
                .zip(log_weights.par_iter())
                .for_each(|((((num, den), max), value), &lw)| {
                    if lw == f32::NEG_INFINITY {
                        return;
                    }
                    let weight = if lw > *max {
                        let scale = (*max - lw).exp();
                        num.iter_mut().for_each(|n| *n *= scale);
                        *den *= scale;
                        *max = lw;
                        1.0
                    } else {
                        (lw - *max).exp()
                    };
                    for c in 0..3 {
                        num[c] += weight * value[c];
                    }
                    *den += weight;
                });
        }
        if let (Some(depth), Some(measure)) = (&mut self.depth, &contribution.measure) {
            let log_weights = &contribution.log_weights[DEPTH_LEVEL.min(self.levels.len() - 1)];
            depth
                .best
                .par_iter_mut()
                .zip(depth.labels.par_iter_mut())
                .zip(measure.data.par_iter())
                .zip(log_weights.par_iter())
                .for_each(|(((b, l), &m), &lw)| {
                    if lw > f32::NEG_INFINITY && m > *b {
                        *b = m;
                        *l = index as u16;
                    }
                });
        }
    }

    pub fn finish(self) -> (Raster, Option<Depth>) {
        let mut result: Option<Raster> = None;
        for level in self.levels.into_iter().rev() {
            let mut band = level.numerator;
            band.par_chunks_mut(3)
                .zip(level.denominator.par_iter())
                .for_each(|(p, &d)| {
                    let inv = if d > 0.0 { 1.0 / d } else { 0.0 };
                    p.iter_mut().for_each(|v| *v *= inv);
                });
            let band = Raster::from_data(level.width, level.height, 3, band);
            result = Some(match result {
                None => band,
                Some(coarse) => {
                    let mut up = pyr_up(&coarse, level.width, level.height);
                    up.data
                        .par_iter_mut()
                        .zip(band.data.par_iter())
                        .for_each(|(u, b)| *u += b);
                    up
                }
            });
        }
        (result.expect("fusion has at least one level"), self.depth)
    }
}
