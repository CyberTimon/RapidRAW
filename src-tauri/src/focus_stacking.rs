use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, ImageFormat, Rgb32FImage};
use nalgebra::{DMatrix, DVector};
use rayon::prelude::*;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::file_management::parse_virtual_path;
use crate::formats::is_raw_file;
use crate::image_processing::apply_cpu_default_raw_processing;

const MEMORY_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

impl Plane {
    pub fn new(w: usize, h: usize) -> Self {
        Plane {
            w,
            h,
            data: vec![0.0; w * h],
        }
    }

    pub fn filled(w: usize, h: usize, v: f32) -> Self {
        Plane {
            w,
            h,
            data: vec![v; w * h],
        }
    }

    #[inline(always)]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.w + x]
    }

    #[inline(always)]
    pub fn clamped(&self, x: i64, y: i64) -> f32 {
        let xc = x.clamp(0, self.w as i64 - 1) as usize;
        let yc = y.clamp(0, self.h as i64 - 1) as usize;
        self.data[yc * self.w + xc]
    }

    #[inline]
    pub fn sample_bilinear(&self, x: f32, y: f32) -> f32 {
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let x0 = x0 as i64;
        let y0 = y0 as i64;
        let p00 = self.clamped(x0, y0);
        let p10 = self.clamped(x0 + 1, y0);
        let p01 = self.clamped(x0, y0 + 1);
        let p11 = self.clamped(x0 + 1, y0 + 1);
        let top = p00 + (p10 - p00) * fx;
        let bot = p01 + (p11 - p01) * fx;
        top + (bot - top) * fy
    }

    #[inline]
    pub fn sample_catmull_rom(&self, x: f32, y: f32) -> f32 {
        let xf = x.floor();
        let yf = y.floor();
        let tx = x - xf;
        let ty = y - yf;
        let ix = xf as i64;
        let iy = yf as i64;

        let wx = catmull_weights(tx);
        let wy = catmull_weights(ty);

        let mut acc = 0.0f32;
        for (j, &wy_j) in wy.iter().enumerate() {
            let mut row = 0.0f32;
            for (i, &wx_i) in wx.iter().enumerate() {
                row += wx_i * self.clamped(ix - 1 + i as i64, iy - 1 + j as i64);
            }
            acc += wy_j * row;
        }
        acc
    }

    pub fn map<F: Fn(f32) -> f32 + Sync + Send>(&self, f: F) -> Plane {
        let mut out = Plane::new(self.w, self.h);
        out.data
            .par_iter_mut()
            .zip(self.data.par_iter())
            .for_each(|(o, &v)| *o = f(v));
        out
    }

    pub fn mean(&self) -> f64 {
        let s: f64 = self.data.par_iter().map(|&v| v as f64).sum();
        s / self.data.len().max(1) as f64
    }

    pub fn gradients(&self) -> (Plane, Plane) {
        let mut gx = Plane::new(self.w, self.h);
        let mut gy = Plane::new(self.w, self.h);
        let (w, h) = (self.w, self.h);
        gx.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for (x, out_val) in row.iter_mut().enumerate() {
                let a = self.clamped(x as i64 - 1, y as i64);
                let b = self.clamped(x as i64 + 1, y as i64);
                *out_val = 0.5 * (b - a);
            }
        });
        gy.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for (x, out_val) in row.iter_mut().enumerate() {
                let a = self.clamped(x as i64, y as i64 - 1);
                let b = self.clamped(x as i64, y as i64 + 1);
                *out_val = 0.5 * (b - a);
            }
        });
        let _ = h;
        (gx, gy)
    }
}

#[inline(always)]
fn catmull_weights(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

pub fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let sigma = sigma.max(1e-3);
    let radius = (sigma * 3.0).ceil().max(1.0) as usize;
    let mut k = Vec::with_capacity(2 * radius + 1);
    let denom = 2.0 * sigma * sigma;
    for i in 0..(2 * radius + 1) {
        let d = i as f32 - radius as f32;
        k.push((-d * d / denom).exp());
    }
    let sum: f32 = k.iter().sum();
    for v in k.iter_mut() {
        *v /= sum;
    }
    k
}

pub fn convolve_separable(src: &Plane, kernel: &[f32]) -> Plane {
    let (w, h) = (src.w, src.h);
    if w == 0 || h == 0 {
        return src.clone();
    }
    let r_kern = (kernel.len() / 2) as i64;

    let mut tmp = Plane::new(w, h);
    tmp.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, out_val) in row.iter_mut().enumerate() {
            let mut acc = 0.0f32;
            for (i, &k) in kernel.iter().enumerate() {
                let sx = (x as i64 + i as i64 - r_kern).clamp(0, w as i64 - 1) as usize;
                acc += k * src.data[y * w + sx];
            }
            *out_val = acc;
        }
    });

    let mut out = Plane::new(w, h);
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, out_val) in row.iter_mut().enumerate() {
            let mut acc = 0.0f32;
            for (i, &k) in kernel.iter().enumerate() {
                let sy = (y as i64 + i as i64 - r_kern).clamp(0, h as i64 - 1) as usize;
                acc += k * tmp.data[sy * w + x];
            }
            *out_val = acc;
        }
    });
    out
}

pub fn gaussian_blur(src: &Plane, sigma: f32) -> Plane {
    convolve_separable(src, &gaussian_kernel(sigma))
}

pub fn box_filter(src: &Plane, radius: usize) -> Plane {
    let (w, h) = (src.w, src.h);
    if w == 0 || h == 0 {
        return src.clone();
    }
    let stride = w + 1;
    let mut sat = vec![0f64; stride * (h + 1)];
    for y in 0..h {
        let mut row_sum = 0f64;
        for x in 0..w {
            row_sum += src.data[y * w + x] as f64;
            sat[(y + 1) * stride + (x + 1)] = sat[y * stride + (x + 1)] + row_sum;
        }
    }

    let mut out = Plane::new(w, h);
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius + 1).min(h);
        for (x, out_val) in row.iter_mut().enumerate() {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius + 1).min(w);
            let s = sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0]
                + sat[y0 * stride + x0];
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            *out_val = (s / n) as f32;
        }
    });
    out
}

pub fn downsample(src: &Plane) -> Plane {
    const K: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let blurred = convolve_separable(src, &K);
    let w2 = src.w.div_ceil(2).max(1);
    let h2 = src.h.div_ceil(2).max(1);
    let mut out = Plane::new(w2, h2);
    out.data
        .par_chunks_mut(w2)
        .enumerate()
        .for_each(|(y, row)| {
            let sy = (2 * y).min(src.h.saturating_sub(1));
            for (x, out_val) in row.iter_mut().enumerate() {
                let sx = (2 * x).min(src.w.saturating_sub(1));
                *out_val = blurred.data[sy * src.w + sx];
            }
        });
    out
}

pub fn upsample_to(src: &Plane, w: usize, h: usize) -> Plane {
    let mut out = Plane::new(w, h);
    if src.w == 0 || src.h == 0 || w == 0 || h == 0 {
        return out;
    }
    let sx_ratio = src.w as f32 / w as f32;
    let sy_ratio = src.h as f32 / h as f32;
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let sy = ((y as f32 + 0.5) * sy_ratio - 0.5).max(0.0);
        for (x, out_val) in row.iter_mut().enumerate() {
            let sx = ((x as f32 + 0.5) * sx_ratio - 0.5).max(0.0);
            *out_val = src.sample_bilinear(sx, sy);
        }
    });
    out
}

pub fn resize_to(src: &Plane, w: usize, h: usize) -> Plane {
    if src.w == w && src.h == h {
        return src.clone();
    }
    let mut cur = src.clone();
    while cur.w >= 2 * w && cur.h >= 2 * h && cur.w > 2 && cur.h > 2 {
        cur = downsample(&cur);
    }
    if cur.w == w && cur.h == h {
        cur
    } else {
        upsample_to(&cur, w, h)
    }
}

pub fn plane_sub(a: &Plane, b: &Plane) -> Plane {
    let mut out = Plane::new(a.w, a.h);
    out.data
        .par_iter_mut()
        .zip(a.data.par_iter().zip(b.data.par_iter()))
        .for_each(|(o, (&x, &y))| *o = x - y);
    out
}

