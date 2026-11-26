use super::camera::{Camera, Lens};
use crate::merge::raster::Raster;
use crate::render::color_space::luminance;
use nalgebra::{DMatrix, DVector, Vector2};
use rayon::prelude::*;

const SAMPLE_GRID: usize = 40;
const SAMPLE_RADIUS: isize = 1;
const MIN_LUMINANCE: f32 = 0.003;
const MAX_CHANNEL: f32 = 0.9;
const MAX_LOCAL_CONTRAST: f32 = 0.08;
const MIN_SAMPLES: usize = 60;
const NOISE_SIGMA: f64 = 0.05;
const GAIN_SIGMA: f64 = 0.5;
const VIGNETTING_SIGMA: f64 = 2.0;
const HUBER_THRESHOLD: f64 = 0.06;
const IRLS_ITERATIONS: usize = 5;
const MIN_VIGNETTING_FACTOR: f64 = 0.3;
const MAX_VIGNETTING_FACTOR: f64 = 1.1;

#[derive(Clone, Debug)]
pub struct Photometric {
    pub log_gains: Vec<[f32; 3]>,
    pub vignetting: [f32; 3],
}

struct Sample {
    a: usize,
    b: usize,
    vignetting_basis: [f64; 3],
    log_a: [f64; 3],
    log_b: [f64; 3],
}

impl Photometric {
    pub fn identity(count: usize) -> Self {
        Photometric {
            log_gains: vec![[0.0; 3]; count],
            vignetting: [0.0; 3],
        }
    }

    #[inline]
    pub fn correction(&self, image: usize, r2: f32) -> [f32; 3] {
        let v = self.vignetting;
        let falloff = r2 * (v[0] + r2 * (v[1] + r2 * v[2]));
        let g = self.log_gains[image];
        [
            (-g[0] - falloff).exp(),
            (-g[1] - falloff).exp(),
            (-g[2] - falloff).exp(),
        ]
    }
}

fn sample_patch(image: &Raster, x: f64, y: f64) -> Option<([f32; 3], f32)> {
    let cx = x.round() as isize;
    let cy = y.round() as isize;
    if cx - SAMPLE_RADIUS < 0
        || cy - SAMPLE_RADIUS < 0
        || cx + SAMPLE_RADIUS >= image.width as isize
        || cy + SAMPLE_RADIUS >= image.height as isize
    {
        return None;
    }
    let mut sum = [0.0f32; 3];
    let mut lum_min = f32::MAX;
    let mut lum_max = f32::MIN;
    let mut count = 0.0;
    for dy in -SAMPLE_RADIUS..=SAMPLE_RADIUS {
        for dx in -SAMPLE_RADIUS..=SAMPLE_RADIUS {
            let p = image.pixel((cx + dx) as usize, (cy + dy) as usize);
            for c in 0..3 {
                sum[c] += p[c];
            }
            let lum = luminance(p);
            lum_min = lum_min.min(lum);
            lum_max = lum_max.max(lum);
            count += 1.0;
        }
    }
    let mean = [sum[0] / count, sum[1] / count, sum[2] / count];
    Some((mean, (lum_max - lum_min) / luminance(&mean).max(1e-4)))
}

fn collect_samples(
    cameras: &[Camera],
    lens: &Lens,
    images: &[&Raster],
    a: usize,
    b: usize,
) -> Vec<Sample> {
    let (ca, cb) = (&cameras[a], &cameras[b]);
    let (ra, rb) = (ca.radius_norm(), cb.radius_norm());
    let mut samples = Vec::new();
    for gy in 0..SAMPLE_GRID {
        for gx in 0..SAMPLE_GRID {
            let p = Vector2::new(
                ((gx as f64 + 0.5) / SAMPLE_GRID as f64 - 0.5) * ca.width,
                ((gy as f64 + 0.5) / SAMPLE_GRID as f64 - 0.5) * ca.height,
            );
            let ray = ca.ray(lens, p);
            let Some(q) = cb.project(lens, &ray) else {
                continue;
            };
            if q.x.abs() > 0.48 * cb.width || q.y.abs() > 0.48 * cb.height {
                continue;
            }
            let (ax, ay) = ca.level_position(images[a], &p);
            let (bx, by) = cb.level_position(images[b], &q);
            let (Some((va, ka)), Some((vb, kb))) = (
                sample_patch(images[a], ax, ay),
                sample_patch(images[b], bx, by),
            ) else {
                continue;
            };
            let usable = |v: &[f32; 3], k: f32| {
                luminance(v) > MIN_LUMINANCE
                    && v.iter().all(|&c| c > 1e-5 && c < MAX_CHANNEL)
                    && k < MAX_LOCAL_CONTRAST
            };
            if !usable(&va, ka) || !usable(&vb, kb) {
                continue;
            }
            let r2_a = p.norm_squared() / (ra * ra);
            let r2_b = q.norm_squared() / (rb * rb);
            samples.push(Sample {
                a,
                b,
                vignetting_basis: [
                    r2_a - r2_b,
                    r2_a.powi(2) - r2_b.powi(2),
                    r2_a.powi(3) - r2_b.powi(3),
                ],
                log_a: [va[0].ln() as f64, va[1].ln() as f64, va[2].ln() as f64],
                log_b: [vb[0].ln() as f64, vb[1].ln() as f64, vb[2].ln() as f64],
            });
        }
    }
    samples
}

