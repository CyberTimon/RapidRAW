use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use image::imageops::FilterType;
use image::{GrayImage, Luma};
use imageproc::region_labelling::{Connectivity, connected_components};
use rayon::prelude::*;
use serde_json::Value;
use wgpu::util::DeviceExt;

use crate::masks::transform::{TransformParams, generate_edge_clamped_bitmap};
use crate::render::adjustment_utils::is_tool_active;
use crate::render::geometry::get_geometry_params_from_json;
use crate::render::gpu::context::GpuContext;
use crate::render::uniforms::MAX_MASKS;

const MAX_LINEAR_LENGTH: f32 = 0.15;
const MAX_SMOOTH_LENGTH: f32 = 0.05;
const SMOOTH_ANGLES: [f32; 3] = [
    0.0,
    std::f32::consts::FRAC_PI_3,
    2.0 * std::f32::consts::FRAC_PI_3,
];
const FULL_FRAME: u32 = u32::MAX;
const ALPHA_CHANNEL: u32 = 3;
const CHANNELS: u32 = 4;
const MAX_ZOOM_SCALE: f32 = 0.5;
const MAX_SPIN_ANGLE: f32 = std::f32::consts::PI;
const MAX_FRAME_SPIN_ANGLE: f32 = std::f32::consts::FRAC_PI_4;
const MAX_HIGHLIGHT_GAIN: f32 = 16.0;
const MAX_DEPTH_FACTOR: f32 = 4.0;
const MIN_DEPTH_REF: f32 = 0.05;
const TAPER: f32 = 0.3;
const WOBBLE: f32 = 0.03;
const GUARD: f32 = 0.0005;
const MATTE_EDGE: f32 = 1.5;
const MATTE_SMOOTH: f32 = 0.0004;
const MATTE_TILE: usize = 64;
const SEGMENTED_TYPES: [&str; 6] = [
    "ai-subject",
    "ai-foreground",
    "ai-sky",
    "ai-text",
    "ai-face",
    "quick-eraser",
];
const DEFAULT_HIGHLIGHTS: f64 = 30.0;
const DEFAULT_DEPTH: f64 = 50.0;
const AMOUNT_GAMMA: f32 = 1.5;
const TAPS: f32 = 8.0;
const AUTO_BORDER_SHARE: f32 = 0.5;
const AUTO_FULL_COVER: f32 = 0.98;
const STATS_SAMPLES: f32 = 1_048_576.0;
const SPIN_GRID: u32 = 256;
const SPIN_MIN_SHARE: f64 = 0.05;
const MAX_SPINS: usize = 8;
const GRAIN_PERCENTILE: f32 = 0.1;
const GRAIN_RESIDUAL_GAIN: f32 = 1.118;
const WORKGROUP: u32 = 8;
const FILL_DIV: u32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MotionKind {
    Linear,
    Zoom,
    Spin,
    Smooth,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MotionLayer {
    Auto,
    Subject,
    Panning,
    Uniform,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionBlur {
    pub mask: Option<usize>,
    pub kind: MotionKind,
    pub layer: MotionLayer,
    pub amount: f32,
    pub angle: f32,
    pub highlights: f32,
    pub depth: f32,
    pub segmented: bool,
}

#[derive(Clone, Default)]
pub struct MotionBlurs {
    pub blurs: Vec<MotionBlur>,
    pub depth: Option<Arc<GrayImage>>,
}

impl MotionBlurs {
    pub fn new(
        path: &str,
        adjustments: &Value,
        size: (u32, u32),
        crop_offset: (f32, f32),
        extent: f32,
    ) -> Self {
        let blurs = from_adjustments(adjustments);
        let depth = uses_depth(&blurs)
            .then(|| depth_map(path, adjustments, size, crop_offset, extent))
            .flatten()
            .map(Arc::new);
        Self { blurs, depth }
    }
}

fn percent(value: &Value, default: f64) -> f32 {
    (value.as_f64().unwrap_or(default) as f32 / 100.0).clamp(0.0, 1.0)
}

fn motion_blur(adj: &Value, mask: Option<usize>, segmented: bool) -> Option<MotionBlur> {
    let amount = percent(&adj["motionBlurAmount"], 0.0);
    if amount <= 0.0 || !is_tool_active(adj, "motionBlur") {
        return None;
    }

    Some(MotionBlur {
        mask,
        kind: match adj["motionBlurType"].as_str() {
            Some("zoom") => MotionKind::Zoom,
            Some("spin") => MotionKind::Spin,
            Some("smooth") => MotionKind::Smooth,
            _ => MotionKind::Linear,
        },
        layer: match (mask, adj["motionBlurLayer"].as_str()) {
            (None, _) | (_, Some("uniform")) => MotionLayer::Uniform,
            (_, Some("subject")) => MotionLayer::Subject,
            (_, Some("panning")) => MotionLayer::Panning,
            _ => MotionLayer::Auto,
        },
        amount,
        angle: adj["motionBlurAngle"].as_f64().unwrap_or(0.0) as f32,
        highlights: percent(&adj["motionBlurHighlights"], DEFAULT_HIGHLIGHTS),
        depth: if adj["motionBlurDepthEnabled"].as_bool().unwrap_or(false) {
            percent(&adj["motionBlurDepth"], DEFAULT_DEPTH)
        } else {
            0.0
        },
        segmented,
    })
}

fn from_adjustments(adjustments: &Value) -> Vec<MotionBlur> {
    adjustments["masks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mask| {
            mask["visible"].as_bool().unwrap_or(false)
                && mask["subMasks"].as_array().is_some_and(|s| !s.is_empty())
        })
        .take(MAX_MASKS)
        .enumerate()
        .filter_map(|(index, mask)| {
            let segmented = mask["subMasks"].as_array().is_some_and(|subs| {
                subs.iter()
                    .any(|sub| SEGMENTED_TYPES.contains(&sub["type"].as_str().unwrap_or("")))
            });
            motion_blur(&mask["adjustments"], Some(index), segmented)
        })
        .chain(motion_blur(adjustments, None, false))
        .collect()
}

pub fn requests_depth_map(adjustments: &Value) -> bool {
    adjustments["masks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|mask| &mask["adjustments"])
        .chain([adjustments])
        .any(|adj| adj["motionBlurDepthEnabled"].as_bool().unwrap_or(false))
}

pub fn needs_depth_map(adjustments: &Value) -> bool {
    uses_depth(&from_adjustments(adjustments))
}

fn uses_depth(blurs: &[MotionBlur]) -> bool {
    blurs
        .iter()
        .any(|b| b.depth > 0.0 && b.kind != MotionKind::Spin)
}

fn depth_map(
    path: &str,
    adjustments: &Value,
    (width, height): (u32, u32),
    crop_offset: (f32, f32),
    extent: f32,
) -> Option<GrayImage> {
    let data_url = adjustments["motionBlurDepthMap"]
        .as_str()
        .filter(|map| !map.is_empty())?;
    let geometry = get_geometry_params_from_json(path, adjustments);
    let map = crate::effects::maps::resolve_luma_map(data_url, adjustments, Some(&geometry))?;
    let longest = map.width().max(map.height());
    if map.width() < 2 || map.height() < 2 || extent < 1.0 {
        return None;
    }
    let density = (longest as f32 / extent).min(1.0);
    Some(generate_edge_clamped_bitmap(
        &map,
        &TransformParams {
            rotation: adjustments["rotation"].as_f64().unwrap_or(0.0) as f32,
            flip_horizontal: adjustments["flipHorizontal"].as_bool().unwrap_or(false),
            flip_vertical: adjustments["flipVertical"].as_bool().unwrap_or(false),
            orientation_steps: (adjustments["orientationSteps"].as_u64().unwrap_or(0) % 4) as u8,
            width: ((width as f32 * density).ceil() as u32).max(1),
            height: ((height as f32 * density).ceil() as u32).max(1),
            scale: extent * density / longest as f32,
            crop_offset: (crop_offset.0 * density, crop_offset.1 * density),
        },
    ))
}

pub fn cache_key(
    input_id: u64,
    mask_key: u64,
    depth: Option<&GrayImage>,
    blurs: &[MotionBlur],
) -> u64 {
    let mut hasher = DefaultHasher::new();
    (input_id, mask_key).hash(&mut hasher);
    depth
        .map(|map| (map.dimensions(), map.as_raw()))
        .hash(&mut hasher);
    for blur in blurs {
        (blur.mask, blur.kind, blur.layer, blur.segmented).hash(&mut hasher);
        for value in [blur.amount, blur.angle, blur.highlights, blur.depth] {
            value.to_bits().hash(&mut hasher);
        }
    }
    hasher.finish()
}

pub fn estimate_grain(
    context: &crate::render::gpu::context::GpuContext,
    image: &wgpu::TextureView,
    (w, h): (u32, u32),
    is_raw: bool,
) -> Result<f32, String> {
    const BLOCK: u32 = 8;
    if w <= BLOCK + 2 || h <= BLOCK + 2 {
        return Ok(0.0);
    }
    let stride = ((w as f32 * h as f32 / 4096.0).sqrt().max(BLOCK as f32) as u32).max(1);
    let blocks = (
        (w - BLOCK - 2).div_ceil(stride),
        (h - BLOCK - 2).div_ceil(stride),
    );
    let count = (blocks.0 * blocks.1) as usize;
    let bytes = count as u64 * 4;
    let readback = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Grain Readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    crate::render::gpu::compute::encode(context, |enc| {
        let energies = enc.buffer("Grain Blocks", &vec![0u8; bytes as usize]);
        enc.run(
            crate::render::gpu::compute::Group::Transform,
            "tf_grain",
            &crate::render::source::TransformParams::grain(stride, blocks, is_raw),
            blocks,
            &[image],
            crate::render::gpu::compute::Out::None,
            crate::render::gpu::compute::Bind {
                scratch: Some(&energies),
                ..Default::default()
            },
        );
        enc.encoder
            .copy_buffer_to_buffer(&energies, 0, &readback, 0, bytes);
    })?;

    let (tx, rx) = std::sync::mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
    context
        .device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_secs(10)),
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut energies: Vec<f32> =
        bytemuck::cast_slice(&readback.slice(..).get_mapped_range()).to_vec();
    readback.unmap();
    Ok(grain_from_blocks(&mut energies))
}

fn grain_from_blocks(blocks: &mut [f32]) -> f32 {
    if blocks.is_empty() {
        return 0.0;
    }
    let index = (blocks.len() as f32 * GRAIN_PERCENTILE) as usize;
    *blocks.select_nth_unstable_by(index, f32::total_cmp).1 / GRAIN_RESIDUAL_GAIN
}

fn needs_matte(blur: &MotionBlur) -> bool {
    blur.segmented || matches!(blur.layer, MotionLayer::Subject | MotionLayer::Panning)
}

fn box_blur(values: &mut [f32], w: usize, h: usize, radius: usize) {
    let norm = 1.0 / (2 * radius + 1) as f32;
    let r = radius as isize;
    let mut rows = vec![0.0f32; values.len()];
    for y in 0..h {
        for x in 0..w {
            let sum: f32 = (x as isize - r..=x as isize + r)
                .map(|k| values[y * w + k.clamp(0, w as isize - 1) as usize])
                .sum();
            rows[y * w + x] = sum * norm;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let sum: f32 = (y as isize - r..=y as isize + r)
                .map(|k| rows[k.clamp(0, h as isize - 1) as usize * w + x])
                .sum();
            values[y * w + x] = sum * norm;
        }
    }
}

fn snap_alpha(value: f32, gx: f32, gy: f32) -> f32 {
    let slope = (gx * gx + gy * gy).sqrt().max(1.0e-4) * MATTE_EDGE;
    (0.5 + (value - 0.5) / slope).clamp(0.0, 1.0)
}

fn snap_window(values: &[f32], w: usize, h: usize) -> Vec<f32> {
    let at = |x: usize, y: usize| values[y * w + x];
    (0..w * h)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            let (left, right) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let (up, down) = (y.saturating_sub(1), (y + 1).min(h - 1));
            snap_alpha(
                at(x, y),
                (at(right, y) - at(left, y)) * 0.5,
                (at(x, down) - at(x, up)) * 0.5,
            )
        })
        .collect()
}

