//! Unified 1-Click HDR Panorama Engine for RapidRAW Pro
//!
//! Merges multi-bracket exposure sets (e.g. 3 brackets x 5 angles = 15 images)
//! directly into 32-bit linear floating-point HDR panels and seamlessly stitches
//! them using Cylindrical, Spherical, or Planar projections.

use std::collections::HashMap;
use std::fs;

use image::{DynamicImage, ImageFormat, Rgb32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::app_settings::load_settings;
use crate::exif_processing::read_exposure_time_secs;
use crate::file_management::parse_virtual_path;
use crate::hdr_deghosting::{align_hdr_frames, assert_uniform_dimensions, load_hdr_frames};
use crate::panorama_stitching::ImageInfo;
use crate::panorama_utils::camera_model::{CameraPose, PanoramaProjection};
use crate::panorama_utils::stitching::ray_traced_multiband_stitcher;
use crate::sleep_lock::SleepLockGuard;
use crate::AppState;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HdrPanoramaRequest {
    pub paths: Vec<String>,
    pub projection: PanoramaProjection,
    pub enable_multiband_blending: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExposureBracketGroup {
    pub position_index: usize,
    pub paths: Vec<String>,
}

/// Parses capture timestamp string (YYYY:MM:DD HH:MM:SS) into seconds for temporal grouping
fn parse_exif_timestamp(datetime_str: &str) -> Option<u64> {
    let parts: Vec<&str> = datetime_str.split_whitespace().collect();
    if parts.len() != 2 {
        return None;
    }
    let d_parts: Vec<u32> = parts[0].split(':').filter_map(|s| s.parse().ok()).collect();
    let t_parts: Vec<u32> = parts[1].split(':').filter_map(|s| s.parse().ok()).collect();
    if d_parts.len() == 3 && t_parts.len() == 3 {
        // Approximate epoch seconds calculation for relative delta comparison
        let days = d_parts[0] as u64 * 365 + d_parts[1] as u64 * 30 + d_parts[2] as u64;
        let secs = days * 86400 + t_parts[0] as u64 * 3600 + t_parts[1] as u64 * 60 + t_parts[2] as u64;
        Some(secs)
    } else {
        None
    }
}

/// Automatically clusters arbitrary RAW photo selections into HDR exposure bracket groups
/// by EXIF capture timestamp delta (dt < 7s), focal length, and exposure EV progressions.
pub fn cluster_hdr_brackets(paths: &[String]) -> Vec<ExposureBracketGroup> {
    if paths.is_empty() {
        return Vec::new();
    }

    struct ItemMeta {
        path: String,
        timestamp: u64,
        exposure: f32,
    }

    let mut items: Vec<ItemMeta> = Vec::with_capacity(paths.len());

    for path in paths {
        let (source_path, _) = parse_virtual_path(path);
        let file_bytes = fs::read(&source_path).unwrap_or_default();
        let exposure = read_exposure_time_secs(&source_path.to_string_lossy(), &file_bytes).unwrap_or(0.01);
        
        let exif_map = crate::exif_processing::read_exif_data(&source_path.to_string_lossy(), &file_bytes);
        let timestamp = exif_map
            .get("DateTimeOriginal")
            .or_else(|| exif_map.get("DateTime"))
            .and_then(|s| parse_exif_timestamp(s))
            .unwrap_or_else(|| {
                fs::metadata(&source_path)
                    .and_then(|m| m.modified())
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                    .unwrap_or(0)
            });

        items.push(ItemMeta {
            path: path.clone(),
            timestamp,
            exposure,
        });
    }

    // Sort chronologically, then by filename
    items.sort_by(|a, b| {
        if a.timestamp != b.timestamp && a.timestamp > 0 && b.timestamp > 0 {
            a.timestamp.cmp(&b.timestamp)
        } else {
            a.path.cmp(&b.path)
        }
    });

    let mut groups: Vec<ExposureBracketGroup> = Vec::new();
    let mut current_group: Vec<String> = Vec::new();
    let mut last_timestamp: Option<u64> = None;
    let mut last_exposure: Option<f32> = None;

    for item in items {
        let mut start_new_group = false;

        if let Some(prev_t) = last_timestamp {
            if prev_t > 0 && item.timestamp > 0 {
                let dt = (item.timestamp as i64 - prev_t as i64).abs();
                // If shots are separated by more than 3 seconds, they belong to different angles/bursts
                if dt > 3 {
                    start_new_group = true;
                }
            }
        }

        if !start_new_group && let Some(last_exp) = last_exposure {
            // In AEB brackets, exposure progresses (e.g. -2 EV -> 0 EV -> +2 EV).
            // When moving to the next angle, the camera resets to the start of the bracket (-2 EV),
            // which causes a sharp drop in exposure time (e.g. ratio < 0.7) when current group has >= 2 frames.
            if current_group.len() >= 2 && item.exposure < last_exp * 0.7 {
                start_new_group = true;
            } else {
                let ratio = if last_exp > 0.0 { item.exposure / last_exp } else { 1.0 };
                let is_bracket = ratio > 1.35 || ratio < 0.74;

                // If exposure does not vary and we already have at least 2 frames in current bracket
                if !is_bracket && current_group.len() >= 2 {
                    start_new_group = true;
                }
            }
        }

        if start_new_group && !current_group.is_empty() {
            groups.push(ExposureBracketGroup {
                position_index: groups.len(),
                paths: current_group.clone(),
            });
            current_group.clear();
        }

        current_group.push(item.path);
        last_timestamp = Some(item.timestamp);
        last_exposure = Some(item.exposure);
    }

    if !current_group.is_empty() {
        groups.push(ExposureBracketGroup {
            position_index: groups.len(),
            paths: current_group,
        });
    }

    if groups.len() <= 1 && paths.len() >= 6 && paths.len() % 3 == 0 {
        return paths
            .chunks(3)
            .enumerate()
            .map(|(i, chunk)| ExposureBracketGroup {
                position_index: i,
                paths: chunk.to_vec(),
            })
            .collect();
    }

    groups
}

#[tauri::command]
pub async fn stitch_hdr_panorama(
    paths: Vec<String>,
    projection: Option<PanoramaProjection>,
    boundary_warp: Option<f32>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _sleep_guard = SleepLockGuard::new("stitch_hdr_panorama");

    if paths.len() < 3 {
        return Err("At least 3 photos are required for an HDR Panorama.".to_string());
    }

    let selected_projection = projection.unwrap_or(PanoramaProjection::Cylindrical);
    let warp_strength = boundary_warp.unwrap_or(0.5);
    let panorama_result_handle = state.panorama_result.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let handle_for_task = app_handle.clone();

    let task = tokio::task::spawn_blocking(move || {
        let _ = handle_for_task.emit("panorama-progress", "Analyzing HDR exposure brackets...");
        println!("Analyzing HDR exposure brackets across {} photos...", paths.len());

        let bracket_groups = cluster_hdr_brackets(&paths);
        let num_positions = bracket_groups.len();
        println!("Detected {} panorama angle positions with multi-exposure brackets.", num_positions);

        if num_positions < 2 {
            return Err("Could not detect at least 2 distinct panorama angles in the selection.".to_string());
        }

        // 1. Parallel HDR Merge each angle position into 32-bit linear floating-point panels
        let merged_hdr_panels: Vec<Result<Rgb32FImage, String>> = bracket_groups
            .par_iter()
            .map(|group| {
                let group_msg = format!("Merging 32-bit HDR for Position {} of {}...", group.position_index + 1, num_positions);
                let _ = handle_for_task.emit("panorama-progress", &group_msg);

                if group.paths.len() == 1 {
                    let (source_path, _) = parse_virtual_path(&group.paths[0]);
                    let file_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
                    let mut img = crate::image_loader::load_base_image_from_bytes(&file_bytes, &source_path.to_string_lossy(), false, &settings, None)
                        .map_err(|e| e.to_string())?;
                    if crate::formats::is_raw_file(&*source_path.to_string_lossy()) {
                        crate::image_processing::apply_cpu_default_raw_processing(&mut img);
                    }
                    return Ok(img.to_rgb32f());
                }

                let mut frames = load_hdr_frames(&group.paths, Some(&handle_for_task), &settings)?;
                let _ = assert_uniform_dimensions(&frames);

                let ref_idx = crate::hdr_deghosting::select_best_reference_index(&frames);
                align_hdr_frames(&mut frames, Some(&handle_for_task));
                crate::hdr_deghosting::apply_reference_deghosting_mask(
                    &mut frames,
                    ref_idx,
                    Some(crate::hdr_fusion::DeghostSensitivity::Medium),
                    None,
                    Some(&handle_for_task),
                );

                let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                let exposure_scales: Vec<f32> = frames
                    .iter()
                    .map(|f| crate::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4))
                    .collect();

                let options = crate::hdr_fusion::HdrMergeOptions {
                    reference_index: Some(ref_idx),
                    ..Default::default()
                };
                let fused = crate::hdr_fusion::fuse_exposures_linear_radiance(
                    &rgb_frames,
                    &exposure_scales,
                    &options,
                    Some(&handle_for_task),
                    None,
                )?;
                Ok(fused)
            })
            .collect();

        let mut valid_panels = Vec::new();
        for panel_res in merged_hdr_panels {
            match panel_res {
                Ok(panel) => valid_panels.push(panel),
                Err(e) => return Err(format!("HDR Merge failed for position: {}", e)),
            }
        }

        // 2. Stitch the 32-bit HDR panels using 3D ray projection and 2D Graph-Cut + Multi-Band Blending
        let _ = handle_for_task.emit("panorama-progress", "Stitching 32-bit HDR panels with 2D Graph-Cut & Multi-Band blending...");
        println!("Stitching {} 32-bit HDR panels with {:?} projection...", valid_panels.len(), selected_projection);

        let final_hdr_pano = stitch_hdr_panels(&valid_panels, selected_projection, warp_strength, Some(&handle_for_task))?;

        // 3. Create high-resolution preview
        let _ = handle_for_task.emit("panorama-progress", "Creating 32-bit HDR Panorama preview...");
        let (w, h) = final_hdr_pano.dimensions();
        let (new_w, new_h) = if w > h {
            (1200, ((1200.0 * h as f32 / w as f32).round() as u32).max(1))
        } else {
            (((1200.0 * w as f32 / h as f32).round() as u32).max(1), 1200)
        };

        let preview_f32 = crate::image_processing::downscale_f32_image(&DynamicImage::ImageRgb32F(final_hdr_pano.clone()), new_w, new_h);
        let preview_u8 = preview_f32.to_rgb8();

        let mut buf = std::io::Cursor::new(Vec::new());
        if let Err(e) = preview_u8.write_to(&mut buf, ImageFormat::Png) {
            return Err(format!("Failed to encode HDR panorama preview: {}", e));
        }

        use base64::{engine::general_purpose, Engine as _};
        let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
        let final_base64 = format!("data:image/png;base64,{}", base64_str);

        *panorama_result_handle.lock().unwrap() = Some(DynamicImage::ImageRgb32F(final_hdr_pano));

        let _ = handle_for_task.emit(
            "panorama-complete",
            serde_json::json!({
                "base64": final_base64,
                "isHdr": true,
                "projection": format!("{:?}", selected_projection),
            }),
        );

        Ok(())
    });

    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => {
            let _ = app_handle.emit("panorama-error", e.clone());
            Err(e)
        }
        Err(join_err) => {
            let msg = format!("HDR Panorama task failed: {}", join_err);
            let _ = app_handle.emit("panorama-error", msg.clone());
            Err(msg)
        }
    }
}

