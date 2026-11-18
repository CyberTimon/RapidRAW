use image::Rgb32FImage;
use rayon::prelude::*;

use super::{Camera, FILL_SUPPORT_DIVISOR, Finish, PLATEAU_SHARE, SAMPLE_BAND_PX};
use crate::render::color_space::{fit_gamut, working_luma};
use crate::render::geometry::oriented_rgb32f;

const CLIP_THRESHOLD: f32 = 0.985;
const SOFT_THRESHOLD: f32 = 0.90;
const MIN_SAMPLE_LEVEL: f32 = 0.2;
const ITERATIONS: usize = 3;
const FULL_CLIP_CHROMA: f32 = 0.35;
const HEADROOM_FADE: f32 = 0.3;
const FILL_SPREAD_START: f32 = 0.25;
const FILL_SPREAD_END: f32 = 0.6;
const FILL_STRENGTH: f32 = 0.5;
const FILL_SAMPLE_SPREAD: f32 = 0.25;
const LEVEL_BINS: usize = 2048;
const LEVEL_LOW: f32 = 0.75;
const LEVEL_HIGH: f32 = 1.25;
const PLATEAU_RATIO: f32 = 8.0;
const BLOWN: u8 = 8;
const FLOOR: f32 = 0.002;
const PAD: usize = 2;
const CHUNK: usize = 64;

pub(super) fn finish(
    data: &[[f32; 3]],
    width: usize,
    height: usize,
    finish: &Finish,
) -> Rgb32FImage {
    let highlights = finish
        .camera
        .map(|camera| Highlights::new(data, width, height, camera));
    let mut image = oriented_rgb32f(width, height, finish.orientation, |x, y| {
        let observed = data[y * width + x];
        highlights
            .as_ref()
            .map_or(observed, |highlights| highlights.developed(x, y, observed))
    });

    let luma =
        (finish.denoise > 0.0).then(|| reduce_chroma_noise(&mut image, finish.denoise.min(1.0)));
    if finish.sharpen > 0.0 {
        let luma = luma.unwrap_or_else(|| sqrt_luma_plane(&image));
        sharpen(&mut image, &luma, finish.sharpen);
    }
    image
}

#[derive(Clone, Copy, Default)]
struct Cell {
    weight: [f32; 3],
    offset: [f32; 3],
}

struct Grid {
    width: usize,
    height: usize,
    data: Vec<[f32; 3]>,
}

impl Grid {
    #[inline]
    fn sample(&self, x: f32, y: f32) -> [f32; 3] {
        let x = x.clamp(0.0, (self.width - 1) as f32);
        let y = y.clamp(0.0, (self.height - 1) as f32);
        let x0 = x as usize;
        let y0 = y as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let fx = x - x0 as f32;
        let fy = y - y0 as f32;
        let a = self.data[y0 * self.width + x0];
        let b = self.data[y0 * self.width + x1];
        let c = self.data[y1 * self.width + x0];
        let d = self.data[y1 * self.width + x1];
        std::array::from_fn(|i| {
            let top = a[i] + (b[i] - a[i]) * fx;
            let bottom = c[i] + (d[i] - c[i]) * fx;
            top + (bottom - top) * fy
        })
    }
}

#[inline]
fn ease(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn cube_root(v: f32) -> f32 {
    v.max(0.0).cbrt()
}

#[inline]
fn opposed(roots: &[f32; 3], c: usize) -> f32 {
    let m = 0.5 * (roots[(c + 1) % 3] + roots[(c + 2) % 3]);
    m * m * m
}

struct Highlights<'a> {
    data: &'a [[f32; 3]],
    width: usize,
    height: usize,
    camera: Camera,
    neutral: [f32; 3],
    clips: [f32; 3],
    thresholds: [f32; 3],
    softs: [f32; 3],
    cell: usize,
    offsets: Option<Grid>,
    chroma: Option<Grid>,
}

