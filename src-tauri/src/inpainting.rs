use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, Rgb, RgbImage, RgbaImage};
use rayon::prelude::*;
use serde_json::Value;

use crate::ai_connector;
use crate::ai_processing;
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::image_loader::composite_patches_on_image;
use crate::image_processing::apply_linear_to_srgb;
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, generate_mask_bitmap};
use crate::resolve_warped_image_for_masks;

fn prepare_source_image(
    patch_id: &str,
    current_adjustments: &Value,
    state: &tauri::State<'_, AppState>,
) -> Result<(DynamicImage, bool), String> {
    let mut source_image_adjustments = current_adjustments.clone();
    if let Some(patches) = source_image_adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        patches.retain(|p| p.get("id").and_then(|id| id.as_str()) != Some(patch_id));
    }

    let is_raw = {
        let guard = state.original_image.lock().unwrap();
        guard.as_ref().map(|img| img.is_raw).unwrap_or(false)
    };

    let (base_image, _) = crate::get_original_image(state)?;
    let source_path = crate::current_source_path(state);
    let composited = composite_patches_on_image(
        &base_image,
        &source_image_adjustments,
        source_path.as_deref(),
    )
    .map_err(|e| format!("Failed to prepare source image: {}", e))?;

    let source_image = if is_raw {
        apply_linear_to_srgb(composited)
    } else {
        composited
    };

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
) -> Result<String, String> {
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

    let result_json = serde_json::json!({
        "color": color_base64,
        "mask": mask_base64,
        "offsetX": offset_x,
        "offsetY": offset_y,
        "width": width,
        "height": height,
        "isSrgbEncoded": is_srgb
    })
    .to_string();

    Ok(result_json)
}

#[tauri::command]
pub async fn generate_manual_cleanup_patch(
    patch_definition: AiPatchDefinition,
    current_adjustments: Value,
    source_point: (f64, f64),
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
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
    .ok_or("Failed to generate mask bitmap for manual cleanup")?;

    let mask_bitmap = crate::image_processing::inverse_transform_mask(
        mask_bitmap,
        &current_adjustments,
        crate::current_source_path(&state).as_deref(),
    );

    let (min_x, max_x, min_y, max_y) = calculate_mask_bounds(&mask_bitmap)?;

    let center_x = (min_x + max_x) as f64 / 2.0;
    let center_y = (min_y + max_y) as f64 / 2.0;

    let source_point_untransformed = crate::image_processing::inverse_transform_point(
        source_point.0,
        source_point.1,
        trans_w as f64,
        trans_h as f64,
        &current_adjustments,
        crate::current_source_path(&state).as_deref(),
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
        100,
        false,
    )
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

    let mask_bitmap = crate::image_processing::inverse_transform_mask(
        mask_bitmap,
        &current_adjustments,
        crate::current_source_path(&state).as_deref(),
    );

    let (min_x, max_x, min_y, max_y) = calculate_mask_bounds(&mask_bitmap)?;

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

        let base_url = "http://127.0.0.1:5000";
        let generated_ai_patch = ai_connector::process_cloud_inpainting(
            base_url,
            &DynamicImage::ImageRgba8(final_src_crop),
            &DynamicImage::ImageRgba8(rgba_mask),
            patch_definition.prompt,
            &auth_token,
        )
        .await
        .map_err(|e| e.to_string())?;

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

        let mut full_canvas = RgbaImage::new(img_w, img_h);
        image::imageops::overlay(
            &mut full_canvas,
            &restored_ai_patch,
            padded_min_x as i64,
            padded_min_y as i64,
        );

        full_canvas
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
                *final_patch.get_pixel(px_x, px_y)
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
    _source_point: (f64, f64),
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_dynamic, is_raw) =
        prepare_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_dynamic.dimensions();
    let source_image = source_dynamic.to_rgb8();

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
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (source_dynamic, is_raw) =
        prepare_source_image(&patch_definition.id, &current_adjustments, &state)?;
    let (img_w, img_h) = source_dynamic.dimensions();
    let source_image = source_dynamic.to_rgb8();

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
        image::imageops::crop_imm(&source_image, min_x_u32, min_y_u32, crop_w, crop_h).to_image();
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
}
