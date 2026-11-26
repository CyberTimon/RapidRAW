use std::ops::Range;

use rayon::prelude::*;

use super::geometry::Transform;
use super::lp::{Program, Rows};
use super::motion::Similarity;

const SMOOTHNESS: [f64; 3] = [0.3, 10.0, 100.0];
const REFERENCE_FPS: f64 = 30.0;
const PARAMETERS: usize = 4;
const IDENTITY: [f64; PARAMETERS] = [1.0, 0.0, 0.0, 0.0];
const DIFFERENCES: [&[f64]; 3] = [&[1.0], &[-1.0, 1.0], &[1.0, -2.0, 1.0]];
const CORNERS: [[f64; 2]; 4] = [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]];
const START_ZOOM: f64 = 0.1;
const WINDOW: usize = 240;
const OVERLAP: usize = 60;

#[derive(Clone, Debug, PartialEq)]
pub struct Stabilization {
    pub corrections: Vec<Similarity>,
    pub zoom: f32,
}

struct CameraPath<'a> {
    motions: &'a [[f64; 4]],
    weights: [f64; 4],
    crop: [f64; 2],
    frame: [f64; 2],
}

impl CameraPath<'_> {
    fn residual(
        &self,
        at: usize,
        component: usize,
        scale: f64,
        entries: &mut Vec<(usize, f64)>,
    ) -> f64 {
        let [a, b, x, y] = self.motions[at];
        let pair = PARAMETERS * at + component / 2 * 2;
        let (first, second) = if component.is_multiple_of(2) {
            (a, -b)
        } else {
            (b, a)
        };
        entries.push((pair, -scale * first));
        entries.push((pair + 1, -scale * second));
        entries.push((PARAMETERS * (at + 1) + component, scale));
        -scale * [0.0, 0.0, x, y][component]
    }

    fn program(&self) -> Program {
        let frames = self.motions.len() + 1;
        let mut terms = Rows::new();
        let mut weights = Vec::new();
        let mut entries = Vec::with_capacity(3 * PARAMETERS);
        for at in 0..frames {
            for (component, identity) in IDENTITY.iter().enumerate() {
                terms.push(&mut [(PARAMETERS * at + component, 1.0)], -identity);
                weights.push(self.weights[0]);
            }
        }
        for (order, taps) in DIFFERENCES.iter().enumerate() {
            for at in 0..frames.saturating_sub(order + 1) {
                for component in 0..PARAMETERS {
                    entries.clear();
                    let constant = taps
                        .iter()
                        .enumerate()
                        .map(|(step, &tap)| self.residual(at + step, component, tap, &mut entries))
                        .sum();
                    terms.push(&mut entries, constant);
                    weights.push(self.weights[order + 1]);
                }
            }
        }
        let ([hx, hy], [wx, wy]) = (self.crop, self.frame);
        let mut limits = Rows::new();
        for at in 0..frames {
            let base = PARAMETERS * at;
            for [sx, sy] in CORNERS {
                limits.push(
                    &mut [(base, hx), (base + 1, -sx * sy * hy), (base + 2, sx)],
                    -wx,
                );
                limits.push(
                    &mut [(base, hy), (base + 1, sx * sy * hx), (base + 3, sy)],
                    -wy,
                );
            }
            limits.push(&mut [(base, -1.0)], 1.0);
        }
        Program {
            terms,
            weights,
            limits,
        }
    }

    fn solve(&self, zoom: f64) -> Vec<f64> {
        let start = (0..=self.motions.len())
            .flat_map(|_| [1.0 + START_ZOOM * (zoom - 1.0), 0.0, 0.0, 0.0])
            .collect();
        self.program().solve(start)
    }
}

fn windows(frames: usize) -> Vec<Range<usize>> {
    let count = frames
        .saturating_sub(OVERLAP)
        .div_ceil(WINDOW - OVERLAP)
        .max(1);
    let length = frames.min(WINDOW);
    (0..count)
        .map(|index| {
            let start = index * (frames - length) / (count - 1).max(1);
            start..start + length
        })
        .collect()
}

fn ramp(position: usize) -> f64 {
    let t = ((position as f64 + 0.5) / OVERLAP as f64).min(1.0);
    t * t * (3.0 - 2.0 * t)
}

