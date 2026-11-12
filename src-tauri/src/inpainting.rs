use std::io::Cursor;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, Rgb, RgbImage, RgbaImage};
use serde_json::Value;

use crate::ai_connector;
use crate::ai_processing;
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::image_loader::prepare_base_image_cow;
use crate::image_processing::{Crop, apply_linear_to_srgb};
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, SubMask, generate_mask_bitmap};
use crate::resolve_warped_image_for_masks;
use crate::touch_up::{LiquifyMode, LiquifyPoint, LiquifyStroke};

fn adjustments_without_patch(patch_id: &str, current_adjustments: &Value) -> Value {
    let mut adjustments = current_adjustments.clone();
    if let Some(patches) = adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        patches.retain(|p| p.get("id").and_then(|id| id.as_str()) != Some(patch_id));
    }
    if let Some(obj) = adjustments.as_object_mut() {
        obj.insert("aiUpscaleEnabled".to_string(), Value::Bool(false));
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
) -> Result<(Arc<RgbImage>, bool, String), String> {
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
    Ok((source_image, is_raw, loaded_image.path))
}

fn transformed_dimensions(img_w: u32, img_h: u32, adjustments: &Value) -> (u32, u32) {
    let orientation_steps = adjustments
        .get("orientationSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if orientation_steps % 2 == 1 {
        (img_h, img_w)
    } else {
        (img_w, img_h)
    }
}

fn raw_patch_mask(
    patch_definition: &AiPatchDefinition,
    path: &str,
    current_adjustments: &Value,
    state: &tauri::State<'_, AppState>,
    (trans_w, trans_h): (u32, u32),
) -> Result<image::GrayImage, String> {
    let mask_def = MaskDefinition {
        id: patch_definition.id.clone(),
        name: patch_definition.name.clone(),
        visible: patch_definition.visible,
        invert: patch_definition.invert,
        opacity: 100.0,
        adjustments: Value::Null,
        sub_masks: patch_definition.sub_masks.clone(),
    };

    let warped_image =
        resolve_warped_image_for_masks(state, current_adjustments, std::slice::from_ref(&mask_def));

    let mask_bitmap = generate_mask_bitmap(
        &mask_def,
        trans_w,
        trans_h,
        1.0,
        (0.0, 0.0),
        warped_image.as_deref(),
    )
    .ok_or("Failed to generate mask bitmap for this patch")?;

    Ok(crate::image_processing::inverse_transform_mask(
        mask_bitmap,
        path,
        current_adjustments,
    ))
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
    path: &str,
    adjustments: &Value,
) -> (f64, f64) {
    let to_raw = |p: (f64, f64)| {
        crate::image_processing::inverse_transform_point(p.0, p.1, width, height, path, adjustments)
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
    path: &str,
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
        let (rx, ry) = crate::image_processing::inverse_transform_point(
            cx,
            cy,
            width,
            height,
            path,
            adjustments,
        );
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
    let (source_image, is_raw, path) =
        cached_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();
    let (trans_w, trans_h) = transformed_dimensions(img_w, img_h, &current_adjustments);

    let mask_bitmap = raw_patch_mask(
        &patch_definition,
        &path,
        &current_adjustments,
        &state,
        (trans_w, trans_h),
    )?;

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
        &path,
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
                &path,
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
                &path,
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
            let display =
                display_point_for(target, guess, trans_w, trans_h, &path, &current_adjustments);
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
        crate::image_processing::inverse_transform_mask(mask_bitmap, &path, &current_adjustments);

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

fn line_points(line: &Value) -> Vec<(f64, f64)> {
    line.get("points")
        .and_then(|v| v.as_array())
        .map(|points| {
            points
                .iter()
                .filter_map(|p| Some((p.get("x")?.as_f64()?, p.get("y")?.as_f64()?)))
                .collect()
        })
        .unwrap_or_default()
}

fn line_radius(line: &Value) -> f32 {
    line.get("brushSize")
        .and_then(|v| v.as_f64())
        .unwrap_or(50.0) as f32
        / 2.0
}

fn is_eraser_line(line: &Value) -> bool {
    line.get("tool").and_then(|v| v.as_str()) == Some("eraser")
}

#[tauri::command]
pub async fn generate_liquify_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    _task_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_image, is_raw, path) =
        cached_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();
    let (trans_w, trans_h) = transformed_dimensions(img_w, img_h, &current_adjustments);
    let to_raw = |x: f64, y: f64| {
        crate::image_processing::inverse_transform_point(
            x,
            y,
            trans_w as f64,
            trans_h as f64,
            &path,
            &current_adjustments,
        )
    };

    let mut strokes = Vec::new();
    for sm in patch_definition
        .sub_masks
        .iter()
        .filter(|sm| sm.mask_type.eq_ignore_ascii_case("liquify"))
    {
        let params = &sm.parameters;
        let pressure = (params
            .get("pressure")
            .and_then(|v| v.as_f64())
            .unwrap_or(50.0) as f32
            / 100.0)
            .clamp(0.01, 1.0);
        let layer_mode = LiquifyMode::from_name(
            params
                .get("liquifyMode")
                .and_then(|v| v.as_str())
                .unwrap_or("push"),
        );
        let lines = params.get("lines").and_then(|v| v.as_array());

        for line in lines.into_iter().flatten() {
            let mode = if is_eraser_line(line) {
                LiquifyMode::Reconstruct
            } else {
                layer_mode
            };
            let radius = line_radius(line);
            let points = line_points(line)
                .into_iter()
                .map(|(x, y)| {
                    let c = to_raw(x, y);
                    let ex = to_raw(x + 1.0, y);
                    let ey = to_raw(x, y + 1.0);
                    let det = (ex.0 - c.0) * (ey.1 - c.1) - (ex.1 - c.1) * (ey.0 - c.0);
                    LiquifyPoint {
                        x: c.0 as f32,
                        y: c.1 as f32,
                        radius: radius * det.abs().sqrt() as f32,
                        handedness: if det < 0.0 { -1.0 } else { 1.0 },
                    }
                })
                .collect();
            strokes.push(LiquifyStroke {
                points,
                mode,
                pressure,
                feather: line.get("feather").and_then(|v| v.as_f64()).unwrap_or(0.5) as f32,
            });
        }
    }

    let (color_image, mask_image, (offset_x, offset_y)) =
        crate::touch_up::liquify_patch(&source_image, &strokes)
            .ok_or("No brush strokes found for Liquify.")?;

    encode_patch_result(
        &color_image,
        &mask_image,
        offset_x,
        offset_y,
        color_image.width(),
        color_image.height(),
        is_raw,
        100,
        true,
    )
    .map(|v| v.to_string())
}

