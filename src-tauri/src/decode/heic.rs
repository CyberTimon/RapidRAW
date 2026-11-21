use crate::decode::avif::{ContainerColor, gain_map_params, has_ftyp_brand, is_avif};
use crate::decode::hdr_source::{GainMap, GainMapParams, HdrTransfer};
use crate::render::color_space::srgb_decode;
use crate::render::hdr::REFERENCE_WHITE_NITS;
use anyhow::{Result, anyhow};
use image::Rgb32FImage;
use zenavif::{ColorPrimaries, GainMapMetadata};

const HEIF_BRANDS: [&[u8; 4]; 8] = [
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1",
];
const APPLE_GAIN_MAP: &[u8] = b"urn:com:apple:photo:2020:aux:hdrgainmap";

pub struct HeifImage {
    pub rgb: Rgb32FImage,
    pub color: ContainerColor,
}

#[derive(Default)]
struct Container {
    icc: Option<Vec<u8>>,
    nclx: Option<(ColorPrimaries, Option<HdrTransfer>)>,
    max_content_light: Option<u16>,
    apple_gain_map: Option<u16>,
    iso_gain_map: Option<(GainMapMetadata, u16)>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    nclx_offsets: Vec<usize>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    bit_depth: u8,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pitm_offset: Option<usize>,
}

impl Container {
    fn add_primary(&mut self, kind: &[u8; 4], payload: &[u8]) {
        match (kind, payload.split_first_chunk::<4>()) {
            (b"colr", Some((b"nclx", data))) if data.len() >= 4 => {
                let primaries = u16::from_be_bytes([data[0], data[1]]);
                let transfer = match u16::from_be_bytes([data[2], data[3]]) {
                    16 => Some(HdrTransfer::Pq),
                    18 => Some(HdrTransfer::Hlg),
                    _ => None,
                };
                self.nclx = Some((
                    ColorPrimaries(u8::try_from(primaries).unwrap_or(2)),
                    transfer,
                ));
            }
            (b"colr", Some((b"prof" | b"rICC", icc))) if !icc.is_empty() => {
                self.icc = Some(icc.to_vec());
            }
            (b"pixi", _) => {
                if let Some((&channels, depths)) = payload.get(4..).and_then(<[u8]>::split_first) {
                    self.bit_depth = depths
                        .iter()
                        .take(usize::from(channels))
                        .copied()
                        .max()
                        .unwrap_or(self.bit_depth);
                }
            }
            (b"clli", _) => {
                self.max_content_light = payload
                    .first_chunk::<2>()
                    .map(|level| u16::from_be_bytes(*level));
            }
            _ => {}
        }
    }

    fn transfer(&self) -> Option<HdrTransfer> {
        self.nclx.and_then(|(_, transfer)| transfer)
    }

    fn color(&self) -> ContainerColor {
        let transfer = self.transfer();
        match (&self.icc, self.nclx) {
            (Some(icc), _) => ContainerColor::Icc {
                icc: icc.clone(),
                transfer,
            },
            (None, Some((primaries, transfer))) => ContainerColor::Cicp {
                primaries,
                transfer,
            },
            (None, None) => ContainerColor::Cicp {
                primaries: ColorPrimaries::BT709,
                transfer: None,
            },
        }
    }
}

pub fn is_heif(bytes: &[u8]) -> bool {
    has_ftyp_brand(bytes, &HEIF_BRANDS) && !is_avif(bytes)
}

fn boxes(mut data: &[u8]) -> impl Iterator<Item = (&[u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        let (size, rest) = data.split_first_chunk::<4>()?;
        let (kind, rest) = rest.split_first_chunk::<4>()?;
        let (header, size) = match u32::from_be_bytes(*size) {
            0 => (8, data.len()),
            1 => (
                16,
                usize::try_from(u64::from_be_bytes(*rest.first_chunk::<8>()?)).ok()?,
            ),
            size => (8, size as usize),
        };
        let payload = data.get(header..size)?;
        data = &data[size..];
        Some((kind, payload))
    })
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data)
        .find(|(found, _)| *found == kind)
        .map(|(_, payload)| payload)
}

fn take<const N: usize>(data: &mut &[u8]) -> Option<[u8; N]> {
    let (head, rest) = data.split_first_chunk::<N>()?;
    *data = rest;
    Some(*head)
}

fn take_id(data: &mut &[u8], wide: bool) -> Option<u32> {
    if wide {
        take::<4>(data).map(u32::from_be_bytes)
    } else {
        take::<2>(data).map(|id| u16::from_be_bytes(id).into())
    }
}

