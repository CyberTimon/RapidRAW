use crate::adjustments::auto_adjust::{
    AutoAdjustMode, auto_results_to_json, perform_auto_analysis,
};
use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::AppState;
use crate::decode::as_shot::as_shot;
use crate::decode::baseline_exposure::BaselineOptions;
use crate::decode::image_loader;
use crate::library::albums::add_to_album;
use crate::library::file_ops::{read_file_mapped, write_file_atomic};
use crate::library::listing::{ImageFileMetadata, emit_image_metadata_loaded};
use crate::library::tagging::COLOR_TAG_PREFIX;
use crate::library::thumbnails::{
    add_to_thumbnail_queue, emit_thumbnail_cache_setup_error, emit_thumbnail_generated,
    generate_single_thumbnail_and_cache, increment_thumbnail_progress, regenerate_thumbnails,
    resolve_thumbnail_cache_dir,
};
use crate::metadata::sidecar::{ImageFlag, ImageMetadata, is_image_edited};
use crate::metadata::xmp::{parse_gps_components, sync_metadata_from_xmp, sync_metadata_to_xmp};
use crate::render::adjustment_utils::{default_adjustments, effective_baseline_exposure};
use crate::render::gpu::context::get_or_init_gpu_context;
use crate::render::options::resolve_tonemapper_override;
use anyhow::Result;
use image::DynamicImage;
use rayon::prelude::*;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::{fs, thread};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

pub fn parse_sidecar_name(file_name: &str) -> Option<(&str, Option<&str>)> {
    let base = file_name.strip_suffix(".rrdata")?;
    if base.len() >= 7 && base.as_bytes()[base.len() - 7] == b'.' {
        let id = &base[base.len() - 6..];
        if id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return Some((&base[..base.len() - 7], Some(id)));
        }
    }
    Some((base, None))
}

pub fn parse_virtual_path(virtual_path: &str) -> (PathBuf, PathBuf) {
    let (source_path_str, copy_id) = if let Some((base, id)) = virtual_path.rsplit_once("?vc=") {
        (base.to_string(), Some(id.to_string()))
    } else {
        (virtual_path.to_string(), None)
    };

    let source_path = PathBuf::from(source_path_str);

    let sidecar_filename = if let Some(id) = copy_id {
        format!(
            "{}.{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            id
        )
    } else {
        format!(
            "{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    };

    let sidecar_path = source_path.with_file_name(sidecar_filename);
    (source_path, sidecar_path)
}

#[tauri::command]
pub fn save_metadata_and_update_thumbnail(
    path: String,
    adjustments: Value,
    app_handle: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let (source_path, sidecar_path) = parse_virtual_path(&path);
    let source_id = crate::ai::jobs::source_id(&source_path);
    let mut stripped_ai_results = false;
    let mut had_ai_work = false;

    let metadata =
        crate::metadata::sidecar::update_sidecar(&sidecar_path, &source_path, |metadata| {
            crate::metadata::sidecar::fill_missing_exif(metadata, &source_path);
            had_ai_work = crate::ai::jobs::needs_generation(&metadata.adjustments, &source_path);
            let mut final_adjustments = adjustments;
            if let Some(source_id) = &source_id {
                stripped_ai_results = crate::ai::jobs::reconcile_ai_results(
                    &mut final_adjustments,
                    &metadata.adjustments,
                    source_id,
                    true,
                );
            }
            metadata.adjustments = final_adjustments;
        })
        .map_err(|e| e.to_string())?;

    if stripped_ai_results {
        crate::ai::jobs::enqueue(&app_handle, std::slice::from_ref(&path), true);
    } else if had_ai_work && !crate::ai::jobs::needs_generation(&metadata.adjustments, &source_path)
    {
        crate::ai::jobs::resolve(&app_handle, std::slice::from_ref(&path));
    }

    if let Ok(settings) = load_settings(app_handle.clone())
        && settings.enable_xmp_sync.unwrap_or(false)
    {
        let create_if_missing = settings.create_xmp_if_missing.unwrap_or(false);
        sync_metadata_to_xmp(&source_path, &sidecar_path, &metadata, create_if_missing);
    }

    let loaded_image_lock = state.original_image.lock().unwrap();
    let preloaded_image_option = if let Some(loaded_image) = loaded_image_lock.as_ref() {
        if loaded_image.path == path {
            Some(loaded_image.image.clone())
        } else {
            None
        }
    } else {
        None
    };
    drop(loaded_image_lock);

    let gpu_context = get_or_init_gpu_context(&state, &app_handle).ok();
    let app_handle_clone = app_handle.clone();
    let path_clone = path.clone();

    add_to_thumbnail_queue(&state, 1, &app_handle);

    thread::spawn(move || {
        let state = app_handle_clone.state::<AppState>();
        let settings = load_settings(app_handle_clone.clone()).unwrap_or_default();

        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle_clone) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!(
                    "Unable to initialize thumbnail cache directory for '{}': {}",
                    path_clone,
                    e
                );
                emit_thumbnail_cache_setup_error(&app_handle_clone, &path_clone, &e);
                increment_thumbnail_progress(&state, &app_handle_clone);
                return;
            }
        };

        let result = generate_single_thumbnail_and_cache(
            &path_clone,
            &thumb_cache_dir,
            gpu_context.as_ref(),
            preloaded_image_option.as_deref(),
            true,
            &app_handle_clone,
            &settings,
            None,
        );

        if let Some((small_path, medium_path, rating, is_edited)) = result {
            emit_thumbnail_generated(
                &app_handle_clone,
                &path_clone,
                &small_path,
                &medium_path,
                rating,
                is_edited,
            );
        }

        increment_thumbnail_progress(&state, &app_handle_clone);
    });

    Ok(())
}

