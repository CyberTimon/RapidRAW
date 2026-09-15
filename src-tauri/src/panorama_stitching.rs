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
use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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

#[derive(Debug, Clone)]
pub struct Feature {
    pub keypoint: KeyPoint,
    pub descriptor: Descriptor,
}

#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub index1: usize,
    pub index2: usize,
}

#[derive(Clone)]
pub struct ImageInfo {
    pub id: usize,
    pub filename: String,
    pub full_width: u32,
    pub full_height: u32,
    pub proxy_image: Rgb32FImage,
    pub full_image: Option<Rgb32FImage>,
    #[allow(dead_code)]
    pub low_detail_mask: GrayImage,
    pub scale_factor: f64,
    pub features: Vec<Feature>,
    pub exposure_gain: f32,
}

impl ImageInfo {
    pub fn get_panel_image<'a>(
        &'a self,
        settings: &crate::app_settings::AppSettings,
    ) -> Result<Cow<'a, Rgb32FImage>, String> {
        if let Some(ref img) = self.full_image {
            Ok(Cow::Borrowed(img))
        } else {
            let img = load_single_full_res_panel(&self.filename, settings, Some(self.exposure_gain))?;
            Ok(Cow::Owned(img))
        }
    }
}

pub fn load_single_full_res_panel(
    filename: &str,
    settings: &crate::app_settings::AppSettings,
    fixed_exposure_gain: Option<f32>,
) -> Result<Rgb32FImage, String> {
    let file_bytes = fs::read(filename)
        .map_err(|e| format!("Failed to read image {}: {}", filename, e))?;

    let mut dynamic_image = crate::image_loader::load_base_image_from_bytes(
        &file_bytes,
        filename,
        false,
        settings,
        None,
    )
    .map_err(|e| format!("Failed to load image {}: {}", filename, e))?;

    if is_raw_file(filename) {
        let _gain = develop_and_normalize_raw_for_panorama(&mut dynamic_image, fixed_exposure_gain);
    }

    Ok(dynamic_image.to_rgb32f())
}

#[derive(Clone)]
pub struct MatchInfo {
    pub homography: Matrix3<f64>,
    pub inliers: usize,
    pub inlier_matches: Vec<Match>,
}

