use super::{
    AutoState, storage,
    types::*,
    worker::{phase, report},
};
use crate::{app_settings::AppSettings, image_processing::GpuContext};
use anyhow::{Result, ensure};
use tauri::Manager;
pub(super) fn sync(
    app: &tauri::AppHandle,
    path: &str,
    meta: &crate::image_processing::ImageMetadata,
    settings: &AppSettings,
) {
    if settings.enable_xmp_sync.unwrap_or(false) {
        let (source, _) = crate::file_management::parse_virtual_path(path);
        if let Err(error) = crate::file_management::sync_metadata_to_xmp_checked(
            &source,
            meta,
            settings.create_xmp_if_missing.unwrap_or(false),
        ) {
            app.state::<AutoState>()
                .progress
                .lock()
                .unwrap()
                .warnings
                .insert(path.into(), format!("Saved; XMP synchronization failed: {error}"));
        }
    }
}
pub(super) fn thumbnail(
    app: &tauri::AppHandle,
    path: &str,
    settings: &AppSettings,
    gpu: Option<&GpuContext>,
    base: Option<&image::DynamicImage>,
) {
    let result = crate::file_management::resolve_thumbnail_cache_dir(app).ok().and_then(|dir| {
        crate::file_management::generate_single_thumbnail_and_cache(
            path, &dir, gpu, base, true, app, settings,
        )
    });
    if let Some((small, medium, rating, edited)) = result {
        crate::file_management::emit_thumbnail_generated(app, path, &small, &medium, rating, edited);
    } else {
        app.state::<AutoState>()
            .progress
            .lock()
            .unwrap()
            .warnings
            .insert(path.into(), "Saved; thumbnail refresh failed".into());
    }
}
pub fn undo(app: &tauri::AppHandle, batch: &mut Batch, settings: &AppSettings) -> Result<()> {
    let state = app.state::<AutoState>();
    phase(app, "undoing", batch.entries.len());
    for e in &mut batch.entries {
        if state.cancelled() {
            break;
        }
        if !e.applied {
            report(app, &e.path, Ok(()));
            continue;
        }
        let result = (|| -> Result<()> {
            let _lock = storage::WRITE_LOCK.lock().unwrap();
            let (mut meta, bytes) = storage::metadata(&e.path)?;
            if !storage::same(&meta.adjustments, &e.expected)
                || state.protected.lock().unwrap().contains(&e.path)
            {
                state.progress.lock().unwrap().skipped.push(e.path.clone());
                return Ok(());
            }
            ensure!(
                storage::fingerprint(&e.path, settings)? == e.fingerprint,
                "Source or decoding settings changed; Undo skipped"
            );
            meta.adjustments = e.baseline.clone();
            storage::commit(&e.path, &meta, &bytes)?;
            e.expected = e.baseline.clone();
            e.applied = false;
            storage::save_entry(app, &batch.id, e)?;
            state.progress.lock().unwrap().changed.push(e.path.clone());
            sync(app, &e.path, &meta, settings);
            drop(_lock);
            thumbnail(app, &e.path, settings, None, None);
            Ok(())
        })();
        report(app, &e.path, result);
    }
    Ok(())
}
