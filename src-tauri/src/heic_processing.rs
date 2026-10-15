use anyhow::{Result, anyhow};
use heic::{DecoderConfig, PixelLayout};
use image::{DynamicImage, RgbImage};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub fn decode_heic(
    bytes: &[u8],
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    let check_cancel = || -> Result<()> {
        if let Some((tracker, generation)) = &cancel_token
            && tracker.load(Ordering::SeqCst) != *generation
        {
            return Err(anyhow!("Load cancelled"));
        }
        Ok(())
    };

    check_cancel()?;

    let output = DecoderConfig::new()
        .decode(bytes, PixelLayout::Rgb8)
        .map_err(|e| anyhow!("HEIC decode failed: {}", e))?;

    check_cancel()?;

    let image = RgbImage::from_raw(output.width, output.height, output.data)
        .ok_or_else(|| anyhow!("HEIC decode produced an invalid pixel buffer"))?;

    Ok(DynamicImage::ImageRgb32F(
        DynamicImage::ImageRgb8(image).to_rgb32f(),
    ))
}
