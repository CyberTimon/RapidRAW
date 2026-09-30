//! Explicit sRGB profile embedding for the native display-referred raster.
//! This labels actual sRGB output; it never assigns an unrelated source profile.
use crate::color_profiles::srgb_profile;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat};
use std::io::Cursor;
type Result<T> = std::result::Result<T, String>;

pub(crate) fn canonical_format(format: &str) -> &str {
    match format {
        "jpg" => "jpeg",
        "tif" => "tiff",
        _ => format,
    }
}

pub(crate) fn supports_icc(format: &str) -> bool {
    matches!(canonical_format(format), "jpeg" | "png" | "tiff" | "webp")
}

pub(crate) fn encode_profiled_raster(
    image: &DynamicImage,
    format: &str,
    depth: u32,
    preserve_alpha: bool,
) -> Result<Vec<u8>> {
    let profile = srgb_profile()?;
    let alpha = preserve_alpha && canonical_format(format) == "png" && image.color().has_alpha();
    let raster = if depth == 16 && alpha {
        DynamicImage::ImageRgba16(image.to_rgba16())
    } else if depth == 16 {
        DynamicImage::ImageRgb16(image.to_rgb16())
    } else if alpha {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    };
    let mut output = Cursor::new(Vec::new());
    match canonical_format(format) {
        "png" => {
            let mut encoder = image::codecs::png::PngEncoder::new(&mut output);
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
            raster
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        "tiff" => {
            let mut encoder = image::codecs::tiff::TiffEncoder::new(&mut output);
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
            raster
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("INVALID_ARGUMENT: Profiled raster encoder supports PNG/TIFF".into()),
    }
    Ok(output.into_inner())
}

pub(crate) fn add_profile(bytes: &mut Vec<u8>, format: &str) -> Result<()> {
    let profile = srgb_profile()?;
    match canonical_format(format) {
        "jpeg" => {
            if !bytes.starts_with(&[0xff, 0xd8]) {
                return Err("INVALID_EXPORT: JPEG signature missing".into());
            }
            // ICC APP2 chunks have a 14-byte identifier/sequence prefix.
            let parts = profile.chunks(65519).collect::<Vec<_>>();
            if parts.len() > 255 {
                return Err("COLOR_PROFILE_FAILED: ICC profile is too large".into());
            }
            let mut segments = Vec::new();
            for (i, part) in parts.iter().enumerate() {
                segments.extend_from_slice(&[0xff, 0xe2]);
                segments.extend_from_slice(&((part.len() + 16) as u16).to_be_bytes());
                segments.extend_from_slice(b"ICC_PROFILE\0");
                segments.extend_from_slice(&[(i + 1) as u8, parts.len() as u8]);
                segments.extend_from_slice(part);
            }
            bytes.splice(2..2, segments);
        }
        "webp" => {
            if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
                return Err("INVALID_EXPORT: WebP signature missing".into());
            }
            // Caller normalizes VP8X after adding the ICCP chunk.
            let mut chunk = b"ICCP".to_vec();
            chunk.extend_from_slice(&(profile.len() as u32).to_le_bytes());
            chunk.extend_from_slice(&profile);
            if profile.len() % 2 != 0 {
                chunk.push(0);
            }
            let at = if bytes.get(12..16) == Some(b"VP8X") {
                30
            } else {
                12
            };
            bytes.splice(at..at, chunk);
            let size = u32::try_from(bytes.len() - 8)
                .map_err(|_| "INVALID_EXPORT: WebP container too large")?;
            bytes[4..8].copy_from_slice(&size.to_le_bytes());
        }
        _ => return Err("INVALID_ARGUMENT: Inline profile insertion supports JPEG/WebP".into()),
    }
    Ok(())
}

pub(crate) fn verify_profile(bytes: &[u8], format: &str) -> Result<bool> {
    let format = canonical_format(format);
    if format == "tiff" {
        let expected = srgb_profile()?;
        return Ok(tiff_profile(bytes)?.is_some_and(|profile| profile == expected));
    }
    let format = match format {
        "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "tiff" => ImageFormat::Tiff,
        "webp" => ImageFormat::WebP,
        _ => return Ok(false),
    };
    let mut decoder = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|e| format!("EXPORT_VERIFICATION_FAILED: {e}"))?;
    let embedded = decoder
        .icc_profile()
        .map_err(|e| format!("EXPORT_VERIFICATION_FAILED: {e}"))?;
    let expected = srgb_profile()?;
    Ok(embedded.as_ref().is_some_and(|p| p == &expected))
}

