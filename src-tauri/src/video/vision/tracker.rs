use std::borrow::Cow;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::features::detect;
use super::flow::track;
use super::frame::{GrayFrame, Pyramid, from_level, to_level};
use super::geometry::{Transform, ransac, solve};

const TEMPLATE_SIDE: f32 = 64.0;
const MIN_SIDE: f32 = 8.0;
const LEVELS_ABOVE: usize = 3;
const FEATURES: usize = 64;
const FEATURE_SPACING: f32 = 3.0;
const FEATURE_AREA: f32 = 0.9;
const INLIER_DISTANCE: f32 = 1.0;
const MIN_INLIERS: usize = 4;
const MIN_INLIER_RATIO: f32 = 0.4;
const MAX_SCALE_STEP: f32 = 1.1;
const MAX_ROTATION_STEP: f32 = 0.15;
const COARSE_STEPS: usize = 2;
const MIN_GRID: usize = 8;
const ITERATIONS: usize = 10;
const CONVERGED: f64 = 5e-3;
const DAMPING: f64 = 1e-3;
const HUBER: f64 = 1.345;
const MIN_RESIDUAL: f64 = 1e-3;
const REFINE_RADIUS: usize = 2;
const SEARCH_EXTENT: f32 = 0.75;
const SEARCH_GROWTH: f32 = 0.1;
const MAX_SEARCH_EXTENT: f32 = 1.5;
const COARSE_CELLS: usize = 16;
const DETAIL_RADIUS: usize = 3;
const ACCEPT: f32 = 0.5;
const REACQUIRE: f32 = 0.7;
const ADAPT: f32 = 0.7;
const REFRESH: f32 = 0.85;
const MIN_VISIBLE: f32 = 0.5;
const COAST_DAMPING: f32 = 0.8;
const RESET_AFTER: u32 = 3;
pub const LEAVING: f32 = 0.5;
const FLAT: f32 = 1e-8;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub cx: f32,
    pub cy: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSample {
    pub cx: f32,
    pub cy: f32,
    pub scale: f32,
    pub rotation: f32,
    pub confidence: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corners: Option<[[f32; 2]; 4]>,
}

#[derive(Clone, Copy, Debug)]
struct Pose {
    center: [f32; 2],
    scale: f32,
    rotation: f32,
}

#[derive(Clone, Copy, Debug)]
struct Motion {
    shift: [f32; 2],
    scale: f32,
    rotation: f32,
}

const STILL: Motion = Motion {
    shift: [0.0; 2],
    scale: 1.0,
    rotation: 0.0,
};

impl Motion {
    fn between(from: Pose, to: Pose) -> Self {
        Self {
            shift: [0, 1].map(|axis| to.center[axis] - from.center[axis]),
            scale: to.scale / from.scale,
            rotation: to.rotation - from.rotation,
        }
    }

    fn apply(&self, pose: Pose) -> Pose {
        Pose {
            center: [0, 1].map(|axis| pose.center[axis] + self.shift[axis]),
            scale: pose.scale * self.scale,
            rotation: pose.rotation + self.rotation,
        }
    }

    fn damped(&self) -> Self {
        Self {
            shift: self.shift.map(|value| value * COAST_DAMPING),
            scale: self.scale.powf(COAST_DAMPING),
            rotation: self.rotation * COAST_DAMPING,
        }
    }
}

pub struct RegionTracker {
    previous: Pyramid,
    base: usize,
    frame: [u32; 2],
    cells: [usize; 2],
    spacing: [f32; 2],
    grids: Vec<Grid>,
    pose: Pose,
    motion: Motion,
    reference: Templates,
    anchor: Templates,
    misses: u32,
    coverage: f32,
}

#[derive(Clone, Default)]
struct Templates {
    levels: Vec<Vec<f32>>,
    pattern: Vec<f32>,
}

struct Grid {
    columns: usize,
    points: Vec<[f32; 2]>,
}

impl Grid {
    fn new(cells: [usize; 2], spacing: [f32; 2], step: usize) -> Self {
        let counts = cells.map(|count| (count >> step).max(MIN_GRID.min(count)));
        let pitch = [0, 1].map(|axis| spacing[axis] * cells[axis] as f32 / counts[axis] as f32);
        let offset = |axis: usize, index: usize| {
            (index as f32 - (counts[axis] - 1) as f32 * 0.5) * pitch[axis]
        };
        Self {
            columns: counts[0],
            points: (0..counts[1])
                .flat_map(|y| (0..counts[0]).map(move |x| [offset(0, x), offset(1, y)]))
                .collect(),
        }
    }
}