pub fn stabilize(
    motions: &[Option<Similarity>],
    fps: f32,
    follow: f64,
    max_zoom: f32,
    aspect: f32,
) -> Stabilization {
    let units = [aspect, 1.0];
    let frames = motions.len() + 1;
    if max_zoom <= 1.0 {
        return Stabilization {
            corrections: vec![Similarity::IDENTITY; frames],
            zoom: 1.0,
        };
    }
    let rate = f64::from(fps) / REFERENCE_FPS;
    let zoom = f64::from(max_zoom);
    let half = [f64::from(aspect) * 0.5, 0.5];
    let motions: Vec<[f64; 4]> = filled(motions)
        .iter()
        .map(|motion| {
            let transform = motion.transform(units);
            [transform.a, transform.b, transform.tx, transform.ty].map(f64::from)
        })
        .collect();
    let [velocity, acceleration, jerk] = SMOOTHNESS;
    let weights = [
        follow / rate,
        velocity,
        acceleration * rate,
        jerk * rate * rate,
    ];
    let spans = windows(frames);
    let solutions: Vec<Vec<f64>> = spans
        .par_iter()
        .map(|span| {
            CameraPath {
                motions: &motions[span.start..span.end - 1],
                weights,
                crop: half.map(|value| value / zoom),
                frame: half,
            }
            .solve(zoom)
        })
        .collect();
    let mut blended = vec![([0.0; PARAMETERS], 0.0); frames];
    for (index, (span, solution)) in spans.iter().zip(&solutions).enumerate() {
        for (offset, parameters) in solution.as_chunks::<PARAMETERS>().0.iter().enumerate() {
            let rising = if index == 0 { 1.0 } else { ramp(offset) };
            let falling = if index + 1 == spans.len() {
                1.0
            } else {
                ramp(span.len() - 1 - offset)
            };
            let (sums, total) = &mut blended[span.start + offset];
            for (sum, parameter) in sums.iter_mut().zip(parameters) {
                *sum += rising * falling * parameter;
            }
            *total += rising * falling;
        }
    }
    let paths: Vec<Transform> = blended
        .iter()
        .map(|(sums, total)| {
            let [a, b, tx, ty] = sums.map(|sum| (sum / total) as f32);
            Transform { a, b, tx, ty }
        })
        .collect();
    let zoom = paths
        .iter()
        .map(|path| required_zoom(path, units))
        .fold(1.0, f32::max)
        .min(max_zoom);
    Stabilization {
        corrections: paths
            .iter()
            .map(|path| Similarity::from_transform(&path.inverse(), units))
            .collect(),
        zoom,
    }
}

fn filled(motions: &[Option<Similarity>]) -> Vec<Similarity> {
    let mut afters = vec![None; motions.len()];
    let mut next = None;
    for (after, motion) in afters.iter_mut().zip(motions).rev() {
        *after = next;
        next = motion.or(next);
    }
    let mut before = None;
    motions
        .iter()
        .zip(afters)
        .map(|(motion, after)| {
            let value = motion.unwrap_or_else(|| match (before, after) {
                (Some(a), Some(b)) => Similarity {
                    dx: 0.5 * (a.dx + b.dx),
                    dy: 0.5 * (a.dy + b.dy),
                    angle: 0.5 * (a.angle + b.angle),
                    scale: (a.scale * b.scale).sqrt(),
                },
                (Some(motion), None) | (None, Some(motion)) => motion,
                (None, None) => Similarity::IDENTITY,
            });
            before = motion.or(before);
            value
        })
        .collect()
}

fn required_zoom(path: &Transform, units: [f32; 2]) -> f32 {
    let origin = path.apply([0.0; 2]);
    let half = units.map(|unit| 0.5 * unit);
    let mut reach = f32::INFINITY;
    for corner in CORNERS {
        let direction = path.linear([corner[0] as f32 * half[0], corner[1] as f32 * half[1]]);
        for axis in 0..2 {
            let slack = half[axis] - origin[axis] * direction[axis].signum();
            if slack <= 0.0 {
                return f32::INFINITY;
            }
            reach = reach.min(slack / direction[axis].abs());
        }
    }
    1.0 / reach
}
