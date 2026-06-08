use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose};
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage,
};
use serde_json::Value;

use crate::ai_connector;
use crate::ai_processing::{
    self, AiDepthMaskParameters, AiForegroundMaskParameters, AiSkyMaskParameters,
    AiSubjectMaskParameters, CachedDepthMap, get_or_init_ai_models,
    run_depth_anything_model, run_sky_seg_model, run_u2netp_model, run_birefnet_model,
};
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::cache_utils::GEOMETRY_KEYS;
use crate::image_loader::composite_patches_on_image;
use crate::image_processing::apply_unwarp_geometry;
use crate::mask_generation::{AiPatchDefinition, MaskDefinition, generate_mask_bitmap};
use crate::{
    get_cached_full_warped_image, get_full_image_for_processing, resolve_warped_image_for_masks,
};

fn encode_to_base64_png(image: &GrayImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    image
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[tauri::command]
pub async fn generate_ai_foreground_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiForegroundMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    let full_mask_image =
        run_u2netp_model(warped_image.as_ref(), &models.u2netp).map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiForegroundMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
pub async fn generate_ai_sky_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSkyMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    let full_mask_image =
        run_sky_seg_model(warped_image.as_ref(), &models.sky_seg).map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiSkyMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_depth_mask(
    js_adjustments: serde_json::Value,
    path: String,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    feather: f32,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiDepthMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let path_hash = {
        let mut hasher = blake3::Hasher::new();
        hasher.update(path.as_bytes());
        let mut geo_hasher = DefaultHasher::new();
        for key in GEOMETRY_KEYS {
            if let Some(val) = js_adjustments.get(key) {
                key.hash(&mut geo_hasher);
                val.to_string().hash(&mut geo_hasher);
            }
        }
        hasher.update(&geo_hasher.finish().to_le_bytes());
        hasher.finalize().to_hex().to_string()
    };

    let cached_depth = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        if let Some(cached) = &ai_state.depth_map {
            if cached.path_hash == path_hash {
                cached.clone()
            } else {
                let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
                let depth_img =
                    run_depth_anything_model(warped_image.as_ref(), &models.depth_anything)
                        .map_err(|e| e.to_string())?;
                let new_cache = CachedDepthMap {
                    path_hash: path_hash.clone(),
                    depth_image: depth_img,
                    original_size: (warped_image.width(), warped_image.height()),
                };
                ai_state.depth_map = Some(new_cache.clone());
                new_cache
            }
        } else {
            let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
            let depth_img = run_depth_anything_model(warped_image.as_ref(), &models.depth_anything)
                .map_err(|e| e.to_string())?;
            let new_cache = CachedDepthMap {
                path_hash: path_hash.clone(),
                depth_image: depth_img,
                original_size: (warped_image.width(), warped_image.height()),
            };
            ai_state.depth_map = Some(new_cache.clone());
            new_cache
        }
    };

    let raw_depth_fullres = image::imageops::resize(
        &cached_depth.depth_image,
        cached_depth.original_size.0,
        cached_depth.original_size.1,
        image::imageops::FilterType::Triangle,
    );

    let base64_data = encode_to_base64_png(&raw_depth_fullres)?;

    Ok(AiDepthMaskParameters {
        min_depth,
        max_depth,
        min_fade,
        max_fade,
        feather,
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_subject_mask(
    js_adjustments: serde_json::Value,
    _path: String,
    start_point: (f64, f64),
    end_point: (f64, f64),
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSubjectMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    let (img_w, img_h) = (warped_image.width(), warped_image.height());

    let (coarse_rotated_w, coarse_rotated_h) = if orientation_steps % 2 == 1 {
        (img_h as f64, img_w as f64)
    } else {
        (img_w as f64, img_h as f64)
    };

    let center = (coarse_rotated_w / 2.0, coarse_rotated_h / 2.0);

    let p1 = start_point;
    let p2 = (start_point.0, end_point.1);
    let p3 = end_point;
    let p4 = (end_point.0, start_point.1);

    let angle_rad = (rotation as f64).to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let unrotate = |p: (f64, f64)| {
        let px = p.0 - center.0;
        let py = p.1 - center.1;
        let new_px = px * cos_a + py * sin_a + center.0;
        let new_py = -px * sin_a + py * cos_a + center.1;
        (new_px, new_py)
    };

    let up1 = unrotate(p1);
    let up2 = unrotate(p2);
    let up3 = unrotate(p3);
    let up4 = unrotate(p4);

    let unflip = |p: (f64, f64)| {
        let mut new_px = p.0;
        let mut new_py = p.1;
        if flip_horizontal {
            new_px = coarse_rotated_w - p.0;
        }
        if flip_vertical {
            new_py = coarse_rotated_h - p.1;
        }
        (new_px, new_py)
    };

    let ufp1 = unflip(up1);
    let ufp2 = unflip(up2);
    let ufp3 = unflip(up3);
    let ufp4 = unflip(up4);

    let un_coarse_rotate = |p: (f64, f64)| -> (f64, f64) {
        match orientation_steps {
            0 => p,
            1 => (p.1, img_h as f64 - p.0),
            2 => (img_w as f64 - p.0, img_h as f64 - p.1),
            3 => (img_w as f64 - p.1, p.0),
            _ => p,
        }
    };

    let ucrp1 = un_coarse_rotate(ufp1);
    let ucrp2 = un_coarse_rotate(ufp2);
    let ucrp3 = un_coarse_rotate(ufp3);
    let ucrp4 = un_coarse_rotate(ufp4);

    let min_x = ucrp1.0.min(ucrp2.0).min(ucrp3.0).min(ucrp4.0);
    let min_y = ucrp1.1.min(ucrp2.1).min(ucrp3.1).min(ucrp4.1);
    let max_x = ucrp1.0.max(ucrp2.0).max(ucrp3.0).max(ucrp4.0);
    let max_y = ucrp1.1.max(ucrp2.1).max(ucrp3.1).max(ucrp4.1);

    let min_x_u = (min_x.clamp(0.0, img_w as f64 - 1.0).round()) as u32;
    let min_y_u = (min_y.clamp(0.0, img_h as f64 - 1.0).round()) as u32;
    let max_x_u = (max_x.clamp(0.0, img_w as f64).round()) as u32;
    let max_y_u = (max_y.clamp(0.0, img_h as f64).round()) as u32;

    let crop_w = max_x_u.saturating_sub(min_x_u);
    let crop_h = max_y_u.saturating_sub(min_y_u);

    if crop_w == 0 || crop_h == 0 {
        return Err("Selected bounding box is empty or out of bounds.".to_string());
    }

    let cropped_img = image::imageops::crop_imm(warped_image.as_ref(), min_x_u, min_y_u, crop_w, crop_h).to_image();
    let crop_mask = run_birefnet_model(&DynamicImage::ImageRgba8(cropped_img), &models.birefnet)
        .map_err(|e| e.to_string())?;

    let mut full_mask = GrayImage::new(img_w, img_h);
    for y in 0..crop_h {
        for x in 0..crop_w {
            let pixel = crop_mask.get_pixel(x, y);
            full_mask.put_pixel(min_x_u + x, min_y_u + y, *pixel);
        }
    }

    let feathered_mask = image::imageops::blur(&full_mask, 2.0);
    let base64_data = encode_to_base64_png(&feathered_mask)?;

    Ok(AiSubjectMaskParameters {
        start_x: start_point.0,
        start_y: start_point.1,
        end_x: end_point.0,
        end_y: end_point.1,
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
pub async fn precompute_ai_subject_mask(
    _js_adjustments: serde_json::Value,
    _path: String,
    _state: tauri::State<'_, AppState>,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // BiRefNet runs on-demand within coordinates, no visual embeddings to cache
    Ok(())
}

#[tauri::command]
pub async fn check_ai_connector_status(app_handle: tauri::AppHandle) {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let is_connected = if let Some(address) = settings.ai_connector_address {
        ai_connector::check_status(&address).await.unwrap_or(false)
    } else {
        false
    };
    use tauri::Emitter;
    let _ = app_handle.emit(
        "ai-connector-status-update",
        serde_json::json!({ "connected": is_connected }),
    );
}

#[tauri::command]
pub async fn test_ai_connector_connection(address: String) -> Result<(), String> {
    match ai_connector::check_status(&address).await {
        Ok(true) => Ok(()),
        Ok(false) => Err("Server reachable but returned bad health status".to_string()),
        Err(e) => Err(e.to_string()),
    }
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

    let (base_image, _) = get_full_image_for_processing(&state)?;
    let source_image = composite_patches_on_image(&base_image, &source_image_adjustments)
        .map_err(|e| format!("Failed to prepare source image: {}", e))?;

    let (img_w, img_h) = source_image.dimensions();
    let mask_def_for_generation = MaskDefinition {
        id: patch_definition.id.clone(),
        name: patch_definition.name.clone(),
        visible: patch_definition.visible,
        invert: patch_definition.invert,
        opacity: 100.0,
        adjustments: serde_json::Value::Null,
        sub_masks: patch_definition.sub_masks,
    };

    let warped_image = resolve_warped_image_for_masks(
        &state,
        &current_adjustments,
        std::slice::from_ref(&mask_def_for_generation),
    );

    let mask_bitmap = generate_mask_bitmap(
        &mask_def_for_generation,
        img_w,
        img_h,
        1.0,
        (0.0, 0.0),
        warped_image.as_deref(),
    )
    .ok_or("Failed to generate mask bitmap for AI replace")?;

    let mask_dynamic = DynamicImage::ImageLuma8(mask_bitmap);
    let unwarped_dynamic =
        apply_unwarp_geometry(Cow::Borrowed(&mask_dynamic), &current_adjustments).into_owned();
    let mask_bitmap = unwarped_dynamic.to_luma8();

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
        for (x, y, luma_pixel) in mask_bitmap.enumerate_pixels() {
            let intensity = luma_pixel[0];
            rgba_mask.put_pixel(x, y, Rgba([intensity, intensity, intensity, 255]));
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
        for (x, y, luma_pixel) in mask_bitmap.enumerate_pixels() {
            let intensity = luma_pixel[0];
            rgba_mask.put_pixel(x, y, Rgba([intensity, intensity, intensity, 255]));
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
    let scaled_mask_bitmap = image::imageops::resize(
        &mask_bitmap,
        patch_w,
        patch_h,
        image::imageops::FilterType::Lanczos3,
    );
    let mut color_image = RgbImage::new(patch_w, patch_h);
    let mask_image = scaled_mask_bitmap.clone();

    for y in 0..patch_h {
        for x in 0..patch_w {
            let mask_value = scaled_mask_bitmap.get_pixel(x, y)[0];

            if mask_value > 0 {
                let patch_pixel = patch_rgba.get_pixel(x, y);
                color_image.put_pixel(x, y, Rgb([patch_pixel[0], patch_pixel[1], patch_pixel[2]]));
            } else {
                color_image.put_pixel(x, y, Rgb([0, 0, 0]));
            }
        }
    }

    let quality = 92;

    let mut color_buf = Cursor::new(Vec::new());
    color_image
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut color_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let color_base64 = general_purpose::STANDARD.encode(color_buf.get_ref());

    let mut mask_buf = Cursor::new(Vec::new());
    mask_image
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut mask_buf,
            quality,
        ))
        .map_err(|e| e.to_string())?;
    let mask_base64 = general_purpose::STANDARD.encode(mask_buf.get_ref());

    let result_json = serde_json::json!({
        "color": color_base64,
        "mask": mask_base64
    })
    .to_string();

    Ok(result_json)
}