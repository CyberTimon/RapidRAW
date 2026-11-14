use crate::app::settings::load_settings;
use crate::app::state::{
    AnalyticsConfig, AnalyticsJob, AppState, CachedPreview, FrameContent, PreviewJob,
    PreviewTarget, PreviewTask,
};
use crate::render::adjustment_utils::hydrate_adjustments;
use crate::render::analytics::{calculate_histogram, calculate_waveform, encode_analytics_packet};
use crate::render::cache_utils::{
    calculate_full_job_hash, calculate_patch_hash, calculate_transform_hash,
};
use crate::render::gpu::context::get_or_init_gpu_context;
use crate::render::gpu::display::DisplayLayer;
use crate::render::options::resolve_render_options;
use crate::render::preview::{EditorRender, prepare_preview_source};
use crate::render::source::RenderSource;
use image::DynamicImage;
use imgref::ImgRef;
use rgb::{FromSlice, RGBA8};
use std::panic;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;
use tauri::{Emitter, Manager, ipc::InvokeResponseBody};

#[allow(clippy::too_many_arguments)]
fn process_preview_job(
    app_handle: &tauri::AppHandle,
    state: tauri::State<AppState>,
    mut adjustments_json: serde_json::Value,
    layer: DisplayLayer,
    is_interactive: bool,
    target_resolution: Option<u32>,
    roi: Option<(f32, f32, f32, f32)>,
    request_analytics: bool,
    compute_waveform: bool,
    active_waveform_channel: Option<&str>,
    target: PreviewTarget,
) -> Result<Vec<u8>, String> {
    let fn_start = std::time::Instant::now();
    let context = get_or_init_gpu_context(&state, app_handle)?;

    let image_generation = state.load_image_generation.load(Ordering::SeqCst);
    let loaded_image_guard = state.original_image.lock().unwrap();
    let loaded_image = loaded_image_guard
        .as_ref()
        .ok_or("No original image loaded")?
        .clone();
    drop(loaded_image_guard);

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let is_raw = loaded_image.is_raw;
    let render = resolve_render_options(&settings, is_raw);
    let content = FrameContent {
        job_hash: calculate_full_job_hash(&loaded_image.path, &adjustments_json),
        patch_hash: calculate_patch_hash(&adjustments_json),
        render,
    };
    let mirrors_editor = target == PreviewTarget::Editor && layer == DisplayLayer::Edited;
    if mirrors_editor {
        crate::platform::viewer_window::record_editor_source(
            app_handle,
            &loaded_image.path,
            &adjustments_json,
            content,
            is_interactive,
        );
    }

    hydrate_adjustments(&state, &mut adjustments_json);
    let adjustments_clone = adjustments_json;

    crate::ai::denoise::ensure_generated(app_handle, &loaded_image, &adjustments_clone);
    crate::ai::upscale::ensure_generated(app_handle, &loaded_image, &adjustments_clone);

    let new_transform_hash = calculate_transform_hash(&adjustments_clone);
    let live_quality = settings.live_preview_quality.as_deref().unwrap_or("high");

    let default_preview_dim = settings.editor_preview_resolution.unwrap_or(1920);
    let preview_dim = target_resolution.unwrap_or(default_preview_dim);
    let use_wgpu_renderer = settings.wgpu_renderer_enabled();

    let has_roi = roi.is_some();
    let (interactive_divisor, interactive_quality) = match live_quality {
        "performance" => (if has_roi { 1.4_f32 } else { 1.2_f32 }, 75_u8),
        _ => (1.0_f32, 85_u8),
    };
    let interactive_divisor = match target {
        PreviewTarget::Editor => interactive_divisor,
        PreviewTarget::Viewer => 1.0,
    };
    let small_preview_dim = (preview_dim as f32 / interactive_divisor) as u32;

    let mut cached_preview_lock = state
        .cached_preview_for(target)
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let preview = match cached_preview_lock
        .as_ref()
        .filter(|c| c.transform_hash == new_transform_hash && c.preview_dim == preview_dim)
    {
        Some(cached) => cached.preview.clone(),
        None => {
            if let Some(cache) = state
                .gpu_image_cache_for(target)
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
            {
                cache.entries.clear();
            }
            let preview = prepare_preview_source(
                &state,
                &context,
                &loaded_image,
                &adjustments_clone,
                preview_dim,
            )?;
            *cached_preview_lock = Some(CachedPreview {
                preview: preview.clone(),
                transform_hash: new_transform_hash,
                preview_dim,
            });
            preview
        }
    };
    drop(cached_preview_lock);

    let full_size = preview.size();
    if mirrors_editor {
        crate::platform::viewer_window::sync_viewer_image(
            app_handle,
            &loaded_image.path,
            full_size,
            preview.scale,
        );
    }

    let frame_resolution = if is_interactive {
        small_preview_dim
    } else {
        preview_dim
    };

    let mut processing_transform = preview.transform.clone();
    let jpeg_quality = if is_interactive {
        if interactive_divisor > 1.0 {
            let (w, h) = full_size;
            processing_transform.output_fit = Some(if w > h {
                let ratio = h as f32 / w as f32;
                (small_preview_dim, (small_preview_dim as f32 * ratio) as u32)
            } else {
                let ratio = w as f32 / h as f32;
                ((small_preview_dim as f32 * ratio) as u32, small_preview_dim)
            });
        }
        interactive_quality
    } else {
        94
    };
    let processing_source = RenderSource::new(
        &preview.image,
        preview.id,
        &adjustments_clone,
        processing_transform,
    );
    let (preview_width, preview_height) = processing_source.size();
    let effective_scale = if full_size.0 > 0 {
        preview.scale * preview_width as f32 / full_size.0 as f32
    } else {
        preview.scale
    };
    let unscaled_crop_offset = preview.unscaled_crop_offset;

    let pixel_roi = if is_interactive {
        roi.map(|(nx, ny, nw, nh)| crate::render::gpu::processor::Roi {
            x: (nx * preview_width as f32).round() as u32,
            y: (ny * preview_height as f32).round() as u32,
            width: (nw * preview_width as f32).round() as u32,
            height: (nh * preview_height as f32).round() as u32,
        })
    } else {
        None
    };

    let editor_render = EditorRender::prepare(
        &state,
        &loaded_image,
        &adjustments_clone,
        (preview_width, preview_height),
        effective_scale,
        unscaled_crop_offset,
        render,
        image_generation,
    );

    let wants_analytics = !(is_interactive && pixel_roi.is_some()) && request_analytics;
    let channel_filter = if is_interactive {
        active_waveform_channel.map(|s| s.to_string())
    } else {
        None
    };

    let analytics_config = if wants_analytics {
        state
            .analytics_worker_tx
            .lock()
            .unwrap()
            .clone()
            .map(|tx| AnalyticsConfig {
                path: loaded_image.path.clone(),
                compute_waveform,
                active_waveform_channel: channel_filter,
                sender: tx,
            })
    } else {
        None
    };

    if use_wgpu_renderer {
        let _ = context.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_millis(500)),
        });
    }

    let to_viewer = match target {
        PreviewTarget::Viewer => true,
        PreviewTarget::Editor => {
            mirrors_editor
                && pixel_roi.is_none()
                && crate::platform::viewer_window::accepts_editor_frame(
                    app_handle,
                    &content,
                    frame_resolution,
                )
        }
    };
    let caller_id = match target {
        PreviewTarget::Editor => "apply_adjustments",
        PreviewTarget::Viewer => "viewer_preview",
    };

    let final_processed_image_result =
        crate::render::gpu::output::process_and_get_dynamic_image_with_analytics(
            &context,
            &state,
            &processing_source,
            editor_render.request(pixel_roi, false),
            caller_id,
            use_wgpu_renderer.then_some(crate::render::gpu::display::DisplayOutput {
                target,
                layer,
                to_viewer,
                content: crate::render::gpu::display::display_content_key(&loaded_image.path),
            }),
            analytics_config,
        );

    let deliver_to_viewer = |jpeg_bytes: Option<&[u8]>| {
        if to_viewer {
            crate::platform::viewer_window::record_viewer_frame(
                app_handle,
                content,
                frame_resolution,
                jpeg_bytes,
            );
        }
        target == PreviewTarget::Viewer
    };

    if let Ok(final_processed_image) = final_processed_image_result {
        if use_wgpu_renderer {
            if deliver_to_viewer(None) {
                return Ok(Vec::new());
            }
            if layer == DisplayLayer::Original {
                return Ok(b"WGPU_RENDER".to_vec());
            }
            if state
                .wgpu_presented_generation
                .swap(image_generation, Ordering::SeqCst)
                != image_generation
            {
                let _ = context.device.poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_millis(500)),
                });
            }
            let _ = app_handle.emit(
                "wgpu-frame-ready",
                serde_json::json!({ "path": loaded_image.path }),
            );
            return Ok(b"WGPU_RENDER".to_vec());
        }

        let final_processed_image = Arc::new(final_processed_image);
        let final_rgba_image = match &*final_processed_image {
            DynamicImage::ImageRgba8(img) => img,
            _ => return Err("Expected Rgba8 image from GPU for encoding".to_string()),
        };

        let raw_bytes: &[u8] = final_rgba_image.as_raw();
        let rgba8_pixels: &[RGBA8] = raw_bytes.as_rgba();

        let img_ref = ImgRef::new(
            rgba8_pixels,
            final_rgba_image.width() as usize,
            final_rgba_image.height() as usize,
        );

        let step_start = std::time::Instant::now();

        let encode_result = crate::render::preview_jpeg::encode_rgba(img_ref, jpeg_quality, true);

        match encode_result {
            Ok(jpeg_bytes) => {
                if deliver_to_viewer(Some(&jpeg_bytes)) {
                    return Ok(Vec::new());
                }
                if is_interactive {
                    let (roi_w, roi_h) = final_rgba_image.dimensions();
                    let (rx, ry) = if let Some(r) = pixel_roi {
                        (r.x, r.y)
                    } else {
                        (0, 0)
                    };

                    let mut response = Vec::with_capacity(24 + jpeg_bytes.len());
                    response.extend_from_slice(&rx.to_le_bytes());
                    response.extend_from_slice(&ry.to_le_bytes());
                    response.extend_from_slice(&roi_w.to_le_bytes());
                    response.extend_from_slice(&roi_h.to_le_bytes());
                    response.extend_from_slice(&preview_width.to_le_bytes());
                    response.extend_from_slice(&preview_height.to_le_bytes());
                    response.extend_from_slice(&jpeg_bytes);

                    log::info!(
                        "[process_preview_job] interactive ROI {}x{} encode in {:.2?}, total {:.2?}",
                        roi_w,
                        roi_h,
                        step_start.elapsed(),
                        fn_start.elapsed()
                    );
                    Ok(response)
                } else {
                    let (width, height) = final_rgba_image.dimensions();
                    log::info!(
                        "[process_preview_job] full {}x{} q={} encode in {:.2?}, total {:.2?}",
                        width,
                        height,
                        jpeg_quality,
                        step_start.elapsed(),
                        fn_start.elapsed()
                    );
                    Ok(jpeg_bytes)
                }
            }
            Err(e) => Err(format!("Failed to encode preview: {}", e)),
        }
    } else {
        log::error!(
            "[process_preview_job] processing failed after {:.2?}",
            fn_start.elapsed()
        );
        Err("Processing failed".to_string())
    }
}

