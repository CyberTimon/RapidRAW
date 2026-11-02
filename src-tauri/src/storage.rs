use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::app_settings::{
    AppSettings, default_ai_cache_limit_gb, default_ai_maps_cache_limit_gb,
    default_thumbnail_cache_limit_gb,
};
use crate::app_state::AppState;

struct ThumbnailCache {
    dir: Mutex<Option<PathBuf>>,
    session_start: SystemTime,
    limit: AtomicU64,
    estimated: AtomicU64,
    written_since_prune: AtomicU64,
    pruning: AtomicBool,
    prune_requested: AtomicBool,
}

static THUMBNAIL_CACHE: LazyLock<ThumbnailCache> = LazyLock::new(|| ThumbnailCache {
    dir: Mutex::new(None),
    session_start: SystemTime::now() - mark_used_interval(),
    limit: AtomicU64::new(u64::MAX),
    estimated: AtomicU64::new(0),
    written_since_prune: AtomicU64::new(0),
    pruning: AtomicBool::new(false),
    prune_requested: AtomicBool::new(false),
});

fn mark_used_interval() -> Duration {
    Duration::from_secs(10 * 60)
}

pub fn apply_cache_limits(settings: &AppSettings) {
    set_thumbnail_limit_gb(
        settings
            .thumbnail_cache_limit_gb
            .unwrap_or_else(default_thumbnail_cache_limit_gb),
    );
    crate::ai_denoise::set_disk_cache_limit_gb(
        settings
            .ai_cache_limit_gb
            .unwrap_or_else(default_ai_cache_limit_gb),
    );
    crate::effect_maps::set_disk_cache_limit_gb(
        settings
            .ai_maps_cache_limit_gb
            .unwrap_or_else(default_ai_maps_cache_limit_gb),
    );
}

pub fn mark_used(path: &Path) {
    let stale = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > mark_used_interval());
    if stale {
        let _ = filetime::set_file_mtime(path, filetime::FileTime::now());
    }
}

pub fn initialize_thumbnail_cache(cache_dir: PathBuf) {
    *THUMBNAIL_CACHE
        .dir
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(cache_dir.join("thumbnails"));
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(60));
        prune_thumbnails_in_background();
    });
}

pub fn reset_thumbnail_estimate() {
    THUMBNAIL_CACHE.estimated.store(0, Ordering::Relaxed);
    THUMBNAIL_CACHE
        .written_since_prune
        .store(0, Ordering::Relaxed);
}

fn set_thumbnail_limit_gb(limit_gb: u32) {
    let cache = &*THUMBNAIL_CACHE;
    let limit = u64::from(limit_gb.max(1)) * 1024 * 1024 * 1024;
    if cache.limit.swap(limit, Ordering::Relaxed) > limit
        && cache.estimated.load(Ordering::Relaxed) > limit
    {
        prune_thumbnails_in_background();
    }
}

pub fn record_thumbnail_write(bytes: u64) {
    let cache = &*THUMBNAIL_CACHE;
    let estimated = cache.estimated.fetch_add(bytes, Ordering::Relaxed) + bytes;
    let written = cache
        .written_since_prune
        .fetch_add(bytes, Ordering::Relaxed)
        + bytes;
    if estimated > cache.limit.load(Ordering::Relaxed) && written >= 64 * 1024 * 1024 {
        prune_thumbnails_in_background();
    }
}

fn prune_thumbnails_in_background() {
    let cache = &*THUMBNAIL_CACHE;
    cache.prune_requested.store(true, Ordering::Release);
    if cache.pruning.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        loop {
            while cache.prune_requested.swap(false, Ordering::AcqRel) {
                cache.written_since_prune.store(0, Ordering::Relaxed);
                let dir = cache.dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(dir) = dir {
                    let before = cache.estimated.load(Ordering::Relaxed);
                    let remaining = prune_thumbnails(&dir, cache.limit.load(Ordering::Relaxed));
                    let written_during = cache
                        .estimated
                        .load(Ordering::Relaxed)
                        .saturating_sub(before);
                    cache
                        .estimated
                        .store(remaining + written_during, Ordering::Relaxed);
                }
            }
            cache.pruning.store(false, Ordering::Release);
            if !cache.prune_requested.load(Ordering::Acquire)
                || cache.pruning.swap(true, Ordering::AcqRel)
            {
                break;
            }
        }
    });
}

