//! RAW image processing module.
//!
//! Handles decoding and development of RAW image files, including tonemapping, gamma correction, and orientation adjustment.
//! Integrates with the `rawler` crate for advanced RAW processing workflows.

use crate::image_processing::apply_orientation;
use anyhow::Result;
use image::DynamicImage;
use rawler::{
    decoders::{Orientation, RawDecodeParams},
    imgop::develop::{DemosaicAlgorithm, Intermediate, ProcessingStep, RawDevelop},
    rawimage::RawImage,
    rawsource::RawSource,
};

/// Develops a RAW image from bytes, applies tonemapping and orientation correction.
///
/// # Arguments
/// * `file_bytes` - The RAW file bytes.
/// * `fast_demosaic` - Whether to use fast demosaic algorithm (see `rawler` crate).
///
/// # Returns
/// * `Result<DynamicImage>` - The developed image or an error.
pub fn develop_raw_image(file_bytes: &[u8], fast_demosaic: bool) -> Result<DynamicImage> {
    let (developed_image, orientation) = develop_internal(file_bytes, fast_demosaic)?;
    Ok(apply_orientation(developed_image, orientation))
}

/// Applies tonemapping and gamma correction to a linear pixel value.
///
/// # Arguments
/// * `linear_val` - The linear pixel value.
///
/// # Returns
/// * `f32` - The corrected pixel value.
fn apply_tonemap_and_gamma(linear_val: f32) -> f32 {
    let x = linear_val.max(0.0);
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    let tonemapped = ((x * (a * x + b)) / (x * (c * x + d) + e))
        .max(0.0)
        .min(1.0);

    if tonemapped <= 0.0031308 {
        tonemapped * 12.92
    } else {
        1.055 * tonemapped.powf(1.0 / 2.4) - 0.055
    }
}

/// Decodes RAW image data, applies custom processing pipeline, and outputs a tone-mapped image with preserved highlight detail.
/// Uses the `rawler` crate for RAW decoding and processing.
///
/// # Arguments
/// * `file_bytes` - The RAW file bytes.
/// * `fast_demosaic` - Whether to use fast demosaic algorithm.
///
/// # Returns
/// * `Result<(DynamicImage, Orientation)>` - The developed image and orientation or an error.
fn develop_internal(file_bytes: &[u8], fast_demosaic: bool) -> Result<(DynamicImage, Orientation)> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source)?;
    let mut raw_image: RawImage = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;

    let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default())?;
    let orientation = metadata
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal);

    let original_white_level = raw_image
        .whitelevel
        .0
        .get(0)
        .cloned()
        .unwrap_or(u16::MAX as u32) as f32;
    let original_black_level = raw_image
        .blacklevel
        .levels
        .get(0)
        .map(|r| r.as_f32())
        .unwrap_or(0.0);

    let headroom_white_level = u32::MAX as f32;
    for level in raw_image.whitelevel.0.iter_mut() {
        *level = u32::MAX;
    }

    let mut developer = RawDevelop::default();
    if fast_demosaic {
        developer.demosaic_algorithm = DemosaicAlgorithm::Speed;
    }
    developer.steps.retain(|&step| step != ProcessingStep::SRgb);

    let mut developed_intermediate = developer.develop_intermediate(&raw_image)?;

    let denominator = (original_white_level - original_black_level).max(1.0);
    let rescale_factor = (headroom_white_level - original_black_level) / denominator;

    const HIGHLIGHT_COMPRESSION_POINT: f32 = 2.2; // FIXME: This is not a good solution yet

    match &mut developed_intermediate {
        Intermediate::Monochrome(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                let linear_val = *p * rescale_factor;
                *p = apply_tonemap_and_gamma(linear_val);
            });
        }
        Intermediate::ThreeColor(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                let r = (p[0] * rescale_factor).max(0.0);
                let g = (p[1] * rescale_factor).max(0.0);
                let b = (p[2] * rescale_factor).max(0.0);

                let max_c = r.max(g).max(b);

                let (final_r, final_g, final_b) = if max_c > 1.0 {
                    let min_c = r.min(g).min(b);
                    let compression_factor = (1.0
                        - (max_c - 1.0) / (HIGHLIGHT_COMPRESSION_POINT - 1.0))
                        .max(0.0)
                        .min(1.0);
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

                p[0] = apply_tonemap_and_gamma(final_r);
                p[1] = apply_tonemap_and_gamma(final_g);
                p[2] = apply_tonemap_and_gamma(final_b);
            });
        }
        Intermediate::FourColor(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                p.iter_mut().for_each(|c| {
                    let linear_val = *c * rescale_factor;
                    *c = apply_tonemap_and_gamma(linear_val);
                });
            });
        }
    }

    let dynamic_image = developed_intermediate
        .to_dynamic_image()
        .ok_or_else(|| anyhow::anyhow!("Failed to convert developed image to DynamicImage"))?;

    Ok((dynamic_image, orientation))
}
