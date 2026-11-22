mod exposure_fusion;
mod radiance;

use crate::decode::formats::is_raw_file;
use crate::merge::align::{
    AlignmentFeatures, downscaled, estimate_transform, max_displacement, warp,
};
use crate::merge::output::{MergeOutput, MergePreview, Rendition, encode_jpeg_base64};
use crate::merge::raster::{Raster, Rect, crop, crop_rects, fit_size, map_pixels, resize_area};
use crate::merge::source::{SourceLoader, ensure_same_size, file_name};
use crate::merge::{MergeContext, MergeSession, parse_settings};
use crate::metadata::exif_processing::{read_exposure_time_secs, read_iso};
use crate::render::color_space::{luminance, srgb_encode};
use exposure_fusion::ExposureFusion;
use nalgebra::Matrix3;
use radiance::{Accumulator, FrameRole, PreviewFrame, exposure_ratio, ghost_masks};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;

const PREVIEW_MAX_DIMENSION: usize = 1600;
const DETECTION_MAX_DIMENSION: usize = 2000;
const IDENTITY_DISPLACEMENT: f64 = 0.3;
const CLIP_PERCENTILE: f64 = 0.999;
const MAX_RATIO_CORRECTION: f64 = 2.0;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HdrSettings {
    pub auto_crop: bool,
}

impl Default for HdrSettings {
    fn default() -> Self {
        HdrSettings { auto_crop: true }
    }
}

struct Frame {
    path: String,
    exposure: f64,
    transform: Matrix3<f64>,
    preview: Raster,
    valid: Vec<f32>,
}

enum Merge {
    Radiance {
        clip: f32,
        masks: Vec<Option<Raster>>,
    },
    Fusion,
}

pub struct HdrSession {
    frames: Vec<Frame>,
    reference: usize,
    merge: Merge,
    rendition: Rendition,
    width: usize,
    height: usize,
    unaligned: usize,
    name_source: String,
    merged_preview: Raster,
}

struct Loaded {
    path: String,
    exif_exposure: Option<f64>,
    preview: Raster,
    detection: Raster,
    width: usize,
    height: usize,
}

fn exif_exposure(path: &str, bytes: &[u8]) -> Option<f64> {
    let time = read_exposure_time_secs(path, bytes)? as f64;
    let iso = read_iso(path, bytes).unwrap_or(100) as f64;
    (time > 0.0 && iso > 0.0).then_some(time * iso)
}

fn median(mut values: Vec<f32>) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let middle = values.len() / 2;
    *values
        .select_nth_unstable_by(middle, |a, b| a.total_cmp(b))
        .1
}

fn percentile(mut values: Vec<f32>, fraction: f64) -> f32 {
    if values.is_empty() {
        return 1.0;
    }
    let index = ((values.len() - 1) as f64 * fraction) as usize;
    *values
        .select_nth_unstable_by(index, |a, b| a.total_cmp(b))
        .1
}

fn detection_image(detection: &Raster, relative_exposure: f64, scale: f32) -> Raster {
    let gain = scale / relative_exposure as f32;
    map_pixels(detection, 1, |p, o| {
        let x = p[0].max(0.0) * gain;
        o[0] = srgb_encode(x / (1.0 + x));
    })
}

fn frame_role(frames: &[Frame], reference: usize, index: usize) -> FrameRole {
    FrameRole {
        exposure: frames[index].exposure as f32,
        darkest: index == 0,
        reference: index == reference,
    }
}

