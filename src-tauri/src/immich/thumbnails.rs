use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use super::{is_placeholder, registry, session};

const SMALL: u32 = 480;
const MEDIUM: u32 = 1280;

pub fn placeholder_thumbnail(
    app_handle: &AppHandle,
    path_str: &str,
    thumb_cache_dir: &Path,
) -> Option<Option<(String, String)>> {
    let (source, _) = crate::file_management::parse_virtual_path(path_str);
    if !is_placeholder(&source) {
        return None;
    }
    let asset_id = registry::get(&source)?.asset_id;
    let small = thumb_cache_dir.join(format!("immich_{asset_id}_small.jpg"));
    let medium = thumb_cache_dir.join(format!("immich_{asset_id}_medium.jpg"));
    let as_strings = |small: &Path, medium: &Path| {
        (
            small.to_string_lossy().into_owned(),
            medium.to_string_lossy().into_owned(),
        )
    };
    if small.exists() && medium.exists() {
        return Some(Some(as_strings(&small, &medium)));
    }

    static IN_FLIGHT: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
    if !IN_FLIGHT.lock().unwrap().insert(asset_id.clone()) {
        return Some(None);
    }

    let app_handle = app_handle.clone();
    let path_str = path_str.to_string();
    tauri::async_runtime::spawn(async move {
        let result = fetch(&app_handle, &asset_id, &small, &medium).await;
        IN_FLIGHT.lock().unwrap().remove(&asset_id);
        match result {
            Ok(()) => {
                let (small, medium) = as_strings(&small, &medium);
                let _ = app_handle.emit(
                    "thumbnail-generated",
                    json!({
                        "path": path_str,
                        "thumbnailPath": small,
                        "previewPath": medium,
                        "rating": 0,
                        "is_edited": false,
                    }),
                );
            }
            Err(e) => log::warn!("Immich thumbnail for {asset_id} failed: {e}"),
        }
    });
    Some(None)
}

async fn fetch(
    app_handle: &AppHandle,
    asset_id: &str,
    small: &Path,
    medium: &Path,
) -> Result<(), String> {
    let session = session(app_handle)?;
    let bytes = session.client.thumbnail(asset_id, "preview").await?;
    let small = small.to_path_buf();
    let medium = medium.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        for (target, size) in [(&small, SMALL), (&medium, MEDIUM)] {
            let resized = if image.width().max(image.height()) > size {
                image.thumbnail(size, size)
            } else {
                image.clone()
            };
            let mut encoded = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 85)
                .encode_image(&resized.to_rgb8())
                .map_err(|e| e.to_string())?;
            std::fs::write(target, encoded).map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
