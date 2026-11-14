use crate::app::settings::load_settings;
use crate::app::state::{AppState, PreviewJob, PreviewTarget, PreviewTask};
use crate::decode::formats::is_raw_file;
use crate::decode::image_loader::prepare_base_image_cow;
use crate::library::sidecars::parse_virtual_path;
use crate::masks::generation::{
    MaskDefinition, build_warped_image_for_masks, generate_mask_bitmap,
    get_cached_or_generate_masks,
};
use crate::render::adjustment_utils::hydrate_adjustments;
use crate::render::cache_utils::calculate_transform_hash;
use crate::render::geometry::{get_geometry_params_from_json, is_geometry_identity};
use crate::render::gpu::context::get_or_init_gpu_context;
use crate::render::gpu::display::DisplayLayer;
use crate::render::gpu::output::process_and_get_dynamic_image;
use crate::render::gpu::processor::RenderRequest;
use crate::render::image_processing::downscale_f32_image;
use crate::render::options::{resolve_render_options, resolve_render_options_from_handle};
use crate::render::preview::{
    EditorRender, compute_patched, get_or_compute_stage, patched_cache_key,
};
use crate::render::source::{Frame, RenderSource, SourceTransform};
use crate::render::uniforms::get_all_adjustments_from_json;
use image::{GenericImageView, ImageBuffer, Luma};
use imgref::ImgRef;
use mozjpeg_rs::{Encoder, Preset};
use rgb::FromSlice;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{
    Manager,
    ipc::{Channel, Response},
};

#[derive(serde::Serialize)]
pub struct ImageDimensions {
    width: u32,
    height: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WgpuTransformPayload {
    pub window_width: f32,
    pub window_height: f32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub clip_x: f32,
    pub clip_y: f32,
    pub clip_width: f32,
    pub clip_height: f32,
    pub bg_primary: [f32; 4],
    pub bg_secondary: [f32; 4],
    pub pixelated: bool,
    pub split_origin: [f32; 2],
    pub split_normal: [f32; 2],
    pub split_offset: [f32; 2],
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub await_present: bool,
}

#[tauri::command]
pub fn get_image_dimensions(path: String) -> Result<ImageDimensions, String> {
    let (source_path, _) = parse_virtual_path(&path);
    image::image_dimensions(&source_path)
        .map(|(width, height)| ImageDimensions { width, height })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_wgpu_transform(
    payload: WgpuTransformPayload,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    crate::platform::viewer_window::set_viewer_background(&app_handle, payload.bg_secondary);

    let Some(context) = crate::render::gpu::context::current_gpu_context(&state) else {
        return Ok(false);
    };

    tokio::task::spawn_blocking(move || {
        let mut display_lock = context.display.lock().unwrap_or_else(|e| e.into_inner());
        let Some(display) = display_lock.as_mut() else {
            return false;
        };
        let content = payload
            .path
            .as_deref()
            .map(crate::render::gpu::display::display_content_key);
        let rect_applied = display.place_editor_rect(
            content,
            [payload.x, payload.y, payload.width, payload.height],
        );
        display.latest_transform.clip = [
            payload.clip_x,
            payload.clip_y,
            payload.clip_width,
            payload.clip_height,
        ];
        display.latest_transform.window = [payload.window_width, payload.window_height];
        display.latest_transform.bg_primary = payload.bg_primary;
        display.latest_transform.bg_secondary = payload.bg_secondary;
        display.latest_transform.pixelated = if payload.pixelated { 1.0 } else { 0.0 };
        display.latest_transform.split_origin = payload.split_origin;
        display.latest_transform.split_normal = payload.split_normal;
        display.latest_transform.split_offset = payload.split_offset;
        let presented = display.flush(&context.device, &context.queue);
        drop(display_lock);
        if presented && payload.await_present {
            let _ = context.device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_millis(250)),
            });
        }
        rect_applied && presented
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))
}

#[tauri::command]
pub async fn release_original_preview(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let Some(context) = state
        .gpu_context
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    else {
        return Ok(());
    };

    tokio::task::spawn_blocking(move || {
        if let Some(display) = context
            .display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            display.original_texture = None;
            display.rebind(&context.device);
        }
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))
}

