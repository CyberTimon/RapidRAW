use crate::export::settings::{ExportSettings, TiffBitDepth};
use crate::metadata::tiff_metadata::{TiffSamples, encode_tiff_with_metadata};
use crate::metadata::{exif_processing, export_metadata};
use crate::render::color_space::OutputColorSpace;
use image::codecs::jpeg::{JpegEncoder, PixelDensity};
use image::codecs::png::PngEncoder;
use image::{DynamicImage, GenericImageView, ImageEncoder};
use jxl_encoder::{
    ImageMetadata, LosslessConfig, LossyConfig, PixelLayout,
    api::{calibrated_jxl_quality, quality_to_distance},
};
use rayon::prelude::*;
use std::borrow::Cow;
#[cfg(not(target_os = "android"))]
use std::fs;
use std::io::Cursor;
use std::path::Path;

pub fn set_timestamps_from_exif(src: &Path, dst: &Path) {
    let capture_dt = exif_processing::get_creation_date_from_path(src);

    if capture_dt.timestamp() <= 0 {
        let now = filetime::FileTime::now();
        if let Err(e) = filetime::set_file_times(dst, now, now) {
            log::warn!("Could not set timestamps on '{}': {}", dst.display(), e);
        }
        return;
    }

    let ft = filetime::FileTime::from_unix_time(
        capture_dt.timestamp(),
        capture_dt.timestamp_subsec_nanos(),
    );
    if let Err(e) = filetime::set_file_times(dst, ft, ft) {
        log::warn!("Could not set timestamps on '{}': {}", dst.display(), e);
    }
}

pub fn save_image_with_metadata(
    image: &DynamicImage,
    output_path: &std::path::Path,
    source_path_str: &str,
    export_xmp: &export_metadata::ExportXmp,
    export_settings: &ExportSettings,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let is_srgb = export_settings.color_space_for(&extension) == OutputColorSpace::Srgb;
    let tiff_metadata =
        if export_settings.keep_metadata && matches!(extension.as_str(), "tif" | "tiff") {
            export_metadata::collect_metadata_from_source(
                source_path_str,
                export_settings.strip_gps,
                Some(image.dimensions()),
                is_srgb,
            )
        } else {
            None
        };

    let mut image_bytes =
        encode_image_to_bytes(image, &extension, export_settings, tiff_metadata.as_ref())?;

    if export_settings.keep_metadata {
        export_metadata::write_image_with_metadata(
            &mut image_bytes,
            source_path_str,
            &extension,
            export_settings.strip_gps,
            export_xmp,
            export_settings.dpi,
            is_srgb,
        )?;
    }

    #[cfg(target_os = "android")]
    {
        let file_name = output_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Missing Android export file name".to_string())?;
        crate::platform::android::save_image_bytes_to_android_gallery(
            file_name,
            mime_type_for_extension(&extension),
            &image_bytes,
        )?;
    }

    #[cfg(not(target_os = "android"))]
    {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create folder '{}': {}", parent.display(), e))?;
        }
        fs::write(output_path, image_bytes)
            .map_err(|e| format!("Failed to write file to '{}': {}", output_path.display(), e))?;
    }

    Ok(())
}

#[cfg(target_os = "android")]
pub fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "jxl" => "image/jxl",
        _ => "application/octet-stream",
    }
}

