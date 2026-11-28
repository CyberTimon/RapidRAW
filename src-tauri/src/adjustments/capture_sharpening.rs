use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use glam::{Mat3, Vec3};
use image::{DynamicImage, Rgb32FImage};
use rayon::prelude::*;
use serde_json::Value;
use wgpu::util::DeviceExt;

use crate::adjustments::negative_conversion;
use crate::decode::develop::{release, storage, upload, whole};
use crate::decode::formats::is_raw_file;
use crate::decode::gpu_fallback::{Load, on_gpu, scoped};
use crate::library::sidecars::parse_virtual_path;
use crate::render::adjustment_utils::{factory_adjustments, is_tool_active};
use crate::render::color_space::working_luma;
use crate::render::gpu::context::DecodeGpu;

const SHADER: &str = include_str!("../shaders/capture.wgsl");
const TOOL: &str = "sharpening";
const KEY: &str = "captureSharpening";

const PEDESTAL: f32 = 0.001;
const STOP_PEDESTAL: f32 = 0.9;
const MIN_RADIUS: f32 = 0.4;
const MAX_RADIUS: f32 = 2.0;
const DEFAULT_RADIUS: f32 = 0.75;
const ITERATIONS: u32 = 20;
const TILE: usize = 42;
const MAX_TAPS: usize = 13;
const SETTLED: f32 = 0.01;
const CLIP_LEVEL: f32 = 0.98;
const BLEND_SIGMA: f32 = 2.0;
const BAND_FLOATS: usize = 8 << 20;
const IDENTITY_SAMPLES: usize = 4096;

const MIN_TILE_L: f32 = 2000.0 / 327.68;
const MAX_TILE_L: f32 = 20000.0 / 327.68;
const MIN_TILE_VARIANCE: f64 = 0.5 / 327.68;
const FLAT_COARSE: f64 = 1.0 / 327.68;
const FLAT_FINE: f64 = 8.0 / 327.68;
const NOISE_SHARE: f64 = 0.35;
const COARSE_TILE: usize = 80;
const FINE_TILE: usize = 40;
const CELL: usize = 10;

#[derive(Clone, Copy, Default)]
pub struct Capture {
    pub radius: Option<f32>,
    pub camera: Option<[[f32; 3]; 3]>,
}

#[derive(Clone, Copy)]
struct Develop {
    dims: (u32, u32),
    radius: f32,
    to_camera: Option<Mat3>,
    generation: u64,
}

static DEVELOPS: LazyLock<Mutex<HashMap<String, Develop>>> = LazyLock::new(Default::default);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static GAINS: Mutex<Option<(u64, Arc<Vec<f32>>)>> = Mutex::new(None);

fn source_key(path: &str) -> String {
    parse_virtual_path(path).0.to_string_lossy().into_owned()
}

pub fn remember(path: &str, dims: (u32, u32), capture: Capture) {
    let to_camera = capture
        .camera
        .map(|rows| Mat3::from_cols_array_2d(&rows).transpose())
        .filter(|m| m.determinant().abs() > f32::EPSILON)
        .map(|m| m.inverse());
    let develop = Develop {
        dims,
        radius: capture
            .radius
            .filter(|r| r.is_finite())
            .unwrap_or(DEFAULT_RADIUS)
            .clamp(MIN_RADIUS, MAX_RADIUS),
        to_camera,
        generation: GENERATION.fetch_add(1, Ordering::Relaxed),
    };
    DEVELOPS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(source_key(path), develop);
}

fn develop(path: &str) -> Option<Develop> {
    DEVELOPS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&source_key(path))
        .copied()
}

