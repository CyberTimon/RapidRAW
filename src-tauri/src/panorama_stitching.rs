use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::file_management::parse_virtual_path;
use crate::panorama_utils::camera_model::{
    bundle_adjust_poses, compute_apap_mesh_warps, homography_to_relative_rotation, CameraPose,
    MatchTiePoint, PanoramaProjection,
};
use crate::panorama_utils::stitching::ray_traced_multiband_stitcher;
use base64::{engine::general_purpose, Engine as _};
use image::ImageFormat;
use image::{DynamicImage, GenericImageView, GrayImage, Rgb32FImage};
use nalgebra::{Matrix3, Point2};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::formats::is_raw_file;
use crate::panorama_utils::{processing, stitching};

pub const BRIEF_DESCRIPTOR_SIZE: usize = 256;
pub type Descriptor = [u8; BRIEF_DESCRIPTOR_SIZE / 8];

#[derive(Debug, Clone, Copy)]
pub struct KeyPoint {
    pub x: u32,
    pub y: u32,
}

pub struct Feature {
    pub keypoint: KeyPoint,
    pub descriptor: Descriptor,
}

#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub index1: usize,
    pub index2: usize,
}

pub struct ImageInfo {
    pub id: usize,
    pub filename: String,
    pub image: Rgb32FImage,
    #[allow(dead_code)]
    pub low_detail_mask: GrayImage,
    pub scale_factor: f64,
    pub features: Vec<Feature>,
}

#[derive(Clone)]
pub struct MatchInfo {
    pub homography: Matrix3<f64>,
    pub inliers: usize,
    pub inlier_matches: Vec<Match>,
}

#[tauri::command]
pub async fn stitch_panorama(
    paths: Vec<String>,
    projection: Option<PanoramaProjection>,
    boundary_warp: Option<f32>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("stitch_panorama");
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }

    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();

    let panorama_result_handle = state.panorama_result.clone();
    let selected_proj = projection.unwrap_or(stitching::PanoramaProjection::Cylindrical);
    let warp_strength = boundary_warp.unwrap_or(0.5);

    let task = tokio::task::spawn_blocking(move || {
        let panorama_result = stitch_images(source_paths, selected_proj, warp_strength, app_handle.clone());

        match panorama_result {
            Ok(panorama_image) => {
                let _ = app_handle.emit("panorama-progress", "Creating preview...");

                let (w, h) = panorama_image.dimensions();
                let (new_w, new_h) = if w > h {
                    (1000, ((1000.0 * h as f32 / w as f32).round() as u32).max(1))
                } else {
                    (((1000.0 * w as f32 / h as f32).round() as u32).max(1), 1000)
                };

                let preview_f32 =
                    crate::image_processing::downscale_f32_image(&panorama_image, new_w, new_h);

                let preview_u8 = preview_f32.to_rgb8();

                let mut buf = Cursor::new(Vec::new());

                if let Err(e) = preview_u8.write_to(&mut buf, ImageFormat::Png) {
                    return Err(format!("Failed to encode panorama preview: {}", e));
                }

                let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
                let final_base64 = format!("data:image/png;base64,{}", base64_str);

                *panorama_result_handle.lock().unwrap() = Some(panorama_image);

                let _ = app_handle.emit(
                    "panorama-complete",
                    serde_json::json!({
                        "base64": final_base64,
                    }),
                );
                Ok(())
            }
            Err(e) => {
                let _ = app_handle.emit("panorama-error", e.clone());
                Err(e)
            }
        }
    });

    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(format!("Panorama task failed: {}", join_err)),
    }
}

