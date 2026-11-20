use crate::merge::raster::{Raster, gaussian_blur, map_pixels, max_filter};
use crate::render::color_space::luminance;
use rayon::prelude::*;

const KNEE: (f32, f32) = (0.7, 0.9);
const NOISE_FLOOR: f32 = 0.003;
const DARKEST_FALLBACK_WEIGHT: f32 = 1e-6;
const REFERENCE_FALLBACK_WEIGHT: f32 = 1e-9;
const COMPARISON_BLUR: f32 = 1.2;
const GHOST_THRESHOLD: f32 = 0.25;
const GHOST_SPREAD: usize = 4;
const MIN_RATIO_SAMPLES: usize = 200;

#[derive(Clone, Copy)]
pub struct FrameRole {
    pub exposure: f32,
    pub darkest: bool,
    pub reference: bool,
}

#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub fn levels(image: &Raster, clip: f32, spread: usize) -> Raster {
    let level = map_pixels(image, 1, |p, o| o[0] = p[0].max(p[1]).max(p[2]) / clip);
    max_filter(&level, spread)
}

#[inline]
fn weight(role: FrameRole, level: f32, valid: f32) -> f32 {
    let usable = if role.darkest {
        1.0
    } else {
        1.0 - smoothstep(KNEE.0, KNEE.1, level)
    };
    let fallback = if role.darkest {
        DARKEST_FALLBACK_WEIGHT
    } else if role.reference {
        REFERENCE_FALLBACK_WEIGHT
    } else {
        0.0
    };
    role.exposure * (usable * valid + fallback)
}

#[inline]
fn contributes(role: FrameRole, level: f32) -> bool {
    role.darkest || level < KNEE.1
}

pub struct Accumulator {
    width: usize,
    height: usize,
    numerator: Vec<f32>,
    denominator: Vec<f32>,
}

impl Accumulator {
    pub fn new(width: usize, height: usize) -> Self {
        Accumulator {
            width,
            height,
            numerator: vec![0.0; width * height * 3],
            denominator: vec![0.0; width * height],
        }
    }

    pub fn add(
        &mut self,
        clip: f32,
        role: FrameRole,
        image: &Raster,
        valid: &[f32],
        ghost: Option<&Raster>,
    ) {
        assert_eq!(image.width, self.width, "frame width must match the merge");
        assert_eq!(
            image.height, self.height,
            "frame height must match the merge"
        );
        let level = levels(image, clip, 1);
        let width = self.width;
        let (gx, gy) = ghost.map_or((0.0, 0.0), |g| {
            (
                g.width as f32 / width as f32,
                g.height as f32 / self.height as f32,
            )
        });
        let inverse_exposure = 1.0 / role.exposure;
        self.numerator
            .par_chunks_mut(width * 3)
            .zip(self.denominator.par_chunks_mut(width))
            .enumerate()
            .for_each(|(y, (num, den))| {
                let mut sample = [0.0f32; 1];
                for x in 0..width {
                    let i = y * width + x;
                    let mut w = weight(role, level.data[i], valid[i]);
                    if let Some(g) = ghost {
                        g.bilinear(
                            (x as f32 + 0.5) * gx - 0.5,
                            (y as f32 + 0.5) * gy - 0.5,
                            &mut sample,
                        );
                        w *= 1.0 - sample[0].clamp(0.0, 1.0);
                    }
                    if w <= 0.0 {
                        continue;
                    }
                    let p = image.pixel(x, y);
                    let wr = w * inverse_exposure;
                    for c in 0..3 {
                        num[x * 3 + c] += wr * p[c].max(0.0);
                    }
                    den[x] += w;
                }
            });
    }

    fn estimate(&self) -> Raster {
        let mut data = self.numerator.clone();
        data.par_chunks_mut(3)
            .zip(self.denominator.par_iter())
            .for_each(|(p, &d)| {
                let inv = if d > 0.0 { 1.0 / d } else { 0.0 };
                p.iter_mut().for_each(|v| *v *= inv);
            });
        Raster::from_data(self.width, self.height, 3, data)
    }

