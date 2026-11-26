use image::{GrayImage, RgbImage};
use rayon::prelude::*;

pub type Bounds = (usize, usize, usize, usize);

const NO_NEIGHBOR: u32 = u32::MAX;

#[inline]
fn pixel(image: &RgbImage, x: i64, y: i64) -> [f32; 3] {
    let x = x.clamp(0, image.width() as i64 - 1) as u32;
    let y = y.clamp(0, image.height() as i64 - 1) as u32;
    let p = image.get_pixel(x, y);
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

fn masked_pixels(mask: &GrayImage, bounds: Bounds) -> Vec<(u32, u32)> {
    let (min_x, max_x, min_y, max_y) = bounds;
    (min_y..=max_y)
        .into_par_iter()
        .flat_map_iter(|y| {
            (min_x..=max_x)
                .filter(move |&x| mask.get_pixel(x as u32, y as u32)[0] > 0)
                .map(move |x| (y as u32, x as u32))
        })
        .collect()
}

fn patch_canvas(
    image: &RgbImage,
    bounds: Bounds,
    fill: impl Fn(u32, u32) -> Option<[u8; 3]> + Sync,
) -> RgbImage {
    let (min_x, max_x, min_y, max_y) = bounds;
    let width = max_x - min_x + 1;
    let height = max_y - min_y + 1;
    let mut out = vec![0u8; width * height * 3];
    out.par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(row, chunk)| {
            let y = (min_y + row) as u32;
            for col in 0..width {
                let x = (min_x + col) as u32;
                let rgb = fill(x, y).unwrap_or_else(|| image.get_pixel(x, y).0);
                chunk[col * 3..col * 3 + 3].copy_from_slice(&rgb);
            }
        });
    RgbImage::from_raw(width as u32, height as u32, out).unwrap()
}

pub fn clone_patch(
    image: &RgbImage,
    mask: &GrayImage,
    bounds: Bounds,
    offset: (i32, i32),
) -> RgbImage {
    let w = image.width() as i64 - 1;
    let h = image.height() as i64 - 1;
    patch_canvas(image, bounds, |x, y| {
        (mask.get_pixel(x, y)[0] > 0).then(|| {
            let sx = (x as i64 + offset.0 as i64).clamp(0, w) as u32;
            let sy = (y as i64 + offset.1 as i64).clamp(0, h) as u32;
            image.get_pixel(sx, sy).0
        })
    })
}

struct Level {
    width: u32,
    height: u32,
    coords: Vec<(u32, u32)>,
    unknown: Vec<bool>,
    values: Vec<[f32; 3]>,
}

impl Level {
    fn find(&self, x: i64, y: i64) -> Option<usize> {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return None;
        }
        self.coords.binary_search(&(y as u32, x as u32)).ok()
    }
}

fn build_level(
    width: u32,
    height: u32,
    unknown_coords: Vec<(u32, u32)>,
    known_value: impl Fn(u32, u32) -> [f32; 3] + Sync,
) -> Level {
    let is_unknown = |y: u32, x: u32| unknown_coords.binary_search(&(y, x)).is_ok();

    let mut ring: Vec<(u32, u32)> = unknown_coords
        .par_iter()
        .flat_map_iter(|&(y, x)| {
            let mut candidates = Vec::with_capacity(4);
            if x > 0 {
                candidates.push((y, x - 1));
            }
            if x + 1 < width {
                candidates.push((y, x + 1));
            }
            if y > 0 {
                candidates.push((y - 1, x));
            }
            if y + 1 < height {
                candidates.push((y + 1, x));
            }
            candidates
                .into_iter()
                .filter(|&(ny, nx)| !is_unknown(ny, nx))
        })
        .collect();
    ring.par_sort_unstable();
    ring.dedup();

    let mut coords = Vec::with_capacity(unknown_coords.len() + ring.len());
    let mut unknown = Vec::with_capacity(coords.capacity());
    let (mut a, mut b) = (0, 0);
    while a < unknown_coords.len() || b < ring.len() {
        if b >= ring.len() || (a < unknown_coords.len() && unknown_coords[a] < ring[b]) {
            coords.push(unknown_coords[a]);
            unknown.push(true);
            a += 1;
        } else {
            coords.push(ring[b]);
            unknown.push(false);
            b += 1;
        }
    }

    let values = coords
        .par_iter()
        .zip(unknown.par_iter())
        .map(|(&(y, x), &is_unknown)| {
            if is_unknown {
                [0.0; 3]
            } else {
                known_value(x, y)
            }
        })
        .collect();

    Level {
        width,
        height,
        coords,
        unknown,
        values,
    }
}