#[derive(Clone, Debug)]
pub struct PlanarRgb {
    pub w: usize,
    pub h: usize,
    pub c: [Plane; 3],
}

impl PlanarRgb {
    pub fn new(w: usize, h: usize) -> Self {
        PlanarRgb {
            w,
            h,
            c: [Plane::new(w, h), Plane::new(w, h), Plane::new(w, h)],
        }
    }

    pub fn from_rgb32f(img: &Rgb32FImage) -> Self {
        let w = img.width() as usize;
        let h = img.height() as usize;
        let raw = img.as_raw();
        let mut out = PlanarRgb::new(w, h);
        for ch in 0..3 {
            out.c[ch]
                .data
                .par_iter_mut()
                .enumerate()
                .for_each(|(i, v)| *v = raw[i * 3 + ch]);
        }
        out
    }

    pub fn to_rgb32f(&self) -> Rgb32FImage {
        let mut img = Rgb32FImage::new(self.w as u32, self.h as u32);
        {
            let raw = img.as_mut();
            raw.par_chunks_mut(3).enumerate().for_each(|(i, px)| {
                px[0] = self.c[0].data[i];
                px[1] = self.c[1].data[i];
                px[2] = self.c[2].data[i];
            });
        }
        img
    }

    pub fn luma(&self) -> Plane {
        let mut out = Plane::new(self.w, self.h);
        out.data.par_iter_mut().enumerate().for_each(|(i, v)| {
            *v = 0.2126 * self.c[0].data[i]
                + 0.7152 * self.c[1].data[i]
                + 0.0722 * self.c[2].data[i];
        });
        out
    }

    pub fn crop(&self, x0: usize, y0: usize, w: usize, h: usize) -> PlanarRgb {
        let mut out = PlanarRgb::new(w, h);
        for ch in 0..3 {
            let src = &self.c[ch];
            out.c[ch]
                .data
                .par_chunks_mut(w)
                .enumerate()
                .for_each(|(y, row)| {
                    let sy = y + y0;
                    row.copy_from_slice(&src.data[sy * src.w + x0..sy * src.w + x0 + w]);
                });
        }
        out
    }
}

pub fn level_count(w: usize, h: usize, max_levels: usize) -> usize {
    let mut n = 1usize;
    let (mut cw, mut ch) = (w, h);
    while n < max_levels && cw.min(ch) > 16 {
        cw = cw.div_ceil(2);
        ch = ch.div_ceil(2);
        n += 1;
    }
    n
}

pub fn gaussian_pyramid(base: &Plane, levels: usize) -> Vec<Plane> {
    let mut v = Vec::with_capacity(levels);
    v.push(base.clone());
    for _ in 1..levels {
        let next = downsample(v.last().unwrap());
        v.push(next);
    }
    v
}

#[derive(Clone, Debug)]
pub struct LaplacianPyramid {
    pub details: Vec<Plane>,
    pub residual: Plane,
}

pub fn laplacian_pyramid(base: &Plane, levels: usize) -> LaplacianPyramid {
    let g = gaussian_pyramid(base, levels);
    let mut details = Vec::with_capacity(g.len().saturating_sub(1));
    for i in 0..g.len() - 1 {
        let up = upsample_to(&g[i + 1], g[i].w, g[i].h);
        details.push(plane_sub(&g[i], &up));
    }
    LaplacianPyramid {
        residual: g.last().unwrap().clone(),
        details,
    }
}