#[tauri::command]
pub async fn sample_hsl_mixer_area(
    js_adjustments: serde_json::Value,
    x: f32,
    y: f32,
    radius: f32,
    app_handle: tauri::AppHandle,
) -> Result<Response, String> {
    tokio::task::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let context = get_or_init_gpu_context(&state, &app_handle)?;
        let loaded_image = state
            .original_image
            .lock()
            .unwrap()
            .clone()
            .ok_or("No original image loaded")?;
        let mut adjustments = js_adjustments;
        hydrate_adjustments(&state, &mut adjustments);

        let transform_hash = calculate_transform_hash(&adjustments);
        let preview = state
            .cached_preview_for(PreviewTarget::Editor)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|cached| cached.transform_hash == transform_hash)
            .map(|cached| cached.preview.clone())
            .ok_or("Editor preview is not ready")?;
        let source = preview.render_source(&adjustments);

        let (width, height) = source.size();
        let half = (radius * width as f32).max(1.0);
        let x0 = (x * width as f32 - half).clamp(0.0, width as f32 - 1.0) as u32;
        let y0 = (y * height as f32 - half).clamp(0.0, height as f32 - 1.0) as u32;
        let x1 = ((x * width as f32 + half).ceil() as u32).clamp(x0 + 1, width);
        let y1 = ((y * height as f32 + half).ceil() as u32).clamp(y0 + 1, height);

        let editor_render = EditorRender::prepare(
            &state,
            &loaded_image,
            &adjustments,
            (width, height),
            preview.scale,
            preview.unscaled_crop_offset,
            resolve_render_options_from_handle(&app_handle, loaded_image.is_raw),
            state.load_image_generation.load(Ordering::SeqCst),
        );
        let roi = crate::render::gpu::processor::Roi {
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
        };
        let probe = process_and_get_dynamic_image(
            &context,
            &state,
            &source,
            editor_render.request(Some(roi), true),
            "sample_hsl_mixer_area",
        )?;
        Ok(Response::new(probe.into_bytes()))
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

