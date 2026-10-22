use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, GrayImage, ImageFormat};

use crate::ai_connector;
use crate::ai_processing::{
    AiDepthMaskParameters, AiForegroundMaskParameters, AiSkyMaskParameters,
    AiSubjectMaskParameters, AiModels, CachedDepthMap, Sam3ImageEmbeddings,
    generate_sam3_image_embeddings, get_or_init_ai_models, get_or_init_depth_anything3_model,
    run_depth_anything3_model, run_sam3_decoder,
    AiDepthMaskParameters, AiForegroundMaskParameters, AiMaskModel, AiModels, AiSkyMaskParameters,
    AiState, AiSubjectMaskParameters, AiTextMaskParameters, CachedDepthMap,
    ESAM3_SKY_SCORE_THRESHOLD, ESAM3_TEXT_SCORE_THRESHOLD, Esam3Features, ImageEmbeddings,
    generate_image_embeddings, get_or_init_ai_models, run_birefnet_model, run_depth_anything_model,
    run_esam3_decoder, run_esam3_image_encoder, run_sam_decoder,
};
use crate::app_settings::load_settings;
use crate::app_state::{AiTaskGuard, AppState};
use crate::cache_utils::GEOMETRY_KEYS;
use crate::effect_maps::EffectMapKind;
use crate::get_cached_full_warped_image;