fn load_frames(
    loader: &SourceLoader,
    paths: &[String],
    context: &MergeContext,
) -> Result<Vec<Loaded>, String> {
    let loaded = loader.load_all(paths, |_, path| {
        context.report(format!("Processing '{}'", file_name(path)));
        let decoded = loader.decode(path)?;
        let exif_exposure = exif_exposure(path, &decoded.file_bytes);
        let image = decoded.image;
        let (width, height) = (image.width, image.height);
        let (dw, dh) = fit_size(width, height, DETECTION_MAX_DIMENSION);
        let detection = map_pixels(&resize_area(&image, dw, dh), 1, |p, o| o[0] = luminance(p));
        let (pw, ph) = fit_size(width, height, PREVIEW_MAX_DIMENSION);
        let preview = resize_area(&image, pw, ph);
        Ok(Loaded {
            path: path.to_string(),
            exif_exposure,
            preview,
            detection,
            width,
            height,
        })
    })?;
    ensure_same_size(loaded.iter().map(|l| (l.path.as_str(), l.width, l.height)))?;
    Ok(loaded)
}

fn align_frames(loaded: Vec<Loaded>, mut exposures: Vec<f64>) -> (Vec<Frame>, usize, usize) {
    let medians: Vec<f32> = loaded
        .iter()
        .map(|l| median(l.detection.data.clone()))
        .collect();
    let mut order: Vec<usize> = (0..loaded.len()).collect();
    order.sort_by(|&a, &b| {
        exposures[a]
            .total_cmp(&exposures[b])
            .then(medians[a].total_cmp(&medians[b]))
    });
    let mut slots: Vec<Option<Loaded>> = loaded.into_iter().map(Some).collect();
    let loaded: Vec<Loaded> = order.iter().map(|&i| slots[i].take().unwrap()).collect();
    exposures = order.iter().map(|&i| exposures[i]).collect();
    let reference = (loaded.len() - 1) / 2;
    let reference_exposure = exposures[reference];
    exposures.iter_mut().for_each(|e| *e /= reference_exposure);

    let (width, height) = (loaded[0].width, loaded[0].height);
    let detection_scale = 0.36 / medians[order[reference]].max(1e-6);
    let features: Vec<AlignmentFeatures> = loaded
        .par_iter()
        .zip(&exposures)
        .map(|(l, &e)| {
            AlignmentFeatures::detect(
                &detection_image(&l.detection, e, detection_scale),
                width,
                height,
            )
        })
        .collect();
    let mut transforms = vec![Matrix3::identity(); loaded.len()];
    let mut unaligned = 0;
    let neighbours = (0..reference)
        .rev()
        .map(|k| (k, k + 1))
        .chain((reference + 1..loaded.len()).map(|k| (k, k - 1)));
    for (k, toward) in neighbours {
        let step = estimate_transform(&features[toward], &features[k]);
        if step.is_none() {
            unaligned += 1;
        }
        transforms[k] = step.unwrap_or_else(Matrix3::identity) * transforms[toward];
    }
    drop(features);
    for t in transforms.iter_mut() {
        if max_displacement(t, width as f64, height as f64) < IDENTITY_DISPLACEMENT {
            *t = Matrix3::identity();
        }
    }

    let preview_scale = width as f64 / loaded[0].preview.width as f64;
    let frames = loaded
        .into_par_iter()
        .zip(transforms.into_par_iter())
        .zip(exposures.into_par_iter())
        .map(|((l, transform), exposure)| {
            let (preview, valid) = if transform == Matrix3::identity() {
                let valid = vec![1.0; l.preview.width * l.preview.height];
                (l.preview, valid)
            } else {
                let local = downscaled(&transform, preview_scale);
                warp(&l.preview, &local, l.preview.width, l.preview.height, false)
            };
            Frame {
                path: l.path,
                exposure,
                transform,
                preview,
                valid,
            }
        })
        .collect();
    (frames, reference, unaligned)
}

fn refine_exposures(clip: f32, frames: &mut [Frame], reference: usize) {
    let n = frames.len();
    let steps: Vec<f64> = (0..n - 1)
        .map(|k| {
            let nominal = frames[k + 1].exposure / frames[k].exposure;
            match exposure_ratio(
                clip,
                (&frames[k].preview, &frames[k].valid),
                (&frames[k + 1].preview, &frames[k + 1].valid),
            ) {
                Some(r) if (r / nominal).ln().abs() < MAX_RATIO_CORRECTION.ln() => r,
                _ => nominal,
            }
        })
        .collect();
    let mut refined = vec![1.0f64; n];
    for k in (0..reference).rev() {
        refined[k] = refined[k + 1] / steps[k];
    }
    for k in reference + 1..n {
        refined[k] = refined[k - 1] * steps[k - 1];
    }
    for (frame, exposure) in frames.iter_mut().zip(refined) {
        frame.exposure = exposure;
    }
}

