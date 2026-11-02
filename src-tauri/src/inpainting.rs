use std::io::Cursor;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, Rgb, RgbImage, RgbaImage};
use rayon::prelude::*;
use serde_json::Value;

use crate::ai_connector;
use crate::ai_processing;
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::image_loader::prepare_base_image_cow;
use crate::image_processing::{Crop, apply_linear_to_srgb};
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, SubMask, generate_mask_bitmap};
use crate::resolve_warped_image_for_masks;

fn adjustments_without_patch(patch_id: &str, current_adjustments: &Value) -> Value {
    let mut adjustments = current_adjustments.clone();
    if let Some(patches) = adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        patches.retain(|p| p.get("id").and_then(|id| id.as_str()) != Some(patch_id));
    }
    adjustments
}

fn prepare_source_image(
    patch_id: &str,
    current_adjustments: &Value,
    state: &tauri::State<'_, AppState>,
) -> Result<(DynamicImage, bool), String> {
    let source_image_adjustments = adjustments_without_patch(patch_id, current_adjustments);

    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;
    let is_raw = crate::negative_conversion::effective_is_raw(
        loaded_image.is_raw,
        &source_image_adjustments,
    );

    let composited = prepare_base_image_cow(
        &loaded_image.image,
        &loaded_image.path,
        &source_image_adjustments,
    )
    .map_err(|e| format!("Failed to prepare source image: {}", e))?
    .into_owned();

    let source_image = if is_raw {
        apply_linear_to_srgb(composited)
    } else {
        composited
    };

    Ok((source_image, is_raw))
}

fn cached_source_image(
    patch_id: &str,
    current_adjustments: &Value,
    state: &tauri::State<'_, AppState>,
) -> Result<(Arc<RgbImage>, bool), String> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;
    let is_raw =
        crate::negative_conversion::effective_is_raw(loaded_image.is_raw, current_adjustments);
    let key = crate::patched_cache_key(
        &loaded_image.path,
        &adjustments_without_patch(patch_id, current_adjustments),
    );

    let source_image = crate::get_or_compute_stage(&state.cleanup_source_cache, key, || {
        prepare_source_image(patch_id, current_adjustments, state)
            .map(|(image, _)| Arc::new(image.into_rgb8()))
    })?;
    Ok((source_image, is_raw))
}

fn calculate_mask_bounds(
    mask_bitmap: &image::GrayImage,
) -> Result<(usize, usize, usize, usize), String> {
    let (img_w, img_h) = mask_bitmap.dimensions();
    let mask_raw = mask_bitmap.as_raw();
    let img_w_usize = img_w as usize;
    let img_h_usize = img_h as usize;

    let mut min_y = img_h_usize;
    let mut max_y = 0;

    for y in 0..img_h_usize {
        let row_start = y * img_w_usize;
        if mask_raw[row_start..row_start + img_w_usize]
            .iter()
            .any(|&p| p > 0)
        {
            min_y = y;
            break;
        }
    }

    if min_y == img_h_usize {
        return Err("Mask is empty.".to_string());
    }

    for y in (min_y..img_h_usize).rev() {
        let row_start = y * img_w_usize;
        if mask_raw[row_start..row_start + img_w_usize]
            .iter()
            .any(|&p| p > 0)
        {
            max_y = y;
            break;
        }
    }

    let mut min_x = img_w_usize;
    let mut max_x = 0;
    for y in min_y..=max_y {
        let row_start = y * img_w_usize;
        let row = &mask_raw[row_start..row_start + img_w_usize];
        if let Some(first) = row.iter().position(|&p| p > 0)
            && first < min_x
        {
            min_x = first;
        }
        if let Some(last) = row.iter().rposition(|&p| p > 0)
            && last > max_x
        {
            max_x = last;
        }
    }

    Ok((min_x, max_x, min_y, max_y))
}

#[allow(clippy::too_many_arguments)]
fn encode_patch_result(
    color_image: &RgbImage,
    mask_image: &image::GrayImage,
    offset_x: u32,
    offset_y: u32,
    width: u32,
    height: u32,
    is_srgb: bool,
    quality: u8,
    mask_as_png: bool,
) -> Result<Value, String> {
    let mut color_buf = Cursor::new(Vec::with_capacity(32768));
    color_image
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut color_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let color_base64 = general_purpose::STANDARD.encode(color_buf.get_ref());

    let mut mask_buf = Cursor::new(Vec::with_capacity(32768));
    if mask_as_png {
        mask_image
            .write_to(&mut mask_buf, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    } else {
        mask_image
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut mask_buf,
                quality,
            ))
            .map_err(|e| e.to_string())?;
    }
    let mask_base64 = general_purpose::STANDARD.encode(mask_buf.get_ref());

    Ok(serde_json::json!({
        "color": color_base64,
        "mask": mask_base64,
        "offsetX": offset_x,
        "offsetY": offset_y,
        "width": width,
        "height": height,
        "isSrgbEncoded": is_srgb
    }))
}

fn stroke_anchor(sub_masks: &[SubMask]) -> Option<(f64, f64)> {
    let mut bounds = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    let points = sub_masks
        .iter()
        .filter_map(|sm| sm.parameters.get("lines").and_then(|v| v.as_array()))
        .flatten()
        .filter_map(|line| line.get("points").and_then(|v| v.as_array()))
        .flatten();
    for point in points {
        if let (Some(x), Some(y)) = (
            point.get("x").and_then(|v| v.as_f64()),
            point.get("y").and_then(|v| v.as_f64()),
        ) {
            bounds = (
                bounds.0.min(x),
                bounds.1.max(x),
                bounds.2.min(y),
                bounds.3.max(y),
            );
        }
    }
    bounds
        .0
        .is_finite()
        .then(|| ((bounds.0 + bounds.1) / 2.0, (bounds.2 + bounds.3) / 2.0))
}

