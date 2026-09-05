use anyhow::{Context, Result, anyhow, bail};
use half::f16;
use image::{DynamicImage, ImageBuffer, Rgb};
use objc2_core_foundation::{
    CFData, CFDictionary, CFNumber, CFString, CFType, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetData, CGBitmapInfo, CGColorSpace, CGContext, CGImage,
    CGImageAlphaInfo, CGImageComponentInfo, kCGColorSpaceExtendedSRGB,
};
use objc2_image_io::{
    CGImageSource, kCGImagePropertyOrientation, kCGImagePropertyPixelHeight,
    kCGImagePropertyPixelWidth,
};
use rawler::Orientation;
use std::ffi::c_void;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

// A 100 MP RGBA16F output is already 800 MB before RapidRAW's float working
// buffer. Reject larger images before allocating that buffer.
const MAX_DECODED_PIXELS: usize = 100_000_000;

const HEIF_BRANDS: &[[u8; 4]] = &[
    *b"heic", *b"heix", *b"hevc", *b"hevx", *b"heim", *b"heis", *b"hevm", *b"hevs", *b"mif1",
    *b"msf1",
];

/// Decode HEIC/HEIF with Apple's licensed ImageIO/HEVC implementation.
///
/// ImageIO performs profile-aware conversion into extended sRGB. We retain
/// 16-bit float components, apply container orientation once, and never
/// create a lossy intermediate file.
pub fn decode(
    bytes: &[u8],
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    if !looks_like_heif(bytes) {
        bail!("The file extension is HEIC/HEIF, but the file is not a recognized HEIF container");
    }

    decode_with_image_io(bytes, cancel_token)
}

fn decode_with_image_io(
    bytes: &[u8],
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    check_cancel(&cancel_token)?;

    let data = CFData::from_bytes(bytes);
    // SAFETY: `data` is a valid immutable CFData and no options are supplied.
    let source = unsafe { CGImageSource::with_data(&data, None) }
        .context("Apple ImageIO could not open the HEIC/HEIF container")?;

    // SAFETY: `source` remains alive and index zero is validated by `count`.
    if unsafe { source.count() } == 0 {
        bail!("The HEIC/HEIF container does not contain an image");
    }

    let (orientation, declared_dimensions) = image_properties(&source);
    if let Some((width, height)) = declared_dimensions {
        checked_pixel_count(width, height)?;
    }
    // SAFETY: `source` contains an image at index zero and no options are used.
    let cg_image = unsafe { source.image_at_index(0, None) }.context(
        "Apple ImageIO could not decode this HEIC/HEIF image; its HEVC profile may not be supported on this Mac",
    )?;

    check_cancel(&cancel_token)?;

    let width = CGImage::width(Some(&cg_image));
    let height = CGImage::height(Some(&cg_image));
    let pixel_count = checked_pixel_count(width, height)?;
    let component_count = pixel_count
        .checked_mul(4)
        .context("HEIC/HEIF pixel buffer size overflow")?;
    let bytes_per_row = width
        .checked_mul(4)
        .and_then(|components| components.checked_mul(std::mem::size_of::<f16>()))
        .context("HEIC/HEIF row size overflow")?;

    // SAFETY: This framework constant is available on every supported macOS
    // version, and the retained color space outlives the bitmap context.
    let color_space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceExtendedSRGB }))
        .context("Apple CoreGraphics could not create an extended sRGB color space")?;
    let bitmap_info = CGImageAlphaInfo::PremultipliedLast.0
        | CGImageComponentInfo::Float.0
        | CGBitmapInfo::ByteOrder16Host.bits();

    // SAFETY: A null data pointer asks CoreGraphics to allocate and own a
    // correctly aligned bitmap. The validated dimensions and row size bound
    // that allocation.
    let context = unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut::<c_void>(),
            width,
            height,
            16,
            bytes_per_row,
            Some(&color_space),
            bitmap_info,
        )
    }
    .context("Apple CoreGraphics could not allocate the HEIC/HEIF conversion context")?;

    CGContext::draw_image(
        Some(&context),
        CGRect::new(CGPoint::ZERO, CGSize::new(width as f64, height as f64)),
        Some(&cg_image),
    );
    CGContext::flush(Some(&context));

    let data = CGBitmapContextGetData(Some(&context)).cast::<f16>();
    if data.is_null() {
        bail!("Apple CoreGraphics returned an empty HEIC/HEIF conversion buffer");
    }
    // SAFETY: The bitmap context owns at least `component_count` f16 values as
    // established by its dimensions, format, and row size. Copy before drop.
    let pixels = unsafe { std::slice::from_raw_parts(data, component_count) }.to_vec();
    drop(context);

    check_cancel(&cancel_token)?;
    if !pixels
        .as_chunks::<4>()
        .0
        .iter()
        .any(|pixel| pixel[3].to_f32() > f32::EPSILON)
    {
        bail!(
            "Apple's HEVC decoder returned no visible pixels; HEIC/HEIF decoding may be unavailable in this environment"
        );
    }
    let pixels = rgba16f_to_rgb32f(pixels);

    let width = u32::try_from(width).context("HEIC/HEIF width exceeds RapidRAW's image limits")?;
    let height =
        u32::try_from(height).context("HEIC/HEIF height exceeds RapidRAW's image limits")?;
    let image = ImageBuffer::<Rgb<f32>, _>::from_raw(width, height, pixels)
        .context("Apple ImageIO returned an invalid HEIC/HEIF pixel buffer")?;
    let oriented = crate::image_processing::apply_orientation(
        DynamicImage::ImageRgb32F(image),
        Orientation::from_u16(orientation),
    );

    Ok(DynamicImage::ImageRgb32F(oriented.into_rgb32f()))
}