fn full_box(payload: &[u8]) -> Option<(u8, u8, &[u8])> {
    let (header, data) = payload.split_first_chunk::<4>()?;
    Some((header[0], header[3], data))
}

fn take_sized(data: &mut &[u8], size: u8) -> Option<usize> {
    match size {
        0 => Some(0),
        4 => take::<4>(data).map(|value| u32::from_be_bytes(value) as usize),
        8 => take::<8>(data).and_then(|value| usize::try_from(u64::from_be_bytes(value)).ok()),
        _ => None,
    }
}

fn item_of_type(meta: &[u8], kind: &[u8; 4]) -> Option<u32> {
    let (version, _, mut data) = full_box(child(meta, b"iinf")?)?;
    if version == 0 {
        take::<2>(&mut data)?;
    } else {
        take::<4>(&mut data)?;
    }
    boxes(data)
        .filter(|(found, _)| *found == b"infe")
        .find_map(|(_, infe)| {
            let (version, _, mut data) = full_box(infe)?;
            if version < 2 {
                return None;
            }
            let id = take_id(&mut data, version >= 3)?;
            take::<2>(&mut data)?;
            (take::<4>(&mut data)? == *kind).then_some(id)
        })
}

fn references(meta: &[u8], kind: &[u8; 4], from: u32) -> Option<Vec<u32>> {
    let (version, _, data) = full_box(child(meta, b"iref")?)?;
    boxes(data)
        .filter(|(found, _)| *found == kind)
        .find_map(|(_, mut data)| {
            (take_id(&mut data, version != 0)? == from).then_some(())?;
            let count = u16::from_be_bytes(take::<2>(&mut data)?);
            (0..count)
                .map(|_| take_id(&mut data, version != 0))
                .collect()
        })
}

fn item_data(bytes: &[u8], meta: &[u8], item: u32) -> Option<Vec<u8>> {
    let (version, _, mut data) = full_box(child(meta, b"iloc")?)?;
    let [sizes, more] = take::<2>(&mut data)?;
    let index_size = if version == 0 { 0 } else { more & 15 };
    let count = take_id(&mut data, version >= 2)?;
    for _ in 0..count {
        let id = take_id(&mut data, version >= 2)?;
        let method = if version == 0 {
            0
        } else {
            u16::from_be_bytes(take::<2>(&mut data)?) & 15
        };
        take::<2>(&mut data)?;
        let base = take_sized(&mut data, more >> 4)?;
        let extents = u16::from_be_bytes(take::<2>(&mut data)?);
        let mut item_bytes = Vec::new();
        for _ in 0..extents {
            take_sized(&mut data, index_size)?;
            let offset = base + take_sized(&mut data, sizes >> 4)?;
            let length = take_sized(&mut data, sizes & 15)?;
            if id == item {
                let source = match method {
                    0 => bytes,
                    1 => child(meta, b"idat")?,
                    _ => return None,
                };
                item_bytes.extend_from_slice(source.get(offset..offset.checked_add(length)?)?);
            }
        }
        if id == item {
            return Some(item_bytes);
        }
    }
    None
}

fn read_iso_gain_map(bytes: &[u8], meta: &[u8], primary: u32) -> Option<(GainMapMetadata, u16)> {
    let tone_map = item_of_type(meta, b"tmap")?;
    let [base, gain_map] = references(meta, b"dimg", tone_map)?[..] else {
        return None;
    };
    (base == primary).then_some(())?;
    let metadata = GainMapMetadata::parse_tmap_bytes(&item_data(bytes, meta, tone_map)?).ok()?;
    Some((metadata, u16::try_from(gain_map).ok()?))
}

fn offset_in(bytes: &[u8], part: &[u8]) -> usize {
    part.as_ptr() as usize - bytes.as_ptr() as usize
}