fn default_slider() -> f64 {
    factory_adjustments()
        .and_then(|factory| factory.get(KEY))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn slider(adjustments: &Value) -> f64 {
    if is_tool_active(adjustments, TOOL) {
        adjustments[KEY].as_f64().unwrap_or_else(default_slider)
    } else {
        0.0
    }
}

pub fn amount(path: &str, adjustments: &Value) -> f32 {
    if !is_raw_file(parse_virtual_path(path).0)
        || negative_conversion::is_enabled(adjustments)
        || crate::ai::upscale::is_enabled(adjustments)
    {
        return 0.0;
    }
    (slider(adjustments) / 100.0).clamp(0.0, 1.0) as f32
}

pub fn hash(adjustments: &Value, hasher: &mut impl Hasher) {
    let slider = slider(adjustments);
    if slider != default_slider() {
        slider.to_bits().hash(hasher);
    }
}

pub fn apply<'a>(
    image: Cow<'a, DynamicImage>,
    path: &str,
    adjustments: &Value,
) -> Cow<'a, DynamicImage> {
    let amount = amount(path, adjustments);
    let DynamicImage::ImageRgb32F(rgb) = image.as_ref() else {
        return image;
    };
    if amount <= 0.0 {
        return image;
    }
    let Some(develop) = develop(path).filter(|d| d.dims == rgb.dimensions()) else {
        return image;
    };
    let Some(stops) = gains(rgb, path, develop) else {
        return image;
    };
    let mut sharpened = match image.into_owned() {
        DynamicImage::ImageRgb32F(rgb) => rgb,
        other => other.into_rgb32f(),
    };
    sharpened
        .par_chunks_mut(3)
        .zip(stops.par_iter())
        .filter(|(_, stops)| **stops != 0.0)
        .for_each(|(px, stops)| {
            let factor = (stops * amount).exp2();
            px.iter_mut()
                .for_each(|c| *c = (*c + PEDESTAL) * factor - PEDESTAL);
        });
    Cow::Owned(DynamicImage::ImageRgb32F(sharpened))
}

fn identity(rgb: &Rgb32FImage, path: &str, develop: Develop) -> u64 {
    let mut hasher = DefaultHasher::new();
    (source_key(path), develop.generation, rgb.dimensions()).hash(&mut hasher);
    let raw = rgb.as_raw();
    for value in raw.iter().step_by((raw.len() / IDENTITY_SAMPLES).max(1)) {
        value.to_bits().hash(&mut hasher);
    }
    hasher.finish()
}

fn gains(rgb: &Rgb32FImage, path: &str, develop: Develop) -> Option<Arc<Vec<f32>>> {
    let radius = develop.radius;
    let key = identity(rgb, path, develop);
    if let Some((cached, stops)) = GAINS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        && *cached == key
    {
        return Some(Arc::clone(stops));
    }
    let started = Instant::now();
    let (width, height) = (rgb.width() as usize, rgb.height() as usize);
    if width < COARSE_TILE || height < COARSE_TILE {
        return None;
    }
    let planes = Planes::new(rgb, develop.to_camera);
    let kernel = Kernel::new(radius);
    let load = Load {
        pixels: width * height,
        demosaic: false,
    };
    let (processor, stops) = match on_gpu(load, |context| {
        with_kernels(&context.device, |kernels| {
            deconvolve_gpu(kernels, context, &planes, &kernel)
        })
    }) {
        Some(stops) => ("GPU", stops),
        None => ("CPU", deconvolve_cpu(&planes, &kernel)),
    };
    log::info!(
        "{} capture sharpening of {}x{} at radius {:.2}, threshold {:.2} took {:?}",
        processor,
        width,
        height,
        radius,
        planes.threshold,
        started.elapsed()
    );
    let stops = Arc::new(stops);
    *GAINS.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, Arc::clone(&stops)));
    Some(stops)
}

struct Planes {
    width: usize,
    height: usize,
    luma: Vec<f32>,
    blend: Vec<f32>,
    threshold: f32,
}

