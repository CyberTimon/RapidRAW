pub mod encode;
pub mod geometry;
pub mod masks;
pub mod original;
pub mod settings;
pub mod size_estimate;
pub mod tasks;
pub mod watermark;

use crate::adjustments::develop_defaults;
use std::borrow::Cow;
use std::collections::HashMap;
#[cfg(not(target_os = "android"))]
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use image::{DynamicImage, ImageBuffer, Luma};
use serde_json::Value;
use tauri::Emitter;
use tauri::Manager;

use crate::adjustments::lut_processing::{export_adjustments_as_lut, get_or_load_lut};
use crate::app::launch_request::HeadlessExportSession;
use crate::app::settings::load_settings;
use crate::app::state::AppState;
use crate::decode::as_shot::as_shot;
use crate::decode::formats::is_raw_file;
use crate::decode::image_loader::prepare_base_image_cow;
use crate::export::encode::{save_image_with_metadata, set_timestamps_from_exif};
use crate::export::geometry::apply_export_geometry_and_watermark;
use crate::export::masks::export_masks_for_image;
use crate::export::original::{
    load_export_source_image, original_export_adjustments, original_output_path,
};
use crate::export::settings::{ExportAdjustmentsMode, ExportSettings, render_output_precision};
use crate::export::tasks::{
    ExportTaskGuard, ensure_export_not_cancelled, estimate_export_memory, finish_export_task,
    register_export_task,
};
use crate::export::watermark::{WatermarkCacheGuard, clear_watermark_cache};
use crate::library::file_ops::generate_filename_from_template;
use crate::library::sidecars::parse_virtual_path;
use crate::masks::generation::{
    MaskDefinition, build_warped_image_for_masks, generate_mask_bitmap,
};
use crate::metadata::exif_processing;
use crate::render::adjustment_utils::hydrate_adjustments;
use crate::render::gpu::context::{GpuContext, get_or_init_gpu_context};
use crate::render::gpu::output::process_and_get_dynamic_image_with_precision;
use crate::render::gpu::processor::{RenderOutputPrecision, RenderRequest};
use crate::render::options::resolve_render_options_from_handle;
use crate::render::preview::cached_patched_image;
use crate::render::source::{RenderSource, fit_to_gpu, source_id};
use crate::render::uniforms::get_all_adjustments_from_json;

#[allow(clippy::too_many_arguments)]
fn process_image_for_export_pipeline(
    path: &str,
    base_image: &DynamicImage,
    base_scale: f32,
    js_adjustments: &Value,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    is_raw: bool,
    debug_tag: &str,
    app_handle: &tauri::AppHandle,
    output_precision: RenderOutputPrecision,
) -> Result<DynamicImage, String> {
    let (fitted, fit_scale) = fit_to_gpu(context, base_image);
    let scale = fit_scale * base_scale;
    let source = RenderSource::edited(
        &fitted,
        source_id("export", path, js_adjustments),
        path,
        js_adjustments,
    )
    .scaled(scale);
    let crop_offset = source.crop_offset();
    let (img_w, img_h) = source.size();

    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let warped_image = build_warped_image_for_masks(
        base_image,
        base_scale,
        is_raw,
        path,
        js_adjustments,
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

    let render = resolve_render_options_from_handle(app_handle, is_raw);
    let mut all_adjustments =
        get_all_adjustments_from_json(js_adjustments, is_raw, as_shot(path), render);
    all_adjustments.global.show_clipping = 0;

    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| get_or_load_lut(state, p).ok());

    process_and_get_dynamic_image_with_precision(
        context,
        state,
        &source,
        RenderRequest {
            adjustments: all_adjustments,
            mask_bitmaps: &mask_bitmaps,
            mask_cache_key: None,
            lut,
            roi: None,
            hsl_probe: false,
            motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                path,
                js_adjustments,
                (img_w, img_h),
                crop_offset,
                base_image.width().max(base_image.height()) as f32 * fit_scale,
            ),
        },
        debug_tag,
        output_precision,
    )
}

