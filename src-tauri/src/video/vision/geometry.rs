const MAX_ITERATIONS: usize = 400;
const CONFIDENCE: f32 = 0.999;
const MIN_SPAN: f32 = 4.0;
const SINGULAR: f64 = 1e-12;

pub(super) type Pair = ([f32; 2], [f32; 2]);

pub(super) trait Model: Copy {
    const SAMPLE: usize;

    fn fit<'a>(pairs: impl Iterator<Item = &'a Pair> + Clone) -> Option<Self>;

    fn error(&self, pair: &Pair) -> f32;

    fn spread(sample: &[&Pair]) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Transform {
    pub a: f32,
    pub b: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Transform {
    pub fn from_parts(scale: f32, angle: f32, translation: [f32; 2]) -> Self {
        let (sin, cos) = angle.sin_cos();
        Self {
            a: scale * cos,
            b: scale * sin,
            tx: translation[0],
            ty: translation[1],
        }
    }

    pub fn scale(&self) -> f32 {
        self.a.hypot(self.b)
    }

    pub fn angle(&self) -> f32 {
        self.b.atan2(self.a)
    }

    pub fn linear(&self, point: [f32; 2]) -> [f32; 2] {
        [
            self.a * point[0] - self.b * point[1],
            self.b * point[0] + self.a * point[1],
        ]
    }

    pub fn apply(&self, point: [f32; 2]) -> [f32; 2] {
        let [x, y] = self.linear(point);
        [x + self.tx, y + self.ty]
    }

    pub fn inverse(&self) -> Self {
        let norm = self.a * self.a + self.b * self.b;
        let linear = Self {
            a: self.a / norm,
            b: -self.b / norm,
            tx: 0.0,
            ty: 0.0,
        };
        let [tx, ty] = linear.linear([self.tx, self.ty]);
        Self {
            tx: -tx,
            ty: -ty,
            ..linear
        }
    }
}

impl Model for Transform {
    const SAMPLE: usize = 2;

    fn fit<'a>(pairs: impl Iterator<Item = &'a Pair> + Clone) -> Option<Self> {
        let mut sums = [0.0f64; 8];
        for ([px, py], [qx, qy]) in pairs {
            let (px, py, qx, qy) = (*px as f64, *py as f64, *qx as f64, *qy as f64);
            let terms = [
                1.0,
                px,
                py,
                qx,
                qy,
                px * qx + py * qy,
                px * qy - py * qx,
                px * px + py * py,
            ];
            for (sum, term) in sums.iter_mut().zip(terms) {
                *sum += term;
            }
        }
        let [count, px, py, qx, qy, dot, cross, norm] = sums;
        if count < 2.0 {
            return None;
        }
        let spread = norm - (px * px + py * py) / count;
        if spread <= 1e-9 {
            return None;
        }
        let a = (dot - (px * qx + py * qy) / count) / spread;
        let b = (cross - (px * qy - py * qx) / count) / spread;
        Some(Self {
            a: a as f32,
            b: b as f32,
            tx: ((qx - a * px + b * py) / count) as f32,
            ty: ((qy - b * px - a * py) / count) as f32,
        })
    }

    fn error(&self, (source, target): &Pair) -> f32 {
        let [x, y] = self.apply(*source);
        (x - target[0]).powi(2) + (y - target[1]).powi(2)
    }

    fn spread(sample: &[&Pair]) -> bool {
        let (first, second) = (sample[0], sample[1]);
        let span = (first.0[0] - second.0[0]).powi(2) + (first.0[1] - second.0[1]).powi(2);
        span >= MIN_SPAN * MIN_SPAN
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Homography(pub [f64; 9]);

impl Homography {
    pub fn from_square(corners: &[[f64; 2]; 4]) -> Option<Self> {
        let [p0, p1, p2, p3] = *corners;
        let (dx1, dy1) = (p1[0] - p2[0], p1[1] - p2[1]);
        let (dx2, dy2) = (p3[0] - p2[0], p3[1] - p2[1]);
        let (dx3, dy3) = (p0[0] - p1[0] + p2[0] - p3[0], p0[1] - p1[1] + p2[1] - p3[1]);
        let determinant = dx1 * dy2 - dx2 * dy1;
        if determinant.abs() < SINGULAR {
            return None;
        }
        let g = (dx3 * dy2 - dx2 * dy3) / determinant;
        let h = (dx1 * dy3 - dx3 * dy1) / determinant;
        Some(Self([
            p1[0] - p0[0] + g * p1[0],
            p3[0] - p0[0] + h * p3[0],
            p0[0],
            p1[1] - p0[1] + g * p1[1],
            p3[1] - p0[1] + h * p3[1],
            p0[1],
            g,
            h,
            1.0,
        ]))
    }

    pub fn apply(&self, [x, y]: [f64; 2]) -> Option<[f64; 2]> {
        let m = &self.0;
        let w = self.depth([x, y]);
        (w.abs() > SINGULAR).then(|| {
            [
                (m[0] * x + m[1] * y + m[2]) / w,
                (m[3] * x + m[4] * y + m[5]) / w,
            ]
        })
    }

    pub fn then(&self, next: &Self) -> Self {
        let (a, b) = (&next.0, &self.0);
        Self(std::array::from_fn(|index| {
            let (row, column) = (index / 3, index % 3);
            (0..3).map(|k| a[row * 3 + k] * b[k * 3 + column]).sum()
        }))
    }

    pub fn inverse(&self) -> Option<Self> {
        let m = &self.0;
        let cofactors = [
            m[4] * m[8] - m[5] * m[7],
            m[2] * m[7] - m[1] * m[8],
            m[1] * m[5] - m[2] * m[4],
            m[5] * m[6] - m[3] * m[8],
            m[0] * m[8] - m[2] * m[6],
            m[2] * m[3] - m[0] * m[5],
            m[3] * m[7] - m[4] * m[6],
            m[1] * m[6] - m[0] * m[7],
            m[0] * m[4] - m[1] * m[3],
        ];
        let determinant = self.determinant();
        (determinant.abs() > SINGULAR).then(|| Self(cofactors.map(|value| value / determinant)))
    }

    pub fn depth(&self, [x, y]: [f64; 2]) -> f64 {
        self.0[6] * x + self.0[7] * y + self.0[8]
    }

    pub fn determinant(&self) -> f64 {
        let m = &self.0;
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    pub fn jacobian(&self, point: [f64; 2]) -> Option<[[f64; 2]; 2]> {
        let m = &self.0;
        let [x, y] = self.apply(point)?;
        let w = self.depth(point);
        Some([
            [(m[0] - m[6] * x) / w, (m[1] - m[7] * x) / w],
            [(m[3] - m[6] * y) / w, (m[4] - m[7] * y) / w],
        ])
    }

    pub fn local_scale(&self, point: [f64; 2]) -> f64 {
        let depth = self.depth(point).abs();
        if depth < SINGULAR {
            1.0
        } else {
            (self.determinant().abs() / depth.powi(3)).sqrt()
        }
    }

    fn normalized(self) -> Option<Self> {
        let scale = self.0[8];
        (scale.abs() > SINGULAR && self.0.iter().all(|value| value.is_finite()))
            .then(|| Self(self.0.map(|value| value / scale)))
    }
}

fn conditioner(points: impl Iterator<Item = [f32; 2]> + Clone) -> Option<Homography> {
    let count = points.clone().count() as f64;
    let mean = points
        .clone()
        .fold([0.0f64; 2], |sum, [x, y]| {
            [sum[0] + x as f64, sum[1] + y as f64]
        })
        .map(|sum| sum / count);
    let distance = points
        .map(|[x, y]| (x as f64 - mean[0]).hypot(y as f64 - mean[1]))
        .sum::<f64>()
        / count;
    (distance > SINGULAR).then(|| {
        let scale = std::f64::consts::SQRT_2 / distance;
        Homography([
            scale,
            0.0,
            -scale * mean[0],
            0.0,
            scale,
            -scale * mean[1],
            0.0,
            0.0,
            1.0,
        ])
    })
}

impl Model for Homography {
    const SAMPLE: usize = 4;

    fn fit<'a>(pairs: impl Iterator<Item = &'a Pair> + Clone) -> Option<Self> {
        if pairs.clone().count() < Self::SAMPLE {
            return None;
        }
        let source = conditioner(pairs.clone().map(|pair| pair.0))?;
        let target = conditioner(pairs.clone().map(|pair| pair.1))?;
        let mut matrix = [[0.0f64; 8]; 8];
        let mut vector = [0.0f64; 8];
        for (from, to) in pairs {
            let [u, v] = source.apply([from[0] as f64, from[1] as f64])?;
            let [x, y] = target.apply([to[0] as f64, to[1] as f64])?;
            let rows = [
                ([u, v, 1.0, 0.0, 0.0, 0.0, -u * x, -v * x], x),
                ([0.0, 0.0, 0.0, u, v, 1.0, -u * y, -v * y], y),
            ];
            for (row, value) in rows {
                for (index, &entry) in row.iter().enumerate() {
                    vector[index] += entry * value;
                    for (cell, &other) in matrix[index].iter_mut().zip(&row) {
                        *cell += entry * other;
                    }
                }
            }
        }
        let [a, b, c, d, e, f, g, h] = solve(matrix, vector)?;
        let fitted = Homography([a, b, c, d, e, f, g, h, 1.0]);
        source.then(&fitted).then(&target.inverse()?).normalized()
    }

    fn error(&self, (source, target): &Pair) -> f32 {
        self.apply([source[0] as f64, source[1] as f64])
            .map_or(f32::MAX, |[x, y]| {
                ((x - target[0] as f64).powi(2) + (y - target[1] as f64).powi(2)) as f32
            })
    }

    fn spread(sample: &[&Pair]) -> bool {
        let area = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| {
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs()
        };
        (0..sample.len()).all(|skip| {
            let rest: Vec<[f32; 2]> = sample
                .iter()
                .enumerate()
                .filter(|&(index, _)| index != skip)
                .map(|(_, pair)| pair.0)
                .collect();
            area(rest[0], rest[1], rest[2]) >= MIN_SPAN * MIN_SPAN
        })
    }
}

pub(super) fn solve<const N: usize>(
    mut matrix: [[f64; N]; N],
    mut vector: [f64; N],
) -> Option<[f64; N]> {
    for column in 0..N {
        let pivot = (column..N)
            .max_by(|&a, &b| matrix[a][column].abs().total_cmp(&matrix[b][column].abs()))?;
        if matrix[pivot][column].abs() < SINGULAR {
            return None;
        }
        matrix.swap(column, pivot);
        vector.swap(column, pivot);
        let (lead, target) = (matrix[column], vector[column]);
        for (line, value) in matrix.iter_mut().zip(&mut vector).skip(column + 1) {
            let factor = line[column] / lead[column];
            for (cell, &above) in line.iter_mut().zip(&lead).skip(column) {
                *cell -= factor * above;
            }
            *value -= factor * target;
        }
    }
    let mut result = [0.0; N];
    for (row, (line, &value)) in matrix.iter().zip(&vector).enumerate().rev() {
        let known: f64 = line
            .iter()
            .zip(&result)
            .skip(row + 1)
            .map(|(a, b)| a * b)
            .sum();
        result[row] = (value - known) / line[row];
    }
    Some(result)
}

pub(super) fn ransac<M: Model>(pairs: &[Pair], threshold: f32) -> Option<(M, usize)> {
    let limit = threshold * threshold;
    let cost = |model: &M| -> f32 { pairs.iter().map(|pair| model.error(pair).min(limit)).sum() };
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut random = |count: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % count as u64) as usize
    };
    let mut best: Option<(f32, M)> = None;
    let (mut iteration, mut iterations) = (0, MAX_ITERATIONS);
    while iteration < iterations && pairs.len() >= M::SAMPLE {
        iteration += 1;
        let sample: Vec<&Pair> = (0..M::SAMPLE)
            .map(|_| &pairs[random(pairs.len())])
            .collect();
        if !M::spread(&sample) {
            continue;
        }
        let Some(model) = M::fit(sample.into_iter()) else {
            continue;
        };
        let score = cost(&model);
        if best.is_none_or(|(lowest, _)| score < lowest) {
            best = Some((score, model));
            let ratio = inliers(pairs, &model, limit).count() as f32 / pairs.len() as f32;
            let needed =
                (1.0 - CONFIDENCE).ln() / (1.0 - ratio.powi(M::SAMPLE as i32)).max(1e-6).ln();
            iterations = iterations.min(needed.ceil().max(1.0) as usize);
        }
    }
    let mut model = best?.1;
    for _ in 0..3 {
        model = M::fit(inliers(pairs, &model, limit))?;
    }
    Some((model, inliers(pairs, &model, limit).count()))
}

fn inliers<'a, M: Model>(
    pairs: &'a [Pair],
    model: &'a M,
    limit: f32,
) -> impl Iterator<Item = &'a Pair> + Clone {
    pairs.iter().filter(move |pair| model.error(pair) < limit)
}
