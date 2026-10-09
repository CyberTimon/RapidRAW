use crate::image_processing::apply_orientation;
use crate::white_balance::WhiteBalance;
use anyhow::{Result, anyhow};
use image::{DynamicImage, ImageBuffer, Rgb32FImage, Rgba};
use rawler::{
    decoders::{Decoder, Orientation, RawDecodeParams, RawMetadata},
    dng::{
        CropMode, DNG_VERSION_V1_4, DngCompression, DngPhotometricConversion, writer::DngWriter,
    },
    imgop::{
        develop::{DemosaicAlgorithm, Intermediate, ProcessingStep, RawDevelop},
        matrix::{multiply, normalize},
        xyz::{Illuminant, SRGB_TO_XYZ_D65},
    },
    rawimage::{BlackLevel, RawImage, RawImageData, RawPhotometricInterpretation, WhiteLevel},
    rawsource::RawSource,
    tags::{ExifTag, TiffCommonTag},
};
use rayon::prelude::*;
use std::io::Cursor;
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

    if is_linear_format {
        developer.steps.retain(|&step| {
            step != ProcessingStep::SRgb
                && step != ProcessingStep::Demosaic
                && (apply_calibration || step != ProcessingStep::Calibrate)
        });
    } else if fast_demosaic {
        developer.demosaic_algorithm = DemosaicAlgorithm::Speed;
        developer.steps.retain(|&step| step != ProcessingStep::SRgb);
    } else {
        developer.steps.retain(|&step| step != ProcessingStep::SRgb);
    }

    raw_image.wb_coeffs =
        crate::multi_exposure::neutralize_wb_if_multiexposure(raw_image.wb_coeffs, file_bytes);

    check_cancel()?;
    let mut developed_intermediate = developer.develop_intermediate(&raw_image)?;

    drop(raw_image);

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
            pixels.data.iter_mut().for_each(|p| {
                let mut linear_val = *p * rescale_factor;
                if is_linear_format && apply_ungamma {
                    linear_val = srgb_to_linear(linear_val.max(0.0));
                }
                *p = linear_val.clamp(0.0, clamp_limit);
            });
        }
        Intermediate::ThreeColor(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
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
            pixels.data.iter_mut().for_each(|p| {
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
            let buffer = ImageBuffer::<Rgba<f32>, _>::from_fn(width, height, |x, y| {
                let p = pixels.data[(y * width + x) as usize];
                Rgba([p[0], p[1], p[2], 1.0])
            });
            DynamicImage::ImageRgba32F(buffer)
        }
        Intermediate::Monochrome(pixels) => {
            let buffer = ImageBuffer::<Rgba<f32>, _>::from_fn(width, height, |x, y| {
                let p = pixels.data[(y * width + x) as usize];
                Rgba([p, p, p, 1.0])
            });
            DynamicImage::ImageRgba32F(buffer)
        }
        _ => {
            return Err(anyhow!("Unsupported intermediate format for conversion"));
        }
    };

    Ok((dynamic_image, orientation))
}

pub fn read_as_shot_white_balance(file_bytes: &[u8]) -> Option<WhiteBalance> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source).ok()?;
    let raw_image = decoder
        .raw_image(&source, &RawDecodeParams::default(), true)
        .ok()?;
    if raw_image.cpp == 1 && !matches!(raw_image.photometric, RawPhotometricInterpretation::Cfa(_))
    {
        return None;
    }

    let wb_coeffs =
        crate::multi_exposure::neutralize_wb_if_multiexposure(raw_image.wb_coeffs, file_bytes);
    let neutral = if wb_coeffs[0].is_nan() {
        [1.0; 4]
    } else {
        wb_coeffs.map(|c| 1.0 / c)
    };

    let matrices = &raw_image.color_matrix;
    if let (Some(matrix_a), Some(matrix_d65)) =
        (matrices.get(&Illuminant::A), matrices.get(&Illuminant::D65))
    {
        return WhiteBalance::from_dual_illuminant_camera_neutral(matrix_a, matrix_d65, &neutral);
    }

    let color_matrix = matrices
        .get(&Illuminant::D65)
        .or_else(|| matrices.values().next())?;
    WhiteBalance::from_camera_neutral(color_matrix, &neutral)
}

