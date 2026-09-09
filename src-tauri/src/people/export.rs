use super::export_files::{copy_original, create_folder, folder_name};
use super::{PeopleState, database};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    ids: Vec<String>,
    destination: String,
    originals: bool,
    settings: crate::export_processing::ExportSettings,
    format: String,
    current_edit_path: Option<String>,
    current_edit_adjustments: Option<serde_json::Value>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    copied: usize,
    failed: Vec<String>,
    cancelled: bool,
}

#[tauri::command]
pub async fn export_people(app: tauri::AppHandle, mut request: Request) -> Result<Report, String> {
    let state = app.state::<PeopleState>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let _guard = state.maintenance.lock().await;
        let mut token = state.cancel.lock().unwrap();
        if token.is_some() {
            return Err("A People job is already running".into());
        }
        *token = Some(cancel.clone());
        *state.progress.lock().unwrap() = super::types::PeopleScanProgress {
            running: true,
            stage: "exporting".into(),
            ..Default::default()
        };
    }
    super::scan::publish(&app);
    if let Some(template) = &mut request.settings.filename_template {
        *template = template.replace(['/', '\\'], "_");
    }
    // A person export always writes into newly reserved destination folders.
    request.settings.destination_type = Some("customFolder".into());
    request.settings.preserve_folders = false;
    request.settings.subfolder = None;
    let result = run(&app, request, &cancel).await;
    let mut p = state.progress.lock().unwrap();
    p.running = false;
    p.cancelled = cancel.load(Ordering::Relaxed);
    p.error = result.as_ref().err().map(ToString::to_string);
    p.stage = if p.cancelled {
        "cancelled"
    } else if p.error.is_some() {
        "failed"
    } else {
        "complete"
    }
    .into();
    let _ = app.emit("people-scan-progress", p.clone());
    *state.cancel.lock().unwrap() = None;
    result.map_err(|e| e.to_string())
}

async fn run(app: &tauri::AppHandle, request: Request, cancel: &Arc<AtomicBool>) -> Result<Report> {
    ensure!(
        request.originals
            || ["jpg", "jpeg", "png", "tiff", "webp", "jxl", "avif"]
                .contains(&request.format.as_str()),
        "Choose an image export format"
    );
    ensure!(
        Path::new(&request.destination).is_dir(),
        "Choose an existing destination folder"
    );
    ensure!(!request.ids.is_empty(), "Select at least one person");
    let copy = app.clone();
    let ids = request.ids.clone();
    let albums = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let db = database::open(&super::db_path(&copy)?)?;
        let mut albums = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let name: Option<String> =
                db.query_row("SELECT name FROM people WHERE id=?", [&id], |r| r.get(0))?;
            albums.push((
                folder_name(&name.unwrap_or_else(|| {
                    format!("Person {}", id.chars().take(8).collect::<String>())
                })),
                database::paths(&db, &id)?,
            ));
        }
        Ok(albums)
    })
    .await??;
    app.state::<PeopleState>().progress.lock().unwrap().total =
        albums.iter().map(|(_, paths)| paths.len()).sum();
    let mut report = Report::default();
    for (name, paths) in albums {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let folder = match create_folder(Path::new(&request.destination), &name) {
            Ok(folder) => folder,
            Err(error) => {
                let count = paths.len();
                report
                    .failed
                    .extend(paths.into_iter().map(|path| format!("{path}: {error}")));
                let state = app.state::<PeopleState>();
                let mut p = state.progress.lock().unwrap();
                p.processed += count;
                p.failed = report.failed.len();
                drop(p);
                super::scan::publish(app);
                continue;
            }
        };
        for path in paths {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let result = if !Path::new(&path).is_file()
                || crate::file_management::is_cloud_placeholder(Path::new(&path))
            {
                Err(anyhow::anyhow!("Image is not available locally"))
            } else if request.originals {
                let (source, destination, cancellation) =
                    (PathBuf::from(&path), folder.clone(), cancel.clone());
                match tauri::async_runtime::spawn_blocking(move || {
                    copy_original(&source, &destination, &cancellation)
                })
                .await
                {
                    Ok(result) => result,
                    Err(error) => Err(error.into()),
                }
            } else {
                render(app, &path, &folder, &request, cancel).await
            };
            if !cancel.load(Ordering::Relaxed) {
                match result {
                    Ok(()) => report.copied += 1,
                    Err(e) => report.failed.push(format!("{path}: {e}")),
                }
            }
            let state = app.state::<PeopleState>();
            let mut p = state.progress.lock().unwrap();
            p.processed += 1;
            p.failed = report.failed.len();
            drop(p);
            super::scan::publish(app);
        }
    }
    report.cancelled = cancel.load(Ordering::Relaxed);
    Ok(report)
}

async fn render(
    app: &tauri::AppHandle,
    path: &str,
    folder: &Path,
    request: &Request,
    cancel: &AtomicBool,
) -> Result<()> {
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    crate::export_processing::export_images_impl(
        vec![path.into()],
        folder.to_string_lossy().into(),
        false,
        vec![],
        request.settings.clone(),
        request.format.clone(),
        crate::export_processing::ExportAdjustmentsMode::UseSidecars {
            active_path: request.current_edit_path.clone(),
            active_adjustments: request.current_edit_adjustments.clone(),
        },
        app.state::<crate::AppState>(),
        app.clone(),
        Some(tx),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    loop {
        tokio::select! {
            result = &mut rx => { return match result {Ok(Ok(()))=>Ok(()),Ok(Err(n))=>Err(anyhow::anyhow!("{n} render failed")),Err(_)=>Err(anyhow::anyhow!("Render cancelled or interrupted"))}; }
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancel.load(Ordering::Relaxed) { let _ = crate::export_processing::cancel_export(app.state::<crate::AppState>(),app.clone()); }
            }
        }
    }
}
