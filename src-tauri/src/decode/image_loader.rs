use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::{AppState, LoadedImage, PreviewTarget};
use crate::decode::baseline_exposure::BaselineOptions;
use crate::decode::formats::is_raw_file;
use crate::decode::hdr_source::{self, GainMap, HdrTransfer};
use crate::decode::white_balance::WhiteBalance;

use crate::library::file_ops::read_file_mapped;
use crate::library::sidecars::parse_virtual_path;
use crate::masks::generation::{MaskDefinition, SubMask, generate_mask_bitmap};
use crate::metadata::sidecar::ImageMetadata;
use crate::metadata::{exif_processing, sidecar};
use crate::render::adjustment_utils::effective_baseline_exposure;
use crate::render::cache_utils::{DecodeFingerprint, FlightRole, clear_preview_slot};
use crate::render::color_space::{
    OutputColorSpace, fit_gamut, srgb_decode, srgb_encode, srgb_to_working, srgb_transfer,
    working_profile,
};
use crate::render::geometry::{apply_orientation, inverse_transform_mask};
use crate::render::image_processing::apply_working_display_to_srgb;
use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose};
use exif::{Reader as ExifReader, Tag};
use glam::{DMat3, Mat3, Vec3};
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader, Rgb32FImage, imageops};
use moxcms::{
    CicpColorPrimaries, CmsError, ColorProfile, DataColorSpace, Layout, RenderingIntent,
    ToneReprCurve, TransformF32Executor, TransformOptions,
};
use rawler::Orientation;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::panic;
use std::path::Path;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use tauri::Manager;

#[derive(serde::Serialize)]
pub struct LoadImageResult {
    pub width: u32,
    pub height: u32,
    pub metadata: ImageMetadata,
    pub exif: HashMap<String, String>,
    pub is_raw: bool,
    pub as_shot_white_balance: WhiteBalance,
    pub is_embedded_preview: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchMaskInfo {
    id: String,
    name: String,
    #[serde(default)]
    invert: bool,
    #[serde(default)]
    sub_masks: Vec<SubMask>,
}

pub const PATCH_PRIMARIES: &str = "rec2020";

fn srgb_to_linear_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| std::array::from_fn(|i| srgb_decode(i as f32 / 255.0)))
}

pub fn load_and_composite(
    base_image: &[u8],
    path: &str,
    adjustments: &Value,
    use_fast_raw_dev: bool,
    settings: &AppSettings,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<(DynamicImage, f32)> {
    let base_image =
        load_base_image_from_bytes(base_image, path, use_fast_raw_dev, settings, cancel_token)?;
    let prepared = match prepare_base_image_cow(&base_image, path, adjustments)? {
        Cow::Owned(img) => Some(img),
        Cow::Borrowed(_) => None,
    };
    let scale = prepared.as_ref().map_or(1.0, |img| {
        crate::ai::upscale::scale_between(&base_image, img)
    });
    Ok((prepared.unwrap_or(base_image), scale))
}

pub fn prepare_base_image_cow<'a>(
    base_image: &'a DynamicImage,
    path: &str,
    adjustments: &Value,
) -> Result<Cow<'a, DynamicImage>> {
    let has_patches = adjustments
        .get("aiPatches")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty());

    let denoised = crate::ai::denoise::apply_ai_denoise(base_image, path, adjustments);
    let upscaled = crate::ai::upscale::apply_ai_upscale(base_image, denoised, path, adjustments);
    match crate::adjustments::negative_conversion::apply_negative_conversion(
        upscaled,
        is_raw_file(path),
        adjustments,
    ) {
        Cow::Owned(prepared) if !has_patches => Ok(Cow::Owned(prepared)),
        prepared => composite_patches_cow(prepared, base_image.dimensions(), path, adjustments),
    }
}

pub fn load_base_image_from_bytes(
    bytes: &[u8],
    path_for_ext_check: &str,
    use_fast_raw_dev: bool,
    settings: &AppSettings,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
    let linear_mode = settings.linear_raw_mode.clone();
    let color_nr_amount = settings
        .raw_preprocessing_color_nr
        .unwrap_or(0.5)
        .clamp(0.0, 1.0);
    let sharpening_amount = settings.raw_preprocessing_sharpening.unwrap_or(0.35);
    let apply_to_non_raws = settings.apply_preprocessing_to_non_raws.unwrap_or(false);

    crate::metadata::sidecar::persist_exif_if_missing(
        Path::new(path_for_ext_check),
        path_for_ext_check,
        bytes,
    );

    let record_embedded_preview = |used: bool| {
        if !use_fast_raw_dev {
            set_embedded_preview(path_for_ext_check, used);
        }
    };

    if is_raw_file(path_for_ext_check)
        && !use_fast_raw_dev
        && settings.use_apple_raw9.unwrap_or(false)
    {
        if let Some((tracker, generation)) = &cancel_token
            && tracker.load(Ordering::SeqCst) != *generation
        {
            return Err(anyhow!("Load cancelled"));
        }

        match crate::decode::apple_raw::develop_raw9(bytes, path_for_ext_check) {
            Ok(image) => {
                record_embedded_preview(false);
                return Ok(image);
            }
            Err(e) => log::warn!(
                "Apple RAW 9 unavailable for '{}', falling back to rawler: {}",
                path_for_ext_check,
                e
            ),
        }
    }

    if is_raw_file(path_for_ext_check) {
        match panic::catch_unwind(move || {
            crate::decode::raw_processing::develop_raw_image(
                bytes,
                use_fast_raw_dev,
                highlight_compression,
                linear_mode,
                color_nr_amount,
                sharpening_amount,
                cancel_token,
            )
        }) {
            Ok(Ok(image)) => {
                record_embedded_preview(false);
                Ok(image)
            }
            Ok(Err(e)) => {
                let classified = classify_raw_develop_error(path_for_ext_check, e);

                if classified.to_string().contains("Load cancelled") {
                    return Err(classified);
                }

                log::warn!(
                    "Error developing RAW file '{}': {}",
                    path_for_ext_check,
                    classified
                );
                embedded_preview_instead(bytes, path_for_ext_check)
                    .inspect(|_| record_embedded_preview(true))
                    .ok_or(classified)
            }
            Err(_) => {
                log::error!("Panic while processing RAW file: {}", path_for_ext_check);
                embedded_preview_instead(bytes, path_for_ext_check)
                    .inspect(|_| record_embedded_preview(true))
                    .ok_or_else(|| anyhow!("Failed to process RAW file: {}", path_for_ext_check))
            }
        }
    } else {
        let (image, linear_peak) =
            load_image_with_orientation(bytes, cancel_token, settings.decode_gain_maps())?;
        if let Some(peak) = linear_peak {
            crate::decode::as_shot::record_source_peak(path_for_ext_check, peak);
        }
        Ok(if apply_to_non_raws && !use_fast_raw_dev {
            crate::decode::develop::enhance(image, color_nr_amount, sharpening_amount)
        } else {
            image
        })
    }
}

