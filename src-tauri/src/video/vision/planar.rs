use rayon::prelude::*;

use super::features::detect;
use super::flow::track;
use super::frame::{GrayFrame, Pyramid};
use super::geometry::{Homography, Pair, ransac, solve};
use super::tracker::{TrackSample, spread};

pub type Quad = [[f32; 2]; 4];
type Corners = [[f64; 2]; 4];
type Sample = (usize, [f64; 6]);

const SQUARE: Corners = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
const SPACING: f64 = 1.0;
const MARGIN: f64 = 0.03;
const MIN_CELLS: usize = 8;
const MAX_CELLS: usize = 96;
const MIN_EXTENT: f64 = 24.0;
const SCORE_EXTENT: f64 = 64.0;
const FEATURE_EXTENT: f64 = 256.0;
const FEATURES: usize = 128;
const FEATURE_SPACING: f32 = 4.0;
const FEATURE_GRID: usize = 2;
const FEATURE_AREA: f64 = 0.9;
const INLIER_DISTANCE: f32 = 1.0;
const MIN_INLIERS: usize = 8;
const MIN_INLIER_RATIO: f32 = 0.4;
const ITERATIONS: usize = 24;
const CONVERGED: f64 = 1e-3;
const DAMPING: f64 = 1e-4;
const MAX_STEP: f64 = 0.25;
const MAX_SHRINKS: usize = 32;
const HUBER: f64 = 1.345;
const OUTLIER: f64 = 3.0;
const MIN_NOISE: f64 = 0.01;
const MIN_VISIBLE: f64 = 0.3;
const MIN_DEPTH: f64 = 1e-6;
const CHUNK: usize = 1024;
const ACCEPT: f32 = 0.5;
const REACQUIRE: f32 = 0.65;
const ADAPT: f32 = 0.8;
const MIN_INLIER_SHARE: f32 = 0.85;
const MAX_AREA_STEP: f64 = 1.5;
const COAST: f64 = 0.8;
const RESET_AFTER: u32 = 3;
const SEARCH_EXTENT: f64 = 0.5;
const SEARCH_GROWTH: f64 = 0.1;
const MAX_SEARCH_EXTENT: f64 = 1.25;
const MAX_SEARCH_RADIUS: usize = 24;
const FLAT: f64 = 1e-10;

struct Grid {
    columns: usize,
    points: Vec<[f64; 2]>,
}

impl Grid {
    fn new(corners: &Corners) -> Self {
        let length = |a: usize, b: usize| distance(corners[a], corners[b]);
        let cells = |extent: f64| ((extent / SPACING).round() as usize).clamp(MIN_CELLS, MAX_CELLS);
        let columns = cells(length(0, 1).max(length(3, 2)));
        let rows = cells(length(0, 3).max(length(1, 2)));
        Self {
            columns,
            points: (0..rows)
                .flat_map(|y| {
                    (0..columns).map(move |x| {
                        [
                            MARGIN + (1.0 - 2.0 * MARGIN) * (x as f64 + 0.5) / columns as f64,
                            MARGIN + (1.0 - 2.0 * MARGIN) * (y as f64 + 0.5) / rows as f64,
                        ]
                    })
                })
                .collect(),
        }
    }
}

#[derive(Clone, Copy)]
struct Warp {
    origin: [f64; 2],
    map: Homography,
}

impl Warp {
    fn new(corners: &Corners) -> Option<Self> {
        let origin = centroid(corners);
        let relative = corners.map(|[x, y]| [x - origin[0], y - origin[1]]);
        Some(Self {
            origin,
            map: Homography::from_square(&relative)?,
        })
    }

    fn at(&self, [u, v]: [f64; 2]) -> Option<([f64; 2], [f64; 3])> {
        let m = &self.map.0;
        let depth = m[6] * u + m[7] * v + m[8];
        if depth <= MIN_DEPTH {
            return None;
        }
        let x = (m[0] * u + m[1] * v + m[2]) / depth;
        let y = (m[3] * u + m[4] * v + m[5]) / depth;
        Some(([x + self.origin[0], y + self.origin[1]], [x, y, depth]))
    }

