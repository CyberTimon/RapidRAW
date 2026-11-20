use crate::render::geometry::apply_orientation;
use crate::render::hdr::{REFERENCE_WHITE_NITS, SDR_ROLLOFF_KNEE};
use image::{DynamicImage, ImageDecoder, ImageReader, Rgb32FImage};
use moxcms::{ColorProfile, ToneReprCurve, TransferCharacteristics};
use rawler::Orientation;
use std::io::Cursor;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};

const XMP_NAMESPACE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const ISO_NAMESPACE: &[u8] = b"urn:iso:std:iso:ts:21496:-1\0";
const MPF_SIGNATURE: &[u8] = b"MPF\0";
const APP1: u8 = 0xE1;
const APP2: u8 = 0xE2;
const START_OF_SCAN: u8 = 0xDA;
const MPF_ENTRIES: u16 = 0xB002;
const MPF_ENTRY_SIZE: usize = 16;
const PQ_PEAK_NITS: f32 = 10000.0;
const PQ_UNKNOWN_PEAK_NITS: f32 = 1000.0;
const HLG_PEAK_NITS: f32 = 1000.0;
const HLG_SYSTEM_GAMMA: f32 = 1.2;
const MAX_PEAK: f32 = 16.0;
const MAX_GAIN_LOG2: f32 = 16.0;
const JXL_CODESTREAM: &[u8] = &[0xFF, 0x0A];
const JXL_CONTAINER: &[u8] = b"\0\0\0\x0cJXL \r\n\x87\n";

static GAIN_MAPS_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_gain_maps_enabled(enabled: bool) {
    GAIN_MAPS_ENABLED.store(enabled, Ordering::Release);
}

pub fn gain_maps_enabled() -> bool {
    GAIN_MAPS_ENABLED.load(Ordering::Acquire)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GainMapParams {
    min_log2: [f32; 3],
    max_log2: [f32; 3],
    gamma: [f32; 3],
    offset_sdr: [f32; 3],
    offset_hdr: [f32; 3],
}

impl GainMapParams {
    pub fn from_channels(channels: [[f32; 5]; 3]) -> Option<Self> {
        let field = |index: usize| channels.map(|channel| channel[index]);
        Self {
            min_log2: field(0),
            max_log2: field(1),
            gamma: field(2),
            offset_sdr: field(3),
            offset_hdr: field(4),
        }
        .validated()
    }

    fn validated(self) -> Option<Self> {
        let fields = [
            self.min_log2,
            self.max_log2,
            self.gamma,
            self.offset_sdr,
            self.offset_hdr,
        ];
        let finite = fields.iter().flatten().all(|value| value.is_finite());
        let positive_gamma = self.gamma.iter().all(|gamma| *gamma > 0.0);
        let clamp_log2 = |values: [f32; 3]| values.map(|v| v.clamp(-MAX_GAIN_LOG2, MAX_GAIN_LOG2));
        (finite && positive_gamma).then(|| Self {
            min_log2: clamp_log2(self.min_log2),
            max_log2: clamp_log2(self.max_log2),
            ..self
        })
    }

    pub fn peak(&self) -> f32 {
        self.max_log2
            .into_iter()
            .fold(0.0, f32::max)
            .exp2()
            .max(1.0)
    }

    fn boost(&self, channel: usize, encoded: f32) -> f32 {
        let recovery = encoded.clamp(0.0, 1.0).powf(1.0 / self.gamma[channel]);
        let log2 =
            self.min_log2[channel] + (self.max_log2[channel] - self.min_log2[channel]) * recovery;
        log2.exp2()
    }
}

pub struct GainMap {
    params: GainMapParams,
    image: Rgb32FImage,
}

impl GainMap {
    pub fn new(params: GainMapParams, image: Rgb32FImage) -> Option<Self> {
        let (width, height) = image.dimensions();
        (width > 0 && height > 0).then_some(Self { params, image })
    }

    pub fn transformed(self, transform: impl Fn(DynamicImage) -> DynamicImage) -> Self {
        let image = transform(DynamicImage::ImageRgb32F(self.image)).to_rgb32f();
        Self { image, ..self }
    }

    pub fn oriented(self, orientation: Option<Orientation>) -> Self {
        let Some(orientation) = orientation else {
            return self;
        };
        let image =
            apply_orientation(DynamicImage::ImageRgb32F(self.image), orientation).to_rgb32f();
        Self { image, ..self }
    }

    pub fn row_applier(&self, width: u32, height: u32) -> impl Fn(u32, &mut [f32]) + Sync + '_ {
        let (map_width, map_height) = self.image.dimensions();
        let scale_x = map_width as f32 / width.max(1) as f32;
        let scale_y = map_height as f32 / height.max(1) as f32;
        let max_x = map_width.saturating_sub(1) as f32;
        let max_y = map_height.saturating_sub(1) as f32;
        move |y, row| {
            let map_y = ((y as f32 + 0.5) * scale_y - 0.5).clamp(0.0, max_y);
            let (y0, fy) = (map_y.floor() as u32, map_y.fract());
            let y1 = (y0 + 1).min(map_height - 1);
            for (x, rgb) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let map_x = ((x as f32 + 0.5) * scale_x - 0.5).clamp(0.0, max_x);
                let (x0, fx) = (map_x.floor() as u32, map_x.fract());
                let x1 = (x0 + 1).min(map_width - 1);
                let [a, b, c, d] = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
                    .map(|(sx, sy)| self.image.get_pixel(sx, sy).0);
                for channel in 0..3 {
                    let top = a[channel] + (b[channel] - a[channel]) * fx;
                    let bottom = c[channel] + (d[channel] - c[channel]) * fx;
                    let encoded = top + (bottom - top) * fy;
                    rgb[channel] = (rgb[channel] + self.params.offset_sdr[channel])
                        * self.params.boost(channel, encoded)
                        - self.params.offset_hdr[channel];
                }
            }
        }
    }
}

