use rayon::prelude::*;

use super::blend::{Buf, push_pull};
use crate::panorama_utils::features::bilinear;
use crate::panorama_utils::raster::{Plane, Rgb32f};

fn edges(alpha: &Plane, vertical: bool) -> Option<(Vec<f64>, Vec<f64>)> {
    let (w, h) = (alpha.width, alpha.height);
    let (n, len) = if vertical { (w, h) } else { (h, w) };
    let at = |i: usize, k: usize| {
        if vertical {
            alpha.get(i, k)
        } else {
            alpha.get(k, i)
        }
    };
    let mut lo = vec![f64::NAN; n];
    let mut hi = vec![f64::NAN; n];
    for i in 0..n {
        if let Some(a) = (0..len).find(|&k| at(i, k) >= 0.5) {
            let b = (0..len).rev().find(|&k| at(i, k) >= 0.5).unwrap_or(a);
            lo[i] = a as f64;
            hi[i] = b as f64 + 1.0;
        }
    }
    let known: Vec<usize> = (0..n).filter(|&i| lo[i].is_finite()).collect();
    if known.len() < 2 {
        return None;
    }
    for i in 0..n {
        if lo[i].is_finite() {
            continue;
        }
        let p = known.iter().rev().find(|&&k| k < i).copied();
        let q = known.iter().find(|&&k| k > i).copied();
        let (a, b) = match (p, q) {
            (Some(p), Some(q)) => {
                let t = (i - p) as f64 / (q - p) as f64;
                (lo[p] + (lo[q] - lo[p]) * t, hi[p] + (hi[q] - hi[p]) * t)
            }
            (Some(p), None) => (lo[p], hi[p]),
            (None, Some(q)) => (lo[q], hi[q]),
            _ => (0.0, len as f64),
        };
        lo[i] = a;
        hi[i] = b;
    }
    let r = (n / 40).max(1) as isize;
    let smooth = |v: &[f64]| -> Vec<f64> {
        (0..n as isize)
            .map(|i| {
                let (a, b) = ((i - r).max(0) as usize, ((i + r) as usize).min(n - 1));
                v[a..=b].iter().sum::<f64>() / (b - a + 1) as f64
            })
            .collect()
    };
    Some((smooth(&lo), smooth(&hi)))
}

fn stretch(img: &Rgb32f, alpha: &Plane, amount: f64, vertical: bool) -> (Rgb32f, Plane) {
    let Some((lo, hi)) = edges(alpha, vertical) else {
        return (img.clone(), alpha.clone());
    };
    let (w, h) = (img.width, img.height);
    let len = if vertical { h } else { w } as f64;
    let mut out = Rgb32f::new(w, h);
    let mut oa = Plane::new(w, h);
    out.data
        .par_chunks_mut(w)
        .zip(oa.data.par_chunks_mut(w))
        .enumerate()
        .for_each(|(y, (row, arow))| {
            for x in 0..w {
                let (i, k) = if vertical { (x, y) } else { (y, x) };
                let t = (k as f64 + 0.5) / len;
                let src = lo[i] + t * (hi[i] - lo[i]);
                let s = (1.0 - amount) * (k as f64 + 0.5) + amount * src;
                let (sx, sy) = if vertical {
                    (x as f32 + 0.5, s as f32)
                } else {
                    (s as f32, y as f32 + 0.5)
                };
                row[x] = img.sample_bilinear(sx, sy);
                arow[x] = bilinear(alpha, sx, sy);
            }
        });
    (out, oa)
}

pub fn boundary_warp(img: &Rgb32f, alpha: &Plane, amount: f64) -> (Rgb32f, Plane) {
    if amount <= 0.0 {
        return (img.clone(), alpha.clone());
    }
    let amount = amount.min(1.0);
    let (i1, a1) = stretch(img, alpha, amount, true);
    stretch(&i1, &a1, amount, false)
}

// Largest rectangle that stays inside the painted area.
pub fn coverage_crop(alpha: &Plane) -> Option<[f64; 4]> {
    let (w, h) = (alpha.width, alpha.height);
    if w == 0 || h == 0 {
        return None;
    }
    let usable: Vec<bool> = alpha.data.iter().map(|a| *a >= 0.999).collect();
    let (x, y, cw, ch) = largest_covered(&usable, w, h)?;
    Some([
        x as f64 / w as f64,
        y as f64 / h as f64,
        cw as f64 / w as f64,
        ch as f64 / h as f64,
    ])
}

fn largest_covered(usable: &[bool], w: usize, h: usize) -> Option<(usize, usize, usize, usize)> {
    let mut heights = vec![0usize; w];
    let mut stack = Vec::with_capacity(w + 1);
    let mut best_area = 0usize;
    let mut best = (0usize, 0usize, 0usize, 0usize);
    for y in 0..h {
        let row = &usable[y * w..y * w + w];
        for x in 0..w {
            heights[x] = if row[x] { heights[x] + 1 } else { 0 };
        }
        stack.clear();
        for i in 0..=w {
            let cur = if i < w { heights[i] } else { 0 };
            while let Some(&top) = stack.last() {
                if heights[top] <= cur {
                    break;
                }
                stack.pop();
                let hgt = heights[top];
                let left = stack.last().copied().map_or(0, |s| s + 1);
                let width = i - left;
                let area = hgt * width;
                if area > best_area {
                    best_area = area;
                    best = (left, y + 1 - hgt, width, hgt);
                }
            }
            stack.push(i);
        }
    }
    (best_area > 0).then_some(best)
}

pub fn fill_edges(img: &Rgb32f, alpha: &Plane) -> Result<Rgb32f, String> {
    let (w, h) = (img.width, img.height);
    let mut b = Buf::try_new(w, h, 3, None)?;
    for (i, p) in img.data.iter().enumerate() {
        for (c, &v) in p.iter().enumerate() {
            b.data[i * 3 + c] = v.max(1e-6).ln();
        }
    }
    let wgt: Vec<f32> = alpha
        .data
        .iter()
        .map(|a| if *a >= 0.999 { 1.0 } else { 0.0 })
        .collect();
    push_pull(&mut b, &wgt);
    let mut out = img.clone();
    for (i, p) in out.data.iter_mut().enumerate() {
        let a = alpha.data[i].clamp(0.0, 1.0);
        if a < 0.999 {
            let f = [0, 1, 2].map(|c| b.data[i * 3 + c].exp());
            let v = if a > 1e-3 { p.map(|v| v / a) } else { [0.0; 3] };
            *p = [0, 1, 2].map(|c| v[c] * a + f[c] * (1.0 - a));
        }
    }
    Ok(out)
}