    fn corners(&self) -> Option<Corners> {
        let mapped = SQUARE.map(|point| self.at(point).map(|(at, _)| at));
        mapped
            .iter()
            .all(Option::is_some)
            .then(|| mapped.map(Option::unwrap))
    }
}

#[derive(Clone, Copy)]
struct Fit {
    corners: Corners,
    score: f32,
    inliers: f32,
}

#[derive(Clone, Copy)]
struct Normal {
    matrix: [[f64; 10]; 10],
    vector: [f64; 10],
}

impl Normal {
    const ZERO: Self = Self {
        matrix: [[0.0; 10]; 10],
        vector: [0.0; 10],
    };

    fn add(&mut self, jacobian: &[f64; 10], residual: f64, weight: f64) {
        for (row, &value) in jacobian.iter().enumerate() {
            let weighted = weight * value;
            self.vector[row] += weighted * residual;
            for (cell, &other) in self.matrix[row][row..].iter_mut().zip(&jacobian[row..]) {
                *cell += weighted * other;
            }
        }
    }

    fn merge(mut self, other: &Self) -> Self {
        for (line, other) in self.matrix.iter_mut().zip(&other.matrix) {
            for (cell, value) in line.iter_mut().zip(other) {
                *cell += value;
            }
        }
        for (value, other) in self.vector.iter_mut().zip(&other.vector) {
            *value += other;
        }
        self
    }
}

pub struct PlaneTracker {
    previous: Pyramid,
    frame: [u32; 2],
    grids: Vec<Grid>,
    reference: Vec<Vec<f32>>,
    anchor: Vec<Vec<f32>>,
    anchored: bool,
    corners: Corners,
    velocity: Corners,
    feature_level: usize,
    score_level: usize,
    area: f64,
    angle: f64,
    rotation: f64,
    misses: u32,
}

impl PlaneTracker {
    pub fn new(first: &GrayFrame, quad: Quad) -> Result<Self, String> {
        const NOT_CONVEX: &str = "The plane outline is not a convex shape";
        let frame = [first.width, first.height];
        let corners: Corners = quad.map(|[x, y]| {
            [
                x as f64 * frame[0] as f64 - 0.5,
                y as f64 * frame[1] as f64 - 0.5,
            ]
        });
        if !convex(&corners) {
            return Err(NOT_CONVEX.to_string());
        }
        let shortest = (0..4)
            .map(|index| distance(corners[index], corners[(index + 1) % 4]))
            .fold(f64::MAX, f64::min);
        let longest = (0..4)
            .map(|index| distance(corners[index], corners[(index + 1) % 4]))
            .fold(0.0, f64::max);
        let wanted = (shortest / MIN_EXTENT).log2().floor().max(0.0) as usize;
        let previous = Pyramid::new(first.clone(), wanted + 1);
        let coarsest = wanted.min(previous.0.len() - 1);
        let level_for =
            |extent: f64| ((longest / extent).log2().ceil().max(0.0) as usize).min(coarsest);
        let mut tracker = Self {
            frame,
            grids: (0..=coarsest)
                .map(|level| Grid::new(&scaled(&corners, level)))
                .collect(),
            reference: Vec::new(),
            anchor: Vec::new(),
            anchored: false,
            corners,
            velocity: [[0.0; 2]; 4],
            feature_level: level_for(FEATURE_EXTENT),
            score_level: level_for(SCORE_EXTENT),
            area: area(&corners),
            angle: angle(&corners),
            rotation: 0.0,
            misses: 0,
            previous,
        };
        tracker.reference = tracker
            .templates(&tracker.previous, &corners)
            .ok_or_else(|| NOT_CONVEX.to_string())?;
        let visible = |template: &Vec<f32>| {
            template.iter().filter(|value| value.is_finite()).count() as f64
                >= MIN_VISIBLE * template.len() as f64
        };
        if !tracker.reference.iter().all(visible) {
            return Err("The plane outline is mostly outside the frame".to_string());
        }
        Ok(tracker)
    }

