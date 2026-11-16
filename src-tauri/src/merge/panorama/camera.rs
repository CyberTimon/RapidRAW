use super::homography::Correspondence;
use super::raster::Raster;
use nalgebra::{DMatrix, DVector, Matrix3, Rotation3, SymmetricEigen, Vector2, Vector3};
use rayon::prelude::*;
use std::collections::VecDeque;

const MAX_ITERATIONS: usize = 60;
const MIN_RELATIVE_IMPROVEMENT: f64 = 1e-7;
const ROTATION_STEP: f64 = 1e-6;
const FOCAL_STEP: f64 = 1e-7;
const DISTORTION_STEP: f64 = 1e-6;
const MAX_DISTORTION: f64 = 0.4;
const DISTORTION_PRIOR_WEIGHT: f64 = 1.0;
const DEGENERATE_SPREAD: f64 = 2e-3;

#[derive(Clone, Debug)]
pub struct Camera {
    pub rotation: Matrix3<f64>,
    pub focal: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Lens {
    pub k1: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Horizontal,
    Vertical,
}

pub struct PairObservation {
    pub a: usize,
    pub b: usize,
    pub points: Vec<Correspondence>,
    pub homography: Matrix3<f64>,
    pub confidence: f64,
}

pub struct BundleOptions {
    pub shared_focal: bool,
    pub estimate_distortion: bool,
    pub huber_threshold: f64,
}

impl Camera {
    pub fn radius_norm(&self) -> f64 {
        0.5 * self.width.hypot(self.height)
    }

    #[inline]
    pub fn undistort(&self, lens: &Lens, p: Vector2<f64>) -> Vector2<f64> {
        if lens.k1 == 0.0 {
            return p;
        }
        let r_norm = self.radius_norm();
        let r2 = p.norm_squared() / (r_norm * r_norm);
        p * (1.0 + lens.k1 * r2)
    }

    #[inline]
    pub fn distort(&self, lens: &Lens, p: Vector2<f64>) -> Option<Vector2<f64>> {
        if lens.k1 == 0.0 {
            return Some(p);
        }
        let r_norm = self.radius_norm();
        let ru = p.norm() / r_norm;
        if ru < 1e-12 {
            return Some(p);
        }
        let rd_max = if lens.k1 < 0.0 {
            (-1.0 / (3.0 * lens.k1)).sqrt()
        } else {
            f64::INFINITY
        };
        if lens.k1 < 0.0 && ru >= rd_max * (1.0 + lens.k1 * rd_max * rd_max) {
            return None;
        }
        let mut rd = ru.min(0.99 * rd_max);
        for _ in 0..8 {
            let g = rd + lens.k1 * rd * rd * rd - ru;
            if g.abs() < 1e-9 * ru.max(1.0) {
                break;
            }
            let dg = 1.0 + 3.0 * lens.k1 * rd * rd;
            if dg <= 1e-9 {
                return None;
            }
            rd = (rd - g / dg).clamp(0.0, 0.99 * rd_max);
        }
        let residual = rd + lens.k1 * rd * rd * rd - ru;
        (residual.abs() < 1e-6 * ru.max(1.0)).then(|| p * (rd / ru))
    }

    #[inline]
    pub fn ray(&self, lens: &Lens, p: Vector2<f64>) -> Vector3<f64> {
        let u = self.undistort(lens, p);
        self.rotation.transpose() * Vector3::new(u.x, u.y, self.focal).normalize()
    }

    #[inline]
    pub fn project(&self, lens: &Lens, ray: &Vector3<f64>) -> Option<Vector2<f64>> {
        let c = self.rotation * ray;
        if c.z <= 1e-9 {
            return None;
        }
        let u = Vector2::new(self.focal * c.x / c.z, self.focal * c.y / c.z);
        self.distort(lens, u)
    }

    pub fn level_position(&self, level: &Raster, p: &Vector2<f64>) -> (f64, f64) {
        (
            (p.x + 0.5 * self.width) * (level.width as f64 / self.width) - 0.5,
            (p.y + 0.5 * self.height) * (level.height as f64 / self.height) - 0.5,
        )
    }

