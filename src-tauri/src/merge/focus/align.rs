use crate::merge::raster::{Raster, gaussian_blur, pyr_down};
use nalgebra::{DMatrix, DVector, Matrix3, Vector3};
use rayon::prelude::*;

const COARSEST_DIMENSION: usize = 80;
const MAX_ITERATIONS: usize = 45;
const TARGET_SAMPLES: usize = 160_000;
pub const MIN_QUALITY: f64 = 0.25;
const POSE_SMOOTHING: f64 = 0.35;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WarpModel {
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
    fn for_level(short_side: usize) -> Self {
        if short_side < 48 {
            WarpModel::Translation
        } else if short_side < 110 {
            WarpModel::Similarity
        } else if short_side < 300 {
            WarpModel::AffineRadial
        } else {
            WarpModel::AffineCubic
        }
    }

    fn parameter_count(self) -> usize {
        match self {
            WarpModel::Translation => 2,
            WarpModel::Similarity => 4,
            WarpModel::AffineRadial => 7,
            WarpModel::AffineCubic => 21,
        }
    }

    fn prior(self, i: usize) -> f64 {
        match self {
            WarpModel::AffineCubic if i == 20 => 2e-3,
            WarpModel::AffineCubic if i >= 6 => {
                if (i - 6) % 7 < 3 {
                    3e-4
                } else {
                    1e-3
                }
            }
            _ => 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LensWarp {
    a: [f64; 4],
    t: [f64; 2],
    k1: f64,
    k2: f64,
    pu: [f64; 7],
    pv: [f64; 7],
    cx: f64,
    cy: f64,
    norm: f64,
}

impl LensWarp {
    pub fn identity(width: usize, height: usize) -> Self {
        LensWarp {
            a: [1.0, 0.0, 0.0, 1.0],
            t: [0.0, 0.0],
            k1: 0.0,
            k2: 0.0,
            pu: [0.0; 7],
            pv: [0.0; 7],
            cx: width as f64 / 2.0,
            cy: height as f64 / 2.0,
            norm: (0.5 * ((width * width + height * height) as f64).sqrt()).max(1.0),
        }
    }

    pub fn rescaled(&self, factor: f64) -> Self {
        LensWarp {
            t: [self.t[0] * factor, self.t[1] * factor],
            cx: self.cx * factor,
            cy: self.cy * factor,
            norm: self.norm * factor,
            ..*self
        }
    }

    fn fold_radial_into_poly(&mut self) {
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
        let radial = self.k1 * r2 + self.k2 * r2 * r2;
        let mut du = qx * radial;
        let mut dv = qy * radial;
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

    pub fn is_identity(&self) -> bool {
        let reference = LensWarp::identity(1, 1);
        self.a == reference.a
            && self.t == reference.t
            && self.k1 == 0.0
            && self.k2 == 0.0
            && self.pu == reference.pu
            && self.pv == reference.pv
    }

    pub fn max_displacement(&self, width: usize, height: usize) -> f64 {
        let mut m: f64 = 0.0;
        for gy in 0..5 {
            for gx in 0..5 {
                let x = gx as f64 * (width.max(2) - 1) as f64 / 4.0;
                let y = gy as f64 * (height.max(2) - 1) as f64 / 4.0;
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
                let dx = qx * r2 * self.norm;
                let dy = qy * r2 * self.norm;
                ju[6] = self.a[0] * dx + self.a[1] * dy;
                jv[6] = self.a[2] * dx + self.a[3] * dy;
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
                let a = self.a;
                let m = [1.0 + d[0], -d[1], d[1], 1.0 + d[0]];
                self.a = [
                    m[0] * a[0] + m[1] * a[2],
                    m[0] * a[1] + m[1] * a[3],
                    m[2] * a[0] + m[3] * a[2],
                    m[2] * a[1] + m[3] * a[3],
                ];
                self.t[0] += d[2];
                self.t[1] += d[3];
            }
            WarpModel::AffineRadial | WarpModel::AffineCubic => {
                for (a, delta) in self.a.iter_mut().zip(d) {
                    *a += delta;
                }
                self.t[0] += d[4];
                self.t[1] += d[5];
                if model == WarpModel::AffineRadial {
                    self.k1 += d[6];
                } else {
                    for m in 0..7 {
                        self.pu[m] += d[6 + m];
                        self.pv[m] += d[13 + m];
                    }
                    self.k2 += d[20];
                }
            }
        }
    }

    pub fn is_plausible(&self) -> bool {
        let det = self.a[0] * self.a[3] - self.a[1] * self.a[2];
        det.is_finite()
            && det > 0.5
            && det < 2.0
            && self.k1.abs() < 0.5
            && self.k2.abs() < 0.5
            && self.t.iter().all(|t| t.is_finite())
            && self.pu.iter().chain(self.pv.iter()).all(|c| c.abs() < 0.2)
    }

    fn to_vector(self) -> [f64; 22] {
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

    fn with_vector(mut self, v: &[f64; 22]) -> LensWarp {
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
    pub quality: f64,
}

struct Level {
    template: Raster,
    source: Raster,
    gx: Raster,
    gy: Raster,
    scale: f64,
}

pub struct AlignmentPyramid {
    levels: Vec<Level>,
}

fn gradients(src: &Raster) -> (Raster, Raster) {
    let (w, h) = (src.width, src.height);
    let mut gx = Raster::new(w, h, 1);
    let mut gy = Raster::new(w, h, 1);
    gx.data
        .par_chunks_mut(w)
        .zip(gy.data.par_chunks_mut(w))
        .enumerate()
        .for_each(|(y, (rx, ry))| {
            let yi = y as isize;
            for x in 0..w {
                let xi = x as isize;
                rx[x] = 0.5 * (src.get_clamped(xi + 1, yi, 0) - src.get_clamped(xi - 1, yi, 0));
                ry[x] = 0.5 * (src.get_clamped(xi, yi + 1, 0) - src.get_clamped(xi, yi - 1, 0));
            }
        });
    (gx, gy)
}

pub fn build_pyramid(template: &Raster, source: &Raster) -> AlignmentPyramid {
    let mut count = 1usize;
    let (mut w, mut h) = (template.width, template.height);
    while w.max(h) > COARSEST_DIMENSION && w.min(h) > 20 {
        w = w.div_ceil(2);
        h = h.div_ceil(2);
        count += 1;
    }
    let mut t = gaussian_blur(template, 1.0);
    let mut s = gaussian_blur(source, 1.0);
    let mut levels = Vec::with_capacity(count);
    for i in 0..count {
        let (gx, gy) = gradients(&s);
        let (next_t, next_s) = if i + 1 < count {
            (Some(pyr_down(&t)), Some(pyr_down(&s)))
        } else {
            (None, None)
        };
        levels.push(Level {
            template: t,
            source: s,
            gx,
            gy,
            scale: 0.5f64.powi(i as i32),
        });
        match (next_t, next_s) {
            (Some(nt), Some(ns)) => {
                t = nt;
                s = ns;
            }
            _ => break,
        }
    }
    AlignmentPyramid { levels }
}

struct Sample {
    ju: [f64; 21],
    jv: [f64; 21],
    gx: f64,
    gy: f64,
    value: f64,
    residual: f64,
}

pub fn solve(pyramid: &AlignmentPyramid, initial: LensWarp) -> FramePose {
    let mut warp = initial;
    let mut gain = 1.0f64;
    let mut bias = 0.0f64;
    let mut quality = 0.0f64;
    for level in pyramid.levels.iter().rev() {
        let model = WarpModel::for_level(level.template.width.min(level.template.height));
        let mut local = warp.rescaled(level.scale);
        if model == WarpModel::AffineCubic {
            local.fold_radial_into_poly();
        }
        let q = solve_level(level, &mut local, &mut gain, &mut bias, model);
        if local.is_plausible() {
            warp = local.rescaled(1.0 / level.scale);
            quality = q;
        }
    }
    FramePose { warp, quality }
}

fn solve_level(
    level: &Level,
    warp: &mut LensWarp,
    gain: &mut f64,
    bias: &mut f64,
    model: WarpModel,
) -> f64 {
    let np = model.parameter_count();
    let n = np + 2;
    let (w, h) = (level.template.width, level.template.height);
    if w < 8 || h < 8 {
        return 0.0;
    }
    let stride = (((w * h) as f64 / TARGET_SAMPLES as f64).sqrt().ceil() as usize).max(1);
    let mean = level
        .template
        .data
        .par_iter()
        .map(|&v| v as f64)
        .sum::<f64>()
        / (w * h) as f64;
    let variance = (level
        .template
        .data
        .par_iter()
        .map(|&v| (v as f64 - mean).powi(2))
        .sum::<f64>()
        / (w * h) as f64)
        .max(1e-9);

    let mut lambda = 1e-3f64;
    let mut previous_cost = f64::INFINITY;
    for _ in 0..MAX_ITERATIONS {
        let samples = collect_samples(level, warp, *gain, *bias, model, stride);
        if samples.len() < n * 8 {
            return 0.0;
        }
        let mut absolute: Vec<f64> = samples.iter().map(|s| s.residual.abs()).collect();
        let middle = absolute.len() / 2;
        absolute.select_nth_unstable_by(middle, |a, b| a.total_cmp(b));
        let huber = 1.5 * 1.4826 * absolute[middle].max(1e-6);

        let (hessian, gradient, cost, weight_sum) = samples
            .par_iter()
            .fold(
                || (vec![0f64; n * n], vec![0f64; n], 0f64, 0f64),
                |mut acc, s| {
                    let r = s.residual;
                    let weight = if r.abs() <= huber {
                        1.0
                    } else {
                        huber / r.abs()
                    };
                    let mut j = [0f64; 23];
                    for (p, jp) in j.iter_mut().enumerate().take(np) {
                        *jp = *gain * (s.gx * s.ju[p] + s.gy * s.jv[p]);
                    }
                    j[np] = s.value;
                    j[np + 1] = 1.0;
                    for a in 0..n {
                        acc.1[a] += weight * j[a] * r;
                        for b in a..n {
                            acc.0[a * n + b] += weight * j[a] * j[b];
                        }
                    }
                    acc.2 += weight * r * r;
                    acc.3 += weight;
                    acc
                },
            )
            .reduce(
                || (vec![0f64; n * n], vec![0f64; n], 0f64, 0f64),
                |mut a, b| {
                    a.0.iter_mut().zip(&b.0).for_each(|(x, y)| *x += y);
                    a.1.iter_mut().zip(&b.1).for_each(|(x, y)| *x += y);
                    a.2 += b.2;
                    a.3 += b.3;
                    a
                },
            );
        let cost = cost / weight_sum.max(1e-12);
        if cost > previous_cost {
            lambda *= 8.0;
            if lambda > 1e6 {
                break;
            }
        } else {
            lambda = (lambda * 0.5).max(1e-8);
        }
        previous_cost = previous_cost.min(cost);

        let mut matrix = DMatrix::<f64>::zeros(n, n);
        for a in 0..n {
            for b in a..n {
                matrix[(a, b)] = hessian[a * n + b];
                matrix[(b, a)] = hessian[a * n + b];
            }
        }
        let trace = (0..n).map(|a| matrix[(a, a)]).sum::<f64>() / n as f64;
        for a in 0..n {
            let d = matrix[(a, a)];
            let prior = if a < np { model.prior(a) } else { 0.0 };
            matrix[(a, a)] = d + lambda * d.max(1e-9) + prior * trace;
        }
        let rhs = DVector::<f64>::from_iterator(n, gradient.iter().map(|&v| -v));
        let Some(delta) = matrix.lu().solve(&rhs) else {
            break;
        };
        if delta.iter().any(|v| !v.is_finite()) {
            break;
        }
        let mut trial = *warp;
        trial.update(model, delta.as_slice());
        let trial_gain = *gain + delta[np];
        if !trial.is_plausible() || trial_gain <= 0.1 || trial_gain > 10.0 {
            break;
        }
        *warp = trial;
        *gain = trial_gain;
        *bias += delta[np + 1];
        if delta.iter().take(np).fold(0f64, |m, &v| m.max(v.abs())) < 1e-6 {
            break;
        }
    }
    (1.0 - previous_cost / variance).clamp(0.0, 1.0)
}

fn collect_samples(
    level: &Level,
    warp: &LensWarp,
    gain: f64,
    bias: f64,
    model: WarpModel,
    stride: usize,
) -> Vec<Sample> {
    let (w, h) = (level.template.width, level.template.height);
    let (sw, sh) = (level.source.width as f64, level.source.height as f64);
    let rows: Vec<usize> = (0..h).step_by(stride).collect();
    rows.par_iter()
        .flat_map_iter(|&y| {
            let mut local = Vec::with_capacity(w / stride + 1);
            let mut ju = [0f64; 21];
            let mut jv = [0f64; 21];
            let mut sample = [0.0f32; 1];
            for x in (0..w).step_by(stride) {
                let (u, v) = warp.apply(x as f64, y as f64);
                if !(u >= 1.0 && v >= 1.0 && u < sw - 2.0 && v < sh - 2.0) {
                    continue;
                }
                level.source.bilinear(u as f32, v as f32, &mut sample);
                let value = sample[0] as f64;
                level.gx.bilinear(u as f32, v as f32, &mut sample);
                let gx = sample[0] as f64;
                level.gy.bilinear(u as f32, v as f32, &mut sample);
                let gy = sample[0] as f64;
                if gx * gx + gy * gy <= 1e-10 {
                    continue;
                }
                warp.jacobian(x as f64, y as f64, model, &mut ju, &mut jv);
                local.push(Sample {
                    ju,
                    jv,
                    gx,
                    gy,
                    value,
                    residual: gain * value + bias - level.template.get(x, y, 0) as f64,
                });
            }
            local.into_iter()
        })
        .collect()
}

pub fn regularize(poses: &mut [FramePose], reference: usize) {
    let n = poses.len();
    let good: Vec<usize> = (0..n)
        .filter(|&i| poses[i].quality >= MIN_QUALITY && poses[i].warp.is_plausible())
        .collect();
    if n < 4 || good.len() < 4 {
        return;
    }
    let center = (n as f64 - 1.0) / 2.0;
    let position = |i: usize| (i as f64 - center) / n as f64;
    let mut normal = Matrix3::<f64>::zeros();
    for &i in &good {
        let t = position(i);
        let weight = poses[i].quality * poses[i].quality;
        let basis = Vector3::new(1.0, t, t * t);
        normal += weight * basis * basis.transpose();
    }
    let Some(inverse) = normal.try_inverse() else {
        return;
    };
    let mut coefficients = [Vector3::<f64>::zeros(); 22];
    for (p, coefficient) in coefficients.iter_mut().enumerate() {
        let mut rhs = Vector3::zeros();
        for &i in &good {
            let t = position(i);
            let weight = poses[i].quality * poses[i].quality;
            rhs += weight * poses[i].warp.to_vector()[p] * Vector3::new(1.0, t, t * t);
        }
        *coefficient = inverse * rhs;
    }
    for (i, pose) in poses.iter_mut().enumerate() {
        if i == reference {
            continue;
        }
        let t = position(i);
        let failed = pose.quality < MIN_QUALITY || !pose.warp.is_plausible();
        let s = if failed { 1.0 } else { POSE_SMOOTHING };
        let current = pose.warp.to_vector();
        let mut blended = [0f64; 22];
        for (p, value) in blended.iter_mut().enumerate() {
            let fitted = coefficients[p].dot(&Vector3::new(1.0, t, t * t));
            *value = current[p] * (1.0 - s) + fitted * s;
        }
        let candidate = pose.warp.with_vector(&blended);
        if candidate.is_plausible() {
            pose.warp = candidate;
        }
    }
}

pub fn align_stack(
    luma: &[Raster],
    reference: usize,
    report: &(dyn Fn(usize) + Sync),
) -> Vec<FramePose> {
    let (w, h) = (luma[reference].width, luma[reference].height);
    let identity = FramePose {
        warp: LensWarp::identity(w, h),
        quality: 1.0,
    };
    let mut poses = vec![identity; luma.len()];
    let below: Vec<usize> = (0..reference).rev().collect();
    let above: Vec<usize> = (reference + 1..luma.len()).collect();
    let solve_chain = |order: &[usize]| -> Vec<(usize, FramePose)> {
        let mut previous = LensWarp::identity(w, h);
        order
            .iter()
            .map(|&i| {
                report(i);
                let pyramid = build_pyramid(&luma[reference], &luma[i]);
                let mut pose = solve(&pyramid, previous);
                if pose.quality < MIN_QUALITY || !pose.warp.is_plausible() {
                    let retry = solve(&pyramid, LensWarp::identity(w, h));
                    if retry.quality > pose.quality {
                        pose = retry;
                    }
                }
                if pose.warp.is_plausible() {
                    previous = pose.warp;
                }
                (i, pose)
            })
            .collect()
    };
    let (lower, upper) = rayon::join(|| solve_chain(&below), || solve_chain(&above));
    for (i, pose) in lower.into_iter().chain(upper) {
        poses[i] = pose;
    }
    regularize(&mut poses, reference);
    poses
}