impl Planes {
    fn new(rgb: &Rgb32FImage, to_camera: Option<Mat3>) -> Self {
        let (width, height) = (rgb.width() as usize, rgb.height() as usize);
        let weights = working_luma();
        let n = width * height;
        let mut luma = vec![0f32; n];
        let mut lightness = vec![0f32; n];
        let mut clipped = vec![false; n];
        luma.par_iter_mut()
            .zip(lightness.par_iter_mut())
            .zip(clipped.par_iter_mut())
            .zip(rgb.as_raw().par_chunks_exact(3))
            .for_each(|(((luma, lightness), clipped), px)| {
                let y = weights[0] * px[0] + weights[1] * px[1] + weights[2] * px[2];
                let finite = y.is_finite();
                let y = if finite { y } else { 0.0 };
                *luma = y.max(0.0) + PEDESTAL;
                *lightness = l_star(y);
                let px = Vec3::from_slice(px);
                let raw = to_camera.map_or(px, |m| m * px);
                *clipped = !finite || raw.max_element() >= CLIP_LEVEL;
            });
        let clipped = widen(&clipped, width, height);
        let threshold = auto_threshold(&lightness, width, height);
        let mut blend = vec![0f32; n];
        blend
            .par_chunks_mut(width)
            .zip(clipped.par_chunks(width))
            .enumerate()
            .for_each(|(y, (row, clipped))| {
                let cy = y.clamp(2, height - 3);
                for (x, (b, &clipped)) in row.iter_mut().zip(clipped).enumerate() {
                    *b = match (clipped, threshold > 0.0) {
                        (true, _) => 0.0,
                        (false, false) => 1.0,
                        (false, true) => {
                            let cx = x.clamp(2, width - 3);
                            blend_factor(contrast(&lightness, width, cx, cy), threshold)
                        }
                    };
                }
            });
        drop((lightness, clipped));
        if threshold > 0.0 {
            gaussian(&mut blend, width, height, BLEND_SIGMA);
        }
        Self {
            width,
            height,
            luma,
            blend,
            threshold,
        }
    }
}

fn l_star(y: f32) -> f32 {
    let f = if y > 0.008856 {
        y.cbrt()
    } else {
        7.787 * y + 16.0 / 116.0
    };
    116.0 * f - 16.0
}

fn contrast(l: &[f32], w: usize, x: usize, y: usize) -> f32 {
    let at = |x: usize, y: usize| l[y * w + x];
    let dx1 = at(x + 1, y) - at(x - 1, y);
    let dy1 = at(x, y + 1) - at(x, y - 1);
    let dx2 = at(x + 2, y) - at(x - 2, y);
    let dy2 = at(x, y + 2) - at(x, y - 2);
    (dx1 * dx1 + dy1 * dy1 + dx2 * dx2 + dy2 * dy2).sqrt() * 0.0625
}

fn blend_factor(contrast: f32, threshold: f32) -> f32 {
    let x = (16.0 / threshold) * contrast - 16.0;
    0.5 * (1.0 + x / (1.0 + x * x).sqrt())
}

fn widen(mask: &[bool], w: usize, h: usize) -> Vec<bool> {
    let rows: Vec<bool> = mask
        .par_chunks(w)
        .flat_map_iter(|row| {
            (0..w).map(move |x| row[x.saturating_sub(2)..(x + 3).min(w)].contains(&true))
        })
        .collect();
    (0..h)
        .into_par_iter()
        .flat_map_iter(|y| {
            let rows = &rows;
            (0..w).map(move |x| (y.saturating_sub(2)..(y + 3).min(h)).any(|yy| rows[yy * w + x]))
        })
        .collect()
}