fn app_segments(jpeg: &[u8]) -> Vec<(u8, Range<usize>)> {
    let mut segments = Vec::new();
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return segments;
    }
    let mut position = 2;
    while let (Some(&0xFF), Some(&marker)) = (jpeg.get(position), jpeg.get(position + 1)) {
        if marker == START_OF_SCAN {
            break;
        }
        let Some(length) = jpeg
            .get(position + 2..position + 4)
            .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]) as usize)
        else {
            break;
        };
        let end = position + 2 + length;
        if length < 2 || end > jpeg.len() {
            break;
        }
        segments.push((marker, position + 4..end));
        position = end;
    }
    segments
}

fn segment_payload<'a>(jpeg: &'a [u8], marker: u8, namespace: &[u8]) -> Option<&'a [u8]> {
    app_segments(jpeg)
        .into_iter()
        .find(|(m, range)| *m == marker && jpeg[range.clone()].starts_with(namespace))
        .map(|(_, range)| &jpeg[range.start + namespace.len()..range.end])
}

fn mpf_secondary_image(jpeg: &[u8]) -> Option<Range<usize>> {
    let (_, range) = app_segments(jpeg)
        .into_iter()
        .find(|(m, range)| *m == APP2 && jpeg[range.clone()].starts_with(MPF_SIGNATURE))?;
    let tiff_start = range.start + MPF_SIGNATURE.len();
    let tiff = jpeg.get(tiff_start..range.end)?;
    let big_endian = match tiff.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |offset: usize| {
        let bytes: [u8; 2] = tiff.get(offset..offset + 2)?.try_into().ok()?;
        Some(if big_endian {
            u16::from_be_bytes(bytes)
        } else {
            u16::from_le_bytes(bytes)
        })
    };
    let u32_at = |offset: usize| {
        let bytes: [u8; 4] = tiff.get(offset..offset + 4)?.try_into().ok()?;
        Some(if big_endian {
            u32::from_be_bytes(bytes)
        } else {
            u32::from_le_bytes(bytes)
        })
    };
    let ifd = u32_at(4)? as usize;
    let entries_offset = (0..u16_at(ifd)? as usize).find_map(|index| {
        let entry = ifd + 2 + index * 12;
        (u16_at(entry)? == MPF_ENTRIES)
            .then(|| u32_at(entry + 8))
            .flatten()
    })? as usize;
    let secondary = entries_offset + MPF_ENTRY_SIZE;
    let size = u32_at(secondary + 4)? as usize;
    let offset = u32_at(secondary + 8)? as usize;
    let start = tiff_start + offset;
    (offset > 0 && size > 0 && start + size <= jpeg.len()).then_some(start..start + size)
}