pub fn collapse_pyramid(lp: &LaplacianPyramid) -> Plane {
    let mut cur = lp.residual.clone();
    for d in lp.details.iter().rev() {
        let up = upsample_to(&cur, d.w, d.h);
        let mut next = up;
        next.data
            .iter_mut()
            .zip(d.data.iter())
            .for_each(|(o, &v)| *o += v);
        cur = next;
    }
    cur
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarpModel {
    Translation,
    Similarity,
    AffineRadial,
    AffineCubic,
}

#[inline(always)]
fn poly_basis(qx: f64, qy: f64) -> [f64; 7] {
    let (qx2, qy2) = (qx * qx, qy * qy);
    [qx2, qx * qy, qy2, qx2 * qx, qx2 * qy, qx * qy2, qy2 * qy]
}

impl WarpModel {
    pub fn n_params(&self) -> usize {
        match self {
            WarpModel::Translation => 2,
            WarpModel::Similarity => 4,
            WarpModel::AffineRadial => 7,
            WarpModel::AffineCubic => 21,
        }
    }

    fn prior(&self, i: usize) -> f64 {
        match self {
            WarpModel::AffineCubic => {
                if i < 6 {
                    0.0
                } else if i == 20 {
                    2e-3
                } else {
                    let m = (i - 6) % 7;
                    if m < 3 { 3e-4 } else { 1e-3 }
                }
            }
            _ => 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LensWarp {
    pub a: [f64; 4],
    pub t: [f64; 2],
    pub k1: f64,
    pub k2: f64,
    pub pu: [f64; 7],
    pub pv: [f64; 7],
    pub cx: f64,
    pub cy: f64,
    pub norm: f64,
}

impl LensWarp {
    pub fn identity(w: usize, h: usize) -> Self {
        LensWarp {
            a: [1.0, 0.0, 0.0, 1.0],
            t: [0.0, 0.0],
            k1: 0.0,
            k2: 0.0,
            pu: [0.0; 7],
            pv: [0.0; 7],
            cx: w as f64 / 2.0,
            cy: h as f64 / 2.0,
            norm: (0.5 * ((w * w + h * h) as f64).sqrt()).max(1.0),
        }
    }

    pub fn rescaled(&self, factor: f64) -> Self {
        LensWarp {
            a: self.a,
            t: [self.t[0] * factor, self.t[1] * factor],
            k1: self.k1,
            k2: self.k2,
            pu: self.pu,
            pv: self.pv,
            cx: self.cx * factor,
            cy: self.cy * factor,
            norm: self.norm * factor,
        }
    }

    pub fn fold_radial_into_poly(&mut self) {
        if self.k1 == 0.0 {
            return;
        }
        self.pu[3] += self.k1;
        self.pu[5] += self.k1;
        self.pv[4] += self.k1;
        self.pv[6] += self.k1;
        self.k1 = 0.0;
    }

    #[inline(always)]
    fn predistort(&self, x: f64, y: f64) -> (f64, f64, f64, f64, [f64; 7]) {
        let qx = (x - self.cx) / self.norm;
        let qy = (y - self.cy) / self.norm;
        let basis = poly_basis(qx, qy);
        let r2 = qx * qx + qy * qy;
        let rad = self.k1 * r2 + self.k2 * r2 * r2;
        let mut du = qx * rad;
        let mut dv = qy * rad;
        for (m, &b) in basis.iter().enumerate() {
            du += self.pu[m] * b;
            dv += self.pv[m] * b;
        }
        (
            (qx + du) * self.norm + self.cx,
            (qy + dv) * self.norm + self.cy,
            qx,
            qy,
            basis,
        )
    }

    #[inline(always)]
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let (px, py, _, _, _) = self.predistort(x, y);
        (
            self.a[0] * px + self.a[1] * py + self.t[0],
            self.a[2] * px + self.a[3] * py + self.t[1],
        )
    }

    pub fn max_displacement(&self, w: usize, h: usize) -> f64 {
        let mut m: f64 = 0.0;
        for gy in 0..5 {
            for gx in 0..5 {
                let x = gx as f64 * (w.max(2) - 1) as f64 / 4.0;
                let y = gy as f64 * (h.max(2) - 1) as f64 / 4.0;
                let (u, v) = self.apply(x, y);
                m = m.max(((u - x).powi(2) + (v - y).powi(2)).sqrt());
            }
        }
        m
    }

    #[inline]
    fn jacobian(&self, x: f64, y: f64, model: WarpModel, ju: &mut [f64; 21], jv: &mut [f64; 21]) {
        *ju = [0.0; 21];
        *jv = [0.0; 21];
        let (px, py, qx, qy, basis) = self.predistort(x, y);
        match model {
            WarpModel::Translation => {
                ju[0] = 1.0;
                jv[1] = 1.0;
            }
            WarpModel::Similarity => {
                ju[0] = px;
                ju[1] = -py;
                ju[2] = 1.0;
                jv[0] = py;
                jv[1] = px;
                jv[3] = 1.0;
            }
            WarpModel::AffineRadial => {
                ju[0] = px;
                ju[1] = py;
                ju[4] = 1.0;
                jv[2] = px;
                jv[3] = py;
                jv[5] = 1.0;
                let r2 = qx * qx + qy * qy;
                let dk_x = qx * r2 * self.norm;
                let dk_y = qy * r2 * self.norm;
                ju[6] = self.a[0] * dk_x + self.a[1] * dk_y;
                jv[6] = self.a[2] * dk_x + self.a[3] * dk_y;
            }
            WarpModel::AffineCubic => {
                ju[0] = px;
                ju[1] = py;
                ju[4] = 1.0;
                jv[2] = px;
                jv[3] = py;
                jv[5] = 1.0;
                for m in 0..7 {
                    let b = basis[m] * self.norm;
                    ju[6 + m] = self.a[0] * b;
                    jv[6 + m] = self.a[2] * b;
                    ju[13 + m] = self.a[1] * b;
                    jv[13 + m] = self.a[3] * b;
                }
                let r2 = qx * qx + qy * qy;
                let q4x = qx * r2 * r2 * self.norm;
                let q4y = qy * r2 * r2 * self.norm;
                ju[20] = self.a[0] * q4x + self.a[1] * q4y;
                jv[20] = self.a[2] * q4x + self.a[3] * q4y;
            }
        }
    }

    fn update(&mut self, model: WarpModel, d: &[f64]) {
        match model {
            WarpModel::Translation => {
                self.t[0] += d[0];
                self.t[1] += d[1];
            }
            WarpModel::Similarity => {
                let (da, db) = (d[0], d[1]);
                let a = self.a;
                let m = [1.0 + da, -db, db, 1.0 + da];
                self.a = [
                    m[0] * a[0] + m[1] * a[2],
                    m[0] * a[1] + m[1] * a[3],
                    m[2] * a[0] + m[3] * a[2],
                    m[2] * a[1] + m[3] * a[3],
                ];
                self.t[0] += d[2];
                self.t[1] += d[3];
            }
            WarpModel::AffineRadial => {
                self.a[0] += d[0];
                self.a[1] += d[1];
                self.a[2] += d[2];
                self.a[3] += d[3];
                self.t[0] += d[4];
                self.t[1] += d[5];
                self.k1 += d[6];
            }
            WarpModel::AffineCubic => {
                self.a[0] += d[0];
                self.a[1] += d[1];
                self.a[2] += d[2];
                self.a[3] += d[3];
                self.t[0] += d[4];
                self.t[1] += d[5];
                for m in 0..7 {
                    self.pu[m] += d[6 + m];
                    self.pv[m] += d[13 + m];
                }
                self.k2 += d[20];
            }
        }
    }

    pub fn is_plausible(&self) -> bool {
        let det = self.a[0] * self.a[3] - self.a[1] * self.a[2];
        if !det.is_finite() || det <= 0.5 || det >= 2.0 {
            return false;
        }
        if self.k1.abs() >= 0.5
            || self.k2.abs() >= 0.5
            || !self.t[0].is_finite()
            || !self.t[1].is_finite()
        {
            return false;
        }
        self.pu.iter().chain(self.pv.iter()).all(|c| c.abs() < 0.2)
    }

    pub fn to_vector(self) -> [f64; 22] {
        let mut v = [0f64; 22];
        v[0..4].copy_from_slice(&self.a);
        v[4] = self.t[0];
        v[5] = self.t[1];
        v[6] = self.k1;
        v[7..14].copy_from_slice(&self.pu);
        v[14..21].copy_from_slice(&self.pv);
        v[21] = self.k2;
        v
    }

    pub fn with_vector(mut self, v: &[f64; 22]) -> LensWarp {
        self.a.copy_from_slice(&v[0..4]);
        self.t = [v[4], v[5]];
        self.k1 = v[6];
        self.pu.copy_from_slice(&v[7..14]);
        self.pv.copy_from_slice(&v[14..21]);
        self.k2 = v[21];
        self
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FramePose {
    pub warp: LensWarp,
    pub gain: f64,
    pub bias: f64,
    pub quality: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct AlignConfig {
    pub finest_dim: usize,
    pub coarsest_dim: usize,
    pub max_iterations: usize,
    pub target_samples: usize,
    pub min_quality: f64,
    pub polynomial_refinement: bool,
}

impl Default for AlignConfig {
    fn default() -> Self {
        AlignConfig {
            finest_dim: 2400,
            coarsest_dim: 80,
            max_iterations: 45,
            target_samples: 160_000,
            min_quality: 0.25,
            polynomial_refinement: true,
        }
    }
}

struct LevelData {
    tmpl: Plane,
    src: Plane,
    gx: Plane,
    gy: Plane,
    scale: f64,
}

pub struct AlignPyramids {
    levels: Vec<LevelData>,
}

pub fn build_align_pyramids(
    tmpl_full: &Plane,
    src_full: &Plane,
    cfg: &AlignConfig,
) -> AlignPyramids {
    let mut start_scale = 1.0f64;
    let mut tmpl = tmpl_full.clone();
    let mut src = src_full.clone();
    while tmpl.w.max(tmpl.h) > cfg.finest_dim && tmpl.w.min(tmpl.h) > 32 {
        tmpl = downsample(&tmpl);
        src = downsample(&src);
        start_scale *= 0.5;
    }

    let mut n = 1usize;
    let (mut cw, mut ch) = (tmpl.w, tmpl.h);
    while cw.max(ch) > cfg.coarsest_dim && cw.min(ch) > 20 {
        cw = cw.div_ceil(2);
        ch = ch.div_ceil(2);
        n += 1;
    }

    let tmpl_s = gaussian_blur(&tmpl, 1.0);
    let src_s = gaussian_blur(&src, 1.0);

    let tp = gaussian_pyramid(&tmpl_s, n);
    let sp = gaussian_pyramid(&src_s, n);

    let mut levels = Vec::with_capacity(tp.len());
    for i in 0..tp.len() {
        let (gx, gy) = sp[i].gradients();
        levels.push(LevelData {
            tmpl: tp[i].clone(),
            src: sp[i].clone(),
            gx,
            gy,
            scale: start_scale * 0.5f64.powi(i as i32),
        });
    }
    AlignPyramids { levels }
}

struct Sample {
    ju: [f64; 21],
    jv: [f64; 21],
    gx: f64,
    gy: f64,
    val: f64,
    residual: f64,
}

fn model_for_level(short_side: usize, cfg: &AlignConfig) -> WarpModel {
    if short_side < 48 {
        WarpModel::Translation
    } else if short_side < 110 {
        WarpModel::Similarity
    } else if short_side < 300 || !cfg.polynomial_refinement {
        WarpModel::AffineRadial
    } else {
        WarpModel::AffineCubic
    }
}

pub fn solve_alignment(pyr: &AlignPyramids, init: LensWarp, cfg: &AlignConfig) -> FramePose {
    let mut warp_full = init;
    let mut gain = 1.0f64;
    let mut bias = 0.0f64;
    let mut quality = 0.0f64;

    for li in (0..pyr.levels.len()).rev() {
        let lvl = &pyr.levels[li];
        let model = model_for_level(lvl.tmpl.w.min(lvl.tmpl.h), cfg);

        let mut w = warp_full.rescaled(lvl.scale);
        if model == WarpModel::AffineCubic {
            w.fold_radial_into_poly();
        }
        let q = solve_level(lvl, &mut w, &mut gain, &mut bias, model, cfg);
        if w.is_plausible() {
            warp_full = w.rescaled(1.0 / lvl.scale);
            quality = q;
        }
    }

    FramePose {
        warp: warp_full,
        gain,
        bias,
        quality,
    }
}

fn solve_level(
    lvl: &LevelData,
    warp: &mut LensWarp,
    gain: &mut f64,
    bias: &mut f64,
    model: WarpModel,
    cfg: &AlignConfig,
) -> f64 {
    let np = model.n_params();
    let n = np + 2;
    let (w, h) = (lvl.tmpl.w, lvl.tmpl.h);
    if w < 8 || h < 8 {
        return 0.0;
    }

    let px_total = w * h;
    let stride = ((px_total as f64 / cfg.target_samples as f64).sqrt().ceil() as usize).max(1);

    let tmpl_mean = lvl.tmpl.mean();
    let tmpl_var: f64 = lvl
        .tmpl
        .data
        .par_iter()
        .map(|&v| {
            let d = v as f64 - tmpl_mean;
            d * d
        })
        .sum::<f64>()
        / px_total as f64;
    let tmpl_var = tmpl_var.max(1e-9);

    let mut lambda = 1e-3f64;
    let mut prev_cost = f64::INFINITY;

    for _iter in 0..cfg.max_iterations {
        let samples = collect_samples(lvl, warp, *gain, *bias, model, stride);
        if samples.len() < n * 8 {
            return 0.0;
        }

        let mut abs_res: Vec<f64> = samples.iter().map(|s| s.residual.abs()).collect();
        let mid = abs_res.len() / 2;
        abs_res.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap());
        let mad = abs_res[mid].max(1e-6);
        let huber = 1.5 * 1.4826 * mad;

        let (hess, grad, cost, wsum) = samples
            .par_iter()
            .fold(
                || (vec![0f64; n * n], vec![0f64; n], 0f64, 0f64),
                |mut acc, s| {
                    let r = s.residual;
                    let wgt = if r.abs() <= huber {
                        1.0
                    } else {
                        huber / r.abs()
                    };
                    let mut j = [0f64; 23];
                    for (p, jp) in j.iter_mut().enumerate().take(np) {
                        *jp = *gain * (s.gx * s.ju[p] + s.gy * s.jv[p]);
                    }
                    j[np] = s.val;
                    j[np + 1] = 1.0;
                    for a in 0..n {
                        acc.1[a] += wgt * j[a] * r;
                        for b in a..n {
                            acc.0[a * n + b] += wgt * j[a] * j[b];
                        }
                    }
                    acc.2 += wgt * r * r;
                    acc.3 += wgt;
                    acc
                },
            )
            .reduce(
                || (vec![0f64; n * n], vec![0f64; n], 0f64, 0f64),
                |mut a, b| {
                    for i in 0..n * n {
                        a.0[i] += b.0[i];
                    }
                    for i in 0..n {
                        a.1[i] += b.1[i];
                    }
                    a.2 += b.2;
                    a.3 += b.3;
                    a
                },
            );

        let cost = cost / wsum.max(1e-12);

        if cost > prev_cost {
            lambda *= 8.0;
            if lambda > 1e6 {
                break;
            }
        } else {
            lambda = (lambda * 0.5).max(1e-8);
        }
        prev_cost = prev_cost.min(cost);

        let mut hm = DMatrix::<f64>::zeros(n, n);
        for a in 0..n {
            for b in a..n {
                let v = hess[a * n + b];
                hm[(a, b)] = v;
                hm[(b, a)] = v;
            }
        }
        let trace: f64 = (0..n).map(|a| hm[(a, a)]).sum::<f64>() / n as f64;
        for a in 0..n {
            let d = hm[(a, a)];
            let prior = if a < np { model.prior(a) } else { 0.0 };
            hm[(a, a)] = d + lambda * d.max(1e-9) + prior * trace;
        }
        let gv = DVector::<f64>::from_iterator(n, grad.iter().map(|&v| -v));

        let delta = match hm.lu().solve(&gv) {
            Some(d) => d,
            None => break,
        };
        if delta.iter().any(|v| !v.is_finite()) {
            break;
        }

        let mut trial = *warp;
        trial.update(model, delta.as_slice());
        let trial_gain = *gain + delta[np];
        let trial_bias = *bias + delta[np + 1];

        if !trial.is_plausible() || trial_gain <= 0.1 || trial_gain > 10.0 {
            break;
        }
        *warp = trial;
        *gain = trial_gain;
        *bias = trial_bias;

        let shift = delta.iter().take(np).fold(0f64, |m, &v| m.max(v.abs()));
        if shift < 1e-6 {
            break;
        }
    }

    (1.0 - prev_cost / tmpl_var).clamp(0.0, 1.0)
}

fn collect_samples(
    lvl: &LevelData,
    warp: &LensWarp,
    gain: f64,
    bias: f64,
    model: WarpModel,
    stride: usize,
) -> Vec<Sample> {
    let (w, h) = (lvl.tmpl.w, lvl.tmpl.h);
    let rows: Vec<usize> = (0..h).step_by(stride).collect();
    rows.par_iter()
        .flat_map_iter(|&y| {
            let mut local = Vec::with_capacity(w / stride + 1);
            let mut ju = [0f64; 21];
            let mut jv = [0f64; 21];
            let mut x = 0usize;
            while x < w {
                let (u, v) = warp.apply(x as f64, y as f64);
                if u >= 1.0 && v >= 1.0 && u < (lvl.src.w - 2) as f64 && v < (lvl.src.h - 2) as f64
                {
                    let val = lvl.src.sample_bilinear(u as f32, v as f32) as f64;
                    let gx = lvl.gx.sample_bilinear(u as f32, v as f32) as f64;
                    let gy = lvl.gy.sample_bilinear(u as f32, v as f32) as f64;
                    if gx * gx + gy * gy > 1e-10 {
                        warp.jacobian(x as f64, y as f64, model, &mut ju, &mut jv);
                        let t = lvl.tmpl.at(x, y) as f64;
                        local.push(Sample {
                            ju,
                            jv,
                            gx,
                            gy,
                            val,
                            residual: gain * val + bias - t,
                        });
                    }
                }
                x += stride;
            }
            local.into_iter()
        })
        .collect()
}

fn erode_mask(mask: &Plane, radius: usize) -> Plane {
    if radius == 0 {
        return mask.clone();
    }
    let (w, h) = (mask.w, mask.h);
    let r = radius as i64;
    let mut tmp = Plane::new(w, h);
    tmp.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, out_val) in row.iter_mut().enumerate() {
            let mut m = f32::INFINITY;
            for d in -r..=r {
                m = m.min(mask.clamped(x as i64 + d, y as i64));
            }
            *out_val = m;
        }
    });
    let mut out = Plane::new(w, h);
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, out_val) in row.iter_mut().enumerate() {
            let mut m = f32::INFINITY;
            for d in -r..=r {
                m = m.min(tmp.clamped(x as i64, y as i64 + d));
            }
            *out_val = m;
        }
    });
    out
}

