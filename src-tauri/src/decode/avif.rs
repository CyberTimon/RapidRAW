use crate::decode::hdr_source::{GainMap, GainMapParams, HdrTransfer};
use crate::render::hdr::REFERENCE_WHITE_NITS;
use anyhow::{Result, anyhow};
use image::{DynamicImage, Rgb32FImage};
use zenavif::{
    ColorPrimaries, DecoderConfig, GainMapMetadata, ImageInfo, ManagedAvifDecoder,
    TransferCharacteristics, Unstoppable,
};
use zenpixels::{ChannelLayout, ChannelType};

const AVIF_BRANDS: [&[u8; 4]; 2] = [b"avif", b"avis"];

pub enum ContainerColor {
    Icc {
        icc: Vec<u8>,
        transfer: Option<HdrTransfer>,
    },
    Cicp {
        primaries: ColorPrimaries,
        transfer: Option<HdrTransfer>,
    },
}

pub struct AvifImage {
    pub rgb: Rgb32FImage,
    pub color: ContainerColor,
}

pub fn is_avif(bytes: &[u8]) -> bool {
    has_ftyp_brand(bytes, &AVIF_BRANDS)
}

pub fn has_ftyp_brand(bytes: &[u8], brands: &[&[u8; 4]]) -> bool {
    let Some(size) = bytes
        .get(..4)
        .map(|size| u32::from_be_bytes([size[0], size[1], size[2], size[3]]) as usize)
    else {
        return false;
    };
    if bytes.get(4..8) != Some(b"ftyp") || size < 16 {
        return false;
    }
    let Some(ftyp) = bytes.get(8..size.min(bytes.len())) else {
        return false;
    };
    ftyp.as_chunks::<4>()
        .0
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != 1)
        .any(|(_, brand)| brands.contains(&brand))
}

fn transfer(info: &ImageInfo) -> Option<HdrTransfer> {
    match info.transfer_characteristics {
        TransferCharacteristics::SMPTE2084 => Some(HdrTransfer::Pq),
        TransferCharacteristics::HLG => Some(HdrTransfer::Hlg),
        _ => None,
    }
}

fn fraction(numerator: i64, denominator: u32) -> f32 {
    numerator as f32 / denominator.max(1) as f32
}

pub fn gain_map_params(metadata: &GainMapMetadata) -> Option<GainMapParams> {
    if metadata.backward_direction {
        return None;
    }
    let channel = |index: usize| {
        let channel = &metadata.channels[if metadata.is_multichannel { index } else { 0 }];
        [
            fraction(channel.gain_map_min_n.into(), channel.gain_map_min_d),
            fraction(channel.gain_map_max_n.into(), channel.gain_map_max_d),
            fraction(channel.gamma_n.into(), channel.gamma_d),
            fraction(channel.base_offset_n.into(), channel.base_offset_d),
            fraction(
                channel.alternate_offset_n.into(),
                channel.alternate_offset_d,
            ),
        ]
    };
    let capacity = [
        fraction(
            metadata.base_hdr_headroom_n.into(),
            metadata.base_hdr_headroom_d,
        ),
        fraction(
            metadata.alternate_hdr_headroom_n.into(),
            metadata.alternate_hdr_headroom_d,
        ),
    ];
    GainMapParams::from_channels([channel(0), channel(1), channel(2)], Some(capacity))
}

fn probe(bytes: &[u8]) -> Option<ImageInfo> {
    ManagedAvifDecoder::new(bytes, &DecoderConfig::default())
        .ok()?
        .probe_info()
        .ok()
}

pub fn has_gain_map(bytes: &[u8]) -> bool {
    probe(bytes)
        .and_then(|info| info.gain_map)
        .is_some_and(|gain_map| gain_map_params(&gain_map.metadata).is_some())
}

pub fn hdr_peak(bytes: &[u8]) -> Option<f32> {
    let info = probe(bytes)?;
    match transfer(&info)? {
        HdrTransfer::Pq => Some(
            info.content_light_level
                .map(|level| f32::from(level.max_content_light_level))
                .filter(|nits| *nits > 0.0)
                .map_or_else(
                    || HdrTransfer::Pq.default_peak(),
                    |nits| nits / REFERENCE_WHITE_NITS,
                ),
        ),
        transfer => Some(transfer.default_peak()),
    }
}