fn merge_radiance(frames: &mut [Frame], reference: usize) -> (Merge, Raster) {
    let clip = frames
        .iter()
        .map(|f| {
            let green: Vec<f32> = f
                .preview
                .data
                .as_chunks::<3>()
                .0
                .iter()
                .map(|p| p[1])
                .collect();
            percentile(green, CLIP_PERCENTILE)
        })
        .fold(0.0f32, f32::max)
        .max(1e-3);
    refine_exposures(clip, frames, reference);
    let previews: Vec<PreviewFrame> = (0..frames.len())
        .map(|i| PreviewFrame {
            image: &frames[i].preview,
            valid: &frames[i].valid,
            role: frame_role(frames, reference, i),
        })
        .collect();
    let masks = ghost_masks(clip, &previews, reference);
    let (pw, ph) = (frames[0].preview.width, frames[0].preview.height);
    let mut accumulator = Accumulator::new(pw, ph);
    for (frame, mask) in previews.iter().zip(&masks) {
        accumulator.add(clip, frame.role, frame.image, frame.valid, mask.as_ref());
    }
    (Merge::Radiance { clip, masks }, accumulator.finish())
}

fn fuse_previews(frames: &[Frame]) -> Raster {
    let (pw, ph) = (frames[0].preview.width, frames[0].preview.height);
    let weights: Vec<Vec<f32>> = frames
        .iter()
        .map(|f| exposure_fusion::weights(&f.preview, &f.valid))
        .collect();
    let total = sum_maps(&weights, pw * ph);
    let mut fusion = ExposureFusion::new(pw, ph);
    for (frame, w) in frames.iter().zip(&weights) {
        fusion.add(&frame.preview, w, &total);
    }
    fusion.finish()
}

fn sum_maps(maps: &[Vec<f32>], len: usize) -> Vec<f32> {
    let mut total = vec![0.0f32; len];
    for map in maps {
        add_into(&mut total, map);
    }
    total
}

fn add_into(total: &mut [f32], map: &[f32]) {
    total
        .par_iter_mut()
        .zip(map.par_iter())
        .for_each(|(t, &v)| *t += v);
}

pub fn build_session(paths: &[String], context: &MergeContext) -> Result<HdrSession, String> {
    let scene = paths.iter().all(is_raw_file);
    let loader = context.loader(scene);
    context.report("Loading images...");
    let loaded = load_frames(&loader, paths, context)?;
    let exposures: Vec<f64> = if loaded.iter().all(|l| l.exif_exposure.is_some()) {
        loaded.iter().filter_map(|l| l.exif_exposure).collect()
    } else {
        loaded
            .iter()
            .map(|l| median(l.detection.data.clone()).max(1e-6) as f64)
            .collect()
    };
    let (width, height) = (loaded[0].width, loaded[0].height);

    context.report("Aligning images...");
    let (mut frames, reference, unaligned) = align_frames(loaded, exposures);

    context.report("Merging exposures...");
    let (merge, merged_preview) = if scene {
        merge_radiance(&mut frames, reference)
    } else {
        (Merge::Fusion, fuse_previews(&frames))
    };
    let rendition = Rendition::for_sources(scene, &frames[reference].path, context.settings)
        .with_agx(context.settings);

    Ok(HdrSession {
        frames,
        reference,
        merge,
        rendition,
        width,
        height,
        unaligned,
        name_source: paths[0].clone(),
        merged_preview,
    })
}

