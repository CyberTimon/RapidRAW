mod align;
mod fusion;

use crate::decode::formats::is_raw_file;
use crate::merge::align::warp_with;
use crate::merge::output::{MergeOutput, MergePreview, Rendition, encode_jpeg_base64};
use crate::merge::raster::{
    Raster, Rect, crop, crop_rects, encoded_luminance, fit_size, resize_area, srgb_decoded,
    srgb_encoded,
};
use crate::merge::source::{ensure_same_size, file_name};
use crate::merge::{MergeContext, MergeSession, parse_settings};
use crate::render::color_space::luminance;
use align::{FramePose, LensWarp, MIN_QUALITY, align_stack};
use fusion::{Depth, Fusion, Method, noise_floor, prepare};
use image::RgbImage;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

const PREVIEW_MAX_DIMENSION: usize = 1600;
const ALIGN_MAX_DIMENSION: usize = 2000;
const IDENTITY_DISPLACEMENT: f64 = 0.25;
const DEPTH_BACKGROUND: f32 = 0.08;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusSettings {
    pub method: Method,
    pub auto_crop: bool,
}

impl Default for FocusSettings {
    fn default() -> Self {
        FocusSettings {
            method: Method::Detail,
            auto_crop: true,
        }
    }
}

struct Frame {
    path: String,
    warp: Option<LensWarp>,
    gain: f32,
    preview: Raster,
    valid: Vec<f32>,
}

pub struct FocusSession {
    frames: Vec<Frame>,
    reference: usize,
    width: usize,
    height: usize,
    rendition: Rendition,
    name_source: String,
    unaligned: usize,
    preview_cache: Option<(FocusSettings, MergePreview)>,
}

struct Loaded {
    path: String,
    preview: Raster,
    luma: Raster,
    width: usize,
    height: usize,
}

fn natural_key(path: &str) -> Vec<(String, u64)> {
    let name = file_name(path).to_lowercase();
    let mut key = Vec::new();
    let mut text = String::new();
    let mut digits = String::new();
    for c in name.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else {
            if !digits.is_empty() {
                key.push((std::mem::take(&mut text), digits.parse().unwrap_or(0)));
                digits.clear();
            }
            text.push(c);
        }
    }
    key.push((text, digits.parse().unwrap_or(0)));
    key
}

fn median_gain(reference: &Raster, frame: &Raster, valid: &[f32]) -> f32 {
    let mut ratios: Vec<f32> = (0..valid.len())
        .into_par_iter()
        .filter_map(|i| {
            if valid[i] < 1.0 {
                return None;
            }
            let r = luminance(reference.pixel_at(i));
            let f = luminance(frame.pixel_at(i));
            (r > 0.02 && f > 0.02 && r < 0.9 && f < 0.9).then(|| (r / f).ln())
        })
        .collect();
    if ratios.len() < 1000 {
        return 1.0;
    }
    let middle = ratios.len() / 2;
    let median = *ratios
        .select_nth_unstable_by(middle, |a, b| a.total_cmp(b))
        .1;
    median.exp().clamp(0.5, 2.0)
}

fn warp_frame(
    image: &Raster,
    warp: Option<&LensWarp>,
    gain: f32,
    width: usize,
    height: usize,
    bicubic: bool,
) -> (Raster, Vec<f32>) {
    let (mut warped, valid) = match warp {
        Some(warp) => warp_with(image, width, height, bicubic, |x, y| Some(warp.apply(x, y))),
        None => (image.clone(), vec![1.0; width * height]),
    };
    if gain != 1.0 {
        warped.data.par_iter_mut().for_each(|v| *v *= gain);
    }
    (warped, valid)
}

