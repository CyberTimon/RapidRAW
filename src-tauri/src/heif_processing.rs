use crate::image_processing::apply_orientation;
use anyhow::{Context, Result, anyhow};
use ffheif::Decoder;
use image::{DynamicImage, ImageBuffer, Rgba};
use rawler::Orientation;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const TRANSFER_PQ: u16 = 16;
const TRANSFER_HLG: u16 = 18;

pub fn decode_heif(
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

    let img = Decoder::new()
        .context("HEIF decoder init failed")?
        .decode(bytes)
        .context("HEIF decode failed")?;

    check_cancel()?;

    let info = img.info();

    if matches!(info.transfer_characteristics, TRANSFER_PQ | TRANSFER_HLG) {
        log::warn!(
            "HDR HEIF (transfer={}) decoded as if SDR; colors will be off until GPU HDR path lands",
            info.transfer_characteristics
        );
    }

    let buffer: ImageBuffer<Rgba<u16>, _> =
        ImageBuffer::from_raw(info.width, info.height, img.pixels_u16().to_vec())
            .context("HEIF decode produced an invalid pixel buffer")?;
    let oriented = apply_orientation(
        DynamicImage::ImageRgba16(buffer),
        Orientation::from_u16(info.exif_orientation as u16),
    );
    Ok(DynamicImage::ImageRgb32F(oriented.to_rgb32f()))
}
