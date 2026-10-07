mod client;
pub mod commands;
mod config;
mod files;
mod registry;
mod resolve;
mod secrets;
mod thumbnails;

use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tauri::AppHandle;

use client::ImmichClient;

pub use config::ImmichSettings;
pub use files::{ensure_local, ensure_local_all};
pub use thumbnails::placeholder_thumbnail;

const MIN_VERSION: (u32, u32, u32) = (2, 0, 0);

struct Session {
    settings: ImmichSettings,
    client: Arc<ImmichClient>,
    cache_dir: PathBuf,
}

static SESSION: Lazy<RwLock<Option<Arc<Session>>>> = Lazy::new(|| RwLock::new(None));

fn session(app_handle: &AppHandle) -> Result<Arc<Session>, String> {
    if let Some(session) = SESSION.read().unwrap().as_ref() {
        return Ok(session.clone());
    }
    let settings = config::load(app_handle);
    let api_key = config::load_api_key(app_handle).api_key;
    if settings.server_url.trim().is_empty() || api_key.is_empty() {
        return Err("Immich is not set up yet. Add the server in Settings → Immich.".to_string());
    }
    let client = Arc::new(ImmichClient::new(&settings.server_url, &api_key)?);
    let cache_dir = cache_dir(app_handle, &settings)?;
    let session = Arc::new(Session {
        settings,
        client,
        cache_dir,
    });
    *SESSION.write().unwrap() = Some(session.clone());
    files::prune_cache_later(&session);
    Ok(session)
}

fn reset_session(forget_images: bool) {
    *SESSION.write().unwrap() = None;
    if forget_images {
        registry::clear();
    }
}

pub fn apply_settings(settings: &ImmichSettings) {
    let current = SESSION.read().unwrap().as_ref().map(|s| s.settings.clone());
    if let Some(current) = current
        && current != *settings
    {
        reset_session(!current.same_library(settings));
    }
}

fn cache_dir(app_handle: &AppHandle, settings: &ImmichSettings) -> Result<PathBuf, String> {
    match settings.cache_dir.as_deref().map(str::trim) {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => config::default_cache_dir(app_handle),
    }
}

pub fn is_placeholder(path: &Path) -> bool {
    registry::is_placeholder(path)
}