impl RegionTracker {
    pub fn new(first: &GrayFrame, region: Region) -> Self {
        let frame = [first.width, first.height];
        let size = [
            (region.width.clamp(0.0, 1.0) * frame[0] as f32).max(MIN_SIDE),
            (region.height.clamp(0.0, 1.0) * frame[1] as f32).max(MIN_SIDE),
        ];
        let wanted = (size[0].max(size[1]) / TEMPLATE_SIDE)
            .log2()
            .ceil()
            .max(0.0) as usize;
        let previous = Pyramid::new(first.clone(), wanted + LEVELS_ABOVE + 1);
        let base = wanted.min(previous.0.len() - 1);
        let level_size = size.map(|side| side / (1u32 << base) as f32);
        let cells = level_size.map(|side| (side * 0.5).round().max(4.0) as usize * 2);
        let spacing = [0, 1].map(|axis| level_size[axis] / cells[axis] as f32);
        let center = [
            region.cx * frame[0] as f32 - 0.5,
            region.cy * frame[1] as f32 - 0.5,
        ];
        let mut tracker = Self {
            previous,
            base,
            frame,
            cells,
            spacing,
            grids: (0..=COARSE_STEPS)
                .map(|step| Grid::new(cells, spacing, step))
                .collect(),
            pose: Pose {
                center: to_level(center, base),
                scale: 1.0,
                rotation: 0.0,
            },
            motion: STILL,
            reference: Templates::default(),
            anchor: Templates::default(),
            misses: 0,
            coverage: 1.0,
        };
        tracker.coverage = MIN_VISIBLE
            * tracker.visible(
                &tracker.previous.0[base],
                base,
                &tracker.grids[0],
                tracker.pose,
            );
        tracker.reference = tracker.templates(&tracker.previous);
        tracker.anchor = tracker.reference.clone();
        tracker
    }

    pub fn leaving(&self) -> bool {
        self.visible(
            &self.previous.0[self.base],
            self.base,
            &self.grids[0],
            self.pose,
        ) < LEAVING
    }

    pub fn update(&mut self, frame: &GrayFrame) -> Option<TrackSample> {
        if [frame.width, frame.height] != self.frame {
            return None;
        }
        let current = Pyramid::new(frame.clone(), self.previous.0.len());
        let predicted = self.motion.apply(self.pose);
        let found = self
            .follow(&current, predicted)
            .or_else(|| self.search(&current, predicted));
        let sample = match found {
            Some((score, pose)) => {
                self.motion = if self.misses == 0 {
                    Motion::between(self.pose, pose)
                } else {
                    STILL
                };
                self.pose = pose;
                self.misses = 0;
                if (ADAPT..REFRESH).contains(&score) {
                    self.anchor = self.templates(&current);
                }
                Some(self.sample(score))
            }
            None => {
                self.misses += 1;
                if self.misses == RESET_AFTER {
                    self.anchor = self.reference.clone();
                }
                self.pose = predicted;
                self.motion = self.motion.damped();
                None
            }
        };
        self.previous = current;
        sample
    }

    fn templates(&self, pyramid: &Pyramid) -> Templates {
        let fine = self.level(self.pose.scale);
        let levels = self
            .grids
            .iter()
            .enumerate()
            .map_while(|(step, grid)| {
                let level = fine + step;
                (level < pyramid.0.len()).then(|| self.sampled(pyramid, level, grid, self.pose))
            })
            .collect();
        Templates {
            levels,
            pattern: self.patch(pyramid, self.pose, 0, 0),
        }
    }

    fn follow(&self, current: &Pyramid, predicted: Pose) -> Option<(f32, Pose)> {
        let estimate = (self.misses == 0)
            .then(|| self.feature_motion(current))
            .flatten();
        self.settle(
            current,
            estimate.unwrap_or(predicted),
            estimate.is_none(),
            ACCEPT,
        )
    }

    fn settle(
        &self,
        current: &Pyramid,
        start: Pose,
        coarse: bool,
        threshold: f32,
    ) -> Option<(f32, Pose)> {
        self.align(current, start, coarse)
            .filter(|(score, _)| *score >= threshold)
            .or_else(|| {
                let (score, pose) = self.locate(current, start, REFINE_RADIUS, 0)?;
                let visible = self.visible(&current.0[self.base], self.base, &self.grids[0], pose);
                (score >= threshold && visible >= self.coverage).then_some((score, pose))
            })
    }

