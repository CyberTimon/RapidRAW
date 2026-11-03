use crate::ai_processing::{
    AiDepthMaskParameters, AiForegroundMaskParameters, AiSkyMaskParameters, AiSubjectMaskParameters,
};
use base64::{Engine as _, engine::general_purpose};
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{
    DynamicImage, ExtendedColorType, GenericImageView, GrayImage, ImageEncoder, Luma, RgbImage,
};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::f32::consts::PI;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;

use crate::app_state::AppState;
use crate::image_processing::{apply_cpu_default_raw_processing, apply_geometry_warp};
use crate::{get_cached_full_warped_image, get_cached_full_warped_image_for_path};

const MASK_CACHE_LIMIT_BYTES: usize = 128 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub enum SubMaskMode {
    Additive,
    Subtractive,
    Intersect,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct SubMask {
    pub id: String,
    #[serde(rename = "type")]
    pub mask_type: String,
    pub visible: bool,
    #[serde(default)]
    pub invert: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub mode: SubMaskMode,
    pub parameters: Value,
}

fn default_opacity() -> f32 {
    100.0
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct MaskDefinition {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub invert: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub adjustments: Value,
    pub sub_masks: Vec<SubMask>,
}

impl MaskDefinition {
    pub fn requires_warped_image(&self) -> bool {
        self.sub_masks
            .iter()
            .any(|sm| matches!(sm.mask_type.as_str(), "color" | "luminance" | "match-brush"))
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct PatchData {
    pub color: String,
    pub mask: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct AiPatchDefinition {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub invert: bool,
    pub prompt: String,
    #[serde(default)]
    pub patch_data: Option<PatchData>,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub sub_masks: Vec<SubMask>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GrowFeatherParameters {
    #[serde(default)]
    grow: f32,
    #[serde(default)]
    feather: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct RadialMaskParameters {
    center_x: f64,
    center_y: f64,
    radius_x: f64,
    radius_y: f64,
    rotation: f32,
    feather: f32,
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
struct Point {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct BrushLine {
    tool: String,
    brush_size: f32,
    points: Vec<Point>,
    #[serde(default = "default_brush_feather")]
    feather: f32,
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ParametricMaskParameters {
    target_x: f64,
    target_y: f64,
    #[serde(default = "default_tolerance")]
    tolerance: f32,
    #[serde(default)]
    grow: f32,
    #[serde(default)]
    feather: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default)]
    flip_horizontal: bool,
    #[serde(default)]
    flip_vertical: bool,
    #[serde(default)]
    orientation_steps: u8,
}

fn default_tolerance() -> f32 {
    20.0
}

impl Default for ParametricMaskParameters {
    fn default() -> Self {
        Self {
            target_x: 0.0,
            target_y: 0.0,
            tolerance: default_tolerance(),
            grow: 0.0,
            feather: 35.0,
            rotation: 0.0,
            flip_horizontal: false,
            flip_vertical: false,
            orientation_steps: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct MatchBrushMaskParameters {
    #[serde(default)]
    lines: Vec<BrushLine>,
    #[serde(default = "default_match_brush_tolerance")]
    tolerance: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default)]
    flip_horizontal: bool,
    #[serde(default)]
    flip_vertical: bool,
    #[serde(default)]
    orientation_steps: u8,
}

fn default_match_brush_tolerance() -> f32 {
    30.0
}

const MATCH_BRUSH_ANALYSIS_SIZE: f32 = 2048.0;
const MATCH_BRUSH_SMOOTH_RADIUS: usize = 1;
const MATCH_BRUSH_TEXTURE_RADIUS: usize = 2;
const MATCH_BRUSH_REFINE_RADIUS: usize = 2;
const MATCH_BRUSH_REFINE_EPS: f32 = 1e-3;
const MATCH_BRUSH_CHROMA_WEIGHT: f32 = 1.5;
const MATCH_BRUSH_TEXTURE_WEIGHT: f32 = 2.0;
const MATCH_BRUSH_CORE_FRACTION: f32 = 0.1;
const MATCH_BRUSH_CORE_MAX: f32 = 12.0;
const MATCH_BRUSH_CORE_SIMILARITY: f32 = 0.04;
const MATCH_BRUSH_SPREAD_WEIGHT: f32 = 2.0;
const MATCH_BRUSH_SPREAD_LIMIT: f32 = 3.0;
const MATCH_BRUSH_KERNEL_EXTENT: f32 = 6.25;
const MATCH_BRUSH_MAX_TAPS: u32 = 6;

fn grayscale_dilate(image: &GrayImage, k: u8) -> GrayImage {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let w = width as usize;
    let h = height as usize;
    let r = k as i32;
    let src = image.as_raw();

    let mut temp = vec![0u8; w * h];
    let mut out = vec![0u8; w * h];

    temp.par_chunks_mut(w)
        .zip(src.par_chunks(w))
        .for_each(|(temp_row, src_row)| {
            for (x, slot) in temp_row.iter_mut().enumerate() {
                let mut max_val = 0;
                let start = (x as i32 - r).max(0) as usize;
                let end = (x as i32 + r).min((w - 1) as i32) as usize;
                for &value in &src_row[start..=end] {
                    max_val = max_val.max(value);
                }
                *slot = max_val;
            }
        });

    let r = r as usize;
    out.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let start = y.saturating_sub(r);
        let end = (y + r).min(h - 1);
        out_row.copy_from_slice(&temp[start * w..(start + 1) * w]);
        for yi in (start + 1)..=end {
            for (o, &t) in out_row.iter_mut().zip(&temp[yi * w..(yi + 1) * w]) {
                *o = (*o).max(t);
            }
        }
    });

    GrayImage::from_raw(width, height, out).unwrap()
}

fn grayscale_erode(image: &GrayImage, k: u8) -> GrayImage {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let w = width as usize;
    let h = height as usize;
    let r = k as i32;
    let src = image.as_raw();

    let mut temp = vec![0u8; w * h];
    let mut out = vec![0u8; w * h];

    temp.par_chunks_mut(w)
        .zip(src.par_chunks(w))
        .for_each(|(temp_row, src_row)| {
            for (x, slot) in temp_row.iter_mut().enumerate() {
                let mut min_val = 255;
                let start = (x as i32 - r).max(0) as usize;
                let end = (x as i32 + r).min((w - 1) as i32) as usize;
                for &value in &src_row[start..=end] {
                    min_val = min_val.min(value);
                }
                *slot = min_val;
            }
        });

    let r = r as usize;
    out.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let start = y.saturating_sub(r);
        let end = (y + r).min(h - 1);
        out_row.copy_from_slice(&temp[start * w..(start + 1) * w]);
        for yi in (start + 1)..=end {
            for (o, &t) in out_row.iter_mut().zip(&temp[yi * w..(yi + 1) * w]) {
                *o = (*o).min(t);
            }
        }
    });

    GrayImage::from_raw(width, height, out).unwrap()
}

fn apply_grow_and_feather(mask: &mut GrayImage, grow: f32, feather: f32, width: u32, height: u32) {
    let base_dimension = width.min(height) as f32;

    if grow.abs() > 0.01 {
        const MAX_GROW_PERCENTAGE: f32 = 0.01;
        let grow_pixels = (grow / 100.0) * base_dimension * MAX_GROW_PERCENTAGE;

        let amount = grow_pixels.abs().round() as u8;

        if amount > 0 {
            if grow_pixels > 0.0 {
                *mask = grayscale_dilate(mask, amount);
            } else {
                *mask = grayscale_erode(mask, amount);
            }
        }
    }

    if feather > 0.0 {
        const MAX_FEATHER_SIGMA_PERCENTAGE: f32 = 0.005;
        let sigma = (feather / 100.0) * base_dimension * MAX_FEATHER_SIGMA_PERCENTAGE;

        if sigma > 0.01 {
            *mask = imageproc::filter::gaussian_blur_f32(mask, sigma);
        }
    }
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

fn generate_radial_bitmap(
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

    for_each_mask_row(&mut mask, |y, row| {
        for (x, value) in row.iter_mut().enumerate() {
            let dx = x as f32 - center_x as f32;
            let dy = y as f32 - center_y as f32;

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

fn generate_linear_bitmap(
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

fn generate_brush_bitmap(
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

fn generate_flow_bitmap(
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

pub struct TransformParams {
    pub rotation: f32,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub orientation_steps: u8,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub crop_offset: (f32, f32),
}

fn generate_ai_bitmap_from_full_mask(
    full_mask_image: &GrayImage,
    tf: &TransformParams,
) -> GrayImage {
    transform_full_mask(full_mask_image, tf, false)
}

pub fn generate_edge_clamped_bitmap(full_map: &GrayImage, tf: &TransformParams) -> GrayImage {
    transform_full_mask(full_map, tf, true)
}

fn output_to_source(
    tf: &TransformParams,
    source_w: u32,
    source_h: u32,
) -> impl Fn(f32, f32) -> (f32, f32) + Sync {
    let angle_rad = tf.rotation.to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if tf.orientation_steps % 2 == 1 {
        (source_h, source_w)
    } else {
        (source_w, source_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * tf.scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * tf.scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    let (scale, crop_offset) = (tf.scale, tf.crop_offset);
    let (flip_horizontal, flip_vertical) = (tf.flip_horizontal, tf.flip_vertical);
    let orientation_steps = tf.orientation_steps;

    move |x_out: f32, y_out: f32| {
        let x_uncrop = x_out + crop_offset.0;
        let y_uncrop = y_out + crop_offset.1;

        let x_centered = x_uncrop - center_x;
        let y_centered = y_uncrop - center_y;

        let x_unrotated = x_centered * cos_a + y_centered * sin_a + center_x;
        let y_unrotated = -x_centered * sin_a + y_centered * cos_a + center_y;

        let x_unflipped = if flip_horizontal {
            scaled_coarse_rotated_w - x_unrotated
        } else {
            x_unrotated
        };
        let y_unflipped = if flip_vertical {
            scaled_coarse_rotated_h - y_unrotated
        } else {
            y_unrotated
        };

        let (x_unrotated_coarse, y_unrotated_coarse) = match orientation_steps {
            0 => (x_unflipped, y_unflipped),
            1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
            2 => (
                scaled_coarse_rotated_w - x_unflipped,
                scaled_coarse_rotated_h - y_unflipped,
            ),
            3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
            _ => (x_unflipped, y_unflipped),
        };

        (x_unrotated_coarse / scale, y_unrotated_coarse / scale)
    }
}

fn transform_full_mask(
    full_mask_image: &GrayImage,
    tf: &TransformParams,
    clamp_edges: bool,
) -> GrayImage {
    let (full_mask_w, full_mask_h) = full_mask_image.dimensions();
    let mut final_mask = GrayImage::new(tf.width, tf.height);

    let to_source = output_to_source(tf, full_mask_w, full_mask_h);

    let raw = full_mask_image.as_raw();
    let sample = |(x_src, y_src): (f32, f32)| {
        if clamp_edges
            || (x_src >= 0.0
                && x_src < full_mask_w as f32
                && y_src >= 0.0
                && y_src < full_mask_h as f32)
        {
            let x = (x_src.max(0.0) as usize).min(full_mask_w as usize - 1);
            let y = (y_src.max(0.0) as usize).min(full_mask_h as usize - 1);
            raw[y * full_mask_w as usize + x] as u32
        } else {
            0
        }
    };

    for_each_mask_row(&mut final_mask, |y_out, row| {
        for (x_out, value) in row.iter_mut().enumerate() {
            *value = sample(to_source(x_out as f32, y_out as f32)) as u8;
        }
    });

    let taps = (tf.scale.recip() - 1.0e-3).ceil().max(1.0) as u32;
    if taps == 1 {
        return final_mask;
    }

    let origin = to_source(0.0, 0.0);
    let step_x = to_source(1.0, 0.0);
    let step_y = to_source(0.0, 1.0);
    let (step_x, step_y) = (
        (step_x.0 - origin.0, step_x.1 - origin.1),
        (step_y.0 - origin.0, step_y.1 - origin.1),
    );
    let offsets: Vec<(f32, f32)> = (0..taps * taps)
        .map(|k| {
            let u = ((k % taps) as f32 + 0.5) / taps as f32;
            let v = ((k / taps) as f32 + 0.5) / taps as f32;
            (u * step_x.0 + v * step_y.0, u * step_x.1 + v * step_y.1)
        })
        .collect();
    let count = taps * taps;

    let nearest = final_mask.clone();
    let (width, height) = (tf.width as usize, tf.height as usize);
    let near = nearest.as_raw();
    for_each_mask_row(&mut final_mask, |y_out, row| {
        let y = y_out as usize;
        for (x, value) in row.iter_mut().enumerate() {
            let v = *value;
            let at = |nx: usize, ny: usize| near[ny * width + nx];
            let edge = (v != 0 && v != 255)
                || (x > 0 && at(x - 1, y) != v)
                || (x + 1 < width && at(x + 1, y) != v)
                || (y > 0 && at(x, y - 1) != v)
                || (y + 1 < height && at(x, y + 1) != v);
            if edge {
                let corner = to_source(x as f32, y_out as f32);
                let sum: u32 = offsets
                    .iter()
                    .map(|&(dx, dy)| sample((corner.0 + dx, corner.1 + dy)))
                    .sum();
                *value = ((sum + count / 2) / count) as u8;
            }
        }
    });

    final_mask
}

pub fn generate_ai_bitmap_from_base64(data_url: &str, tf: &TransformParams) -> Option<GrayImage> {
    let b64_data = if let Some(idx) = data_url.find(',') {
        &data_url[idx + 1..]
    } else {
        data_url
    };

    let decoded_bytes = general_purpose::STANDARD.decode(b64_data).ok()?;
    let full_mask_image = image::load_from_memory(&decoded_bytes).ok()?.to_luma8();

    Some(generate_ai_bitmap_from_full_mask(&full_mask_image, tf))
}

fn generate_ai_sky_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiSkyMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let tf = TransformParams {
        rotation: params.rotation.unwrap_or(0.0),
        flip_horizontal: params.flip_horizontal.unwrap_or(false),
        flip_vertical: params.flip_vertical.unwrap_or(false),
        orientation_steps: params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    };
    let mut mask = generate_ai_bitmap_from_base64(&data_url, &tf)?;

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_ai_depth_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiDepthMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let tf = TransformParams {
        rotation: params.rotation.unwrap_or(0.0),
        flip_horizontal: params.flip_horizontal.unwrap_or(false),
        flip_vertical: params.flip_vertical.unwrap_or(false),
        orientation_steps: params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    };

    let depth_map = generate_ai_bitmap_from_base64(&data_url, &tf)?;

    let (w, h) = depth_map.dimensions();

    fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
        let t = ((x - edge0) / (edge1 - edge0).max(0.0001)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    let min_fade = params.min_fade;
    let max_fade = params.max_fade;

    let data: Vec<u8> = depth_map
        .as_raw()
        .par_iter()
        .map(|&p| {
            let val_pct = (p as f32 / 255.0) * 100.0;

            let lower_bound = smoothstep(params.min_depth - min_fade, params.min_depth, val_pct);
            let upper_bound =
                1.0 - smoothstep(params.max_depth, params.max_depth + max_fade, val_pct);
            let bandpass_weight = lower_bound * upper_bound;

            let depth_intensity = val_pct / 100.0;
            let final_intensity = bandpass_weight * depth_intensity;

            (final_intensity * 255.0) as u8
        })
        .collect();
    let mut mask = GrayImage::from_raw(w, h, data)?;

    if params.feather > 0.0 {
        mask = image::imageops::blur(&mask, params.feather * 0.1);
    }

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_ai_foreground_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiForegroundMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let tf = TransformParams {
        rotation: params.rotation.unwrap_or(0.0),
        flip_horizontal: params.flip_horizontal.unwrap_or(false),
        flip_vertical: params.flip_vertical.unwrap_or(false),
        orientation_steps: params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    };
    let mut mask = generate_ai_bitmap_from_base64(&data_url, &tf)?;

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_ai_subject_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiSubjectMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let tf = TransformParams {
        rotation: params.rotation.unwrap_or(0.0),
        flip_horizontal: params.flip_horizontal.unwrap_or(false),
        flip_vertical: params.flip_vertical.unwrap_or(false),
        orientation_steps: params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    };
    let mut mask = generate_ai_bitmap_from_base64(&data_url, &tf)?;

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_color_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&image::DynamicImage>,
) -> Option<GrayImage> {
    let params: ParametricMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let warped = warped_image?;
    let (full_w, full_h) = warped.dimensions();

    let target_x = params.target_x.round() as i32;
    let target_y = params.target_y.round() as i32;
    if target_x < 0 || target_y < 0 || target_x >= full_w as i32 || target_y >= full_h as i32 {
        return None;
    }

    let ref_pixel = warped.get_pixel(target_x as u32, target_y as u32);
    let ref_r = ref_pixel[0] as f32;
    let ref_g = ref_pixel[1] as f32;
    let ref_b = ref_pixel[2] as f32;

    let mut mask = GrayImage::new(width, height);

    let angle_rad = params.rotation * PI / 180.0;
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if params.orientation_steps % 2 == 1 {
        (full_h, full_w)
    } else {
        (full_w, full_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    let tolerance_sq = (params.tolerance * 2.55).max(1.0).powi(2) * 3.0;
    let inv_scale = 1.0 / scale;

    for_each_mask_row(&mut mask, |y_out, row| {
        let y_uncrop = y_out as f32 + crop_offset.1;
        let y_centered = y_uncrop - center_y;
        let y_sin = y_centered * sin_a;
        let y_cos = y_centered * cos_a;

        for (x_out, value) in row.iter_mut().enumerate() {
            let x_uncrop = x_out as f32 + crop_offset.0;
            let x_centered = x_uncrop - center_x;

            let x_unrotated = x_centered * cos_a + y_sin + center_x;
            let y_unrotated = -x_centered * sin_a + y_cos + center_y;

            let x_unflipped = if params.flip_horizontal {
                scaled_coarse_rotated_w - x_unrotated
            } else {
                x_unrotated
            };
            let y_unflipped = if params.flip_vertical {
                scaled_coarse_rotated_h - y_unrotated
            } else {
                y_unrotated
            };

            let (x_unrotated_coarse, y_unrotated_coarse) = match params.orientation_steps {
                0 => (x_unflipped, y_unflipped),
                1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
                2 => (
                    scaled_coarse_rotated_w - x_unflipped,
                    scaled_coarse_rotated_h - y_unflipped,
                ),
                3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
                _ => (x_unflipped, y_unflipped),
            };

            if x_unrotated_coarse >= 0.0 && y_unrotated_coarse >= 0.0 {
                let x_src = (x_unrotated_coarse * inv_scale) as u32;
                let y_src = (y_unrotated_coarse * inv_scale) as u32;

                if x_src < full_w && y_src < full_h {
                    let pixel = warped.get_pixel(x_src, y_src);
                    let dist_sq = (pixel[0] as f32 - ref_r).powi(2)
                        + (pixel[1] as f32 - ref_g).powi(2)
                        + (pixel[2] as f32 - ref_b).powi(2);

                    if dist_sq <= tolerance_sq {
                        let intensity = 1.0 - (dist_sq.sqrt() / tolerance_sq.sqrt());
                        *value = (intensity * 255.0) as u8;
                    }
                }
            }
        }
    });

    apply_grow_and_feather(&mut mask, params.grow, params.feather, width, height);
    Some(mask)
}

fn generate_luminance_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&image::DynamicImage>,
) -> Option<GrayImage> {
    let params: ParametricMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let warped = warped_image?;
    let (full_w, full_h) = warped.dimensions();

    let target_x = params.target_x.round() as i32;
    let target_y = params.target_y.round() as i32;
    if target_x < 0 || target_y < 0 || target_x >= full_w as i32 || target_y >= full_h as i32 {
        return None;
    }

    let ref_pixel = warped.get_pixel(target_x as u32, target_y as u32);
    let ref_luma =
        0.299 * ref_pixel[0] as f32 + 0.587 * ref_pixel[1] as f32 + 0.114 * ref_pixel[2] as f32;

    let mut mask = GrayImage::new(width, height);

    let angle_rad = params.rotation * PI / 180.0;
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if params.orientation_steps % 2 == 1 {
        (full_h, full_w)
    } else {
        (full_w, full_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    let tolerance_val = (params.tolerance * 2.55).max(1.0);
    let inv_scale = 1.0 / scale;

    for_each_mask_row(&mut mask, |y_out, row| {
        let y_uncrop = y_out as f32 + crop_offset.1;
        let y_centered = y_uncrop - center_y;
        let y_sin = y_centered * sin_a;
        let y_cos = y_centered * cos_a;

        for (x_out, value) in row.iter_mut().enumerate() {
            let x_uncrop = x_out as f32 + crop_offset.0;
            let x_centered = x_uncrop - center_x;

            let x_unrotated = x_centered * cos_a + y_sin + center_x;
            let y_unrotated = -x_centered * sin_a + y_cos + center_y;

            let x_unflipped = if params.flip_horizontal {
                scaled_coarse_rotated_w - x_unrotated
            } else {
                x_unrotated
            };
            let y_unflipped = if params.flip_vertical {
                scaled_coarse_rotated_h - y_unrotated
            } else {
                y_unrotated
            };

            let (x_unrotated_coarse, y_unrotated_coarse) = match params.orientation_steps {
                0 => (x_unflipped, y_unflipped),
                1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
                2 => (
                    scaled_coarse_rotated_w - x_unflipped,
                    scaled_coarse_rotated_h - y_unflipped,
                ),
                3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
                _ => (x_unflipped, y_unflipped),
            };

            if x_unrotated_coarse >= 0.0 && y_unrotated_coarse >= 0.0 {
                let x_src = (x_unrotated_coarse * inv_scale) as u32;
                let y_src = (y_unrotated_coarse * inv_scale) as u32;

                if x_src < full_w && y_src < full_h {
                    let pixel = warped.get_pixel(x_src, y_src);
                    let luma =
                        0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32;
                    let dist = (luma - ref_luma).abs();

                    if dist <= tolerance_val {
                        let intensity = 1.0 - (dist / tolerance_val);
                        *value = (intensity * 255.0) as u8;
                    }
                }
            }
        }
    });

    apply_grow_and_feather(&mut mask, params.grow, params.feather, width, height);
    Some(mask)
}

struct MatchBrushAnalysis {
    key: u64,
    factor: u32,
    width: usize,
    height: usize,
    guide: RgbImage,
    features: Vec<[f32; 4]>,
}

static MATCH_BRUSH_ANALYSIS: Mutex<Option<Arc<MatchBrushAnalysis>>> = Mutex::new(None);

struct MatchBrushStroke {
    erase: bool,
    radius: f32,
    feather: f32,
    dabs: Vec<(f32, f32)>,
}

struct MatchBrushDab {
    x: f32,
    y: f32,
    reference: [f32; 4],
    inverse_spread: [f32; 4],
    left: usize,
    right: usize,
    top: usize,
    bottom: usize,
}

fn match_brush_dabs(points: &[(f32, f32)], spacing: f32) -> Vec<(f32, f32)> {
    let mut dabs = vec![points[0]];
    let mut travelled = 0.0;
    for pair in points.windows(2) {
        let (dx, dy) = (pair[1].0 - pair[0].0, pair[1].1 - pair[0].1);
        let length = (dx * dx + dy * dy).sqrt();
        let mut t = spacing - travelled;
        while t <= length {
            dabs.push((pair[0].0 + dx * t / length, pair[0].1 + dy * t / length));
            t += spacing;
        }
        travelled = length - (t - spacing);
    }
    dabs
}

fn linear_to_oklab([r, g, b]: [f32; 3]) -> [f32; 3] {
    let l = (0.412_221_5 * r + 0.536_332_5 * g + 0.051_446 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_397 * b).cbrt();
    let s = (0.088_302_5 * r + 0.281_718_8 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_3 * l + 0.793_617_8 * m - 0.004_072 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904 * l + 0.782_771_8 * m - 0.808_675_8 * s,
    ]
}

fn match_brush_analysis_key(source: &RgbImage) -> u64 {
    let (width, height) = source.dimensions();
    let mut hasher = DefaultHasher::new();
    (width, height).hash(&mut hasher);
    for j in 0..128u64 {
        let y = (j * (height as u64 - 1) / 127) as u32;
        for i in 0..128u64 {
            let x = (i * (width as u64 - 1) / 127) as u32;
            source.get_pixel(x, y).0.hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn match_brush_analysis(source: &RgbImage) -> Arc<MatchBrushAnalysis> {
    let key = match_brush_analysis_key(source);
    let cached = MATCH_BRUSH_ANALYSIS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|analysis| analysis.key == key)
        .cloned();
    if let Some(analysis) = cached {
        return analysis;
    }
    let analysis = Arc::new(build_match_brush_analysis(source, key));
    *MATCH_BRUSH_ANALYSIS
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(analysis.clone());
    analysis
}

fn build_match_brush_analysis(source: &RgbImage, key: u64) -> MatchBrushAnalysis {
    let (full_w, full_h) = source.dimensions();
    let factor = (full_w.max(full_h) as f32 / MATCH_BRUSH_ANALYSIS_SIZE)
        .ceil()
        .max(1.0) as u32;
    let width = full_w.div_ceil(factor) as usize;
    let height = full_h.div_ceil(factor) as usize;

    let linear_lut: [f32; 256] = std::array::from_fn(|i| {
        let c = i as f32 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    });
    let raw = source.as_raw();
    let stride = full_w as usize * 3;
    let block = factor as usize;
    let mut guide = RgbImage::new(width as u32, height as u32);
    let mut lab = vec![[0.0_f32; 3]; width * height];
    guide
        .par_chunks_mut(width * 3)
        .zip(lab.par_chunks_mut(width))
        .enumerate()
        .for_each(|(j, (guide_row, lab_row))| {
            let sy0 = j * block;
            let sy1 = (sy0 + block).min(full_h as usize);
            for (i, (guide_pixel, lab_pixel)) in guide_row
                .as_chunks_mut::<3>()
                .0
                .iter_mut()
                .zip(lab_row.iter_mut())
                .enumerate()
            {
                let sx0 = i * block;
                let sx1 = (sx0 + block).min(full_w as usize);
                let mut srgb_sum = [0u32; 3];
                let mut linear_sum = [0.0_f32; 3];
                for row in raw[sy0 * stride..sy1 * stride].chunks_exact(stride) {
                    for pixel in row[sx0 * 3..sx1 * 3].as_chunks::<3>().0 {
                        for ((sum, linear), &value) in
                            srgb_sum.iter_mut().zip(linear_sum.iter_mut()).zip(pixel)
                        {
                            *sum += value as u32;
                            *linear += linear_lut[value as usize];
                        }
                    }
                }
                let count = ((sy1 - sy0) * (sx1 - sx0)) as u32;
                for (out, sum) in guide_pixel.iter_mut().zip(srgb_sum) {
                    *out = ((sum + count / 2) / count) as u8;
                }
                *lab_pixel = linear_to_oklab(linear_sum.map(|v| v / count as f32));
            }
        });

    let box_mean =
        |values: &[f32], radius: usize| crate::touch_up::box_mean(values, width, height, radius);
    let channel = |c: usize| lab.iter().map(|p| p[c]).collect::<Vec<f32>>();
    let lightness = channel(0);
    let smooth_l = box_mean(&lightness, MATCH_BRUSH_SMOOTH_RADIUS);
    let smooth_a = box_mean(&channel(1), MATCH_BRUSH_SMOOTH_RADIUS);
    let smooth_b = box_mean(&channel(2), MATCH_BRUSH_SMOOTH_RADIUS);
    drop(lab);
    let local_mean = box_mean(&lightness, MATCH_BRUSH_TEXTURE_RADIUS);
    let squares: Vec<f32> = lightness.iter().map(|v| v * v).collect();
    let local_mean_sq = box_mean(&squares, MATCH_BRUSH_TEXTURE_RADIUS);
    let features = (0..width * height)
        .into_par_iter()
        .map(|k| {
            let texture = (local_mean_sq[k] - local_mean[k] * local_mean[k])
                .max(0.0)
                .sqrt();
            [
                smooth_l[k],
                smooth_a[k] * MATCH_BRUSH_CHROMA_WEIGHT,
                smooth_b[k] * MATCH_BRUSH_CHROMA_WEIGHT,
                texture * MATCH_BRUSH_TEXTURE_WEIGHT,
            ]
        })
        .collect();

    MatchBrushAnalysis {
        key,
        factor,
        width,
        height,
        guide,
        features,
    }
}

fn match_brush_reference(
    analysis: &MatchBrushAnalysis,
    x: f32,
    y: f32,
    radius: f32,
    sigma_sq: f32,
) -> ([f32; 4], [f32; 4]) {
    let (width, height) = (analysis.width, analysis.height);
    let core = (radius * MATCH_BRUSH_CORE_FRACTION).clamp(1.0, MATCH_BRUSH_CORE_MAX);
    let center_x = (x.round().max(0.0) as usize).min(width - 1);
    let center_y = (y.round().max(0.0) as usize).min(height - 1);
    let center = analysis.features[center_y * width + center_x];
    let inv_similarity = 1.0 / (2.0 * MATCH_BRUSH_CORE_SIMILARITY * MATCH_BRUSH_CORE_SIMILARITY);
    let reach = core.ceil() as usize;

    let mut total = 0.0;
    let mut sum = [0.0_f32; 4];
    let mut sum_sq = [0.0_f32; 4];
    for j in center_y.saturating_sub(reach)..=(center_y + reach).min(height - 1) {
        let row = &analysis.features[j * width..(j + 1) * width];
        for (i, feature) in row
            .iter()
            .enumerate()
            .take((center_x + reach).min(width - 1) + 1)
            .skip(center_x.saturating_sub(reach))
        {
            let (dx, dy) = (i as f32 - x, j as f32 - y);
            let spatial = 1.0 - (dx * dx + dy * dy) / (core * core);
            if spatial <= 0.0 {
                continue;
            }
            let difference_sq: f32 = feature
                .iter()
                .zip(center)
                .map(|(a, b)| (a - b) * (a - b))
                .sum();
            let weight = spatial * (-difference_sq * inv_similarity).exp();
            total += weight;
            for ((s, sq), &v) in sum.iter_mut().zip(sum_sq.iter_mut()).zip(feature) {
                *s += weight * v;
                *sq += weight * v * v;
            }
        }
    }

    if total <= 0.0 {
        return (center, [1.0 / sigma_sq; 4]);
    }
    let mean = sum.map(|s| s / total);
    let inverse_spread = std::array::from_fn(|c| {
        let variance = (sum_sq[c] / total - mean[c] * mean[c]).max(0.0);
        1.0 / (sigma_sq
            + (MATCH_BRUSH_SPREAD_WEIGHT * variance).min(MATCH_BRUSH_SPREAD_LIMIT * sigma_sq))
    });
    (mean, inverse_spread)
}

fn generate_match_brush_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    let params: MatchBrushMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let warped = warped_image?;
    let converted;
    let source = match warped.as_rgb8() {
        Some(rgb) => rgb,
        None => {
            converted = warped.to_rgb8();
            &converted
        }
    };
    let (full_w, full_h) = source.dimensions();
    let mut mask = GrayImage::new(width, height);
    if full_w == 0 || full_h == 0 || width == 0 || height == 0 {
        return Some(mask);
    }

    let analysis = match_brush_analysis(source);
    let (analysis_w, analysis_h) = (analysis.width, analysis.height);
    let factor = analysis.factor as f32;
    let block_center = (factor - 1.0) / 2.0;
    let to_analysis =
        |(x, y): (f32, f32)| ((x - block_center) / factor, (y - block_center) / factor);

    let transform = |width, height, scale, crop_offset| TransformParams {
        rotation: params.rotation,
        flip_horizontal: params.flip_horizontal,
        flip_vertical: params.flip_vertical,
        orientation_steps: params.orientation_steps,
        width,
        height,
        scale,
        crop_offset,
    };

    let image_tf = transform(0, 0, 1.0, (0.0, 0.0));
    let image_to_source = output_to_source(&image_tf, full_w, full_h);
    let strokes: Vec<MatchBrushStroke> = params
        .lines
        .iter()
        .filter_map(|line| {
            let radius = line.brush_size / 2.0 / factor;
            if line.points.is_empty() || radius <= 0.0 {
                return None;
            }
            let points: Vec<(f32, f32)> = line
                .points
                .iter()
                .map(|p| to_analysis(image_to_source(p.x as f32, p.y as f32)))
                .collect();
            let dabs: Vec<(f32, f32)> = match_brush_dabs(&points, (radius * 0.25).max(0.5))
                .into_iter()
                .filter(|&(x, y)| {
                    x >= -0.5
                        && y >= -0.5
                        && x < analysis_w as f32 - 0.5
                        && y < analysis_h as f32 - 0.5
                })
                .collect();
            (!dabs.is_empty()).then_some(MatchBrushStroke {
                erase: line.tool == "eraser",
                radius,
                feather: line.feather.clamp(0.0, 1.0),
                dabs,
            })
        })
        .collect();
    if strokes.is_empty() {
        return Some(mask);
    }

    let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
    let (mut max_x, mut max_y) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for stroke in &strokes {
        for &(x, y) in &stroke.dabs {
            min_x = min_x.min(x - stroke.radius);
            min_y = min_y.min(y - stroke.radius);
            max_x = max_x.max(x + stroke.radius);
            max_y = max_y.max(y + stroke.radius);
        }
    }
    let margin = (2 * MATCH_BRUSH_REFINE_RADIUS + 1) as f32;
    let left = (min_x - margin).floor().max(0.0) as usize;
    let top = (min_y - margin).floor().max(0.0) as usize;
    let right = ((max_x + margin).ceil().max(0.0) as usize).min(analysis_w - 1);
    let bottom = ((max_y + margin).ceil().max(0.0) as usize).min(analysis_h - 1);
    let (region_w, region_h) = (right - left + 1, bottom - top + 1);

    let tolerance = params.tolerance.clamp(1.0, 100.0) / 100.0;
    let sigma = 0.015 + tolerance * tolerance * 0.35;
    let sigma_sq = sigma * sigma;
    let mut selection = vec![0.0_f32; region_w * region_h];

    for stroke in &strokes {
        let radius_sq = stroke.radius * stroke.radius;
        let inner_radius = stroke.radius * (1.0 - stroke.feather);
        let feather_range = (stroke.radius - inner_radius).max(0.01);
        let dabs: Vec<MatchBrushDab> = stroke
            .dabs
            .iter()
            .map(|&(x, y)| {
                let (reference, inverse_spread) =
                    match_brush_reference(&analysis, x, y, stroke.radius, sigma_sq);
                let (x, y) = (x - left as f32, y - top as f32);
                MatchBrushDab {
                    x,
                    y,
                    reference,
                    inverse_spread,
                    left: (x - stroke.radius).floor().max(0.0) as usize,
                    right: ((x + stroke.radius).ceil().max(0.0) as usize).min(region_w - 1),
                    top: (y - stroke.radius).floor().max(0.0) as usize,
                    bottom: ((y + stroke.radius).ceil().max(0.0) as usize).min(region_h - 1),
                }
            })
            .collect();

        selection
            .par_chunks_mut(region_w)
            .enumerate()
            .for_each(|(j, row)| {
                let mut coverage: Vec<f32> = Vec::new();
                let start = (top + j) * analysis_w + left;
                let features = &analysis.features[start..start + region_w];
                for dab in dabs.iter().filter(|d| (d.top..=d.bottom).contains(&j)) {
                    if coverage.is_empty() {
                        coverage.resize(region_w, 0.0);
                    }
                    let dy = j as f32 - dab.y;
                    for (i, (covered, feature)) in coverage[dab.left..=dab.right]
                        .iter_mut()
                        .zip(&features[dab.left..=dab.right])
                        .enumerate()
                    {
                        let dx = (dab.left + i) as f32 - dab.x;
                        let dist_sq = dx * dx + dy * dy;
                        if dist_sq > radius_sq {
                            continue;
                        }
                        let dist = dist_sq.sqrt();
                        let falloff = if dist <= inner_radius {
                            1.0
                        } else {
                            let t = ((dist - inner_radius) / feather_range).clamp(0.0, 1.0);
                            1.0 - t * t * (3.0 - 2.0 * t)
                        };
                        if falloff <= *covered {
                            continue;
                        }
                        let distance_sq: f32 = feature
                            .iter()
                            .zip(dab.reference)
                            .zip(dab.inverse_spread)
                            .map(|((a, b), inverse)| (a - b) * (a - b) * inverse)
                            .sum();
                        let similarity = (1.0 - distance_sq / MATCH_BRUSH_KERNEL_EXTENT)
                            .max(0.0)
                            .powi(3);
                        *covered = covered.max(falloff * similarity);
                    }
                }
                for (value, &weight) in row.iter_mut().zip(&coverage) {
                    *value = if stroke.erase {
                        *value * (1.0 - weight)
                    } else {
                        *value + weight - *value * weight
                    };
                }
            });
    }

    let selection_mask = GrayImage::from_raw(
        region_w as u32,
        region_h as u32,
        selection
            .iter()
            .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
            .collect(),
    )?;
    let region_guide = image::imageops::crop_imm(
        &analysis.guide,
        left as u32,
        top as u32,
        region_w as u32,
        region_h as u32,
    )
    .to_image();
    let coefficients = crate::ai_processing::color_guided_coefficients(
        &region_guide,
        &selection_mask,
        MATCH_BRUSH_REFINE_RADIUS,
        MATCH_BRUSH_REFINE_EPS,
    );
    let coefficient = |values: &[f32], x: i64, y: i64| {
        if x < 0 || y < 0 || x >= region_w as i64 || y >= region_h as i64 {
            0.0
        } else {
            values[y as usize * region_w + x as usize]
        }
    };

    let output_tf = transform(width, height, scale, crop_offset);
    let to_source = output_to_source(&output_tf, full_w, full_h);
    let origin = to_source(0.0, 0.0);
    let along_x = to_source(1.0, 0.0);
    let along_y = to_source(0.0, 1.0);
    let step_x = (along_x.0 - origin.0, along_x.1 - origin.1);
    let step_y = (along_y.0 - origin.0, along_y.1 - origin.1);
    let taps = ((scale.recip() - 1.0e-3).ceil().max(1.0) as u32).min(MATCH_BRUSH_MAX_TAPS);
    let offsets: Vec<(f32, f32)> = (0..taps * taps)
        .map(|k| {
            let u = ((k % taps) as f32 + 0.5) / taps as f32 - 0.5;
            let v = ((k / taps) as f32 + 0.5) / taps as f32 - 0.5;
            (u * step_x.0 + v * step_y.0, u * step_x.1 + v * step_y.1)
        })
        .collect();

    let raw = source.as_raw();
    let (source_w, source_h) = (full_w as usize, full_h as usize);
    let pixel = |x: usize, y: usize| {
        let k = (y * source_w + x) * 3;
        [raw[k] as f32, raw[k + 1] as f32, raw[k + 2] as f32]
    };
    let guide_color = |sx: f32, sy: f32| -> [f32; 3] {
        if taps == 1 {
            let x = sx.clamp(0.0, (source_w - 1) as f32);
            let y = sy.clamp(0.0, (source_h - 1) as f32);
            let (x0, y0) = (x.floor() as usize, y.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(source_w - 1), (y0 + 1).min(source_h - 1));
            let (tx, ty) = (x - x0 as f32, y - y0 as f32);
            let (p00, p10) = (pixel(x0, y0), pixel(x1, y0));
            let (p01, p11) = (pixel(x0, y1), pixel(x1, y1));
            std::array::from_fn(|c| {
                let upper = p00[c] * (1.0 - tx) + p10[c] * tx;
                let lower = p01[c] * (1.0 - tx) + p11[c] * tx;
                (upper * (1.0 - ty) + lower * ty) / 255.0
            })
        } else {
            let mut sum = [0.0_f32; 3];
            for &(dx, dy) in &offsets {
                let x = ((sx + dx).round().max(0.0) as usize).min(source_w - 1);
                let y = ((sy + dy).round().max(0.0) as usize).min(source_h - 1);
                for (s, v) in sum.iter_mut().zip(pixel(x, y)) {
                    *s += v;
                }
            }
            sum.map(|s| s / (255.0 * offsets.len() as f32))
        }
    };

    for_each_mask_row(&mut mask, |y_out, row| {
        for (x_out, value) in row.iter_mut().enumerate() {
            let (sx, sy) = to_source(x_out as f32, y_out as f32);
            let (ax, ay) = to_analysis((sx, sy));
            let (ax, ay) = (ax - left as f32, ay - top as f32);
            if ax <= -1.0 || ay <= -1.0 || ax >= region_w as f32 || ay >= region_h as f32 {
                continue;
            }
            let (x0, y0) = (ax.floor(), ay.floor());
            let (tx, ty) = (ax - x0, ay - y0);
            let (x0, y0) = (x0 as i64, y0 as i64);
            let sample = |values: &[f32]| {
                let upper =
                    coefficient(values, x0, y0) * (1.0 - tx) + coefficient(values, x0 + 1, y0) * tx;
                let lower = coefficient(values, x0, y0 + 1) * (1.0 - tx)
                    + coefficient(values, x0 + 1, y0 + 1) * tx;
                upper * (1.0 - ty) + lower * ty
            };
            let [a0, a1, a2, b] = [0, 1, 2, 3].map(|c| sample(&coefficients[c]));
            if a0.abs() + a1.abs() + a2.abs() + b.abs() < 0.5 / 255.0 {
                continue;
            }
            let [r, g, bl] = guide_color(sx, sy);
            let q = a0 * r + a1 * g + a2 * bl + b;
            *value = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    });

    Some(mask)
}

fn for_each_mask_row(mask: &mut GrayImage, fill_row: impl Fn(u32, &mut [u8]) + Sync) {
    let width = mask.width() as usize;
    if width == 0 {
        return;
    }
    mask.par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| fill_row(y as u32, row));
}

fn generate_all_bitmap(width: u32, height: u32) -> GrayImage {
    GrayImage::from_pixel(width, height, Luma([255]))
}

fn generate_sub_mask_bitmap(
    sub_mask: &SubMask,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    if !sub_mask.visible {
        return None;
    }

    match sub_mask.mask_type.as_str() {
        "radial" => Some(generate_radial_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "linear" => Some(generate_linear_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "brush" | "clone" | "heal" | "liquify" | "retouch" => Some(generate_brush_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "flow" => Some(generate_flow_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "color" => generate_color_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "luminance" => generate_luminance_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "match-brush" => generate_match_brush_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "ai-subject" => {
            generate_ai_subject_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-foreground" => {
            generate_ai_foreground_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-sky" | "ai-text" | "ai-face" => {
            generate_ai_sky_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-depth" => {
            generate_ai_depth_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "quick-eraser" => {
            generate_ai_subject_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "all" => Some(generate_all_bitmap(width, height)),
        _ => None,
    }
}

pub fn generate_mask_bitmap(
    mask_def: &MaskDefinition,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    if !mask_def.visible || mask_def.sub_masks.is_empty() {
        return None;
    }

    let mut final_mask = GrayImage::new(width, height);

    for sub_mask in &mask_def.sub_masks {
        if let Some(mut sub_bitmap) =
            generate_sub_mask_bitmap(sub_mask, width, height, scale, crop_offset, warped_image)
        {
            let invert = sub_mask.invert;
            let opacity_multiplier = (sub_mask.opacity / 100.0).clamp(0.0, 1.0);
            let mode = sub_mask.mode;

            final_mask
                .par_iter_mut()
                .zip(sub_bitmap.par_iter_mut())
                .for_each(|(pixel, sub_pixel)| {
                    if invert {
                        *sub_pixel = 255 - *sub_pixel;
                    }
                    if opacity_multiplier < 1.0 {
                        *sub_pixel = (*sub_pixel as f32 * opacity_multiplier) as u8;
                    }
                    *pixel = match mode {
                        SubMaskMode::Additive => (*pixel).max(*sub_pixel),
                        SubMaskMode::Subtractive => pixel.saturating_sub(*sub_pixel),
                        SubMaskMode::Intersect => (*pixel).min(*sub_pixel),
                    };
                });
        }
    }

    let invert = mask_def.invert;
    let opacity_multiplier = (mask_def.opacity / 100.0).clamp(0.0, 1.0);
    if invert || opacity_multiplier < 1.0 {
        final_mask.par_iter_mut().for_each(|pixel| {
            if invert {
                *pixel = 255 - *pixel;
            }
            if opacity_multiplier < 1.0 {
                *pixel = (*pixel as f32 * opacity_multiplier) as u8;
            }
        });
    }

    Some(final_mask)
}

#[tauri::command(async)]
pub fn generate_mask_overlay(
    mut mask_def: serde_json::Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    mut js_adjustments: Option<serde_json::Value>,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    if let Some(ref mut adj) = js_adjustments {
        crate::adjustment_utils::hydrate_adjustments(&state, adj);
    }

    if let Some(sub_masks) = mask_def.get_mut("subMasks").and_then(|v| v.as_array_mut()) {
        let mut cache = state.patch_cache.lock().unwrap_or_else(|e| e.into_inner());
        crate::adjustment_utils::hydrate_sub_masks(sub_masks, &mut cache);
    }

    let parsed_mask_def: MaskDefinition = serde_json::from_value(mask_def)
        .map_err(|e| format!("Failed to parse hydrated mask_def: {}", e))?;

    let scaled_crop_offset = (crop_offset.0 * scale, crop_offset.1 * scale);

    let warped_image = js_adjustments.as_ref().and_then(|adj| {
        resolve_warped_image_for_masks(&state, adj, std::slice::from_ref(&parsed_mask_def))
    });

    if let Some(gray_mask) = generate_mask_bitmap(
        &parsed_mask_def,
        width,
        height,
        scale,
        scaled_crop_offset,
        warped_image.as_deref(),
    ) {
        let rgba_mask: Vec<u8> = gray_mask
            .as_raw()
            .par_iter()
            .flat_map_iter(|&intensity| [255, 0, 0, (intensity as f32 * 0.5) as u8])
            .collect();

        let mut buf = Vec::new();
        PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, PngFilterType::Adaptive)
            .write_image(&rgba_mask, width, height, ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;

        Ok(Response::new(buf))
    } else {
        Ok(Response::new(Vec::new()))
    }
}

pub fn resolve_warped_image_for_masks(
    state: &tauri::State<AppState>,
    adjustments: &serde_json::Value,
    masks: &[MaskDefinition],
) -> Option<Arc<DynamicImage>> {
    if masks.iter().any(|m| m.requires_warped_image()) {
        get_cached_full_warped_image(state, adjustments).ok()
    } else {
        None
    }
}

fn build_full_source_image(base_image: &DynamicImage, is_raw: bool) -> Cow<'_, DynamicImage> {
    let mut image = Cow::Borrowed(base_image);
    if is_raw {
        apply_cpu_default_raw_processing(image.to_mut());
    }
    image
}

pub fn build_converted_source_image<'a>(
    base_image: &'a DynamicImage,
    is_raw: bool,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let mut image = crate::negative_conversion::apply_negative_conversion(
        Cow::Borrowed(base_image),
        adjustments,
    );
    if crate::negative_conversion::effective_is_raw(is_raw, adjustments) {
        apply_cpu_default_raw_processing(image.to_mut());
    }
    image
}

pub fn build_full_warped_image<'a>(
    base_image: &'a DynamicImage,
    is_raw: bool,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    apply_geometry_warp(build_full_source_image(base_image, is_raw), adjustments)
}

pub fn build_full_warped_image_rgb8(
    base_image: &DynamicImage,
    is_raw: bool,
    adjustments: &serde_json::Value,
) -> DynamicImage {
    let warped = build_full_warped_image(base_image, is_raw, adjustments);
    let rgb8 = match warped.as_rgb32f() {
        Some(buffer) => {
            let data: Vec<u8> = buffer
                .as_raw()
                .par_iter()
                .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect();
            image::RgbImage::from_raw(buffer.width(), buffer.height(), data)
                .expect("RGB8 buffer matches image dimensions")
        }
        None => warped.to_rgb8(),
    };
    DynamicImage::ImageRgb8(rgb8)
}

pub fn build_warped_image_for_masks<'a>(
    base_image: &'a DynamicImage,
    is_raw: bool,
    adjustments: &serde_json::Value,
    masks: &[MaskDefinition],
) -> Option<Cow<'a, DynamicImage>> {
    if masks.iter().any(|m| m.requires_warped_image()) {
        Some(Cow::Owned(build_full_warped_image_rgb8(
            base_image,
            crate::negative_conversion::effective_is_raw(is_raw, adjustments),
            adjustments,
        )))
    } else {
        None
    }
}

pub struct GeneratedMasks {
    pub bitmaps: Vec<GrayImage>,
    pub cache_key: u64,
}

#[allow(clippy::too_many_arguments)]
pub fn get_cached_or_generate_masks(
    state: &tauri::State<AppState>,
    path: &str,
    definitions: &[MaskDefinition],
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    adjustments: &serde_json::Value,
) -> GeneratedMasks {
    let mut combined_hasher = DefaultHasher::new();
    let mut bitmaps = Vec::with_capacity(definitions.len());

    for def in definitions {
        let mut hasher = DefaultHasher::new();
        let def_json = serde_json::to_string(&(
            &def.id,
            &def.name,
            def.visible,
            def.invert,
            def.opacity,
            &def.sub_masks,
        ))
        .unwrap_or_default();
        def_json.hash(&mut hasher);
        path.hash(&mut hasher);
        if def.requires_warped_image() {
            crate::cache_utils::calculate_geometry_hash(adjustments).hash(&mut hasher);
        }
        width.hash(&mut hasher);
        height.hash(&mut hasher);
        scale.to_bits().hash(&mut hasher);
        crop_offset.0.to_bits().hash(&mut hasher);
        crop_offset.1.to_bits().hash(&mut hasher);
        let key = hasher.finish();

        let cached = state
            .mask_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned();

        let bitmap = cached.or_else(|| {
            let warped_image = def
                .requires_warped_image()
                .then(|| get_cached_full_warped_image_for_path(state, Some(path), adjustments).ok())
                .flatten();
            let generated = generate_mask_bitmap(
                def,
                width,
                height,
                scale,
                crop_offset,
                warped_image.as_deref(),
            )?;

            let mut cache = state.mask_cache.lock().unwrap_or_else(|e| e.into_inner());
            let cached_bytes: usize = cache.values().map(|m| m.as_raw().len()).sum();
            if cache.len() > 50 || cached_bytes > MASK_CACHE_LIMIT_BYTES {
                cache.clear();
            }
            cache.insert(key, generated.clone());
            Some(generated)
        });

        (key, bitmap.is_some()).hash(&mut combined_hasher);
        bitmaps.extend(bitmap);
    }

    GeneratedMasks {
        bitmaps,
        cache_key: combined_hasher.finish(),
    }
}
