use nalgebra::{DMatrix, DVector, Matrix3, Rotation3, Vector2, Vector3};
use rayon::prelude::*;

use crate::panorama_utils::features::{self, Features};
use crate::panorama_utils::ransac::{self, Point};

const MAX_ROTATION_SKEW: f64 = 4.0;
const BA_CHUNKS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub f: f64,
    pub r: Matrix3<f64>,
    pub cx: f64,
    pub cy: f64,
}

impl Camera {
    #[inline]
    pub fn scaled(&self, r: f64) -> Camera {
        if (r - 1.0).abs() < f64::EPSILON {
            return *self;
        }
        Camera {
            f: self.f * r,
            r: self.r,
            cx: self.cx * r,
            cy: self.cy * r,
        }
    }
    #[inline]
    pub fn ray(&self, x: f64, y: f64) -> Vector3<f64> {
        self.r.tr_mul(&Vector3::new(
            (x - self.cx) / self.f,
            (y - self.cy) / self.f,
            1.0,
        ))
    }
    #[inline]
    pub fn project(&self, d: Vector3<f64>) -> Option<(f64, f64)> {
        self.pixel(self.r * d)
    }
    #[inline]
    pub fn pixel(&self, p: Vector3<f64>) -> Option<(f64, f64)> {
        (p[2] > 1e-9).then(|| {
            (
                self.f * p[0] / p[2] + self.cx,
                self.f * p[1] / p[2] + self.cy,
            )
        })
    }
}

#[derive(Clone, Debug)]
pub struct PairMatch {
    pub i: usize,
    pub j: usize,
    pub h: Matrix3<f64>,
    pub pts: Vec<(Point, Point)>,
    pub levels: Vec<u8>,
}

pub fn match_pairs(
    feats: &[Features],
    scales: &[f64],
    stop: &crate::panorama_utils::log::StitchLog,
) -> Vec<PairMatch> {
    let n = feats.len();
    let pairs: Vec<(usize, usize)> = (0..n)
        .flat_map(|i| (i + 1..n).map(move |j| (i, j)))
        .collect();
    let mut out: Vec<PairMatch> = pairs
        .par_iter()
        .filter_map(|&(i, j)| {
            if stop.halted() {
                return None;
            }
            let m = features::match_features(&feats[i], &feats[j], 0.8);
            if m.len() < 12 {
                return None;
            }
            let a: Vec<Point> = m
                .iter()
                .map(|(p, _)| {
                    Point::new(feats[i].points[*p].x as f64, feats[i].points[*p].y as f64)
                })
                .collect();
            let b: Vec<Point> = m
                .iter()
                .map(|(_, q)| {
                    Point::new(feats[j].points[*q].x as f64, feats[j].points[*q].y as f64)
                })
                .collect();
            let fit = ransac::ransac(&a, &b, 3.0, 12, (i * 1000 + j) as u64)?;
            if (fit.inliers.len() as f64) <= 8.0 + 0.3 * m.len() as f64 {
                return None;
            }
            let (si, sj) = (scales[i], scales[j]);
            let pts = fit
                .inliers
                .iter()
                .map(|&k| {
                    (
                        Point::new(a[k].x / si, a[k].y / si),
                        Point::new(b[k].x / sj, b[k].y / sj),
                    )
                })
                .collect();
            let levels = fit
                .inliers
                .iter()
                .map(|&k| {
                    feats[i].points[m[k].0]
                        .level
                        .max(feats[j].points[m[k].1].level)
                })
                .collect();
            let scale = |s: f64| Matrix3::new_nonuniform_scaling(&Vector2::new(s, s));
            Some(PairMatch {
                i,
                j,
                h: scale(1.0 / sj) * fit.h * scale(si),
                pts,
                levels,
            })
        })
        .collect();
    out.sort_by_key(|p| (p.i, p.j));
    out
}

