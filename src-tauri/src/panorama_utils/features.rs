use rayon::prelude::*;

use super::raster::{Plane, Rgb32f, gaussian_plane, half_plane};

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
        if l.width.min(l.height) < 96 {
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
            let (gx, gy) = gradients(&orient_img);
            let scale = (1u32 << li) as f32;
            let mut pts = Vec::new();
            let mut descs = Vec::new();
            for (x, y, s) in cands {
                let (xi, yi) = (x as usize, y as usize);
                let (dx, dy) = (
                    gx.get(xi.min(gx.width - 1), yi.min(gy.height - 1)),
                    gy.get(xi.min(gx.width - 1), yi.min(gy.height - 1)),
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

fn gradients(p: &Plane) -> (Plane, Plane) {
    let (w, h) = (p.width, p.height);
    let gx = Plane::from_fn(w, h, |x, y| {
        (p.get_clamped(x as isize + 1, y as isize) - p.get_clamped(x as isize - 1, y as isize))
            * 0.5
    });
    let gy = Plane::from_fn(w, h, |x, y| {
        (p.get_clamped(x as isize, y as isize + 1) - p.get_clamped(x as isize, y as isize - 1))
            * 0.5
    });
    (gx, gy)
}

fn harris(lvl: &Plane) -> Vec<(f32, f32, f32)> {
    let (w, h) = (lvl.width, lvl.height);
    if w < 24 || h < 24 {
        return vec![];
    }
    let s = gaussian_plane(lvl, 1.0);
    let (gx, gy) = gradients(&s);
    let xx = gaussian_plane(&gx.zip_map(&gx, |a, b| a * b), 1.5);
    let yy = gaussian_plane(&gy.zip_map(&gy, |a, b| a * b), 1.5);
    let xy = gaussian_plane(&gx.zip_map(&gy, |a, b| a * b), 1.5);
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
                let v = r.get(x, y);
                if v <= thr {
                    continue;
                }
                let mut is_max = true;
                'n: for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        if (dx, dy) != (0, 0) {
                            let o = r.get((x as i32 + dx) as usize, (y as i32 + dy) as usize);
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
                let ox = sub(r.get(x - 1, y), v, r.get(x + 1, y));
                let oy = sub(r.get(x, y - 1), v, r.get(x, y + 1));
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
    let (w, h) = (img.width as f32, img.height as f32);
    for j in 0..8 {
        for i in 0..8 {
            let u = (i as f32 - 3.5) * 5.0;
            let v = (j as f32 - 3.5) * 5.0;
            let sx = x + c * u - s * v;
            let sy = y + s * u + c * v;
            if sx < 0.5 || sy < 0.5 || sx > w - 0.5 || sy > h - 0.5 {
                return None;
            }
            d[j * 8 + i] = bilinear(img, sx, sy);
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

#[inline]
pub fn bilinear(img: &Plane, x: f32, y: f32) -> f32 {
    let fx = x - 0.5;
    let fy = y - 0.5;
    let x0 = fx.floor();
    let y0 = fy.floor();
    let (tx, ty) = (fx - x0, fy - y0);
    let (x0, y0) = (x0 as isize, y0 as isize);
    let a = img.get_clamped(x0, y0);
    let b = img.get_clamped(x0 + 1, y0);
    let c = img.get_clamped(x0, y0 + 1);
    let d = img.get_clamped(x0 + 1, y0 + 1);
    let top = a + (b - a) * tx;
    let bot = c + (d - c) * tx;
    top + (bot - top) * ty
}

fn dist2(a: &[f32; DESC_LEN], b: &[f32; DESC_LEN]) -> f32 {
    let mut s = 0.0;
    for i in 0..DESC_LEN {
        let d = a[i] - b[i];
        s += d * d;
    }
    s
}

fn nearest(a: &Features, b: &Features) -> Vec<(usize, f32, f32)> {
    a.desc
        .par_iter()
        .map(|da| {
            let (mut bi, mut d1, mut d2) = (usize::MAX, f32::INFINITY, f32::INFINITY);
            for (j, db) in b.desc.iter().enumerate() {
                let d = dist2(da, db);
                if d < d1 {
                    d2 = d1;
                    d1 = d;
                    bi = j;
                } else if d < d2 {
                    d2 = d;
                }
            }
            (bi, d1, d2)
        })
        .collect()
}

pub fn match_features(a: &Features, b: &Features, ratio: f32) -> Vec<(usize, usize)> {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let ab = nearest(a, b);
    let ba = nearest(b, a);
    let r2 = ratio * ratio;
    ab.iter()
        .enumerate()
        .filter(|(i, (j, d1, d2))| *j != usize::MAX && *d1 < r2 * *d2 && ba[*j].0 == *i)
        .map(|(i, (j, _, _))| (i, *j))
        .collect()
}

pub fn work_image(img: &Rgb32f, gain: f32, max_edge: usize) -> (Plane, f64) {
    let small = if img.width.max(img.height) > max_edge {
        super::raster::fit_rgb(img, max_edge, max_edge)
    } else {
        img.clone()
    };
    let scale = small.width as f64 / img.width as f64;
    let p = Plane::from_fn(small.width, small.height, |x, y| {
        let c = small.get(x, y);
        let l = (0.25 * c[0] + 0.6 * c[1] + 0.15 * c[2]) * gain;
        l.clamp(0.0, 1.0).powf(1.0 / 2.2)
    });
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
