use crate::file_management::load_settings;
use crate::formats::is_raw_file;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::apply_cpu_default_raw_processing;
use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, Rgb32FImage};
use rayon::prelude::*;
use std::cmp::Ordering;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const BLOCK_SIZE: usize = 8;
const BLOCK_AREA: usize = 64;
const MAX_GROUP_SIZE: usize = 16;
const STRIDE: usize = 6;
const SEARCH_WINDOW: usize = 19;
const FIXED_POINT_SCALE: f32 = 100_000.0;

#[derive(Clone, Copy)]
struct Bm3dParams {
    sigma: f32,
    hard_th_lambda: f32,
    max_dist_hard: f32,
}

impl Bm3dParams {
    fn from_intensity(i: f32) -> Self {
        let val = i.clamp(0.001, 1.0);
        let sigma = val * 80.0;
        let lambda = 2.0 + (val * 2.5);
        let dist = 3000.0 + (val * 20000.0);

        Self {
            sigma,
            hard_th_lambda: lambda,
            max_dist_hard: dist,
        }
    }
}

pub fn denoise_image(
    path_str: String,
    intensity: f32,
    app_handle: AppHandle,
) -> Result<(DynamicImage, String), String> {
    let path = Path::new(&path_str);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    let is_raw = is_raw_file(&path_str);

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    let _ = app_handle.emit("denoise-progress", "Loading image...");

    let file_bytes = fs::read(path).map_err(|e| e.to_string())?;

    let mut dynamic_img = load_base_image_from_bytes(
        &file_bytes, 
        &path_str, 
        false, 
        highlight_compression, 
        linear_mode, 
        None
    ).map_err(|e| e.to_string())?;

    if is_raw {
        let _ = app_handle.emit("denoise-progress", "Preparing RAW data...");
        apply_cpu_default_raw_processing(&mut dynamic_img);
    }

    let rgb_img_for_denoiser = dynamic_img.to_rgb32f();

    let (width, height) = rgb_img_for_denoiser.dimensions();

    let params = Bm3dParams::from_intensity(intensity);
    let dct_tables = Arc::new(DctTables::new());

    let channels = split_channels(&rgb_img_for_denoiser);

    let patches_x = (width as usize).saturating_sub(BLOCK_SIZE) / STRIDE + 1;
    let patches_y = (height as usize).saturating_sub(BLOCK_SIZE) / STRIDE + 1;
    let total_work_units = (patches_x * patches_y) * 2;
    let progress_counter = Arc::new(AtomicUsize::new(0));

    let _ = app_handle.emit("denoise-progress", "Processing (Step 1/2)...");

    let denoised_channels = bm3d_process_joint(
        &channels,
        width,
        height,
        &params,
        &dct_tables,
        &progress_counter,
        total_work_units,
        &app_handle,
    );

    let _ = app_handle.emit("denoise-progress", "Finalizing data...");
    let out_img_buffer = merge_channels(&denoised_channels, width, height);
    let out_dynamic = DynamicImage::ImageRgb32F(out_img_buffer);

    let _ = app_handle.emit("denoise-progress", "Generating previews...");

    let (w, h) = out_dynamic.dimensions();
    let (new_w, new_h) = if w > h {
        if w > 4000 {
            (4000, (4000.0 * h as f32 / w as f32).round() as u32)
        } else {
            (w, h)
        }
    } else {
        if h > 4000 {
            ((4000.0 * w as f32 / h as f32).round() as u32, 4000)
        } else {
            (w, h)
        }
    };

    let denoised_preview = if new_w != w {
        out_dynamic.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        out_dynamic.clone()
    };

    let mut buf_denoised = Cursor::new(Vec::new());
    denoised_preview
        .to_rgb8()
        .write_to(&mut buf_denoised, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview: {}", e))?;
    let base64_str_denoised = general_purpose::STANDARD.encode(buf_denoised.get_ref());
    let data_url_denoised = format!("data:image/png;base64,{}", base64_str_denoised);

    let original_dynamic = DynamicImage::ImageRgb32F(rgb_img_for_denoiser);
    let original_preview = if new_w != w {
        original_dynamic.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        original_dynamic
    };

    let mut buf_orig = Cursor::new(Vec::new());
    original_preview
        .to_rgb8()
        .write_to(&mut buf_orig, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode original preview: {}", e))?;
    let base64_str_orig = general_purpose::STANDARD.encode(buf_orig.get_ref());
    let data_url_orig = format!("data:image/png;base64,{}", base64_str_orig);

    let payload = serde_json::json!({
        "denoised": data_url_denoised,
        "original": data_url_orig
    });

    let _ = app_handle.emit("denoise-complete", &payload);

    Ok((out_dynamic, data_url_denoised))
}

fn bm3d_process_joint(
    noisy_channels: &[Vec<f32>],
    width: u32,
    height: u32,
    params: &Bm3dParams,
    tables: &DctTables,
    counter: &Arc<AtomicUsize>,
    total_work: usize,
    app_handle: &AppHandle,
) -> Vec<Vec<f32>> {
    let basic_estimate = run_bm3d_step_joint(
        noisy_channels,
        noisy_channels,
        width,
        height,
        params,
        true,
        tables,
        counter,
        total_work,
        app_handle,
    );

    run_bm3d_step_joint(
        noisy_channels,
        &basic_estimate,
        width,
        height,
        params,
        false,
        tables,
        counter,
        total_work,
        app_handle,
    )
}

fn run_bm3d_step_joint(
    noisy: &[Vec<f32>],
    guide: &[Vec<f32>],
    width: u32,
    height: u32,
    params: &Bm3dParams,
    is_step_1: bool,
    tables: &DctTables,
    counter: &Arc<AtomicUsize>,
    total_work: usize,
    app_handle: &AppHandle,
) -> Vec<Vec<f32>> {
    let w = width as usize;
    let h = height as usize;
    let count = w * h;
    let num_channels = 3;

    let mut numerators = Vec::new();
    let mut denominators = Vec::new();
    for _ in 0..num_channels {
        numerators.push(Arc::new(AtomicAccumulator::new(count)));
        denominators.push(Arc::new(AtomicAccumulator::new(count)));
    }

    let mut ref_patches = Vec::with_capacity((w / STRIDE) * (h / STRIDE));
    for y in (0..h.saturating_sub(BLOCK_SIZE)).step_by(STRIDE) {
        for x in (0..w.saturating_sub(BLOCK_SIZE)).step_by(STRIDE) {
            ref_patches.push((x, y));
        }
    }

    ref_patches.par_iter().for_each(|&(rx, ry)| {
        let c = counter.fetch_add(1, AtomicOrdering::Relaxed);
        if c % 200 == 0 {
             let pct = (c as f32 / total_work as f32) * 100.0;
             let step_str = if is_step_1 { "Step 1/2" } else { "Step 2/2" };
             let msg = format!("{} - {:.0}%", step_str, pct);
             let _ = app_handle.emit("denoise-progress", msg);
        }

        let mut group_locs_buf = [(0, 0); MAX_GROUP_SIZE];
        let group_size = block_matching_joint(
            guide,
            w,
            h,
            rx,
            ry,
            is_step_1,
            params,
            &mut group_locs_buf,
        );
        let group_locs = &group_locs_buf[0..group_size];

        for ch in 0..num_channels {
            let guide_ch = &guide[ch];
            let noisy_ch = &noisy[ch];

            let mut guide_stack = build_3d_group(guide_ch, w, group_locs);
            let mut noisy_stack = if is_step_1 {
                guide_stack.clone()
            } else {
                build_3d_group(noisy_ch, w, group_locs)
            };

            transform_3d(&mut guide_stack, group_size, tables);
            if !is_step_1 {
                transform_3d(&mut noisy_stack, group_size, tables);
            }

            let weight;
            if is_step_1 {
                let threshold = params.hard_th_lambda * params.sigma;
                let nonzero = hard_threshold(&mut guide_stack, threshold);
                weight = if nonzero > 0 {
                    1.0 / (nonzero as f32)
                } else {
                    1.0
                };
                noisy_stack = guide_stack;
            } else {
                weight = wiener_filter(&mut noisy_stack, &guide_stack, params.sigma);
            }

            inverse_transform_3d(&mut noisy_stack, group_size, tables);

            let num_acc = &numerators[ch];
            let den_acc = &denominators[ch];

            for (k, &(lx, ly)) in group_locs.iter().enumerate() {
                let patch_offset = k * BLOCK_AREA;
                for dy in 0..BLOCK_SIZE {
                    let row_global = (ly + dy) * w + lx;
                    let row_patch = dy * BLOCK_SIZE;
                    for dx in 0..BLOCK_SIZE {
                        let idx = row_global + dx;
                        let val = noisy_stack[patch_offset + row_patch + dx];
                        let w_val = tables.kaiser[row_patch + dx] * weight;
                        num_acc.add(idx, val * w_val);
                        den_acc.add(idx, w_val);
                    }
                }
            }
        }
    });

    let mut results = Vec::new();
    for ch in 0..num_channels {
        let num_vec = numerators[ch].to_vec();
        let den_vec = denominators[ch].to_vec();
        let final_ch = num_vec
            .iter()
            .zip(den_vec.iter())
            .map(|(&n, &d)| if d > 1e-6 { n / d } else { n })
            .collect();
        results.push(final_ch);
    }
    results
}

fn hard_threshold(stack: &mut [f32], th: f32) -> usize {
    let mut c = 0;
    for (i, x) in stack.iter_mut().enumerate() {
        if i == 0 {
            c += 1;
            continue;
        }

        if x.abs() < th {
            *x = 0.0;
        } else {
            c += 1;
        }
    }
    c
}

fn wiener_filter(noisy: &mut [f32], guide: &[f32], sigma: f32) -> f32 {
    let mut sum = 0.0;
    let s2 = sigma * sigma;
    for (i, (n, g)) in noisy.iter_mut().zip(guide).enumerate() {
        if i == 0 {
            sum += 1.0;
            continue;
        }

        let energy = g * g;
        let coef = energy / (energy + s2 + 1e-5);
        *n *= coef;
        sum += coef * coef;
    }
    if sum > 0.0 {
        1.0 / sum
    } else {
        1.0
    }
}

#[derive(Clone, Copy)]
struct Match {
    dist: f32,
    x: u16,
    y: u16,
}

#[inline(always)]
fn block_matching_joint(
    channels: &[Vec<f32>],
    w: usize,
    h: usize,
    rx: usize,
    ry: usize,
    is_step_1: bool,
    params: &Bm3dParams,
    out_buf: &mut [(usize, usize)],
) -> usize {
    const MAX_CANDIDATES: usize = 1024;
    let mut candidates: [Match; MAX_CANDIDATES] =
        [Match { dist: f32::MAX, x: 0, y: 0 }; MAX_CANDIDATES];
    let mut cand_count = 0;

    let threshold = if is_step_1 {
        params.max_dist_hard
    } else {
        params.max_dist_hard * 0.5
    };

    let mut ref_r = [0.0; 64];
    let mut ref_g = [0.0; 64];
    let mut ref_b = [0.0; 64];
    extract_patch(&channels[0], w, rx, ry, &mut ref_r);
    extract_patch(&channels[1], w, rx, ry, &mut ref_g);
    extract_patch(&channels[2], w, rx, ry, &mut ref_b);

    let half_sw = SEARCH_WINDOW / 2;
    let sx_start = rx.saturating_sub(half_sw);
    let sx_end = (rx + half_sw).min(w.saturating_sub(BLOCK_SIZE));
    let sy_start = ry.saturating_sub(half_sw);
    let sy_end = (ry + half_sw).min(h.saturating_sub(BLOCK_SIZE));

    candidates[0] = Match {
        dist: 0.0,
        x: rx as u16,
        y: ry as u16,
    };
    cand_count += 1;

    for y in sy_start..=sy_end {
        for x in sx_start..=sx_end {
            if x == rx && y == ry {
                continue;
            }

            let d_r = compute_ssd_flat(&channels[0], w, x, y, &ref_r, threshold);
            if d_r > threshold {
                continue;
            }

            let d_g = compute_ssd_flat(&channels[1], w, x, y, &ref_g, threshold - d_r);
            if d_r + d_g > threshold {
                continue;
            }

            let d_b = compute_ssd_flat(&channels[2], w, x, y, &ref_b, threshold - (d_r + d_g));
            let total_dist = d_r + d_g + d_b;

            if total_dist < threshold {
                if cand_count < MAX_CANDIDATES {
                    candidates[cand_count] = Match {
                        dist: total_dist,
                        x: x as u16,
                        y: y as u16,
                    };
                    cand_count += 1;
                }
            }
        }
    }

    let valid_slice = &mut candidates[0..cand_count];
    valid_slice.sort_unstable_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));

    let limit = MAX_GROUP_SIZE.min(cand_count);
    let p2_limit = prev_power_of_two(limit);

    for i in 0..p2_limit {
        out_buf[i] = (valid_slice[i].x as usize, valid_slice[i].y as usize);
    }
    p2_limit
}

