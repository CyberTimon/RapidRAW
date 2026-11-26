use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, Semaphore};

use super::client::is_asset_id;
use super::registry::AssetDetails;
use super::{Session, registry, session};

const LAST_USED: &str = ".last-used";
const PARTIAL: &str = ".part";
const MAX_DOWNLOADS: usize = 3;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const CANCELLED: &str = "Download cancelled";

type Finished = Shared<BoxFuture<'static, Result<(), String>>>;

#[derive(Clone, Copy, PartialEq)]
enum Lane {
    Open,
    Background,
}

struct Download {
    cancel: Arc<Notify>,
    promote: Arc<Notify>,
    finished: Finished,
}

static DOWNLOADS: Lazy<Mutex<HashMap<PathBuf, Download>>> = Lazy::new(Default::default);
static SLOTS: Semaphore = Semaphore::const_new(MAX_DOWNLOADS);
static PINNED: Lazy<RwLock<HashSet<PathBuf>>> = Lazy::new(Default::default);

pub async fn ensure_local(app_handle: &AppHandle, path: &Path) -> Result<(), String> {
    if ensure(app_handle, path, Lane::Open).await? {
        super::fetch_edits(app_handle, path).await;
    }
    Ok(())
}

pub async fn ensure_media(app_handle: &AppHandle, path: &Path) -> Result<(), String> {
    if ensure(app_handle, path, Lane::Background).await? {
        let (app_handle, path) = (app_handle.clone(), path.to_path_buf());
        tauri::async_runtime::spawn(async move { super::fetch_edits(&app_handle, &path).await });
    }
    Ok(())
}

async fn ensure(app_handle: &AppHandle, path: &Path, lane: Lane) -> Result<bool, String> {
    let Some(entry) = registry::get(path) else {
        return Ok(false);
    };
    if path.exists() {
        mark_used(path);
        return Ok(true);
    }
    let session = session(app_handle)?;
    download(app_handle, &session, &entry.asset_id, path, lane).await?;
    prune_cache_later(app_handle, &session);
    Ok(true)
}

fn mark_used(original: &Path) {
    let Some(folder) = original.parent() else {
        return;
    };
    let marker = folder.join(LAST_USED);
    if marker.exists() {
        crate::app::storage::mark_used(&marker);
    } else {
        let _ = std::fs::write(&marker, []);
    }
}

fn downloads() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Download>> {
    DOWNLOADS.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn download(
    app_handle: &AppHandle,
    session: &Arc<Session>,
    asset_id: &str,
    path: &Path,
    lane: Lane,
) -> Result<(), String> {
    let finished = {
        let mut downloads = downloads();
        match downloads.get(path) {
            Some(download) => {
                if lane == Lane::Open {
                    download.promote.notify_one();
                }
                download.finished.clone()
            }
            None => {
                let cancel = Arc::new(Notify::new());
                let promote = Arc::new(Notify::new());
                let task = tauri::async_runtime::spawn(run(
                    app_handle.clone(),
                    session.clone(),
                    asset_id.to_string(),
                    path.to_path_buf(),
                    lane,
                    cancel.clone(),
                    promote.clone(),
                ));
                let finished = async move { task.await.unwrap_or_else(|e| Err(e.to_string())) }
                    .boxed()
                    .shared();
                downloads.insert(
                    path.to_path_buf(),
                    Download {
                        cancel,
                        promote,
                        finished: finished.clone(),
                    },
                );
                finished
            }
        }
    };
    finished.await
}

pub fn cancel_download(path: &Path) {
    if let Some(download) = downloads().get(path) {
        download.cancel.notify_one();
    }
}

fn report(app_handle: &AppHandle, path: &Path, mut payload: Value) {
    payload["path"] = json!(path);
    let _ = app_handle.emit("immich-download", payload);
}

async fn run(
    app_handle: AppHandle,
    session: Arc<Session>,
    asset_id: String,
    path: PathBuf,
    lane: Lane,
    cancel: Arc<Notify>,
    promote: Arc<Notify>,
) -> Result<(), String> {
    report(
        &app_handle,
        &path,
        json!({ "state": "queued", "video": crate::decode::formats::is_video_file(&path) }),
    );
    let result = tokio::select! {
        result = fetch(&app_handle, &session, &asset_id, &path, lane, &promote) => result,
        () = cancel.notified() => Err(CANCELLED.to_string()),
    };
    downloads().remove(&path);
    let state = match &result {
        Ok(()) => "done",
        Err(e) if e == CANCELLED => "cancelled",
        Err(_) => "error",
    };
    report(
        &app_handle,
        &path,
        json!({ "state": state, "error": result.as_ref().err() }),
    );
    result
}

async fn fetch(
    app_handle: &AppHandle,
    session: &Session,
    asset_id: &str,
    path: &Path,
    lane: Lane,
    promote: &Notify,
) -> Result<(), String> {
    let _slot = match lane {
        Lane::Open => None,
        Lane::Background => tokio::select! {
            slot = SLOTS.acquire() => Some(slot.map_err(|e| e.to_string())?),
            () = promote.notified() => None,
        },
    };
    if path.exists() {
        return Ok(());
    }
    let parent = path.parent().ok_or("Invalid cache path")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("Cannot create '{}': {e}", parent.display()))?;
    let details = match registry::details(asset_id) {
        Some(details) => details,
        None => session
            .client
            .asset(asset_id)
            .await
            .map(|asset| AssetDetails {
                modified: asset.file_modified_at,
                checksum: asset.checksum,
            })
            .unwrap_or_default(),
    };
    let partial = parent.join(format!(".{asset_id}{PARTIAL}"));
    let mut reported: Option<Instant> = None;
    let mut progress = |current: u64, total: Option<u64>| {
        if reported.is_some_and(|at| at.elapsed() < PROGRESS_INTERVAL) {
            return;
        }
        reported = Some(Instant::now());
        report(
            app_handle,
            path,
            json!({ "state": "progress", "current": current, "total": total }),
        );
    };
    let checksum = details.checksum.as_deref();
    session
        .client
        .download_original(asset_id, &partial, &mut progress)
        .await?;
    if !matches_checksum(&partial, checksum).await {
        let _ = tokio::fs::remove_file(&partial).await;
        session
            .client
            .download_original(asset_id, &partial, &mut progress)
            .await?;
        if !matches_checksum(&partial, checksum).await {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err("The downloaded file does not match the original on Immich".to_string());
        }
    }
    if let Some(modified) = details
        .modified
        .as_deref()
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
    {
        let _ = filetime::set_file_mtime(
            &partial,
            filetime::FileTime::from_system_time(SystemTime::from(modified)),
        );
    }
    mark_used(path);
    std::fs::rename(&partial, path).map_err(|e| format!("Cannot write '{}': {e}", path.display()))
}

