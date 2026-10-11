pub type M3 = [[f64; 3]; 3];

pub const I3: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub fn mul3(a: &M3, b: &M3) -> M3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}

pub fn apply3(a: &M3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}

pub fn transpose3(a: &M3) -> M3 {
    [0, 1, 2].map(|i| [a[0][i], a[1][i], a[2][i]])
}

pub fn det3(a: &M3) -> f64 {
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
}

pub fn inv3(a: &M3) -> Option<M3> {
    let d = det3(a);
    if d.abs() < 1e-300 || !d.is_finite() {
        return None;
    }
    let c =
        |r0: usize, c0: usize, r1: usize, c1: usize| a[r0][c0] * a[r1][c1] - a[r0][c1] * a[r1][c0];
    Some([
        [c(1, 1, 2, 2) / d, -c(0, 1, 2, 2) / d, c(0, 1, 1, 2) / d],
        [-c(1, 0, 2, 2) / d, c(0, 0, 2, 2) / d, -c(0, 0, 1, 2) / d],
        [c(1, 0, 2, 1) / d, -c(0, 0, 2, 1) / d, c(0, 0, 1, 1) / d],
    ])
}

pub fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

pub fn normalize(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    if n > 0.0 { a.map(|v| v / n) } else { a }
}

pub fn rodrigues(w: [f64; 3]) -> M3 {
    let th = norm(w);
    if th < 1e-12 {
        return [[1.0, -w[2], w[1]], [w[2], 1.0, -w[0]], [-w[1], w[0], 1.0]];
    }
    let k = w.map(|v| v / th);
    let (s, c) = th.sin_cos();
    let v = 1.0 - c;
    [
        [
            c + k[0] * k[0] * v,
            k[0] * k[1] * v - k[2] * s,
            k[0] * k[2] * v + k[1] * s,
        ],
        [
            k[1] * k[0] * v + k[2] * s,
            c + k[1] * k[1] * v,
            k[1] * k[2] * v - k[0] * s,
        ],
        [
            k[2] * k[0] * v - k[1] * s,
            k[2] * k[1] * v + k[0] * s,
            c + k[2] * k[2] * v,
        ],
    ]
}

pub fn rotation_vector(r: &M3) -> [f64; 3] {
    let tr = (r[0][0] + r[1][1] + r[2][2] - 1.0) / 2.0;
    let th = tr.clamp(-1.0, 1.0).acos();
    let a = [r[2][1] - r[1][2], r[0][2] - r[2][0], r[1][0] - r[0][1]];
    if th < 1e-9 {
        return a.map(|v| v / 2.0);
    }
    if (std::f64::consts::PI - th).abs() < 1e-6 {
        let b =
            [0, 1, 2].map(|i| [0, 1, 2].map(|j| (r[i][j] + if i == j { 1.0 } else { 0.0 }) / 2.0));
        let i = (0..3)
            .max_by(|&x, &y| b[x][x].total_cmp(&b[y][y]))
            .unwrap_or(0);
        let axis = normalize(b[i]);
        return axis.map(|v| v * th);
    }
    let s = th / (2.0 * th.sin());
    a.map(|v| v * s)
}

pub fn orthonormalize(m: &M3) -> M3 {
    let mut x = *m;
    for _ in 0..20 {
        let Some(inv) = inv3(&x) else { return I3 };
        let it = transpose3(&inv);
        let mut n = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                n[i][j] = 0.5 * (x[i][j] + it[i][j]);
            }
        }
        x = n;
    }
    if det3(&x) < 0.0 {
        for row in x.iter_mut() {
            row[2] = -row[2];
        }
    }
    x
}

pub fn solve(mut a: Vec<f64>, mut b: Vec<f64>, n: usize) -> Option<Vec<f64>> {
    for col in 0..n {
        let piv =
            (col..n).max_by(|&i, &j| a[i * n + col].abs().total_cmp(&a[j * n + col].abs()))?;
        let pv = a[piv * n + col];
        if pv.abs() < 1e-300 || !pv.is_finite() {
            return None;
        }
        if piv != col {
            for k in 0..n {
                a.swap(piv * n + k, col * n + k);
            }
            b.swap(piv, col);
        }
        for r in col + 1..n {
            let f = a[r * n + col] / a[col * n + col];
            if f != 0.0 {
                for k in col..n {
                    a[r * n + k] -= f * a[col * n + k];
                }
                b[r] -= f * b[col];
            }
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let s: f64 = (r + 1..n).map(|k| a[r * n + k] * x[k]).sum();
        x[r] = (b[r] - s) / a[r * n + r];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

pub fn sym_eigen(a: &[f64], n: usize) -> (Vec<f64>, Vec<Vec<f64>>) {
    let mut m = a.to_vec();
    let mut v = vec![0.0; n * n];
    for i in 0..n {
        v[i * n + i] = 1.0;
    }
    for _sweep in 0..100 {
        let off: f64 = (0..n)
            .flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j)))
            .map(|(i, j)| m[i * n + j] * m[i * n + j])
            .sum();
        let scale: f64 = (0..n)
            .map(|i| m[i * n + i] * m[i * n + i])
            .sum::<f64>()
            .max(1e-300);
        if off <= 1e-24 * scale {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = m[p * n + q];
                if apq.abs() < 1e-300 {
                    continue;
                }
                let theta = (m[q * n + q] - m[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let (mkp, mkq) = (m[k * n + p], m[k * n + q]);
                    m[k * n + p] = c * mkp - s * mkq;
                    m[k * n + q] = s * mkp + c * mkq;
                }
                for k in 0..n {
                    let (mpk, mqk) = (m[p * n + k], m[q * n + k]);
                    m[p * n + k] = c * mpk - s * mqk;
                    m[q * n + k] = s * mpk + c * mqk;
                }
                for k in 0..n {
                    let (vkp, vkq) = (v[k * n + p], v[k * n + q]);
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| m[a * n + a].total_cmp(&m[b * n + b]));
    let vals = idx.iter().map(|&i| m[i * n + i]).collect();
    let vecs = idx
        .iter()
        .map(|&i| (0..n).map(|k| v[k * n + i]).collect())
        .collect();
    (vals, vecs)
}