pub fn largest_component(n: usize, pairs: &[PairMatch]) -> Vec<usize> {
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut c = x;
        while p[c] != r {
            let nx = p[c];
            p[c] = r;
            c = nx;
        }
        r
    }
    for m in pairs {
        let (a, b) = (find(&mut parent, m.i), find(&mut parent, m.j));
        if a != b {
            parent[a] = b;
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    groups
        .into_values()
        .max_by_key(|g| g.len())
        .unwrap_or_default()
}

pub fn focals_from_homography(h: &Matrix3<f64>) -> (Option<f64>, Option<f64>) {
    let (h00, h01, h02) = (h[(0, 0)], h[(0, 1)], h[(0, 2)]);
    let (h10, h11, h12) = (h[(1, 0)], h[(1, 1)], h[(1, 2)]);
    let (h20, h21) = (h[(2, 0)], h[(2, 1)]);
    let pick = |n1: f64, d1: f64, n2: f64, d2: f64| -> Option<f64> {
        let a = (d1.abs() > 1e-12).then(|| n1 / d1).filter(|v| *v > 0.0);
        let b = (d2.abs() > 1e-12).then(|| n2 / d2).filter(|v| *v > 0.0);
        let v = match (a, b) {
            (Some(a), Some(b)) => {
                if d1.abs() > d2.abs() {
                    a
                } else {
                    b
                }
            }
            (Some(a), None) => a,
            (None, Some(b)) => b,
            _ => return None,
        };
        Some(v.sqrt())
    };
    let f0 = pick(
        -h02 * h12,
        h00 * h10 + h01 * h11,
        h12 * h12 - h02 * h02,
        h00 * h00 + h01 * h01 - h10 * h10 - h11 * h11,
    );
    let f1 = pick(
        -(h00 * h01 + h10 * h11),
        h20 * h21,
        h01 * h01 + h11 * h11 - h00 * h00 - h10 * h10,
        h20 * h20 - h21 * h21,
    );
    (f0, f1)
}

pub fn centred(h: &Matrix3<f64>, size_i: (usize, usize), size_j: (usize, usize)) -> Matrix3<f64> {
    let shift = |(w, h): (usize, usize), s: f64| {
        Matrix3::new_translation(&Vector2::new(s * w as f64 / 2.0, s * h as f64 / 2.0))
    };
    shift(size_j, -1.0) * h * shift(size_i, 1.0)
}

fn orthonormalize(m: &Matrix3<f64>) -> Matrix3<f64> {
    let svd = m.svd(true, true);
    match (svd.u, svd.v_t) {
        (Some(u), Some(v_t)) => u * v_t,
        _ => Matrix3::identity(),
    }
}

pub fn relative_rotation(
    h: &Matrix3<f64>,
    size_i: (usize, usize),
    size_j: (usize, usize),
    fi: f64,
    fj: f64,
) -> Option<Matrix3<f64>> {
    let k = |f: f64| Matrix3::from_diagonal(&Vector3::new(f, f, 1.0));
    let rel = k(1.0 / fj) * centred(h, size_i, size_j) * k(fi);
    let d = rel.determinant();
    if !d.is_finite() || d.abs() < 1e-12 {
        return None;
    }
    let rel = rel / d.cbrt();
    if rel[(2, 2)] <= 0.0 {
        return None;
    }
    let sv = (rel.transpose() * rel).symmetric_eigenvalues();
    (sv.max() <= MAX_ROTATION_SKEW * MAX_ROTATION_SKEW * sv.min()).then(|| orthonormalize(&rel))
}

pub fn initial_cameras(
    ids: &[usize],
    sizes: &[(usize, usize)],
    pairs: &[PairMatch],
    priors: &[f64],
    f0: f64,
) -> Vec<Option<Camera>> {
    let focal_for = |k: usize| -> f64 { priors.get(k).copied().filter(|v| *v > 0.0).unwrap_or(f0) };
    let n = sizes.len();
    let mut cams: Vec<Option<Camera>> = vec![None; n];
    let deg = |k: usize| {
        pairs
            .iter()
            .filter(|p| p.i == k || p.j == k)
            .map(|p| p.pts.len())
            .sum::<usize>()
    };
    let Some(&root) = ids.iter().max_by_key(|&&k| (deg(k), usize::MAX - k)) else {
        return cams;
    };
    let c = |k: usize| (sizes[k].0 as f64 / 2.0, sizes[k].1 as f64 / 2.0);
    cams[root] = Some(Camera {
        f: focal_for(root),
        r: Matrix3::identity(),
        cx: c(root).0,
        cy: c(root).1,
    });
    let mut edges: Vec<&PairMatch> = pairs
        .iter()
        .filter(|p| ids.contains(&p.i) && ids.contains(&p.j))
        .collect();
    edges.sort_by_key(|p| std::cmp::Reverse(p.pts.len()));
    loop {
        let mut grew = false;
        for e in &edges {
            let (known, new, h) = match (cams[e.i].is_some(), cams[e.j].is_some()) {
                (true, false) => (e.i, e.j, e.h),
                (false, true) => (
                    e.j,
                    e.i,
                    match e.h.try_inverse() {
                        Some(h) => h,
                        None => continue,
                    },
                ),
                _ => continue,
            };
            let Some(rel) = relative_rotation(
                &h,
                sizes[known],
                sizes[new],
                focal_for(known),
                focal_for(new),
            ) else {
                continue;
            };
            let Some(rk) = cams[known].map(|c| c.r) else {
                continue;
            };
            cams[new] = Some(Camera {
                f: focal_for(new),
                r: rel * rk,
                cx: c(new).0,
                cy: c(new).1,
            });
            grew = true;
        }
        if !grew {
            break;
        }
    }
    cams
}

#[derive(Clone, Debug)]
pub struct Adjusted {
    pub cameras: Vec<Option<Camera>>,
    pub rms: f64,
}

struct Obs {
    i: usize,
    j: usize,
    a: Point,
    b: Point,
}

fn residual(ci: &Camera, cj: &Camera, a: Point, b: Point) -> [f64; 4] {
    let big = 1e3;
    let p = ci.project(cj.ray(b.x, b.y));
    let q = cj.project(ci.ray(a.x, a.y));
    let (r0, r1) = p.map_or((big, big), |(x, y)| (x - a.x, y - a.y));
    let (r2, r3) = q.map_or((big, big), |(x, y)| (x - b.x, y - b.y));
    [r0, r1, r2, r3]
}

fn perturb(c: &Camera, k: usize, eps: f64) -> Camera {
    let mut c = *c;
    if k < 3 {
        let mut w = Vector3::zeros();
        w[k] = eps;
        c.r = Rotation3::new(w).into_inner() * c.r;
    } else {
        c.f += eps;
    }
    c
}

pub fn bundle_adjust(
    cams: &[Option<Camera>],
    pairs: &[PairMatch],
    anchor: usize,
    max_per_pair: usize,
    stop: &crate::panorama_utils::log::StitchLog,
) -> Adjusted {
    let idx: Vec<Option<usize>> = {
        let mut k = 0;
        cams.iter()
            .map(|c| {
                c.map(|_| {
                    k += 1;
                    k - 1
                })
            })
            .collect()
    };
    let m = idx.iter().flatten().count();
    let np = 4 * m;
    let mut obs = Vec::new();
    for p in pairs {
        if cams[p.i].is_none() || cams[p.j].is_none() {
            continue;
        }
        let fine: Vec<usize> = (0..p.pts.len())
            .filter(|&k| p.levels.get(k).is_none_or(|l| *l <= 1))
            .collect();
        let use_idx: Vec<usize> = if fine.len() >= 16 {
            fine
        } else {
            (0..p.pts.len()).collect()
        };
        let step = (use_idx.len() / max_per_pair.max(1)).max(1);
        for &k in use_idx.iter().step_by(step) {
            let (a, b) = p.pts[k];
            obs.push(Obs {
                i: p.i,
                j: p.j,
                a,
                b,
            });
        }
    }
    let mut cur: Vec<Option<Camera>> = cams.to_vec();
    let sigma = 2.0f64;
    let cost = |cs: &[Option<Camera>]| -> (f64, f64) {
        let (mut c, mut sq) = (0.0, 0.0);
        for o in &obs {
            let (Some(ci), Some(cj)) = (cs[o.i].as_ref(), cs[o.j].as_ref()) else {
                continue;
            };
            let r = residual(ci, cj, o.a, o.b);
            for v in r {
                let a = v.abs();
                sq += v * v;
                c += if a <= sigma {
                    0.5 * v * v
                } else {
                    sigma * (a - 0.5 * sigma)
                };
            }
        }
        (c, (sq / (obs.len().max(1) * 4) as f64).sqrt())
    };
    let (mut c0, _) = cost(&cur);
    let mut lambda = 1e-3;
    for _ in 0..100 {
        if stop.halted() {
            break;
        }
        let (jtj, jtr) = {
            let parts: Vec<(Vec<f64>, Vec<f64>)> = obs
                .par_chunks(obs.len().div_ceil(BA_CHUNKS).max(1))
                .map(|chunk| {
                    let mut jtj = vec![0.0f64; np * np];
                    let mut jtr = vec![0.0f64; np];
                    let mut cols: Vec<(usize, [f64; 4])> = Vec::with_capacity(8);
                    for o in chunk {
                        let (Some(ci), Some(cj)) = (cur[o.i].as_ref(), cur[o.j].as_ref()) else {
                            continue;
                        };
                        let r = residual(ci, cj, o.a, o.b);
                        cols.clear();
                        for (cam, which) in [(o.i, 0), (o.j, 1)] {
                            let Some(i) = idx[cam] else { continue };
                            let base = 4 * i;
                            for k in 0..4 {
                                if k < 3 && cam == anchor {
                                    continue;
                                }
                                let c = if which == 0 { ci } else { cj };
                                let eps = if k < 3 { 1e-6 } else { 1e-4 * c.f };
                                let pc = perturb(c, k, eps);
                                let rr = if which == 0 {
                                    residual(&pc, cj, o.a, o.b)
                                } else {
                                    residual(ci, &pc, o.a, o.b)
                                };
                                let mut d = [0.0; 4];
                                for t in 0..4 {
                                    d[t] = (rr[t] - r[t]) / eps;
                                }
                                cols.push((base + k, d));
                            }
                        }
                        for t in 0..4 {
                            let a = r[t].abs();
                            let w = if a <= sigma { 1.0 } else { sigma / a };
                            for &(p, dp) in &cols {
                                jtr[p] += w * dp[t] * r[t];
                                for &(q, dq) in &cols {
                                    jtj[p * np + q] += w * dp[t] * dq[t];
                                }
                            }
                        }
                    }
                    (jtj, jtr)
                })
                .collect();
            let mut jtj = vec![0.0f64; np * np];
            let mut jtr = vec![0.0f64; np];
            for (pa, pb) in parts {
                for (x, y) in jtj.iter_mut().zip(&pa) {
                    *x += y;
                }
                for (x, y) in jtr.iter_mut().zip(&pb) {
                    *x += y;
                }
            }
            (jtj, jtr)
        };
        let mut improved = false;
        for _ in 0..10 {
            let mut a = jtj.clone();
            for p in 0..np {
                let d = a[p * np + p];
                a[p * np + p] = d + lambda * d.max(1e-9) + 1e-12;
            }
            let Some(delta) = DMatrix::from_row_slice(np, np, &a)
                .lu()
                .solve(&-DVector::from_column_slice(&jtr))
                .filter(|d| d.iter().all(|v| v.is_finite()))
            else {
                lambda *= 10.0;
                continue;
            };
            let mut trial = cur.clone();
            for (cam, c) in trial.iter_mut().enumerate() {
                let (Some(c), Some(b)) = (c.as_mut(), idx[cam]) else {
                    continue;
                };
                let b = 4 * b;
                if cam != anchor {
                    let w = delta.fixed_rows::<3>(b).into_owned();
                    c.r = orthonormalize(&(Rotation3::new(w).into_inner() * c.r));
                }
                c.f = (c.f + delta[b + 3]).max(1.0);
            }
            let (c1, _) = cost(&trial);
            if c1 < c0 {
                let rel = (c0 - c1) / c0.max(1e-300);
                cur = trial;
                c0 = c1;
                lambda = (lambda * 0.3).max(1e-9);
                improved = rel > 1e-9;
                break;
            }
            lambda *= 10.0;
        }
        if !improved {
            break;
        }
    }
    let (_, rms) = cost(&cur);
    Adjusted { cameras: cur, rms }
}

fn flatten(v: Vector3<f64>, axis: Vector3<f64>) -> Vector3<f64> {
    v - axis * v.dot(&axis)
}

fn unit(v: Vector3<f64>) -> Vector3<f64> {
    v.try_normalize(0.0).unwrap_or(v)
}

pub fn straighten(cams: &mut [Option<Camera>]) {
    let rs: Vec<Matrix3<f64>> = cams.iter().flatten().map(|c| c.r).collect();
    if rs.is_empty() {
        return;
    }
    let row = |r: &Matrix3<f64>, k: usize| r.row(k).transpose();
    let cov: Matrix3<f64> = rs.iter().map(|r| row(r, 0) * row(r, 0).transpose()).sum();
    let xsum: Vector3<f64> = rs.iter().map(|r| row(r, 0)).sum();
    let ysum: Vector3<f64> = rs.iter().map(|r| row(r, 1)).sum();
    let zsum: Vector3<f64> = rs.iter().map(|r| row(r, 2)).sum();
    let eig = cov.symmetric_eigen();
    let mut order = [0, 1, 2];
    order.sort_by(|&a, &b| eig.eigenvalues[a].total_cmp(&eig.eigenvalues[b]));
    let mut down = eig.eigenvectors.column(order[0]).into_owned();
    if eig.eigenvalues[order[1]] < 0.05 * eig.eigenvalues[order[2]] {
        down = unit(flatten(ysum, unit(xsum)));
    }
    if down.dot(&ysum) < 0.0 {
        down = -down;
    }
    let mut fwd = flatten(zsum, down);
    if fwd.norm() < 1e-3 * rs.len() as f64 {
        fwd = rs
            .iter()
            .map(|r| flatten(row(r, 2), down))
            .max_by(|a, b| a.norm().total_cmp(&b.norm()))
            .unwrap_or(fwd);
    }
    let fwd = unit(fwd);
    let wt = Matrix3::from_columns(&[down.cross(&fwd), down, fwd]);
    for c in cams.iter_mut().flatten() {
        c.r *= wt;
    }
}