fn refine_matte(mask: &GrayImage, peak: f32) -> GrayImage {
    let (w, h) = (mask.width() as usize, mask.height() as usize);
    let raw = mask.as_raw();
    let inv = 1.0 / (peak * 255.0);
    let radius = ((w as f32).hypot(h as f32) * MATTE_SMOOTH).round().max(1.0) as usize;
    let margin = 2 * radius + 2;
    let to_u8 = |alpha: f32| (alpha * 255.0).round() as u8;

    let mut matte = GrayImage::new(w as u32, h as u32);
    matte
        .par_chunks_mut(w * MATTE_TILE)
        .enumerate()
        .for_each(|(tile_row, band)| {
            let y0 = tile_row * MATTE_TILE;
            let rows = band.len() / w;
            for x0 in (0..w).step_by(MATTE_TILE) {
                let cols = MATTE_TILE.min(w - x0);
                let (wx0, wy0) = (x0.saturating_sub(margin), y0.saturating_sub(margin));
                let (wx1, wy1) = ((x0 + cols + margin).min(w), (y0 + rows + margin).min(h));
                let first = raw[wy0 * w + wx0];
                if (wy0..wy1).all(|y| raw[y * w + wx0..y * w + wx1].iter().all(|&v| v == first)) {
                    let value = to_u8(snap_alpha(
                        snap_alpha(first as f32 * inv, 0.0, 0.0),
                        0.0,
                        0.0,
                    ));
                    for y in 0..rows {
                        band[y * w + x0..y * w + x0 + cols].fill(value);
                    }
                    continue;
                }

                let (ww, wh) = (wx1 - wx0, wy1 - wy0);
                let window: Vec<f32> = (wy0..wy1)
                    .flat_map(|y| raw[y * w + wx0..y * w + wx1].iter())
                    .map(|&v| v as f32 * inv)
                    .collect();
                let mut snapped = snap_window(&window, ww, wh);
                for _ in 0..2 {
                    box_blur(&mut snapped, ww, wh, radius);
                }
                let refined = snap_window(&snapped, ww, wh);
                for row in 0..rows {
                    let source = (y0 + row - wy0) * ww + x0 - wx0;
                    for (out, &alpha) in band[row * w + x0..row * w + x0 + cols]
                        .iter_mut()
                        .zip(&refined[source..source + cols])
                    {
                        *out = to_u8(alpha);
                    }
                }
            }
        });
    matte
}