pub fn warp_frame(
    src: &PlanarRgb,
    warp: &LensWarp,
    gain: f32,
    bias: f32,
    out_w: usize,
    out_h: usize,
) -> (PlanarRgb, Plane) {
    let mut out = PlanarRgb::new(out_w, out_h);
    let mut mask = Plane::new(out_w, out_h);

    let coords: Vec<(f32, f32, bool)> = {
        let mut v = vec![(0f32, 0f32, false); out_w * out_h];
        v.par_chunks_mut(out_w).enumerate().for_each(|(y, row)| {
            for (x, r) in row.iter_mut().enumerate() {
                let (u, vv) = warp.apply(x as f64, y as f64);
                let ok =
                    u >= 2.0 && vv >= 2.0 && u <= (src.w - 3) as f64 && vv <= (src.h - 3) as f64;
                *r = (u as f32, vv as f32, ok);
            }
        });
        v
    };

    mask.data.par_iter_mut().enumerate().for_each(|(i, m)| {
        *m = if coords[i].2 { 1.0 } else { 0.0 };
    });
    let mask = erode_mask(&mask, 2);

    for ch in 0..3 {
        let s = &src.c[ch];
        out.c[ch]
            .data
            .par_iter_mut()
            .enumerate()
            .for_each(|(i, o)| {
                let (u, v, _) = coords[i];
                *o = (s.sample_catmull_rom(u, v) * gain + bias).max(0.0);
            });
    }

    (out, mask)
}

#[derive(Clone, Copy, Debug)]
pub struct FusionConfig {
    pub decision_dim: usize,
    pub max_levels: usize,
    pub pool_sigma: f32,
    pub guided_radius: usize,
    pub guided_eps: f32,
    pub median_radius: usize,
    pub median_sigma: f32,
    pub consistency_threshold: f32,
    pub detail_gamma: f32,
}