fn gaussian(plane: &mut [f32], w: usize, h: usize, sigma: f32) {
    let reach = (3.0 * sigma).ceil() as usize;
    let taps: Vec<f32> = (0..=2 * reach)
        .map(|k| {
            let i = k as f32 - reach as f32;
            (-(i * i) / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let total: f32 = taps.iter().sum();
    let taps: Vec<f32> = taps.iter().map(|t| t / total).collect();
    let mut rows = vec![0f32; w * h];
    rows.par_chunks_mut(w)
        .zip(plane.par_chunks(w))
        .for_each_init(
            || vec![0f32; w + 2 * reach],
            |padded, (out, row)| {
                padded[..reach].fill(row[0]);
                padded[reach..reach + w].copy_from_slice(row);
                padded[reach + w..].fill(row[w - 1]);
                out.fill(0.0);
                for (k, &tap) in taps.iter().enumerate() {
                    for (o, &v) in out.iter_mut().zip(&padded[k..k + w]) {
                        *o += tap * v;
                    }
                }
            },
        );
    plane.par_chunks_mut(w).enumerate().for_each(|(y, out)| {
        out.fill(0.0);
        for (k, &tap) in taps.iter().enumerate() {
            let sy = (y + k).saturating_sub(reach).min(h - 1);
            for (o, &v) in out.iter_mut().zip(&rows[sy * w..(sy + 1) * w]) {
                *o += tap * v;
            }
        }
    });
}

struct Cells {
    across: usize,
    sums: Vec<[f64; 2]>,
}

impl Cells {
    fn new(lightness: &[f32], w: usize, h: usize) -> Self {
        let (across, down) = (w / CELL, h / CELL);
        let sums = (0..across * down)
            .into_par_iter()
            .map(|i| {
                let (cx, cy) = (i % across * CELL, i / across * CELL);
                let mut sum = [0f64; 2];
                for y in cy..cy + CELL {
                    for &v in &lightness[y * w + cx..y * w + cx + CELL] {
                        sum[0] += v as f64;
                        sum[1] += v as f64 * v as f64;
                    }
                }
                sum
            })
            .collect();
        Self { across, sums }
    }

    fn index(&self, x: usize, y: usize, size: usize) -> f64 {
        let span = size / CELL;
        let (cx, cy) = (x / CELL, y / CELL);
        let mut sum = [0f64; 2];
        for j in cy..cy + span {
            for cell in &self.sums[j * self.across + cx..j * self.across + cx + span] {
                sum[0] += cell[0];
                sum[1] += cell[1];
            }
        }
        flatness(sum, size)
    }
}

fn flatness(sum: [f64; 2], size: usize) -> f64 {
    let n = (size * size) as f64;
    let mean = sum[0] / n;
    if !(MIN_TILE_L as f64..=MAX_TILE_L as f64).contains(&mean) {
        return f64::INFINITY;
    }
    let index = (sum[1] - n * mean * mean).max(0.0) / (n * mean);
    if index < MIN_TILE_VARIANCE {
        f64::INFINITY
    } else {
        index
    }
}

fn tile_flatness(lightness: &[f32], w: usize, x: usize, y: usize, size: usize) -> f64 {
    let mut sum = [0f64; 2];
    for row in y..y + size {
        for &v in &lightness[row * w + x..row * w + x + size] {
            sum[0] += v as f64;
            sum[1] += v as f64 * v as f64;
        }
    }
    flatness(sum, size)
}

fn flattest(
    tiles: impl ParallelIterator<Item = (usize, usize)>,
    index: impl Fn(usize, usize) -> f64 + Sync,
) -> Option<((usize, usize), f64)> {
    tiles
        .map(|(x, y)| ((x, y), index(x, y)))
        .filter(|(_, v)| v.is_finite())
        .min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)))
}

fn auto_threshold(lightness: &[f32], w: usize, h: usize) -> f32 {
    let cells = Cells::new(lightness, w, h);
    let grid = |size: usize, step: usize, trim: usize| {
        let across = (w / step).saturating_sub(trim);
        let down = (h / step).saturating_sub(trim);
        (0..across * down)
            .into_par_iter()
            .map(move |i| (i % across * step, i / across * step))
            .filter(move |&(x, y)| x + size <= w && y + size <= h)
    };
    if let Some(((x, y), index)) = flattest(grid(COARSE_TILE, COARSE_TILE, 0), |x, y| {
        cells.index(x, y, COARSE_TILE)
    }) && index <= FLAT_COARSE
    {
        return contrast_threshold(lightness, w, x, y, COARSE_TILE);
    }
    let step = FINE_TILE / 4;
    let Some(((bx, by), _)) = flattest(grid(FINE_TILE, step, 3), |x, y| {
        cells.index(x, y, FINE_TILE)
    }) else {
        return 0.0;
    };
    let (x0, y0) = (bx.saturating_sub(step), by.saturating_sub(step));
    let (x1, y1) = (
        (bx + step).min(w - FINE_TILE),
        (by + step).min(h - FINE_TILE),
    );
    let around = (y0..=y1)
        .into_par_iter()
        .flat_map_iter(|y| (x0..=x1).map(move |x| (x, y)));
    match flattest(around, |x, y| tile_flatness(lightness, w, x, y, FINE_TILE)) {
        Some(((x, y), index))
            if index <= FLAT_FINE || noise_share(lightness, w, x, y, FINE_TILE) >= NOISE_SHARE =>
        {
            contrast_threshold(lightness, w, x, y, FINE_TILE)
        }
        _ => 0.0,
    }
}

