mod robust;
mod trails;

use crate::decode::formats::is_raw_file;
use crate::merge::align::{AlignmentFeatures, estimate_transform, max_displacement, scaled, warp};
use crate::merge::flow::{FlowEstimator, FlowField, align, warp_along};
use crate::merge::noise::NoiseModel;
use crate::merge::output::{MergeOutput, MergePreview, Rendition, encode_jpeg_base64};
use crate::merge::raster::{
    Interpolation, Raster, Rect, crop, crop_rects, fit_size, map_pixels, median, resize_area,
    tone_gray,
};
use crate::merge::source::{SourceLoader, ensure_same_size, file_name, natural_key};
use crate::merge::{MergeContext, MergeSession, parse_settings};
use crate::render::color_space::luminance;
use nalgebra::Matrix3;
use rayon::prelude::*;
use robust::{Contribution, Merger, contribution};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use trails::Trails;

const PREVIEW_MAX_DIMENSION: usize = 1600;
const DETECTION_MAX_DIMENSION: usize = 2000;
const FLOW_MAX_DIMENSION: usize = 2048;
const IDENTITY_DISPLACEMENT: f64 = 0.3;
const NOISE_PROBES: usize = 2;
const MIDTONE: f32 = 0.36;
const TRAIL_MIDTONE: f32 = 0.18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Denoise,
    LongExposure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BurstSettings {
    pub auto_crop: bool,
    pub smooth_motion: bool,
}

impl Default for BurstSettings {
    fn default() -> Self {
        BurstSettings {
            auto_crop: true,
            smooth_motion: true,
        }
    }
}

struct Frame {
    path: String,
    transform: Matrix3<f64>,
}

pub struct BurstSession {
    mode: Mode,
    frames: Vec<Frame>,
    reference: usize,
    width: usize,
    height: usize,
    rendition: Rendition,
    unaligned: usize,
    name_source: String,
    merged_preview: Raster,
    smooth_preview: Option<Raster>,
    coverage: Vec<f32>,
    trail_gain: f32,
}

struct Loaded {
    path: String,
    preview: Raster,
    features: AlignmentFeatures,
    sharpness: f64,
    width: usize,
    height: usize,
}

fn luminance_of(image: &Raster) -> Raster {
    map_pixels(image, 1, |p, o| o[0] = luminance(p))
}

fn midtone_gain(gray: &Raster) -> f32 {
    MIDTONE / median(gray.data.clone()).max(1e-6)
}

fn sharpness(gray: &Raster) -> f64 {
    let (w, h) = (gray.width, gray.height);
    if w < 3 || h < 3 {
        return 0.0;
    }
    let total: f64 = (1..h - 1)
        .into_par_iter()
        .map(|y| {
            (1..w - 1)
                .map(|x| {
                    let laplacian = gray.get(x - 1, y, 0)
                        + gray.get(x + 1, y, 0)
                        + gray.get(x, y - 1, 0)
                        + gray.get(x, y + 1, 0)
                        - 4.0 * gray.get(x, y, 0);
                    (laplacian * laplacian) as f64
                })
                .sum::<f64>()
        })
        .sum();
    total / ((w - 2) * (h - 2)) as f64
}

struct LocalFlow<'a> {
    estimator: &'a FlowEstimator,
    reference: Raster,
    gain: f32,
}

impl<'a> LocalFlow<'a> {
    fn new(estimator: &'a FlowEstimator, reference: &Raster, max_dimension: usize) -> Self {
        let (fw, fh) = fit_size(reference.width, reference.height, max_dimension);
        let small = luminance_of(&resize_area(reference, fw, fh));
        let gain = midtone_gain(&small);
        LocalFlow {
            estimator,
            reference: tone_gray(&small, gain),
            gain,
        }
    }

    fn field(&self, image: &Raster, transform: &Matrix3<f64>) -> Option<FlowField> {
        let (fw, fh) = (self.reference.width, self.reference.height);
        let small = resize_area(image, fw, fh);
        let warped = if *transform == Matrix3::identity() {
            small
        } else {
            let factor = image.width as f64 / fw as f64;
            warp(
                &small,
                &scaled(transform, factor),
                fw,
                fh,
                Interpolation::Bilinear,
            )
            .0
        };
        self.estimator.estimate(
            &self.reference,
            &tone_gray(&luminance_of(&warped), self.gain),
        )
    }
}

struct Denoiser<'a> {
    reference: &'a Raster,
    local: Option<LocalFlow<'a>>,
    interpolation: Interpolation,
}

