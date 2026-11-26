use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::client::is_asset_id;
use super::registry::{self, RemoteImage};
use super::{files, session};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MediaRef {
    server: String,
    asset: String,
}

#[derive(Deserialize)]
pub struct LinkedMedia {
    path: String,
    immich: MediaRef,
}

#[derive(Serialize)]
pub struct Original {
    path: String,
    missing: bool,
}

pub fn refs(app_handle: &AppHandle, paths: &[String]) -> Vec<Option<MediaRef>> {
    let server = session(app_handle)
        .ok()
        .map(|session| session.server.clone());
    paths
        .iter()
        .map(|path| {
            let entry = registry::get(&crate::library::sidecars::parse_virtual_path(path).0)?;
            Some(MediaRef {
                server: server.clone()?,
                asset: entry.asset_id,
            })
        })
        .collect()
}

pub fn link(app_handle: &AppHandle, media: &[LinkedMedia]) -> Vec<Option<Original>> {
    let session = session(app_handle).ok();
    let originals: Vec<Option<PathBuf>> = media
        .iter()
        .map(|entry| {
            let MediaRef { server, asset } = &entry.immich;
            let session = session
                .as_ref()
                .filter(|session| session.server == *server && is_asset_id(asset))?;
            let path = session
                .cache_dir
                .join(asset)
                .join(Path::new(&entry.path).file_name()?);
            if registry::get(&path).is_none() {
                registry::insert(
                    path.clone(),
                    RemoteImage {
                        asset_id: asset.clone(),
                        listed_asset_id: asset.clone(),
                        album_id: None,
                    },
                );
            }
            Some(path)
        })
        .collect();
    files::pin(originals.iter().flatten().cloned().collect());
    originals
        .into_iter()
        .map(|path| {
            path.map(|path| Original {
                missing: !path.exists(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}