/// Converts 32-bit linear floating-point HDR panel to a high-contrast,
/// perceptually uniform 8-bit grayscale image optimized for multi-scale ORB/FAST feature detection.
pub fn hdr_to_feature_grayscale(panel: &Rgb32FImage) -> image::GrayImage {
    let (w, h) = panel.dimensions();
    let mut gray = image::GrayImage::new(w, h);

    // 1. Calculate luminance L = 0.2126*R + 0.7152*G + 0.0722*B
    // and sample 1st and 99th percentiles for robust adaptive range normalization
    let mut lums: Vec<f32> = Vec::with_capacity((w * h / 16) as usize);
    for y in (0..h).step_by(4) {
        for x in (0..w).step_by(4) {
            let p = panel.get_pixel(x, y);
            let lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            if lum > 0.0001 && lum.is_finite() {
                lums.push(lum);
            }
        }
    }

    let (p_low, p_high) = if lums.is_empty() {
        (0.001, 1.0)
    } else {
        lums.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let low_idx = (lums.len() as f32 * 0.01) as usize;
        let high_idx = ((lums.len() as f32 * 0.99) as usize).min(lums.len() - 1);
        (lums[low_idx].max(1e-5), lums[high_idx].max(1e-4))
    };

    let range = (p_high - p_low).max(1e-4);

    // 2. Tonemap and gamma correct (sRGB gamma 2.2) to reveal full texture in shadows & midtones
    for y in 0..h {
        for x in 0..w {
            let p = panel.get_pixel(x, y);
            let lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            let norm = ((lum - p_low) / range).clamp(0.0, 1.0);
            let val = (norm.powf(1.0 / 2.2) * 255.0).clamp(0.0, 255.0) as u8;
            gray.put_pixel(x, y, image::Luma([val]));
        }
    }

    gray
}