fn display_point_for(
    target: (f64, f64),
    guess: (f64, f64),
    width: f64,
    height: f64,
    adjustments: &Value,
) -> (f64, f64) {
    let to_raw = |p: (f64, f64)| {
        crate::image_processing::inverse_transform_point(p.0, p.1, width, height, adjustments)
    };
    let mut point = guess;
    for _ in 0..8 {
        let raw = to_raw(point);
        let error = (target.0 - raw.0, target.1 - raw.1);
        if error.0.abs() < 0.01 && error.1.abs() < 0.01 {
            break;
        }
        let dx = to_raw((point.0 + 1.0, point.1));
        let dy = to_raw((point.0, point.1 + 1.0));
        let (j00, j01, j10, j11) = (dx.0 - raw.0, dy.0 - raw.0, dx.1 - raw.1, dy.1 - raw.1);
        let det = j00 * j11 - j01 * j10;
        if det.abs() < 1e-9 {
            break;
        }
        point.0 += (j11 * error.0 - j01 * error.1) / det;
        point.1 += (j00 * error.1 - j10 * error.0) / det;
    }
    point
}

fn visible_area(
    adjustments: &Value,
    width: f64,
    height: f64,
    full_area: (i64, i64, i64, i64),
) -> (i64, i64, i64, i64) {
    let Ok(Crop {
        x,
        y,
        width: w,
        height: h,
    }) = serde_json::from_value::<Crop>(adjustments["crop"].clone())
    else {
        return full_area;
    };
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (cx, cy) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
        let (rx, ry) =
            crate::image_processing::inverse_transform_point(cx, cy, width, height, adjustments);
        (min_x, max_x) = (min_x.min(rx), max_x.max(rx));
        (min_y, max_y) = (min_y.min(ry), max_y.max(ry));
    }
    (
        (min_x.ceil() as i64).max(full_area.0),
        (min_y.ceil() as i64).max(full_area.1),
        (max_x.floor() as i64).min(full_area.2),
        (max_y.floor() as i64).min(full_area.3),
    )
}

