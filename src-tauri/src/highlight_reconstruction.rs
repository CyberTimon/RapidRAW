use rayon::prelude::*;

const CLIP_THRESHOLD: f32 = 0.985;
const SOFT_THRESHOLD: f32 = 0.90;
const MIN_SAMPLE_LEVEL: f32 = 0.2;
const BORDER_EXCLUSION: usize = 2;
const SAMPLE_BAND_PX: usize = 24;
const ITERATIONS: usize = 3;
const FULL_CLIP_CHROMA: f32 = 0.35;
const HEADROOM_FADE: f32 = 0.3;
const FILL_SUPPORT_DIVISOR: f32 = 28.0;
const FILL_SPREAD_START: f32 = 0.25;
const FILL_SPREAD_END: f32 = 0.6;
const FILL_STRENGTH: f32 = 0.5;
const FILL_SAMPLE_SPREAD: f32 = 0.25;
const LEVEL_BINS: usize = 2048;
const LEVEL_LOW: f32 = 0.75;
const LEVEL_HIGH: f32 = 1.25;
const PLATEAU_RATIO: f32 = 8.0;
const PLATEAU_SHARE: usize = 5000;

#[derive(Clone, Copy)]
pub struct Region {
    pub stride: usize,
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

impl Region {
    #[inline]
    fn row<'a>(&self, data: &'a [[f32; 3]], y: usize) -> &'a [[f32; 3]] {
        let start = (self.y + y) * self.stride + self.x;
        &data[start..start + self.width]
    }
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
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
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