impl<'a> Highlights<'a> {
    fn new(data: &'a [[f32; 3]], width: usize, height: usize, camera: Camera) -> Self {
        let neutral = camera.wb.map(|c| 1.0 / c);
        let levels = clip_levels(
            data,
            neutral,
            (width * height / PLATEAU_SHARE as usize).max(64),
        );
        let clips: [f32; 3] = std::array::from_fn(|c| camera.wb[c] * levels[c]);
        let cell = (width.max(height) / 1024).clamp(1, 8);
        let mut highlights = Self {
            data,
            width,
            height,
            camera,
            neutral,
            clips,
            thresholds: clips.map(|c| c * CLIP_THRESHOLD),
            softs: clips.map(|c| c * SOFT_THRESHOLD),
            cell,
            offsets: None,
            chroma: None,
        };

        let gw = width.div_ceil(cell);
        let gh = height.div_ceil(cell);
        let mut cells = vec![0u8; gw * gh];
        cells
            .par_chunks_exact_mut(gw)
            .enumerate()
            .for_each(|(gy, row)| {
                for y in gy * cell..((gy + 1) * cell).min(height) {
                    for (x, p) in data[y * width..(y + 1) * width].iter().enumerate() {
                        let blown = if highlights.full_blend(*p) > 0.0 {
                            BLOWN
                        } else {
                            0
                        };
                        row[x / cell] |= highlights.mask_bits(*p) | blown;
                    }
                }
            });
        if cells.par_iter().all(|&bits| bits & 7 == 0) {
            return highlights;
        }
        let band = dilate(&cells, gw, gh, (SAMPLE_BAND_PX as usize).div_ceil(cell));

        let lo = clips.map(|c| c * MIN_SAMPLE_LEVEL);
        let base = highlights.gather(&band, gw, 7, |target, channels, x, y| {
            let p = data[y * width + x];
            let in_range = |c: usize| p[c] > lo[c] && p[c] < highlights.thresholds[c];
            let mut usable = channels & (0..3).fold(0, |bits, c| bits | (in_range(c) as u8) << c);
            if usable != 0 {
                usable &= !highlights.near_mask(x, y);
            }
            if usable == 0 {
                return;
            }
            let roots = p.map(cube_root);
            for c in (0..3).filter(|c| usable & (1 << c) != 0) {
                let level = p[c] * (1.0 / clips[c]);
                let w = level * level;
                target.weight[c] += w;
                target.offset[c] += w * (p[c] - opposed(&roots, c));
            }
        });
        highlights.offsets = Some(push_pull(base, gw, gh, 0.25 * (cell * cell) as f32));

        if cells.par_iter().any(|&bits| bits & BLOWN != 0) {
            let base = highlights.gather(&band, gw, BLOWN, |target, _, x, y| {
                let observed = data[y * width + x];
                if highlights.mask_bits(observed).count_ones() != 1 || highlights.near_blown(x, y) {
                    return;
                }
                let p = highlights.rebuild(x, y, observed);
                if p.iter().any(|&v| v <= 0.0) {
                    return;
                }
                let rg = (p[0] / p[1]).ln();
                let bg = (p[2] / p[1]).ln();
                let spread = (rg.max(bg).max(0.0) - rg.min(bg).min(0.0)) / FILL_SAMPLE_SPREAD;
                let w = 1.0 / (1.0 + spread * spread);
                target.weight[0] += w;
                target.weight[1] += w;
                target.offset[0] += w * rg;
                target.offset[1] += w * bg;
            });
            let support = width.max(height) as f32 / FILL_SUPPORT_DIVISOR;
            highlights.chroma = Some(push_pull(base, gw, gh, 0.5 * support * support));
        }
        highlights
    }

    fn gather(
        &self,
        band: &[u8],
        gw: usize,
        bits: u8,
        sample: impl Fn(&mut Cell, u8, usize, usize) + Sync,
    ) -> Vec<Cell> {
        let cell = self.cell;
        let mut base = vec![Cell::default(); band.len()];
        base.par_chunks_exact_mut(gw)
            .zip(band.par_chunks_exact(gw))
            .enumerate()
            .for_each(|(gy, (cells, band_row))| {
                for (gx, (target, &channels)) in cells.iter_mut().zip(band_row).enumerate() {
                    if channels & bits == 0 {
                        continue;
                    }
                    for y in gy * cell..((gy + 1) * cell).min(self.height) {
                        for x in gx * cell..((gx + 1) * cell).min(self.width) {
                            sample(target, channels, x, y);
                        }
                    }
                }
            });
        base
    }

    #[inline]
    fn mask_bits(&self, p: [f32; 3]) -> u8 {
        (0..3).fold(0, |bits, c| {
            bits | ((p[c] >= self.thresholds[c]) as u8) << c
        })
    }

    #[inline]
    fn blends(&self, p: [f32; 3]) -> [f32; 3] {
        std::array::from_fn(|c| ease(self.softs[c], self.thresholds[c], p[c]))
    }

    #[inline]
    fn full_blend(&self, p: [f32; 3]) -> f32 {
        if (0..3).any(|c| p[c] <= self.softs[c]) {
            return 0.0;
        }
        let blend = self.blends(p);
        blend[0].min(blend[1]).min(blend[2])
    }

