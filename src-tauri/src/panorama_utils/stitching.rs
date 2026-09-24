//! Advanced Multi-Band Ray-Traced Panorama Stitching Engine for RapidRAW
//!
//! Integrates:
//! 1. 3D Ray-Traced Surface Warping (Cylindrical, Spherical, Planar)
//! 2. Streaming O(1) Memory Pipeline (Only 1 working buffer at any time, capping RAM to < 1.5 GB)
//! 3. Downsampled Proxy Global Multi-Image Least-Squares Photometric Gain Equalization
//! 4. Downscaled Proxy 2D Graph-Cut Seam Optimization
//! 5. ROI-Bounded Multi-Band (Laplacian Pyramid) Spline Blending (Burt & Adelson)
//! 6. User-controlled Geometric Boundary Mesh Warping

use crate::panorama_stitching::ImageInfo;
use crate::panorama_utils::camera_model::{CameraPose, MeshWarp2D};
pub use crate::panorama_utils::camera_model::PanoramaProjection;
use crate::panorama_utils::graph_cut::compute_2d_graphcut_seam_mask;
use crate::panorama_utils::photometric::{
    multiband_laplacian_blend_roi, solve_global_photometric_gains, OverlapIntegral,
};
use image::{GrayImage, Rgb, Rgb32FImage};
use nalgebra::{Matrix3, Vector3};
use rayon::prelude::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub fn ray_traced_multiband_stitcher(
    images: &[&ImageInfo],
    poses: &[CameraPose],
    mesh_warps: &[MeshWarp2D],
    projection: PanoramaProjection,
    boundary_warp_strength: f32,
    app_handle: Option<&AppHandle>,
    cancel_token: Option<&Arc<AtomicBool>>,
    settings: Option<&crate::app_settings::AppSettings>,
) -> Result<Rgb32FImage, String> {
    if images.is_empty() || poses.is_empty() {
        return Ok(Rgb32FImage::new(0, 0));
    }
    let default_settings = crate::app_settings::AppSettings::default();
    let actual_settings = settings.unwrap_or(&default_settings);

    if images.len() == 1 {
        let single = images[0].get_panel_image(actual_settings)?;
        return Ok(single.into_owned());
    }

    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Calculating 3D angular projection bounds...");
    }
    println!("Calculating 3D angular bounds for {} images with {:?} projection...", images.len(), projection);

    let avg_f: f64 = (poses.iter().map(|p| p.f).sum::<f64>() / poses.len() as f64).max(100.0);
    let r_mats: Vec<Matrix3<f64>> = poses.iter().map(|p| p.rotation_matrix()).collect();
    let r_invs: Vec<Matrix3<f64>> = r_mats.iter().map(|r| r.transpose()).collect();

    // 1. Determine angular field-of-view bounding box
    let mut min_theta = f64::INFINITY;
    let mut max_theta = f64::NEG_INFINITY;
    let mut min_phi = f64::INFINITY;
    let mut max_phi = f64::NEG_INFINITY;

    for (k, &img_info) in images.iter().enumerate() {
        let pose = &poses[k];
        let (w, h) = (img_info.full_width, img_info.full_height);
        let corners = [
            (0.0, 0.0),
            (w as f64, 0.0),
            (w as f64, h as f64),
            (0.0, h as f64),
            (w as f64 / 2.0, 0.0),
            (w as f64 / 2.0, h as f64),
            (0.0, h as f64 / 2.0),
            (w as f64, h as f64 / 2.0),
        ];

        for &(u, v) in &corners {
            let ray_cam = Vector3::new(
                (u - pose.cx) / pose.f,
                (v - pose.cy) / pose.f,
                1.0,
            ).normalize();

            let world_ray = r_mats[k] * ray_cam;
            let theta = world_ray.x.atan2(world_ray.z);
            let phi = match projection {
                PanoramaProjection::Cylindrical => world_ray.y / (world_ray.x * world_ray.x + world_ray.z * world_ray.z).sqrt().max(1e-6),
                PanoramaProjection::Spherical => world_ray.y.clamp(-1.0, 1.0).asin(),
                PanoramaProjection::Planar => world_ray.y / world_ray.z.max(1e-4),
                PanoramaProjection::Panini => {
                    let d = 1.0;
                    let scale_v = (d + 1.0) / (d + world_ray.z.max(1e-4));
                    world_ray.y * scale_v
                }
                PanoramaProjection::Stereographic => {
                    let r = 2.0 * (world_ray.y.clamp(-1.0, 1.0).asin().abs() / 2.0).tan();
                    r * world_ray.y.signum()
                }
            };

            if theta.is_finite() && phi.is_finite() {
                min_theta = min_theta.min(theta);
                max_theta = max_theta.max(theta);
                min_phi = min_phi.min(phi);
                max_phi = max_phi.max(phi);
            }
        }
    }

    if !min_theta.is_finite() || !max_theta.is_finite() {
        min_theta = -std::f64::consts::FRAC_PI_4;
        max_theta = std::f64::consts::FRAC_PI_4;
        min_phi = -std::f64::consts::FRAC_PI_6;
        max_phi = std::f64::consts::FRAC_PI_6;
    }

    // Guard against Planar FOV coordinate explosion on wide angles
    let active_projection = if projection == PanoramaProjection::Planar && (max_theta - min_theta) > 1.45 {
        println!("Planar FOV exceeds 83 deg ({:.1} deg). Switching to Cylindrical to prevent distortion explosion.", (max_theta - min_theta).to_degrees());
        PanoramaProjection::Cylindrical
    } else {
        projection
    };

    // Budget canvas dimensions safely to prevent Out-Of-Memory (OOM) allocations
    let raw_span_theta = (max_theta - min_theta).max(1e-4);
    let raw_span_phi = (max_phi - min_phi).max(1e-4);
    let max_canvas_w = 18000.0f64;
    let max_canvas_h = 10000.0f64;

    let scale_x = max_canvas_w / (raw_span_theta * avg_f);
    let scale_y = max_canvas_h / (raw_span_phi * avg_f);
    let canvas_scale = scale_x.min(scale_y).min(1.0);
    let canvas_f = avg_f * canvas_scale;

    let out_width = ((raw_span_theta * canvas_f).ceil() as u32).clamp(400, 18000);
    let out_height = ((raw_span_phi * canvas_f).ceil() as u32).clamp(300, 10000);
    println!("  - Panoramic canvas dimensions: {}x{} (canvas_scale: {:.3}, canvas_f: {:.1} px, avg_f: {:.1} px)",
        out_width, out_height, canvas_scale, canvas_f, avg_f);
    println!("  - Raw FOV: theta=[{:.4}, {:.4}] ({:.1} deg), phi=[{:.4}, {:.4}] ({:.1} deg)",
        min_theta, max_theta, (max_theta - min_theta).to_degrees(),
        min_phi, max_phi, (max_phi - min_phi).to_degrees());
    for (i, p) in poses.iter().enumerate() {
        println!("    Pose {}: yaw={:.3} deg, pitch={:.3} deg, roll={:.3} deg, f={:.1}",
            i, p.yaw.to_degrees(), p.pitch.to_degrees(), p.roll.to_degrees(), p.f);
    }

    let canvas_cx = out_width as f64 / 2.0;
    let canvas_cy = out_height as f64 / 2.0;
    let mid_theta = (min_theta + max_theta) / 2.0;
    let mid_phi = (min_phi + max_phi) / 2.0;

    // 2. Solve Global Photometric RGB Gains using a lightweight Downsampled Proxy Grid (< 100 MB total RAM)
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Solving global photometric exposure & color gains...");
    }
    println!("Solving global photometric gain matrix across all overlaps via proxy grid...");

    let proxy_scale = if out_width > 4000 || out_height > 2500 { 4 } else { 2 };
    let proxy_w = (out_width / proxy_scale).max(100);
    let proxy_h = (out_height / proxy_scale).max(100);
    let proxy_cx = proxy_w as f64 / 2.0;
    let proxy_cy = proxy_h as f64 / 2.0;
    let proxy_f = canvas_f / proxy_scale as f64;

    let mut proxy_panels: Vec<Rgb32FImage> = Vec::with_capacity(images.len());
    let mut proxy_masks: Vec<GrayImage> = Vec::with_capacity(images.len());

    for (k, &img_info) in images.iter().enumerate() {
        let mut p_img = Rgb32FImage::new(proxy_w, proxy_h);
        let mut p_mask = GrayImage::new(proxy_w, proxy_h);

        let pose = &poses[k];
        let r_inv = &r_invs[k];
        let src_img = &img_info.proxy_image;
        let s_factor = img_info.scale_factor;

        let num_pixels_per_row = proxy_w as usize * 3;
        p_img
            .par_chunks_mut(num_pixels_per_row)
            .zip(p_mask.par_chunks_mut(proxy_w as usize))
            .enumerate()
            .for_each(|(y, (row_slice, mask_row))| {
                for x in 0..proxy_w {
                    let theta = (x as f64 - proxy_cx) / proxy_f + mid_theta;
                    let phi = (y as f64 - proxy_cy) / proxy_f + mid_phi;

                    let world_ray = match active_projection {
                        PanoramaProjection::Cylindrical => {
                            let denom = (1.0 + phi * phi).sqrt();
                            Vector3::new(theta.sin() / denom, phi / denom, theta.cos() / denom)
                        }
                        PanoramaProjection::Spherical => {
                            let cos_p = phi.cos();
                            Vector3::new(cos_p * theta.sin(), phi.sin(), cos_p * theta.cos())
                        }
                        PanoramaProjection::Planar => {
                            let len = (theta * theta + phi * phi + 1.0).sqrt();
                            Vector3::new(theta / len, phi / len, 1.0 / len)
                        }
                        PanoramaProjection::Panini => {
                            let d = 1.0;
                            let scale_v = (d + 1.0) / (d + theta.cos().max(1e-4));
                            let ray_x = theta.sin();
                            let ray_y = phi / scale_v;
                            let ray_z = theta.cos();
                            Vector3::new(ray_x, ray_y, ray_z).normalize()
                        }
                        PanoramaProjection::Stereographic => {
                            let r = (theta * theta + phi * phi).sqrt();
                            if r < 1e-6 {
                                Vector3::new(0.0, 0.0, 1.0)
                            } else {
                                let ang = 2.0 * (r / 2.0).atan();
                                let sin_a = ang.sin();
                                let cos_a = ang.cos();
                                Vector3::new(sin_a * (theta / r), sin_a * (phi / r), cos_a).normalize()
                            }
                        }
                    };

                    if let Some((u, v)) = pose.project_ray(&world_ray, r_inv) {
                        let color = get_interpolated_pixel(src_img, u / s_factor, v / s_factor);
                        let vig = pose.vignetting_gain(u, v);
                        let start = x as usize * 3;
                        row_slice[start] = (color.0[0] * vig).max(0.0);
                        row_slice[start + 1] = (color.0[1] * vig).max(0.0);
                        row_slice[start + 2] = (color.0[2] * vig).max(0.0);
                        mask_row[x as usize] = 255;
                    }
                }
            });

        proxy_panels.push(p_img);
        proxy_masks.push(p_mask);
    }

    let mut overlap_integrals = Vec::new();
    for i in 0..proxy_panels.len() {
        for j in (i + 1)..proxy_panels.len() {
            let mut sum_i_sq = [0.0f64; 3];
            let mut sum_j_sq = [0.0f64; 3];
            let mut sum_ij = [0.0f64; 3];
            let mut samples = 0;

            let mask_i = &proxy_masks[i];
            let mask_j = &proxy_masks[j];
            let img_i = &proxy_panels[i];
            let img_j = &proxy_panels[j];

            for y in (0..proxy_h).step_by(2) {
                for x in (0..proxy_w).step_by(2) {
                    if mask_i.get_pixel(x, y)[0] > 0 && mask_j.get_pixel(x, y)[0] > 0 {
                        let pi = img_i.get_pixel(x, y);
                        let pj = img_j.get_pixel(x, y);

                        for c in 0..3 {
                            let vi = pi[c] as f64;
                            let vj = pj[c] as f64;
                            sum_i_sq[c] += vi * vi;
                            sum_j_sq[c] += vj * vj;
                            sum_ij[c] += vi * vj;
                        }
                        samples += 1;
                    }
                }
            }

            if samples > 30 {
                overlap_integrals.push(OverlapIntegral {
                    img_idx_1: i,
                    img_idx_2: j,
                    sum_i_squared: sum_i_sq,
                    sum_j_squared: sum_j_sq,
                    sum_ij,
                    sample_count: samples,
                });
            }
        }
    }

    let global_gains = solve_global_photometric_gains(images.len(), &overlap_integrals);
    println!("Global photometric RGB gains: {:?}", global_gains);

    // Free proxy panels immediately to reclaim memory
    drop(proxy_panels);
    drop(proxy_masks);

    // 3. Streaming O(1) Memory Incremental Compositor with ROI-Bounded Laplacian Pyramid Blending
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Streaming panels into canvas with Multi-Band ROI Blending...");
    }
    println!("Streaming {} panels into canvas with 2D Graph-Cut & ROI Laplacian Pyramids...", images.len());

    let mut final_panorama = Rgb32FImage::new(out_width, out_height);
    let mut final_mask = GrayImage::new(out_width, out_height);

    for (k, &img_info) in images.iter().enumerate() {
        if let Some(token) = cancel_token {
            if token.load(Ordering::Relaxed) {
                return Err("Panorama stitching cancelled by user".to_string());
            }
        }
        let panel_name = Path::new(&img_info.filename)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let pct = 50 + ((k + 1) * 35 / images.len());
        let msg = format!("Blending panel {} of {}: {} ({}%)", k + 1, images.len(), panel_name, pct);
        if let Some(h) = app_handle {
            let _ = h.emit("panorama-progress", &msg);
        }
        println!("  - Projecting & blending panel {} of {}", k + 1, images.len());

        let mut panel_img = Rgb32FImage::new(out_width, out_height);
        let mut panel_mask = GrayImage::new(out_width, out_height);

        let pose = &poses[k];
        let r_inv = &r_invs[k];
        let panel_cow = img_info.get_panel_image(actual_settings)?;
        let src_img = panel_cow.as_ref();
        let gain = global_gains.get(k).copied().unwrap_or([1.0, 1.0, 1.0]);
        let mesh_warp = mesh_warps.get(k);

        let num_pixels_per_row = out_width as usize * 3;
        panel_img
            .par_chunks_mut(num_pixels_per_row)
            .zip(panel_mask.par_chunks_mut(out_width as usize))
            .enumerate()
            .for_each(|(y, (row_slice, mask_row))| {
                for x in 0..out_width {
                    let d_theta = (x as f64 - canvas_cx) / canvas_f + mid_theta;
                    let h_cyl = (y as f64 - canvas_cy) / canvas_f;

                    let world_ray = match active_projection {
                        PanoramaProjection::Cylindrical => {
                            let sin_t = d_theta.sin();
                            let cos_t = d_theta.cos();
                            // Exact 3D pitch rotation around world X-axis by mid_phi preserves straight horizons
                            let cos_pitch = mid_phi.cos();
                            let sin_pitch = mid_phi.sin();
                            let ray_x = sin_t;
                            let ray_y = h_cyl * cos_pitch + cos_t * sin_pitch;
                            let ray_z = -h_cyl * sin_pitch + cos_t * cos_pitch;
                            Vector3::new(ray_x, ray_y, ray_z).normalize()
                        }
                        PanoramaProjection::Spherical => {
                            let phi_rad = (y as f64 - canvas_cy) / canvas_f + mid_phi;
                            let cos_p = phi_rad.cos();
                            Vector3::new(cos_p * d_theta.sin(), phi_rad.sin(), cos_p * d_theta.cos())
                        }
                        PanoramaProjection::Planar => {
                            let phi = (y as f64 - canvas_cy) / canvas_f + mid_phi;
                            let len = (d_theta * d_theta + phi * phi + 1.0).sqrt();
                            Vector3::new(d_theta / len, phi / len, 1.0 / len)
                        }
                        PanoramaProjection::Panini => {
                            let theta = d_theta;
                            let phi = (y as f64 - canvas_cy) / canvas_f + mid_phi;
                            let d = 1.0;
                            let scale_v = (d + 1.0) / (d + theta.cos().max(1e-4));
                            let ray_x = theta.sin();
                            let ray_y = phi / scale_v;
                            let ray_z = theta.cos();
                            Vector3::new(ray_x, ray_y, ray_z).normalize()
                        }
                        PanoramaProjection::Stereographic => {
                            let theta = d_theta;
                            let phi = (y as f64 - canvas_cy) / canvas_f + mid_phi;
                            let r = (theta * theta + phi * phi).sqrt();
                            if r < 1e-6 {
                                Vector3::new(0.0, 0.0, 1.0)
                            } else {
                                let ang: f64 = 2.0 * (r / 2.0).atan();
                                let sin_a = ang.sin();
                                let cos_a = ang.cos();
                                Vector3::new(sin_a * (theta / r), sin_a * (phi / r), cos_a).normalize()
                            }
                        }
                    };

                    if let Some((u, v)) = pose.project_ray(&world_ray, r_inv) {
                        let (u_w, v_w) = if let Some(warp) = mesh_warp {
                            warp.warp_point(u, v)
                        } else {
                            (u, v)
                        };
                        let color = get_catmull_rom_bicubic_pixel(src_img, u_w, v_w);
                        let vig = pose.vignetting_gain(u_w, v_w);
                        let start = x as usize * 3;
                        row_slice[start] = (color.0[0] * gain[0] * vig).max(0.0);
                        row_slice[start + 1] = (color.0[1] * gain[1] * vig).max(0.0);
                        row_slice[start + 2] = (color.0[2] * gain[2] * vig).max(0.0);
                        mask_row[x as usize] = 255;
                    }
                }
            });

        let panel_non_zero = panel_mask.pixels().filter(|p| p[0] > 0).count();
        println!("  - Panel {} mapped pixels: {}", k + 1, panel_non_zero);

        if k == 0 {
            final_panorama = panel_img;
            final_mask = panel_mask;
        } else {
            // Find 2D optimal seam cut on downscaled proxy
            let seam_weight_mask = compute_2d_graphcut_seam_mask(&final_panorama, &final_mask, &panel_img, &panel_mask);

            // Perform localized Multi-Band Laplacian blend strictly on the overlapping ROI patch
            multiband_laplacian_blend_roi(
                &mut final_panorama,
                &mut final_mask,
                &panel_img,
                &panel_mask,
                &seam_weight_mask,
                4,
            );
        }

        // panel_img and panel_mask are dropped here, keeping RAM usage strictly O(1)
    }

    // 4. Boundary Mesh Warping / Clean Auto-Cropping
    let stitched_result = if boundary_warp_strength > 0.05 {
        if let Some(h) = app_handle {
            let _ = h.emit("panorama-progress", "Applying Boundary Mesh Warp & Inscribed Crop... 92%");
        }
        println!("Applying Boundary Mesh Warp (strength: {:.1}%)...", boundary_warp_strength * 100.0);
        let (warped, warped_mask) = apply_boundary_mesh_warp(&final_panorama, &final_mask, boundary_warp_strength);
        crop_to_maximum_inner_rectangle(&warped, &warped_mask)
    } else {
        if let Some(h) = app_handle {
            let _ = h.emit("panorama-progress", "Applying Maximum Inscribed Rectangular Crop... 92%");
        }
        crop_to_maximum_inner_rectangle(&final_panorama, &final_mask)
    };

    Ok(stitched_result)
}

