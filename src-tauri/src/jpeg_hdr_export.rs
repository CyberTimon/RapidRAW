//! Pure-Rust Ultra HDR JPEG export: an ordinary sRGB JPEG plus an RGB gain map.
//!
//! The GPU supplies extended-sRGB HDR samples and a separate SDR rendering. Package
//! the gain map only after editing EXIF/XMP: MPF offsets depend on the final sizes.
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb, codecs::jpeg::JpegEncoder};
use quick_xml::{
    Writer,
    events::{BytesText, Event},
    name::ResolveResult,
    reader::NsReader,
};
use std::borrow::Cow;
use ultrahdr_rs::{
    GainMapEncodingFormat, GainMapMetadata,
    container::scan_segments,
    metadata::{
        iso21496::create_version_only_iso_app2,
        mpf::create_mpf_header,
        xmp::{build_gainmap_metadata_markers, create_xmp_app1_marker, generate_primary_xmp},
    },
};

const HEADROOM: f32 = 1000.0 / 203.0;
const OFFSET: f32 = 1.0 / 64.0;
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn linear(sample: f32) -> f32 {
    let sample = if sample.is_finite() {
        sample.max(0.0)
    } else {
        0.0
    };
    if sample <= 0.04045 {
        sample / 12.92
    } else {
        ((sample + 0.055) / 1.055).powf(2.4)
    }
}

fn gain_map(hdr: &DynamicImage, base: &DynamicImage) -> Result<(Vec<u8>, GainMapMetadata), String> {
    if hdr.dimensions() != base.dimensions() || hdr.width() == 0 || hdr.height() == 0 {
        return Err("Ultra HDR requires nonempty, matching HDR and SDR images".into());
    }
    let base = base
        .as_rgb8()
        .map_or_else(|| Cow::Owned(base.to_rgb8()), Cow::Borrowed);
    let fallback;
    let (samples, channels) = if let Some(rgb) = hdr.as_rgb32f() {
        (rgb.as_raw().as_slice(), 3)
    } else if let Some(rgba) = hdr.as_rgba32f() {
        (rgba.as_raw().as_slice(), 4)
    } else {
        fallback = hdr.to_rgb32f();
        (fallback.as_raw().as_slice(), 3)
    };
    // Average each block in log space. Allocate only the quarter-resolution map,
    // not another full-resolution floating-point copy of a large RAW export.
    let mut gains =
        ImageBuffer::<Rgb<f32>, Vec<f32>>::new(hdr.width().div_ceil(4), hdr.height().div_ceil(4));
    for (gx, gy, out) in gains.enumerate_pixels_mut() {
        let mut count = 0.0;
        for y in gy * 4..((gy + 1) * 4).min(hdr.height()) {
            for x in gx * 4..((gx + 1) * 4).min(hdr.width()) {
                let index = (y as usize * hdr.width() as usize + x as usize) * channels;
                for channel in 0..3 {
                    let h = linear(samples[index + channel]).min(HEADROOM);
                    let s = linear(base.get_pixel(x, y)[channel] as f32 / 255.0);
                    out[channel] += ((h + OFFSET) / (s + OFFSET)).log2();
                }
                count += 1.0;
            }
        }
        for value in &mut out.0 {
            *value /= count;
        }
    }
    let min = gains.as_raw().iter().copied().fold(0.0_f32, f32::min);
    let max = gains
        .as_raw()
        .iter()
        .copied()
        .fold(0.0_f32, f32::max)
        .max(min + 1.0 / 1024.0);
    let samples: Vec<u8> = gains
        .as_raw()
        .iter()
        .map(|gain| (((gain - min) / (max - min)).clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode(
            &samples,
            gains.width(),
            gains.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
    // The bounds used to quantize samples must also be the bounds in the metadata.
    let mut metadata = GainMapMetadata::default();
    metadata.gain_map_min = [min as f64; 3];
    metadata.gain_map_max = [max as f64; 3];
    metadata.alternate_hdr_headroom = (HEADROOM as f64).log2();
    Ok((jpeg, metadata))
}

/// Add the new container description to the existing XMP packet, preserving its
/// namespace scope. Old gain-map/container properties must not refer to the source.
fn merge_xmp(source: &str, description: &str) -> Result<String, String> {
    let mut reader = NsReader::from_str(source);
    let mut writer = Writer::new(Vec::new());
    let mut inserted = false;
    let stale = |ns: ResolveResult<'_>| {
        matches!(ns, ResolveResult::Bound(ns)
        if matches!(ns.as_ref(), b"http://ns.adobe.com/hdr-gain-map/1.0/" | b"http://ns.google.com/photos/1.0/container/"))
    };
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match event {
            Event::Eof => break,
            Event::Start(e) if stale(reader.resolver().resolve_element(e.name()).0) => {
                reader.read_to_end(e.name()).map_err(|e| e.to_string())?;
            }
            Event::Empty(e) if stale(reader.resolver().resolve_element(e.name()).0) => {}
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let empty = matches!(event, Event::Empty(_));
                let (Event::Start(e) | Event::Empty(e)) = event else {
                    unreachable!()
                };
                let mut clean = e.to_owned();
                clean.clear_attributes();
                for attribute in e.attributes() {
                    let attribute = attribute.map_err(|e| e.to_string())?;
                    if !stale(reader.resolver().resolve_attribute(attribute.key).0) {
                        clean.push_attribute(attribute);
                    }
                }
                writer
                    .write_event(if empty {
                        Event::Empty(clean)
                    } else {
                        Event::Start(clean)
                    })
                    .map_err(|e| e.to_string())?;
            }
            Event::End(e)
                if {
                    let (ns, local) = reader.resolver().resolve_element(e.name());
                    local.as_ref() == b"RDF"
                        && matches!(ns, ResolveResult::Bound(ns) if ns.as_ref() == b"http://www.w3.org/1999/02/22-rdf-syntax-ns#")
                } =>
            {
                writer
                    .write_event(Event::Text(BytesText::from_escaped(description)))
                    .map_err(|e| e.to_string())?;
                writer
                    .write_event(Event::End(e))
                    .map_err(|e| e.to_string())?;
                inserted = true;
            }
            event => writer.write_event(event).map_err(|e| e.to_string())?,
        }
    }
    if !inserted {
        return Err("Cannot merge Ultra HDR metadata into the source XMP".into());
    }
    String::from_utf8(writer.into_inner()).map_err(|e| e.to_string())
}

