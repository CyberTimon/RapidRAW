use nalgebra::{Matrix3, SMatrix, SymmetricEigen, Vector2, Vector3};

pub type Correspondence = (Vector2<f64>, Vector2<f64>);

const RANSAC_CONFIDENCE: f64 = 0.999;
const RANSAC_MIN_ITERATIONS: usize = 64;
const RANSAC_MAX_ITERATIONS: usize = 4000;
const LOCAL_OPTIMIZATION_STEPS: usize = 4;

struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        SplitMix64(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }
}

fn normalization(points: impl Iterator<Item = Vector2<f64>> + Clone) -> Matrix3<f64> {
    let count = points.clone().count().max(1) as f64;
    let centroid = points.clone().fold(Vector2::zeros(), |acc, p| acc + p) / count;
    let mean_distance = points.map(|p| (p - centroid).norm()).sum::<f64>() / count;
    let scale = if mean_distance > 1e-12 {
        std::f64::consts::SQRT_2 / mean_distance
    } else {
        1.0
    };
    Matrix3::new(
        scale,
        0.0,
        -scale * centroid.x,
        0.0,
        scale,
        -scale * centroid.y,
        0.0,
        0.0,
        1.0,
    )
}

#[inline]
fn apply(t: &Matrix3<f64>, p: &Vector2<f64>) -> Vector2<f64> {
    let q = t * Vector3::new(p.x, p.y, 1.0);
    Vector2::new(q.x / q.z, q.y / q.z)
}

pub fn fit_homography(
    correspondences: &[Correspondence],
    indices: &[usize],
) -> Option<Matrix3<f64>> {
    if indices.len() < 4 {
        return None;
    }
    let ta = normalization(indices.iter().map(|&i| correspondences[i].0));
    let tb = normalization(indices.iter().map(|&i| correspondences[i].1));

    let mut ata = SMatrix::<f64, 9, 9>::zeros();
    for &i in indices {
        let a = apply(&ta, &correspondences[i].0);
        let b = apply(&tb, &correspondences[i].1);
        let rows = [
            [-a.x, -a.y, -1.0, 0.0, 0.0, 0.0, b.x * a.x, b.x * a.y, b.x],
            [0.0, 0.0, 0.0, -a.x, -a.y, -1.0, b.y * a.x, b.y * a.y, b.y],
        ];
        for row in rows.iter() {
            for r in 0..9 {
                if row[r] == 0.0 {
                    continue;
                }
                for c in r..9 {
                    ata[(r, c)] += row[r] * row[c];
                }
            }
        }
    }
    for r in 0..9 {
        for c in 0..r {
            ata[(r, c)] = ata[(c, r)];
        }
    }

    let eigen = SymmetricEigen::new(ata);
    let (min_index, _) = eigen
        .eigenvalues
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.total_cmp(b.1))?;
    let h = eigen.eigenvectors.column(min_index);
    let normalized = Matrix3::new(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]);
    let homography = tb.try_inverse()? * normalized * ta;
    let norm = homography.norm();
    if !norm.is_finite() || norm < 1e-12 {
        return None;
    }
    let scaled = if homography[(2, 2)].abs() > 1e-9 {
        homography / homography[(2, 2)]
    } else {
        homography / norm
    };
    Some(scaled)
}

#[inline]
pub fn transfer_error_sq(h: &Matrix3<f64>, c: &Correspondence) -> f64 {
    let p = h * Vector3::new(c.0.x, c.0.y, 1.0);
    if p.z.abs() < 1e-12 {
        return f64::INFINITY;
    }
    let dx = p.x / p.z - c.1.x;
    let dy = p.y / p.z - c.1.y;
    dx * dx + dy * dy
}

fn is_degenerate_sample(correspondences: &[Correspondence], sample: &[usize; 4]) -> bool {
    let collinear = |p: [Vector2<f64>; 3]| {
        let area = (p[1] - p[0]).perp(&(p[2] - p[0])).abs();
        let scale = (p[1] - p[0]).norm() * (p[2] - p[0]).norm();
        area <= 1e-3 * scale.max(1e-12)
    };
    for side in 0..2 {
        let pts: Vec<Vector2<f64>> = sample
            .iter()
            .map(|&i| {
                if side == 0 {
                    correspondences[i].0
                } else {
                    correspondences[i].1
                }
            })
            .collect();
        for skip in 0..4 {
            let tri: Vec<Vector2<f64>> = (0..4).filter(|&k| k != skip).map(|k| pts[k]).collect();
            if collinear([tri[0], tri[1], tri[2]]) {
                return true;
            }
        }
    }
    false
}

