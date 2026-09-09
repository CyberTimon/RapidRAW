use super::{AutoState, storage, types::*, worker};
use anyhow::{Result, ensure};
use std::{collections::BTreeSet, sync::atomic::Ordering};
use tauri::Manager;

#[tauri::command]
pub async fn start_job(
    app: tauri::AppHandle,
    paths: Vec<String>,
    options: Options,
    batch_id: Option<String>,
    undo: bool,
) -> Result<String, String> {
    options.controls.validate().map_err(|e| e.to_string())?;
    for group in options.groups.values() {
        if let Some(c) = &group.controls {
            c.validate().map_err(|e| e.to_string())?;
        }
    }
    let state = app.state::<AutoState>();
    let job_id = uuid::Uuid::new_v4().to_string();
    let id = batch_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    {
        let mut progress = state.progress.lock().unwrap();
        if progress.running {
            return Err("An Auto job is already running".into());
        }
        state.cancel.store(false, Ordering::Relaxed);
        state.protected.lock().unwrap().clear();
        *progress = Progress {
            id: job_id.clone(),
            batch_id: id.clone(),
            phase: "preparing".into(),
            running: true,
            ..Progress::default()
        };
    }
    state.publish(&app);
    let result_id = job_id;
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(&app, &id, paths, options, batch_id.is_some(), undo)
        }));
        let state = app.state::<AutoState>();
        {
            let mut p = state.progress.lock().unwrap();
            let error = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e.to_string()),
                Err(_) => Some("Auto processing failed unexpectedly".into()),
            };
            if let Some(e) = error {
                p.failures.insert("batch".into(), e);
            }
            p.running = false;
            p.cancelled = state.cancelled();
            p.phase = if p.cancelled {
                "cancelled"
            } else if p.failures.contains_key("batch") {
                "failed"
            } else {
                "complete"
            }
            .into();
        }
        state.publish(&app);
    });
    Ok(result_id)
}
fn run(
    app: &tauri::AppHandle,
    id: &str,
    paths: Vec<String>,
    options: Options,
    resume: bool,
    undo: bool,
) -> Result<()> {
    let settings = crate::app_settings::load_settings(app.clone()).map_err(anyhow::Error::msg)?;
    let mut batch = if resume {
        let mut b = storage::load(app, id)?;
        ensure!(undo || b.version == VERSION, "Auto engine changed; start a new batch to re-tune");
        storage::restore_entries(app, &mut b)?;
        b.options = options;
        b
    } else {
        ensure!(!undo, "Undo requires a saved batch");
        let mut entries = Vec::new();
        for path in paths.into_iter().collect::<BTreeSet<_>>() {
            let outcome = (|| -> Result<Entry> {
                let (meta, _) = storage::metadata(&path)?;
                let (source, _) = crate::file_management::parse_virtual_path(&path);
                let raw = crate::formats::is_raw_file(&source);
                let edited = meta.adjustments["crop"].is_object()
                    || crate::image_processing::is_image_edited(
                        &meta.adjustments,
                        raw,
                        crate::image_processing::resolve_tonemapper_override(&settings, raw),
                    );
                ensure!(!(options.skip_edited && edited), "skip-edited");
                let mut baseline = meta.adjustments.clone();
                // A fresh Auto run on an unchanged Auto result still uses its original baseline.
                if let Some(previous) = baseline["autoProvenance"]["batchId"].as_str() {
                    if let Ok(mut old) = storage::load(app, previous) {
                        storage::restore_entries(app, &mut old)?;
                        if let Some(e) = old
                            .entries
                            .iter()
                            .find(|e| e.path == path && storage::same(&e.expected, &meta.adjustments))
                        {
                            baseline = e.baseline.clone();
                        }
                    }
                }
                Ok(Entry {
                    fingerprint: storage::fingerprint(&path, &settings)?,
                    path: path.clone(),
                    baseline,
                    expected: meta.adjustments,
                    applied: false,
                    analysis: Analysis::default(),
                    group_id: String::new(),
                })
            })();
            match outcome {
                Ok(e) => entries.push(e),
                Err(e) => {
                    let state = app.state::<AutoState>();
                    let mut p = state.progress.lock().unwrap();
                    if e.to_string() == "skip-edited" {
                        p.skipped.push(path);
                    } else {
                        p.failures.insert(path, e.to_string());
                    }
                }
            }
        }
        Batch { id: id.into(), version: VERSION.into(), options, entries, groups: vec![] }
    };
    if undo {
        super::completion::undo(app, &mut batch, &settings)?;
        return Ok(());
    }
    worker::apply(app, &mut batch, &settings, resume)
}