struct ThumbnailEntry {
    files: Vec<PathBuf>,
    size: u64,
    last_used: SystemTime,
}

fn prune_thumbnails(dir: &Path, limit_bytes: u64) -> u64 {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return 0;
    };

    let mut entries: HashMap<String, ThumbnailEntry> = HashMap::new();
    let mut total = 0u64;
    for file in read_dir.filter_map(|e| e.ok()) {
        let path = file.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(meta) = file.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let key = stem
            .strip_suffix("_small")
            .or_else(|| stem.strip_suffix("_medium"))
            .unwrap_or(stem)
            .to_string();
        let entry = entries.entry(key).or_insert(ThumbnailEntry {
            files: Vec::new(),
            size: 0,
            last_used: UNIX_EPOCH,
        });
        entry.files.push(path);
        entry.size += meta.len();
        entry.last_used = entry.last_used.max(meta.modified().unwrap_or(UNIX_EPOCH));
        total += meta.len();
    }
    if total <= limit_bytes {
        return total;
    }

    let target = limit_bytes / 10 * 9;
    let mut entries: Vec<ThumbnailEntry> = entries.into_values().collect();
    entries.sort_by_key(|entry| entry.last_used);
    for entry in entries {
        if total <= target || entry.last_used >= THUMBNAIL_CACHE.session_start {
            break;
        }
        for file in &entry.files {
            let _ = fs::remove_file(file);
        }
        total = total.saturating_sub(entry.size);
    }
    total
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    thumbnails: u64,
    ai_denoise: u64,
    ai_maps: u64,
    metadata: u64,
    immich: u64,
    models: u64,
    logs: u64,
}

struct StorageDirs {
    cache: PathBuf,
    data: PathBuf,
    logs: PathBuf,
}

fn storage_dirs(app_handle: &AppHandle) -> Result<StorageDirs, String> {
    let path = app_handle.path();
    Ok(StorageDirs {
        cache: path.app_cache_dir().map_err(|e| e.to_string())?,
        data: path.app_data_dir().map_err(|e| e.to_string())?,
        logs: path.app_log_dir().map_err(|e| e.to_string())?,
    })
}

fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

#[tauri::command]
pub async fn get_storage_usage(app_handle: AppHandle) -> Result<StorageUsage, String> {
    let dirs = storage_dirs(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || StorageUsage {
        thumbnails: dir_size(&dirs.cache.join("thumbnails")),
        ai_denoise: dir_size(&dirs.cache.join("ai_denoise")),
        ai_maps: dir_size(&dirs.cache.join("ai_maps")),
        metadata: dir_size(&dirs.cache.join("exif")),
        immich: dir_size(&dirs.cache.join("immich")),
        models: dir_size(&dirs.data.join("models")),
        logs: dir_size(&dirs.logs),
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_ai_maps_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::effect_maps::clear_disk_cache)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_metadata_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::exif_processing::clear_disk_cache)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_immich_cache(app_handle: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::immich::clear_cache(&app_handle))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_ai_models(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let models_dir = storage_dirs(&app_handle)?.data.join("models");
    let _guard = state.ai_init_lock.lock().await;
    crate::ai_processing::reset_ai_sessions(&state.ai_state);
    if models_dir.exists() {
        fs::remove_dir_all(&models_dir)
            .map_err(|e| format!("Failed to remove AI models: {}", e))?;
    }
    Ok(())
}
