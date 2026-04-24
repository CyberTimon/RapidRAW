use crate::Cursor;
use crate::formats::is_raw_file;
use crate::image_processing::{apply_orientation, remove_raw_artifacts_and_enhance};
use crate::mask_generation::{MaskDefinition, SubMask, generate_mask_bitmap};
use crate::raw_processing::develop_raw_image;
use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose};
use exif::{Reader as ExifReader, Tag};
use image::{DynamicImage, GenericImageView, ImageReader, imageops};
use rawler::Orientation;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Value, from_value};
use std::panic;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Instant;

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
    highlight_compression: f32,
    linear_mode: String,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    let base_image = load_base_image_from_bytes(
        base_image,
        path,
        use_fast_raw_dev,
        highlight_compression,
        linear_mode,
        cancel_token,
    )?;
    composite_patches_on_image(&base_image, adjustments)
}

pub fn load_base_image_from_bytes(
    bytes: &[u8],
    path_for_ext_check: &str,
    use_fast_raw_dev: bool,
    highlight_compression: f32,
    linear_mode: String,
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    if is_raw_file(path_for_ext_check) {
        match panic::catch_unwind(move || {
            develop_raw_image(
                bytes,
                use_fast_raw_dev,
                highlight_compression,
                linear_mode,
                cancel_token,
            )
        }) {
            Ok(Ok(mut image)) => {
                if !use_fast_raw_dev {
                    let start = Instant::now();
                    remove_raw_artifacts_and_enhance(&mut image);
                    let duration = start.elapsed();
                    log::info!(
                        "Raw enhancing for '{}' took {:?}",
                        path_for_ext_check,
                        duration
                    );
                }
                Ok(image)
            }
            Ok(Err(e)) => {
                let classified = classify_raw_develop_error(path_for_ext_check, e);
                log::warn!(
                    "Error developing RAW file '{}': {}",
                    path_for_ext_check,
                    classified
                );
                Err(classified)
            }
            Err(_) => {
                log::error!("Panic while processing RAW file: {}", path_for_ext_check);
                Err(anyhow!(
                    "Failed to process RAW file: {}",
                    path_for_ext_check
                ))
            }
        }
    } else {
        load_image_with_orientation(bytes, cancel_token)
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

pub fn load_image_with_orientation(
    bytes: &[u8],
    cancel_token: Option<(Arc<AtomicUsize>, usize)>,
) -> Result<DynamicImage> {
    let check_cancel = || -> Result<()> {
        if let Some((tracker, generation)) = &cancel_token
            && tracker.load(Ordering::SeqCst) != *generation
        {
            return Err(anyhow!("Load cancelled"));
        }
        Ok(())
    };

    let cursor = Cursor::new(bytes);
    let mut reader = ImageReader::new(cursor.clone())
        .with_guessed_format()
        .context("Failed to guess image format")?;

    reader.no_limits();

    check_cancel()?;

    let image = reader.decode().context("Failed to decode image")?;
    check_cancel()?;

    let oriented_image = {
        let exif_reader = ExifReader::new();
        if let Ok(exif) = exif_reader.read_from_container(&mut cursor.clone()) {
            if let Some(orientation) = exif
                .get_field(Tag::Orientation, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
            {
                check_cancel()?;
                apply_orientation(image, Orientation::from_u16(orientation as u16))
            } else {
                image
            }
        } else {
            image
        }
    };

    Ok(DynamicImage::ImageRgb32F(oriented_image.to_rgb32f()))
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
                .is_some_and(|s| !s.is_empty())
        })
        .collect();

    if visible_patches.is_empty() {
        return Ok(base_image.clone());
    }

    let (base_w, base_h) = base_image.dimensions();
    let mut composited_rgba = base_image.to_rgba32f();

    for patch_obj in visible_patches {
        let patch_data = patch_obj.get("patchData").context("Missing patchData")?;

        let mask_bitmap = if let Some(mask_b64) = patch_data
            .get("mask")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            let mask_bytes = general_purpose::STANDARD.decode(mask_b64)?;
            let mask_img = image::load_from_memory(&mask_bytes)?.to_luma8();
            if mask_img.width() != base_w || mask_img.height() != base_h {
                imageops::resize(&mask_img, base_w, base_h, imageops::FilterType::Lanczos3)
            } else {
                mask_img
            }
        } else {
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

            generate_mask_bitmap(&mask_def, base_w, base_h, 1.0, (0.0, 0.0), None)
                .context("Failed to generate mask from sub_masks for compositing")?
        };

        let color_b64 = patch_data
            .get("color")
            .and_then(|v| v.as_str())
            .context("Missing color data")?;
        let color_bytes = general_purpose::STANDARD.decode(color_b64)?;
        let color_image_u8 = image::load_from_memory(&color_bytes)?.to_rgb8();

        let (patch_w, patch_h) = color_image_u8.dimensions();
        let color_image_f32 = if base_w != patch_w || base_h != patch_h {
            let resized = imageops::resize(
                &color_image_u8,
                base_w,
                base_h,
                imageops::FilterType::Lanczos3,
            );
            DynamicImage::ImageRgb8(resized).to_rgb32f()
        } else {
            DynamicImage::ImageRgb8(color_image_u8).to_rgb32f()
        };

        composited_rgba
            .par_chunks_mut((base_w * 4) as usize)
            .enumerate()
            .for_each(|(y, row)| {
                for x in 0..base_w as usize {
                    let mask_value = mask_bitmap.get_pixel(x as u32, y as u32)[0];

                    if mask_value > 0 {
                        let patch_pixel = color_image_f32.get_pixel(x as u32, y as u32);

                        let alpha = mask_value as f32 / 255.0;
                        let one_minus_alpha = 1.0 - alpha;

                        let base_r = row[x * 4];
                        let base_g = row[x * 4 + 1];
                        let base_b = row[x * 4 + 2];

                        row[x * 4] = patch_pixel[0] * alpha + base_r * one_minus_alpha;
                        row[x * 4 + 1] = patch_pixel[1] * alpha + base_g * one_minus_alpha;
                        row[x * 4 + 2] = patch_pixel[2] * alpha + base_b * one_minus_alpha;
                    }
                }
            });
    }

    Ok(DynamicImage::ImageRgba32F(composited_rgba))
}