    pub fn contains(&self, p: &Vector2<f64>) -> bool {
        p.x.abs() <= 0.5 * self.width && p.y.abs() <= 0.5 * self.height
    }
}

pub fn focal_from_35mm(focal_35mm: f64, width: f64, height: f64) -> f64 {
    const FULL_FRAME_DIAGONAL: f64 = 43.266_615;
    focal_35mm * width.hypot(height) / FULL_FRAME_DIAGONAL
}

fn focals_from_homography(h: &Matrix3<f64>) -> Option<f64> {
    let h = h.transpose();
    let h = h.as_slice();
    let candidate = |d1: f64, d2: f64, v1: f64, v2: f64| -> Option<f64> {
        let (v1, v2) = if v1 < v2 { (v2, v1) } else { (v1, v2) };
        if v1 > 0.0 && v2 > 0.0 {
            Some(if d1.abs() > d2.abs() { v1 } else { v2 }.sqrt())
        } else if v1 > 0.0 {
            Some(v1.sqrt())
        } else {
            None
        }
    };

    let d1 = h[6] * h[7];
    let d2 = (h[7] - h[6]) * (h[7] + h[6]);
    let v1 = -(h[0] * h[1] + h[3] * h[4]) / d1;
    let v2 = (h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4]) / d2;
    let f1 = candidate(d1, d2, v1, v2)?;

    let d1 = h[0] * h[3] + h[1] * h[4];
    let d2 = h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4];
    let v1 = -h[2] * h[5] / d1;
    let v2 = (h[5] * h[5] - h[2] * h[2]) / d2;
    let f0 = candidate(d1, d2, v1, v2)?;

    let f = (f0 * f1).sqrt();
    f.is_finite().then_some(f)
}

pub fn estimate_focal_from_homographies(pairs: &[PairObservation]) -> Option<f64> {
    let mut focals: Vec<f64> = pairs
        .iter()
        .filter_map(|p| focals_from_homography(&p.homography))
        .collect();
    if focals.is_empty() {
        return None;
    }
    focals.sort_by(|a, b| a.total_cmp(b));
    Some(focals[focals.len() / 2])
}

fn nearest_rotation(m: &Matrix3<f64>) -> Matrix3<f64> {
    let svd = m.svd(true, true);
    let (u, v_t) = (svd.u.unwrap(), svd.v_t.unwrap());
    let mut r = u * v_t;
    if r.determinant() < 0.0 {
        let mut u = u;
        u.column_mut(2).neg_mut();
        r = u * v_t;
    }
    r
}

pub fn initialize_rotations(cameras: &mut [Camera], pairs: &[PairObservation]) -> usize {
    let n = cameras.len();
    if n == 0 {
        return 0;
    }
    let mut edges: Vec<usize> = (0..pairs.len()).collect();
    edges.sort_by(|&a, &b| pairs[b].confidence.total_cmp(&pairs[a].confidence));

    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], i: usize) -> usize {
        let mut root = i;
        while parent[root] != root {
            root = parent[root];
        }
        let mut node = i;
        while parent[node] != root {
            let next = parent[node];
            parent[node] = root;
            node = next;
        }
        root
    }

    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); n];
    for e in edges {
        let (a, b) = (pairs[e].a, pairs[e].b);
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra != rb {
            parent[ra] = rb;
            adjacency[a].push(e);
            adjacency[b].push(e);
        }
    }

    let center = tree_center(&adjacency, pairs, n);
    let mut visited = vec![false; n];
    let mut queue = VecDeque::new();
    cameras[center].rotation = Matrix3::identity();
    visited[center] = true;
    queue.push_back(center);
    while let Some(i) = queue.pop_front() {
        for &e in &adjacency[i] {
            let pair = &pairs[e];
            let j = if pair.a == i { pair.b } else { pair.a };
            if visited[j] {
                continue;
            }
            let (from, to, h) = if pair.a == i {
                (i, j, pair.homography)
            } else {
                (
                    i,
                    j,
                    pair.homography.try_inverse().unwrap_or(Matrix3::identity()),
                )
            };
            let k_from = intrinsics(&cameras[from]);
            let k_to_inv = intrinsics(&cameras[to])
                .try_inverse()
                .unwrap_or(Matrix3::identity());
            let relative = nearest_rotation(&(k_to_inv * h * k_from));
            cameras[to].rotation = relative * cameras[from].rotation;
            visited[j] = true;
            queue.push_back(j);
        }
    }
    center
}

fn intrinsics(camera: &Camera) -> Matrix3<f64> {
    Matrix3::new(
        camera.focal,
        0.0,
        0.0,
        0.0,
        camera.focal,
        0.0,
        0.0,
        0.0,
        1.0,
    )
}

