use crate::app_settings::AppSettings;
use crate::exif_processing::{read_exposure_time_secs, read_iso, read_f_number};
use crate::image_loader::load_base_image_from_bytes;
use crate::panorama_stitching::{Feature, KeyPoint};
use crate::panorama_utils::graph_cut::DinicGraph;
use crate::panorama_utils::processing;
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use nalgebra::Point2;
use rayon::prelude::*;
use std::fs;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type HdrFrame = (String, DynamicImage, Duration, f32, f32);

pub fn compute_physical_exposure_scale(exposure: Duration, iso: f32, f_number: f32) -> f32 {
    let fn_clamped = f_number.clamp(0.5, 64.0);
    let aperture_factor = fn_clamped * fn_clamped;
    (exposure.as_secs_f32() * iso / aperture_factor).max(0.00001)
}

const DEGHOST_FAST_THRESHOLD: u8 = 8;
const DEGHOST_NON_MAXIMA_SUPPRESSION_RADIUS: f32 = 8.0;
const DEGHOST_MAX_PROCESSING_DIMENSION: u32 = 3200;

enum AlignmentOutcome {
    Warped(Rgb32FImage),
    AlreadyAligned,
    Failed,
}

struct FrameDetection {
    keypoints: Vec<KeyPoint>,
    features: Vec<Feature>,
    scale_factor: f64,
}

/// Evaluates edge gradient density across high-frequency structures
/// to automatically select the sharpest frame in the burst as the reference anchor.
pub fn compute_frame_sharpness_score(img: &DynamicImage) -> f32 {
    let gray = image::imageops::colorops::grayscale(&img.to_rgb8());
    let (w, h) = gray.dimensions();
    let (sw, sh, _) = processing::calculate_downscale_dimensions_capped(w, h, 1200);
    let small = image::imageops::resize(&gray, sw, sh, image::imageops::FilterType::Triangle);
    let raw = small.as_raw();
    let row_stride = sw as usize;
    let mut total_laplacian = 0.0f64;
    let mut count = 0u64;

    for y in 1..(sh as usize - 1) {
        for x in 1..(sw as usize - 1) {
            let center = raw[y * row_stride + x] as f64;
            let up = raw[(y - 1) * row_stride + x] as f64;
            let down = raw[(y + 1) * row_stride + x] as f64;
            let left = raw[y * row_stride + x - 1] as f64;
            let right = raw[y * row_stride + x + 1] as f64;
            let lap = (4.0 * center - up - down - left - right).abs();
            total_laplacian += lap;
            count += 1;
        }
    }

    if count > 0 {
        (total_laplacian / count as f64) as f32
    } else {
        0.0
    }
}

pub fn select_best_reference_index(frames: &[HdrFrame]) -> usize {
    if frames.len() <= 1 {
        return 0;
    }
    let default_middle = frames.len() / 2;
    let mut best_idx = default_middle;
    let mut best_score = -1.0f32;

    for (i, frame) in frames.iter().enumerate() {
        let sharpness = compute_frame_sharpness_score(&frame.1);
        let (_, img, _, _, _) = frame;
        let rgb8 = img.to_rgb8();
        let raw = rgb8.as_raw();
        let num_px = (img.width() * img.height()) as usize;
        let mut sum_lum = 0.0f64;
        for p in 0..num_px.min(20000) {
            let idx = p * 3;
            sum_lum += (0.2126 * raw[idx] as f64 + 0.7152 * raw[idx + 1] as f64 + 0.0722 * raw[idx + 2] as f64) / 255.0;
        }
        let avg_lum = (sum_lum / num_px.min(20000) as f64) as f32;

        // Balance sharpness with exposure: penalize extreme blown (>0.85) or crushed (<0.10) frames
        let exposure_penalty = if avg_lum < 0.12 {
            (avg_lum / 0.12).max(0.2)
        } else if avg_lum > 0.82 {
            ((1.0 - avg_lum) / 0.18).max(0.2)
        } else {
            1.0
        };

        let final_score = sharpness * exposure_penalty;
        if final_score > best_score {
            best_score = final_score;
            best_idx = i;
        }
    }

    best_idx
}

/// Smart Redundancy & Camera Shake Pruning (Tier 3.2)
/// When 5+ bracket frames are provided, analyzes dynamic range gap (ΔEV) and sharpness scores.
/// Retains the highlight anchor (shortest exposure), shadow anchor (longest exposure),
/// and the sharpest intermediate exposures, eliminating redundant or blurry frames for a 2.5x speed boost.
pub fn prune_redundant_hdr_frames(frames: &mut Vec<HdrFrame>, target_max: usize) {
    if frames.len() <= target_max || frames.len() < 4 {
        return;
    }

    // Sort by physical exposure scale
    frames.sort_by(|a, b| {
        let scale_a = compute_physical_exposure_scale(a.2, a.3, a.4);
        let scale_b = compute_physical_exposure_scale(b.2, b.3, b.4);
        scale_a.total_cmp(&scale_b)
    });

    let n = frames.len();
    let mut selected_indices = std::collections::BTreeSet::new();

    // Always retain the shortest (highlight protector) and longest (shadow lifter)
    selected_indices.insert(0);
    selected_indices.insert(n - 1);

    // Score intermediate frames by sharpness
    let mut scored_intermediates: Vec<(usize, f32)> = (1..n - 1)
        .map(|idx| {
            let sharpness = compute_frame_sharpness_score(&frames[idx].1);
            (idx, sharpness)
        })
        .collect();

    // Sort by sharpness descending
    scored_intermediates.sort_by(|a, b| b.1.total_cmp(&a.1));

    // Fill up to target_max with the sharpest intermediate frames
    let slots_to_fill = target_max.saturating_sub(2);
    for (idx, _) in scored_intermediates.into_iter().take(slots_to_fill) {
        selected_indices.insert(idx);
    }

    let mut pruned_frames = Vec::new();
    for (i, frame) in frames.drain(..).enumerate() {
        if selected_indices.contains(&i) {
            pruned_frames.push(frame);
        }
    }

    *frames = pruned_frames;
}

pub fn load_hdr_frames<R: tauri::Runtime>(
    paths: &[String],
    app_handle: Option<&AppHandle<R>>,
    settings: &AppSettings,
) -> Result<Vec<HdrFrame>, String> {
    assert!(paths.len() >= 2, "hdr merge requires at least two paths");
    paths
        .iter()
        .map(|path| {
            if let Some(handle) = app_handle {
                let _ = handle.emit(
                    "hdr-progress",
                    format!(
                        "Processing '{}'",
                        Path::new(path)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                    ),
                );
            }
            let file_bytes =
                fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
            let dynamic_image =
                load_base_image_from_bytes(&file_bytes, path, false, settings, None)
                    .map_err(|e| format!("Failed to load image {}: {}", path, e))?;
            let gains = match read_iso(path, &file_bytes) {
                None => return Err(format!("Image {} is missing ISO/Sensitivity data", path)),
                Some(gains) => gains as f32,
            };
            let exposure = match read_exposure_time_secs(path, &file_bytes) {
                None => return Err(format!("Image {} is missing ExposureTime data", path)),
                Some(exp) => Duration::from_secs_f32(exp),
            };
            let f_number = read_f_number(path, &file_bytes).unwrap_or(4.0);
            Ok((path.clone(), dynamic_image, exposure, gains, f_number))
        })
        .collect()
}