    pub fn first_sample(&mut self) -> TrackSample {
        self.sample(1.0)
    }

    pub fn update(&mut self, frame: &GrayFrame) -> Option<TrackSample> {
        if [frame.width, frame.height] != self.frame {
            return None;
        }
        let current = Pyramid::new(frame.clone(), self.previous.0.len());
        let predicted = shifted(&self.corners, &self.velocity, 1.0);
        let start = (self.misses == 0)
            .then(|| self.features(&current, &predicted))
            .flatten()
            .unwrap_or(predicted);
        let found = self
            .lock(&current, &start)
            .or_else(|| self.search(&current, &predicted));
        let sample = match found {
            Some(fit) => {
                self.velocity = if self.misses == 0 {
                    difference(&fit.corners, &self.corners)
                } else {
                    [[0.0; 2]; 4]
                };
                self.corners = fit.corners;
                self.misses = 0;
                if fit.score < ADAPT
                    && fit.inliers >= MIN_INLIER_SHARE
                    && let Some(anchor) = self.templates(&current, &fit.corners)
                {
                    self.anchor = anchor;
                    self.anchored = true;
                }
                Some(self.sample(fit.score))
            }
            None => {
                self.misses += 1;
                if self.misses == RESET_AFTER {
                    self.anchored = false;
                }
                self.corners = predicted;
                self.velocity = self.velocity.map(|point| point.map(|value| value * COAST));
                None
            }
        };
        self.previous = current;
        sample
    }

    fn coarsest(&self) -> usize {
        self.grids.len() - 1
    }

    fn templates(&self, pyramid: &Pyramid, corners: &Corners) -> Option<Vec<Vec<f32>>> {
        self.grids
            .iter()
            .enumerate()
            .map(|(level, grid)| {
                let warp = Warp::new(&scaled(corners, level))?;
                Some(sampled(&pyramid.0[level], grid, &warp))
            })
            .collect()
    }

    fn lock(&mut self, current: &Pyramid, start: &Corners) -> Option<Fit> {
        let templates = if self.anchored {
            &self.anchor
        } else {
            &self.reference
        };
        let fit = self
            .align(current, start, templates, self.coarsest())
            .filter(|fit| fit.score >= ACCEPT)?;
        if !self.anchored {
            return Some(fit);
        }
        let locked = self
            .align(current, &fit.corners, &self.reference, self.score_level)
            .filter(|locked| locked.score >= REACQUIRE);
        if locked.is_some() {
            self.anchored = false;
        }
        Some(locked.unwrap_or(fit))
    }

    fn align(
        &self,
        current: &Pyramid,
        start: &Corners,
        templates: &[Vec<f32>],
        from: usize,
    ) -> Option<Fit> {
        let mut corners = scaled(start, from);
        let mut photometric = None;
        for level in (0..=from).rev() {
            corners = refine(
                &current.0[level],
                &self.grids[level],
                &templates[level],
                corners,
                &mut photometric,
            )?;
            if level > 0 {
                corners = corners.map(|point| point.map(|value| (value + 0.5) * 2.0 - 0.5));
            }
        }
        let change = area(&corners) / area(&self.corners).max(FLAT);
        if !convex(&corners) || !(1.0 / MAX_AREA_STEP..=MAX_AREA_STEP).contains(&change) {
            return None;
        }
        let photometric = photometric?;
        let (score, inliers) = self.score(current, &corners, templates, photometric)?;
        Some(Fit {
            corners,
            score,
            inliers,
        })
    }