fn tree_center(adjacency: &[Vec<usize>], pairs: &[PairObservation], n: usize) -> usize {
    let eccentricity = |start: usize| -> usize {
        let mut depth = vec![usize::MAX; n];
        depth[start] = 0;
        let mut queue = VecDeque::from([start]);
        let mut max_depth = 0;
        while let Some(i) = queue.pop_front() {
            for &e in &adjacency[i] {
                let j = if pairs[e].a == i {
                    pairs[e].b
                } else {
                    pairs[e].a
                };
                if depth[j] == usize::MAX {
                    depth[j] = depth[i] + 1;
                    max_depth = max_depth.max(depth[j]);
                    queue.push_back(j);
                }
            }
        }
        max_depth
    };
    (0..n).min_by_key(|&i| eccentricity(i)).unwrap_or(0)
}

struct ParameterLayout {
    rotation: Vec<Option<usize>>,
    focal: Vec<usize>,
    distortion: Option<usize>,
    count: usize,
}

impl ParameterLayout {
    fn new(n: usize, reference: usize, options: &BundleOptions) -> Self {
        let mut count = 0;
        let rotation = (0..n)
            .map(|i| {
                if i == reference {
                    None
                } else {
                    count += 3;
                    Some(count - 3)
                }
            })
            .collect();
        let focal = if options.shared_focal {
            count += 1;
            vec![count - 1; n]
        } else {
            (0..n)
                .map(|_| {
                    count += 1;
                    count - 1
                })
                .collect()
        };
        let distortion = options.estimate_distortion.then(|| {
            count += 1;
            count - 1
        });
        ParameterLayout {
            rotation,
            focal,
            distortion,
            count,
        }
    }

    fn local_parameters(&self, a: usize, b: usize) -> Vec<usize> {
        let mut params = Vec::with_capacity(9);
        for cam in [a, b] {
            if let Some(r) = self.rotation[cam] {
                params.extend([r, r + 1, r + 2]);
            }
            if !params.contains(&self.focal[cam]) {
                params.push(self.focal[cam]);
            }
        }
        if let Some(d) = self.distortion {
            params.push(d);
        }
        params
    }
}

fn apply_update(
    cameras: &mut [Camera],
    lens: &mut Lens,
    layout: &ParameterLayout,
    delta: &DVector<f64>,
) {
    for (i, camera) in cameras.iter_mut().enumerate() {
        if let Some(r) = layout.rotation[i] {
            let omega = Vector3::new(delta[r], delta[r + 1], delta[r + 2]);
            camera.rotation = Rotation3::new(omega).into_inner() * camera.rotation;
        }
        camera.focal *= delta[layout.focal[i]].clamp(-0.5, 0.5).exp();
    }
    if let Some(d) = layout.distortion {
        lens.k1 = (lens.k1 + delta[d]).clamp(-MAX_DISTORTION, MAX_DISTORTION);
    }
}

fn perturbed(
    cameras: &[Camera],
    lens: &Lens,
    layout: &ParameterLayout,
    a: usize,
    b: usize,
    param: usize,
    step: f64,
) -> (Camera, Camera, Lens) {
    let mut ca = cameras[a].clone();
    let mut cb = cameras[b].clone();
    let mut l = *lens;
    for (cam, idx) in [(&mut ca, a), (&mut cb, b)] {
        if let Some(r) = layout.rotation[idx]
            && param >= r
            && param < r + 3
        {
            let mut omega = Vector3::zeros();
            omega[param - r] = step;
            cam.rotation = Rotation3::new(omega).into_inner() * cam.rotation;
        }
        if layout.focal[idx] == param {
            cam.focal *= step.exp();
        }
    }
    if layout.distortion == Some(param) {
        l.k1 += step;
    }
    (ca, cb, l)
}

#[inline]
pub fn pair_residual(
    ca: &Camera,
    cb: &Camera,
    lens: &Lens,
    correspondence: &Correspondence,
) -> Vector3<f64> {
    let ra = ca.ray(lens, correspondence.0);
    let rb = cb.ray(lens, correspondence.1);
    (ra - rb) * (ca.focal * cb.focal).sqrt()
}

