use super::shortcuts::PersonShortcut;
use super::{PeopleState, database};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Emitter, Manager};

#[tauri::command]
pub async fn organize(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut token = state.cancel.lock().unwrap();
        if token.is_some() {
            return Err("A People job is already running".into());
        }
        *token = Some(cancel.clone());
        *state.progress.lock().unwrap() = super::types::PeopleScanProgress {
            running: true,
            stage: "organizing".into(),
            ..Default::default()
        };
    }
    super::scan::publish(&app);
    let copy = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker = copy.clone();
        let cancellation = cancel.clone();
        let result = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
            super::organize::run(
                &mut database::open(&super::db_path(&worker)?)?,
                true,
                &cancellation,
            )
        })
        .await;
        let state = copy.state::<PeopleState>();
        let _guard = state.maintenance.lock().await;
        let mut p = state.progress.lock().unwrap();
        p.running = false;
        p.cancelled = cancel.load(Ordering::Relaxed);
        p.error = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e.to_string()),
            Err(e) => Some(e.to_string()),
        };
        p.stage = if p.cancelled {
            "cancelled"
        } else if p.error.is_some() {
            "failed"
        } else {
            "complete"
        }
        .into();
        let _ = copy.emit("people-scan-progress", p.clone());
        let _ = copy.emit("people-index-updated", ());
        *state.cancel.lock().unwrap() = None;
    });
    Ok(())
}

#[tauri::command]
pub async fn suggestions(
    app: tauri::AppHandle,
) -> Result<Vec<super::organize::Suggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        super::organize::suggestions(&database::open(&super::db_path(&app)?)?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn can_undo(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        Ok(database::open(&super::db_path(&app)?)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM people_history)",
            [],
            |r| r.get(0),
        )?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn undo(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    if state.cancel.lock().unwrap().is_some() {
        return Err("Cancel the People job before making corrections".into());
    }
    let copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        super::history::undo(&mut database::open(&super::db_path(&copy)?)?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let _ = app.emit("people-index-updated", ());
    Ok(())
}

#[tauri::command]
pub async fn shortcuts(
    app: tauri::AppHandle,
    scope: String,
) -> Result<Vec<PersonShortcut>, String> {
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        super::shortcuts::list(&database::open(&super::db_path(&app)?)?, &scope)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_shortcut(
    app: tauri::AppHandle,
    scope: String,
    person_id: String,
    shortcut: Option<String>,
) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    if state.cancel.lock().unwrap().is_some() {
        return Err("Cancel the People job before changing shortcuts".into());
    }
    let copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        let mut db = database::open(&super::db_path(&copy)?)?;
        super::shortcuts::set(&mut db, &scope, &person_id, shortcut.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
