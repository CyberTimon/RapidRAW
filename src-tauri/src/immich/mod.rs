mod client;
pub mod commands;
mod config;
mod files;
mod registry;
mod resolve;
mod secrets;
mod sync;
mod thumbnails;
mod trash;
mod uploads;

use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tauri::AppHandle;

use client::ImmichClient;

pub use config::ImmichSettings;
pub use files::ensure_local;
pub use thumbnails::placeholder_thumbnail;
pub use trash::trash_remote;
pub use uploads::on_exported;

const MIN_VERSION: (u32, u32, u32) = (2, 5, 0);

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
    let api_key = if settings.server_url.trim().is_empty() {
        String::new()
    } else {
        config::load_api_key(app_handle).api_key
    };
    if api_key.is_empty() {
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
    sync::start(app_handle);
    Ok(session)
}

pub async fn fetch_edits(app_handle: &AppHandle, path: &Path) {
    let Some(entry) = registry::get(path) else {
        return;
    };
    if sync::status().offline {
        return;
    }
    let Ok(session) = session(app_handle) else {
        return;
    };
    if let Err(e) = sync::pull(app_handle, &session.client, &entry.asset_id, path).await {
        log::warn!(
            "Could not fetch the edits of {} from Immich: {e}",
            path.display()
        );
        sync::mark_offline(app_handle);
    }
}

pub fn start(app_handle: &AppHandle) {
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = session(&app_handle);
    });
}

fn current_session() -> Option<Arc<Session>> {
    SESSION.read().unwrap().clone()
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
    let server = settings
        .server_url
        .trim()
        .trim_end_matches('/')
        .to_lowercase();
    let server_id = blake3::hash(server.as_bytes()).to_hex();
    Ok(config::default_cache_dir(app_handle)?.join(&server_id[..16]))
}

pub fn clear_cache(app_handle: &AppHandle) -> Result<(), String> {
    files::clear_originals(&config::default_cache_dir(app_handle)?)
}

pub fn is_placeholder(path: &Path) -> bool {
    registry::is_placeholder(path)
}

pub fn is_remote(path: &Path) -> bool {
    registry::get(path).is_some()
}
