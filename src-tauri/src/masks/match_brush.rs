use crate::masks::morphology::for_each_mask_row;
use crate::masks::shapes::BrushLine;
use crate::masks::transform::{TransformParams, output_to_source};
use image::{DynamicImage, GrayImage, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

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

    let box_mean = |values: &[f32], radius: usize| {
        crate::retouch::touch_up::box_mean(values, width, height, radius)
    };
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

pub fn generate_match_brush_bitmap(
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
    let coefficients = crate::ai::guided_filter::color_guided_coefficients(
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
