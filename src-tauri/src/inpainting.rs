use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, Rgb, RgbImage, RgbaImage};
use serde_json::Value;

use crate::ai_connector;
use crate::ai_processing;
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::image_loader::composite_patches_on_image;
use crate::image_processing::apply_linear_to_srgb;
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, generate_mask_bitmap};
use crate::resolve_warped_image_for_masks;

#[tauri::command]
pub async fn generate_manual_cleanup_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    source_point: (f64, f64),
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut source_image_adjustments = current_adjustments.clone();
    if let Some(patches) = source_image_adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        patches.retain(|p| p.get("id").and_then(|id| id.as_str()) != Some(&patch_definition.id));
    }

    let is_raw = {
        let guard = state.original_image.lock().unwrap();
        guard.as_ref().map(|img| img.is_raw).unwrap_or(false)
    };

    let (base_image, _) = crate::get_original_image(&state)?;
    let composited = composite_patches_on_image(&base_image, &source_image_adjustments)
        .map_err(|e| format!("Failed to prepare source image: {}", e))?;

    let source_image = if is_raw {
        apply_linear_to_srgb(composited)
    } else {
        composited
    };

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

    let center_x = (min_x + max_x) as f64 / 2.0;
    let center_y = (min_y + max_y) as f64 / 2.0;

    let source_point_untransformed = crate::image_processing::inverse_transform_point(
        source_point.0,
        source_point.1,
        trans_w as f64,
        trans_h as f64,
        &current_adjustments,
    );

    let offset_x = (source_point_untransformed.0 - center_x).round() as i32;
    let offset_y = (source_point_untransformed.1 - center_y).round() as i32;

    let min_x_u32 = min_x as u32;
    let min_y_u32 = min_y as u32;
    let crop_w = (max_x - min_x + 1) as u32;
    let crop_h = (max_y - min_y + 1) as u32;

    let sub_masks_val = serde_json::to_value(&patch_definition.sub_masks).unwrap_or(Value::Null);
    let mut is_heal = false;
    if let Some(arr) = sub_masks_val.as_array() {
        for sm in arr {
            if let Some(t) = sm.get("type").and_then(|v| v.as_str())
                && t.eq_ignore_ascii_case("heal")
            {
                is_heal = true;
                break;
            }
        }
    }
    if !is_heal && patch_definition.name.to_lowercase().contains("heal") {
        is_heal = true;
    }

    let mut color_image = RgbImage::new(crop_w, crop_h);

    if !is_heal {
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let px_x = x as u32;
                let px_y = y as u32;
                if mask_bitmap.get_pixel(px_x, px_y)[0] > 0 {
                    let src_x = (px_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
                    let src_y = (px_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
                    let src_px = source_image.get_pixel(src_x, src_y);

                    let dest_x = px_x - min_x_u32;
                    let dest_y = px_y - min_y_u32;
                    color_image.put_pixel(dest_x, dest_y, Rgb([src_px[0], src_px[1], src_px[2]]));
                }
            }
        }
    } else {
        let bw = max_x - min_x + 3;
        let bh = max_y - min_y + 3;

        let mut v_r = vec![0.0f32; bw * bh];
        let mut v_g = vec![0.0f32; bw * bh];
        let mut v_b = vec![0.0f32; bw * bh];

        let mut region = vec![0u8; bw * bh];

        for y in 0..bh {
            for x in 0..bw {
                let img_x = min_x as i32 + x as i32 - 1;
                let img_y = min_y as i32 + y as i32 - 1;

                if img_x >= 0
                    && img_x < img_w as i32
                    && img_y >= 0
                    && img_y < img_h as i32
                    && mask_bitmap.get_pixel(img_x as u32, img_y as u32)[0] > 0
                {
                    region[y * bw + x] = 1;
                }
            }
        }

        let mut omega_coords = Vec::with_capacity(bw * bh);

        for y in 1..(bh - 1) {
            for x in 1..(bw - 1) {
                if region[y * bw + x] == 0 {
                    if region[(y - 1) * bw + x] == 1
                        || region[(y + 1) * bw + x] == 1
                        || region[y * bw + x - 1] == 1
                        || region[y * bw + x + 1] == 1
                    {
                        region[y * bw + x] = 2;

                        let img_x = (min_x as i32 + x as i32 - 1) as u32;
                        let img_y = (min_y as i32 + y as i32 - 1) as u32;

                        let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
                        let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;

                        let dest_px = source_image.get_pixel(img_x, img_y);
                        let src_px = source_image.get_pixel(src_x, src_y);

                        v_r[y * bw + x] = dest_px[0] as f32 - src_px[0] as f32;
                        v_g[y * bw + x] = dest_px[1] as f32 - src_px[1] as f32;
                        v_b[y * bw + x] = dest_px[2] as f32 - src_px[2] as f32;
                    }
                } else if region[y * bw + x] == 1 {
                    omega_coords.push((x, y));
                }
            }
        }

        let omega = 1.6f32;
        let iterations = 400;

        for _ in 0..iterations {
            for &(x, y) in &omega_coords {
                let idx = y * bw + x;
                let sum_r = v_r[idx - bw] + v_r[idx + bw] + v_r[idx - 1] + v_r[idx + 1];
                let sum_g = v_g[idx - bw] + v_g[idx + bw] + v_g[idx - 1] + v_g[idx + 1];
                let sum_b = v_b[idx - bw] + v_b[idx + bw] + v_b[idx - 1] + v_b[idx + 1];

                v_r[idx] = (1.0 - omega) * v_r[idx] + omega * 0.25 * sum_r;
                v_g[idx] = (1.0 - omega) * v_g[idx] + omega * 0.25 * sum_g;
                v_b[idx] = (1.0 - omega) * v_b[idx] + omega * 0.25 * sum_b;
            }
        }
        for &(x, y) in &omega_coords {
            let img_x = (min_x as i32 + x as i32 - 1) as u32;
            let img_y = (min_y as i32 + y as i32 - 1) as u32;

            let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
            let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
            let src_px = source_image.get_pixel(src_x, src_y);

            let idx = y * bw + x;
            let out_r = (src_px[0] as f32 + v_r[idx]).clamp(0.0, 255.0) as u8;
            let out_g = (src_px[1] as f32 + v_g[idx]).clamp(0.0, 255.0) as u8;
            let out_b = (src_px[2] as f32 + v_b[idx]).clamp(0.0, 255.0) as u8;

            let out_x = img_x as i32 - min_x as i32;
            let out_y = img_y as i32 - min_y as i32;
            if out_x >= 0 && out_x < crop_w as i32 && out_y >= 0 && out_y < crop_h as i32 {
                color_image.put_pixel(out_x as u32, out_y as u32, Rgb([out_r, out_g, out_b]));
            }
        }
    }

    let quality = 100;

    let output_mask =
        image::imageops::crop_imm(&mask_bitmap, min_x_u32, min_y_u32, crop_w, crop_h).to_image();

    let mut color_buf = Cursor::new(Vec::with_capacity(32768));
    color_image
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut color_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let color_base64 = general_purpose::STANDARD.encode(color_buf.get_ref());

    let mut mask_buf = Cursor::new(Vec::with_capacity(32768));
    output_mask
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut mask_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let mask_base64 = general_purpose::STANDARD.encode(mask_buf.get_ref());

    let result_json = serde_json::json!({
        "color": color_base64,
        "mask": mask_base64,
        "offsetX": min_x_u32,
        "offsetY": min_y_u32,
        "width": crop_w,
        "height": crop_h,
        "isSrgbEncoded": is_raw
    })
    .to_string();

    Ok(result_json)
}

