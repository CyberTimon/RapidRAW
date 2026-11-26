pub mod alignment;
pub mod camera;
pub mod compositor;
pub mod layout;
pub mod maxflow;
pub mod photometric;
pub mod projection;
pub mod seams;

use crate::decode::formats::is_raw_file;
use crate::merge::features::{FeatureSet, detect_features};
use crate::merge::output::{MergeOutput, MergePreview, Rendition, encode_jpeg_base64};
use crate::merge::raster::{encoded_luminance, srgb_decoded};
use crate::merge::source::{SourceLoader, file_name};
use crate::merge::{MergeContext, MergeSession, parse_settings};
use crate::metadata::exif_processing::read_focal_length_35mm;
use alignment::{Alignment, AlignmentImage, align_images};
use compositor::{
    CompositionPlan, Interpolation, Scene, SourceImage, StitchSettings, build_levels,
    level_for_magnification, level_for_size, plan_composition, render_composition,
};
use serde_json::Value;
use std::time::Instant;

const DETECTION_MAX_DIMENSION: usize = 2000;
const PHOTOMETRIC_MAX_DIMENSION: usize = 512;
const MIN_LEVEL_DIMENSION: usize = 128;
const SESSION_MAX_DIMENSION: usize = 2048;
const MAX_FEATURES: usize = 3000;
const PREVIEW_MAX_DIMENSION: f64 = 1600.0;

pub struct PanoramaSession {
    paths: Vec<String>,
    name_source: String,
    sources: Vec<SourceImage>,
    alignment: Alignment,
    excluded_count: usize,
    rendition: Rendition,
    plan: Option<(StitchSettings, CompositionPlan)>,
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

    fn scene_referred(&self) -> bool {
        matches!(self.rendition, Rendition::Scene { .. })
    }
}

impl MergeSession for PanoramaSession {
    fn preview(&mut self, settings: &Value) -> Result<MergePreview, String> {
        let settings: StitchSettings = parse_settings(settings)?;
        self.prepare_plan(&settings)?;
        let plan = self.plan();
        let (w, h) = plan.output_size(1.0, self.alignment.orientation);
        let scale = (PREVIEW_MAX_DIMENSION / w.max(h) as f64).min(plan.full_scale());
        let image = srgb_decoded(render_composition(
            &self.scene(),
            plan,
            scale,
            Interpolation::Bilinear,
            &|_| {},
        ));
        let (width, height) = plan.output_size(plan.full_scale(), self.alignment.orientation);
        Ok(MergePreview {
            base64: encode_jpeg_base64(&self.rendition.to_srgb8(&image))?,
            width,
            height,
            image_count: self.sources.len(),
            excluded_count: self.excluded_count,
            projection: Some(plan.projection()),
            ..Default::default()
        })
    }

    fn render(&mut self, settings: &Value, context: &MergeContext) -> Result<MergeOutput, String> {
        let settings: StitchSettings = parse_settings(settings)?;
        self.prepare_plan(&settings)?;
        context.report("Loading full resolution images...");
        let loader = context.loader(self.scene_referred());
        let plan = self.plan();
        let scale = plan.full_scale();
        let cameras = &self.alignment.cameras;
        let sources = loader.load_all(&self.paths, |index, path| {
            let camera = &cameras[index];
            load_for_render(&loader, path, camera, plan.magnification(camera, scale))
        })?;
        let progress = |message: String| context.report(message);
        let image = render_composition(
            &self.scene_with(&sources),
            plan,
            scale,
            Interpolation::Bicubic,
            &progress,
        );
        drop(sources);
        Ok(MergeOutput {
            image: srgb_decoded(image),
            rendition: self.rendition,
            suffix: "Pano",
            name_source: self.name_source.clone(),
            metadata_source: self.paths[0].clone(),
            keeps_lens_geometry: false,
            tone_mapper: None,
        })
    }
}

fn load_for_render(
    loader: &SourceLoader,
    path: &str,
    camera: &camera::Camera,
    magnification: f64,
) -> Result<SourceImage, String> {
    let decoded = loader.decode(path)?;
    Ok(SourceImage {
        levels: vec![level_for_magnification(
            decoded.image,
            camera,
            magnification,
            MIN_LEVEL_DIMENSION,
        )],
    })
}

fn load_source(loader: &SourceLoader, path: &str) -> Result<LoadedSource, String> {
    let decoded = loader.decode(path)?;
    let (width, height) = (decoded.image.width, decoded.image.height);
    let levels = build_levels(decoded.image, MIN_LEVEL_DIMENSION, SESSION_MAX_DIMENSION);

    let detection_level = level_for_size(&levels, DETECTION_MAX_DIMENSION);
    let features = detect_features(&encoded_luminance(detection_level), MAX_FEATURES);
    log::info!("Found {} features in '{}'", features.len(), path);
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

pub fn build_session(paths: &[String], context: &MergeContext) -> Result<PanoramaSession, String> {
    let scene_referred = paths.iter().all(is_raw_file);
    let loader = context.loader(scene_referred);

    let start_time = Instant::now();
    context.report("Loading images and detecting features...");
    let loaded = loader.load_all(paths, |_, path| {
        context.report(format!("Processing '{}'", file_name(path)));
        load_source(&loader, path)
    })?;
    log::info!(
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
    let progress = |message: String| context.report(message);
    let alignment = align_images(&inputs, &progress)?;
    drop(inputs);
    log::info!("Alignment completed in {:.2?}", start_time.elapsed());

    let excluded_count = loaded.len() - alignment.included.len();
    if excluded_count > 0 {
        let excluded: Vec<String> = (0..paths.len())
            .filter(|i| !alignment.included.contains(i))
            .map(|i| file_name(&paths[i]))
            .collect();
        log::warn!(
            "{} image(s) could not be matched and will be excluded: {}",
            excluded_count,
            excluded.join(", ")
        );
    }

    let mut loaded: Vec<Option<LoadedSource>> = loaded.into_iter().map(Some).collect();
    let sources = alignment
        .included
        .iter()
        .map(|&i| loaded[i].take().unwrap().source)
        .collect();

    let included_paths: Vec<String> = alignment
        .included
        .iter()
        .map(|&i| paths[i].clone())
        .collect();
    let rendition = Rendition::for_sources(scene_referred, &included_paths[0], context.settings);

    Ok(PanoramaSession {
        paths: included_paths,
        name_source: paths[0].clone(),
        sources,
        alignment,
        excluded_count,
        rendition,
        plan: None,
    })
}