pub fn detect_clip_levels(data: &[[f32; 3]], region: Region, scale: f32) -> [f32; 3] {
    let bins_per_unit = LEVEL_BINS as f32 / (LEVEL_HIGH - LEVEL_LOW);
    let histogram = (0..region.height)
        .into_par_iter()
        .fold(
            || vec![[0u32; 3]; LEVEL_BINS],
            |mut histogram, y| {
                for p in region.row(data, y) {
                    for c in 0..3 {
                        let bin = (p[c] * scale - LEVEL_LOW) * bins_per_unit;
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

    let min_count = (region.width * region.height / PLATEAU_SHARE).max(64) as u32;
    let plateaus: [Option<f32>; 3] = std::array::from_fn(|c| {
        let counts: Vec<u32> = histogram.iter().map(|bin| bin[c]).collect();
        let (peak, &count) = counts.iter().enumerate().max_by_key(|&(_, &n)| n)?;
        if count < min_count || peak < 80 {
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

pub fn reconstruct_highlights(data: &mut [[f32; 3]], region: Region, clips: [f32; 3]) {
    let Region { width, height, .. } = region;
    if width < 4
        || height < 4
        || region.x + width > region.stride
        || data.len() < (region.y + height) * region.stride
    {
        return;
    }

    let thresholds = clips.map(|c| c * CLIP_THRESHOLD);
    let soft_starts = clips.map(|c| c * SOFT_THRESHOLD);
    let mut mask = vec![0u8; width * height];
    mask.par_chunks_exact_mut(width)
        .enumerate()
        .for_each(|(y, mask_row)| {
            for (m, p) in mask_row.iter_mut().zip(region.row(data, y)) {
                *m = (p[0] >= thresholds[0]) as u8
                    | (((p[1] >= thresholds[1]) as u8) << 1)
                    | (((p[2] >= thresholds[2]) as u8) << 2);
            }
        });
    if !mask.par_iter().any(|&m| m != 0) {
        return;
    }

    let cell = (width.max(height) / 1024).clamp(1, 8);
    let offsets = inpaint_offsets(data, region, &mask, cell, clips, thresholds);

    let inv_cell = 1.0 / cell as f32;
    let blown: Vec<Vec<(usize, [f32; 3], f32)>> = data
        .par_chunks_exact_mut(region.stride)
        .skip(region.y)
        .take(height)
        .zip(mask.par_chunks_exact(width))
        .enumerate()
        .map(|(y, (row, mask_row))| {
            let mut blown = Vec::new();
            let row = &mut row[region.x..region.x + width];
            let gy = (y as f32 + 0.5) * inv_cell - 0.5;
            for (x, (pixel, &bits)) in row.iter_mut().zip(mask_row).enumerate() {
                let observed = *pixel;
                let blend: [f32; 3] =
                    std::array::from_fn(|c| smoothstep(soft_starts[c], thresholds[c], observed[c]));
                if blend.iter().all(|&b| b == 0.0) {
                    continue;
                }
                let full = blend[0].min(blend[1]).min(blend[2]);
                if full > 0.0 {
                    blown.push((x, observed, full));
                }

                let gx = (x as f32 + 0.5) * inv_cell - 0.5;
                let offset = offsets.sample(gx, gy);
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

                let headroom = (0..3)
                    .filter(|&c| bits & (1 << c) == 0)
                    .map(|c| 1.0 - observed[c] / clips[c])
                    .fold(0.0f32, f32::max);
                let keep = FULL_CLIP_CHROMA
                    + (1.0 - FULL_CLIP_CHROMA) * smoothstep(0.0, HEADROOM_FADE, headroom);
                let mean = (pixel[0] + pixel[1] + pixel[2]) / 3.0;
                for c in 0..3 {
                    if blend[c] > 0.0 {
                        let faded = observed[c].max(mean + (pixel[c] - mean) * keep);
                        pixel[c] = observed[c] + (faded - observed[c]) * blend[c];
                    }
                }
            }
            blown
        })
        .collect();

    if blown.iter().any(|row| !row.is_empty()) {
        fill_blown(data, region, &mask, &blown, cell);
    }
}

fn fill_blown(
    data: &mut [[f32; 3]],
    region: Region,
    mask: &[u8],
    blown: &[Vec<(usize, [f32; 3], f32)>],
    cell: usize,
) {
    let Region { width, height, .. } = region;
    let mut blown_mask = vec![0u8; width * height];
    blown_mask
        .par_chunks_exact_mut(width)
        .zip(blown.par_iter())
        .for_each(|(row, pixels)| {
            for &(x, _, _) in pixels {
                row[x] = 1;
            }
        });
    let near_blown = dilate(&blown_mask, width, height, BORDER_EXCLUSION);

    let gw = width.div_ceil(cell);
    let gh = height.div_ceil(cell);
    let mut blown_cells = vec![0u8; gw * gh];
    blown_cells
        .par_chunks_exact_mut(gw)
        .enumerate()
        .for_each(|(gy, cells)| {
            for y in gy * cell..((gy + 1) * cell).min(height) {
                for (x, &m) in blown_mask[y * width..(y + 1) * width].iter().enumerate() {
                    cells[x / cell] |= m;
                }
            }
        });
    let band = dilate(&blown_cells, gw, gh, SAMPLE_BAND_PX.div_ceil(cell));

    let samples: &[[f32; 3]] = data;
    let mut base = vec![Cell::default(); gw * gh];
    base.par_chunks_exact_mut(gw)
        .zip(band.par_chunks_exact(gw))
        .enumerate()
        .for_each(|(gy, (cells, band_row))| {
            if band_row.iter().all(|&b| b == 0) {
                return;
            }
            for y in gy * cell..((gy + 1) * cell).min(height) {
                let start = y * width;
                let pixels = region.row(samples, y);
                for x in 0..width {
                    let i = start + x;
                    let p = &pixels[x];
                    if band_row[x / cell] == 0
                        || mask[i].count_ones() != 1
                        || near_blown[i] != 0
                        || p[0] <= 0.0
                        || p[1] <= 0.0
                        || p[2] <= 0.0
                    {
                        continue;
                    }
                    let rg = (p[0] / p[1]).ln();
                    let bg = (p[2] / p[1]).ln();
                    let spread = (rg.max(bg).max(0.0) - rg.min(bg).min(0.0)) / FILL_SAMPLE_SPREAD;
                    let w = 1.0 / (1.0 + spread * spread);
                    let target = &mut cells[x / cell];
                    target.weight[0] += w;
                    target.weight[1] += w;
                    target.offset[0] += w * rg;
                    target.offset[1] += w * bg;
                }
            }
        });
    let support = width.max(height) as f32 / FILL_SUPPORT_DIVISOR;
    let chroma = push_pull(base, gw, gh, 0.5 * support * support);

    let inv_cell = 1.0 / cell as f32;
    data.par_chunks_exact_mut(region.stride)
        .skip(region.y)
        .take(height)
        .zip(blown.par_iter())
        .enumerate()
        .for_each(|(y, (row, pixels))| {
            let row = &mut row[region.x..region.x + width];
            let gy = (y as f32 + 0.5) * inv_cell - 0.5;
            for &(x, observed, full) in pixels {
                let gx = (x as f32 + 0.5) * inv_cell - 0.5;
                let [rg, bg, _] = chroma.sample(gx, gy);
                let spread = rg.max(bg).max(0.0) - rg.min(bg).min(0.0);
                let strength =
                    FILL_STRENGTH * (1.0 - smoothstep(FILL_SPREAD_START, FILL_SPREAD_END, spread));
                let tint = [(rg * strength).exp(), 1.0, (bg * strength).exp()];
                let pixel = &mut row[x];
                let brightness = (pixel[0] + pixel[1] + pixel[2]) / (tint[0] + tint[1] + tint[2]);
                let scale = (0..3)
                    .map(|c| observed[c] / tint[c])
                    .fold(brightness, f32::max);
                for c in 0..3 {
                    pixel[c] += (scale * tint[c] - pixel[c]) * full;
                }
            }
        });
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

fn inpaint_offsets(
    data: &[[f32; 3]],
    region: Region,
    mask: &[u8],
    cell: usize,
    clips: [f32; 3],
    thresholds: [f32; 3],
) -> Grid {
    let Region { width, height, .. } = region;
    let near_clip = dilate(mask, width, height, BORDER_EXCLUSION);
    let lo = clips.map(|c| c * MIN_SAMPLE_LEVEL);
    let inv_clips = clips.map(|c| 1.0 / c);

    let gw = width.div_ceil(cell);
    let gh = height.div_ceil(cell);

    let mut clipped_cells = vec![0u8; gw * gh];
    clipped_cells
        .par_chunks_exact_mut(gw)
        .enumerate()
        .for_each(|(gy, clipped)| {
            for y in gy * cell..((gy + 1) * cell).min(height) {
                for (x, &m) in mask[y * width..(y + 1) * width].iter().enumerate() {
                    clipped[x / cell] |= m;
                }
            }
        });

    let band = dilate(&clipped_cells, gw, gh, SAMPLE_BAND_PX.div_ceil(cell));

    let mut base = vec![Cell::default(); gw * gh];
    base.par_chunks_exact_mut(gw)
        .zip(band.par_chunks_exact(gw))
        .enumerate()
        .for_each(|(gy, (cells, band_row))| {
            if band_row.iter().all(|&b| b == 0) {
                return;
            }
            for y in gy * cell..((gy + 1) * cell).min(height) {
                let start = y * width;
                let pixels = region.row(data, y);
                for (gx, (target, &channels)) in cells.iter_mut().zip(band_row).enumerate() {
                    if channels == 0 {
                        continue;
                    }
                    for x in gx * cell..((gx + 1) * cell).min(width) {
                        let p = &pixels[x];
                        let usable = channels & !near_clip[start + x];
                        let mut roots = None;
                        for c in 0..3 {
                            if usable & (1 << c) == 0 || p[c] <= lo[c] || p[c] >= thresholds[c] {
                                continue;
                            }
                            let roots = roots.get_or_insert_with(|| p.map(cube_root));
                            let level = p[c] * inv_clips[c];
                            let w = level * level;
                            target.weight[c] += w;
                            target.offset[c] += w * (p[c] - opposed(roots, c));
                        }
                    }
                }
            }
        });

    push_pull(base, gw, gh, 0.25 * (cell * cell) as f32)
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