impl Default for FusionConfig {
    fn default() -> Self {
        FusionConfig {
            decision_dim: 2048,
            max_levels: 9,
            pool_sigma: 2.0,
            guided_radius: 12,
            guided_eps: 1e-4,
            median_radius: 5,
            median_sigma: 0.08,
            consistency_threshold: 0.10,
            detail_gamma: 8.0,
        }
    }
}

pub fn guided_filter(guide: &Plane, input: &Plane, radius: usize, eps: f32) -> Plane {
    let mean_i = box_filter(guide, radius);
    let mean_p = box_filter(input, radius);

    let mut ii = Plane::new(guide.w, guide.h);
    let mut ip = Plane::new(guide.w, guide.h);
    ii.data
        .par_iter_mut()
        .zip(guide.data.par_iter())
        .for_each(|(o, &g)| *o = g * g);
    ip.data
        .par_iter_mut()
        .zip(guide.data.par_iter().zip(input.data.par_iter()))
        .for_each(|(o, (&g, &p))| *o = g * p);

    let corr_i = box_filter(&ii, radius);
    let corr_ip = box_filter(&ip, radius);

    let mut a = Plane::new(guide.w, guide.h);
    let mut b = Plane::new(guide.w, guide.h);
    for i in 0..a.data.len() {
        let var_i = corr_i.data[i] - mean_i.data[i] * mean_i.data[i];
        let cov_ip = corr_ip.data[i] - mean_i.data[i] * mean_p.data[i];
        let ai = cov_ip / (var_i + eps);
        a.data[i] = ai;
        b.data[i] = mean_p.data[i] - ai * mean_i.data[i];
    }

    let mean_a = box_filter(&a, radius);
    let mean_b = box_filter(&b, radius);

    let mut out = Plane::new(guide.w, guide.h);
    out.data.par_iter_mut().enumerate().for_each(|(i, o)| {
        *o = mean_a.data[i] * guide.data[i] + mean_b.data[i];
    });
    out
}

fn focus_domain(luma: &Plane) -> Plane {
    luma.map(|v| (v.max(0.0) * 8.0).ln_1p())
}

pub fn focus_scores(luma: &Plane, levels: usize, cfg: &FusionConfig) -> Vec<Plane> {
    let fd = focus_domain(luma);
    let lp = laplacian_pyramid(&fd, levels);
    let mut out = Vec::with_capacity(lp.details.len());
    for d in lp.details.iter() {
        let sq = d.map(|v| v * v);
        let pooled = gaussian_blur(&sq, cfg.pool_sigma);
        out.push(pooled.map(|v| v.max(0.0).sqrt()));
    }
    out
}

pub struct DecisionMaps {
    pub weights: Vec<Plane>,
    pub labels: Vec<u16>,
    pub w: usize,
    pub h: usize,
}

pub fn decide_labels(
    scores: &[Vec<Plane>],
    base: &[Plane],
    masks: &[Plane],
    cfg: &FusionConfig,
) -> DecisionMaps {
    let n = scores.len();
    assert!(n > 0);
    let (w, h) = (masks[0].w, masks[0].h);
    let npx = w * h;
    let n_levels = scores[0].len();

    let mut combined: Vec<Plane> = (0..n).map(|_| Plane::new(w, h)).collect();
    for (k, _) in scores[0].iter().enumerate().take(n_levels) {
        let level_weight = 1.0 / (1.0 + k as f32);
        let mut totals = vec![0f32; npx];
        for (i, score_frames) in scores.iter().enumerate().take(n) {
            let s = &score_frames[k];
            totals
                .par_iter_mut()
                .zip(s.data.par_iter().zip(masks[i].data.par_iter()))
                .for_each(|(t, (&v, &m))| *t += v * m);
        }
        for (i, score_frames) in scores.iter().enumerate().take(n) {
            let s = &score_frames[k];
            let m = &masks[i];
            combined[i]
                .data
                .par_iter_mut()
                .enumerate()
                .for_each(|(p, c)| {
                    let denom = totals[p] + 1e-8;
                    *c += level_weight * (s.data[p] * m.data[p]) / denom;
                });
        }
    }

    {
        let mut median = vec![0f32; npx];
        let mut buf = vec![0f32; n];
        for (p, med) in median.iter_mut().enumerate() {
            let mut cnt = 0usize;
            for (i, mask_i) in masks.iter().enumerate().take(n) {
                if mask_i.data[p] > 0.5 {
                    buf[cnt] = base[i].data[p];
                    cnt += 1;
                }
            }
            if cnt == 0 {
                continue;
            }
            let slice = &mut buf[..cnt];
            slice.sort_by(|a, b| a.partial_cmp(b).unwrap());
            *med = slice[cnt / 2];
        }
        let thr = cfg.consistency_threshold.max(1e-4);
        for i in 0..n {
            let b = &base[i];
            combined[i]
                .data
                .par_iter_mut()
                .enumerate()
                .for_each(|(p, c)| {
                    let scale = median[p].abs().max(0.02);
                    let dev = (b.data[p] - median[p]).abs() / scale;
                    let t = dev / thr;
                    *c *= (-t * t).exp();
                });
        }
    }

    let mut guide = Plane::new(w, h);
    guide.data.par_iter_mut().enumerate().for_each(|(p, g)| {
        let mut best = f32::NEG_INFINITY;
        let mut bi = 0usize;
        for (i, comb) in combined.iter().enumerate() {
            if comb.data[p] > best {
                best = comb.data[p];
                bi = i;
            }
        }
        *g = base[bi].data[p];
    });
    let guide = gaussian_blur(&guide, 0.8);

    let aggregated: Vec<Plane> = combined
        .par_iter()
        .map(|c| guided_filter(&guide, c, cfg.guided_radius, cfg.guided_eps))
        .collect();

    let mut labels = vec![0u16; npx];
    let mut any_valid = vec![false; npx];
    labels
        .par_iter_mut()
        .zip(any_valid.par_iter_mut())
        .enumerate()
        .for_each(|(p, (l, av))| {
            let mut best = f32::NEG_INFINITY;
            let mut bi = 0usize;
            let mut found = false;
            for i in 0..n {
                if masks[i].data[p] < 0.5 {
                    continue;
                }
                found = true;
                if aggregated[i].data[p] > best {
                    best = aggregated[i].data[p];
                    bi = i;
                }
            }
            *l = bi as u16;
            *av = found;
        });

    let labels = weighted_median_labels(
        &labels,
        &guide,
        n,
        cfg.median_radius,
        cfg.median_sigma,
        w,
        h,
    );

    let mut weights: Vec<Plane> = Vec::with_capacity(n);
    for (i, mask_i) in masks.iter().enumerate() {
        let mut ind = Plane::new(w, h);
        ind.data.par_iter_mut().enumerate().for_each(|(p, v)| {
            *v = if any_valid[p] && labels[p] as usize == i && mask_i.data[p] > 0.5 {
                1.0
            } else {
                0.0
            };
        });
        let soft = guided_filter(&guide, &ind, cfg.guided_radius / 3 + 1, cfg.guided_eps);
        let mut soft = soft.map(|v| v.max(0.0));
        soft.data
            .par_iter_mut()
            .zip(mask_i.data.par_iter())
            .for_each(|(v, &m)| *v *= m);
        weights.push(soft);
    }

    let mut totals = vec![0f32; npx];
    for wi in weights.iter() {
        totals
            .par_iter_mut()
            .zip(wi.data.par_iter())
            .for_each(|(t, &v)| *t += v);
    }
    for wi in weights.iter_mut() {
        wi.data.par_iter_mut().enumerate().for_each(|(p, v)| {
            *v = if totals[p] > 1e-6 {
                *v / totals[p]
            } else {
                0.0
            };
        });
    }

    DecisionMaps {
        weights,
        labels,
        w,
        h,
    }
}

