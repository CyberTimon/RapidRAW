use crate::app_settings::AppSettings;
use rawler::bits::Endian;
use rawler::decoders::{Decoder, FormatHint, WellKnownIFD};
use rawler::formats::bmff::Bmff;
use rawler::formats::tiff::reader::TiffReader;
use rawler::formats::tiff::{IFD, Value, ifd::OffsetMode};
use rawler::tags::{DngTag, ExifTag};
use std::io::Cursor;
use std::panic::{AssertUnwindSafe, catch_unwind};

const HIGHLIGHT_BIAS_MIN: f32 = -1.0;
const HIGHLIGHT_BIAS_MAX: f32 = 4.0;

const CANON_LIGHTING_OPT: u16 = 0x4018;
const FUJI_DEVELOPMENT_DYNAMIC_RANGE: u16 = 0x1403;
const FUJI_AUTO_DYNAMIC_RANGE: u16 = 0x140b;
const NIKON_COLOR_SPACE: u16 = 0x001e;
const NIKON_ACTIVE_D_LIGHTING: u16 = 0x0022;
const OLYMPUS_CAMERA_SETTINGS: u16 = 0x2020;
const OLYMPUS_GRADATION: u16 = 0x050f;
const PENTAX_DYNAMIC_RANGE_EXPANSION: u16 = 0x0069;

const RAF_JPEG_OFFSET_POSITION: usize = 84;
const RAF_JPEG_TIFF_HEADER: u32 = 12;
const FUJI_MAKERNOTE_HEADER: &[u8] = b"FUJIFILM";
const FUJI_MAKERNOTE_IFD_OFFSET: u32 = 12;

#[derive(Clone, Copy, Debug, Default)]
pub struct RawExposure {
    pub scene_referred: bool,
    pub dng_baseline: f32,
    pub highlight_preservation: f32,
}

impl RawExposure {
    pub fn compensation(&self, options: BaselineOptions) -> f32 {
        let baseline = options.baseline_exposure.map_or(0.0, |amount| {
            let scene_referred = if self.scene_referred { amount } else { 0.0 };
            scene_referred + self.dng_baseline
        });
        let highlight_preservation = if options.compensate_highlight_preservation {
            self.highlight_preservation
        } else {
            0.0
        };
        baseline + highlight_preservation
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BaselineOptions {
    pub baseline_exposure: Option<f32>,
    pub compensate_highlight_preservation: bool,
}

impl BaselineOptions {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            baseline_exposure: settings
                .enable_baseline_exposure
                .then_some(settings.baseline_exposure),
            compensate_highlight_preservation: settings.compensate_highlight_preservation,
        }
    }
}

pub fn read(decoder: &dyn Decoder, file_bytes: &[u8], is_monochrome: bool) -> RawExposure {
    let highlight_preservation = catch_unwind(AssertUnwindSafe(|| {
        highlight_preservation(decoder.format_hint(), file_bytes)
    }))
    .unwrap_or(0.0);
    RawExposure {
        scene_referred: !is_monochrome,
        dng_baseline: dng_baseline(decoder),
        highlight_preservation: highlight_preservation
            .clamp(HIGHLIGHT_BIAS_MIN, HIGHLIGHT_BIAS_MAX),
    }
}

fn dng_baseline(decoder: &dyn Decoder) -> f32 {
    let Ok(Some(tags)) = decoder.ifd(WellKnownIFD::VirtualDngRootTags) else {
        return 0.0;
    };
    [DngTag::BaselineExposure, DngTag::BaselineExposureOffset]
        .into_iter()
        .filter_map(|tag| tags.get_entry(tag)?.value.get_f32(0).ok().flatten())
        .sum()
}

fn highlight_preservation(format: FormatHint, file_bytes: &[u8]) -> f32 {
    match format {
        FormatHint::CR2 => tiff_makernote(file_bytes).map(|makernote| canon(&makernote)),
        FormatHint::CR3 => Bmff::new_buf(file_bytes)
            .ok()
            .and_then(|bmff| bmff.filebox.moov.cr3desc)
            .map(|desc| canon(desc.cmt3.tiff.root_ifd())),
        FormatHint::NEF | FormatHint::NRW => {
            tiff_makernote(file_bytes).map(|makernote| nikon(&makernote))
        }
        FormatHint::PEF => tiff_makernote(file_bytes).map(|makernote| pentax(&makernote)),
        FormatHint::ORF => olympus_camera_settings(file_bytes).map(|settings| olympus(&settings)),
        FormatHint::RAF => fuji_makernote(file_bytes).map(|makernote| fuji(&makernote)),
        _ => None,
    }
    .unwrap_or(0.0)
}