fn noise_share(lightness: &[f32], w: usize, x0: usize, y0: usize, size: usize) -> f64 {
    let at = |x: usize, y: usize| lightness[y * w + x] as f64;
    let (mut sum, mut squares, mut fine) = (0f64, 0f64, 0f64);
    for y in y0 + 1..y0 + size - 1 {
        for x in x0 + 1..x0 + size - 1 {
            let local = (y - 1..=y + 1)
                .flat_map(|yy| (x - 1..=x + 1).map(move |xx| (xx, yy)))
                .map(|(xx, yy)| at(xx, yy))
                .sum::<f64>()
                / 9.0;
            let v = at(x, y);
            sum += v;
            squares += v * v;
            fine += (v - local) * (v - local);
        }
    }
    let n = ((size - 2) * (size - 2)) as f64;
    let variance = squares / n - (sum / n) * (sum / n);
    if variance > 0.0 {
        fine / n / variance
    } else {
        0.0
    }
}

fn contrast_threshold(lightness: &[f32], w: usize, x0: usize, y0: usize, size: usize) -> f32 {
    let contrasts: Vec<f32> = (y0 + 2..y0 + size - 2)
        .flat_map(|y| (x0 + 2..x0 + size - 2).map(move |x| contrast(lightness, w, x, y)))
        .collect();
    let limit = contrasts.len() as f32 / 100.0;
    (1..100)
        .find(|&c| {
            let t = c as f32 / 100.0;
            contrasts.iter().map(|&v| blend_factor(v, t)).sum::<f32>() <= limit
        })
        .unwrap_or(100) as f32
        / 100.0
}

#[derive(Clone, Copy)]
struct Kernel {
    taps: [f32; MAX_TAPS],
    half: usize,
    border: usize,
    inner: usize,
}

impl Kernel {
    fn new(sigma: f32) -> Self {
        let half = match sigma {
            s if s < 0.6 => 1,
            s if s <= 0.84 => 2,
            s if s <= 1.15 => 3,
            s if s <= 1.5 => 4,
            _ => 6,
        };
        let mut taps = [0f32; MAX_TAPS];
        for (k, tap) in taps.iter_mut().take(2 * half + 1).enumerate() {
            let i = k as f32 - half as f32;
            *tap = (-(i * i) / (2.0 * sigma * sigma)).exp();
        }
        let total: f32 = taps.iter().sum();
        taps.iter_mut().for_each(|t| *t /= total);
        let border = if half <= 3 { 5 } else { 8 };
        Self {
            taps,
            half,
            border,
            inner: TILE - 2 * border,
        }
    }
}

fn stop_floor(luma: f32, blend: f32) -> f32 {
    ((luma - PEDESTAL) * 0.5 + PEDESTAL * STOP_PEDESTAL) * blend
}

fn deconvolve_cpu(planes: &Planes, kernel: &Kernel) -> Vec<f32> {
    let (w, h, inner) = (planes.width, planes.height, kernel.inner);
    let mut stops = vec![0f32; w * h];
    stops
        .par_chunks_mut(w * inner)
        .enumerate()
        .for_each(|(band, rows)| {
            let mut block = Block::default();
            for x0 in (0..w).step_by(inner) {
                block.deconvolve(planes, kernel, x0, band * inner, rows);
            }
        });
    stops
}

struct Block {
    est: Vec<f32>,
    orig: Vec<f32>,
    floor: Vec<f32>,
    tmp: Vec<f32>,
    ratio: Vec<f32>,
}

impl Default for Block {
    fn default() -> Self {
        Self {
            est: vec![0.0; TILE * TILE],
            orig: vec![0.0; TILE * TILE],
            floor: vec![0.0; TILE * TILE],
            tmp: vec![0.0; TILE * TILE],
            ratio: vec![0.0; TILE * TILE],
        }
    }
}