#[tauri::command]
pub async fn generate_retouch_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    _task_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_image, is_raw, path) =
        cached_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_image.dimensions();

    let retouch = patch_definition
        .sub_masks
        .iter()
        .find(|sm| sm.mask_type.eq_ignore_ascii_case("retouch"))
        .ok_or("No brush strokes found for Retouch.")?;
    let intensity = retouch
        .parameters
        .get("intensity")
        .and_then(|v| v.as_f64())
        .unwrap_or(50.0) as f32;
    let brush_radius = retouch
        .parameters
        .get("lines")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|line| !is_eraser_line(line))
        .map(line_radius)
        .fold(0.0_f32, f32::max);

    let mask_bitmap = raw_patch_mask(
        &patch_definition,
        &path,
        &current_adjustments,
        &state,
        transformed_dimensions(img_w, img_h, &current_adjustments),
    )?;
    let bounds = calculate_mask_bounds(&mask_bitmap)
        .map_err(|_| "No brush strokes found for Retouch.".to_string())?;
    let (min_x, max_x, min_y, max_y) = bounds;

    let color_image =
        crate::touch_up::retouch_patch(&source_image, bounds, brush_radius, intensity / 100.0);

    let crop_w = (max_x - min_x + 1) as u32;
    let crop_h = (max_y - min_y + 1) as u32;
    let output_mask =
        image::imageops::crop_imm(&mask_bitmap, min_x as u32, min_y as u32, crop_w, crop_h)
            .to_image();

    encode_patch_result(
        &color_image,
        &output_mask,
        min_x as u32,
        min_y as u32,
        crop_w,
        crop_h,
        is_raw,
        100,
        true,
    )
    .map(|v| v.to_string())
}
