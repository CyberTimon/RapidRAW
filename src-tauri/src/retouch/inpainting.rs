use std::io::Cursor;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, GrayImage, Rgb, RgbImage, RgbaImage};
use serde_json::Value;

use crate::ai::{connector, lama, models};
use crate::app::settings::load_settings;
use crate::app::state::AppState;
use crate::decode::image_loader::prepare_base_image_cow;
use crate::masks::generation::{
    AiPatchDefinition, MaskDefinition, SubMask, generate_mask_bitmap,
    resolve_warped_image_for_masks,
};
use crate::masks::morphology::{gaussian_blur_mask, grayscale_dilate};
use crate::render::geometry::{Crop, inverse_transform_mask, inverse_transform_point};
use crate::render::image_processing::apply_linear_to_srgb;
use crate::render::preview::{get_or_compute_stage, patched_cache_key};
use crate::retouch::touch_up::{LiquifyMode, LiquifyPoint, LiquifyStroke};

const CLOUD_API_URL: &str = "https://www.getrapidraw.com/api";
const CLOUD_MAX_SIDE: u32 = 2048;
const CLOUD_MIN_CONTEXT: u32 = 1024;
const FILL_THRESHOLD: u8 = 16;

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
    let is_raw = crate::adjustments::negative_conversion::effective_is_raw(
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
    let is_raw = crate::adjustments::negative_conversion::effective_is_raw(
        loaded_image.is_raw,
        current_adjustments,
    );
    let key = patched_cache_key(
        &loaded_image.path,
        &adjustments_without_patch(patch_id, current_adjustments),
    );

    let source_image = get_or_compute_stage(&state.cleanup_source_cache, key, || {
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

    Ok(inverse_transform_mask(
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
    let to_raw =
        |p: (f64, f64)| inverse_transform_point(p.0, p.1, width, height, path, adjustments);
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
        let (rx, ry) = inverse_transform_point(cx, cy, width, height, path, adjustments);
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
    let raw_anchor = inverse_transform_point(
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
            let raw = inverse_transform_point(x, y, trans_w, trans_h, &path, &current_adjustments);
            let offset = (
                (raw.0 - raw_anchor.0).round() as i32,
                (raw.1 - raw_anchor.1).round() as i32,
            );
            (offset, None)
        }
        None => {
            let search = |area| {
                crate::retouch::clone_heal::find_source_offset(
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
        crate::retouch::clone_heal::heal_patch(&source_image, &mask_bitmap, bounds, offset)
    } else {
        crate::retouch::clone_heal::clone_patch(&source_image, &mask_bitmap, bounds, offset)
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
        .map(|id| crate::app::state::AiTaskGuard::new(&state.active_ai_tasks, id.clone()));
    let cancel_flag = _guard.as_ref().map(|g| &g.token);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let (source_image, is_raw) =
        prepare_source_image(&patch_definition.id, &current_adjustments, &state)?;
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
    .ok_or("Failed to generate mask bitmap for AI replace")?;

    let mask_bitmap = inverse_transform_mask(mask_bitmap, &path, &current_adjustments);
    let (fill_mask, blend_mask) = generation_masks(&mask_bitmap)?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let (final_patch, patch_x, patch_y) = if use_fast_inpaint {
        let lama_model =
            models::get_or_init_lama_model(&app_handle, &state.ai_state, &state.ai_init_lock)
                .await
                .map_err(|e| e.to_string())?;

        if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err("Task cancelled".to_string());
        }

        lama::run_lama_inpainting(&source_image, &fill_mask, &lama_model)
            .map_err(|e| e.to_string())?
    } else if settings.ai_provider.as_deref() == Some("cloud")
        && let Some(auth_token) = token
    {
        let cloud_fut = cloud_inpaint(
            &source_image,
            &fill_mask,
            patch_definition.prompt,
            &auth_token,
        );

        if let Some(token) = cancel_flag.as_ref() {
            tokio::select! {
                res = cloud_fut => res?,
                _ = token.wait_for_cancel() => {
                    return Err("Task cancelled".to_string());
                }
            }
        } else {
            cloud_fut.await?
        }
    } else if settings.ai_provider.as_deref() == Some("ai-connector")
        && let Some(address) = settings.ai_connector_address
    {
        let base_url = format!("http://{}", address);

        let mut rgba_mask = RgbaImage::new(img_w, img_h);
        for (src_val, dst_chunk) in fill_mask.as_raw().iter().zip(rgba_mask.chunks_mut(4)) {
            let intensity = *src_val;
            dst_chunk[0] = intensity;
            dst_chunk[1] = intensity;
            dst_chunk[2] = intensity;
            dst_chunk[3] = 255;
        }
        let mask_image_dynamic = DynamicImage::ImageRgba8(rgba_mask);

        let (real_path_buf, _) = crate::library::sidecars::parse_virtual_path(&path);
        let real_path_str = real_path_buf.to_string_lossy().to_string();

        let inpaint_fut = connector::process_inpainting(
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

    encode_generated_patch(
        &source_image,
        &final_patch,
        (patch_x, patch_y),
        &blend_mask,
        is_raw,
    )
    .map(|v| v.to_string())
}

fn generation_masks(mask: &GrayImage) -> Result<(GrayImage, GrayImage), String> {
    let (min_x, max_x, min_y, max_y) = calculate_mask_bounds(mask)?;
    let diagonal = ((max_x - min_x + 1) as f32).hypot((max_y - min_y + 1) as f32);
    let radius = (diagonal * 0.012).round().clamp(4.0, 24.0) as u32;

    let (w, h) = mask.dimensions();
    let margin = radius * 2 + 2;
    let x0 = (min_x as u32).saturating_sub(margin);
    let y0 = (min_y as u32).saturating_sub(margin);
    let x1 = (max_x as u32 + margin + 1).min(w);
    let y1 = (max_y as u32 + margin + 1).min(h);

    let mut core = image::imageops::crop_imm(mask, x0, y0, x1 - x0, y1 - y0).to_image();
    let threshold = FILL_THRESHOLD.min(core.iter().copied().max().unwrap_or(1).max(1));
    core.iter_mut()
        .for_each(|v| *v = if *v >= threshold { 255 } else { 0 });

    let fill = grayscale_dilate(&core, (radius * 2) as u8);
    let mut blend = gaussian_blur_mask(&grayscale_dilate(&core, radius as u8), radius as f32 / 2.0);
    blend
        .iter_mut()
        .zip(core.iter())
        .for_each(|(b, c)| *b = (*b).max(*c));

    let mut fill_mask = GrayImage::new(w, h);
    let mut blend_mask = GrayImage::new(w, h);
    image::imageops::replace(&mut fill_mask, &fill, x0 as i64, y0 as i64);
    image::imageops::replace(&mut blend_mask, &blend, x0 as i64, y0 as i64);
    Ok((fill_mask, blend_mask))
}

fn context_window(min: usize, max: usize, limit: u32) -> (u32, u32) {
    let size = (((max - min + 1) * 2) as u32)
        .max(CLOUD_MIN_CONTEXT)
        .min(limit);
    let center = (min + max).div_ceil(2) as u32;
    (center.saturating_sub(size / 2).min(limit - size), size)
}

async fn cloud_inpaint(
    source_image: &DynamicImage,
    fill_mask: &GrayImage,
    prompt: String,
    token: &str,
) -> Result<(RgbaImage, u32, u32), String> {
    let (img_w, img_h) = source_image.dimensions();
    let (min_x, max_x, min_y, max_y) = calculate_mask_bounds(fill_mask)?;
    let (crop_x, crop_w) = context_window(min_x, max_x, img_w);
    let (crop_y, crop_h) = context_window(min_y, max_y, img_h);

    let src_crop =
        image::imageops::crop_imm(source_image, crop_x, crop_y, crop_w, crop_h).to_image();
    let mask_crop = image::imageops::crop_imm(fill_mask, crop_x, crop_y, crop_w, crop_h).to_image();

    let scale = (CLOUD_MAX_SIDE as f32 / crop_w.max(crop_h) as f32).min(1.0);
    let (model_src, model_mask) = if scale < 1.0 {
        let ai_w = ((crop_w as f32 * scale).round() as u32).max(1);
        let ai_h = ((crop_h as f32 * scale).round() as u32).max(1);
        let mut mask = image::imageops::resize(
            &mask_crop,
            ai_w,
            ai_h,
            image::imageops::FilterType::Triangle,
        );
        mask.iter_mut().filter(|v| **v > 0).for_each(|v| *v = 255);
        (
            image::imageops::resize(&src_crop, ai_w, ai_h, image::imageops::FilterType::Lanczos3),
            mask,
        )
    } else {
        (src_crop.clone(), mask_crop.clone())
    };

    let generated = connector::process_cloud_inpainting(
        CLOUD_API_URL,
        &DynamicImage::ImageRgba8(model_src),
        &DynamicImage::ImageLuma8(model_mask),
        prompt,
        token,
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut patch = generated.to_rgba8();
    if patch.dimensions() != (crop_w, crop_h) {
        patch = image::imageops::resize(
            &patch,
            crop_w,
            crop_h,
            image::imageops::FilterType::Lanczos3,
        );
    }
    match_tone(&mut patch, &src_crop, &mask_crop);
    let float_crop = source_image
        .crop_imm(crop_x, crop_y, crop_w, crop_h)
        .to_rgb32f();
    match_grain(&mut patch, &float_crop, &mask_crop);

    Ok((patch, crop_x, crop_y))
}

fn match_tone(patch: &mut RgbaImage, source: &RgbaImage, fill: &GrayImage) {
    let (w, h) = patch.dimensions();
    let cell = (w.max(h) / 160).max(4);
    let (gw, gh) = (w.div_ceil(cell) as usize, h.div_ceil(cell) as usize);
    let mut sums = vec![[0.0f32; 3]; gw * gh];
    let mut counts = vec![0u32; gw * gh];

    for (x, y, p) in patch.enumerate_pixels() {
        if fill.get_pixel(x, y)[0] > 0 {
            continue;
        }
        let s = source.get_pixel(x, y);
        let i = (y / cell) as usize * gw + (x / cell) as usize;
        for c in 0..3 {
            sums[i][c] += s[c] as f32 - p[c] as f32;
        }
        counts[i] += 1;
    }

    let mut field = vec![[0.0f32; 3]; gw * gh];
    let mut known = vec![false; gw * gh];
    let mut mean = [0.0f32; 3];
    let mut known_count = 0;
    for i in 0..gw * gh {
        if counts[i] < cell * cell / 4 {
            continue;
        }
        let d = sums[i].map(|v| v / counts[i] as f32);
        if d.iter().map(|v| v.abs()).sum::<f32>() > 24.0 {
            continue;
        }
        field[i] = d;
        known[i] = true;
        known_count += 1;
        for c in 0..3 {
            mean[c] += d[c];
        }
    }
    if known_count == 0 {
        return;
    }
    let mean = mean.map(|v| v / known_count as f32);
    for i in 0..gw * gh {
        if !known[i] {
            field[i] = mean;
        }
    }

    for _ in 0..400 {
        for gy in 0..gh {
            for gx in 0..gw {
                let i = gy * gw + gx;
                if known[i] {
                    continue;
                }
                let mut acc = [0.0f32; 3];
                let mut n = 0.0;
                for (nx, ny) in [
                    (gx.wrapping_sub(1), gy),
                    (gx + 1, gy),
                    (gx, gy.wrapping_sub(1)),
                    (gx, gy + 1),
                ] {
                    if nx < gw && ny < gh {
                        let v = field[ny * gw + nx];
                        for c in 0..3 {
                            acc[c] += v[c];
                        }
                        n += 1.0;
                    }
                }
                field[i] = acc.map(|v| v / n);
            }
        }
    }

    let sample = |fx: f32, fy: f32| {
        let fx = fx.clamp(0.0, (gw - 1) as f32);
        let fy = fy.clamp(0.0, (gh - 1) as f32);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(gw - 1), (y0 + 1).min(gh - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let mut out = [0.0f32; 3];
        for (c, o) in out.iter_mut().enumerate() {
            let top = field[y0 * gw + x0][c] * (1.0 - tx) + field[y0 * gw + x1][c] * tx;
            let bottom = field[y1 * gw + x0][c] * (1.0 - tx) + field[y1 * gw + x1][c] * tx;
            *o = top * (1.0 - ty) + bottom * ty;
        }
        out
    };

    for (x, y, p) in patch.enumerate_pixels_mut() {
        if fill.get_pixel(x, y)[0] == 0 {
            continue;
        }
        let d = sample(
            (x as f32 + 0.5) / cell as f32 - 0.5,
            (y as f32 + 0.5) / cell as f32 - 0.5,
        );
        for c in 0..3 {
            p[c] = (p[c] as f32 + d[c]).round().clamp(0.0, 255.0) as u8;
        }
    }
}

fn luma_noise_sigma(
    (w, h): (u32, u32),
    luma: impl Fn(u32, u32) -> f32,
    include: impl Fn(u32, u32) -> bool,
) -> Option<f32> {
    let mut residuals = Vec::new();
    for y in (1..h.saturating_sub(1)).step_by(2) {
        for x in (1..w.saturating_sub(1)).step_by(2) {
            if !include(x, y) {
                continue;
            }
            let mut sum = 0.0;
            for dy in 0..3 {
                for dx in 0..3 {
                    sum += luma(x + dx - 1, y + dy - 1);
                }
            }
            residuals.push((luma(x, y) - sum / 9.0).abs());
        }
    }
    if residuals.len() < 256 {
        return None;
    }
    let mid = residuals.len() / 2;
    let (_, median, _) = residuals.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    Some(*median * 1.4826 / (8.0f32 / 9.0).sqrt())
}

fn mix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn gaussian_noise(x: u32, y: u32) -> f32 {
    let a = mix64(((y as u64) << 32) | x as u64);
    let b = mix64(a);
    let u1 = ((a >> 40) as f32 + 1.0) / (1u32 << 24) as f32;
    let u2 = (b >> 40) as f32 / (1u32 << 24) as f32;
    (-2.0 * u1.ln()).sqrt() * (std::f32::consts::TAU * u2).cos()
}

fn match_grain(patch: &mut RgbaImage, source: &image::Rgb32FImage, fill: &GrayImage) {
    const STEP: u32 = 8;
    const QUANTIZATION_VARIANCE: f32 = 1.0 / 12.0;
    let (w, h) = fill.dimensions();
    let mut coarse = GrayImage::new(w.div_ceil(STEP), h.div_ceil(STEP));
    for (x, y, v) in fill.enumerate_pixels() {
        let c = coarse.get_pixel_mut(x / STEP, y / STEP);
        c[0] = c[0].max(v[0]);
    }
    let ring = grayscale_dilate(&coarse, 6);

    let source_luma = |x: u32, y: u32| {
        let p = source.get_pixel(x, y);
        (p[0].clamp(0.0, 1.0) + p[1].clamp(0.0, 1.0) + p[2].clamp(0.0, 1.0)) * 85.0
    };
    let patch_luma = |x: u32, y: u32| {
        let p = patch.get_pixel(x, y);
        (p[0] as f32 + p[1] as f32 + p[2] as f32) / 3.0
    };
    let Some(source_sigma) = luma_noise_sigma((w, h), source_luma, |x, y| {
        fill.get_pixel(x, y)[0] == 0 && ring.get_pixel(x / STEP, y / STEP)[0] > 0
    }) else {
        return;
    };
    let Some(patch_sigma) =
        luma_noise_sigma((w, h), patch_luma, |x, y| fill.get_pixel(x, y)[0] > 0)
    else {
        return;
    };

    let patch_variance = (patch_sigma * patch_sigma - QUANTIZATION_VARIANCE).max(0.0);
    let missing = (source_sigma * source_sigma - patch_variance)
        .max(0.0)
        .sqrt();
    if missing < 0.1 {
        return;
    }
    for (x, y, pixel) in patch.enumerate_pixels_mut() {
        if fill.get_pixel(x, y)[0] == 0 {
            continue;
        }
        let n = gaussian_noise(x, y) * missing;
        for c in &mut pixel.0[..3] {
            *c = (*c as f32 + n).round().clamp(0.0, 255.0) as u8;
        }
    }
}

fn encode_generated_patch(
    source_image: &DynamicImage,
    final_patch: &RgbaImage,
    (patch_x, patch_y): (u32, u32),
    blend_mask: &GrayImage,
    is_raw: bool,
) -> Result<Value, String> {
    let (min_x, max_x, min_y, max_y) = calculate_mask_bounds(blend_mask)?;
    let (min_x, min_y) = (min_x as u32, min_y as u32);
    let crop_w = (max_x as u32) - min_x + 1;
    let crop_h = (max_y as u32) - min_y + 1;

    let color_image = RgbImage::from_fn(crop_w, crop_h, |out_x, out_y| {
        let (x, y) = (out_x + min_x, out_y + min_y);
        let px = if blend_mask.get_pixel(x, y)[0] > 0 {
            final_patch
                .get_pixel_checked(x.wrapping_sub(patch_x), y.wrapping_sub(patch_y))
                .copied()
                .unwrap_or(image::Rgba([0, 0, 0, 0]))
        } else {
            source_image.get_pixel(x, y)
        };
        Rgb([px[0], px[1], px[2]])
    });

    let output_mask =
        image::imageops::crop_imm(blend_mask, min_x, min_y, crop_w, crop_h).to_image();

    encode_patch_result(
        &color_image,
        &output_mask,
        min_x,
        min_y,
        crop_w,
        crop_h,
        is_raw,
        95,
        true,
    )
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
        inverse_transform_point(
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
        crate::retouch::touch_up::liquify_patch(&source_image, &strokes)
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

    let color_image = crate::retouch::touch_up::retouch_patch(
        &source_image,
        bounds,
        brush_radius,
        intensity / 100.0,
    );

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