fn solve(
    samples: &[Sample],
    count: usize,
    with_vignetting: bool,
) -> Option<(Vec<[f64; 3]>, [f64; 3])> {
    let unknowns = count * 3 + if with_vignetting { 3 } else { 0 };
    let data_weight = 1.0 / (NOISE_SIGMA * NOISE_SIGMA);
    let mut weights = vec![[1.0f64; 3]; samples.len()];
    let mut solution = DVector::<f64>::zeros(unknowns);

    let mut per_image = vec![0usize; count];
    for s in samples {
        per_image[s.a] += 1;
        per_image[s.b] += 1;
    }

    for _ in 0..IRLS_ITERATIONS {
        let mut ata = DMatrix::<f64>::zeros(unknowns, unknowns);
        let mut atb = DVector::<f64>::zeros(unknowns);
        for (s, w) in samples.iter().zip(weights.iter()) {
            for (c, channel_weight) in w.iter().enumerate() {
                let v = &s.vignetting_basis;
                let full_row = [
                    (s.a * 3 + c, 1.0),
                    (s.b * 3 + c, -1.0),
                    (count * 3, v[0]),
                    (count * 3 + 1, v[1]),
                    (count * 3 + 2, v[2]),
                ];
                let row = &full_row[..if with_vignetting { 5 } else { 2 }];
                let rhs = s.log_a[c] - s.log_b[c];
                let weight = data_weight * channel_weight;
                for &(i, vi) in row {
                    atb[i] += weight * vi * rhs;
                    for &(j, vj) in row {
                        ata[(i, j)] += weight * vi * vj;
                    }
                }
            }
        }
        for (image, &n) in per_image.iter().enumerate() {
            let prior = (n.max(1) as f64) / (GAIN_SIGMA * GAIN_SIGMA);
            for c in 0..3 {
                ata[(image * 3 + c, image * 3 + c)] += prior;
            }
        }
        if with_vignetting {
            let prior = samples.len() as f64 / (VIGNETTING_SIGMA * VIGNETTING_SIGMA);
            for k in 0..3 {
                ata[(count * 3 + k, count * 3 + k)] += prior;
            }
        }
        solution = ata.cholesky()?.solve(&atb);

        for (s, w) in samples.iter().zip(weights.iter_mut()) {
            for c in 0..3 {
                let mut predicted = solution[s.a * 3 + c] - solution[s.b * 3 + c];
                if with_vignetting {
                    let base = count * 3;
                    let v = &s.vignetting_basis;
                    predicted += solution[base] * v[0]
                        + solution[base + 1] * v[1]
                        + solution[base + 2] * v[2];
                }
                let residual = (s.log_a[c] - s.log_b[c] - predicted).abs();
                w[c] = if residual <= HUBER_THRESHOLD {
                    1.0
                } else {
                    HUBER_THRESHOLD / residual
                };
            }
        }
    }

    let mut gains = vec![[0.0f64; 3]; count];
    for (image, gain) in gains.iter_mut().enumerate() {
        for c in 0..3 {
            gain[c] = solution[image * 3 + c];
        }
    }
    let vignetting = if with_vignetting {
        [
            solution[count * 3],
            solution[count * 3 + 1],
            solution[count * 3 + 2],
        ]
    } else {
        [0.0; 3]
    };
    Some((gains, vignetting))
}

fn vignetting_is_plausible(v: &[f64; 3]) -> bool {
    (0..=20).all(|i| {
        let r2 = (i as f64 / 20.0).powi(2);
        let factor = (r2 * (v[0] + r2 * (v[1] + r2 * v[2]))).exp();
        (MIN_VIGNETTING_FACTOR..=MAX_VIGNETTING_FACTOR).contains(&factor)
    })
}

pub fn estimate_photometric(
    cameras: &[Camera],
    lens: &Lens,
    images: &[&Raster],
    pairs: &[(usize, usize)],
) -> Photometric {
    let count = cameras.len();
    let samples: Vec<Sample> = pairs
        .par_iter()
        .flat_map_iter(|&(a, b)| {
            let mut s = collect_samples(cameras, lens, images, a, b);
            s.extend(collect_samples(cameras, lens, images, b, a));
            s
        })
        .collect();
    if samples.len() < MIN_SAMPLES {
        return Photometric::identity(count);
    }

    let vignetting_solution =
        solve(&samples, count, true).filter(|(_, v)| vignetting_is_plausible(v));
    let Some((mut gains, vignetting)) =
        vignetting_solution.or_else(|| solve(&samples, count, false))
    else {
        return Photometric::identity(count);
    };

    for c in 0..3 {
        let mean = gains.iter().map(|g| g[c]).sum::<f64>() / count as f64;
        gains.iter_mut().for_each(|g| g[c] -= mean);
    }
    Photometric {
        log_gains: gains
            .iter()
            .map(|g| [g[0] as f32, g[1] as f32, g[2] as f32])
            .collect(),
        vignetting: [
            vignetting[0] as f32,
            vignetting[1] as f32,
            vignetting[2] as f32,
        ],
    }
}