struct MaskStats {
    peak: f32,
    border: f32,
    cover: f32,
    centroid: [f32; 2],
    hole_centroid: [f32; 2],
}

impl MaskStats {
    fn full_frame((w, h): (f32, f32)) -> Self {
        Self {
            peak: 1.0,
            border: 1.0,
            cover: 1.0,
            centroid: [w * 0.5, h * 0.5],
            hole_centroid: [w * 0.5, h * 0.5],
        }
    }
}

#[derive(Default, Clone, Copy)]
struct StatsSums {
    count: f32,
    q: f32,
    qx: f32,
    qy: f32,
    h: f32,
    hx: f32,
    hy: f32,
}

impl StatsSums {
    fn add(self, o: Self) -> Self {
        Self {
            count: self.count + o.count,
            q: self.q + o.q,
            qx: self.qx + o.qx,
            qy: self.qy + o.qy,
            h: self.h + o.h,
            hx: self.hx + o.hx,
            hy: self.hy + o.hy,
        }
    }
}

fn mask_stats(mask: &GrayImage) -> Option<MaskStats> {
    let (w, h) = (mask.width() as usize, mask.height() as usize);
    let raw = mask.as_raw();
    let peak = raw.par_iter().copied().max().unwrap_or(0);
    if w == 0 || h == 0 || peak == 0 {
        return None;
    }

    let inv_peak = 1.0 / peak as f32;
    let step = ((w * h) as f32 / STATS_SAMPLES).sqrt().ceil().max(1.0) as usize;
    let q_at = |x: usize, y: usize| raw[y * w + x] as f32 * inv_peak;

    let sums = (0..h)
        .into_par_iter()
        .step_by(step)
        .map(|y| {
            let mut s = StatsSums::default();
            let fy = y as f32 + 0.5;
            for x in (0..w).step_by(step) {
                let q = q_at(x, y);
                let fx = x as f32 + 0.5;
                s.count += 1.0;
                s.q += q;
                s.qx += q * fx;
                s.qy += q * fy;
                s.h += 1.0 - q;
                s.hx += (1.0 - q) * fx;
                s.hy += (1.0 - q) * fy;
            }
            s
        })
        .reduce(StatsSums::default, StatsSums::add);

    let mut border_sum = 0.0;
    let mut border_count = 0.0;
    for x in (0..w).step_by(step) {
        border_sum += q_at(x, 0) + q_at(x, h - 1);
        border_count += 2.0;
    }
    for y in (0..h).step_by(step) {
        border_sum += q_at(0, y) + q_at(w - 1, y);
        border_count += 2.0;
    }

    let center = [w as f32 * 0.5, h as f32 * 0.5];
    let centroid_of = |sum: f32, sx: f32, sy: f32| {
        if sum > 1.0e-3 {
            [sx / sum, sy / sum]
        } else {
            center
        }
    };

    Some(MaskStats {
        peak: peak as f32 / 255.0,
        border: border_sum / border_count,
        cover: sums.q / sums.count.max(1.0),
        centroid: centroid_of(sums.q, sums.qx, sums.qy),
        hole_centroid: centroid_of(sums.h, sums.hx, sums.hy),
    })
}