#[tauri::command]
pub fn subscribe_analytics(channel: Channel, state: tauri::State<AppState>) {
    *state.analytics_channel.lock().unwrap() = Some(channel);
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn apply_adjustments(
    js_adjustments: serde_json::Value,
    original: bool,
    is_interactive: bool,
    target_resolution: Option<u32>,
    roi: Option<(f32, f32, f32, f32)>,
    request_analytics: bool,
    compute_waveform: bool,
    active_waveform_channel: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    {
        let tx_guard = state.preview_worker_tx.lock().unwrap();
        if let Some(worker_tx) = tx_guard.as_ref() {
            let job = PreviewJob {
                adjustments: js_adjustments,
                layer: if original {
                    DisplayLayer::Original
                } else {
                    DisplayLayer::Edited
                },
                is_interactive,
                target_resolution,
                roi,
                request_analytics,
                compute_waveform,
                active_waveform_channel,
                responder: tx,
            };
            worker_tx
                .send(PreviewTask::Editor(job))
                .map_err(|e| format!("Failed to send to preview worker: {}", e))?;
        } else {
            return Err("Preview worker not running".to_string());
        }
    }

    match rx.await {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(_) => Err("Superseded or worker failed".to_string()),
    }
}

#[tauri::command]
pub async fn generate_uncropped_preview(
    js_adjustments: serde_json::Value,
    target_resolution: Option<u32>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Response, String> {
    let context = get_or_init_gpu_context(&state, &app_handle)?;
    let mut adjustments_clone = js_adjustments.clone();
    hydrate_adjustments(&state, &mut adjustments_clone);

    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;

    tokio::task::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let path = loaded_image.path.clone();
        let is_raw = loaded_image.is_raw;
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let target_dim =
            target_resolution.unwrap_or_else(|| settings.editor_preview_resolution.unwrap_or(1920));

        let patched_key = patched_cache_key(&path, &adjustments_clone);

        let mut hasher = DefaultHasher::new();
        patched_key.hash(&mut hasher);
        target_dim.hash(&mut hasher);
        let source_key = hasher.finish();

        let cached_source = state
            .uncropped_source_cache
            .lock()
            .unwrap()
            .get(&source_key)
            .cloned();
        let source_image = match cached_source {
            Some(cached) => cached,
            None => {
                let patched = get_or_compute_stage(&state.patched_cache, patched_key, || {
                    compute_patched(&loaded_image, &adjustments_clone)
                })?;
                let downscaled = Arc::new(downscale_f32_image(&patched, target_dim, target_dim));
                drop(patched);

                let mut cache = state.uncropped_source_cache.lock().unwrap();
                if cache.len() > 2 {
                    cache.clear();
                }
                cache.insert(source_key, Arc::clone(&downscaled));
                downscaled
            }
        };

        let scale_for_gpu = if loaded_image.image.width() > 0 {
            source_image.width() as f32 / loaded_image.image.width() as f32
        } else {
            1.0
        };

        let geometry = get_geometry_params_from_json(&path, &adjustments_clone);
        let has_geometry = !is_geometry_identity(&geometry);
        let source = RenderSource::new(
            &source_image,
            source_key,
            &adjustments_clone,
            SourceTransform {
                warp: has_geometry.then_some(geometry),
                effects: true,
                frame: Frame {
                    rotation: 0.0,
                    crop: None,
                    ..Frame::from_adjustments(&adjustments_clone)
                },
                ..Default::default()
            },
        );
        let (preview_width, preview_height) = source.size();

        let mask_definitions: Vec<MaskDefinition> = adjustments_clone
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();

        let mask_bitmaps = get_cached_or_generate_masks(
            &state,
            &path,
            &mask_definitions,
            preview_width,
            preview_height,
            scale_for_gpu,
            (0.0, 0.0),
            &adjustments_clone,
        )
        .bitmaps;

        let render = resolve_render_options_from_handle(&app_handle, is_raw);
        let mut uncropped_adjustments =
            get_all_adjustments_from_json(&adjustments_clone, is_raw, loaded_image.as_shot, render);
        uncropped_adjustments.global.show_clipping = 0;
        let lut_path = adjustments_clone["lutPath"].as_str();
        let lut = lut_path
            .and_then(|p| crate::adjustments::lut_processing::get_or_load_lut(&state, p).ok());

        if let Ok(processed_image) = process_and_get_dynamic_image(
            &context,
            &state,
            &source,
            RenderRequest {
                adjustments: uncropped_adjustments,
                mask_bitmaps: &mask_bitmaps,
                mask_cache_key: None,
                lut,
                roi: None,
                hsl_probe: false,
                motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                    &path,
                    &adjustments_clone,
                    (preview_width, preview_height),
                    (0.0, 0.0),
                    preview_width.max(preview_height) as f32,
                ),
            },
            "generate_uncropped_preview",
        ) {
            let (width, height) = processed_image.dimensions();
            let rgb_pixels = processed_image.to_rgb8().into_vec();

            if let Ok(bytes) = Encoder::new(Preset::BaselineFastest)
                .quality(80)
                .encode_rgb(&rgb_pixels, width, height)
            {
                return Ok(Response::new(bytes));
            }
        }

        Err("Failed to process uncropped preview".to_string())
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}

#[tauri::command]
pub async fn generate_preview_for_path(
    path: String,
    js_adjustments: Value,
    app_handle: tauri::AppHandle,
) -> Result<Response, String> {
    tokio::task::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let context = get_or_init_gpu_context(&state, &app_handle)?;
        let (source_path, _) = parse_virtual_path(&path);
        let source_path_str = source_path.to_string_lossy().to_string();
        let is_raw = is_raw_file(&source_path_str);
        let settings = load_settings(app_handle.clone()).unwrap_or_default();

        let (pristine, _exif) = crate::decode::image_loader::get_or_decode_pristine(
            &state,
            &source_path,
            &settings,
            None,
        )?;
        let base_image = prepare_base_image_cow(&pristine, &source_path_str, &js_adjustments)
            .map_err(|e| e.to_string())?;
        let base_scale = crate::ai::upscale::scale_between(&pristine, &base_image);
        let (fitted, fit_scale) = crate::render::source::fit_to_gpu(&context, &base_image);
        let scale = fit_scale * base_scale;
        let source = RenderSource::edited(
            &fitted,
            crate::render::source::source_id("preview-for-path", &source_path_str, &js_adjustments),
            &path,
            &js_adjustments,
        )
        .scaled(scale);
        let crop_offset = source.crop_offset();
        let (img_w, img_h) = source.size();
        let mask_definitions: Vec<MaskDefinition> = js_adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();

        let warped_image = build_warped_image_for_masks(
            &base_image,
            base_scale,
            is_raw,
            &path,
            &js_adjustments,
            &mask_definitions,
        );
        let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
            .iter()
            .filter_map(|def| {
                generate_mask_bitmap(
                    def,
                    img_w,
                    img_h,
                    scale,
                    crop_offset,
                    warped_image.as_deref(),
                )
            })
            .collect();

        let render = resolve_render_options(&settings, is_raw);
        let mut all_adjustments = get_all_adjustments_from_json(
            &js_adjustments,
            is_raw,
            crate::decode::as_shot::as_shot(&source_path_str),
            render,
        );
        all_adjustments.global.show_clipping = 0;
        let lut_path = js_adjustments["lutPath"].as_str();
        let lut = lut_path
            .and_then(|p| crate::adjustments::lut_processing::get_or_load_lut(&state, p).ok());
        let final_image = process_and_get_dynamic_image(
            &context,
            &state,
            &source,
            RenderRequest {
                adjustments: all_adjustments,
                mask_bitmaps: &mask_bitmaps,
                mask_cache_key: None,
                lut,
                roi: None,
                hsl_probe: false,
                motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                    &path,
                    &js_adjustments,
                    (img_w, img_h),
                    crop_offset,
                    base_image.width().max(base_image.height()) as f32 * fit_scale,
                ),
            },
            "generate_preview_for_path",
        )?;

        let rgba = final_image.into_rgba8();
        let (width, height) = rgba.dimensions();
        let pixels = ImgRef::new(rgba.as_raw().as_rgba(), width as usize, height as usize);
        let bytes = crate::render::preview_jpeg::encode_rgba(pixels, 92, false)
            .map_err(|e| format!("Failed to encode with mozjpeg-rs: {}", e))?;

        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}
