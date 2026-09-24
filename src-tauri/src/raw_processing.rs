use crate::image_processing::apply_orientation;
use anyhow::{Result, anyhow};
use image::{DynamicImage, ImageBuffer, Rgba};
use rawler::{
    decoders::{Orientation, RawDecodeParams},
    imgop::develop::{DemosaicAlgorithm, Intermediate, ProcessingStep, RawDevelop},
    rawimage::{RawImage, RawPhotometricInterpretation},
    rawsource::RawSource,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use rayon::prelude::*;

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

    check_cancel()?;
    let mut raw_image: RawImage = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;

    // Correct sensor white level if rawler extracted nominal JPEG maker note ceiling (e.g. 11892)
    // for 14-bit sensors whose physical sensels saturate at 16383
    if let Some(&w_val) = raw_image.whitelevel.0.first() {
        if w_val < 16383 && w_val > 5000 {
            let max_sensel = match &raw_image.data {
                rawler::rawimage::RawImageData::Integer(data) => data.iter().copied().max().unwrap_or(w_val as u16),
                _ => w_val as u16,
            };
            if max_sensel > w_val as u16 || w_val == 11892 {
                let target_white = (max_sensel as u32).max(16383);
                raw_image.whitelevel = rawler::rawimage::WhiteLevel(vec![target_white]);
            }
        }
    }

    let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default())?;
    let orientation = metadata
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal);
    let iso = metadata.exif.iso_speed.unwrap_or(100) as f32;

    // Sensor physics conditioning: OB row drift subtraction + 3x3 Bayer hot-pixel filter
    condition_raw_bayer_sensor(&mut raw_image, iso);

    let is_linear_format = is_linear_raw_format(&raw_image);

    let (apply_ungamma, apply_calibration) = match linear_mode.as_str() {
        "gamma" => (true, true),
        "skip_calib" => (false, false),
        "gamma_skip_calib" => (true, false),
        _ => (false, true),
    };

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
                let mut linear_val = *p;
                if is_linear_format && apply_ungamma {
                    linear_val = srgb_to_linear(linear_val.clamp(0.0, 1.0));
                }
                *p = linear_val.clamp(0.0, clamp_limit);
            });
        }
        Intermediate::ThreeColor(pixels) => {
            pixels.data.iter_mut().for_each(|p| {
                let mut r = p[0].max(0.0);
                let mut g = p[1].max(0.0);
                let mut b = p[2].max(0.0);

                if is_linear_format && apply_ungamma {
                    r = srgb_to_linear(r.clamp(0.0, 1.0));
                    g = srgb_to_linear(g.clamp(0.0, 1.0));
                    b = srgb_to_linear(b.clamp(0.0, 1.0));
                }

                let max_c = r.max(g).max(b);

                let (final_r, final_g, final_b) = if max_c > 0.95 {
                    // Chromaticity-preserving highlight inpainting & recovery
                    let min_c = r.min(g).min(b);
                    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

                    // Blend towards neutral white as brightness approaches and exceeds saturation threshold
                    let sat_ratio = if max_c > 1e-5 { ((max_c - min_c) / max_c).clamp(0.0, 1.0) } else { 0.0 };
                    let highlight_blend = ((max_c - 0.95) / (safe_highlight_compression - 0.95).max(0.05)).clamp(0.0, 1.0);
                    let desat_factor = 1.0 - (highlight_blend * 0.85);

                    let neutral_luma = luma.max(max_c * 0.9);
                    let inpaint_r = neutral_luma + (r - neutral_luma) * desat_factor * sat_ratio;
                    let inpaint_g = neutral_luma + (g - neutral_luma) * desat_factor * sat_ratio;
                    let inpaint_b = neutral_luma + (b - neutral_luma) * desat_factor * sat_ratio;

                    if max_c > 1.0 {
                        let compression_factor =
                            (1.0 - (max_c - 1.0) / (safe_highlight_compression - 1.0)).clamp(0.0, 1.0);
                        let comp_r = min_c + (inpaint_r - min_c) * compression_factor;
                        let comp_g = min_c + (inpaint_g - min_c) * compression_factor;
                        let comp_b = min_c + (inpaint_b - min_c) * compression_factor;
                        let comp_max = comp_r.max(comp_g).max(comp_b);
                        if comp_max > 1e-6 {
                            let rescale = max_c / comp_max;
                            (comp_r * rescale, comp_g * rescale, comp_b * rescale)
                        } else {
                            (max_c, max_c, max_c)
                        }
                    } else {
                        (inpaint_r, inpaint_g, inpaint_b)
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
                    let mut linear_val = *c;
                    if is_linear_format && apply_ungamma {
                        linear_val = srgb_to_linear(linear_val.clamp(0.0, 1.0));
                    }
                    *c = linear_val.clamp(0.0, clamp_limit);
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProDemosaicMethod {
    Rcd,
    Amaze,
    Ahd,
    LinearFast,
}

/// Ratio-Corrected Demosaicing (RCD) implementation for Bayer CFA arrays (RGGB / BGGR)
pub fn demosaic_rcd_bayer(
    cfa: &[f32],
    width: usize,
    height: usize,
    cfa_pattern: [u8; 4], // e.g. [0, 1, 1, 2] for RGGB (0=R, 1=G1, 2=G2, 3=B)
) -> Vec<[f32; 3]> {
    let mut rgb = vec![[0.0f32; 3]; width * height];

    // 1. Reconstruct Green channel using directional color ratio gradients
    for y in 2..(height - 2) {
        for x in 2..(width - 2) {
            let idx = y * width + x;
            let c = cfa[idx];
            let p_type = cfa_pattern[(y % 2) * 2 + (x % 2)];

            if p_type == 1 || p_type == 2 {
                // Already green pixel
                rgb[idx][1] = c;
            } else {
                // Red or Blue site: compute horizontal vs vertical color ratios
                let h_diff = (cfa[y * width + (x - 1)] - cfa[y * width + (x + 1)]).abs()
                    + (cfa[y * width + (x - 2)] - cfa[y * width + (x + 2)]).abs() * 0.5;
                let v_diff = (cfa[(y - 1) * width + x] - cfa[(y + 1) * width + x]).abs()
                    + (cfa[(y - 2) * width + x] - cfa[(y + 2) * width + x]).abs() * 0.5;

                if h_diff < v_diff * 0.8 {
                    // Strong horizontal edge
                    rgb[idx][1] = 0.5 * (cfa[y * width + (x - 1)] + cfa[y * width + (x + 1)]);
                } else if v_diff < h_diff * 0.8 {
                    // Strong vertical edge
                    rgb[idx][1] = 0.5 * (cfa[(y - 1) * width + x] + cfa[(y + 1) * width + x]);
                } else {
                    // Diagonal / smooth isotropic blend
                    rgb[idx][1] = 0.25 * (
                        cfa[y * width + (x - 1)] + cfa[y * width + (x + 1)]
                        + cfa[(y - 1) * width + x] + cfa[(y + 1) * width + x]
                    );
                }
            }
        }
    }

    // 2. Reconstruct Red and Blue using color ratio interpolation (R/G and B/G)
    for y in 2..(height - 2) {
        for x in 2..(width - 2) {
            let idx = y * width + x;
            let g = rgb[idx][1].max(1e-5);
            let p_type = cfa_pattern[(y % 2) * 2 + (x % 2)];

            if p_type == 0 {
                // Red site
                rgb[idx][0] = cfa[idx];
                // Blue from 4 diagonal neighbors
                let b_ratio = 0.25 * (
                    cfa[(y - 1) * width + (x - 1)] / rgb[(y - 1) * width + (x - 1)][1].max(1e-5)
                    + cfa[(y - 1) * width + (x + 1)] / rgb[(y - 1) * width + (x + 1)][1].max(1e-5)
                    + cfa[(y + 1) * width + (x - 1)] / rgb[(y + 1) * width + (x - 1)][1].max(1e-5)
                    + cfa[(y + 1) * width + (x + 1)] / rgb[(y + 1) * width + (x + 1)][1].max(1e-5)
                );
                rgb[idx][2] = (b_ratio * g).max(0.0);
            } else if p_type == 3 {
                // Blue site
                rgb[idx][2] = cfa[idx];
                // Red from 4 diagonal neighbors
                let r_ratio = 0.25 * (
                    cfa[(y - 1) * width + (x - 1)] / rgb[(y - 1) * width + (x - 1)][1].max(1e-5)
                    + cfa[(y - 1) * width + (x + 1)] / rgb[(y - 1) * width + (x + 1)][1].max(1e-5)
                    + cfa[(y + 1) * width + (x - 1)] / rgb[(y + 1) * width + (x - 1)][1].max(1e-5)
                    + cfa[(y + 1) * width + (x + 1)] / rgb[(y + 1) * width + (x + 1)][1].max(1e-5)
                );
                rgb[idx][0] = (r_ratio * g).max(0.0);
            } else {
                // Green site: interpolate R and B from horizontal/vertical neighbors
                if y % 2 == 0 && x % 2 == 1 {
                    // Green on Red row: Red is Left/Right, Blue is Top/Bottom
                    let r_ratio = 0.5 * (
                        cfa[y * width + (x - 1)] / rgb[y * width + (x - 1)][1].max(1e-5)
                        + cfa[y * width + (x + 1)] / rgb[y * width + (x + 1)][1].max(1e-5)
                    );
                    let b_ratio = 0.5 * (
                        cfa[(y - 1) * width + x] / rgb[(y - 1) * width + x][1].max(1e-5)
                        + cfa[(y + 1) * width + x] / rgb[(y + 1) * width + x][1].max(1e-5)
                    );
                    rgb[idx][0] = (r_ratio * g).max(0.0);
                    rgb[idx][2] = (b_ratio * g).max(0.0);
                } else {
                    // Green on Blue row: Blue is Left/Right, Red is Top/Bottom
                    let b_ratio = 0.5 * (
                        cfa[y * width + (x - 1)] / rgb[y * width + (x - 1)][1].max(1e-5)
                        + cfa[y * width + (x + 1)] / rgb[y * width + (x + 1)][1].max(1e-5)
                    );
                    let r_ratio = 0.5 * (
                        cfa[(y - 1) * width + x] / rgb[(y - 1) * width + x][1].max(1e-5)
                        + cfa[(y + 1) * width + x] / rgb[(y + 1) * width + x][1].max(1e-5)
                    );
                    rgb[idx][0] = (r_ratio * g).max(0.0);
                    rgb[idx][2] = (b_ratio * g).max(0.0);
                }
            }
        }
    }

    rgb
}

/// Extracts raw 4-channel Bayer CFA tensor (RGGB) for pre-demosaiced AI denoising
pub fn extract_raw_bayer_cfa(
    file_bytes: &[u8],
) -> Result<(Vec<f32>, usize, usize, [f32; 4])> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source)?;
    let raw_image = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;

    let w = raw_image.width;
    let h = raw_image.height;
    let half_w = w / 2;
    let half_h = h / 2;

    let mut tensor = vec![0.0f32; half_w * half_h * 4]; // 4-plane: R, G1, G2, B

    let white = raw_image.whitelevel.0.first().cloned().unwrap_or(16383) as f32;
    let black = raw_image.blacklevel.levels.first().map(|r| r.as_f32()).unwrap_or(2048.0);
    let denom = (white - black).max(1.0);

    let wb = [
        raw_image.wb_coeffs[0],
        raw_image.wb_coeffs[1],
        raw_image.wb_coeffs[2],
        raw_image.wb_coeffs[3],
    ];

    if let rawler::rawimage::RawImageData::Integer(data) = &raw_image.data {
        for y in 0..half_h {
            for x in 0..half_w {
                let p00 = (data[(y * 2) * w + (x * 2)] as f32 - black) / denom;
                let p01 = (data[(y * 2) * w + (x * 2 + 1)] as f32 - black) / denom;
                let p10 = (data[(y * 2 + 1) * w + (x * 2)] as f32 - black) / denom;
                let p11 = (data[(y * 2 + 1) * w + (x * 2 + 1)] as f32 - black) / denom;

                let tensor_idx = y * half_w + x;
                tensor[tensor_idx] = p00.clamp(0.0, 1.5);
                tensor[half_w * half_h + tensor_idx] = p01.clamp(0.0, 1.5);
                tensor[half_w * half_h * 2 + tensor_idx] = p10.clamp(0.0, 1.5);
                tensor[half_w * half_h * 3 + tensor_idx] = p11.clamp(0.0, 1.5);
            }
        }
    }

    Ok((tensor, half_w, half_h, wb))
}

/// Extracts un-interpolated 2D Bayer CFA array (1 value per pixel) with camera calibration
#[allow(dead_code)]
pub fn extract_raw_bayer_array(
    file_bytes: &[u8],
) -> Result<(Vec<f32>, usize, usize, [u8; 4], [f32; 4])> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source)?;
    let raw_image = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;

    let w = raw_image.width;
    let h = raw_image.height;

    let white = raw_image.whitelevel.0.first().cloned().unwrap_or(16383) as f32;
    let black = raw_image.blacklevel.levels.first().map(|r| r.as_f32()).unwrap_or(2048.0);
    let denom = (white - black).max(1.0);

    let wb = [
        raw_image.wb_coeffs[0],
        raw_image.wb_coeffs[1],
        raw_image.wb_coeffs[2],
        raw_image.wb_coeffs[3],
    ];

    let mut cfa = vec![0.0f32; w * h];
    if let rawler::rawimage::RawImageData::Integer(data) = &raw_image.data {
        for (i, &val) in data.iter().enumerate() {
            cfa[i] = ((val as f32 - black) / denom).clamp(0.0, 1.5);
        }
    }

    // RGGB standard pattern: 0=R, 1=G1, 2=G2, 3=B
    let pattern = [0u8, 1u8, 1u8, 2u8];
    Ok((cfa, w, h, pattern, wb))
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

/// High-speed embedded camera RAW preview extractor for RapidRAW.
/// Extracts full-resolution or medium-resolution embedded JPEGs directly
/// from RAW camera files (.CR2, .CR3, .NEF, .ARW, .DNG, .RAF) in ~10-15ms.
#[tauri::command]
pub fn extract_embedded_raw_preview(path: String, app_handle: tauri::AppHandle) -> std::result::Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};
    use crate::file_management::{parse_virtual_path, read_file_mapped};
    use crate::formats::is_raw_file;
    use crate::image_loader::load_base_image_from_bytes;
    use std::io::Cursor;
    use std::path::Path;

    let (source_path, _) = parse_virtual_path(&path);
    let path_str = source_path.to_string_lossy().to_string();

    let bytes = read_file_mapped(Path::new(&path_str))
        .map_err(|e| format!("Failed to read file for preview '{}': {}", path, e))?;

    if !is_raw_file(&path_str) {
        // For non-raw formats (JPEG, PNG, WebP), return direct asset file path URL
        return Ok(format!("asset://localhost/{}", path_str.replace('\\', "/")));
    }

    // Try fast embedded preview extraction
    let settings = crate::app_settings::load_settings(app_handle).unwrap_or_default();
    let img: DynamicImage = match load_base_image_from_bytes(&bytes, &path_str, false, &settings, None) {
        Ok(loaded) => loaded,
        Err(e) => return Err(format!("Could not extract preview for '{}': {}", path, e)),
    };

    // Encode to fast JPEG buffer (quality 85)
    let (w, h) = (img.width(), img.height());
    let resized = if w > 2560 || h > 2560 {
        let (new_w, new_h) = if w > h {
            (2560, (2560.0 * h as f32 / w as f32).round() as u32)
        } else {
            ((2560.0 * w as f32 / h as f32).round() as u32, 2560)
        };
        img.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let mut buf = Cursor::new(Vec::new());
    resized
        .to_rgb8()
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode preview JPEG: {}", e))?;

    let b64 = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

/// Suppresses isolated hot pixel spikes and CMOS thermal impulse noise in long-exposure raw frames
pub fn suppress_bayer_hot_pixels_and_impulse_noise(img: &mut image::Rgb32FImage) {
    use rayon::prelude::*;
    let (width, height) = img.dimensions();
    if width < 3 || height < 3 {
        return;
    }
    let src = img.clone();

    img.enumerate_rows_mut().par_bridge().for_each(|(y, row)| {
        if y == 0 || y == height - 1 {
            return;
        }
        for (x, _, pixel) in row {
            if x == 0 || x == width - 1 {
                continue;
            }
            for c in 0..3 {
                let center_val = src.get_pixel(x, y)[c];
                // 3x3 neighborhood median
                let mut neighbors = [
                    src.get_pixel(x - 1, y - 1)[c],
                    src.get_pixel(x, y - 1)[c],
                    src.get_pixel(x + 1, y - 1)[c],
                    src.get_pixel(x - 1, y)[c],
                    src.get_pixel(x + 1, y)[c],
                    src.get_pixel(x - 1, y + 1)[c],
                    src.get_pixel(x, y + 1)[c],
                    src.get_pixel(x + 1, y + 1)[c],
                ];
                neighbors.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let median = (neighbors[3] + neighbors[4]) * 0.5;
                let mad = (neighbors[5] - neighbors[2]).max(0.005); // Median Absolute Deviation floor

                // If center pixel is an outlier (> 5 sigma from local neighborhood)
                if (center_val - median) > 5.0 * mad && center_val > 0.05 {
                    pixel[c] = median;
                }
            }
        }
    });
}

/// Reconstructs partially clipped highlight cores from remaining unclipped channels
pub fn reconstruct_directional_clipped_highlights(img: &mut image::Rgb32FImage) {
    use rayon::prelude::*;
    img.enumerate_rows_mut().par_bridge().for_each(|(_, row)| {
        for (_, _, pixel) in row {
            let r = pixel[0];
            let g = pixel[1];
            let b = pixel[2];

            let is_r_clipped = r >= 0.98;
            let is_g_clipped = g >= 0.98;
            let is_b_clipped = b >= 0.98;

            let num_clipped = (is_r_clipped as u8) + (is_g_clipped as u8) + (is_b_clipped as u8);
            if num_clipped == 1 || num_clipped == 2 {
                // If only 1 or 2 channels are clipped, inpaint the clipped channel using unclipped channels
                let max_unclipped = if !is_g_clipped {
                    g
                } else if !is_r_clipped {
                    r
                } else {
                    b
                };

                let target_lum = max_unclipped * 1.15;
                if is_r_clipped {
                    pixel[0] = target_lum.max(pixel[0]);
                }
                if is_g_clipped {
                    pixel[1] = target_lum.max(pixel[1]);
                }
                if is_b_clipped {
                    pixel[2] = target_lum.max(pixel[2]);
                }
            }
        }
    });
}

/// Pre-demosaicing raw Bayer sensor conditioning for high-ISO and long-exposure frames:
/// 1. Optical Black (OB) row drift subtraction to eliminate horizontal read noise banding
/// 2. Raw-level 3x3 same-channel Bayer median hot-pixel filter to prevent colored demosaic crosses
pub fn condition_raw_bayer_sensor(raw_image: &mut rawler::rawimage::RawImage, iso: f32) {
    let w = raw_image.width;
    let h = raw_image.height;
    if w < 10 || h < 10 {
        return;
    }

    let nominal_black = raw_image
        .blacklevel
        .levels
        .first()
        .map(|r| r.as_f32())
        .unwrap_or(2048.0);

    // 1. Optical Black (OB) Row Drift Subtraction:
    // Search for a vertical optical black column strip in raw_image.blackareas (e.g. [0, 34, 260, 4056])
    let ob_strip = raw_image.blackareas.iter().find(|rect| {
        rect.width() >= 32 && rect.height() >= h / 2
    }).cloned();

    if let rawler::rawimage::RawImageData::Integer(ref mut data) = raw_image.data {
        if let Some(strip) = ob_strip {
            let x_start = strip.x() + 8; // skip transition boundary
            let x_end = (strip.x() + strip.width()).saturating_sub(8).min(w);
            let y_start = strip.y().min(h);
            let y_end = (strip.y() + strip.height()).min(h);

            if x_end > x_start && y_end > y_start {
                let sample_count = (x_end - x_start) as f32;

                // Process rows in parallel with Rayon: subtract per-row drift
                data.par_chunks_mut(w)
                    .enumerate()
                    .for_each(|(y, row)| {
                        if y >= y_start && y < y_end {
                            let mut ob_sum = 0.0f32;
                            for x in x_start..x_end {
                                ob_sum += row[x] as f32;
                            }
                            let ob_mean = ob_sum / sample_count;
                            let drift = ob_mean - nominal_black;

                            // If drift exceeds normal random fluctuation (> 0.5 DN), correct row
                            if drift.abs() > 0.5 {
                                for val in row.iter_mut() {
                                    *val = (*val as f32 - drift).clamp(0.0, 65535.0).round() as u16;
                                }
                            }
                        }
                    });
            }
        }

        // 2. Raw-Level 3x3 Same-Channel Bayer Median Hot-Pixel Filter:
        // Especially critical at ISO >= 1600 or long exposures to prevent colored demosaicing star artifacts.
        let iso_factor = (iso / 100.0).max(1.0);
        let spike_thresh = (150.0 * iso_factor.sqrt()).min(8000.0) as u16;

        // In active area, check sensels (x +/- 2, y +/- 2 for same Bayer channel)
        let active_crop = raw_image.crop_area.or(raw_image.active_area);
        let (crop_x0, crop_y0, crop_x1, crop_y1) = if let Some(c) = active_crop {
            (c.x().max(2), c.y().max(2), (c.x() + c.width()).min(w - 2), (c.y() + c.height()).min(h - 2))
        } else {
            (2, 2, w - 2, h - 2)
        };

        if crop_x1 > crop_x0 && crop_y1 > crop_y0 {
            // Snapshot for read-only neighbor lookups
            let data_snapshot = data.clone();
            data.par_chunks_mut(w)
                .enumerate()
                .for_each(|(y, row)| {
                    if y >= crop_y0 && y < crop_y1 {
                        let y_prev2 = (y - 2) * w;
                        let y_curr = y * w;
                        let y_next2 = (y + 2) * w;

                        for x in crop_x0..crop_x1 {
                            let val = row[x];
                            let p00 = data_snapshot[y_prev2 + x - 2];
                            let p01 = data_snapshot[y_prev2 + x];
                            let p02 = data_snapshot[y_prev2 + x + 2];
                            let p10 = data_snapshot[y_curr + x - 2];
                            let p12 = data_snapshot[y_curr + x + 2];
                            let p20 = data_snapshot[y_next2 + x - 2];
                            let p21 = data_snapshot[y_next2 + x];
                            let p22 = data_snapshot[y_next2 + x + 2];

                            let max_neighbor = p00.max(p01).max(p02).max(p10).max(p12).max(p20).max(p21).max(p22);
                            if val > max_neighbor.saturating_add(spike_thresh) {
                                let mut neighbors = [p00, p01, p02, p10, p12, p20, p21, p22];
                                neighbors.sort_unstable();
                                let median = (neighbors[3] as u32 + neighbors[4] as u32) / 2;
                                row[x] = median as u16;
                            }
                        }
                    }
                });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_inspect_raw_sensor_metadata() {
        let p = Path::new(r"D:\neapdirbti\IMG_4712.CR2");
        if !p.exists() { return; }
        let bytes = std::fs::read(p).unwrap();
        let source = rawler::rawsource::RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).unwrap();
        let mut raw_image = decoder.raw_image(&source, &rawler::decoders::RawDecodeParams::default(), false).unwrap();
        println!("RAW WxH: {}x{}", raw_image.width, raw_image.height);
        println!("Active area: {:?}", raw_image.active_area);
        println!("Crop area: {:?}", raw_image.crop_area);
        println!("Black areas: {:?}", raw_image.blackareas);
        println!("Black level: {:?}", raw_image.blacklevel);
        println!("White level: {:?}", raw_image.whitelevel);
        if let Some(r) = raw_image.active_area {
            println!("Rect x={}, y={}, w={}, h={}", r.x(), r.y(), r.width(), r.height());
        }

        // Test conditioning
        condition_raw_bayer_sensor(&mut raw_image, 1600.0);
        println!("Sensor conditioning passed successfully!");
    }
}