fn resolve_layer(blur: &MotionBlur, stats: &MaskStats) -> MotionLayer {
    match blur.layer {
        MotionLayer::Auto if !blur.segmented || stats.cover > AUTO_FULL_COVER => {
            MotionLayer::Uniform
        }
        MotionLayer::Auto if stats.border > AUTO_BORDER_SHARE => MotionLayer::Panning,
        MotionLayer::Auto => MotionLayer::Subject,
        other => other,
    }
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct SpinItem {
    center: [f32; 2],
    _pad: [f32; 2],
    frame: [f32; 4],
    frame_inv: [f32; 4],
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct SpinSet {
    count: u32,
    _pad: [u32; 3],
    items: [SpinItem; MAX_SPINS],
}

#[derive(Clone, Copy)]
struct Blob {
    weight: f64,
    min: [f64; 2],
    max: [f64; 2],
}

impl Blob {
    const EMPTY: Self = Self {
        weight: 0.0,
        min: [f64::MAX; 2],
        max: [f64::MIN; 2],
    };

    fn merge(self, o: Self) -> Self {
        Self {
            weight: self.weight + o.weight,
            min: [self.min[0].min(o.min[0]), self.min[1].min(o.min[1])],
            max: [self.max[0].max(o.max[0]), self.max[1].max(o.max[1])],
        }
    }
}

fn spin_set(mask: &GrayImage, peak: f32) -> Option<(SpinSet, f32)> {
    let (w, h) = mask.dimensions();
    let cell = w.max(h).div_ceil(SPIN_GRID).max(1);
    let (gw, gh) = (w.div_ceil(cell), h.div_ceil(cell));
    let threshold = (peak * 255.0 * 0.5) as u8;
    let mut grid = image::imageops::resize(mask, gw, gh, FilterType::Nearest);
    grid.iter_mut()
        .for_each(|v| *v = if *v > threshold { 255 } else { 0 });
    let labels = connected_components(&grid, Connectivity::Four, Luma([0u8]));

    let count = labels.iter().copied().max().unwrap_or(0) as usize;
    let raw = mask.as_raw();
    let step = (cell / 4).max(1) as usize;
    let merge_all = |mut a: Vec<Blob>, b: Vec<Blob>| {
        a.iter_mut().zip(b).for_each(|(x, y)| *x = x.merge(y));
        a
    };
    let mut blobs = (0..h as usize)
        .into_par_iter()
        .step_by(step)
        .fold(
            || vec![Blob::EMPTY; count],
            |mut blobs, y| {
                for x in (0..w as usize).step_by(step) {
                    let label = labels.get_pixel(x as u32 / cell, y as u32 / cell)[0] as usize;
                    if label == 0 || raw[y * w as usize + x] <= threshold {
                        continue;
                    }
                    let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
                    blobs[label - 1] = blobs[label - 1].merge(Blob {
                        weight: 1.0,
                        min: [fx, fy],
                        max: [fx, fy],
                    });
                }
                blobs
            },
        )
        .reduce(|| vec![Blob::EMPTY; count], merge_all);
    blobs.sort_by(|a, b| b.weight.total_cmp(&a.weight));
    let largest = blobs.first()?.weight;

    let mut set: SpinSet = bytemuck::Zeroable::zeroed();
    let mut reach = 0.0f32;
    for blob in blobs
        .iter()
        .filter(|b| b.weight > 0.0 && b.weight >= largest * SPIN_MIN_SHARE)
        .take(MAX_SPINS)
    {
        let rx = (0.5 * (blob.max[0] - blob.min[0])).max(1.0) as f32;
        let ry = (0.5 * (blob.max[1] - blob.min[1])).max(rx as f64) as f32;
        set.items[set.count as usize] = SpinItem {
            center: [
                (0.5 * (blob.min[0] + blob.max[0])) as f32,
                blob.max[1] as f32 - ry,
            ],
            _pad: [0.0; 2],
            frame: [rx, 0.0, 0.0, ry],
            frame_inv: [rx.recip(), 0.0, 0.0, ry.recip()],
        };
        set.count += 1;
        reach = reach.max(rx.max(ry));
    }

    (set.count > 0).then_some((set, reach))
}

fn frame_spin((w, h): (f32, f32)) -> (SpinSet, f32) {
    let radius = 0.5 * (w * w + h * h).sqrt();
    let mut set: SpinSet = bytemuck::Zeroable::zeroed();
    set.count = 1;
    set.items[0] = SpinItem {
        center: [w * 0.5, h * 0.5],
        _pad: [0.0; 2],
        frame: [radius, 0.0, 0.0, radius],
        frame_inv: [radius.recip(), 0.0, 0.0, radius.recip()],
    };
    (set, radius)
}

fn depth_reference(
    depth: &GrayImage,
    mask: Option<&GrayImage>,
    layer: MotionLayer,
    peak: f32,
) -> f32 {
    let (dw, dh) = depth.dimensions();
    let (mut sum, mut weight) = (0.0f32, 0.0f32);
    for (x, y, d) in depth.enumerate_pixels() {
        let q = mask.map_or(1.0, |mask| {
            let (mw, mh) = mask.dimensions();
            let mx = ((x as f32 + 0.5) * mw as f32 / dw as f32) as u32;
            let my = ((y as f32 + 0.5) * mh as f32 / dh as f32) as u32;
            (mask.get_pixel(mx.min(mw - 1), my.min(mh - 1))[0] as f32 / 255.0 / peak).min(1.0)
        });
        let w = if layer == MotionLayer::Panning {
            1.0 - q
        } else {
            q
        };
        sum += w * d[0] as f32 / 255.0;
        weight += w;
    }
    (sum / weight.max(1.0e-3)).max(MIN_DEPTH_REF)
}

struct Stroke {
    axis: [f32; 2],
    total: f32,
    passes: u32,
}

impl Stroke {
    fn new(axis: [f32; 2], total: f32, reach: f32) -> Option<Self> {
        (reach >= 1.0).then(|| Self {
            axis,
            total,
            passes: (reach.ln() / TAPS.ln()).ceil().max(1.0) as u32,
        })
    }
}

struct Plan {
    mask: Option<usize>,
    kind: MotionKind,
    layer: MotionLayer,
    strokes: Vec<Stroke>,
    strength: f32,
    gain: f32,
    parallax: f32,
    depth_ref: f32,
    guard: f32,
    spins: Option<SpinSet>,
    matte: Option<GrayImage>,
}

fn plan(
    blur: &MotionBlur,
    mask: Option<&GrayImage>,
    (width, height): (u32, u32),
    depth: Option<&GrayImage>,
) -> Option<Plan> {
    let (w, h) = (width as f32, height as f32);
    let stats = match mask {
        Some(mask) => mask_stats(mask)?,
        None => MaskStats::full_frame((w, h)),
    };
    let layer = match blur.kind {
        MotionKind::Spin | MotionKind::Smooth => MotionLayer::Uniform,
        _ => resolve_layer(blur, &stats),
    };
    let shaped = blur.amount.powf(AMOUNT_GAMMA);
    let mut spins = None;

    let (axis, total, reach) = match blur.kind {
        MotionKind::Linear | MotionKind::Smooth => {
            let scale = match blur.kind {
                MotionKind::Smooth => MAX_SMOOTH_LENGTH,
                _ => MAX_LINEAR_LENGTH,
            };
            let length = scale * (w * w + h * h).sqrt() * shaped;
            let (sin, cos) = blur.angle.to_radians().sin_cos();
            ([cos, -sin], length, length)
        }
        MotionKind::Zoom => {
            let center = match layer {
                MotionLayer::Panning => stats.hole_centroid,
                _ => stats.centroid,
            };
            let total = MAX_ZOOM_SCALE * shaped;
            let radius = [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)]
                .iter()
                .map(|(x, y)| ((x - center[0]).powi(2) + (y - center[1]).powi(2)).sqrt())
                .fold(0.0f32, f32::max);
            (center, total, radius * 2.0 * (total * 0.5).sinh())
        }
        MotionKind::Spin => {
            let (set, radius) = match mask {
                Some(mask) => spin_set(mask, stats.peak)?,
                None => frame_spin((w, h)),
            };
            spins = Some(set);
            let max_angle = match mask {
                Some(_) => MAX_SPIN_ANGLE,
                None => MAX_FRAME_SPIN_ANGLE,
            };
            let total = max_angle * shaped;
            ([0.0; 2], total, radius * total)
        }
    };

    let (parallax, depth_ref) = match depth {
        Some(map) if blur.depth > 0.0 && blur.kind != MotionKind::Spin => {
            (blur.depth, depth_reference(map, mask, layer, stats.peak))
        }
        _ => (0.0, 1.0),
    };
    let reach = reach * (1.0 + parallax * (depth_ref.recip() - 1.0)).min(MAX_DEPTH_FACTOR);
    let mut strokes: Vec<Stroke> = match blur.kind {
        MotionKind::Smooth => SMOOTH_ANGLES
            .iter()
            .filter_map(|angle| {
                let (sin, cos) = angle.sin_cos();
                Stroke::new([cos, sin], total, reach)
            })
            .collect(),
        _ => [1.0 - TAPER, TAPER]
            .into_iter()
            .filter_map(|share| Stroke::new(axis, total * share, reach * share))
            .collect(),
    };
    if strokes.is_empty() {
        return None;
    }
    if blur.kind == MotionKind::Linear {
        strokes.extend(Stroke::new(
            [-axis[1], axis[0]],
            total * WOBBLE,
            reach * WOBBLE,
        ));
    }

    Some(Plan {
        mask: blur.mask,
        kind: blur.kind,
        layer,
        strokes,
        strength: stats.peak,
        gain: blur.highlights * MAX_HIGHLIGHT_GAIN,
        parallax,
        depth_ref,
        guard: (GUARD * (w * w + h * h).sqrt()).max(1.0),
        spins,
        matte: mask
            .filter(|_| needs_matte(blur))
            .map(|mask| refine_matte(mask, stats.peak)),
    })
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct MotionParams {
    axis: [f32; 2],
    spacing: f32,
    strength: f32,
    scale: f32,
    gain: f32,
    noise: f32,
    parallax: f32,
    depth_ref: f32,
    kind: u32,
    layer: u32,
    mask_layer: u32,
    is_raw: u32,
    row_words: u32,
    seed: u32,
    guard: f32,
    channel: u32,
    _pad: [u32; 3],
}

impl MotionParams {
    fn for_plan(plan: &Plan, is_raw: u32, noise: f32, row_words: u32) -> Self {
        Self {
            axis: plan.strokes[0].axis,
            spacing: 0.0,
            strength: plan.strength,
            scale: plan.strength.recip(),
            gain: plan.gain,
            noise,
            parallax: plan.parallax,
            depth_ref: plan.depth_ref,
            kind: match plan.kind {
                MotionKind::Linear | MotionKind::Smooth => 0,
                MotionKind::Zoom => 1,
                MotionKind::Spin => 2,
            },
            layer: match plan.layer {
                MotionLayer::Subject => 0,
                MotionLayer::Panning => 1,
                _ => 2,
            },
            mask_layer: plan.mask.map_or(FULL_FRAME, |index| index as u32),
            is_raw,
            row_words,
            seed: plan.mask.map_or(0, |index| index as u32 + 1),
            guard: plan.guard,
            channel: ALPHA_CHANNEL,
            _pad: [0; 3],
        }
    }
}

pub struct MotionBlurPipelines {
    bgl: wgpu::BindGroupLayout,
    pull_first: wgpu::ComputePipeline,
    pull_front: wgpu::ComputePipeline,
    pull: wgpu::ComputePipeline,
    push_top: wgpu::ComputePipeline,
    push: wgpu::ComputePipeline,
    source: wgpu::ComputePipeline,
    cascade: wgpu::ComputePipeline,
    composite: wgpu::ComputePipeline,
    pack: wgpu::ComputePipeline,
    mask_source: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
    dummy_view: wgpu::TextureView,
    dummy_storage_view: wgpu::TextureView,
    dummy_buffer: wgpu::Buffer,
    no_spins: wgpu::Buffer,
}

impl MotionBlurPipelines {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Motion Blur Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/motion_blur.wgsl").into()),
        });

        let entry = |binding: u32, ty: wgpu::BindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty,
            count: None,
        };
        let texture = |view_dimension| wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension,
            multisampled: false,
        };
        let buffer = |ty| wgpu::BindingType::Buffer {
            ty,
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let flat = wgpu::TextureViewDimension::D2;

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Motion Blur BGL"),
            entries: &[
                entry(0, texture(flat)),
                entry(1, texture(flat)),
                entry(2, texture(wgpu::TextureViewDimension::D2Array)),
                entry(
                    3,
                    wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: flat,
                    },
                ),
                entry(4, buffer(wgpu::BufferBindingType::Uniform)),
                entry(
                    5,
                    wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                ),
                entry(
                    6,
                    buffer(wgpu::BufferBindingType::Storage { read_only: false }),
                ),
                entry(7, texture(flat)),
                entry(8, buffer(wgpu::BufferBindingType::Uniform)),
                entry(9, texture(flat)),
                entry(10, texture(flat)),
            ],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Motion Blur Layout"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });

        let pipeline = |entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&layout),
                module: &shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        let dummy_desc = wgpu::TextureDescriptor {
            label: Some("Motion Blur Dummy"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        };

        Self {
            pull_first: pipeline("mb_pull_first"),
            pull_front: pipeline("mb_pull_front"),
            pull: pipeline("mb_pull"),
            push_top: pipeline("mb_push_top"),
            push: pipeline("mb_push"),
            source: pipeline("mb_source"),
            cascade: pipeline("mb_cascade"),
            composite: pipeline("mb_composite"),
            pack: pipeline("mb_pack"),
            mask_source: pipeline("mb_mask_source"),
            bgl,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Motion Blur Sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            dummy_view: device
                .create_texture(&dummy_desc)
                .create_view(&Default::default()),
            dummy_storage_view: device
                .create_texture(&wgpu::TextureDescriptor {
                    usage: wgpu::TextureUsages::STORAGE_BINDING,
                    ..dummy_desc
                })
                .create_view(&Default::default()),
            dummy_buffer: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Motion Blur Dummy Buffer"),
                size: 16,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            }),
            no_spins: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Motion Blur No Spins"),
                contents: bytemuck::bytes_of(&<SpinSet as bytemuck::Zeroable>::zeroed()),
                usage: wgpu::BufferUsages::UNIFORM,
            }),
        }
    }

    pub fn upload_depth(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        depth: &GrayImage,
    ) -> wgpu::TextureView {
        device
            .create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some("Motion Blur Depth"),
                    size: wgpu::Extent3d {
                        width: depth.width(),
                        height: depth.height(),
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::MipMajor,
                depth.as_raw(),
            )
            .create_view(&Default::default())
    }
}