    fn near(&self, x: usize, y: usize) -> impl Iterator<Item = [f32; 3]> + '_ {
        let rows = y.saturating_sub(2)..=(y + 2).min(self.height - 1);
        let columns = x.saturating_sub(2)..=(x + 2).min(self.width - 1);
        rows.flat_map(move |y| self.data[y * self.width..][columns.clone()].iter().copied())
    }

    fn near_mask(&self, x: usize, y: usize) -> u8 {
        self.near(x, y).fold(0, |bits, p| bits | self.mask_bits(p))
    }

    fn near_blown(&self, x: usize, y: usize) -> bool {
        self.near(x, y).any(|p| self.full_blend(p) > 0.0)
    }

    #[inline]
    fn cell_coord(&self, v: usize) -> f32 {
        (v as f32 + 0.5) / self.cell as f32 - 0.5
    }

    fn rebuild(&self, x: usize, y: usize, observed: [f32; 3]) -> [f32; 3] {
        let Some(offsets) = &self.offsets else {
            return observed;
        };
        if (0..3).all(|c| observed[c] <= self.softs[c]) {
            return observed;
        }
        let blend = self.blends(observed);
        let offset = offsets.sample(self.cell_coord(x), self.cell_coord(y));
        let mut pixel = observed;
        let mut roots = observed.map(cube_root);
        for iteration in 0..ITERATIONS {
            for c in 0..3 {
                if blend[c] > 0.0 {
                    let rebuilt = observed[c].max(opposed(&roots, c) + offset[c]);
                    pixel[c] = observed[c] + (rebuilt - observed[c]) * blend[c];
                }
            }
            if iteration + 1 < ITERATIONS {
                for c in 0..3 {
                    if blend[c] > 0.0 {
                        roots[c] = cube_root(pixel[c]);
                    }
                }
            }
        }

        let bits = self.mask_bits(observed);
        let headroom = (0..3)
            .filter(|&c| bits & (1 << c) == 0)
            .map(|c| 1.0 - observed[c] / self.clips[c])
            .fold(0.0f32, f32::max);
        let keep = FULL_CLIP_CHROMA + (1.0 - FULL_CLIP_CHROMA) * ease(0.0, HEADROOM_FADE, headroom);
        let mean = (pixel[0] + pixel[1] + pixel[2]) / 3.0;
        for c in 0..3 {
            if blend[c] > 0.0 {
                let faded = observed[c].max(mean + (pixel[c] - mean) * keep);
                pixel[c] = observed[c] + (faded - observed[c]) * blend[c];
            }
        }
        pixel
    }

    fn refill(&self, x: usize, y: usize, observed: [f32; 3], rebuilt: [f32; 3]) -> [f32; 3] {
        let Some(chroma) = &self.chroma else {
            return rebuilt;
        };
        let full = self.full_blend(observed);
        if full <= 0.0 {
            return rebuilt;
        }
        let [rg, bg, _] = chroma.sample(self.cell_coord(x), self.cell_coord(y));
        let spread = rg.max(bg).max(0.0) - rg.min(bg).min(0.0);
        let strength = FILL_STRENGTH * (1.0 - ease(FILL_SPREAD_START, FILL_SPREAD_END, spread));
        let tint = [(rg * strength).exp(), 1.0, (bg * strength).exp()];
        let brightness = (rebuilt[0] + rebuilt[1] + rebuilt[2]) / (tint[0] + tint[1] + tint[2]);
        let scale = (0..3)
            .map(|c| observed[c] / tint[c])
            .fold(brightness, f32::max);
        std::array::from_fn(|c| rebuilt[c] + (scale * tint[c] - rebuilt[c]) * full)
    }

    #[inline]
    fn developed(&self, x: usize, y: usize, observed: [f32; 3]) -> [f32; 3] {
        let p = self.refill(x, y, observed, self.rebuild(x, y, observed));
        let camera: [f32; 3] = std::array::from_fn(|c| p[c] * self.neutral[c]);
        let rgb = self
            .camera
            .matrix
            .map(|row| row[0] * camera[0] + row[1] * camera[1] + row[2] * camera[2]);
        fit_gamut(rgb, &self.camera.compression).map(|v| v.min(self.camera.clamp_limit))
    }
}

fn clip_levels(data: &[[f32; 3]], scale: [f32; 3], min_count: usize) -> [f32; 3] {
    let bins_per_unit = LEVEL_BINS as f32 / (LEVEL_HIGH - LEVEL_LOW);
    let histogram = data
        .par_chunks(1 << 16)
        .fold(
            || vec![[0u32; 3]; LEVEL_BINS],
            |mut histogram, pixels| {
                for p in pixels {
                    for c in 0..3 {
                        let bin = (p[c] * scale[c] - LEVEL_LOW) * bins_per_unit;
                        if bin >= 0.0 && bin < LEVEL_BINS as f32 {
                            histogram[bin as usize][c] += 1;
                        }
                    }
                }
                histogram
            },
        )
        .reduce(
            || vec![[0u32; 3]; LEVEL_BINS],
            |mut a, b| {
                for (x, y) in a.iter_mut().zip(&b) {
                    for c in 0..3 {
                        x[c] += y[c];
                    }
                }
                a
            },
        );

    let plateaus: [Option<f32>; 3] = std::array::from_fn(|c| {
        let counts: Vec<u32> = histogram.iter().map(|bin| bin[c]).collect();
        let (peak, &count) = counts.iter().enumerate().max_by_key(|&(_, &n)| n)?;
        if (count as usize) < min_count || peak < 80 {
            return None;
        }
        let mut below = counts[peak - 80..peak - 20].to_vec();
        below.sort_unstable();
        let baseline = below[below.len() / 2] as f32;
        let above: u32 = counts[(peak + 4).min(LEVEL_BINS)..].iter().sum();
        (count as f32 >= PLATEAU_RATIO * (baseline + 1.0) && above < count)
            .then(|| LEVEL_LOW + (peak as f32 + 0.5) / bins_per_unit)
    });

    let fallback = plateaus
        .iter()
        .flatten()
        .copied()
        .reduce(f32::min)
        .unwrap_or(1.0);
    plateaus.map(|level| level.unwrap_or(fallback))
}

fn dilate(mask: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut out = vec![0u8; mask.len()];
    out.par_chunks_exact_mut(width).enumerate().for_each_init(
        || vec![0u8; width],
        |vertical, (y, row)| {
            vertical.fill(0);
            for yy in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
                for (v, &m) in vertical.iter_mut().zip(&mask[yy * width..(yy + 1) * width]) {
                    *v |= m;
                }
            }
            for (x, o) in row.iter_mut().enumerate() {
                let x0 = x.saturating_sub(radius);
                let x1 = (x + radius).min(width - 1);
                *o = vertical[x0..=x1].iter().fold(0, |acc, &m| acc | m);
            }
        },
    );
    out
}