fn relax(level: &mut Level, omega: f32, max_iterations: usize, tolerance: f32) {
    let cells: Vec<(u32, [u32; 4])> = (0..level.coords.len())
        .into_par_iter()
        .filter(|&i| level.unknown[i])
        .map(|i| {
            let (y, x) = level.coords[i];
            let (x, y) = (x as i64, y as i64);
            let neighbors = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
                .map(|(nx, ny)| level.find(nx, ny).map_or(NO_NEIGHBOR, |n| n as u32));
            (i as u32, neighbors)
        })
        .collect();
    let (red, black): (Vec<_>, Vec<_>) = cells.into_iter().partition(|&(i, _)| {
        let (y, x) = level.coords[i as usize];
        (x + y) % 2 == 0
    });

    for _ in 0..max_iterations {
        let mut max_delta = 0.0f32;
        for cells in [&red, &black] {
            let values = &level.values;
            let updates: Vec<([f32; 3], f32)> = cells
                .par_iter()
                .map(|&(i, neighbors)| {
                    let mut sum = [0.0f32; 3];
                    let mut count = 0.0f32;
                    for n in neighbors {
                        if n != NO_NEIGHBOR {
                            let v = values[n as usize];
                            sum[0] += v[0];
                            sum[1] += v[1];
                            sum[2] += v[2];
                            count += 1.0;
                        }
                    }
                    let current = values[i as usize];
                    if count == 0.0 {
                        return (current, 0.0);
                    }
                    let mut next = current;
                    let mut delta = 0.0f32;
                    for c in 0..3 {
                        next[c] = current[c] + omega * (sum[c] / count - current[c]);
                        delta = delta.max((next[c] - current[c]).abs());
                    }
                    (next, delta)
                })
                .collect();
            for (&(i, _), (value, delta)) in cells.iter().zip(updates) {
                level.values[i as usize] = value;
                max_delta = max_delta.max(delta);
            }
        }
        if max_delta < tolerance {
            break;
        }
    }
}

