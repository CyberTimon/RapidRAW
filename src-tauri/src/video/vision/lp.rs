const MAX_ITERATIONS: usize = 60;
const GAP: f64 = 1e-7;
const STEP: f64 = 0.995;
const MIN_STEP: f64 = 1e-9;
const REGULARIZATION: f64 = 1e-14;
const BAND: usize = 16;

pub(super) struct Rows {
    offsets: Vec<usize>,
    columns: Vec<usize>,
    values: Vec<f64>,
    constants: Vec<f64>,
}

impl Rows {
    pub fn new() -> Self {
        Self {
            offsets: vec![0],
            columns: Vec::new(),
            values: Vec::new(),
            constants: Vec::new(),
        }
    }

    pub fn push(&mut self, entries: &mut [(usize, f64)], constant: f64) {
        entries.sort_unstable_by_key(|&(column, _)| column);
        let start = self.columns.len();
        for &(column, value) in entries.iter() {
            if self.columns.len() > start && self.columns.last() == Some(&column) {
                *self.values.last_mut().expect("the row has a value") += value;
            } else {
                self.columns.push(column);
                self.values.push(value);
            }
        }
        self.offsets.push(self.columns.len());
        self.constants.push(constant);
    }

    fn len(&self) -> usize {
        self.constants.len()
    }

    fn row(&self, row: usize) -> (&[usize], &[f64]) {
        let range = self.offsets[row]..self.offsets[row + 1];
        (&self.columns[range.clone()], &self.values[range])
    }

    fn linear(&self, row: usize, x: &[f64]) -> f64 {
        let (columns, values) = self.row(row);
        columns
            .iter()
            .zip(values)
            .map(|(&column, value)| value * x[column])
            .sum()
    }

    fn scatter(&self, row: usize, scale: f64, out: &mut [f64]) {
        let (columns, values) = self.row(row);
        for (&column, value) in columns.iter().zip(values) {
            out[column] += scale * value;
        }
    }
}

struct Band {
    size: usize,
    data: Vec<f64>,
}

impl Band {
    fn index(row: usize, column: usize) -> usize {
        row * BAND + BAND - 1 + column - row
    }

    fn add(&mut self, rows: &Rows, row: usize, weight: f64) {
        let (columns, values) = rows.row(row);
        for (i, (&high, &outer)) in columns.iter().zip(values).enumerate() {
            let scaled = weight * outer;
            for (&low, &inner) in columns[..=i].iter().zip(values) {
                self.data[Self::index(high, low)] += scaled * inner;
            }
        }
    }

    fn factor(&mut self) {
        let largest = (0..self.size)
            .map(|i| self.data[Self::index(i, i)])
            .fold(0.0, f64::max);
        let floor = largest * REGULARIZATION + f64::MIN_POSITIVE;
        for i in 0..self.size {
            let first = i.saturating_sub(BAND - 1);
            let (done, current) = self.data.split_at_mut(i * BAND);
            for j in first..=i {
                let length = j - first;
                let other = if j == i {
                    &current[..BAND]
                } else {
                    &done[j * BAND..][..BAND]
                };
                let sum = dot(
                    &current[BAND - 1 + first - i..][..length],
                    &other[BAND - 1 + first - j..][..length],
                );
                let value = current[BAND - 1 + j - i] - sum;
                current[BAND - 1 + j - i] = if i == j {
                    value.max(floor).sqrt()
                } else {
                    value / done[j * BAND + BAND - 1]
                };
            }
        }
    }

    fn solve(&self, x: &mut [f64]) {
        for i in 0..self.size {
            let first = i.saturating_sub(BAND - 1);
            let row = &self.data[i * BAND..][..BAND];
            let sum = dot(&row[BAND - 1 + first - i..BAND - 1], &x[first..i]);
            x[i] = (x[i] - sum) / row[BAND - 1];
        }
        for i in (0..self.size).rev() {
            let last = (i + BAND).min(self.size);
            let sum: f64 = (i + 1..last)
                .map(|k| self.data[Self::index(k, i)] * x[k])
                .sum();
            x[i] = (x[i] - sum) / self.data[Self::index(i, i)];
        }
    }
}

struct Pairs {
    values: Vec<f64>,
    duals: Vec<f64>,
}

impl Pairs {
    fn zeros(length: usize) -> Self {
        Self {
            values: vec![0.0; length],
            duals: vec![0.0; length],
        }
    }

    fn gap(&self) -> f64 {
        dot(&self.values, &self.duals)
    }

    fn gap_after(&self, step: &Self, primal: f64, dual: f64) -> f64 {
        self.values
            .iter()
            .zip(&self.duals)
            .zip(step.values.iter().zip(&step.duals))
            .map(|((v, d), (dv, dd))| (v + primal * dv) * (d + dual * dd))
            .sum()
    }

