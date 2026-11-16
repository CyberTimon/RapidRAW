pub mod alignment;
pub mod blending;
pub mod camera;
pub mod compositor;
pub mod features;
pub mod homography;
pub mod layout;
pub mod matching;
pub mod maxflow;
pub mod photometric;
pub mod projection;
pub mod raster;
pub mod seams;

use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::AppState;
use crate::decode::formats::is_raw_file;
use crate::library::sidecars::parse_virtual_path;
use crate::metadata::exif_processing::read_focal_length_35mm;
use crate::render::image_processing::{apply_cpu_default_raw_processing, srgb_channel_to_linear};
use alignment::{Alignment, AlignmentImage, align_images};
use base64::{Engine as _, engine::general_purpose};
use compositor::{
    CompositionPlan, Interpolation, Scene, SourceImage, StitchSettings, build_levels, encode_srgb,
    level_for_size, plan_composition, render_composition,
};
use features::{FeatureSet, detect_features};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, Rgb32FImage, RgbImage};
use projection::Projection;
use raster::Raster;
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

const DETECTION_MAX_DIMENSION: usize = 2000;
const PHOTOMETRIC_MAX_DIMENSION: usize = 512;
const MIN_LEVEL_DIMENSION: usize = 128;
const SESSION_MAX_DIMENSION: usize = 2048;
const MAX_FEATURES: usize = 3000;
const PREVIEW_MAX_DIMENSION: f64 = 1600.0;
const PREVIEW_JPEG_QUALITY: u8 = 90;

pub struct PanoramaSession {
    paths: Vec<String>,
    sources: Vec<SourceImage>,
    alignment: Alignment,
    excluded_count: usize,
    plan: Option<(StitchSettings, CompositionPlan)>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanoramaPreview {
    base64: String,
    width: usize,
    height: usize,
    projection: Projection,
    image_count: usize,
    excluded_count: usize,
}

struct LoadedSource {
    source: SourceImage,
    features: FeatureSet,
    detection_scale: f64,
    width: f64,
    height: f64,
    focal_35mm: Option<f64>,
}

impl PanoramaSession {
    fn scene(&self) -> Scene<'_> {
        self.scene_with(&self.sources)
    }

    fn scene_with<'a>(&'a self, sources: &'a [SourceImage]) -> Scene<'a> {
        Scene {
            sources: sources.iter().collect(),
            cameras: &self.alignment.cameras,
            lens: self.alignment.lens,
            photometric: &self.alignment.photometric,
            orientation: self.alignment.orientation,
        }
    }

    fn plan_for(&mut self, settings: &StitchSettings) -> Result<&CompositionPlan, String> {
        let cached = self
            .plan
            .as_ref()
            .is_some_and(|(cached_settings, _)| cached_settings == settings);
        if !cached {
            let plan = plan_composition(&self.scene(), settings)?;
            self.plan = Some((*settings, plan));
        }
        Ok(&self.plan.as_ref().unwrap().1)
    }

    fn render_preview(
        &mut self,
        settings: &StitchSettings,
    ) -> Result<(Raster, Projection), String> {
        self.plan_for(settings)?;
        let plan = &self.plan.as_ref().unwrap().1;
        let (w, h) = plan.output_size(1.0, self.alignment.orientation);
        let scale = (PREVIEW_MAX_DIMENSION / w.max(h) as f64).min(plan.full_scale());
        let image =
            render_composition(&self.scene(), plan, scale, Interpolation::Bilinear, &|_| {});
        Ok((image, plan.projection()))
    }

    fn render_full(
        &mut self,
        settings: &StitchSettings,
        app_settings: &AppSettings,
        progress: &dyn Fn(String),
    ) -> Result<Raster, String> {
        self.plan_for(settings)?;
        progress("Loading full resolution images...".to_string());
        let sources: Vec<SourceImage> = self
            .paths
            .par_iter()
            .map(|path| load_full_resolution(path, app_settings))
            .collect::<Result<_, _>>()?;
        let plan = &self.plan.as_ref().unwrap().1;
        Ok(render_composition(
            &self.scene_with(&sources),
            plan,
            plan.full_scale(),
            Interpolation::Bicubic,
            progress,
        ))
    }

