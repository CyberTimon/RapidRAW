use crate::as_shot::AsShot;
use crate::highlight_reconstruction::{self, Region};
use crate::image_processing::{apply_orientation, oriented_rgb32f};
use crate::white_balance::WhiteBalance;
use anyhow::{Result, anyhow};
use image::{DynamicImage, ImageBuffer, Rgb};
use rawler::{
    decoders::{Decoder, Orientation, RawDecodeParams},
    imgop::{
        Dim2, Point, Rect,
        develop::{DemosaicAlgorithm, Intermediate, ProcessingStep, RawDevelop},
        xyz::{FlatColorMatrix, Illuminant},
    },
    pixarray::Color2D,
    rawimage::{RawImage, RawPhotometricInterpretation},
    rawsource::RawSource,
};
use rayon::prelude::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub fn develop_raw_image(
    file_bytes: &[u8],
    fast_demosaic: bool,
    highlight_compression: f32,
    linear_mode: String,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    let (developed_image, orientation) = develop_internal(
        file_bytes,
        fast_demosaic,
        highlight_compression,
        linear_mode,
        cancel_token,
    )?;
    Ok(apply_orientation(developed_image, orientation))
}

fn metadata_orientation(decoder: &dyn Decoder, source: &RawSource) -> Result<Orientation> {
    let metadata = decoder.raw_metadata(source, &RawDecodeParams::default())?;
    Ok(metadata
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal))
}

pub fn extract_embedded_preview(file_bytes: &[u8]) -> Option<DynamicImage> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source).ok()?;
    let preview = decoder
        .full_image(&source, &RawDecodeParams::default())
        .ok()??;
    let orientation =
        metadata_orientation(decoder.as_ref(), &source).unwrap_or(Orientation::Normal);
    Some(apply_orientation(preview, orientation))
}

fn is_linear_raw_format(raw_image: &RawImage) -> bool {
    matches!(
        raw_image.photometric,
        RawPhotometricInterpretation::LinearRaw
    )
}

#[inline]
fn srgb_to_linear(value: f32) -> f32 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(3.0)
    }
}

#[inline]
fn smootherstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn recover_clipped_pixel(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max_c = r.max(g).max(b);

    if max_c <= 0.50 {
        return (r, g, b);
    }

    let mut cur_r = r;
    let mut cur_g = g;
    let mut cur_b = b;

    let outer_blend = smootherstep(0.50, 1.5, max_c);

    let magenta = (cur_r.min(cur_b) - cur_g).max(0.0);
    if magenta > 0.0 {
        let target_g = cur_r.min(cur_b) * 0.80 + ((cur_r + cur_b) * 0.5) * 0.20;
        let correction = (target_g - cur_g).max(0.0);
        let magenta_weight = smoothstep(0.0, 0.25, magenta / max_c);
        cur_g += correction * outer_blend * magenta_weight;
    }

    let residual = (cur_r.min(cur_b) - cur_g).max(0.0);
    if residual > 0.0 {
        cur_g += residual * outer_blend;
    }

    let new_max = cur_r.max(cur_g).max(cur_b);
    let min_c = cur_r.min(cur_g).min(cur_b);

    let knee = smoothstep(0.50, 1.5, new_max);

    if knee > 0.0 {
        let neutrality = (min_c / new_max.max(1e-5)).clamp(0.0, 1.0);

        let core_burn = smoothstep(0.60, 3.0, new_max);

        let desat = (knee * (neutrality * 0.85 + core_burn * 0.15)).clamp(0.0, 1.0);
        let smooth_desat = desat * desat * (3.0 - 2.0 * desat);

        let neutral_value = min_c + (new_max - min_c) * 1.0;

        cur_r = cur_r * (1.0 - smooth_desat) + neutral_value * smooth_desat;
        cur_g = cur_g * (1.0 - smooth_desat) + neutral_value * smooth_desat;
        cur_b = cur_b * (1.0 - smooth_desat) + neutral_value * smooth_desat;
    }

    (cur_r, cur_g, cur_b)
}