fn weighted_median_labels(
    labels: &[u16],
    guide: &Plane,
    n_labels: usize,
    radius: usize,
    sigma: f32,
    w: usize,
    h: usize,
) -> Vec<u16> {
    if radius == 0 {
        return labels.to_vec();
    }
    let mut out = vec![0u16; w * h];
    let inv2s2 = 1.0 / (2.0 * sigma * sigma).max(1e-8);
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let mut hist = vec![0f32; n_labels];
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius + 1).min(h);
        for x in 0..w {
            for v in hist.iter_mut() {
                *v = 0.0;
            }
            let gp = guide.data[y * w + x];
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius + 1).min(w);
            let mut total = 0f32;
            for yy in y0..y1 {
                for xx in x0..x1 {
                    let d = guide.data[yy * w + xx] - gp;
                    let wgt = (-d * d * inv2s2).exp();
                    hist[labels[yy * w + xx] as usize] += wgt;
                    total += wgt;
                }
            }
            let half = total * 0.5;
            let mut acc = 0f32;
            let mut chosen = labels[y * w + x];
            for (i, &v) in hist.iter().enumerate() {
                acc += v;
                if acc >= half {
                    chosen = i as u16;
                    break;
                }
            }
            row[x] = chosen;
        }
    });
    out
}

pub struct MergeAccumulator {
    levels: usize,
    dims: Vec<(usize, usize)>,
    num_details: [Vec<Plane>; 3],
    num_residual: [Plane; 3],
    den_details: Vec<Plane>,
    den_residual: Plane,
    gammas: Vec<f32>,
}

impl MergeAccumulator {
    pub fn new(w: usize, h: usize, cfg: &FusionConfig) -> Self {
        let levels = level_count(w, h, cfg.max_levels);
        let mut dims = Vec::with_capacity(levels);
        let (mut cw, mut ch) = (w, h);
        for _ in 0..levels {
            dims.push((cw, ch));
            cw = cw.div_ceil(2);
            ch = ch.div_ceil(2);
        }
        let mk = |from: usize| -> Vec<Plane> {
            (from..levels - 1)
                .map(|k| Plane::new(dims[k].0, dims[k].1))
                .collect()
        };
        let (rw, rh) = dims[levels - 1];
        let gammas = (0..levels - 1)
            .map(|k| 1.0 + (cfg.detail_gamma - 1.0) * 0.5f32.powi(k as i32))
            .collect();
        MergeAccumulator {
            levels,
            num_details: [mk(0), mk(0), mk(0)],
            num_residual: [Plane::new(rw, rh), Plane::new(rw, rh), Plane::new(rw, rh)],
            den_details: mk(0),
            den_residual: Plane::new(rw, rh),
            dims,
            gammas,
        }
    }

    pub fn add_frame(&mut self, frame: &PlanarRgb, weight_full: &Plane) {
        let wpyr = gaussian_pyramid(weight_full, self.levels);

        let mut wpow: Vec<Plane> = Vec::with_capacity(self.levels);
        for (k, wp) in wpyr.iter().enumerate().take(self.levels) {
            let g = if k < self.gammas.len() {
                self.gammas[k]
            } else {
                1.0
            };
            wpow.push(wp.map(move |v| v.max(0.0).powf(g)));
        }

        for (k, src) in wpow.iter().enumerate().take(self.levels - 1) {
            let dst = &mut self.den_details[k];
            dst.data
                .par_iter_mut()
                .zip(src.data.par_iter())
                .for_each(|(d, &s)| *d += s);
        }
        {
            let src = &wpow[self.levels - 1];
            self.den_residual
                .data
                .par_iter_mut()
                .zip(src.data.par_iter())
                .for_each(|(d, &s)| *d += s);
        }

        for ch in 0..3 {
            let lp = laplacian_pyramid(&frame.c[ch], self.levels);
            for (k, det) in lp.details.iter().enumerate() {
                let wk = &wpow[k];
                self.num_details[ch][k]
                    .data
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(p, o)| *o += wk.data[p] * det.data[p]);
            }
            let wk = &wpow[self.levels - 1];
            let res = &lp.residual;
            self.num_residual[ch]
                .data
                .par_iter_mut()
                .enumerate()
                .for_each(|(p, o)| *o += wk.data[p] * res.data[p]);
        }
    }

    pub fn finish(self) -> PlanarRgb {
        let (w, h) = self.dims[0];
        let mut out = PlanarRgb::new(w, h);
        let MergeAccumulator {
            num_details,
            num_residual,
            den_details,
            den_residual,
            ..
        } = self;

        let mut num_details = num_details;
        let mut num_residual = num_residual;

        for ch in 0..3 {
            let mut details = Vec::with_capacity(den_details.len());
            for (k, den) in den_details.iter().enumerate() {
                let mut d = std::mem::replace(&mut num_details[ch][k], Plane::new(1, 1));
                d.data
                    .par_iter_mut()
                    .zip(den.data.par_iter())
                    .for_each(|(v, &dd)| *v = if dd > 1e-8 { *v / dd } else { 0.0 });
                details.push(d);
            }
            let mut residual = std::mem::replace(&mut num_residual[ch], Plane::new(1, 1));
            residual
                .data
                .par_iter_mut()
                .zip(den_residual.data.par_iter())
                .for_each(|(v, &dd)| *v = if dd > 1e-8 { *v / dd } else { 0.0 });

            let lp = LaplacianPyramid { details, residual };
            out.c[ch] = collapse_pyramid(&lp);
        }
        out
    }
}

pub fn weight_to_full(weight: &Plane, w: usize, h: usize) -> Plane {
    if weight.w == w && weight.h == h {
        weight.clone()
    } else {
        upsample_to(weight, w, h)
    }
}

pub fn valid_bounds(masks: &[Plane], min_coverage: f32) -> (usize, usize, usize, usize) {
    let (w, h) = (masks[0].w, masks[0].h);
    let n = masks.len() as f32;
    let mut cov = vec![0f32; w * h];
    for m in masks {
        cov.par_iter_mut()
            .zip(m.data.par_iter())
            .for_each(|(c, &v)| *c += v);
    }
    let need = (n * min_coverage).max(1.0);

    let mut x0 = w;
    let mut x1 = 0usize;
    let mut y0 = h;
    let mut y1 = 0usize;
    for y in 0..h {
        for x in 0..w {
            if cov[y * w + x] >= need {
                if x < x0 {
                    x0 = x;
                }
                if x > x1 {
                    x1 = x;
                }
                if y < y0 {
                    y0 = y;
                }
                if y > y1 {
                    y1 = y;
                }
            }
        }
    }
    if x0 > x1 || y0 > y1 {
        return (0, 0, w, h);
    }
    (x0, y0, x1 - x0 + 1, y1 - y0 + 1)
}

pub trait FrameSource: Sync {
    fn len(&self) -> usize;
    fn dims(&self) -> (usize, usize);
    fn get(&self, index: usize) -> Result<PlanarRgb, String>;
}

#[derive(Clone, Copy, Debug)]
pub struct StackConfig {
    pub align: AlignConfig,
    pub fusion: FusionConfig,
    pub align_dim: usize,
    pub align_enabled: bool,
    pub pose_smoothing: f64,
    pub crop_coverage: f32,
}

impl Default for StackConfig {
    fn default() -> Self {
        StackConfig {
            align: AlignConfig::default(),
            fusion: FusionConfig::default(),
            align_dim: 2400,
            align_enabled: true,
            pose_smoothing: 0.35,
            crop_coverage: 0.999,
        }
    }
}

pub struct StackResult {
    pub image: PlanarRgb,
    pub depth: Vec<u16>,
    pub depth_w: usize,
    pub depth_h: usize,
    pub poses: Vec<FramePose>,
    pub reference: usize,
}

fn fit_dims(w: usize, h: usize, max_dim: usize) -> (usize, usize) {
    let long = w.max(h);
    if long <= max_dim {
        return (w, h);
    }
    let s = max_dim as f64 / long as f64;
    (
        ((w as f64 * s).round() as usize).max(1),
        ((h as f64 * s).round() as usize).max(1),
    )
}

