use crate::render::color_space::OutputColorSpace;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, RgbImage, imageops};
use rayon::prelude::*;
use std::ops::Range;

const OFFSET: f32 = 1.0 / 64.0;
const MIN_RANGE_LOG2: f32 = 0.05;
const DOWNSCALE: u32 = 2;
const FRACTION_DENOMINATOR: u32 = 1 << 16;
const USE_BASE_COLOR_SPACE: u8 = 1 << 6;

const XMP_NAMESPACE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const ISO_NAMESPACE: &[u8] = b"urn:iso:std:iso:ts:21496:-1\0";
const MPF_SIGNATURE: &[u8] = b"MPF\0";
const MPF_SEGMENT_LENGTH: usize = 90;
const MPF_ENTRIES_OFFSET: u32 = 50;
const MPF_PRIMARY_IMAGE: u32 = 0x0003_0000;
const MAX_SEGMENT_PAYLOAD: usize = u16::MAX as usize - 2;

const APP1: u8 = 0xE1;
const APP2: u8 = 0xE2;
const START_OF_SCAN: u8 = 0xDA;

struct GainMap {
    image: RgbImage,
    max_log2: f32,
}

fn compute(
    sdr: &DynamicImage,
    hdr: &DynamicImage,
    color_space: OutputColorSpace,
) -> Result<GainMap, String> {
    let (width, height) = sdr.dimensions();
    let sdr_samples = sdr
        .as_flat_samples_u8()
        .ok_or("Gain map base image must be 8-bit")?;
    let hdr_samples = hdr
        .as_flat_samples_f32()
        .ok_or("Gain map HDR rendition must be floating point")?;
    let sdr_channels = sdr_samples.layout.channels as usize;
    let hdr_channels = hdr_samples.layout.channels as usize;
    if hdr.dimensions() != (width, height) || sdr_channels < 3 || hdr_channels < 3 {
        return Err("Gain map renditions do not match".to_string());
    }

    let curve = color_space.curve();
    let decoded: [f32; 256] = std::array::from_fn(|i| curve.decode(i as f32 / 255.0));
    let gain = |sdr: u8, hdr: f32| {
        let boost = (curve.decode(hdr.max(0.0)) + OFFSET) / (decoded[sdr as usize] + OFFSET);
        boost.log2().max(0.0)
    };
    let pixels = || {
        sdr_samples
            .samples
            .par_chunks_exact(sdr_channels)
            .zip(hdr_samples.samples.par_chunks_exact(hdr_channels))
    };

    let max_log2 = pixels()
        .map(|(sdr, hdr)| (0..3).map(|c| gain(sdr[c], hdr[c])).fold(0.0, f32::max))
        .reduce(|| MIN_RANGE_LOG2, f32::max);

    let mut encoded = vec![0u8; width as usize * height as usize * 3];
    encoded
        .par_chunks_exact_mut(3)
        .zip(pixels())
        .for_each(|(encoded, (sdr, hdr))| {
            for c in 0..3 {
                encoded[c] = (gain(sdr[c], hdr[c]) / max_log2 * 255.0).round() as u8;
            }
        });
    let full = RgbImage::from_raw(width, height, encoded).ok_or("Invalid gain map size")?;
    let image = imageops::resize(
        &full,
        width.div_ceil(DOWNSCALE),
        height.div_ceil(DOWNSCALE),
        imageops::FilterType::Triangle,
    );
    Ok(GainMap { image, max_log2 })
}

fn segment(marker: u8, parts: &[&[u8]]) -> Vec<u8> {
    let length = 2 + parts.iter().map(|part| part.len()).sum::<usize>();
    let mut segment = vec![0xFF, marker];
    segment.extend_from_slice(&(length as u16).to_be_bytes());
    for part in parts {
        segment.extend_from_slice(part);
    }
    segment
}