#[inline(always)]
fn compute_ssd_flat(
    img: &[f32],
    w: usize,
    x: usize,
    y: usize,
    ref_patch: &[f32],
    stop_thr: f32,
) -> f32 {
    let mut dist = 0.0;
    for dy in 0..8 {
        let img_base = (y + dy) * w + x;
        let ref_base = dy * 8;
        for dx in 0..8 {
            let diff = img[img_base + dx] - ref_patch[ref_base + dx];
            dist += diff * diff;
        }
        if dist > stop_thr {
            return dist;
        }
    }
    dist / BLOCK_AREA as f32
}

#[inline(always)]
fn extract_patch(img: &[f32], w: usize, x: usize, y: usize, out: &mut [f32]) {
    for dy in 0..8 {
        let src_idx = (y + dy) * w + x;
        let dst_idx = dy * 8;
        out[dst_idx..dst_idx + 8].copy_from_slice(&img[src_idx..src_idx + 8]);
    }
}

fn build_3d_group(img: &[f32], w: usize, locs: &[(usize, usize)]) -> Vec<f32> {
    let mut stack = vec![0.0; locs.len() * 64];
    for (i, &(lx, ly)) in locs.iter().enumerate() {
        let offset = i * 64;
        extract_patch(img, w, lx, ly, &mut stack[offset..offset + 64]);
    }
    stack
}

