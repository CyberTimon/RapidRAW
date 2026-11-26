use rayon::prelude::*;

use super::frame::GrayFrame;

const RADIUS: usize = 2;
const QUALITY: f32 = 0.01;
const MIN_RESPONSE: f32 = 1e-5;
const CORNER_RADIUS: usize = 1;
const MAX_CORNERS: usize = 1 << 16;
const REFINE_RADIUS: i32 = 1;
const REFINE_STEPS: usize = 6;
const REFINE_LIMIT: f32 = 3.0;
const REFINE_CONVERGED: f32 = 1e-3;

pub fn strong_corners(frame: &GrayFrame) -> Vec<[f32; 2]> {
    let (width, height) = (frame.width as f32, frame.height as f32);
    let Some([left, top, area_width, area_height]) =
        area(frame, [0.0, 0.0, width, height], CORNER_RADIUS)
    else {
        return Vec::new();
    };
    let response = response(frame, left, top, area_width, area_height, CORNER_RADIUS);
    let mut peaks = maxima(&response, area_width, area_height);
    if peaks.len() > MAX_CORNERS {
        peaks.select_nth_unstable_by(MAX_CORNERS, |a, b| b.0.total_cmp(&a.0));
        peaks.truncate(MAX_CORNERS);
    }
    peaks
        .into_par_iter()
        .map(|(_, x, y)| {
            let [x, y] = refined(frame, [(left + x) as f32, (top + y) as f32]);
            [(x + 0.5) / width, (y + 0.5) / height]
        })
        .collect()
}

fn refined(frame: &GrayFrame, start: [f32; 2]) -> [f32; 2] {
    let mut point = start;
    for _ in 0..REFINE_STEPS {
        let mut sums = [0.0f32; 5];
        for dy in -REFINE_RADIUS..=REFINE_RADIUS {
            for dx in -REFINE_RADIUS..=REFINE_RADIUS {
                let (x, y) = (point[0] + dx as f32, point[1] + dy as f32);
                let gx = (frame.sample(x + 1.0, y) - frame.sample(x - 1.0, y)) * 0.5;
                let gy = (frame.sample(x, y + 1.0) - frame.sample(x, y - 1.0)) * 0.5;
                let terms = [
                    gx * gx,
                    gx * gy,
                    gy * gy,
                    gx * gx * x + gx * gy * y,
                    gx * gy * x + gy * gy * y,
                ];
                for (sum, term) in sums.iter_mut().zip(terms) {
                    *sum += term;
                }
            }
        }
        let [xx, xy, yy, bx, by] = sums;
        let determinant = xx * yy - xy * xy;
        if determinant <= MIN_RESPONSE * MIN_RESPONSE {
            break;
        }
        let next = [
            (yy * bx - xy * by) / determinant,
            (xx * by - xy * bx) / determinant,
        ];
        let moved = (next[0] - point[0]).hypot(next[1] - point[1]);
        point = next;
        if moved < REFINE_CONVERGED {
            break;
        }
    }
    if (point[0] - start[0]).hypot(point[1] - start[1]) <= REFINE_LIMIT
        && point.iter().all(|value| value.is_finite())
    {
        point
    } else {
        start
    }
}

pub(super) fn detect(
    frame: &GrayFrame,
    bounds: [f32; 4],
    count: usize,
    spacing: f32,
    grid: usize,
    accept: impl Fn([f32; 2]) -> bool,
) -> Vec<[f32; 2]> {
    let Some([left, top, area_width, area_height]) = area(frame, bounds, RADIUS) else {
        return Vec::new();
    };
    let response = response(frame, left, top, area_width, area_height, RADIUS);
    let mut candidates = maxima(&response, area_width, area_height);
    candidates.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));

    let cell = spacing.max(1.0);
    let columns = (area_width as f32 / cell) as usize + 1;
    let rows = (area_height as f32 / cell) as usize + 1;
    let mut cells: Vec<Vec<[f32; 2]>> = vec![Vec::new(); columns * rows];
    let grid = grid.max(1);
    let mut quota = vec![count.div_ceil(grid * grid); grid * grid];
    let mut points = Vec::new();
    for (_, x, y) in candidates {
        if points.len() >= count {
            break;
        }
        let point = [(left + x) as f32, (top + y) as f32];
        let region = (y * grid / area_height) * grid + x * grid / area_width;
        if quota[region] == 0 || !accept(point) {
            continue;
        }
        let (column, row) = ((x as f32 / cell) as usize, (y as f32 / cell) as usize);
        let crowded = (row.saturating_sub(1)..(row + 2).min(rows))
            .flat_map(|r| {
                (column.saturating_sub(1)..(column + 2).min(columns)).map(move |c| r * columns + c)
            })
            .flat_map(|index| &cells[index])
            .any(|other| {
                (other[0] - point[0]).powi(2) + (other[1] - point[1]).powi(2) < cell * cell
            });
        if crowded {
            continue;
        }
        quota[region] -= 1;
        cells[row * columns + column].push(point);
        points.push(point);
    }
    points
}

