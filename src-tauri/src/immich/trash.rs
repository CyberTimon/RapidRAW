use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::client::ImmichClient;
use super::{registry, session};

pub fn trash_remote(
    app_handle: &AppHandle,
    paths: Vec<String>,
    whole_stack: bool,
) -> Result<Vec<String>, String> {
    let (remote, local): (Vec<_>, Vec<_>) = paths.into_iter().partition(|p| {
        !p.contains("?vc=")
            && registry::get(&crate::file_management::parse_virtual_path(p).0).is_some()
    });
    if remote.is_empty() {
        return Ok(local);
    }
    let session = match session(app_handle) {
        Ok(session) => session,
        Err(e) => {
            let _ = app_handle.emit("immich-trash", json!({ "error": e }));
            return Ok(local);
        }
    };

    let mut ids = Vec::new();
    let mut sources = Vec::new();
    for path in &remote {
        let (source, _) = crate::file_management::parse_virtual_path(path);
        let Some(entry) = registry::get(&source) else {
            continue;
        };
        for id in [entry.asset_id, entry.listed_asset_id] {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        registry::remove(&source);
        sources.push(source);
    }
    registry::mark_trashing(&ids);

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut ids = ids;
        let result = trash_assets(&session.client, &mut ids, whole_stack).await;
        registry::done_trashing(&ids);
        match &result {
            Ok(()) => {
                for source in &sources {
                    if let Some(folder) = source.parent()
                        && folder.parent() == Some(session.cache_dir.as_path())
                    {
                        let _ = std::fs::remove_dir_all(folder);
                    }
                }
            }
            Err(e) => {
                log::error!("Could not move images to Immich's trash: {e}");
                let _ = app_handle.emit("immich-trash", json!({ "error": e }));
            }
        }
        let _ = app_handle.emit("immich-library-changed", json!({}));
    });
    Ok(local)
}

async fn trash_assets(
    client: &ImmichClient,
    ids: &mut Vec<String>,
    whole_stack: bool,
) -> Result<(), String> {
    if whole_stack {
        for stack in client.stacks().await? {
            if stack.assets.iter().any(|a| ids.contains(&a.id)) {
                for asset in stack.assets {
                    if !ids.contains(&asset.id) {
                        ids.push(asset.id);
                    }
                }
            }
        }
    }
    client.trash(ids).await
}
