//! Directory-at-a-time discovery, independent of pixel decoding and metadata hydration.
use crate::file_management::{ImageFile, list_images_in_dir_sync};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, ipc::Channel};

static GENERATION: AtomicU64 = AtomicU64::new(0);
pub(crate) fn is_current(generation: u64) -> bool {
    generation == GENERATION.load(Ordering::SeqCst)
}

#[derive(Clone, Serialize)]
pub struct ScanBatch {
    scan_id: String,
    images: Vec<ImageFile>,
    warnings: Vec<String>,
    done: bool,
}

#[tauri::command]
pub fn cancel_library_scan() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub async fn start_library_scan(
    path: String,
    recursive: bool,
    scan_id: String,
    on_batch: Channel<ScanBatch>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let completion = on_batch.clone();
    let completed_id = scan_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .map_err(|error| error.to_string())?;
        let cancelled = || generation != GENERATION.load(Ordering::SeqCst);
        let warnings =
            crate::library_walk::walk(Path::new(&path), recursive, cancelled, |directory| {
                let images = pool.install(|| {
                    list_images_in_dir_sync(
                        directory.to_string_lossy().into_owned(),
                        app_handle.clone(),
                        true,
                        Some(generation),
                    )
                })?;
                for chunk in images.chunks(128) {
                    if cancelled() {
                        break;
                    }
                    on_batch
                        .send(ScanBatch {
                            scan_id: scan_id.clone(),
                            images: chunk.to_vec(),
                            warnings: Vec::new(),
                            done: false,
                        })
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })?;
        on_batch
            .send(ScanBatch {
                scan_id,
                images: Vec::new(),
                warnings,
                done: false,
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    completion
        .send(ScanBatch {
            scan_id: completed_id,
            images: Vec::new(),
            warnings: Vec::new(),
            done: true,
        })
        .map_err(|error| error.to_string())?;
    result
}