#[tauri::command]
pub fn cancel_panorama(state: tauri::State<'_, AppState>) {
    state.panorama_cancellation_token.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn stitch_panorama(
    paths: Vec<String>,
    projection: Option<PanoramaProjection>,
    boundary_warp: Option<f32>,
    half_size: Option<bool>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("stitch_panorama");
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }

    state.panorama_cancellation_token.store(false, Ordering::Relaxed);
    let cancel_token = state.panorama_cancellation_token.clone();

    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();

    let panorama_result_handle = state.panorama_result.clone();
    let panorama_metadata_handle = state.panorama_metadata.clone();
    let selected_proj = projection.unwrap_or(stitching::PanoramaProjection::Cylindrical);
    let warp_strength = boundary_warp.unwrap_or(0.5);
    let is_half_size = half_size.unwrap_or(false);

    let cancel_token_clone = cancel_token.clone();
    let app_handle_clone = app_handle.clone();
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    let task = tokio::task::spawn_blocking(move || {
        let hugin_res = crate::hugin_engine::run_hugin_panorama(
            &source_paths,
            selected_proj,
            &settings,
            is_half_size,
            None,
            Some(&app_handle_clone),
            Some(&cancel_token_clone),
        );

        match hugin_res {
            Ok(pano_f32) => {
                let panorama_image = DynamicImage::ImageRgb32F(pano_f32);
                let _ = app_handle.emit("panorama-progress", "Generating high-resolution preview... 98%");

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
                *panorama_metadata_handle.lock().unwrap() = Some((selected_proj, warp_strength));

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
    let pano_guard = state.panorama_result.lock().unwrap();
    let panorama_image = pano_guard
        .as_ref()
        .ok_or_else(|| {
            "No panorama image found in memory to save. It might have already been saved."
                .to_string()
        })?;
    let radiance_guard = state.panorama_linear_radiance.lock().unwrap();
    let linear_radiance = radiance_guard.as_ref();

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
    let (real_path, _) = crate::file_management::parse_virtual_path(&first_path_str);
    let real_path_str = real_path.to_string_lossy().to_string();

    match export_format {
        "jpeg" | "jpg" => {
            let sdr_rgb = panorama_image.to_rgb8();
            crate::export_processing::save_jpeg_high_quality_with_metadata(&output_path, &sdr_rgb, Some(&real_path_str))?;
        }
        "ultrahdr" => {
            let sdr_rgb = panorama_image.to_rgb8();
            let lin_img_fallback;
            let lin_img: &Rgb32FImage = match linear_radiance {
                Some(r) => r,
                None => {
                    lin_img_fallback = panorama_image.to_rgb32f();
                    &lin_img_fallback
                }
            };
            crate::export_processing::save_ultrahdr_jpeg_with_metadata(&output_path, lin_img, &sdr_rgb, Some(&real_path_str))?;
        }
        "png" => {
            crate::export_processing::save_png_high_quality_with_metadata(&output_path, panorama_image, Some(&real_path_str))?;
        }
        "dng" => {
            let lin_img_fallback;
            let lin_img: &Rgb32FImage = match linear_radiance {
                Some(r) => r,
                None => {
                    lin_img_fallback = panorama_image.to_rgb32f();
                    &lin_img_fallback
                }
            };
            let pano_meta = state.panorama_metadata.lock().unwrap().clone();
            let proj_tag = match pano_meta {
                Some((p, w)) => format!(" [{:?} Projection, Boundary Warp: {:.0}%]", p, w * 100.0),
                None => "".to_string(),
            };
            let mut dng_meta = crate::dng_encoder::DngExportMetadata::default();
            dng_meta.description = Some(format!("RapidRAW 32-Bit Linear Panoramic Composite ({}_Pano){}", stem, proj_tag));

            if let Ok(raw_source) = rawler::rawsource::RawSource::new(Path::new(&real_path_str)) {
                let loader = rawler::RawLoader::new();
                if let Ok(decoder) = loader.get_decoder(&raw_source) {
                    if let Ok(raw_meta) = decoder.raw_metadata(&raw_source, &Default::default()) {
                        if !raw_meta.make.is_empty() { dng_meta.make = Some(raw_meta.make); }
                        if !raw_meta.model.is_empty() { dng_meta.model = Some(raw_meta.model); }
                    }
                }
            }

            crate::dng_encoder::write_linear_dng_file(&output_path, lin_img, Some(&dng_meta))
                .map_err(|e| format!("Failed to save 32-bit Linear DNG panorama: {}", e))?;
        }
        _ => {
            let lin_img_fallback;
            let lin_img: &Rgb32FImage = match linear_radiance {
                Some(r) => r,
                None => {
                    lin_img_fallback = panorama_image.to_rgb32f();
                    &lin_img_fallback
                }
            };
            crate::export_processing::save_tiff_compressed(&output_path, lin_img)?;
        }
    }

    let _ =
        crate::exif_processing::write_rrexif_sidecar(&real_path_str, &output_path);

    Ok(output_path.to_string_lossy().to_string())
}

pub fn stitch_images(
    image_paths: Vec<String>,
    projection: PanoramaProjection,
    boundary_warp: f32,
    app_handle: AppHandle,
) -> Result<DynamicImage, String> {
    stitch_images_impl(image_paths, projection, boundary_warp, Some(&app_handle), None)
}

pub fn stitch_images_headless(
    image_paths: Vec<String>,
    projection: PanoramaProjection,
    boundary_warp: f32,
) -> Result<DynamicImage, String> {
    stitch_images_impl(image_paths, projection, boundary_warp, None, None)
}

fn stitch_images_impl(
    image_paths: Vec<String>,
    projection: PanoramaProjection,
    boundary_warp: f32,
    app_handle: Option<&AppHandle>,
    cancel_token: Option<&Arc<AtomicBool>>,
) -> Result<DynamicImage, String> {
    if image_paths.len() < 2 {
        return Err("At least two images are required for a panorama.".to_string());
    }

    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Initializing panorama pipeline... 5%");
    }
    println!(
        "Starting panorama stitching process for {} images...",
        image_paths.len()
    );

    let settings = app_handle
        .and_then(|h| load_settings(h.clone()).ok())
        .unwrap_or_default();

    let start_time = Instant::now();
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Loading images & extracting multi-scale ORB features... 10%");
    }
    println!("Loading and extracting multi-scale ORB features (memory-capped sequential pipeline)...");
    let brief_pairs = processing::generate_brief_pairs();

    let mut image_data = Vec::with_capacity(image_paths.len());
    let mut anchor_gain: Option<f32> = None;

    for (i, filename) in image_paths.iter().enumerate() {
        if let Some(token) = cancel_token {
            if token.load(Ordering::Relaxed) {
                return Err("Panorama stitching cancelled by user".to_string());
            }
        }
        let pct = 10 + ((i + 1) * 15 / image_paths.len());
        let name = Path::new(filename)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        if let Some(h) = app_handle {
            let _ = h.emit(
                "panorama-progress",
                format!("Extracting features '{}' ({}%)", name, pct),
            );
        }
        println!("  - Processing '{}' ({}/{})", filename, i + 1, image_paths.len());

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

        let exposure_gain = if is_raw_file(filename) {
            let g = develop_and_normalize_raw_for_panorama(&mut dynamic_image, anchor_gain);
            if anchor_gain.is_none() {
                anchor_gain = Some(g);
            }
            g
        } else {
            1.0
        };

        let (full_w, full_h) = dynamic_image.dimensions();
        let (new_w, new_h, scale_factor) = processing::calculate_downscale_dimensions(full_w, full_h);

        let proxy_dyn = dynamic_image.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle);
        let proxy_image = proxy_dyn.to_rgb32f();

        let color_small_u8 = proxy_dyn.to_rgb8();
        let gray_small = image::imageops::colorops::grayscale(&color_small_u8);
        drop(dynamic_image);
        drop(proxy_dyn);

        let low_detail_mask = processing::generate_low_detail_mask(&gray_small);

        let features = processing::find_features(&gray_small, &brief_pairs);
        println!("    Found {} multi-scale ORB features in '{}'", features.len(), filename);

        image_data.push(ImageInfo {
            id: i,
            filename: filename.to_string(),
            full_width: full_w,
            full_height: full_h,
            proxy_image,
            full_image: None,
            low_detail_mask,
            scale_factor,
            features,
            exposure_gain,
        });
    }

    println!(
        "Image loading and feature detection completed in {:.2?}\n",
        start_time.elapsed()
    );

    let start_time = Instant::now();
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Pairwise feature matching & homography estimation... 28%");
    }
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
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Determining stitching order & estimating 3D camera poses... 36%");
    }
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
    println!("  Stitching order: {:?}", ordered_filenames);

    let stitched_images_info: Vec<&ImageInfo> =
        ordered_indices.iter().map(|&i| &image_data[i]).collect();

    // 1. Convert Global Homographies into 3D Spherical/Cylindrical Camera Poses with True EXIF Focal Length
    let first_path = Path::new(&image_data[0].filename);
    let exif_focal_mm = crate::exif_processing::extract_focal_length_from_file(first_path);
    let exif_meta = crate::exif_processing::load_primary_metadata(first_path);
    let exif_f_number = exif_meta.exif.as_ref().and_then(|e| e.get("FNumber")).and_then(|s| {
        s.trim_start_matches('f').trim_start_matches('/').trim().parse::<f64>().ok()
    });
    let (first_w, first_h) = (image_data[0].full_width, image_data[0].full_height);
    let avg_f = if let Some(f_mm) = exif_focal_mm {
        let f_px = CameraPose::focal_length_from_exif(f_mm, None, first_w);
        println!("  - Detected physical EXIF Focal Length: {:.1} mm -> {:.1} pixels", f_mm, f_px);
        f_px
    } else {
        first_w.max(first_h) as f64 * 1.25
    };
    let mut camera_poses: Vec<CameraPose> = Vec::with_capacity(stitched_images_info.len());

    for (k, &img_info) in stitched_images_info.iter().enumerate() {
        let (w, h) = (img_info.full_width, img_info.full_height);
        let mut pose = CameraPose::new(k, w, h, Some(avg_f));
        if let Some(f_mm) = exif_focal_mm {
            pose = pose.with_vignetting_from_optical_params(f_mm, exif_f_number);
        }
        if let Some(h_global) = global_homographies.get(&img_info.id) {
            let (yaw, pitch, roll) = homography_to_relative_rotation(h_global, avg_f, w, h);
            pose.yaw = yaw;
            pose.pitch = pitch;
            pose.roll = roll;
        }
        camera_poses.push(pose);
    }

    // 2. Collect tie points across all matched pairs and run Levenberg-Marquardt Bundle Adjustment
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Optimizing 3D poses with Levenberg-Marquardt Bundle Adjustment... 42%");
    }
    println!("Running Levenberg-Marquardt Bundle Adjustment on 3D camera poses...");

    let mut tie_points: Vec<MatchTiePoint> = Vec::new();
    let index_map: HashMap<usize, usize> = ordered_indices.iter().enumerate().map(|(k, &id)| (id, k)).collect();

    for (&(id1, id2), match_info) in &pairwise_matches {
        if let (Some(&k1), Some(&k2)) = (index_map.get(&id1), index_map.get(&id2)) {
            let s1 = image_data[id1].scale_factor;
            let s2 = image_data[id2].scale_factor;
            let f1 = &image_data[id1].features;
            let f2 = &image_data[id2].features;
            let img1 = &image_data[id1].proxy_image;
            let img2 = &image_data[id2].proxy_image;

            for m in &match_info.inlier_matches {
                let p1 = f1[m.index1].keypoint;
                let p2 = f2[m.index2].keypoint;
                let p1_proxy = Point2::new(p1.x as f64, p1.y as f64);
                let p2_proxy = Point2::new(p2.x as f64, p2.y as f64);

                // Sub-pixel (1/16th px) Lucas-Kanade optical flow refinement on proxy radiance
                let p2_refined_proxy = processing::refine_match_klt_subpixel(img1, p1_proxy, img2, p2_proxy);
                let p1_full = Point2::new(p1.x as f64 * s1, p1.y as f64 * s1);
                let p2_refined_full = Point2::new(p2_refined_proxy.x * s2, p2_refined_proxy.y * s2);

                tie_points.push(MatchTiePoint {
                    img1: k1,
                    img2: k2,
                    p1: p1_full,
                    p2: p2_refined_full,
                });
            }
        }
    }

    if let Some(token) = cancel_token {
        if token.load(Ordering::Relaxed) {
            return Err("Panorama stitching cancelled by user".to_string());
        }
    }

    bundle_adjust_poses(&mut camera_poses, &tie_points, 20);
    crate::panorama_utils::camera_model::auto_level_camera_poses(&mut camera_poses);

    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Calculating local APAP mesh deformation grids... 48%");
    }
    println!("Calculating local APAP mesh deformation grids to eliminate parallax...");
    let mesh_warps = compute_apap_mesh_warps(&camera_poses, &tie_points);

    let _start_time = Instant::now();
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Ray-traced stitching & Multi-Band Laplacian Pyramid Blending... 50%");
    }
    println!("Ray-traced stitching with APAP meshes, 2D Graph-Cut & Multi-Band Laplacian Pyramid Blending...");

    let panorama = ray_traced_multiband_stitcher(
        &stitched_images_info,
        &camera_poses,
        &mesh_warps,
        projection,
        boundary_warp,
        app_handle,
        cancel_token,
        Some(&settings),
    )?;

    println!("Stitching completed in {:.2?}\n", start_time.elapsed());
    if let Some(h) = app_handle {
        let _ = h.emit("panorama-progress", "Finalizing panorama composition... 96%");
    }

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

