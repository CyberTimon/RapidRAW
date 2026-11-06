use crate::app_settings::AppSettings;
use crate::exif_processing::{read_exposure_time_secs, read_iso};
use crate::formats::is_raw_file;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::{
    apply_cpu_default_raw_processing, apply_linear_to_srgb, apply_srgb_to_linear,
};
use crate::panorama_stitching::{Feature, KeyPoint, Match};
use crate::panorama_utils::{processing, stitching};
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use nalgebra::{Matrix2, Matrix3, Point2};
use std::fs;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type HdrFrame = (String, DynamicImage, Duration, f32);

const DEGHOST_FAST_THRESHOLD: u8 = 8;
const DEGHOST_NON_MAXIMA_SUPPRESSION_RADIUS: f32 = 8.0;
const DEGHOST_MAX_PROCESSING_DIMENSION: u32 = 3200;
const DEGHOST_IDENTITY_MAX_DISPLACEMENT: f64 = 1.0;

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

pub fn load_hdr_frames(
    paths: &[String],
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Result<Vec<HdrFrame>, String> {
    assert!(paths.len() >= 2, "hdr merge requires at least two paths");
    paths
        .iter()
        .map(|path| {
            let _ = app_handle.emit(
                "hdr-progress",
                format!(
                    "Processing '{}'",
                    Path::new(path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ),
            );
            let file_bytes =
                fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
            let mut dynamic_image =
                load_base_image_from_bytes(&file_bytes, path, false, settings, None)
                    .map_err(|e| format!("Failed to load image {}: {}", path, e))?;
            if !is_raw_file(path) {
                dynamic_image = apply_srgb_to_linear(dynamic_image);
            }
            let gains = match read_iso(path, &file_bytes) {
                None => return Err(format!("Image {} is missing ISO/Sensitivity data", path)),
                Some(gains) => gains as f32,
            };
            let exposure = match read_exposure_time_secs(path, &file_bytes) {
                None => return Err(format!("Image {} is missing ExposureTime data", path)),
                Some(exp) => Duration::from_secs_f32(exp),
            };
            Ok((path.clone(), dynamic_image, exposure, gains))
        })
        .collect()
}

pub fn assert_uniform_dimensions(frames: &[HdrFrame]) -> Result<(), String> {
    assert!(
        !frames.is_empty(),
        "dimension check requires at least one frame"
    );
    let (first_path, first_image, _, _) = &frames[0];
    let width = first_image.width();
    let height = first_image.height();
    for (path, image, _, _) in frames.iter().skip(1) {
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

pub fn align_hdr_frames(frames: &mut [HdrFrame], app_handle: &AppHandle) {
    assert!(!frames.is_empty(), "alignment requires at least one frame");
    let _ = app_handle.emit("hdr-progress", "Deghosting...");
    let brief_pairs = processing::generate_brief_pairs();
    let reference_index = frames.len() / 2;
    let detections: Vec<FrameDetection> = frames
        .iter()
        .map(|frame| detect_frame_features(&frame.1, &brief_pairs, is_raw_file(&frame.0)))
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
        let _ = app_handle.emit("hdr-progress", format!("Aligning '{}'...", file_name));
        let outcome = align_frame_to_reference(
            &frames[index].1,
            &detections[index],
            &detections[reference_index],
        );
        match outcome {
            AlignmentOutcome::Warped(warped) => {
                frames[index].1 = DynamicImage::ImageRgb32F(warped);
            }
            AlignmentOutcome::AlreadyAligned => {}
            AlignmentOutcome::Failed => {
                let _ = app_handle.emit(
                    "hdr-progress",
                    format!("Could not align '{}', using as-is", file_name),
                );
            }
        }
    }
}

fn detect_frame_features(
    image: &DynamicImage,
    brief_pairs: &[(Point2<i32>, Point2<i32>)],
    source_is_raw: bool,
) -> FrameDetection {
    let mut detection_proxy = image.clone();
    if source_is_raw {
        apply_cpu_default_raw_processing(&mut detection_proxy);
    } else {
        detection_proxy = apply_linear_to_srgb(detection_proxy);
    }
    let gray_full = image::imageops::colorops::grayscale(&detection_proxy.to_rgb8());
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

fn align_frame_to_reference(
    frame_image: &DynamicImage,
    frame: &FrameDetection,
    reference: &FrameDetection,
) -> AlignmentOutcome {
    let matches = processing::match_features(&reference.features, &frame.features);
    if matches.len() < processing::MIN_INLIERS_FOR_CONNECTION {
        return AlignmentOutcome::Failed;
    }
    let (_, inliers) = match processing::find_homography_ransac(
        &matches,
        &reference.keypoints,
        &frame.keypoints,
    ) {
        Some(result) => result,
        None => {
            return AlignmentOutcome::Failed;
        }
    };
    let rigid_full = estimate_rigid_transform(&inliers, reference, frame);
    let (width, height) = frame_image.dimensions();
    let displacement = max_corner_displacement(&rigid_full, width, height);
    if displacement < DEGHOST_IDENTITY_MAX_DISPLACEMENT {
        return AlignmentOutcome::AlreadyAligned;
    }
    let source = frame_image.to_rgb32f();
    AlignmentOutcome::Warped(stitching::warp_image_homography(
        &source,
        &rigid_full,
        width,
        height,
    ))
}

fn estimate_rigid_transform(
    inliers: &[Match],
    reference: &FrameDetection,
    frame: &FrameDetection,
) -> Matrix3<f64> {
    assert!(
        inliers.len() >= 2,
        "rigid estimate requires at least two inliers"
    );
    let pairs: Vec<((f64, f64), (f64, f64))> = inliers
        .iter()
        .map(|m| {
            let r = reference.keypoints[m.index1];
            let f = frame.keypoints[m.index2];
            ((r.x as f64, r.y as f64), (f.x as f64, f.y as f64))
        })
        .collect();
    let count = pairs.len() as f64;
    let reference_centroid = centroid(pairs.iter().map(|(r, _)| *r), count);
    let frame_centroid = centroid(pairs.iter().map(|(_, f)| *f), count);
    let (mut h00, mut h01, mut h10, mut h11) = (0.0, 0.0, 0.0, 0.0);
    for ((rx, ry), (fx, fy)) in &pairs {
        let ax = rx - reference_centroid.0;
        let ay = ry - reference_centroid.1;
        let bx = fx - frame_centroid.0;
        let by = fy - frame_centroid.1;
        h00 += ax * bx;
        h01 += ax * by;
        h10 += ay * bx;
        h11 += ay * by;
    }
    let covariance = Matrix2::new(h00, h01, h10, h11);
    let svd = covariance.svd(true, true);
    let u = svd.u.expect("svd failed to produce u");
    let v = svd.v_t.expect("svd failed to produce v_t").transpose();
    let mut rotation = v * u.transpose();
    if rotation.determinant() < 0.0 {
        let mut corrected = v;
        corrected[(0, 1)] = -corrected[(0, 1)];
        corrected[(1, 1)] = -corrected[(1, 1)];
        rotation = corrected * u.transpose();
    }
    let tx = frame_centroid.0
        - (rotation[(0, 0)] * reference_centroid.0 + rotation[(0, 1)] * reference_centroid.1);
    let ty = frame_centroid.1
        - (rotation[(1, 0)] * reference_centroid.0 + rotation[(1, 1)] * reference_centroid.1);
    Matrix3::new(
        rotation[(0, 0)],
        rotation[(0, 1)],
        tx * frame.scale_factor,
        rotation[(1, 0)],
        rotation[(1, 1)],
        ty * frame.scale_factor,
        0.0,
        0.0,
        1.0,
    )
}

fn centroid(points: impl Iterator<Item = (f64, f64)>, count: f64) -> (f64, f64) {
    assert!(count > 0.0, "centroid requires a positive count");
    let mut sum = (0.0, 0.0);
    for (x, y) in points {
        sum.0 += x;
        sum.1 += y;
    }
    (sum.0 / count, sum.1 / count)
}

fn max_corner_displacement(transform: &Matrix3<f64>, width: u32, height: u32) -> f64 {
    let corners = [
        (0.0, 0.0),
        (width as f64, 0.0),
        (0.0, height as f64),
        (width as f64, height as f64),
    ];
    let mut max_displacement = 0.0;
    for (x, y) in corners {
        let mapped_x = transform[(0, 0)] * x + transform[(0, 1)] * y + transform[(0, 2)];
        let mapped_y = transform[(1, 0)] * x + transform[(1, 1)] * y + transform[(1, 2)];
        let dx = mapped_x - x;
        let dy = mapped_y - y;
        let displacement = (dx * dx + dy * dy).sqrt();
        if displacement > max_displacement {
            max_displacement = displacement;
        }
    }
    max_displacement
}