    fn feature_motion(&self, current: &Pyramid) -> Option<Pose> {
        let Pose {
            center: [cx, cy],
            scale,
            rotation,
        } = self.pose;
        let half = [0, 1].map(|axis| 0.5 * self.cells[axis] as f32 * self.spacing[axis] * scale);
        let (sin, cos) = rotation.sin_cos();
        let extent = [
            cos.abs() * half[0] + sin.abs() * half[1],
            sin.abs() * half[0] + cos.abs() * half[1],
        ];
        let inside = |[x, y]: [f32; 2]| {
            let (dx, dy) = (x - cx, y - cy);
            (dx * cos + dy * sin).abs() <= FEATURE_AREA * half[0]
                && (dy * cos - dx * sin).abs() <= FEATURE_AREA * half[1]
        };
        let points = detect(
            &self.previous.0[self.base],
            [
                cx - extent[0],
                cy - extent[1],
                cx + extent[0] + 1.0,
                cy + extent[1] + 1.0,
            ],
            FEATURES,
            FEATURE_SPACING,
            1,
            inside,
        );
        let pairs: Vec<_> = points
            .iter()
            .zip(track(
                &self.previous,
                current,
                self.base,
                &points,
                self.motion.shift,
            ))
            .filter_map(|(&[fx, fy], to)| {
                let [tx, ty] = to?;
                Some(([fx - cx, fy - cy], [tx - cx, ty - cy]))
            })
            .collect();
        let (motion, inliers) = ransac::<Transform>(&pairs, INLIER_DISTANCE)?;
        if inliers < MIN_INLIERS || (inliers as f32) < MIN_INLIER_RATIO * pairs.len() as f32 {
            return None;
        }
        Some(Pose {
            center: [cx + motion.tx, cy + motion.ty],
            scale: scale * motion.scale().clamp(1.0 / MAX_SCALE_STEP, MAX_SCALE_STEP),
            rotation: rotation + motion.angle().clamp(-MAX_ROTATION_STEP, MAX_ROTATION_STEP),
        })
    }

    fn search(&self, current: &Pyramid, predicted: Pose) -> Option<(f32, Pose)> {
        let coarse = usize::from(
            self.cells[0].min(self.cells[1]) >= COARSE_CELLS && self.base + 1 < current.0.len(),
        );
        let side = [0, 1]
            .map(|axis| self.cells[axis] as f32 * self.spacing[axis])
            .into_iter()
            .fold(0.0, f32::max)
            * predicted.scale;
        let shift = self.motion.shift[0].hypot(self.motion.shift[1]);
        let reach = (SEARCH_EXTENT + SEARCH_GROWTH * self.misses as f32).min(MAX_SEARCH_EXTENT)
            * side
            + shift;
        let cell = self.spacing[0].max(self.spacing[1]) * predicted.scale * (1 << coarse) as f32;
        let (_, rough) = self.locate(current, predicted, (reach / cell).ceil() as usize, coarse)?;
        let (_, rough) = self.locate(current, rough, REFINE_RADIUS, 0)?;
        self.settle(current, rough, false, REACQUIRE)
    }

    fn level(&self, scale: f32) -> usize {
        (self.base as f32 + scale.log2().round()).clamp(0.0, (self.previous.0.len() - 1) as f32)
            as usize
    }