fn push_pull(base: Vec<Cell>, width: usize, height: usize, full_weight: f32) -> Grid {
    let mut levels = vec![(base, width, height)];
    loop {
        let (prev, pw, ph) = levels.last().unwrap();
        let (pw, ph) = (*pw, *ph);
        if pw == 1 && ph == 1 {
            break;
        }
        let nw = pw.div_ceil(2);
        let nh = ph.div_ceil(2);
        let mut next = vec![Cell::default(); nw * nh];
        next.par_chunks_exact_mut(nw)
            .enumerate()
            .for_each(|(y, row)| {
                for (x, out) in row.iter_mut().enumerate() {
                    for yy in (2 * y)..(2 * y + 2).min(ph) {
                        for xx in (2 * x)..(2 * x + 2).min(pw) {
                            let c = &prev[yy * pw + xx];
                            for i in 0..3 {
                                out.weight[i] += c.weight[i];
                                out.offset[i] += c.offset[i];
                            }
                        }
                    }
                }
            });
        levels.push((next, nw, nh));
    }

    let top = &levels.last().unwrap().0[0];
    let mut filled = Grid {
        width: 1,
        height: 1,
        data: vec![std::array::from_fn(|i| {
            if top.weight[i] > 0.0 {
                top.offset[i] / top.weight[i]
            } else {
                0.0
            }
        })],
    };

    for (cells, w, h) in levels.iter().rev().skip(1) {
        let (w, h) = (*w, *h);
        let scale_x = filled.width as f32 / w as f32;
        let scale_y = filled.height as f32 / h as f32;
        let mut next = vec![[0.0f32; 3]; w * h];
        next.par_chunks_exact_mut(w)
            .enumerate()
            .for_each(|(y, row)| {
                let sy = (y as f32 + 0.5) * scale_y - 0.5;
                for (x, out) in row.iter_mut().enumerate() {
                    let sx = (x as f32 + 0.5) * scale_x - 0.5;
                    let coarse = filled.sample(sx, sy);
                    let c = &cells[y * w + x];
                    for i in 0..3 {
                        out[i] = if c.weight[i] > 0.0 {
                            let alpha = (c.weight[i] / full_weight).min(1.0);
                            coarse[i] + (c.offset[i] / c.weight[i] - coarse[i]) * alpha
                        } else {
                            coarse[i]
                        };
                    }
                }
            });
        filled = Grid {
            width: w,
            height: h,
            data: next,
        };
    }
    filled
}

fn stabilize(rgb: [f32; 3], luma: [f32; 3]) -> (f32, f32, f32) {
    let l = luma[0] * rgb[0] + luma[1] * rgb[1] + luma[2] * rgb[2];
    let s = (l.max(0.0) + FLOOR).sqrt();
    (
        s,
        (rgb[0].max(0.0) + FLOOR).sqrt() - s,
        (rgb[2].max(0.0) + FLOOR).sqrt() - s,
    )
}

struct ChromaPlanes {
    q: Vec<f32>,
    cr: Vec<f32>,
    cb: Vec<f32>,
    w: usize,
    h: usize,
    noise_q: f32,
    noise_c: f32,
}

impl ChromaPlanes {
    fn new(w: usize, h: usize, sample: impl Fn(usize, usize) -> (f32, f32, f32) + Sync) -> Self {
        let pw = w + 2 * PAD;
        let ph = h + 2 * PAD;
        let mut q = vec![0.0f32; pw * ph];
        let mut cr = vec![0.0f32; pw * ph];
        let mut cb = vec![0.0f32; pw * ph];
        q.par_chunks_mut(pw)
            .zip(cr.par_chunks_mut(pw))
            .zip(cb.par_chunks_mut(pw))
            .enumerate()
            .for_each(|(py, ((q_row, cr_row), cb_row))| {
                let y = py.saturating_sub(PAD).min(h - 1);
                for px in 0..pw {
                    let x = px.saturating_sub(PAD).min(w - 1);
                    (q_row[px], cr_row[px], cb_row[px]) = sample(x, y);
                }
            });
        let noise_q = estimate_noise(pw, ph, &[&|i| q[i]]).max(1e-3);
        let noise_c = estimate_noise(pw, ph, &[&|i| cr[i], &|i| cb[i]]).max(1e-3);
        Self {
            q,
            cr,
            cb,
            w,
            h,
            noise_q,
            noise_c,
        }
    }

    fn from_rgb(src: &[f32], w: usize, h: usize, luma: [f32; 3]) -> Self {
        Self::new(w.div_ceil(2), h.div_ceil(2), |x, y| {
            let mut sum = [0.0f32; 3];
            for sy in [2 * y, (2 * y + 1).min(h - 1)] {
                for sx in [2 * x, (2 * x + 1).min(w - 1)] {
                    let i = (sy * w + sx) * 3;
                    for c in 0..3 {
                        sum[c] += src[i + c] * 0.25;
                    }
                }
            }
            stabilize(sum, luma)
        })
    }

    fn downsample(&self) -> Self {
        Self::new(self.w.div_ceil(2), self.h.div_ceil(2), |x, y| {
            let mut sum = (0.0, 0.0, 0.0);
            for sy in [2 * y, (2 * y + 1).min(self.h - 1)] {
                for sx in [2 * x, (2 * x + 1).min(self.w - 1)] {
                    let i = self.at(sx, sy);
                    sum.0 += self.q[i] * 0.25;
                    sum.1 += self.cr[i] * 0.25;
                    sum.2 += self.cb[i] * 0.25;
                }
            }
            sum
        })
    }

    fn stride(&self) -> usize {
        self.w + 2 * PAD
    }

    fn at(&self, x: usize, y: usize) -> usize {
        (y + PAD) * self.stride() + x + PAD
    }