fn xml_number_list(xmp: &str, name: &str) -> Option<Vec<f32>> {
    for quote in ['"', '\''] {
        let attribute = format!("hdrgm:{}={}", name, quote);
        if let Some(start) = xmp.find(&attribute) {
            let rest = &xmp[start + attribute.len()..];
            return rest[..rest.find(quote)?]
                .trim()
                .parse()
                .ok()
                .map(|v| vec![v]);
        }
    }
    let open = format!("<hdrgm:{}>", name);
    let close = format!("</hdrgm:{}>", name);
    let start = xmp.find(&open)? + open.len();
    let body = &xmp[start..start + xmp[start..].find(&close)?];
    let values: Vec<f32> = body
        .split("<rdf:li>")
        .skip(1)
        .filter_map(|item| item.split("</rdf:li>").next()?.trim().parse().ok())
        .collect();
    (!values.is_empty()).then_some(values)
}

fn per_channel(values: Option<Vec<f32>>, default: f32) -> Option<[f32; 3]> {
    match values.as_deref() {
        None => Some([default; 3]),
        Some([value]) => Some([*value; 3]),
        Some([r, g, b]) => Some([*r, *g, *b]),
        Some(_) => None,
    }
}

fn params_from_xmp(xmp: &str) -> Option<GainMapParams> {
    if !xmp.contains("hdrgm:GainMapMax") {
        return None;
    }
    let base_is_hdr = xmp.contains("hdrgm:BaseRenditionIsHDR=\"True\"")
        || xmp.contains("hdrgm:BaseRenditionIsHDR='True'");
    let read = |name: &str, default: f32| per_channel(xml_number_list(xmp, name), default);
    let params = GainMapParams {
        min_log2: read("GainMapMin", 0.0)?,
        max_log2: read("GainMapMax", 1.0)?,
        gamma: read("Gamma", 1.0)?,
        offset_sdr: read("OffsetSDR", 1.0 / 64.0)?,
        offset_hdr: read("OffsetHDR", 1.0 / 64.0)?,
    };
    (!base_is_hdr).then_some(params)?.validated()
}

fn params_from_iso(metadata: &[u8]) -> Option<GainMapParams> {
    let mut position = 4;
    let flags = *metadata.get(position)?;
    position += 1;
    if flags & 0x04 != 0 {
        return None;
    }
    let channels = if flags & 0x80 != 0 { 3 } else { 1 };
    let mut next_u32 = || {
        let bytes: [u8; 4] = metadata.get(position..position + 4)?.try_into().ok()?;
        position += 4;
        Some(u32::from_be_bytes(bytes))
    };
    let mut values = Vec::with_capacity(channels * 5);
    if flags & 0x08 != 0 {
        let denominator = next_u32()?.max(1) as f32;
        next_u32()?;
        next_u32()?;
        for _ in 0..channels * 5 {
            values.push(next_u32()? as i32 as f32 / denominator);
        }
    } else {
        for _ in 0..4 {
            next_u32()?;
        }
        for _ in 0..channels * 5 {
            let numerator = next_u32()? as i32 as f32;
            values.push(numerator / next_u32()?.max(1) as f32);
        }
    }
    let channel = |field: usize| {
        let at = |c: usize| values[(if channels == 3 { c } else { 0 }) * 5 + field];
        [at(0), at(1), at(2)]
    };
    GainMapParams {
        min_log2: channel(0),
        max_log2: channel(1),
        gamma: channel(2),
        offset_sdr: channel(3),
        offset_hdr: channel(4),
    }
    .validated()
}

fn gain_map_params(gain_map_jpeg: &[u8]) -> Option<GainMapParams> {
    segment_payload(gain_map_jpeg, APP1, XMP_NAMESPACE)
        .and_then(|xmp| params_from_xmp(&String::from_utf8_lossy(xmp)))
        .or_else(|| segment_payload(gain_map_jpeg, APP2, ISO_NAMESPACE).and_then(params_from_iso))
}

fn gain_map_jpeg(jpeg: &[u8]) -> Option<&[u8]> {
    jpeg.get(mpf_secondary_image(jpeg)?)
}