    fn align(&self, pyramid: &Pyramid, start: Pose, coarse: bool) -> Option<(f32, Pose)> {
        let fine = self.level(start.scale);
        let steps = if coarse {
            self.anchor.levels.len().min(pyramid.0.len() - fine)
        } else {
            1
        };
        let mut params = [
            start.center[0] as f64,
            start.center[1] as f64,
            (start.scale * start.rotation.cos()) as f64,
            (start.scale * start.rotation.sin()) as f64,
        ];
        for step in (0..steps).rev() {
            params = self.refine(
                &pyramid.0[fine + step],
                fine + step,
                &self.grids[step],
                &self.anchor.levels[step],
                params,
            )?;
        }
        let [x, y, a, b] = params;
        let scale = a.hypot(b);
        let turn = (b.atan2(a) - start.rotation as f64 + std::f64::consts::PI)
            .rem_euclid(std::f64::consts::TAU)
            - std::f64::consts::PI;
        let pose = Pose {
            center: [x as f32, y as f32],
            scale: scale as f32,
            rotation: start.rotation + turn as f32,
        };
        if (pose.scale / self.pose.scale).ln().abs() > MAX_SCALE_STEP.ln()
            || (pose.rotation - self.pose.rotation).abs() > MAX_ROTATION_STEP
        {
            return None;
        }
        let grid = &self.grids[0];
        if self.visible(&pyramid.0[fine], fine, grid, pose) < self.coverage {
            return None;
        }
        let shown = self.sampled(pyramid, fine, grid, pose);
        let width = grid.columns;
        let radius = DETAIL_RADIUS.min((width.min(grid.points.len() / width) - 1) / 2);
        let (score, _) = correlate(
            &detail(&shown, width, radius),
            width - 2 * radius,
            &detail(&self.anchor.levels[0], width, radius),
            width - 2 * radius,
        )?;
        Some((score, pose))
    }

    fn refine(
        &self,
        frame: &GrayFrame,
        level: usize,
        grid: &Grid,
        template: &[f32],
        mut params: [f64; 4],
    ) -> Option<[f64; 4]> {
        let factor = self.factor(level);
        let limit = [(frame.width - 1) as f32, (frame.height - 1) as f32];
        let reach = grid
            .points
            .iter()
            .map(|[x, y]| x.hypot(*y))
            .fold(0.0, f32::max) as f64;
        let mut photometric = None;
        for _ in 0..ITERATIONS {
            let [cx, cy, a, b] = params.map(|value| value as f32);
            let warp = self.warp(level, [cx, cy], [a, b]);
            let samples: Vec<(usize, [f32; 3])> = grid
                .points
                .par_iter()
                .enumerate()
                .filter_map(|(index, point)| {
                    let [x, y] = warp(point);
                    ((0.0..=limit[0]).contains(&x) && (0.0..=limit[1]).contains(&y)).then(|| {
                        (
                            index,
                            [
                                frame.sample(x, y),
                                (frame.sample(x + 1.0, y) - frame.sample(x - 1.0, y))
                                    * 0.5
                                    * factor,
                                (frame.sample(x, y + 1.0) - frame.sample(x, y - 1.0))
                                    * 0.5
                                    * factor,
                            ],
                        )
                    })
                })
                .collect();
            if samples.is_empty() {
                return None;
            }
            let [gain, bias] = *photometric.get_or_insert_with(|| moments(&samples, template));
            let residuals: Vec<f64> = samples
                .iter()
                .map(|&(index, sample)| gain * sample[0] as f64 + bias - template[index] as f64)
                .collect();
            let cutoff = HUBER * spread(&residuals);
            let mut hessian = [[0.0f64; 6]; 6];
            let mut gradient = [0.0f64; 6];
            for (&(index, sample), &residual) in samples.iter().zip(&residuals) {
                let [ux, uy] = grid.points[index];
                let (gx, gy) = (gain * sample[1] as f64, gain * sample[2] as f64);
                let (ux, uy) = (ux as f64, uy as f64);
                let jacobian = [
                    gx,
                    gy,
                    gx * ux + gy * uy,
                    gy * ux - gx * uy,
                    sample[0] as f64,
                    1.0,
                ];
                let weight = if residual.abs() <= cutoff {
                    1.0
                } else {
                    cutoff / residual.abs()
                };
                for ((line, total), &value) in hessian.iter_mut().zip(&mut gradient).zip(&jacobian)
                {
                    *total += weight * value * residual;
                    for (cell, &other) in line.iter_mut().zip(&jacobian) {
                        *cell += weight * value * other;
                    }
                }
            }
            for (index, line) in hessian.iter_mut().enumerate() {
                line[index] *= 1.0 + DAMPING;
            }
            let step = solve(hessian, gradient)?;
            for (value, delta) in params.iter_mut().zip(&step) {
                *value -= delta;
            }
            photometric = Some([gain - step[4], bias - step[5]]);
            let moved = step[0].abs() + step[1].abs() + reach * (step[2].abs() + step[3].abs());
            if moved < CONVERGED {
                break;
            }
        }
        params
            .iter()
            .all(|value| value.is_finite())
            .then_some(params)
    }

    fn factor(&self, level: usize) -> f32 {
        2f32.powi(self.base as i32 - level as i32)
    }