    fn filter(
        &self,
        amount: f32,
        reference: Option<&(Vec<f32>, Vec<f32>)>,
    ) -> (Vec<f32>, Vec<f32>) {
        const R: usize = PAD;
        const D: usize = 2 * R + 1;

        let (w, h, pw) = (self.w, self.h, self.stride());
        let (q, cr, cb) = (&self.q, &self.cr, &self.cb);
        let luma_tol = (1.5 + 2.0 * amount) * self.noise_q;
        let chroma_tol = (2.0 + 3.0 * amount) * self.noise_c;
        let sigma = 1.5 + amount;
        let spatial: [f32; D * D] = std::array::from_fn(|k| {
            let dx = (k % D) as f32 - R as f32;
            let dy = (k / D) as f32 - R as f32;
            (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp()
        });
        let kq = 1.0 / (luma_tol * luma_tol);
        let kc = 1.0 / (chroma_tol * chroma_tol);
        let eps = luma_tol * luma_tol;
        let ph = h + 2 * R;
        let mut rel = vec![1.0f32; q.len()];
        let mut widen = vec![1.0f32; q.len()];
        rel.par_chunks_mut(pw)
            .zip(widen.par_chunks_mut(pw))
            .enumerate()
            .for_each(|(py, (rel_row, widen_row))| {
                if py == 0 || py + 1 >= ph {
                    return;
                }
                for px in 1..pw - 1 {
                    let i = py * pw + px;
                    let g = 0.5
                        * (q[i + 1] - q[i - 1])
                            .abs()
                            .max((q[i + pw] - q[i - pw]).abs());
                    let t = g / luma_tol;
                    rel_row[px] = 1.0 / (1.0 + t * t);
                    let f = 1.0 + 2.0 * t;
                    widen_row[px] = 1.0 / (f * f);
                }
            });

        let mut out_r = vec![0.0f32; w * h];
        let mut out_b = vec![0.0f32; w * h];
        out_r
            .par_chunks_mut(w)
            .zip(out_b.par_chunks_mut(w))
            .enumerate()
            .for_each(|(y, (row_r, row_b))| {
                let mut x0 = 0;
                while x0 < w {
                    let n = CHUNK.min(w - x0);
                    let at = |j: usize, i: usize| (y + j) * pw + x0 + i;
                    let c = at(R, R);
                    let qc = &q[c..c + n];
                    let wc = &widen[c..c + n];

                    let mut ref_r = [0.0f32; CHUNK];
                    let mut ref_b = [0.0f32; CHUNK];
                    if let Some((rr, rb)) = reference {
                        let o = y * w + x0;
                        ref_r[..n].copy_from_slice(&rr[o..o + n]);
                        ref_b[..n].copy_from_slice(&rb[o..o + n]);
                    } else {
                        let mut ref_w = [0.0f32; CHUNK];
                        for j in R - 1..=R + 1 {
                            for i in R - 1..=R + 1 {
                                let o = at(j, i);
                                let sp = spatial[j * D + i];
                                let (qs, crs, cbs, rs) =
                                    (&q[o..o + n], &cr[o..o + n], &cb[o..o + n], &rel[o..o + n]);
                                for k in 0..n {
                                    let d = qs[k] - qc[k];
                                    let t = (1.0 - d * d * kq * wc[k]).max(0.0);
                                    let wt = sp * rs[k] * t * t;
                                    ref_r[k] += wt * crs[k];
                                    ref_b[k] += wt * cbs[k];
                                    ref_w[k] += wt;
                                }
                            }
                        }
                        for k in 0..n {
                            let inv = 1.0 / ref_w[k];
                            ref_r[k] *= inv;
                            ref_b[k] *= inv;
                        }
                    }

                    let mut sw = [0.0f32; CHUNK];
                    let mut sd = [0.0f32; CHUNK];
                    let mut sdd = [0.0f32; CHUNK];
                    let mut sr = [0.0f32; CHUNK];
                    let mut sb = [0.0f32; CHUNK];
                    let mut sdr = [0.0f32; CHUNK];
                    let mut sdb = [0.0f32; CHUNK];
                    for j in 0..D {
                        for i in 0..D {
                            let o = at(j, i);
                            let sp = spatial[j * D + i];
                            let (qs, crs, cbs, rs) =
                                (&q[o..o + n], &cr[o..o + n], &cb[o..o + n], &rel[o..o + n]);
                            for k in 0..n {
                                let d = qs[k] - qc[k];
                                let er = crs[k] - ref_r[k];
                                let eb = cbs[k] - ref_b[k];
                                let t = (1.0 - (d * d * kq + (er * er + eb * eb) * kc) * wc[k])
                                    .max(0.0);
                                let wt = sp * rs[k] * t * t;
                                let wd = wt * d;
                                sw[k] += wt;
                                sd[k] += wd;
                                sdd[k] += wd * d;
                                sr[k] += wt * crs[k];
                                sb[k] += wt * cbs[k];
                                sdr[k] += wd * crs[k];
                                sdb[k] += wd * cbs[k];
                            }
                        }
                    }

                    for k in 0..n {
                        let (fr, fb) = if sw[k] > 1e-6 {
                            let inv = 1.0 / sw[k];
                            let md = sd[k] * inv;
                            let mr = sr[k] * inv;
                            let mb = sb[k] * inv;
                            let var = (sdd[k] * inv - md * md).max(0.0) + eps;
                            let slope_r = (sdr[k] * inv - mr * md) / var;
                            let slope_b = (sdb[k] * inv - mb * md) / var;
                            (mr - slope_r * md, mb - slope_b * md)
                        } else {
                            (ref_r[k], ref_b[k])
                        };
                        row_r[x0 + k] = fr;
                        row_b[x0 + k] = fb;
                    }
                    x0 += n;
                }
            });
        (out_r, out_b)
    }

    fn upsample_eps(&self, amount: f32) -> f32 {
        16.0 * ((1.5 + 2.0 * amount) * self.noise_q).powi(2)
    }

    fn upsample(
        &self,
        coarse: &ChromaPlanes,
        (cr, cb): &(Vec<f32>, Vec<f32>),
        amount: f32,
    ) -> (Vec<f32>, Vec<f32>) {
        let eps = self.upsample_eps(amount);
        let (w, cw) = (self.w, coarse.w);
        let mut out_r = vec![0.0f32; w * self.h];
        let mut out_b = vec![0.0f32; w * self.h];
        out_r
            .par_chunks_mut(w)
            .zip(out_b.par_chunks_mut(w))
            .enumerate()
            .for_each(|(y, (row_r, row_b))| {
                let rows = upsample_taps(y, coarse.h).map(|(ly, wy)| {
                    let o = coarse.at(0, ly);
                    (
                        &coarse.q[o..o + cw],
                        &cr[ly * cw..(ly + 1) * cw],
                        &cb[ly * cw..(ly + 1) * cw],
                        wy,
                    )
                });
                let q_row = &self.q[self.at(0, y)..self.at(0, y) + w];
                let mut x0 = 0;
                while x0 < w {
                    let n = CHUNK.min(w - x0);
                    let up = upsample_chunk(rows, &q_row[x0..x0 + n], x0, cw, eps);
                    row_r[x0..x0 + n].copy_from_slice(&up.r[..n]);
                    row_b[x0..x0 + n].copy_from_slice(&up.b[..n]);
                    x0 += n;
                }
            });
        (out_r, out_b)
    }

    fn core(
        &self,
        (mut fr, mut fb): (Vec<f32>, Vec<f32>),
        (rr, rb): &(Vec<f32>, Vec<f32>),
        amount: f32,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut mags: Vec<f32> = (0..fr.len())
            .step_by(7)
            .map(|i| (fr[i] - rr[i]).hypot(fb[i] - rb[i]))
            .collect();
        let mid = mags.len() / 2;
        let core = (*mags.select_nth_unstable_by(mid, f32::total_cmp).1 * (1.5 + amount)).max(1e-6);
        let texture = 4.0 * (0.5 + amount);
        let (w, pw) = (self.w, self.stride());
        fr.par_chunks_mut(w)
            .zip(fb.par_chunks_mut(w))
            .zip(rr.par_chunks(w).zip(rb.par_chunks(w)))
            .enumerate()
            .for_each(|(y, ((r, b), (ref_r, ref_b)))| {
                let rows: [&[f32]; 3] = std::array::from_fn(|j| {
                    let o = (y + PAD + j - 1) * pw + PAD;
                    &self.q[o - 1..o + w + 1]
                });
                for x in 0..w {
                    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
                    for row in rows {
                        for &v in &row[x..x + 3] {
                            lo = lo.min(v);
                            hi = hi.max(v);
                        }
                    }
                    let (er, eb) = (r[x] - ref_r[x], b[x] - ref_b[x]);
                    let keep = ((er * er + eb * eb).sqrt() / (core + texture * (hi - lo)) - 1.0)
                        .clamp(0.0, 1.0);
                    r[x] = ref_r[x] + er * keep;
                    b[x] = ref_b[x] + eb * keep;
                }
            });
        (fr, fb)
    }
}

type UpsampleRow<'a> = (&'a [f32], &'a [f32], &'a [f32], f32);