#[inline]
fn huber(norm: f64, threshold: f64) -> (f64, f64) {
    if norm <= threshold {
        (0.5 * norm * norm, 1.0)
    } else {
        (threshold * (norm - 0.5 * threshold), threshold / norm)
    }
}

fn total_cost(
    cameras: &[Camera],
    lens: &Lens,
    pairs: &[PairObservation],
    options: &BundleOptions,
) -> f64 {
    let data: f64 = pairs
        .par_iter()
        .map(|pair| {
            pair.points
                .iter()
                .map(|c| {
                    let r = pair_residual(&cameras[pair.a], &cameras[pair.b], lens, c);
                    huber(r.norm(), options.huber_threshold).0
                })
                .sum::<f64>()
        })
        .sum();
    data + distortion_prior(lens, pairs, options)
}

fn distortion_prior(lens: &Lens, pairs: &[PairObservation], options: &BundleOptions) -> f64 {
    if !options.estimate_distortion {
        return 0.0;
    }
    let count: usize = pairs.iter().map(|p| p.points.len()).sum();
    0.5 * DISTORTION_PRIOR_WEIGHT * count as f64 * lens.k1 * lens.k1
}

fn step_size(layout: &ParameterLayout, param: usize) -> f64 {
    if layout.distortion == Some(param) {
        DISTORTION_STEP
    } else if layout.focal.contains(&param) {
        FOCAL_STEP
    } else {
        ROTATION_STEP
    }
}

fn normal_equations(
    cameras: &[Camera],
    lens: &Lens,
    pairs: &[PairObservation],
    layout: &ParameterLayout,
    options: &BundleOptions,
) -> (DMatrix<f64>, DVector<f64>) {
    let p = layout.count;
    let (mut jtj, mut jtr) = pairs
        .par_iter()
        .fold(
            || (DMatrix::<f64>::zeros(p, p), DVector::<f64>::zeros(p)),
            |(mut jtj, mut jtr), pair| {
                let params = layout.local_parameters(pair.a, pair.b);
                let variants: Vec<(Camera, Camera, Lens, Camera, Camera, Lens, f64)> = params
                    .iter()
                    .map(|&param| {
                        let h = step_size(layout, param);
                        let (pa, pb, pl) =
                            perturbed(cameras, lens, layout, pair.a, pair.b, param, h);
                        let (ma, mb, ml) =
                            perturbed(cameras, lens, layout, pair.a, pair.b, param, -h);
                        (pa, pb, pl, ma, mb, ml, h)
                    })
                    .collect();
                let mut columns = vec![Vector3::zeros(); params.len()];
                for c in &pair.points {
                    let r = pair_residual(&cameras[pair.a], &cameras[pair.b], lens, c);
                    let (_, weight) = huber(r.norm(), options.huber_threshold);
                    for (k, (pa, pb, pl, ma, mb, ml, h)) in variants.iter().enumerate() {
                        let plus = pair_residual(pa, pb, pl, c);
                        let minus = pair_residual(ma, mb, ml, c);
                        columns[k] = (plus - minus) / (2.0 * h);
                    }
                    for (k, &pk) in params.iter().enumerate() {
                        jtr[pk] += weight * columns[k].dot(&r);
                        for (l, &pl) in params.iter().enumerate() {
                            jtj[(pk, pl)] += weight * columns[k].dot(&columns[l]);
                        }
                    }
                }
                (jtj, jtr)
            },
        )
        .reduce(
            || (DMatrix::<f64>::zeros(p, p), DVector::<f64>::zeros(p)),
            |(a1, b1), (a2, b2)| (a1 + a2, b1 + b2),
        );

    if let Some(d) = layout.distortion {
        let count: usize = pairs.iter().map(|p| p.points.len()).sum();
        let w = DISTORTION_PRIOR_WEIGHT * count as f64;
        jtj[(d, d)] += w;
        jtr[d] += w * lens.k1;
    }
    (jtj, jtr)
}