    pub fn finish(self) -> Raster {
        self.estimate()
    }
}

pub struct PreviewFrame<'a> {
    pub image: &'a Raster,
    pub valid: &'a [f32],
    pub role: FrameRole,
}

fn clean_mask(raw: Vec<f32>, width: usize, height: usize) -> Raster {
    let inverted = Raster::from_data(width, height, 1, raw.iter().map(|v| 1.0 - v).collect());
    let mut opened = max_filter(&inverted, 1);
    opened.data.iter_mut().for_each(|v| *v = 1.0 - *v);
    let dilated = max_filter(&opened, GHOST_SPREAD);
    let mut feathered = gaussian_blur(&dilated, GHOST_SPREAD as f32);
    feathered
        .data
        .iter_mut()
        .for_each(|v| *v = v.clamp(0.0, 1.0));
    feathered
}

pub fn ghost_masks(clip: f32, frames: &[PreviewFrame], reference: usize) -> Vec<Option<Raster>> {
    let mut masks: Vec<Option<Raster>> = (0..frames.len()).map(|_| None).collect();
    let (width, height) = (frames[0].image.width, frames[0].image.height);
    let mut order: Vec<usize> = (0..frames.len()).filter(|&k| k != reference).collect();
    order.sort_by(|&a, &b| {
        let distance = |k: usize| {
            (frames[k].role.exposure / frames[reference].role.exposure)
                .ln()
                .abs()
        };
        distance(a).total_cmp(&distance(b)).then(a.cmp(&b))
    });

    let mut accumulator = Accumulator::new(width, height);
    let base = &frames[reference];
    accumulator.add(clip, base.role, base.image, base.valid, None);
    let floor = NOISE_FLOOR * clip;

    for k in order {
        let frame = &frames[k];
        let estimate = gaussian_blur(&accumulator.estimate(), COMPARISON_BLUR);
        let radiance = gaussian_blur(frame.image, COMPARISON_BLUR);
        let level = levels(frame.image, clip, 2);
        let delta = floor / frame.role.exposure;
        let min_support = 1e-3 * frame.role.exposure.min(base.role.exposure);
        let raw: Vec<f32> = (0..width * height)
            .into_par_iter()
            .map(|i| {
                let comparable = frame.valid[i] >= 1.0
                    && accumulator.denominator[i] > min_support
                    && contributes(frame.role, level.data[i]);
                let ghost = comparable
                    && (0..3).any(|c| {
                        let measured = radiance.data[i * 3 + c] / frame.role.exposure;
                        ((measured + delta) / (estimate.data[i * 3 + c] + delta))
                            .ln()
                            .abs()
                            > GHOST_THRESHOLD
                    });
                if ghost { 1.0 } else { 0.0 }
            })
            .collect();
        let mask = clean_mask(raw, width, height);
        accumulator.add(clip, frame.role, frame.image, frame.valid, Some(&mask));
        masks[k] = Some(mask);
    }
    masks
}

pub fn exposure_ratio(
    clip: f32,
    darker: (&Raster, &[f32]),
    brighter: (&Raster, &[f32]),
) -> Option<f64> {
    let floor = 4.0 * NOISE_FLOOR * clip;
    let dark_level = levels(darker.0, clip, 1);
    let bright_level = levels(brighter.0, clip, 1);
    let mut ratios: Vec<f32> = (0..darker.1.len())
        .into_par_iter()
        .filter_map(|i| {
            if darker.1[i] < 1.0 || brighter.1[i] < 1.0 {
                return None;
            }
            if dark_level.data[i] >= KNEE.0 || bright_level.data[i] >= KNEE.0 {
                return None;
            }
            let yd = luminance(darker.0.pixel_at(i));
            let yb = luminance(brighter.0.pixel_at(i));
            (yd > floor && yb > 0.0).then(|| (yb / yd).ln())
        })
        .collect();
    if ratios.len() < MIN_RATIO_SAMPLES {
        return None;
    }
    let middle = ratios.len() / 2;
    let (_, median, _) = ratios.select_nth_unstable_by(middle, |a, b| a.total_cmp(b));
    Some((*median as f64).exp())
}