async fn matches_checksum(file: &Path, checksum: Option<&str>) -> bool {
    let Some(expected) = checksum.map(str::to_string) else {
        return true;
    };
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || sha1_base64(&file).is_ok_and(|actual| actual == expected))
        .await
        .unwrap_or(false)
}

fn sha1_base64(file: &Path) -> std::io::Result<String> {
    let mut context = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    let mut reader = std::fs::File::open(file)?;
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(BASE64.encode(context.finish()));
        }
        context.update(&buffer[..read]);
    }
}

pub fn pin(paths: HashSet<PathBuf>) {
    *PINNED.write().unwrap_or_else(PoisonError::into_inner) = paths;
}

struct Kept {
    files: HashSet<PathBuf>,
    folders: HashSet<PathBuf>,
}

impl Kept {
    fn new(projects: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut files = PINNED
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        files.extend(projects);
        let folders = downloads()
            .keys()
            .filter_map(|path| path.parent().map(Path::to_path_buf))
            .collect();
        Self { files, folders }
    }

    fn contains(&self, file: &Path) -> bool {
        self.files.contains(file) || file.parent().is_some_and(|f| self.folders.contains(f))
    }
}

pub fn project_originals_size(app_handle: &AppHandle) -> u64 {
    let Ok(root) = super::config::default_cache_dir(app_handle) else {
        return 0;
    };
    Kept::new(crate::video::project_files::recent_media(app_handle))
        .files
        .iter()
        .filter(|file| file.starts_with(&root))
        .filter_map(|file| std::fs::metadata(file).ok())
        .map(|meta| meta.len())
        .sum()
}

pub fn prune_cache_later(app_handle: &AppHandle, session: &Arc<Session>) {
    let dir = session.cache_dir.clone();
    let limit = u64::from(session.settings.cache_limit_gb) * 1024 * 1024 * 1024;
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        prune_cache(&dir, limit, || {
            Kept::new(crate::video::project_files::recent_media(&app_handle))
        })
    });
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn is_cached_data(name: &str) -> bool {
    let original = !(name.starts_with('.')
        || name.ends_with(".rrdata")
        || name.ends_with(".rrexif")
        || crate::decode::formats::is_video_project_file(name));
    original || (name.starts_with('.') && name.ends_with(PARTIAL))
}

struct CachedFile {
    used: u64,
    size: u64,
    path: PathBuf,
}

fn cached_files(server_dir: &Path) -> Vec<CachedFile> {
    let Ok(folders) = std::fs::read_dir(server_dir) else {
        return Vec::new();
    };
    folders
        .filter_map(Result::ok)
        .filter(|folder| folder.file_name().to_str().is_some_and(is_asset_id))
        .flat_map(|folder| {
            let last_used = modified_ms(&folder.path().join(LAST_USED));
            std::fs::read_dir(folder.path())
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|file| is_cached_data(&file.file_name().to_string_lossy()))
                .filter_map(move |file| {
                    let path = file.path();
                    Some(CachedFile {
                        used: last_used.max(modified_ms(&path)).unwrap_or(0),
                        size: file.metadata().ok()?.len(),
                        path,
                    })
                })
        })
        .collect()
}

fn an_hour_ago_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
        .saturating_sub(3_600_000)
}

pub fn clear_originals(cache_root: &Path) -> Result<(), String> {
    let an_hour_ago = an_hour_ago_ms();
    let kept = Kept::new([]);
    let Ok(servers) = std::fs::read_dir(cache_root) else {
        return Ok(());
    };
    for server in servers.filter_map(Result::ok) {
        for file in cached_files(&server.path()) {
            if file.used <= an_hour_ago && !kept.contains(&file.path) {
                std::fs::remove_file(&file.path)
                    .map_err(|e| format!("Failed to remove {}: {}", file.path.display(), e))?;
            }
        }
    }
    Ok(())
}

fn prune_cache(cache_dir: &Path, limit_bytes: u64, kept: impl FnOnce() -> Kept) {
    let files = cached_files(cache_dir);
    if files.iter().map(|file| file.size).sum::<u64>() <= limit_bytes {
        return;
    }
    let kept = kept();
    let mut files: Vec<CachedFile> = files
        .into_iter()
        .filter(|file| !kept.contains(&file.path))
        .collect();
    let mut total: u64 = files.iter().map(|file| file.size).sum();
    let an_hour_ago = an_hour_ago_ms();
    files.sort_by_key(|file| file.used);
    for file in files {
        if total <= limit_bytes {
            break;
        }
        if file.used <= an_hour_ago && std::fs::remove_file(&file.path).is_ok() {
            total = total.saturating_sub(file.size);
        }
    }
}
