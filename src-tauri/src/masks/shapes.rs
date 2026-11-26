use crate::masks::morphology::for_each_mask_row;
use image::GrayImage;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f32::consts::PI;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct RadialMaskParameters {
    center_x: f64,
    center_y: f64,
    radius_x: f64,
    radius_y: f64,
    rotation: f32,
    feather: f32,
    #[serde(default)]
    inverse_plane: Option<[f64; 9]>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct LinearMaskParameters {
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    #[serde(default = "default_range")]
    range: f32,
}

fn default_range() -> f32 {
    50.0
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct RectangleMaskParameters {
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    rotation: f32,
    roundness: f32,
    feather: f32,
    inverse_plane: Option<[f64; 9]>,
}

struct Unplane {
    matrix: [f64; 9],
    scale: f64,
    crop: (f64, f64),
}

impl Unplane {
    fn new(matrix: Option<[f64; 9]>, scale: f32, crop_offset: (f32, f32)) -> Option<Self> {
        Some(Self {
            matrix: matrix?,
            scale: scale as f64,
            crop: (crop_offset.0 as f64, crop_offset.1 as f64),
        })
    }

    fn place(&self, x: f32, y: f32) -> Option<(f32, f32, f32)> {
        let m = &self.matrix;
        let fx = (x as f64 + self.crop.0) / self.scale;
        let fy = (y as f64 + self.crop.1) / self.scale;
        let depth = m[6] * fx + m[7] * fy + m[8];
        if depth <= 1e-12 {
            return None;
        }
        let rx = (m[0] * fx + m[1] * fy + m[2]) / depth;
        let ry = (m[3] * fx + m[4] * fy + m[5]) / depth;
        Some((
            (rx * self.scale - self.crop.0) as f32,
            (ry * self.scale - self.crop.1) as f32,
            depth.powf(1.5) as f32,
        ))
    }
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct PenPoint {
    x: f64,
    y: f64,
    in_x: f64,
    in_y: f64,
    out_x: f64,
    out_y: f64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct PenMaskParameters {
    points: Vec<PenPoint>,
    closed: bool,
    feather: f32,
}

impl Default for LinearMaskParameters {
    fn default() -> Self {
        Self {
            start_x: 0.0,
            start_y: 0.0,
            end_x: 0.0,
            end_y: 0.0,
            range: default_range(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrushLine {
    pub tool: String,
    pub brush_size: f32,
    pub points: Vec<Point>,
    #[serde(default = "default_brush_feather")]
    pub feather: f32,
}

fn default_brush_feather() -> f32 {
    0.5
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct BrushMaskParameters {
    #[serde(default)]
    lines: Vec<BrushLine>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct FlowLine {
    tool: String,
    brush_size: f32,
    points: Vec<Point>,
    #[serde(default = "default_brush_feather")]
    feather: f32,
    #[serde(default = "default_line_flow")]
    flow: f32,
}

fn default_line_flow() -> f32 {
    10.0
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct FlowMaskParameters {
    #[serde(default)]
    lines: Vec<FlowLine>,
}

fn stroke_bounds(
    points: &[Point],
    width: u32,
    height: u32,
    radius: f32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<(u32, u32, u32, u32)> {
    if width == 0 || height == 0 || points.is_empty() {
        return None;
    }

    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let r_pad = radius.ceil() + 2.0;

    for p in points {
        let px = p.x as f32 * scale - crop_offset.0;
        let py = p.y as f32 * scale - crop_offset.1;

        min_x = min_x.min(px - r_pad);
        min_y = min_y.min(py - r_pad);
        max_x = max_x.max(px + r_pad);
        max_y = max_y.max(py + r_pad);
    }

    if max_x < 0.0 || max_y < 0.0 || min_x > (width - 1) as f32 || min_y > (height - 1) as f32 {
        return None;
    }

    let min_x = min_x.floor().max(0.0).min((width - 1) as f32) as u32;
    let min_y = min_y.floor().max(0.0).min((height - 1) as f32) as u32;
    let max_x = max_x.ceil().max(0.0).min((width - 1) as f32) as u32;
    let max_y = max_y.ceil().max(0.0).min((height - 1) as f32) as u32;

    if min_x > max_x || min_y > max_y {
        None
    } else {
        Some((min_x, min_y, max_x, max_y))
    }
}

#[allow(clippy::too_many_arguments)]
fn render_stroke_layer_parallel(
    points: &[Point],
    radius: f32,
    feather: f32,
    scale: f32,
    crop_offset: (f32, f32),
    layer_offset: (f32, f32),
    bb_w: u32,
    bb_h: u32,
) -> GrayImage {
    let mut out_pixels = vec![0u8; (bb_w * bb_h) as usize];
    if points.is_empty() || radius <= 0.0 {
        return GrayImage::from_raw(bb_w, bb_h, out_pixels).unwrap();
    }

    struct Segment {
        x1: f32,
        y1: f32,
        dx: f32,
        dy: f32,
        len_sq: f32,
        bounds_left: i32,
        bounds_right: i32,
        bounds_top: i32,
        bounds_bottom: i32,
    }

    let mut segments = Vec::with_capacity(points.len().saturating_sub(1));
    for pair in points.windows(2) {
        let x1 = pair[0].x as f32 * scale - crop_offset.0 - layer_offset.0;
        let y1 = pair[0].y as f32 * scale - crop_offset.1 - layer_offset.1;
        let x2 = pair[1].x as f32 * scale - crop_offset.0 - layer_offset.0;
        let y2 = pair[1].y as f32 * scale - crop_offset.1 - layer_offset.1;

        let left = ((x1.min(x2) - radius).floor() as i32).max(0);
        let right = ((x1.max(x2) + radius).ceil() as i32).min(bb_w as i32 - 1);
        let top = ((y1.min(y2) - radius).floor() as i32).max(0);
        let bottom = ((y1.max(y2) + radius).ceil() as i32).min(bb_h as i32 - 1);

        if left > right || top > bottom {
            continue;
        }

        let dx = x2 - x1;
        let dy = y2 - y1;
        let len_sq = dx * dx + dy * dy;

        segments.push(Segment {
            x1,
            y1,
            dx,
            dy,
            len_sq,
            bounds_left: left,
            bounds_right: right,
            bounds_top: top,
            bounds_bottom: bottom,
        });
    }

    let mut single_point = None;
    if segments.is_empty() && !points.is_empty() {
        let x1 = points[0].x as f32 * scale - crop_offset.0 - layer_offset.0;
        let y1 = points[0].y as f32 * scale - crop_offset.1 - layer_offset.1;
        let left = ((x1 - radius).floor() as i32).max(0);
        let right = ((x1 + radius).ceil() as i32).min(bb_w as i32 - 1);
        let top = ((y1 - radius).floor() as i32).max(0);
        let bottom = ((y1 + radius).ceil() as i32).min(bb_h as i32 - 1);
        if left <= right && top <= bottom {
            single_point = Some((x1, y1, left, right, top, bottom));
        }
    }

    let feather_amount = feather.clamp(0.0, 1.0);
    let inner_radius = radius * (1.0 - feather_amount);
    let feather_range = (radius - inner_radius).max(0.01);
    let radius_sq = radius * radius;
    let inner_radius_sq = inner_radius * inner_radius;

    out_pixels
        .par_chunks_mut(bb_w as usize)
        .enumerate()
        .for_each(|(y, row)| {
            let py = y as f32;
            let y_i32 = y as i32;

            let mut active_segments = Vec::new();
            for seg in &segments {
                if y_i32 >= seg.bounds_top && y_i32 <= seg.bounds_bottom {
                    active_segments.push(seg);
                }
            }

            let is_point_active = if let Some(pt) = &single_point {
                y_i32 >= pt.4 && y_i32 <= pt.5
            } else {
                false
            };

            if active_segments.is_empty() && !is_point_active {
                return;
            }

            for (x, pixel) in row.iter_mut().enumerate() {
                let px = x as f32;
                let x_i32 = x as i32;

                let mut min_dist_sq = radius_sq + 1.0;

                for seg in &active_segments {
                    if x_i32 >= seg.bounds_left && x_i32 <= seg.bounds_right {
                        let dist_sq = if seg.len_sq < 0.0001 {
                            (px - seg.x1) * (px - seg.x1) + (py - seg.y1) * (py - seg.y1)
                        } else {
                            let t = (((px - seg.x1) * seg.dx + (py - seg.y1) * seg.dy)
                                / seg.len_sq)
                                .clamp(0.0, 1.0);
                            let proj_x = seg.x1 + t * seg.dx;
                            let proj_y = seg.y1 + t * seg.dy;
                            (px - proj_x) * (px - proj_x) + (py - proj_y) * (py - proj_y)
                        };
                        if dist_sq < min_dist_sq {
                            min_dist_sq = dist_sq;
                        }
                    }
                }

                if is_point_active {
                    let pt = single_point.as_ref().unwrap();
                    if x_i32 >= pt.2 && x_i32 <= pt.3 {
                        let dist_sq = (px - pt.0) * (px - pt.0) + (py - pt.1) * (py - pt.1);
                        if dist_sq < min_dist_sq {
                            min_dist_sq = dist_sq;
                        }
                    }
                }

                if min_dist_sq <= radius_sq {
                    let intensity = if min_dist_sq <= inner_radius_sq {
                        1.0
                    } else {
                        let dist = min_dist_sq.sqrt();
                        let t = ((dist - inner_radius) / feather_range).clamp(0.0, 1.0);
                        1.0 - (t * t * (3.0 - 2.0 * t))
                    };
                    *pixel = (intensity * 255.0).round() as u8;
                }
            }
        });

    GrayImage::from_raw(bb_w, bb_h, out_pixels).unwrap()
}

pub fn generate_radial_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: RadialMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);

    let center_x = (params.center_x as f32 * scale - crop_offset.0) as i32;
    let center_y = (params.center_y as f32 * scale - crop_offset.1) as i32;
    let radius_x = params.radius_x as f32 * scale;
    let radius_y = params.radius_y as f32 * scale;
    let rotation_rad = params.rotation * PI / 180.0;
    let cos_rot = rotation_rad.cos();
    let sin_rot = rotation_rad.sin();
    let inner_bound = 1.0 - params.feather.clamp(0.0, 1.0);
    let unplane = Unplane::new(params.inverse_plane, scale, crop_offset);

    for_each_mask_row(&mut mask, |y, row| {
        for (x, value) in row.iter_mut().enumerate() {
            let (px, py) = match &unplane {
                None => (x as f32, y as f32),
                Some(unplane) => match unplane.place(x as f32, y as f32) {
                    Some((px, py, _)) => (px, py),
                    None => continue,
                },
            };
            let dx = px - center_x as f32;
            let dy = py - center_y as f32;

            let rot_dx = dx * cos_rot + dy * sin_rot;
            let rot_dy = -dx * sin_rot + dy * cos_rot;

            let norm_x = rot_dx / radius_x.max(0.01);
            let norm_y = rot_dy / radius_y.max(0.01);

            let dist = (norm_x.powi(2) + norm_y.powi(2)).sqrt();

            let intensity = 1.0 - (dist - inner_bound) / (1.0 - inner_bound).max(0.01);
            let clamped_intensity = intensity.clamp(0.0, 1.0);

            *value = (clamped_intensity * 255.0) as u8;
        }
    });

    mask
}

pub fn generate_linear_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: LinearMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);

    let start_x = params.start_x as f32 * scale - crop_offset.0;
    let start_y = params.start_y as f32 * scale - crop_offset.1;
    let end_x = params.end_x as f32 * scale - crop_offset.0;
    let end_y = params.end_y as f32 * scale - crop_offset.1;
    let range = params.range * scale;

    let line_vec_x = end_x - start_x;
    let line_vec_y = end_y - start_y;

    let len_sq = line_vec_x.powi(2) + line_vec_y.powi(2);

    if len_sq < 0.01 {
        return mask;
    }

    let perp_vec_x = -line_vec_y / len_sq.sqrt();
    let perp_vec_y = line_vec_x / len_sq.sqrt();

    let half_width = range.max(0.01);

    for_each_mask_row(&mut mask, |y_u, row| {
        let y = y_u as f32;
        for (x_u, value) in row.iter_mut().enumerate() {
            let x = x_u as f32;

            let pixel_vec_x = x - start_x;
            let pixel_vec_y = y - start_y;

            let dist_perp = pixel_vec_x * perp_vec_x + pixel_vec_y * perp_vec_y;

            let t = dist_perp / half_width;

            let intensity = 0.5 - t * 0.5;

            let clamped_intensity = intensity.clamp(0.0, 1.0);

            *value = (clamped_intensity * 255.0) as u8;
        }
    });

    mask
}

const CURVE_FLATNESS: f32 = 0.1;
const MAX_CURVE_STEPS: usize = 256;
const FEATHER_GRID_STEPS: f32 = 16.0;

fn edge_coverage(signed_distance: f32, feather: f32) -> f32 {
    let t = (0.5 - signed_distance / feather.max(1.0)).clamp(0.0, 1.0);
    if feather > 1.0 {
        t * t * (3.0 - 2.0 * t)
    } else {
        t
    }
}

fn shape_bounds(
    (min_x, min_y, max_x, max_y): (f32, f32, f32, f32),
    width: u32,
    height: u32,
) -> Option<(usize, usize, usize, usize)> {
    if width == 0
        || height == 0
        || max_x < 0.0
        || max_y < 0.0
        || min_x >= width as f32
        || min_y >= height as f32
    {
        return None;
    }
    Some((
        min_x.floor().max(0.0) as usize,
        min_y.floor().max(0.0) as usize,
        (max_x.ceil() as usize).min(width as usize - 1),
        (max_y.ceil() as usize).min(height as usize - 1),
    ))
}

fn fill_within(
    mask: &mut GrayImage,
    (x0, y0, x1, y1): (usize, usize, usize, usize),
    fill_row: impl Fn(f32, usize, &mut [u8]) + Sync,
) {
    for_each_mask_row(mask, |y, row| {
        let y = y as usize;
        if (y0..=y1).contains(&y) {
            fill_row(y as f32 + 0.5, x0, &mut row[x0..=x1]);
        }
    });
}

fn coverage_byte(coverage: f32) -> u8 {
    (coverage * 255.0 + 0.5) as u8
}

pub fn generate_rectangle_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: RectangleMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);

    let half_w = params.width.abs() as f32 * scale / 2.0;
    let half_h = params.height.abs() as f32 * scale / 2.0;
    if half_w <= 0.0 || half_h <= 0.0 {
        return mask;
    }
    let center_x = params.center_x as f32 * scale - crop_offset.0;
    let center_y = params.center_y as f32 * scale - crop_offset.1;
    let short = half_w.min(half_h);
    let radius = params.roundness.clamp(0.0, 1.0) * short;
    let feather = params.feather.clamp(0.0, 1.0) * 2.0 * short;
    let (sin, cos) = (params.rotation * PI / 180.0).sin_cos();
    let reach = feather.max(1.0) / 2.0 + 1.0;
    let extent_x = half_w * cos.abs() + half_h * sin.abs() + reach;
    let extent_y = half_w * sin.abs() + half_h * cos.abs() + reach;
    let unplane = Unplane::new(params.inverse_plane, scale, crop_offset);
    let extent = if unplane.is_some() {
        (0.0, 0.0, width as f32, height as f32)
    } else {
        (
            center_x - extent_x,
            center_y - extent_y,
            center_x + extent_x,
            center_y + extent_y,
        )
    };
    let Some(bounds) = shape_bounds(extent, width, height) else {
        return mask;
    };
    let (inner_w, inner_h) = (half_w - radius, half_h - radius);

    fill_within(&mut mask, bounds, |py, x0, span| {
        for (offset, value) in span.iter_mut().enumerate() {
            let px = (x0 + offset) as f32 + 0.5;
            let (sx, sy, stretch) = match &unplane {
                None => (px, py, 1.0),
                Some(unplane) => match unplane.place(px, py) {
                    Some(placed) => placed,
                    None => continue,
                },
            };
            let (dx, dy) = (sx - center_x, sy - center_y);
            let qx = (dx * cos + dy * sin).abs() - inner_w;
            let qy = (dy * cos - dx * sin).abs() - inner_h;
            let (outside_x, outside_y) = (qx.max(0.0), qy.max(0.0));
            let distance = (outside_x * outside_x + outside_y * outside_y).sqrt()
                + qx.max(qy).min(0.0)
                - radius;
            *value = coverage_byte(edge_coverage(distance * stretch, feather * stretch));
        }
    });

    mask
}

struct Edge {
    x0: f32,
    y0: f32,
    dx: f32,
    dy: f32,
    len_sq: f32,
    x_range: (f32, f32),
    y_range: (f32, f32),
}

impl Edge {
    fn new((x0, y0): (f32, f32), (x1, y1): (f32, f32)) -> Self {
        let (dx, dy) = (x1 - x0, y1 - y0);
        Self {
            x0,
            y0,
            dx,
            dy,
            len_sq: dx * dx + dy * dy,
            x_range: (x0.min(x1), x0.max(x1)),
            y_range: (y0.min(y1), y0.max(y1)),
        }
    }

    fn crossing(&self, py: f32) -> Option<(f32, i32)> {
        ((self.y0 <= py) != (self.y0 + self.dy <= py)).then(|| {
            (
                self.x0 + (py - self.y0) / self.dy * self.dx,
                if self.dy > 0.0 { 1 } else { -1 },
            )
        })
    }

    fn distance_sq(&self, px: f32, py: f32) -> f32 {
        let t = if self.len_sq > 0.0 {
            (((px - self.x0) * self.dx + (py - self.y0) * self.dy) / self.len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (ex, ey) = (px - self.x0 - t * self.dx, py - self.y0 - t * self.dy);
        ex * ex + ey * ey
    }
}

fn flatten_pen(points: &[PenPoint], scale: f32, crop_offset: (f32, f32)) -> Vec<(f32, f32)> {
    let place = |x: f64, y: f64| {
        (
            x as f32 * scale - crop_offset.0,
            y as f32 * scale - crop_offset.1,
        )
    };
    let mut polygon = Vec::new();
    for (index, from) in points.iter().enumerate() {
        let to = &points[(index + 1) % points.len()];
        let p0 = place(from.x, from.y);
        let p1 = place(from.x + from.out_x, from.y + from.out_y);
        let p2 = place(to.x + to.in_x, to.y + to.in_y);
        let p3 = place(to.x, to.y);
        let bend = (p0.0 - 2.0 * p1.0 + p2.0)
            .hypot(p0.1 - 2.0 * p1.1 + p2.1)
            .max((p1.0 - 2.0 * p2.0 + p3.0).hypot(p1.1 - 2.0 * p2.1 + p3.1));
        let steps =
            ((0.75 * bend / CURVE_FLATNESS).sqrt().ceil() as usize).clamp(1, MAX_CURVE_STEPS);
        polygon.push(p0);
        for step in 1..steps {
            let t = step as f32 / steps as f32;
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            polygon.push((
                a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0,
                a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1,
            ));
        }
    }
    polygon
}

fn row_distances(
    edges: &[Edge],
    py: f32,
    xs: impl Iterator<Item = f32>,
    reach: f32,
    mut emit: impl FnMut(f32),
) {
    let mut crossings: Vec<(f32, i32)> =
        edges.iter().filter_map(|edge| edge.crossing(py)).collect();
    crossings.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut near: Vec<(f32, f32, &Edge)> = edges
        .iter()
        .filter(|edge| edge.y_range.0 - reach <= py && edge.y_range.1 + reach >= py)
        .map(|edge| (edge.x_range.0 - reach, edge.x_range.1 + reach, edge))
        .collect();
    near.sort_by(|a, b| a.0.total_cmp(&b.0));

    let (mut winding, mut crossed, mut entered) = (0, 0, 0);
    let mut live: Vec<(f32, f32, &Edge)> = Vec::new();
    for px in xs {
        while crossed < crossings.len() && crossings[crossed].0 < px {
            winding += crossings[crossed].1;
            crossed += 1;
        }
        while entered < near.len() && near[entered].0 <= px {
            live.push(near[entered]);
            entered += 1;
        }
        live.retain(|entry| entry.1 >= px);
        let nearest = live
            .iter()
            .map(|entry| entry.2.distance_sq(px, py))
            .fold(reach * reach, f32::min)
            .sqrt();
        emit(if winding != 0 { -nearest } else { nearest });
    }
}

pub fn generate_pen_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: PenMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);
    if !params.closed || params.points.len() < 2 {
        return mask;
    }

    let polygon = flatten_pen(&params.points, scale, crop_offset);
    let edges: Vec<Edge> = polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .map(|(from, to)| Edge::new(*from, *to))
        .collect();
    let area = edges
        .iter()
        .map(|edge| edge.x0 * (edge.y0 + edge.dy) - (edge.x0 + edge.dx) * edge.y0)
        .sum::<f32>()
        .abs()
        / 2.0;
    let feather = params.feather.clamp(0.0, 1.0) * area.sqrt();
    let step = feather / FEATHER_GRID_STEPS;
    let reach = if step > 1.0 {
        feather / 2.0 + 2.0 * step
    } else {
        feather.max(1.0) / 2.0 + 0.5
    };
    let extent = |axis: fn(&(f32, f32)) -> f32| {
        polygon
            .iter()
            .map(axis)
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), value| {
                (low.min(value), high.max(value))
            })
    };
    let ((min_x, max_x), (min_y, max_y)) = (extent(|point| point.0), extent(|point| point.1));
    let Some(bounds) = shape_bounds(
        (min_x - reach, min_y - reach, max_x + reach, max_y + reach),
        width,
        height,
    ) else {
        return mask;
    };

    if step <= 1.0 {
        fill_within(&mut mask, bounds, |py, x0, span| {
            let mut values = span.iter_mut();
            let centers = (x0..x0 + values.len()).map(|x| x as f32 + 0.5);
            row_distances(&edges, py, centers, reach, |distance| {
                if let Some(value) = values.next() {
                    *value = coverage_byte(edge_coverage(distance, feather));
                }
            });
        });
        return mask;
    }

    let (x0, y0, x1, y1) = bounds;
    let origin = (x0 as f32 + 0.5, y0 as f32 + 0.5);
    let columns = ((x1 - x0) as f32 / step).ceil() as usize + 2;
    let rows = ((y1 - y0) as f32 / step).ceil() as usize + 2;
    let grid: Vec<Vec<f32>> = (0..rows)
        .into_par_iter()
        .map(|row| {
            let mut line = Vec::with_capacity(columns);
            let nodes = (0..columns).map(|column| origin.0 + column as f32 * step);
            row_distances(
                &edges,
                origin.1 + row as f32 * step,
                nodes,
                reach,
                |distance| line.push(distance),
            );
            line
        })
        .collect();
    fill_within(&mut mask, bounds, |py, _, span| {
        let fy = (py - origin.1) / step;
        let (row, ty) = (fy as usize, fy.fract());
        let (above, below) = (&grid[row], &grid[row + 1]);
        for (offset, value) in span.iter_mut().enumerate() {
            let fx = offset as f32 / step;
            let (column, tx) = (fx as usize, fx.fract());
            let top = above[column] + (above[column + 1] - above[column]) * tx;
            let bottom = below[column] + (below[column + 1] - below[column]) * tx;
            *value = coverage_byte(edge_coverage(top + (bottom - top) * ty, feather));
        }
    });

    mask
}

pub fn generate_brush_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: BrushMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut final_mask = GrayImage::new(width, height);

    for line in &params.lines {
        if line.points.is_empty() {
            continue;
        }

        let is_eraser = line.tool == "eraser";
        let radius = (line.brush_size * scale / 2.0).max(0.0);
        let feather = line.feather.clamp(0.0, 1.0);

        let Some((min_x, min_y, max_x, max_y)) =
            stroke_bounds(&line.points, width, height, radius, scale, crop_offset)
        else {
            continue;
        };

        let bb_w = max_x - min_x + 1;
        let bb_h = max_y - min_y + 1;
        let layer_offset = (min_x as f32, min_y as f32);

        let line_mask = render_stroke_layer_parallel(
            &line.points,
            radius,
            feather,
            scale,
            crop_offset,
            layer_offset,
            bb_w,
            bb_h,
        );

        for y in 0..bb_h {
            for x in 0..bb_w {
                let src_val = line_mask.get_pixel(x, y)[0] as f32 / 255.0;
                if src_val <= 0.0 {
                    continue;
                }

                let abs_x = min_x + x;
                let abs_y = min_y + y;
                let dst_pixel = final_mask.get_pixel_mut(abs_x, abs_y);
                let dst_val = dst_pixel[0] as f32 / 255.0;

                let blended = if is_eraser {
                    dst_val * (1.0 - src_val)
                } else {
                    dst_val + src_val - dst_val * src_val
                };

                dst_pixel[0] = (blended.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
    }

    final_mask
}

pub fn generate_flow_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: FlowMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut final_mask = GrayImage::new(width, height);

    for line in &params.lines {
        if line.points.is_empty() {
            continue;
        }

        let is_eraser = line.tool == "eraser";
        let flow_per_stroke = (line.flow.clamp(0.0, 100.0) / 100.0) * 255.0;
        let radius = (line.brush_size * scale / 2.0).max(0.0);
        let feather = line.feather.clamp(0.0, 1.0);

        let Some((min_x, min_y, max_x, max_y)) =
            stroke_bounds(&line.points, width, height, radius, scale, crop_offset)
        else {
            continue;
        };

        let bb_w = max_x - min_x + 1;
        let bb_h = max_y - min_y + 1;
        let layer_offset = (min_x as f32, min_y as f32);

        let line_mask = render_stroke_layer_parallel(
            &line.points,
            radius,
            feather,
            scale,
            crop_offset,
            layer_offset,
            bb_w,
            bb_h,
        );

        for y in 0..bb_h {
            for x in 0..bb_w {
                let stroke_pixel = line_mask.get_pixel(x, y)[0] as f32;
                if stroke_pixel <= 0.0 {
                    continue;
                }

                let abs_x = min_x + x;
                let abs_y = min_y + y;
                let pixel = final_mask.get_pixel_mut(abs_x, abs_y);

                let c_norm = pixel[0] as f32 / 255.0;
                let delta = ((stroke_pixel / 255.0) * flow_per_stroke).round();
                let d_norm = (delta / 255.0).clamp(0.0, 1.0);

                let next = if is_eraser {
                    c_norm * (1.0 - d_norm)
                } else {
                    c_norm + d_norm - c_norm * d_norm
                };

                pixel[0] = (next.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
    }

    final_mask
}
