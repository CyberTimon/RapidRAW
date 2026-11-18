#[cfg(target_os = "windows")]
use anyhow::{anyhow, Result};
#[cfg(target_os = "windows")]
use image::{DynamicImage, ImageBuffer, Rgb};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Imaging::*;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

#[cfg(target_os = "windows")]
pub fn decode_heif_or_avif_wic(bytes: &[u8]) -> Result<DynamicImage> {
    unsafe {
        // Initialize COM on this thread if not already initialized
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| anyhow!("Failed to create WIC Imaging Factory: {e}"))?;

        let stream = factory
            .CreateStream()
            .map_err(|e| anyhow!("Failed to create WIC stream: {e}"))?;

        stream
            .InitializeFromMemory(bytes)
            .map_err(|e| anyhow!("Failed to initialize WIC stream from bytes: {e}"))?;

        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
            .map_err(|e| anyhow!("Failed to create WIC decoder: {e}"))?;

        let frame = decoder
            .GetFrame(0)
            .map_err(|e| anyhow!("Failed to get WIC frame 0: {e}"))?;

        let mut width = 0u32;
        let mut height = 0u32;
        frame
            .GetSize(&mut width, &mut height)
            .map_err(|e| anyhow!("Failed to get WIC frame size: {e}"))?;

        if width == 0 || height == 0 {
            return Err(anyhow!("Invalid image dimensions: {width}x{height}"));
        }

        let pixel_format = frame
            .GetPixelFormat()
            .map_err(|e| anyhow!("Failed to get WIC pixel format: {e}"))?;

        let is_high_bit_depth = pixel_format == GUID_WICPixelFormat48bppRGB
            || pixel_format == GUID_WICPixelFormat48bppBGR
            || pixel_format == GUID_WICPixelFormat64bppRGBA
            || pixel_format == GUID_WICPixelFormat64bppBGRA
            || pixel_format == GUID_WICPixelFormat64bppPRGBA
            || pixel_format == GUID_WICPixelFormat64bppPBGRA
            || pixel_format == GUID_WICPixelFormat48bppRGBHalf
            || pixel_format == GUID_WICPixelFormat64bppRGBAHalf
            || pixel_format == GUID_WICPixelFormat128bppRGBAFloat
            || pixel_format == GUID_WICPixelFormat96bppRGBFloat;

        let converter = factory
            .CreateFormatConverter()
            .map_err(|e| anyhow!("Failed to create WIC format converter: {e}"))?;

        if is_high_bit_depth {
            // Preserve 10-bit / 12-bit / 16-bit data by converting to 48bpp RGB (16-bit per channel)
            converter
                .Initialize(
                    &frame,
                    &GUID_WICPixelFormat48bppRGB,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .map_err(|e| anyhow!("Failed to convert to 48bpp RGB: {e}"))?;

            let stride = width * 3 * 2; // 2 bytes per channel * 3 channels
            let buffer_size = (stride * height) as usize;
            let mut raw_bytes = vec![0u8; buffer_size];

            converter
                .CopyPixels(std::ptr::null(), stride, &mut raw_bytes)
                .map_err(|e| anyhow!("Failed to copy 16-bit pixels from WIC converter: {e}"))?;

            // Convert byte buffer to u16 buffer (little-endian)
            let mut u16_buffer = Vec::with_capacity((width * height * 3) as usize);
            for chunk in raw_bytes.chunks_exact(2) {
                u16_buffer.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }

            let img_buffer = ImageBuffer::<Rgb<u16>, Vec<u16>>::from_raw(width, height, u16_buffer)
                .ok_or_else(|| anyhow!("Failed to construct Rgb16 ImageBuffer"))?;

            Ok(DynamicImage::ImageRgb16(img_buffer))
        } else {
            // Standard 8-bit image: convert to 24bpp RGB
            converter
                .Initialize(
                    &frame,
                    &GUID_WICPixelFormat24bppRGB,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .map_err(|e| anyhow!("Failed to convert to 24bpp RGB: {e}"))?;

            let stride = width * 3;
            let buffer_size = (stride * height) as usize;
            let mut raw_bytes = vec![0u8; buffer_size];

            converter
                .CopyPixels(std::ptr::null(), stride, &mut raw_bytes)
                .map_err(|e| anyhow!("Failed to copy 8-bit pixels from WIC converter: {e}"))?;

            let img_buffer = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_raw(width, height, raw_bytes)
                .ok_or_else(|| anyhow!("Failed to construct Rgb8 ImageBuffer"))?;

            Ok(DynamicImage::ImageRgb8(img_buffer))
        }
    }
}
