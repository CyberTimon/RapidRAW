use rayon::prelude::*;

use super::frame::{GrayFrame, Pyramid, to_level};

const RADIUS: usize = 7;
const SIDE: usize = 2 * RADIUS + 1;
const PADDED: usize = SIDE + 2;
const ITERATIONS: usize = 20;
const CONVERGED: f32 = 1e-4;
const COARSE_CONVERGED: f32 = 4e-3;
const MIN_EIGENVALUE: f32 = 2e-6;
const ROUND_TRIP: f32 = 0.5;

pub(super) fn track(
    previous: &Pyramid,
    next: &Pyramid,
    base: usize,
    points: &[[f32; 2]],
    guess: [f32; 2],
) -> Vec<Option<[f32; 2]>> {
    points
        .par_iter()
        .map(|&point| {
            let forward = follow(previous, next, base, point, guess)?;
            let reverse = [point[0] - forward[0], point[1] - forward[1]];
            let back = follow(next, previous, base, forward, reverse)?;
            let error = (back[0] - point[0]).powi(2) + (back[1] - point[1]).powi(2);
            (error <= ROUND_TRIP * ROUND_TRIP).then_some(forward)
        })
        .collect()
}

fn follow(
    from: &Pyramid,
    to: &Pyramid,
    base: usize,
    point: [f32; 2],
    guess: [f32; 2],
) -> Option<[f32; 2]> {
    let top = from.0.len().min(to.0.len()) - 1;
    let mut flow = guess.map(|value| value / (1u32 << (top - base)) as f32);
    for level in (base..=top).rev() {
        let tolerance = if level == base {
            CONVERGED
        } else {
            COARSE_CONVERGED
        };
        let refined = refine(
            &from.0[level],
            &to.0[level],
            to_level(point, level - base),
            flow,
            tolerance,
        );
        flow = match refined {
            Some(refined) => refined,
            None if level > base => flow,
            None => return None,
        };
        if level > base {
            flow = flow.map(|value| value * 2.0);
        }
    }
    let frame = &to.0[base];
    let end = [point[0] + flow[0], point[1] + flow[1]];
    let inside = end[0] >= 0.0
        && end[1] >= 0.0
        && end[0] <= (frame.width - 1) as f32
        && end[1] <= (frame.height - 1) as f32;
    inside.then_some(end)
}

fn refine(
    from: &GrayFrame,
    to: &GrayFrame,
    at: [f32; 2],
    mut flow: [f32; 2],
    tolerance: f32,
) -> Option<[f32; 2]> {
    let mut padded = [0.0; PADDED * PADDED];
    let corner = (RADIUS + 1) as f32;
    from.sample_window(at[0] - corner, at[1] - corner, PADDED, &mut padded);
    let mut template = [0.0; SIDE * SIDE];
    let mut gradients = [[0.0f32; 2]; SIDE * SIDE];
    for (index, (value, gradient)) in template.iter_mut().zip(&mut gradients).enumerate() {
        let center = (index / SIDE + 1) * PADDED + index % SIDE + 1;
        *value = padded[center];
        *gradient = [
            (padded[center + 1] - padded[center - 1]) * 0.5,
            (padded[center + PADDED] - padded[center - PADDED]) * 0.5,
        ];
    }
    let count = (SIDE * SIDE) as f32;
    let mean = gradients
        .iter()
        .fold([0.0; 2], |sum, g| [sum[0] + g[0], sum[1] + g[1]])
        .map(|sum| sum / count);
    let (mut xx, mut yy, mut xy) = (0.0, 0.0, 0.0);
    for gradient in &mut gradients {
        *gradient = [gradient[0] - mean[0], gradient[1] - mean[1]];
        xx += gradient[0] * gradient[0];
        yy += gradient[1] * gradient[1];
        xy += gradient[0] * gradient[1];
    }
    let half_trace = 0.5 * (xx + yy);
    let smallest = half_trace - (0.25 * (xx - yy) * (xx - yy) + xy * xy).sqrt();
    if smallest < MIN_EIGENVALUE * count {
        return None;
    }
    let determinant = xx * yy - xy * xy;
    let inverse = [yy / determinant, -xy / determinant, xx / determinant];

    let mut warped = [0.0; SIDE * SIDE];
    let radius = RADIUS as f32;
    for _ in 0..ITERATIONS {
        to.sample_window(
            at[0] + flow[0] - radius,
            at[1] + flow[1] - radius,
            SIDE,
            &mut warped,
        );
        let mismatch = template.iter().zip(&warped).zip(&gradients).fold(
            [0.0; 2],
            |sum, ((value, target), gradient)| {
                let difference = value - target;
                [
                    sum[0] + gradient[0] * difference,
                    sum[1] + gradient[1] * difference,
                ]
            },
        );
        let step = [
            inverse[0] * mismatch[0] + inverse[1] * mismatch[1],
            inverse[1] * mismatch[0] + inverse[2] * mismatch[1],
        ];
        flow = [flow[0] + step[0], flow[1] + step[1]];
        if step[0] * step[0] + step[1] * step[1] < tolerance {
            break;
        }
    }
    flow.iter().all(|value| value.is_finite()).then_some(flow)
}
