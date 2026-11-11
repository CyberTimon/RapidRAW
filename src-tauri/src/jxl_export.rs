use image::{DynamicImage, GenericImageView};
use jxl_encoder::{
    ColorEncoding, LosslessConfig, LossyConfig, PixelLayout, TransferFunction,
    api::{calibrated_jxl_quality, quality_to_distance},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(try_from = "u16", into = "u16")]
pub enum JxlHdrPeakNits {
    #[default]
    Thousand = 1000,
    SixteenHundred = 1600,
}

impl TryFrom<u16> for JxlHdrPeakNits {
    type Error = String;
    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1000 => Ok(Self::Thousand),
            1600 => Ok(Self::SixteenHundred),
            _ => Err(format!(
                "Invalid HDR peak brightness '{value}'; expected 1000 or 1600 nits."
            )),
        }
    }
}

impl From<JxlHdrPeakNits> for u16 {
    fn from(value: JxlHdrPeakNits) -> Self {
        value as u16
    }
}
const HDR_DIFFUSE_WHITE_NITS: f32 = 203.0;
const XYB_REFERENCE_NITS: f32 = 255.0;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(try_from = "u8", into = "u8")]
pub enum JxlBitDepth {
    #[default]
    Eight = 8,
    Sixteen = 16,
}

impl TryFrom<u8> for JxlBitDepth {
    type Error = String;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            8 => Ok(Self::Eight),
            16 => Ok(Self::Sixteen),
            _ => Err(format!(
                "Invalid JPEG XL bit depth '{value}'; expected 8 or 16."
            )),
        }
    }
}

impl From<JxlBitDepth> for u8 {
    fn from(value: JxlBitDepth) -> Self {
        value as u8
    }
}

pub fn encode(
    image: &DynamicImage,
    bit_depth: JxlBitDepth,
    jpeg_quality: u8,
    hdr: bool,
    peak_nits: JxlHdrPeakNits,
) -> Result<Vec<u8>, String> {
    if hdr {
        if bit_depth != JxlBitDepth::Sixteen {
            return Err("HDR JPEG XL export requires 16-bit output.".into());
        }
        return if jpeg_quality == 100 {
            encode_lossless_hdr(image, peak_nits)
        } else {
            encode_lossy_hdr(image, jpeg_quality, peak_nits)
        };
    }

    let (width, height) = image.dimensions();
    let has_alpha = image.color().has_alpha();
    let (pixels, layout) = match (bit_depth, has_alpha) {
        (JxlBitDepth::Eight, false) => (image.to_rgb8().into_raw(), PixelLayout::Rgb8),
        (JxlBitDepth::Eight, true) => (image.to_rgba8().into_raw(), PixelLayout::Rgba8),
        (JxlBitDepth::Sixteen, false) => (
            bytemuck::cast_slice(image.to_rgb16().as_raw()).to_vec(),
            PixelLayout::Rgb16,
        ),
        (JxlBitDepth::Sixteen, true) => (
            bytemuck::cast_slice(image.to_rgba16().as_raw()).to_vec(),
            PixelLayout::Rgba16,
        ),
    };
    let jxl_data = if jpeg_quality == 100 {
        LosslessConfig::new()
            .with_tree_learning(false)
            .encode_request(width, height, layout)
            .encode(&pixels)
    } else {
        let distance = quality_to_distance(calibrated_jxl_quality(jpeg_quality as f32));
        let config = LossyConfig::new(distance);
        let request = config.encode_request(width, height, layout);
        request.encode(&pixels)
    }
    .map_err(|e| format!("Failed to encode JPEG XL: {e}"))?;

    Ok(jxl_data)
}

fn encode_lossy_hdr(
    image: &DynamicImage,
    quality: u8,
    peak_nits: JxlHdrPeakNits,
) -> Result<Vec<u8>, String> {
    let rgba = image.to_rgba32f();
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    let has_alpha = image.color().has_alpha();
    let mut alpha = Vec::with_capacity(if has_alpha { rgba.len() / 4 } else { 0 });
    for p in rgba.pixels() {
        // jxl-encoder 0.3.1's XYB transform uses a fixed 255-nit reference.
        // The decoder applies 255 / intensity_target before PQ conversion.
        rgb.extend(
            p.0[..3]
                .iter()
                .map(|v| hdr_nits(*v, peak_nits) / XYB_REFERENCE_NITS),
        );
        if has_alpha {
            alpha.push((p[3].clamp(0.0, 1.0) * u8::MAX as f32).round() as u8);
        }
    }
    let distance = quality_to_distance(calibrated_jxl_quality(quality as f32));
    let mut encoder = jxl_encoder::vardct::VarDctEncoder::new(distance);
    encoder.bit_depth_16 = true;
    encoder.color_encoding = Some(pq_encoding());
    encoder.intensity_target = peak_nits as u16 as f32;
    encoder
        .encode(
            image.width() as usize,
            image.height() as usize,
            &rgb,
            has_alpha.then_some(alpha.as_slice()),
        )
        .map(|output| output.data)
        .map_err(|e| format!("Failed to encode HDR JPEG XL: {e}"))
}