fn read_container(bytes: &[u8]) -> Option<Container> {
    let (_, _, meta) = full_box(child(bytes, b"meta")?)?;
    let (version, _, mut pitm) = full_box(child(meta, b"pitm")?)?;
    let mut container = Container {
        pitm_offset: (version == 0).then(|| offset_in(bytes, pitm)),
        ..Container::default()
    };
    let primary = take_id(&mut pitm, version != 0)?;
    let iprp = child(meta, b"iprp")?;
    let ipco: Vec<_> = boxes(child(iprp, b"ipco")?).collect();

    let mut any_color = Container::default();
    for (kind, payload) in &ipco {
        match *kind {
            b"colr" => {
                if payload.starts_with(b"nclx") {
                    container.nclx_offsets.push(offset_in(bytes, payload) + 4);
                }
                if any_color.icc.is_none() && any_color.nclx.is_none() {
                    any_color.add_primary(kind, payload);
                }
            }
            b"hvcC" => {
                let depth = payload.get(17).map_or(0, |depth| (depth & 7) + 8);
                container.bit_depth = container.bit_depth.max(depth);
            }
            _ => {}
        }
    }

    for (_, ipma) in boxes(iprp).filter(|(kind, _)| *kind == b"ipma") {
        let (version, flags, mut data) = full_box(ipma)?;
        let entries = u32::from_be_bytes(take::<4>(&mut data)?);
        for _ in 0..entries {
            let item = take_id(&mut data, version != 0)?;
            let [associations] = take::<1>(&mut data)?;
            for _ in 0..associations {
                let index = if flags & 1 != 0 {
                    usize::from(u16::from_be_bytes(take::<2>(&mut data)?) & 0x7fff)
                } else {
                    usize::from(take::<1>(&mut data)?[0] & 0x7f)
                };
                let Some((kind, payload)) = index.checked_sub(1).and_then(|i| ipco.get(i)) else {
                    continue;
                };
                if item == primary {
                    container.add_primary(kind, payload);
                } else if *kind == b"auxC"
                    && full_box(payload).is_some_and(|(_, _, urn)| urn.starts_with(APPLE_GAIN_MAP))
                {
                    container.apple_gain_map = u16::try_from(item).ok();
                }
            }
        }
    }
    if container.icc.is_none() && container.nclx.is_none() {
        container.icc = any_color.icc;
        container.nclx = any_color.nclx;
    }
    container.iso_gain_map = read_iso_gain_map(bytes, meta, primary);
    Some(container)
}

fn apple_maker_note_value(note: &[u8], tag: u16) -> Option<f32> {
    let ifd = note.strip_prefix(b"Apple iOS\0")?.get(4..)?;
    let u16_at = |at: usize| {
        note.get(at..at + 2)
            .map(|v| u16::from_be_bytes([v[0], v[1]]))
    };
    let u32_at = |at: usize| {
        note.get(at..at + 4)
            .map(|v| u32::from_be_bytes([v[0], v[1], v[2], v[3]]))
    };
    let start = note.len() - ifd.len();
    let count = usize::from(u16_at(start)?);
    let entry = (0..count)
        .map(|i| start + 2 + i * 12)
        .find(|entry| u16_at(*entry) == Some(tag))?;
    let value = entry + 8;
    match u16_at(entry + 2)? {
        5 | 10 => {
            let offset = u32_at(value)? as usize;
            let (numerator, denominator) = (u32_at(offset)?, u32_at(offset + 4)?);
            Some(numerator as i32 as f32 / (denominator as i32 as f32).max(1.0))
        }
        11 => Some(f32::from_bits(u32_at(value)?)),
        4 | 9 => Some(u32_at(value)? as i32 as f32),
        3 => Some(f32::from(u16_at(value)?)),
        _ => None,
    }
}

fn apple_headroom(bytes: &[u8]) -> Option<f32> {
    let exif = crate::metadata::exif_processing::read_exif(bytes)?;
    let field = exif.get_field(exif::Tag::MakerNote, exif::In::PRIMARY)?;
    let exif::Value::Undefined(note, _) = &field.value else {
        return None;
    };
    let headroom = apple_maker_note_value(note, 0x21)?;
    let gain = apple_maker_note_value(note, 0x30)?;
    let stops = match (headroom < 1.0, gain <= 0.01) {
        (true, true) => -20.0 * gain + 1.8,
        (true, false) => -0.101 * gain + 1.601,
        (false, true) => -70.0 * gain + 3.0,
        (false, false) => -0.303 * gain + 2.303,
    };
    Some(stops.max(0.0).exp2()).filter(|headroom| *headroom > 1.0)
}

pub fn has_gain_map(bytes: &[u8]) -> bool {
    read_container(bytes).is_some_and(|container| match &container.iso_gain_map {
        Some((metadata, _)) => gain_map_params(metadata).is_some(),
        None => container.apple_gain_map.is_some() && apple_headroom(bytes).is_some(),
    })
}

pub fn hdr_peak(bytes: &[u8]) -> Option<f32> {
    let container = read_container(bytes)?;
    match container.transfer()? {
        HdrTransfer::Pq => Some(
            container
                .max_content_light
                .filter(|nits| *nits > 0)
                .map_or_else(
                    || HdrTransfer::Pq.default_peak(),
                    |nits| f32::from(nits) / REFERENCE_WHITE_NITS,
                ),
        ),
        transfer => Some(transfer.default_peak()),
    }
}