pub fn build_session(paths: &[String], context: &MergeContext) -> Result<FocusSession, String> {
    let mut paths = paths.to_vec();
    paths.sort_by_cached_key(|p| natural_key(p));
    let scene = paths.iter().all(is_raw_file);
    let loader = context.loader(scene);

    context.report("Loading images...");
    let mut loaded = loader.load_all(&paths, |_, path| {
        context.report(format!("Processing '{}'", file_name(path)));
        let decoded = loader.decode(path)?;
        let image = decoded.image;
        let (width, height) = (image.width, image.height);
        let (aw, ah) = fit_size(width, height, ALIGN_MAX_DIMENSION);
        let luma = encoded_luminance(&resize_area(&image, aw, ah));
        let (pw, ph) = fit_size(width, height, PREVIEW_MAX_DIMENSION);
        let preview = resize_area(&image, pw, ph);
        Ok(Loaded {
            path: path.to_string(),
            preview,
            luma,
            width,
            height,
        })
    })?;
    ensure_same_size(loaded.iter().map(|l| (l.path.as_str(), l.width, l.height)))?;
    let (width, height) = (loaded[0].width, loaded[0].height);

    let count = loaded.len();
    let reference = count / 2;
    let align_scale = width as f64 / loaded[0].luma.width as f64;
    let lumas: Vec<Raster> = loaded
        .iter_mut()
        .map(|l| std::mem::replace(&mut l.luma, Raster::new(0, 0, 1)))
        .collect();
    let done = AtomicUsize::new(0);
    let poses: Vec<FramePose> = align_stack(&lumas, reference, &|_| {
        let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
        context.report(format!("Aligning image {} of {}...", finished, count - 1));
    });
    drop(lumas);
    let unaligned = poses
        .iter()
        .enumerate()
        .filter(|(i, p)| *i != reference && p.quality < MIN_QUALITY)
        .count();

    let reference_preview = loaded[reference].preview.clone();
    let (pw, ph) = (reference_preview.width, reference_preview.height);
    let preview_scale = width as f64 / pw as f64;
    let frames: Vec<Frame> = loaded
        .into_par_iter()
        .zip(poses.into_par_iter())
        .enumerate()
        .map(|(i, (l, pose))| {
            let full = pose.warp.rescaled(align_scale);
            let warp = (i != reference
                && !pose.warp.is_identity()
                && full.max_displacement(width, height) >= IDENTITY_DISPLACEMENT)
                .then_some(full);
            let local = warp.map(|w| w.rescaled(1.0 / preview_scale));
            let (aligned, valid) = warp_frame(&l.preview, local.as_ref(), 1.0, pw, ph, false);
            let gain = if i == reference {
                1.0
            } else {
                median_gain(&reference_preview, &aligned, &valid)
            };
            let mut preview = aligned;
            preview.data.par_iter_mut().for_each(|v| *v *= gain);
            Frame {
                path: l.path,
                warp,
                gain,
                preview,
                valid,
            }
        })
        .collect();

    let rendition = Rendition::for_sources(scene, &frames[reference].path, context.settings);
    Ok(FocusSession {
        frames,
        reference,
        width,
        height,
        rendition,
        name_source: paths[0].clone(),
        unaligned,
        preview_cache: None,
    })
}

fn depth_image(
    depth: &Depth,
    noise: f32,
    preview: (usize, usize),
    count: usize,
    rect: &Rect,
) -> RgbImage {
    let denominator = (count.max(2) - 1) as f32;
    let sx = depth.width as f32 / preview.0 as f32;
    let sy = depth.height as f32 / preview.1 as f32;
    RgbImage::from_fn(rect.width as u32, rect.height as u32, |x, y| {
        let dx = (((rect.x + x as usize) as f32 + 0.5) * sx) as usize;
        let dy = (((rect.y + y as usize) as f32 + 0.5) * sy) as usize;
        let index = dy.min(depth.height - 1) * depth.width + dx.min(depth.width - 1);
        let t = depth.labels[index] as f32 / denominator;
        let confidence = ((depth.best[index] / noise - 1.0) / 3.0).clamp(0.0, 1.0);
        let ramp = |a: f32, b: f32, c: f32| {
            let v = if t < 0.5 {
                a + (b - a) * t * 2.0
            } else {
                b + (c - b) * (t - 0.5) * 2.0
            };
            let v = DEPTH_BACKGROUND + (v - DEPTH_BACKGROUND) * confidence;
            (v * 255.0).round().clamp(0.0, 255.0) as u8
        };
        image::Rgb([
            ramp(0.10, 0.20, 0.98),
            ramp(0.12, 0.72, 0.85),
            ramp(0.45, 0.62, 0.25),
        ])
    })
}

