use crate::AppState;
use crate::app_settings::AppSettings;
use crate::formats::is_raw_file;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::{apply_linear_to_srgb, apply_srgb_to_linear};
use image::{DynamicImage, ImageBuffer, Rgb, Rgb32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CalibrationFrames {
    pub dark_frames: Vec<String>,
    pub flat_frames: Vec<String>,
    pub bias_frames: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AstroStackOptions {
    pub paths: Vec<String>,
    pub sigma_clip: f32, // e.g. 2.5
    pub stack_mode: String, // "kappa_sigma", "median", "mean"
    pub auto_dark_subtract: bool,
    pub calibration: Option<CalibrationFrames>,
    pub remove_light_pollution: Option<bool>,
    pub freeze_ground: Option<bool>,
    pub preserve_pedestal: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AstroStackResult {
    pub output_path: Option<String>,
    pub frames_stacked: usize,
    pub stars_aligned: usize,
    pub noise_reduction_ratio: f32,
    pub message: String,
}

#[derive(Debug, Clone)]
struct StarPoint {
    x: f32,
    y: f32,
    brightness: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct RigidTransform2D {
    pub dx: f32,
    pub dy: f32,
    pub dtheta: f32, // Rotation in radians around frame center
}

impl Default for RigidTransform2D {
    fn default() -> Self {
        Self { dx: 0.0, dy: 0.0, dtheta: 0.0 }
    }
}

/// Detects star centroids in a frame using adaptive scene noise-floor statistics (mu + 3*sigma)
fn detect_star_centroids(img: &Rgb32FImage) -> Vec<StarPoint> {
    let (width, height) = img.dimensions();
    let mut stars = Vec::new();

    // 1. Calculate dynamic scene luminance statistics (noise floor)
    let sample_step = 4;
    let mut sum_lum = 0.0f32;
    let mut count = 0.0f32;
    for y in (8..(height - 8)).step_by(sample_step) {
        for x in (8..(width - 8)).step_by(sample_step) {
            let p = img.get_pixel(x, y);
            let lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            sum_lum += lum;
            count += 1.0;
        }
    }
    let mean_lum = if count > 0.0 { sum_lum / count } else { 0.01 };

    let mut var_lum = 0.0f32;
    for y in (8..(height - 8)).step_by(sample_step) {
        for x in (8..(width - 8)).step_by(sample_step) {
            let p = img.get_pixel(x, y);
            let lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            var_lum += (lum - mean_lum).powi(2);
        }
    }
    let std_lum = if count > 1.0 { (var_lum / (count - 1.0)).sqrt() } else { 0.01 };
    let threshold = (mean_lum + 3.0 * std_lum).max(0.012);

    // 2. Scan for local 5x5 luminance maxima
    let step = 2;
    for y in (8..(height - 8)).step_by(step) {
        for x in (8..(width - 8)).step_by(step) {
            let p = img.get_pixel(x, y);
            let lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

            if lum > threshold {
                let mut is_max = true;
                let mut sum_x = 0.0f32;
                let mut sum_y = 0.0f32;
                let mut sum_w = 0.0f32;

                for dy in -2..=2 {
                    for dx in -2..=2 {
                        let nx = (x as i32 + dx) as u32;
                        let ny = (y as i32 + dy) as u32;
                        let np = img.get_pixel(nx, ny);
                        let nlum = 0.2126 * np[0] + 0.7152 * np[1] + 0.0722 * np[2];
                        if (dx != 0 || dy != 0) && nlum >= lum {
                            is_max = false;
                            break;
                        }
                        sum_x += nx as f32 * nlum;
                        sum_y += ny as f32 * nlum;
                        sum_w += nlum;
                    }
                    if !is_max {
                        break;
                    }
                }

                if is_max && sum_w > 0.0 {
                    let cx = sum_x / sum_w;
                    let cy = sum_y / sum_w;
                    stars.push(StarPoint {
                        x: cx,
                        y: cy,
                        brightness: lum,
                    });
                }
            }
        }
    }

    stars.sort_by(|a, b| b.brightness.partial_cmp(&a.brightness).unwrap_or(std::cmp::Ordering::Equal));
    stars.truncate(300); // Keep top 300 brightest stars across the sky
    stars
}

/// Computes 3-DOF rigid star alignment (translation + field rotation) using Procrustes/Kabsch
fn calculate_rigid_alignment(
    ref_stars: &[StarPoint],
    target_stars: &[StarPoint],
    width: f32,
    height: f32,
    max_dist: f32,
) -> RigidTransform2D {
    if ref_stars.is_empty() || target_stars.is_empty() {
        return RigidTransform2D::default();
    }

    let cx = width * 0.5;
    let cy = height * 0.5;

    // Match pairs based on proximity
    let mut matches: Vec<((f32, f32), (f32, f32))> = Vec::new();
    for r in ref_stars.iter().take(80) {
        let mut best_t: Option<&StarPoint> = None;
        let mut best_dist = max_dist;

        for t in target_stars.iter().take(80) {
            let dist = ((r.x - t.x).powi(2) + (r.y - t.y).powi(2)).sqrt();
            if dist < best_dist {
                best_dist = dist;
                best_t = Some(t);
            }
        }

        if let Some(t) = best_t {
            matches.push(((r.x - cx, r.y - cy), (t.x - cx, t.y - cy)));
        }
    }

    if matches.len() < 3 {
        // Fallback to simple translation median if too few pairs
        let mut dx_votes = Vec::new();
        let mut dy_votes = Vec::new();
        for r in ref_stars.iter().take(30) {
            for t in target_stars.iter().take(30) {
                let dx = r.x - t.x;
                let dy = r.y - t.y;
                if dx.abs() < max_dist && dy.abs() < max_dist {
                    dx_votes.push(dx);
                    dy_votes.push(dy);
                }
            }
        }
        if dx_votes.is_empty() {
            return RigidTransform2D::default();
        }
        dx_votes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        dy_votes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        return RigidTransform2D {
            dx: dx_votes[dx_votes.len() / 2],
            dy: dy_votes[dy_votes.len() / 2],
            dtheta: 0.0,
        };
    }

    let n = matches.len() as f32;
    let mean_rx: f32 = matches.iter().map(|m| m.0.0).sum::<f32>() / n;
    let mean_ry: f32 = matches.iter().map(|m| m.0.1).sum::<f32>() / n;
    let mean_tx: f32 = matches.iter().map(|m| m.1.0).sum::<f32>() / n;
    let mean_ty: f32 = matches.iter().map(|m| m.1.1).sum::<f32>() / n;

    let mut h11 = 0.0f32;
    let mut h12 = 0.0f32;
    for &((rx, ry), (tx, ty)) in &matches {
        let prx = rx - mean_rx;
        let pry = ry - mean_ry;
        let ptx = tx - mean_tx;
        let pty = ty - mean_ty;
        h11 += prx * ptx + pry * pty;
        h12 += prx * pty - pry * ptx;
    }

    let dtheta = h12.atan2(h11);
    let dx = mean_rx - mean_tx;
    let dy = mean_ry - mean_ty;

    RigidTransform2D { dx, dy, dtheta }
}

/// Warps an image using continuous 4-point bilinear interpolation with rigid translation and rotation
fn warp_rigid(
    img: &Rgb32FImage,
    transform: RigidTransform2D,
    width: u32,
    height: u32,
) -> Rgb32FImage {
    let mut out = Rgb32FImage::new(width, height);
    let cx = width as f32 * 0.5;
    let cy = height as f32 * 0.5;
    let cos_t = (-transform.dtheta).cos();
    let sin_t = (-transform.dtheta).sin();

    for y in 0..height {
        let y_rel = y as f32 - cy;
        for x in 0..width {
            let x_rel = x as f32 - cx;

            // Rotate around center, then shift
            let rot_x = cos_t * x_rel - sin_t * y_rel + cx;
            let rot_y = sin_t * x_rel + cos_t * y_rel + cy;

            let sx = rot_x - transform.dx;
            let sy = rot_y - transform.dy;

            out.put_pixel(x, y, sample_bilinear(img, sx, sy));
        }
    }
    out
}

/// 4-point bilinear sub-pixel interpolation to preserve 100% of star photon energy
#[inline(always)]
fn sample_bilinear(img: &Rgb32FImage, x: f32, y: f32) -> Rgb<f32> {
    let (w, h) = img.dimensions();
    if x < 0.0 || y < 0.0 || x >= (w - 1) as f32 || y >= (h - 1) as f32 {
        let cx = x.clamp(0.0, (w - 1) as f32) as u32;
        let cy = y.clamp(0.0, (h - 1) as f32) as u32;
        return *img.get_pixel(cx, cy);
    }

    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = x0 + 1;
    let y1 = y0 + 1;

    let fx = x - x0 as f32;
    let fy = y - y0 as f32;

    let p00 = img.get_pixel(x0, y0);
    let p10 = img.get_pixel(x1, y0);
    let p01 = img.get_pixel(x0, y1);
    let p11 = img.get_pixel(x1, y1);

    let w00 = (1.0 - fx) * (1.0 - fy);
    let w10 = fx * (1.0 - fy);
    let w01 = (1.0 - fx) * fy;
    let w11 = fx * fy;

    Rgb([
        p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11,
        p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11,
        p00[2] * w00 + p10[2] * w10 + p01[2] * w01 + p11[2] * w11,
    ])
}

/// Computes median master calibration frame from a list of paths
fn compute_master_median_frame(
    paths: &[String],
    settings: &AppSettings,
    bias_opt: Option<&Rgb32FImage>,
) -> Option<Rgb32FImage> {
    if paths.is_empty() {
        return None;
    }

    let mut frames: Vec<Rgb32FImage> = Vec::new();
    let mut dims: Option<(u32, u32)> = None;

    for path in paths {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(mut dyn_img) = load_base_image_from_bytes(&bytes, path, false, settings, None) {
                if !is_raw_file(path) {
                    dyn_img = apply_srgb_to_linear(dyn_img);
                }
                let rgb32f = dyn_img.to_rgb32f();
                let (w, h) = rgb32f.dimensions();
                if let Some((dw, dh)) = dims {
                    if dw == w && dh == h {
                        frames.push(rgb32f);
                    }
                } else {
                    dims = Some((w, h));
                    frames.push(rgb32f);
                }
            }
        }
    }

    if frames.is_empty() {
        return None;
    }

    let (w, h) = dims.unwrap();
    let n = frames.len();
    let row_stride = (w * 3) as usize;
    let mut out_raw = vec![0.0f32; (w * h * 3) as usize];

    out_raw
        .par_chunks_mut(row_stride)
        .enumerate()
        .for_each(|(y_idx, row_slice)| {
            let y = y_idx as u32;
            let mut r_vals = vec![0.0f32; n];
            let mut g_vals = vec![0.0f32; n];
            let mut b_vals = vec![0.0f32; n];

            for x in 0..w {
                for i in 0..n {
                    let p = frames[i].get_pixel(x, y);
                    r_vals[i] = p[0];
                    g_vals[i] = p[1];
                    b_vals[i] = p[2];
                }
                r_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                g_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                b_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

                let mut med_r = r_vals[n / 2];
                let mut med_g = g_vals[n / 2];
                let mut med_b = b_vals[n / 2];

                if let Some(bias) = bias_opt {
                    let bp = bias.get_pixel(x, y);
                    med_r = (med_r - bp[0]).max(0.0);
                    med_g = (med_g - bp[1]).max(0.0);
                    med_b = (med_b - bp[2]).max(0.0);
                }

                let out_idx = (x * 3) as usize;
                row_slice[out_idx] = med_r;
                row_slice[out_idx + 1] = med_g;
                row_slice[out_idx + 2] = med_b;
            }
        });

    ImageBuffer::<Rgb<f32>, _>::from_raw(w, h, out_raw)
}

/// 2D Polynomial background light-pollution gradient extractor with ambient pedestal preservation
pub fn remove_background_gradient(img: &mut Rgb32FImage, preserve_pedestal: Option<f32>) {
    let (width, height) = img.dimensions();
    let grid_x = 32u32;
    let grid_y = 32u32;
    let tile_w = width / grid_x;
    let tile_h = height / grid_y;

    if tile_w < 4 || tile_h < 4 {
        return;
    }

    // 1. Gather sparse background sample tiles (using 15th percentile to reject stars/nebulae)
    let mut sample_pts: Vec<(f32, f32, f32, f32, f32)> = Vec::new(); // (norm_x, norm_y, r, g, b)

    for gy in 0..grid_y {
        for gx in 0..grid_x {
            let start_x = gx * tile_w;
            let start_y = gy * tile_h;
            let cx = (start_x + tile_w / 2) as f32 / width as f32;
            let cy = (start_y + tile_h / 2) as f32 / height as f32;

            let mut r_tile = Vec::with_capacity((tile_w * tile_h) as usize);
            let mut g_tile = Vec::with_capacity((tile_w * tile_h) as usize);
            let mut b_tile = Vec::with_capacity((tile_w * tile_h) as usize);

            for ty in 0..tile_h {
                for tx in 0..tile_w {
                    let p = img.get_pixel(start_x + tx, start_y + ty);
                    r_tile.push(p[0]);
                    g_tile.push(p[1]);
                    b_tile.push(p[2]);
                }
            }

            r_tile.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            g_tile.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            b_tile.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

            let p15_idx = ((r_tile.len() as f32) * 0.15) as usize;
            let r_bg = r_tile[p15_idx];
            let g_bg = g_tile[p15_idx];
            let b_bg = b_tile[p15_idx];

            sample_pts.push((cx, cy, r_bg, g_bg, b_bg));
        }
    }

    if sample_pts.len() < 10 {
        return;
    }

    // Measure natural median sky baseline so we don't crush the scene into deep darkness
    let mut bg_lumas: Vec<f32> = sample_pts.iter().map(|&(_, _, r, g, b)| 0.2126 * r + 0.7152 * g + 0.0722 * b).collect();
    bg_lumas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let _natural_median_luma = if !bg_lumas.is_empty() { bg_lumas[bg_lumas.len() / 2] } else { 0.08 };

    // 2. Fit 2nd-degree polynomial: B(x, y) = c0 + c1*x + c2*y + c3*x^2 + c4*x*y + c5*y^2
    let mut ata = [[0.0f64; 6]; 6];
    let mut atz_r = [0.0f64; 6];
    let mut atz_g = [0.0f64; 6];
    let mut atz_b = [0.0f64; 6];

    for &(x, y, r, g, b) in &sample_pts {
        let terms = [
            1.0f64,
            x as f64,
            y as f64,
            (x * x) as f64,
            (x * y) as f64,
            (y * y) as f64,
        ];

        for i in 0..6 {
            for j in 0..6 {
                ata[i][j] += terms[i] * terms[j];
            }
            atz_r[i] += terms[i] * r as f64;
            atz_g[i] += terms[i] * g as f64;
            atz_b[i] += terms[i] * b as f64;
        }
    }

    let solve_poly = |ata: &[[f64; 6]; 6], atz: &[f64; 6]| -> [f32; 6] {
        let mut mat = [[0.0f64; 7]; 6];
        for i in 0..6 {
            for j in 0..6 {
                mat[i][j] = ata[i][j];
            }
            mat[i][6] = atz[i];
        }

        // Forward elimination
        for i in 0..6 {
            let mut pivot = i;
            for k in (i + 1)..6 {
                if mat[k][i].abs() > mat[pivot][i].abs() {
                    pivot = k;
                }
            }
            mat.swap(i, pivot);

            let diag = mat[i][i];
            if diag.abs() < 1e-12 {
                continue;
            }
            for j in i..7 {
                mat[i][j] /= diag;
            }

            for k in (i + 1)..6 {
                let factor = mat[k][i];
                for j in i..7 {
                    mat[k][j] -= factor * mat[i][j];
                }
            }
        }

        // Back substitution
        let mut res = [0.0f64; 6];
        for i in (0..6).rev() {
            let mut sum = mat[i][6];
            for j in (i + 1)..6 {
                sum -= mat[i][j] * res[j];
            }
            res[i] = sum;
        }

        [
            res[0] as f32,
            res[1] as f32,
            res[2] as f32,
            res[3] as f32,
            res[4] as f32,
            res[5] as f32,
        ]
    };

    let poly_r = solve_poly(&ata, &atz_r);
    let poly_g = solve_poly(&ata, &atz_g);
    let poly_b = solve_poly(&ata, &atz_b);

    let eval_poly = |c: &[f32; 6], x: f32, y: f32| -> f32 {
        c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * x * y + c[5] * y * y
    };

    // Measure natural minimum baseline across the background grid so we remove ONLY the differential tilt
    let mut min_gr = f32::MAX;
    let mut min_gg = f32::MAX;
    let mut min_gb = f32::MAX;
    for gy in 0..=8 {
        for gx in 0..=8 {
            let xn = gx as f32 / 8.0;
            let yn = gy as f32 / 8.0;
            min_gr = min_gr.min(eval_poly(&poly_r, xn, yn));
            min_gg = min_gg.min(eval_poly(&poly_g, xn, yn));
            min_gb = min_gb.min(eval_poly(&poly_b, xn, yn));
        }
    }

    // Dynamic pedestal baseline (matching the true scene black point without artificial +0.04 lift)
    let baseline_add = preserve_pedestal.unwrap_or(0.0);

    // 3. Parallel per-pixel gradient subtraction
    let row_stride = (width * 3) as usize;
    let raw = img.as_mut();

    raw.par_chunks_mut(row_stride)
        .enumerate()
        .for_each(|(y_idx, row_slice)| {
            let y_norm = y_idx as f32 / height as f32;
            for x in 0..width {
                let x_norm = x as f32 / width as f32;
                let gr = (eval_poly(&poly_r, x_norm, y_norm) - min_gr).max(0.0);
                let gg = (eval_poly(&poly_g, x_norm, y_norm) - min_gg).max(0.0);
                let gb = (eval_poly(&poly_b, x_norm, y_norm) - min_gb).max(0.0);

                let out_idx = (x * 3) as usize;
                row_slice[out_idx] = (row_slice[out_idx] - gr + baseline_add).max(0.0).min(1.0);
                row_slice[out_idx + 1] = (row_slice[out_idx + 1] - gg + baseline_add).max(0.0).min(1.0);
                row_slice[out_idx + 2] = (row_slice[out_idx + 2] - gb + baseline_add).max(0.0).min(1.0);
            }
        });
}

/// Estimates a fast smooth horizon / sky mask for ground freezing
fn generate_sky_mask_proxy(ref_frame: &Rgb32FImage) -> Vec<f32> {
    let (width, height) = ref_frame.dimensions();
    let mut mask = vec![1.0f32; (width * height) as usize];

    // Compute vertical luminance profile
    let mut row_lumas = vec![0.0f32; height as usize];
    for y in 0..height as usize {
        let mut sum = 0.0f32;
        for x in (0..width as usize).step_by(8) {
            let p = ref_frame.get_pixel(x as u32, y as u32);
            sum += 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
        }
        row_lumas[y] = sum / ((width / 8) as f32);
    }

    // Estimate horizon transition line
    let mut min_luma_y = height as usize / 2;
    let mut min_luma = f32::MAX;
    for y in (height as usize / 4)..(height as usize * 3 / 4) {
        if row_lumas[y] < min_luma {
            min_luma = row_lumas[y];
            min_luma_y = y;
        }
    }

    // Feathered gradient across horizon (default to upper 60% sky)
    let horizon_y = (min_luma_y as f32).clamp(height as f32 * 0.35, height as f32 * 0.85);
    let feather_dist = (height as f32 * 0.08).max(20.0);

    for y in 0..height as usize {
        let y_f = y as f32;
        let weight = if y_f <= horizon_y - feather_dist {
            1.0 // Pure sky
        } else if y_f >= horizon_y + feather_dist {
            0.0 // Pure ground
        } else {
            // Smooth Hermite blend
            let t = (horizon_y + feather_dist - y_f) / (2.0 * feather_dist);
            t * t * (3.0 - 2.0 * t)
        };

        let row_offset = y * width as usize;
        for x in 0..width as usize {
            mask[row_offset + x] = weight;
        }
    }

    mask
}

/// Stacks a series of astro frames with sub-pixel alignment, ground freezing, and outlier rejection
pub fn process_astro_stack(
    options: &AstroStackOptions,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    if options.paths.len() < 2 {
        return Err("Astro Stacking requires at least 2 frames".to_string());
    }

    // 1. Process Master Calibration Frames if provided
    let master_bias = if let Some(calib) = &options.calibration {
        if !calib.bias_frames.is_empty() {
            let _ = app_handle.emit("astro-progress", "Creating Master Bias frame...");
            compute_master_median_frame(&calib.bias_frames, settings, None)
        } else {
            None
        }
    } else {
        None
    };

    let master_dark = if let Some(calib) = &options.calibration {
        if !calib.dark_frames.is_empty() {
            let _ = app_handle.emit("astro-progress", "Creating Master Dark frame (thermal noise reduction)...");
            compute_master_median_frame(&calib.dark_frames, settings, master_bias.as_ref())
        } else {
            None
        }
    } else {
        None
    };

    let master_flat = if let Some(calib) = &options.calibration {
        if !calib.flat_frames.is_empty() {
            let _ = app_handle.emit("astro-progress", "Creating Master Flat frame (vignetting & dust reduction)...");
            if let Some(flat) = compute_master_median_frame(&calib.flat_frames, settings, master_bias.as_ref()) {
                let (fw, fh) = flat.dimensions();
                let total_sum: f32 = flat.as_raw().iter().sum();
                let mean_val = (total_sum / flat.as_raw().len() as f32).max(1e-5);
                let normalized_raw: Vec<f32> = flat.into_raw().into_iter().map(|v| (v / mean_val).max(0.01)).collect();
                ImageBuffer::<Rgb<f32>, _>::from_raw(fw, fh, normalized_raw)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let _ = app_handle.emit("astro-progress", "Loading and calibrating astronomical light frames...");

    let mut loaded_raw_frames: Vec<Rgb32FImage> = Vec::new();
    let mut dims: Option<(u32, u32)> = None;

    for (idx, path) in options.paths.iter().enumerate() {
        let _ = app_handle.emit(
            "astro-progress",
            format!(
                "Calibrating frame {}/{} ('{}')...",
                idx + 1,
                options.paths.len(),
                Path::new(path).file_name().unwrap_or_default().to_string_lossy()
            ),
        );

        let file_bytes = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
        let mut dynamic_img = load_base_image_from_bytes(&file_bytes, path, false, settings, None)
            .map_err(|e| format!("Failed to decode {}: {}", path, e))?;

        if !is_raw_file(path) {
            dynamic_img = apply_srgb_to_linear(dynamic_img);
        }

        let mut rgb32f = dynamic_img.to_rgb32f();
        let (w, h) = rgb32f.dimensions();

        if let Some((dw, dh)) = dims {
            if dw != w || dh != h {
                return Err(format!("Frame dimension mismatch: expected {}x{}, got {}x{}", dw, dh, w, h));
            }
        } else {
            dims = Some((w, h));
        }

        // Apply Dark subtraction and Flat division
        if master_dark.is_some() || master_flat.is_some() {
            for y in 0..h {
                for x in 0..w {
                    let mut p = *rgb32f.get_pixel(x, y);
                    if let Some(dark) = &master_dark {
                        let dp = dark.get_pixel(x, y);
                        p[0] = (p[0] - dp[0]).max(0.0);
                        p[1] = (p[1] - dp[1]).max(0.0);
                        p[2] = (p[2] - dp[2]).max(0.0);
                    }
                    if let Some(flat) = &master_flat {
                        let fp = flat.get_pixel(x, y);
                        p[0] = (p[0] / fp[0]).min(1.0);
                        p[1] = (p[1] / fp[1]).min(1.0);
                        p[2] = (p[2] / fp[2]).min(1.0);
                    }
                    rgb32f.put_pixel(x, y, p);
                }
            }
        }

        loaded_raw_frames.push(rgb32f);
    }

    let (width, height) = dims.unwrap();
    let total_frames = loaded_raw_frames.len();

    let _ = app_handle.emit("astro-progress", "Aligning star centroids with sub-pixel precision...");

    // Star detection on reference frame (frame 0)
    let ref_stars = detect_star_centroids(&loaded_raw_frames[0]);

    // Sub-pixel aligned sky frames
    let mut aligned_sky_frames: Vec<Rgb32FImage> = Vec::with_capacity(total_frames);
    aligned_sky_frames.push(loaded_raw_frames[0].clone());

    for i in 1..total_frames {
        let target_stars = detect_star_centroids(&loaded_raw_frames[i]);
        let transform = calculate_rigid_alignment(
            &ref_stars,
            &target_stars,
            width as f32,
            height as f32,
            (width as f32 * 0.15).max(80.0),
        );

        if transform.dx.abs() > 0.05 || transform.dy.abs() > 0.05 || transform.dtheta.abs() > 0.0001 {
            let shifted = warp_rigid(&loaded_raw_frames[i], transform, width, height);
            aligned_sky_frames.push(shifted);
        } else {
            aligned_sky_frames.push(loaded_raw_frames[i].clone());
        }
    }

    // Sky segmentation mask for landscape ground freezing
    let freeze_ground = options.freeze_ground.unwrap_or(true);
    let sky_mask = if freeze_ground {
        generate_sky_mask_proxy(&loaded_raw_frames[0])
    } else {
        vec![1.0f32; (width * height) as usize]
    };

    let _ = app_handle.emit("astro-progress", "Performing high-speed Kappa-Sigma clipping stack... 0%");

    let kappa = if options.sigma_clip > 0.5 { options.sigma_clip } else { 2.5 };
    let sky_raws: Vec<&[f32]> = aligned_sky_frames.iter().map(|f| f.as_raw().as_slice()).collect();
    let ground_raws: Vec<&[f32]> = loaded_raw_frames.iter().map(|f| f.as_raw().as_slice()).collect();

    let row_stride = (width * 3) as usize;
    let mut out_raw = vec![0.0f32; (width * height * 3) as usize];
    let completed_rows = std::sync::atomic::AtomicUsize::new(0);

    out_raw
        .par_chunks_mut(row_stride)
        .enumerate()
        .for_each(|(y_idx, row_slice)| {
            let y = y_idx as usize;
            let mut sky_r = vec![0.0f32; total_frames];
            let mut sky_g = vec![0.0f32; total_frames];
            let mut sky_b = vec![0.0f32; total_frames];

            let mut gnd_r = vec![0.0f32; total_frames];
            let mut gnd_g = vec![0.0f32; total_frames];
            let mut gnd_b = vec![0.0f32; total_frames];

            for x in 0..width as usize {
                let pixel_offset = (y * width as usize + x) * 3;
                let sky_weight = sky_mask[y * width as usize + x];

                for i in 0..total_frames {
                    let s_raw = sky_raws[i];
                    sky_r[i] = s_raw[pixel_offset];
                    sky_g[i] = s_raw[pixel_offset + 1];
                    sky_b[i] = s_raw[pixel_offset + 2];

                    if freeze_ground && sky_weight < 0.99 {
                        let g_raw = ground_raws[i];
                        gnd_r[i] = g_raw[pixel_offset];
                        gnd_g[i] = g_raw[pixel_offset + 1];
                        gnd_b[i] = g_raw[pixel_offset + 2];
                    }
                }

                // Stack sky pixels (Kappa-Sigma outlier rejection)
                let (sr, sg, sb) = if options.stack_mode == "median" {
                    sky_r.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    sky_g.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    sky_b.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    (sky_r[total_frames / 2], sky_g[total_frames / 2], sky_b[total_frames / 2])
                } else {
                    (
                        kappa_sigma_mean(&sky_r, kappa),
                        kappa_sigma_mean(&sky_g, kappa),
                        kappa_sigma_mean(&sky_b, kappa),
                    )
                };

                // Blend with frozen ground stack if applicable
                let (final_r, final_g, final_b) = if freeze_ground && sky_weight < 0.99 {
                    gnd_r.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    gnd_g.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    gnd_b.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let (gr, gg, gb) = (gnd_r[total_frames / 2], gnd_g[total_frames / 2], gnd_b[total_frames / 2]);

                    (
                        sr * sky_weight + gr * (1.0 - sky_weight),
                        sg * sky_weight + gg * (1.0 - sky_weight),
                        sb * sky_weight + gb * (1.0 - sky_weight),
                    )
                } else {
                    (sr, sg, sb)
                };

                let out_idx = x * 3;
                row_slice[out_idx] = final_r;
                row_slice[out_idx + 1] = final_g;
                row_slice[out_idx + 2] = final_b;
            }

            let done = completed_rows.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if done % 64 == 0 || done == height as usize - 1 {
                let pct = ((done as f32 / height as f32) * 100.0).min(100.0) as u32;
                let _ = app_handle.emit("astro-progress", format!("Performing Kappa-Sigma clipping stack... {}%", pct));
            }
        });

    let mut buffer = ImageBuffer::<Rgb<f32>, _>::from_raw(width, height, out_raw)
        .ok_or_else(|| "Failed to construct stacked image buffer".to_string())?;

    // Optional 2D Light-Pollution Gradient Removal with Pedestal Retention
    if options.remove_light_pollution.unwrap_or(true) {
        let _ = app_handle.emit("astro-progress", "Neutralizing light-pollution gradient while preserving natural celestial exposure...");
        remove_background_gradient(&mut buffer, options.preserve_pedestal);
        neutralize_star_cores(&mut buffer);
    }

    let final_dyn = DynamicImage::ImageRgb32F(buffer);
    let _ = app_handle.emit("astro-progress", "Astro stacking complete!");

    Ok(final_dyn)
}

/// Robust Astronomical Kappa-Sigma Outlier Clipping (PixInsight / Siril standard)
fn kappa_sigma_mean(values: &[f32], kappa: f32) -> f32 {
    let n = values.len();
    if n <= 2 {
        return values.iter().sum::<f32>() / n as f32;
    }

    // 1. Robust Median estimator
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[n / 2];

    // 2. Median Absolute Deviation (MAD) -> Robust Standard Deviation (sigma = 1.4826 * MAD)
    let mut dev: Vec<f32> = sorted.iter().map(|&v| (v - median).abs()).collect();
    dev.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mad = dev[n / 2];
    let robust_sigma = (1.4826 * mad).max(1e-5);

    // 3. Asymmetric Sigma Clipping (reject satellite streaks, cosmic rays, planes)
    let low_thr = median - (kappa * 1.2) * robust_sigma;
    let high_thr = median + kappa * robust_sigma;

    let mut kept_sum = 0.0f32;
    let mut kept_count = 0.0f32;

    for &v in values {
        if v >= low_thr && v <= high_thr {
            kept_sum += v;
            kept_count += 1.0;
        }
    }

    if kept_count > 0.0 {
        kept_sum / kept_count
    } else {
        median
    }
}

#[tauri::command]
pub fn stack_astro_frames(
    options: AstroStackOptions,
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    use std::io::Cursor;

    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("stack_astro_frames");
    let settings = AppSettings::default();
    let stacked_image = process_astro_stack(&options, &app_handle, &settings)?;

    let _ = app_handle.emit("astro-progress", "Creating calibrated preview... 100%");

    // Ensure sRGB gamma is applied to preview so the output image does not suffer from linear darkening
    let srgb_preview = apply_linear_to_srgb(stacked_image.clone());

    let mut buf = Cursor::new(Vec::new());
    if let Err(e) = srgb_preview.to_rgb8().write_to(&mut buf, image::ImageFormat::Png) {
        return Err(format!("Failed to encode astro preview: {}", e));
    }

    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    let final_base64 = format!("data:image/png;base64,{}", base64_str);

    let mut hdr_guard = state.hdr_result.lock().map_err(|e| e.to_string())?;
    *hdr_guard = Some(stacked_image);

    let _ = app_handle.emit(
        "hdr-complete",
        serde_json::json!({
            "base64": final_base64,
        }),
    );

    Ok("Astro stack completed successfully".to_string())
}

#[tauri::command]
pub fn remove_active_light_pollution_gradient(
    preserve_pedestal: Option<f32>,
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("remove_light_pollution");
    let mut orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded_image) = &mut *orig_guard {
        let _ = app_handle.emit("astro-progress", "Extracting 2D background gradient...");
        let mut rgb32f = loaded_image.image.to_rgb32f();
        remove_background_gradient(&mut rgb32f, preserve_pedestal);

        let updated_dyn = DynamicImage::ImageRgb32F(rgb32f);
        let new_proxy = crate::fast_resizer::fast_downscale_dynamic(&updated_dyn, 2560, 2560);
        loaded_image.screen_proxy = Some(std::sync::Arc::new(new_proxy));
        loaded_image.image = std::sync::Arc::new(updated_dyn.clone());

        if let Ok(mut preview_guard) = state.cached_preview.lock()
            && let Some(cached) = &mut *preview_guard
        {
            cached.image = std::sync::Arc::new(updated_dyn);
        }

        let _ = app_handle.emit("astro-progress", "Light-pollution gradient removed successfully!");
        Ok("Light pollution gradient removed".to_string())
    } else {
        Err("No active image loaded".to_string())
    }
}

pub fn neutralize_star_cores(img: &mut Rgb32FImage) {
    let (width, _height) = img.dimensions();
    let row_stride = (width * 3) as usize;
    img.as_mut()
        .par_chunks_mut(row_stride)
        .for_each(|row| {
            for x in 0..width as usize {
                let idx = x * 3;
                let r = row[idx];
                let g = row[idx + 1];
                let b = row[idx + 2];
                let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

                if luma > 0.85 {
                    let factor = ((luma - 0.85) / 0.15).clamp(0.0, 1.0);
                    row[idx] = r * (1.0 - factor) + luma * factor;
                    row[idx + 1] = g * (1.0 - factor) + luma * factor;
                    row[idx + 2] = b * (1.0 - factor) + luma * factor;
                }
            }
        });
}

/// Automated Atmospheric Dispersion Corrector (ADC)
/// Removes starlight prism splitting (red/blue fringing) caused by low-altitude Earth atmospheric refraction
pub fn auto_align_atmospheric_dispersion(img: &mut Rgb32FImage) {
    let (w, h) = img.dimensions();
    if w < 64 || h < 64 {
        return;
    }

    // Measure vertical starlight centroid shift between Red and Blue relative to Green
    let mut sum_dy_red = 0.0f32;
    let mut sum_dy_blue = 0.0f32;
    let mut samples = 0.0f32;

    for y in (16..(h - 16)).step_by(8) {
        for x in (16..(w - 16)).step_by(8) {
            let p = img.get_pixel(x, y);
            let g = p[1];
            if g > 0.4 {
                // High brightness star candidate
                let p_up = img.get_pixel(x, y - 1);
                let p_down = img.get_pixel(x, y + 1);

                let g_grad_y = (p_down[1] - p_up[1]) * 0.5;
                let r_grad_y = (p_down[0] - p_up[0]) * 0.5;
                let b_grad_y = (p_down[2] - p_up[2]) * 0.5;

                if g_grad_y.abs() > 0.05 {
                    sum_dy_red += (r_grad_y - g_grad_y) * 2.0;
                    sum_dy_blue += (b_grad_y - g_grad_y) * 2.0;
                    samples += 1.0;
                }
            }
        }
    }

    if samples > 10.0 {
        let avg_dy_red = (sum_dy_red / samples).clamp(-2.0, 2.0);
        let avg_dy_blue = (sum_dy_blue / samples).clamp(-2.0, 2.0);

        apply_atmospheric_dispersion_shifts(img, (0.0, -avg_dy_red), (0.0, -avg_dy_blue));
    }
}

/// Shifts the Red and Blue color channels by sub-pixel offsets (dx, dy) relative to Green
pub fn apply_atmospheric_dispersion_shifts(img: &mut Rgb32FImage, red_shift: (f32, f32), blue_shift: (f32, f32)) {
    let (w, h) = img.dimensions();
    let orig = img.clone();
    let row_stride = (w * 3) as usize;
    let raw = img.as_mut();

    raw.par_chunks_mut(row_stride)
        .enumerate()
        .for_each(|(y_idx, row_slice)| {
            let y = y_idx as u32;
            for x in 0..w {
                let out_idx = (x * 3) as usize;

                // Red channel shifted
                let rx = (x as f32 + red_shift.0).clamp(0.0, (w - 1) as f32);
                let ry = (y as f32 + red_shift.1).clamp(0.0, (h - 1) as f32);
                let red_sample = sample_bilinear(&orig, rx, ry)[0];

                // Blue channel shifted
                let bx = (x as f32 + blue_shift.0).clamp(0.0, (w - 1) as f32);
                let by = (y as f32 + blue_shift.1).clamp(0.0, (h - 1) as f32);
                let blue_sample = sample_bilinear(&orig, bx, by)[2];

                row_slice[out_idx] = red_sample;
                // Green remains unaltered optical reference anchor
                row_slice[out_idx + 2] = blue_sample;
            }
        });
}

/// Star Trails Stacking with optional exponential Comet Tail decay
pub fn stack_star_trails_burst(
    paths: &[String],
    comet_decay: bool,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    if paths.len() < 2 {
        return Err("Star trails stacking requires at least 2 frames".to_string());
    }

    let total = paths.len();
    let (ref_source, _) = crate::file_management::parse_virtual_path(&paths[0]);
    let ref_bytes = fs::read(&ref_source).map_err(|e| e.to_string())?;
    let mut composite = load_base_image_from_bytes(&ref_bytes, &ref_source.to_string_lossy(), false, settings, None)
        .map_err(|e| e.to_string())?
        .to_rgb32f();

    let (w, h) = composite.dimensions();

    for (idx, path_str) in paths.iter().enumerate().skip(1) {
        let _ = app_handle.emit(
            "astro-progress",
            format!("Merging Star Trail frame {}/{}...", idx + 1, total),
        );

        let (src_path, _) = crate::file_management::parse_virtual_path(path_str);
        if let Ok(bytes) = fs::read(&src_path) {
            if let Ok(dyn_img) = load_base_image_from_bytes(&bytes, &src_path.to_string_lossy(), false, settings, None) {
                let frame_rgb = dyn_img.to_rgb32f();
                if frame_rgb.dimensions() == (w, h) {
                    // Decay factor for comet mode: older frames fade out smoothly
                    let weight = if comet_decay {
                        ((idx as f32 / total as f32).powf(0.8)).clamp(0.15, 1.0)
                    } else {
                        1.0
                    };

                    composite
                        .as_mut()
                        .par_chunks_mut((w * 3) as usize)
                        .zip(frame_rgb.as_raw().par_chunks((w * 3) as usize))
                        .for_each(|(comp_row, frame_row)| {
                            for (c_px, f_px) in comp_row.chunks_mut(3).zip(frame_row.chunks(3)) {
                                let f_weighted_r = f_px[0] * weight;
                                let f_weighted_g = f_px[1] * weight;
                                let f_weighted_b = f_px[2] * weight;

                                c_px[0] = c_px[0].max(f_weighted_r);
                                c_px[1] = c_px[1].max(f_weighted_g);
                                c_px[2] = c_px[2].max(f_weighted_b);
                            }
                        });
                }
            }
        }
    }

    Ok(DynamicImage::ImageRgb32F(composite))
}

/// Landscape Astrophotography Ground-Freeze Stacking
/// Freezes mountains/trees while aligning and stacking rotating celestial stars
pub fn stack_landscape_ground_freeze_burst(
    options: &AstroStackOptions,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    let mut opts_freeze = options.clone();
    opts_freeze.freeze_ground = Some(true);
    process_astro_stack(&opts_freeze, app_handle, settings)
}

#[tauri::command]
pub fn stack_star_trails(
    paths: Vec<String>,
    comet_decay: Option<bool>,
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("stack_star_trails");
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    let decay = comet_decay.unwrap_or(false);
    let hdr_handle = state.hdr_result.clone();

    tauri::async_runtime::spawn_blocking(move || {
        match stack_star_trails_burst(&paths, decay, &app_handle, &settings) {
            Ok(img) => {
                *hdr_handle.lock().unwrap() = Some(img);
                let _ = app_handle.emit("hdr-complete", serde_json::json!({ "message": "Star trails complete!" }));
            }
            Err(e) => {
                let _ = app_handle.emit("astro-error", e);
            }
        }
    });

    Ok("Star trails stacking started".to_string())
}

#[tauri::command]
pub fn apply_adc_active(
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    let mut orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded) = &mut *orig_guard {
        let mut rgb32f = loaded.image.to_rgb32f();
        auto_align_atmospheric_dispersion(&mut rgb32f);
        let updated = DynamicImage::ImageRgb32F(rgb32f);
        loaded.image = std::sync::Arc::new(updated);
        let _ = app_handle.emit("astro-progress", "Atmospheric dispersion corrected!");
        Ok("Atmospheric dispersion corrected".to_string())
    } else {
        Err("No active image loaded".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_star_centroid_subpixel_detection() {
        let (w, h) = (64u32, 64u32);
        let mut img = Rgb32FImage::from_pixel(w, h, Rgb([0.02, 0.02, 0.02]));

        // Synthesize a sub-pixel Gaussian star centered at (30.4, 25.6)
        let star_x = 30.4f32;
        let star_y = 25.6f32;
        for y in 20..32 {
            for x in 24..36 {
                let dx = x as f32 - star_x;
                let dy = y as f32 - star_y;
                let d2 = dx * dx + dy * dy;
                let val = 0.8 * (-d2 / 2.0).exp();
                img.put_pixel(x, y, Rgb([val, val, val]));
            }
        }

        let detected = detect_star_centroids(&img);
        assert!(!detected.is_empty(), "Centroid detector must identify the synthesized star");
        let best_star = &detected[0];
        assert!((best_star.x - star_x).abs() < 0.35, "Centroid X subpixel precision: got {}", best_star.x);
        assert!((best_star.y - star_y).abs() < 0.35, "Centroid Y subpixel precision: got {}", best_star.y);
    }

    #[test]
    fn test_kappa_sigma_clipping_rejects_cosmic_ray_and_satellite() {
        // 5 aligned sub-frames with constant star signal of 0.20 + one cosmic ray spike of 1.00 on frame 3
        let values = [0.20f32, 0.21f32, 0.19f32, 1.00f32, 0.20f32];
        let stacked = kappa_sigma_mean(&values, 2.0);

        // Result should be tightly clustered around 0.20 and reject the 1.00 cosmic ray
        assert!(stacked < 0.25, "Kappa-Sigma must reject cosmic ray outlier: got {}", stacked);
        assert!(stacked >= 0.19, "Kappa-Sigma must preserve true photon signal: got {}", stacked);
    }

    #[test]
    fn test_real_world_astro_dataset_if_present() {
        let test_dir = std::path::Path::new(r"D:\neapdirbti");
        if !test_dir.exists() {
            return;
        }

        let astro_files = [
            test_dir.join("IMG_5037.CR2"),
            test_dir.join("IMG_5038.CR2"),
        ];

        let all_exist = astro_files.iter().all(|f| f.exists());
        if all_exist {
            for f in &astro_files {
                let is_raw = crate::formats::is_raw_file(&*f.to_string_lossy());
                assert!(is_raw, "Astro CR2 frame must be recognized as RAW");
            }
        }
    }
}