fn check_cancel(cancel_token: &Option<(Arc<AtomicUsize>, usize)>) -> Result<()> {
    if let Some((tracker, generation)) = cancel_token
        && tracker.load(Ordering::SeqCst) != *generation
    {
        return Err(anyhow!("Load cancelled"));
    }
    Ok(())
}

fn checked_pixel_count(width: usize, height: usize) -> Result<usize> {
    if width == 0 || height == 0 {
        bail!("HEIC/HEIF decoder returned an empty image");
    }
    let pixel_count = width
        .checked_mul(height)
        .context("HEIC/HEIF dimensions overflow")?;
    if pixel_count > MAX_DECODED_PIXELS {
        bail!(
            "HEIC/HEIF image is too large to decode safely ({}x{}; maximum {} megapixels)",
            width,
            height,
            MAX_DECODED_PIXELS / 1_000_000
        );
    }
    Ok(pixel_count)
}

fn image_properties(source: &CGImageSource) -> (u16, Option<(usize, usize)>) {
    // SAFETY: The source and index are valid. ImageIO owns the dictionary and
    // its CoreFoundation keys/values for the duration of this function.
    let Some(properties) = (unsafe { source.properties_at_index(0, None) }) else {
        return (1, None);
    };
    // SAFETY: ImageIO property dictionaries use CFString keys and CFType values.
    let properties = unsafe { properties.cast_unchecked::<CFString, CFType>() };
    // SAFETY: These framework constants are valid CFString values.
    let orientation = property_i64(properties, unsafe { kCGImagePropertyOrientation })
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1);
    let dimensions = property_i64(properties, unsafe { kCGImagePropertyPixelWidth })
        .and_then(|width| usize::try_from(width).ok())
        .zip(
            property_i64(properties, unsafe { kCGImagePropertyPixelHeight })
                .and_then(|height| usize::try_from(height).ok()),
        );

    (orientation, dimensions)
}

fn property_i64(properties: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    // SAFETY: ImageIO's property dictionary is immutable while this borrowed
    // CoreFoundation value is inspected.
    unsafe { properties.get_unchecked(key) }
        .and_then(|value| value.downcast_ref::<CFNumber>())
        .and_then(CFNumber::as_i64)
}

fn looks_like_heif(bytes: &[u8]) -> bool {
    let scan_limit = bytes.len().min(64 * 1024);
    let mut offset = 0_usize;

    while offset.checked_add(8).is_some_and(|end| end <= scan_limit) {
        let size32 = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let box_type = &bytes[offset + 4..offset + 8];
        let (box_size, header_size) = match size32 {
            0 => (scan_limit - offset, 8),
            1 if offset + 16 <= scan_limit => {
                let size64 = u64::from_be_bytes(bytes[offset + 8..offset + 16].try_into().unwrap());
                let Ok(size64) = usize::try_from(size64) else {
                    return false;
                };
                (size64, 16)
            }
            1 => return false,
            size => (size, 8),
        };

        if box_size < header_size || offset.saturating_add(box_size) > scan_limit {
            return false;
        }

        if box_type == b"ftyp" {
            let payload = &bytes[offset + header_size..offset + box_size];
            if payload.len() < 8 {
                return false;
            }

            return HEIF_BRANDS.contains(payload[0..4].try_into().unwrap())
                || payload[8..]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|brand| HEIF_BRANDS.contains(brand));
        }

        offset += box_size;
    }

    false
}