fn classify_raw_develop_error(path: &str, err: anyhow::Error) -> anyhow::Error {
    let error_text = err.to_string();
    let lowered = error_text.to_ascii_lowercase();
    let unsupported_compression =
        lowered.contains("nef compression") && lowered.contains("not supported");

    if unsupported_compression {
        return anyhow!(
            "Unsupported RAW compression format for '{}'. Original error: {}",
            path,
            error_text
        );
    }

    err
}

fn largest_tiff_jpeg_preview(buf: &[u8]) -> Option<DynamicImage> {
    let le = match buf.get(..4)? {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        _ => return None,
    };
    let rd16 = |o: usize| -> Option<u64> {
        let b: [u8; 2] = buf.get(o..o + 2)?.try_into().ok()?;
        Some(if le {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        } as u64)
    };
    let rd32 = |o: usize| -> Option<u64> {
        let b: [u8; 4] = buf.get(o..o + 4)?.try_into().ok()?;
        Some(if le {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        } as u64)
    };

    let mut candidates: Vec<(u64, u64)> = Vec::new();
    let mut queue: Vec<u64> = vec![rd32(4)?];
    let mut seen = HashMap::new();

    while let Some(ifd) = queue.pop() {
        if seen.insert(ifd, ()).is_some() || seen.len() > 64 {
            continue;
        }
        let Some(n) = rd16(ifd as usize) else {
            continue;
        };

        let mut compression: u64 = 0;
        let mut strip: Option<(u64, u64)> = None;
        let mut old_jpeg: Option<(u64, u64)> = None;

        for i in 0..n {
            let e = ifd as usize + 2 + (i as usize) * 12;
            let (Some(tag), Some(count), Some(val)) = (rd16(e), rd32(e + 4), rd32(e + 8)) else {
                continue;
            };
            match tag {
                259 => compression = val,
                273 if count == 1 => strip = Some((val, strip.map_or(0, |s| s.1))),
                279 if count == 1 => strip = strip.map(|s| (s.0, val)).or(Some((0, val))),
                513 => old_jpeg = Some((val, old_jpeg.map_or(0, |s| s.1))),
                514 => old_jpeg = old_jpeg.map(|s| (s.0, val)).or(Some((0, val))),
                330 => {
                    if count == 1 {
                        queue.push(val);
                    } else {
                        for j in 0..count.min(8) {
                            if let Some(p) = rd32(val as usize + (j as usize) * 4) {
                                queue.push(p);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        if matches!(compression, 6 | 7)
            && let Some(s) = strip
        {
            candidates.push(s);
        }
        if let Some(oj) = old_jpeg {
            candidates.push(oj);
        }
        if let Some(next) = rd32(ifd as usize + 2 + (n as usize) * 12)
            && next != 0
        {
            queue.push(next);
        }
    }

    candidates.sort_by_key(|&(_, len)| std::cmp::Reverse(len));

    for (off, len) in candidates {
        if let Some(bytes) = buf.get(off as usize..(off + len) as usize)
            && let Ok(img) = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
        {
            return Some(img);
        }
    }

    None
}

pub fn tiff_embedded_preview(bytes: &[u8]) -> Option<DynamicImage> {
    let img = largest_tiff_jpeg_preview(bytes)?;

    let orientation = exif_processing::read_exif(bytes).and_then(|exif| {
        exif.get_field(Tag::Orientation, exif::In::PRIMARY)?
            .value
            .get_uint(0)
    });

    Some(match orientation {
        Some(o) if o > 1 => apply_orientation(img, Orientation::from_u16(o as u16)),
        _ => img,
    })
}

fn embedded_preview_fallback(bytes: &[u8]) -> Option<DynamicImage> {
    tiff_embedded_preview(bytes)
        .or_else(|| crate::decode::raw_processing::extract_embedded_preview(bytes))
}

pub fn safe_embedded_preview_fallback(bytes: &[u8], path: &str) -> Option<DynamicImage> {
    match panic::catch_unwind(panic::AssertUnwindSafe(|| embedded_preview_fallback(bytes))) {
        Ok(preview) => preview,
        Err(_) => {
            log::warn!("Embedded RAW preview extraction panicked for '{}'", path);
            None
        }
    }
}

fn embedded_preview_paths() -> &'static Mutex<HashSet<String>> {
    static PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn set_embedded_preview(path: &str, used: bool) {
    let mut paths = embedded_preview_paths()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if used {
        paths.insert(path.to_string());
    } else {
        paths.remove(path);
    }
}

pub fn is_embedded_preview(path: &str) -> bool {
    embedded_preview_paths()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(path)
}

fn embedded_preview_instead(bytes: &[u8], path: &str) -> Option<DynamicImage> {
    let preview = safe_embedded_preview_fallback(bytes, path)?;
    log::warn!(
        "Using embedded preview fallback for '{}' ({}x{})",
        path,
        preview.width(),
        preview.height()
    );
    Some(linearize_embedded_preview(preview))
}

fn linearize_embedded_preview(preview: DynamicImage) -> DynamicImage {
    const PREVIEW_GAIN: f32 = 0.4;
    let mut linear_preview = preview.to_rgb32f();
    let matrix = srgb_to_working() * PREVIEW_GAIN;
    for pixel in linear_preview.pixels_mut() {
        pixel.0 = (matrix * Vec3::from_array(pixel.0.map(|c| srgb_decode(c.max(0.0))))).to_array();
    }
    DynamicImage::ImageRgb32F(linear_preview)
}

enum HdrSource {
    GainMap(GainMap),
    Transfer {
        transfer: HdrTransfer,
        to_working: Mat3,
    },
    Linear {
        to_working: Mat3,
    },
}

struct Decoded {
    rgb: Rgb32FImage,
    profile: Option<ProfileToWorking>,
    hdr: Option<HdrSource>,
}

fn hdr_to_working(profile: &ColorProfile) -> Mat3 {
    match profile.cicp.as_ref().map(|cicp| cicp.color_primaries) {
        Some(CicpColorPrimaries::Bt709) => srgb_to_working(),
        Some(CicpColorPrimaries::Smpte432) => {
            OutputColorSpace::DisplayP3.working_matrix().inverse()
        }
        Some(CicpColorPrimaries::Bt2020) => OutputColorSpace::Rec2020.working_matrix().inverse(),
        _ if profile.is_matrix_shaper() => {
            (colorants(&working_profile()).inverse() * colorants(profile)).as_mat3()
        }
        _ => OutputColorSpace::Rec2020.working_matrix().inverse(),
    }
}

fn primaries_profile(primaries: zenavif::ColorPrimaries) -> Option<ColorProfile> {
    match primaries {
        zenavif::ColorPrimaries::SMPTE432 => Some(ColorProfile::new_display_p3()),
        zenavif::ColorPrimaries::BT2020 => Some(ColorProfile::new_bt2020()),
        _ => None,
    }
}

fn primaries_to_working(primaries: zenavif::ColorPrimaries) -> Mat3 {
    match primaries {
        zenavif::ColorPrimaries::SMPTE432 => OutputColorSpace::DisplayP3.working_matrix().inverse(),
        zenavif::ColorPrimaries::BT2020 => OutputColorSpace::Rec2020.working_matrix().inverse(),
        _ => srgb_to_working(),
    }
}

fn decode_avif(bytes: &[u8], with_gain_map: bool) -> Result<Decoded> {
    let avif = crate::decode::avif::decode(bytes, with_gain_map)?;
    let (profile, transfer) = match avif.color {
        crate::decode::avif::AvifColor::Icc {
            icc,
            transfer: container_transfer,
        } => {
            let profile = ColorProfile::new_from_slice(&icc).ok();
            let transfer = profile
                .as_ref()
                .and_then(hdr_source::hdr_transfer)
                .or(container_transfer);
            let to_working = profile.as_ref().map(hdr_to_working);
            (
                profile.as_ref().and_then(ProfileToWorking::new),
                transfer.zip(to_working),
            )
        }
        crate::decode::avif::AvifColor::Cicp {
            primaries,
            transfer,
        } => (
            primaries_profile(primaries)
                .as_ref()
                .and_then(ProfileToWorking::new),
            transfer.map(|transfer| (transfer, primaries_to_working(primaries))),
        ),
    };
    let hdr = match (transfer, avif.gain_map) {
        (Some((transfer, to_working)), _) => Some(HdrSource::Transfer {
            transfer,
            to_working,
        }),
        (None, Some(gain_map)) => Some(HdrSource::GainMap(gain_map)),
        (None, None) => None,
    };
    let profile = match hdr {
        Some(HdrSource::Transfer { .. }) => None,
        _ => profile,
    };
    Ok(Decoded {
        rgb: avif.rgb,
        profile,
        hdr,
    })
}

fn decode_with_orientation(
    bytes: &[u8],
    cancel_token: &Option<(Arc<AtomicUsize>, usize)>,
    with_gain_map: bool,
) -> Result<Decoded> {
    let check_cancel = || -> Result<()> {
        if let Some((tracker, generation)) = cancel_token
            && tracker.load(Ordering::SeqCst) != *generation
        {
            return Err(anyhow!("Load cancelled"));
        }
        Ok(())
    };

    if crate::decode::avif::is_avif(bytes) {
        check_cancel()?;
        let decoded = decode_avif(bytes, with_gain_map)?;
        check_cancel()?;
        return Ok(decoded);
    }

    let cursor = Cursor::new(bytes);
    let mut reader = ImageReader::new(cursor.clone())
        .with_guessed_format()
        .context("Failed to guess image format")?;

    reader.no_limits();

    check_cancel()?;

    let mut decoder = reader.into_decoder().context("Failed to decode image")?;
    let icc_profile = decoder.icc_profile().ok().flatten();
    let source_color = decoder.color_type();
    let image = DynamicImage::from_decoder(decoder).context("Failed to decode image")?;
    let base_size = image.dimensions();
    check_cancel()?;

    let exif = ExifReader::new()
        .read_from_container(&mut cursor.clone())
        .ok();
    let orientation = exif.as_ref().and_then(|exif| {
        exif.get_field(Tag::Orientation, exif::In::PRIMARY)?
            .value
            .get_uint(0)
    });
    let orientation = orientation.map(|orientation| Orientation::from_u16(orientation as u16));
    let oriented_image = match orientation {
        Some(orientation) => apply_orientation(image, orientation),
        None => image,
    };

    let rgb = oriented_image.to_rgb32f();
    let source_profile = match icc_profile {
        Some(icc) => ColorProfile::new_from_slice(&icc).ok(),
        None => exif
            .as_ref()
            .is_some_and(is_exif_adobe_rgb)
            .then(ColorProfile::new_adobe_rgb),
    };
    check_cancel()?;

    let transfer = source_profile.as_ref().and_then(hdr_source::hdr_transfer);
    let hdr = if let (Some(transfer), Some(profile)) = (transfer, &source_profile) {
        Some(HdrSource::Transfer {
            transfer,
            to_working: hdr_to_working(profile),
        })
    } else if hdr_source::is_linear_float(source_color, source_profile.as_ref()) {
        Some(HdrSource::Linear {
            to_working: source_profile
                .as_ref()
                .map_or_else(srgb_to_working, hdr_to_working),
        })
    } else if with_gain_map && bytes.starts_with(&[0xFF, 0xD8]) {
        hdr_source::read_gain_map(bytes, base_size)
            .map(|gain_map| HdrSource::GainMap(gain_map.oriented(orientation)))
    } else {
        None
    };
    let profile = match hdr {
        Some(HdrSource::Transfer { .. } | HdrSource::Linear { .. }) => None,
        _ => source_profile.as_ref().and_then(ProfileToWorking::new),
    };

    Ok(Decoded { rgb, profile, hdr })
}

fn convert_hdr_to_working(
    image: &mut Rgb32FImage,
    from_profile: Option<&ProfileToWorking>,
    hdr: &HdrSource,
) {
    let (width, height) = image.dimensions();
    let row_len = width as usize * 3;
    if row_len == 0 {
        return;
    }
    let transfer = srgb_transfer();
    let (matrix, gain) = match hdr {
        HdrSource::Transfer { to_working, .. } | HdrSource::Linear { to_working } => {
            (*to_working, None)
        }
        HdrSource::GainMap(gain_map) => (
            from_profile.map_or_else(srgb_to_working, |profile| profile.matrix),
            Some(gain_map.row_applier(width, height)),
        ),
    };

    image.par_chunks_mut(row_len).enumerate().for_each_init(
        || vec![0.0f32; row_len],
        |linear, (y, row)| {
            let mut row_matrix = matrix;
            match hdr {
                HdrSource::Transfer { transfer, .. } => {
                    for (linear, encoded) in linear
                        .as_chunks_mut::<3>()
                        .0
                        .iter_mut()
                        .zip(row.as_chunks::<3>().0)
                    {
                        *linear = transfer.to_relative(*encoded);
                    }
                }
                HdrSource::Linear { .. } => {
                    for (linear, value) in linear.iter_mut().zip(row.iter()) {
                        *linear = if value.is_finite() {
                            value.max(0.0)
                        } else {
                            0.0
                        };
                    }
                }
                HdrSource::GainMap(_) => {
                    let linearized = from_profile
                        .is_some_and(|profile| profile.linearize.transform(row, linear).is_ok());
                    if !linearized {
                        for (linear, encoded) in linear.iter_mut().zip(row.iter()) {
                            *linear = transfer.decode(encoded.max(0.0));
                        }
                        row_matrix = srgb_to_working();
                    }
                }
            }
            if let Some(apply_gain) = &gain {
                apply_gain(y as u32, linear);
            }
            for (out, rgb) in row
                .as_chunks_mut::<3>()
                .0
                .iter_mut()
                .zip(linear.as_chunks::<3>().0)
            {
                let working = (row_matrix * Vec3::from_array(*rgb)).to_array();
                *out = fit_gamut(working, &[None; 3]).map(|c| transfer.encode(c.max(0.0)));
            }
        },
    );
}

pub fn load_image_with_orientation(
    bytes: &[u8],
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
    gain_maps: bool,
) -> Result<(DynamicImage, Option<f32>)> {
    let Decoded {
        mut rgb,
        profile,
        hdr,
    } = decode_with_orientation(bytes, &cancel_token, gain_maps)?;
    let linear_peak = matches!(hdr, Some(HdrSource::Linear { .. }))
        .then(|| hdr_source::linear_peak(rgb.as_raw()));
    match &hdr {
        Some(hdr) => convert_hdr_to_working(&mut rgb, profile.as_ref(), hdr),
        None => convert_to_working(&mut rgb, profile.as_ref()),
    }
    Ok((DynamicImage::ImageRgb32F(rgb), linear_peak))
}

pub fn load_display_image(bytes: &[u8], path: &str) -> Result<DynamicImage> {
    crate::metadata::sidecar::persist_exif_if_missing(Path::new(path), path, bytes);
    let Decoded {
        mut rgb,
        profile,
        hdr,
    } = decode_with_orientation(bytes, &None, false)?;
    let mut image = match &hdr {
        Some(hdr) => {
            let peak = match hdr {
                HdrSource::Linear { .. } => {
                    let peak = hdr_source::linear_peak(rgb.as_raw());
                    crate::decode::as_shot::record_source_peak(path, peak);
                    peak
                }
                _ => hdr_source::source_peak(bytes),
            };
            convert_hdr_to_working(&mut rgb, profile.as_ref(), hdr);
            let mut image = DynamicImage::ImageRgb32F(rgb);
            hdr_source::roll_off_encoded(&mut image, peak);
            image
        }
        None if profile.is_none() => return Ok(DynamicImage::ImageRgb32F(rgb)),
        None => {
            convert_to_working(&mut rgb, profile.as_ref());
            DynamicImage::ImageRgb32F(rgb)
        }
    };
    apply_working_display_to_srgb(&mut image, false);
    Ok(image)
}

fn is_exif_adobe_rgb(exif: &exif::Exif) -> bool {
    let uncalibrated = exif
        .get_field(Tag::ColorSpace, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        == Some(0xFFFF);
    let interop_r03 = exif
        .get_field(Tag::InteroperabilityIndex, exif::In::PRIMARY)
        .is_some_and(|f| f.display_value().to_string().contains("R03"));
    uncalibrated && interop_r03
}

fn with_linear_trc(mut profile: ColorProfile) -> ColorProfile {
    let identity = ToneReprCurve::Lut(Vec::new());
    profile.red_trc = Some(identity.clone());
    profile.green_trc = Some(identity.clone());
    profile.blue_trc = Some(identity);
    profile.cicp = None;
    profile
}

fn colorants(profile: &ColorProfile) -> DMat3 {
    DMat3::from_cols_array_2d(&profile.colorant_matrix().v).transpose()
}

fn srgb_to_linear_working(src: &[f32], dst: &mut [f32]) {
    let transfer = srgb_transfer();
    let matrix = srgb_to_working();
    for (out, rgb) in dst
        .as_chunks_mut::<3>()
        .0
        .iter_mut()
        .zip(src.as_chunks::<3>().0)
    {
        *out = (matrix * Vec3::from_array(rgb.map(|c| transfer.decode(c.max(0.0))))).to_array();
    }
}

struct ProfileToWorking {
    linearize: Arc<TransformF32Executor>,
    matrix: Mat3,
}

impl ProfileToWorking {
    fn new(source: &ColorProfile) -> Option<Self> {
        if source.color_space != DataColorSpace::Rgb {
            return None;
        }
        let working = working_profile();
        let (target, matrix) = if source.is_matrix_shaper() {
            let matrix = (colorants(&working).inverse() * colorants(source)).as_mat3();
            (with_linear_trc(source.clone()), matrix)
        } else {
            (with_linear_trc(working), Mat3::IDENTITY)
        };

        let options = TransformOptions {
            rendering_intent: RenderingIntent::RelativeColorimetric,
            ..TransformOptions::default()
        };
        let Ok(linearize) = source.create_transform_f32(Layout::Rgb, &target, Layout::Rgb, options)
        else {
            log::warn!("Unsupported embedded color profile, assuming sRGB");
            return None;
        };
        let transform = Self { linearize, matrix };

        const STEPS: usize = 16;
        let probe: Vec<f32> = (0..(STEPS + 1).pow(3))
            .flat_map(|i| {
                [
                    i % (STEPS + 1),
                    i / (STEPS + 1) % (STEPS + 1),
                    i / (STEPS + 1).pow(2),
                ]
                .map(|c| c as f32 / STEPS as f32)
            })
            .collect();
        let mut from_profile = vec![0.0f32; probe.len()];
        if transform.apply(&probe, &mut from_profile).is_err() {
            log::warn!("Failed to apply embedded color profile, assuming sRGB");
            return None;
        }
        let mut from_srgb = vec![0.0f32; probe.len()];
        srgb_to_linear_working(&probe, &mut from_srgb);
        let is_srgb = from_profile
            .iter()
            .zip(&from_srgb)
            .all(|(a, b)| (srgb_encode(*a) - srgb_encode(*b)).abs() < 2.0 / 255.0);
        (!is_srgb).then_some(transform)
    }

    fn apply(&self, src: &[f32], dst: &mut [f32]) -> Result<(), CmsError> {
        self.linearize.transform(src, dst)?;
        for rgb in dst.as_chunks_mut::<3>().0 {
            *rgb = (self.matrix * Vec3::from_array(*rgb)).to_array();
        }
        Ok(())
    }
}

fn convert_to_working(image: &mut Rgb32FImage, from_profile: Option<&ProfileToWorking>) {
    let row_len = image.width() as usize * 3;
    if row_len == 0 {
        return;
    }
    let transfer = srgb_transfer();

    image.par_chunks_mut(row_len).for_each_init(
        || vec![0.0f32; row_len],
        |linear, row| {
            let converted =
                from_profile.is_some_and(|transform| transform.apply(row, linear).is_ok());
            if !converted {
                srgb_to_linear_working(row, linear);
            }
            for (out, rgb) in row
                .as_chunks_mut::<3>()
                .0
                .iter_mut()
                .zip(linear.as_chunks::<3>().0)
            {
                let fitted = fit_gamut(*rgb, &[None; 3]);
                let scale = fitted[0].max(fitted[1]).max(fitted[2]).max(1.0);
                *out = fitted.map(|c| transfer.encode(c / scale));
            }
        },
    );
}

fn composite_patches_cow<'a>(
    base_image: Cow<'a, DynamicImage>,
    (canon_w, canon_h): (u32, u32),
    path: &str,
    current_adjustments: &Value,
) -> Result<Cow<'a, DynamicImage>> {
    let patches_val = match current_adjustments.get("aiPatches") {
        Some(val) => val,
        None => return Ok(base_image),
    };

    let patches_arr = match patches_val.as_array() {
        Some(arr) if !arr.is_empty() => arr,
        _ => return Ok(base_image),
    };

    let visible_patches: Vec<&Value> = patches_arr
        .par_iter()
        .filter(|patch_obj| {
            let is_visible = patch_obj
                .get("visible")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if !is_visible {
                return false;
            }
            patch_obj
                .get("patchData")
                .and_then(|data| data.get("color"))
                .and_then(|color| color.as_str())
                .is_some_and(|s| !s.is_empty())
        })
        .collect();

    if visible_patches.is_empty() {
        return Ok(base_image);
    }

    let (base_w, base_h) = base_image.dimensions();
    let scale = (base_w / canon_w.max(1)).max(1);

    struct DecodedPatch {
        offset_x: Option<u32>,
        offset_y: Option<u32>,
        mask: image::GrayImage,
        color: image::RgbImage,
        is_srgb_encoded: bool,
        is_working_space: bool,
    }

    let decoded_patches: Result<Vec<DecodedPatch>> = visible_patches
        .par_iter()
        .map(|patch_obj| {
            let patch_data = patch_obj.get("patchData").context("Missing patchData")?;
            let offset_x = patch_data
                .get("offsetX")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let offset_y = patch_data
                .get("offsetY")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let is_cropped = offset_x.is_some() && offset_y.is_some();

            let is_srgb_encoded = patch_data
                .get("isSrgbEncoded")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let is_working_space =
                patch_data.get("primaries").and_then(|v| v.as_str()) == Some(PATCH_PRIMARIES);

            let mask_bitmap = if let Some(mask_b64) = patch_data
                .get("mask")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                let mask_bytes = general_purpose::STANDARD.decode(mask_b64)?;
                let mask_img = image::load_from_memory(&mask_bytes)?.into_luma8();
                if !is_cropped && (mask_img.width() != canon_w || mask_img.height() != canon_h) {
                    imageops::resize(&mask_img, canon_w, canon_h, imageops::FilterType::Lanczos3)
                } else {
                    mask_img
                }
            } else {
                let patch_info = PatchMaskInfo::deserialize(*patch_obj)
                    .context("Failed to deserialize patch info for mask generation")?;

                let mask_def = MaskDefinition {
                    id: patch_info.id,
                    name: patch_info.name,
                    visible: true,
                    invert: patch_info.invert,
                    opacity: 100.0,
                    adjustments: Value::Null,
                    sub_masks: patch_info.sub_masks,
                };

                let orientation_steps = current_adjustments
                    .get("orientationSteps")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u8;
                let (trans_w, trans_h) = if orientation_steps % 2 == 1 {
                    (canon_h, canon_w)
                } else {
                    (canon_w, canon_h)
                };

                let mut gen_mask =
                    generate_mask_bitmap(&mask_def, trans_w, trans_h, 1.0, (0.0, 0.0), None)
                        .context("Failed to generate mask from sub_masks for compositing")?;

                gen_mask = inverse_transform_mask(gen_mask, path, current_adjustments);

                if let (Some(ox), Some(oy)) = (offset_x, offset_y) {
                    let w = patch_data
                        .get("width")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32)
                        .unwrap_or(canon_w);
                    let h = patch_data
                        .get("height")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32)
                        .unwrap_or(canon_h);
                    let crop_w = w.min(canon_w.saturating_sub(ox));
                    let crop_h = h.min(canon_h.saturating_sub(oy));
                    gen_mask = imageops::crop_imm(&gen_mask, ox, oy, crop_w, crop_h).to_image();
                }
                gen_mask
            };

            let color_b64 = patch_data
                .get("color")
                .and_then(|v| v.as_str())
                .context("Missing color data")?;
            let color_bytes = general_purpose::STANDARD.decode(color_b64)?;
            let color_image_u8 = image::load_from_memory(&color_bytes)?.into_rgb8();

            let (patch_w, patch_h) = color_image_u8.dimensions();
            let final_color = if !is_cropped && (canon_w != patch_w || canon_h != patch_h) {
                imageops::resize(
                    &color_image_u8,
                    canon_w,
                    canon_h,
                    imageops::FilterType::Lanczos3,
                )
            } else {
                color_image_u8
            };

            let (mask_bitmap, final_color) = if scale == 1 {
                (mask_bitmap, final_color)
            } else {
                let (w, h) = mask_bitmap.dimensions();
                let (sw, sh) = (w * scale, h * scale);
                (
                    imageops::resize(&mask_bitmap, sw, sh, imageops::FilterType::Triangle),
                    imageops::resize(&final_color, sw, sh, imageops::FilterType::CatmullRom),
                )
            };

            Ok(DecodedPatch {
                offset_x: offset_x.map(|v| v * scale),
                offset_y: offset_y.map(|v| v * scale),
                mask: mask_bitmap,
                color: final_color,
                is_srgb_encoded,
                is_working_space,
            })
        })
        .collect();

    let decoded_patches = decoded_patches?;

    let mut composited_image = base_image.into_owned();
    let lut = srgb_to_linear_lut();

    let from_srgb = srgb_to_working();

    let get_color = |patch: &DecodedPatch, r: u8, g: u8, b: u8| -> (f32, f32, f32) {
        let linear = || Vec3::new(lut[r as usize], lut[g as usize], lut[b as usize]);
        match (patch.is_working_space, patch.is_srgb_encoded) {
            (true, true) => linear().into(),
            (true, false) => (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0),
            (false, true) => (from_srgb * linear()).into(),
            (false, false) => (from_srgb * linear()).map(srgb_encode).into(),
        }
    };

    match &mut composited_image {
        DynamicImage::ImageRgb32F(img_buf) => {
            for patch in decoded_patches {
                let mask_raw = patch.mask.as_raw();
                let color_raw = patch.color.as_raw();
                let patch_w = patch.mask.width() as usize;

                if let (Some(ox), Some(oy)) = (patch.offset_x, patch.offset_y) {
                    let max_x = (ox + patch.mask.width()).min(base_w);
                    let max_y = (oy + patch.mask.height()).min(base_h);

                    let crop_w = max_x.saturating_sub(ox) as usize;
                    let crop_h = max_y.saturating_sub(oy) as usize;

                    if crop_w == 0 || crop_h == 0 {
                        continue;
                    }

                    let base_w_usize = base_w as usize;
                    let ox_usize = ox as usize;
                    let oy_usize = oy as usize;

                    img_buf
                        .par_chunks_mut(base_w_usize * 3)
                        .enumerate()
                        .skip(oy_usize)
                        .take(crop_h)
                        .for_each(|(y, row)| {
                            let py = y - oy_usize;
                            let patch_row_start = py * patch_w;

                            for x in ox_usize..(ox_usize + crop_w) {
                                let px = x - ox_usize;
                                let mask_idx = patch_row_start + px;
                                let mask_value = mask_raw[mask_idx];

                                if mask_value > 0 {
                                    let color_idx = mask_idx * 3;
                                    let pr_u8 = color_raw[color_idx];
                                    let pg_u8 = color_raw[color_idx + 1];
                                    let pb_u8 = color_raw[color_idx + 2];

                                    let (pr, pg, pb) = get_color(&patch, pr_u8, pg_u8, pb_u8);

                                    let alpha = mask_value as f32 / 255.0;
                                    let one_minus_alpha = 1.0 - alpha;

                                    let base_idx = x * 3;
                                    row[base_idx] = pr * alpha + row[base_idx] * one_minus_alpha;
                                    row[base_idx + 1] =
                                        pg * alpha + row[base_idx + 1] * one_minus_alpha;
                                    row[base_idx + 2] =
                                        pb * alpha + row[base_idx + 2] * one_minus_alpha;
                                }
                            }
                        });
                } else {
                    img_buf
                        .par_chunks_mut((base_w * 3) as usize)
                        .enumerate()
                        .for_each(|(y, row)| {
                            let patch_row_start = y * patch_w;
                            for x in 0..base_w as usize {
                                let mask_idx = patch_row_start + x;
                                let mask_value = mask_raw[mask_idx];
                                if mask_value > 0 {
                                    let color_idx = mask_idx * 3;
                                    let pr_u8 = color_raw[color_idx];
                                    let pg_u8 = color_raw[color_idx + 1];
                                    let pb_u8 = color_raw[color_idx + 2];

                                    let (pr, pg, pb) = get_color(&patch, pr_u8, pg_u8, pb_u8);

                                    let alpha = mask_value as f32 / 255.0;
                                    let one_minus_alpha = 1.0 - alpha;

                                    row[x * 3] = pr * alpha + row[x * 3] * one_minus_alpha;
                                    row[x * 3 + 1] = pg * alpha + row[x * 3 + 1] * one_minus_alpha;
                                    row[x * 3 + 2] = pb * alpha + row[x * 3 + 2] * one_minus_alpha;
                                }
                            }
                        });
                }
            }
        }
        DynamicImage::ImageRgba32F(img_buf) => {
            for patch in decoded_patches {
                let mask_raw = patch.mask.as_raw();
                let color_raw = patch.color.as_raw();
                let patch_w = patch.mask.width() as usize;

                if let (Some(ox), Some(oy)) = (patch.offset_x, patch.offset_y) {
                    let max_x = (ox + patch.mask.width()).min(base_w);
                    let max_y = (oy + patch.mask.height()).min(base_h);

                    let crop_w = max_x.saturating_sub(ox) as usize;
                    let crop_h = max_y.saturating_sub(oy) as usize;

                    if crop_w == 0 || crop_h == 0 {
                        continue;
                    }

                    let base_w_usize = base_w as usize;
                    let ox_usize = ox as usize;
                    let oy_usize = oy as usize;

                    img_buf
                        .par_chunks_mut(base_w_usize * 4)
                        .enumerate()
                        .skip(oy_usize)
                        .take(crop_h)
                        .for_each(|(y, row)| {
                            let py = y - oy_usize;
                            let patch_row_start = py * patch_w;

                            for x in ox_usize..(ox_usize + crop_w) {
                                let px = x - ox_usize;
                                let mask_idx = patch_row_start + px;
                                let mask_value = mask_raw[mask_idx];

                                if mask_value > 0 {
                                    let color_idx = mask_idx * 3;
                                    let pr_u8 = color_raw[color_idx];
                                    let pg_u8 = color_raw[color_idx + 1];
                                    let pb_u8 = color_raw[color_idx + 2];

                                    let (pr, pg, pb) = get_color(&patch, pr_u8, pg_u8, pb_u8);
                                    let alpha = mask_value as f32 / 255.0;
                                    let one_minus_alpha = 1.0 - alpha;

                                    let base_idx = x * 4;
                                    row[base_idx] = pr * alpha + row[base_idx] * one_minus_alpha;
                                    row[base_idx + 1] =
                                        pg * alpha + row[base_idx + 1] * one_minus_alpha;
                                    row[base_idx + 2] =
                                        pb * alpha + row[base_idx + 2] * one_minus_alpha;
                                }
                            }
                        });
                } else {
                    img_buf
                        .par_chunks_mut((base_w * 4) as usize)
                        .enumerate()
                        .for_each(|(y, row)| {
                            let patch_row_start = y * patch_w;
                            for x in 0..base_w as usize {
                                let mask_idx = patch_row_start + x;
                                let mask_value = mask_raw[mask_idx];
                                if mask_value > 0 {
                                    let color_idx = mask_idx * 3;
                                    let pr_u8 = color_raw[color_idx];
                                    let pg_u8 = color_raw[color_idx + 1];
                                    let pb_u8 = color_raw[color_idx + 2];

                                    let (pr, pg, pb) = get_color(&patch, pr_u8, pg_u8, pb_u8);

                                    let alpha = mask_value as f32 / 255.0;
                                    let one_minus_alpha = 1.0 - alpha;

                                    row[x * 4] = pr * alpha + row[x * 4] * one_minus_alpha;
                                    row[x * 4 + 1] = pg * alpha + row[x * 4 + 1] * one_minus_alpha;
                                    row[x * 4 + 2] = pb * alpha + row[x * 4 + 2] * one_minus_alpha;
                                }
                            }
                        });
                }
            }
        }
        _ => {
            let mut rgba32_img = composited_image.to_rgba32f();
            for patch in decoded_patches {
                let mask_raw = patch.mask.as_raw();
                let color_raw = patch.color.as_raw();
                let patch_w = patch.mask.width() as usize;

                if let (Some(ox), Some(oy)) = (patch.offset_x, patch.offset_y) {
                    let max_x = (ox + patch.mask.width()).min(base_w);
                    let max_y = (oy + patch.mask.height()).min(base_h);

                    let crop_w = max_x.saturating_sub(ox) as usize;
                    let crop_h = max_y.saturating_sub(oy) as usize;

                    if crop_w == 0 || crop_h == 0 {
                        continue;
                    }

                    let base_w_usize = base_w as usize;
                    let ox_usize = ox as usize;
                    let oy_usize = oy as usize;

                    rgba32_img
                        .par_chunks_mut(base_w_usize * 4)
                        .enumerate()
                        .skip(oy_usize)
                        .take(crop_h)
                        .for_each(|(y, row)| {
                            let py = y - oy_usize;
                            let patch_row_start = py * patch_w;

                            for x in ox_usize..(ox_usize + crop_w) {
                                let px = x - ox_usize;
                                let mask_idx = patch_row_start + px;
                                let mask_value = mask_raw[mask_idx];

                                if mask_value > 0 {
                                    let color_idx = mask_idx * 3;
                                    let pr_u8 = color_raw[color_idx];
                                    let pg_u8 = color_raw[color_idx + 1];
                                    let pb_u8 = color_raw[color_idx + 2];

                                    let (pr, pg, pb) = get_color(&patch, pr_u8, pg_u8, pb_u8);
                                    let alpha = mask_value as f32 / 255.0;
                                    let one_minus_alpha = 1.0 - alpha;

                                    let base_idx = x * 4;
                                    row[base_idx] = pr * alpha + row[base_idx] * one_minus_alpha;
                                    row[base_idx + 1] =
                                        pg * alpha + row[base_idx + 1] * one_minus_alpha;
                                    row[base_idx + 2] =
                                        pb * alpha + row[base_idx + 2] * one_minus_alpha;
                                }
                            }
                        });
                } else {
                    rgba32_img
                        .par_chunks_mut((base_w * 4) as usize)
                        .enumerate()
                        .for_each(|(y, row)| {
                            let patch_row_start = y * patch_w;
                            for x in 0..base_w as usize {
                                let mask_idx = patch_row_start + x;
                                let mask_value = mask_raw[mask_idx];
                                if mask_value > 0 {
                                    let color_idx = mask_idx * 3;
                                    let pr_u8 = color_raw[color_idx];
                                    let pg_u8 = color_raw[color_idx + 1];
                                    let pb_u8 = color_raw[color_idx + 2];

                                    let (pr, pg, pb) = get_color(&patch, pr_u8, pg_u8, pb_u8);
                                    let alpha = mask_value as f32 / 255.0;
                                    let one_minus_alpha = 1.0 - alpha;

                                    row[x * 4] = pr * alpha + row[x * 4] * one_minus_alpha;
                                    row[x * 4 + 1] = pg * alpha + row[x * 4 + 1] * one_minus_alpha;
                                    row[x * 4 + 2] = pb * alpha + row[x * 4 + 2] * one_minus_alpha;
                                }
                            }
                        });
                }
            }
            composited_image = DynamicImage::ImageRgba32F(rgba32_img);
        }
    }

    Ok(Cow::Owned(composited_image))
}

fn is_cancelled(cancel_token: &Option<(Arc<AtomicUsize>, usize)>) -> bool {
    cancel_token
        .as_ref()
        .is_some_and(|(tracker, generation)| tracker.load(Ordering::SeqCst) != *generation)
}

pub fn decode_pristine(
    source_path: &Path,
    path_str: &str,
    settings: &AppSettings,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<(DynamicImage, HashMap<String, String>), String> {
    if crate::library::file_ops::is_cloud_placeholder(source_path) {
        return Err(format!(
            "'{}' is stored in iCloud and hasn't been downloaded yet. Download it in Finder, then try again.",
            path_str
        ));
    }
    let decode = |bytes: &[u8]| -> Result<(DynamicImage, HashMap<String, String>), String> {
        if is_cancelled(&cancel_token) {
            return Err("Load cancelled".to_string());
        }
        let image =
            load_base_image_from_bytes(bytes, path_str, false, settings, cancel_token.clone())
                .map_err(|e| e.to_string())?;
        crate::decode::as_shot::as_shot_from_bytes(path_str, bytes);
        Ok((image, sidecar::read_exif_data(path_str, bytes)))
    };
    match read_file_mapped(source_path) {
        Ok(mmap) => decode(&mmap),
        Err(e) => {
            log::warn!(
                "Failed to memory-map file '{}': {}. Falling back to standard read.",
                path_str,
                e
            );
            let bytes = fs::read(source_path)
                .map_err(|io_err| format!("Fallback read failed for {}: {}", path_str, io_err))?;
            decode(&bytes)
        }
    }
}

pub fn cache_pristine(
    state: &AppState,
    path_str: String,
    fingerprint: Option<DecodeFingerprint>,
    image: DynamicImage,
    exif: HashMap<String, String>,
) -> (Arc<DynamicImage>, HashMap<String, String>) {
    let image = Arc::new(image);
    if let Some(fp) = fingerprint {
        state.decoded_image_cache.lock().unwrap().insert(
            path_str,
            fp,
            Arc::clone(&image),
            exif.clone(),
        );
    }
    (image, exif)
}

pub fn get_or_decode_pristine(
    state: &AppState,
    source_path: &Path,
    settings: &AppSettings,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<(Arc<DynamicImage>, HashMap<String, String>), String> {
    let path_str = source_path.to_string_lossy().to_string();
    let fingerprint = DecodeFingerprint::for_file(source_path, settings);
    let cached = || {
        fingerprint
            .as_ref()
            .and_then(|fp| state.decoded_image_cache.lock().unwrap().get(&path_str, fp))
    };
    loop {
        if let Some(hit) = cached() {
            return Ok(hit);
        }
        if is_cancelled(&cancel_token) {
            return Err("Load cancelled".to_string());
        }
        let _flight = match state.decode_flights.begin(&path_str) {
            FlightRole::Follower(flight) => {
                flight.wait();
                continue;
            }
            FlightRole::Leader(guard) => guard,
        };
        if let Some(hit) = cached() {
            return Ok(hit);
        }

        let (image, exif) = decode_pristine(source_path, &path_str, settings, cancel_token)?;
        return Ok(cache_pristine(state, path_str, fingerprint, image, exif));
    }
}

#[tauri::command]
pub fn is_image_cached(
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> bool {
    let (source_path, _) = parse_virtual_path(&path);
    let settings = load_settings(app_handle).unwrap_or_default();
    let Some(fingerprint) = DecodeFingerprint::for_file(&source_path, &settings) else {
        return false;
    };
    state
        .decoded_image_cache
        .lock()
        .unwrap()
        .contains(&source_path.to_string_lossy(), &fingerprint)
}

fn file_has_gain_map(source_path: &Path) -> bool {
    read_file_mapped(source_path).is_ok_and(|bytes| hdr_source::has_gain_map(&bytes))
}

pub fn refresh_gain_map_decode(
    state: &AppState,
    loaded: LoadedImage,
    settings: &AppSettings,
) -> LoadedImage {
    let wanted = settings.decode_gain_maps();
    if loaded.is_raw || !loaded.has_gain_map || loaded.gain_maps == wanted {
        return loaded;
    }
    let (source_path, _) = parse_virtual_path(&loaded.path);
    let image = match get_or_decode_pristine(state, &source_path, settings, None) {
        Ok((image, _)) => image,
        Err(e) => {
            log::warn!(
                "Could not reload '{}' for the gain map setting: {}",
                loaded.path,
                e
            );
            return loaded;
        }
    };
    let refreshed = LoadedImage {
        image,
        as_shot: crate::decode::as_shot::as_shot(&source_path.to_string_lossy()),
        gain_maps: wanted,
        ..loaded
    };
    let mut current = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if current
        .as_ref()
        .is_some_and(|current| current.path == refreshed.path)
    {
        *current = Some(refreshed.clone());
        drop(current);
        for target in PreviewTarget::ALL {
            clear_preview_slot(state, target);
        }
        *state
            .full_warped_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        state
            .uncropped_source_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        crate::render::cache_utils::clear_preview_stage_caches(state);
    }
    refreshed
}

#[tauri::command]
pub async fn load_image(
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<LoadImageResult, String> {
    let (source_path, sidecar_path) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();
    let _preload_guard = state.image_preloader.begin_load(&source_path_str);

    let my_generation = state.load_image_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel_token = Some((state.load_image_generation.clone(), my_generation));

    {
        *state
            .original_image
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        for target in PreviewTarget::ALL {
            clear_preview_slot(&state, target);
        }
        *state
            .full_warped_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        crate::render::cache_utils::clear_preview_stage_caches(&state);

        state
            .mask_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        state
            .patch_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        state
            .uncropped_source_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    crate::integrations::immich::ensure_local(&app_handle, &source_path).await?;

    let metadata: ImageMetadata = crate::metadata::sidecar::load_sidecar(&sidecar_path);

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let baseline_options = BaselineOptions::from_settings(&settings);
    let gain_maps = settings.decode_gain_maps();

    state
        .decoded_image_cache
        .lock()
        .unwrap()
        .promote(&source_path_str);

    let (pristine_arc, exif_data) = {
        let app_handle = app_handle.clone();
        let source_path = source_path.clone();
        tokio::task::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            get_or_decode_pristine(&state, &source_path, &settings, cancel_token)
        })
        .await
        .map_err(|e| e.to_string())??
    };

    if state.load_image_generation.load(Ordering::SeqCst) != my_generation {
        return Err("Load cancelled".to_string());
    }

    let is_raw = is_raw_file(&source_path_str);

    if state.load_image_generation.load(Ordering::SeqCst) != my_generation {
        return Err("Load cancelled".to_string());
    }

    let (orig_width, orig_height) = pristine_arc.dimensions();
    let as_shot = crate::decode::as_shot::as_shot(&source_path_str);
    if is_raw {
        log::info!(
            "Baseline exposure for '{}': {:+.2} EV (DNG baseline {:+.2} EV, highlight preservation {:+.2} EV)",
            source_path_str,
            effective_baseline_exposure(&metadata.adjustments, as_shot, baseline_options),
            as_shot.exposure.dng_baseline.unwrap_or(0.0),
            as_shot.exposure.highlight_preservation
        );
    }

    *state.original_image.lock().unwrap() = Some(LoadedImage {
        path: path.clone(),
        image: pristine_arc,
        is_raw,
        as_shot,
        has_gain_map: !is_raw && file_has_gain_map(&source_path),
        gain_maps,
    });

    crate::ai::jobs::prioritize(&app_handle, &path);

    Ok(LoadImageResult {
        width: orig_width,
        height: orig_height,
        metadata,
        exif: exif_data,
        is_raw,
        as_shot_white_balance: as_shot.white_balance,
        is_embedded_preview: is_embedded_preview(&source_path_str),
    })
}