fn gain_map_xmp(max_log2: f32) -> String {
    format!(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"RapidRAW\">\n \
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  \
<rdf:Description rdf:about=\"\" xmlns:hdrgm=\"http://ns.adobe.com/hdr-gain-map/1.0/\" \
hdrgm:Version=\"1.0\" hdrgm:GainMapMin=\"0\" hdrgm:GainMapMax=\"{max}\" hdrgm:Gamma=\"1\" \
hdrgm:OffsetSDR=\"{offset}\" hdrgm:OffsetHDR=\"{offset}\" hdrgm:HDRCapacityMin=\"0\" \
hdrgm:HDRCapacityMax=\"{max}\" hdrgm:BaseRenditionIsHDR=\"False\"/>\n \
</rdf:RDF>\n</x:xmpmeta>",
        max = max_log2,
        offset = OFFSET,
    )
}

fn container_description(gain_map_length: usize) -> String {
    format!(
        "  <rdf:Description rdf:about=\"\" \
xmlns:Container=\"http://ns.google.com/photos/1.0/container/\" \
xmlns:Item=\"http://ns.google.com/photos/1.0/container/item/\" \
xmlns:hdrgm=\"http://ns.adobe.com/hdr-gain-map/1.0/\" hdrgm:Version=\"1.0\">\n   \
<Container:Directory>\n    <rdf:Seq>\n     \
<rdf:li rdf:parseType=\"Resource\">\n      \
<Container:Item Item:Semantic=\"Primary\" Item:Mime=\"image/jpeg\"/>\n     </rdf:li>\n     \
<rdf:li rdf:parseType=\"Resource\">\n      \
<Container:Item Item:Semantic=\"GainMap\" Item:Mime=\"image/jpeg\" Item:Length=\"{}\"/>\n     \
</rdf:li>\n    </rdf:Seq>\n   </Container:Directory>\n  </rdf:Description>\n",
        gain_map_length
    )
}

fn primary_xmp(existing: Option<&[u8]>, gain_map_length: usize) -> Option<Vec<u8>> {
    const RDF_END: &str = "</rdf:RDF>";
    let description = container_description(gain_map_length);
    let packet = match existing {
        Some(existing) => {
            let existing = std::str::from_utf8(existing).ok()?;
            let end = existing.rfind(RDF_END)?;
            format!("{}{}{}", &existing[..end], description, &existing[end..])
        }
        None => format!(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"RapidRAW\">\n \
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n{} {}\n</x:xmpmeta>",
            description, RDF_END
        ),
    };
    (XMP_NAMESPACE.len() + packet.len() <= MAX_SEGMENT_PAYLOAD).then(|| packet.into_bytes())
}

fn iso_metadata(max_log2: f32) -> Vec<u8> {
    let fraction = |value: f32| {
        [
            ((value * FRACTION_DENOMINATOR as f32).round() as i32).to_be_bytes(),
            FRACTION_DENOMINATOR.to_be_bytes(),
        ]
        .concat()
    };
    let mut metadata = vec![0, 0, 0, 0, USE_BASE_COLOR_SPACE];
    for value in [0.0, max_log2, 0.0, max_log2, 1.0, OFFSET, OFFSET] {
        metadata.extend(fraction(value));
    }
    metadata
}

fn mpf_segment(primary_length: usize, gain_map_length: usize, gain_map_offset: usize) -> Vec<u8> {
    let mut index = Vec::with_capacity(MPF_SEGMENT_LENGTH - 4);
    index.extend_from_slice(MPF_SIGNATURE);
    index.extend_from_slice(b"MM\0*");
    index.extend_from_slice(&8u32.to_be_bytes());
    index.extend_from_slice(&3u16.to_be_bytes());
    for (tag, kind, count, value) in [
        (0xB000u16, 7u16, 4u32, *b"0100"),
        (0xB001, 4, 1, 2u32.to_be_bytes()),
        (0xB002, 7, 32, MPF_ENTRIES_OFFSET.to_be_bytes()),
    ] {
        index.extend_from_slice(&tag.to_be_bytes());
        index.extend_from_slice(&kind.to_be_bytes());
        index.extend_from_slice(&count.to_be_bytes());
        index.extend_from_slice(&value);
    }
    index.extend_from_slice(&0u32.to_be_bytes());
    for (attribute, length, offset) in [
        (MPF_PRIMARY_IMAGE, primary_length, 0),
        (0, gain_map_length, gain_map_offset),
    ] {
        index.extend_from_slice(&attribute.to_be_bytes());
        index.extend_from_slice(&(length as u32).to_be_bytes());
        index.extend_from_slice(&(offset as u32).to_be_bytes());
        index.extend_from_slice(&[0; 4]);
    }
    segment(APP2, &[&index])
}