fn sam3_embedding_hash(path: &str, js_adjustments: &serde_json::Value) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.as_bytes());
    let mut geo_hasher = DefaultHasher::new();
    for key in GEOMETRY_KEYS {
        if let Some(value) = js_adjustments.get(key) {
            key.hash(&mut geo_hasher);
            value.to_string().hash(&mut geo_hasher);
        }
    }
    hasher.update(&geo_hasher.finish().to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

/// Reuse SAM 3's large image-encoder outputs across different text/box prompts.
/// The cache key includes the source path and all geometry-affecting adjustments.
fn get_or_generate_sam3_embeddings(
    ai_state_mutex: &std::sync::Mutex<Option<crate::ai_processing::AiState>>,
    image: &image::DynamicImage,
    models: &crate::ai_processing::AiModels,
    path_hash: &str,
) -> Result<crate::ai_processing::Sam3ImageEmbeddings, String> {
    {
        let state_lock = ai_state_mutex.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = state_lock
            .as_ref()
            .and_then(|state| state.embeddings.as_ref())
            .filter(|cached| cached.path_hash == path_hash)
        {
            return Ok(cached.clone());
        }
    }

    let mut embeddings = match generate_sam3_image_embeddings(image, &models.sam3_image_encoder) {
        Ok(embeddings) => embeddings,
        Err(accelerated_error) => {
            eprintln!("SAM 3 image encoder failed; retrying with CPU-only sessions: {accelerated_error}");
            models.force_sam3_cpu().map_err(|cpu_setup_error| {
                format!("SAM 3 inference failed ({accelerated_error}); CPU fallback could not initialize: {cpu_setup_error}")
            })?;
            generate_sam3_image_embeddings(image, &models.sam3_image_encoder).map_err(|cpu_error| {
                format!("SAM 3 inference failed with accelerated providers ({accelerated_error}) and CPU fallback ({cpu_error})")
            })?
        }
    };
    embeddings.path_hash = path_hash.to_owned();

    let mut state_lock = ai_state_mutex.lock().map_err(|e| e.to_string())?;
    let state = state_lock
        .as_mut()
        .ok_or_else(|| "AI model state was not initialized".to_string())?;
    // Another prompt may have populated the same cache key while this call was
    // encoding. Prefer the cached output and avoid replacing identical data.
    if let Some(cached) = state
        .embeddings
        .as_ref()
        .filter(|cached| cached.path_hash == path_hash)
    {
        return Ok(cached.clone());
    }
    state.embeddings = Some(embeddings.clone());
    Ok(embeddings)
}


/// Retry SAM 3 decoder inference with CPU-only sessions if an accelerated
/// provider fails after successful session creation.
fn run_sam3_decoder_with_fallback(
    models: &AiModels,
    embeddings: &Sam3ImageEmbeddings,
    prompt: &str,
    geometry: Option<((f64, f64), (f64, f64))>,
) -> Result<GrayImage, String> {
    match run_sam3_decoder(
        embeddings,
        prompt,
        geometry,
        &models.sam3_text_encoder,
        &models.sam3_decoder,
        &models.sam3_tokenizer,
    ) {
        Ok(mask) => Ok(mask),
        Err(accelerated_error) => {
            eprintln!("SAM 3 decoder failed; retrying with CPU-only sessions: {accelerated_error}");
            models.force_sam3_cpu().map_err(|cpu_setup_error| {
                format!("SAM 3 decoder failed ({accelerated_error}); CPU fallback could not initialize: {cpu_setup_error}")
            })?;
            run_sam3_decoder(
                embeddings,
                prompt,
                geometry,
                &models.sam3_text_encoder,
                &models.sam3_decoder,
                &models.sam3_tokenizer,
            )
            .map_err(|cpu_error| {
                format!("SAM 3 decoder failed with accelerated providers ({accelerated_error}) and CPU fallback ({cpu_error})")
            })
        }
    }
}

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

#[derive(Clone, Copy)]
pub struct MaskTransform {
    pub rotation: f32,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub orientation_steps: u8,
}

impl MaskTransform {
    pub fn from_adjustments(adjustments: &serde_json::Value) -> Self {
        Self {
            rotation: adjustments["rotation"].as_f64().unwrap_or(0.0) as f32,
            flip_horizontal: adjustments["flipHorizontal"].as_bool().unwrap_or(false),
            flip_vertical: adjustments["flipVertical"].as_bool().unwrap_or(false),
            orientation_steps: adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8,
        }
    }

    pub fn box_space(&self, (width, height): (u32, u32)) -> (u32, u32) {
        if self.orientation_steps % 2 == 1 {
            (height, width)
        } else {
            (width, height)
        }
    }
}

pub fn ai_cache_key(path: &str, adjustments: &serde_json::Value) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.as_bytes());
    let mut geo_hasher = DefaultHasher::new();
    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut geo_hasher);
            val.to_string().hash(&mut geo_hasher);
        }
    }
    hasher.update(&geo_hasher.finish().to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn loaded_source_id(state: &tauri::State<'_, AppState>) -> Option<String> {
    let loaded = state.original_image.lock().unwrap().clone()?;
    crate::ai_jobs::source_id_for(&loaded.path)
}

fn check_cancelled(guard: &Option<AiTaskGuard>) -> Result<(), String> {
    if guard.as_ref().is_some_and(|g| g.token.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }
    Ok(())
}

    let loaded_image = get_loaded_image(&state)?;
    let path_hash = sam3_embedding_hash(&loaded_image.path, &js_adjustments);
    let embeddings = get_or_generate_sam3_embeddings(
        &state.ai_state,
        warped_image.as_ref(),
        models.as_ref(),
        &path_hash,
    )?;
    let full_mask_image = run_sam3_decoder_with_fallback(
        models.as_ref(),
        &embeddings,
        "object",
        None,
    )?;
pub fn generate_foreground_mask(
    models: &AiModels,
    warped_image: &DynamicImage,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiForegroundMaskParameters, String> {
    let mask = run_birefnet_model(
        warped_image,
        &*models.birefnet().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(AiForegroundMaskParameters {
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

fn cached_esam3_features(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
) -> Result<Arc<Esam3Features>, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.esam3_features.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let mut features = run_esam3_image_encoder(
        warped_image,
        &*models.esam3_image_encoder().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    features.path_hash = cache_key.to_string();
    let features = Arc::new(features);

    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.esam3_features = Some(features.clone());
    }
    Ok(features)
}

pub fn generate_sky_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiSkyMaskParameters, String> {
    let features = cached_esam3_features(ai_state, models, cache_key, warped_image)?;
    let prompt = models.esam3_sky_prompt().map_err(|e| e.to_string())?;
    let mask = run_esam3_decoder(
        &*models.esam3_decoder().map_err(|e| e.to_string())?,
        &features,
        &prompt,
        warped_image,
        ESAM3_SKY_SCORE_THRESHOLD,
    )
    .map_err(|e| e.to_string())?
    .unwrap_or_else(|| GrayImage::new(warped_image.width(), warped_image.height()));

    Ok(AiSkyMaskParameters {
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

pub fn generate_text_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    prompt: &str,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiTextMaskParameters, String> {
    let features = cached_esam3_features(ai_state, models, cache_key, warped_image)?;
    let text_prompt = models
        .esam3_text_prompt(prompt)
        .map_err(|e| e.to_string())?;
    let mask = run_esam3_decoder(
        &*models.esam3_decoder().map_err(|e| e.to_string())?,
        &features,
        &text_prompt,
        warped_image,
        ESAM3_TEXT_SCORE_THRESHOLD,
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("No match found for \"{}\"", prompt.trim()))?;

    Ok(AiTextMaskParameters {
        prompt: prompt.to_string(),
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

fn cached_depth_estimate(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
) -> Result<CachedDepthMap, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.depth_map.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let loaded_image = get_loaded_image(&state)?;
    let path_hash = sam3_embedding_hash(&loaded_image.path, &js_adjustments);
    let embeddings = get_or_generate_sam3_embeddings(
        &state.ai_state,
        warped_image.as_ref(),
        models.as_ref(),
        &path_hash,
    )?;
    let full_mask_image = run_sam3_decoder_with_fallback(
        models.as_ref(),
        &embeddings,
        "sky",
        None,
    )?;
    let depth_image = run_depth_anything_model(
        warped_image,
        &*models.depth_anything().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let depth = CachedDepthMap {
        path_hash: cache_key.to_string(),
        depth_image,
        original_size: warped_image.dimensions(),
    };
    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.depth_map = Some(depth.clone());
    }
    Ok(depth)
}

pub fn generate_depth_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    params: AiDepthMaskParameters,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiDepthMaskParameters, String> {
    let depth = cached_depth_estimate(ai_state, models, cache_key, warped_image)?;
    let raw_depth_fullres = image::imageops::resize(
        &depth.depth_image,
        depth.original_size.0,
        depth.original_size.1,
        image::imageops::FilterType::Triangle,
    );

    Ok(AiDepthMaskParameters {
        mask_data_base64: Some(encode_to_base64_png(&raw_depth_fullres)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
        ..params
    })
}

fn cached_image_embeddings(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
) -> Result<ImageEmbeddings, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.embeddings.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let depth_model =
        get_or_init_depth_anything3_model(&app_handle, &state.ai_state, &state.ai_init_lock)
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
    let mut embeddings = generate_image_embeddings(
        warped_image,
        &*models.sam_encoder().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    embeddings.path_hash = cache_key.to_string();

    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.embeddings = Some(embeddings.clone());
    }
    Ok(embeddings)
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
                    run_depth_anything3_model(warped_image.as_ref(), depth_model.as_ref())
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
fn unrotate_box(
    start_point: (f64, f64),
    end_point: (f64, f64),
    (img_w, img_h): (u32, u32),
    transform: MaskTransform,
) -> ((f64, f64), (f64, f64)) {
    let (coarse_rotated_w, coarse_rotated_h) = {
        let (w, h) = transform.box_space((img_w, img_h));
        (w as f64, h as f64)
    };
    let center = (coarse_rotated_w / 2.0, coarse_rotated_h / 2.0);

    let angle_rad = (transform.rotation as f64).to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

            let depth_img = run_depth_anything3_model(warped_image.as_ref(), depth_model.as_ref())
                .map_err(|e| e.to_string())?;
    let unrotate = |p: (f64, f64)| {
        let px = p.0 - center.0;
        let py = p.1 - center.1;
        (
            px * cos_a + py * sin_a + center.0,
            -px * sin_a + py * cos_a + center.1,
        )
    };

    let unflip = |p: (f64, f64)| {
        let mut new_px = p.0;
        let mut new_py = p.1;
        if transform.flip_horizontal {
            new_px = coarse_rotated_w - p.0;
        }
        if transform.flip_vertical {
            new_py = coarse_rotated_h - p.1;
        }
        (new_px, new_py)
    };

    let un_coarse_rotate = |p: (f64, f64)| -> (f64, f64) {
        match transform.orientation_steps {
            0 => p,
            1 => (p.1, img_h as f64 - p.0),
            2 => (img_w as f64 - p.0, img_h as f64 - p.1),
            3 => (img_w as f64 - p.1, p.0),
            _ => p,
        }
    };

    let corners = [
        start_point,
        (start_point.0, end_point.1),
        end_point,
        (end_point.0, start_point.1),
    ]
    .map(|p| un_coarse_rotate(unflip(unrotate(p))));

    let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|p| p.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = corners
        .iter()
        .map(|p| p.1)
        .fold(f64::NEG_INFINITY, f64::max);

    ((min_x, min_y), (max_x, max_y))
}

#[allow(clippy::too_many_arguments)]
pub fn generate_subject_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    start_point: (f64, f64),
    end_point: (f64, f64),
    skip_refinement: bool,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiSubjectMaskParameters, String> {
    let embeddings = cached_image_embeddings(ai_state, models, cache_key, warped_image)?;
    let (unrotated_start, unrotated_end) =
        unrotate_box(start_point, end_point, embeddings.original_size, transform);

    let mask_bitmap = run_sam_decoder(
        &*models.sam_decoder().map_err(|e| e.to_string())?,
        &embeddings,
        unrotated_start,
        unrotated_end,
        (!skip_refinement).then_some(warped_image),
    )
    .map_err(|e| e.to_string())?;

    let (box_space_width, box_space_height) = transform.box_space(embeddings.original_size);

    Ok(AiSubjectMaskParameters {
        start_x: start_point.0,
        start_y: start_point.1,
        end_x: end_point.0,
        end_y: end_point.1,
        mask_data_base64: Some(encode_to_base64_png(&mask_bitmap)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        box_space_width: Some(box_space_width),
        box_space_height: Some(box_space_height),
        ai_source,
    })
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
) -> Result<String, String> {
    let depth_model = crate::ai_processing::get_or_init_depth_anything3_model(
) -> Result<AiForegroundMaskParameters, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Foreground,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let loaded_image = get_loaded_image(&state)?;
    let source_image = crate::mask_generation::build_converted_source_image(
        &loaded_image.image,
        loaded_image.is_raw,
        &js_adjustments,
    );

    let depth_img = crate::ai_processing::run_depth_anything3_model(
        source_image.as_ref(),
        depth_model.as_ref(),
    )
    .map_err(|e| e.to_string())?;
    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params =
        generate_foreground_mask(&models, &warped_image, transform, loaded_source_id(&state))?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_sky_mask(
    js_adjustments: serde_json::Value,
    path: String,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSkyMaskParameters, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Sky,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params = generate_sky_mask(
        &state.ai_state,
        &models,
        &ai_cache_key(&path, &js_adjustments),
        &warped_image,
        transform,
        loaded_source_id(&state),
    )?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_text_mask(
    js_adjustments: serde_json::Value,
    path: String,
    prompt: String,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiTextMaskParameters, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let path_hash = sam3_embedding_hash(&path, &js_adjustments);

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }
    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Text,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let embeddings = get_or_generate_sam3_embeddings(
        &state.ai_state,
        warped_image.as_ref(),
        models.as_ref(),
        &path_hash,
    )?;

    if cancel_flag.as_ref().is_some_and(|t| t.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }

    let (img_w, img_h) = embeddings.original_size;

    let (coarse_rotated_w, coarse_rotated_h) = if orientation_steps % 2 == 1 {
        (img_h as f64, img_w as f64)
    } else {
        (img_w as f64, img_h as f64)
    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params = generate_text_mask(
        &state.ai_state,
        &models,
        &ai_cache_key(&path, &js_adjustments),
        &warped_image,
        &prompt,
        transform,
        loaded_source_id(&state),
    )?;
    check_cancelled(&guard)?;
    Ok(params)
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
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Depth,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params = AiDepthMaskParameters {
        min_depth,
        max_depth,
        min_fade,
        max_fade,
        feather,
        ..Default::default()
    };
    let params = generate_depth_mask(
        &state.ai_state,
        &models,
        &ai_cache_key(&path, &js_adjustments),
        &warped_image,
        params,
        transform,
        loaded_source_id(&state),
    )?;
    check_cancelled(&guard)?;
    Ok(params)
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
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    // The previous SAM API's optional edge-refinement switch is retained for
    // saved command compatibility; SAM 3 currently returns its own decoder mask.
    let _ = skip_refinement;
    let mask_bitmap = run_sam3_decoder_with_fallback(
        models.as_ref(),
        &embeddings,
        "object",
        Some((unrotated_start_point, unrotated_end_point)),
    )?;
    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Subject,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params = generate_subject_mask(
        &state.ai_state,
        &models,
        &ai_cache_key(&path, &js_adjustments),
        &warped_image,
        start_point,
        end_point,
        skip_refinement.unwrap_or(false),
        transform,
        loaded_source_id(&state),
    )?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[tauri::command]
pub async fn precompute_ai_subject_mask(
    js_adjustments: serde_json::Value,
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Subject,
    )
    .await
    .map_err(|e| e.to_string())?;

    let path_hash = sam3_embedding_hash(&path, &js_adjustments);

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    let _ = get_or_generate_sam3_embeddings(
        &state.ai_state,
        warped_image.as_ref(),
        models.as_ref(),
        &path_hash,
    )?;
    let cache_key = ai_cache_key(&path, &js_adjustments);
    let is_cached = state
        .ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.embeddings.as_ref())
        .is_some_and(|cached| cached.path_hash == cache_key);
    if is_cached {
        return Ok(());
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    cached_image_embeddings(&state.ai_state, &models, &cache_key, &warped_image)?;
    Ok(())
}

pub async fn generate_effect_map(
    app_handle: &tauri::AppHandle,
    kind: EffectMapKind,
    source_image: &DynamicImage,
    source_id: &str,
) -> Result<String, String> {
    let state = tauri::Manager::state::<AppState>(app_handle);
    let map = match kind {
        EffectMapKind::Depth => {
            let models = get_or_init_ai_models(
                app_handle,
                &state.ai_state,
                &state.ai_init_lock,
                AiMaskModel::Depth,
            )
            .await
            .map_err(|e| e.to_string())?;
            let session = models.depth_anything().map_err(|e| e.to_string())?;
            DynamicImage::ImageLuma8(
                run_depth_anything_model(source_image, &session).map_err(|e| e.to_string())?,
            )
        }
        EffectMapKind::Normal => {
            let session = crate::ai_processing::get_or_init_normal_model(
                app_handle,
                &state.ai_state,
                &state.ai_init_lock,
            )
            .await
            .map_err(|e| e.to_string())?;
            DynamicImage::ImageRgba8(
                crate::ai_processing::run_normal_model(source_image, &session)
                    .map_err(|e| e.to_string())?,
            )
        }
    };

    crate::effect_maps::store_source_map(kind, source_id, &map)
}

async fn generate_loaded_effect_map(
    kind: EffectMapKind,
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let loaded_image = get_loaded_image(&state)?;
    let source_id = crate::ai_jobs::source_id_for(&loaded_image.path)
        .ok_or("Unable to identify the loaded image")?;
    let source_image = crate::mask_generation::build_converted_source_image(
        &loaded_image.image,
        loaded_image.is_raw,
        &js_adjustments,
    );
    generate_effect_map(&app_handle, kind, &source_image, &source_id).await
}

#[tauri::command]
pub async fn generate_full_image_depth_map(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    generate_loaded_effect_map(EffectMapKind::Depth, js_adjustments, state, app_handle).await
}

#[tauri::command]
pub async fn generate_relight_normal_map(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    generate_loaded_effect_map(EffectMapKind::Normal, js_adjustments, state, app_handle).await
}

fn get_loaded_image(state: &tauri::State<'_, AppState>) -> Result<crate::LoadedImage, String> {
    state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "No original image loaded".to_string())
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
