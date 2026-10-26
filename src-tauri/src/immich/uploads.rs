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
        .parent()
        .and_then(|folder| EXPORT_TARGETS.lock().unwrap().get(folder).cloned())
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
        client.create_stack(&ids).await?;
    }
    if entry.is_some() {
        registry::set_listed_asset(source, &new_id);
    }
    Ok(())
}

async fn upload_original(
    app_handle: &AppHandle,
    session: &Session,
    source: &Path,
) -> Result<String, String> {
    let modified = file_time(source);
    let id = session
        .client
        .upload(source, &modified, &modified)
        .await?
        .id;

    let file_name = source.file_name().ok_or("Invalid file name")?;
    let target = session.cache_dir.join(&id).join(file_name);
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::copy(source, &target).map_err(|e| format!("Cannot copy {}: {e}", source.display()))?;
    let sidecar = crate::exif_processing::get_primary_sidecar_path(source);
    if sidecar.exists() {
        let _ = std::fs::copy(
            &sidecar,
            crate::exif_processing::get_primary_sidecar_path(&target),
        );
    }
    registry::insert(
        target.clone(),
        registry::RemoteImage {
            asset_id: id.clone(),
            listed_asset_id: id.clone(),
            album_id: None,
        },
    );
    sync::push(app_handle, &session.client, &id, &target).await?;
    Ok(id)
}

fn file_time(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now())
        .to_rfc3339()
}