impl Block {
    fn deconvolve(
        &mut self,
        planes: &Planes,
        kernel: &Kernel,
        x0: usize,
        y0: usize,
        out: &mut [f32],
    ) {
        let (w, h) = (planes.width, planes.height);
        let (border, inner) = (kernel.border, kernel.inner);
        let (cols, rows) = (inner.min(w - x0), inner.min(h - y0));
        let peak = (0..rows)
            .flat_map(|y| &planes.blend[(y0 + y) * w + x0..(y0 + y) * w + x0 + cols])
            .fold(0f32, |m, &b| m.max(b));
        if peak < SETTLED {
            return;
        }
        let at = |tx: usize, ty: usize| (y0 + ty - border) * w + x0 + tx - border;
        for ty in 0..TILE {
            let sy = (y0 + ty).saturating_sub(border).min(h - 1);
            for tx in 0..TILE {
                let sx = (x0 + tx).saturating_sub(border).min(w - 1);
                let i = ty * TILE + tx;
                self.orig[i] = planes.luma[sy * w + sx];
                let inside =
                    (border..border + cols).contains(&tx) && (border..border + rows).contains(&ty);
                self.floor[i] = if inside {
                    let p = at(tx, ty);
                    stop_floor(planes.luma[p], planes.blend[p])
                } else {
                    f32::NEG_INFINITY
                };
            }
        }
        self.est.copy_from_slice(&self.orig);
        for iteration in 0..ITERATIONS {
            row_blur(&self.est, &mut self.tmp, kernel);
            col_blur(&self.tmp, &mut self.ratio, kernel);
            for (r, o) in self.ratio.iter_mut().zip(&self.orig) {
                *r = o / r.max(1e-6);
            }
            row_blur(&self.ratio, &mut self.tmp, kernel);
            col_blur(&self.tmp, &mut self.ratio, kernel);
            for (e, r) in self.est.iter_mut().zip(&self.ratio) {
                *e *= r;
            }
            if iteration + 1 < ITERATIONS && self.est.iter().zip(&self.floor).any(|(e, f)| e < f) {
                break;
            }
        }
        for ty in border..border + rows {
            for tx in border..border + cols {
                let p = at(tx, ty);
                let (luma, blend) = (planes.luma[p], planes.blend[p]);
                let sharpened = luma + blend * (self.est[ty * TILE + tx] - luma);
                out[(ty - border) * w + x0 + tx - border] = (sharpened / luma).log2();
            }
        }
    }
}

fn row_blur(src: &[f32], dst: &mut [f32], kernel: &Kernel) {
    let half = kernel.half;
    let taps = &kernel.taps[..2 * half + 1];
    let mut padded = [0f32; TILE + MAX_TAPS];
    for (row, out) in src
        .as_chunks::<TILE>()
        .0
        .iter()
        .zip(dst.as_chunks_mut::<TILE>().0)
    {
        padded[..half].fill(row[0]);
        padded[half..half + TILE].copy_from_slice(row);
        padded[half + TILE..2 * half + TILE].fill(row[TILE - 1]);
        out.fill(0.0);
        for (k, &tap) in taps.iter().enumerate() {
            for (o, &v) in out.iter_mut().zip(&padded[k..k + TILE]) {
                *o += tap * v;
            }
        }
    }
}