pub fn encode_image_to_bytes(
    image: &DynamicImage,
    output_format: &str,
    export_settings: &ExportSettings,
    tiff_metadata: Option<&little_exif::metadata::Metadata>,
) -> Result<Vec<u8>, String> {
    let jpeg_quality = export_settings.jpeg_quality;
    let color_space = export_settings.color_space_for(output_format);
    let mut image_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut image_bytes);

    match output_format.to_lowercase().as_str() {
        "jxl" => {
            let (width, height) = image.dimensions();
            let has_alpha = image.color().has_alpha();
            let (pixels, layout, linear_layout) = if has_alpha {
                let pixels = image.to_rgba8().into_raw();
                (pixels, PixelLayout::Rgba8, PixelLayout::RgbaLinearF32)
            } else {
                let pixels = image.to_rgb8().into_raw();
                (pixels, PixelLayout::Rgb8, PixelLayout::RgbLinearF32)
            };
            let channels = layout.bytes_per_pixel();
            let metadata = match color_space {
                OutputColorSpace::Srgb => ImageMetadata::new(),
                _ => ImageMetadata::new().with_icc_profile(color_space.icc_profile()),
            };

            let jxl_data = if jpeg_quality == 100 {
                LosslessConfig::new()
                    .with_tree_learning(false)
                    .encode_request(width, height, layout)
                    .with_metadata(&metadata)
                    .encode(&pixels)
                    .map_err(|e| format!("Failed to encode lossless JXL: {}", e))?
            } else {
                let jxl_quality = calibrated_jxl_quality(jpeg_quality as f32);
                let config = LossyConfig::new(quality_to_distance(jxl_quality));

                if color_space == OutputColorSpace::Srgb {
                    config.encode_request(width, height, layout).encode(&pixels)
                } else {
                    let to_linear_srgb = color_space.linear_srgb_decoder();
                    let mut linear = vec![0.0f32; pixels.len()];
                    linear
                        .par_chunks_exact_mut(channels)
                        .zip(pixels.par_chunks_exact(channels))
                        .for_each(|(linear, encoded)| {
                            let rgb = to_linear_srgb([encoded[0], encoded[1], encoded[2]]);
                            linear[..3].copy_from_slice(&rgb);
                            if let Some(alpha) = encoded.get(3) {
                                linear[3] = f32::from(*alpha) / 255.0;
                            }
                        });
                    config
                        .encode_request(width, height, linear_layout)
                        .with_metadata(&metadata)
                        .encode(bytemuck::cast_slice(&linear))
                }
                .map_err(|e| format!("Failed to encode lossy JXL: {}", e))?
            };

            return Ok(jxl_data);
        }
        "webp" => {
            let encoder = webp::Encoder::from_image(image)
                .map_err(|_| "Failed to create WebP encoder".to_string())?;
            let mut webp_data = encoder.encode(jpeg_quality as f32).to_vec();
            if color_space != OutputColorSpace::Srgb {
                export_metadata::embed_webp_icc(&mut webp_data, color_space.icc_profile());
            }
            return Ok(webp_data);
        }
        "jpg" | "jpeg" => {
            let rgb_image = image
                .as_rgb8()
                .map_or_else(|| Cow::Owned(image.to_rgb8()), Cow::Borrowed);
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, jpeg_quality);
            encoder
                .set_icc_profile(color_space.icc_profile().to_vec())
                .map_err(|e| e.to_string())?;
            if let Some(dpi) = export_settings.dpi {
                encoder.set_pixel_density(PixelDensity::dpi(dpi));
            }
            rgb_image
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        "png" => {
            let converted;
            let image_to_encode = if image.as_rgb32f().is_some() {
                converted = DynamicImage::ImageRgb16(image.to_rgb16());
                &converted
            } else {
                image
            };

            let mut encoder = PngEncoder::new(&mut cursor);
            encoder
                .set_icc_profile(color_space.icc_profile().to_vec())
                .map_err(|e| e.to_string())?;
            image_to_encode
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
            if let Some(dpi) = export_settings.dpi {
                insert_png_phys_chunk(&mut image_bytes, dpi);
            }
        }
        "tif" | "tiff" => {
            let samples = match export_settings.tiff_bit_depth {
                TiffBitDepth::Eight => TiffSamples::Eight,
                TiffBitDepth::Sixteen => TiffSamples::Sixteen,
            };
            return encode_tiff_with_metadata(
                image,
                samples,
                tiff_metadata,
                Some(color_space.icc_profile()),
                export_settings.dpi,
            );
        }
        "avif" => {
            image
                .write_to(&mut cursor, image::ImageFormat::Avif)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unsupported file format: {}", output_format)),
    };
    Ok(image_bytes)
}

fn insert_png_phys_chunk(image_bytes: &mut Vec<u8>, dpi: u16) {
    let pixels_per_meter = (f64::from(dpi) / 0.0254).round() as u32;
    let mut data = Vec::with_capacity(9);
    data.extend_from_slice(&pixels_per_meter.to_be_bytes());
    data.extend_from_slice(&pixels_per_meter.to_be_bytes());
    data.push(1);
    export_metadata::insert_png_chunk(image_bytes, b"pHYs", &data);
}