    fn longest(&self, step: &Self) -> (f64, f64) {
        let longest = |values: &[f64], steps: &[f64]| {
            values
                .iter()
                .zip(steps)
                .filter(|(_, step)| **step < 0.0)
                .map(|(value, step)| -value / step)
                .fold(1.0, f64::min)
        };
        (
            longest(&self.values, &step.values),
            longest(&self.duals, &step.duals),
        )
    }

    fn advance(&mut self, step: &Self, primal: f64, dual: f64) {
        advance(&mut self.values, &step.values, primal);
        advance(&mut self.duals, &step.duals, dual);
    }

    fn targets(&self, affine: Option<(&Self, f64)>, out: &mut [f64]) {
        for (index, out) in out.iter_mut().enumerate() {
            *out = self.values[index] * self.duals[index]
                + affine.map_or(0.0, |(affine, centering)| {
                    affine.values[index] * affine.duals[index] - centering
                });
        }
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}

fn advance(values: &mut [f64], steps: &[f64], length: f64) {
    values
        .iter_mut()
        .zip(steps)
        .for_each(|(value, step)| *value += length * step);
}

struct Point {
    x: Vec<f64>,
    bound: Vec<f64>,
    upper: Pairs,
    lower: Pairs,
    slack: Pairs,
}

impl Point {
    fn zeros(variables: usize, terms: usize, limits: usize) -> Self {
        Self {
            x: vec![0.0; variables],
            bound: vec![0.0; terms],
            upper: Pairs::zeros(terms),
            lower: Pairs::zeros(terms),
            slack: Pairs::zeros(limits),
        }
    }

    fn pairs(&self) -> [&Pairs; 3] {
        [&self.upper, &self.lower, &self.slack]
    }

    fn gap(&self) -> f64 {
        self.pairs().into_iter().map(Pairs::gap).sum()
    }

    fn gap_after(&self, step: &Self, primal: f64, dual: f64) -> f64 {
        self.pairs()
            .into_iter()
            .zip(step.pairs())
            .map(|(pairs, moves)| pairs.gap_after(moves, primal, dual))
            .sum()
    }

    fn longest(&self, step: &Self) -> (f64, f64) {
        self.pairs()
            .into_iter()
            .zip(step.pairs())
            .map(|(pairs, moves)| pairs.longest(moves))
            .fold((1.0, 1.0), |(p, d), (primal, dual)| {
                (p.min(primal), d.min(dual))
            })
    }

    fn advance(&mut self, step: &Self, primal: f64, dual: f64) {
        advance(&mut self.x, &step.x, primal);
        advance(&mut self.bound, &step.bound, primal);
        self.upper.advance(&step.upper, primal, dual);
        self.lower.advance(&step.lower, primal, dual);
        self.slack.advance(&step.slack, primal, dual);
    }
}

struct Scaling {
    ratio: Vec<f64>,
    inverse: Vec<f64>,
    upper: Vec<f64>,
    lower: Vec<f64>,
    slack: Vec<f64>,
}

pub(super) struct Program {
    pub terms: Rows,
    pub weights: Vec<f64>,
    pub limits: Rows,
}

impl Program {
    fn newton(
        &self,
        point: &Point,
        scaling: &Scaling,
        band: &Band,
        residual: &[f64],
        affine: Option<(&Point, f64)>,
        step: &mut Point,
    ) {
        let variables = point.x.len();
        point.upper.targets(
            affine.map(|(affine, centering)| (&affine.upper, centering)),
            &mut step.upper.duals,
        );
        point.lower.targets(
            affine.map(|(affine, centering)| (&affine.lower, centering)),
            &mut step.lower.duals,
        );
        point.slack.targets(
            affine.map(|(affine, centering)| (&affine.slack, centering)),
            &mut step.slack.duals,
        );
        step.x.copy_from_slice(&residual[..variables]);
        for j in 0..self.terms.len() {
            let pushed_upper = -step.upper.duals[j] * scaling.upper[j];
            let pushed_lower = -step.lower.duals[j] * scaling.lower[j];
            let combined = pushed_upper + pushed_lower + residual[variables + j];
            step.bound[j] = combined;
            self.terms.scatter(
                j,
                pushed_lower - pushed_upper + scaling.ratio[j] * combined,
                &mut step.x,
            );
        }
        for i in 0..self.limits.len() {
            let pushed = step.slack.duals[i] * scaling.slack[i];
            self.limits.scatter(i, pushed, &mut step.x);
        }
        band.solve(&mut step.x);
        for j in 0..self.terms.len() {
            let change = self.terms.linear(j, &step.x);
            let bound = step.bound[j] * scaling.inverse[j] + scaling.ratio[j] * change;
            step.bound[j] = bound;
            step.upper.values[j] = bound - change;
            step.lower.values[j] = bound + change;
            step.upper.duals[j] = (-step.upper.duals[j]
                - point.upper.duals[j] * step.upper.values[j])
                * scaling.upper[j];
            step.lower.duals[j] = (-step.lower.duals[j]
                - point.lower.duals[j] * step.lower.values[j])
                * scaling.lower[j];
        }
        for i in 0..self.limits.len() {
            step.slack.values[i] = -self.limits.linear(i, &step.x);
            step.slack.duals[i] = (-step.slack.duals[i]
                - point.slack.duals[i] * step.slack.values[i])
                * scaling.slack[i];
        }
    }