#[tauri::command]
pub async fn apply_adjustments_to_paths(
    paths: Vec<String>,
    adjustments: Value,
    app_handle: AppHandle,
) -> Result<(), String> {
    let regenerates_ai = crate::ai::jobs::has_ai_results(&adjustments);
    if regenerates_ai {
        crate::ai::jobs::reserve(&paths);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let reserved_paths = paths.clone();
        let jobs_app_handle = app_handle.clone();
        let ai_work = std::sync::Mutex::new(Vec::new());
        let ai_work_ref = &ai_work;
        update_sidecars_and_thumbnails(paths, app_handle, move |path, source_path, metadata| {
            crate::metadata::sidecar::fill_missing_exif(metadata, source_path);

            if metadata.adjustments.is_null() {
                metadata.adjustments = default_adjustments(source_path);
            }

            let mut pasted = adjustments.clone();
            let source_id = regenerates_ai
                .then(|| crate::ai::jobs::source_id(source_path))
                .flatten();
            if let Some(source_id) = &source_id {
                crate::ai::jobs::reconcile_ai_results(
                    &mut pasted,
                    &metadata.adjustments,
                    source_id,
                    false,
                );
            }

            if let (Some(new_map), Some(pasted_map)) =
                (metadata.adjustments.as_object_mut(), pasted.as_object())
            {
                for (k, v) in pasted_map {
                    new_map.insert(k.clone(), v.clone());
                }
            }

            if let Some(source_id) = &source_id
                && crate::ai::jobs::has_pending_jobs(&metadata.adjustments, path, source_id)
            {
                ai_work_ref.lock().unwrap().push(path.to_string());
            }
        });

        if regenerates_ai {
            crate::ai::jobs::enqueue(&jobs_app_handle, &ai_work.into_inner().unwrap(), false);
            crate::ai::jobs::release(&reserved_paths);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn revert_gps_in_metadata_and_cache(
    source_path: &Path,
    metadata: &mut ImageMetadata,
) -> Option<(f64, f64)> {
    let mut exif_map = metadata.exif.clone().unwrap_or_default();

    let orig_from_sidecar = if let (Some(orig_lat_str), Some(orig_lon_str)) = (
        exif_map.get("OriginalGPSLatitude"),
        exif_map.get("OriginalGPSLongitude"),
    ) {
        let lat_ref = exif_map
            .get("OriginalGPSLatitudeRef")
            .cloned()
            .unwrap_or_else(|| "N".to_string());
        let lon_ref = exif_map
            .get("OriginalGPSLongitudeRef")
            .cloned()
            .unwrap_or_else(|| "E".to_string());
        if let (Some((ld, lm, ls)), Some((od, om, os))) = (
            parse_gps_components(orig_lat_str),
            parse_gps_components(orig_lon_str),
        ) {
            let mut lat_val = ld as f64 + lm / 60.0 + ls / 3600.0;
            if lat_ref.to_uppercase() == "S" {
                lat_val = -lat_val;
            }
            let mut lon_val = od as f64 + om / 60.0 + os / 3600.0;
            if lon_ref.to_uppercase() == "W" {
                lon_val = -lon_val;
            }
            Some((
                lat_val,
                lon_val,
                orig_lat_str.clone(),
                lat_ref,
                orig_lon_str.clone(),
                lon_ref,
            ))
        } else {
            None
        }
    } else {
        None
    };

    let native_opt = orig_from_sidecar.or_else(|| extract_native_gps(source_path));

    if let Some((lat_val, lon_val, lat_str, lat_ref, lon_str, lon_ref)) = native_opt {
        exif_map.insert("GPSLatitude".to_string(), lat_str.clone());
        exif_map.insert("GPSLatitudeRef".to_string(), lat_ref.clone());
        exif_map.insert("GPSLongitude".to_string(), lon_str.clone());
        exif_map.insert("GPSLongitudeRef".to_string(), lon_ref.clone());
        exif_map.insert("OriginalGPSLatitude".to_string(), lat_str);
        exif_map.insert("OriginalGPSLatitudeRef".to_string(), lat_ref);
        exif_map.insert("OriginalGPSLongitude".to_string(), lon_str);
        exif_map.insert("OriginalGPSLongitudeRef".to_string(), lon_ref);
        exif_map.insert("HasNativeGPS".to_string(), "true".to_string());
        exif_map.remove("IsGpsModified");

        crate::metadata::exif_cache::save_exif_to_rrcache(source_path, exif_map.clone());
        metadata.exif = Some(exif_map);
        Some((lat_val, lon_val))
    } else {
        exif_map.remove("GPSLatitude");
        exif_map.remove("GPSLatitudeRef");
        exif_map.remove("GPSLongitude");
        exif_map.remove("GPSLongitudeRef");
        exif_map.remove("OriginalGPSLatitude");
        exif_map.remove("OriginalGPSLatitudeRef");
        exif_map.remove("OriginalGPSLongitude");
        exif_map.remove("OriginalGPSLongitudeRef");
        exif_map.remove("IsGpsModified");
        exif_map.insert("HasNativeGPS".to_string(), "false".to_string());
        crate::metadata::exif_cache::save_exif_to_rrcache(source_path, exif_map.clone());
        metadata.exif = Some(exif_map);
        None
    }
}

#[tauri::command]
pub async fn reset_adjustments_for_paths(
    paths: Vec<String>,
    to_neutral: Option<bool>,
    app_handle: AppHandle,
) -> Result<HashMap<String, Option<(f64, f64)>>, String> {
    let reset_to = if to_neutral.unwrap_or(false) {
        crate::render::adjustment_utils::neutral_adjustments()
    } else {
        Value::Null
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let gps_results = std::sync::Mutex::new(HashMap::new());
        let gps_results_ref = &gps_results;
        update_sidecars_and_thumbnails(paths, app_handle, |path, source_path, metadata| {
            crate::metadata::sidecar::fill_missing_exif(metadata, source_path);
            metadata.adjustments = reset_to.clone();
            let gps_coords = revert_gps_in_metadata_and_cache(source_path, metadata);
            gps_results_ref
                .lock()
                .unwrap()
                .insert(path.to_string(), gps_coords);
        });

        gps_results.into_inner().unwrap()
    })
    .await;

    match result {
        Ok(map) => Ok(map),
        Err(e) => Err(format!("Task failed: {}", e)),
    }
}

fn update_sidecars_and_thumbnails(
    paths: Vec<String>,
    app_handle: AppHandle,
    update: impl Fn(&str, &Path, &mut ImageMetadata) + Sync,
) {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    let (updated_tx, updated_rx) = std::sync::mpsc::channel::<String>();
    let thumbnail_app_handle = app_handle.clone();
    let thumbnail_settings = settings.clone();
    tauri::async_runtime::spawn_blocking(move || {
        regenerate_thumbnails(
            updated_rx.into_iter(),
            &thumbnail_app_handle,
            &thumbnail_settings,
            false,
        );
    });

    let resolved_ai = std::sync::Mutex::new(Vec::new());
    paths
        .par_iter()
        .for_each_with(updated_tx, |updated_tx, path| {
            let (source_path, sidecar_path) = parse_virtual_path(path);
            let mut had_ai_work = false;
            match crate::metadata::sidecar::update_sidecar(
                &sidecar_path,
                &source_path,
                |metadata| {
                    had_ai_work =
                        crate::ai::jobs::needs_generation(&metadata.adjustments, &source_path);
                    update(path, &source_path, metadata)
                },
            ) {
                Ok(metadata) => {
                    if had_ai_work
                        && !crate::ai::jobs::needs_generation(&metadata.adjustments, &source_path)
                    {
                        resolved_ai.lock().unwrap().push(path.clone());
                    }
                    if enable_xmp_sync {
                        sync_metadata_to_xmp(
                            &source_path,
                            &sidecar_path,
                            &metadata,
                            create_xmp_if_missing,
                        );
                    }
                }
                Err(e) => log::error!("Failed to update sidecar for {}: {}", path, e),
            }

            let _ = updated_tx.send(path.clone());
        });

    crate::ai::jobs::resolve(&app_handle, &resolved_ai.into_inner().unwrap());
}

const RAM_PER_BATCH_DECODE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn run_batch_workers<T: Send>(items: impl Iterator<Item = T> + Send, work: impl Fn(T) + Sync) {
    static WORKERS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let workers = *WORKERS.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let ram_limit = (sys.total_memory() / RAM_PER_BATCH_DECODE_BYTES).max(1) as usize;
        rayon::current_num_threads().min(ram_limit).max(1)
    });

    let items = std::sync::Mutex::new(items);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let next = items.lock().unwrap_or_else(|e| e.into_inner()).next();
                    match next {
                        Some(item) => work(item),
                        None => break,
                    }
                }
            });
        }
    });
}