impl Denoiser<'_> {
    fn noise(&self, image: &Raster, transform: &Matrix3<f64>) -> Option<NoiseModel> {
        let (aligned, valid) = align(image.clone(), transform, None, self.interpolation);
        NoiseModel::estimate(self.reference, &aligned, &valid)
    }

    fn contribution(
        &self,
        model: &NoiseModel,
        image: Raster,
        transform: &Matrix3<f64>,
    ) -> Contribution {
        let refined = self
            .local
            .as_ref()
            .and_then(|local| local.field(&image, transform))
            .map(|field| warp_along(&image, transform, &field, self.interpolation));
        let (aligned, valid) = align(image, transform, None, self.interpolation);
        let base = contribution(model, self.reference, &aligned, &valid);
        drop((aligned, valid));
        match refined {
            Some((aligned, valid)) => {
                let candidate = contribution(model, self.reference, &aligned, &valid);
                drop((aligned, valid));
                base.prefer(candidate)
            }
            None => base,
        }
    }
}

fn denoise_preview(
    mut previews: Vec<Raster>,
    reference: usize,
    transform: &(dyn Fn(usize) -> Matrix3<f64> + Sync),
) -> Raster {
    let reference_preview = std::mem::replace(&mut previews[reference], Raster::new(0, 0, 3));
    let estimator = FlowEstimator::new();
    let denoiser = Denoiser {
        reference: &reference_preview,
        local: estimator
            .as_ref()
            .map(|e| LocalFlow::new(e, &reference_preview, PREVIEW_MAX_DIMENSION)),
        interpolation: Interpolation::Bilinear,
    };
    let mut pending: Vec<(usize, Raster)> = previews
        .into_iter()
        .enumerate()
        .filter(|(i, _)| *i != reference)
        .collect();
    pending.sort_by_key(|(i, _)| i.abs_diff(reference));
    let model = NoiseModel::combine(
        pending
            .par_iter()
            .take(NOISE_PROBES)
            .filter_map(|(index, preview)| denoiser.noise(preview, &transform(*index)))
            .collect(),
    );
    let mut merger = Merger::new(reference_preview.width, reference_preview.height);
    merger.add(&reference_preview, None);
    if let Some(model) = model {
        for (index, preview) in pending {
            let merged = denoiser.contribution(&model, preview, &transform(index));
            merger.add(&merged.image, Some(&merged.weights));
        }
    }
    merger.finish()
}

fn long_exposure_preview(
    previews: Vec<Raster>,
    transform: &(dyn Fn(usize) -> Matrix3<f64> + Sync),
    trails: Option<Trails>,
) -> (Raster, Option<Raster>, Vec<f32>) {
    let aligned: Vec<(Raster, Vec<f32>)> = previews
        .into_iter()
        .enumerate()
        .map(|(index, preview)| align(preview, &transform(index), None, Interpolation::Bilinear))
        .collect();
    let (width, height) = (aligned[0].0.width, aligned[0].0.height);
    let mut plain = Merger::new(width, height);
    for (image, valid) in &aligned {
        plain.add(image, Some(valid));
    }
    let smooth = trails.and_then(|mut trails| {
        let mut merger = Merger::new(width, height);
        for (k, (_, valid)) in aligned.iter().enumerate() {
            let smeared = trails.smear(k, neighbourhood(&aligned, k))?;
            merger.add(&smeared, Some(valid));
        }
        Some(merger.finish())
    });
    let coverage = (0..width * height)
        .into_par_iter()
        .map(|i| aligned.iter().map(|(_, v)| v[i]).fold(1.0f32, f32::min))
        .collect();
    (plain.finish(), smooth, coverage)
}

fn neighbourhood(aligned: &[(Raster, Vec<f32>)], k: usize) -> [Option<&Raster>; 3] {
    [
        k.checked_sub(1).map(|j| &aligned[j].0),
        Some(&aligned[k].0),
        aligned.get(k + 1).map(|a| &a.0),
    ]
}

fn load_frames(
    loader: &SourceLoader,
    paths: &[String],
    context: &MergeContext,
) -> Result<Vec<Loaded>, String> {
    let loaded = loader.load_all(paths, |_, path| {
        context.report(format!("Processing '{}'", file_name(path)));
        let image = loader.decode(path)?.image;
        let (width, height) = (image.width, image.height);
        let (dw, dh) = fit_size(width, height, DETECTION_MAX_DIMENSION);
        let detection = luminance_of(&resize_area(&image, dw, dh));
        let gray = tone_gray(&detection, midtone_gain(&detection));
        let (pw, ph) = fit_size(width, height, PREVIEW_MAX_DIMENSION);
        Ok(Loaded {
            path: path.to_string(),
            preview: resize_area(&image, pw, ph),
            features: AlignmentFeatures::detect(&gray, width, height),
            sharpness: sharpness(&gray),
            width,
            height,
        })
    })?;
    ensure_same_size(loaded.iter().map(|l| (l.path.as_str(), l.width, l.height)))?;
    Ok(loaded)
}

