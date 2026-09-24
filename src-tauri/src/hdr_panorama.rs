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
use crate::exif_processing::{read_exposure_time_secs, read_iso, read_f_number};
use crate::file_management::parse_virtual_path;
#[allow(unused_imports)]
use crate::hdr_deghosting::{align_hdr_frames, compute_physical_exposure_scale, load_hdr_frames};
use std::time::Duration;
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
pub fn parse_exif_timestamp(datetime_str: &str) -> Option<u64> {
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HdrPanoGroupingReport {
    pub total_files: usize,
    pub panels: Vec<ExposureBracketGroup>,
    pub excluded_outliers: Vec<String>,
    pub is_consistent_bracket_size: bool,
    pub detected_bracket_size: usize,
}

/// Automatically clusters arbitrary RAW photo selections into HDR exposure bracket groups
/// by physical exposure scale E = (t * ISO) / F^2, temporal burst proximity, and outlier isolation.
pub fn cluster_hdr_brackets_robust(paths: &[String]) -> (Vec<ExposureBracketGroup>, Vec<String>) {
    if paths.is_empty() {
        return (Vec::new(), Vec::new());
    }

    #[derive(Clone)]
    struct ItemMeta {
        path: String,
        timestamp: u64,
        physical_scale: f32,
    }

    let mut items: Vec<ItemMeta> = Vec::with_capacity(paths.len());

    for path in paths {
        let (source_path, _) = parse_virtual_path(path);
        let file_bytes = fs::read(&source_path).unwrap_or_default();
        let exposure_sec = read_exposure_time_secs(&source_path.to_string_lossy(), &file_bytes).unwrap_or(0.01);
        let iso = read_iso(&source_path.to_string_lossy(), &file_bytes).map(|g| g as f32).unwrap_or(100.0);
        let f_number = read_f_number(&source_path.to_string_lossy(), &file_bytes).unwrap_or(5.6);
        let physical_scale = compute_physical_exposure_scale(Duration::from_secs_f32(exposure_sec), iso, f_number);

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
            physical_scale,
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

    // Detect and isolate temporal outliers (e.g. disconnected shots separated by > 60s from the burst sequence)
    let mut cohesive_items = Vec::new();
    let mut excluded_outliers = Vec::new();

    let n = items.len();
    for i in 0..n {
        let t = items[i].timestamp;
        let mut is_outlier = false;

        if n >= 4 && t > 0 {
            let prev_gap = if i > 0 && items[i - 1].timestamp > 0 {
                (t as i64 - items[i - 1].timestamp as i64).abs()
            } else {
                0
            };
            let next_gap = if i + 1 < n && items[i + 1].timestamp > 0 {
                (items[i + 1].timestamp as i64 - t as i64).abs()
            } else {
                0
            };

            // Tail outlier: last frame shot > 60 seconds after preceding burst
            if i == n - 1 && prev_gap > 60 {
                is_outlier = true;
            }
            // Head outlier: first frame shot > 60 seconds before following burst
            if i == 0 && next_gap > 60 {
                is_outlier = true;
            }
        }

        if is_outlier {
            println!("  [HDR Pano] Isolating outlier frame {} (temporal delta > 60s)", items[i].path);
            excluded_outliers.push(items[i].path.clone());
        } else {
            cohesive_items.push(items[i].clone());
        }
    }

    let mut groups: Vec<ExposureBracketGroup> = Vec::new();
    let mut current_group: Vec<ItemMeta> = Vec::new();

    for item in cohesive_items {
        let mut start_new_group = false;

        if !current_group.is_empty() {
            let prev_item = current_group.last().unwrap();

            // 1. Check temporal gap: if timestamp delta > 15 seconds, likely a different angle or pause
            if prev_item.timestamp > 0 && item.timestamp > 0 {
                let dt = (item.timestamp as i64 - prev_item.timestamp as i64).abs();
                if dt > 15 {
                    start_new_group = true;
                }
            }

            // 2. Exposure collision check: in an HDR bracket, all frames must have distinct exposures.
            // If current_group already contains a frame with a similar exposure scale (ratio in [0.80, 1.25]),
            // this new frame cannot be part of the same bracket and must start the next bracket.
            if !start_new_group {
                let has_duplicate_exposure = current_group.iter().any(|existing| {
                    let r = if existing.physical_scale > 0.0 {
                        item.physical_scale / existing.physical_scale
                    } else {
                        1.0
                    };
                    r >= 0.80 && r <= 1.25
                });

                if has_duplicate_exposure {
                    start_new_group = true;
                }
            }

            // 3. Bracket length limit: standard brackets are 3 frames (or max 5 frames).
            // If we have reached 3 frames and total cohesive count is a multiple of 3, start new group.
            let total_cohesive = paths.len().saturating_sub(excluded_outliers.len());
            if !start_new_group && current_group.len() >= 3 {
                if total_cohesive % 3 == 0 || current_group.len() >= 5 {
                    start_new_group = true;
                }
            }
        }

        if start_new_group && !current_group.is_empty() {
            groups.push(ExposureBracketGroup {
                position_index: groups.len(),
                paths: current_group.iter().map(|it| it.path.clone()).collect(),
            });
            current_group.clear();
        }

        current_group.push(item);
    }

    if !current_group.is_empty() {
        groups.push(ExposureBracketGroup {
            position_index: groups.len(),
            paths: current_group.iter().map(|it| it.path.clone()).collect(),
        });
    }

    // Smart fallback: If grouping produced single-frame orphans or only 1 group,
    // but the cohesive files count is divisible by 3 and >= 6, chunk by 3!
    let total_cohesive = paths.len().saturating_sub(excluded_outliers.len());
    let has_orphans = groups.iter().any(|g| g.paths.len() < 2);
    if (groups.len() <= 1 || has_orphans) && total_cohesive >= 6 && total_cohesive % 3 == 0 {
        let mut fallback_paths = Vec::new();
        for path in paths {
            if !excluded_outliers.contains(path) {
                fallback_paths.push(path.clone());
            }
        }
        let fallback_groups: Vec<ExposureBracketGroup> = fallback_paths
            .chunks(3)
            .enumerate()
            .map(|(i, chunk)| ExposureBracketGroup {
                position_index: i,
                paths: chunk.to_vec(),
            })
            .collect();
        return (fallback_groups, excluded_outliers);
    }

    (groups, excluded_outliers)
}

pub fn cluster_hdr_brackets(paths: &[String]) -> Vec<ExposureBracketGroup> {
    cluster_hdr_brackets_robust(paths).0
}

#[tauri::command]
pub async fn stitch_hdr_panorama(
    paths: Vec<String>,
    projection: Option<PanoramaProjection>,
    boundary_warp: Option<f32>,
    half_size: Option<bool>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _sleep_guard = SleepLockGuard::new("stitch_hdr_panorama");

    if paths.len() < 3 {
        return Err("At least 3 photos are required for an HDR Panorama.".to_string());
    }

    let selected_projection = projection.unwrap_or(PanoramaProjection::Cylindrical);
    let _warp_strength = boundary_warp.unwrap_or(0.5);
    let panorama_result_handle = state.panorama_result.clone();
    let panorama_linear_radiance_handle = state.panorama_linear_radiance.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let handle_for_task = app_handle.clone();
    let is_half_size = half_size.unwrap_or(false);

    let cancel_token = state.panorama_cancellation_token.clone();
    let task = tokio::task::spawn_blocking(move || {
        let final_hdr_pano = crate::hugin_engine::run_hugin_hdr_panorama(
            &paths,
            selected_projection,
            &settings,
            is_half_size,
            Some(&handle_for_task),
            Some(&cancel_token),
        )?;

        // 4. Create high-resolution preview directly from the tone-fused output without double tone-mapping
        let _ = handle_for_task.emit("panorama-progress", "Creating HDR Panorama preview... 98%");
        let master_dyn = DynamicImage::ImageRgb32F(final_hdr_pano.clone());
        let master_rgb8 = master_dyn.to_rgb8();
        let (w, h) = (master_rgb8.width(), master_rgb8.height());

        let (new_w, new_h) = if w > h {
            (1200, ((1200.0 * h as f32 / w as f32).round() as u32).max(1))
        } else {
            (((1200.0 * w as f32 / h as f32).round() as u32).max(1), 1200)
        };

        let preview_u8 = image::imageops::resize(&master_rgb8, new_w, new_h, image::imageops::FilterType::Triangle);

        let mut buf = std::io::Cursor::new(Vec::new());
        if let Err(e) = preview_u8.write_to(&mut buf, ImageFormat::Png) {
            return Err(format!("Failed to encode HDR panorama preview: {}", e));
        }

        use base64::{engine::general_purpose, Engine as _};
        let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
        let final_base64 = format!("data:image/png;base64,{}", base64_str);

        *panorama_result_handle.lock().unwrap() = Some(master_dyn);
        *panorama_linear_radiance_handle.lock().unwrap() = Some(final_hdr_pano);

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
            if lum > 0.00001 && lum.is_finite() {
                lums.push(lum);
            }
        }
    }

    let (p01, p99) = if lums.is_empty() {
        (0.0f32, 1.0f32)
    } else {
        lums.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx01 = (lums.len() as f32 * 0.01) as usize;
        let idx99 = ((lums.len() as f32 * 0.99) as usize).min(lums.len() - 1);
        (lums[idx01].max(0.0), lums[idx99].max(0.001))
    };

    let span = (p99 - p01).max(1e-5);
    let log_denom = (1.0f32 + 20.0f32).ln();

    // 2. Perceptual log-luminance mapping + sRGB gamma 2.2 to preserve sharp feature gradients
    // across deep shadow foliage, iron bridge details, and bright skies simultaneously.
    for y in 0..h {
        for x in 0..w {
            let p = panel.get_pixel(x, y);
            let lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).max(0.0);
            let relative = ((lum - p01) / span).clamp(0.0, 1.0);
            let norm = (1.0 + 20.0 * relative).ln() / log_denom;
            let val = (norm.powf(1.0 / 2.2) * 255.0).clamp(0.0, 255.0) as u8;
            gray.put_pixel(x, y, image::Luma([val]));
        }
    }

    crate::panorama_utils::processing::normalize_grayscale(&gray)
}

/// Stitches pre-merged 32-bit float HDR image panels using robust multi-scale ORB matching,
/// scaled homography RANSAC, MST anchor selection, and bundle adjustment.
pub fn stitch_hdr_panels(
    panels: &[Rgb32FImage],
    projection: PanoramaProjection,
    boundary_warp: f32,
    optical_params: Option<(f64, Option<f64>)>,
    app_handle: Option<&AppHandle>,
) -> Result<Rgb32FImage, String> {
    if panels.is_empty() {
        return Err("No HDR panels available to stitch.".to_string());
    }
    if panels.len() == 1 {
        return Ok(panels[0].clone());
    }

    let brief_pairs = crate::panorama_utils::processing::generate_brief_pairs();

    // Extract perceptual grayscale representations once for all multi-scale matching passes
    let grays_full: Vec<image::GrayImage> = panels.iter().map(|p| hdr_to_feature_grayscale(p)).collect();

    let image_infos: Vec<ImageInfo> = panels
        .iter()
        .enumerate()
        .map(|(i, panel)| {
            let gray_full = &grays_full[i];
            let (w, h) = gray_full.dimensions();
            let (new_w, new_h, scale_factor) = crate::panorama_utils::processing::calculate_downscale_dimensions(w, h);
            let gray_small = image::imageops::resize(gray_full, new_w, new_h, image::imageops::FilterType::Triangle);
            let low_detail_mask = crate::panorama_utils::processing::generate_low_detail_mask(gray_full);
            let features = crate::panorama_utils::processing::find_features(&gray_small, &brief_pairs);
            println!("  [HDR Pano] Angle {}: extracted {} features (scale: {:.2})", i + 1, features.len(), scale_factor);

            let proxy_dyn = DynamicImage::ImageRgb32F(panel.clone()).resize_exact(new_w, new_h, image::imageops::FilterType::Triangle);
            let proxy_image = proxy_dyn.to_rgb32f();

            ImageInfo {
                id: i,
                filename: format!("HDR_Angle_{:02}", i + 1),
                full_width: w,
                full_height: h,
                proxy_image,
                full_image: Some(panel.clone()),
                low_detail_mask,
                scale_factor,
                features,
                exposure_gain: 1.0,
            }
        })
        .collect();

    let min_inliers = crate::panorama_utils::processing::MIN_INLIERS_FOR_CONNECTION; // Enforce strict 15 inlier floor for robust graph topology

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
            println!("  [HDR Pano] Pair ({}, {}): {} initial matches", i + 1, j + 1, initial_matches.len());
            let mut best_match: Option<crate::panorama_stitching::MatchInfo> = None;

            if initial_matches.len() >= min_inliers {
                let keypoints1: Vec<crate::panorama_stitching::KeyPoint> = features1.iter().map(|f| f.keypoint).collect();
                let keypoints2: Vec<crate::panorama_stitching::KeyPoint> = features2.iter().map(|f| f.keypoint).collect();

                if let Some((_h_small, inliers)) = crate::panorama_utils::processing::find_homography_ransac_with_min_inliers(&initial_matches, &keypoints1, &keypoints2, min_inliers)
                    && inliers.len() >= min_inliers
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

                        best_match = Some(crate::panorama_stitching::MatchInfo {
                            homography: h_full,
                            inliers: inliers.len(),
                            inlier_matches: inliers,
                        });
                    }
                }
            }

            // High-resolution fallback pass if pair is borderline or has < 25 inliers (e.g. low-contrast rails/foliage)
            let inlier_count = best_match.as_ref().map(|m| m.inliers).unwrap_or(0);
            if inlier_count < 25 {
                let gray_full_1 = &grays_full[i];
                let gray_full_2 = &grays_full[j];
                let (w1, h1) = gray_full_1.dimensions();
                let (w2, h2) = gray_full_2.dimensions();
                let (hd_w1, hd_h1, hd_s1) = crate::panorama_utils::processing::calculate_downscale_dimensions_capped(w1, h1, 2400);
                let (hd_w2, hd_h2, hd_s2) = crate::panorama_utils::processing::calculate_downscale_dimensions_capped(w2, h2, 2400);

                let hd_img1 = image::imageops::resize(gray_full_1, hd_w1, hd_h1, image::imageops::FilterType::Triangle);
                let hd_img2 = image::imageops::resize(gray_full_2, hd_w2, hd_h2, image::imageops::FilterType::Triangle);

                let hd_feat1 = crate::panorama_utils::processing::find_features_tuned(&hd_img1, &brief_pairs, 7, 12.0);
                let hd_feat2 = crate::panorama_utils::processing::find_features_tuned(&hd_img2, &brief_pairs, 7, 12.0);

                let hd_matches = crate::panorama_utils::processing::match_features(&hd_feat1, &hd_feat2);
                if hd_matches.len() >= min_inliers {
                    let hd_kp1: Vec<crate::panorama_stitching::KeyPoint> = hd_feat1.iter().map(|f| f.keypoint).collect();
                    let hd_kp2: Vec<crate::panorama_stitching::KeyPoint> = hd_feat2.iter().map(|f| f.keypoint).collect();

                    if let Some((_h_small, hd_inliers)) = crate::panorama_utils::processing::find_homography_ransac_with_min_inliers(&hd_matches, &hd_kp1, &hd_kp2, min_inliers)
                        && hd_inliers.len() > inlier_count
                    {
                        println!("  [HDR Pano] Adaptive HD fallback for pair ({}, {}): {} matches, {} inliers (previously {})",
                            i + 1, j + 1, hd_matches.len(), hd_inliers.len(), inlier_count);

                        let inlier_points: Vec<(nalgebra::Point2<f64>, nalgebra::Point2<f64>)> = hd_inliers
                            .iter()
                            .map(|m| {
                                let p1 = hd_kp1[m.index1];
                                let p2 = hd_kp2[m.index2];
                                (
                                    nalgebra::Point2::new(p1.x as f64, p1.y as f64),
                                    nalgebra::Point2::new(p2.x as f64, p2.y as f64),
                                )
                            })
                            .collect();

                        if let Some(h_refined) = crate::panorama_utils::processing::compute_homography(&inlier_points) {
                            let scale_mat_i_inv = nalgebra::Matrix3::new(1.0 / hd_s1, 0.0, 0.0, 0.0, 1.0 / hd_s1, 0.0, 0.0, 0.0, 1.0);
                            let scale_mat_j = nalgebra::Matrix3::new(hd_s2, 0.0, 0.0, 0.0, hd_s2, 0.0, 0.0, 0.0, 1.0);
                            let h_full = scale_mat_j * h_refined * scale_mat_i_inv;

                            best_match = Some(crate::panorama_stitching::MatchInfo {
                                homography: h_full,
                                inliers: hd_inliers.len(),
                                inlier_matches: hd_inliers,
                            });
                        }
                    }
                }
            }

            if let Some(ref m) = best_match {
                println!("  [HDR Pano] Final accepted match pair ({}, {}): {} inliers", i + 1, j + 1, m.inliers);
                Some(((i, j), best_match.unwrap()))
            } else {
                None
            }
        })
        .collect();

    let mut pairwise_matches: HashMap<(usize, usize), crate::panorama_stitching::MatchInfo> = HashMap::new();
    for (pair, info) in match_results.into_iter().flatten() {
        pairwise_matches.insert(pair, info);
    }
    println!("  [HDR Pano] Total matched pairs found: {}", pairwise_matches.len());

    if pairwise_matches.is_empty() {
        return Err("Could not align enough overlapping HDR panels. Ensure at least 30% overlap between adjacent shots.".to_string());
    }

    let (ordered_indices, global_homographies) = crate::panorama_stitching::build_stitching_order(&image_infos, &pairwise_matches);

    if ordered_indices.len() < 2 {
        return Err("Could not align enough overlapping HDR panels. Ensure at least 30% overlap between adjacent shots.".to_string());
    }

    let stitched_infos: Vec<&ImageInfo> = ordered_indices.iter().map(|&i| &image_infos[i]).collect();

    // 1. Initialize camera poses with optical physics & vignetting compensation
    let (first_w, first_h) = (stitched_infos[0].full_width, stitched_infos[0].full_height);
    let (avg_f, vig_params) = if let Some((f_mm, fn_opt)) = optical_params {
        let f_px = CameraPose::focal_length_from_exif(f_mm, None, first_w);
        println!("  - HDR Pano physical focal length: {:.1} mm -> {:.1} px", f_mm, f_px);
        (f_px, Some((f_mm, fn_opt)))
    } else {
        (first_w.max(first_h) as f64 * 1.25, None)
    };
    let mut camera_poses = Vec::with_capacity(stitched_infos.len());

    for (k, &img_info) in stitched_infos.iter().enumerate() {
        let (w, h) = (img_info.full_width, img_info.full_height);
        let mut pose = CameraPose::new(k, w, h, Some(avg_f));
        if let Some((f_mm, fn_opt)) = vig_params {
            pose = pose.with_vignetting_from_optical_params(f_mm, fn_opt);
        }
        if let Some(h_global) = global_homographies.get(&img_info.id) {
            let (yaw, pitch, roll) = crate::panorama_utils::camera_model::homography_to_relative_rotation(h_global, avg_f, w, h);
            pose.yaw = yaw;
            pose.pitch = pitch;
            pose.roll = roll;
        }
        camera_poses.push(pose);
    }

    // 2. Levenberg-Marquardt Bundle Adjustment on 3D camera poses for HDR panels
    let mut tie_points: Vec<crate::panorama_utils::camera_model::MatchTiePoint> = Vec::new();
    let index_map: HashMap<usize, usize> = ordered_indices.iter().enumerate().map(|(k, &id)| (id, k)).collect();

    for (&(id1, id2), match_info) in &pairwise_matches {
        if let (Some(&k1), Some(&k2)) = (index_map.get(&id1), index_map.get(&id2)) {
            let s1 = image_infos[id1].scale_factor;
            let s2 = image_infos[id2].scale_factor;
            let f1 = &image_infos[id1].features;
            let f2 = &image_infos[id2].features;
            let img1 = &image_infos[id1].proxy_image;
            let img2 = &image_infos[id2].proxy_image;

            for m in &match_info.inlier_matches {
                let p1 = f1[m.index1].keypoint;
                let p2 = f2[m.index2].keypoint;

                let p1_proxy = nalgebra::Point2::new(p1.x as f64, p1.y as f64);
                let p2_proxy = nalgebra::Point2::new(p2.x as f64, p2.y as f64);

                let p2_refined_proxy = crate::panorama_utils::processing::refine_match_klt_subpixel(img1, p1_proxy, img2, p2_proxy);
                let p1_full = nalgebra::Point2::new(p1.x as f64 * s1, p1.y as f64 * s1);
                let p2_refined_full = nalgebra::Point2::new(p2_refined_proxy.x * s2, p2_refined_proxy.y * s2);

                tie_points.push(crate::panorama_utils::camera_model::MatchTiePoint {
                    img1: k1,
                    img2: k2,
                    p1: p1_full,
                    p2: p2_refined_full,
                });
            }
        }
    }

    if !tie_points.is_empty() {
        crate::panorama_utils::camera_model::bundle_adjust_poses(&mut camera_poses, &tie_points, 15);
    }

    // 3. Automatic Horizon Roll & Pitch Leveling
    crate::panorama_utils::camera_model::auto_level_camera_poses(&mut camera_poses);

    // 4. Compute local APAP mesh deformation grids to eliminate parallax in HDR panels
    let mesh_warps = crate::panorama_utils::camera_model::compute_apap_mesh_warps(&camera_poses, &tie_points);

    let pano = ray_traced_multiband_stitcher(
        &stitched_infos,
        &camera_poses,
        &mesh_warps,
        projection,
        boundary_warp,
        app_handle,
        None,
        None,
    )?;
    Ok(pano)
}

#[tauri::command]
pub fn inspect_hdr_pano_grouping(paths: Vec<String>) -> Result<HdrPanoGroupingReport, String> {
    let (panels, excluded_outliers) = cluster_hdr_brackets_robust(&paths);
    let total_files = paths.len();
    let detected_bracket_size = if !panels.is_empty() { panels[0].paths.len() } else { 0 };
    let is_consistent_bracket_size = !panels.is_empty() && panels.iter().all(|p| p.paths.len() == detected_bracket_size);

    Ok(HdrPanoGroupingReport {
        total_files,
        panels,
        excluded_outliers,
        is_consistent_bracket_size,
        detected_bracket_size,
    })
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