    fn warp(
        &self,
        level: usize,
        [cx, cy]: [f32; 2],
        [a, b]: [f32; 2],
    ) -> impl Fn(&[f32; 2]) -> [f32; 2] + Sync {
        let factor = self.factor(level);
        move |&[ux, uy]| {
            [
                (cx + a * ux - b * uy + 0.5) * factor - 0.5,
                (cy + b * ux + a * uy + 0.5) * factor - 0.5,
            ]
        }
    }

    fn pose_warp(&self, level: usize, pose: Pose) -> impl Fn(&[f32; 2]) -> [f32; 2] + Sync {
        let (sin, cos) = pose.rotation.sin_cos();
        self.warp(level, pose.center, [pose.scale * cos, pose.scale * sin])
    }

    fn sampled(&self, pyramid: &Pyramid, level: usize, grid: &Grid, pose: Pose) -> Vec<f32> {
        let frame = &pyramid.0[level];
        let warp = self.pose_warp(level, pose);
        grid.points
            .iter()
            .map(|point| {
                let [x, y] = warp(point);
                frame.sample(x, y)
            })
            .collect()
    }

    fn visible(&self, frame: &GrayFrame, level: usize, grid: &Grid, pose: Pose) -> f32 {
        let warp = self.pose_warp(level, pose);
        let limit = [(frame.width - 1) as f32, (frame.height - 1) as f32];
        let inside = grid
            .points
            .iter()
            .filter(|point| {
                let [x, y] = warp(point);
                (0.0..=limit[0]).contains(&x) && (0.0..=limit[1]).contains(&y)
            })
            .count();
        inside as f32 / grid.points.len() as f32
    }

    fn locate(
        &self,
        pyramid: &Pyramid,
        pose: Pose,
        radius: usize,
        coarse: usize,
    ) -> Option<(f32, Pose)> {
        let width = self.cells[0] >> coarse;
        let template = if coarse == 0 {
            Cow::Borrowed(&self.anchor.pattern)
        } else {
            Cow::Owned(halved(&self.anchor.pattern, self.cells[0]))
        };
        let search = self.patch(pyramid, pose, coarse, radius);
        let (score, offset) = correlate(&search, width + 2 * radius, &template, width)?;
        let axes = self.axes(pose);
        let factor = (1u32 << coarse) as f32;
        let center = [0, 1]
            .map(|i| pose.center[i] + (offset[0] * axes[0][i] + offset[1] * axes[1][i]) * factor);
        Some((score, Pose { center, ..pose }))
    }

    fn axes(&self, pose: Pose) -> [[f32; 2]; 2] {
        let (sin, cos) = pose.rotation.sin_cos();
        let [x, y] = self.spacing.map(|spacing| spacing * pose.scale);
        [[cos * x, sin * x], [-sin * y, cos * y]]
    }

    fn patch(&self, pyramid: &Pyramid, pose: Pose, coarse: usize, margin: usize) -> Vec<f32> {
        let frame = &pyramid.0[self.base + coarse];
        let radius = (DETAIL_RADIUS >> coarse).max(1);
        let axes = self.axes(pose);
        let [width, height] = self
            .cells
            .map(|cells| (cells >> coarse) + 2 * (margin + radius));
        let center = to_level(pose.center, coarse);
        let half = [(width - 1) as f32 * 0.5, (height - 1) as f32 * 0.5];
        let origin = [0, 1].map(|i| center[i] - axes[0][i] * half[0] - axes[1][i] * half[1]);
        let samples: Vec<f32> = (0..height)
            .flat_map(|y| {
                (0..width).map(move |x| {
                    let (x, y) = (x as f32, y as f32);
                    frame.sample(
                        origin[0] + axes[0][0] * x + axes[1][0] * y,
                        origin[1] + axes[0][1] * x + axes[1][1] * y,
                    )
                })
            })
            .collect();
        detail(&samples, width, radius)
    }

    fn sample(&self, score: f32) -> TrackSample {
        let [x, y] = from_level(self.pose.center, self.base);
        TrackSample {
            cx: (x + 0.5) / self.frame[0] as f32,
            cy: (y + 0.5) / self.frame[1] as f32,
            scale: self.pose.scale,
            rotation: self.pose.rotation,
            confidence: score.clamp(0.0, 1.0),
            corners: None,
        }
    }
}