fn decode_gain_map(bytes: &[u8], container: &Container, item: u16) -> Option<Rgb32FImage> {
    decode_gain_map_pixels(bytes, container, item)
        .map_err(|e| log::warn!("Could not decode the HEIC gain map: {}", e))
        .ok()
}

pub fn gain_map(bytes: &[u8]) -> Option<(GainMap, ContainerColor)> {
    let container = read_container(bytes)?;
    if container.transfer().is_some() {
        return None;
    }
    let gain_map = if let Some((metadata, item)) = &container.iso_gain_map {
        GainMap::new(
            gain_map_params(metadata)?,
            decode_gain_map(bytes, &container, *item)?,
        )
    } else {
        apple_gain_map(bytes, &container)
    }?;
    Some((gain_map, container.color()))
}

fn apple_gain_map(bytes: &[u8], container: &Container) -> Option<GainMap> {
    let item = container.apple_gain_map?;
    let headroom = apple_headroom(bytes)?;
    let map = decode_gain_map(bytes, container, item)?;
    let max_log2 = headroom.log2();
    let encoded = map
        .pixels()
        .flat_map(|pixel| {
            let gain = srgb_decode(pixel.0[0].clamp(0.0, 1.0));
            [(1.0 + (headroom - 1.0) * gain).log2() / max_log2; 3]
        })
        .collect();
    GainMap::new(
        GainMapParams::from_channels([[0.0, max_log2, 1.0, 0.0, 0.0]; 3], Some([0.0, max_log2]))?,
        Rgb32FImage::from_raw(map.width(), map.height(), encoded)?,
    )
}

pub fn decode(bytes: &[u8]) -> Result<HeifImage> {
    let container = read_container(bytes).unwrap_or_default();
    let rgb = decode_pixels(bytes, &container)?;
    Ok(HeifImage {
        rgb,
        color: container.color(),
    })
}

#[cfg(target_os = "windows")]
fn wic_decode(bytes: &[u8], pq_tagged: bool) -> Result<Rgb32FImage> {
    use crate::decode::hdr_source::pq_from_nits;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat48bppRGB, GUID_WICPixelFormat128bppRGBAFloat,
        IWICImagingFactory, IWICPixelFormatInfo2, WICBitmapDitherTypeNone,
        WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
        WICPixelFormatNumericRepresentationFloat,
    };
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::core::Interface;

    const SCRGB_WHITE_NITS: f32 = 80.0;

    let decode = || -> windows::core::Result<(u32, u32, Vec<f32>)> {
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromMemory(bytes)?;
            let decoder = factory.CreateDecoderFromStream(
                &stream,
                std::ptr::null(),
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = decoder.GetFrame(0)?;
            let (mut width, mut height) = (0, 0);
            frame.GetSize(&mut width, &mut height)?;
            let pq = pq_tagged
                && factory
                    .CreateComponentInfo(&frame.GetPixelFormat()?)?
                    .cast::<IWICPixelFormatInfo2>()?
                    .GetNumericRepresentation()?
                    == WICPixelFormatNumericRepresentationFloat;
            let (format, stride) = if pq {
                (GUID_WICPixelFormat128bppRGBAFloat, width * 16)
            } else {
                (GUID_WICPixelFormat48bppRGB, width * 6)
            };
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &frame,
                &format,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let mut pixels = vec![0u8; stride as usize * height as usize];
            converter.CopyPixels(std::ptr::null(), stride, &mut pixels)?;
            let data = if pq {
                pixels
                    .as_chunks::<16>()
                    .0
                    .iter()
                    .flat_map(|pixel| {
                        let (rgba, _) = pixel.as_chunks::<4>();
                        [0, 1, 2]
                            .map(|i| pq_from_nits(f32::from_le_bytes(rgba[i]) * SCRGB_WHITE_NITS))
                    })
                    .collect()
            } else {
                pixels
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|sample| f32::from(u16::from_le_bytes(*sample)) / 65535.0)
                    .collect()
            };
            Ok((width, height, data))
        }
    };

    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let decoded = decode();
    if initialized {
        unsafe { CoUninitialize() };
    }
    let (width, height, data) = decoded.map_err(|e| {
        anyhow!(
            "Windows could not decode this HEIC file ({}). Install the HEIF Image Extensions and HEVC Video Extensions from the Microsoft Store.",
            e
        )
    })?;
    Rgb32FImage::from_raw(width, height, data).ok_or_else(|| anyhow!("Invalid HEIC image size"))
}