impl HdrSession {
    fn crop_rects(&self, settings: &HdrSettings) -> (Rect, Rect) {
        let valid: Vec<&[f32]> = self.frames.iter().map(|f| f.valid.as_slice()).collect();
        crop_rects(
            &valid,
            (self.merged_preview.width, self.merged_preview.height),
            (self.width, self.height),
            settings.auto_crop,
        )
    }

    fn load_aligned(
        &self,
        loader: &SourceLoader,
        index: usize,
    ) -> Result<(Raster, Vec<f32>), String> {
        let decoded = loader.decode(&self.frames[index].path)?;
        let transform = self.frames[index].transform;
        Ok(if transform == Matrix3::identity() {
            let valid = vec![1.0; self.width * self.height];
            (decoded.image, valid)
        } else {
            warp(&decoded.image, &transform, self.width, self.height, true)
        })
    }

    fn render_radiance(
        &self,
        clip: f32,
        masks: &[Option<Raster>],
        loader: &SourceLoader,
        context: &MergeContext,
    ) -> Result<Raster, String> {
        let accumulator = Mutex::new(Accumulator::new(self.width, self.height));
        let paths: Vec<String> = self.frames.iter().map(|f| f.path.clone()).collect();
        loader.load_all(&paths, |index, path| {
            context.report(format!("Merging '{}'", file_name(path)));
            let (aligned, valid) = self.load_aligned(loader, index)?;
            accumulator.lock().unwrap().add(
                clip,
                frame_role(&self.frames, self.reference, index),
                &aligned,
                &valid,
                masks[index].as_ref(),
            );
            Ok(())
        })?;
        Ok(accumulator
            .into_inner()
            .map_err(|_| "Merging the images failed unexpectedly.".to_string())?
            .finish())
    }

    fn render_fusion(
        &self,
        loader: &SourceLoader,
        context: &MergeContext,
    ) -> Result<Raster, String> {
        let paths: Vec<String> = self.frames.iter().map(|f| f.path.clone()).collect();
        let total = Mutex::new(vec![0.0f32; self.width * self.height]);
        loader.load_all(&paths, |index, path| {
            context.report(format!("Weighting '{}'", file_name(path)));
            let (aligned, valid) = self.load_aligned(loader, index)?;
            let weights = exposure_fusion::weights(&aligned, &valid);
            add_into(&mut total.lock().unwrap(), &weights);
            Ok(())
        })?;
        let total = total
            .into_inner()
            .map_err(|_| "Merging the images failed unexpectedly.".to_string())?;
        let fusion = Mutex::new(ExposureFusion::new(self.width, self.height));
        loader.load_all(&paths, |index, path| {
            context.report(format!("Blending '{}'", file_name(path)));
            let (aligned, valid) = self.load_aligned(loader, index)?;
            let weights = exposure_fusion::weights(&aligned, &valid);
            fusion.lock().unwrap().add(&aligned, &weights, &total);
            Ok(())
        })?;
        Ok(fusion
            .into_inner()
            .map_err(|_| "Merging the images failed unexpectedly.".to_string())?
            .finish())
    }
}

impl MergeSession for HdrSession {
    fn preview(&mut self, settings: &Value) -> Result<MergePreview, String> {
        let settings: HdrSettings = parse_settings(settings)?;
        let (rect, full) = self.crop_rects(&settings);
        let display = self.rendition.to_srgb8(&crop(&self.merged_preview, &rect));
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
        let settings: HdrSettings = parse_settings(settings)?;
        let merged = match &self.merge {
            Merge::Radiance { clip, masks } => {
                self.render_radiance(*clip, masks, &context.loader(true), context)?
            }
            Merge::Fusion => self.render_fusion(&context.loader(false), context)?,
        };
        let (_, rect) = self.crop_rects(&settings);
        Ok(MergeOutput {
            image: crop(&merged, &rect),
            rendition: self.rendition,
            suffix: "HDR",
            name_source: self.name_source.clone(),
            metadata_source: self.frames[self.reference].path.clone(),
            keeps_lens_geometry: true,
            tone_mapper: matches!(self.merge, Merge::Radiance { .. }).then_some("agx"),
        })
    }
}
