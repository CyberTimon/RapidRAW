use serde::Serialize;
use tauri::AppHandle;

use super::client::{Album, ImmichClient, TimelineMonth};
use super::config::{self, ApiKeyInfo};
use super::{MIN_VERSION, registry, reset_session, resolve, session};
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
            local_paths.push(path);
        } else {
            placeholders.push(placeholder_file(&path, item.file_modified_at.as_deref()));
        }
        registry::insert(item.path, item.image);
    }

    let app = app_handle.clone();
    let mut files = tauri::async_runtime::spawn_blocking(move || {
        crate::file_management::get_album_images(local_paths, app)
    })
    .await
    .map_err(|e| e.to_string())??;
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