fn regularize_poses(poses: &mut [FramePose], cfg: &StackConfig, reference: usize) {
    let n = poses.len();
    if n < 4 || cfg.pose_smoothing <= 0.0 {
        return;
    }

    let good: Vec<usize> = (0..n)
        .filter(|&i| poses[i].quality >= cfg.align.min_quality && poses[i].warp.is_plausible())
        .collect();
    if good.len() < 4 {
        return;
    }

    let center = (n as f64 - 1.0) / 2.0;
    let mut ata = [[0f64; 3]; 3];
    for &i in &good {
        let t = (i as f64 - center) / (n as f64).max(1.0);
        let w = poses[i].quality * poses[i].quality;
        let basis = [1.0, t, t * t];
        for a in 0..3 {
            for b in 0..3 {
                ata[a][b] += w * basis[a] * basis[b];
            }
        }
    }
    let m = nalgebra::Matrix3::new(
        ata[0][0], ata[0][1], ata[0][2], ata[1][0], ata[1][1], ata[1][2], ata[2][0], ata[2][1],
        ata[2][2],
    );
    let minv = match m.try_inverse() {
        Some(v) => v,
        None => return,
    };

    let mut coeffs = [[0f64; 3]; 22];
    for (p, coeff) in coeffs.iter_mut().enumerate() {
        let mut atb = nalgebra::Vector3::zeros();
        for &i in &good {
            let t = (i as f64 - center) / (n as f64).max(1.0);
            let w = poses[i].quality * poses[i].quality;
            let val = poses[i].warp.to_vector()[p];
            atb += nalgebra::Vector3::new(w * val, w * val * t, w * val * t * t);
        }
        let c = minv * atb;
        *coeff = [c[0], c[1], c[2]];
    }

    for (i, pose) in poses.iter_mut().enumerate().take(n) {
        if i == reference {
            continue;
        }
        let t = (i as f64 - center) / (n as f64).max(1.0);
        let mut fitted = [0f64; 22];
        for (p, fit_val) in fitted.iter_mut().enumerate() {
            *fit_val = coeffs[p][0] + coeffs[p][1] * t + coeffs[p][2] * t * t;
        }

        let failed = pose.quality < cfg.align.min_quality || !pose.warp.is_plausible();
        let s = if failed { 1.0 } else { cfg.pose_smoothing };

        let cur = pose.warp.to_vector();
        let mut blended = [0f64; 22];
        for (p, bl) in blended.iter_mut().enumerate() {
            *bl = cur[p] * (1.0 - s) + fitted[p] * s;
        }
        let candidate = pose.warp.with_vector(&blended);
        if candidate.is_plausible() {
            pose.warp = candidate;
        }
    }
}

pub fn run_focus_stack<S: FrameSource + ?Sized>(
    src: &S,
    cfg: &StackConfig,
    progress: &dyn Fn(&str),
) -> Result<StackResult, String> {
    let n = src.len();
    if n < 2 {
        return Err("Focus stacking needs at least two frames.".into());
    }
    let (w, h) = src.dims();
    if w < 32 || h < 32 {
        return Err("Frames are too small to stack.".into());
    }

    let reference = n / 2;

    let (aw, ah) = fit_dims(w, h, cfg.align_dim);
    let align_scale = aw as f64 / w as f64;

    let mut poses: Vec<FramePose> = (0..n)
        .map(|_| FramePose {
            warp: LensWarp::identity(aw, ah),
            gain: 1.0,
            bias: 0.0,
            quality: 1.0,
        })
        .collect();

    if cfg.align_enabled {
        progress("Preparing alignment references...");
        let mut align_luma: Vec<Plane> = Vec::with_capacity(n);
        for i in 0..n {
            let f = src.get(i)?;
            if f.w != w || f.h != h {
                return Err(format!(
                    "Frame {} is {}x{} but the stack is {}x{}. All frames must share dimensions.",
                    i + 1,
                    f.w,
                    f.h,
                    w,
                    h
                ));
            }
            align_luma.push(resize_to(&f.luma(), aw, ah));
        }

        let mut acfg = cfg.align;
        acfg.finest_dim = acfg.finest_dim.max(aw.max(ah));

        let mut completed = 0;
        for pass in 0..2 {
            let order: Vec<usize> = if pass == 0 {
                (0..reference).rev().collect()
            } else {
                ((reference + 1)..n).collect()
            };
            let mut prev = LensWarp::identity(aw, ah);
            for &i in order.iter() {
                completed += 1;
                progress(&format!("Aligning frame {} of {}...", completed, n - 1));
                let pyr = build_align_pyramids(&align_luma[reference], &align_luma[i], &acfg);
                let pose = solve_alignment(&pyr, prev, &acfg);
                let pose = if pose.quality < acfg.min_quality || !pose.warp.is_plausible() {
                    let retry = solve_alignment(&pyr, LensWarp::identity(aw, ah), &acfg);
                    if retry.quality > pose.quality {
                        retry
                    } else {
                        pose
                    }
                } else {
                    pose
                };
                poses[i] = pose;
                if pose.warp.is_plausible() {
                    prev = pose.warp;
                }
            }
        }

        poses[reference] = FramePose {
            warp: LensWarp::identity(aw, ah),
            gain: 1.0,
            bias: 0.0,
            quality: 1.0,
        };

        progress("Regularising alignment across the stack...");
        regularize_poses(&mut poses, cfg, reference);
    }

    let full_poses: Vec<FramePose> = poses
        .iter()
        .map(|p| FramePose {
            warp: p.warp.rescaled(1.0 / align_scale),
            ..*p
        })
        .collect();

    let (dw, dh) = fit_dims(w, h, cfg.fusion.decision_dim);
    let levels = level_count(w, h, cfg.fusion.max_levels);

    let mut scores: Vec<Vec<Plane>> = Vec::with_capacity(n);
    let mut bases: Vec<Plane> = Vec::with_capacity(n);
    let mut masks: Vec<Plane> = Vec::with_capacity(n);

    for (i, full_pose) in full_poses.iter().enumerate().take(n) {
        progress(&format!("Measuring focus in frame {} of {}...", i + 1, n));
        let frame = src.get(i)?;
        let (warped, mask) = warp_or_copy(&frame, full_pose, cfg.align_enabled, w, h);
        drop(frame);

        let luma = warped.luma();
        let raw_scores = focus_scores(&luma, levels, &cfg.fusion);
        scores.push(raw_scores.iter().map(|s| resize_to(s, dw, dh)).collect());

        let compressed = luma.map(|v| (v.max(0.0) * 8.0).ln_1p());
        bases.push(gaussian_blur(&resize_to(&compressed, dw, dh), 3.0));

        masks.push(resize_to(&mask, dw, dh).map(|v| if v > 0.98 { 1.0 } else { 0.0 }));
    }

    progress("Solving depth labels...");
    let decision = decide_labels(&scores, &bases, &masks, &cfg.fusion);
    drop(scores);
    drop(bases);

    let mut acc = MergeAccumulator::new(w, h, &cfg.fusion);
    for (i, full_pose) in full_poses.iter().enumerate().take(n) {
        progress(&format!("Blending frame {} of {}...", i + 1, n));
        let frame = src.get(i)?;
        let (warped, _) = warp_or_copy(&frame, full_pose, cfg.align_enabled, w, h);
        drop(frame);
        let wf = weight_to_full(&decision.weights[i], w, h);
        acc.add_frame(&warped, &wf);
    }

    progress("Reconstructing...");
    let merged = acc.finish();

    let (cx, cy, cw, ch) = valid_bounds(&masks, cfg.crop_coverage);
    let sx = w as f64 / dw as f64;
    let sy = h as f64 / dh as f64;
    let x0 = ((cx as f64 * sx).ceil() as usize).min(w.saturating_sub(1));
    let y0 = ((cy as f64 * sy).ceil() as usize).min(h.saturating_sub(1));
    let cw = ((cw as f64 * sx).floor() as usize).min(w - x0).max(1);
    let ch = ((ch as f64 * sy).floor() as usize).min(h - y0).max(1);

    let image = if x0 == 0 && y0 == 0 && cw == w && ch == h {
        merged
    } else {
        merged.crop(x0, y0, cw, ch)
    };

    Ok(StackResult {
        image,
        depth: decision.labels,
        depth_w: decision.w,
        depth_h: decision.h,
        poses: full_poses,
        reference,
    })
}

fn warp_or_copy(
    frame: &PlanarRgb,
    pose: &FramePose,
    align_enabled: bool,
    w: usize,
    h: usize,
) -> (PlanarRgb, Plane) {
    if !align_enabled {
        return (frame.clone(), Plane::filled(w, h, 1.0));
    }
    warp_frame(frame, &pose.warp, pose.gain as f32, pose.bias as f32, w, h)
}