fn primary_color_matrix(raw_image: &RawImage) -> Option<&FlatColorMatrix> {
    let matrices = &raw_image.color_matrix;
    matrices
        .get(&Illuminant::D65)
        .or_else(|| matrices.values().next())
}

struct GamutCompression {
    threshold: f32,
    scale: f32,
}

impl GamutCompression {
    const THRESHOLD: f32 = 0.8;
    const POWER: f32 = 1.2;

    fn new(limit: f32) -> Option<Self> {
        if limit <= 1.0 {
            return None;
        }
        let threshold = Self::THRESHOLD;
        let span = limit - threshold;
        let scale =
            span / (((1.0 - threshold) / span).powf(-Self::POWER) - 1.0).powf(1.0 / Self::POWER);
        Some(Self { threshold, scale })
    }

    #[inline]
    fn compress(&self, distance: f32) -> f32 {
        if distance <= self.threshold {
            return distance;
        }
        let excess = distance - self.threshold;
        self.threshold
            + excess / (1.0 + (excess / self.scale).powf(Self::POWER)).powf(1.0 / Self::POWER)
    }
}

struct CameraToSrgb {
    matrix: [[f32; 4]; 3],
    compression: [Option<GamutCompression>; 3],
}

impl CameraToSrgb {
    fn new(raw_image: &RawImage) -> Option<Self> {
        let color_matrix = as_shot_color(raw_image)
            .map(|(_, color_matrix)| color_matrix)
            .or_else(|| primary_color_matrix(raw_image).cloned())?;
        if color_matrix.len() % 3 != 0 || color_matrix.len() > 12 {
            return None;
        }
        let primaries =
            crate::white_balance::camera_to_srgb(&color_matrix, &camera_neutral(raw_image))?;

        let mut matrix = [[0.0f32; 4]; 3];
        let mut limits = [0.0f32; 3];
        for (channel, primary) in primaries.iter().enumerate() {
            for (row, value) in matrix.iter_mut().zip(primary) {
                row[channel] = *value;
            }
            let peak = primary[0].max(primary[1]).max(primary[2]);
            if peak > 0.0 {
                for (limit, value) in limits.iter_mut().zip(primary) {
                    *limit = limit.max((peak - value) / peak);
                }
            }
        }

        Some(Self {
            matrix,
            compression: limits.map(GamutCompression::new),
        })
    }

    #[inline]
    fn pixel<const N: usize>(&self, camera: &[f32; N]) -> [f32; 3] {
        let mut rgb = self
            .matrix
            .map(|row| row.iter().zip(camera).map(|(m, c)| m * c).sum::<f32>());
        let achromatic = rgb[0].max(rgb[1]).max(rgb[2]);
        if achromatic <= 0.0 {
            return [0.0; 3];
        }
        for (value, compression) in rgb.iter_mut().zip(&self.compression) {
            if let Some(compression) = compression {
                let distance = (achromatic - *value) / achromatic;
                *value = achromatic - compression.compress(distance) * achromatic;
            }
        }
        rgb
    }

    fn convert_pixels<const N: usize>(&self, pixels: &Color2D<f32, N>) -> Color2D<f32, 3> {
        Color2D::new_with(
            pixels.data.par_iter().map(|p| self.pixel(p)).collect(),
            pixels.width,
            pixels.height,
        )
    }

    fn apply(&self, intermediate: Intermediate) -> Intermediate {
        match intermediate {
            Intermediate::ThreeColor(pixels) => {
                Intermediate::ThreeColor(self.convert_pixels(&pixels))
            }
            Intermediate::FourColor(pixels) => {
                Intermediate::ThreeColor(self.convert_pixels(&pixels))
            }
            monochrome => monochrome,
        }
    }
}