const ANALYTICS_MIN_INTERVAL: Duration = Duration::from_millis(16);

pub fn start_analytics_worker(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let (tx, rx): (Sender<AnalyticsJob>, Receiver<AnalyticsJob>) = mpsc::channel();
    *state.analytics_worker_tx.lock().unwrap() = Some(tx);

    std::thread::spawn(move || {
        let mut last_run: Option<std::time::Instant> = None;
        while let Ok(mut job) = rx.recv() {
            if let Some(remaining) =
                last_run.and_then(|t| ANALYTICS_MIN_INTERVAL.checked_sub(t.elapsed()))
            {
                std::thread::sleep(remaining);
            }
            while let Ok(latest) = rx.try_recv() {
                job = latest;
            }
            last_run = Some(std::time::Instant::now());

            let histogram_data = calculate_histogram(&job.frame).ok();

            let waveform_data = if job.compute_waveform {
                calculate_waveform(&job.frame, job.active_waveform_channel.as_deref()).ok()
            } else {
                None
            };

            if histogram_data.is_some() || waveform_data.is_some() {
                let state = app_handle.state::<AppState>();
                let channel = state.analytics_channel.lock().unwrap().clone();
                if let Some(channel) = channel {
                    let packet = encode_analytics_packet(
                        &job.path,
                        histogram_data.as_ref(),
                        waveform_data.as_ref(),
                    );
                    let _ = channel.send(InvokeResponseBody::Raw(packet));
                }
            }
        }
    });
}