    fn score(
        &self,
        current: &Pyramid,
        corners: &Corners,
        templates: &[Vec<f32>],
        [gain, bias]: [f64; 2],
    ) -> Option<(f32, f32)> {
        let level = self.score_level;
        let warp = Warp::new(&scaled(corners, level))?;
        let shown = sampled(&current.0[level], &self.grids[level], &warp);
        let template = &templates[level];
        let residuals: Vec<f64> = shown
            .iter()
            .zip(template)
            .filter(|(value, target)| value.is_finite() && target.is_finite())
            .map(|(&value, &target)| gain * value as f64 + bias - target as f64)
            .collect();
        if residuals.is_empty() {
            return None;
        }
        let limit = OUTLIER * spread(&residuals).max(MIN_NOISE);
        let keep: Vec<bool> = shown
            .iter()
            .zip(template)
            .map(|(&value, &target)| {
                value.is_finite()
                    && target.is_finite()
                    && (gain * value as f64 + bias - target as f64).abs() <= limit
            })
            .collect();
        let kept = keep.iter().filter(|&&kept| kept).count();
        Some((
            agreement(&shown, template, &keep)?,
            kept as f32 / shown.len() as f32,
        ))
    }

    fn features(&self, current: &Pyramid, predicted: &Corners) -> Option<Corners> {
        let level = self.feature_level;
        let corners = scaled(&self.corners, level);
        let origin = centroid(&corners);
        let inner = corners.map(|[x, y]| {
            [
                origin[0] + (x - origin[0]) * FEATURE_AREA,
                origin[1] + (y - origin[1]) * FEATURE_AREA,
            ]
        });
        let low = [0, 1].map(|axis| {
            inner
                .iter()
                .map(|point| point[axis])
                .fold(f64::MAX, f64::min)
        });
        let high = [0, 1].map(|axis| {
            inner
                .iter()
                .map(|point| point[axis])
                .fold(f64::MIN, f64::max)
        });
        let points = detect(
            &self.previous.0[level],
            [
                low[0] as f32,
                low[1] as f32,
                high[0] as f32 + 1.0,
                high[1] as f32 + 1.0,
            ],
            FEATURES,
            FEATURE_SPACING,
            FEATURE_GRID,
            |[x, y]| contains(&inner, [x as f64, y as f64]),
        );
        let target = centroid(&scaled(predicted, level));
        let guess = [0, 1].map(|axis| (target[axis] - origin[axis]) as f32);
        let pairs: Vec<Pair> = points
            .iter()
            .zip(track(&self.previous, current, level, &points, guess))
            .filter_map(|(&[fx, fy], to)| {
                let [tx, ty] = to?;
                let (ox, oy) = (origin[0] as f32, origin[1] as f32);
                Some(([fx - ox, fy - oy], [tx - ox, ty - oy]))
            })
            .collect();
        let (motion, inliers) = ransac::<Homography>(&pairs, INLIER_DISTANCE)?;
        if inliers < MIN_INLIERS || (inliers as f32) < MIN_INLIER_RATIO * pairs.len() as f32 {
            return None;
        }
        let moved = corners.map(|[x, y]| {
            motion
                .apply([x - origin[0], y - origin[1]])
                .map(|[x, y]| [x + origin[0], y + origin[1]])
        });
        if moved.iter().any(Option::is_none) {
            return None;
        }
        let moved = unscaled(&moved.map(Option::unwrap), level);
        let change = area(&moved) / area(&self.corners).max(FLAT);
        (convex(&moved) && (1.0 / MAX_AREA_STEP..=MAX_AREA_STEP).contains(&change)).then_some(moved)
    }