fn to_rgb32f(pixels: &zenavif::PixelBuffer) -> Result<Rgb32FImage> {
    let descriptor = pixels.descriptor();
    let channels = descriptor.layout().channels();
    let (width, height) = (pixels.width(), pixels.height());
    let bytes_per_sample = match descriptor.channel_type() {
        ChannelType::U8 => 1,
        ChannelType::U16 | ChannelType::F16 => 2,
        ChannelType::F32 => 4,
        other => return Err(anyhow!("Unsupported AVIF sample type {:?}", other)),
    };
    let row_len = width as usize * channels * bytes_per_sample;
    let contiguous = pixels.copy_to_contiguous_bytes();
    if row_len == 0 || contiguous.len() < row_len * height as usize {
        return Err(anyhow!("Unexpected AVIF pixel buffer size"));
    }
    let sample = |row: &[u8], index: usize| -> f32 {
        match descriptor.channel_type() {
            ChannelType::U8 => f32::from(row[index]) / 255.0,
            ChannelType::U16 => {
                f32::from(u16::from_ne_bytes([row[index * 2], row[index * 2 + 1]])) / 65535.0
            }
            ChannelType::F16 => {
                half::f16::from_ne_bytes([row[index * 2], row[index * 2 + 1]]).to_f32()
            }
            ChannelType::F32 => f32::from_ne_bytes([
                row[index * 4],
                row[index * 4 + 1],
                row[index * 4 + 2],
                row[index * 4 + 3],
            ]),
            _ => 0.0,
        }
    };
    let gray = matches!(
        descriptor.layout(),
        ChannelLayout::Gray | ChannelLayout::GrayAlpha
    );
    let bgr = matches!(descriptor.layout(), ChannelLayout::Bgra);
    let mut data = Vec::with_capacity(width as usize * height as usize * 3);
    for row in contiguous.chunks_exact(row_len).take(height as usize) {
        for x in 0..width as usize {
            let base = x * channels;
            let rgb = if gray {
                [sample(row, base); 3]
            } else if bgr {
                [
                    sample(row, base + 2),
                    sample(row, base + 1),
                    sample(row, base),
                ]
            } else {
                [
                    sample(row, base),
                    sample(row, base + 1),
                    sample(row, base + 2),
                ]
            };
            data.extend_from_slice(&rgb);
        }
    }
    Rgb32FImage::from_raw(width, height, data).ok_or_else(|| anyhow!("Invalid AVIF image size"))
}

fn decode_gain_map(info: &ImageInfo, base_size: (u32, u32)) -> Option<GainMap> {
    let gain_map = info.gain_map.as_ref()?;
    let params = gain_map_params(&gain_map.metadata)?;
    let (pixels, width, height, channels) = zenavif::decode_av1_obu(&gain_map.gain_map_data)
        .map_err(|e| log::warn!("Could not decode the AVIF gain map: {}", e))
        .ok()?;
    if width > base_size.0 || height > base_size.1 {
        return None;
    }
    let channels = usize::from(channels);
    let data = pixels
        .chunks_exact(channels)
        .flat_map(|pixel| {
            let rgb = if channels >= 3 {
                [pixel[0], pixel[1], pixel[2]]
            } else {
                [pixel[0]; 3]
            };
            rgb.map(|value| f32::from(value) / 255.0)
        })
        .collect();
    GainMap::new(params, Rgb32FImage::from_raw(width, height, data)?)
}

fn orient(image: DynamicImage, info: &ImageInfo) -> DynamicImage {
    let rotated = match info.rotation.map(|rotation| rotation.angle) {
        Some(90) => image.rotate270(),
        Some(180) => image.rotate180(),
        Some(270) => image.rotate90(),
        _ => image,
    };
    match info.mirror.map(|mirror| mirror.axis) {
        Some(0) => rotated.fliph(),
        Some(1) => rotated.flipv(),
        _ => rotated,
    }
}

fn color(info: &ImageInfo) -> ContainerColor {
    let transfer = transfer(info);
    match &info.icc_profile {
        Some(icc) if !icc.is_empty() => ContainerColor::Icc {
            icc: icc.clone(),
            transfer,
        },
        _ => ContainerColor::Cicp {
            primaries: info.color_primaries,
            transfer,
        },
    }
}

pub fn gain_map(bytes: &[u8]) -> Option<(GainMap, ContainerColor)> {
    let info = probe(bytes)?;
    if transfer(&info).is_some() {
        return None;
    }
    let gain_map = decode_gain_map(&info, (info.width, info.height))?
        .transformed(|image| orient(image, &info));
    Some((gain_map, color(&info)))
}

pub fn decode(bytes: &[u8]) -> Result<AvifImage> {
    let mut decoder = ManagedAvifDecoder::new(bytes, &DecoderConfig::default())
        .map_err(|e| anyhow!("Failed to read AVIF: {}", e))?;
    let (pixels, info) = decoder
        .decode_full(&Unstoppable)
        .map_err(|e| anyhow!("Failed to decode AVIF: {}", e))?;
    let rgb = orient(DynamicImage::ImageRgb32F(to_rgb32f(&pixels)?), &info).to_rgb32f();
    Ok(AvifImage {
        rgb,
        color: color(&info),
    })
}