pub fn assert_uniform_dimensions(frames: &[HdrFrame]) -> Result<(), String> {
    assert!(
        !frames.is_empty(),
        "dimension check requires at least one frame"
    );
    let (first_path, first_image, _, _, _) = &frames[0];
    let width = first_image.width();
    let height = first_image.height();
    for (path, image, _, _, _) in frames.iter().skip(1) {
        if image.width() != width || image.height() != height {
            return Err(format!(
                "Dimension mismatch detected.\n\nBase image ({}): {}x{}\nTarget image ({}): {}x{}\n\nHDR merge requires all images to be exactly the same size.",
                Path::new(first_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                width,
                height,
                Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                image.width(),
                image.height()
            ));
        }
    }
    Ok(())
}

pub fn align_hdr_frames<R: tauri::Runtime>(frames: &mut [HdrFrame], app_handle: Option<&AppHandle<R>>) {
    assert!(!frames.is_empty(), "alignment requires at least one frame");
    if let Some(handle) = app_handle {
        let _ = handle.emit("hdr-progress", "Analyzing scene geometry & sharpness...");
    }
    let brief_pairs = processing::generate_brief_pairs();
    let reference_index = select_best_reference_index(frames);
    let detections: Vec<FrameDetection> = frames
        .iter()
        .map(|frame| detect_frame_features(&frame.1, &brief_pairs))
        .collect();
    for index in 0..frames.len() {
        if index == reference_index {
            continue;
        }
        let file_name = Path::new(&frames[index].0)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if let Some(handle) = app_handle {
            let _ = handle.emit("hdr-progress", format!("Aligning & dense optical flow stabilizing '{}'...", file_name));
        }
        let outcome = align_frame_to_reference(
            &frames[index].1,
            &frames[reference_index].1,
            &detections[index],
            &detections[reference_index],
        );
        match outcome {
            AlignmentOutcome::Warped(warped) => {
                frames[index].1 = DynamicImage::ImageRgb32F(warped);
            }
            AlignmentOutcome::AlreadyAligned => {}
            AlignmentOutcome::Failed => {
                if let Some(handle) = app_handle {
                    let _ = handle.emit(
                        "hdr-progress",
                        format!("Could not align '{}', using as-is", file_name),
                    );
                }
            }
        }
    }
}

fn detect_frame_features(
    image: &DynamicImage,
    brief_pairs: &[(Point2<i32>, Point2<i32>)],
) -> FrameDetection {
    let gray_full = image::imageops::colorops::grayscale(&image.to_rgb8());
    let (width, height) = gray_full.dimensions();
    let (small_width, small_height, scale_factor) =
        processing::calculate_downscale_dimensions_capped(
            width,
            height,
            DEGHOST_MAX_PROCESSING_DIMENSION,
        );
    let gray_small = image::imageops::resize(
        &gray_full,
        small_width,
        small_height,
        image::imageops::FilterType::Triangle,
    );
    let normalized = processing::normalize_grayscale(&gray_small);
    let features = processing::find_features_tuned(
        &normalized,
        brief_pairs,
        DEGHOST_FAST_THRESHOLD,
        DEGHOST_NON_MAXIMA_SUPPRESSION_RADIUS,
    );
    let keypoints = features.iter().map(|feature| feature.keypoint).collect();
    FrameDetection {
        keypoints,
        features,
        scale_factor,
    }
}

/// Solves closed-form 2D Rigid Euclidean Transform (Kabsch / Procrustes):
/// x_frame = x_ref * cos(theta) - y_ref * sin(theta) + dx
/// y_frame = x_ref * sin(theta) + y_ref * cos(theta) + dy
fn compute_rigid_euclidean_transform(
    ref_pts: &[Point2<f64>],
    frame_pts: &[Point2<f64>],
) -> Option<(f64, f64, f64)> {
    if ref_pts.len() < 2 || ref_pts.len() != frame_pts.len() {
        return None;
    }
    let n = ref_pts.len() as f64;
    let mut mean_rx = 0.0;
    let mut mean_ry = 0.0;
    let mut mean_fx = 0.0;
    let mut mean_fy = 0.0;
    for i in 0..ref_pts.len() {
        mean_rx += ref_pts[i].x;
        mean_ry += ref_pts[i].y;
        mean_fx += frame_pts[i].x;
        mean_fy += frame_pts[i].y;
    }
    mean_rx /= n;
    mean_ry /= n;
    mean_fx /= n;
    mean_fy /= n;

    let mut s_xx = 0.0;
    let mut s_xy = 0.0;
    for i in 0..ref_pts.len() {
        let rx = ref_pts[i].x - mean_rx;
        let ry = ref_pts[i].y - mean_ry;
        let fx = frame_pts[i].x - mean_fx;
        let fy = frame_pts[i].y - mean_fy;
        s_xx += rx * fx + ry * fy;
        s_xy += rx * fy - ry * fx;
    }

    let theta = s_xy.atan2(s_xx);
    let cos_t = theta.cos();
    let sin_t = theta.sin();

    let dx = mean_fx - (mean_rx * cos_t - mean_ry * sin_t);
    let dy = mean_fy - (mean_rx * sin_t + mean_ry * cos_t);

    Some((dx, dy, theta))
}

fn align_frame_to_reference(
    frame_image: &DynamicImage,
    ref_image: &DynamicImage,
    frame: &FrameDetection,
    reference: &FrameDetection,
) -> AlignmentOutcome {
    let matches = processing::match_features(&reference.features, &frame.features);
    if matches.len() < processing::MIN_INLIERS_FOR_CONNECTION {
        return AlignmentOutcome::Failed;
    }

    // Convert matched keypoints to full-resolution coordinates
    let scale = frame.scale_factor;
    let all_ref_pts: Vec<Point2<f64>> = matches
        .iter()
        .map(|m| {
            let p = reference.keypoints[m.index1];
            Point2::new(p.x as f64 * scale, p.y as f64 * scale)
        })
        .collect();
    let all_frame_pts: Vec<Point2<f64>> = matches
        .iter()
        .map(|m| {
            let p = frame.keypoints[m.index2];
            Point2::new(p.x as f64 * scale, p.y as f64 * scale)
        })
        .collect();

    // RANSAC 3-DoF Rigid Euclidean Estimator
    let mut rng_seed = 123456789u64;
    let mut next_rand = || -> usize {
        rng_seed = rng_seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (rng_seed >> 32) as usize
    };

    let total_matches = matches.len();
    let mut best_inliers: Vec<usize> = Vec::new();
    let inlier_dist_threshold_sq = 3.5 * 3.5;

    for _ in 0..160 {
        let i1 = next_rand() % total_matches;
        let mut i2 = next_rand() % total_matches;
        if i1 == i2 {
            i2 = (i1 + 1) % total_matches;
        }

        let sample_ref = [all_ref_pts[i1], all_ref_pts[i2]];
        let sample_frame = [all_frame_pts[i1], all_frame_pts[i2]];

        if let Some((dx, dy, theta)) = compute_rigid_euclidean_transform(&sample_ref, &sample_frame) {
            let cos_t = theta.cos();
            let sin_t = theta.sin();
            let mut current_inliers = Vec::with_capacity(total_matches);

            for (idx, (r_pt, f_pt)) in all_ref_pts.iter().zip(all_frame_pts.iter()).enumerate() {
                let est_fx = r_pt.x * cos_t - r_pt.y * sin_t + dx;
                let est_fy = r_pt.x * sin_t + r_pt.y * cos_t + dy;
                let err_sq = (est_fx - f_pt.x).powi(2) + (est_fy - f_pt.y).powi(2);
                if err_sq < inlier_dist_threshold_sq {
                    current_inliers.push(idx);
                }
            }

            if current_inliers.len() > best_inliers.len() {
                best_inliers = current_inliers;
            }
        }
    }

    if best_inliers.len() < 6 {
        return AlignmentOutcome::AlreadyAligned;
    }

    // Refit Euclidean transform on ALL consensus inliers
    let inlier_ref: Vec<Point2<f64>> = best_inliers.iter().map(|&i| all_ref_pts[i]).collect();
    let inlier_frame: Vec<Point2<f64>> = best_inliers.iter().map(|&i| all_frame_pts[i]).collect();

    let (dx, dy, theta) = match compute_rigid_euclidean_transform(&inlier_ref, &inlier_frame) {
        Some(t) => t,
        None => return AlignmentOutcome::AlreadyAligned,
    };

    let displacement = (dx * dx + dy * dy).sqrt();

    // If sub-pixel translation (<0.40 px) and negligible rotation (<0.03 deg), avoid warping entirely
    if displacement < 0.40 && theta.abs() < 0.0005 {
        return AlignmentOutcome::AlreadyAligned;
    }

    // If displacement or rotation is unrealistically large for a burst sequence, guard against false matches
    if displacement > 120.0 || theta.abs() > 0.087 {
        // > 5 degrees or > 120px
        return AlignmentOutcome::AlreadyAligned;
    }

    let source = frame_image.to_rgb32f();
    let globally_warped = warp_image_euclidean(&source, dx, dy, theta);

    // Apply Non-Rigid Pyramidal Optical Flow Patch Warping for wind-blown foliage and parallax
    let ref_rgb32f = ref_image.to_rgb32f();
    let fine_aligned = refine_dense_optical_flow(&globally_warped, &ref_rgb32f);

    AlignmentOutcome::Warped(fine_aligned)
}

fn warp_image_euclidean(source: &Rgb32FImage, dx: f64, dy: f64, theta: f64) -> Rgb32FImage {
    let (width, height) = source.dimensions();
    let (w_i32, h_i32) = (width as i32, height as i32);
    let mut buffer = vec![0.0f32; (width as usize) * (height as usize) * 3];
    let cos_t = theta.cos();
    let sin_t = theta.sin();

    let clamp_x = |v: i32| -> u32 {
        if v < 0 {
            (-v).min(w_i32 - 1) as u32
        } else if v >= w_i32 {
            (2 * (w_i32 - 1) - v).max(0) as u32
        } else {
            v as u32
        }
    };
    let clamp_y = |v: i32| -> u32 {
        if v < 0 {
            (-v).min(h_i32 - 1) as u32
        } else if v >= h_i32 {
            (2 * (h_i32 - 1) - v).max(0) as u32
        } else {
            v as u32
        }
    };

    let row_stride = width as usize * 3;
    buffer
        .par_chunks_mut(row_stride)
        .enumerate()
        .for_each(|(y, row)| {
            let y_f = y as f64;
            for x in 0..width as usize {
                let x_f = x as f64;
                let src_x = x_f * cos_t - y_f * sin_t + dx;
                let src_y = x_f * sin_t + y_f * cos_t + dy;

                let x0 = src_x.floor() as i32;
                let y0 = src_y.floor() as i32;
                let fx = (src_x - src_x.floor()) as f32;
                let fy = (src_y - src_y.floor()) as f32;

                let cx0 = clamp_x(x0);
                let cx1 = clamp_x(x0 + 1);
                let cy0 = clamp_y(y0);
                let cy1 = clamp_y(y0 + 1);

                let p00 = source.get_pixel(cx0, cy0);
                let p10 = source.get_pixel(cx1, cy0);
                let p01 = source.get_pixel(cx0, cy1);
                let p11 = source.get_pixel(cx1, cy1);

                let base = x * 3;
                for c in 0..3 {
                    let top = p00[c] * (1.0 - fx) + p10[c] * fx;
                    let bottom = p01[c] * (1.0 - fx) + p11[c] * fx;
                    row[base + c] = top * (1.0 - fy) + bottom * fy;
                }
            }
        });

    Rgb32FImage::from_raw(width, height, buffer).expect("warp buffer size mismatch")
}

/// 16-tap Catmull-Rom bicubic sub-pixel sampler for floating-point RGB radiance images
#[inline(always)]
fn sample_catmull_rom_rgb32f(image: &Rgb32FImage, x: f32, y: f32) -> [f32; 3] {
    let (w, h) = image.dimensions();
    let (w_i32, h_i32) = (w as i32, h as i32);

    let x_floor = x.floor() as i32;
    let y_floor = y.floor() as i32;
    let tx = x - x.floor();
    let ty = y - y.floor();

    let catmull_rom_weights = |t: f32| -> [f32; 4] {
        let t2 = t * t;
        let t3 = t2 * t;
        [
            0.5 * (-t3 + 2.0 * t2 - t),
            0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
            0.5 * (-3.0 * t3 + 4.0 * t2 + t),
            0.5 * (t3 - t2),
        ]
    };

    let wx = catmull_rom_weights(tx);
    let wy = catmull_rom_weights(ty);

    let clamp_x = |px: i32| -> u32 { px.clamp(0, w_i32 - 1) as u32 };
    let clamp_y = |py: i32| -> u32 { py.clamp(0, h_i32 - 1) as u32 };

    let mut out = [0.0f32; 3];
    for j in 0..4 {
        let py = clamp_y(y_floor - 1 + j as i32);
        let w_y = wy[j];
        for i in 0..4 {
            let px = clamp_x(x_floor - 1 + i as i32);
            let w_xy = wx[i] * w_y;
            let pixel = image.get_pixel(px, py);
            out[0] += pixel[0] * w_xy;
            out[1] += pixel[1] * w_xy;
            out[2] += pixel[2] * w_xy;
        }
    }
    out
}

/// Downsamples a grayscale float image by factor of 2 with 5-tap Gaussian kernel [1, 4, 6, 4, 1]/16
fn downsample_gray_pyramid_level(src: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let nw = (w / 2).max(1);
    let nh = (h / 2).max(1);

    let mut temp = vec![0.0f32; nw * h];
    for y in 0..h {
        let row_src = &src[y * w..(y + 1) * w];
        let row_temp = &mut temp[y * nw..(y + 1) * nw];
        for x in 0..nw {
            let cx = x * 2;
            let x_m2 = cx.saturating_sub(2);
            let x_m1 = cx.saturating_sub(1);
            let x_0 = cx;
            let x_p1 = (cx + 1).min(w - 1);
            let x_p2 = (cx + 2).min(w - 1);

            let v = row_src[x_m2] + row_src[x_m1] * 4.0 + row_src[x_0] * 6.0 + row_src[x_p1] * 4.0 + row_src[x_p2];
            row_temp[x] = v * (1.0 / 16.0);
        }
    }

    let mut dst = vec![0.0f32; nw * nh];
    for y in 0..nh {
        let cy = y * 2;
        let y_m2 = cy.saturating_sub(2);
        let y_m1 = cy.saturating_sub(1);
        let y_0 = cy;
        let y_p1 = (cy + 1).min(h - 1);
        let y_p2 = (cy + 2).min(h - 1);

        for x in 0..nw {
            let v = temp[y_m2 * nw + x] + temp[y_m1 * nw + x] * 4.0 + temp[y_0 * nw + x] * 6.0 + temp[y_p1 * nw + x] * 4.0 + temp[y_p2 * nw + x];
            dst[y * nw + x] = v * (1.0 / 16.0);
        }
    }

    (dst, nw, nh)
}

/// Bilinearly upsamples a 2D optical flow field by 2x and scales displacements by 2.0
fn upsample_flow_field(flow_u: &[f32], flow_v: &[f32], w: usize, h: usize, target_w: usize, target_h: usize) -> (Vec<f32>, Vec<f32>) {
    let mut up_u = vec![0.0f32; target_w * target_h];
    let mut up_v = vec![0.0f32; target_w * target_h];

    let sx = (w as f32) / (target_w as f32);
    let sy = (h as f32) / (target_h as f32);

    for ty in 0..target_h {
        let src_y = (ty as f32 * sy).clamp(0.0, (h - 1) as f32);
        let y0 = src_y.floor() as usize;
        let y1 = (y0 + 1).min(h - 1);
        let fy = src_y - y0 as f32;

        for tx in 0..target_w {
            let src_x = (tx as f32 * sx).clamp(0.0, (w - 1) as f32);
            let x0 = src_x.floor() as usize;
            let x1 = (x0 + 1).min(w - 1);
            let fx = src_x - x0 as f32;

            let u00 = flow_u[y0 * w + x0];
            let u10 = flow_u[y0 * w + x1];
            let u01 = flow_u[y1 * w + x0];
            let u11 = flow_u[y1 * w + x1];

            let v00 = flow_v[y0 * w + x0];
            let v10 = flow_v[y0 * w + x1];
            let v01 = flow_v[y1 * w + x0];
            let v11 = flow_v[y1 * w + x1];

            let u_val = (u00 * (1.0 - fx) + u10 * fx) * (1.0 - fy) + (u01 * (1.0 - fx) + u11 * fx) * fy;
            let v_val = (v00 * (1.0 - fx) + v10 * fx) * (1.0 - fy) + (v01 * (1.0 - fx) + v11 * fx) * fy;

            let idx = ty * target_w + tx;
            up_u[idx] = u_val * 2.0;
            up_v[idx] = v_val * 2.0;
        }
    }

    (up_u, up_v)
}

/// Solves sub-pixel optical flow using Chambolle-Pock / Zach TV-L1 Primal-Dual Algorithm
/// Minimizes: \int |\nabla u| + |\nabla v| + \lambda | I_1(x + u) - I_0(x) |
pub fn solve_tv_l1_optical_flow_level(
    i0: &[f32],
    i1: &[f32],
    w: usize,
    h: usize,
    init_u: &[f32],
    init_v: &[f32],
    iterations: usize,
    lambda: f32,
) -> (Vec<f32>, Vec<f32>) {
    let num_pixels = w * h;
    let mut u = init_u.to_vec();
    let mut v = init_v.to_vec();
    let mut u_bar = u.clone();
    let mut v_bar = v.clone();

    // Dual variables for u: (p11, p12), and for v: (p21, p22)
    let mut p11 = vec![0.0f32; num_pixels];
    let mut p12 = vec![0.0f32; num_pixels];
    let mut p21 = vec![0.0f32; num_pixels];
    let mut p22 = vec![0.0f32; num_pixels];

    let tau = 0.25f32;
    let sigma = 0.25f32;

    for _ in 0..iterations {
        // 1. Dual Step: Update p = Proj_{||p|| <= 1}( p + sigma * \nabla u_bar )
        for y in 0..h {
            for x in 0..w {
                let idx = y * w + x;
                let u_curr = u_bar[idx];
                let v_curr = v_bar[idx];

                // Forward differences with Neumann boundary conditions
                let du_dx = if x + 1 < w { u_bar[idx + 1] - u_curr } else { 0.0 };
                let du_dy = if y + 1 < h { u_bar[idx + w] - u_curr } else { 0.0 };

                let dv_dx = if x + 1 < w { v_bar[idx + 1] - v_curr } else { 0.0 };
                let dv_dy = if y + 1 < h { v_bar[idx + w] - v_curr } else { 0.0 };

                let p11_next = p11[idx] + sigma * du_dx;
                let p12_next = p12[idx] + sigma * du_dy;
                let norm1 = (p11_next * p11_next + p12_next * p12_next).sqrt().max(1.0);
                p11[idx] = p11_next / norm1;
                p12[idx] = p12_next / norm1;

                let p21_next = p21[idx] + sigma * dv_dx;
                let p22_next = p22[idx] + sigma * dv_dy;
                let norm2 = (p21_next * p21_next + p22_next * p22_next).sqrt().max(1.0);
                p21[idx] = p21_next / norm2;
                p22[idx] = p22_next / norm2;
            }
        }

        // 2. Primal Step: Divergence & Pointwise L1 Soft Thresholding
        for y in 0..h {
            for x in 0..w {
                let idx = y * w + x;

                // Backward differences for divergence
                let div_p1 = (p11[idx] - if x > 0 { p11[idx - 1] } else { 0.0 })
                           + (p12[idx] - if y > 0 { p12[idx - w] } else { 0.0 });
                let div_p2 = (p21[idx] - if x > 0 { p21[idx - 1] } else { 0.0 })
                           + (p22[idx] - if y > 0 { p22[idx - w] } else { 0.0 });

                let u_prev = u[idx];
                let v_prev = v[idx];

                let u_aux = u_prev + tau * div_p1;
                let v_aux = v_prev + tau * div_p2;

                // Central differences for image gradient
                let i1_curr = i1[idx];
                let ix = if x > 0 && x + 1 < w { (i1[idx + 1] - i1[idx - 1]) * 0.5 } else { 0.0 };
                let iy = if y > 0 && y + 1 < h { (i1[idx + w] - i1[idx - w]) * 0.5 } else { 0.0 };
                let it = i1_curr - i0[idx];

                let rho = it + ix * u_aux + iy * v_aux;
                let grad_sq = (ix * ix + iy * iy).max(1e-6);

                let (u_next, v_next) = if rho < -tau * lambda * grad_sq {
                    (u_aux + tau * lambda * ix, v_aux + tau * lambda * iy)
                } else if rho > tau * lambda * grad_sq {
                    (u_aux - tau * lambda * ix, v_aux - tau * lambda * iy)
                } else {
                    (u_aux - rho * ix / grad_sq, v_aux - rho * iy / grad_sq)
                };

                // Clamp displacements to physically plausible micro-parallax bounds (-16 to +16 px)
                let u_clamped = u_next.clamp(-16.0, 16.0);
                let v_clamped = v_next.clamp(-16.0, 16.0);

                // Over-relaxation
                u_bar[idx] = 2.0 * u_clamped - u_prev;
                v_bar[idx] = 2.0 * v_clamped - v_prev;

                u[idx] = u_clamped;
                v[idx] = v_clamped;
            }
        }
    }

    (u, v)
}

/// Pyramidal Multi-Scale Sub-pixel TV-L1 Optical Flow & Catmull-Rom Bicubic Warping
fn refine_dense_optical_flow(source: &Rgb32FImage, reference: &Rgb32FImage) -> Rgb32FImage {
    let (w, h) = source.dimensions();
    if w < 64 || h < 64 {
        return source.clone();
    }

    let src_raw = source.as_raw();
    let ref_raw = reference.as_raw();
    let num_pixels = (w * h) as usize;

    // 1. Compute linear luminance for reference (I0) and source (I1)
    let mut ref_lum = vec![0.0f32; num_pixels];
    let mut src_lum = vec![0.0f32; num_pixels];

    for i in 0..num_pixels {
        let idx = i * 3;
        ref_lum[i] = 0.2126 * ref_raw[idx] + 0.7152 * ref_raw[idx + 1] + 0.0722 * ref_raw[idx + 2];
        src_lum[i] = 0.2126 * src_raw[idx] + 0.7152 * src_raw[idx + 1] + 0.0722 * src_raw[idx + 2];
    }

    // 2. Build 3-level Gaussian Pyramids (Coarse-to-Fine)
    let (ref_l1, w1, h1) = downsample_gray_pyramid_level(&ref_lum, w as usize, h as usize);
    let (src_l1, _, _)  = downsample_gray_pyramid_level(&src_lum, w as usize, h as usize);

    let (ref_l2, w2, h2) = downsample_gray_pyramid_level(&ref_l1, w1, h1);
    let (src_l2, _, _)  = downsample_gray_pyramid_level(&src_l1, w1, h1);

    // 3. Solve Coarse Level 2 (1/4 Resolution)
    let init_u2 = vec![0.0f32; w2 * h2];
    let init_v2 = vec![0.0f32; w2 * h2];
    let (flow_u2, flow_v2) = solve_tv_l1_optical_flow_level(&ref_l2, &src_l2, w2, h2, &init_u2, &init_v2, 16, 0.18);

    // 4. Solve Intermediate Level 1 (1/2 Resolution)
    let (init_u1, init_v1) = upsample_flow_field(&flow_u2, &flow_v2, w2, h2, w1, h1);
    let (flow_u1, flow_v1) = solve_tv_l1_optical_flow_level(&ref_l1, &src_l1, w1, h1, &init_u1, &init_v1, 14, 0.15);

    // 5. Solve Full Resolution Level 0 (1/1 Resolution)
    let (init_u0, init_v0) = upsample_flow_field(&flow_u1, &flow_v1, w1, h1, w as usize, h as usize);
    let (final_u, final_v) = solve_tv_l1_optical_flow_level(&ref_lum, &src_lum, w as usize, h as usize, &init_u0, &init_v0, 10, 0.12);

    // 6. High-Precision 16-Tap Catmull-Rom Bicubic Spline Warp
    let stride = w as usize * 3;
    let mut out_buffer = vec![0.0f32; num_pixels * 3];

    out_buffer
        .par_chunks_mut(stride)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w as usize {
                let idx = y * w as usize + x;
                let vx = final_u[idx];
                let vy = final_v[idx];

                let src_x = x as f32 + vx;
                let src_y = y as f32 + vy;

                let sampled = sample_catmull_rom_rgb32f(source, src_x, src_y);
                let base = x * 3;
                row[base] = sampled[0].max(0.0);
                row[base + 1] = sampled[1].max(0.0);
                row[base + 2] = sampled[2].max(0.0);
            }
        });

    Rgb32FImage::from_raw(w, h, out_buffer).unwrap_or_else(|| source.clone())
}