pub struct MotionBlurOutput {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub mask_view: Option<wgpu::TextureView>,
}

#[derive(Clone, Copy)]
struct Dispatch<'a> {
    pipeline: &'a wgpu::ComputePipeline,
    params: MotionParams,
    src: &'a wgpu::TextureView,
    aux: Option<&'a wgpu::TextureView>,
    fill: Option<&'a wgpu::TextureView>,
    dst: Option<&'a wgpu::TextureView>,
    packed: Option<&'a wgpu::Buffer>,
    front: Option<&'a wgpu::TextureView>,
    mask: Option<&'a wgpu::TextureView>,
    spins: Option<&'a wgpu::Buffer>,
    size: (u32, u32),
}

impl<'a> Dispatch<'a> {
    fn new(
        pipeline: &'a wgpu::ComputePipeline,
        params: MotionParams,
        src: &'a wgpu::TextureView,
        size: (u32, u32),
    ) -> Self {
        Self {
            pipeline,
            params,
            src,
            aux: None,
            fill: None,
            dst: None,
            packed: None,
            front: None,
            mask: None,
            spins: None,
            size,
        }
    }

    fn to(self, dst: &'a wgpu::TextureView) -> Self {
        Self {
            dst: Some(dst),
            ..self
        }
    }
}