    fn start(&self, x: Vec<f64>) -> Point {
        let (terms, limits) = (self.terms.len(), self.limits.len());
        let mut point = Point::zeros(0, terms, limits);
        let values: Vec<f64> = (0..terms)
            .map(|j| self.terms.constants[j] + self.terms.linear(j, &x))
            .collect();
        let margin =
            (values.iter().map(|value| value.abs()).sum::<f64>() / terms.max(1) as f64).max(1e-9);
        for (j, value) in values.into_iter().enumerate() {
            point.bound[j] = value.abs() + margin;
            point.upper.values[j] = point.bound[j] - value;
            point.lower.values[j] = point.bound[j] + value;
            point.upper.duals[j] = 0.5 * self.weights[j];
            point.lower.duals[j] = 0.5 * self.weights[j];
        }
        let mu = point.gap() / (2 * terms).max(1) as f64;
        for i in 0..limits {
            let slack = -(self.limits.constants[i] + self.limits.linear(i, &x));
            point.slack.values[i] = slack.max(1e-12);
            point.slack.duals[i] = mu / point.slack.values[i];
        }
        point.x = x;
        point
    }

    pub fn solve(&self, start: Vec<f64>) -> Vec<f64> {
        let (variables, terms, limits) = (start.len(), self.terms.len(), self.limits.len());
        let mut point = self.start(start);
        let constraints = (2 * terms + limits) as f64;
        let mut band = Band {
            size: variables,
            data: vec![0.0; variables * BAND],
        };
        let mut scaling = Scaling {
            ratio: vec![0.0; terms],
            inverse: vec![0.0; terms],
            upper: vec![0.0; terms],
            lower: vec![0.0; terms],
            slack: vec![0.0; limits],
        };
        let mut residual = vec![0.0; variables + terms];
        let mut affine = Point::zeros(variables, terms, limits);
        let mut step = Point::zeros(variables, terms, limits);
        for _ in 0..MAX_ITERATIONS {
            let gap = point.gap();
            let objective = dot(&self.weights, &point.bound);
            if gap <= GAP * (1.0 + objective) {
                break;
            }
            residual.fill(0.0);
            band.data.fill(0.0);
            for j in 0..terms {
                let (upper, lower) = (&point.upper, &point.lower);
                self.terms
                    .scatter(j, lower.duals[j] - upper.duals[j], &mut residual);
                residual[variables + j] = upper.duals[j] + lower.duals[j] - self.weights[j];
                scaling.upper[j] = 1.0 / upper.values[j];
                scaling.lower[j] = 1.0 / lower.values[j];
                let high = upper.duals[j] * scaling.upper[j];
                let low = lower.duals[j] * scaling.lower[j];
                scaling.inverse[j] = 1.0 / (high + low);
                scaling.ratio[j] = (high - low) * scaling.inverse[j];
                band.add(&self.terms, j, 4.0 * high * low * scaling.inverse[j]);
            }
            for i in 0..limits {
                let slack = &point.slack;
                scaling.slack[i] = 1.0 / slack.values[i];
                self.limits.scatter(i, -slack.duals[i], &mut residual);
                band.add(&self.limits, i, slack.duals[i] * scaling.slack[i]);
            }
            band.factor();
            self.newton(&point, &scaling, &band, &residual, None, &mut affine);
            let (primal, dual) = point.longest(&affine);
            let predicted = point.gap_after(&affine, primal, dual);
            let centering = (predicted / gap).powi(3) * gap / constraints;
            self.newton(
                &point,
                &scaling,
                &band,
                &residual,
                Some((&affine, centering)),
                &mut step,
            );
            let (primal, dual) = point.longest(&step);
            if !step.x.iter().all(|value| value.is_finite()) || primal.max(dual) < MIN_STEP {
                break;
            }
            point.advance(&step, STEP * primal, STEP * dual);
        }
        point.x
    }
}