pub(crate) fn build_stitching_order(
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
/// 1. Unified reference-anchored exposure scaling to prevent blotchy sky boundaries
/// 2. Perceptual filmic S-curve tone mapping
/// 3. Saturation and natural color enhancement
pub fn develop_and_normalize_raw_for_panorama(image: &mut DynamicImage, fixed_exposure_gain: Option<f32>) -> f32 {
    let mut f32_image = image.to_rgb32f();
    let (w, h) = f32_image.dimensions();
    let total_pixels = (w * h) as usize;
    if total_pixels == 0 {
        return 1.0;
    }

    // Auto-detect and correct Transverse Chromatic Aberration before feature detection
    let (tca_r, tca_b) = crate::lens_correction::auto_detect_transverse_chromatic_aberration(&f32_image);
    if (tca_r - 1.0).abs() > 1e-4 || (tca_b - 1.0).abs() > 1e-4 {
        crate::lens_correction::apply_radial_chromatic_aberration_correction(&mut f32_image, tca_r, tca_b);
    }

    let exposure_gain = match fixed_exposure_gain {
        Some(g) => g,
        None => 1.0,
    };

    let to_srgb = |x: f32| -> f32 {
        let x = (x * exposure_gain).clamp(0.0, 1.0);
        if x <= 0.0031308 {
            x * 12.92
        } else {
            1.055 * x.powf(1.0 / 2.4) - 0.055
        }
    };

    f32_image.par_chunks_mut(3).for_each(|pixel| {
        pixel[0] = to_srgb(pixel[0]);
        pixel[1] = to_srgb(pixel[1]);
        pixel[2] = to_srgb(pixel[2]);
    });

    crate::filmic_color_science::apply_filmic_color_science(
        &mut f32_image,
        &crate::filmic_color_science::FilmicColorParams::default(),
    );

    *image = DynamicImage::ImageRgb32F(f32_image);
    exposure_gain
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