#[tauri::command]
pub async fn generate_manual_cleanup_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    source_point: Option<(f64, f64)>,
    source_variant: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_image, is_raw) =
        cached_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();

    let orientation_steps = current_adjustments
        .get("orientationSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u8;
    let (trans_w, trans_h) = if orientation_steps % 2 == 1 {
        (img_h, img_w)
    } else {
        (img_w, img_h)
    };

    let mask_def_for_generation = MaskDefinition {
        id: patch_definition.id.clone(),
        name: patch_definition.name.clone(),
        visible: patch_definition.visible,
        invert: patch_definition.invert,
        opacity: 100.0,
        adjustments: serde_json::Value::Null,
        sub_masks: patch_definition.sub_masks.clone(),
    };

    let warped_image = resolve_warped_image_for_masks(
        &state,
        &current_adjustments,
        std::slice::from_ref(&mask_def_for_generation),
    );

    let mask_bitmap = generate_mask_bitmap(
        &mask_def_for_generation,
        trans_w,
        trans_h,
        1.0,
        (0.0, 0.0),
        warped_image.as_deref(),
    )
    .ok_or("Failed to generate mask bitmap for manual cleanup")?;

    let mask_bitmap =
        crate::image_processing::inverse_transform_mask(mask_bitmap, &current_adjustments);

    let bounds = calculate_mask_bounds(&mask_bitmap)?;
    let (min_x, max_x, min_y, max_y) = bounds;

    let anchor = stroke_anchor(&patch_definition.sub_masks)
        .ok_or("No brush strokes found for this spot.")?;
    let (trans_w, trans_h) = (trans_w as f64, trans_h as f64);
    let raw_anchor = crate::image_processing::inverse_transform_point(
        anchor.0,
        anchor.1,
        trans_w,
        trans_h,
        &current_adjustments,
    );

    let is_heal = patch_definition
        .sub_masks
        .iter()
        .any(|sm| sm.mask_type.eq_ignore_ascii_case("heal"));

    let (offset, picked_source) = match source_point {
        Some((x, y)) => {
            let raw = crate::image_processing::inverse_transform_point(
                x,
                y,
                trans_w,
                trans_h,
                &current_adjustments,
            );
            let offset = (
                (raw.0 - raw_anchor.0).round() as i32,
                (raw.1 - raw_anchor.1).round() as i32,
            );
            (offset, None)
        }
        None => {
            let search = |area| {
                crate::clone_heal::find_source_offset(
                    &source_image,
                    &mask_bitmap,
                    bounds,
                    area,
                    is_heal,
                    source_variant.unwrap_or(0) as usize,
                )
            };
            let full_area = (0, 0, img_w as i64, img_h as i64);
            let offset = search(visible_area(
                &current_adjustments,
                trans_w,
                trans_h,
                full_area,
            ))
            .or_else(|| search(full_area))
            .ok_or("Could not find a matching source area for this spot.")?;
            let target = (
                raw_anchor.0 + offset.0 as f64,
                raw_anchor.1 + offset.1 as f64,
            );
            let guess = (anchor.0 + offset.0 as f64, anchor.1 + offset.1 as f64);
            let display = display_point_for(target, guess, trans_w, trans_h, &current_adjustments);
            (offset, Some(display))
        }
    };

    let color_image = if is_heal {
        crate::clone_heal::heal_patch(&source_image, &mask_bitmap, bounds, offset)
    } else {
        crate::clone_heal::clone_patch(&source_image, &mask_bitmap, bounds, offset)
    };

    let crop_w = (max_x - min_x + 1) as u32;
    let crop_h = (max_y - min_y + 1) as u32;
    let output_mask =
        image::imageops::crop_imm(&mask_bitmap, min_x as u32, min_y as u32, crop_w, crop_h)
            .to_image();

    let mut result = encode_patch_result(
        &color_image,
        &output_mask,
        min_x as u32,
        min_y as u32,
        crop_w,
        crop_h,
        is_raw,
        100,
        false,
    )?;
    if let Some((x, y)) = picked_source {
        result["sourceX"] = serde_json::json!(x);
        result["sourceY"] = serde_json::json!(y);
    }
    Ok(result.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn invoke_generative_replace_with_mask_def(
    path: String,
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    use_fast_inpaint: bool,
    token: Option<String>,
    task_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let _guard = task_id
        .as_ref()
        .map(|id| crate::app_state::AiTaskGuard::new(&state.active_ai_tasks, id.clone()));
    let cancel_flag = _guard.as_ref().map(|g| &g.token);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let (source_image, is_raw) =
        prepare_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();
    let img_w_usize = img_w as usize;
    let img_h_usize = img_h as usize;

    let orientation_steps = current_adjustments
        .get("orientationSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u8;
    let (trans_w, trans_h) = if orientation_steps % 2 == 1 {
        (img_h, img_w)
    } else {
        (img_w, img_h)
    };

    let mask_def_for_generation = MaskDefinition {
        id: patch_definition.id.clone(),
        name: patch_definition.name.clone(),
        visible: patch_definition.visible,
        invert: patch_definition.invert,
        opacity: 100.0,
        adjustments: serde_json::Value::Null,
        sub_masks: patch_definition.sub_masks.clone(),
    };

    let warped_image = resolve_warped_image_for_masks(
        &state,
        &current_adjustments,
        std::slice::from_ref(&mask_def_for_generation),
    );

    let mask_bitmap = generate_mask_bitmap(
        &mask_def_for_generation,
        trans_w,
        trans_h,
        1.0,
        (0.0, 0.0),
        warped_image.as_deref(),
    )
    .ok_or("Failed to generate mask bitmap for AI replace")?;

    let mask_bitmap =
        crate::image_processing::inverse_transform_mask(mask_bitmap, &current_adjustments);

    let (min_x, max_x, min_y, max_y) = calculate_mask_bounds(&mask_bitmap)?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let (final_patch, patch_x, patch_y) = if use_fast_inpaint {
        let lama_model = ai_processing::get_or_init_lama_model(
            &app_handle,
            &state.ai_state,
            &state.ai_init_lock,
        )
        .await
        .map_err(|e| e.to_string())?;

        if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err("Task cancelled".to_string());
        }

        ai_processing::run_lama_inpainting(&source_image, &mask_bitmap, &lama_model)
            .map_err(|e| e.to_string())?
    } else if settings.ai_provider.as_deref() == Some("cloud")
        && let Some(auth_token) = token
    {
        let tight_w = max_x - min_x + 1;
        let tight_h = max_y - min_y + 1;

        let pad_x = tight_w / 2;
        let pad_y = tight_h / 2;

        let padded_min_x = min_x.saturating_sub(pad_x);
        let padded_min_y = min_y.saturating_sub(pad_y);
        let padded_max_x = (max_x + pad_x).min(img_w_usize - 1);
        let padded_max_y = (max_y + pad_y).min(img_h_usize - 1);

        let crop_w = (padded_max_x - padded_min_x + 1) as u32;
        let crop_h = (padded_max_y - padded_min_y + 1) as u32;

        let src_crop = image::imageops::crop_imm(
            &source_image,
            padded_min_x as u32,
            padded_min_y as u32,
            crop_w,
            crop_h,
        )
        .to_image();

        let mask_crop = image::imageops::crop_imm(
            &mask_bitmap,
            padded_min_x as u32,
            padded_min_y as u32,
            crop_w,
            crop_h,
        )
        .to_image();

        let max_pixels = 1_500_000_f32;
        let current_pixels = (crop_w * crop_h) as f32;

        let mut ai_w = crop_w;
        let mut ai_h = crop_h;
        if current_pixels > max_pixels {
            let scale = (max_pixels / current_pixels).sqrt();
            ai_w = (crop_w as f32 * scale) as u32;
            ai_h = (crop_h as f32 * scale) as u32;
        }

        ai_w = (ai_w / 16) * 16;
        ai_h = (ai_h / 16) * 16;

        let resize_needed = ai_w != crop_w || ai_h != crop_h;

        let (final_src_crop, final_mask_crop) = if resize_needed {
            (
                image::imageops::resize(
                    &src_crop,
                    ai_w,
                    ai_h,
                    image::imageops::FilterType::Lanczos3,
                ),
                image::imageops::resize(
                    &mask_crop,
                    ai_w,
                    ai_h,
                    image::imageops::FilterType::Triangle,
                ),
            )
        } else {
            (src_crop, mask_crop)
        };

        let mut rgba_mask = RgbaImage::new(ai_w, ai_h);
        for (src_val, dst_chunk) in final_mask_crop.as_raw().iter().zip(rgba_mask.chunks_mut(4)) {
            let intensity = *src_val;
            dst_chunk[0] = intensity;
            dst_chunk[1] = intensity;
            dst_chunk[2] = intensity;
            dst_chunk[3] = 255;
        }

        let base_url = "https://www.getrapidraw.com/api";

        let dyn_src_crop = DynamicImage::ImageRgba8(final_src_crop);
        let dyn_rgba_mask = DynamicImage::ImageRgba8(rgba_mask);

        let cloud_fut = ai_connector::process_cloud_inpainting(
            base_url,
            &dyn_src_crop,
            &dyn_rgba_mask,
            patch_definition.prompt,
            &auth_token,
        );

        let generated_ai_patch = if let Some(token) = cancel_flag.as_ref() {
            tokio::select! {
                res = cloud_fut => res.map_err(|e| e.to_string())?,
                _ = token.wait_for_cancel() => {
                    return Err("Task cancelled".to_string());
                }
            }
        } else {
            cloud_fut.await.map_err(|e| e.to_string())?
        };

        let generated_ai_patch_rgba = generated_ai_patch.to_rgba8();
        let restored_ai_patch = if resize_needed {
            image::imageops::resize(
                &generated_ai_patch_rgba,
                crop_w,
                crop_h,
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            generated_ai_patch_rgba
        };

        let mut patch_canvas = RgbaImage::new(crop_w, crop_h);
        image::imageops::overlay(&mut patch_canvas, &restored_ai_patch, 0, 0);

        (patch_canvas, padded_min_x as u32, padded_min_y as u32)
    } else if settings.ai_provider.as_deref() == Some("ai-connector")
        && let Some(address) = settings.ai_connector_address
    {
        let base_url = format!("http://{}", address);

        let mut rgba_mask = RgbaImage::new(img_w, img_h);
        for (src_val, dst_chunk) in mask_bitmap.as_raw().iter().zip(rgba_mask.chunks_mut(4)) {
            let intensity = *src_val;
            dst_chunk[0] = intensity;
            dst_chunk[1] = intensity;
            dst_chunk[2] = intensity;
            dst_chunk[3] = 255;
        }
        let mask_image_dynamic = DynamicImage::ImageRgba8(rgba_mask);

        let (real_path_buf, _) = crate::file_management::parse_virtual_path(&path);
        let real_path_str = real_path_buf.to_string_lossy().to_string();

        let inpaint_fut = ai_connector::process_inpainting(
            &base_url,
            &real_path_str,
            &source_image,
            &mask_image_dynamic,
            patch_definition.prompt,
            None,
        );

        let inpainted = if let Some(token) = cancel_flag.as_ref() {
            tokio::select! {
                res = inpaint_fut => res.map_err(|e| e.to_string())?,
                _ = token.wait_for_cancel() => {
                    return Err("Task cancelled".to_string());
                }
            }
        } else {
            inpaint_fut.await.map_err(|e| e.to_string())?
        };
        let inpainted = if inpainted.dimensions() != (img_w, img_h) {
            image::imageops::resize(
                &inpainted,
                img_w,
                img_h,
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            inpainted
        };
        (inpainted, 0, 0)
    } else {
        return Err(
            "No generative backend configured or connection invalid. Please check your AI settings."
                .to_string(),
        );
    };

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let min_x_u32 = min_x as u32;
    let min_y_u32 = min_y as u32;
    let crop_w = (max_x - min_x + 1) as u32;
    let crop_h = (max_y - min_y + 1) as u32;

    let mut color_image = RgbImage::new(crop_w, crop_h);

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px_x = x as u32;
            let px_y = y as u32;
            let mask_value = mask_bitmap.get_pixel(px_x, px_y)[0];

            let out_x = px_x - min_x_u32;
            let out_y = px_y - min_y_u32;

            let px = if mask_value > 0 {
                final_patch
                    .get_pixel_checked(px_x.wrapping_sub(patch_x), px_y.wrapping_sub(patch_y))
                    .copied()
                    .unwrap_or(image::Rgba([0, 0, 0, 0]))
            } else {
                source_image.get_pixel(px_x, px_y)
            };
            color_image.put_pixel(out_x, out_y, Rgb([px[0], px[1], px[2]]));
        }
    }

    let output_mask =
        image::imageops::crop_imm(&mask_bitmap, min_x_u32, min_y_u32, crop_w, crop_h).to_image();

    encode_patch_result(
        &color_image,
        &output_mask,
        min_x_u32,
        min_y_u32,
        crop_w,
        crop_h,
        is_raw,
        95,
        true,
    )
    .map(|v| v.to_string())
}

fn point_to_segment_dist_sq(px: f32, py: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> (f32, f32) {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 {
        return ((px - x1) * (px - x1) + (py - y1) * (py - y1), 0.0);
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    let t = t.clamp(0.0, 1.0);
    let proj_x = x1 + t * dx;
    let proj_y = y1 + t * dy;
    (
        (px - proj_x) * (px - proj_x) + (py - proj_y) * (py - proj_y),
        t,
    )
}

fn bilinear_sample(img: &RgbImage, x: f32, y: f32) -> Rgb<u8> {
    let w = img.width() as i32;
    let h = img.height() as i32;

    let x_floor = x.floor() as i32;
    let y_floor = y.floor() as i32;
    let x_frac = x - x_floor as f32;
    let y_frac = y - y_floor as f32;

    let x0 = x_floor.clamp(0, w - 1) as u32;
    let y0 = y_floor.clamp(0, h - 1) as u32;
    let x1 = (x_floor + 1).clamp(0, w - 1) as u32;
    let y1 = (y_floor + 1).clamp(0, h - 1) as u32;

    let p00 = img.get_pixel(x0, y0);
    let p10 = img.get_pixel(x1, y0);
    let p01 = img.get_pixel(x0, y1);
    let p11 = img.get_pixel(x1, y1);

    let mut out = [0u8; 3];
    for c in 0..3 {
        let val = (p00[c] as f32 * (1.0 - x_frac) * (1.0 - y_frac)
            + p10[c] as f32 * x_frac * (1.0 - y_frac)
            + p01[c] as f32 * (1.0 - x_frac) * y_frac
            + p11[c] as f32 * x_frac * y_frac)
            .clamp(0.0, 255.0);
        out[c] = val as u8;
    }
    Rgb(out)
}

#[tauri::command]
pub async fn generate_liquify_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    _task_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_image, is_raw) =
        cached_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();

    let mut all_points = Vec::new();

    #[derive(Clone, Copy, PartialEq)]
    enum LiquifyMode {
        Push,
        Pinch,
        Expand,
        Twirl,
        Eraser,
    }

    #[derive(Clone)]
    struct Stroke {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        radius: f32,
        radius_sq: f32,
        feather: f32,
        pressure: f32,
        mode: LiquifyMode,
        aabb_min_x: f32,
        aabb_max_x: f32,
        aabb_min_y: f32,
        aabb_max_y: f32,
    }

    let mut strokes = Vec::new();

    let sub_masks_val = serde_json::to_value(&patch_definition.sub_masks).unwrap_or(Value::Null);

    let mut max_brush_radius = 0.0_f32;

    if let Some(arr) = sub_masks_val.as_array() {
        for sm in arr {
            let mask_type = sm.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if mask_type.eq_ignore_ascii_case("liquify") {
                let params = sm.get("parameters");
                let pressure_param = params
                    .and_then(|p| p.get("pressure"))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(50.0) as f32;
                let force = (pressure_param / 100.0).clamp(0.01, 1.0);

                let mode_str = params
                    .and_then(|p| p.get("liquifyMode"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("push");
                let liquify_mode = match mode_str {
                    "pinch" => LiquifyMode::Pinch,
                    "expand" => LiquifyMode::Expand,
                    "twirl" => LiquifyMode::Twirl,
                    _ => LiquifyMode::Push,
                };

                if let Some(lines) = params
                    .and_then(|p| p.get("lines"))
                    .and_then(|v| v.as_array())
                {
                    for line in lines {
                        let tool_str = line.get("tool").and_then(|v| v.as_str()).unwrap_or("brush");
                        let line_mode = if tool_str == "eraser" {
                            LiquifyMode::Eraser
                        } else {
                            liquify_mode
                        };

                        let radius = line
                            .get("brushSize")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(50.0) as f32
                            / 2.0;

                        if radius > max_brush_radius {
                            max_brush_radius = radius;
                        }

                        let feather =
                            line.get("feather").and_then(|v| v.as_f64()).unwrap_or(0.5) as f32;

                        if let Some(pts) = line.get("points").and_then(|v| v.as_array()) {
                            if pts.len() == 1 {
                                if let (Some(x), Some(y)) = (
                                    pts[0].get("x").and_then(|v| v.as_f64()),
                                    pts[0].get("y").and_then(|v| v.as_f64()),
                                ) {
                                    let (xf, yf) = (x as f32, y as f32);
                                    all_points.push((xf, yf, radius));
                                    strokes.push(Stroke {
                                        x1: xf,
                                        y1: yf,
                                        x2: xf,
                                        y2: yf,
                                        radius,
                                        radius_sq: radius * radius,
                                        feather,
                                        pressure: force,
                                        mode: line_mode,
                                        aabb_min_x: xf - radius,
                                        aabb_max_x: xf + radius,
                                        aabb_min_y: yf - radius,
                                        aabb_max_y: yf + radius,
                                    });
                                }
                            } else {
                                let mut prev_pt: Option<(f32, f32)> = None;
                                for p_val in pts {
                                    if let (Some(x), Some(y)) = (
                                        p_val.get("x").and_then(|v| v.as_f64()),
                                        p_val.get("y").and_then(|v| v.as_f64()),
                                    ) {
                                        let (xf, yf) = (x as f32, y as f32);
                                        all_points.push((xf, yf, radius));

                                        if let Some((px, py)) = prev_pt {
                                            strokes.push(Stroke {
                                                x1: px,
                                                y1: py,
                                                x2: xf,
                                                y2: yf,
                                                radius,
                                                radius_sq: radius * radius,
                                                feather,
                                                pressure: force,
                                                mode: line_mode,
                                                aabb_min_x: px.min(xf) - radius,
                                                aabb_max_x: px.max(xf) + radius,
                                                aabb_min_y: py.min(yf) - radius,
                                                aabb_max_y: py.max(yf) + radius,
                                            });
                                        }
                                        prev_pt = Some((xf, yf));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if strokes.is_empty() {
        return Err("No brush strokes found for Liquify.".to_string());
    }

    let mut min_x = img_w as f32;
    let mut min_y = img_h as f32;
    let mut max_x = 0.0_f32;
    let mut max_y = 0.0_f32;

    for (x, y, r) in &all_points {
        if x - r < min_x {
            min_x = x - r;
        }
        if y - r < min_y {
            min_y = y - r;
        }
        if x + r > max_x {
            max_x = x + r;
        }
        if y + r > max_y {
            max_y = y + r;
        }
    }

    let margin = (max_brush_radius * 2.5).clamp(50.0, 300.0);

    min_x -= margin;
    min_y -= margin;
    max_x += margin;
    max_y += margin;

    let min_x_u32 = (min_x as i32).clamp(0, img_w as i32 - 1) as u32;
    let min_y_u32 = (min_y as i32).clamp(0, img_h as i32 - 1) as u32;
    let max_x_u32 = (max_x as i32).clamp(0, img_w as i32 - 1) as u32;
    let max_y_u32 = (max_y as i32).clamp(0, img_h as i32 - 1) as u32;

    let crop_w = max_x_u32 - min_x_u32 + 1;
    let crop_h = max_y_u32 - min_y_u32 + 1;

    let mut color_pixels = vec![0u8; (crop_w * crop_h * 3) as usize];
    let mut mask_pixels = vec![0u8; (crop_w * crop_h) as usize];

    color_pixels
        .par_chunks_mut((crop_w * 3) as usize)
        .zip(mask_pixels.par_chunks_mut(crop_w as usize))
        .enumerate()
        .for_each(|(y, (color_row, mask_row))| {
            let orig_y = y as f32 + min_y_u32 as f32;

            for x in 0..(crop_w as usize) {
                let orig_x = x as f32 + min_x_u32 as f32;
                let mut disp_x = 0.0_f32;
                let mut disp_y = 0.0_f32;

                for stroke in &strokes {
                    if orig_x < stroke.aabb_min_x
                        || orig_x > stroke.aabb_max_x
                        || orig_y < stroke.aabb_min_y
                        || orig_y > stroke.aabb_max_y
                    {
                        continue;
                    }

                    let (dist_sq, t) = point_to_segment_dist_sq(
                        orig_x, orig_y, stroke.x1, stroke.y1, stroke.x2, stroke.y2,
                    );

                    if dist_sq < stroke.radius_sq {
                        let dist = dist_sq.sqrt();
                        let feather = stroke.feather.clamp(0.01, 1.0);
                        let inner_radius = stroke.radius * (1.0 - feather);

                        let elastic_falloff = if dist <= inner_radius {
                            1.0
                        } else {
                            let falloff_t = (dist - inner_radius) / (stroke.radius - inner_radius);
                            let cos_val = 0.5 * (1.0 + (falloff_t * std::f32::consts::PI).cos());
                            cos_val * cos_val
                        };

                        let dx = stroke.x2 - stroke.x1;
                        let dy = stroke.y2 - stroke.y1;
                        let step_dist = (dx * dx + dy * dy).sqrt();

                        let step_factor = if step_dist < 0.001 {
                            0.45
                        } else {
                            (step_dist / stroke.radius).clamp(0.05, 0.6)
                        };

                        match stroke.mode {
                            LiquifyMode::Push => {
                                disp_x -= dx * elastic_falloff * stroke.pressure * 0.6;
                                disp_y -= dy * elastic_falloff * stroke.pressure * 0.6;
                            }
                            LiquifyMode::Pinch => {
                                let proj_x = stroke.x1 + t * dx;
                                let proj_y = stroke.y1 + t * dy;
                                let rx = orig_x - proj_x;
                                let ry = orig_y - proj_y;
                                let strength =
                                    elastic_falloff * stroke.pressure * step_factor * 0.45;
                                disp_x += rx * strength;
                                disp_y += ry * strength;
                            }
                            LiquifyMode::Expand => {
                                let proj_x = stroke.x1 + t * dx;
                                let proj_y = stroke.y1 + t * dy;
                                let rx = orig_x - proj_x;
                                let ry = orig_y - proj_y;
                                let strength =
                                    elastic_falloff * stroke.pressure * step_factor * 0.30;
                                disp_x -= rx * strength;
                                disp_y -= ry * strength;
                            }
                            LiquifyMode::Twirl => {
                                let proj_x = stroke.x1 + t * dx;
                                let proj_y = stroke.y1 + t * dy;
                                let rx = orig_x - proj_x;
                                let ry = orig_y - proj_y;
                                let angle = elastic_falloff * stroke.pressure * step_factor * 1.4;
                                let cos_a = angle.cos();
                                let sin_a = angle.sin();
                                disp_x += (rx * cos_a - ry * sin_a) - rx;
                                disp_y += (rx * sin_a + ry * cos_a) - ry;
                            }
                            LiquifyMode::Eraser => {
                                let erase_strength =
                                    (elastic_falloff * stroke.pressure * step_factor * 5.0)
                                        .clamp(0.0, 1.0);
                                let retain_factor = 1.0 - erase_strength;
                                disp_x *= retain_factor;
                                disp_y *= retain_factor;
                            }
                        }
                    }
                }

                let src_x = orig_x + disp_x;
                let src_y = orig_y + disp_y;

                let disp_sq = disp_x * disp_x + disp_y * disp_y;

                if disp_sq > 0.001 {
                    let displacement = disp_sq.sqrt();
                    let mask_val = (displacement * 255.0).clamp(0.0, 255.0) as u8;
                    let px = bilinear_sample(&source_image, src_x, src_y);

                    color_row[x * 3] = px[0];
                    color_row[x * 3 + 1] = px[1];
                    color_row[x * 3 + 2] = px[2];
                    mask_row[x] = mask_val;
                } else {
                    let px = source_image.get_pixel(orig_x as u32, orig_y as u32);
                    color_row[x * 3] = px[0];
                    color_row[x * 3 + 1] = px[1];
                    color_row[x * 3 + 2] = px[2];
                    mask_row[x] = 0;
                }
            }
        });

    let color_image = RgbImage::from_raw(crop_w, crop_h, color_pixels).unwrap();
    let mask_image = image::GrayImage::from_raw(crop_w, crop_h, mask_pixels).unwrap();

    encode_patch_result(
        &color_image,
        &mask_image,
        min_x_u32,
        min_y_u32,
        crop_w,
        crop_h,
        is_raw,
        100,
        false,
    )
    .map(|v| v.to_string())
}

#[allow(clippy::too_many_arguments)]
fn draw_stroke_to_mask(
    mask: &mut [u8],
    img_w: u32,
    img_h: u32,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    radius: f32,
    feather: f32,
    is_eraser: bool,
) {
    let radius_sq = radius * radius;
    let inner_radius = radius * (1.0 - feather.clamp(0.0, 1.0));

    let min_x = (x1.min(x2) - radius).floor() as i32;
    let min_y = (y1.min(y2) - radius).floor() as i32;
    let max_x = (x1.max(x2) + radius).ceil() as i32;
    let max_y = (y1.max(y2) + radius).ceil() as i32;

    let min_x = min_x.clamp(0, img_w as i32 - 1) as u32;
    let min_y = min_y.clamp(0, img_h as i32 - 1) as u32;
    let max_x = max_x.clamp(0, img_w as i32 - 1) as u32;
    let max_y = max_y.clamp(0, img_h as i32 - 1) as u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px = x as f32;
            let py = y as f32;

            let (dist_sq, _) = point_to_segment_dist_sq(px, py, x1, y1, x2, y2);

            if dist_sq <= radius_sq {
                let dist = dist_sq.sqrt();

                let alpha = if dist <= inner_radius {
                    1.0
                } else {
                    let t = (dist - inner_radius) / (radius - inner_radius);
                    let cos_val = 0.5 * (1.0 + (t * std::f32::consts::PI).cos());
                    cos_val * cos_val
                };

                let added_val = (alpha * 255.0) as u8;
                let idx = (y * img_w + x) as usize;

                if is_eraser {
                    mask[idx] = mask[idx].saturating_sub(added_val);
                } else {
                    mask[idx] = mask[idx].saturating_add(added_val);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn generate_retouch_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    _task_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_image, is_raw) =
        cached_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();

    let mut min_x = img_w as f32;
    let mut min_y = img_h as f32;
    let mut max_x = 0.0_f32;
    let mut max_y = 0.0_f32;
    let mut max_radius = 0.0_f32;
    let mut intensity = 50.0_f32;

    let sub_masks_val = serde_json::to_value(&patch_definition.sub_masks).unwrap_or(Value::Null);
    let mut mask_canvas = vec![0u8; (img_w * img_h) as usize];

    if let Some(arr) = sub_masks_val.as_array() {
        for sm in arr {
            if sm.get("type").and_then(|v| v.as_str()) == Some("retouch")
                && let Some(params) = sm.get("parameters")
            {
                intensity = params
                    .get("intensity")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(50.0) as f32;

                if let Some(lines) = params.get("lines").and_then(|v| v.as_array()) {
                    for line in lines {
                        let r = line
                            .get("brushSize")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(50.0) as f32
                            / 2.0;
                        let feather =
                            line.get("feather").and_then(|v| v.as_f64()).unwrap_or(0.5) as f32;
                        let is_eraser = line.get("tool").and_then(|v| v.as_str()) == Some("eraser");

                        max_radius = max_radius.max(r);

                        if let Some(pts) = line.get("points").and_then(|v| v.as_array()) {
                            if pts.len() == 1 {
                                if let (Some(x), Some(y)) = (
                                    pts[0].get("x").and_then(|v| v.as_f64()),
                                    pts[0].get("y").and_then(|v| v.as_f64()),
                                ) {
                                    let (xf, yf) = (x as f32, y as f32);
                                    min_x = min_x.min(xf - r);
                                    min_y = min_y.min(yf - r);
                                    max_x = max_x.max(xf + r);
                                    max_y = max_y.max(yf + r);

                                    draw_stroke_to_mask(
                                        &mut mask_canvas,
                                        img_w,
                                        img_h,
                                        xf,
                                        yf,
                                        xf,
                                        yf,
                                        r,
                                        feather,
                                        is_eraser,
                                    );
                                }
                            } else {
                                let mut prev: Option<(f32, f32)> = None;
                                for p_val in pts {
                                    if let (Some(x), Some(y)) = (
                                        p_val.get("x").and_then(|v| v.as_f64()),
                                        p_val.get("y").and_then(|v| v.as_f64()),
                                    ) {
                                        let (xf, yf) = (x as f32, y as f32);
                                        min_x = min_x.min(xf - r);
                                        min_y = min_y.min(yf - r);
                                        max_x = max_x.max(xf + r);
                                        max_y = max_y.max(yf + r);

                                        if let Some((px, py)) = prev {
                                            draw_stroke_to_mask(
                                                &mut mask_canvas,
                                                img_w,
                                                img_h,
                                                px,
                                                py,
                                                xf,
                                                yf,
                                                r,
                                                feather,
                                                is_eraser,
                                            );
                                        }
                                        prev = Some((xf, yf));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if min_x > max_x || min_y > max_y {
        return Err("No brush strokes found for Retouch.".to_string());
    }

    let pad = (max_radius * 3.0 + 30.0).ceil();
    let min_x_u32 = (min_x - pad).clamp(0.0, img_w as f32 - 1.0) as u32;
    let min_y_u32 = (min_y - pad).clamp(0.0, img_h as f32 - 1.0) as u32;
    let max_x_u32 = (max_x + pad).clamp(0.0, img_w as f32 - 1.0) as u32;
    let max_y_u32 = (max_y + pad).clamp(0.0, img_h as f32 - 1.0) as u32;
    let crop_w = max_x_u32 - min_x_u32 + 1;
    let crop_h = max_y_u32 - min_y_u32 + 1;

    let orig_crop =
        image::imageops::crop_imm(source_image.as_ref(), min_x_u32, min_y_u32, crop_w, crop_h)
            .to_image();
    let orig_raw = orig_crop.as_raw();

    let mut mask_pixels = vec![0u8; (crop_w * crop_h) as usize];
    for y in 0..crop_h {
        for x in 0..crop_w {
            let m_val = mask_canvas[((y + min_y_u32) * img_w + (x + min_x_u32)) as usize];
            mask_pixels[(y * crop_w + x) as usize] = m_val;
        }
    }

    let norm_intensity = (intensity / 100.0).clamp(0.05, 1.0);
    let sig_s = (1.0 + norm_intensity * 6.0).clamp(1.2, 8.0);
    let sig_c = (8.0 + norm_intensity * 20.0).clamp(8.0, 28.0);

    let sig_s_sq = sig_s * sig_s;
    let sig_c_sq = sig_c * sig_c;

    let r = (sig_s * 2.0).ceil() as i32;
    let window_size = (2 * r + 1) as usize;

    let mut spatial_weights = vec![0.0_f32; window_size * window_size];
    for dy in -r..=r {
        for dx in -r..=r {
            let dist_s = (dx * dx + dy * dy) as f32;
            let w = (-dist_s / (2.0 * sig_s_sq)).exp();
            let idx = ((dy + r) as usize) * window_size + ((dx + r) as usize);
            spatial_weights[idx] = w;
        }
    }

    let max_color_dist_sq = 3 * 255 * 255;
    let color_weights: Vec<f32> = (0..=max_color_dist_sq)
        .map(|i| (-(i as f32) / (2.0 * sig_c_sq)).exp())
        .collect();

    let mut color_pixels = vec![0u8; (crop_w * crop_h * 3) as usize];
    let crop_w_i32 = crop_w as i32;
    let crop_h_i32 = crop_h as i32;
    let crop_w_usize = crop_w as usize;

    color_pixels
        .par_chunks_mut(crop_w_usize * 3)
        .enumerate()
        .for_each(|(y, row_out)| {
            let y_i32 = y as i32;

            for x in 0..crop_w_usize {
                let m_val = mask_pixels[y * crop_w_usize + x];
                let px_idx = (y * crop_w_usize + x) * 3;

                if m_val == 0 {
                    row_out[x * 3] = orig_raw[px_idx];
                    row_out[x * 3 + 1] = orig_raw[px_idx + 1];
                    row_out[x * 3 + 2] = orig_raw[px_idx + 2];
                    continue;
                }

                let m = m_val as f32 / 255.0;
                let smooth_m = m * m * (3.0 - 2.0 * m);
                let blend_factor = smooth_m * (0.3 + norm_intensity * 0.7);

                let ctr_r = orig_raw[px_idx] as i32;
                let ctr_g = orig_raw[px_idx + 1] as i32;
                let ctr_b = orig_raw[px_idx + 2] as i32;

                let mut sum_w = 0.0_f32;
                let mut sum_r = 0.0_f32;
                let mut sum_g = 0.0_f32;
                let mut sum_b = 0.0_f32;

                let x_i32 = x as i32;
                let y_min = (y_i32 - r).max(0);
                let y_max = (y_i32 + r).min(crop_h_i32 - 1);
                let x_min = (x_i32 - r).max(0);
                let x_max = (x_i32 + r).min(crop_w_i32 - 1);

                for ny in y_min..=y_max {
                    let dy = ny - y_i32;
                    let wy_offset = (dy + r) as usize * window_size;
                    let row_offset = (ny as usize) * crop_w_usize;

                    for nx in x_min..=x_max {
                        let dx = nx - x_i32;
                        let spatial_w = spatial_weights[wy_offset + (dx + r) as usize];

                        let n_idx = (row_offset + nx as usize) * 3;
                        let pr = orig_raw[n_idx] as i32;
                        let pg = orig_raw[n_idx + 1] as i32;
                        let pb = orig_raw[n_idx + 2] as i32;

                        let dr = pr - ctr_r;
                        let dg = pg - ctr_g;
                        let db = pb - ctr_b;

                        let color_dist_sq = (dr * dr + dg * dg + db * db) as usize;
                        let w = spatial_w * color_weights[color_dist_sq];

                        sum_w += w;
                        sum_r += (pr as f32) * w;
                        sum_g += (pg as f32) * w;
                        sum_b += (pb as f32) * w;
                    }
                }

                let base_r = sum_r / sum_w;
                let base_g = sum_g / sum_w;
                let base_b = sum_b / sum_w;

                row_out[x * 3] = ((ctr_r as f32) * (1.0 - blend_factor) + base_r * blend_factor)
                    .clamp(0.0, 255.0) as u8;
                row_out[x * 3 + 1] = ((ctr_g as f32) * (1.0 - blend_factor) + base_g * blend_factor)
                    .clamp(0.0, 255.0) as u8;
                row_out[x * 3 + 2] = ((ctr_b as f32) * (1.0 - blend_factor) + base_b * blend_factor)
                    .clamp(0.0, 255.0) as u8;
            }
        });

    let color_image = RgbImage::from_raw(crop_w, crop_h, color_pixels).unwrap();
    let mask_image = image::GrayImage::from_raw(crop_w, crop_h, mask_pixels).unwrap();

    encode_patch_result(
        &color_image,
        &mask_image,
        min_x_u32,
        min_y_u32,
        crop_w,
        crop_h,
        is_raw,
        100,
        false,
    )
    .map(|v| v.to_string())
}
