use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use super::client::is_asset_id;
use super::{Session, registry, session};

const LAST_USED: &str = ".last-used";

pub async fn ensure_local(app_handle: &AppHandle, path: &Path) -> Result<(), String> {
    let Some(entry) = registry::get(path) else {
        return Ok(());
    };
    let session = session(app_handle)?;

    if !path.exists() {
        download(app_handle, &session, &entry.asset_id, path).await?;
        prune_cache_later(&session);
    }
    if let Some(folder) = path.parent() {
        let _ = std::fs::write(folder.join(LAST_USED), []);
    }
    super::fetch_edits(app_handle, path).await;
    Ok(())
}

async fn download(
    app_handle: &AppHandle,
    session: &Session,
    asset_id: &str,
    path: &Path,
) -> Result<(), String> {
    let lock = {
        static LOCKS: Lazy<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
            Lazy::new(|| Mutex::new(HashMap::new()));
        LOCKS
            .lock()
            .unwrap()
            .entry(path.to_path_buf())
            .or_default()
            .clone()
    };
    let _guard = lock.lock().await;
    if path.exists() {
        return Ok(());
    }

    let parent = path.parent().ok_or("Invalid cache path")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("Cannot create '{}': {e}", parent.display()))?;

    let _ = app_handle.emit(
        "immich-download",
        json!({ "path": path, "state": "started" }),
    );
    let partial = parent.join(format!(".{asset_id}.part"));
    let result = session
        .client
        .download_original(asset_id, &partial)
        .await
        .and_then(|_| std::fs::rename(&partial, path).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    let _ = app_handle.emit(
        "immich-download",
        json!({
            "path": path,
            "state": if result.is_ok() { "done" } else { "error" },
            "error": result.as_ref().err(),
        }),
    );
    result
}

pub fn prune_cache_later(session: &Arc<Session>) {
    let dir = session.cache_dir.clone();
    let limit = u64::from(session.settings.cache_limit_gb) * 1024 * 1024 * 1024;
    tauri::async_runtime::spawn_blocking(move || prune_cache(&dir, limit));
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn is_original(name: &str) -> bool {
    !(name.starts_with('.') || name.ends_with(".rrdata") || name.ends_with(".rrexif"))
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
    let Ok(servers) = std::fs::read_dir(cache_root) else {
        return Ok(());
    };
    for server in servers.filter_map(Result::ok) {
        let Ok(folders) = std::fs::read_dir(server.path()) else {
            continue;
        };
        for folder in folders.filter_map(Result::ok) {
            if !folder.file_name().to_str().is_some_and(is_asset_id) {
                continue;
            }
            let last_used = modified_ms(&folder.path().join(LAST_USED));
            let Ok(files) = std::fs::read_dir(folder.path()) else {
                continue;
            };
            for file in files.filter_map(Result::ok) {
                let used = last_used.max(modified_ms(&file.path())).unwrap_or(0);
                if is_original(&file.file_name().to_string_lossy()) && used <= an_hour_ago {
                    std::fs::remove_file(file.path()).map_err(|e| {
                        format!("Failed to remove {}: {}", file.path().display(), e)
                    })?;
                }
            }
        }
    }
    Ok(())
}

fn prune_cache(cache_dir: &Path, limit_bytes: u64) {
    let Ok(folders) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut originals = Vec::new();
    let mut total = 0u64;
    for folder in folders.filter_map(Result::ok) {
        if !folder.file_name().to_str().is_some_and(is_asset_id) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(folder.path()) else {
            continue;
        };
        let last_used = modified_ms(&folder.path().join(LAST_USED));
        for file in files.filter_map(Result::ok) {
            let path = file.path();
            if !is_original(&file.file_name().to_string_lossy()) {
                continue;
            }
            let Ok(meta) = file.metadata() else { continue };
            total += meta.len();
            let used = last_used.max(modified_ms(&path)).unwrap_or(0);
            originals.push((used, meta.len(), path));
        }
    }
    if total <= limit_bytes {
        return;
    }

    let an_hour_ago = an_hour_ago_ms();
    originals.sort_by_key(|(used, ..)| *used);
    for (used, size, path) in originals {
        if total <= limit_bytes {
            break;
        }
        if used > an_hour_ago {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}
