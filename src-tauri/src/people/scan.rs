use super::{PeopleState, database, preview, types::*};
use anyhow::Result;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Emitter, Manager};

pub async fn run(
    app: tauri::AppHandle,
    scope: PeopleScanScope,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let state = app.state::<PeopleState>();
    let mut models = state.models.lock().await;
    if models.is_none() {
        *models = Some(super::models::Models::load(&app).await?);
    }
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    // Move the session to the blocking worker, returning it even after a scan failure.
    let mut model = models.take().unwrap();
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = process(&worker_app, &scope, &cancel, &mut model);
        (model, result)
    })
    .await;
    match result {
        Ok((model, result)) => {
            *models = Some(model);
            result
        }
        Err(e) => Err(e.into()),
    }
}

fn process(
    app: &tauri::AppHandle,
    scope: &PeopleScanScope,
    cancel: &Arc<AtomicBool>,
    model: &mut super::models::Models,
) -> Result<()> {
    let mut paths = std::collections::BTreeSet::new();
    for input in &scope.paths {
        let (physical, _) = crate::file_management::parse_virtual_path(input);
        if scope.recursive && physical.is_dir() {
            for entry in walkdir::WalkDir::new(&physical).follow_links(false) {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(());
                }
                match entry {
                    Ok(entry) if entry.file_type().is_file() => {
                        if crate::formats::is_supported_image_file(entry.path()) {
                            paths.insert(
                                entry
                                    .path()
                                    .canonicalize()
                                    .unwrap_or_else(|_| entry.path().to_path_buf()),
                            );
                        }
                    }
                    Err(_) => {
                        app.state::<PeopleState>().progress.lock().unwrap().failed += 1;
                    }
                    _ => {}
                }
            }
        } else {
            paths.insert(physical.canonicalize().unwrap_or(physical));
        }
    }
    let mut db = database::open(&super::db_path(app)?)?;
    database::prune(&mut db)?;
    let paths = paths.into_iter().collect::<Vec<_>>();
    let state = app.state::<PeopleState>();
    state.progress.lock().unwrap().total = paths.len();
    publish(app);
    // Two bounded decode producers feed exactly one inference consumer.
    let (tx, rx) = std::sync::mpsc::sync_channel(2);
    let cursor = std::sync::atomic::AtomicUsize::new(0);
    let jobs = paths
        .iter()
        .map(|path| {
            let path = path
                .canonicalize()
                .unwrap_or_else(|_| path.clone())
                .to_string_lossy()
                .to_string();
            let fingerprint = preview::fingerprint(&path).ok();
            let skip = !std::path::Path::new(&path).is_file()
                || crate::file_management::is_cloud_placeholder(std::path::Path::new(&path))
                || !crate::formats::is_supported_image_file(&path)
                || (!scope.force
                    && fingerprint
                        .as_ref()
                        .is_some_and(|f| database::unchanged(&db, &path, f).unwrap_or(false)));
            (path, fingerprint, skip)
        })
        .collect::<Vec<_>>();
    std::thread::scope(|threads| -> Result<()> {
        let jobs = &jobs;
        let cursor = &cursor;
        for _ in 0..2 {
            let tx = tx.clone();
            threads.spawn(move || {
                while !cancel.load(Ordering::Relaxed) {
                    let i = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((path, fingerprint, skip)) = jobs.get(i) else {
                        break;
                    };
                    let image = if *skip {
                        None
                    } else {
                        Some(
                            std::panic::catch_unwind(|| preview::load(path))
                                .unwrap_or_else(|_| Err(anyhow::anyhow!("Image decoder panicked"))),
                        )
                    };
                    if tx.send((path.clone(), fingerprint.clone(), image)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        for (path, fingerprint, image) in rx {
            if cancel.load(Ordering::Relaxed) {
                continue;
            }
            let result = match image {
                None => None,
                Some(image) => Some(image.and_then(|image| {
                    let faces = model.detect(&image)?;
                    let fingerprint =
                        fingerprint.ok_or_else(|| anyhow::anyhow!("File metadata unavailable"))?;
                    anyhow::ensure!(
                        preview::fingerprint(&path)? == fingerprint,
                        "Image changed during scan"
                    );
                    database::replace(&mut db, &path, &fingerprint, &faces)?;
                    Ok(faces.len())
                })),
            };
            let mut p = state.progress.lock().unwrap();
            p.processed += 1;
            match result {
                None => p.skipped += 1,
                Some(Ok(count)) => p.detected_faces += count,
                Some(Err(error)) => {
                    p.failed += 1;
                    db.execute("INSERT INTO scanned_files(path,fingerprint,model,status,error) VALUES(?,'',?,'failed',?) ON CONFLICT(path) DO UPDATE SET status='failed',error=excluded.error",rusqlite::params![path,MODEL_VERSION,error.to_string()])?;
                }
            }
            drop(p);
            publish(app);
        }
        Ok(())
    })?;
    Ok(())
}

pub fn publish(app: &tauri::AppHandle) {
    let _ = app.emit(
        "people-scan-progress",
        app.state::<PeopleState>().progress.lock().unwrap().clone(),
    );
}