fn statistics(values: impl Iterator<Item = f64> + Clone) -> (f64, f64) {
    let count = values.clone().count().max(1) as f64;
    let mean = values.clone().sum::<f64>() / count;
    let deviation = (values.map(|value| (value - mean).powi(2)).sum::<f64>() / count).sqrt();
    (mean, deviation)
}

fn moments(samples: &[(usize, [f32; 3])], template: &[f32]) -> [f64; 2] {
    let (source, source_deviation) = statistics(samples.iter().map(|(_, sample)| sample[0] as f64));
    let (target, target_deviation) =
        statistics(samples.iter().map(|&(index, _)| template[index] as f64));
    let gain = if source_deviation > MIN_RESIDUAL {
        target_deviation / source_deviation
    } else {
        1.0
    };
    [gain, target - gain * source]
}

pub(super) fn spread(residuals: &[f64]) -> f64 {
    let mut magnitudes: Vec<f64> = residuals.iter().map(|value| value.abs()).collect();
    let middle = magnitudes.len() / 2;
    let (_, median, _) = magnitudes.select_nth_unstable_by(middle, f64::total_cmp);
    (1.4826 * *median).max(MIN_RESIDUAL)
}

pub(super) fn detail(values: &[f32], width: usize, radius: usize) -> Vec<f32> {
    let window = 2 * radius + 1;
    let inner = width - 2 * radius;
    let sums: Vec<f32> = values
        .chunks_exact(width)
        .flat_map(|row| row.windows(window).map(|values| values.iter().sum::<f32>()))
        .collect();
    let normalization = 1.0 / (window * window) as f32;
    (radius..values.len() / width - radius)
        .flat_map(|y| {
            let sums = &sums;
            (0..inner).map(move |x| {
                let local: f32 = (y - radius..=y + radius)
                    .map(|row| sums[row * inner + x])
                    .sum();
                values[y * width + x + radius] - local * normalization
            })
        })
        .collect()
}

fn vertex(before: f32, peak: f32, after: f32) -> f32 {
    let curvature = before - 2.0 * peak + after;
    if curvature < 0.0 {
        (0.5 * (before - after) / curvature).clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn halved(values: &[f32], width: usize) -> Vec<f32> {
    let height = values.len() / width;
    (0..height / 2)
        .flat_map(|y| {
            (0..width / 2).map(move |x| {
                let at = |dx: usize, dy: usize| values[(2 * y + dy) * width + 2 * x + dx];
                0.25 * (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1))
            })
        })
        .collect()
}

fn correlate(
    search: &[f32],
    search_width: usize,
    template: &[f32],
    width: usize,
) -> Option<(f32, [f32; 2])> {
    let count = template.len() as f32;
    let mean = template.iter().sum::<f32>() / count;
    let centered: Vec<f32> = template.iter().map(|value| value - mean).collect();
    let energy: f32 = centered.iter().map(|value| value * value).sum();
    if energy < FLAT * count {
        return None;
    }
    let columns = search_width - width + 1;
    let rows = search.len() / search_width - template.len() / width + 1;
    let scores: Vec<f32> = (0..columns * rows)
        .into_par_iter()
        .map(|index| {
            let (x, y) = (index % columns, index / columns);
            let (mut cross, mut sum, mut squares) = (0.0, 0.0, 0.0);
            for (row, line) in centered.chunks_exact(width).enumerate() {
                let window = &search[(y + row) * search_width + x..][..width];
                for (value, weight) in window.iter().zip(line) {
                    cross += value * weight;
                    sum += value;
                    squares += value * value;
                }
            }
            let variance = squares - sum * sum / count;
            if variance > FLAT * count {
                cross / (energy * variance).sqrt()
            } else {
                0.0
            }
        })
        .collect();
    let best = (0..scores.len()).max_by(|&a, &b| scores[a].total_cmp(&scores[b]))?;
    let (x, y) = (best % columns, best / columns);
    let offset = |inside: bool, before: usize, after: usize| {
        if inside {
            vertex(scores[before], scores[best], scores[after])
        } else {
            0.0
        }
    };
    let dx = offset(x > 0 && x + 1 < columns, best.wrapping_sub(1), best + 1);
    let dy = offset(
        y > 0 && y + 1 < rows,
        best.wrapping_sub(columns),
        best + columns,
    );
    Some((
        scores[best],
        [
            x as f32 + dx - (columns - 1) as f32 * 0.5,
            y as f32 + dy - (rows - 1) as f32 * 0.5,
        ],
    ))
}