pub fn bundle_adjust(
    cameras: &mut [Camera],
    lens: &mut Lens,
    pairs: &[PairObservation],
    reference: usize,
    options: &BundleOptions,
) -> f64 {
    let layout = ParameterLayout::new(cameras.len(), reference, options);
    if layout.count == 0 || pairs.is_empty() {
        return 0.0;
    }
    let mut cost = total_cost(cameras, lens, pairs, options);
    let mut lambda = 1e-3;

    for _ in 0..MAX_ITERATIONS {
        let (jtj, jtr) = normal_equations(cameras, lens, pairs, &layout, options);
        let mut improved = false;
        while lambda < 1e10 {
            let mut a = jtj.clone();
            for k in 0..layout.count {
                a[(k, k)] += lambda * jtj[(k, k)].max(1e-9) + 1e-12;
            }
            let Some(chol) = a.cholesky() else {
                lambda *= 10.0;
                continue;
            };
            let delta = -chol.solve(&jtr);
            let mut trial_cameras = cameras.to_vec();
            let mut trial_lens = *lens;
            apply_update(&mut trial_cameras, &mut trial_lens, &layout, &delta);
            let trial_cost = total_cost(&trial_cameras, &trial_lens, pairs, options);
            if trial_cost < cost {
                let relative = (cost - trial_cost) / cost.max(1e-12);
                cameras.clone_from_slice(&trial_cameras);
                *lens = trial_lens;
                cost = trial_cost;
                lambda = (lambda / 3.0).max(1e-9);
                improved = relative > MIN_RELATIVE_IMPROVEMENT;
                break;
            }
            lambda *= 4.0;
        }
        if !improved {
            break;
        }
    }
    cost
}

pub fn pair_errors(cameras: &[Camera], lens: &Lens, pairs: &[PairObservation]) -> Vec<f64> {
    pairs
        .par_iter()
        .map(|pair| {
            let mut errors: Vec<f64> = pair
                .points
                .iter()
                .map(|c| pair_residual(&cameras[pair.a], &cameras[pair.b], lens, c).norm())
                .collect();
            if errors.is_empty() {
                return 0.0;
            }
            errors.sort_by(|a, b| a.total_cmp(b));
            errors[errors.len() / 2]
        })
        .collect()
}

pub fn straighten(cameras: &mut [Camera]) -> Orientation {
    let n = cameras.len() as f64;
    let mut moment_x = Matrix3::zeros();
    let mut moment_y = Matrix3::zeros();
    let mut sum_x = Vector3::zeros();
    let mut sum_y = Vector3::zeros();
    let mut sum_z = Vector3::zeros();
    for camera in cameras.iter() {
        let x: Vector3<f64> = camera.rotation.row(0).transpose();
        let y: Vector3<f64> = camera.rotation.row(1).transpose();
        let z: Vector3<f64> = camera.rotation.row(2).transpose();
        moment_x += x * x.transpose();
        moment_y += y * y.transpose();
        sum_x += x;
        sum_y += y;
        sum_z += z;
    }

    let eigen_x = SymmetricEigen::new(moment_x / n);
    let eigen_y = SymmetricEigen::new(moment_y / n);
    let sorted = |e: &SymmetricEigen<f64, nalgebra::U3>| {
        let mut idx = [0usize, 1, 2];
        idx.sort_by(|&a, &b| e.eigenvalues[b].total_cmp(&e.eigenvalues[a]));
        idx
    };
    let order_x = sorted(&eigen_x);
    let order_y = sorted(&eigen_y);
    let spread_x = eigen_x.eigenvalues[order_x[1]];
    let spread_y = eigen_y.eigenvalues[order_y[1]];

    let (orientation, right, down) = if spread_x >= spread_y {
        let mean_up = -sum_y.normalize();
        let up = if spread_x < DEGENERATE_SPREAD {
            mean_up
        } else {
            let axis: Vector3<f64> = eigen_x.eigenvectors.column(order_x[2]).into();
            if axis.dot(&mean_up) < 0.0 {
                -axis
            } else {
                axis
            }
        };
        let down = -up;
        let forward = (sum_z - down * sum_z.dot(&down)).normalize();
        (Orientation::Horizontal, down.cross(&forward), down)
    } else {
        let right = sum_x.normalize();
        let down = (sum_y - right * sum_y.dot(&right)).normalize();
        (Orientation::Vertical, right, down)
    };
    let forward = right.cross(&down);
    let mut world = Matrix3::from_rows(&[right.transpose(), down.transpose(), forward.transpose()]);
    if orientation == Orientation::Vertical {
        let quarter_turn = Matrix3::new(0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
        world = quarter_turn * world;
    }
    if !world.iter().all(|v| v.is_finite()) {
        return Orientation::Horizontal;
    }
    let world_t = world.transpose();
    for camera in cameras.iter_mut() {
        camera.rotation *= world_t;
    }
    orientation
}