pub fn has_gain_map(bytes: &[u8]) -> bool {
    if crate::decode::avif::is_avif(bytes) {
        return crate::decode::avif::has_gain_map(bytes);
    }
    bytes.starts_with(&[0xFF, 0xD8]) && gain_map_peak(bytes).is_some()
}

pub fn gain_map_peak(jpeg: &[u8]) -> Option<f32> {
    gain_map_params(gain_map_jpeg(jpeg)?).map(|params| params.peak())
}

pub fn read_gain_map(jpeg: &[u8], base_size: (u32, u32)) -> Option<GainMap> {
    let gain_map_jpeg = gain_map_jpeg(jpeg)?;
    let params = gain_map_params(gain_map_jpeg)?;
    let (width, height) =
        ImageReader::with_format(Cursor::new(gain_map_jpeg), image::ImageFormat::Jpeg)
            .into_dimensions()
            .ok()?;
    if width == 0 || height == 0 || width > base_size.0 || height > base_size.1 {
        log::warn!(
            "Ignoring a gain map of {}x{} for a {}x{} image",
            width,
            height,
            base_size.0,
            base_size.1
        );
        return None;
    }
    let image = image::load_from_memory_with_format(gain_map_jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| log::warn!("Could not decode the gain map: {}", e))
        .ok()?
        .to_rgb32f();
    Some(GainMap { params, image })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HdrTransfer {
    Pq,
    Hlg,
}

impl HdrTransfer {
    pub fn default_peak(self) -> f32 {
        match self {
            Self::Pq => PQ_UNKNOWN_PEAK_NITS / REFERENCE_WHITE_NITS,
            Self::Hlg => HLG_PEAK_NITS / REFERENCE_WHITE_NITS,
        }
    }

    pub fn to_relative(self, rgb: [f32; 3]) -> [f32; 3] {
        match self {
            Self::Pq => rgb.map(pq_to_relative),
            Self::Hlg => hlg_to_relative(rgb),
        }
    }
}

fn jxl_hdr_peak(jxl: &[u8]) -> Option<f32> {
    use jxl::api::{
        Event, JxlColorEncoding, JxlColorProfile, JxlDecoder, JxlDecoderOptions,
        JxlTransferFunction,
    };
    let mut input = std::io::BufReader::new(Cursor::new(jxl));
    let mut decoder = JxlDecoder::new(JxlDecoderOptions::default());
    if decoder.process(&mut input, None, None).ok()? != Event::BasicInfo {
        return None;
    }
    let target = decoder.basic_info()?.tone_mapping.intensity_target;
    let transfer = match decoder.embedded_color_profile()? {
        JxlColorProfile::Simple(JxlColorEncoding::RgbColorSpace {
            transfer_function, ..
        }) => match transfer_function {
            JxlTransferFunction::PQ => Some(HdrTransfer::Pq),
            JxlTransferFunction::HLG => Some(HdrTransfer::Hlg),
            _ => None,
        },
        JxlColorProfile::Icc(icc) => ColorProfile::new_from_slice(icc)
            .ok()
            .as_ref()
            .and_then(hdr_transfer),
        _ => None,
    }?;
    Some(match transfer {
        HdrTransfer::Pq if target > 0.0 => target / REFERENCE_WHITE_NITS,
        transfer => transfer.default_peak(),
    })
}

fn hlg_to_relative(rgb: [f32; 3]) -> [f32; 3] {
    const A: f32 = 0.178_832_77;
    const B: f32 = 0.284_668_92;
    const C: f32 = 0.559_910_7;
    let inverse_oetf = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.5 {
            v * v / 3.0
        } else {
            (((v - C) / A).exp() + B) / 12.0
        }
    };
    let scene = rgb.map(inverse_oetf);
    let luminance = 0.2627 * scene[0] + 0.6780 * scene[1] + 0.0593 * scene[2];
    let gain = HLG_PEAK_NITS * luminance.max(1e-6).powf(HLG_SYSTEM_GAMMA - 1.0);
    scene.map(|c| c * gain / REFERENCE_WHITE_NITS)
}

