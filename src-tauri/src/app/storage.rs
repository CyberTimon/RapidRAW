use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::app::settings::{
    AppSettings, default_ai_cache_limit_gb, default_ai_maps_cache_limit_gb,
    default_ai_upscale_cache_limit_gb, default_thumbnail_cache_limit_gb,
    default_video_cache_limit_gb,
};
use crate::app::state::AppState;

type Prune = fn(&Path, u64, SystemTime) -> u64;

struct DiskBudget {
    dir: Mutex<Option<PathBuf>>,
    session_start: SystemTime,
    limit: AtomicU64,
    estimated: AtomicU64,
    written_since_prune: AtomicU64,
    pruning: AtomicBool,
    prune_requested: AtomicBool,
    prune: Prune,
}

static THUMBNAIL_CACHE: LazyLock<DiskBudget> = LazyLock::new(|| DiskBudget::new(prune_thumbnails));
static VIDEO_CACHE: LazyLock<DiskBudget> =
    LazyLock::new(|| DiskBudget::new(crate::video::proxy::prune_cache));

fn mark_used_interval() -> Duration {
    Duration::from_secs(10 * 60)
}

impl DiskBudget {
    fn new(prune: Prune) -> Self {
        Self {
            dir: Mutex::new(None),
            session_start: SystemTime::now() - mark_used_interval(),
            limit: AtomicU64::new(u64::MAX),
            estimated: AtomicU64::new(0),
            written_since_prune: AtomicU64::new(0),
            pruning: AtomicBool::new(false),
            prune_requested: AtomicBool::new(false),
            prune,
        }
    }

    fn initialize(&'static self, dir: PathBuf) {
        *self.dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            self.prune_in_background();
        });
    }

    fn reset_estimate(&self) {
        self.estimated.store(0, Ordering::Relaxed);
        self.written_since_prune.store(0, Ordering::Relaxed);
    }

    fn set_limit_gb(&'static self, limit_gb: u32) {
        let limit = u64::from(limit_gb.max(1)) * 1024 * 1024 * 1024;
        if self.limit.swap(limit, Ordering::Relaxed) > limit
            && self.estimated.load(Ordering::Relaxed) > limit
        {
            self.prune_in_background();
        }
    }

    fn record_write(&'static self, bytes: u64) {
        let estimated = self.estimated.fetch_add(bytes, Ordering::Relaxed) + bytes;
        let written = self.written_since_prune.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if estimated > self.limit.load(Ordering::Relaxed) && written >= 64 * 1024 * 1024 {
            self.prune_in_background();
        }
    }

    fn prune_in_background(&'static self) {
        self.prune_requested.store(true, Ordering::Release);
        if self.pruning.swap(true, Ordering::AcqRel) {
            return;
        }
        std::thread::spawn(move || {
            loop {
                while self.prune_requested.swap(false, Ordering::AcqRel) {
                    self.written_since_prune.store(0, Ordering::Relaxed);
                    let dir = self.dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if let Some(dir) = dir {
                        let before = self.estimated.load(Ordering::Relaxed);
                        let remaining = (self.prune)(
                            &dir,
                            self.limit.load(Ordering::Relaxed),
                            self.session_start,
                        );
                        let written_during = self
                            .estimated
                            .load(Ordering::Relaxed)
                            .saturating_sub(before);
                        self.estimated
                            .store(remaining + written_during, Ordering::Relaxed);
                    }
                }
                self.pruning.store(false, Ordering::Release);
                if !self.prune_requested.load(Ordering::Acquire)
                    || self.pruning.swap(true, Ordering::AcqRel)
                {
                    break;
                }
            }
        });
    }
}