    fn search(&self, current: &Pyramid, predicted: &Corners) -> Option<Fit> {
        let level = self.score_level;
        let grid = &self.grids[level];
        let templates = if self.anchored {
            &self.anchor
        } else {
            &self.reference
        };
        let template = &templates[level];
        let corners = scaled(predicted, level);
        let extent = (0..4)
            .map(|index| distance(corners[index], corners[(index + 1) % 4]))
            .fold(0.0, f64::max);
        let speed = centroid(&self.velocity);
        let speed = speed[0].hypot(speed[1]) / (1u32 << level) as f64;
        let reach = (SEARCH_EXTENT + SEARCH_GROWTH * self.misses as f64).min(MAX_SEARCH_EXTENT)
            * extent
            + speed;
        let pitch = (extent / grid.columns as f64).max(1.0);
        let radius = ((reach / pitch).ceil() as usize).min(MAX_SEARCH_RADIUS) as i64;
        let side = 2 * radius + 1;
        let frame = &current.0[level];
        let candidate = |index: i64| {
            let offset =
                [index % side - radius, index / side - radius].map(|value| value as f64 * pitch);
            let moved = corners.map(|[x, y]| [x + offset[0], y + offset[1]]);
            let warp = Warp::new(&moved)?;
            let shown = sampled(frame, grid, &warp);
            let keep: Vec<bool> = shown
                .iter()
                .zip(template)
                .map(|(value, target)| value.is_finite() && target.is_finite())
                .collect();
            (keep.iter().filter(|&&kept| kept).count() as f64 >= MIN_VISIBLE * keep.len() as f64)
                .then(|| agreement(&shown, template, &keep))
                .flatten()
                .map(|score| (score, moved))
        };
        let (_, found) = (0..side * side)
            .into_par_iter()
            .filter_map(candidate)
            .max_by(|a, b| a.0.total_cmp(&b.0))?;
        self.align(
            current,
            &unscaled(&found, level),
            templates,
            self.coarsest(),
        )
        .filter(|fit| fit.score >= REACQUIRE)
    }

    fn sample(&mut self, score: f32) -> TrackSample {
        let [width, height] = self.frame.map(f64::from);
        let normalized =
            |[x, y]: [f64; 2]| [((x + 0.5) / width) as f32, ((y + 0.5) / height) as f32];
        let center = Warp::new(&self.corners)
            .and_then(|warp| warp.at([0.5, 0.5]))
            .map_or_else(|| centroid(&self.corners), |(at, _)| at);
        let raw = angle(&self.corners) - self.angle;
        self.rotation =
            raw + ((self.rotation - raw) / std::f64::consts::TAU).round() * std::f64::consts::TAU;
        let [cx, cy] = normalized(center);
        TrackSample {
            cx,
            cy,
            scale: (area(&self.corners) / self.area.max(FLAT)).sqrt() as f32,
            rotation: self.rotation as f32,
            confidence: score.clamp(0.0, 1.0),
            corners: Some(self.corners.map(normalized)),
        }
    }
}