fn rgba16f_to_rgb32f(pixels: Vec<f16>) -> Vec<f32> {
    let mut output = Vec::with_capacity(pixels.len() / 4 * 3);
    for pixel in pixels.as_chunks::<4>().0 {
        let alpha = pixel[3].to_f32();
        if alpha > f32::EPSILON {
            output.extend(
                pixel[..3]
                    .iter()
                    .map(|component| component.to_f32() / alpha),
            );
        } else {
            output.extend([0.0; 3]);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb as Rgb8};
    use std::io::Cursor;
    use std::process::Command;

    fn ftyp(major: &[u8; 4], compatible: &[[u8; 4]]) -> Vec<u8> {
        let size = 16 + compatible.len() * 4;
        let mut bytes = Vec::with_capacity(size);
        bytes.extend_from_slice(&(size as u32).to_be_bytes());
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(major);
        bytes.extend_from_slice(&0_u32.to_be_bytes());
        for brand in compatible {
            bytes.extend_from_slice(brand);
        }
        bytes
    }

    #[test]
    fn recognizes_heif_major_and_compatible_brands() {
        assert!(looks_like_heif(&ftyp(b"heic", &[])));
        assert!(looks_like_heif(&ftyp(b"isom", &[*b"mif1"])));
        assert!(!looks_like_heif(&ftyp(b"avif", &[])));
        assert!(!looks_like_heif(b"not a container"));
    }

    #[test]
    fn rejects_unsafe_output_dimensions() {
        assert!(checked_pixel_count(10_000, 10_000).is_ok());
        assert!(checked_pixel_count(10_001, 10_000).is_err());
        assert!(checked_pixel_count(0, 10).is_err());
    }

    #[test]
    fn unpremultiplies_float_color_channels() {
        let pixels = vec![
            f16::from_f32(0.25),
            f16::from_f32(0.125),
            f16::ZERO,
            f16::from_f32(0.5),
            f16::ONE,
            f16::ONE,
            f16::ONE,
            f16::ZERO,
        ];
        assert_eq!(rgba16f_to_rgb32f(pixels), [0.5, 0.25, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn image_io_renderer_preserves_top_to_bottom_row_order() -> Result<()> {
        let source = ImageBuffer::from_fn(64, 64, |_x, y| {
            if y < 32 {
                Rgb8([255_u8, 0, 0])
            } else {
                Rgb8([0, 0, 255])
            }
        });
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(source).write_to(&mut png, ImageFormat::Png)?;

        let decoded = decode_with_image_io(png.get_ref(), None)?.to_rgb32f();
        let top = decoded.get_pixel(32, 8);
        let bottom = decoded.get_pixel(32, 56);
        assert!(top[0] > top[2], "top row should remain red: {top:?}");
        assert!(
            bottom[2] > bottom[0],
            "bottom row should remain blue: {bottom:?}"
        );
        Ok(())
    }

    #[test]
    fn decodes_real_heic_with_system_codec() -> Result<()> {
        let source = ImageBuffer::from_pixel(16, 12, Rgb8([224_u8, 48, 16]));
        let temp_dir = tempfile::tempdir()?;
        let png_path = temp_dir.path().join("source.png");
        let heic_path = temp_dir.path().join("encoded.heic");
        DynamicImage::ImageRgb8(source).save_with_format(&png_path, ImageFormat::Png)?;

        let output = Command::new("/usr/bin/sips")
            .args(["-s", "format", "heic"])
            .arg(&png_path)
            .arg("--out")
            .arg(&heic_path)
            .output()
            .context("Could not invoke macOS sips to create the HEIC test image")?;
        if !output.status.success() {
            bail!(
                "macOS HEIC encoder failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        let bytes = std::fs::read(&heic_path)?;
        assert!(looks_like_heif(&bytes));

        let decoded = decode(&bytes, None)?.into_rgb32f();
        assert_eq!(decoded.dimensions(), (16, 12));
        let pixel = decoded.get_pixel(8, 6);
        assert!(
            pixel[0] > pixel[1] && pixel[1] > pixel[2],
            "decoded HEIC color channels should preserve their ordering: {pixel:?}"
        );
        Ok(())
    }
}