impl FocusSession {
    fn crop_rects(&self, settings: &FocusSettings) -> (Rect, Rect) {
        let preview = &self.frames[0].preview;
        let valid: Vec<&[f32]> = self.frames.iter().map(|f| f.valid.as_slice()).collect();
        crop_rects(
            &valid,
            (preview.width, preview.height),
            (self.width, self.height),
            settings.auto_crop,
        )
    }
}

impl MergeSession for FocusSession {
    fn preview(&mut self, settings: &Value) -> Result<MergePreview, String> {
        let settings: FocusSettings = parse_settings(settings)?;
        if let Some((cached, preview)) = &self.preview_cache
            && *cached == settings
        {
            return Ok(preview.clone());
        }
        let (pw, ph) = (self.frames[0].preview.width, self.frames[0].preview.height);
        let noise = noise_floor(&srgb_encoded(&self.frames[self.reference].preview));
        let mut fusion = Fusion::new(pw, ph, true);
        for (i, frame) in self.frames.iter().enumerate() {
            let contribution = prepare(
                &srgb_encoded(&frame.preview),
                &frame.valid,
                settings.method,
                noise,
                true,
            );
            fusion.accumulate(i, contribution);
        }
        let (fused, labels) = fusion.finish();
        let (rect, full) = self.crop_rects(&settings);
        let image = srgb_decoded(crop(&fused, &rect));
        let depth = labels.expect("preview fusion tracks depth");
        let preview = MergePreview {
            base64: encode_jpeg_base64(&self.rendition.to_srgb8(&image))?,
            overlay_base64: Some(encode_jpeg_base64(&depth_image(
                &depth,
                noise,
                (pw, ph),
                self.frames.len(),
                &rect,
            ))?),
            width: full.width,
            height: full.height,
            image_count: self.frames.len(),
            unaligned_count: self.unaligned,
            ..Default::default()
        };
        self.preview_cache = Some((settings, preview.clone()));
        Ok(preview)
    }

    fn render(&mut self, settings: &Value, context: &MergeContext) -> Result<MergeOutput, String> {
        let settings: FocusSettings = parse_settings(settings)?;
        let scene = matches!(self.rendition, Rendition::Scene { .. });
        let loader = context.loader(scene);
        let (width, height) = (self.width, self.height);
        let load = |index: usize, path: &str| -> Result<(Raster, Vec<f32>), String> {
            context.report(format!("Stacking '{}'", file_name(path)));
            let frame = &self.frames[index];
            let decoded = loader.decode(path)?;
            let (warped, valid) = warp_frame(
                &decoded.image,
                frame.warp.as_ref(),
                frame.gain,
                width,
                height,
                true,
            );
            Ok((srgb_encoded(&warped), valid))
        };

        let reference_path = self.frames[self.reference].path.clone();
        let (reference_image, reference_valid) = load(self.reference, &reference_path)?;
        let noise = noise_floor(&reference_image);
        let fusion = Mutex::new(Fusion::new(width, height, false));
        fusion.lock().unwrap().accumulate(
            self.reference,
            prepare(
                &reference_image,
                &reference_valid,
                settings.method,
                noise,
                false,
            ),
        );
        drop(reference_image);

        let others: Vec<String> = self
            .frames
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != self.reference)
            .map(|(_, f)| f.path.clone())
            .collect();
        let indices: Vec<usize> = (0..self.frames.len())
            .filter(|&i| i != self.reference)
            .collect();
        loader.load_all(&others, |slot, path| {
            let index = indices[slot];
            let (image, valid) = load(index, path)?;
            let contribution = prepare(&image, &valid, settings.method, noise, false);
            drop(image);
            fusion.lock().unwrap().accumulate(index, contribution);
            Ok(())
        })?;

        let (fused, _) = fusion
            .into_inner()
            .map_err(|_| "Stacking the images failed unexpectedly.".to_string())?
            .finish();
        let (_, rect) = self.crop_rects(&settings);
        Ok(MergeOutput {
            image: srgb_decoded(crop(&fused, &rect)),
            rendition: self.rendition,
            suffix: "Stacked",
            name_source: self.name_source.clone(),
            metadata_source: self.frames[self.reference].path.clone(),
            keeps_lens_geometry: true,
            tone_mapper: None,
        })
    }
}