pub fn build_session(
    mode: Mode,
    paths: &[String],
    context: &MergeContext,
) -> Result<BurstSession, String> {
    let mut paths = paths.to_vec();
    paths.sort_by_cached_key(|p| natural_key(p));
    let scene = paths.iter().all(is_raw_file);
    let loader = context.loader(scene);
    context.report("Loading images...");
    let loaded = load_frames(&loader, &paths, context)?;
    let (width, height) = (loaded[0].width, loaded[0].height);
    let reference = (0..loaded.len())
        .max_by(|&a, &b| loaded[a].sharpness.total_cmp(&loaded[b].sharpness))
        .unwrap_or(0);

    context.report("Aligning images...");
    let estimates: Vec<Option<Matrix3<f64>>> = (0..loaded.len())
        .into_par_iter()
        .map(|i| {
            if i == reference {
                return Some(Matrix3::identity());
            }
            estimate_transform(&loaded[reference].features, &loaded[i].features).map(|t| {
                if max_displacement(&t, width as f64, height as f64) < IDENTITY_DISPLACEMENT {
                    Matrix3::identity()
                } else {
                    t
                }
            })
        })
        .collect();
    let unaligned = estimates.iter().filter(|t| t.is_none()).count();
    let frames: Vec<Frame> = loaded
        .iter()
        .zip(&estimates)
        .map(|(l, t)| Frame {
            path: l.path.clone(),
            transform: t.unwrap_or_else(Matrix3::identity),
        })
        .collect();

    let preview_scale = width as f64 / loaded[0].preview.width as f64;
    let previews: Vec<Raster> = loaded.into_iter().map(|l| l.preview).collect();
    let transform = |index: usize| scaled(&frames[index].transform, preview_scale);
    let trail_gain = TRAIL_MIDTONE / median(luminance_of(&previews[reference]).data).max(1e-6);
    context.report("Merging images...");
    let (merged_preview, smooth_preview, coverage) = match mode {
        Mode::Denoise => (
            denoise_preview(previews, reference, &transform),
            None,
            Vec::new(),
        ),
        Mode::LongExposure => long_exposure_preview(previews, &transform, Trails::new(trail_gain)),
    };
    let rendition = Rendition::for_sources(scene, &frames[reference].path, context.settings);

    Ok(BurstSession {
        mode,
        frames,
        reference,
        width,
        height,
        rendition,
        unaligned,
        name_source: paths[0].clone(),
        merged_preview,
        smooth_preview,
        coverage,
        trail_gain,
    })
}

impl BurstSession {
    fn crop_rects(&self, settings: &BurstSettings) -> (Rect, Rect) {
        crop_rects(
            &[self.coverage.as_slice()],
            (self.merged_preview.width, self.merged_preview.height),
            (self.width, self.height),
            settings.auto_crop && self.mode == Mode::LongExposure,
        )
    }

    fn render_denoise(
        &self,
        loader: &SourceLoader,
        context: &MergeContext,
    ) -> Result<Raster, String> {
        let reference_path = &self.frames[self.reference].path;
        context.report(format!("Loading '{}'", file_name(reference_path)));
        let reference = loader.decode(reference_path)?.image;
        let estimator = FlowEstimator::new();
        let denoiser = Denoiser {
            reference: &reference,
            local: estimator
                .as_ref()
                .map(|e| LocalFlow::new(e, &reference, FLOW_MAX_DIMENSION)),
            interpolation: Interpolation::Lanczos,
        };
        let decode = |index: usize| -> Result<Raster, String> {
            Ok(loader.decode(&self.frames[index].path)?.image)
        };
        let mut others: Vec<usize> = (0..self.frames.len())
            .filter(|&i| i != self.reference)
            .collect();
        others.sort_by_key(|&i| i.abs_diff(self.reference));
        let rest = others.split_off(others.len().min(NOISE_PROBES));
        let paths = |indices: &[usize]| -> Vec<String> {
            indices
                .iter()
                .map(|&i| self.frames[i].path.clone())
                .collect()
        };
        context.report("Measuring noise...");
        let probes = loader.load_all(&paths(&others), |slot, _| {
            let index = others[slot];
            let image = decode(index)?;
            let model = denoiser.noise(&image, &self.frames[index].transform);
            Ok((index, image, model))
        })?;
        let merger = Mutex::new(Merger::new(self.width, self.height));
        merger.lock().unwrap().add(&reference, None);
        let model = NoiseModel::combine(probes.iter().filter_map(|(_, _, model)| *model).collect());
        if let Some(model) = model {
            let merge = |index: usize, image: Raster| {
                let merged = denoiser.contribution(&model, image, &self.frames[index].transform);
                merger
                    .lock()
                    .unwrap()
                    .add(&merged.image, Some(&merged.weights));
            };
            for (index, image, _) in probes {
                context.report(format!("Merging '{}'", file_name(&self.frames[index].path)));
                merge(index, image);
            }
            loader.load_all(&paths(&rest), |slot, path| {
                context.report(format!("Merging '{}'", file_name(path)));
                merge(rest[slot], decode(rest[slot])?);
                Ok(())
            })?;
        }
        Ok(merger
            .into_inner()
            .map_err(|_| "Merging the images failed unexpectedly.".to_string())?
            .finish())
    }