pub fn heal_patch(
    image: &RgbImage,
    mask: &GrayImage,
    bounds: Bounds,
    offset: (i32, i32),
) -> RgbImage {
    let (img_w, img_h) = image.dimensions();
    let (ox, oy) = (offset.0 as i64, offset.1 as i64);
    let difference = |x: i64, y: i64| {
        let dest = pixel(image, x, y);
        let src = pixel(image, x + ox, y + oy);
        [dest[0] - src[0], dest[1] - src[1], dest[2] - src[2]]
    };

    let mut levels = vec![build_level(
        img_w,
        img_h,
        masked_pixels(mask, bounds),
        |x, y| difference(x as i64, y as i64),
    )];

    while levels.len() < 12 {
        let fine = levels.last().unwrap();
        let unknown_count = fine.unknown.iter().filter(|&&u| u).count();
        if unknown_count <= 256 {
            break;
        }
        let scale = 1i64 << levels.len();
        let mut parents: Vec<(u32, u32)> = fine
            .coords
            .iter()
            .zip(&fine.unknown)
            .filter(|&(_, &u)| u)
            .map(|(&(y, x), _)| (y / 2, x / 2))
            .collect();
        parents.par_sort_unstable();
        parents.dedup();
        let width = fine.width.div_ceil(2);
        let height = fine.height.div_ceil(2);
        levels.push(build_level(width, height, parents, |x, y| {
            let x0 = x as i64 * scale;
            let y0 = y as i64 * scale;
            let x1 = (x0 + scale).min(img_w as i64);
            let y1 = (y0 + scale).min(img_h as i64);
            let mut sum = [0.0f32; 3];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let d = difference(sx, sy);
                    sum[0] += d[0];
                    sum[1] += d[1];
                    sum[2] += d[2];
                }
            }
            let n = ((x1 - x0) * (y1 - y0)).max(1) as f32;
            [sum[0] / n, sum[1] / n, sum[2] / n]
        }));
    }

    let coarsest = levels.last_mut().unwrap();
    let (mut ring_sum, mut ring_count) = ([0.0f32; 3], 0.0f32);
    for (v, _) in coarsest
        .values
        .iter()
        .zip(&coarsest.unknown)
        .filter(|(_, u)| !**u)
    {
        for c in 0..3 {
            ring_sum[c] += v[c];
        }
        ring_count += 1.0;
    }
    let ring_mean = ring_sum.map(|s| s / ring_count.max(1.0));
    for (v, _) in coarsest
        .values
        .iter_mut()
        .zip(&coarsest.unknown)
        .filter(|(_, u)| **u)
    {
        *v = ring_mean;
    }
    relax(coarsest, 1.85, 2000, 0.01);

    for index in (0..levels.len() - 1).rev() {
        let (fine_levels, coarse_levels) = levels.split_at_mut(index + 1);
        let fine = &mut fine_levels[index];
        let coarse = &coarse_levels[0];
        let guesses: Vec<(usize, [f32; 3])> = (0..fine.coords.len())
            .into_par_iter()
            .filter(|&i| fine.unknown[i])
            .map(|i| {
                let (y, x) = fine.coords[i];
                let parent = coarse
                    .find((x / 2) as i64, (y / 2) as i64)
                    .map_or([0.0; 3], |p| coarse.values[p]);
                let cx = (x as f32 + 0.5) / 2.0 - 0.5;
                let cy = (y as f32 + 0.5) / 2.0 - 0.5;
                let x0 = cx.floor();
                let y0 = cy.floor();
                let fx = cx - x0;
                let fy = cy - y0;
                let at = |dx: i64, dy: i64| {
                    coarse
                        .find(x0 as i64 + dx, y0 as i64 + dy)
                        .map_or(parent, |p| coarse.values[p])
                };
                let (v00, v10, v01, v11) = (at(0, 0), at(1, 0), at(0, 1), at(1, 1));
                let mut out = [0.0f32; 3];
                for c in 0..3 {
                    let top = v00[c] + (v10[c] - v00[c]) * fx;
                    let bottom = v01[c] + (v11[c] - v01[c]) * fx;
                    out[c] = top + (bottom - top) * fy;
                }
                (i, out)
            })
            .collect();
        for (i, value) in guesses {
            fine.values[i] = value;
        }
        relax(fine, 1.9, if index == 0 { 150 } else { 80 }, 0.01);
    }

    let finest = &levels[0];
    patch_canvas(image, bounds, |x, y| {
        if mask.get_pixel(x, y)[0] == 0 {
            return None;
        }
        let v = finest
            .find(x as i64, y as i64)
            .map_or([0.0; 3], |i| finest.values[i]);
        let src = pixel(image, x as i64 + ox, y as i64 + oy);
        Some([0, 1, 2].map(|c| (src[c] + v[c]).round().clamp(0.0, 255.0) as u8))
    })
}

fn distance_to(grid: &[bool], width: usize, height: usize) -> Vec<f32> {
    let mut dist: Vec<f32> = grid
        .iter()
        .map(|&inside| if inside { 0.0 } else { f32::INFINITY })
        .collect();
    let diagonal = std::f32::consts::SQRT_2;
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            let mut d = dist[i];
            if x > 0 {
                d = d.min(dist[i - 1] + 1.0);
            }
            if y > 0 {
                d = d.min(dist[i - width] + 1.0);
                if x > 0 {
                    d = d.min(dist[i - width - 1] + diagonal);
                }
                if x + 1 < width {
                    d = d.min(dist[i - width + 1] + diagonal);
                }
            }
            dist[i] = d;
        }
    }
    for y in (0..height).rev() {
        for x in (0..width).rev() {
            let i = y * width + x;
            let mut d = dist[i];
            if x + 1 < width {
                d = d.min(dist[i + 1] + 1.0);
            }
            if y + 1 < height {
                d = d.min(dist[i + width] + 1.0);
                if x + 1 < width {
                    d = d.min(dist[i + width + 1] + diagonal);
                }
                if x > 0 {
                    d = d.min(dist[i + width - 1] + diagonal);
                }
            }
            dist[i] = d;
        }
    }
    dist
}

