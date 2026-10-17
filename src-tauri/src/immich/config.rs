use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::secrets;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ImmichSettings {
    pub server_url: String,
    pub cache_dir: Option<String>,
    pub cache_limit_gb: u32,
}

impl Default for ImmichSettings {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            cache_dir: None,
            cache_limit_gb: 20,
        }
    }
}

impl ImmichSettings {
    pub fn same_library(&self, other: &ImmichSettings) -> bool {
        self.server_url.trim() == other.server_url.trim() && self.cache_dir == other.cache_dir
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInfo {
    pub api_key: String,
    pub in_credential_store: bool,
}

pub fn load(app_handle: &AppHandle) -> ImmichSettings {
    crate::app_settings::load_settings(app_handle.clone())
        .map(|settings| settings.immich)
        .unwrap_or_default()
}

fn key_file(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("immich-api-key"))
}

pub fn default_cache_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("immich"))
}

pub fn load_api_key(app_handle: &AppHandle) -> ApiKeyInfo {
    if let Some(api_key) = secrets::load().filter(|key| !key.is_empty()) {
        return ApiKeyInfo {
            api_key,
            in_credential_store: true,
        };
    }
    let api_key = key_file(app_handle)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|key| key.trim().to_string())
        .unwrap_or_default();
    ApiKeyInfo {
        api_key,
        in_credential_store: false,
    }
}

pub fn save_api_key(app_handle: &AppHandle, api_key: &str) -> Result<ApiKeyInfo, String> {
    let api_key = api_key.trim();
    let path = key_file(app_handle)?;
    let in_credential_store = secrets::save(api_key) && !api_key.is_empty();
    if in_credential_store || api_key.is_empty() {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, api_key).map_err(|e| e.to_string())?;
        restrict_permissions(&path);
    }
    Ok(ApiKeyInfo {
        api_key: api_key.to_string(),
        in_credential_store,
    })
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
