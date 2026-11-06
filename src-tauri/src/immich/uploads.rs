use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use super::{Session, registry, session, sync};

#[derive(Debug, Clone)]
struct ExportTarget {
    album: ExportAlbum,
    with_original: bool,
}

#[derive(Debug, Clone)]
enum ExportAlbum {
    None,
    Source,
    Album(String),
}

static EXPORT_TARGETS: Lazy<Mutex<HashMap<PathBuf, ExportTarget>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn prepare_export(
    app_handle: &AppHandle,
    album: &str,
    with_original: bool,
) -> Result<PathBuf, String> {
    session(app_handle)?;
    let root = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("immich-exports");
    let mut targets = EXPORT_TARGETS.lock().unwrap();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if !targets.contains_key(&entry.path()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let folder = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let album = match album {
        "" | "none" => ExportAlbum::None,
        "source" => ExportAlbum::Source,
        id => ExportAlbum::Album(id.to_string()),
    };
    targets.insert(
        folder.clone(),
        ExportTarget {
            album,
            with_original,
        },
    );
    Ok(folder)
}

pub fn on_exported(
    app_handle: &AppHandle,
    source_path: &str,
    output_path: &Path,
) -> Result<(), String> {
    let Some(target) = output_path
        .ancestors()
        .skip(1)
        .find_map(|folder| EXPORT_TARGETS.lock().unwrap().get(folder).cloned())
    else {
        return Ok(());
    };
    let session = session(app_handle)?;

    let (source, _) = crate::file_management::parse_virtual_path(source_path);
    let file_name = output_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let result = tauri::async_runtime::block_on(upload_export(
        app_handle,
        &session,
        &source,
        &target,
        output_path,
    ));
    let _ = std::fs::remove_file(output_path);
    if result.is_ok() {
        let _ = app_handle.emit("immich-upload", json!({ "fileName": file_name }));
    }
    let _ = app_handle.emit("immich-library-changed", json!({}));
    result.map_err(|e| format!("Immich upload of {file_name} failed: {e}"))
}

async fn upload_export(
    app_handle: &AppHandle,
    session: &Session,
    source: &Path,
    target: &ExportTarget,
    output: &Path,
) -> Result<(), String> {
    let client = &session.client;
    let entry = registry::get(source);
    let original = match &entry {
        Some(entry) => {
            if let Err(e) = sync::push(app_handle, client, &entry.asset_id, source).await {
                log::warn!("Could not send the edits of {}: {e}", source.display());
            }
            Some(entry.asset_id.clone())
        }
        None if target.with_original => Some(upload_original(app_handle, session, source).await?),
        None => None,
    };

    let modified = file_time(output);
    let new_id = client.upload(output, &modified, &modified).await?.id;
    if original.as_deref() == Some(new_id.as_str()) {
        return Ok(());
    }

    let album = match &target.album {
        ExportAlbum::None => None,
        ExportAlbum::Source => entry.as_ref().and_then(|e| e.album_id.clone()),
        ExportAlbum::Album(id) => Some(id.clone()),
    };
    if let Some(album) = album {
        client
            .add_to_album(&album, std::slice::from_ref(&new_id))
            .await?;
    }
    if let Some(original) = original {
        let mut ids = vec![new_id.clone(), original];
        let stacked = client
            .stacks()
            .await?
            .into_iter()
            .find(|stack| stack.assets.iter().any(|asset| asset.id == ids[1]));
        for asset in stacked.map(|stack| stack.assets).unwrap_or_default() {
            if !ids.contains(&asset.id) {
                ids.push(asset.id);
            }
        }
        if let Err(e) = client.create_stack(&ids).await {
            if client.owns(&ids[1]).await != Ok(false) {
                return Err(e);
            }
            log::info!(
                "Not stacking {}, its original belongs to someone else: {e}",
                output.display()
            );
        }
    }
    if entry.is_some() {
        registry::set_listed_asset(source, &new_id);
    }
    Ok(())
}

const ALBUM_PREFIX: &str = "immich:";

pub fn add_to_album(
    app_handle: &AppHandle,
    album_id: &str,
    paths: &[String],
) -> Option<Result<(), String>> {
    let target = album_id.strip_prefix(ALBUM_PREFIX)?;
    let album = uuid::Uuid::parse_str(target)
        .ok()
        .map(|_| target.to_string());
    let session = match session(app_handle) {
        Ok(session) => session,
        Err(e) => return Some(Err(e)),
    };
    let app_handle = app_handle.clone();
    let paths = paths.to_vec();
    tauri::async_runtime::spawn(async move {
        let total = paths.len();
        let mut ids = Vec::new();
        let mut failed = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let _ = app_handle.emit(
                "immich-transfer",
                json!({ "state": "progress", "current": index, "total": total }),
            );
            match asset_for(&app_handle, &session, path).await {
                Ok(id) => ids.push(id),
                Err(e) => {
                    log::error!("Could not add {path} to Immich: {e}");
                    failed.push(e);
                }
            }
        }
        if let Some(album) = &album
            && !ids.is_empty()
            && let Err(e) = session.client.add_to_album(album, &ids).await
        {
            failed.push(e);
        }
        let _ = app_handle.emit(
            "immich-transfer",
            json!({
                "state": "done",
                "added": ids.len(),
                "failed": failed.len(),
                "error": failed.first(),
            }),
        );
        let _ = app_handle.emit("immich-library-changed", json!({}));
    });
    Some(Ok(()))
}

async fn asset_for(
    app_handle: &AppHandle,
    session: &Session,
    path: &str,
) -> Result<String, String> {
    let (source, _) = crate::file_management::parse_virtual_path(path);
    if let Some(entry) = registry::get(&source) {
        return Ok(entry.listed_asset_id);
    }
    if path.contains("?vc=") || !source.is_file() {
        return Err(format!(
            "{} is not a file that can be uploaded",
            source.display()
        ));
    }
    upload_original(app_handle, session, &source).await
}

async fn upload_original(
    app_handle: &AppHandle,
    session: &Session,
    source: &Path,
) -> Result<String, String> {
    let modified = file_time(source);
    let uploaded = session.client.upload(source, &modified, &modified).await?;
    let id = uploaded.id;

    let file_name = source.file_name().ok_or("Invalid file name")?;
    let target = session.cache_dir.join(&id).join(file_name);
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    if !target.exists() {
        std::fs::copy(source, &target)
            .map_err(|e| format!("Cannot copy {}: {e}", source.display()))?;
    }
    registry::insert(
        target.clone(),
        registry::RemoteImage {
            asset_id: id.clone(),
            listed_asset_id: id.clone(),
            album_id: None,
        },
    );
    sync::adopt_upload(
        app_handle,
        &session.client,
        &id,
        &target,
        &crate::exif_processing::get_primary_sidecar_path(source),
        uploaded.status == "duplicate",
    )
    .await?;
    Ok(id)
}

fn file_time(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now())
        .to_rfc3339()
}