struct Layout {
    xmp: Option<Range<usize>>,
    apps_end: usize,
    scan: usize,
}

fn layout(jpeg: &[u8]) -> Option<Layout> {
    let (mut position, mut xmp, mut apps_end) = (2, None, 2);
    loop {
        if *jpeg.get(position)? != 0xFF {
            return None;
        }
        let marker = *jpeg.get(position + 1)?;
        if marker == START_OF_SCAN {
            return Some(Layout {
                xmp,
                apps_end,
                scan: position,
            });
        }
        let length = u16::from_be_bytes([*jpeg.get(position + 2)?, *jpeg.get(position + 3)?]);
        let end = position + 2 + length as usize;
        if (0xE0..=0xEF).contains(&marker) {
            apps_end = end;
            if marker == APP1 && jpeg.get(position + 4..end)?.starts_with(XMP_NAMESPACE) {
                xmp = Some(position..end);
            }
        }
        position = end;
    }
}

fn assemble(primary: &[u8], gain_map_jpeg: &[u8], max_log2: f32) -> Result<Vec<u8>, String> {
    let layout = layout(primary).ok_or("Unexpected JPEG structure for gain map export")?;

    let mut gain_map = vec![0xFF, 0xD8];
    gain_map.extend(segment(
        APP1,
        &[XMP_NAMESPACE, gain_map_xmp(max_log2).as_bytes()],
    ));
    gain_map.extend(segment(APP2, &[ISO_NAMESPACE, &iso_metadata(max_log2)]));
    gain_map.extend_from_slice(&gain_map_jpeg[2..]);

    let existing_xmp = layout
        .xmp
        .clone()
        .map(|range| &primary[range.start + 4 + XMP_NAMESPACE.len()..range.end]);
    let xmp = primary_xmp(existing_xmp, gain_map.len());
    if xmp.is_none() {
        log::warn!(
            "Gain map directory was left out of the XMP packet because it could not be extended"
        );
    }
    let replaced = layout.xmp.filter(|_| xmp.is_some());

    let mut output = Vec::with_capacity(primary.len() + gain_map.len() + 1024);
    match &replaced {
        Some(range) => {
            output.extend_from_slice(&primary[..range.start]);
            output.extend_from_slice(&primary[range.end..layout.apps_end]);
        }
        None => output.extend_from_slice(&primary[..layout.apps_end]),
    }
    if let Some(xmp) = &xmp {
        output.extend(segment(APP1, &[XMP_NAMESPACE, xmp]));
    }
    output.extend(segment(APP2, &[ISO_NAMESPACE, &[0; 4]]));
    output.extend_from_slice(&primary[layout.apps_end..layout.scan]);

    let mpf_position = output.len();
    let primary_length = mpf_position + MPF_SEGMENT_LENGTH + primary.len() - layout.scan;
    output.extend(mpf_segment(
        primary_length,
        gain_map.len(),
        primary_length - mpf_position - 8,
    ));
    output.extend_from_slice(&primary[layout.scan..]);
    output.extend(gain_map);
    Ok(output)
}

pub fn attach(
    primary: &[u8],
    sdr: &DynamicImage,
    hdr: &DynamicImage,
    color_space: OutputColorSpace,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let gain_map = compute(sdr, hdr, color_space)?;
    let mut gain_map_jpeg = Vec::new();
    gain_map
        .image
        .write_with_encoder(JpegEncoder::new_with_quality(&mut gain_map_jpeg, quality))
        .map_err(|e| e.to_string())?;
    assemble(primary, &gain_map_jpeg, gain_map.max_log2)
}