#[tauri::command]
pub async fn invoke_generative_replace_with_mask_def(
    path: String,
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    use_fast_inpaint: bool,
    token: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let mut source_image_adjustments = current_adjustments.clone();
    if let Some(patches) = source_image_adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        patches.retain(|p| p.get("id").and_then(|id| id.as_str()) != Some(&patch_definition.id));
    }

    let is_raw = {
        let guard = state.original_image.lock().unwrap();
        guard.as_ref().map(|img| img.is_raw).unwrap_or(false)
    };

    let (base_image, _) = crate::get_original_image(&state)?;
    let composited = composite_patches_on_image(&base_image, &source_image_adjustments)
        .map_err(|e| format!("Failed to prepare source image: {}", e))?;

    let source_image = if is_raw {
        apply_linear_to_srgb(composited)
    } else {
        composited
    };

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

    let mask_bitmap =
        crate::image_processing::inverse_transform_mask(mask_bitmap, &current_adjustments);

    let patch_rgba = if use_fast_inpaint {
        let lama_model = ai_processing::get_or_init_lama_model(
            &app_handle,
            &state.ai_state,
            &state.ai_init_lock,
        )
        .await
        .map_err(|e| e.to_string())?;

        ai_processing::run_lama_inpainting(&source_image, &mask_bitmap, &lama_model)
            .map_err(|e| e.to_string())?
    } else if settings.ai_provider.as_deref() == Some("cloud")
        && let Some(auth_token) = token
    {
        let base_url = "https://getrapidraw.com/api";

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

        ai_connector::process_inpainting(
            base_url,
            &real_path_buf.to_string_lossy(),
            &source_image,
            &mask_image_dynamic,
            patch_definition.prompt,
            Some(&auth_token),
        )
        .await
        .map_err(|e| e.to_string())?
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

        ai_connector::process_inpainting(
            &base_url,
            &real_path_buf.to_string_lossy(),
            &source_image,
            &mask_image_dynamic,
            patch_definition.prompt,
            None,
        )
        .await
        .map_err(|e| e.to_string())?
    } else {
        return Err(
            "No generative backend configured or connection invalid. Please check your AI settings."
                .to_string(),
        );
    };

    let (patch_w, patch_h) = patch_rgba.dimensions();
    let final_patch = if patch_w != img_w || patch_h != img_h {
        image::imageops::resize(
            &patch_rgba,
            img_w,
            img_h,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        patch_rgba.clone()
    };

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

            if mask_value > 0 {
                let patch_pixel = final_patch.get_pixel(px_x, px_y);
                color_image.put_pixel(
                    out_x,
                    out_y,
                    Rgb([patch_pixel[0], patch_pixel[1], patch_pixel[2]]),
                );
            } else {
                color_image.put_pixel(out_x, out_y, Rgb([0, 0, 0]));
            }
        }
    }

    let output_mask =
        image::imageops::crop_imm(&mask_bitmap, min_x_u32, min_y_u32, crop_w, crop_h).to_image();

    let quality = 95;
    let mut color_buf = Cursor::new(Vec::with_capacity(32768));
    color_image
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut color_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let color_base64 = general_purpose::STANDARD.encode(color_buf.get_ref());

    let mut mask_buf = Cursor::new(Vec::with_capacity(32768));
    output_mask
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut mask_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let mask_base64 = general_purpose::STANDARD.encode(mask_buf.get_ref());

    let result_json = serde_json::json!({
        "color": color_base64,
        "mask": mask_base64,
        "offsetX": min_x_u32,
        "offsetY": min_y_u32,
        "width": crop_w,
        "height": crop_h,
        "isSrgbEncoded": is_raw
    })
    .to_string();

    Ok(result_json)
}