    fn preview(&mut self, settings: &StitchSettings) -> Result<PanoramaPreview, String> {
        let (image, projection) = self.render_preview(settings)?;
        let rgb: Vec<u8> = image
            .data
            .par_iter()
            .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
            .collect();
        let rgb = RgbImage::from_raw(image.width as u32, image.height as u32, rgb)
            .ok_or("Failed to create panorama preview.")?;
        let mut buf = Cursor::new(Vec::new());
        JpegEncoder::new_with_quality(&mut buf, PREVIEW_JPEG_QUALITY)
            .encode_image(&rgb)
            .map_err(|e| format!("Failed to encode panorama preview: {}", e))?;

        let plan = &self.plan.as_ref().unwrap().1;
        let (width, height) = plan.output_size(plan.full_scale(), self.alignment.orientation);
        Ok(PanoramaPreview {
            base64: format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(buf.get_ref())
            ),
            width,
            height,
            projection,
            image_count: self.sources.len(),
            excluded_count: self.excluded_count,
        })
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn decode_linear(path: &str, file_bytes: &[u8], settings: &AppSettings) -> Result<Raster, String> {
    let mut dynamic_image = crate::decode::image_loader::load_base_image_from_bytes(
        file_bytes, path, false, settings, None,
    )
    .map_err(|e| format!("Failed to load image {}: {}", path, e))?;
    if is_raw_file(path) {
        apply_cpu_default_raw_processing(&mut dynamic_image);
    }

    let rgb = dynamic_image.into_rgb32f();
    let (width, height) = (rgb.width() as usize, rgb.height() as usize);
    let mut data = rgb.into_raw();
    data.par_iter_mut()
        .for_each(|v| *v = srgb_channel_to_linear(v.max(0.0)));
    Ok(Raster::from_data(width, height, 3, data))
}

fn load_full_resolution(path: &str, settings: &AppSettings) -> Result<SourceImage, String> {
    let file_bytes = fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
    let full = decode_linear(path, &file_bytes, settings)?;
    Ok(SourceImage {
        levels: build_levels(full, MIN_LEVEL_DIMENSION),
    })
}

fn load_source(path: &str, settings: &AppSettings) -> Result<LoadedSource, String> {
    let file_bytes = fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
    let full = decode_linear(path, &file_bytes, settings)?;
    let (width, height) = (full.width, full.height);
    let mut levels = build_levels(full, MIN_LEVEL_DIMENSION);

    let detection_level = level_for_size(&levels, DETECTION_MAX_DIMENSION);
    let gray = Raster::from_data(
        detection_level.width,
        detection_level.height,
        1,
        detection_level
            .data
            .par_chunks(3)
            .map(|p| encode_srgb(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]))
            .collect(),
    );
    let features = detect_features(&gray, MAX_FEATURES);
    println!("    Found {} features in '{}'", features.len(), path);
    let detection_scale = width as f64 / detection_level.width as f64;

    let first_kept = levels
        .iter()
        .position(|l| l.width.max(l.height) <= SESSION_MAX_DIMENSION)
        .unwrap_or(levels.len() - 1);
    levels.drain(..first_kept);

    Ok(LoadedSource {
        detection_scale,
        source: SourceImage { levels },
        features,
        width: width as f64,
        height: height as f64,
        focal_35mm: read_focal_length_35mm(&file_bytes).map(|f| f as f64),
    })
}