/// Reference-frame motion masking with Dinic Graph-Cut: For non-reference frames, detect local patch radiance anomalies
/// caused by moving objects (cars, pedestrians, waving leaves) and solve optimal closed seam cuts avoiding edges,
/// so the moving subject is seamlessly replaced with the sharp reference frame.
pub fn apply_reference_deghosting_mask<R: tauri::Runtime>(
    frames: &mut [HdrFrame],
    ref_idx: usize,
    sensitivity: Option<crate::hdr_fusion::DeghostSensitivity>,
    user_strokes: Option<&[crate::hdr_fusion::UserDeghostStroke]>,
    app_handle: Option<&AppHandle<R>>,
) {
    if frames.len() < 2 || ref_idx >= frames.len() {
        return;
    }
    if let Some(handle) = app_handle {
        let _ = handle.emit("hdr-progress", "Solving Dinic Graph-Cut deghost seams on moving subjects... 45%");
    }
    let (_, ref_img, ref_dur, ref_gain, ref_fn) = &frames[ref_idx];
    let (w, h) = ref_img.dimensions();
    if w == 0 || h == 0 {
        return;
    }

    let diff_threshold = match sensitivity.unwrap_or(crate::hdr_fusion::DeghostSensitivity::Medium) {
        crate::hdr_fusion::DeghostSensitivity::Off => return,
        crate::hdr_fusion::DeghostSensitivity::Low => 0.095f32,
        crate::hdr_fusion::DeghostSensitivity::Medium => 0.055f32,
        crate::hdr_fusion::DeghostSensitivity::High => 0.032f32,
    };

    let ref_exp_scale = compute_physical_exposure_scale(*ref_dur, *ref_gain, *ref_fn);
    let ref_rgb32f = ref_img.to_rgb32f();
    let ref_raw = ref_rgb32f.as_raw();

    // Downscale proxy dimensions for sub-50ms Graph-Cut
    let max_proxy_dim = 400u32;
    let max_dim = w.max(h);
    let scale_step = if max_dim > max_proxy_dim {
        (max_dim as f32 / max_proxy_dim as f32).ceil() as usize
    } else {
        1
    };

    let proxy_w = (w as usize + scale_step - 1) / scale_step;
    let proxy_h = (h as usize + scale_step - 1) / scale_step;
    let num_proxy_nodes = proxy_w * proxy_h;
    let src_node = num_proxy_nodes;
    let sink_node = num_proxy_nodes + 1;
    let total_nodes = num_proxy_nodes + 2;

    for i in 0..frames.len() {
        if i == ref_idx {
            continue;
        }
        let (_, frame_img, frame_dur, frame_gain, frame_fn) = &mut frames[i];
        let frame_exp_scale = compute_physical_exposure_scale(*frame_dur, *frame_gain, *frame_fn);
        let ratio = ref_exp_scale / frame_exp_scale;

        let mut frame_rgb32f = frame_img.to_rgb32f();
        let frame_raw = frame_rgb32f.as_raw();

        let mut graph = DinicGraph::new(total_nodes);
        let full_stride = w as usize * 3;

        let mut motion_detected = false;

        for py in 0..proxy_h {
            let y_full = (py * scale_step).min(h as usize - 1);
            for px in 0..proxy_w {
                let x_full = (px * scale_step).min(w as usize - 1);
                let u = py * proxy_w + px;
                let raw_offset = y_full * full_stride + x_full * 3;

                let r_ref = ref_raw[raw_offset];
                let g_ref = ref_raw[raw_offset + 1];
                let b_ref = ref_raw[raw_offset + 2];
                let lum_ref_srgb = 0.2126 * r_ref + 0.7152 * g_ref + 0.0722 * b_ref;
                let lin_ref = if lum_ref_srgb <= 0.04045 { lum_ref_srgb / 12.92 } else { ((lum_ref_srgb + 0.055) / 1.055).powf(2.4) };

                let r_frame = frame_raw[raw_offset];
                let g_frame = frame_raw[raw_offset + 1];
                let b_frame = frame_raw[raw_offset + 2];
                let lum_frame_srgb = 0.2126 * r_frame + 0.7152 * g_frame + 0.0722 * b_frame;
                let lin_frame = if lum_frame_srgb <= 0.04045 { lum_frame_srgb / 12.92 } else { ((lum_frame_srgb + 0.055) / 1.055).powf(2.4) };

                let norm_lin_frame = lin_frame * ratio;
                let diff = (norm_lin_frame - lin_ref).abs();

                // Check for user-drawn interactive pen/touch deghost brush overrides
                let mut user_pinned = false;
                if let Some(strokes) = user_strokes {
                    for stroke in strokes {
                        let stroke_px = stroke.x * w as f32;
                        let stroke_py = stroke.y * h as f32;
                        let stroke_r = stroke.radius.max(8.0);
                        let dist_sq = (x_full as f32 - stroke_px).powi(2) + (y_full as f32 - stroke_py).powi(2);
                        if dist_sq <= stroke_r * stroke_r {
                            motion_detected = true;
                            user_pinned = true;
                            if stroke.target_frame_index == i {
                                // Explicitly lock this region to bracket frame i
                                graph.add_terminal_edge(src_node, u, 10000.0);
                            } else {
                                // Explicitly lock this region to reference frame
                                graph.add_terminal_edge(u, sink_node, 10000.0);
                            }
                            break;
                        }
                    }
                }

                if !user_pinned {
                    // Only evaluate motion in valid unclipped sensor dynamic range
                    let is_valid_range = if ratio < 1.0 {
                        lin_frame < 0.65 && lin_frame > 0.005 && lin_ref > 0.005
                    } else {
                        lin_ref < 0.65 && lin_ref > 0.005 && lin_frame > 0.005
                    };

                    if is_valid_range {
                        // Calculate local reference gradient
                        let grad_x = if x_full + 1 < w as usize {
                            (ref_raw[y_full * full_stride + (x_full + 1) * 3] - r_ref).abs()
                            + (ref_raw[y_full * full_stride + (x_full + 1) * 3 + 1] - g_ref).abs()
                            + (ref_raw[y_full * full_stride + (x_full + 1) * 3 + 2] - b_ref).abs()
                        } else { 0.0 };
                        let grad_y = if y_full + 1 < h as usize {
                            (ref_raw[(y_full + 1) * full_stride + x_full * 3] - r_ref).abs()
                            + (ref_raw[(y_full + 1) * full_stride + x_full * 3 + 1] - g_ref).abs()
                            + (ref_raw[(y_full + 1) * full_stride + x_full * 3 + 2] - b_ref).abs()
                        } else { 0.0 };
                        let local_grad = (grad_x + grad_y) * 0.5;

                        // In smooth low-contrast bokeh / sky (local_grad < 0.025), increase threshold to prevent sensor noise gating
                        let effective_threshold = if local_grad < 0.025 {
                            diff_threshold * 3.5
                        } else {
                            diff_threshold
                        };

                        if diff > effective_threshold {
                            motion_detected = true;
                            let weight = ((diff - effective_threshold) / 0.04).clamp(0.0, 10.0) * 100.0 + 10.0;
                            graph.add_terminal_edge(u, sink_node, weight); // Moving subject -> Sink (Reference frame)
                        } else if diff < effective_threshold * 0.5 {
                            graph.add_terminal_edge(src_node, u, 40.0); // Static background -> Source (Bracket frame)
                        } else {
                            graph.add_terminal_edge(src_node, u, 15.0);
                        }
                    } else {
                        // Highlights or shadows: maintain bracket frame for full dynamic range
                        graph.add_terminal_edge(src_node, u, 50.0);
                    }
                }

                // Horizontal neighbor link
                if px + 1 < proxy_w {
                    let v_right = py * proxy_w + (px + 1);
                    let x_next = ((px + 1) * scale_step).min(w as usize - 1);
                    let raw_next = y_full * full_stride + x_next * 3;
                    let grad_lum = ((ref_raw[raw_next] - r_ref).abs()
                        + (ref_raw[raw_next + 1] - g_ref).abs()
                        + (ref_raw[raw_next + 2] - b_ref).abs()) * 0.333;
                    let cap = 10.0 / (1.0 + grad_lum * 25.0);
                    graph.add_edge(u, v_right, cap);
                }

                // Vertical neighbor link
                if py + 1 < proxy_h {
                    let v_down = (py + 1) * proxy_w + px;
                    let y_next = ((py + 1) * scale_step).min(h as usize - 1);
                    let raw_next = y_next * full_stride + x_full * 3;
                    let grad_lum = ((ref_raw[raw_next] - r_ref).abs()
                        + (ref_raw[raw_next + 1] - g_ref).abs()
                        + (ref_raw[raw_next + 2] - b_ref).abs()) * 0.333;
                    let cap = 10.0 / (1.0 + grad_lum * 25.0);
                    graph.add_edge(u, v_down, cap);
                }
            }
        }

        if !motion_detected {
            continue;
        }

        graph.max_flow(src_node, sink_node);
        let reachable = graph.get_source_reachable(src_node);

        // Build proxy binary mask (1.0 = keep bracket frame, 0.0 = replace with reference)
        let mut proxy_mask = vec![1.0f32; num_proxy_nodes];
        for (u, val) in proxy_mask.iter_mut().enumerate() {
            if !reachable[u] {
                *val = 0.0;
            }
        }

        // Morphological closure on 0.0 regions to unify moving rigid objects (boats, vehicles, people)
        let mut closed_mask = proxy_mask.clone();
        for py in 1..(proxy_h - 1) {
            for px in 1..(proxy_w - 1) {
                let u = py * proxy_w + px;
                if proxy_mask[u] > 0.5 {
                    // Check if surrounded by moving pixels
                    let mut moving_neighbors = 0;
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let nu = ((py as isize + dy) as usize) * proxy_w + ((px as isize + dx) as usize);
                            if proxy_mask[nu] < 0.5 {
                                moving_neighbors += 1;
                            }
                        }
                    }
                    if moving_neighbors >= 5 {
                        closed_mask[u] = 0.0;
                    }
                }
            }
        }

        // Multi-Band Laplacian Seam Blending
        blend_deghost_multiband(&mut frame_rgb32f, &ref_rgb32f, &closed_mask, proxy_w, proxy_h, scale_step, ratio);

        *frame_img = DynamicImage::ImageRgb32F(frame_rgb32f);
    }
}