#[allow(clippy::too_many_arguments)]
fn process_image_for_export(
    path: &str,
    base_image: &DynamicImage,
    base_scale: f32,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    is_raw: bool,
    app_handle: &tauri::AppHandle,
    output_format: &str,
) -> Result<DynamicImage, String> {
    let processed_image = process_image_for_export_pipeline(
        path,
        base_image,
        base_scale,
        js_adjustments,
        context,
        state,
        is_raw,
        "process_image_for_export",
        app_handle,
        render_output_precision(output_format, export_settings),
    )?;

    apply_export_geometry_and_watermark(processed_image, export_settings).map(|(image, _)| image)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn export_images_impl(
    paths: Vec<String>,
    output_folder_or_file: String,
    is_explicit_file_path: bool,
    base_origin_folders: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    adjustments_mode: ExportAdjustmentsMode,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    completion_tx: Option<tokio::sync::oneshot::Sender<Result<(), usize>>>,
) -> Result<(), String> {
    let cancellation_token = register_export_task(&state.export_task_token)?;
    clear_watermark_cache();
    let task_guard = ExportTaskGuard::with_app_handle(
        Arc::clone(&state.export_task_token),
        Arc::clone(&cancellation_token),
        app_handle.clone(),
    );
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    if cancellation_token.load(Ordering::SeqCst) {
        return Ok(());
    }

    let context = match get_or_init_gpu_context(&state, &app_handle) {
        Ok(context) => context,
        Err(_) if cancellation_token.load(Ordering::SeqCst) => return Ok(()),
        Err(error) => return Err(error),
    };

    if cancellation_token.load(Ordering::SeqCst) {
        return Ok(());
    }

    let context = Arc::new(context);
    let progress_counter = Arc::new(AtomicUsize::new(0));

    let available_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);

    let mut sys = sysinfo::System::new();
    sys.refresh_memory();

    let app_settings = load_settings(app_handle.clone()).unwrap_or_default();
    let memory_limit = app_settings.export_memory_limit.unwrap_or(80).clamp(25, 95);

    let available_ram = sys.available_memory();
    let available_ram_gb = available_ram as f64 / 1024.0 / 1024.0 / 1024.0;
    let memory_budget = crate::app::memory_budget::MemoryBudget::new(
        (available_ram as f64 * memory_limit as f64 / 100.0) as u64,
    );

    let num_threads = if paths.len() == 1 {
        1
    } else {
        match app_settings.export_worker_threads {
            Some(threads) if threads > 0 => (threads as usize).clamp(1, 8),
            _ => available_cores.clamp(1, 4),
        }
    };

    log::info!(
        "Batch Export: {} cores, {:.1} GB free RAM -> up to {} threads",
        available_cores,
        available_ram_gb,
        num_threads
    );

    let _export_task = tokio::spawn(async move {
        let _watermark_cache_guard = WatermarkCacheGuard;
        let _task_guard = task_guard;
        let output_folder_path = std::path::Path::new(&output_folder_or_file);
        let total_paths = paths.len();
        let settings = load_settings(app_handle.clone()).unwrap_or_default();

        let mut base_path_counts: HashMap<String, usize> = HashMap::new();
        let mut export_items = Vec::with_capacity(total_paths);

        for (i, path_str) in paths.into_iter().enumerate() {
            let (source_path, _) = parse_virtual_path(&path_str);
            let source_str = source_path.to_string_lossy().to_string();
            let count = base_path_counts.entry(source_str.clone()).or_insert(0);
            *count += 1;

            let mut explicit_vc = None;
            if let Some(idx) = path_str.rfind("vc=") {
                let id_str = path_str[idx + 3..].split('&').next().unwrap_or("");
                if let Ok(id) = id_str.parse::<u32>() {
                    explicit_vc = Some(id);
                }
            }
            if explicit_vc.is_none() {
                let lower = path_str.to_lowercase();
                if let Some(idx) = lower.rfind("_vc") {
                    let id_str: String = lower[idx + 3..]
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    if let Ok(id) = id_str.parse::<u32>() {
                        explicit_vc = Some(id);
                    }
                }
            }
            export_items.push((i, path_str, *count, explicit_vc));
        }

        let used_paths = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(num_threads));
        let mut join_handles = Vec::new();

        for (global_index, image_path_str, appearance_count, explicit_vc) in export_items {
            if cancellation_token.load(Ordering::SeqCst) {
                break;
            }
            let permit = semaphore.clone().acquire_owned().await.unwrap();
            if cancellation_token.load(Ordering::SeqCst) {
                drop(permit);
                break;
            }

            let app_handle_clone = app_handle.clone();
            let context_clone = Arc::clone(&context);
            let progress_counter_clone = Arc::clone(&progress_counter);
            let output_folder_path = output_folder_path.to_path_buf();
            let base_origin_folders = base_origin_folders.clone();
            let export_settings = export_settings.clone();
            let output_format = output_format.clone();
            let settings = settings.clone();
            let cancellation_token_clone = Arc::clone(&cancellation_token);
            let adjustments_mode = adjustments_mode.clone();
            let used_paths_clone = Arc::clone(&used_paths);
            let memory_budget = Arc::clone(&memory_budget);

            let handle = tokio::task::spawn_blocking(move || {
                ensure_export_not_cancelled(&cancellation_token_clone)?;

                let state = app_handle_clone.state::<AppState>();
                let (source_path, sidecar_path) = parse_virtual_path(&image_path_str);
                let source_path_str = source_path.to_string_lossy().to_string();
                tauri::async_runtime::block_on(crate::integrations::immich::ensure_local(
                    &app_handle_clone,
                    &source_path,
                ))?;

                let is_current_edit = match &adjustments_mode {
                    ExportAdjustmentsMode::UseSidecars { active_path, .. } => {
                        Some(&image_path_str) == active_path.as_ref()
                    }
                    ExportAdjustmentsMode::GlobalOverride(_) => false,
                };

                if !is_current_edit
                    && matches!(adjustments_mode, ExportAdjustmentsMode::UseSidecars { .. })
                {
                    crate::ai::jobs::ensure_ready(&app_handle_clone, &image_path_str)
                        .map_err(|e| format!("Failed to generate AI results for export: {}", e))?;
                }

                let sidecar = crate::metadata::sidecar::load_sidecar(&sidecar_path);
                let export_xmp =
                    crate::metadata::export_metadata::ExportXmp::from_metadata(&sidecar);

                let mut js_adjustments = match &adjustments_mode {
                    ExportAdjustmentsMode::UseSidecars {
                        active_adjustments, ..
                    } => {
                        if is_current_edit {
                            if let Some(adj) = active_adjustments {
                                adj.clone()
                            } else {
                                develop_defaults::resolve(&sidecar.adjustments, &source_path)
                                    .into_owned()
                            }
                        } else {
                            develop_defaults::resolve(&sidecar.adjustments, &source_path)
                                .into_owned()
                        }
                    }
                    ExportAdjustmentsMode::GlobalOverride(adj) => {
                        let mut adj = adj.clone();
                        crate::ai::jobs::resolve_detached(
                            &app_handle_clone,
                            &image_path_str,
                            &mut adj,
                        )
                        .map_err(|e| format!("Failed to generate AI results for export: {}", e))?;
                        adj
                    }
                };

                hydrate_adjustments(&state, &mut js_adjustments);
                let is_raw = is_raw_file(&source_path_str);
                let original_path = std::path::Path::new(&source_path_str);
                let file_date = exif_processing::get_creation_date_from_path(original_path);

                let filename_template = export_settings
                    .filename_template
                    .as_deref()
                    .unwrap_or("{original_filename}_edited");

                let mut new_stem = generate_filename_from_template(
                    filename_template,
                    original_path,
                    global_index + 1,
                    total_paths,
                    &file_date,
                );

                if let Some(vc_id) = explicit_vc {
                    new_stem = format!("{}_VC{:02}", new_stem, vc_id);
                } else if appearance_count > 1 {
                    new_stem = format!("{}_VC{:02}", new_stem, appearance_count - 1);
                }

                let new_filename = format!("{}.{}", new_stem, output_format);

                let mut output_path =
                    if export_settings.destination_type.as_deref() == Some("originalFolder") {
                        let mut dir = source_path
                            .parent()
                            .unwrap_or(std::path::Path::new(""))
                            .to_path_buf();
                        if let Some(sub) = &export_settings.subfolder {
                            let mut trimmed = sub.trim();

                            while trimmed.starts_with('/') || trimmed.starts_with('\\') {
                                trimmed = &trimmed[1..];
                            }

                            if !trimmed.is_empty() {
                                dir = dir.join(trimmed);
                            }
                        }

                        if let Err(e) = std::fs::create_dir_all(&dir) {
                            return Err(format!(
                                "Failed to create export subdirectory '{}': {}",
                                dir.display(),
                                e
                            ));
                        }

                        dir.join(&new_filename)
                    } else if is_explicit_file_path && total_paths == 1 {
                        output_folder_path.clone()
                    } else if export_settings.preserve_folders {
                        if let Some(rel_dir) = relative_export_dir_for_preserved_folders(
                            source_path.as_path(),
                            &base_origin_folders,
                        ) {
                            let full_dir = output_folder_path.join(rel_dir);
                            if let Err(e) = std::fs::create_dir_all(&full_dir) {
                                return Err(format!(
                                    "Failed to create export subdirectory '{}': {}",
                                    full_dir.display(),
                                    e
                                ));
                            }
                            full_dir.join(&new_filename)
                        } else {
                            output_folder_path.join(&new_filename)
                        }
                    } else {
                        output_folder_path.join(&new_filename)
                    };

                let extension = output_format.to_lowercase();

                if !(is_explicit_file_path && total_paths == 1) {
                    let mut used = used_paths_clone.lock().unwrap();
                    let parent_dir = output_path
                        .parent()
                        .unwrap_or(std::path::Path::new(""))
                        .to_path_buf();
                    let mut counter = 1;
                    let export_original = export_settings.export_original.is_some();
                    let is_taken = |path: &PathBuf| path.exists() || used.contains(path);

                    while is_taken(&output_path)
                        || (export_original && is_taken(&original_output_path(&output_path)))
                    {
                        let incremented_filename =
                            format!("{}_{}.{}", new_stem, counter, extension);
                        output_path = parent_dir.join(&incremented_filename);
                        counter += 1;
                    }
                    if export_original {
                        used.insert(original_output_path(&output_path));
                    }
                    used.insert(output_path.clone());
                }

                let result: Result<(), String> = (|| {
                    if extension == "cube" {
                        let cube_bytes = export_adjustments_as_lut(
                            &js_adjustments,
                            &source_path_str,
                            &context_clone,
                            &state,
                            &app_handle_clone,
                            &cancellation_token_clone,
                        )?;
                        ensure_export_not_cancelled(&cancellation_token_clone)?;
                        #[cfg(target_os = "android")]
                        {
                            let file_name = output_path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .ok_or_else(|| "Missing Android LUT file name".to_string())?;
                            crate::platform::android::save_file_bytes_to_android_downloads(
                                file_name,
                                "application/octet-stream",
                                &cube_bytes,
                            )?;
                        }
                        #[cfg(not(target_os = "android"))]
                        fs::write(&output_path, cube_bytes).map_err(|e| e.to_string())?;
                        ensure_export_not_cancelled(&cancellation_token_clone)?;
                        return Ok(());
                    }

                    let loaded_image = if is_current_edit {
                        state
                            .original_image
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .clone()
                            .filter(|loaded| {
                                parse_virtual_path(&loaded.path).0
                                    == parse_virtual_path(&source_path_str).0
                            })
                    } else {
                        None
                    };

                    let estimated_memory = estimate_export_memory(
                        &source_path_str,
                        is_raw,
                        loaded_image
                            .as_ref()
                            .map(|loaded| (loaded.image.width(), loaded.image.height())),
                        js_adjustments["masks"].as_array().map_or(0, |m| m.len()),
                        &output_format,
                        export_settings.jpeg_quality,
                    );
                    let Some(_export_reservation) =
                        memory_budget.reserve(estimated_memory, Some(&cancellation_token_clone))
                    else {
                        return Err("Export cancelled".to_string());
                    };
                    let Some(_app_reservation) = state
                        .memory_budget
                        .reserve(estimated_memory, Some(&cancellation_token_clone))
                    else {
                        return Err("Export cancelled".to_string());
                    };

                    let cached_patched = loaded_image.as_ref().and_then(|loaded_image| {
                        cached_patched_image(&state, &loaded_image.image, &js_adjustments)
                    });

                    let (source_image, source_image_path) = match &loaded_image {
                        Some(loaded_image) => {
                            (Arc::clone(&loaded_image.image), loaded_image.path.as_str())
                        }
                        None => (
                            Arc::new(load_export_source_image(&source_path_str, &settings)?),
                            source_path_str.as_str(),
                        ),
                    };
                    let prepare_base = |adjustments: &Value| -> Result<Arc<DynamicImage>, String> {
                        match prepare_base_image_cow(&source_image, source_image_path, adjustments)
                            .map_err(|e| format!("Failed to composite AI patches: {}", e))?
                        {
                            Cow::Owned(prepared) => Ok(Arc::new(prepared)),
                            Cow::Borrowed(_) => Ok(Arc::clone(&source_image)),
                        }
                    };

                    let base_image = match cached_patched {
                        Some(patched) => patched,
                        None => prepare_base(&js_adjustments)?,
                    };
                    let base_scale = crate::ai::upscale::scale_between(&source_image, &base_image);
                    let original_render = export_settings
                        .export_original
                        .as_ref()
                        .map(|options| {
                            let adjustments = original_export_adjustments(&js_adjustments, options);
                            prepare_base(&adjustments).map(|base| {
                                let scale = crate::ai::upscale::scale_between(&source_image, &base);
                                (base, scale, adjustments)
                            })
                        })
                        .transpose()?;
                    drop(source_image);
                    let mut base_image = Some(base_image);
                    ensure_export_not_cancelled(&cancellation_token_clone)?;

                    let mut main_export_adjustments = js_adjustments.clone();
                    if export_settings.export_masks
                        && let Some(obj) = main_export_adjustments.as_object_mut()
                    {
                        obj.insert("masks".to_string(), serde_json::json!([]));
                    }

                    let actual_output_format = output_path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .unwrap_or(output_format.as_str());

                    let final_image = process_image_for_export(
                        &source_path_str,
                        base_image.as_deref().unwrap(),
                        base_scale,
                        &main_export_adjustments,
                        &export_settings,
                        &context_clone,
                        &state,
                        is_raw,
                        &app_handle_clone,
                        actual_output_format,
                    )?;
                    if !export_settings.export_masks {
                        base_image = None;
                    }
                    ensure_export_not_cancelled(&cancellation_token_clone)?;
                    save_image_with_metadata(
                        &final_image,
                        &output_path,
                        &source_path_str,
                        &export_xmp,
                        &export_settings,
                    )?;
                    ensure_export_not_cancelled(&cancellation_token_clone)?;

                    if export_settings.preserve_timestamps {
                        set_timestamps_from_exif(Path::new(&source_path_str), &output_path);
                    }
                    ensure_export_not_cancelled(&cancellation_token_clone)?;

                    if let Some((original_base, original_scale, original_adjustments)) =
                        original_render
                    {
                        let original_image = process_image_for_export(
                            &source_path_str,
                            &original_base,
                            original_scale,
                            &original_adjustments,
                            &export_settings,
                            &context_clone,
                            &state,
                            is_raw,
                            &app_handle_clone,
                            actual_output_format,
                        )?;
                        drop(original_base);
                        ensure_export_not_cancelled(&cancellation_token_clone)?;
                        let original_path = original_output_path(&output_path);
                        save_image_with_metadata(
                            &original_image,
                            &original_path,
                            &source_path_str,
                            &export_xmp,
                            &export_settings,
                        )?;
                        if export_settings.preserve_timestamps {
                            set_timestamps_from_exif(Path::new(&source_path_str), &original_path);
                        }
                        ensure_export_not_cancelled(&cancellation_token_clone)?;
                    }

                    if export_settings.export_masks
                        && let Some(base_image) = &base_image
                    {
                        export_masks_for_image(
                            base_image,
                            base_scale,
                            &js_adjustments,
                            &export_settings,
                            &output_path,
                            &source_path_str,
                            &export_xmp,
                            &context_clone,
                            &state,
                            is_raw,
                            &app_handle_clone,
                            &cancellation_token_clone,
                        )?;
                    }

                    crate::integrations::immich::on_exported(
                        &app_handle_clone,
                        &source_path_str,
                        &output_path,
                    )
                })();

                if !cancellation_token_clone.load(Ordering::SeqCst) {
                    let current_progress =
                        progress_counter_clone.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app_handle_clone.emit(
                        "batch-export-progress",
                        serde_json::json!({
                            "current": current_progress,
                            "total": total_paths,
                            "path": &image_path_str
                        }),
                    );
                }

                drop(permit);
                if cancellation_token_clone.load(Ordering::SeqCst) {
                    Err("Export cancelled".to_string())
                } else {
                    result
                }
            });

            join_handles.push(handle);
        }

        let mut results = Vec::new();
        for handle in join_handles {
            match handle.await {
                Ok(res) => results.push(res),
                Err(e) => results.push(Err(format!("Thread crashed: {}", e))),
            }
        }

        let errors: Vec<String> = results.into_iter().filter_map(Result::err).collect();
        let error_count = errors.len();
        let export_state = app_handle.state::<AppState>();
        let finalized = finish_export_task(
            &export_state.export_task_token,
            &cancellation_token,
            |cancelled| {
                if cancelled {
                    log::info!("Batch export cancelled and worker cleanup completed");
                    let _ = app_handle.emit("export-cancelled", ());
                    return;
                }

                for error in &errors {
                    log::error!("Export error: {}", error);
                    if total_paths == 1 {
                        let _ = app_handle.emit("export-error", error.clone());
                    }
                }

                if error_count > 0 && total_paths > 1 {
                    let _ = app_handle.emit(
                        "export-error",
                        format!("{error_count} of {total_paths} exports failed"),
                    );
                } else if error_count == 0 {
                    let _ = app_handle.emit(
                        "batch-export-progress",
                        serde_json::json!({ "current": total_paths, "total": total_paths, "path": "" }),
                    );
                    let _ = app_handle.emit("export-complete", ());
                }
            },
        );

        if !finalized {
            log::warn!("Ignoring terminal events from a stale export task");
        }

        if let Some(tx) = completion_tx {
            if error_count > 0 {
                let _ = tx.send(Err(error_count));
            } else {
                let _ = tx.send(Ok(()));
            }
        }
    });

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn export_images_and_wait(
    paths: Vec<String>,
    output_folder_or_file: String,
    is_explicit_file_path: bool,
    base_origin_folders: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    adjustments_mode: ExportAdjustmentsMode,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    export_images_impl(
        paths,
        output_folder_or_file,
        is_explicit_file_path,
        base_origin_folders,
        export_settings,
        output_format,
        adjustments_mode,
        state,
        app_handle,
        Some(tx),
    )
    .await?;

    match rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(errors)) => Err(format!("Export completed with {} errors.", errors)),
        Err(_) => Err("Export task panicked or was cancelled.".to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_images(
    paths: Vec<String>,
    output_folder_or_file: String,
    is_explicit_file_path: bool,
    base_origin_folders: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    current_edit_path: Option<String>,
    current_edit_adjustments: Option<Value>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    export_images_impl(
        paths,
        output_folder_or_file,
        is_explicit_file_path,
        base_origin_folders,
        export_settings,
        output_format,
        ExportAdjustmentsMode::UseSidecars {
            active_path: current_edit_path,
            active_adjustments: current_edit_adjustments,
        },
        state,
        app_handle,
        None,
    )
    .await
}

pub async fn run_headless_export(
    session: HeadlessExportSession,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    cli_println!("Starting headless export...");
    let state = app_handle.state::<AppState>();

    let source_path = std::path::Path::new(&session.source);
    if !source_path.exists() {
        return Err(format!("Source path does not exist: {}", session.source));
    }

    let mut paths = Vec::new();
    if source_path.is_dir() {
        let images = crate::library::listing::list_images_recursive(
            session.source.clone(),
            app_handle.clone(),
        )
        .await?;
        paths = images.into_iter().map(|img| img.path).collect();
    } else {
        paths.push(session.source.clone());
    }

    if paths.is_empty() {
        return Err("No supported images found at the source path.".to_string());
    }

    let output_path = std::path::Path::new(&session.output);
    let is_explicit_file_path =
        paths.len() == 1 && output_path.extension().is_some() && !output_path.is_dir();

    if is_explicit_file_path {
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output parent directory: {}", e))?;
        }
    } else {
        std::fs::create_dir_all(&session.output)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    cli_println!("Found {} images to export. Processing...", paths.len());

    let export_settings = ExportSettings {
        jpeg_quality: session.quality,
        tiff_bit_depth: session.tiff_bit_depth,
        resize: None,
        border: None,
        pad: None,
        keep_metadata: session.keep_metadata,
        preserve_timestamps: true,
        strip_gps: false,
        filename_template: None,
        watermark: None,
        export_masks: false,
        preserve_folders: true,
        destination_type: None,
        subfolder: None,
        dpi: None,
        export_original: session.export_original,
    };

    let mut custom_adjustments = None;
    if let Some(adj_path) = &session.adjustments_override {
        let content = std::fs::read_to_string(adj_path)
            .map_err(|e| format!("Failed to read adjustments file: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse adjustments JSON: {}", e))?;
        custom_adjustments = Some(json);
        cli_println!(
            "Loaded custom adjustments to override sidecars from: {}",
            adj_path
        );
    }

    let mode = if let Some(adj) = custom_adjustments {
        ExportAdjustmentsMode::GlobalOverride(adj)
    } else {
        ExportAdjustmentsMode::UseSidecars {
            active_path: None,
            active_adjustments: None,
        }
    };

    export_images_and_wait(
        paths,
        session.output,
        is_explicit_file_path,
        vec![session.source],
        export_settings,
        session.format,
        mode,
        state.clone(),
        app_handle.clone(),
    )
    .await
}

fn relative_dir_is_safe(rel_dir: &Path) -> bool {
    rel_dir.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

#[cfg(windows)]
fn component_matches(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn component_matches(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    left == right
}

fn strip_prefix_preserving_source_case(source_path: &Path, base_path: &Path) -> Option<PathBuf> {
    let source_components: Vec<_> = source_path.components().collect();
    let base_components: Vec<_> = base_path.components().collect();

    if base_components.len() > source_components.len() {
        return None;
    }

    if !source_components
        .iter()
        .zip(base_components.iter())
        .all(|(source, base)| component_matches(*source, *base))
    {
        return None;
    }

    Some(source_components[base_components.len()..].iter().collect())
}

fn relative_export_dir_for_preserved_folders(
    source_path: &Path,
    base_origin_folders: &[String],
) -> Option<PathBuf> {
    base_origin_folders
        .iter()
        .filter_map(|base| {
            let base_path = Path::new(base);
            strip_prefix_preserving_source_case(source_path, base_path)
                .map(|rel_path| (base_path.components().count(), rel_path))
        })
        .max_by_key(|(component_count, _)| *component_count)
        .and_then(|(_, rel_path)| {
            let rel_dir = rel_path.parent().unwrap_or_else(|| Path::new(""));
            if relative_dir_is_safe(rel_dir) {
                Some(rel_dir.to_path_buf())
            } else {
                None
            }
        })
}
