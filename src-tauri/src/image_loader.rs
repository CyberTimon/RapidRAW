use crate::Cursor;
use crate::formats::is_raw_file;
use crate::image_processing::apply_orientation;
use crate::mask_generation::{MaskDefinition, SubMask, generate_mask_bitmap};
use crate::raw_processing::develop_raw_image;
use anyhow::{anyhow, Context, Result};
use base64::{Engine as _, engine::general_purpose};
use exif::{Reader as ExifReader, Tag};
use image::{DynamicImage, GenericImageView, ImageReader, imageops};
use rawler::Orientation;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Value, from_value};
use std::panic;

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

pub fn load_and_composite(
    base_image: &[u8],
    path: &str,
    adjustments: &Value,
    use_fast_raw_dev: bool,
) -> Result<DynamicImage> {
    let base_image = load_base_image_from_bytes(base_image, path, use_fast_raw_dev)?;
    composite_patches_on_image(&base_image, adjustments)
}

pub fn load_base_image_from_bytes(
    bytes: &[u8],
    path_for_ext_check: &str,
    use_fast_raw_dev: bool,
) -> Result<DynamicImage> {
    if is_raw_file(path_for_ext_check) {
        match panic::catch_unwind(|| develop_raw_image(bytes, use_fast_raw_dev)) {
            Ok(Ok(image)) => Ok(image),
            Ok(Err(e)) => {
                log::warn!("Error developing RAW file '{}': {}", path_for_ext_check, e);
                Err(e)
            }
            Err(_) => {
                log::error!("Panic while processing corrupt RAW file: {}", path_for_ext_check);
                Err(anyhow!("Failed to process corrupt RAW file: {}", path_for_ext_check))
            }
        }
    } else {
        load_image_with_orientation(bytes)
    }
}

pub fn load_image_with_orientation(bytes: &[u8]) -> Result<DynamicImage> {
    let cursor = Cursor::new(bytes);
    let mut reader = ImageReader::new(cursor.clone())
        .with_guessed_format()
        .context("Failed to guess image format")?;

    reader.no_limits();
    let image = reader.decode().context("Failed to decode image")?;

    let exif_reader = ExifReader::new();
    if let Ok(exif) = exif_reader.read_from_container(&mut cursor.clone()) {
        if let Some(orientation) = exif
            .get_field(Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
        {
            return Ok(apply_orientation(
                image,
                Orientation::from_u16(orientation as u16),
            ));
        }
    }

    Ok(image)
}

pub fn composite_patches_on_image(
    base_image: &DynamicImage,
    current_adjustments: &Value,
) -> Result<DynamicImage> {
    let patches_val = match current_adjustments.get("aiPatches") {
        Some(val) => val,
        None => return Ok(base_image.clone()),
    };

    let patches_arr = match patches_val.as_array() {
        Some(arr) if !arr.is_empty() => arr,
        _ => return Ok(base_image.clone()),
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
                .map_or(false, |s| !s.is_empty())
        })
        .collect();

    if visible_patches.is_empty() {
        return Ok(base_image.clone());
    }

    let (base_w, base_h) = base_image.dimensions();
    let mut composited_rgba = base_image.to_rgba8();

    for patch_obj in visible_patches {
        let patch_info: PatchMaskInfo = from_value(patch_obj.clone())
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

        let mask_bitmap = generate_mask_bitmap(&mask_def, base_w, base_h, 1.0, (0.0, 0.0))
            .context("Failed to generate mask from sub_masks for compositing")?;

        let patch_data = patch_obj.get("patchData").context("Missing patchData")?;
        let color_b64 = patch_data
            .get("color")
            .and_then(|v| v.as_str())
            .context("Missing color data")?;
        let color_bytes = general_purpose::STANDARD.decode(color_b64)?;
        let mut color_image = image::load_from_memory(&color_bytes)?.to_rgb8();

        let (patch_w, patch_h) = color_image.dimensions();
        if base_w != patch_w || base_h != patch_h {
            color_image =
                imageops::resize(&color_image, base_w, base_h, imageops::FilterType::Lanczos3);
        }

        composited_rgba
            .par_chunks_mut(base_w as usize * 4)
            .enumerate()
            .for_each(|(y, row)| {
                for x in 0..base_w as usize {
                    let mask_value = mask_bitmap.get_pixel(x as u32, y as u32)[0];

                    if mask_value > 0 {
                        let patch_pixel = color_image.get_pixel(x as u32, y as u32);

                        let alpha = mask_value as f32 / 255.0;
                        let one_minus_alpha = 1.0 - alpha;

                        let base_r = row[x * 4 + 0];
                        let base_g = row[x * 4 + 1];
                        let base_b = row[x * 4 + 2];

                        row[x * 4 + 0] = (patch_pixel[0] as f32 * alpha
                            + base_r as f32 * one_minus_alpha)
                            .round() as u8;
                        row[x * 4 + 1] = (patch_pixel[1] as f32 * alpha
                            + base_g as f32 * one_minus_alpha)
                            .round() as u8;
                        row[x * 4 + 2] = (patch_pixel[2] as f32 * alpha
                            + base_b as f32 * one_minus_alpha)
                            .round() as u8;
                    }
                }
            });
    }

    Ok(DynamicImage::ImageRgba8(composited_rgba))
}