struct DctTables {
    dct_coeff: [f32; 64],
    idct_coeff: [f32; 64],
    kaiser: Vec<f32>,
}

impl DctTables {
    fn new() -> Self {
        let mut dct_coeff = [0.0; 64];
        let mut idct_coeff = [0.0; 64];
        for k in 0..8 {
            for n in 0..8 {
                let c = k as f32 * std::f32::consts::PI / 8.0;
                let val = ((n as f32 + 0.5) * c).cos();
                let scale = if k == 0 { 0.35355339 } else { 0.5 };
                dct_coeff[k * 8 + n] = val * scale;
            }
        }
        for n in 0..8 {
            for k in 0..8 {
                let theta = (std::f32::consts::PI / 8.0) * (n as f32 + 0.5) * (k as f32);
                let scale = if k == 0 { 0.35355339 } else { 0.5 };
                idct_coeff[n * 8 + k] = scale * theta.cos();
            }
        }
        let mut kaiser = vec![0.0; 64];
        for y in 0..8 {
            for x in 0..8 {
                let wx = (std::f32::consts::PI * x as f32 / 7.0).sin();
                let wy = (std::f32::consts::PI * y as f32 / 7.0).sin();
                kaiser[y * 8 + x] = wx * wy;
            }
        }
        Self {
            dct_coeff,
            idct_coeff,
            kaiser,
        }
    }
}