    fn render_trails(
        &self,
        loader: &SourceLoader,
        context: &MergeContext,
        trails: &mut Trails,
    ) -> Result<Option<Raster>, String> {
        let load = |index: usize| -> Result<(Raster, Vec<f32>), String> {
            let image = loader.decode(&self.frames[index].path)?.image;
            Ok(align(
                image,
                &self.frames[index].transform,
                None,
                Interpolation::Lanczos,
            ))
        };
        let load = &load;
        let count = self.frames.len();
        let mut merger = Merger::new(self.width, self.height);
        let finished = std::thread::scope(|scope| -> Result<bool, String> {
            let mut window: Vec<(Raster, Vec<f32>)> = vec![load(0)?];
            let mut upcoming = (count > 1).then(|| scope.spawn(move || load(1)));
            for k in 0..count {
                context.report(format!("Blending '{}'", file_name(&self.frames[k].path)));
                if let Some(handle) = upcoming.take() {
                    window.push(
                        handle
                            .join()
                            .map_err(|_| "Loading an image failed unexpectedly.".to_string())??,
                    );
                }
                if k + 2 < count {
                    upcoming = Some(scope.spawn(move || load(k + 2)));
                }
                let centre = window.len() - 1 - (k + 1 < count) as usize;
                let Some(smeared) = trails.smear(k, neighbourhood(&window, centre)) else {
                    return Ok(false);
                };
                merger.add(&smeared, Some(&window[centre].1));
                if centre > 0 {
                    window.remove(0);
                }
            }
            Ok(true)
        })?;
        Ok(finished.then(|| merger.finish()))
    }

    fn render_long_exposure(
        &self,
        loader: &SourceLoader,
        context: &MergeContext,
        smooth: bool,
    ) -> Result<Raster, String> {
        if smooth && let Some(mut trails) = Trails::new(self.trail_gain) {
            if let Some(merged) = self.render_trails(loader, context, &mut trails)? {
                return Ok(merged);
            }
            log::warn!("merge: smooth motion failed, blending without it");
        }
        let merger = Mutex::new(Merger::new(self.width, self.height));
        let paths: Vec<String> = self.frames.iter().map(|f| f.path.clone()).collect();
        loader.load_all(&paths, |index, path| {
            context.report(format!("Merging '{}'", file_name(path)));
            let image = loader.decode(path)?.image;
            let (image, valid) = align(
                image,
                &self.frames[index].transform,
                None,
                Interpolation::Lanczos,
            );
            merger.lock().unwrap().add(&image, Some(&valid));
            Ok(())
        })?;
        Ok(merger
            .into_inner()
            .map_err(|_| "Merging the images failed unexpectedly.".to_string())?
            .finish())
    }
}

impl MergeSession for BurstSession {
    fn preview(&mut self, settings: &Value) -> Result<MergePreview, String> {
        let settings: BurstSettings = parse_settings(settings)?;
        let (rect, full) = self.crop_rects(&settings);
        let merged = match &self.smooth_preview {
            Some(smooth) if settings.smooth_motion => smooth,
            _ => &self.merged_preview,
        };
        let display = self.rendition.to_srgb8(&crop(merged, &rect));
        Ok(MergePreview {
            base64: encode_jpeg_base64(&display)?,
            width: full.width,
            height: full.height,
            image_count: self.frames.len(),
            unaligned_count: self.unaligned,
            ..Default::default()
        })
    }

    fn render(&mut self, settings: &Value, context: &MergeContext) -> Result<MergeOutput, String> {
        let settings: BurstSettings = parse_settings(settings)?;
        let loader = context.loader(matches!(self.rendition, Rendition::Scene { .. }));
        let merged = match self.mode {
            Mode::Denoise => self.render_denoise(&loader, context)?,
            Mode::LongExposure => {
                self.render_long_exposure(&loader, context, settings.smooth_motion)?
            }
        };
        let (_, rect) = self.crop_rects(&settings);
        Ok(MergeOutput {
            image: crop(merged, &rect).into_owned(),
            rendition: self.rendition,
            suffix: match self.mode {
                Mode::Denoise => "Burst",
                Mode::LongExposure => "LongExposure",
            },
            name_source: self.name_source.clone(),
            metadata_source: self.frames[self.reference].path.clone(),
            keeps_lens_geometry: true,
            tone_mapper: None,
        })
    }
}