fn pq_encoding() -> ColorEncoding {
    ColorEncoding {
        transfer_function: TransferFunction::Pq,
        ..ColorEncoding::srgb()
    }
}

// jxl-encoder 0.3.1's high-level lossless API does not copy the requested color
// encoding to the file header. Use its modular encoder directly so PQ is signaled
// natively, without relying on an ICC profile to trigger HDR in the viewer.
fn encode_lossless_hdr(
    source: &DynamicImage,
    peak_nits: JxlHdrPeakNits,
) -> Result<Vec<u8>, String> {
    use jxl_encoder::{
        bit_writer::BitWriter,
        headers::{FileHeader, file_header::BitDepth},
        modular::{FrameEncoder, FrameEncoderOptions, ModularImage},
    };
    let (width, height) = source.dimensions();
    let alpha = source.color().has_alpha();
    let rgba = source.to_rgba32f();
    let channels = if alpha { 4 } else { 3 };
    let mut samples = Vec::with_capacity(rgba.len() / 4 * channels);
    for pixel in rgba.pixels() {
        samples.extend(pixel.0[..3].iter().map(|v| quantize_hdr(*v, peak_nits)));
        if alpha {
            samples.push((pixel[3].clamp(0.0, 1.0) * u16::MAX as f32).round() as u16);
        }
    }
    let pixels = bytemuck::cast_slice(&samples);
    let image = if alpha {
        ModularImage::from_rgba16_native(pixels, width as usize, height as usize)
    } else {
        ModularImage::from_rgb16_native(pixels, width as usize, height as usize)
    }
    .map_err(|e| e.to_string())?;
    let mut header = if alpha {
        FileHeader::new_rgba(width, height)
    } else {
        FileHeader::new_rgb(width, height)
    };
    header.metadata.bit_depth = BitDepth::uint16();
    for channel in &mut header.metadata.extra_channels {
        channel.bit_depth = BitDepth::uint16();
    }
    header.metadata.color_encoding = pq_encoding();
    header.metadata.intensity_target = peak_nits as u16 as f32;
    let mut writer = BitWriter::new();
    header.write(&mut writer).map_err(|e| e.to_string())?;
    writer.zero_pad_to_byte();
    FrameEncoder::new(
        width as usize,
        height as usize,
        FrameEncoderOptions::default(),
    )
    .encode_modular(&image, &pq_encoding(), &mut writer)
    .map_err(|e| e.to_string())?;
    Ok(writer.finish_with_padding())
}

fn hdr_nits(srgb: f32, peak_nits: JxlHdrPeakNits) -> f32 {
    if !srgb.is_finite() {
        return 0.0;
    }
    let linear = if srgb <= 0.04045 {
        srgb / 12.92
    } else {
        ((srgb + 0.055) / 1.055).powf(2.4)
    };
    (linear * HDR_DIFFUSE_WHITE_NITS).clamp(0.0, peak_nits as u16 as f32)
}

fn quantize_hdr(srgb: f32, peak_nits: JxlHdrPeakNits) -> u16 {
    (nits_to_pq(hdr_nits(srgb, peak_nits)) * 65535.0).round() as u16
}