fn subsample<T: Copy>(items: &[T], cap: usize) -> Vec<T> {
    let step = items.len().div_ceil(cap.max(1)).max(1);
    items.iter().step_by(step).copied().collect()
}

struct Region {
    band: Vec<(i64, i64, f32)>,
    interior: Vec<(i64, i64)>,
    distance: Vec<f32>,
}

fn split_region(
    dest: &[bool],
    width: usize,
    height: usize,
    origin: (i64, i64),
    band_width: f32,
) -> Region {
    let distance = distance_to(dest, width, height);
    let mut band = Vec::new();
    let mut interior = Vec::new();
    for i in 0..width * height {
        let point = (origin.0 + (i % width) as i64, origin.1 + (i / width) as i64);
        if dest[i] {
            interior.push(point);
        } else if distance[i] <= band_width {
            band.push((point.0, point.1, distance[i]));
        }
    }
    Region {
        band,
        interior,
        distance,
    }
}

struct BandPoint {
    x: i64,
    y: i64,
    weight: f32,
    color: [f32; 3],
}

struct SearchSet {
    band: Vec<BandPoint>,
    interior: Vec<(i64, i64)>,
    band_mean: [f32; 3],
    band_variance: f32,
    reach: (i64, i64, i64, i64),
}

impl SearchSet {
    fn new(
        band: &[(i64, i64, f32)],
        interior: Vec<(i64, i64)>,
        band_width: f32,
        sample: &impl Fn(i64, i64) -> [f32; 3],
    ) -> Self {
        let mut reach = (i64::MAX, i64::MIN, i64::MAX, i64::MIN);
        for (x, y) in band
            .iter()
            .map(|b| (b.0, b.1))
            .chain(interior.iter().copied())
        {
            reach = (
                reach.0.min(x),
                reach.1.max(x),
                reach.2.min(y),
                reach.3.max(y),
            );
        }
        let falloff = band_width * 0.25;
        let mut band: Vec<BandPoint> = band
            .iter()
            .map(|&(x, y, distance)| BandPoint {
                x,
                y,
                weight: 1.0 / (1.0 + (distance - 1.0).max(0.0) / falloff),
                color: sample(x, y),
            })
            .collect();
        let total = band.iter().map(|b| b.weight).sum::<f32>().max(1e-6);
        band.iter_mut().for_each(|b| b.weight /= total);

        let mut band_mean = [0.0f32; 3];
        for b in &band {
            for (mean, value) in band_mean.iter_mut().zip(b.color) {
                *mean += b.weight * value;
            }
        }
        let band_variance = band
            .iter()
            .map(|b| {
                b.weight
                    * (0..3)
                        .map(|c| (b.color[c] - band_mean[c]).powi(2))
                        .sum::<f32>()
            })
            .sum::<f32>();
        Self {
            band,
            interior,
            band_mean,
            band_variance,
            reach,
        }
    }

    fn cost(
        &self,
        offset: (i64, i64),
        is_heal: bool,
        sample: &impl Fn(i64, i64) -> [f32; 3],
    ) -> f32 {
        let (ox, oy) = offset;
        let mut mean_diff = [0.0f32; 3];
        let mut src_sq = 0.0f32;
        for b in &self.band {
            let src = sample(b.x + ox, b.y + oy);
            for c in 0..3 {
                mean_diff[c] += b.weight * (b.color[c] - src[c]);
                src_sq += b.weight * src[c] * src[c];
            }
        }
        let shift = if is_heal { 0.75 } else { 0.0 };
        let mut deviation = 0.0f32;
        for b in &self.band {
            let src = sample(b.x + ox, b.y + oy);
            for c in 0..3 {
                deviation += b.weight * (b.color[c] - src[c] - shift * mean_diff[c]).abs();
            }
        }

        let src_band_mean = [0, 1, 2].map(|c| self.band_mean[c] - mean_diff[c]);
        let src_band_variance = src_sq - src_band_mean.iter().map(|m| m * m).sum::<f32>();
        let mut interior_variance = 0.0f32;
        for &(x, y) in &self.interior {
            let src = sample(x + ox, y + oy);
            for c in 0..3 {
                interior_variance += (src[c] - src_band_mean[c]).powi(2);
            }
        }
        interior_variance /= self.interior.len().max(1) as f32;

        deviation * deviation
            + 0.1
                * ((src_band_variance - self.band_variance).abs()
                    + (interior_variance - self.band_variance).abs())
    }

