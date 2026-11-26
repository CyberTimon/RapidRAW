use crate::merge::raster::{Raster, convolve_row, gaussian_kernel};
use rayon::prelude::*;

const BAND_SIGMA: f32 = 1.5;
const STRIP_ROWS: usize = 32;
const BINS: usize = 30;
const LOWEST_STOP: f32 = -14.0;
const STOP_STEP: f32 = 0.5;
const SAMPLE_STEP: usize = 3;
const MIN_BIN_SAMPLES: usize = 300;
const QUARTILE: f32 = 0.25;
const QUARTILE_SIGMAS: f32 = 0.3186;
const SIGMA_FLOOR: f32 = 1e-6;

pub type Table = [[f32; BINS]; 3];

fn bin_position(value: f32) -> f32 {
    (value.max(1e-12).log2() - LOWEST_STOP) / STOP_STEP - 0.5
}

fn bin_of(value: f32) -> usize {
    (bin_position(value) + 0.5).clamp(0.0, (BINS - 1) as f32) as usize
}

pub struct Bands<'a> {
    pub reference: &'a [f32],
    pub low: &'a [f32],
    pub difference: &'a [f32],
}

pub fn for_band_rows<R: Send>(
    reference: &Raster,
    aligned: &Raster,
    rows: impl Fn(usize) -> bool + Sync,
    visit: impl Fn(usize, Bands) -> R + Sync,
) -> Vec<R> {
    assert_eq!(reference.channels, 3, "burst frames are RGB");
    let (width, height) = (reference.width, reference.height);
    let kernel = gaussian_kernel(BAND_SIGMA);
    let radius = kernel.len() / 2;
    let stride = width * 3;
    let difference_of = |y: usize, out: &mut [f32]| {
        let span = y * stride..(y + 1) * stride;
        for ((d, a), r) in out
            .iter_mut()
            .zip(&aligned.data[span.clone()])
            .zip(&reference.data[span])
        {
            *d = a - r;
        }
    };
    (0..height.div_ceil(STRIP_ROWS))
        .into_par_iter()
        .flat_map_iter(|strip| {
            let y0 = strip * STRIP_ROWS;
            let y1 = (y0 + STRIP_ROWS).min(height);
            let wanted: Vec<usize> = (y0..y1).filter(|&y| rows(y)).collect();
            if wanted.is_empty() {
                return Vec::new().into_iter();
            }
            let top = y0.saturating_sub(radius);
            let bottom = (y1 + radius).min(height);
            let mut smooth_reference = vec![0.0f32; (bottom - top) * stride];
            let mut smooth_difference = vec![0.0f32; (bottom - top) * stride];
            let mut difference = vec![0.0f32; stride];
            for y in top..bottom {
                let local = (y - top) * stride..(y - top + 1) * stride;
                convolve_row(
                    &reference.data[y * stride..(y + 1) * stride],
                    &mut smooth_reference[local.clone()],
                    width,
                    3,
                    &kernel,
                );
                difference_of(y, &mut difference);
                convolve_row(
                    &difference,
                    &mut smooth_difference[local],
                    width,
                    3,
                    &kernel,
                );
            }
            let mut reference_row = vec![0.0f32; stride];
            let mut low_row = vec![0.0f32; stride];
            wanted
                .into_iter()
                .map(|y| {
                    reference_row.fill(0.0);
                    low_row.fill(0.0);
                    for (k, weight) in kernel.iter().enumerate() {
                        let sy = (y + k).saturating_sub(radius).min(height - 1) - top;
                        let span = sy * stride..(sy + 1) * stride;
                        for ((r, d), (sr, sd)) in
                            reference_row.iter_mut().zip(low_row.iter_mut()).zip(
                                smooth_reference[span.clone()]
                                    .iter()
                                    .zip(&smooth_difference[span]),
                            )
                        {
                            *r += weight * sr;
                            *d += weight * sd;
                        }
                    }
                    difference_of(y, &mut difference);
                    visit(
                        y,
                        Bands {
                            reference: &reference_row,
                            low: &low_row,
                            difference: &difference,
                        },
                    )
                })
                .collect::<Vec<_>>()
                .into_iter()
        })
        .collect()
}

fn monotone(values: &[(f32, f32)]) -> Vec<f32> {
    let mut blocks: Vec<(f32, f32, usize)> = Vec::new();
    for &(value, weight) in values {
        blocks.push((value * weight, weight, 1));
        while blocks.len() > 1 {
            let (sum, weight, count) = blocks[blocks.len() - 1];
            let previous = blocks[blocks.len() - 2];
            if previous.0 / previous.1 <= sum / weight {
                break;
            }
            blocks.pop();
            let last = blocks.last_mut().unwrap();
            *last = (last.0 + sum, last.1 + weight, last.2 + count);
        }
    }
    blocks
        .into_iter()
        .flat_map(|(sum, weight, count)| std::iter::repeat_n(sum / weight, count))
        .collect()
}