fn catch_render_panic(render: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<Vec<u8>, String> {
    panic::catch_unwind(panic::AssertUnwindSafe(render))
        .unwrap_or_else(|_| Err("Preview rendering panicked".to_string()))
}

fn run_editor_job(app_handle: &tauri::AppHandle, job: PreviewJob) {
    let state = app_handle.state::<AppState>();
    let responder = job.responder;
    let rendered_source = (job.layer == DisplayLayer::Edited
        && state.image_preloader.is_awaiting_frame())
    .then(|| {
        let generation = state.load_image_generation.load(Ordering::SeqCst);
        state
            .original_image
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|loaded| (generation, loaded.path.clone()))
    })
    .flatten();
    let result = catch_render_panic(|| {
        process_preview_job(
            app_handle,
            state,
            job.adjustments,
            job.layer,
            job.is_interactive,
            job.target_resolution,
            job.roi,
            job.request_analytics,
            job.compute_waveform,
            job.active_waveform_channel.as_deref(),
            PreviewTarget::Editor,
        )
    });
    match result {
        Ok(bytes) => {
            let _ = responder.send(bytes);
            let state = app_handle.state::<AppState>();
            if let Some((generation, path)) = rendered_source
                && state.load_image_generation.load(Ordering::SeqCst) == generation
            {
                state.image_preloader.frame_rendered(&path);
            }
            if job.layer == DisplayLayer::Edited && !job.is_interactive {
                crate::platform::viewer_window::schedule_viewer_render(app_handle);
            }
        }
        Err(e) => {
            log::error!("Preview worker error: {}", e);
        }
    }
}

