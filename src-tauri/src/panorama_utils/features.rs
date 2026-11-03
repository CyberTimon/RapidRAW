use rayon::prelude::*;

use super::raster::{Rgb32f, fit_long_edge, gaussian_plane, half_plane};
use crate::focus_stacking::Plane;

pub const DESC_LEN: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Keypoint {
    pub x: f32,
    pub y: f32,
    pub level: u8,
    pub angle: f32,
    pub strength: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Features {
    pub points: Vec<Keypoint>,
    pub desc: Vec<[f32; DESC_LEN]>,
}

impl Features {
    pub fn len(&self) -> usize {
        self.points.len()
    }
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }
}

pub fn detect(img: &Plane, max: usize) -> Features {
    let mut levels = vec![img.clone()];
    while levels.len() < 4 {
        let Some(l) = levels.last() else { break };
        if l.w.min(l.h) < 96 {
            break;
        }
        levels.push(half_plane(l));
    }
    let per_level: Vec<(Vec<Keypoint>, Vec<[f32; DESC_LEN]>)> = levels
        .par_iter()
        .enumerate()
        .map(|(li, lvl)| {
            let cands = harris(lvl);
            let orient_img = gaussian_plane(lvl, 4.5);
            let desc_img = gaussian_plane(lvl, 2.5);
            let (gx, gy) = orient_img.gradients();
            let scale = (1u32 << li) as f32;
            let mut pts = Vec::new();
            let mut descs = Vec::new();
            for (x, y, s) in cands {
                let (xi, yi) = (x as usize, y as usize);
                let (dx, dy) = (
                    gx.at(xi.min(gx.w - 1), yi.min(gy.h - 1)),
                    gy.at(xi.min(gx.w - 1), yi.min(gy.h - 1)),
                );
                let angle = dy.atan2(dx);
                let Some(d) = descriptor(&desc_img, x, y, angle) else {
                    continue;
                };
                pts.push(Keypoint {
                    x: x * scale,
                    y: y * scale,
                    level: li as u8,
                    angle,
                    strength: s,
                });
                descs.push(d);
            }
            (pts, descs)
        })
        .collect();
    let mut all: Vec<(Keypoint, [f32; DESC_LEN])> = per_level
        .into_iter()
        .flat_map(|(p, d)| p.into_iter().zip(d))
        .collect();
    all.sort_by(|a, b| b.0.strength.total_cmp(&a.0.strength));
    all.truncate(max.saturating_mul(8).max(64));
    let keep = anms(&all.iter().map(|(k, _)| *k).collect::<Vec<_>>(), max);
    let mut f = Features::default();
    for i in keep {
        f.points.push(all[i].0);
        f.desc.push(all[i].1);
    }
    f
}

fn harris(lvl: &Plane) -> Vec<(f32, f32, f32)> {
    let (w, h) = (lvl.w, lvl.h);
    if w < 24 || h < 24 {
        return vec![];
    }
    let (gx, gy) = gaussian_plane(lvl, 1.0).gradients();
    let product = |a: &Plane, b: &Plane| {
        let mut p = Plane::new(w, h);
        p.data
            .par_iter_mut()
            .zip(a.data.par_iter().zip(&b.data))
            .for_each(|(o, (a, b))| *o = a * b);
        gaussian_plane(&p, 1.5)
    };
    let (xx, yy, xy) = (product(&gx, &gx), product(&gy, &gy), product(&gx, &gy));
    let mut r = Plane::new(w, h);
    for i in 0..r.data.len() {
        let (a, b, c) = (xx.data[i], yy.data[i], xy.data[i]);
        let tr = a + b;
        r.data[i] = if tr > 1e-12 {
            (a * b - c * c) / tr
        } else {
            0.0
        };
    }
    let mut sorted: Vec<f32> = r.data.iter().copied().step_by(7).collect();
    sorted.sort_by(|a, b| b.total_cmp(a));
    let top = sorted.get(sorted.len() / 200).copied().unwrap_or(0.0);
    let thr = (top * 0.01).max(1e-7);
    let border = 22usize;
    let rows: Vec<Vec<(f32, f32, f32)>> = (border..h.saturating_sub(border))
        .into_par_iter()
        .map(|y| {
            let mut out = Vec::new();
            for x in border..w.saturating_sub(border) {
                let v = r.at(x, y);
                if v <= thr {
                    continue;
                }
                let mut is_max = true;
                'n: for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        if (dx, dy) != (0, 0) {
                            let o = r.at((x as i32 + dx) as usize, (y as i32 + dy) as usize);
                            if o > v || (o == v && (dy < 0 || (dy == 0 && dx < 0))) {
                                is_max = false;
                                break 'n;
                            }
                        }
                    }
                }
                if !is_max {
                    continue;
                }
                let sub = |a: f32, b: f32, c: f32| {
                    let d = a - 2.0 * b + c;
                    if d.abs() > 1e-12 {
                        (0.5 * (a - c) / d).clamp(-0.5, 0.5)
                    } else {
                        0.0
                    }
                };
                let ox = sub(r.at(x - 1, y), v, r.at(x + 1, y));
                let oy = sub(r.at(x, y - 1), v, r.at(x, y + 1));
                out.push((x as f32 + 0.5 + ox, y as f32 + 0.5 + oy, v));
            }
            out
        })
        .collect();
    rows.into_iter().flatten().collect()
}