fn fit_table(mut bins: Vec<Vec<f32>>) -> Option<Table> {
    let mut table = [[0.0f32; BINS]; 3];
    for (c, channel) in table.iter_mut().enumerate() {
        let measured: Vec<(usize, f32, f32)> = (0..BINS)
            .filter_map(|bin| {
                let values = &mut bins[c * BINS + bin];
                if values.len() < MIN_BIN_SAMPLES {
                    return None;
                }
                let index = ((values.len() - 1) as f32 * QUARTILE) as usize;
                let (_, quartile, _) = values.select_nth_unstable_by(index, |a, b| a.total_cmp(b));
                let estimate = (*quartile / QUARTILE_SIGMAS).max(SIGMA_FLOOR);
                Some((bin, estimate.ln(), (values.len() as f32).sqrt()))
            })
            .collect();
        if measured.is_empty() {
            return None;
        }
        let fitted = monotone(&measured.iter().map(|&(_, v, w)| (v, w)).collect::<Vec<_>>());
        for (bin, value) in channel.iter_mut().enumerate() {
            let nearest = measured
                .iter()
                .zip(&fitted)
                .min_by_key(|((at, _, _), _)| at.abs_diff(bin))
                .map(|(_, &f)| f)
                .unwrap();
            *value = nearest.exp();
        }
        for k in 0..measured.len().saturating_sub(1) {
            let (a, b) = (measured[k].0, measured[k + 1].0);
            for (step, value) in channel[a + 1..b].iter_mut().enumerate() {
                let t = (step + 1) as f32 / (b - a) as f32;
                *value = (fitted[k] + (fitted[k + 1] - fitted[k]) * t).exp();
            }
        }
    }
    Some(table)
}

pub fn lookup(table: &Table, channel: usize, value: f32) -> f32 {
    let position = bin_position(value).clamp(0.0, (BINS - 1) as f32);
    let low = position.floor() as usize;
    let high = (low + 1).min(BINS - 1);
    let t = position - low as f32;
    let row = &table[channel];
    row[low] + (row[high] - row[low]) * t
}

#[derive(Clone, Copy)]
pub struct NoiseModel {
    pub low: Table,
    pub detail: Table,
}

impl NoiseModel {
    pub fn estimate(reference: &Raster, aligned: &Raster, valid: &[f32]) -> Option<Self> {
        let width = reference.width;
        let rows = for_band_rows(
            reference,
            aligned,
            |y| y % SAMPLE_STEP == 0,
            |y, bands| {
                let mut samples: Vec<(u8, f32, f32)> = Vec::new();
                for x in (0..width).step_by(SAMPLE_STEP) {
                    if valid[y * width + x] < 1.0 {
                        continue;
                    }
                    for c in 0..3 {
                        let i = x * 3 + c;
                        let slot = (c * BINS + bin_of(bands.reference[i])) as u8;
                        let low = bands.low[i];
                        samples.push((slot, low.abs(), (bands.difference[i] - low).abs()));
                    }
                }
                samples
            },
        );
        let mut low = vec![Vec::new(); 3 * BINS];
        let mut detail = vec![Vec::new(); 3 * BINS];
        for samples in rows {
            for (slot, l, d) in samples {
                low[slot as usize].push(l);
                detail[slot as usize].push(d);
            }
        }
        Some(NoiseModel {
            low: fit_table(low)?,
            detail: fit_table(detail)?,
        })
    }

    pub fn combine(estimates: Vec<NoiseModel>) -> Option<NoiseModel> {
        if estimates.is_empty() {
            return None;
        }
        let pick = (estimates.len() - 1) / 2;
        let combined = |table: fn(&NoiseModel) -> &Table| {
            let mut out = [[0.0f32; BINS]; 3];
            for (c, channel) in out.iter_mut().enumerate() {
                for (bin, value) in channel.iter_mut().enumerate() {
                    let mut values: Vec<f32> = estimates.iter().map(|e| table(e)[c][bin]).collect();
                    values.sort_by(f32::total_cmp);
                    *value = values[pick];
                }
            }
            out
        };
        Some(NoiseModel {
            low: combined(|e| &e.low),
            detail: combined(|e| &e.detail),
        })
    }
}
