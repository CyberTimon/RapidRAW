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

use crate::app::memory_budget::MemoryBudget;
use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::AppState;
use crate::decode::formats::is_raw_file;
use crate::library::sidecars::parse_virtual_path;
use crate::metadata::exif_processing::read_focal_length_35mm;
use crate::render::color_space::{luminance, srgb_transfer};
use crate::render::image_processing::{apply_cpu_default_raw_processing, working_display_to_srgb8};
use alignment::{Alignment, AlignmentImage, align_images};
use base64::{Engine as _, engine::general_purpose};
use compositor::{
    CompositionPlan, Interpolation, Scene, SourceImage, StitchSettings, build_levels,
    level_for_magnification, level_for_size, plan_composition, render_composition,
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
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

const DETECTION_MAX_DIMENSION: usize = 2000;
const PHOTOMETRIC_MAX_DIMENSION: usize = 512;
const MIN_LEVEL_DIMENSION: usize = 128;
const SESSION_MAX_DIMENSION: usize = 2048;
const MAX_FEATURES: usize = 3000;
const PREVIEW_MAX_DIMENSION: f64 = 1600.0;
const PREVIEW_JPEG_QUALITY: u8 = 90;

pub struct PanoramaSession {
    paths: Vec<String>,
    tone_after_blend: bool,
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

    fn prepare_plan(&mut self, settings: &StitchSettings) -> Result<(), String> {
        if self
            .plan
            .as_ref()
            .is_none_or(|(cached_settings, _)| cached_settings != settings)
        {
            let plan = plan_composition(&self.scene(), settings)?;
            self.plan = Some((*settings, plan));
        }
        Ok(())
    }

    fn plan(&self) -> &CompositionPlan {
        &self.plan.as_ref().expect("plan is prepared before use").1
    }

    fn loader<'a>(
        &self,
        settings: &'a AppSettings,
        memory_budget: &'a Arc<MemoryBudget>,
    ) -> SourceLoader<'a> {
        SourceLoader {
            settings,
            memory_budget,
            tone_after_blend: self.tone_after_blend,
        }
    }

    fn render_full(
        &mut self,
        settings: &StitchSettings,
        loader: &SourceLoader,
        progress: &dyn Fn(String),
    ) -> Result<Raster, String> {
        self.prepare_plan(settings)?;
        progress("Loading full resolution images...".to_string());
        let plan = self.plan();
        let scale = plan.full_scale();
        let cameras = &self.alignment.cameras;
        let sources = loader.load_all(&self.paths, |index, path| {
            let camera = &cameras[index];
            loader.load_for_render(path, camera, plan.magnification(camera, scale))
        })?;
        let image = render_composition(
            &self.scene_with(&sources),
            plan,
            scale,
            Interpolation::Bicubic,
            progress,
        );
        drop(sources);
        Ok(self.finish_tone(image))
    }

    fn finish_tone(&self, image: Raster) -> Raster {
        if !self.tone_after_blend {
            return image;
        }
        let (width, height) = (image.width, image.height);
        let mut data = image.data;
        let transfer = srgb_transfer();
        data.par_iter_mut()
            .for_each(|v| *v = transfer.decode(v.max(0.0)));
        let mut toned = DynamicImage::ImageRgb32F(
            Rgb32FImage::from_raw(width as u32, height as u32, data)
                .expect("raster matches its dimensions"),
        );
        apply_cpu_default_raw_processing(&mut toned);
        Raster::from_data(width, height, 3, toned.into_rgb32f().into_raw())
    }

    fn preview(&mut self, settings: &StitchSettings) -> Result<PanoramaPreview, String> {
        self.prepare_plan(settings)?;
        let plan = self.plan();
        let (w, h) = plan.output_size(1.0, self.alignment.orientation);
        let scale = (PREVIEW_MAX_DIMENSION / w.max(h) as f64).min(plan.full_scale());
        let image = self.finish_tone(render_composition(
            &self.scene(),
            plan,
            scale,
            Interpolation::Bilinear,
            &|_| {},
        ));
        let rgb = working_display_to_srgb8(&image.data);
        let rgb = RgbImage::from_raw(image.width as u32, image.height as u32, rgb)
            .ok_or("Failed to create panorama preview.")?;
        let mut buf = Cursor::new(Vec::new());
        JpegEncoder::new_with_quality(&mut buf, PREVIEW_JPEG_QUALITY)
            .encode_image(&rgb)
            .map_err(|e| format!("Failed to encode panorama preview: {}", e))?;

        let (width, height) = plan.output_size(plan.full_scale(), self.alignment.orientation);
        Ok(PanoramaPreview {
            base64: format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(buf.get_ref())
            ),
            width,
            height,
            projection: plan.projection(),
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

struct SourceLoader<'a> {
    settings: &'a AppSettings,
    memory_budget: &'a Arc<MemoryBudget>,
    tone_after_blend: bool,
}

struct DecodedSource {
    file_bytes: Vec<u8>,
    image: Raster,
}

impl SourceLoader<'_> {
    fn load_all<T: Send>(
        &self,
        paths: &[String],
        load: impl Fn(usize, &str) -> Result<T, String> + Sync,
    ) -> Result<Vec<T>, String> {
        let load = &load;
        std::thread::scope(|scope| {
            let workers: Vec<_> = paths
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    let estimate = crate::export::tasks::estimate_export_memory(
                        path,
                        is_raw_file(path),
                        None,
                        0,
                        "tiff",
                        0,
                    );
                    let reservation = self.memory_budget.reserve(estimate, None);
                    scope.spawn(move || {
                        let _reservation = reservation;
                        load(index, path)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .map_err(|_| "Loading a panorama image failed unexpectedly.".to_string())?
                })
                .collect()
        })
    }

    fn decode(&self, path: &str) -> Result<DecodedSource, String> {
        let is_raw = is_raw_file(path);
        let file_bytes =
            fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
        let mut dynamic_image = crate::decode::image_loader::load_base_image_from_bytes(
            &file_bytes,
            path,
            false,
            self.settings,
            None,
        )
        .map_err(|e| format!("Failed to load image {}: {}", path, e))?;
        let linear_raw = is_raw && self.tone_after_blend;
        if is_raw && !linear_raw {
            apply_cpu_default_raw_processing(&mut dynamic_image);
        }

        let rgb = dynamic_image.into_rgb32f();
        let (width, height) = (rgb.width() as usize, rgb.height() as usize);
        let mut data = rgb.into_raw();
        let transfer = srgb_transfer();
        data.par_iter_mut().for_each(|v| {
            *v = if linear_raw {
                v.max(0.0)
            } else {
                transfer.decode(v.max(0.0))
            }
        });
        Ok(DecodedSource {
            file_bytes,
            image: Raster::from_data(width, height, 3, data),
        })
    }

    fn load_for_render(
        &self,
        path: &str,
        camera: &camera::Camera,
        magnification: f64,
    ) -> Result<SourceImage, String> {
        let decoded = self.decode(path)?;
        Ok(SourceImage {
            levels: vec![level_for_magnification(
                decoded.image,
                camera,
                magnification,
                MIN_LEVEL_DIMENSION,
            )],
        })
    }

    fn load_source(&self, path: &str) -> Result<LoadedSource, String> {
        let decoded = self.decode(path)?;
        let (width, height) = (decoded.image.width, decoded.image.height);
        let levels = build_levels(decoded.image, MIN_LEVEL_DIMENSION, SESSION_MAX_DIMENSION);

        let detection_level = level_for_size(&levels, DETECTION_MAX_DIMENSION);
        let transfer = srgb_transfer();
        let gray = Raster::from_data(
            detection_level.width,
            detection_level.height,
            1,
            detection_level
                .data
                .par_chunks(3)
                .map(|p| transfer.encode(luminance(p)))
                .collect(),
        );
        let features = detect_features(&gray, MAX_FEATURES);
        println!("    Found {} features in '{}'", features.len(), path);
        let detection_scale = width as f64 / detection_level.width as f64;

        Ok(LoadedSource {
            detection_scale,
            source: SourceImage { levels },
            features,
            width: width as f64,
            height: height as f64,
            focal_35mm: read_focal_length_35mm(&decoded.file_bytes).map(|f| f as f64),
        })
    }
}