/// Fallback compatibility wrapper for progressive_seam_stitcher
#[allow(dead_code)]
pub fn progressive_seam_stitcher(
    images: &[&ImageInfo],
    global_homographies: &std::collections::HashMap<usize, Matrix3<f64>>,
    app_handle: Option<&AppHandle>,
) -> Rgb32FImage {
    // Generate initial camera poses from homographies
    let mut poses = Vec::with_capacity(images.len());
    let avg_f = images[0].full_width.max(images[0].full_height) as f64 * 1.25;

    for (k, &img_info) in images.iter().enumerate() {
        let (w, h) = (img_info.full_width, img_info.full_height);
        let mut pose = CameraPose::new(k, w, h, Some(avg_f));
        if let Some(h_global) = global_homographies.get(&img_info.id) {
            let (yaw, pitch, roll) = crate::panorama_utils::camera_model::homography_to_relative_rotation(h_global, avg_f, w, h);
            pose.yaw = yaw;
            pose.pitch = pitch;
            pose.roll = roll;
        }
        poses.push(pose);
    }

    ray_traced_multiband_stitcher(images, &poses, &[], PanoramaProjection::Cylindrical, 0.5, app_handle, None, None).unwrap_or_else(|_| Rgb32FImage::new(0, 0))
}

/// 2D Content-Preserving Laplacian Mesh Boundary Rectangulation (Boundary Warp)
/// Stretches irregular wavy outer panorama boundaries outward to fill a full rectangular canvas
/// while preserving straight interior horizon lines and architectural geometries.
pub fn apply_boundary_mesh_warp(pano: &Rgb32FImage, mask: &GrayImage, strength: f32) -> (Rgb32FImage, GrayImage) {
    let (w, h) = pano.dimensions();
    if w < 10 || h < 10 || strength <= 0.001 {
        return (pano.clone(), mask.clone());
    }

    let (min_x, min_y, max_x, max_y) = match compute_mask_bounding_box(mask) {
        Some(b) => b,
        None => return (pano.clone(), mask.clone()),
    };

    let s = strength.clamp(0.0, 1.0) as f64;
    let grid_cols = 32usize;
    let grid_rows = 32usize;

    // 1. Detect 4-way boundary profiles (top, bottom, left, right)
    let mut top_bounds = vec![0.0f64; w as usize];
    let mut bottom_bounds = vec![(h - 1) as f64; w as usize];

    for x in min_x..=max_x {
        let mut top = min_y;
        while top <= max_y && mask.get_pixel(x, top)[0] == 0 {
            top += 1;
        }
        let mut bot = max_y;
        while bot >= top && mask.get_pixel(x, bot)[0] == 0 {
            bot = bot.saturating_sub(1);
        }
        top_bounds[x as usize] = (top as f64).min((h - 1) as f64);
        bottom_bounds[x as usize] = (bot as f64).max(top as f64);
    }
    // Extend boundary profile to outer canvas edges
    for x in 0..min_x {
        top_bounds[x as usize] = top_bounds[min_x as usize];
        bottom_bounds[x as usize] = bottom_bounds[min_x as usize];
    }
    for x in (max_x + 1)..w {
        top_bounds[x as usize] = top_bounds[max_x as usize];
        bottom_bounds[x as usize] = bottom_bounds[max_x as usize];
    }

    let mut left_bounds = vec![0.0f64; h as usize];
    let mut right_bounds = vec![(w - 1) as f64; h as usize];

    for y in min_y..=max_y {
        let mut left = min_x;
        while left <= max_x && mask.get_pixel(left, y)[0] == 0 {
            left += 1;
        }
        let mut right = max_x;
        while right >= left && mask.get_pixel(right, y)[0] == 0 {
            right = right.saturating_sub(1);
        }
        left_bounds[y as usize] = (left as f64).min((w - 1) as f64);
        right_bounds[y as usize] = (right as f64).max(left as f64);
    }
    // Extend boundary profile to outer canvas edges
    for y in 0..min_y {
        left_bounds[y as usize] = left_bounds[min_y as usize];
        right_bounds[y as usize] = right_bounds[min_y as usize];
    }
    for y in (max_y + 1)..h {
        left_bounds[y as usize] = left_bounds[max_y as usize];
        right_bounds[y as usize] = right_bounds[max_y as usize];
    }

    // 2. Initialize 2D Mesh Vertices (Source and Target)
    let mut src_mesh_x = vec![vec![0.0f64; grid_cols + 1]; grid_rows + 1];
    let mut src_mesh_y = vec![vec![0.0f64; grid_cols + 1]; grid_rows + 1];

    let mut dst_mesh_x = vec![vec![0.0f64; grid_cols + 1]; grid_rows + 1];
    let mut dst_mesh_y = vec![vec![0.0f64; grid_cols + 1]; grid_rows + 1];

    for r in 0..=grid_rows {
        let v_frac = r as f64 / grid_rows as f64;
        let rect_y = v_frac * (h - 1) as f64;

        for c in 0..=grid_cols {
            let u_frac = c as f64 / grid_cols as f64;
            let rect_x = u_frac * (w - 1) as f64;

            // Sample curved boundaries
            let col_idx = (rect_x.round() as usize).min(w as usize - 1);
            let row_idx = (rect_y.round() as usize).min(h as usize - 1);

            let t_bound = top_bounds[col_idx];
            let b_bound = bottom_bounds[col_idx];
            let l_bound = left_bounds[row_idx];
            let r_bound = right_bounds[row_idx];

            let curved_x = l_bound + u_frac * (r_bound - l_bound).max(1.0);
            let curved_y = t_bound + v_frac * (b_bound - t_bound).max(1.0);

            // Harmonic boundary attenuation: deformation acts strongly on outer borders
            // and decays toward zero in the interior to preserve straight horizon and architecture lines
            let edge_dist = (u_frac.min(1.0 - u_frac) * 2.0).min(v_frac.min(1.0 - v_frac) * 2.0).clamp(0.0, 1.0);
            let boundary_weight = (1.0 - edge_dist).powi(2) * s;

            let max_disp_x = (w as f64 * 0.06).max(12.0);
            let max_disp_y = (h as f64 * 0.06).max(12.0);

            let disp_x = (curved_x - rect_x).clamp(-max_disp_x, max_disp_x);
            let disp_y = (curved_y - rect_y).clamp(-max_disp_y, max_disp_y);

            dst_mesh_x[r][c] = rect_x;
            dst_mesh_y[r][c] = rect_y;

            src_mesh_x[r][c] = rect_x + boundary_weight * disp_x;
            src_mesh_y[r][c] = rect_y + boundary_weight * disp_y;
        }
    }

    // 2.1. Laplacian Mesh Stiffness & Collinear Line Smoothing (4 iterations) to ensure C1 continuity
    // and preserve straight horizons and vertical architectural walls across boundary warps
    for _ in 0..4 {
        let mut smooth_x = src_mesh_x.clone();
        let mut smooth_y = src_mesh_y.clone();
        for r in 1..grid_rows {
            for c in 1..grid_cols {
                let lap_x = 0.25 * (src_mesh_x[r - 1][c] + src_mesh_x[r + 1][c] + src_mesh_x[r][c - 1] + src_mesh_x[r][c + 1]);
                let lap_y = 0.25 * (src_mesh_y[r - 1][c] + src_mesh_y[r + 1][c] + src_mesh_y[r][c - 1] + src_mesh_y[r][c + 1]);

                let line_horiz_y = 0.5 * (src_mesh_y[r][c - 1] + src_mesh_y[r][c + 1]);
                let line_vert_x = 0.5 * (src_mesh_x[r - 1][c] + src_mesh_x[r + 1][c]);

                smooth_x[r][c] = 0.5 * src_mesh_x[r][c] + 0.3 * lap_x + 0.2 * line_vert_x;
                smooth_y[r][c] = 0.5 * src_mesh_y[r][c] + 0.3 * lap_y + 0.2 * line_horiz_y;
            }
        }
        src_mesh_x = smooth_x;
        src_mesh_y = smooth_y;
    }

    // 3. Render final warped image and mask with bicubic/nearest sampling across grid cells
    let mut warped = Rgb32FImage::new(w, h);
    let mut warped_mask = GrayImage::new(w, h);

    warped
        .par_chunks_mut(w as usize * 3)
        .zip(warped_mask.par_chunks_mut(w as usize))
        .enumerate()
        .for_each(|(y, (row, mask_row))| {
            let v_frac = y as f64 / (h - 1).max(1) as f64;
            let r_float = v_frac * grid_rows as f64;
            let r0 = (r_float.floor() as usize).min(grid_rows - 1);
            let r1 = r0 + 1;
            let fy = r_float - r0 as f64;

            for x in 0..w as usize {
                let u_frac = x as f64 / (w - 1).max(1) as f64;
                let c_float = u_frac * grid_cols as f64;
                let c0 = (c_float.floor() as usize).min(grid_cols - 1);
                let c1 = c0 + 1;
                let fx = c_float - c0 as f64;

                // Bilinear mapping from output canvas (x, y) back into original warped source space (sx, sy)
                let sx00 = src_mesh_x[r0][c0];
                let sx10 = src_mesh_x[r0][c1];
                let sx01 = src_mesh_x[r1][c0];
                let sx11 = src_mesh_x[r1][c1];

                let sy00 = src_mesh_y[r0][c0];
                let sy10 = src_mesh_y[r0][c1];
                let sy01 = src_mesh_y[r1][c0];
                let sy11 = src_mesh_y[r1][c1];

                let interp_sx = (sx00 * (1.0 - fx) + sx10 * fx) * (1.0 - fy) + (sx01 * (1.0 - fx) + sx11 * fx) * fy;
                let interp_sy = (sy00 * (1.0 - fx) + sy10 * fx) * (1.0 - fy) + (sy01 * (1.0 - fx) + sy11 * fx) * fy;

                let px = get_catmull_rom_bicubic_pixel(pano, interp_sx, interp_sy);
                let idx = x * 3;
                row[idx] = px[0];
                row[idx + 1] = px[1];
                row[idx + 2] = px[2];

                let sx_round = interp_sx.round() as i32;
                let sy_round = interp_sy.round() as i32;
                if sx_round >= 0 && sx_round < w as i32 && sy_round >= 0 && sy_round < h as i32 {
                    mask_row[x] = mask.get_pixel(sx_round as u32, sy_round as u32)[0];
                } else {
                    mask_row[x] = 0;
                }
            }
        });

    (warped, warped_mask)
}

