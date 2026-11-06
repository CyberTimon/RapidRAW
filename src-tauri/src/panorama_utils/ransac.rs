use nalgebra::{Matrix3, Point2, SMatrix, SVector, Vector2};
use rand::SeedableRng;
use rand::rngs::SmallRng;
use rand::seq::index;

pub type Point = Point2<f64>;

const SAMPLE_SIZE: usize = 4;

#[derive(Clone, Debug)]
pub struct Fit {
    pub h: Matrix3<f64>,
    pub inliers: Vec<usize>,
}

fn normaliser(p: &[Point]) -> Matrix3<f64> {
    let n = p.len().max(1) as f64;
    let c = p.iter().map(|q| q.coords).sum::<Vector2<f64>>() / n;
    let md = p.iter().map(|q| (q.coords - c).norm()).sum::<f64>() / n;
    let s = if md > 1e-12 {
        std::f64::consts::SQRT_2 / md
    } else {
        1.0
    };
    Matrix3::new(s, 0.0, -s * c.x, 0.0, s, -s * c.y, 0.0, 0.0, 1.0)
}

pub fn dlt(a: &[Point], b: &[Point]) -> Option<Matrix3<f64>> {
    if a.len() < 4 {
        return None;
    }
    let ta = normaliser(a);
    let tb = normaliser(b);
    let mut ata = SMatrix::<f64, 9, 9>::zeros();
    for (p, q) in a.iter().zip(b) {
        let (p, q) = (ta.transform_point(p), tb.transform_point(q));
        let (x, y, u, v) = (p.x, p.y, q.x, q.y);
        for r in [
            SVector::<f64, 9>::from([-x, -y, -1.0, 0.0, 0.0, 0.0, u * x, u * y, u]),
            SVector::<f64, 9>::from([0.0, 0.0, 0.0, -x, -y, -1.0, v * x, v * y, v]),
        ] {
            ata += r * r.transpose();
        }
    }
    let eig = ata.symmetric_eigen();
    let h = eig.eigenvectors.column(eig.eigenvalues.imin());
    let hn = Matrix3::from_row_iterator(h.iter().copied());
    let h = tb.try_inverse()? * hn * ta;
    let s = h[(2, 2)];
    if s.abs() < 1e-14 || h.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some(h / s)
}

pub fn apply(h: &Matrix3<f64>, p: Point) -> Point {
    let v = h * p.to_homogeneous();
    Point::from(v.xy() / v.z.clamp(1e-300, f64::MAX))
}

pub fn transfer_error2(h: &Matrix3<f64>, a: Point, b: Point) -> f64 {
    (apply(h, a) - b).norm_squared()
}

fn from_quads(src: &[Point; 4], dst: &[Point; 4]) -> Option<Matrix3<f64>> {
    let mut a = [0.0; 64];
    let mut rhs = [0.0; 8];
    for (i, (p, q)) in src.iter().zip(dst).enumerate() {
        let (x, y, u, v) = (p.x, p.y, q.x, q.y);
        a[16 * i..16 * i + 16].copy_from_slice(&[
            x,
            y,
            1.0,
            0.0,
            0.0,
            0.0,
            -u * x,
            -u * y,
            0.0,
            0.0,
            0.0,
            x,
            y,
            1.0,
            -v * x,
            -v * y,
        ]);
        rhs[2 * i] = u;
        rhs[2 * i + 1] = v;
    }
    let h = SMatrix::<f64, 8, 8>::from_row_slice(&a)
        .lu()
        .solve(&SVector::from(rhs))?;
    Some(Matrix3::new(
        h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0,
    ))
}

pub fn ransac(a: &[Point], b: &[Point], thresh: f64, min_inliers: usize, seed: u64) -> Option<Fit> {
    let n = a.len().min(b.len());
    let k = SAMPLE_SIZE;
    if n < k.max(min_inliers) {
        return None;
    }
    let t2 = thresh * thresh;
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut best: Vec<usize> = Vec::new();
    let mut best_h = None;
    let mut iters = 2000usize;
    let mut it = 0;
    while it < iters {
        it += 1;
        let idx = index::sample(&mut rng, n, SAMPLE_SIZE);
        let src: [Point; SAMPLE_SIZE] = std::array::from_fn(|s| a[idx.index(s)]);
        let dst: [Point; SAMPLE_SIZE] = std::array::from_fn(|s| b[idx.index(s)]);
        if degenerate(&src) || degenerate(&dst) {
            continue;
        }
        let Some(h) = from_quads(&src, &dst) else {
            continue;
        };
        let inl: Vec<usize> = (0..n)
            .filter(|&i| transfer_error2(&h, a[i], b[i]) < t2)
            .collect();
        if inl.len() > best.len() {
            best = inl;
            best_h = Some(h);
            let w = best.len() as f64 / n as f64;
            let p_fail = 1.0 - w.powi(k as i32);
            if p_fail <= 1e-12 {
                iters = it;
            } else {
                let need = ((1e-3f64).ln() / p_fail.ln()).ceil();
                iters = iters.min(need.max(16.0) as usize);
            }
        }
    }
    if best.len() < min_inliers.max(k) {
        return None;
    }
    let mut h = best_h?;
    for _ in 0..3 {
        let ia: Vec<Point> = best.iter().map(|&i| a[i]).collect();
        let ib: Vec<Point> = best.iter().map(|&i| b[i]).collect();
        let Some(hh) = dlt(&ia, &ib) else {
            break;
        };
        let inl: Vec<usize> = (0..n)
            .filter(|&i| transfer_error2(&hh, a[i], b[i]) < t2)
            .collect();
        if inl.len() < best.len() {
            break;
        }
        h = hh;
        if inl == best {
            break;
        }
        best = inl;
    }
    if best.len() < min_inliers.max(k) {
        return None;
    }
    Some(Fit { h, inliers: best })
}

fn degenerate(p: &[Point; 4]) -> bool {
    for (i, j, k) in [(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)] {
        let area =
            ((p[j].x - p[i].x) * (p[k].y - p[i].y) - (p[j].y - p[i].y) * (p[k].x - p[i].x)).abs();
        let scale = nalgebra::distance(&p[i], &p[j])
            .max(nalgebra::distance(&p[i], &p[k]))
            .max(1e-9);
        if area < 1e-3 * scale * scale {
            return true;
        }
    }
    false
}