fn develop_internal(
    file_bytes: &[u8],
    fast_demosaic: bool,
    _highlight_compression: f32,
    linear_mode: String,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<(DynamicImage, Orientation)> {
    let check_cancel = || -> Result<()> {
        if let Some((tracker, generation)) = &cancel_token
            && tracker.load(Ordering::SeqCst) != *generation
        {
            return Err(anyhow!("Load cancelled"));
        }
        Ok(())
    };

    check_cancel()?;

    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source)?;

    check_cancel()?;
    let mut raw_image: RawImage = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;

    let orientation = metadata_orientation(decoder.as_ref(), &source)?;

    let is_linear_format = is_linear_raw_format(&raw_image);

    let (apply_ungamma, apply_calibration) = match linear_mode.as_str() {
        "gamma" => (true, true),
        "skip_calib" => (false, false),
        "gamma_skip_calib" => (true, false),
        _ => (false, true),
    };

    let original_white_level = raw_image
        .whitelevel
        .0
        .first()
        .cloned()
        .unwrap_or(u16::MAX as u32) as f32;
    let original_black_level = raw_image
        .blacklevel
        .levels
        .first()
        .map(|r| r.as_f32())
        .unwrap_or(0.0);

    for level in raw_image.whitelevel.0.iter_mut() {
        *level = u32::MAX;
    }

    let mut developer = RawDevelop::default();
    developer
        .steps
        .retain(|&step| step != ProcessingStep::SRgb && step != ProcessingStep::Calibrate);

    if is_linear_format {
        developer
            .steps
            .retain(|&step| step != ProcessingStep::Demosaic);
    } else if fast_demosaic {
        developer.demosaic_algorithm = DemosaicAlgorithm::Speed;
    }

    raw_image.wb_coeffs =
        crate::multi_exposure::neutralize_wb_if_multiexposure(raw_image.wb_coeffs, file_bytes);

    let camera_to_srgb = (apply_calibration || !is_linear_format)
        .then(|| CameraToSrgb::new(&raw_image))
        .flatten();
    let cfa_balance = (!is_linear_format && camera_to_srgb.is_some())
        .then(|| cfa_white_balance(&raw_image))
        .flatten();
    if cfa_balance.is_some() {
        developer
            .steps
            .retain(|&step| step != ProcessingStep::CropDefault);
    }

    check_cancel()?;
    let mut developed_intermediate = developer.develop_intermediate(&raw_image)?;

    let (crop_area, active_area, raw_dim) =
        (raw_image.crop_area, raw_image.active_area, raw_image.dim());
    drop(raw_image);

    if cfa_balance.is_none()
        && let Some(camera_to_srgb) = &camera_to_srgb
    {
        check_cancel()?;
        developed_intermediate = camera_to_srgb.apply(developed_intermediate);
    }

    let denominator = (original_white_level - original_black_level).max(1.0);
    let rescale_factor = (u32::MAX as f32 - original_black_level) / denominator;

    let safe_highlight_compression = 1000.0;

    let clamp_limit = if fast_demosaic {
        1.0
    } else {
        safe_highlight_compression
    };

    let (width, height) = {
        let dim = developed_intermediate.dim();
        (dim.w as u32, dim.h as u32)
    };

    check_cancel()?;

    match &mut developed_intermediate {
        Intermediate::Monochrome(pixels) => {
            pixels.data.par_iter_mut().for_each(|p| {
                let mut linear_val = *p * rescale_factor;
                if is_linear_format && apply_ungamma {
                    linear_val = srgb_to_linear(linear_val.max(0.0));
                }
                *p = linear_val.clamp(0.0, clamp_limit);
            });
        }
        Intermediate::ThreeColor(pixels) if cfa_balance.is_some() => {
            let wb = cfa_balance.unwrap();
            let camera_to_srgb = camera_to_srgb.as_ref().unwrap();
            let crop = default_crop(crop_area, active_area, raw_dim, pixels.dim());
            let region = Region {
                stride: pixels.width,
                x: crop.p.x,
                y: crop.p.y,
                width: crop.d.w,
                height: crop.d.h,
            };

            let levels =
                highlight_reconstruction::detect_clip_levels(&pixels.data, region, rescale_factor);
            let clips: [f32; 3] = std::array::from_fn(|c| wb[c] * levels[c]);

            pixels
                .data
                .par_chunks_exact_mut(region.stride)
                .skip(region.y)
                .take(region.height)
                .for_each(|row| {
                    for p in &mut row[region.x..region.x + region.width] {
                        for c in 0..3 {
                            p[c] = (p[c] * rescale_factor).max(0.0) * wb[c];
                        }
                    }
                });
            highlight_reconstruction::reconstruct_highlights(&mut pixels.data, region, clips);
            check_cancel()?;

            let neutral = wb.map(|c| 1.0 / c);
            let data = &pixels.data;
            let image = oriented_rgb32f(region.width, region.height, orientation, |x, y| {
                let [r, g, b] = data[(region.y + y) * region.stride + region.x + x];
                camera_to_srgb
                    .pixel(&[r * neutral[0], g * neutral[1], b * neutral[2]])
                    .map(|value| value.clamp(0.0, clamp_limit))
            });
            return Ok((DynamicImage::ImageRgb32F(image), Orientation::Normal));
        }
        Intermediate::ThreeColor(pixels) => {
            pixels.data.par_iter_mut().for_each(|p| {
                let mut r = (p[0] * rescale_factor).max(0.0);
                let mut g = (p[1] * rescale_factor).max(0.0);
                let mut b = (p[2] * rescale_factor).max(0.0);

                if is_linear_format && apply_ungamma {
                    r = srgb_to_linear(r.max(0.0));
                    g = srgb_to_linear(g.max(0.0));
                    b = srgb_to_linear(b.max(0.0));
                }

                let (rec_r, rec_g, rec_b) = recover_clipped_pixel(r, g, b);

                p[0] = rec_r.clamp(0.0, clamp_limit);
                p[1] = rec_g.clamp(0.0, clamp_limit);
                p[2] = rec_b.clamp(0.0, clamp_limit);
            });
        }
        Intermediate::FourColor(pixels) => {
            pixels.data.par_iter_mut().for_each(|p| {
                p.iter_mut().for_each(|c| {
                    let mut linear_val = *c * rescale_factor;
                    if is_linear_format && apply_ungamma {
                        linear_val = srgb_to_linear(linear_val.max(0.0));
                    }
                    *c = linear_val.clamp(0.0, clamp_limit);
                });
            });
        }
    }

    check_cancel()?;

    let dynamic_image = match developed_intermediate {
        Intermediate::ThreeColor(pixels) => {
            DynamicImage::ImageRgb32F(rgb_pixels_to_rgb(pixels.data, width, height)?)
        }
        Intermediate::Monochrome(pixels) => {
            DynamicImage::ImageRgb32F(mono_pixels_to_rgb(&pixels.data, width, height)?)
        }
        _ => {
            return Err(anyhow!("Unsupported intermediate format for conversion"));
        }
    };

    Ok((dynamic_image, orientation))
}

