use crate::app::settings::AppSettings;
use crate::decode::baseline_exposure::BaselineOptions;
use crate::decode::formats::is_raw_file;
use crate::library::sidecars::parse_virtual_path;
use crate::merge::dng::{DngDescription, encode_linear_dng};
use crate::merge::panorama::projection::Projection;
use crate::merge::raster::Raster;
use crate::metadata::exif_processing::{read_exif_data_from_bytes, read_rrexif_sidecar};
use crate::render::agx::agx;
use crate::render::color_space::srgb_transfer;
use crate::render::hdr::basic_raw_display;
use crate::render::image_processing::working_display_to_srgb8;
use base64::{Engine as _, engine::general_purpose};
use glam::Vec3;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageBuffer, Rgb, RgbImage};
use rayon::prelude::*;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};

const PREVIEW_JPEG_QUALITY: u8 = 90;
const LENS_KEYS: [&str; 6] = [
    "LensModel",
    "LensMake",
    "LensSpecification",
    "LensSerialNumber",
    "FocalLength",
    "FocalLengthIn35mmFilm",
];

fn tone_mapper_override(settings: &AppSettings) -> Option<bool> {
    crate::render::options::resolve_tonemapper_override(settings, true).map(|mode| mode == 1)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rendition {
    Display,
    Scene { exposure: f32, agx: bool },
}

impl Rendition {
    pub fn for_sources(scene_referred: bool, reference: &str, settings: &AppSettings) -> Self {
        if !scene_referred {
            return Rendition::Display;
        }
        let exposure = if is_raw_file(reference) {
            crate::decode::as_shot::as_shot(reference)
                .exposure
                .compensation(BaselineOptions::from_settings(settings))
        } else {
            0.0
        };
        let default_agx = is_raw_file(reference)
            && crate::adjustments::develop_defaults::overlay(Path::new(reference))
                .get("toneMapper")
                .and_then(|v| v.as_str())
                == Some("agx");
        Rendition::Scene {
            exposure,
            agx: tone_mapper_override(settings).unwrap_or(default_agx),
        }
    }

    pub fn with_agx(self, settings: &AppSettings) -> Self {
        match self {
            Rendition::Scene { exposure, .. } => Rendition::Scene {
                exposure,
                agx: tone_mapper_override(settings).unwrap_or(true),
            },
            display => display,
        }
    }

    fn display_pixel(self, linear: [f32; 3]) -> [f32; 3] {
        let transfer = srgb_transfer();
        match self {
            Rendition::Display => linear.map(|v| transfer.encode(v.max(0.0))),
            Rendition::Scene {
                exposure,
                agx: false,
            } => {
                let gain = exposure.exp2();
                linear.map(|v| transfer.encode(basic_raw_display((v * gain).max(0.0))))
            }
            Rendition::Scene {
                exposure,
                agx: true,
            } => {
                let gain = exposure.exp2();
                agx().tonemap(Vec3::from_array(linear) * gain).to_array()
            }
        }
    }

    pub fn to_srgb8(self, image: &Raster) -> RgbImage {
        let encoded: Vec<f32> = image
            .data
            .par_chunks_exact(3)
            .flat_map_iter(|p| self.display_pixel([p[0], p[1], p[2]]))
            .collect();
        RgbImage::from_raw(
            image.width as u32,
            image.height as u32,
            working_display_to_srgb8(&encoded),
        )
        .expect("preview buffer matches its dimensions")
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub base64: String,
    pub overlay_base64: Option<String>,
    pub width: usize,
    pub height: usize,
    pub image_count: usize,
    pub excluded_count: usize,
    pub unaligned_count: usize,
    pub projection: Option<Projection>,
}

pub fn encode_jpeg_base64(image: &RgbImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut buf, PREVIEW_JPEG_QUALITY)
        .encode_image(image)
        .map_err(|e| format!("Failed to encode the preview: {}", e))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

pub struct MergeOutput {
    pub image: Raster,
    pub rendition: Rendition,
    pub suffix: &'static str,
    pub name_source: String,
    pub metadata_source: String,
    pub keeps_lens_geometry: bool,
    pub tone_mapper: Option<&'static str>,
}

fn source_exif(path: &str) -> HashMap<String, String> {
    read_rrexif_sidecar(Path::new(path))
        .or_else(|| {
            std::fs::read(path)
                .ok()
                .map(|bytes| read_exif_data_from_bytes(path, &bytes))
        })
        .unwrap_or_default()
}

pub fn write_output(
    name_source: &str,
    suffix: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let (first_path, _) = parse_virtual_path(name_source);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine the folder of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| suffix.to_lowercase());
    crate::library::file_ops::write_unique_output(
        parent_dir,
        &format!("{}_{}", stem, suffix),
        extension,
        bytes,
    )
    .map_err(|e| format!("Failed to save the merged image: {}", e))
}

fn encode_display_tiff(image: &Raster, metadata_source: &str) -> Result<Vec<u8>, String> {
    let transfer = srgb_transfer();
    let data: Vec<u16> = image
        .data
        .par_iter()
        .map(|v| (transfer.encode(v.max(0.0)).min(1.0) * 65535.0).round() as u16)
        .collect();
    let rgb =
        ImageBuffer::<Rgb<u16>, Vec<u16>>::from_raw(image.width as u32, image.height as u32, data)
            .ok_or("Failed to create the merged image.")?;
    crate::metadata::export_metadata::encode_converted_image(
        &DynamicImage::ImageRgb16(rgb),
        "tiff",
        metadata_source,
    )
}

pub fn save_output(output: MergeOutput) -> Result<String, String> {
    let mut exif = source_exif(&output.metadata_source);
    if !output.keeps_lens_geometry {
        for key in LENS_KEYS {
            exif.remove(key);
        }
    }

    let (bytes, extension) = match output.rendition {
        Rendition::Scene { exposure, .. } => {
            let text = |key: &str| {
                exif.get(key)
                    .map(|v| v.trim().trim_matches('"').to_string())
            };
            let make = text("Make").unwrap_or_default();
            let model = text("Model").unwrap_or_default();
            let description = DngDescription {
                make: &make,
                model: &model,
                baseline_exposure: exposure,
            };
            (encode_linear_dng(&output.image, &description)?, "dng")
        }
        Rendition::Display => (
            encode_display_tiff(&output.image, &output.metadata_source)?,
            "tiff",
        ),
    };
    drop(output.image);

    let path = write_output(&output.name_source, output.suffix, extension, &bytes)?;
    if !exif.is_empty() {
        let _ = crate::metadata::sidecar::update_primary_metadata(&path, true, |metadata| {
            metadata.exif = Some(exif);
        });
    }
    if let Some(tone_mapper) = output.tone_mapper {
        let mut adjustments = crate::render::adjustment_utils::default_adjustments(&path);
        adjustments["toneMapper"] = Value::from(tone_mapper);
        let _ = crate::metadata::sidecar::update_primary_metadata(&path, true, |metadata| {
            metadata.adjustments = adjustments;
        });
    }
    Ok(path.to_string_lossy().into_owned())
}