fn build_session(paths: &[String], app_handle: &AppHandle) -> Result<PanoramaSession, String> {
    let progress = |message: String| {
        println!("  - {}", message);
        let _ = app_handle.emit("panorama-progress", message);
    };
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let start_time = Instant::now();
    progress("Loading images and detecting features...".to_string());
    let loaded: Vec<LoadedSource> = paths
        .par_iter()
        .map(|path| {
            let _ = app_handle.emit(
                "panorama-progress",
                format!("Processing '{}'", file_name(path)),
            );
            load_source(path, &settings)
        })
        .collect::<Result<_, _>>()?;
    println!(
        "Image loading and feature detection completed in {:.2?}",
        start_time.elapsed()
    );

    let start_time = Instant::now();
    let inputs: Vec<AlignmentImage> = loaded
        .iter()
        .map(|l| AlignmentImage {
            features: &l.features,
            detection_scale: l.detection_scale,
            width: l.width,
            height: l.height,
            focal_35mm: l.focal_35mm,
            photometric_level: level_for_size(&l.source.levels, PHOTOMETRIC_MAX_DIMENSION),
        })
        .collect();
    let alignment = align_images(&inputs, &progress)?;
    drop(inputs);
    println!("Alignment completed in {:.2?}", start_time.elapsed());

    let excluded_count = loaded.len() - alignment.included.len();
    if excluded_count > 0 {
        let excluded: Vec<String> = (0..paths.len())
            .filter(|i| !alignment.included.contains(i))
            .map(|i| file_name(&paths[i]))
            .collect();
        let warning_msg = format!(
            "Warning: {} image(s) could not be matched and will be excluded: {}",
            excluded_count,
            excluded.join(", ")
        );
        println!("{}", warning_msg);
        let _ = app_handle.emit("panorama-warning", warning_msg);
    }

    let mut loaded: Vec<Option<LoadedSource>> = loaded.into_iter().map(Some).collect();
    let sources = alignment
        .included
        .iter()
        .map(|&i| loaded[i].take().unwrap().source)
        .collect();

    let included_paths = alignment
        .included
        .iter()
        .map(|&i| paths[i].clone())
        .collect();

    Ok(PanoramaSession {
        paths: included_paths,
        sources,
        alignment,
        excluded_count,
        plan: None,
    })
}

#[tauri::command]
pub async fn stitch_panorama(
    paths: Vec<String>,
    settings: StitchSettings,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }

    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();

    let panorama_result_handle = state.panorama_result.clone();
    *panorama_result_handle.lock().unwrap() = None;

    let task = tokio::task::spawn_blocking(move || {
        let start_time = Instant::now();
        println!(
            "Starting panorama stitching process for {} images...",
            source_paths.len()
        );
        let result = build_session(&source_paths, &app_handle).and_then(|mut session| {
            let _ = app_handle.emit("panorama-progress", "Finding seams and blending...");
            let preview = session.preview(&settings)?;
            Ok((session, preview))
        });

        match result {
            Ok((session, preview)) => {
                println!("Panorama completed in {:.2?}", start_time.elapsed());
                *panorama_result_handle.lock().unwrap() = Some(session);
                let _ = app_handle.emit("panorama-complete", preview);
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
pub async fn update_panorama_preview(
    settings: StitchSettings,
    state: tauri::State<'_, AppState>,
) -> Result<PanoramaPreview, String> {
    let panorama_result_handle = state.panorama_result.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = panorama_result_handle.lock().unwrap();
        let session = guard
            .as_mut()
            .ok_or("No panorama is available. Please stitch the images again.")?;
        session.preview(&settings)
    })
    .await
    .map_err(|e| format!("Panorama preview task failed: {}", e))?
}

#[tauri::command]
pub async fn save_panorama(
    first_path_str: String,
    settings: StitchSettings,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let panorama_result_handle = state.panorama_result.clone();
    let app_settings = load_settings(app_handle).unwrap_or_default();
    let panorama_image = tokio::task::spawn_blocking(move || {
        let mut guard = panorama_result_handle.lock().unwrap();
        let session = guard.as_mut().ok_or_else(|| {
            "No panorama image found in memory to save. It might have already been saved."
                .to_string()
        })?;
        let start_time = Instant::now();
        let image = session.render_full(&settings, &app_settings, &|message| {
            println!("  - {}", message)
        })?;
        println!(
            "Full resolution panorama rendered in {:.2?}",
            start_time.elapsed()
        );
        *guard = None;
        Rgb32FImage::from_raw(image.width as u32, image.height as u32, image.data)
            .map(DynamicImage::ImageRgb32F)
            .ok_or_else(|| "Failed to create the panorama image.".to_string())
    })
    .await
    .map_err(|e| format!("Panorama save task failed: {}", e))??;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");

    let bytes = crate::metadata::export_metadata::encode_converted_image(
        &panorama_image,
        "tiff",
        &first_path.to_string_lossy(),
    )?;
    let output_path = crate::library::file_ops::write_unique_output(
        parent_dir,
        &format!("{}_Pano", stem),
        "tiff",
        &bytes,
    )
    .map_err(|e| format!("Failed to save panorama image: {}", e))?;

    let _ = crate::metadata::exif_processing::write_rrexif_sidecar(
        &first_path.to_string_lossy(),
        &output_path,
    );

    Ok(output_path.to_string_lossy().to_string())
}