fn run_viewer_job(app_handle: &tauri::AppHandle) {
    let Some((adjustments, target_resolution)) =
        crate::platform::viewer_window::pending_viewer_render(app_handle)
    else {
        return;
    };
    let result = catch_render_panic(|| {
        process_preview_job(
            app_handle,
            app_handle.state::<AppState>(),
            adjustments,
            DisplayLayer::Edited,
            false,
            Some(target_resolution),
            None,
            false,
            false,
            None,
            PreviewTarget::Viewer,
        )
    });
    if let Err(e) = result {
        log::error!("Viewer preview error: {}", e);
    }
}

pub fn start_preview_worker(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let (tx, rx): (Sender<PreviewTask>, Receiver<PreviewTask>) = mpsc::channel();

    *state.preview_worker_tx.lock().unwrap() = Some(tx);

    std::thread::spawn(move || {
        let mut viewer_pending = false;
        loop {
            let first = if viewer_pending {
                rx.try_recv().ok()
            } else {
                match rx.recv() {
                    Ok(task) => Some(task),
                    Err(_) => break,
                }
            };

            let mut latest: [Option<PreviewJob>; 2] = [None, None];
            for task in first.into_iter().chain(rx.try_iter()) {
                match task {
                    PreviewTask::Editor(job) => {
                        let slot = job.layer as usize;
                        latest[slot] = Some(job);
                    }
                    PreviewTask::Viewer => viewer_pending = true,
                }
            }

            if latest.iter().any(Option::is_some) {
                for job in latest.into_iter().flatten() {
                    run_editor_job(&app_handle, job);
                }
            } else if std::mem::take(&mut viewer_pending) {
                run_viewer_job(&app_handle);
            }
        }
    });
}