fn is_orientation_preserving(
    h: &Matrix3<f64>,
    correspondences: &[Correspondence],
    sample: &[usize],
) -> bool {
    let signs: Vec<bool> = sample
        .iter()
        .map(|&i| {
            let p = correspondences[i].0;
            (h[(2, 0)] * p.x + h[(2, 1)] * p.y + h[(2, 2)]) > 0.0
        })
        .collect();
    signs.iter().all(|&s| s == signs[0])
}

fn score(h: &Matrix3<f64>, correspondences: &[Correspondence], threshold_sq: f64) -> (f64, usize) {
    let mut cost = 0.0;
    let mut count = 0;
    for c in correspondences {
        let e = transfer_error_sq(h, c);
        if e < threshold_sq {
            cost += e;
            count += 1;
        } else {
            cost += threshold_sq;
        }
    }
    (cost, count)
}

fn inliers_of(
    h: &Matrix3<f64>,
    correspondences: &[Correspondence],
    threshold_sq: f64,
) -> Vec<usize> {
    correspondences
        .iter()
        .enumerate()
        .filter(|(_, c)| transfer_error_sq(h, c) < threshold_sq)
        .map(|(i, _)| i)
        .collect()
}

fn local_optimization(
    h: Matrix3<f64>,
    correspondences: &[Correspondence],
    threshold_sq: f64,
) -> (Matrix3<f64>, f64) {
    let mut best_h = h;
    let mut best_cost = score(&h, correspondences, threshold_sq).0;
    for _ in 0..LOCAL_OPTIMIZATION_STEPS {
        let inliers = inliers_of(&best_h, correspondences, threshold_sq * 4.0);
        let Some(refined) = fit_homography(correspondences, &inliers) else {
            break;
        };
        let (cost, _) = score(&refined, correspondences, threshold_sq);
        if cost < best_cost {
            best_cost = cost;
            best_h = refined;
        } else {
            break;
        }
    }
    (best_h, best_cost)
}

pub fn estimate_homography(
    correspondences: &[Correspondence],
    threshold: f64,
    seed: u64,
) -> Option<Vec<usize>> {
    let n = correspondences.len();
    if n < 4 {
        return None;
    }
    let threshold_sq = threshold * threshold;
    let mut rng = SplitMix64::new(seed);
    let mut best: Option<(Matrix3<f64>, f64)> = None;
    let mut required_iterations = RANSAC_MAX_ITERATIONS;
    let mut iteration = 0;

    while iteration < required_iterations.max(RANSAC_MIN_ITERATIONS) {
        iteration += 1;
        let mut sample = [0usize; 4];
        let mut k = 0;
        while k < 4 {
            let candidate = rng.below(n);
            if !sample[..k].contains(&candidate) {
                sample[k] = candidate;
                k += 1;
            }
        }
        if is_degenerate_sample(correspondences, &sample) {
            continue;
        }
        let Some(h) = fit_homography(correspondences, &sample) else {
            continue;
        };
        if !is_orientation_preserving(&h, correspondences, &sample) {
            continue;
        }
        let (cost, count) = score(&h, correspondences, threshold_sq);
        if best.as_ref().is_none_or(|(_, c)| cost < *c) {
            let (refined, refined_cost) = local_optimization(h, correspondences, threshold_sq);
            let refined_count = inliers_of(&refined, correspondences, threshold_sq).len();
            let (h, cost, count) = if refined_cost < cost {
                (refined, refined_cost, refined_count)
            } else {
                (h, cost, count)
            };
            best = Some((h, cost));

            let inlier_ratio = (count as f64 / n as f64).clamp(1e-6, 1.0);
            let all_inliers_probability = inlier_ratio.powi(4);
            required_iterations = if all_inliers_probability >= 1.0 - 1e-12 {
                RANSAC_MIN_ITERATIONS
            } else {
                ((1.0 - RANSAC_CONFIDENCE).ln() / (1.0 - all_inliers_probability).ln())
                    .ceil()
                    .min(RANSAC_MAX_ITERATIONS as f64) as usize
            };
        }
        if iteration >= RANSAC_MAX_ITERATIONS {
            break;
        }
    }

    let (h, _) = best?;
    let inliers = inliers_of(&h, correspondences, threshold_sq);
    let homography = fit_homography(correspondences, &inliers).unwrap_or(h);
    let inliers = inliers_of(&homography, correspondences, threshold_sq);
    (inliers.len() >= 4).then_some(inliers)
}