fn default_crop(
    crop_area: Option<Rect>,
    active_area: Option<Rect>,
    raw_dim: Dim2,
    dim: Dim2,
) -> Rect {
    let full = Rect::new(Point::zero(), dim);
    let Some(mut crop) = crop_area else {
        return full;
    };
    if let Some(active_area) = active_area {
        crop = crop.intersection(&active_area).adapt(&active_area);
    }
    let original_width = active_area.map(|area| area.d.w).unwrap_or(raw_dim.w);
    if original_width > 0 {
        let scale_factor = dim.w as f32 / original_width as f32;
        if (scale_factor - 1.0).abs() > 1e-6 {
            crop.scale(scale_factor);
        }
    }
    let in_bounds = crop.p.x + crop.d.w <= dim.w && crop.p.y + crop.d.h <= dim.h;
    if crop.is_empty() || crop.d == dim || !in_bounds {
        full
    } else {
        crop
    }
}

fn cfa_white_balance(raw_image: &RawImage) -> Option<[f32; 3]> {
    let RawPhotometricInterpretation::Cfa(config) = &raw_image.photometric else {
        return None;
    };
    if raw_image.cpp != 1 || !config.cfa.is_rgb() || config.cfa.unique_colors() != 3 {
        return None;
    }
    if raw_image.wb_coeffs[0].is_nan() {
        Some([1.0; 3])
    } else {
        Some([
            raw_image.wb_coeffs[0],
            raw_image.wb_coeffs[1],
            raw_image.wb_coeffs[2],
        ])
    }
}

