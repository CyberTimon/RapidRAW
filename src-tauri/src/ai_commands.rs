use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose};
use image::{GrayImage, ImageFormat};

use crate::ai_connector;
use crate::ai_processing::{
    AiDepthMaskParameters, AiForegroundMaskParameters, AiSkyMaskParameters,
    AiSubjectMaskParameters, CachedDepthMap, generate_image_embeddings, get_or_init_ai_models,
    run_depth_anything_model, run_sam_decoder, run_sky_seg_model, run_u2netp_model,
};
use crate::app_settings::load_settings;
use crate::app_state::{AiTaskGuard, AppState};
use crate::cache_utils::GEOMETRY_KEYS;
use crate::get_cached_full_warped_image;

#[tauri::command]
pub fn cancel_ai_task(task_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let tasks = state.active_ai_tasks.lock().unwrap();
    if let Some(token) = tasks.get(&task_id) {
        token.cancel();
    }
    Ok(())
}

fn encode_to_base64_png(image: &GrayImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    image
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_foreground_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiForegroundMaskParameters, String> {
    let _guard = task_id
        .as_ref()
        .map(|id| AiTaskGuard::new(&state.active_ai_tasks, id.clone()));
    let cancel_flag = _guard.as_ref().map(|g| &g.token);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let full_mask_image =
        run_u2netp_model(warped_image.as_ref(), &models.u2netp).map_err(|e| e.to_string())?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiForegroundMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_sky_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSkyMaskParameters, String> {
    let _guard = task_id
        .as_ref()
        .map(|id| AiTaskGuard::new(&state.active_ai_tasks, id.clone()));
    let cancel_flag = _guard.as_ref().map(|g| &g.token);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let full_mask_image =
        run_sky_seg_model(warped_image.as_ref(), &models.sky_seg).map_err(|e| e.to_string())?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

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
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiDepthMaskParameters, String> {
    let _guard = task_id
        .as_ref()
        .map(|id| AiTaskGuard::new(&state.active_ai_tasks, id.clone()));
    let cancel_flag = _guard.as_ref().map(|g| &g.token);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

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

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let cached_depth = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        if let Some(cached) = &ai_state.depth_map {
            if cached.path_hash == path_hash {
                cached.clone()
            } else {
                drop(ai_state_lock);
                let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

                if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
                    return Err("Task cancelled".to_string());
                }

                let depth_img =
                    run_depth_anything_model(warped_image.as_ref(), &models.depth_anything)
                        .map_err(|e| e.to_string())?;

                let new_cache = CachedDepthMap {
                    path_hash: path_hash.clone(),
                    depth_image: depth_img,
                    original_size: (warped_image.width(), warped_image.height()),
                };

                let mut ai_state_lock = state.ai_state.lock().unwrap();
                let ai_state = ai_state_lock.as_mut().unwrap();
                ai_state.depth_map = Some(new_cache.clone());
                new_cache
            }
        } else {
            drop(ai_state_lock);
            let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

            if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
                return Err("Task cancelled".to_string());
            }

            let depth_img = run_depth_anything_model(warped_image.as_ref(), &models.depth_anything)
                .map_err(|e| e.to_string())?;

            let new_cache = CachedDepthMap {
                path_hash: path_hash.clone(),
                depth_image: depth_img,
                original_size: (warped_image.width(), warped_image.height()),
            };

            let mut ai_state_lock = state.ai_state.lock().unwrap();
            let ai_state = ai_state_lock.as_mut().unwrap();
            ai_state.depth_map = Some(new_cache.clone());
            new_cache
        }
    };

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

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

#[tauri::command]
pub async fn generate_full_image_depth_map(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let models = crate::ai_processing::get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
    )
    .await
    .map_err(|e| e.to_string())?;

    let warped_image = crate::get_cached_full_warped_image(&state, &js_adjustments)?;

    let depth_img = crate::ai_processing::run_depth_anything_model(
        warped_image.as_ref(),
        &models.depth_anything,
    )
    .map_err(|e| e.to_string())?;

    let mut buf = std::io::Cursor::new(Vec::new());
    depth_img
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = base64::engine::general_purpose::STANDARD.encode(buf.get_ref());

    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelightMapsPayload {
    normal_map: String,
    depth_map: String,
    depth_scale: f32,
}

fn encode_png_data_url(image: &image::DynamicImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    image
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

// Generated maps are kept on disk, one file per image, geometry and model quality, so that
// switching quality back and forth or reopening a photo does not run the model again.
const RELIGHT_MAPS_CACHE_VERSION: &str = "v1";
const RELIGHT_MAPS_CACHE_MAX_FILES: usize = 60;

fn relight_maps_cache_file(
    cache_dir: &std::path::Path,
    image_path: &str,
    js_adjustments: &serde_json::Value,
    quality: crate::ai_processing::NormalModelQuality,
) -> std::path::PathBuf {
    let mut hasher = blake3::Hasher::new();
    hasher.update(RELIGHT_MAPS_CACHE_VERSION.as_bytes());
    hasher.update(image_path.as_bytes());
    hasher.update(format!("{:?}", quality).as_bytes());
    hasher.update(&crate::cache_utils::calculate_geometry_hash(js_adjustments).to_le_bytes());

    // A file that was replaced on disk must not reuse the maps of the old one.
    let (source_path, _) = crate::file_management::parse_virtual_path(image_path);
    if let Ok(metadata) = std::fs::metadata(&source_path) {
        hasher.update(&metadata.len().to_le_bytes());
        if let Ok(elapsed) = metadata.modified().and_then(|m| {
            m.duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        }) {
            hasher.update(&elapsed.as_nanos().to_le_bytes());
        }
    }

    cache_dir.join(format!("{}.json", hasher.finalize().to_hex()))
}

fn read_relight_maps_cache(file: &std::path::Path) -> Option<RelightMapsPayload> {
    let bytes = std::fs::read(file).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_relight_maps_cache(
    file: &std::path::Path,
    maps: &RelightMapsPayload,
) -> Result<(), String> {
    let dir = file.parent().ok_or("Invalid relight cache path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Written next to the target and renamed, so a crash never leaves half a file behind.
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(maps).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())?;

    // Drop the least recently written maps once there are too many.
    let mut entries: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if entries.len() > RELIGHT_MAPS_CACHE_MAX_FILES {
        entries.sort();
        for (_, path) in &entries[..entries.len() - RELIGHT_MAPS_CACHE_MAX_FILES] {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Returns the relight maps for the open image, generating them only when there is no saved
/// copy for this image and quality (or when `force` asks for a fresh run).
#[tauri::command]
pub async fn generate_relight_maps(
    js_adjustments: serde_json::Value,
    quality: Option<crate::ai_processing::NormalModelQuality>,
    force: Option<bool>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<RelightMapsPayload, String> {
    use tauri::Manager;

    let quality = quality.unwrap_or_default();
    let image_path = state
        .original_image
        .lock()
        .unwrap()
        .as_ref()
        .map(|loaded| loaded.path.clone())
        .ok_or("No original image loaded")?;

    let cache_file = app_handle.path().app_cache_dir().ok().map(|dir| {
        relight_maps_cache_file(
            &dir.join("relight_maps"),
            &image_path,
            &js_adjustments,
            quality,
        )
    });

    if !force.unwrap_or(false)
        && let Some(maps) = cache_file.as_deref().and_then(read_relight_maps_cache)
    {
        return Ok(maps);
    }

    let normal_model = crate::ai_processing::get_or_init_normal_model(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        quality,
    )
    .await
    .map_err(|e| e.to_string())?;

    let warped_image = crate::get_cached_full_warped_image(&state, &js_adjustments)?;

    let maps = crate::ai_processing::run_normal_model(warped_image.as_ref(), &normal_model)
        .map_err(|e| e.to_string())?;

    let payload = RelightMapsPayload {
        normal_map: encode_png_data_url(&image::DynamicImage::ImageRgba8(maps.normal))?,
        depth_map: encode_png_data_url(&image::DynamicImage::ImageLuma16(maps.depth))?,
        depth_scale: maps.depth_scale,
    };

    if let Some(file) = &cache_file
        && let Err(error) = write_relight_maps_cache(file, &payload)
    {
        log::warn!(
            "Could not save relight maps to {}: {}",
            file.display(),
            error
        );
    }

    Ok(payload)
}

/// Normal map as the relight pass uses it, laid out like the edited image (orientation,
/// rotation and crop applied) so it can be shown on top of it.
#[tauri::command]
pub async fn generate_relight_normal_preview(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let warped_image = crate::get_cached_full_warped_image(&state, &js_adjustments)?;

    let normals = crate::relight::render_normal_preview(warped_image.as_ref(), &js_adjustments)
        .ok_or_else(|| "No normal map available".to_string())?;

    // The preview is smaller than the image, so the crop (stored in full-size pixels) has to
    // shrink with it.
    let scale = normals.width() as f64 / warped_image.width().max(1) as f64;
    let mut layout = serde_json::json!({
        "orientationSteps": js_adjustments["orientationSteps"],
        "rotation": js_adjustments["rotation"],
        "flipHorizontal": js_adjustments["flipHorizontal"],
        "flipVertical": js_adjustments["flipVertical"],
        "crop": js_adjustments["crop"],
    });
    if let Some(crop) = layout["crop"].as_object_mut() {
        for key in ["x", "y", "width", "height"] {
            if let Some(value) = crop.get(key).and_then(|v| v.as_f64()) {
                crop.insert(key.to_string(), serde_json::json!(value * scale));
            }
        }
    }

    let (preview, _) = crate::adjustment_utils::apply_spatial_transformations(
        image::DynamicImage::ImageRgb8(normals),
        &layout,
    );

    let mut buf = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90)
        .encode_image(&preview.to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf.into_inner()))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_subject_mask(
    js_adjustments: serde_json::Value,
    path: String,
    start_point: (f64, f64),
    end_point: (f64, f64),
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    skip_refinement: Option<bool>,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSubjectMaskParameters, String> {
    let _guard = task_id
        .as_ref()
        .map(|id| AiTaskGuard::new(&state.active_ai_tasks, id.clone()));
    let cancel_flag = _guard.as_ref().map(|g| &g.token);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

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

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let embeddings = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        if let Some(cached_embeddings) = &ai_state.embeddings {
            if cached_embeddings.path_hash == path_hash {
                cached_embeddings.clone()
            } else {
                drop(ai_state_lock);
                let mut new_embeddings =
                    generate_image_embeddings(warped_image.as_ref(), &models.sam_encoder)
                        .map_err(|e| e.to_string())?;

                new_embeddings.path_hash = path_hash.clone();

                let mut ai_state_lock = state.ai_state.lock().unwrap();
                let ai_state = ai_state_lock.as_mut().unwrap();
                ai_state.embeddings = Some(new_embeddings.clone());
                new_embeddings
            }
        } else {
            drop(ai_state_lock);
            let mut new_embeddings =
                generate_image_embeddings(warped_image.as_ref(), &models.sam_encoder)
                    .map_err(|e| e.to_string())?;

            new_embeddings.path_hash = path_hash.clone();

            let mut ai_state_lock = state.ai_state.lock().unwrap();
            let ai_state = ai_state_lock.as_mut().unwrap();
            ai_state.embeddings = Some(new_embeddings.clone());
            new_embeddings
        }
    };

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let (img_w, img_h) = embeddings.original_size;

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

    let unrotated_start_point = (min_x, min_y);
    let unrotated_end_point = (max_x, max_y);

    let mask_bitmap = run_sam_decoder(
        &models.sam_decoder,
        &embeddings,
        unrotated_start_point,
        unrotated_end_point,
        if skip_refinement.unwrap_or(false) {
            None
        } else {
            Some(warped_image.as_ref())
        },
    )
    .map_err(|e| e.to_string())?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let base64_data = encode_to_base64_png(&mask_bitmap)?;

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
    js_adjustments: serde_json::Value,
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
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

    {
        let ai_state_lock = state.ai_state.lock().unwrap();
        if let Some(ai_state) = ai_state_lock.as_ref()
            && let Some(cached_embeddings) = &ai_state.embeddings
            && cached_embeddings.path_hash == path_hash
        {
            return Ok(());
        }
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    let mut new_embeddings = generate_image_embeddings(warped_image.as_ref(), &models.sam_encoder)
        .map_err(|e| e.to_string())?;

    new_embeddings.path_hash = path_hash.clone();

    let mut ai_state_lock = state.ai_state.lock().unwrap();
    if let Some(ai_state) = ai_state_lock.as_mut() {
        ai_state.embeddings = Some(new_embeddings);
    }

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

#[cfg(test)]
mod relight_maps_cache_tests {
    use super::*;
    use crate::ai_processing::NormalModelQuality;
    use serde_json::json;

    fn payload(tag: &str) -> RelightMapsPayload {
        RelightMapsPayload {
            normal_map: format!("normal-{tag}"),
            depth_map: format!("depth-{tag}"),
            depth_scale: 1.5,
        }
    }

    #[test]
    fn saved_maps_are_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = relight_maps_cache_file(
            dir.path(),
            "photo.raw",
            &json!({}),
            NormalModelQuality::High,
        );

        assert_eq!(read_relight_maps_cache(&file), None);
        write_relight_maps_cache(&file, &payload("a")).unwrap();
        assert_eq!(read_relight_maps_cache(&file), Some(payload("a")));
    }

    #[test]
    fn each_image_quality_and_geometry_gets_its_own_file() {
        let dir = std::path::Path::new("cache");
        let base =
            relight_maps_cache_file(dir, "photo.raw", &json!({}), NormalModelQuality::Standard);

        let same = relight_maps_cache_file(
            dir,
            "photo.raw",
            &json!({ "exposure": 2 }),
            NormalModelQuality::Standard,
        );
        let other_quality =
            relight_maps_cache_file(dir, "photo.raw", &json!({}), NormalModelQuality::High);
        let other_image =
            relight_maps_cache_file(dir, "other.raw", &json!({}), NormalModelQuality::Standard);
        let other_geometry = relight_maps_cache_file(
            dir,
            "photo.raw",
            &json!({ "transformRotate": 5 }),
            NormalModelQuality::Standard,
        );

        assert_eq!(base, same);
        assert_ne!(base, other_quality);
        assert_ne!(base, other_image);
        assert_ne!(base, other_geometry);
    }

    #[test]
    fn oldest_maps_are_dropped_when_the_cache_is_full() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..RELIGHT_MAPS_CACHE_MAX_FILES + 3 {
            let file = dir.path().join(format!("{i:04}.json"));
            write_relight_maps_cache(&file, &payload("x")).unwrap();
            let stamp = filetime::FileTime::from_unix_time(1_700_000_000 + i as i64, 0);
            filetime::set_file_mtime(&file, stamp).unwrap();
        }
        // One more write triggers the clean-up with every timestamp in place.
        let newest = dir.path().join("newest.json");
        write_relight_maps_cache(&newest, &payload("x")).unwrap();

        let remaining = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(remaining, RELIGHT_MAPS_CACHE_MAX_FILES);
        assert!(!dir.path().join("0000.json").exists());
        assert!(newest.exists());
    }
}