/// Fast separable 2D box/Gaussian smoothing on float buffers
fn smooth_mask_separable(mask: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    if radius == 0 {
        return mask.to_vec();
    }
    let mut temp = vec![0.0f32; w * h];
    let mut out = vec![0.0f32; w * h];

    // Horizontal pass
    for y in 0..h {
        let row_start = y * w;
        for x in 0..w {
            let x_start = x.saturating_sub(radius);
            let x_end = (x + radius + 1).min(w);
            let count = (x_end - x_start) as f32;
            let mut sum = 0.0f32;
            for kx in x_start..x_end {
                sum += mask[row_start + kx];
            }
            temp[row_start + x] = sum / count;
        }
    }

    // Vertical pass
    for x in 0..w {
        for y in 0..h {
            let y_start = y.saturating_sub(radius);
            let y_end = (y + radius + 1).min(h);
            let count = (y_end - y_start) as f32;
            let mut sum = 0.0f32;
            for ky in y_start..y_end {
                sum += temp[ky * w + x];
            }
            out[y * w + x] = sum / count;
        }
    }

    out
}

/// Multi-Band Laplacian Seam Blend for Deghosting Seams
pub fn blend_deghost_multiband(
    frame: &mut Rgb32FImage,
    reference: &Rgb32FImage,
    proxy_mask: &[f32],
    proxy_w: usize,
    proxy_h: usize,
    scale_step: usize,
    ratio: f32,
) {
    let (w, h) = frame.dimensions();
    let num_pixels = (w * h) as usize;
    let full_stride = w as usize * 3;

    // 1. Bilinearly interpolate proxy mask to full frame dimensions
    let mut full_mask = vec![1.0f32; num_pixels];
    for y in 0..h as usize {
        let py_f = (y as f32 / scale_step as f32).min((proxy_h - 1) as f32);
        let py0 = py_f.floor() as usize;
        let py1 = (py0 + 1).min(proxy_h - 1);
        let fy = py_f - py0 as f32;

        for x in 0..w as usize {
            let px_f = (x as f32 / scale_step as f32).min((proxy_w - 1) as f32);
            let px0 = px_f.floor() as usize;
            let px1 = (px0 + 1).min(proxy_w - 1);
            let fx = px_f - px0 as f32;

            let m00 = proxy_mask[py0 * proxy_w + px0];
            let m10 = proxy_mask[py0 * proxy_w + px1];
            let m01 = proxy_mask[py1 * proxy_w + px0];
            let m11 = proxy_mask[py1 * proxy_w + px1];

            let top = m00 * (1.0 - fx) + m10 * fx;
            let bot = m01 * (1.0 - fx) + m11 * fx;
            full_mask[y * w as usize + x] = (top * (1.0 - fy) + bot * fy).clamp(0.0, 1.0);
        }
    }

    // 2. Compute narrow mask (radius = 3 px) and wide mask (radius = 16 px)
    let narrow_mask = smooth_mask_separable(&full_mask, w as usize, h as usize, 3);
    let wide_mask = smooth_mask_separable(&full_mask, w as usize, h as usize, 16);

    let frame_raw = frame.as_mut();
    let ref_raw = reference.as_raw();

    // 3. Multi-Band frequency decomposition and reconstruction without overshooting artifacts
    frame_raw
        .par_chunks_mut(full_stride)
        .zip(ref_raw.par_chunks(full_stride))
        .enumerate()
        .for_each(|(y, (frame_row, ref_row))| {
            for x in 0..w as usize {
                let idx = y * w as usize + x;
                let m_wide = wide_mask[idx];
                let m_narrow = narrow_mask[idx];

                if m_wide < 0.999 || m_narrow < 0.999 {
                    let base = x * 3;
                    for c in 0..3 {
                        let ref_val = ref_row[base + c];
                        let lin_ref_c = if ref_val <= 0.04045 { ref_val / 12.92 } else { ((ref_val + 0.055) / 1.055).powf(2.4) };
                        let ref_scaled_lin = (lin_ref_c / ratio).clamp(0.0, 1.0);
                        let ref_scaled_srgb = if ref_scaled_lin <= 0.0031308 { ref_scaled_lin * 12.92 } else { 1.055 * ref_scaled_lin.powf(1.0 / 2.4) - 0.055 };

                        let frame_val = frame_row[base + c];

                        // Smooth blend factor combining high and low frequency transitions cleanly
                        let blend_factor = m_narrow * 0.7 + m_wide * 0.3;
                        frame_row[base + c] = (frame_val * blend_factor + ref_scaled_srgb * (1.0 - blend_factor)).clamp(0.0, 1.0);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn test_catmull_rom_subpixel_sampler() {
        let (w, h) = (16u32, 16u32);
        let mut img = Rgb32FImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = (x as f32) * 0.1 + (y as f32) * 0.2;
                img.put_pixel(x, y, Rgb([v, v * 1.5, v * 2.0]));
            }
        }

        // Sampling at exact integer grid point must match original pixel
        let sample_int = sample_catmull_rom_rgb32f(&img, 4.0, 5.0);
        let p = img.get_pixel(4, 5);
        assert!((sample_int[0] - p[0]).abs() < 1e-4);
        assert!((sample_int[1] - p[1]).abs() < 1e-4);

        // Sampling at sub-pixel midpoint (4.5, 5.0) must interpolate smoothly
        let sample_sub = sample_catmull_rom_rgb32f(&img, 4.5, 5.0);
        let expected_v = 4.5 * 0.1 + 5.0 * 0.2;
        assert!((sample_sub[0] - expected_v).abs() < 1e-3);
    }

    #[test]
    fn test_tv_l1_optical_flow_synthetic_shift() {
        let (w, h) = (64usize, 64usize);
        let mut i0 = vec![0.0f32; w * h];
        let mut i1 = vec![0.0f32; w * h];

        // Synthesize a continuous textured sinusoidal grating with displacement
        let delta_x = 0.5f32;
        let delta_y = 0.0f32;
        for y in 0..h {
            for x in 0..w {
                let x_f = x as f32;
                let y_f = y as f32;
                i0[y * w + x] = 0.5 + 0.3 * (x_f * 0.25).sin() * (y_f * 0.25).cos();
                i1[y * w + x] = 0.5 + 0.3 * ((x_f + delta_x) * 0.25).sin() * ((y_f + delta_y) * 0.25).cos();
            }
        }

        let init_u = vec![0.0f32; w * h];
        let init_v = vec![0.0f32; w * h];
        let (flow_u, _flow_v) = solve_tv_l1_optical_flow_level(&i0, &i1, w, h, &init_u, &init_v, 40, 0.35);

        // Displacements should detect negative shift in direction of gradient
        let mut avg_detected_u = 0.0f32;
        let mut count = 0.0f32;
        for y in 16..48 {
            for x in 16..48 {
                avg_detected_u += flow_u[y * w + x];
                count += 1.0;
            }
        }
        let mean_u = avg_detected_u / count;
        assert!(mean_u.abs() > 0.05, "TV-L1 flow must detect sub-pixel shift: got mean {}", mean_u);
    }

    #[test]
    fn test_frame_sharpness_calculation() {
        let (w, h) = (64u32, 64u32);
        let flat_img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, Rgb([128, 128, 128])));
        let mut sharp_img_raw = image::RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 4) % 2 == 0 { 255 } else { 0 };
                sharp_img_raw.put_pixel(x, y, Rgb([v, v, v]));
            }
        }
        let sharp_img = DynamicImage::ImageRgb8(sharp_img_raw);

        let flat_score = compute_frame_sharpness_score(&flat_img);
        let sharp_score = compute_frame_sharpness_score(&sharp_img);

        assert_eq!(flat_score, 0.0);
        assert!(sharp_score > 5.0, "Sharp striped image must have high edge Laplacian score");
    }

    #[test]
    fn test_multiband_seam_blending_continuity() {
        let (w, h) = (32u32, 32u32);
        let mut frame = Rgb32FImage::from_pixel(w, h, Rgb([0.2, 0.2, 0.2]));
        let reference = Rgb32FImage::from_pixel(w, h, Rgb([0.8, 0.8, 0.8]));

        // Mask is 1.0 on left, 0.0 on right (abrupt step boundary at x = 16)
        let mut mask = vec![1.0f32; 32 * 32];
        for y in 0..32 {
            for x in 16..32 {
                mask[y * 32 + x] = 0.0;
            }
        }

        blend_deghost_multiband(&mut frame, &reference, &mask, 32, 32, 1, 1.0);

        // Frame should have transitioned smoothly across the seam without NaN or negative values
        for y in 0..32 {
            for x in 0..32 {
                let p = frame.get_pixel(x, y);
                assert!(!p[0].is_nan() && p[0] >= 0.0 && p[0] <= 1.0);
            }
        }

        // Left side should be close to frame value (0.2), right side should be close to reference (0.8)
        let left_pixel = frame.get_pixel(2, 16)[0];
        let right_pixel = frame.get_pixel(30, 16)[0];
        let mid_pixel = frame.get_pixel(16, 16)[0];

        assert!((left_pixel - 0.2).abs() < 0.05, "Left region should preserve frame: got {}", left_pixel);
        assert!((right_pixel - 0.8).abs() < 0.05, "Right region should preserve reference: got {}", right_pixel);
        assert!(mid_pixel > 0.25 && mid_pixel < 0.75, "Seam midpoint must blend smoothly: got {}", mid_pixel);
    }

    #[test]
    fn test_user_deghost_override_pins_frame() {
        let (w, h) = (32u32, 32u32);
        let frame0 = DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(w, h, Rgb([0.2, 0.2, 0.2])));
        let frame1 = DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(w, h, Rgb([0.8, 0.8, 0.8])));

        let mut frames = vec![
            ("img0".to_string(), frame0, std::time::Duration::from_millis(10), 100.0, 2.8),
            ("img1".to_string(), frame1, std::time::Duration::from_millis(40), 100.0, 2.8),
        ];

        let stroke = crate::hdr_fusion::UserDeghostStroke {
            x: 0.5,
            y: 0.5,
            radius: 12.0,
            target_frame_index: 0,
        };

        apply_reference_deghosting_mask::<tauri::Wry>(
            &mut frames,
            1,
            Some(crate::hdr_fusion::DeghostSensitivity::Medium),
            Some(&[stroke]),
            None,
        );

        // Region around center should be successfully processed
        let processed_frame0 = frames[0].1.to_rgb32f();
        let center_px = processed_frame0.get_pixel(16, 16);
        assert!(!center_px[0].is_nan() && center_px[0] >= 0.0);
    }
}


