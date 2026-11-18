use super::camera::{Camera, Lens};
use super::projection::Canvas;
use nalgebra::Vector3;
use rayon::prelude::*;

const ENVELOPE_FRACTION: f64 = 1.0 / 24.0;

#[derive(Debug, Clone)]
pub struct EdgeCurves {
    start: Vec<f64>,
    end: Vec<f64>,
    step: f64,
    target_start: f64,
    target_end: f64,
}

impl EdgeCurves {
    fn eval(&self, position: f64) -> (f64, f64) {
        let t = (position / self.step - 0.5).clamp(0.0, (self.start.len() - 1) as f64);
        let i = (t.floor() as usize).min(self.start.len() - 1);
        let j = (i + 1).min(self.start.len() - 1);
        let f = t - i as f64;
        (
            self.start[i] + (self.start[j] - self.start[i]) * f,
            self.end[i] + (self.end[j] - self.end[i]) * f,
        )
    }

    fn remap(&self, along: f64, across: f64, amount: f64) -> f64 {
        let (s, e) = self.eval(along);
        let span = (self.target_end - self.target_start).max(1e-9);
        let t = (across - self.target_start) / span;
        let mapped = s + t * (e - s);
        across + amount * (mapped - across)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
pub struct OutputLayout {
    pub canvas: Canvas,
    pub crop: CropRect,
    amount: f64,
    vertical: Option<EdgeCurves>,
    horizontal: Option<EdgeCurves>,
}

impl OutputLayout {
    fn canvas_point(&self, x: f64, y: f64) -> (f64, f64) {
        let x1 = match &self.horizontal {
            Some(curves) => curves.remap(y, x, self.amount),
            None => x,
        };
        let y1 = match &self.vertical {
            Some(curves) => curves.remap(x1, y, self.amount),
            None => y,
        };
        (x1, y1)
    }

    #[inline]
    pub fn ray(&self, x: f64, y: f64) -> Option<Vector3<f64>> {
        let (cx, cy) = self.canvas_point(self.crop.x + x, self.crop.y + y);
        self.canvas.ray_at(cx, cy)
    }
}

struct Mask {
    width: usize,
    height: usize,
    scale: f64,
    data: Vec<bool>,
}

impl Mask {
    fn at_canvas(&self, x: f64, y: f64) -> bool {
        let gx = (x * self.scale).floor();
        let gy = (y * self.scale).floor();
        if gx < 0.0 || gy < 0.0 || gx >= self.width as f64 || gy >= self.height as f64 {
            return false;
        }
        self.data[gy as usize * self.width + gx as usize]
    }

    fn from_fn(
        width: usize,
        height: usize,
        scale: f64,
        f: impl Fn(f64, f64) -> bool + Sync,
    ) -> Self {
        let mut data = vec![false; width * height];
        data.par_chunks_mut(width)
            .enumerate()
            .for_each(|(gy, row)| {
                let y = (gy as f64 + 0.5) / scale;
                for (gx, v) in row.iter_mut().enumerate() {
                    *v = f((gx as f64 + 0.5) / scale, y);
                }
            });
        Mask {
            width,
            height,
            scale,
            data,
        }
    }
}

pub fn covered_by_any(cameras: &[Camera], lens: &Lens, ray: &Vector3<f64>) -> bool {
    cameras.iter().any(|camera| {
        camera
            .project(lens, ray)
            .is_some_and(|p| camera.contains(&p))
    })
}

fn smooth_envelope(raw: &[Option<f64>], take_max: bool) -> Option<Vec<f64>> {
    let n = raw.len();
    let first_valid = raw.iter().position(|v| v.is_some())?;
    let mut filled = vec![0.0; n];
    let mut last = raw[first_valid].unwrap();
    for (i, v) in raw.iter().enumerate() {
        if let Some(v) = v {
            last = *v;
        }
        filled[i] = last;
    }
    let radius = ((n as f64 * ENVELOPE_FRACTION).round() as usize).max(2);
    let envelope: Vec<f64> = (0..n)
        .map(|i| {
            let lo = i.saturating_sub(radius);
            let hi = (i + radius + 1).min(n);
            let window = filled[lo..hi].iter().copied();
            if take_max {
                window.fold(f64::MIN, f64::max)
            } else {
                window.fold(f64::MAX, f64::min)
            }
        })
        .collect();

    let sigma = radius as f64 / 2.0;
    let k = (sigma * 3.0).ceil() as isize;
    let weights: Vec<f64> = (-k..=k)
        .map(|d| (-(d * d) as f64 / (2.0 * sigma * sigma)).exp())
        .collect();
    Some(
        (0..n as isize)
            .map(|i| {
                let mut sum = 0.0;
                let mut weight = 0.0;
                for (j, w) in (-k..=k).zip(weights.iter()) {
                    let idx = (i + j).clamp(0, n as isize - 1) as usize;
                    sum += envelope[idx] * w;
                    weight += w;
                }
                let smoothed = sum / weight;
                if take_max {
                    smoothed.max(filled[i as usize])
                } else {
                    smoothed.min(filled[i as usize])
                }
            })
            .collect(),
    )
}

fn column_curves(mask: &Mask) -> Option<EdgeCurves> {
    edge_curves(mask.width, mask.height, mask.scale, |x, y| {
        mask.data[y * mask.width + x]
    })
}

fn row_curves(mask: &Mask) -> Option<EdgeCurves> {
    edge_curves(mask.height, mask.width, mask.scale, |y, x| {
        mask.data[y * mask.width + x]
    })
}

fn edge_curves(
    lines: usize,
    length: usize,
    scale: f64,
    covered: impl Fn(usize, usize) -> bool,
) -> Option<EdgeCurves> {
    let starts: Vec<Option<f64>> = (0..lines)
        .map(|line| (0..length).find(|&i| covered(line, i)).map(|i| i as f64))
        .collect();
    let ends: Vec<Option<f64>> = (0..lines)
        .map(|line| {
            (0..length)
                .rev()
                .find(|&i| covered(line, i))
                .map(|i| i as f64 + 1.0)
        })
        .collect();
    build_curves(&starts, &ends, scale)
}

fn build_curves(starts: &[Option<f64>], ends: &[Option<f64>], scale: f64) -> Option<EdgeCurves> {
    let start = smooth_envelope(starts, true)?;
    let end = smooth_envelope(ends, false)?;
    let target_start = starts.iter().flatten().fold(f64::MAX, |a, &b| a.min(b));
    let target_end = ends.iter().flatten().fold(f64::MIN, |a, &b| a.max(b));
    Some(EdgeCurves {
        start: start.iter().map(|v| v / scale).collect(),
        end: end.iter().map(|v| v / scale).collect(),
        step: 1.0 / scale,
        target_start: target_start / scale,
        target_end: target_end / scale,
    })
}

fn largest_rectangle(mask: &Mask) -> Option<(usize, usize, usize, usize)> {
    let (w, h) = (mask.width, mask.height);
    let mut heights = vec![0usize; w];
    let mut best: Option<(usize, usize, usize, usize)> = None;
    let mut best_area = 0;
    let mut stack: Vec<usize> = Vec::with_capacity(w + 1);
    for y in 0..h {
        for (height, &valid) in heights.iter_mut().zip(&mask.data[y * w..(y + 1) * w]) {
            *height = if valid { *height + 1 } else { 0 };
        }
        stack.clear();
        for x in 0..=w {
            let current = if x < w { heights[x] } else { 0 };
            while let Some(&top) = stack.last() {
                if heights[top] < current {
                    break;
                }
                stack.pop();
                let height = heights[top];
                let left = stack.last().map_or(0, |&s| s + 1);
                let area = height * (x - left);
                if area > best_area {
                    best_area = area;
                    best = Some((left, y + 1 - height, x - left, height));
                }
            }
            stack.push(x);
        }
    }
    best
}

fn full_width_rows(mask: &Mask) -> Option<(usize, usize, usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut run_start = None;
    for y in 0..=mask.height {
        let full = y < mask.height
            && mask.data[y * mask.width..(y + 1) * mask.width]
                .iter()
                .all(|&v| v);
        match (full, run_start) {
            (true, None) => run_start = Some(y),
            (false, Some(start)) => {
                if best.is_none_or(|(_, len)| y - start > len) {
                    best = Some((start, y - start));
                }
                run_start = None;
            }
            _ => {}
        }
    }
    best.map(|(y, h)| {
        let inset = if h > 4 { 1 } else { 0 };
        (0, y + inset, mask.width, h - 2 * inset)
    })
}

fn bounding_box(mask: &Mask) -> Option<(usize, usize, usize, usize)> {
    let mut x0 = usize::MAX;
    let mut y0 = usize::MAX;
    let mut x1 = 0;
    let mut y1 = 0;
    for y in 0..mask.height {
        for x in 0..mask.width {
            if mask.data[y * mask.width + x] {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    (x0 < x1).then(|| (x0, y0, x1 - x0, y1 - y0))
}

pub fn plan_layout(
    canvas: Canvas,
    cameras: &[Camera],
    lens: &Lens,
    grid_scale: f64,
    boundary_warp: f64,
    auto_crop: bool,
) -> Result<OutputLayout, String> {
    let gw = ((canvas.width * grid_scale).ceil() as usize).max(1);
    let gh = ((canvas.height * grid_scale).ceil() as usize).max(1);
    let union = Mask::from_fn(gw, gh, grid_scale, |x, y| {
        canvas
            .ray_at(x, y)
            .is_some_and(|ray| covered_by_any(cameras, lens, &ray))
    });

    let mut layout = OutputLayout {
        canvas,
        crop: CropRect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        },
        amount: boundary_warp.clamp(0.0, 1.0),
        vertical: None,
        horizontal: None,
    };

    if layout.amount > 0.0 {
        layout.vertical = column_curves(&union);
        if !layout.canvas.wraps {
            let partially_warped = Mask::from_fn(gw, gh, grid_scale, |x, y| {
                let (cx, cy) = layout.canvas_point(x, y);
                union.at_canvas(cx, cy)
            });
            layout.horizontal = row_curves(&partially_warped);
        }
    }

    let output = Mask::from_fn(gw, gh, grid_scale, |x, y| {
        let (cx, cy) = layout.canvas_point(x, y);
        union.at_canvas(cx, cy)
    });

    let rect = match (auto_crop, layout.canvas.wraps) {
        (true, true) => full_width_rows(&output),
        (true, false) => largest_rectangle(&output).map(|(x, y, w, h)| {
            let inset = |v: usize| if v > 4 { 1 } else { 0 };
            let (ix, iy) = (inset(w), inset(h));
            (x + ix, y + iy, w - 2 * ix, h - 2 * iy)
        }),
        (false, _) => bounding_box(&output),
    };
    let (x, y, w, h) = rect.ok_or_else(|| "The panorama has no visible area.".to_string())?;

    let (cx, cw) = if layout.canvas.wraps {
        (0.0, layout.canvas.width)
    } else {
        (x as f64 / grid_scale, w as f64 / grid_scale)
    };
    layout.crop = CropRect {
        x: cx,
        y: y as f64 / grid_scale,
        width: cw.min(layout.canvas.width),
        height: (h as f64 / grid_scale).min(layout.canvas.height),
    };
    Ok(layout)
}