#[tauri::command]
pub async fn save_panorama(
    first_path_str: String,
    format: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let panorama_image = state
        .panorama_result
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            "No panorama image found in memory to save. It might have already been saved."
                .to_string()
        })?;
    let linear_radiance = state.panorama_linear_radiance.lock().unwrap().clone();

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");

    let export_format = format.as_deref().unwrap_or("jpeg");

    let output_filename = match export_format {
        "jpeg" | "jpg" => format!("{}_Pano.jpg", stem),
        "ultrahdr" => format!("{}_Pano_UltraHDR.jpg", stem),
        "png" => format!("{}_Pano.png", stem),
        "dng" => format!("{}_Pano.dng", stem),
        _ => format!("{}_Pano.tiff", stem),
    };

    let output_path = parent_dir.join(output_filename);

    match export_format {
        "jpeg" | "jpg" => {
            let sdr_rgb = panorama_image.to_rgb8();
            crate::export_processing::save_jpeg_high_quality(&output_path, &sdr_rgb)?;
        }
        "ultrahdr" => {
            let sdr_rgb = panorama_image.to_rgb8();
            let lin_img = linear_radiance.unwrap_or_else(|| panorama_image.to_rgb32f());
            crate::export_processing::save_ultrahdr_jpeg(&output_path, &lin_img, &sdr_rgb)?;
        }
        "png" => {
            panorama_image
                .save(&output_path)
                .map_err(|e| format!("Failed to save panorama image: {}", e))?;
        }
        "dng" => {
            let lin_img = linear_radiance.unwrap_or_else(|| panorama_image.to_rgb32f());
            let mut dng_meta = crate::dng_encoder::DngExportMetadata::default();
            dng_meta.description = Some(format!("RapidRAW 32-Bit Linear Panoramic Composite ({}_Pano)", stem));
            crate::dng_encoder::write_linear_dng_file(&output_path, &lin_img, Some(&dng_meta))
                .map_err(|e| format!("Failed to save 32-bit Linear DNG panorama: {}", e))?;
        }
        _ => {
            let lin_img = linear_radiance.unwrap_or_else(|| panorama_image.to_rgb32f());
            crate::export_processing::save_tiff_compressed(&output_path, &lin_img)?;
        }
    }

    let (real_path, _) = crate::file_management::parse_virtual_path(&first_path_str);
    let _ =
        crate::exif_processing::write_rrexif_sidecar(&real_path.to_string_lossy(), &output_path);

    Ok(output_path.to_string_lossy().to_string())
}