struct UpsampledChunk {
    r: [f32; CHUNK],
    b: [f32; CHUNK],
    q_range: [f32; CHUNK],
    r_min: [f32; CHUNK],
    r_max: [f32; CHUNK],
    b_min: [f32; CHUNK],
    b_max: [f32; CHUNK],
}

fn upsample_chunk(
    rows: [UpsampleRow; 2],
    qc: &[f32],
    x0: usize,
    cw: usize,
    eps: f32,
) -> UpsampledChunk {
    let n = qc.len().min(CHUNK);
    let mut out = UpsampledChunk {
        r: [0.0; CHUNK],
        b: [0.0; CHUNK],
        q_range: [0.0; CHUNK],
        r_min: [f32::MAX; CHUNK],
        r_max: [f32::MIN; CHUNK],
        b_min: [f32::MAX; CHUNK],
        b_max: [f32::MIN; CHUNK],
    };
    let mut q_min = [f32::MAX; CHUNK];
    let mut q_max = [f32::MIN; CHUNK];
    let mut sd = [0.0f32; CHUNK];
    let mut sdd = [0.0f32; CHUNK];
    let mut sdr = [0.0f32; CHUNK];
    let mut sdb = [0.0f32; CHUNK];
    for (q_row, r_row, b_row, wy) in rows {
        for side in 0..2 {
            let mut gq = [0.0f32; CHUNK];
            let mut gr = [0.0f32; CHUNK];
            let mut gb = [0.0f32; CHUNK];
            let mut gw = [0.0f32; CHUNK];
            for k in 0..n {
                let (lx, wx) = upsample_taps(x0 + k, cw)[side];
                gq[k] = q_row[lx];
                gr[k] = r_row[lx];
                gb[k] = b_row[lx];
                gw[k] = wy * wx;
            }
            for k in 0..n {
                let d = gq[k] - qc[k];
                let wd = gw[k] * d;
                out.r[k] += gw[k] * gr[k];
                out.b[k] += gw[k] * gb[k];
                sd[k] += wd;
                sdd[k] += wd * d;
                sdr[k] += wd * gr[k];
                sdb[k] += wd * gb[k];
                q_min[k] = q_min[k].min(gq[k]);
                q_max[k] = q_max[k].max(gq[k]);
                out.r_min[k] = out.r_min[k].min(gr[k]);
                out.r_max[k] = out.r_max[k].max(gr[k]);
                out.b_min[k] = out.b_min[k].min(gb[k]);
                out.b_max[k] = out.b_max[k].max(gb[k]);
            }
        }
    }
    for k in 0..n {
        let var = (sdd[k] - sd[k] * sd[k]).max(0.0) + eps;
        let slope_r = (sdr[k] - out.r[k] * sd[k]) / var;
        let slope_b = (sdb[k] - out.b[k] * sd[k]) / var;
        out.r[k] -= slope_r * sd[k];
        out.b[k] -= slope_b * sd[k];
        out.q_range[k] = q_max[k] - q_min[k];
    }
    out
}