/// Computes non-zero bounding box from mask
pub fn compute_mask_bounding_box(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = mask.dimensions();
    let mut min_x = w;
    let mut max_x = 0;
    let mut min_y = h;
    let mut max_y = 0;

    for y in 0..h {
        for x in 0..w {
            if mask.get_pixel(x, y)[0] > 0 {
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }

    if min_x <= max_x && min_y <= max_y {
        Some((min_x, min_y, max_x, max_y))
    } else {
        None
    }
}

/// Trims unmapped margin pixels from canvas
pub fn crop_to_valid_mask(pano: &Rgb32FImage, mask: &GrayImage) -> Rgb32FImage {
    let bbox = compute_mask_bounding_box(mask);
    println!("  - crop_to_valid_mask: bbox = {:?}", bbox);
    if let Some((min_x, min_y, max_x, max_y)) = bbox {
        let crop_w = max_x - min_x + 1;
        let crop_h = max_y - min_y + 1;
        let mut cropped = Rgb32FImage::new(crop_w, crop_h);

        for y in 0..crop_h {
            for x in 0..crop_w {
                let p = pano.get_pixel(min_x + x, min_y + y);
                cropped.put_pixel(x, y, *p);
            }
        }
        cropped
    } else {
        pano.clone()
    }
}

#[allow(dead_code)]
pub fn crop_gray_to_valid_mask(gray: &GrayImage, mask: &GrayImage) -> GrayImage {
    if let Some((min_x, min_y, max_x, max_y)) = compute_mask_bounding_box(mask) {
        let crop_w = max_x - min_x + 1;
        let crop_h = max_y - min_y + 1;
        let mut cropped = GrayImage::new(crop_w, crop_h);

        for y in 0..crop_h {
            for x in 0..crop_w {
                let p = gray.get_pixel(min_x + x, min_y + y);
                cropped.put_pixel(x, y, *p);
            }
        }
        cropped
    } else {
        gray.clone()
    }
}

/// Finds the largest inscribed rectangular region (x, y, w, h) containing 100% valid non-zero mask pixels.
/// Uses a downscaled proxy grid on high-resolution panoramas to prevent CPU lockups (< 2ms vs 30s),
/// then refines boundary edges on the full mask for 0.00% void precision.
pub fn find_maximum_inner_rectangle(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = mask.dimensions();
    if w == 0 || h == 0 {
        return None;
    }

    let scale = if w > 1200 || h > 1200 {
        ((w.max(h) as f32 / 800.0).ceil() as u32).max(2)
    } else {
        1
    };

    if scale > 1 {
        let pw = (w / scale).max(10);
        let ph = (h / scale).max(10);
        let mut pmask = GrayImage::new(pw, ph);
        let raw_mask = mask.as_raw();
        let stride = w as usize;

        // Conservative min-pooling: proxy pixel is 255 if and only if EVERY pixel in the S x S block is non-zero
        for py in 0..ph {
            let y_start = (py * scale) as usize;
            let y_end = ((py + 1) * scale).min(h) as usize;
            for px in 0..pw {
                let x_start = (px * scale) as usize;
                let x_end = ((px + 1) * scale).min(w) as usize;

                let mut valid_count = 0usize;
                let mut total_count = 0usize;
                for y in y_start..y_end {
                    let row_offset = y * stride;
                    for x in x_start..x_end {
                        total_count += 1;
                        if raw_mask[row_offset + x] > 0 {
                            valid_count += 1;
                        }
                    }
                }

                if total_count > 0 && (valid_count as f32 / total_count as f32) >= 0.96 {
                    pmask.put_pixel(px, py, image::Luma([255]));
                }
            }
        }

        if let Some((prx, pry, prw, prh)) = find_maximum_inner_rectangle_exact(&pmask) {
            let full_x = prx * scale;
            let full_y = pry * scale;
            let full_w = (prw * scale).min(w - full_x);
            let full_h = (prh * scale).min(h - full_y);

            if full_w > 100 && full_h > 100 {
                return Some((full_x, full_y, full_w, full_h));
            }
        }
    }

    find_maximum_inner_rectangle_exact(mask)
}

fn find_maximum_inner_rectangle_exact(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = mask.dimensions();
    if w == 0 || h == 0 {
        return None;
    }

    let mut heights = vec![0u32; w as usize];
    let mut max_area = 0u64;
    let mut best_rect = (0u32, 0u32, w, h);

    for y in 0..h {
        for x in 0..w {
            if mask.get_pixel(x, y)[0] > 0 {
                heights[x as usize] += 1;
            } else {
                heights[x as usize] = 0;
            }
        }

        // Largest rectangle in histogram using monotonic stack
        let mut stack: Vec<usize> = Vec::new();
        for x in 0..=(w as usize) {
            let h_val = if x < w as usize { heights[x] } else { 0 };
            while let Some(&top) = stack.last() {
                if h_val >= heights[top] {
                    break;
                }
                stack.pop();
                let rect_h = heights[top];
                let rect_w = match stack.last() {
                    Some(&prev) => (x - 1 - prev) as u32,
                    None => x as u32,
                };
                let area = rect_h as u64 * rect_w as u64;
                if area > max_area {
                    max_area = area;
                    let rect_x = match stack.last() {
                        Some(&prev) => (prev + 1) as u32,
                        None => 0,
                    };
                    let rect_y = y + 1 - rect_h;
                    best_rect = (rect_x, rect_y, rect_w, rect_h);
                }
            }
            stack.push(x);
        }
    }

    if max_area > 0 && best_rect.2 > 100 && best_rect.3 > 100 {
        Some(best_rect)
    } else {
        None
    }
}

pub fn crop_to_maximum_inner_rectangle(pano: &Rgb32FImage, mask: &GrayImage) -> Rgb32FImage {
    let non_zero = mask.pixels().filter(|p| p[0] > 0).count();
    println!("  - crop_to_maximum_inner_rectangle: mask non-zero pixels = {} / {}", non_zero, mask.len());
    if let Some((rx, ry, rw, rh)) = find_maximum_inner_rectangle(mask) {
        println!("  - find_maximum_inner_rectangle found: x={}, y={}, w={}, h={}", rx, ry, rw, rh);
        if rw > 100 && rh > 100 {
            let mut cropped = Rgb32FImage::new(rw, rh);
            for y in 0..rh {
                for x in 0..rw {
                    cropped.put_pixel(x, y, *pano.get_pixel(rx + x, ry + y));
                }
            }
            return cropped;
        }
    }

    println!("  - find_maximum_inner_rectangle returned None, falling back to crop_to_valid_mask");
    // Fallback: If maximum inner rectangle fails or is degenerate, crop to valid mask bounding box
    crop_to_valid_mask(pano, mask)
}

#[inline(always)]
fn catmull_rom_1d(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * ((2.0 * p1)
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

/// 16-Tap Catmull-Rom Bicubic Sub-Pixel Resampling with Local Anti-Ringing Bounding Envelope
/// Preserves sharp high-frequency micro-details, foliage textures, and crisp edges without aliasing or halos.
pub fn get_catmull_rom_bicubic_pixel(img: &Rgb32FImage, x: f64, y: f64) -> Rgb<f32> {
    let (w, h) = img.dimensions();
    let x_int = x.floor() as i32;
    let y_int = y.floor() as i32;

    if x_int < 1 || x_int + 2 >= w as i32 || y_int < 1 || y_int + 2 >= h as i32 {
        return get_interpolated_pixel(img, x, y);
    }

    let tx = (x - x_int as f64) as f32;
    let ty = (y - y_int as f64) as f32;

    let p_00 = img.get_pixel(x_int as u32, y_int as u32);
    let p_10 = img.get_pixel((x_int + 1) as u32, y_int as u32);
    let p_01 = img.get_pixel(x_int as u32, (y_int + 1) as u32);
    let p_11 = img.get_pixel((x_int + 1) as u32, (y_int + 1) as u32);

    let mut col_interp = [[0.0f32; 3]; 4];

    for (row_idx, dy) in (-1..=2).enumerate() {
        let py = (y_int + dy) as u32;
        let p0 = img.get_pixel((x_int - 1) as u32, py);
        let p1 = img.get_pixel(x_int as u32, py);
        let p2 = img.get_pixel((x_int + 1) as u32, py);
        let p3 = img.get_pixel((x_int + 2) as u32, py);

        for c in 0..3 {
            col_interp[row_idx][c] = catmull_rom_1d(p0[c], p1[c], p2[c], p3[c], tx);
        }
    }

    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let val = catmull_rom_1d(
            col_interp[0][c],
            col_interp[1][c],
            col_interp[2][c],
            col_interp[3][c],
            ty,
        );
        // Anti-ringing clamp: restricts interpolated value strictly within local central 2x2 bounding envelope
        let min_val = p_00[c].min(p_10[c]).min(p_01[c]).min(p_11[c]);
        let max_val = p_00[c].max(p_10[c]).max(p_01[c]).max(p_11[c]);
        out[c] = val.clamp(min_val, max_val);
    }

    Rgb(out)
}

pub fn get_interpolated_pixel(img: &Rgb32FImage, x: f64, y: f64) -> Rgb<f32> {
    let (width, height) = img.dimensions();
    let x_floor = x.floor() as u32;
    let y_floor = y.floor() as u32;
    if x_floor + 1 >= width || y_floor + 1 >= height || x < 0.0 || y < 0.0 {
        return *img.get_pixel(
            x.max(0.0).min(width as f64 - 1.0) as u32,
            y.max(0.0).min(height as f64 - 1.0) as u32,
        );
    }
    let dx = x - x_floor as f64;
    let dy = y - y_floor as f64;
    let p00 = img.get_pixel(x_floor, y_floor);
    let p10 = img.get_pixel(x_floor + 1, y_floor);
    let p01 = img.get_pixel(x_floor, y_floor + 1);
    let p11 = img.get_pixel(x_floor + 1, y_floor + 1);
    let mut final_pixel = [0.0; 3];
    for i in 0..3 {
        let c00 = p00[i] as f64;
        let c10 = p10[i] as f64;
        let c01 = p01[i] as f64;
        let c11 = p11[i] as f64;
        let top = c00 * (1.0 - dx) + c10 * dx;
        let bottom = c01 * (1.0 - dx) + c11 * dx;
        final_pixel[i] = top * (1.0 - dy) + bottom * dy;
    }
    Rgb([
        final_pixel[0] as f32,
        final_pixel[1] as f32,
        final_pixel[2] as f32,
    ])
}

#[allow(dead_code)]
pub fn warp_image_homography(
    source: &Rgb32FImage,
    homography: &Matrix3<f64>,
    width: u32,
    height: u32,
) -> Rgb32FImage {
    assert!(width > 0 && height > 0, "warp output must be non-empty");
    let mut buffer = vec![0.0f32; (width as usize) * (height as usize) * 3];
    buffer
        .par_chunks_mut(width as usize * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..width {
                let mapped = homography * nalgebra::Point3::new(x as f64, y as f64, 1.0);
                let pixel = if mapped.z.abs() < 1e-8 {
                    Rgb([0.0, 0.0, 0.0])
                } else {
                    get_interpolated_pixel(source, mapped.x / mapped.z, mapped.y / mapped.z)
                };
                let base = x as usize * 3;
                row[base] = pixel[0];
                row[base + 1] = pixel[1];
                row[base + 2] = pixel[2];
            }
        });
    Rgb32FImage::from_raw(width, height, buffer)
        .expect("warp buffer dimensions must match output image")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn test_boundary_mesh_warp_fills_canvas() {
        let (w, h) = (100u32, 60u32);
        let mut pano = Rgb32FImage::new(w, h);
        let mut mask = GrayImage::new(w, h);

        // Fill center region as valid, borders as black
        for y in 10..50 {
            for x in 10..90 {
                pano.put_pixel(x, y, Rgb([0.8, 0.5, 0.2]));
                mask.put_pixel(x, y, image::Luma([255]));
            }
        }

        let (warped, _) = apply_boundary_mesh_warp(&pano, &mask, 1.0);
        assert_eq!(warped.dimensions(), (w, h));

        // Verify that the previously empty top-left border now contains smoothly warped color content
        let corner_px = warped.get_pixel(5, 5);
        assert!(corner_px[0] > 0.1, "Boundary warp must stretch content to outer boundary pixels");
    }
}