fn refine(
    frame: &GrayFrame,
    grid: &Grid,
    template: &[f32],
    mut corners: Corners,
    photometric: &mut Option<[f64; 2]>,
) -> Option<Corners> {
    let limit = [(frame.width - 1) as f64, (frame.height - 1) as f64];
    let shortest = (0..4)
        .map(|index| distance(corners[index], corners[(index + 1) % 4]))
        .fold(f64::MAX, f64::min);
    for _ in 0..ITERATIONS {
        let warp = Warp::new(&corners)?;
        let samples: Vec<Sample> = grid
            .points
            .par_iter()
            .enumerate()
            .filter_map(|(index, &point)| {
                if !template[index].is_finite() {
                    return None;
                }
                let ([x, y], [rx, ry, depth]) = warp.at(point)?;
                if !(0.0..=limit[0]).contains(&x) || !(0.0..=limit[1]).contains(&y) {
                    return None;
                }
                let (x, y) = (x as f32, y as f32);
                Some((
                    index,
                    [
                        frame.sample(x, y) as f64,
                        (frame.sample(x + 1.0, y) - frame.sample(x - 1.0, y)) as f64 * 0.5,
                        (frame.sample(x, y + 1.0) - frame.sample(x, y - 1.0)) as f64 * 0.5,
                        rx,
                        ry,
                        depth,
                    ],
                ))
            })
            .collect();
        if (samples.len() as f64) < MIN_VISIBLE * grid.points.len() as f64 {
            return None;
        }
        let [gain, bias] = *photometric.get_or_insert_with(|| moments(&samples, template));
        let residuals: Vec<f64> = samples
            .iter()
            .map(|&(index, sample)| gain * sample[0] + bias - template[index] as f64)
            .collect();
        let cutoff = HUBER * spread(&residuals);
        let mut normal = samples
            .par_chunks(CHUNK)
            .zip(residuals.par_chunks(CHUNK))
            .map(|(samples, residuals)| {
                let mut normal = Normal::ZERO;
                for (&(index, [value, gx, gy, rx, ry, depth]), &residual) in
                    samples.iter().zip(residuals)
                {
                    let [u, v] = grid.points[index];
                    let (gx, gy) = (gain * gx / depth, gain * gy / depth);
                    let turn = -(gx * rx + gy * ry);
                    let jacobian = [
                        gx * u,
                        gx * v,
                        gx,
                        gy * u,
                        gy * v,
                        gy,
                        turn * u,
                        turn * v,
                        value,
                        1.0,
                    ];
                    let weight = if residual.abs() <= cutoff {
                        1.0
                    } else {
                        cutoff / residual.abs()
                    };
                    normal.add(&jacobian, residual, weight);
                }
                normal
            })
            .collect::<Vec<_>>()
            .iter()
            .fold(Normal::ZERO, Normal::merge);
        for row in 0..10 {
            for column in 0..row {
                normal.matrix[row][column] = normal.matrix[column][row];
            }
            normal.matrix[row][row] *= 1.0 + DAMPING;
        }
        let step = solve(normal.matrix, normal.vector)?;
        let mut scale = 1.0;
        let mut shrinks = 0;
        let moved = loop {
            let mut map = warp.map;
            for (value, delta) in map.0.iter_mut().zip(&step[..8]) {
                *value -= scale * delta;
            }
            let moved = Warp {
                origin: warp.origin,
                map,
            }
            .corners()
            .filter(convex);
            let reach = moved.map(|moved| {
                (0..4)
                    .map(|index| distance(moved[index], corners[index]))
                    .fold(0.0, f64::max)
            });
            match (moved, reach) {
                (Some(moved), Some(reach)) if reach <= MAX_STEP * shortest => {
                    break Some((moved, reach));
                }
                (Some(_), Some(reach)) => scale *= MAX_STEP * shortest / reach,
                _ => scale *= 0.5,
            }
            shrinks += 1;
            if scale < 1e-3 || shrinks == MAX_SHRINKS {
                break None;
            }
        };
        let (moved, reach) = moved?;
        corners = moved;
        *photometric = Some([gain - scale * step[8], bias - scale * step[9]]);
        if reach < CONVERGED {
            break;
        }
    }
    corners
        .iter()
        .flatten()
        .all(|value| value.is_finite())
        .then_some(corners)
}

fn moments(samples: &[Sample], template: &[f32]) -> [f64; 2] {
    let count = samples.len().max(1) as f64;
    let pairs = || {
        samples
            .iter()
            .map(|&(index, sample)| (sample[0], template[index] as f64))
    };
    let (source, target) = pairs().fold((0.0, 0.0), |(a, b), (x, y)| (a + x, b + y));
    let (source, target) = (source / count, target / count);
    let (source_spread, target_spread) = pairs().fold((0.0, 0.0), |(a, b), (x, y)| {
        (a + (x - source).powi(2), b + (y - target).powi(2))
    });
    let source_deviation = (source_spread / count).sqrt();
    let target_deviation = (target_spread / count).sqrt();
    let gain = if source_deviation > MIN_NOISE * 0.1 {
        target_deviation / source_deviation
    } else {
        1.0
    };
    [gain, target - gain * source]
}