fn exif_with_makernote(cursor: &mut Cursor<&[u8]>, tiff_offset: u32) -> Option<IFD> {
    IFD::new_root(cursor, tiff_offset)
        .ok()?
        .find_first_ifd_with_tag(ExifTag::MakerNotes)
        .cloned()
}

fn makernote_start(exif: &IFD) -> Option<u32> {
    Some(exif.base + exif.get_entry(ExifTag::MakerNotes)?.offset()? as u32)
}

fn tiff_makernote(file_bytes: &[u8]) -> Option<IFD> {
    let mut cursor = Cursor::new(file_bytes);
    exif_with_makernote(&mut cursor, 0)?
        .parse_makernote(&mut cursor, OffsetMode::Absolute, &[])
        .ok()?
}

fn fuji_makernote(file_bytes: &[u8]) -> Option<IFD> {
    let jpeg_offset = u32::from_be_bytes(
        file_bytes
            .get(RAF_JPEG_OFFSET_POSITION..RAF_JPEG_OFFSET_POSITION + 4)?
            .try_into()
            .ok()?,
    );
    let mut cursor = Cursor::new(file_bytes);
    let exif = exif_with_makernote(&mut cursor, jpeg_offset + RAF_JPEG_TIFF_HEADER)?;
    if !matches!(
        exif.get_entry(ExifTag::MakerNotes).map(|entry| &entry.value),
        Some(Value::Undefined(data)) if data.starts_with(FUJI_MAKERNOTE_HEADER)
    ) {
        return None;
    }
    IFD::new(
        &mut cursor,
        FUJI_MAKERNOTE_IFD_OFFSET,
        makernote_start(&exif)?,
        0,
        Endian::Little,
        &[],
    )
    .ok()
}

fn olympus_camera_settings(file_bytes: &[u8]) -> Option<IFD> {
    let mut cursor = Cursor::new(file_bytes);
    let exif = exif_with_makernote(&mut cursor, 0)?;
    let makernote = rawler::decoders::orf::parse_makernote(&mut cursor, &exif).ok()??;
    let settings_offset = makernote
        .get_entry_raw_with_len(OLYMPUS_CAMERA_SETTINGS, &mut cursor, 4)
        .ok()??
        .get_force_u32(0);
    IFD::new(
        &mut cursor,
        settings_offset,
        makernote_start(&exif)?,
        0,
        makernote.endian,
        &[],
    )
    .ok()
}

fn integers(ifd: &IFD, tag: u16) -> Vec<i32> {
    ifd.get_entry(tag)
        .map(|entry| {
            (0..entry.value.count())
                .map_while(|index| entry.value.get_i32(index).ok().flatten())
                .collect()
        })
        .unwrap_or_default()
}

fn first_integer(ifd: &IFD, tag: u16) -> Option<i32> {
    ifd.get_entry(tag)?.value.get_i32(0).ok().flatten()
}

fn canon(makernote: &IFD) -> f32 {
    let lighting_opt = integers(makernote, CANON_LIGHTING_OPT);
    let auto_lighting_optimizer = match lighting_opt.get(2) {
        Some(0) => 0.5,
        Some(1) => 0.33,
        Some(2) => 0.66,
        _ => 0.0,
    };
    let highlight_tone_priority = match lighting_opt.get(3) {
        Some(&state) if state > 0 => 1.0,
        _ => 0.0,
    };
    auto_lighting_optimizer + highlight_tone_priority
}

fn fuji(makernote: &IFD) -> f32 {
    match [FUJI_DEVELOPMENT_DYNAMIC_RANGE, FUJI_AUTO_DYNAMIC_RANGE]
        .into_iter()
        .find_map(|tag| first_integer(makernote, tag))
    {
        Some(200) => 1.0,
        Some(400) => 2.0,
        _ => 0.0,
    }
}

fn nikon(makernote: &IFD) -> f32 {
    if first_integer(makernote, NIKON_COLOR_SPACE) == Some(4) {
        return 2.0;
    }
    match first_integer(makernote, NIKON_ACTIVE_D_LIGHTING) {
        Some(3) => 0.33,
        Some(5) => 0.66,
        Some(7) => 1.0,
        Some(8) => 1.1,
        Some(9) => 1.2,
        Some(10) => 1.3,
        Some(11) => 1.33,
        _ => 0.0,
    }
}

fn olympus(camera_settings: &IFD) -> f32 {
    match integers(camera_settings, OLYMPUS_GRADATION).as_slice() {
        [_, _, _, 1, ..] => 0.33,
        [-1, -1, 1, ..] => 0.66,
        _ => 0.0,
    }
}

fn pentax(makernote: &IFD) -> f32 {
    match makernote
        .get_entry(PENTAX_DYNAMIC_RANGE_EXPANSION)
        .map(|entry| &entry.value)
    {
        Some(Value::Undefined(data)) if data.first() == Some(&1) => 1.0,
        _ => 0.0,
    }
}