fn area(frame: &GrayFrame, bounds: [f32; 4], radius: usize) -> Option<[usize; 4]> {
    let (width, height) = (frame.width as usize, frame.height as usize);
    let margin = radius + 2;
    let limit = |value: f32, length: usize| {
        (value.max(0.0) as usize)
            .max(margin)
            .min(length.saturating_sub(margin))
    };
    let (left, top) = (limit(bounds[0], width), limit(bounds[1], height));
    let (right, bottom) = (limit(bounds[2], width), limit(bounds[3], height));
    (right >= left + 3 && bottom >= top + 3).then_some([left, top, right - left, bottom - top])
}

fn maxima(response: &[f32], width: usize, height: usize) -> Vec<(f32, usize, usize)> {
    let peak = response.iter().copied().fold(0.0, f32::max);
    let threshold = (peak * QUALITY).max(MIN_RESPONSE);
    (1..height - 1)
        .into_par_iter()
        .flat_map_iter(|y| (1..width - 1).map(move |x| (x, y)))
        .filter_map(|(x, y)| {
            let value = response[y * width + x];
            let maximum = (y - 1..=y + 1)
                .flat_map(|row| &response[row * width + x - 1..][..3])
                .all(|&neighbor| neighbor <= value);
            (value >= threshold && maximum).then_some((value, x, y))
        })
        .collect()
}

fn response(
    frame: &GrayFrame,
    left: usize,
    top: usize,
    width: usize,
    height: usize,
    radius: usize,
) -> Vec<f32> {
    let stride = frame.width as usize;
    let padded = width + 2 * radius;
    let mut tensor = vec![[0.0f32; 3]; padded * (height + 2 * radius)];
    tensor
        .par_chunks_mut(padded)
        .enumerate()
        .for_each(|(row, out)| {
            let y = top + row - radius;
            let [above, middle, below] = [y - 1, y, y + 1]
                .map(|line| &frame.data[line * stride + left - radius - 1..][..padded + 2]);
            for (((value, a), b), c) in out
                .iter_mut()
                .zip(above.windows(3))
                .zip(middle.windows(3))
                .zip(below.windows(3))
            {
                let gx = (a[2] - a[0] + 2.0 * (b[2] - b[0]) + c[2] - c[0]) * 0.125;
                let gy = (c[0] - a[0] + 2.0 * (c[1] - a[1]) + c[2] - a[2]) * 0.125;
                *value = [gx * gx, gy * gy, gx * gy];
            }
        });
    let window = 2 * radius + 1;
    let mut horizontal = vec![[0.0f32; 3]; width * (height + 2 * radius)];
    horizontal
        .par_chunks_mut(width)
        .zip(tensor.par_chunks(padded))
        .for_each(|(out, row)| {
            for (value, values) in out.iter_mut().zip(row.windows(window)) {
                *value = values.iter().fold([0.0; 3], add);
            }
        });
    let normalization = 1.0 / (window * window) as f32;
    let mut response = vec![0.0; width * height];
    response
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(row, out)| {
            for (column, value) in out.iter_mut().enumerate() {
                let [xx, yy, xy] = (0..window).fold([0.0; 3], |total, offset| {
                    add(total, &horizontal[(row + offset) * width + column])
                });
                let half_trace = 0.5 * (xx + yy);
                *value = (half_trace - (0.25 * (xx - yy).powi(2) + xy * xy).sqrt()) * normalization;
            }
        });
    response
}

fn add(total: [f32; 3], value: &[f32; 3]) -> [f32; 3] {
    [
        total[0] + value[0],
        total[1] + value[1],
        total[2] + value[2],
    ]
}