fn sampled(frame: &GrayFrame, grid: &Grid, warp: &Warp) -> Vec<f32> {
    let limit = [(frame.width - 1) as f64, (frame.height - 1) as f64];
    grid.points
        .iter()
        .map(|&point| match warp.at(point) {
            Some(([x, y], _)) if (0.0..=limit[0]).contains(&x) && (0.0..=limit[1]).contains(&y) => {
                frame.sample(x as f32, y as f32)
            }
            _ => f32::NAN,
        })
        .collect()
}

fn agreement(shown: &[f32], template: &[f32], keep: &[bool]) -> Option<f32> {
    let pairs = || {
        shown
            .iter()
            .zip(template)
            .zip(keep)
            .filter(|(_, kept)| **kept)
            .map(|((&a, &b), _)| (a as f64, b as f64))
    };
    let count = pairs().count() as f64;
    if count < 1.0 {
        return None;
    }
    let (mean_a, mean_b) = pairs().fold((0.0, 0.0), |(sa, sb), (a, b)| (sa + a, sb + b));
    let (mean_a, mean_b) = (mean_a / count, mean_b / count);
    let (cross, energy_a, energy_b) = pairs().fold((0.0, 0.0, 0.0), |(c, ea, eb), (a, b)| {
        let (a, b) = (a - mean_a, b - mean_b);
        (c + a * b, ea + a * a, eb + b * b)
    });
    (energy_a > FLAT * count && energy_b > FLAT * count)
        .then(|| (cross / (energy_a * energy_b).sqrt()) as f32)
}

fn scaled(corners: &Corners, level: usize) -> Corners {
    let factor = (1u32 << level) as f64;
    corners.map(|point| point.map(|value| (value + 0.5) / factor - 0.5))
}

fn unscaled(corners: &Corners, level: usize) -> Corners {
    let factor = (1u32 << level) as f64;
    corners.map(|point| point.map(|value| (value + 0.5) * factor - 0.5))
}

fn shifted(corners: &Corners, by: &Corners, amount: f64) -> Corners {
    std::array::from_fn(|index| {
        [
            corners[index][0] + by[index][0] * amount,
            corners[index][1] + by[index][1] * amount,
        ]
    })
}

fn difference(to: &Corners, from: &Corners) -> Corners {
    std::array::from_fn(|index| [to[index][0] - from[index][0], to[index][1] - from[index][1]])
}

fn centroid(corners: &Corners) -> [f64; 2] {
    [0, 1].map(|axis| corners.iter().map(|point| point[axis]).sum::<f64>() * 0.25)
}

fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn turns(corners: &Corners) -> [f64; 4] {
    std::array::from_fn(|index| {
        let [a, b, c] = [0, 1, 2].map(|offset| corners[(index + offset) % 4]);
        (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    })
}

fn convex(corners: &Corners) -> bool {
    let turns = turns(corners);
    turns.iter().all(|&turn| turn > FLAT) || turns.iter().all(|&turn| turn < -FLAT)
}

fn contains(corners: &Corners, point: [f64; 2]) -> bool {
    let sides: [f64; 4] = std::array::from_fn(|index| {
        let (a, b) = (corners[index], corners[(index + 1) % 4]);
        (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
    });
    sides.iter().all(|&side| side >= 0.0) || sides.iter().all(|&side| side <= 0.0)
}

fn area(corners: &Corners) -> f64 {
    0.5 * (0..4)
        .map(|index| {
            let (a, b) = (corners[index], corners[(index + 1) % 4]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        .abs()
}

fn angle(corners: &Corners) -> f64 {
    let left = [0, 1].map(|axis| 0.5 * (corners[0][axis] + corners[3][axis]));
    let right = [0, 1].map(|axis| 0.5 * (corners[1][axis] + corners[2][axis]));
    (right[1] - left[1]).atan2(right[0] - left[0])
}