    fn fits(&self, offset: (i64, i64), area: (i64, i64, i64, i64)) -> bool {
        let (min_x, max_x, min_y, max_y) = self.reach;
        min_x + offset.0 >= area.0
            && max_x + offset.0 < area.2
            && min_y + offset.1 >= area.1
            && max_y + offset.1 < area.3
    }
}

pub fn find_source_offset(
    image: &RgbImage,
    mask: &GrayImage,
    bounds: Bounds,
    area: (i64, i64, i64, i64),
    is_heal: bool,
    variant: usize,
) -> Option<(i32, i32)> {
    let (min_x, max_x, min_y, max_y) = (
        bounds.0 as i64,
        bounds.1 as i64,
        bounds.2 as i64,
        bounds.3 as i64,
    );
    let size = (max_x - min_x + 1).max(max_y - min_y + 1) as f64;
    let radius = (size * 3.0).max((area.2 - area.0).min(area.3 - area.1) as f64 * 0.06);
    let factor = (size / 32.0).max(radius / 96.0).ceil().max(1.0) as i64;
    let band_ds = ((size / factor as f64) * 0.25).clamp(2.0, 16.0) as f32;
    let margin = radius.ceil() as i64 + (band_ds as i64 + 2) * factor;

    let win_x0 = (min_x - margin).max(area.0);
    let win_y0 = (min_y - margin).max(area.1);
    let win_x1 = (max_x + margin + 1).min(area.2);
    let win_y1 = (max_y + margin + 1).min(area.3);
    if win_x1 <= win_x0 || win_y1 <= win_y0 {
        return None;
    }
    let dw = ((win_x1 - win_x0) as usize).div_ceil(factor as usize);
    let dh = ((win_y1 - win_y0) as usize).div_ceil(factor as usize);

    let cells: Vec<([f32; 3], bool)> = (0..dw * dh)
        .into_par_iter()
        .map(|i| {
            let x0 = win_x0 + (i % dw) as i64 * factor;
            let y0 = win_y0 + (i / dw) as i64 * factor;
            let x1 = (x0 + factor).min(win_x1);
            let y1 = (y0 + factor).min(win_y1);
            let mut sum = [0.0f32; 3];
            let mut covered = false;
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = image.get_pixel(x as u32, y as u32);
                    sum[0] += p[0] as f32;
                    sum[1] += p[1] as f32;
                    sum[2] += p[2] as f32;
                    covered |= mask.get_pixel(x as u32, y as u32)[0] > 0;
                }
            }
            let n = ((x1 - x0) * (y1 - y0)).max(1) as f32;
            (sum.map(|s| s / n), covered)
        })
        .collect();

    let colors: Vec<[f32; 3]> = cells.iter().map(|c| c.0).collect();
    let dest: Vec<bool> = cells.iter().map(|c| c.1).collect();
    let Region {
        band,
        interior,
        distance,
    } = split_region(&dest, dw, dh, (0, 0), band_ds);
    if interior.is_empty() {
        return None;
    }

    let ds_sample = |x: i64, y: i64| colors[y as usize * dw + x as usize];
    let ds_set = SearchSet::new(
        &subsample(&band, 900),
        subsample(&interior, 700),
        band_ds,
        &ds_sample,
    );
    let interior_guard = subsample(&interior, 1500);
    let interior_reach = interior_guard
        .iter()
        .fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |r, &(x, y)| {
            (r.0.min(x), r.1.max(x), r.2.min(y), r.3.max(y))
        });
    let guard_reach = (0..dw * dh).filter(|&i| distance[i] <= 1.5).fold(
        (i64::MAX, i64::MIN, i64::MAX, i64::MIN),
        |r, i| {
            let (x, y) = ((i % dw) as i64, (i / dw) as i64);
            (r.0.min(x), r.1.max(x), r.2.min(y), r.3.max(y))
        },
    );

    let reach = (radius / factor as f64).ceil() as i64;
    let max_distance = (reach * factor) as f32;
    let mut candidates: Vec<(f32, i64, i64)> = (-reach..=reach)
        .into_par_iter()
        .flat_map_iter(|oy| {
            let ds_set = &ds_set;
            let interior_guard = &interior_guard;
            let distance = &distance;
            let ds_sample = &ds_sample;
            (-reach..=reach).filter_map(move |ox| {
                if ox * ox + oy * oy > reach * reach
                    || !ds_set.fits((ox, oy), (0, 0, dw as i64, dh as i64))
                {
                    return None;
                }
                let disjoint = interior_reach.1 + ox < guard_reach.0
                    || interior_reach.0 + ox > guard_reach.1
                    || interior_reach.3 + oy < guard_reach.2
                    || interior_reach.2 + oy > guard_reach.3;
                if !disjoint
                    && interior_guard
                        .iter()
                        .any(|&(x, y)| distance[(y + oy) as usize * dw + (x + ox) as usize] <= 1.5)
                {
                    return None;
                }
                let offset_distance = ((ox * ox + oy * oy) as f32).sqrt() * factor as f32;
                let cost = ds_set.cost((ox, oy), is_heal, ds_sample)
                    * (1.0 + 0.3 * offset_distance / max_distance);
                Some((cost, ox, oy))
            })
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.par_sort_unstable_by(|a, b| a.0.total_cmp(&b.0));

    let spacing = ((size / factor as f64) * 0.5).max(2.0) as i64;
    let mut picks: Vec<(i64, i64)> = Vec::new();
    for &(_, ox, oy) in &candidates {
        if picks
            .iter()
            .all(|&(px, py)| (px - ox).pow(2) + (py - oy).pow(2) >= spacing * spacing)
        {
            picks.push((ox, oy));
            if picks.len() > variant {
                break;
            }
        }
    }
    let (ox, oy) = picks[variant % picks.len()];
    let coarse = (ox * factor, oy * factor);
    if factor == 1 {
        return Some((coarse.0 as i32, coarse.1 as i32));
    }

    let band_full = (band_ds * factor as f32).max(3.0);
    let pad = band_full.ceil() as i64;
    let gx0 = (min_x - pad).max(area.0);
    let gy0 = (min_y - pad).max(area.1);
    let gx1 = (max_x + pad + 1).min(area.2);
    let gy1 = (max_y + pad + 1).min(area.3);
    let gw = (gx1 - gx0) as usize;
    let gh = (gy1 - gy0) as usize;
    let full_dest: Vec<bool> = (0..gw * gh)
        .into_par_iter()
        .map(|i| {
            mask.get_pixel(
                (gx0 + (i % gw) as i64) as u32,
                (gy0 + (i / gw) as i64) as u32,
            )[0] > 0
        })
        .collect();
    let full_region = split_region(&full_dest, gw, gh, (gx0, gy0), band_full);
    let full_sample = |x: i64, y: i64| pixel(image, x, y);
    let full_set = SearchSet::new(
        &subsample(&full_region.band, 3000),
        subsample(&full_region.interior, 2000),
        band_full,
        &full_sample,
    );
    let full_guard = subsample(&full_region.interior, 1500);

    let refined = (-factor..=factor)
        .into_par_iter()
        .flat_map_iter(|dy| (-factor..=factor).map(move |dx| (dx, dy)))
        .filter_map(|(dx, dy)| {
            let offset = (coarse.0 + dx, coarse.1 + dy);
            if !full_set.fits(offset, area)
                || full_guard.iter().any(|&(x, y)| {
                    mask.get_pixel((x + offset.0) as u32, (y + offset.1) as u32)[0] > 0
                })
            {
                return None;
            }
            Some((full_set.cost(offset, is_heal, &full_sample), offset))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0));

    let (ox, oy) = refined.map_or(coarse, |(_, offset)| offset);
    Some((ox as i32, oy as i32))
}