/// Stitches pre-merged 32-bit float HDR image panels using robust multi-scale ORB matching,
/// scaled homography RANSAC, MST anchor selection, and bundle adjustment.
pub fn stitch_hdr_panels(
    panels: &[Rgb32FImage],
    projection: PanoramaProjection,
    boundary_warp: f32,
    app_handle: Option<&AppHandle>,
) -> Result<Rgb32FImage, String> {
    if panels.is_empty() {
        return Err("No HDR panels available to stitch.".to_string());
    }
    if panels.len() == 1 {
        return Ok(panels[0].clone());
    }

    let brief_pairs = crate::panorama_utils::processing::generate_brief_pairs();

    // Extract features on tone-mapped perceptual luminance representations
    let image_infos: Vec<ImageInfo> = panels
        .iter()
        .enumerate()
        .map(|(i, panel)| {
            let gray_full = hdr_to_feature_grayscale(panel);
            let (w, h) = gray_full.dimensions();
            let (new_w, new_h, scale_factor) = crate::panorama_utils::processing::calculate_downscale_dimensions(w, h);
            let gray_small = image::imageops::resize(&gray_full, new_w, new_h, image::imageops::FilterType::Triangle);
            let low_detail_mask = crate::panorama_utils::processing::generate_low_detail_mask(&gray_full);
            let features = crate::panorama_utils::processing::find_features(&gray_small, &brief_pairs);

            ImageInfo {
                id: i,
                filename: format!("HDR_Angle_{:02}", i + 1),
                image: panel.clone(),
                low_detail_mask,
                scale_factor,
                features,
            }
        })
        .collect();

    // Match features pairwise in parallel with homography scaling & refinement
    let pairs_to_check: Vec<(usize, usize)> = (0..image_infos.len())
        .flat_map(|i| (i + 1..image_infos.len()).map(move |j| (i, j)))
        .collect();

    let match_results: Vec<Option<((usize, usize), crate::panorama_stitching::MatchInfo)>> = pairs_to_check
        .par_iter()
        .map(|&(i, j)| {
            let features1 = &image_infos[i].features;
            let features2 = &image_infos[j].features;

            let initial_matches = crate::panorama_utils::processing::match_features(features1, features2);
            if initial_matches.len() < crate::panorama_utils::processing::MIN_INLIERS_FOR_CONNECTION {
                return None;
            }

            let keypoints1: Vec<crate::panorama_stitching::KeyPoint> = features1.iter().map(|f| f.keypoint).collect();
            let keypoints2: Vec<crate::panorama_stitching::KeyPoint> = features2.iter().map(|f| f.keypoint).collect();

            if let Some((_h_small, inliers)) = crate::panorama_utils::processing::find_homography_ransac(&initial_matches, &keypoints1, &keypoints2)
                && inliers.len() >= crate::panorama_utils::processing::MIN_INLIERS_FOR_CONNECTION
            {
                let inlier_points: Vec<(nalgebra::Point2<f64>, nalgebra::Point2<f64>)> = inliers
                    .iter()
                    .map(|m| {
                        let p1 = keypoints1[m.index1];
                        let p2 = keypoints2[m.index2];
                        (
                            nalgebra::Point2::new(p1.x as f64, p1.y as f64),
                            nalgebra::Point2::new(p2.x as f64, p2.y as f64),
                        )
                    })
                    .collect();

                if let Some(h_refined) = crate::panorama_utils::processing::compute_homography(&inlier_points) {
                    let s1 = image_infos[i].scale_factor;
                    let s2 = image_infos[j].scale_factor;
                    let scale_mat_i_inv = nalgebra::Matrix3::new(1.0 / s1, 0.0, 0.0, 0.0, 1.0 / s1, 0.0, 0.0, 0.0, 1.0);
                    let scale_mat_j = nalgebra::Matrix3::new(s2, 0.0, 0.0, 0.0, s2, 0.0, 0.0, 0.0, 1.0);
                    let h_full = scale_mat_j * h_refined * scale_mat_i_inv;

                    let match_info = crate::panorama_stitching::MatchInfo {
                        homography: h_full,
                        inliers: inliers.len(),
                        inlier_matches: inliers,
                    };
                    return Some(((i, j), match_info));
                }
            }
            None
        })
        .collect();

    let mut pairwise_matches: HashMap<(usize, usize), crate::panorama_stitching::MatchInfo> = HashMap::new();
    for (pair, info) in match_results.into_iter().flatten() {
        pairwise_matches.insert(pair, info);
    }

    if pairwise_matches.is_empty() {
        return Err("Could not align enough overlapping HDR panels. Ensure at least 30% overlap between adjacent shots.".to_string());
    }

    let (ordered_indices, global_homographies) = crate::panorama_stitching::build_stitching_order(&image_infos, &pairwise_matches);

    if ordered_indices.len() < 2 {
        return Err("Could not align enough overlapping HDR panels. Ensure at least 30% overlap between adjacent shots.".to_string());
    }

    let stitched_infos: Vec<&ImageInfo> = ordered_indices.iter().map(|&i| &image_infos[i]).collect();

    // Initialize camera poses and run bundle adjustment
    let avg_f = stitched_infos[0].image.width().max(stitched_infos[0].image.height()) as f64 * 1.25;
    let mut camera_poses = Vec::with_capacity(stitched_infos.len());

    for (k, &img_info) in stitched_infos.iter().enumerate() {
        let (w, h) = img_info.image.dimensions();
        let mut pose = CameraPose::new(k, w, h, Some(avg_f));
        if let Some(h_global) = global_homographies.get(&img_info.id) {
            let (yaw, pitch, roll) = crate::panorama_utils::camera_model::homography_to_relative_rotation(h_global, avg_f, w, h);
            pose.yaw = yaw;
            pose.pitch = pitch;
            pose.roll = roll;
        }
        camera_poses.push(pose);
    }

    // Levenberg-Marquardt Bundle Adjustment on 3D camera poses for HDR panels
    let mut tie_points: Vec<crate::panorama_utils::camera_model::MatchTiePoint> = Vec::new();
    let index_map: HashMap<usize, usize> = ordered_indices.iter().enumerate().map(|(k, &id)| (id, k)).collect();

    for (&(id1, id2), match_info) in &pairwise_matches {
        if let (Some(&k1), Some(&k2)) = (index_map.get(&id1), index_map.get(&id2)) {
            let s1 = image_infos[id1].scale_factor;
            let s2 = image_infos[id2].scale_factor;
            let f1 = &image_infos[id1].features;
            let f2 = &image_infos[id2].features;

            for m in &match_info.inlier_matches {
                let p1 = f1[m.index1].keypoint;
                let p2 = f2[m.index2].keypoint;

                let p1_full = nalgebra::Point2::new(p1.x as f64 / s1, p1.y as f64 / s1);
                let p2_full = nalgebra::Point2::new(p2.x as f64 / s2, p2.y as f64 / s2);

                tie_points.push(crate::panorama_utils::camera_model::MatchTiePoint {
                    img1: k1,
                    img2: k2,
                    p1: p1_full,
                    p2: p2_full,
                });
            }
        }
    }

    if !tie_points.is_empty() {
        crate::panorama_utils::camera_model::bundle_adjust_poses(&mut camera_poses, &tie_points, 15);
    }

    let pano = ray_traced_multiband_stitcher(&stitched_infos, &camera_poses, &[], projection, boundary_warp, app_handle);
    Ok(pano)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cluster_hdr_brackets_chunking_fallback() {
        let dummy_paths = vec![
            "IMG_0001.CR2".to_string(),
            "IMG_0002.CR2".to_string(),
            "IMG_0003.CR2".to_string(),
            "IMG_0004.CR2".to_string(),
            "IMG_0005.CR2".to_string(),
            "IMG_0006.CR2".to_string(),
        ];

        let groups = cluster_hdr_brackets(&dummy_paths);
        assert!(!groups.is_empty(), "Should generate bracket groups");
        let total_clustered: usize = groups.iter().map(|g| g.paths.len()).sum();
        assert_eq!(total_clustered, 6, "All 6 photos must be assigned to bracket groups without data loss");
    }

    #[test]
    fn test_hdr_to_feature_grayscale_contrast_and_texture() {
        let mut hdr_panel = Rgb32FImage::new(100, 100);
        for y in 0..100 {
            for x in 0..100 {
                // Wide dynamic range from deep shadow (0.005) to highlight (8.5)
                let lum = 0.005 + (x as f32 / 100.0) * 8.5;
                hdr_panel.put_pixel(x, y, image::Rgb([lum, lum, lum]));
            }
        }

        let gray = hdr_to_feature_grayscale(&hdr_panel);
        let min_val = gray.iter().copied().min().unwrap();
        let max_val = gray.iter().copied().max().unwrap();

        assert_eq!(min_val, 0, "Grayscale floor should be mapped to 0");
        assert_eq!(max_val, 255, "Grayscale ceiling should reach 255 for feature contrast");

        // Check that 18% gray (approx 0.18) is mapped into middle range rather than crushed near 0
        let mid_pixel = gray.get_pixel(50, 50)[0];
        assert!(mid_pixel > 80, "Midtone details must be lifted above dark floor for ORB detector, got {}", mid_pixel);
    }
}