fn build_session(paths: &[String], app_handle: &AppHandle) -> Result<PanoramaSession, String> {
    let progress = |message: String| {
        println!("  - {}", message);
        let _ = app_handle.emit("panorama-progress", message);
    };
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let memory_budget = app_handle.state::<AppState>().memory_budget.clone();
    let tone_after_blend = paths.iter().all(is_raw_file);
    let loader = SourceLoader {
        settings: &settings,
        memory_budget: &memory_budget,
        tone_after_blend,
    };

    let start_time = Instant::now();
    progress("Loading images and detecting features...".to_string());
    let loaded = loader.load_all(paths, |_, path| {
        let _ = app_handle.emit(
            "panorama-progress",
            format!("Processing '{}'", file_name(path)),
        );
        loader.load_source(path)
    })?;
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
        tone_after_blend,
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
pub async fn discard_panorama(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let session = state.panorama_result.lock().unwrap().take();
    drop(session);
    Ok(())
}

#[tauri::command]
pub async fn save_panorama(
    first_path_str: String,
    settings: StitchSettings,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let panorama_result_handle = state.panorama_result.clone();
    let memory_budget = state.memory_budget.clone();
    let app_settings = load_settings(app_handle).unwrap_or_default();
    let mut session = panorama_result_handle
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            "No panorama image found in memory to save. It might have already been saved."
                .to_string()
        })?;
    let panorama_image = tokio::task::spawn_blocking(move || {
        let start_time = Instant::now();
        let loader = session.loader(&app_settings, &memory_budget);
        let rendered =
            session.render_full(&settings, &loader, &|message| println!("  - {}", message));
        let image = match rendered {
            Ok(image) => image,
            Err(e) => {
                *panorama_result_handle.lock().unwrap() = Some(session);
                return Err(e);
            }
        };
        println!(
            "Full resolution panorama rendered in {:.2?}",
            start_time.elapsed()
        );
        Rgb32FImage::from_raw(image.width as u32, image.height as u32, image.data)
            .map(DynamicImage::ImageRgb32F)
            .ok_or_else(|| "Failed to create the panorama image.".to_string())
    })
    .await
    .map_err(|e| format!("Panorama save task failed: {}", e))??;

    crate::merge::save_merged_image(&first_path_str, "Pano", &panorama_image, "tiff")
}