pub fn apply_cache_limits(settings: &AppSettings) {
    THUMBNAIL_CACHE.set_limit_gb(
        settings
            .thumbnail_cache_limit_gb
            .unwrap_or_else(default_thumbnail_cache_limit_gb),
    );
    VIDEO_CACHE.set_limit_gb(
        settings
            .video_cache_limit_gb
            .unwrap_or_else(default_video_cache_limit_gb),
    );
    crate::ai::denoise::set_disk_cache_limit_gb(
        settings
            .ai_cache_limit_gb
            .unwrap_or_else(default_ai_cache_limit_gb),
    );
    crate::ai::upscale::set_disk_cache_limit_gb(
        settings
            .ai_upscale_cache_limit_gb
            .unwrap_or_else(default_ai_upscale_cache_limit_gb),
    );
    crate::effects::maps::set_disk_cache_limit_gb(
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

pub struct CacheEntry {
    files: Vec<(PathBuf, u64)>,
    last_used: SystemTime,
}

impl CacheEntry {
    pub fn files(&self) -> impl Iterator<Item = &Path> {
        self.files.iter().map(|(path, _)| path.as_path())
    }

    pub fn last_used(&self) -> SystemTime {
        self.last_used
    }
}

#[derive(Default)]
pub struct CacheEntries {
    entries: HashMap<String, CacheEntry>,
    total: u64,
}

impl CacheEntries {
    pub fn add(&mut self, key: String, path: PathBuf, meta: &fs::Metadata) {
        let entry = self.entries.entry(key).or_insert(CacheEntry {
            files: Vec::new(),
            last_used: UNIX_EPOCH,
        });
        entry.files.push((path, meta.len()));
        entry.last_used = entry.last_used.max(meta.modified().unwrap_or(UNIX_EPOCH));
        self.total += meta.len();
    }

    pub fn evict(self, limit: u64, target: u64, keep: impl Fn(&CacheEntry) -> bool) -> u64 {
        let mut total = self.total;
        if total <= limit {
            return total;
        }
        let mut entries: Vec<CacheEntry> = self.entries.into_values().collect();
        entries.sort_by_key(|entry| entry.last_used);
        for entry in entries {
            if total <= target {
                break;
            }
            if keep(&entry) {
                continue;
            }
            for (path, len) in &entry.files {
                if fs::remove_file(path).is_ok() {
                    total = total.saturating_sub(*len);
                }
            }
        }
        total
    }
}

fn dir_files(dir: &Path) -> impl Iterator<Item = (PathBuf, fs::Metadata)> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| Some((entry.path(), entry.metadata().ok()?)))
        .filter(|(_, meta)| meta.is_file())
}

pub fn evict_oldest(dir: &Path, extension: &str, limit: u64, keep: impl Fn(&Path) -> bool) {
    let mut entries = CacheEntries::default();
    for (path, meta) in
        dir_files(dir).filter(|(path, _)| path.extension().is_some_and(|ext| ext == extension))
    {
        entries.add(path.to_string_lossy().into_owned(), path, &meta);
    }
    entries.evict(limit, limit, |entry| entry.files().any(&keep));
}

pub fn initialize_caches(cache_dir: PathBuf) {
    VIDEO_CACHE.initialize(crate::video::proxy::cache_root_in(&cache_dir));
    THUMBNAIL_CACHE.initialize(cache_dir.join("thumbnails"));
}

pub fn reset_thumbnail_estimate() {
    THUMBNAIL_CACHE.reset_estimate();
}

pub fn record_thumbnail_write(bytes: u64) {
    THUMBNAIL_CACHE.record_write(bytes);
}

pub fn record_video_cache_write(bytes: u64) {
    VIDEO_CACHE.record_write(bytes);
}

pub fn prune_video_cache() {
    VIDEO_CACHE.prune_in_background();
}

fn prune_thumbnails(dir: &Path, limit_bytes: u64, session_start: SystemTime) -> u64 {
    let mut entries = CacheEntries::default();
    for (path, meta) in dir_files(dir) {
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let key = stem
            .strip_suffix("_small")
            .or_else(|| stem.strip_suffix("_medium"))
            .unwrap_or(stem)
            .to_string();
        entries.add(key, path, &meta);
    }
    entries.evict(limit_bytes, limit_bytes / 10 * 9, |entry| {
        entry.last_used >= session_start
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    thumbnails: u64,
    ai_denoise: u64,
    ai_upscale: u64,
    ai_maps: u64,
    metadata: u64,
    immich: u64,
    immich_projects: u64,
    models: u64,
    logs: u64,
    video_proxies: u64,
    video_reversed: u64,
    video_analysis: u64,
    video_timelapses: u64,
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
    tauri::async_runtime::spawn_blocking(move || {
        let immich_projects = crate::integrations::immich::project_originals_size(&app_handle);
        let [
            video_proxies,
            video_reversed,
            video_analysis,
            video_timelapses,
        ] = crate::video::proxy::cache_usage(&dirs.cache.join("video-cache"));
        StorageUsage {
            thumbnails: dir_size(&dirs.cache.join("thumbnails")),
            ai_denoise: dir_size(&dirs.cache.join("ai_denoise")),
            ai_upscale: dir_size(&dirs.cache.join("ai_upscale")),
            ai_maps: dir_size(&dirs.cache.join("ai_maps")),
            metadata: dir_size(&dirs.cache.join("exif")),
            immich: dir_size(&dirs.cache.join("immich")),
            immich_projects,
            models: dir_size(&dirs.data.join("models")),
            logs: dir_size(&dirs.logs),
            video_proxies,
            video_reversed,
            video_analysis,
            video_timelapses,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_ai_maps_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::effects::maps::clear_disk_cache)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_metadata_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::metadata::exif_cache::clear_disk_cache)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_immich_cache(app_handle: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::integrations::immich::clear_cache(&app_handle)
    })
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
    crate::ai::models::reset_ai_sessions(&state.ai_state);
    if models_dir.exists() {
        fs::remove_dir_all(&models_dir)
            .map_err(|e| format!("Failed to remove AI models: {}", e))?;
    }
    Ok(())
}