pub fn depth_preview_plane(result: &StackResult, n_frames: usize) -> Plane {
    let mut p = Plane::new(result.depth_w, result.depth_h);
    let denom = (n_frames.saturating_sub(1)).max(1) as f32;
    p.data
        .par_iter_mut()
        .zip(result.depth.par_iter())
        .for_each(|(o, &l)| *o = l as f32 / denom);
    p
}

struct MemorySource {
    frames: Vec<PlanarRgb>,
}

impl FrameSource for MemorySource {
    fn len(&self) -> usize {
        self.frames.len()
    }
    fn dims(&self) -> (usize, usize) {
        (self.frames[0].w, self.frames[0].h)
    }
    fn get(&self, index: usize) -> Result<PlanarRgb, String> {
        Ok(self.frames[index].clone())
    }
}

struct DiskSource {
    dir: PathBuf,
    n: usize,
    w: usize,
    h: usize,
}

impl DiskSource {
    fn create(n: usize, w: usize, h: usize) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "rr-focusstack-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create scratch dir: {}", e))?;
        Ok(DiskSource { dir, n, w, h })
    }

    fn path(&self, i: usize) -> PathBuf {
        self.dir.join(format!("frame_{:05}.f32", i))
    }

    fn write(&self, i: usize, img: &PlanarRgb) -> Result<(), String> {
        let mut f =
            fs::File::create(self.path(i)).map_err(|e| format!("Scratch write failed: {}", e))?;
        for ch in 0..3 {
            f.write_all(as_bytes(&img.c[ch].data))
                .map_err(|e| format!("Scratch write failed: {}", e))?;
        }
        Ok(())
    }
}

impl FrameSource for DiskSource {
    fn len(&self) -> usize {
        self.n
    }
    fn dims(&self) -> (usize, usize) {
        (self.w, self.h)
    }
    fn get(&self, index: usize) -> Result<PlanarRgb, String> {
        let mut f =
            fs::File::open(self.path(index)).map_err(|e| format!("Scratch read failed: {}", e))?;
        let mut out = PlanarRgb::new(self.w, self.h);
        for ch in 0..3 {
            f.read_exact(as_bytes_mut(&mut out.c[ch].data))
                .map_err(|e| format!("Scratch read failed: {}", e))?;
        }
        Ok(out)
    }
}

impl Drop for DiskSource {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn as_bytes(v: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}
fn as_bytes_mut(v: &mut [f32]) -> &mut [u8] {
    unsafe { std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, std::mem::size_of_val(v)) }
}

#[tauri::command]
pub async fn stitch_focus_stack(
    paths: Vec<String>,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to stack.".to_string());
    }

    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();

    let focus_result_handle = state.focus_stack_result.clone();

    let task = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let progress = {
            let ah = app_handle.clone();
            move |msg: &str| {
                let _ = ah.emit("focus-stack-progress", msg);
            }
        };

        let source = load_frames(&source_paths, &app_handle, &progress)?;
        let n = source.len();

        let cfg = StackConfig::default();
        let result = run_focus_stack(source.as_ref(), &cfg, &progress)?;

        progress("Creating preview...");
        let final_image = result.image.to_rgb32f();
        let preview = make_preview(&final_image, 1200)?;
        let depth_preview = make_depth_preview(&result, n)?;

        let (dbg_w, dbg_h) = (result.image.w, result.image.h);
        let report: Vec<serde_json::Value> = result
            .poses
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let det = p.warp.a[0] * p.warp.a[3] - p.warp.a[1] * p.warp.a[2];
                serde_json::json!({
                    "frame": i,
                    "is_reference": i == result.reference,
                    "quality": p.quality,
                    "magnification": det.abs().sqrt(),
                    "shift_px": [p.warp.t[0], p.warp.t[1]],
                    "k1": p.warp.k1,
                    "max_displacement_px": p.warp.max_displacement(dbg_w, dbg_h),
                    "exposure_gain": p.gain,
                })
            })
            .collect();
        let _ = app_handle.emit(
            "focus-stack-report",
            serde_json::json!({ "frames": report }),
        );

        *focus_result_handle.lock().unwrap() = Some(DynamicImage::ImageRgb32F(final_image));

        let _ = app_handle.emit(
            "focus-stack-complete",
            serde_json::json!({ "base64": preview, "depthMap": depth_preview }),
        );
        Ok(())
    });

    match task.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Task failed: {}", e)),
    }
}

fn load_frames(
    paths: &[String],
    app_handle: &AppHandle,
    progress: &dyn Fn(&str),
) -> Result<Box<dyn FrameSource>, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let n = paths.len();

    progress(&format!("Loading frame 1 of {}...", n));
    let first = decode_frame(&paths[0], &settings)?;
    let (w, h) = (first.w, first.h);
    let estimated = (n as u64) * (w as u64) * (h as u64) * 3 * 4;

    if estimated <= MEMORY_BUDGET_BYTES {
        let mut frames = Vec::with_capacity(n);
        frames.push(first);
        for (i, p) in paths.iter().enumerate().skip(1) {
            progress(&format!("Loading frame {} of {}...", i + 1, n));
            let f = decode_frame(p, &settings)?;
            check_dims(i, &f, w, h)?;
            frames.push(f);
        }
        Ok(Box::new(MemorySource { frames }))
    } else {
        let disk = DiskSource::create(n, w, h)?;
        disk.write(0, &first)?;
        drop(first);
        for (i, p) in paths.iter().enumerate().skip(1) {
            progress(&format!("Loading frame {} of {}...", i + 1, n));
            let f = decode_frame(p, &settings)?;
            check_dims(i, &f, w, h)?;
            disk.write(i, &f)?;
        }
        Ok(Box::new(disk))
    }
}

fn check_dims(i: usize, f: &PlanarRgb, w: usize, h: usize) -> Result<(), String> {
    if f.w != w || f.h != h {
        return Err(format!(
            "Frame {} is {}x{} but the first frame is {}x{}. \
             All frames in a stack must have the same dimensions and orientation.",
            i + 1,
            f.w,
            f.h,
            w,
            h
        ));
    }
    Ok(())
}

fn decode_frame(
    path: &str,
    settings: &crate::app_settings::AppSettings,
) -> Result<PlanarRgb, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    let mut dyn_img =
        crate::image_loader::load_base_image_from_bytes(&bytes, path, false, settings, None)
            .map_err(|e| format!("Failed to decode {}: {}", path, e))?;
    if is_raw_file(path) {
        apply_cpu_default_raw_processing(&mut dyn_img);
    }
    Ok(PlanarRgb::from_rgb32f(&dyn_img.to_rgb32f()))
}

fn make_preview(img: &image::Rgb32FImage, max_dim: u32) -> Result<String, String> {
    let (w, h) = (img.width(), img.height());
    let scale = (max_dim as f32 / w.max(h) as f32).min(1.0);
    let (nw, nh) = (
        ((w as f32 * scale).round() as u32).max(1),
        ((h as f32 * scale).round() as u32).max(1),
    );
    let small = crate::image_processing::downscale_f32_image(
        &DynamicImage::ImageRgb32F(img.clone()),
        nw,
        nh,
    );
    let mut buf = Cursor::new(Vec::new());
    small
        .to_rgb8()
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview: {}", e))?;
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

fn make_depth_preview(result: &StackResult, n_frames: usize) -> Result<String, String> {
    let p: Plane = depth_preview_plane(result, n_frames);
    let mut img = image::GrayImage::new(p.w as u32, p.h as u32);
    for (i, px) in img.pixels_mut().enumerate() {
        *px = image::Luma([(p.data[i].clamp(0.0, 1.0) * 255.0) as u8]);
    }
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode depth map: {}", e))?;
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

#[tauri::command]
pub async fn save_focus_stack(
    first_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let focus_image = state
        .focus_stack_result
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "No focus stack image found in memory.".to_string())?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine output directory.".to_string())?;
    let stem = first_path.file_stem().unwrap_or_default().to_string_lossy();

    let output_path = parent_dir.join(format!("{}_Stacked.tiff", stem));

    let rgb16 = focus_image.to_rgb16();
    rgb16
        .save_with_format(&output_path, ImageFormat::Tiff)
        .map_err(|e| format!("Failed to save {}: {}", output_path.display(), e))?;

    crate::exif_processing::write_rrexif_sidecar(&first_path_str, &output_path).ok();

    Ok(output_path.to_string_lossy().to_string())
}