pub fn pq_to_relative(encoded: f32) -> f32 {
    const M1: f32 = 2610.0 / 16384.0;
    const M2: f32 = 2523.0 / 4096.0 * 128.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = 2413.0 / 4096.0 * 32.0;
    const C3: f32 = 2392.0 / 4096.0 * 32.0;
    let power = encoded.clamp(0.0, 1.0).powf(1.0 / M2);
    let linear = ((power - C1).max(0.0) / (C2 - C3 * power)).powf(1.0 / M1);
    linear * PQ_PEAK_NITS / REFERENCE_WHITE_NITS
}

pub fn hdr_transfer(profile: &ColorProfile) -> Option<HdrTransfer> {
    match profile.cicp.as_ref()?.transfer_characteristics {
        TransferCharacteristics::Smpte2084 => Some(HdrTransfer::Pq),
        TransferCharacteristics::Hlg => Some(HdrTransfer::Hlg),
        _ => None,
    }
}

pub fn has_linear_trc(profile: &ColorProfile) -> bool {
    match &profile.red_trc {
        Some(ToneReprCurve::Lut(lut)) => lut.is_empty() || lut.as_slice() == [256],
        Some(ToneReprCurve::Parametric(parameters)) => {
            parameters.len() == 1 && (parameters[0] - 1.0).abs() < 1e-3
        }
        None => false,
    }
}

pub fn is_linear_float(color: image::ColorType, profile: Option<&ColorProfile>) -> bool {
    matches!(color, image::ColorType::Rgb32F | image::ColorType::Rgba32F)
        && profile.is_none_or(|profile| profile.is_matrix_shaper() && has_linear_trc(profile))
}

pub fn linear_peak(rgb: &[f32]) -> f32 {
    use rayon::prelude::*;
    rgb.par_iter()
        .copied()
        .filter(|value| value.is_finite())
        .reduce(|| 1.0, f32::max)
        .clamp(1.0, MAX_PEAK)
}

fn embedded_hdr_peak(bytes: &[u8]) -> Option<f32> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let profile = decoder
        .icc_profile()
        .ok()
        .flatten()
        .and_then(|icc| ColorProfile::new_from_slice(&icc).ok());
    profile
        .as_ref()
        .and_then(hdr_transfer)
        .map(HdrTransfer::default_peak)
}

pub fn source_peak(bytes: &[u8]) -> f32 {
    let peak = if bytes.starts_with(&[0xFF, 0xD8]) {
        gain_maps_enabled().then(|| gain_map_peak(bytes)).flatten()
    } else if bytes.starts_with(JXL_CODESTREAM) || bytes.starts_with(JXL_CONTAINER) {
        jxl_hdr_peak(bytes)
    } else if crate::decode::avif::is_avif(bytes) {
        crate::decode::avif::hdr_peak(bytes, gain_maps_enabled())
    } else {
        embedded_hdr_peak(bytes)
    };
    peak.unwrap_or(1.0).clamp(1.0, MAX_PEAK)
}

pub fn roll_off_encoded(image: &mut DynamicImage, peak: f32) {
    if peak <= 1.0 {
        return;
    }
    let transfer = crate::render::color_space::srgb_transfer();
    let roll_off = |pixel: &mut [f32]| {
        let linear = [pixel[0], pixel[1], pixel[2]].map(|c| transfer.decode(c));
        let rolled = sdr_rolloff(linear, peak).map(|c| transfer.encode(c));
        pixel[..3].copy_from_slice(&rolled);
    };
    use rayon::prelude::*;
    match image {
        DynamicImage::ImageRgb32F(buffer) => buffer.par_chunks_exact_mut(3).for_each(roll_off),
        DynamicImage::ImageRgba32F(buffer) => buffer.par_chunks_exact_mut(4).for_each(roll_off),
        _ => {}
    }
}

pub fn sdr_rolloff(rgb: [f32; 3], peak: f32) -> [f32; 3] {
    const KNEE: f32 = SDR_ROLLOFF_KNEE;
    let brightest = rgb[0].max(rgb[1]).max(rgb[2]);
    if peak <= 1.0 || brightest <= KNEE {
        return rgb.map(|c| c.min(1.0));
    }
    let span = 1.0 - KNEE;
    let t = (brightest - KNEE) / span;
    let t_peak = ((peak - KNEE) / span).max(1.0);
    let mapped = (KNEE + span * t * (1.0 + t / (t_peak * t_peak)) / (1.0 + t)).min(1.0);
    rgb.map(|c| c * mapped / brightest)
}
