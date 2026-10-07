use crate::image_processing::apply_orientation;
use crate::white_balance::WhiteBalance;
use anyhow::{Result, anyhow};
use image::{DynamicImage, ImageBuffer, Rgba};
use rawler::{
    decoders::{Decoder, FormatHint, Orientation, RawDecodeParams, WellKnownIFD},
    formats::tiff::Value,
    imgop::{
        develop::{DemosaicAlgorithm, Intermediate, ProcessingStep, RawDevelop},
        xyz::Illuminant,
    },
    rawimage::{RawImage, RawImageData, RawPhotometricInterpretation},
    rawsource::RawSource,
    tags::DngTag,
};
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

fn apply_black_level_delta_v_to_data(
    data: &mut RawImageData,
    width: usize,
    height: usize,
    cpp: usize,
    delta_start_row: usize,
    deltas: &[f32],
) -> bool {
    let Some(row_width) = width.checked_mul(cpp) else {
        return false;
    };
    let Some(expected_len) = row_width.checked_mul(height) else {
        return false;
    };
    if row_width == 0
        || deltas.is_empty()
        || deltas.iter().any(|delta| !delta.is_finite())
    {
        return false;
    }
    let Some(delta_end_row) = delta_start_row.checked_add(deltas.len()) else {
        return false;
    };
    if deltas.len() != 1 && delta_end_row > height {
        return false;
    }

    match data {
        RawImageData::Integer(pixels) if pixels.len() == expected_len => {
            for (row, row_pixels) in pixels.chunks_exact_mut(row_width).enumerate() {
                let delta = if deltas.len() == 1 {
                    deltas[0]
                } else if (delta_start_row..delta_end_row).contains(&row) {
                    deltas[row - delta_start_row]
                } else {
                    continue;
                };
                for pixel in row_pixels {
                    *pixel = (*pixel as f32 - delta)
                        .round()
                        .clamp(0.0, u16::MAX as f32) as u16;
                }
            }
        }
        RawImageData::Float(pixels) if pixels.len() == expected_len => {
            for (row, row_pixels) in pixels.chunks_exact_mut(row_width).enumerate() {
                let delta = if deltas.len() == 1 {
                    deltas[0]
                } else if (delta_start_row..delta_end_row).contains(&row) {
                    deltas[row - delta_start_row]
                } else {
                    continue;
                };
                for pixel in row_pixels {
                    *pixel = (*pixel - delta).max(0.0);
                }
            }
        }
        _ => return false,
    }

    true
}

fn apply_dng_black_level_delta_v(raw_image: &mut RawImage, decoder: &dyn Decoder) -> bool {
    if decoder.format_hint() != FormatHint::DNG
        || !matches!(
            &raw_image.photometric,
            RawPhotometricInterpretation::Cfa(_)
        )
    {
        return false;
    }

    let Ok(Some(raw_ifd)) = decoder.ifd(WellKnownIFD::Raw) else {
        return false;
    };
    let Some(entry) = raw_ifd.get_entry(DngTag::BlackLevelDeltaV) else {
        return false;
    };
    let value = &entry.value;
    if !matches!(
        value,
        Value::Rational(_) | Value::SRational(_) | Value::Float(_) | Value::Double(_)
    ) {
        return false;
    }

    let mut deltas = Vec::with_capacity(value.count());
    for index in 0..value.count() {
        let Ok(Some(delta)) = value.get_f32(index) else {
            return false;
        };
        deltas.push(delta);
    }

    let delta_start_row = if deltas.len() == 1 || deltas.len() == raw_image.height {
        0
    } else {
        let Some(active_area) = raw_ifd.get_entry(DngTag::ActiveArea) else {
            return false;
        };
        if active_area.value.count() < 4 {
            return false;
        }
        let top = active_area.value.force_usize(0);
        let bottom = active_area.value.force_usize(2);
        if bottom.checked_sub(top) != Some(deltas.len()) {
            return false;
        }
        top
    };

    apply_black_level_delta_v_to_data(
        &mut raw_image.data,
        raw_image.width,
        raw_image.height,
        raw_image.cpp,
        delta_start_row,
        &deltas,
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

    if apply_dng_black_level_delta_v(&mut raw_image, decoder.as_ref()) {
        log::debug!("Applied DNG BlackLevelDeltaV correction");
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnose_attached_dng_raw_metadata() {
        let bytes = std::fs::read("../20070819-IMG_2427.dng").unwrap();
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).unwrap();
        let raw_image = decoder
            .raw_image(&source, &RawDecodeParams::default(), false)
            .unwrap();

        eprintln!(
            "camera={:?}/{:?}, blacklevel={:?}, whitelevel={:?}, wb={:?}, matrix={:?}",
            raw_image.make,
            raw_image.model,
            raw_image.blacklevel,
            raw_image.whitelevel,
            raw_image.wb_coeffs,
            raw_image.color_matrix
        );
    }

    #[test]
    fn applies_per_row_black_level_deltas() {
        let mut image = RawImageData::Integer(vec![1000, 2000, 500, 100]);

        assert!(apply_black_level_delta_v_to_data(
            &mut image,
            2,
            2,
            1,
            0,
            &[100.0, 200.0],
        ));
        let RawImageData::Integer(pixels) = image else {
            panic!("Expected integer pixel data");
        };
        assert_eq!(pixels, [900, 1900, 300, 0]);
    }

    #[test]
    fn aligns_black_level_deltas_to_active_area_rows() {
        let mut image = RawImageData::Integer(vec![1000, 1000, 1000]);

        assert!(apply_black_level_delta_v_to_data(
            &mut image,
            1,
            3,
            1,
            1,
            &[100.0, 200.0],
        ));
        let RawImageData::Integer(pixels) = image else {
            panic!("Expected integer pixel data");
        };
        assert_eq!(pixels, [1000, 900, 800]);
    }

    #[test]
    fn ignores_black_level_delta_with_wrong_row_count() {
        let mut image = RawImageData::Integer(vec![1000, 2000, 500, 100]);

        assert!(!apply_black_level_delta_v_to_data(
            &mut image,
            2,
            2,
            1,
            0,
            &[100.0, 200.0, 300.0],
        ));
        let RawImageData::Integer(pixels) = image else {
            panic!("Expected integer pixel data");
        };
        assert_eq!(pixels, [1000, 2000, 500, 100]);
    }
}