fn upsample_taps(v: usize, n: usize) -> [(usize, f32); 2] {
    let i = (v / 2).min(n - 1);
    if v.is_multiple_of(2) {
        [(i.saturating_sub(1), 0.25), (i, 0.75)]
    } else {
        [(i, 0.75), ((i + 1).min(n - 1), 0.25)]
    }
}

fn reduce_chroma_noise(buffer: &mut Rgb32FImage, amount: f32) -> Vec<f32> {
    let w = buffer.width() as usize;
    let h = buffer.height() as usize;
    let luma = working_luma();
    let src = buffer.as_raw();

    let half = ChromaPlanes::from_rgb(src, w, h, luma);
    let quarter = half.downsample();
    let reference = half.upsample(&quarter, &quarter.filter(amount, None), amount);
    let (fr, fb) = half.core(half.filter(amount, Some(&reference)), &reference, amount);

    let pixel = |i: usize| stabilize([src[i * 3], src[i * 3 + 1], src[i * 3 + 2]], luma);
    let noise_c_full = estimate_noise(w, h, &[&|i| pixel(i).1, &|i| pixel(i).2]).max(1e-3);
    let eps = half.upsample_eps(amount);
    let edge_scale = 0.5 / eps.sqrt();
    let core = (2.0 + 2.0 * amount) * noise_c_full;
    let texture = 4.0 * (0.5 + amount);
    let (hw, hh) = (half.w, half.h);

    let mut q = vec![0.0f32; w * h];
    buffer
        .par_chunks_mut(w * 3)
        .zip(q.par_chunks_mut(w))
        .enumerate()
        .for_each(|(y, (row, q_row))| {
            let low_rows = upsample_taps(y, hh).map(|(ly, wy)| {
                let o = half.at(0, ly);
                (
                    &half.q[o..o + hw],
                    &fr[ly * hw..(ly + 1) * hw],
                    &fb[ly * hw..(ly + 1) * hw],
                    wy,
                )
            });
            for (cx, px) in row.chunks_mut(CHUNK * 3).enumerate() {
                let x0 = cx * CHUNK;
                let n = (px.len() / 3).min(CHUNK);
                let mut rgb = [[0.0f32; CHUNK]; 3];
                for k in 0..n {
                    for c in 0..3 {
                        rgb[c][k] = px[k * 3 + c];
                    }
                }
                let mut l = [0.0f32; CHUNK];
                let mut qc = [0.0f32; CHUNK];
                let mut cr = [0.0f32; CHUNK];
                let mut cb = [0.0f32; CHUNK];
                for k in 0..n {
                    let lk = luma[0] * rgb[0][k] + luma[1] * rgb[1][k] + luma[2] * rgb[2][k];
                    let s = (lk.max(0.0) + FLOOR).sqrt();
                    l[k] = lk;
                    qc[k] = s;
                    cr[k] = (rgb[0][k].max(0.0) + FLOOR).sqrt() - s;
                    cb[k] = (rgb[2][k].max(0.0) + FLOOR).sqrt() - s;
                }

                q_row[x0..x0 + n].copy_from_slice(&qc[..n]);
                let up = upsample_chunk(low_rows, &qc[..n], x0, hw, eps);

                for k in 0..n {
                    let er = cr[k] - up.r[k];
                    let eb = cb[k] - up.b[k];
                    let edge = up.q_range[k] * edge_scale;
                    let keep = ((er * er + eb * eb).sqrt() / (core + texture * up.q_range[k])
                        - 1.0)
                        .clamp(0.0, 1.0)
                        / (1.0 + edge * edge);
                    let nr = (up.r[k] + er * keep).max(up.r_min[k]).min(up.r_max[k]);
                    let nb = (up.b[k] + eb * keep).max(up.b_min[k]).min(up.b_max[k]);
                    let vr = (qc[k] + nr).max(0.0);
                    let vb = (qc[k] + nb).max(0.0);
                    let lk = l[k];
                    let dr = vr * vr - FLOOR - lk;
                    let db = vb * vb - FLOOR - lk;
                    let dg = -(luma[0] * dr + luma[2] * db) / luma[1];
                    let m = dr.min(dg).min(db);
                    let s = if lk + m < 0.0 { -lk / m } else { 1.0 };
                    let apply = |v: f32, orig: f32| if lk > 0.0 { v.max(0.0) } else { orig };
                    rgb[0][k] = apply(lk + dr * s, rgb[0][k]);
                    rgb[1][k] = apply(lk + dg * s, rgb[1][k]);
                    rgb[2][k] = apply(lk + db * s, rgb[2][k]);
                }
                for k in 0..n {
                    for c in 0..3 {
                        px[k * 3 + c] = rgb[c][k];
                    }
                }
            }
        });
    q
}