fn col_blur(src: &[f32], dst: &mut [f32], kernel: &Kernel) {
    let half = kernel.half;
    let taps = &kernel.taps[..2 * half + 1];
    for (y, out) in dst.as_chunks_mut::<TILE>().0.iter_mut().enumerate() {
        out.fill(0.0);
        for (k, &tap) in taps.iter().enumerate() {
            let sy = (y + k).saturating_sub(half).min(TILE - 1);
            for (o, &v) in out.iter_mut().zip(&src[sy * TILE..(sy + 1) * TILE]) {
                *o += tap * v;
            }
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    dims: [u32; 4],
    tile: [u32; 4],
    band: [u32; 4],
    taps: [[f32; 4]; MAX_TAPS],
}

struct Kernels {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

type Built = (Arc<wgpu::Device>, Result<Kernels, String>);

static KERNELS: Mutex<Option<Built>> = Mutex::new(None);

impl Kernels {
    fn new(device: &wgpu::Device) -> Self {
        let entry = |binding, ty| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let storage = |read_only| wgpu::BufferBindingType::Storage { read_only };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Capture Sharpening BGL"),
            entries: &[
                entry(0, wgpu::BufferBindingType::Uniform),
                entry(1, storage(true)),
                entry(2, storage(true)),
                entry(3, storage(false)),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Capture Sharpening Layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Capture Sharpening Shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("deconvolve"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("deconvolve"),
            compilation_options: wgpu::PipelineCompilationOptions {
                zero_initialize_workgroup_memory: false,
                ..Default::default()
            },
            cache: None,
        });
        Self { layout, pipeline }
    }
}

fn with_kernels<T>(device: &Arc<wgpu::Device>, f: impl FnOnce(&Kernels) -> Result<T>) -> Result<T> {
    let mut guard = KERNELS.lock().unwrap_or_else(|e| e.into_inner());
    if guard
        .as_ref()
        .is_some_and(|(owner, _)| !Arc::ptr_eq(owner, device))
    {
        *guard = None;
    }
    let (_, kernels) = guard.get_or_insert_with(|| {
        let kernels = scoped(device, || Ok(Kernels::new(device)));
        (Arc::clone(device), kernels.map_err(|e| e.to_string()))
    });
    f(kernels.as_ref().map_err(|e| anyhow!("{}", e))?)
}

pub fn forget() {
    *KERNELS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

pub fn warm(device: &Arc<wgpu::Device>) -> Result<()> {
    with_kernels(device, |_| Ok(()))
}

fn deconvolve_gpu(
    kernels: &Kernels,
    context: &DecodeGpu,
    planes: &Planes,
    kernel: &Kernel,
) -> Result<Vec<f32>> {
    let device = &*context.device;
    let queue = &*context.queue;
    let (w, h) = (planes.width, planes.height);
    let (border, inner) = (kernel.border, kernel.inner);
    let band_blocks = (BAND_FLOATS / (w * inner)).max(1);
    let band_rows = band_blocks * inner;
    let input_rows = band_rows + 2 * border;
    let binding_limit = context
        .limits
        .max_storage_buffer_binding_size
        .min(context.limits.max_buffer_size);
    if (input_rows * w * 4) as u64 > binding_limit {
        return Err(anyhow!("Image too wide for GPU capture sharpening"));
    }

    let input_usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
    let luma = storage(
        device,
        "Capture Luma",
        (input_rows * w * 4) as u64,
        input_usage,
    );
    let blend = storage(
        device,
        "Capture Blend",
        (input_rows * w * 4) as u64,
        input_usage,
    );
    let output = storage(
        device,
        "Capture Stops",
        (band_rows * w * 4) as u64,
        wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    );
    let staging = storage(
        device,
        "Capture Readback",
        (band_rows * w * 4) as u64,
        wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    );
    let mut taps = [[0f32; 4]; MAX_TAPS];
    for (slot, &tap) in taps.iter_mut().zip(&kernel.taps) {
        slot[0] = tap;
    }

    let mut stops = vec![0f32; w * h];
    for (band, out) in stops.chunks_mut(band_rows * w).enumerate() {
        let out_top = band * band_rows;
        let out_rows = out.len() / w;
        let top = out_top.saturating_sub(border);
        let bottom = (out_top + out_rows + border).min(h);
        upload(
            queue,
            &luma,
            0,
            bytemuck::cast_slice(&planes.luma[top * w..bottom * w]),
        )?;
        upload(
            queue,
            &blend,
            0,
            bytemuck::cast_slice(&planes.blend[top * w..bottom * w]),
        )?;
        let params = Params {
            dims: [w as u32, h as u32, top as u32, out_top as u32],
            tile: [border as u32, inner as u32, kernel.half as u32, ITERATIONS],
            band: [out_rows as u32, 0, 0, 0],
            taps,
        };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Capture Params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Capture Sharpening BG"),
            layout: &kernels.layout,
            entries: &[
                whole(0, &uniform),
                whole(1, &luma),
                whole(2, &blend),
                whole(3, &output),
            ],
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Capture Sharpening Encoder"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernels.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(w.div_ceil(inner) as u32, out_rows.div_ceil(inner) as u32, 1);
        }
        let bytes = (out.len() * 4) as u64;
        encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, bytes);
        let submission = queue.submit(Some(encoder.finish()));
        let slice = staging.slice(..bytes);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(Duration::from_secs(60)),
            })
            .map_err(|e| anyhow!("Capture sharpening poll failed: {}", e))?;
        rx.recv()?
            .map_err(|e| anyhow!("Capture sharpening readback failed: {}", e))?;
        {
            let mapped = slice.get_mapped_range();
            let target: &mut [u8] = bytemuck::cast_slice_mut(out);
            target.copy_from_slice(&mapped);
        }
        staging.unmap();
        release((uniform, bind_group));
    }
    release((luma, blend, output, staging));
    Ok(stops)
}