pub(crate) fn encode(
    hdr: &DynamicImage,
    sdr: &DynamicImage,
    base_jpeg: &[u8],
) -> Result<Vec<u8>, String> {
    if hdr.dimensions() != sdr.dimensions() {
        return Err("Ultra HDR render dimensions differ".into());
    }
    // Account for JPEG quantization in the actual fallback, not just the pre-encode pixels.
    let decoded_base = image::load_from_memory_with_format(base_jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    let (gain_jpeg, metadata) = gain_map(hdr, &decoded_base)?;
    let mut secondary = vec![0xff, 0xd8];
    for marker in build_gainmap_metadata_markers(&metadata, GainMapEncodingFormat::Both) {
        secondary.extend(marker);
    }
    secondary.extend_from_slice(&gain_jpeg[2..]);

    let generated = generate_primary_xmp(secondary.len());
    let description_start = generated
        .find("<rdf:Description")
        .ok_or("Missing HDR XMP description")?;
    let description_end = generated
        .find("</rdf:Description>")
        .ok_or("Missing HDR XMP description end")?
        + "</rdf:Description>".len();
    let description = generated[description_start..description_end].replacen(
        "<rdf:Description",
        "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"",
        1,
    );
    let segments = scan_segments(base_jpeg);
    let mut packet = generated.clone();
    if let Some(xmp) = segments.iter().find(|s| s.is_xmp()) {
        let source =
            std::str::from_utf8(&xmp.data[XMP_HEADER.len()..]).map_err(|e| e.to_string())?;
        packet = merge_xmp(source, &description)?;
    }
    if XMP_HEADER.len() + packet.len() + 2 > u16::MAX as usize {
        return Err("Ultra HDR XMP exceeds the JPEG metadata segment limit".into());
    }
    let mut primary = vec![0xff, 0xd8];
    primary.extend(create_xmp_app1_marker(&packet));
    primary.extend(create_version_only_iso_app2());
    let mut cursor = 2;
    for segment in segments.iter().filter(|s| s.is_xmp() || s.is_mpf()) {
        primary.extend_from_slice(&base_jpeg[cursor..segment.offset]);
        cursor = segment.offset + segment.data.len() + 4;
    }
    primary.extend_from_slice(&base_jpeg[cursor..]);
    let mpf_len = create_mpf_header(0, 0, Some(2)).len();
    let mpf = create_mpf_header(primary.len() + mpf_len, secondary.len(), Some(2));
    let mut output = Vec::with_capacity(primary.len() + mpf.len() + secondary.len());
    output.extend_from_slice(&primary[..2]);
    output.extend(mpf);
    output.extend_from_slice(&primary[2..]);
    output.extend(secondary);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, RgbImage};
    use ultrahdr_rs::{
        Decoder,
        container::{extract_secondary_images, parse_mpf_segment},
    };

    fn fixture(
        width: u32,
        height: u32,
        hdr_linear: [f32; 3],
    ) -> (DynamicImage, DynamicImage, Vec<u8>) {
        let srgb = |x: f32| {
            if x <= 0.0031308 {
                x * 12.92
            } else {
                1.055 * x.powf(1.0 / 2.4) - 0.055
            }
        };
        let hdr = DynamicImage::ImageRgb32F(ImageBuffer::from_pixel(
            width,
            height,
            Rgb(hdr_linear.map(srgb)),
        ));
        let sdr = DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([128, 100, 80])));
        let mut bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 90);
        encoder
            .set_icc_profile(include_bytes!("../icc/sRGB-v2-magic.icc").to_vec())
            .unwrap();
        encoder.set_pixel_density(image::codecs::jpeg::PixelDensity::dpi(300));
        sdr.write_with_encoder(encoder).unwrap();
        (hdr, sdr, bytes)
    }

    #[test]
    fn sdr_fallback_and_metadata_offsets_survive_packaging() {
        let (hdr, sdr, base) = fixture(17, 9, [2.0, 1.0, 0.5]);
        let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="5"/></rdf:RDF></x:xmpmeta>"#;
        let mut annotated = base[..2].to_vec();
        annotated.extend(create_xmp_app1_marker(xmp));
        // Valid empty TIFF IFD inside an EXIF APP1 segment.
        let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\0\0\0\0\0\0";
        annotated.extend([0xff, 0xe1]);
        annotated.extend(((exif.len() + 2) as u16).to_be_bytes());
        annotated.extend(exif);
        annotated.extend_from_slice(&base[2..]);
        let output = encode(&hdr, &sdr, &annotated).unwrap();
        let decoder = Decoder::new(&output).unwrap();
        assert!(decoder.is_ultrahdr());
        assert_eq!(
            image::load_from_memory(&output).unwrap().to_rgb8(),
            image::load_from_memory(&base).unwrap().to_rgb8()
        );
        let segments = scan_segments(&output);
        assert_eq!(segments.iter().filter(|s| s.is_icc()).count(), 1);
        assert_eq!(segments.iter().filter(|s| s.is_xmp()).count(), 1);
        assert_eq!(segments.iter().find(|s| s.is_exif()).unwrap().data, exif);
        let packet = &segments.iter().find(|s| s.is_xmp()).unwrap().data;
        assert!(String::from_utf8_lossy(packet).contains("xmp:Rating=\"5\""));
        let mpf = segments.iter().find(|s| s.is_mpf()).unwrap();
        let directory = parse_mpf_segment(&mpf.data, mpf.offset).unwrap();
        let secondaries = extract_secondary_images(&output, &directory);
        assert_eq!(secondaries.len(), 1);
        assert_eq!(secondaries[0], decoder.gainmap_jpeg().unwrap());
        assert_eq!(
            directory.entries[0].size as usize,
            decoder.primary_jpeg().unwrap().len()
        );
        assert_eq!(
            image::load_from_memory(secondaries[0])
                .unwrap()
                .dimensions(),
            (5, 3)
        );
        assert!(
            segments
                .iter()
                .any(|s| s.data.starts_with(b"urn:iso:std:iso:ts:21496:-1\0"))
        );
        let secondary_segments = scan_segments(secondaries[0]);
        assert!(
            secondary_segments
                .iter()
                .any(|s| s.data.starts_with(b"urn:iso:std:iso:ts:21496:-1\0"))
        );
        let iso_header = b"urn:iso:std:iso:ts:21496:-1\0";
        let iso_segment = secondary_segments
            .iter()
            .find(|s| s.data.starts_with(iso_header))
            .unwrap();
        let iso_metadata = ultrahdr_rs::metadata::iso21496::parse_iso21496(
            &iso_segment.data[iso_header.len()..],
            ultrahdr_core::Iso21496Format::JpegApp2,
        )
        .unwrap();
        let xmp = secondary_segments.iter().find(|s| s.is_xmp()).unwrap();
        let (xmp_metadata, _) = ultrahdr_rs::metadata::xmp::parse_xmp(
            std::str::from_utf8(&xmp.data[XMP_HEADER.len()..]).unwrap(),
        )
        .unwrap();
        assert!((xmp_metadata.alternate_hdr_headroom.exp2() - HEADROOM as f64).abs() < 0.001);
        assert!(
            (iso_metadata.alternate_hdr_headroom - xmp_metadata.alternate_hdr_headroom).abs()
                < 0.00001
        );
        for c in 0..3 {
            assert!((iso_metadata.gain_map_min[c] - xmp_metadata.gain_map_min[c]).abs() < 0.00001);
            assert!((iso_metadata.gain_map_max[c] - xmp_metadata.gain_map_max[c]).abs() < 0.00001);
        }
    }

    #[test]
    fn decoded_gain_map_recovers_highlights_and_color() {
        // Include a channel darker than SDR, and gains which do not reach the peak.
        for target in [[2.0, 1.0, 0.04], [0.4, 0.25, 0.15], [HEADROOM; 3]] {
            let (hdr, sdr, base) = fixture(32, 32, target);
            let output = encode(&hdr, &sdr, &base).unwrap();
            let decoder = Decoder::new(&output).unwrap();
            let metadata = decoder.metadata().unwrap();
            let gain = image::load_from_memory(decoder.gainmap_jpeg().unwrap())
                .unwrap()
                .to_rgb8();
            let base = image::load_from_memory(&base).unwrap().to_rgb8();
            for c in 0..3 {
                let log_gain = metadata.gain_map_min[c]
                    + gain.get_pixel(0, 0)[c] as f64 / 255.0
                        * (metadata.gain_map_max[c] - metadata.gain_map_min[c]);
                let reconstructed = (linear(base.get_pixel(0, 0)[c] as f32 / 255.0) as f64
                    + metadata.base_offset[c])
                    * log_gain.exp2()
                    - metadata.alternate_offset[c];
                assert!(
                    (reconstructed - target[c] as f64).abs() < 0.06 * target[c] as f64 + 0.01,
                    "channel {c}: {reconstructed} != {}",
                    target[c]
                );
            }
        }
    }

    #[test]
    fn replaces_stale_hdr_metadata_with_alternate_namespace_prefixes() {
        let (hdr, sdr, base) = fixture(8, 8, [1.0; 3]);
        let old = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:h="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:c="http://ns.google.com/photos/1.0/container/" h:Version="stale"><c:Directory>old directory</c:Directory></r:Description></r:RDF></x:xmpmeta>"#;
        let mut annotated = base[..2].to_vec();
        annotated.extend(create_xmp_app1_marker(old));
        annotated.extend_from_slice(&base[2..]);
        let output = encode(&hdr, &sdr, &annotated).unwrap();
        let segments = scan_segments(&output);
        let xmp = &segments.iter().find(|s| s.is_xmp()).unwrap().data[XMP_HEADER.len()..];
        let packet = std::str::from_utf8(xmp).unwrap();
        assert!(!packet.contains("stale"));
        assert!(!packet.contains("old directory"));
        assert_eq!(packet.matches("<Container:Directory>").count(), 1);
        let mut reader = NsReader::from_str(packet);
        loop {
            let (ns, event) = reader.read_resolved_event().unwrap();
            assert!(!matches!(ns, ResolveResult::Unknown(_)));
            if matches!(event, Event::Eof) {
                break;
            }
        }
        assert!(Decoder::new(&output).unwrap().is_ultrahdr());
    }

    #[test]
    fn tiny_images_and_nonfinite_samples_are_safe() {
        let (mut hdr, sdr, base) = fixture(1, 1, [0.0; 3]);
        hdr.as_mut_rgb32f().unwrap().get_pixel_mut(0, 0).0 = [f32::NAN, f32::INFINITY, -1.0];
        let output = encode(&hdr, &sdr, &base).unwrap();
        assert!(Decoder::new(&output).unwrap().is_ultrahdr());
        assert!(encode(&hdr, &DynamicImage::new_rgb8(2, 1), &base).is_err());
    }
}
