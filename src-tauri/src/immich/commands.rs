use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

use super::client::{Album, ImmichClient, TimelineMonth};
use super::config::{self, ApiKeyInfo};
use super::{MIN_VERSION, registry, reset_session, resolve, session, sync};
use crate::file_management::ImageFile;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub version: String,
    pub user_name: String,
    pub user_email: String,
}

#[tauri::command]
pub fn immich_get_api_key(app_handle: AppHandle) -> ApiKeyInfo {
    config::load_api_key(&app_handle)
}

#[tauri::command]
pub fn immich_set_api_key(api_key: String, app_handle: AppHandle) -> Result<ApiKeyInfo, String> {
    let info = config::save_api_key(&app_handle, &api_key)?;
    reset_session(true);
    Ok(info)
}

#[tauri::command]
pub async fn immich_test_connection(
    server_url: String,
    api_key: String,
) -> Result<ConnectionInfo, String> {
    let client = ImmichClient::new(&server_url, &api_key)?;
    let version = client.version_numbers().await?;
    let version_text = format!("{}.{}.{}", version.0, version.1, version.2);
    if version < MIN_VERSION {
        return Err(format!(
            "Immich {version_text} is too old. RapidRAW needs Immich {}.{}.{} or newer.",
            MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2
        ));
    }
    let user = client.me().await?;
    Ok(ConnectionInfo {
        version: version_text,
        user_name: user.name,
        user_email: user.email,
    })
}

#[tauri::command]
pub async fn immich_list_albums(app_handle: AppHandle) -> Result<Vec<Album>, String> {
    let session = session(&app_handle)?;
    let mut albums = session.client.albums().await?;
    albums.sort_by_key(|a| a.album_name.to_lowercase());
    Ok(albums)
}

#[tauri::command]
pub async fn immich_timeline(app_handle: AppHandle) -> Result<Vec<TimelineMonth>, String> {
    session(&app_handle)?.client.timeline_months().await
}

#[tauri::command]
pub fn immich_prepare_export(
    album: String,
    with_original: bool,
    app_handle: AppHandle,
) -> Result<String, String> {
    super::uploads::prepare_export(&app_handle, &album, with_original)
        .map(|folder| folder.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn immich_remove_from_album(
    album_id: String,
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = session(&app_handle)?;
    let ids: Vec<String> = paths
        .iter()
        .filter(|path| !path.contains("?vc="))
        .filter_map(|path| {
            registry::get(&crate::file_management::parse_virtual_path(path).0)
                .map(|entry| entry.listed_asset_id)
        })
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    session.client.remove_from_album(&album_id, &ids).await
}

#[tauri::command]
pub async fn immich_flush(app_handle: AppHandle) -> sync::SyncStatus {
    if let Some(session) = super::current_session() {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            sync::send_unsent(&app_handle, &session),
        )
        .await;
    }
    sync::status()
}

#[tauri::command]
pub fn immich_sync_status() -> sync::SyncStatus {
    sync::status()
}

#[tauri::command]
pub async fn immich_get_images(
    filter: resolve::Filter,
    app_handle: AppHandle,
) -> Result<Vec<ImageFile>, String> {
    let session = session(&app_handle)?;
    let resolved = resolve::listing(&session.client, &filter, &session.cache_dir).await?;

    let mut local_paths = Vec::new();
    let mut placeholders = Vec::new();
    for item in resolved {
        let path = item.path.to_string_lossy().into_owned();
        if item.path.exists() {
            local_paths.extend(virtual_copies(&item.path));
            local_paths.push(path);
        } else {
            placeholders.push(placeholder_file(&path, item.file_modified_at.as_deref()));
        }
        registry::insert(item.path, item.image);
    }

    let mut files =
        crate::file_management::get_album_images(local_paths, app_handle.clone()).await?;
    files.extend(placeholders);
    Ok(files)
}

fn placeholder_file(path: &str, file_modified_at: Option<&str>) -> ImageFile {
    let modified = file_modified_at
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp().max(0) as u64)
        .unwrap_or(0);
    ImageFile::placeholder(path.to_string(), modified)
}

fn virtual_copies(path: &Path) -> Vec<String> {
    let (Some(folder), Some(name)) = (path.parent(), path.file_name()) else {
        return Vec::new();
    };
    let name = name.to_string_lossy();
    let Ok(files) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    files
        .flatten()
        .filter_map(|file| {
            let file_name = file.file_name().to_string_lossy().into_owned();
            match crate::file_management::parse_sidecar_name(&file_name) {
                Some((base, Some(id))) if base == name => {
                    Some(format!("{}?vc={id}", path.display()))
                }
                _ => None,
            }
        })
        .collect()
}
