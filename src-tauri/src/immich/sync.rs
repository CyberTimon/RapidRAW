use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use super::client::{ImmichClient, MetadataEntry, is_asset_id};
use super::{Session, current_session};

const EDITS_KEY: &str = "rapidraw";
const STATE_FILE: &str = ".immich-sync.json";
const INTERVAL: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SyncState {
    local_modified_ms: Option<u64>,
    local_hash: Option<String>,
    remote_updated_at: Option<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub offline: bool,
    pub pending: usize,
}

static STATUS: Lazy<Mutex<SyncStatus>> = Lazy::new(Default::default);

pub fn status() -> SyncStatus {
    *STATUS.lock().unwrap()
}

pub fn mark_offline(app_handle: &AppHandle) {
    let pending = status().pending;
    report(
        app_handle,
        SyncStatus {
            offline: true,
            pending,
        },
    );
}

fn report(app_handle: &AppHandle, status: SyncStatus) {
    let changed = {
        let mut current = STATUS.lock().unwrap();
        let changed = *current != status;
        *current = status;
        changed
    };
    if changed {
        let _ = app_handle.emit("immich-sync", status);
    }
}

fn sidecar_of(source: &Path) -> PathBuf {
    crate::exif_processing::get_primary_sidecar_path(source)
}

fn state_file(source: &Path) -> PathBuf {
    source.with_file_name(STATE_FILE)
}