#[cfg(target_os = "windows")]
fn decode_pixels(bytes: &[u8], container: &Container) -> Result<Rgb32FImage> {
    let retag = !container.nclx_offsets.is_empty()
        && (container.bit_depth > 8 || container.transfer().is_some());
    if !retag {
        return wic_decode(bytes, false);
    }
    let mut tagged = bytes.to_vec();
    for offset in &container.nclx_offsets {
        tagged[*offset..*offset + 4].copy_from_slice(&[0, 1, 0, 16]);
    }
    wic_decode(&tagged, true)
}

#[cfg(target_os = "windows")]
fn decode_gain_map_pixels(bytes: &[u8], container: &Container, item: u16) -> Result<Rgb32FImage> {
    let offset = container
        .pitm_offset
        .ok_or_else(|| anyhow!("Unsupported primary item box"))?;
    let mut gain_map = bytes.to_vec();
    gain_map[offset..offset + 2].copy_from_slice(&item.to_be_bytes());
    wic_decode(&gain_map, false)
}

#[cfg(target_os = "macos")]
fn core_image_decode(bytes: &[u8], gain_map: bool) -> Result<Rgb32FImage> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_core_image::{
        CIContext, CIContextOption, CIImage, CIImageOption, kCIContextOutputColorSpace,
        kCIContextWorkingColorSpace, kCIFormatRGBAf, kCIImageApplyOrientationProperty,
        kCIImageAuxiliaryHDRGainMap, kCIImageColorSpace,
    };
    use objc2_foundation::{NSData, NSDictionary, NSNull, NSNumber};
    use std::ptr::NonNull;

    autoreleasepool(|_| unsafe {
        let null = NSNull::null();
        let null: &AnyObject = &null;
        let yes = NSNumber::new_bool(true);
        let yes: &AnyObject = &yes;
        let mut image_keys: Vec<&CIImageOption> =
            vec![kCIImageColorSpace, kCIImageApplyOrientationProperty];
        let mut image_values = vec![null, yes];
        if gain_map {
            image_keys.push(kCIImageAuxiliaryHDRGainMap);
            image_values.push(yes);
        }
        let image_options = NSDictionary::from_slices(&image_keys, &image_values);
        let image =
            CIImage::imageWithData_options(&NSData::with_bytes(bytes), Some(&image_options))
                .ok_or_else(|| anyhow!("macOS could not decode this HEIC file"))?;
        let extent = image.extent();
        let width = extent.size.width.round() as usize;
        let height = extent.size.height.round() as usize;
        if width == 0 || height == 0 {
            return Err(anyhow!("HEIC image has an empty extent"));
        }
        let context_keys: [&CIContextOption; 2] =
            [kCIContextWorkingColorSpace, kCIContextOutputColorSpace];
        let context_options = NSDictionary::from_slices(&context_keys, &[null, null]);
        let context = CIContext::contextWithOptions(Some(&context_options));
        let mut rgba = vec![0f32; width * height * 4];
        context.render_toBitmap_rowBytes_bounds_format_colorSpace(
            &image,
            NonNull::from(rgba.as_mut_slice()).cast(),
            (width * 4 * size_of::<f32>()) as isize,
            extent,
            kCIFormatRGBAf,
            None,
        );
        let data = rgba
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|[r, g, b, _]| [*r, *g, *b])
            .collect();
        Rgb32FImage::from_raw(width as u32, height as u32, data)
            .ok_or_else(|| anyhow!("Invalid HEIC image size"))
    })
}

#[cfg(target_os = "macos")]
fn decode_pixels(bytes: &[u8], _container: &Container) -> Result<Rgb32FImage> {
    core_image_decode(bytes, false)
}

#[cfg(target_os = "macos")]
fn decode_gain_map_pixels(bytes: &[u8], _container: &Container, _item: u16) -> Result<Rgb32FImage> {
    core_image_decode(bytes, true)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn decode_pixels(_bytes: &[u8], _container: &Container) -> Result<Rgb32FImage> {
    Err(anyhow!(
        "HEIC files can only be opened with the decoder built into Windows or macOS"
    ))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn decode_gain_map_pixels(
    _bytes: &[u8],
    _container: &Container,
    _item: u16,
) -> Result<Rgb32FImage> {
    Err(anyhow!(
        "HEIC gain maps need the decoder built into Windows or macOS"
    ))
}