pub fn read_as_shot(file_bytes: &[u8]) -> Option<AsShot> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source).ok()?;
    let mut raw_image = decoder
        .raw_image(&source, &RawDecodeParams::default(), true)
        .ok()?;
    raw_image.wb_coeffs =
        crate::multi_exposure::neutralize_wb_if_multiexposure(raw_image.wb_coeffs, file_bytes);
    let is_monochrome = raw_image.cpp == 1
        && !matches!(raw_image.photometric, RawPhotometricInterpretation::Cfa(_));

    Some(AsShot {
        white_balance: (!is_monochrome)
            .then(|| as_shot_color(&raw_image))
            .flatten()
            .map(|(white_balance, _)| white_balance)
            .unwrap_or_else(WhiteBalance::reference),
        exposure: crate::baseline_exposure::read(decoder.as_ref(), file_bytes, is_monochrome),
    })
}

fn camera_neutral(raw_image: &RawImage) -> [f32; 4] {
    if raw_image.wb_coeffs[0].is_nan() {
        [1.0; 4]
    } else {
        raw_image.wb_coeffs.map(|c| 1.0 / c)
    }
}

fn as_shot_color(raw_image: &RawImage) -> Option<(WhiteBalance, FlatColorMatrix)> {
    let neutral = camera_neutral(raw_image);

    let matrices = &raw_image.color_matrix;
    if let (Some(matrix_a), Some(matrix_d65)) =
        (matrices.get(&Illuminant::A), matrices.get(&Illuminant::D65))
    {
        return WhiteBalance::from_dual_illuminant_camera_neutral(matrix_a, matrix_d65, &neutral);
    }

    let color_matrix = primary_color_matrix(raw_image)?;
    WhiteBalance::from_camera_neutral(color_matrix, &neutral)
        .map(|white_balance| (white_balance, color_matrix.clone()))
}

fn rgb_pixels_to_rgb(
    data: Vec<[f32; 3]>,
    width: u32,
    height: u32,
) -> Result<ImageBuffer<Rgb<f32>, Vec<f32>>> {
    ImageBuffer::from_raw(width, height, data.into_flattened())
        .ok_or_else(|| anyhow!("Developed image size does not match its dimensions"))
}

fn mono_pixels_to_rgb(
    data: &[f32],
    width: u32,
    height: u32,
) -> Result<ImageBuffer<Rgb<f32>, Vec<f32>>> {
    let mut rgb = vec![0.0f32; data.len() * 3];
    rgb.par_chunks_exact_mut(3)
        .zip(data.par_iter())
        .for_each(|(dst, &p)| dst.fill(p));
    ImageBuffer::from_raw(width, height, rgb)
        .ok_or_else(|| anyhow!("Developed image size does not match its dimensions"))
}

pub fn raw_dimensions(file_bytes: &[u8]) -> Option<(usize, usize)> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source).ok()?;
    let raw_img = decoder
        .raw_image(&source, &RawDecodeParams::default(), true)
        .ok()?;
    Some((raw_img.width, raw_img.height))
}

pub fn get_fast_demosaic_scale_factor(
    file_bytes: &[u8],
    decoded_width: u32,
    decoded_height: u32,
) -> f32 {
    if let Some((raw_width, raw_height)) = raw_dimensions(file_bytes) {
        let max_orig = (raw_width as f32).max(raw_height as f32);
        let max_comp = (decoded_width as f32).max(decoded_height as f32);
        if max_orig > 0.0 {
            let ratio = max_comp / max_orig;
            if ratio > 0.1 && ratio < 0.35 {
                return 0.25;
            } else if (0.35..0.75).contains(&ratio) {
                return 0.5;
            }
        }
    }
    1.0
}