pub(crate) fn verify_raster_header(
    bytes: &[u8],
    format: &str,
    expected_dimensions: (u32, u32),
    expected_depth: u32,
) -> Result<()> {
    let image_format = match canonical_format(format) {
        "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "tiff" => ImageFormat::Tiff,
        "webp" => ImageFormat::WebP,
        _ => {
            return Err(format!(
                "EXPORT_VERIFICATION_FAILED: Unsupported raster format {format}"
            ));
        }
    };
    let decoder = image::ImageReader::with_format(Cursor::new(bytes), image_format)
        .into_decoder()
        .map_err(|e| format!("EXPORT_VERIFICATION_FAILED: {e}"))?;
    let dimensions = decoder.dimensions();
    let color = decoder.color_type();
    let depth = u32::from(color.bits_per_pixel()) / u32::from(color.channel_count());
    if dimensions != expected_dimensions || depth != expected_depth {
        return Err(format!(
            "EXPORT_VERIFICATION_FAILED: Expected {}x{} at {expected_depth}-bit, got {}x{} at {depth}-bit",
            expected_dimensions.0, expected_dimensions.1, dimensions.0, dimensions.1
        ));
    }
    Ok(())
}

// The image crate's TIFF ICC accessor can return None for valid encoded ICC
// fields. Verify the actual IFD entry and its full payload without re-encoding.
fn tiff_profile(bytes: &[u8]) -> Result<Option<&[u8]>> {
    let invalid = || "EXPORT_VERIFICATION_FAILED: Invalid TIFF ICC directory".to_string();
    let little = match bytes.get(..4) {
        Some(b"II\x2a\x00") => true,
        Some(b"MM\x00\x2a") => false,
        _ => return Err(invalid()),
    };
    let u16_at = |at: usize| -> Result<u16> {
        let v: [u8; 2] = bytes
            .get(at..at.checked_add(2).ok_or_else(invalid)?)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?;
        Ok(if little {
            u16::from_le_bytes(v)
        } else {
            u16::from_be_bytes(v)
        })
    };
    let u32_at = |at: usize| -> Result<u32> {
        let v: [u8; 4] = bytes
            .get(at..at.checked_add(4).ok_or_else(invalid)?)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?;
        Ok(if little {
            u32::from_le_bytes(v)
        } else {
            u32::from_be_bytes(v)
        })
    };
    let directory = u32_at(4)? as usize;
    let count = u16_at(directory)? as usize;
    let mut profile = None;
    for i in 0..count {
        let entry = directory.checked_add(2 + 12 * i).ok_or_else(invalid)?;
        let tag = u16_at(entry)?;
        let kind = u16_at(entry + 2)?;
        let length = u32_at(entry + 4)? as usize;
        let offset = u32_at(entry + 8)? as usize;
        if tag == 34675 {
            if profile.is_some() || ![1, 7].contains(&kind) || length < 128 {
                return Err(invalid());
            }
            profile = Some(
                bytes
                    .get(offset..offset.checked_add(length).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?,
            );
        }
    }
    Ok(profile)
}

/// little_exif can append EXIF to a simple WebP without declaring the extended
/// format. Standards-compliant readers then ignore that metadata. Keep every
/// existing chunk and feature flag; add/repair only its VP8X declaration.
/// https://developers.google.com/speed/webp/docs/riff_container#extended_file_format
pub(crate) fn normalize_webp_metadata_header(
    bytes: &mut Vec<u8>,
    dimensions: (u32, u32),
    force_extended: bool,
) -> Result<()> {
    let invalid = || "EXPORT_VERIFICATION_FAILED: Invalid WebP RIFF container".to_string();
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(invalid());
    }
    if u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as u64 + 8 != bytes.len() as u64 {
        return Err(invalid());
    }
    let (width, height) = dimensions;
    if width == 0
        || height == 0
        || width > 1 << 24
        || height > 1 << 24
        || u64::from(width) * u64::from(height) > u64::from(u32::MAX)
    {
        return Err("EXPORT_VERIFICATION_FAILED: WebP canvas exceeds format limits".into());
    }
    let mut offset = 12;
    let mut extended = None;
    let mut flags = 0u8;
    let mut needs_extended = force_extended;
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err(invalid());
        }
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start.checked_add(size).ok_or_else(invalid)?;
        let padded = end.checked_add(size & 1).ok_or_else(invalid)?;
        if padded > bytes.len() || (size & 1 != 0 && bytes[end] != 0) {
            return Err(invalid());
        }
        match &bytes[offset..offset + 4] {
            b"VP8X" => {
                if extended.is_some() || offset != 12 || size < 10 {
                    return Err(invalid());
                }
                extended = Some(start);
                flags |= bytes[start];
            }
            b"ICCP" | b"ALPH" | b"EXIF" | b"XMP " | b"ANIM" | b"ANMF" => {
                needs_extended = true;
                flags |= match &bytes[offset..offset + 4] {
                    b"ICCP" => 0x20,
                    b"ALPH" => 0x10,
                    b"EXIF" => 0x08,
                    b"XMP " => 0x04,
                    _ => 0x02,
                };
            }
            // VP8L carries its alpha flag in bit 28 of the lossless header.
            b"VP8L" if size >= 5 && bytes[start] == 0x2f => flags |= bytes[start + 4] & 0x10,
            _ => {}
        }
        offset = padded;
    }
    // Simple files without metadata or extended features need no new header.
    if extended.is_none() && !needs_extended {
        return Ok(());
    }
    let header = if let Some(start) = extended {
        start
    } else {
        let mut chunk = [0u8; 18];
        chunk[..4].copy_from_slice(b"VP8X");
        chunk[4..8].copy_from_slice(&10u32.to_le_bytes());
        let riff_size = u32::try_from(bytes.len() - 8 + chunk.len())
            .map_err(|_| "EXPORT_VERIFICATION_FAILED: WebP file exceeds RIFF size limit")?;
        bytes.splice(12..12, chunk);
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        20
    };
    bytes[header] = flags;
    bytes[header + 4..header + 7].copy_from_slice(&(width - 1).to_le_bytes()[..3]);
    bytes[header + 7..header + 10].copy_from_slice(&(height - 1).to_le_bytes()[..3]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn srgb_profile_has_aligned_tags_and_consistent_d50_colorimetry() {
        let bytes = srgb_profile().unwrap();
        let number = |at| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(number(0) as usize, bytes.len());
        assert_eq!(bytes.len() % 4, 0);
        assert_eq!(
            [number(68), number(72), number(76)],
            [0xf6d6, 0x10000, 0xd32d]
        );
        for i in 0..number(128) as usize {
            let entry = 132 + 12 * i;
            assert_eq!(number(entry + 4) % 4, 0);
            assert!((number(entry + 4) + number(entry + 8)) as usize <= bytes.len());
        }
        let decoded = moxcms::ColorProfile::new_from_slice(&bytes).unwrap();
        let expected = [0.9642, 1.0, 0.8249];
        let matrix = decoded.rgb_to_xyz_matrix();
        for (row, white) in matrix.v.iter().zip(expected) {
            assert!((row.iter().sum::<f64>() - white).abs() < 4.0 / 65536.0);
        }
        let chad = decoded.chromatic_adaptation.unwrap();
        let source_white = [0.3127 / 0.3290, 1.0, (1.0 - 0.3127 - 0.3290) / 0.3290];
        for (row, white) in chad.v.iter().zip(expected) {
            let adapted: f64 = row.iter().zip(source_white).map(|(a, b)| a * b).sum();
            assert!((adapted - white).abs() < 4.0 / 65536.0);
        }
        assert_eq!(srgb_profile().unwrap(), bytes);
    }
    #[test]
    fn encoded_profiles_roundtrip_without_changing_raster_depth() {
        let image = DynamicImage::ImageRgb16(image::ImageBuffer::from_fn(23, 11, |x, y| {
            image::Rgb([(x * 2000) as u16, (y * 3000) as u16, 12345])
        }));
        for format in ["png", "tiff"] {
            let bytes = encode_profiled_raster(&image, format, 16, false).unwrap();
            assert!(
                verify_profile(&bytes, format).unwrap(),
                "ICC missing or changed in {format}"
            );
            assert_eq!(
                image::load_from_memory(&bytes).unwrap().to_rgb16(),
                image.to_rgb16()
            );
        }
    }
    #[test]
    fn profiled_png_preserves_alpha_and_sixteen_bit_samples() {
        let image = DynamicImage::ImageRgba16(image::ImageBuffer::from_fn(7, 3, |x, y| {
            image::Rgba([12001 + x as u16, 21002 + y as u16, 34567, 32001 + x as u16])
        }));
        let bytes = encode_profiled_raster(&image, "png", 16, true).unwrap();
        verify_raster_header(&bytes, "png", (7, 3), 16).unwrap();
        assert!(verify_profile(&bytes, "png").unwrap());
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().to_rgba16(),
            image.to_rgba16()
        );
    }
    #[test]
    fn jpeg_profile_preserves_encoded_scan() {
        let image = DynamicImage::new_rgb8(8, 8);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
        let mut bytes = bytes.into_inner();
        let original_bytes = bytes.clone();
        let original = image::load_from_memory(&bytes).unwrap().to_rgb8();
        add_profile(&mut bytes, "jpeg").unwrap();
        assert!(verify_profile(&bytes, "jpeg").unwrap());
        assert!(bytes.ends_with(&original_bytes[2..]));
        assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgb8(), original);
    }
}
