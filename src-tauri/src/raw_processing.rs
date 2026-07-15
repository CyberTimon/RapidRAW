use crate::image_processing::apply_orientation;
use anyhow::{Result, anyhow};
use image::{DynamicImage, ImageBuffer, Rgba};
use rawler::{
    decoders::{FormatHint, Orientation, RawDecodeParams},
    imgop::develop::{DemosaicAlgorithm, Intermediate, ProcessingStep, RawDevelop},
    rawimage::{RawImage, RawPhotometricInterpretation},
    rawsource::RawSource,
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

const MAX_ABS_DNG_BASELINE_EXPOSURE_EV: f32 = 16.0;
const DNG_TAG_BASELINE_EXPOSURE: u16 = 50_730;
const DNG_TAG_BASELINE_EXPOSURE_OFFSET: u16 = 51_109;

#[derive(Clone, Copy)]
enum TiffEndian {
    Little,
    Big,
}

fn read_tiff_u16(bytes: &[u8], offset: usize, endian: TiffEndian) -> Option<u16> {
    let value: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(match endian {
        TiffEndian::Little => u16::from_le_bytes(value),
        TiffEndian::Big => u16::from_be_bytes(value),
    })
}

fn read_tiff_u32(bytes: &[u8], offset: usize, endian: TiffEndian) -> Option<u32> {
    let value: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(match endian {
        TiffEndian::Little => u32::from_le_bytes(value),
        TiffEndian::Big => u32::from_be_bytes(value),
    })
}

fn read_tiff_u64(bytes: &[u8], offset: usize, endian: TiffEndian) -> Option<u64> {
    let value: [u8; 8] = bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(match endian {
        TiffEndian::Little => u64::from_le_bytes(value),
        TiffEndian::Big => u64::from_be_bytes(value),
    })
}

fn read_dng_exposure_tag_value(
    bytes: &[u8],
    entry_offset: usize,
    endian: TiffEndian,
) -> Option<f32> {
    let value_type = read_tiff_u16(bytes, entry_offset.checked_add(2)?, endian)?;
    if read_tiff_u32(bytes, entry_offset.checked_add(4)?, endian)? != 1 {
        return None;
    }

    let value_offset =
        usize::try_from(read_tiff_u32(bytes, entry_offset.checked_add(8)?, endian)?).ok()?;
    match value_type {
        // BaselineExposure is SRATIONAL in DNG.
        10 => {
            let numerator = read_tiff_u32(bytes, value_offset, endian)? as i32;
            let denominator = read_tiff_u32(bytes, value_offset.checked_add(4)?, endian)? as i32;
            (denominator != 0).then_some(numerator as f32 / denominator as f32)
        }
        // BaselineExposureOffset is RATIONAL in DNG. Also accept this type for
        // BaselineExposure to tolerate otherwise well-formed metadata.
        5 => {
            let numerator = read_tiff_u32(bytes, value_offset, endian)?;
            let denominator = read_tiff_u32(bytes, value_offset.checked_add(4)?, endian)?;
            (denominator != 0).then_some(numerator as f32 / denominator as f32)
        }
        11 => Some(f32::from_bits(read_tiff_u32(
            bytes,
            entry_offset.checked_add(8)?,
            endian,
        )?)),
        12 => Some(f64::from_bits(read_tiff_u64(bytes, value_offset, endian)?) as f32),
        _ => None,
    }
}

fn combined_dng_exposure_ev(baseline: f32, offset: f32) -> f32 {
    let finite_component = |value: f32| {
        if value.is_finite() {
            f64::from(value)
        } else {
            0.0
        }
    };

    (finite_component(baseline) + finite_component(offset)).clamp(
        -f64::from(MAX_ABS_DNG_BASELINE_EXPOSURE_EV),
        f64::from(MAX_ABS_DNG_BASELINE_EXPOSURE_EV),
    ) as f32
}

fn dng_default_exposure_ev(file_bytes: &[u8]) -> f32 {
    let Some(endian) = (match file_bytes.get(0..2) {
        Some(bytes) if bytes == b"II" => Some(TiffEndian::Little),
        Some(bytes) if bytes == b"MM" => Some(TiffEndian::Big),
        _ => None,
    }) else {
        return 0.0;
    };

    // RapidRAW-DngLab accepts classic TIFF DNGs (magic 42), so only inspect
    // that root IFD. Reading these two scalar tags directly avoids asking
    // rawler for VirtualDngRootTags, which clones profile/private blobs that
    // the renderer never uses.
    if read_tiff_u16(file_bytes, 2, endian) != Some(42) {
        return 0.0;
    }

    let Some(root_ifd_offset) =
        read_tiff_u32(file_bytes, 4, endian).and_then(|offset| usize::try_from(offset).ok())
    else {
        return 0.0;
    };
    let Some(entry_count) = read_tiff_u16(file_bytes, root_ifd_offset, endian).map(usize::from)
    else {
        return 0.0;
    };
    let Some(entries_offset) = root_ifd_offset.checked_add(2) else {
        return 0.0;
    };
    let Some(entries_size) = entry_count.checked_mul(12) else {
        return 0.0;
    };
    let Some(entries_end) = entries_offset.checked_add(entries_size) else {
        return 0.0;
    };
    if entries_end > file_bytes.len() {
        return 0.0;
    }

    let mut baseline = 0.0;
    let mut offset = 0.0;
    for entry_index in 0..entry_count {
        let Some(entry_offset) = entries_offset.checked_add(entry_index * 12) else {
            return 0.0;
        };
        let Some(tag) = read_tiff_u16(file_bytes, entry_offset, endian) else {
            return 0.0;
        };
        let Some(value) = (tag == DNG_TAG_BASELINE_EXPOSURE
            || tag == DNG_TAG_BASELINE_EXPOSURE_OFFSET)
            .then(|| read_dng_exposure_tag_value(file_bytes, entry_offset, endian))
            .flatten()
        else {
            continue;
        };

        if tag == DNG_TAG_BASELINE_EXPOSURE {
            baseline = value;
        } else {
            offset = value;
        }
    }

    combined_dng_exposure_ev(baseline, offset)
}

fn develop_internal(
    file_bytes: &[u8],
    fast_demosaic: bool,
    highlight_compression: f32,
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
    // DNG baseline exposure is expressed in EV in linear light. Keep it
    // separate from sample normalization so gamma-tagged linear raws apply it
    // only after their transfer function has been decoded.
    let baseline_exposure_gain = if decoder.format_hint() == FormatHint::DNG {
        2.0_f32.powf(dng_default_exposure_ev(file_bytes))
    } else {
        1.0
    };

    check_cancel()?;
    let mut raw_image: RawImage = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;

    let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default())?;
    let orientation = metadata
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal);

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

    let safe_highlight_compression = highlight_compression.max(1.01);

    let clamp_limit = if fast_demosaic {
        1.0
    } else {
        safe_highlight_compression
    };

    check_cancel()?;

    match &mut developed_intermediate {
        Intermediate::Monochrome(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                let mut linear_val = *p * rescale_factor;
                if is_linear_format && apply_ungamma {
                    linear_val = srgb_to_linear(linear_val.clamp(0.0, 1.0));
                }
                *p = (linear_val * baseline_exposure_gain).clamp(0.0, clamp_limit);
            });
        }
        Intermediate::ThreeColor(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                let mut r = (p[0] * rescale_factor).max(0.0);
                let mut g = (p[1] * rescale_factor).max(0.0);
                let mut b = (p[2] * rescale_factor).max(0.0);

                if is_linear_format && apply_ungamma {
                    r = srgb_to_linear(r.clamp(0.0, 1.0));
                    g = srgb_to_linear(g.clamp(0.0, 1.0));
                    b = srgb_to_linear(b.clamp(0.0, 1.0));
                }

                r *= baseline_exposure_gain;
                g *= baseline_exposure_gain;
                b *= baseline_exposure_gain;

                let max_c = r.max(g).max(b);

                let (final_r, final_g, final_b) = if max_c > 1.0 {
                    let min_c = r.min(g).min(b);
                    let compression_factor =
                        (1.0 - (max_c - 1.0) / (safe_highlight_compression - 1.0)).clamp(0.0, 1.0);
                    let compressed_r = min_c + (r - min_c) * compression_factor;
                    let compressed_g = min_c + (g - min_c) * compression_factor;
                    let compressed_b = min_c + (b - min_c) * compression_factor;
                    let compressed_max = compressed_r.max(compressed_g).max(compressed_b);

                    if compressed_max > 1e-6 {
                        let rescale = max_c / compressed_max;
                        (
                            compressed_r * rescale,
                            compressed_g * rescale,
                            compressed_b * rescale,
                        )
                    } else {
                        (max_c, max_c, max_c)
                    }
                } else {
                    (r, g, b)
                };

                p[0] = final_r.clamp(0.0, clamp_limit);
                p[1] = final_g.clamp(0.0, clamp_limit);
                p[2] = final_b.clamp(0.0, clamp_limit);
            });
        }
        Intermediate::FourColor(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                p.iter_mut().for_each(|c| {
                    let mut linear_val = *c * rescale_factor;
                    if is_linear_format && apply_ungamma {
                        linear_val = srgb_to_linear(linear_val.clamp(0.0, 1.0));
                    }
                    *c = (linear_val * baseline_exposure_gain).clamp(0.0, clamp_limit);
                });
            });
        }
    }

    let (width, height) = {
        let dim = developed_intermediate.dim();
        (dim.w as u32, dim.h as u32)
    };

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

    fn write_u16(bytes: &mut [u8], offset: usize, value: u16, endian: TiffEndian) {
        let value = match endian {
            TiffEndian::Little => value.to_le_bytes(),
            TiffEndian::Big => value.to_be_bytes(),
        };
        bytes[offset..offset + 2].copy_from_slice(&value);
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32, endian: TiffEndian) {
        let value = match endian {
            TiffEndian::Little => value.to_le_bytes(),
            TiffEndian::Big => value.to_be_bytes(),
        };
        bytes[offset..offset + 4].copy_from_slice(&value);
    }

    fn dng_with_baseline_tags(
        endian: TiffEndian,
        baseline: (i32, i32),
        offset: (i32, i32),
    ) -> Vec<u8> {
        const ROOT_IFD_OFFSET: usize = 8;
        const ENTRY_COUNT: usize = 2;
        const VALUES_OFFSET: usize = ROOT_IFD_OFFSET + 2 + ENTRY_COUNT * 12 + 4;

        let mut bytes = vec![0; VALUES_OFFSET + ENTRY_COUNT * 8];
        bytes[..2].copy_from_slice(match endian {
            TiffEndian::Little => b"II",
            TiffEndian::Big => b"MM",
        });
        write_u16(&mut bytes, 2, 42, endian);
        write_u32(&mut bytes, 4, ROOT_IFD_OFFSET as u32, endian);
        write_u16(&mut bytes, ROOT_IFD_OFFSET, ENTRY_COUNT as u16, endian);

        for (index, (tag, value_type, numerator, denominator)) in [
            (DNG_TAG_BASELINE_EXPOSURE, 10, baseline.0, baseline.1),
            (DNG_TAG_BASELINE_EXPOSURE_OFFSET, 5, offset.0, offset.1),
        ]
        .into_iter()
        .enumerate()
        {
            let entry_offset = ROOT_IFD_OFFSET + 2 + index * 12;
            let value_offset = VALUES_OFFSET + index * 8;
            write_u16(&mut bytes, entry_offset, tag, endian);
            write_u16(&mut bytes, entry_offset + 2, value_type, endian);
            write_u32(&mut bytes, entry_offset + 4, 1, endian);
            write_u32(&mut bytes, entry_offset + 8, value_offset as u32, endian);
            write_u32(&mut bytes, value_offset, numerator as u32, endian);
            write_u32(&mut bytes, value_offset + 4, denominator as u32, endian);
        }

        bytes
    }

    #[test]
    fn combines_before_bounding_dng_exposure_metadata() {
        assert_eq!(combined_dng_exposure_ev(20.0, -10.0), 10.0);
        assert_eq!(combined_dng_exposure_ev(20.0, -20.0), 0.0);
        assert_eq!(combined_dng_exposure_ev(f32::NAN, 4.7), 4.7);
        assert_eq!(combined_dng_exposure_ev(f32::INFINITY, 4.7), 4.7);
        assert_eq!(
            combined_dng_exposure_ev(f32::MAX, f32::MAX),
            MAX_ABS_DNG_BASELINE_EXPOSURE_EV
        );
        assert_eq!(
            combined_dng_exposure_ev(100.0, 0.0),
            MAX_ABS_DNG_BASELINE_EXPOSURE_EV
        );
        assert_eq!(
            combined_dng_exposure_ev(-100.0, 0.0),
            -MAX_ABS_DNG_BASELINE_EXPOSURE_EV
        );
    }

    #[test]
    fn reads_dng_baseline_and_offset_without_materializing_other_root_tags() {
        for endian in [TiffEndian::Little, TiffEndian::Big] {
            let dng = dng_with_baseline_tags(endian, (-3, 2), (5, 2));
            assert_eq!(dng_default_exposure_ev(&dng), 1.0);
        }
    }

    #[test]
    fn rejects_truncated_root_ifds_and_ignores_invalid_scalar_values() {
        let mut truncated = dng_with_baseline_tags(TiffEndian::Little, (0, 1), (0, 1));
        write_u16(&mut truncated, 8, u16::MAX, TiffEndian::Little);
        assert_eq!(dng_default_exposure_ev(&truncated), 0.0);

        let dng_with_zero_denominator = dng_with_baseline_tags(TiffEndian::Little, (1, 0), (3, 2));
        assert_eq!(dng_default_exposure_ev(&dng_with_zero_denominator), 1.5);
    }
}
