#[allow(unused_imports)]
use anyhow::{anyhow, Result};
use image::DynamicImage;

#[cfg(target_os = "windows")]
use crate::decode::heif_wic::decode_heif_or_avif_wic;

pub fn decode_heif_or_avif(_bytes: &[u8]) -> Result<DynamicImage> {
    #[cfg(target_os = "windows")]
    {
        decode_heif_or_avif_wic(_bytes)
    }

    #[cfg(target_os = "macos")]
    {
        decode_heif_or_avif_macos(_bytes)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err(anyhow!("HEIF/AVIF decoding is not supported on this platform"))
    }
}

#[cfg(target_os = "macos")]
fn decode_heif_or_avif_macos(bytes: &[u8]) -> Result<DynamicImage> {
    use objc2::rc::autoreleasepool;
    use objc2_core_graphics::{CGColorSpace, kCGColorSpaceExtendedLinearSRGB};
    use objc2_core_image::{CIContext, CIImage, kCIFormatRGBAf};
    use objc2_foundation::NSData;
    use image::{ImageBuffer, Rgba};
    use std::ptr::NonNull;

    unsafe {
        autoreleasepool(|_| {
            let data = NSData::with_bytes(bytes);
            let image = CIImage::imageWithData(&data)
                .ok_or_else(|| anyhow!("Failed to load CIImage from bytes"))?;

            let extent = image.extent();
            let width = extent.size.width as u32;
            let height = extent.size.height as u32;
            if width == 0 || height == 0 {
                return Err(anyhow!("Invalid image dimensions: {width}x{height}"));
            }

            let color_space = CGColorSpace::with_name(Some(kCGColorSpaceExtendedLinearSRGB))
                .ok_or_else(|| anyhow!("Could not create extended linear color space"))?;

            let context = CIContext::context();
            let row_bytes = (width as usize) * 4 * std::mem::size_of::<f32>();
            let mut buf = vec![0f32; (width as usize) * (height as usize) * 4];
            let data_ptr = NonNull::new(buf.as_mut_ptr().cast())
                .ok_or_else(|| anyhow!("Failed to allocate render buffer"))?;

            context.render_toBitmap_rowBytes_bounds_format_colorSpace(
                &image,
                data_ptr,
                row_bytes as isize,
                extent,
                kCIFormatRGBAf,
                Some(&color_space),
            );

            let buffer = ImageBuffer::<Rgba<f32>, _>::from_raw(width, height, buf)
                .ok_or_else(|| anyhow!("Buffer size mismatch"))?;
            Ok(DynamicImage::ImageRgba32F(buffer))
        })
    }
}