struct AtomicAccumulator {
    data: Vec<AtomicI64>,
}

impl AtomicAccumulator {
    fn new(size: usize) -> Self {
        let mut data = Vec::with_capacity(size);
        for _ in 0..size {
            data.push(AtomicI64::new(0));
        }
        Self { data }
    }
    #[inline(always)]
    fn add(&self, index: usize, value: f32) {
        if index < self.data.len() {
            let fixed = (value * FIXED_POINT_SCALE) as i64;
            self.data[index].fetch_add(fixed, AtomicOrdering::Relaxed);
        }
    }
    fn to_vec(&self) -> Vec<f32> {
        self.data
            .iter()
            .map(|a| a.load(AtomicOrdering::Relaxed) as f32 / FIXED_POINT_SCALE)
            .collect()
    }
}

#[inline(always)]
fn transform_3d(stack: &mut [f32], group_size: usize, tables: &DctTables) {
    for i in 0..group_size {
        let offset = i * 64;
        dct_2d_8x8(&mut stack[offset..offset + 64], &tables.dct_coeff);
    }
    for i in 0..64 {
        let mut col = [0.0; MAX_GROUP_SIZE];
        for k in 0..group_size {
            col[k] = stack[k * 64 + i];
        }
        walsh_hadamard_1d(&mut col[0..group_size]);
        for k in 0..group_size {
            stack[k * 64 + i] = col[k];
        }
    }
}

