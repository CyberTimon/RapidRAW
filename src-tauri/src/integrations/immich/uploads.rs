use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::client::ImmichClient;
use super::registry::RemoteImage;
use super::{Session, registry, session, sync};

const CANCEL_POLL: Duration = Duration::from_millis(100);

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

impl ExportTarget {
    fn album(&self, entry: Option<&RemoteImage>) -> Option<String> {
        match &self.album {
            ExportAlbum::None => None,
            ExportAlbum::Source => entry.and_then(|e| e.album_id.clone()),
            ExportAlbum::Album(id) => Some(id.clone()),
        }
    }
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

fn export_target(output: &Path) -> Option<ExportTarget> {
    output
        .ancestors()
        .skip(1)
        .find_map(|folder| EXPORT_TARGETS.lock().unwrap().get(folder).cloned())
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn announce(app_handle: &AppHandle, file_name: &str, uploaded: bool) {
    if uploaded {
        let _ = app_handle.emit("immich-upload", json!({ "fileName": file_name }));
    }
    let _ = app_handle.emit("immich-library-changed", json!({}));
}

async fn send_edits(
    app_handle: &AppHandle,
    client: &ImmichClient,
    entry: &RemoteImage,
    source: &Path,
) {
    if let Err(e) = sync::push(app_handle, client, &entry.asset_id, source).await {
        log::warn!("Could not send the edits of {}: {e}", source.display());
    }
}

pub fn on_exported(
    app_handle: &AppHandle,
    source_path: &str,
    output_path: &Path,
) -> Result<(), String> {
    let Some(target) = export_target(output_path) else {
        return Ok(());
    };
    let session = session(app_handle)?;

    let (source, _) = crate::library::sidecars::parse_virtual_path(source_path);
    let file_name = file_name_of(output_path);
    let result = tauri::async_runtime::block_on(upload_export(
        app_handle,
        &session,
        &source,
        &target,
        output_path,
    ));
    let _ = std::fs::remove_file(output_path);
    announce(app_handle, &file_name, result.is_ok());
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
            send_edits(app_handle, client, entry, source).await;
            Some(entry.asset_id.clone())
        }
        None if target.with_original => Some(upload_original(app_handle, session, source).await?),
        None => None,
    };

    let modified = file_time(output);
    let new_id = client
        .upload(output, &modified, &modified, |_, _| {})
        .await?
        .id;
    if original.as_deref() == Some(new_id.as_str()) {
        return Ok(());
    }

    if let Some(album) = target.album(entry.as_ref()) {
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

pub struct VideoUpload {
    session: Arc<Session>,
    target: ExportTarget,
    source: PathBuf,
    created_at: Option<String>,
}

impl VideoUpload {
    pub fn prepare(
        app_handle: &AppHandle,
        source_path: &str,
        output: &Path,
    ) -> Result<Option<Self>, String> {
        let Some(target) = export_target(output) else {
            return Ok(None);
        };
        let session = session(app_handle)?;
        let (source, _) = crate::library::sidecars::parse_virtual_path(source_path);
        let created_at = registry::get(&source).and_then(|entry| {
            tauri::async_runtime::block_on(session.client.asset(&entry.asset_id))
                .ok()?
                .file_created_at
        });
        Ok(Some(Self {
            session,
            target,
            source,
            created_at,
        }))
    }

    pub fn created_at(&self) -> Option<&str> {
        self.created_at.as_deref()
    }

    pub fn run(
        &self,
        app_handle: &AppHandle,
        output: &Path,
        cancel: &AtomicBool,
        progress: impl Fn(u64, u64) + Send + 'static,
    ) -> Result<(), String> {
        let result =
            tauri::async_runtime::block_on(self.upload(app_handle, output, cancel, progress));
        if result.is_ok() {
            let _ = std::fs::remove_file(output);
        }
        announce(app_handle, &file_name_of(output), result.is_ok());
        result
    }

    async fn upload(
        &self,
        app_handle: &AppHandle,
        output: &Path,
        cancel: &AtomicBool,
        progress: impl Fn(u64, u64) + Send + 'static,
    ) -> Result<(), String> {
        let client = &self.session.client;
        let entry = registry::get(&self.source);
        if let Some(entry) = &entry {
            send_edits(app_handle, client, entry, &self.source).await;
        }
        let modified = file_time(output);
        let created = self.created_at.as_deref().unwrap_or(&modified);
        let new_id = tokio::select! {
            uploaded = client.upload(output, created, &modified, progress) => uploaded?.id,
            () = cancelled(cancel) => return Err("Upload cancelled".to_string()),
        };
        if let Some(album) = self.target.album(entry.as_ref())
            && let Err(e) = client
                .add_to_album(&album, std::slice::from_ref(&new_id))
                .await
        {
            log::warn!(
                "Uploaded {} but could not add it to the album: {e}",
                output.display()
            );
        }
        Ok(())
    }
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
    let (source, _) = crate::library::sidecars::parse_virtual_path(path);
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
    let uploaded = session
        .client
        .upload(source, &modified, &modified, |_, _| {})
        .await?;
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
        &crate::metadata::sidecar::get_primary_sidecar_path(source),
        uploaded.status == "duplicate",
    )
    .await?;
    Ok(id)
}

async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(CANCEL_POLL).await;
    }
}

fn file_time(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now())
        .to_rfc3339()
}