fn nits_to_pq(nits: f32) -> f32 {
    let y = (nits / 10000.0).powf(2610.0 / 16384.0);
    ((3424.0 / 4096.0 + (2413.0 / 128.0) * y) / (1.0 + (2392.0 / 128.0) * y)).powf(2523.0 / 32.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn lossless_preserves_sixteen_bit_color_and_alpha() {
        let pixels = ImageBuffer::from_fn(8, 8, |x, y| {
            Rgba([1234 + x as u16 * 31, 23456 + y as u16 * 17, 54321, 45678])
        });
        let source = DynamicImage::ImageRgba16(pixels.clone());
        let encoded = encode(
            &source,
            JxlBitDepth::Sixteen,
            100,
            false,
            JxlHdrPeakNits::default(),
        )
        .unwrap();
        let decoded = jxl_oxide::JxlImage::builder()
            .read(std::io::Cursor::new(encoded))
            .unwrap();
        assert_eq!(
            decoded.image_header().metadata.bit_depth.bits_per_sample(),
            16
        );
        let render = decoded.render_frame(0).unwrap();
        let samples = render.image_all_channels();
        assert_eq!(samples.buf().len(), pixels.as_raw().len());
        for (actual, expected) in samples.buf().iter().zip(pixels.as_raw()) {
            assert!((actual * 65535.0 - *expected as f32).abs() < 1.0);
        }
    }

    #[test]
    fn lossy_exports_have_requested_depth() {
        let source = DynamicImage::ImageRgb16(ImageBuffer::from_pixel(
            8,
            8,
            image::Rgb([12345, 34567, 56789]),
        ));
        for depth in [JxlBitDepth::Eight, JxlBitDepth::Sixteen] {
            let encoded = encode(&source, depth, 90, false, JxlHdrPeakNits::default()).unwrap();
            let decoded = jxl_oxide::JxlImage::builder()
                .read(std::io::Cursor::new(encoded))
                .unwrap();
            assert_eq!(
                decoded.image_header().metadata.bit_depth.bits_per_sample(),
                depth as u32
            );
            decoded.render_frame(0).unwrap();
        }
    }

    #[test]
    fn hdr_preserves_luminance_and_signals_pq() {
        let source =
            DynamicImage::ImageRgba32F(ImageBuffer::from_pixel(8, 8, Rgba([3.0, 1.0, 0.5, 0.75])));
        for peak in [JxlHdrPeakNits::Thousand, JxlHdrPeakNits::SixteenHundred] {
            for quality in [90, 100] {
                let encoded = encode(&source, JxlBitDepth::Sixteen, quality, true, peak).unwrap();
                let mut decoded = jxl_oxide::JxlImage::builder()
                    .read(std::io::Cursor::new(encoded))
                    .unwrap();
                assert_eq!(
                    decoded.image_header().metadata.bit_depth.bits_per_sample(),
                    16
                );
                assert_eq!(
                    decoded
                        .image_header()
                        .metadata
                        .tone_mapping
                        .intensity_target,
                    peak as u16 as f32
                );
                assert!(decoded.original_icc().is_none());
                let mut pq =
                    jxl_oxide::EnumColourEncoding::srgb(jxl_oxide::RenderingIntent::Perceptual);
                pq.tf = jxl_oxide::color::TransferFunction::Pq;
                match &decoded.image_header().metadata.colour_encoding {
                    jxl_oxide::color::ColourEncoding::Enum(encoding) => {
                        assert_eq!(encoding.tf, pq.tf)
                    }
                    _ => panic!("HDR must signal PQ without an ICC profile"),
                }
                decoded.request_color_encoding(pq);
                let render = decoded.render_frame(0).unwrap();
                let samples = render.image_all_channels();
                let p = &samples.buf()[..4];
                // Check absolute decoded light, not only normalized sample values:
                // this catches the 255/1000 luminance scaling regression.
                let to_nits = |v: f32| {
                    let e = v.powf(32.0 / 2523.0);
                    10000.0
                        * ((e - 3424.0 / 4096.0).max(0.0) / (2413.0 / 128.0 - (2392.0 / 128.0) * e))
                            .powf(16384.0 / 2610.0)
                };
                assert!(
                    (to_nits(p[0]) - peak as u16 as f32).abs() < 20.0,
                    "incorrect highlight clipping for {peak:?}: {p:?}"
                );
                assert!((to_nits(p[1]) - 203.0).abs() < 5.0, "diffuse white: {p:?}");
                assert!((to_nits(p[2]) - 43.45).abs() < 2.0, "midtone: {p:?}");
                assert!((p[3] - 0.75).abs() < 0.01, "alpha: {p:?}");
            }
        }
        assert!(
            encode(
                &source,
                JxlBitDepth::Eight,
                90,
                true,
                JxlHdrPeakNits::default()
            )
            .is_err()
        );
    }

    #[test]
    fn default_and_validation() {
        assert_eq!(JxlBitDepth::default(), JxlBitDepth::Eight);
        assert!(JxlBitDepth::try_from(32).is_err());
        assert_eq!(JxlHdrPeakNits::default(), JxlHdrPeakNits::Thousand);
        assert!(serde_json::from_str::<JxlHdrPeakNits>("1200").is_err());
        assert_eq!(
            serde_json::to_string(&JxlHdrPeakNits::SixteenHundred).unwrap(),
            "1600"
        );
        let settings: crate::export_processing::ExportSettings =
            serde_json::from_str(r#"{"jpegQuality":90,"keepMetadata":true,"stripGps":true}"#)
                .unwrap();
        assert_eq!(settings.jxl_hdr_peak_nits, JxlHdrPeakNits::Thousand);
    }
}