fn estimate_noise(w: usize, h: usize, channels: &[&(dyn Fn(usize) -> f32 + Sync)]) -> f32 {
    let mut diffs: Vec<f32> = (0..h)
        .into_par_iter()
        .step_by(8)
        .flat_map_iter(|y| {
            (0..w.saturating_sub(4)).step_by(7).flat_map(move |x| {
                let i = y * w + x;
                channels.iter().map(move |f| (f(i + 4) - f(i)).abs())
            })
        })
        .collect();
    if diffs.is_empty() {
        return 0.0;
    }
    let mid = diffs.len() / 2;
    let (_, median, _) = diffs.select_nth_unstable_by(mid, f32::total_cmp);
    *median * 1.4826 / std::f32::consts::SQRT_2
}

fn sqrt_luma_plane(buffer: &Rgb32FImage) -> Vec<f32> {
    let luma = working_luma();
    buffer
        .as_raw()
        .par_chunks_exact(3)
        .map(|p| ((luma[0] * p[0] + luma[1] * p[1] + luma[2] * p[2]).max(0.0) + FLOOR).sqrt())
        .collect()
}

fn sharpen(buffer: &mut Rgb32FImage, q: &[f32], amount: f32) {
    let w = buffer.width() as usize;
    let h = buffer.height() as usize;
    let row_at = |y: isize| {
        let y = y.clamp(0, h as isize - 1) as usize;
        &q[y * w..(y + 1) * w]
    };
    let blur_row = |y: usize, v: &mut [f32], out: &mut [f32]| {
        let r: [&[f32]; 5] = std::array::from_fn(|k| row_at(y as isize + k as isize - 2));
        for x in 0..w {
            v[x + 2] =
                (r[0][x] + r[4][x] + 4.0 * (r[1][x] + r[3][x]) + 6.0 * r[2][x]) * (1.0 / 16.0);
        }
        (v[0], v[1]) = (v[2], v[2]);
        (v[w + 2], v[w + 3]) = (v[w + 1], v[w + 1]);
        for x in 0..w {
            out[x] =
                (v[x] + v[x + 4] + 4.0 * (v[x + 1] + v[x + 3]) + 6.0 * v[x + 2]) * (1.0 / 16.0);
        }
    };

    let mut samples: Vec<f32> = (0..h)
        .into_par_iter()
        .step_by(16)
        .flat_map_iter(|y| {
            let (mut v, mut blur) = (vec![0.0f32; w + 4], vec![0.0f32; w]);
            blur_row(y, &mut v, &mut blur);
            let row = &q[y * w..(y + 1) * w];
            (0..w)
                .step_by(5)
                .map(|x| (row[x] - blur[x]).abs())
                .collect::<Vec<_>>()
        })
        .collect();
    if samples.is_empty() {
        return;
    }
    let mid = samples.len() / 2;
    let noise = *samples.select_nth_unstable_by(mid, f32::total_cmp).1 * 1.4826;
    let threshold = (1.5 * noise).powi(2).max(1e-12);
    let strength = 4.5 * amount;
    let taper = 0.3 / threshold.sqrt();

    buffer.par_chunks_mut(w * 3).enumerate().for_each_init(
        || {
            (
                vec![0.0f32; w + 4],
                vec![0.0f32; w],
                vec![0.0f32; w + 2],
                vec![0.0f32; w + 2],
            )
        },
        |(v, blur, lo, hi), (y, row)| {
            blur_row(y, v, blur);
            let r: [&[f32]; 3] = std::array::from_fn(|k| row_at(y as isize + k as isize - 1));
            for x in 0..w {
                lo[x + 1] = r[0][x].min(r[1][x]).min(r[2][x]);
                hi[x + 1] = r[0][x].max(r[1][x]).max(r[2][x]);
            }
            (lo[0], hi[0], lo[w + 1], hi[w + 1]) = (lo[1], hi[1], lo[w], hi[w]);
            let center = r[1];
            for (x, p) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let qc = center[x];
                let d = qc - blur[x];
                let d = d * d * d / (d * d + threshold);
                let d = d / (1.0 + d.abs() * taper);
                let min = lo[x].min(lo[x + 1]).min(lo[x + 2]);
                let max = hi[x].max(hi[x + 1]).max(hi[x + 2]);
                let delta = strength * d;
                let range = max - min;
                let up_room = max - qc + range * 0.15 + 0.004;
                let down_room = qc - min + range * 0.05 + 0.002;
                let up = delta.max(0.0);
                let down = (-delta).max(0.0) * 0.7;
                let qn = qc + up * up_room / (up_room + up) - down * down_room / (down_room + down);
                let l = qc * qc - FLOOR;
                let ln = (qn * qn - FLOOR).max(0.0);
                if l > 1e-6 {
                    let peak = p[0].max(p[1]).max(p[2]);
                    let mut ratio = ln / l;
                    if ratio > 1.0 && peak * ratio > 1.0 {
                        ratio = (1.0 / peak).max(1.0);
                    }
                    p.iter_mut().for_each(|c| *c *= ratio);
                } else {
                    p.iter_mut().for_each(|c| *c = (*c + ln - l).max(0.0));
                }
            }
        },
    );
}