pub fn stitch_images(
    image_paths: Vec<String>,
    projection: PanoramaProjection,
    boundary_warp: f32,
    app_handle: AppHandle,
) -> Result<DynamicImage, String> {
    if image_paths.len() < 2 {
        return Err("At least two images are required for a panorama.".to_string());
    }

    let _ = app_handle.emit("panorama-progress", "Starting panorama process...");
    println!(
        "Starting panorama stitching process for {} images...",
        image_paths.len()
    );

    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Loading and extracting multi-scale ORB features...");
    println!("Loading and extracting multi-scale ORB features (in parallel)...");
    let brief_pairs = processing::generate_brief_pairs();

    let image_data_results: Vec<Result<ImageInfo, String>> = image_paths
        .par_iter()
        .enumerate()
        .map(|(i, filename)| {
            let _ = app_handle.emit(
                "panorama-progress",
                format!(
                    "Processing '{}'",
                    Path::new(filename)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ),
            );
            println!("  - Processing '{}'", filename);

            let file_bytes = fs::read(filename)
                .map_err(|e| format!("Failed to read image {}: {}", filename, e))?;

            let mut dynamic_image = crate::image_loader::load_base_image_from_bytes(
                &file_bytes,
                filename,
                false,
                &settings,
                None,
            )
            .map_err(|e| format!("Failed to load image {}: {}", filename, e))?;

            if is_raw_file(filename) {
                develop_and_normalize_raw_for_panorama(&mut dynamic_image);
            }

            let image_f32 = dynamic_image.to_rgb32f();

            let color_full_u8 = dynamic_image.to_rgb8();
            let gray_full = image::imageops::colorops::grayscale(&color_full_u8);

            let (w, h) = gray_full.dimensions();
            let (new_w, new_h, scale_factor) = processing::calculate_downscale_dimensions(w, h);

            let gray_small = image::imageops::resize(
                &gray_full,
                new_w,
                new_h,
                image::imageops::FilterType::Triangle,
            );

            let low_detail_mask = processing::generate_low_detail_mask(&gray_full);

            let features = processing::find_features(&gray_small, &brief_pairs);
            println!("    Found {} multi-scale ORB features in '{}'", features.len(), filename);

            Ok(ImageInfo {
                id: i,
                filename: filename.to_string(),
                image: image_f32,
                low_detail_mask,
                scale_factor,
                features,
            })
        })
        .collect();

    let mut image_data = Vec::new();
    for result in image_data_results {
        match result {
            Ok(info) => image_data.push(info),
            Err(e) => return Err(e),
        }
    }

    println!(
        "Image loading and feature detection completed in {:.2?}\n",
        start_time.elapsed()
    );

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Finding image matches...");
    println!("Finding all pairwise matches (in parallel)...");
    let mut pairwise_matches: HashMap<(usize, usize), MatchInfo> = HashMap::new();

    let pairs_to_check: Vec<(usize, usize)> = (0..image_data.len())
        .flat_map(|i| (i + 1..image_data.len()).map(move |j| (i, j)))
        .collect();

    let match_results: Vec<Option<((usize, usize), MatchInfo)>> = pairs_to_check
        .par_iter()
        .map(|&(i, j)| {
            let features1 = &image_data[i].features;
            let features2 = &image_data[j].features;

            let initial_matches = processing::match_features(features1, features2);
            if initial_matches.len() < processing::MIN_INLIERS_FOR_CONNECTION {
                return None;
            }

            let keypoints1: Vec<KeyPoint> = features1.iter().map(|f| f.keypoint).collect();
            let keypoints2: Vec<KeyPoint> = features2.iter().map(|f| f.keypoint).collect();

            if let Some((_h_small, inliers)) =
                processing::find_homography_ransac(&initial_matches, &keypoints1, &keypoints2)
                && inliers.len() >= processing::MIN_INLIERS_FOR_CONNECTION
            {
                println!(
                    "  - Good match found: '{}' <-> '{}' ({} inliers)",
                    Path::new(&image_data[i].filename)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy(),
                    Path::new(&image_data[j].filename)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy(),
                    inliers.len()
                );

                let inlier_points: Vec<(Point2<f64>, Point2<f64>)> = inliers
                    .iter()
                    .map(|m| {
                        let p1 = keypoints1[m.index1];
                        let p2 = keypoints2[m.index2];
                        (
                            Point2::new(p1.x as f64, p1.y as f64),
                            Point2::new(p2.x as f64, p2.y as f64),
                        )
                    })
                    .collect();

                if let Some(h_refined) = processing::compute_homography(&inlier_points) {
                    let s1 = image_data[i].scale_factor;
                    let s2 = image_data[j].scale_factor;
                    let scale_mat_i_inv =
                        Matrix3::new(1.0 / s1, 0.0, 0.0, 0.0, 1.0 / s1, 0.0, 0.0, 0.0, 1.0);
                    let scale_mat_j = Matrix3::new(s2, 0.0, 0.0, 0.0, s2, 0.0, 0.0, 0.0, 1.0);
                    let h_full = scale_mat_j * h_refined * scale_mat_i_inv;

                    let match_info = MatchInfo {
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

    for result in match_results.into_iter().flatten() {
        pairwise_matches.insert(result.0, result.1);
    }
    println!(
        "Pairwise matching completed in {:.2?}\n",
        start_time.elapsed()
    );

    if pairwise_matches.is_empty() {
        return Err(
            "No suitable matches found between any pair of images. Cannot create a panorama."
                .to_string(),
        );
    }

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Determining stitching order & estimating 3D camera poses...");
    println!("Determining stitching order & estimating 3D camera poses...");
    let (ordered_indices, global_homographies) =
        build_stitching_order(&image_data, &pairwise_matches);

    if ordered_indices.len() < 2 {
        return Err("Could not find a connected sequence of at least two images.".to_string());
    }

    let ordered_filenames: Vec<_> = ordered_indices
        .iter()
        .map(|&i| {
            Path::new(&image_data[i].filename)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
        .collect();
    println!("Stitching order determined: {:?}", ordered_filenames);

    let stitched_images_info: Vec<&ImageInfo> =
        ordered_indices.iter().map(|&i| &image_data[i]).collect();

    // 1. Initialize Camera Poses from global homographies
    let avg_f = image_data[0].image.width().max(image_data[0].image.height()) as f64 * 1.25;
    let mut camera_poses: Vec<CameraPose> = Vec::with_capacity(stitched_images_info.len());

    for (k, &img_info) in stitched_images_info.iter().enumerate() {
        let (w, h) = img_info.image.dimensions();
        let mut pose = CameraPose::new(k, w, h, Some(avg_f));
        if let Some(h_global) = global_homographies.get(&img_info.id) {
            let (yaw, pitch, roll) = homography_to_relative_rotation(h_global, avg_f, w, h);
            pose.yaw = yaw;
            pose.pitch = pitch;
            pose.roll = roll;
        }
        camera_poses.push(pose);
    }

    // 2. Collect tie points across all matched pairs and run Levenberg-Marquardt Bundle Adjustment
    let _ = app_handle.emit("panorama-progress", "Optimizing camera poses with Levenberg-Marquardt Bundle Adjustment...");
    println!("Running Levenberg-Marquardt Bundle Adjustment on 3D camera poses...");

    let mut tie_points: Vec<MatchTiePoint> = Vec::new();
    let index_map: HashMap<usize, usize> = ordered_indices.iter().enumerate().map(|(k, &id)| (id, k)).collect();

    for (&(id1, id2), match_info) in &pairwise_matches {
        if let (Some(&k1), Some(&k2)) = (index_map.get(&id1), index_map.get(&id2)) {
            let s1 = image_data[id1].scale_factor;
            let s2 = image_data[id2].scale_factor;
            let f1 = &image_data[id1].features;
            let f2 = &image_data[id2].features;

            for m in &match_info.inlier_matches {
                let p1 = f1[m.index1].keypoint;
                let p2 = f2[m.index2].keypoint;
                tie_points.push(MatchTiePoint {
                    img1: k1,
                    img2: k2,
                    p1: Point2::new(p1.x as f64 * s1, p1.y as f64 * s1),
                    p2: Point2::new(p2.x as f64 * s2, p2.y as f64 * s2),
                });
            }
        }
    }

    bundle_adjust_poses(&mut camera_poses, &tie_points, 20);

    let _ = app_handle.emit("panorama-progress", "Calculating local APAP mesh warps to eliminate parallax...");
    println!("Calculating local APAP mesh deformation grids to eliminate parallax...");
    let mesh_warps = compute_apap_mesh_warps(&camera_poses, &tie_points);

    let _start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Warping, 2D Graph-Cut & Multi-Band Spline Blending...");
    println!("Ray-traced stitching with APAP meshes, 2D Graph-Cut & Multi-Band Laplacian Pyramid Blending...");

    let panorama = ray_traced_multiband_stitcher(
        &stitched_images_info,
        &camera_poses,
        &mesh_warps,
        projection,
        boundary_warp,
        app_handle.clone(),
    );

    println!("Stitching completed in {:.2?}\n", start_time.elapsed());
    let _ = app_handle.emit("panorama-progress", "Finalizing panorama...");

    Ok(DynamicImage::ImageRgb32F(panorama))
}

struct Dsu {
    parent: Vec<usize>,
}

impl Dsu {
    fn new(n: usize) -> Self {
        Dsu {
            parent: (0..n).collect(),
        }
    }

    fn find(&mut self, i: usize) -> usize {
        if self.parent[i] == i {
            i
        } else {
            self.parent[i] = self.find(self.parent[i]);
            self.parent[i]
        }
    }

    fn union(&mut self, i: usize, j: usize) {
        let root_i = self.find(i);
        let root_j = self.find(j);
        if root_i != root_j {
            self.parent[root_i] = root_j;
        }
    }
}

fn build_stitching_order(
    images: &[ImageInfo],
    matches: &HashMap<(usize, usize), MatchInfo>,
) -> (Vec<usize>, HashMap<usize, Matrix3<f64>>) {
    if images.is_empty() {
        return (vec![], HashMap::new());
    }
    let n = images.len();
    if n < 2 {
        let mut homographies = HashMap::new();
        if n == 1 {
            homographies.insert(0, Matrix3::identity());
        }
        return ((0..n).collect(), homographies);
    }

    let mut edges = Vec::new();
    for (&(i, j), m) in matches {
        edges.push((m.inliers, i, j));
    }
    edges.sort_by_key(|&(inliers, _, _)| std::cmp::Reverse(inliers));

    let mut mst_adj: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut dsu = Dsu::new(n);
    let mut num_edges = 0;

    for &(_, i, j) in &edges {
        if dsu.find(i) != dsu.find(j) {
            dsu.union(i, j);
            mst_adj.entry(i).or_default().push(j);
            mst_adj.entry(j).or_default().push(i);
            num_edges += 1;
            if num_edges == n - 1 {
                break;
            }
        }
    }

    if mst_adj.is_empty() {
        return (vec![], HashMap::new());
    }

    // Find the largest connected component
    let mut component_sizes: HashMap<usize, usize> = HashMap::new();
    for i in 0..n {
        let root = dsu.find(i);
        *component_sizes.entry(root).or_default() += 1;
    }
    let largest_root = component_sizes
        .into_iter()
        .max_by_key(|&(_, count)| count)
        .map(|(root, _)| root)
        .unwrap_or(0);

    let candidate_nodes: Vec<usize> = mst_adj
        .keys()
        .copied()
        .filter(|&node| dsu.find(node) == largest_root)
        .collect();

    if candidate_nodes.is_empty() {
        return (vec![], HashMap::new());
    }

    // Find the central anchor node in the largest component
    let (start_node, radius) = {
        let mut best_node = candidate_nodes[0];
        let mut min_max_dist = usize::MAX;

        for &candidate in &candidate_nodes {
            let mut dist_map: HashMap<usize, usize> = HashMap::new();
            let mut bfs_q = VecDeque::new();
            dist_map.insert(candidate, 0);
            bfs_q.push_back(candidate);

            let mut max_d = 0;
            while let Some(curr) = bfs_q.pop_front() {
                let d = dist_map[&curr];
                max_d = max_d.max(d);
                if let Some(neighbors) = mst_adj.get(&curr) {
                    for &nxt in neighbors {
                        if !dist_map.contains_key(&nxt) {
                            dist_map.insert(nxt, d + 1);
                            bfs_q.push_back(nxt);
                        }
                    }
                }
            }

            if max_d < min_max_dist {
                min_max_dist = max_d;
                best_node = candidate;
            }
        }

        (best_node, min_max_dist)
    };

    println!("Selected central anchor image index: {} (radius: {})", start_node, radius);

    let mut ordered_indices = Vec::new();
    let mut global_homographies = HashMap::new();
    let mut q = VecDeque::new();
    let mut visited = HashSet::new();

    q.push_back((start_node, Matrix3::identity()));
    visited.insert(start_node);

    while let Some((u, h_u_global)) = q.pop_front() {
        ordered_indices.push(u);
        global_homographies.insert(u, h_u_global);

        if let Some(neighbors) = mst_adj.get(&u) {
            for &v in neighbors {
                if !visited.contains(&v) {
                    visited.insert(v);

                    let h_vu = if let Some(m) = matches.get(&(v, u)) {
                        m.homography
                    } else if let Some(m) = matches.get(&(u, v)) {
                        m.homography.try_inverse().unwrap_or_else(|| {
                            println!("Warning: Homography inversion failed between {} and {}, using fallback identity", u, v);
                            Matrix3::identity()
                        })
                    } else {
                        println!("Warning: Match not found between {} and {}, using identity", u, v);
                        Matrix3::identity()
                    };

                    let mut h_v_global: Matrix3<f64> = h_u_global * h_vu;

                    let h33 = h_v_global[(2, 2)];
                    if h33.abs() > 1e-6 {
                        h_v_global /= h33;
                    }
                    h_v_global[(2, 0)] = h_v_global[(2, 0)].clamp(-0.0003, 0.0003);
                    h_v_global[(2, 1)] = h_v_global[(2, 1)].clamp(-0.0003, 0.0003);

                    q.push_back((v, h_v_global));
                }
            }
        }
    }

    (ordered_indices, global_homographies)
}

/// Develops and normalizes RAW sensor data for panoramic stitching:
/// 1. Adaptive exposure scaling to place middle-gray and highlights properly
/// 2. Perceptual filmic S-curve tone mapping
/// 3. Saturation and natural color enhancement
pub fn develop_and_normalize_raw_for_panorama(image: &mut DynamicImage) {
    let mut f32_image = image.to_rgb32f();
    let (w, h) = f32_image.dimensions();
    let total_pixels = (w * h) as usize;
    if total_pixels == 0 {
        return;
    }

    // 1. Analyze 98.5th percentile luminance to compute adaptive exposure scaling
    let mut sample_lumas = Vec::with_capacity(10000);
    let step = (total_pixels / 10000).max(1);
    for i in (0..total_pixels).step_by(step) {
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        let p = f32_image.get_pixel(x, y);
        let luma = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
        if luma > 0.001 {
            sample_lumas.push(luma);
        }
    }
    sample_lumas.sort_by(|a, b| a.total_cmp(b));

    let p98 = if !sample_lumas.is_empty() {
        let idx = (sample_lumas.len() as f32 * 0.985) as usize;
        sample_lumas[idx.min(sample_lumas.len() - 1)].clamp(0.05, 1.0)
    } else {
        0.5
    };

    // Calculate exposure multiplier so highlights align near 0.95
    let exposure_gain = (0.95 / p98).clamp(1.0, 4.5);

    // 2. Perceptual Filmic S-curve & Saturation Boost
    f32_image.par_chunks_mut(3).for_each(|pixel| {
        let r = pixel[0] * exposure_gain;
        let g = pixel[1] * exposure_gain;
        let b = pixel[2] * exposure_gain;

        // Filmic tone curve (Reinhard / Hejl-Burgess-Dawson approximation)
        let tone_map = |x: f32| -> f32 {
            let x = x.max(0.0);
            (x * (1.0 + x * 0.4)) / (1.0 + x * (1.0 + x * 0.4) * 0.9 + 0.05)
        };

        let mut r_t = tone_map(r.powf(1.0 / 2.2));
        let mut g_t = tone_map(g.powf(1.0 / 2.2));
        let mut b_t = tone_map(b.powf(1.0 / 2.2));

        // Saturation boost for vibrant natural colors (+25% chroma)
        let luma = 0.2126 * r_t + 0.7152 * g_t + 0.0722 * b_t;
        r_t = (luma + (r_t - luma) * 1.25).clamp(0.0, 1.0);
        g_t = (luma + (g_t - luma) * 1.25).clamp(0.0, 1.0);
        b_t = (luma + (b_t - luma) * 1.25).clamp(0.0, 1.0);

        pixel[0] = r_t;
        pixel[1] = g_t;
        pixel[2] = b_t;
    });

    *image = DynamicImage::ImageRgb32F(f32_image);
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanoramaGroup {
    pub id: String,
    pub paths: Vec<String>,
    pub is_hdr: bool,
    pub count: usize,
    pub focal_length: Option<f64>,
}

#[tauri::command]
pub async fn detect_panorama_sequences(
    image_paths: Vec<String>,
) -> Result<Vec<PanoramaGroup>, String> {
    if image_paths.len() < 2 {
        return Ok(Vec::new());
    }

    let mut groups: Vec<PanoramaGroup> = Vec::new();
    let mut current_group: Vec<String> = Vec::new();
    let mut last_timestamp: Option<i64> = None;
    let mut last_focal: Option<f64> = None;

    for path_str in image_paths {
        let (real_path, _) = crate::file_management::parse_virtual_path(&path_str);
        let meta = crate::exif_processing::load_primary_metadata(&real_path);

        let mut timestamp = None;
        let mut focal = None;

        if let Some(exif) = &meta.exif {
            if let Some(dto) = exif.get("DateTimeOriginal") {
                if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(dto, "%Y:%m:%d %H:%M:%S") {
                    timestamp = Some(dt.and_utc().timestamp());
                }
            }
            if let Some(fl) = exif.get("FocalLength") {
                if let Ok(fl_val) = fl.trim_end_matches(" mm").parse::<f64>() {
                    focal = Some(fl_val);
                }
            }
        }

        let is_consecutive = match (last_timestamp, timestamp, last_focal, focal) {
            (Some(lt), Some(ct), Some(lf), Some(cf)) => {
                let dt = (ct - lt).abs();
                let df = (cf - lf).abs();
                dt <= 5 && df < 1.0
            }
            (Some(lt), Some(ct), _, _) => {
                let dt = (ct - lt).abs();
                dt <= 4
            }
            _ => false,
        };

        if is_consecutive {
            current_group.push(path_str);
        } else {
            if current_group.len() >= 2 {
                let count = current_group.len();
                groups.push(PanoramaGroup {
                    id: format!("pano_{}", count),
                    paths: current_group,
                    is_hdr: false,
                    count,
                    focal_length: last_focal,
                });
            }
            current_group = vec![path_str];
        }

        last_timestamp = timestamp;
        last_focal = focal;
    }

    if current_group.len() >= 2 {
        let count = current_group.len();
        groups.push(PanoramaGroup {
            id: format!("pano_{}", count),
            paths: current_group,
            is_hdr: false,
            count,
            focal_length: last_focal,
        });
    }

    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_catmull_rom_subpixel_sharpness() {
        let img = Rgb32FImage::from_pixel(10, 10, image::Rgb([0.5, 0.5, 0.5]));
        let px = crate::panorama_utils::stitching::get_catmull_rom_bicubic_pixel(&img, 5.0, 5.0);
        assert!((px[0] - 0.5).abs() < 1e-4);
    }
}