#[tauri::command]
pub async fn apply_auto_lens_correction_to_paths(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_sidecars_and_thumbnails(paths, app_handle, move |_, source_path, metadata| {
            crate::metadata::sidecar::fill_missing_exif(metadata, source_path);

            if metadata.adjustments.is_null() {
                metadata.adjustments = default_adjustments(source_path);
            }

            if let Some(obj) = metadata.adjustments.as_object_mut() {
                for (key, value) in
                    crate::adjustments::develop_defaults::auto_lens_correction_adjustments()
                {
                    obj.insert(key.to_string(), value);
                }
            }
        });
    })
    .await
    .map_err(|e| e.to_string())
}

const FULL_DECODE_WORKER_THREADS: usize = 2;

async fn update_sidecars_from_images(
    paths: Vec<String>,
    app_handle: AppHandle,
    operation: &'static str,
    fast_decode: bool,
    update: impl Fn(&DynamicImage, &str, &AppSettings, &mut Value) + Send + Sync + 'static,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = get_or_init_gpu_context(&state, &app_handle).ok();

        let process = |path: &String| {
            let loaded_image: Option<DynamicImage> = (|| -> Result<DynamicImage, String> {
                let (source_path, sidecar_path) = parse_virtual_path(path);
                let source_path_str = source_path.to_string_lossy().to_string();

                let file_bytes = read_file_mapped(&source_path).map_err(|e| e.to_string())?;
                let image = image_loader::load_base_image_from_bytes(
                    &file_bytes,
                    &source_path_str,
                    fast_decode,
                    &settings,
                    None,
                )
                .map_err(|e| e.to_string())?;

                let updated_metadata = crate::metadata::sidecar::update_sidecar(
                    &sidecar_path,
                    &source_path,
                    |metadata| {
                        if metadata.adjustments.is_null() {
                            metadata.adjustments = default_adjustments(&source_path);
                        }
                        update(
                            &image,
                            &source_path_str,
                            &settings,
                            &mut metadata.adjustments,
                        );
                    },
                )
                .map_err(|e| e.to_string())?;

                if enable_xmp_sync {
                    sync_metadata_to_xmp(
                        &source_path,
                        &sidecar_path,
                        &updated_metadata,
                        create_xmp_if_missing,
                    );
                }
                Ok(image)
            })()
            .map_err(|e| eprintln!("Failed to apply {} to {}: {}", operation, path, e))
            .ok();

            let result = generate_single_thumbnail_and_cache(
                path,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                loaded_image.as_ref(),
                true,
                &app_handle,
                &settings,
                None,
            );

            if let Some((small_path, medium_path, rating, is_edited)) = result {
                emit_thumbnail_generated(
                    &app_handle,
                    path,
                    &small_path,
                    &medium_path,
                    rating,
                    is_edited,
                );
            }

            increment_thumbnail_progress(&state, &app_handle);
        };

        if fast_decode {
            run_batch_workers(paths.iter(), process);
        } else if let Ok(pool) = rayon::ThreadPoolBuilder::new()
            .num_threads(FULL_DECODE_WORKER_THREADS)
            .build()
        {
            pool.install(|| paths.par_iter().for_each(process));
        } else {
            paths.iter().for_each(process);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apply_auto_adjustments_to_paths(
    paths: Vec<String>,
    mode: Option<AutoAdjustMode>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mode = mode.unwrap_or_default();
    update_sidecars_from_images(
        paths,
        app_handle,
        "auto adjustments",
        true,
        move |image, source_path, settings, adjustments| {
            let auto_results = perform_auto_analysis(
                image,
                effective_baseline_exposure(
                    adjustments,
                    as_shot(source_path),
                    BaselineOptions::from_settings(settings),
                ),
            );
            let auto_adjustments_json = auto_results_to_json(&auto_results, mode);

            let mut active_tools = crate::render::adjustment_utils::active_tools(adjustments);

            if let (Some(existing_map), Some(auto_map)) = (
                adjustments.as_object_mut(),
                auto_adjustments_json.as_object(),
            ) {
                for (k, v) in auto_map {
                    if k == "activeTools" {
                        if let Some(auto_tools) = v.as_object() {
                            active_tools.extend(auto_tools.clone());
                        }
                        existing_map.insert(
                            k.clone(),
                            serde_json::Value::Object(std::mem::take(&mut active_tools)),
                        );
                    } else {
                        existing_map.insert(k.clone(), v.clone());
                    }
                }
            }
        },
    )
    .await
}

#[tauri::command]
pub async fn apply_auto_straighten_to_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    update_sidecars_from_images(
        paths,
        app_handle,
        "auto straighten",
        false,
        |image, source_path, _, adjustments| {
            crate::adjustments::auto_straighten::straighten_adjustments(
                image,
                source_path,
                adjustments,
            )
        },
    )
    .await
}

fn update_metadata_for_paths(
    paths: &[String],
    app_handle: &AppHandle,
    update: impl Fn(&mut ImageMetadata) + Sync,
) {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    paths.par_iter().for_each(|path| {
        let (source_path, sidecar_path) = parse_virtual_path(path);

        match crate::metadata::sidecar::update_sidecar(&sidecar_path, &source_path, &update) {
            Ok(metadata) if enable_xmp_sync => {
                sync_metadata_to_xmp(
                    &source_path,
                    &sidecar_path,
                    &metadata,
                    create_xmp_if_missing,
                );
            }
            Ok(_) => {}
            Err(e) => log::error!("Failed to update sidecar for {}: {}", path, e),
        }
    });
}

#[tauri::command]
pub fn set_color_label_for_paths(
    paths: Vec<String>,
    color: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    update_metadata_for_paths(&paths, &app_handle, |metadata| {
        let mut tags = metadata.tags.take().unwrap_or_default();
        tags.retain(|tag| !tag.starts_with(COLOR_TAG_PREFIX));

        if let Some(c) = &color
            && !c.is_empty()
        {
            tags.push(format!("{}{}", COLOR_TAG_PREFIX, c));
        }

        if !tags.is_empty() {
            metadata.tags = Some(tags);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn set_rating_for_paths(
    paths: Vec<String>,
    rating: u8,
    app_handle: AppHandle,
) -> Result<(), String> {
    update_metadata_for_paths(&paths, &app_handle, |metadata| {
        metadata.rating = rating;
        if rating > 0 && metadata.flag == Some(ImageFlag::Reject) {
            metadata.flag = None;
        }
    });

    Ok(())
}

#[tauri::command]
pub fn set_flag_for_paths(
    paths: Vec<String>,
    flag: Option<ImageFlag>,
    app_handle: AppHandle,
) -> Result<(), String> {
    update_metadata_for_paths(&paths, &app_handle, |metadata| {
        metadata.flag = flag;
    });

    Ok(())
}

fn to_dms_string(val: f64) -> String {
    let abs_val = val.abs();
    let deg = abs_val.floor() as u32;
    let min_full = (abs_val - deg as f64) * 60.0;
    let min = min_full.floor() as u32;
    let sec = (min_full - min as f64) * 60.0;
    format!("{} deg {} min {:.4} sec", deg, min, sec)
}

pub fn extract_native_gps(
    source_path: &Path,
) -> Option<(f64, f64, String, String, String, String)> {
    let source_path_str = source_path.to_string_lossy();
    let map = if let Ok(mmap) = read_file_mapped(source_path) {
        crate::metadata::exif_processing::read_exif_data_from_bytes(&source_path_str, &mmap)
    } else if let Ok(bytes) = std::fs::read(source_path) {
        crate::metadata::exif_processing::read_exif_data_from_bytes(&source_path_str, &bytes)
    } else {
        return None;
    };

    let lat_str = map.get("GPSLatitude")?;
    let lon_str = map.get("GPSLongitude")?;
    let lat_ref = map
        .get("GPSLatitudeRef")
        .cloned()
        .unwrap_or_else(|| "N".to_string());
    let lon_ref = map
        .get("GPSLongitudeRef")
        .cloned()
        .unwrap_or_else(|| "E".to_string());

    let (d, m, s) = parse_gps_components(lat_str)?;
    let mut lat_val = d as f64 + m / 60.0 + s / 3600.0;
    if lat_ref.to_uppercase() == "S" {
        lat_val = -lat_val;
    }

    let (d, m, s) = parse_gps_components(lon_str)?;
    let mut lon_val = d as f64 + m / 60.0 + s / 3600.0;
    if lon_ref.to_uppercase() == "W" {
        lon_val = -lon_val;
    }

    Some((
        lat_val,
        lon_val,
        lat_str.clone(),
        lat_ref,
        lon_str.clone(),
        lon_ref,
    ))
}

#[tauri::command]
pub fn set_gps_for_paths(
    paths: Vec<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    paths.par_iter().for_each(|path| {
        let (source_path, sidecar_path) = parse_virtual_path(path);
        let Ok(metadata) =
            crate::metadata::sidecar::update_sidecar(&sidecar_path, &source_path, |metadata| {
                crate::metadata::sidecar::fill_missing_exif(metadata, &source_path);

                let mut exif_map = metadata.exif.clone().unwrap_or_default();

                let has_orig = exif_map.contains_key("OriginalGPSLatitude");
                let has_native = if has_orig {
                    true
                } else if let Some(v) = exif_map.get("HasNativeGPS") {
                    v == "true"
                } else if let Some((_, _, lat_s, lat_r, lon_s, lon_r)) =
                    extract_native_gps(&source_path)
                {
                    exif_map.insert("OriginalGPSLatitude".to_string(), lat_s);
                    exif_map.insert("OriginalGPSLatitudeRef".to_string(), lat_r);
                    exif_map.insert("OriginalGPSLongitude".to_string(), lon_s);
                    exif_map.insert("OriginalGPSLongitudeRef".to_string(), lon_r);
                    exif_map.insert("HasNativeGPS".to_string(), "true".to_string());
                    true
                } else {
                    exif_map.insert("HasNativeGPS".to_string(), "false".to_string());
                    false
                };

                if has_native
                    && !exif_map.contains_key("OriginalGPSLatitude")
                    && exif_map
                        .get("IsGpsModified")
                        .map(|s| s != "true")
                        .unwrap_or(true)
                    && let (Some(cur_lat), Some(cur_lon)) = (
                        exif_map.get("GPSLatitude").cloned(),
                        exif_map.get("GPSLongitude").cloned(),
                    )
                {
                    let cur_lat_ref = exif_map
                        .get("GPSLatitudeRef")
                        .cloned()
                        .unwrap_or_else(|| "N".to_string());
                    let cur_lon_ref = exif_map
                        .get("GPSLongitudeRef")
                        .cloned()
                        .unwrap_or_else(|| "E".to_string());
                    exif_map.insert("OriginalGPSLatitude".to_string(), cur_lat);
                    exif_map.insert("OriginalGPSLatitudeRef".to_string(), cur_lat_ref);
                    exif_map.insert("OriginalGPSLongitude".to_string(), cur_lon);
                    exif_map.insert("OriginalGPSLongitudeRef".to_string(), cur_lon_ref);
                }

                if let (Some(lat), Some(lon)) = (latitude, longitude) {
                    if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) {
                        let lat_str = to_dms_string(lat);
                        let lat_ref = if lat >= 0.0 { "N" } else { "S" }.to_string();
                        let lon_str = to_dms_string(lon);
                        let lon_ref = if lon >= 0.0 { "E" } else { "W" }.to_string();

                        exif_map.insert("GPSLatitude".to_string(), lat_str);
                        exif_map.insert("GPSLatitudeRef".to_string(), lat_ref);
                        exif_map.insert("GPSLongitude".to_string(), lon_str);
                        exif_map.insert("GPSLongitudeRef".to_string(), lon_ref);
                        exif_map.insert("IsGpsModified".to_string(), "true".to_string());
                        if has_native {
                            exif_map.insert("HasNativeGPS".to_string(), "true".to_string());
                        } else {
                            exif_map.insert("HasNativeGPS".to_string(), "false".to_string());
                        }

                        crate::metadata::exif_cache::save_exif_to_rrcache(
                            &source_path,
                            exif_map.clone(),
                        );
                        metadata.exif = Some(exif_map);
                    }
                } else {
                    exif_map.remove("GPSLatitude");
                    exif_map.remove("GPSLatitudeRef");
                    exif_map.remove("GPSLongitude");
                    exif_map.remove("GPSLongitudeRef");
                    if has_native {
                        exif_map.insert("IsGpsModified".to_string(), "true".to_string());
                    } else {
                        exif_map.remove("IsGpsModified");
                        exif_map.remove("HasNativeGPS");
                    }
                    crate::metadata::exif_cache::save_exif_to_rrcache(
                        &source_path,
                        exif_map.clone(),
                    );
                    metadata.exif = Some(exif_map);
                }
            })
        else {
            return;
        };

        if enable_xmp_sync {
            sync_metadata_to_xmp(
                &source_path,
                &sidecar_path,
                &metadata,
                create_xmp_if_missing,
            );
        }

        let is_raw = crate::decode::formats::is_raw_file(&source_path);
        let tm_override = resolve_tonemapper_override(&settings, is_raw);
        let is_adj_edited =
            is_image_edited(&metadata.adjustments, &source_path, is_raw, tm_override);
        let is_gps_edited = metadata
            .exif
            .as_ref()
            .map(|emap| {
                emap.get("IsGpsModified")
                    .map(|v| v == "true")
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        let is_edited = is_adj_edited || is_gps_edited;
        let needs_ai = crate::ai::jobs::needs_generation(&metadata.adjustments, &source_path);

        emit_image_metadata_loaded(
            &app_handle,
            path,
            &ImageFileMetadata {
                is_edited,
                tags: metadata.tags,
                rating: metadata.rating,
                flag: metadata.flag,
                is_raw,
                needs_ai,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn revert_gps_for_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<HashMap<String, Option<(f64, f64)>>, String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    let results: Vec<(String, Option<(f64, f64)>)> = paths
        .par_iter()
        .map(|path| {
            let (source_path, sidecar_path) = parse_virtual_path(path);
            let mut ret = None;
            if let Ok(metadata) =
                crate::metadata::sidecar::update_sidecar(&sidecar_path, &source_path, |metadata| {
                    crate::metadata::sidecar::fill_missing_exif(metadata, &source_path);
                    ret = revert_gps_in_metadata_and_cache(&source_path, metadata);
                })
            {
                if enable_xmp_sync {
                    sync_metadata_to_xmp(
                        &source_path,
                        &sidecar_path,
                        &metadata,
                        create_xmp_if_missing,
                    );
                }

                let is_raw = crate::decode::formats::is_raw_file(&source_path);
                let tm_override = resolve_tonemapper_override(&settings, is_raw);
                let is_adj_edited =
                    is_image_edited(&metadata.adjustments, &source_path, is_raw, tm_override);
                let needs_ai =
                    crate::ai::jobs::needs_generation(&metadata.adjustments, &source_path);

                emit_image_metadata_loaded(
                    &app_handle,
                    path,
                    &ImageFileMetadata {
                        is_edited: is_adj_edited,
                        tags: metadata.tags,
                        rating: metadata.rating,
                        flag: metadata.flag,
                        is_raw,
                        needs_ai,
                    },
                );
            }

            (path.clone(), ret)
        })
        .collect();

    Ok(results.into_iter().collect())
}

#[tauri::command]
pub async fn load_metadata(path: String, app_handle: AppHandle) -> Result<ImageMetadata, String> {
    let (source_path, _) = parse_virtual_path(&path);
    crate::integrations::immich::fetch_edits(&app_handle, &source_path).await;

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

        let (source_path, sidecar_path) = parse_virtual_path(&path);
        let mut metadata = crate::metadata::sidecar::load_sidecar(&sidecar_path);

        if enable_xmp_sync && sync_metadata_from_xmp(&source_path, &sidecar_path, &mut metadata) {
            let _ =
                crate::metadata::sidecar::update_sidecar(&sidecar_path, &source_path, |current| {
                    sync_metadata_from_xmp(&source_path, &sidecar_path, current);
                });
        }

        crate::adjustments::develop_defaults::resolve_in_place(
            &mut metadata.adjustments,
            &source_path,
        );

        if crate::ai::jobs::has_ai_results(&metadata.adjustments)
            && let Some(source_id) = crate::ai::jobs::source_id(&source_path)
        {
            crate::ai::jobs::reconcile_ai_results(
                &mut metadata.adjustments,
                &Value::Null,
                &source_id,
                true,
            );
        }

        metadata
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
pub fn clear_all_sidecars(root_path: String) -> Result<usize, String> {
    if !Path::new(&root_path).exists() {
        return Err(format!("Root path does not exist: {}", root_path));
    }

    let mut deleted_count = 0;
    let walker = WalkDir::new(root_path).into_iter();

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file()
            && let Some(extension) = path.extension()
            && (extension == "rrdata" || extension == "rrexif")
        {
            if fs::remove_file(path).is_ok() {
                deleted_count += 1;
            } else {
                eprintln!("Failed to delete sidecar file: {:?}", path);
            }
        }
    }

    Ok(deleted_count)
}

#[tauri::command]
pub fn create_virtual_copy(
    source_virtual_path: String,
    target_album_id: Option<String>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, source_sidecar_path) = parse_virtual_path(&source_virtual_path);

    let new_copy_id = Uuid::new_v4().to_string()[..6].to_string();
    let new_virtual_path = format!("{}?vc={}", source_path.to_string_lossy(), new_copy_id);
    let (_, new_sidecar_path) = parse_virtual_path(&new_virtual_path);

    let default_json =
        serde_json::to_string_pretty(&ImageMetadata::default()).map_err(|e| e.to_string())?;

    {
        let _layout = crate::metadata::sidecar::SIDECAR_LAYOUT_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if source_sidecar_path.exists() {
            fs::copy(&source_sidecar_path, &new_sidecar_path)
                .map_err(|e| format!("Failed to copy sidecar file: {}", e))?;
        } else {
            write_file_atomic(&new_sidecar_path, default_json.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        // The library hides the original when only virtual copy sidecars exist.
        let primary_sidecar_path = crate::metadata::sidecar::get_primary_sidecar_path(&source_path);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&primary_sidecar_path)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(default_json.as_bytes())
                    .map_err(|e| e.to_string())?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }

    if let Some(album_id) = target_album_id {
        let _ = add_to_album(album_id, vec![new_virtual_path.clone()], app_handle);
    }

    Ok(new_virtual_path)
}
