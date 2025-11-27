use crate::Cursor;
use crate::formats::is_raw_file;
use crate::image_processing::apply_orientation;
use crate::mask_generation::{MaskDefinition, SubMask, generate_mask_bitmap};
use crate::raw_processing::develop_raw_image;
use anyhow::{anyhow, Context, Result};
use base64::{Engine as _, engine::general_purpose};
use exif::{Reader as ExifReader, Tag};
use exr::prelude::*;
use exr::image::pixel_vec::PixelVec;
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
    highlight_compression: f32,
) -> Result<DynamicImage> {
    let base_image =
        load_base_image_from_bytes(base_image, path, use_fast_raw_dev, highlight_compression)?;
    composite_patches_on_image(&base_image, adjustments)
}

fn load_exr_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
    let cursor = Cursor::new(bytes);
    let buffered_reader = std::io::BufReader::new(cursor);

    let exr_image_result = read()
        .no_deep_data()
        .largest_resolution_level()
        .rgba_channels(
            PixelVec::<(f32, f32, f32, f32)>::constructor,
            PixelVec::set_pixel,
        )
        .first_valid_layer()
        .all_attributes()
        .from_buffered(buffered_reader);

    let exr_image = exr_image_result.context("Failed to read EXR image data")?;

    let layer = exr_image.layer_data;
    let resolution = layer.size;
    let width = resolution.x() as u32;
    let height = resolution.y() as u32;
    let pixels = layer.channel_data.pixels;

    let mut rgb_image = image::Rgb32FImage::new(width, height);

    for (index, (r, g, b, _a)) in pixels.pixels.into_iter().enumerate() {
        let x = (index % width as usize) as u32;
        let y = (index / width as usize) as u32;
        rgb_image.put_pixel(x, y, image::Rgb([r, g, b]));
    }

    Ok(DynamicImage::ImageRgb32F(rgb_image))
}

pub fn load_base_image_from_bytes(
    bytes: &[u8],
    path_for_ext_check: &str,
    use_fast_raw_dev: bool,
    highlight_compression: f32,
) -> Result<DynamicImage> {
    let path = std::path::Path::new(path_for_ext_check);
    if path.extension().and_then(|s| s.to_str()).map_or(false, |s| s.eq_ignore_ascii_case("exr")) {
        return load_exr_from_bytes(bytes);
    }

    if is_raw_file(path_for_ext_check) {
        match panic::catch_unwind(|| develop_raw_image(bytes, use_fast_raw_dev, highlight_compression)) {
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

    let oriented_image = {
        let exif_reader = ExifReader::new();
        if let Ok(exif) = exif_reader.read_from_container(&mut cursor.clone()) {
            if let Some(orientation) = exif
                .get_field(Tag::Orientation, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
            {
                apply_orientation(image, Orientation::from_u16(orientation as u16))
            } else {
                image
            }
        } else {
            image
        }
    };

    Ok(DynamicImage::ImageRgb8(oriented_image.to_rgb8()))
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
    let mut composited_rgba = base_image.to_rgba32f();

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
        let color_image_u8 = image::load_from_memory(&color_bytes)?.to_rgb8();

        let (patch_w, patch_h) = color_image_u8.dimensions();
        let color_image_f32 = if base_w != patch_w || base_h != patch_h {
            let resized =
                imageops::resize(&color_image_u8, base_w, base_h, imageops::FilterType::Lanczos3);
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

                        let base_r = row[x * 4 + 0];
                        let base_g = row[x * 4 + 1];
                        let base_b = row[x * 4 + 2];

                        row[x * 4 + 0] = patch_pixel[0] * alpha + base_r * one_minus_alpha;
                        row[x * 4 + 1] = patch_pixel[1] * alpha + base_g * one_minus_alpha;
                        row[x * 4 + 2] = patch_pixel[2] * alpha + base_b * one_minus_alpha;
                    }
                }
            });
    }

    Ok(DynamicImage::ImageRgba32F(composited_rgba))
}