fn anms(pts: &[Keypoint], max: usize) -> Vec<usize> {
    if pts.len() <= max {
        return (0..pts.len()).collect();
    }
    let radii: Vec<f32> = (0..pts.len())
        .into_par_iter()
        .map(|i| {
            let p = pts[i];
            let mut best = f32::INFINITY;
            for q in &pts[..i] {
                if q.strength * 0.9 > p.strength {
                    let d = (q.x - p.x).powi(2) + (q.y - p.y).powi(2);
                    best = best.min(d);
                }
            }
            best
        })
        .collect();
    let mut idx: Vec<usize> = (0..pts.len()).collect();
    idx.sort_by(|&a, &b| radii[b].total_cmp(&radii[a]).then(a.cmp(&b)));
    idx.truncate(max);
    idx
}

fn descriptor(img: &Plane, x: f32, y: f32, angle: f32) -> Option<[f32; DESC_LEN]> {
    let (s, c) = angle.sin_cos();
    let mut d = [0f32; DESC_LEN];
    let (w, h) = (img.w as f32, img.h as f32);
    for j in 0..8 {
        for i in 0..8 {
            let u = (i as f32 - 3.5) * 5.0;
            let v = (j as f32 - 3.5) * 5.0;
            let sx = x + c * u - s * v;
            let sy = y + s * u + c * v;
            if sx < 0.5 || sy < 0.5 || sx > w - 0.5 || sy > h - 0.5 {
                return None;
            }
            d[j * 8 + i] = img.sample_bilinear(sx - 0.5, sy - 0.5);
        }
    }
    let mean = d.iter().sum::<f32>() / DESC_LEN as f32;
    let var = d.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / DESC_LEN as f32;
    if var < 1e-10 {
        return None;
    }
    let inv = 1.0 / var.sqrt();
    for v in d.iter_mut() {
        *v = (*v - mean) * inv;
    }
    Some(d)
}

fn dist2(a: &[f32; DESC_LEN], b: &[f32; DESC_LEN]) -> f32 {
    let mut s = 0.0;
    for i in 0..DESC_LEN {
        let d = a[i] - b[i];
        s += d * d;
    }
    s
}

fn nearest_two(dists: impl Iterator<Item = f32>) -> (usize, f32, f32) {
    let (mut bi, mut d1, mut d2) = (usize::MAX, f32::INFINITY, f32::INFINITY);
    for (j, d) in dists.enumerate() {
        if d < d1 {
            d2 = d1;
            d1 = d;
            bi = j;
        } else if d < d2 {
            d2 = d;
        }
    }
    (bi, d1, d2)
}

pub fn match_features(a: &Features, b: &Features, ratio: f32) -> Vec<(usize, usize)> {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let nb = b.len();
    let dist: Vec<f32> = a
        .desc
        .par_iter()
        .flat_map_iter(|da| b.desc.iter().map(move |db| dist2(da, db)))
        .collect();
    let ab: Vec<(usize, f32, f32)> = dist
        .par_chunks(nb)
        .map(|row| nearest_two(row.iter().copied()))
        .collect();
    let ba: Vec<usize> = (0..nb)
        .into_par_iter()
        .map(|j| nearest_two(dist[j..].iter().step_by(nb).copied()).0)
        .collect();
    let r2 = ratio * ratio;
    ab.iter()
        .enumerate()
        .filter(|(i, (j, d1, d2))| *j != usize::MAX && *d1 < r2 * *d2 && ba[*j] == *i)
        .map(|(i, (j, _, _))| (i, *j))
        .collect()
}

pub fn work_image(img: &Rgb32f, gain: f32, max_edge: usize) -> (Plane, f64) {
    let small = fit_long_edge(img, max_edge);
    let scale = small.width as f64 / img.width as f64;
    let p = Plane {
        w: small.width,
        h: small.height,
        data: small
            .data
            .par_iter()
            .map(|c| {
                ((0.25 * c[0] + 0.6 * c[1] + 0.15 * c[2]) * gain)
                    .clamp(0.0, 1.0)
                    .powf(1.0 / 2.2)
            })
            .collect(),
    };
    (p, scale)
}

pub fn median_luma(img: &Rgb32f, clip: f32) -> f32 {
    let step = (img.data.len() / 100_000).max(1);
    let mut v: Vec<f32> = img
        .data
        .iter()
        .step_by(step)
        .filter(|p| p[0].max(p[1]).max(p[2]) < clip * 0.98)
        .map(|c| 0.25 * c[0] + 0.6 * c[1] + 0.15 * c[2])
        .collect();
    if v.is_empty() {
        return clip;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2].max(1e-6)
}