fn load_state(source: &Path) -> SyncState {
    fs::read_to_string(state_file(source))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_state(source: &Path, state: &SyncState) {
    if let Ok(json) = serde_json::to_string(state) {
        let _ = fs::write(state_file(source), json);
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn read_sidecar(source: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(sidecar_of(source)).ok()?).ok()
}

fn shared(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.remove("exif");
    }
    value
}

fn fingerprint(value: &Value) -> String {
    blake3::hash(value.to_string().as_bytes())
        .to_hex()
        .to_string()
}

fn is_blank(value: &Value) -> bool {
    ["adjustments", "rating", "flag", "tags"].iter().all(|key| {
        value.get(key).is_none_or(|v| {
            v.is_null()
                || v.as_u64() == Some(0)
                || v.as_array().is_some_and(|a| a.is_empty())
                || v.as_object().is_some_and(|o| o.is_empty())
        })
    })
}

fn remember(
    source: &Path,
    modified: Option<u64>,
    local: &Value,
    remote_updated_at: Option<String>,
) {
    let mut state = load_state(source);
    state.local_modified_ms = modified;
    state.local_hash = Some(fingerprint(local));
    if remote_updated_at.is_some() {
        state.remote_updated_at = remote_updated_at;
    }
    save_state(source, &state);
}

fn local_changes(source: &Path, state: &SyncState) -> Option<Value> {
    let modified = modified_ms(&sidecar_of(source));
    if state.local_modified_ms == modified {
        return None;
    }
    let local = match modified {
        Some(_) => shared(read_sidecar(source)?),
        None => json!({}),
    };
    let unchanged = state.local_hash.as_deref() == Some(fingerprint(&local).as_str());
    let never_edited = state.local_hash.is_none() && is_blank(&local);
    if unchanged || never_edited {
        remember(source, modified, &local, None);
        return None;
    }
    Some(local)
}

fn write_sidecar(source: &Path, value: &Value) -> Result<(), String> {
    let mut value = value.clone();
    if let (Some(map), Some(exif)) = (
        value.as_object_mut(),
        read_sidecar(source).and_then(|old| old.get("exif").cloned()),
    ) {
        map.insert("exif".to_string(), exif);
    }
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    let _layout = crate::exif_processing::SIDECAR_LAYOUT_LOCK.lock().unwrap();
    crate::file_management::write_file_atomic(&sidecar_of(source), json.as_bytes())
        .map_err(|e| e.to_string())
}

fn keep_as_virtual_copy(
    app_handle: &AppHandle,
    source: &Path,
    value: &Value,
) -> Result<(), String> {
    let file_name = source
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy()
        .into_owned();
    let copy_id: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(6)
        .collect();
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    {
        let _layout = crate::exif_processing::SIDECAR_LAYOUT_LOCK.lock().unwrap();
        crate::file_management::write_file_atomic(
            &source.with_file_name(format!("{file_name}.{copy_id}.rrdata")),
            json.as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app_handle.emit(
        "immich-edits-conflict",
        json!({ "path": source, "fileName": file_name }),
    );
    Ok(())
}

pub async fn pull(
    app_handle: &AppHandle,
    client: &ImmichClient,
    asset_id: &str,
    source: &Path,
) -> Result<(), String> {
    let Some(remote) = client.metadata(asset_id, EDITS_KEY).await? else {
        return Ok(());
    };
    if !apply_remote(app_handle, source, &remote)? {
        return Ok(());
    }
    let app = app_handle.clone();
    let path = source.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = crate::app_settings::load_settings(app.clone()).unwrap_or_default();
        crate::file_management::regenerate_thumbnails(
            std::iter::once(path),
            &app,
            &settings,
            false,
        );
    });
    let _ = app_handle.emit(
        "immich-edits-fetched",
        json!({
            "path": source,
            "rating": remote.value.get("rating").and_then(Value::as_u64).unwrap_or(0),
        }),
    );
    Ok(())
}

fn apply_remote(
    app_handle: &AppHandle,
    source: &Path,
    remote: &MetadataEntry,
) -> Result<bool, String> {
    let _guard = crate::exif_processing::lock_sidecar(&sidecar_of(source));
    let mut state = load_state(source);
    if state.remote_updated_at.as_deref() == Some(remote.updated_at.as_str()) {
        return Ok(false);
    }
    match local_changes(source, &state) {
        Some(local) if local != remote.value => {
            keep_as_virtual_copy(app_handle, source, &remote.value)?;
            state.remote_updated_at = Some(remote.updated_at.clone());
            save_state(source, &state);
            Ok(false)
        }
        _ => {
            if let Some(parent) = source.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            write_sidecar(source, &remote.value)?;
            remember(
                source,
                modified_ms(&sidecar_of(source)),
                &remote.value,
                Some(remote.updated_at.clone()),
            );
            Ok(true)
        }
    }
}

pub async fn push(
    app_handle: &AppHandle,
    client: &ImmichClient,
    asset_id: &str,
    source: &Path,
) -> Result<bool, String> {
    let state = load_state(source);
    let modified = modified_ms(&sidecar_of(source));
    let Some(local) = local_changes(source, &state) else {
        return Ok(false);
    };

    if let Some(remote) = client.metadata(asset_id, EDITS_KEY).await?
        && state.remote_updated_at.as_deref() != Some(remote.updated_at.as_str())
    {
        if remote.value == local {
            remember(source, modified, &local, Some(remote.updated_at));
            return Ok(false);
        }
        keep_as_virtual_copy(app_handle, source, &remote.value)?;
    }

    let updated_at = client.set_metadata(asset_id, EDITS_KEY, &local).await?;
    remember(source, modified, &local, Some(updated_at));
    Ok(true)
}

fn unsent_edits(cache_dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(folders) = fs::read_dir(cache_dir) else {
        return Vec::new();
    };
    folders
        .flatten()
        .filter_map(|folder| {
            let asset_id = folder.file_name().to_str()?.to_string();
            if !is_asset_id(&asset_id) {
                return None;
            }
            let source = fs::read_dir(folder.path())
                .ok()?
                .flatten()
                .map(|file| file.path())
                .find(|path| crate::formats::is_supported_image_file(path))?;
            let changed =
                modified_ms(&sidecar_of(&source)) != load_state(&source).local_modified_ms;
            changed.then_some((asset_id, source))
        })
        .collect()
}

pub async fn send_unsent(app_handle: &AppHandle, session: &Session) {
    let cache_dir = session.cache_dir.clone();
    let unsent = tauri::async_runtime::spawn_blocking(move || unsent_edits(&cache_dir))
        .await
        .unwrap_or_default();
    let mut pending = unsent.len();
    let mut offline =
        unsent.is_empty() && status().offline && session.client.version_numbers().await.is_err();
    for (asset_id, source) in unsent {
        match push(app_handle, &session.client, &asset_id, &source).await {
            Ok(_) => pending -= 1,
            Err(e) => {
                log::warn!("Could not send edits of {}: {e}", source.display());
                if session.client.version_numbers().await.is_err() {
                    offline = true;
                    break;
                }
            }
        }
    }
    report(app_handle, SyncStatus { offline, pending });
}

pub fn start(app_handle: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            if let Some(session) = current_session() {
                send_unsent(&app_handle, &session).await;
            }
        }
    });
}