pub fn get_fast_demosaic_scale_factor(
    file_bytes: &[u8],
    decoded_width: u32,
    decoded_height: u32,
) -> f32 {
    let source = RawSource::new_from_slice(file_bytes);
    if let Ok(decoder) = rawler::get_decoder(&source)
        && let Ok(raw_img) = decoder.raw_image(&source, &RawDecodeParams::default(), true)
    {
        let max_orig = (raw_img.width as f32).max(raw_img.height as f32);
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

const DNG_MAX_HEADROOM: f32 = 4.0;

pub struct LinearRawFrame {
    pub image: Rgb32FImage,
    pub orientation: Orientation,
    raw_image: RawImage,
    metadata: RawMetadata,
    rgb_to_cam: [[f32; 3]; 3],
    wb: [f32; 3],
}

pub fn develop_linear_frame(file_bytes: &[u8]) -> Result<Option<LinearRawFrame>> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source)?;
    let params = RawDecodeParams::default();
    let mut raw_image: RawImage = decoder.raw_image(&source, &params, false)?;
    let metadata = decoder.raw_metadata(&source, &params)?;
    let orientation = metadata
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal);

    if !matches!(raw_image.photometric, RawPhotometricInterpretation::Cfa(_)) {
        return Ok(None);
    }

    raw_image.wb_coeffs =
        crate::multi_exposure::neutralize_wb_if_multiexposure(raw_image.wb_coeffs, file_bytes);
    let wb = [
        raw_image.wb_coeffs[0],
        raw_image.wb_coeffs[1],
        raw_image.wb_coeffs[2],
    ];
    if wb.iter().any(|c| !c.is_finite() || *c <= 0.0) {
        return Ok(None);
    }

    if !raw_image.color_matrix.contains_key(&Illuminant::D65) {
        let Some(illuminant) = raw_image.color_matrix.keys().min().copied() else {
            return Ok(None);
        };
        raw_image.color_matrix.retain(|key, _| *key == illuminant);
    }
    let Some(color_matrix) = raw_image
        .color_matrix
        .get(&Illuminant::D65)
        .or_else(|| raw_image.color_matrix.values().next())
    else {
        return Ok(None);
    };
    if color_matrix.len() != 9 {
        return Ok(None);
    }
    let mut xyz_to_cam = [[0.0f32; 3]; 3];
    for (i, row) in xyz_to_cam.iter_mut().enumerate() {
        row.copy_from_slice(&color_matrix[i * 3..i * 3 + 3]);
    }
    let rgb_to_cam = normalize(multiply(&xyz_to_cam, &SRGB_TO_XYZ_D65));

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
    let denominator = (original_white_level - original_black_level).max(1.0);
    let rescale_factor = (u32::MAX as f32 - original_black_level) / denominator;

    let mut scaled_raw = raw_image.clone();
    for level in scaled_raw.whitelevel.0.iter_mut() {
        *level = u32::MAX;
    }
    let mut developer = RawDevelop::default();
    developer.steps.retain(|&step| step != ProcessingStep::SRgb);
    let Intermediate::ThreeColor(pixels) = developer.develop_intermediate(&scaled_raw)? else {
        return Ok(None);
    };
    drop(scaled_raw);

    let dim = pixels.dim();
    let mut data = vec![0.0f32; dim.w * dim.h * 3];
    data.par_chunks_mut(3)
        .zip(pixels.data.par_iter())
        .for_each(|(out, p)| {
            for c in 0..3 {
                let value = p[c] * rescale_factor;
                out[c] = if value.is_finite() {
                    value.max(0.0)
                } else {
                    0.0
                };
            }
        });
    let image = Rgb32FImage::from_raw(dim.w as u32, dim.h as u32, data)
        .ok_or_else(|| anyhow!("Failed to build linear frame buffer"))?;

    raw_image.data = RawImageData::Integer(Vec::new());

    Ok(Some(LinearRawFrame {
        image,
        orientation,
        raw_image,
        metadata,
        rgb_to_cam,
        wb,
    }))
}

pub fn encode_linear_dng(
    frame: &LinearRawFrame,
    image: &Rgb32FImage,
    preview: &DynamicImage,
) -> Result<Vec<u8>> {
    let (width, height) = (image.width() as usize, image.height() as usize);
    let matrix = frame.rgb_to_cam;
    let wb = frame.wb;

    let to_camera = |rgb: &[f32], c: usize| {
        (matrix[c][0] * rgb[0] + matrix[c][1] * rgb[1] + matrix[c][2] * rgb[2]) / wb[c]
    };

    let peak = image
        .as_raw()
        .par_chunks(3)
        .map(|rgb| {
            to_camera(rgb, 0)
                .max(to_camera(rgb, 1))
                .max(to_camera(rgb, 2))
        })
        .reduce(|| 1.0f32, f32::max);
    let headroom = if peak.is_finite() {
        peak.clamp(1.0, DNG_MAX_HEADROOM)
    } else {
        1.0
    };
    let white_level = (u16::MAX as f32 / headroom).floor();

    let mut data = vec![0u16; width * height * 3];
    data.par_chunks_mut(3)
        .zip(image.as_raw().par_chunks(3))
        .for_each(|(out, rgb)| {
            for (c, sample) in out.iter_mut().enumerate() {
                let value = (to_camera(rgb, c) * white_level).round();
                *sample = value.clamp(0.0, u16::MAX as f32) as u16;
            }
        });

    let mut raw_image = frame.raw_image.clone();
    raw_image.width = width;
    raw_image.height = height;
    raw_image.cpp = 3;
    raw_image.bps = 16;
    raw_image.photometric = RawPhotometricInterpretation::LinearRaw;
    raw_image.whitelevel = WhiteLevel::new(vec![white_level as u32; 3]);
    raw_image.blacklevel = BlackLevel::zero(1, 1, 3);
    raw_image.active_area = None;
    raw_image.crop_area = None;
    raw_image.blackareas.clear();
    raw_image.data = RawImageData::Integer(data);

    let mut buffer = Cursor::new(Vec::new());
    let mut dng = DngWriter::new(&mut buffer, DNG_VERSION_V1_4)?;

    let mut raw = dng.subframe(0);
    raw.raw_image(
        &raw_image,
        CropMode::None,
        DngCompression::Lossless,
        DngPhotometricConversion::Original,
        1,
    )?;
    raw.finalize()?;
    drop(raw_image);

    let mut preview_frame = dng.subframe(1);
    preview_frame.preview(preview, 0.85)?;
    preview_frame.finalize()?;
    dng.thumbnail(preview)?;

    dng.load_base_tags(&frame.raw_image)?;
    dng.load_metadata(&frame.metadata)?;
    if !dng.root_ifd().contains(ExifTag::Orientation) {
        dng.root_ifd_mut()
            .add_tag(ExifTag::Orientation, frame.orientation.to_u16());
    }
    dng.root_ifd_mut()
        .add_tag(TiffCommonTag::Software, "RapidRAW");
    dng.close()?;

    Ok(buffer.into_inner())
}
