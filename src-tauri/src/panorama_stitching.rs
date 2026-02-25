use crate::file_management::load_settings;
use image::{DynamicImage, GrayImage, Rgb32FImage};
use nalgebra::Matrix3;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::formats::is_raw_file;
use crate::image_processing::apply_cpu_default_raw_processing;
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
    pub low_detail_mask: GrayImage,
    pub scale_factor: f64,
    pub features: Vec<Feature>,
}

#[derive(Clone)]
pub struct MatchInfo {
    pub homography: Matrix3<f64>,
    pub inliers: usize,
}

pub fn stitch_images(
    image_paths: Vec<String>,
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
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode;

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Loading and preparing images...");
    println!("Loading and preparing images (in parallel)...");
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
                highlight_compression,
                linear_mode.clone(),
                None,
            )
            .map_err(|e| format!("Failed to load image {}: {}", filename, e))?;

            if is_raw_file(filename) {
                apply_cpu_default_raw_processing(&mut dynamic_image);
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
            println!("    Found {} features in '{}'", features.len(), filename);

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
            {
                if inliers.len() >= processing::MIN_INLIERS_FOR_CONNECTION {
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

                    let inlier_points: Vec<(nalgebra::Point2<f64>, nalgebra::Point2<f64>)> =
                        inliers
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
                        };
                        return Some(((i, j), match_info));
                    }
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
    let _ = app_handle.emit("panorama-progress", "Determining stitching order...");
    println!("Determining stitching order...");
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
    let _ = app_handle.emit(
        "panorama-progress",
        format!("Stitching order: {}", ordered_filenames.join(" -> ")),
    );

    let stitched_images_info: Vec<&ImageInfo> =
        ordered_indices.iter().map(|&i| &image_data[i]).collect();
    let unstitched_count = image_data.len() - stitched_images_info.len();
    if unstitched_count > 0 {
        let warning_msg = format!(
            "Warning: {} image(s) could not be matched and will be excluded.",
            unstitched_count
        );
        println!("{}", warning_msg);
        let _ = app_handle.emit("panorama-warning", warning_msg);
    }
    println!(
        "Global homography calculation completed in {:.2?}\n",
        start_time.elapsed()
    );

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Warping and blending images...");
    println!("Warping and blending full-resolution images with progressive optimal seams...");

    let panorama = stitching::progressive_seam_stitcher(
        &stitched_images_info,
        &global_homographies,
        app_handle.clone(),
    );

    println!("Stitching completed in {:.2?}\n", start_time.elapsed());

    let _ = app_handle.emit("panorama-progress", "Finalizing panorama...");

    Ok(DynamicImage::ImageRgb32F(panorama))
}

struct DSU {
    parent: Vec<usize>,
}

impl DSU {
    fn new(n: usize) -> Self {
        DSU {
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
    let mut dsu = DSU::new(n);
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

    let start_node = (0..n)
        .filter(|i| mst_adj.contains_key(i))
        .min_by_key(|&i| mst_adj.get(&i).map_or(usize::MAX, |v| v.len()))
        .unwrap_or_else(|| mst_adj.keys().next().copied().unwrap_or(0));

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
                        m.homography
                            .try_inverse()
                            .expect("Failed to invert homography for MST edge")
                    } else {
                        panic!("Match not found for MST edge between {} and {}", u, v);
                    };

                    let h_v_global = h_u_global * h_vu;
                    q.push_back((v, h_v_global));
                }
            }
        }
    }

    (ordered_indices, global_homographies)
}