fn mip_views(texture: &wgpu::Texture) -> Vec<wgpu::TextureView> {
    (0..texture.mip_level_count())
        .map(|level| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: level,
                mip_level_count: Some(1),
                ..Default::default()
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub fn render(
    context: &GpuContext,
    pipelines: &MotionBlurPipelines,
    input: &wgpu::TextureView,
    (width, height): (u32, u32),
    is_raw: u32,
    grain: f32,
    blurs: &[MotionBlur],
    mask_bitmaps: &[GrayImage],
    mask_view: &wgpu::TextureView,
    depth: Option<(&wgpu::TextureView, &GrayImage)>,
) -> Result<Option<MotionBlurOutput>, String> {
    let start = std::time::Instant::now();
    let plans: Vec<Plan> = blurs
        .iter()
        .filter_map(|blur| {
            let mask = match blur.mask {
                Some(index) => Some(
                    mask_bitmaps
                        .get(index)
                        .filter(|mask| mask.dimensions() == (width, height))?,
                ),
                None => None,
            };
            plan(blur, mask, (width, height), depth.map(|(_, map)| map))
        })
        .collect();
    if plans.is_empty() {
        return Ok(None);
    }
    let mask_layers = (mask_bitmaps.len() as u32).min(mask_view.texture().depth_or_array_layers());
    let blurs_masks = mask_layers > 0 && plans.iter().any(|p| p.mask.is_none());

    let device = &context.device;
    let texture = |label: &'static str, w: u32, h: u32, mip_level_count: u32| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        })
    };
    let out_of_memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let invalid = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let pool: Vec<(wgpu::Texture, wgpu::TextureView)> = (0..plans.len().min(2) + 1)
        .map(|_| {
            let t = texture("Motion Blur Image", width, height, 1);
            let view = t.create_view(&Default::default());
            (t, view)
        })
        .collect();

    let (fw, fh) = (
        width.div_ceil(FILL_DIV).max(1),
        height.div_ceil(FILL_DIV).max(1),
    );
    let mip_size = |level: usize| ((fw >> level).max(1), (fh >> level).max(1));
    let fill_chains = plans
        .iter()
        .any(|p| p.layer != MotionLayer::Uniform)
        .then(|| {
            let levels = 32 - fw.max(fh).leading_zeros();
            (
                mip_views(&texture("Motion Blur Pull", fw, fh, levels)),
                mip_views(&texture("Motion Blur Fill", fw, fh, levels)),
                plans
                    .iter()
                    .any(|p| p.layer == MotionLayer::Subject)
                    .then(|| mip_views(&texture("Motion Blur Front", fw, fh, levels))),
            )
        });

    let row_words = width.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * (wgpu::COPY_BYTES_PER_ROW_ALIGNMENT / 4);
    let needs_mask = blurs_masks || plans.iter().any(|p| p.layer == MotionLayer::Subject);
    let packed = needs_mask.then(|| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Motion Blur Mask Buffer"),
            size: row_words as u64 * 4 * height as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    });
    let mask_texture = mask_view.texture();
    let blurred_masks = needs_mask.then(|| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Motion Blur Mask Array"),
            size: mask_texture.size(),
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: mask_texture.format(),
            usage: mask_texture.usage(),
            view_formats: &[],
        })
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Motion Blur Encoder"),
    });
    if let Some(target) = &blurred_masks {
        encoder.copy_texture_to_texture(
            mask_texture.as_image_copy(),
            target.as_image_copy(),
            mask_texture.size(),
        );
    }
    let blurred_mask_view = blurred_masks.as_ref().map(|t| {
        t.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        })
    });

    let depth_view = depth.map_or(&pipelines.dummy_view, |(view, _)| view);
    let dispatch = |encoder: &mut wgpu::CommandEncoder, d: Dispatch| {
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Motion Blur Params"),
            contents: bytemuck::bytes_of(&d.params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        fn view(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding,
                resource: wgpu::BindingResource::TextureView(view),
            }
        }
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Motion Blur BG"),
            layout: &pipelines.bgl,
            entries: &[
                view(0, d.src),
                view(1, d.aux.unwrap_or(&pipelines.dummy_view)),
                view(2, d.mask.unwrap_or(mask_view)),
                view(3, d.dst.unwrap_or(&pipelines.dummy_storage_view)),
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Sampler(&pipelines.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: d
                        .packed
                        .unwrap_or(&pipelines.dummy_buffer)
                        .as_entire_binding(),
                },
                view(7, d.fill.unwrap_or(&pipelines.dummy_view)),
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: d.spins.unwrap_or(&pipelines.no_spins).as_entire_binding(),
                },
                view(9, depth_view),
                view(10, d.front.unwrap_or(&pipelines.dummy_view)),
            ],
        });
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(d.pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(
            d.size.0.div_ceil(WORKGROUP),
            d.size.1.div_ceil(WORKGROUP),
            1,
        );
    };
    let pack_into = |encoder: &mut wgpu::CommandEncoder,
                     params: MotionParams,
                     blurred: &wgpu::TextureView,
                     layer: u32| {
        let (Some(buffer), Some(target)) = (&packed, &blurred_masks) else {
            return;
        };
        dispatch(
            encoder,
            Dispatch {
                aux: Some(blurred),
                packed: Some(buffer),
                ..Dispatch::new(
                    &pipelines.pack,
                    params,
                    &pipelines.dummy_view,
                    (width.div_ceil(4), height),
                )
            },
        );
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_words * 4),
                    rows_per_image: Some(height),
                },
            },
            wgpu::TexelCopyTextureInfo {
                texture: target,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: 0,
                    y: 0,
                    z: layer,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    };

    let mut current: Option<usize> = None;
    for plan in &plans {
        let matte = plan.matte.as_ref().map(|matte| {
            device
                .create_texture_with_data(
                    &context.queue,
                    &wgpu::TextureDescriptor {
                        label: Some("Motion Blur Matte"),
                        size: wgpu::Extent3d {
                            width,
                            height,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::R8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    },
                    wgpu::util::TextureDataOrder::MipMajor,
                    matte.as_raw(),
                )
                .create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2Array),
                    ..Default::default()
                })
        });
        let for_plan = MotionParams::for_plan(plan, is_raw, grain, row_words);
        let base = MotionParams {
            mask_layer: if matte.is_some() {
                0
            } else {
                for_plan.mask_layer
            },
            ..for_plan
        };
        let run = |encoder: &mut wgpu::CommandEncoder, d: Dispatch| {
            dispatch(
                encoder,
                Dispatch {
                    mask: matte.as_ref().or(d.mask),
                    ..d
                },
            )
        };
        let spins = plan.spins.map(|set| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Motion Blur Spins"),
                contents: bytemuck::bytes_of(&set),
                usage: wgpu::BufferUsages::UNIFORM,
            })
        });
        let src = current.map_or(input, |i| &pool[i].1);
        let free: Vec<usize> = (0..pool.len()).filter(|&i| Some(i) != current).collect();

        let fill_into = |encoder: &mut wgpu::CommandEncoder,
                         first: &wgpu::ComputePipeline,
                         pull: &[wgpu::TextureView],
                         target: &[wgpu::TextureView]| {
            let top = pull.len() - 1;
            run(
                encoder,
                Dispatch::new(first, base, src, mip_size(0)).to(&pull[0]),
            );
            for level in 0..top {
                run(
                    encoder,
                    Dispatch::new(&pipelines.pull, base, &pull[level], mip_size(level + 1))
                        .to(&pull[level + 1]),
                );
            }
            run(
                encoder,
                Dispatch::new(&pipelines.push_top, base, &pull[top], mip_size(top))
                    .to(&target[top]),
            );
            for level in (0..top).rev() {
                run(
                    encoder,
                    Dispatch {
                        aux: Some(&target[level + 1]),
                        ..Dispatch::new(&pipelines.push, base, &pull[level], mip_size(level))
                            .to(&target[level])
                    },
                );
            }
        };
        let (fill, front) = match (&fill_chains, plan.layer) {
            (Some((pull, fill, Some(front))), MotionLayer::Subject) => {
                fill_into(&mut encoder, &pipelines.pull_first, pull, fill);
                fill_into(&mut encoder, &pipelines.pull_front, pull, front);
                (Some(&fill[0]), Some(&front[0]))
            }
            (Some((pull, fill, _)), MotionLayer::Panning) => {
                fill_into(&mut encoder, &pipelines.pull_first, pull, fill);
                (Some(&fill[0]), None)
            }
            _ => (None, None),
        };

        let cascade = |encoder: &mut wgpu::CommandEncoder, (mut a, mut b): (usize, usize)| {
            for stroke in &plan.strokes {
                for pass in 0..stroke.passes {
                    let params = MotionParams {
                        axis: stroke.axis,
                        spacing: stroke.total / TAPS.powi((stroke.passes - pass) as i32),
                        ..base
                    };
                    run(
                        encoder,
                        Dispatch {
                            spins: spins.as_ref(),
                            ..Dispatch::new(&pipelines.cascade, params, &pool[a].1, (width, height))
                                .to(&pool[b].1)
                        },
                    );
                    std::mem::swap(&mut a, &mut b);
                }
            }
            (a, b)
        };

        if let (None, Some(masks)) = (plan.mask, &blurred_mask_view) {
            for first in (0..mask_layers).step_by(CHANNELS as usize) {
                dispatch(
                    &mut encoder,
                    Dispatch {
                        mask: Some(masks),
                        ..Dispatch::new(
                            &pipelines.mask_source,
                            MotionParams {
                                mask_layer: first,
                                ..base
                            },
                            &pipelines.dummy_view,
                            (width, height),
                        )
                        .to(&pool[free[0]].1)
                    },
                );
                let (blurred, _) = cascade(&mut encoder, (free[0], free[1]));
                for channel in 0..CHANNELS.min(mask_layers - first) {
                    pack_into(
                        &mut encoder,
                        MotionParams { channel, ..base },
                        &pool[blurred].1,
                        first + channel,
                    );
                }
            }
        }

        run(
            &mut encoder,
            Dispatch {
                fill,
                front,
                ..Dispatch::new(&pipelines.source, base, src, (width, height)).to(&pool[free[0]].1)
            },
        );
        let (a, b) = cascade(&mut encoder, (free[0], free[1]));

        run(
            &mut encoder,
            Dispatch {
                aux: Some(&pool[a].1),
                fill,
                front,
                ..Dispatch::new(&pipelines.composite, base, src, (width, height)).to(&pool[b].1)
            },
        );

        if let (Some(index), MotionLayer::Subject) = (plan.mask, plan.layer) {
            pack_into(&mut encoder, base, &pool[a].1, index as u32);
        }

        current = Some(b);
    }

    context.queue.submit(Some(encoder.finish()));
    let invalid = pollster::block_on(invalid.pop());
    if let Some(error) = pollster::block_on(out_of_memory.pop()).or(invalid) {
        return Err(format!("Motion blur failed on the GPU: {}", error));
    }

    let mut pool = pool;
    let Some(index) = current else {
        return Ok(None);
    };
    let (texture, view) = pool.swap_remove(index);
    log::info!(
        "motion blur ({} blurs, {}x{}) encoded in {:.2?}",
        plans.len(),
        width,
        height,
        start.elapsed()
    );

    Ok(Some(MotionBlurOutput {
        texture,
        view,
        mask_view: blurred_mask_view,
    }))
}