#[inline(always)]
fn inverse_transform_3d(stack: &mut [f32], group_size: usize, tables: &DctTables) {
    for i in 0..64 {
        let mut col = [0.0; MAX_GROUP_SIZE];
        for k in 0..group_size {
            col[k] = stack[k * 64 + i];
        }
        walsh_hadamard_1d(&mut col[0..group_size]);
        for k in 0..group_size {
            stack[k * 64 + i] = col[k];
        }
    }
    for i in 0..group_size {
        let offset = i * 64;
        idct_2d_8x8(&mut stack[offset..offset + 64], &tables.idct_coeff);
    }
}

#[inline]
fn dct_2d_8x8(block: &mut [f32], coeffs: &[f32; 64]) {
    for i in 0..8 {
        dct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
    transpose_8x8(block);
    for i in 0..8 {
        dct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
    transpose_8x8(block);
}

#[inline]
fn idct_2d_8x8(block: &mut [f32], coeffs: &[f32; 64]) {
    transpose_8x8(block);
    for i in 0..8 {
        idct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
    transpose_8x8(block);
    for i in 0..8 {
        idct_1d_8(&mut block[i * 8..(i + 1) * 8], coeffs);
    }
}

#[inline]
fn dct_1d_8(x: &mut [f32], coeffs: &[f32; 64]) {
    let mut tmp = [0.0; 8];
    tmp.copy_from_slice(x);
    for k in 0..8 {
        let mut s = 0.0;
        let row_start = k * 8;
        for n in 0..8 {
            s += tmp[n] * coeffs[row_start + n];
        }
        x[k] = s;
    }
}

#[inline]
fn idct_1d_8(x: &mut [f32], coeffs: &[f32; 64]) {
    let mut tmp = [0.0; 8];
    tmp.copy_from_slice(x);
    for n in 0..8 {
        let mut s = 0.0;
        let row_start = n * 8;
        for k in 0..8 {
            s += tmp[k] * coeffs[row_start + k];
        }
        x[n] = s;
    }
}

#[inline]
fn transpose_8x8(b: &mut [f32]) {
    for y in 0..8 {
        for x in (y + 1)..8 {
            b.swap(y * 8 + x, x * 8 + y);
        }
    }
}

#[inline]
fn walsh_hadamard_1d(data: &mut [f32]) {
    let n = data.len();
    let mut h = 1;
    while h < n {
        for i in (0..n).step_by(h * 2) {
            for j in i..i + h {
                let x = data[j];
                let y = data[j + h];
                data[j] = x + y;
                data[j + h] = x - y;
            }
        }
        h *= 2;
    }
    let scale = 1.0 / (n as f32).sqrt();
    for x in data {
        *x *= scale;
    }
}

fn split_channels(img: &Rgb32FImage) -> Vec<Vec<f32>> {
    let (w, h) = img.dimensions();
    let size = (w * h) as usize;
    let mut r = vec![0.0; size];
    let mut g = vec![0.0; size];
    let mut b = vec![0.0; size];
    for (i, p) in img.pixels().enumerate() {
        r[i] = p[0] * 255.0;
        g[i] = p[1] * 255.0;
        b[i] = p[2] * 255.0;
    }
    vec![r, g, b]
}

fn merge_channels(channels: &[Vec<f32>], w: u32, h: u32) -> Rgb32FImage {
    let mut img = Rgb32FImage::new(w, h);
    for (i, p) in img.pixels_mut().enumerate() {
        let r = channels[0][i].clamp(0.0, 255.0) / 255.0;
        let g = channels[1][i].clamp(0.0, 255.0) / 255.0;
        let b = channels[2][i].clamp(0.0, 255.0) / 255.0;
        *p = Rgb([r, g, b]);
    }
    img
}

fn prev_power_of_two(x: usize) -> usize {
    if x == 0 {
        return 0;
    }
    let mut p = 1;
    while p * 2 <= x {
        p *= 2;
    }
    p
}