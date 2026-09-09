use super::{types::*, *};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

#[tauri::command]
pub async fn start(app: tauri::AppHandle, scope: PeopleScanScope) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut token = state.cancel.lock().unwrap();
        if token.is_some() {
            return Err("A People job is already running".into());
        }
        *token = Some(cancel.clone());
        *state.progress.lock().unwrap() = PeopleScanProgress {
            running: true,
            stage: "preparing".into(),
            ..Default::default()
        };
    }
    scan::publish(&app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = scan::run(app.clone(), scope, cancel.clone()).await;
        let state = app.state::<PeopleState>();
        let _guard = state.maintenance.lock().await;
        let mut progress = state.progress.lock().unwrap();
        progress.running = false;
        progress.stage = if cancel.load(Ordering::Relaxed) {
            "cancelled"
        } else if result.is_err() {
            "failed"
        } else {
            "complete"
        }
        .into();
        progress.cancelled = cancel.load(Ordering::Relaxed);
        progress.error = result.err().map(|e| e.to_string());
        let event = if progress.error.is_some() {
            "people-scan-failed"
        } else if progress.cancelled {
            "people-scan-cancelled"
        } else {
            "people-scan-complete"
        };
        let _ = app.emit(event, progress.clone());
        let _ = app.emit("people-index-updated", ());
        *state.cancel.lock().unwrap() = None;
    });
    Ok(())
}

#[tauri::command]
pub fn cancel(state: tauri::State<PeopleState>) {
    if let Some(token) = state.cancel.lock().unwrap().as_ref() {
        token.store(true, Ordering::Relaxed);
    }
}
#[tauri::command]
pub fn status(state: tauri::State<PeopleState>) -> PeopleScanProgress {
    state.progress.lock().unwrap().clone()
}

#[tauri::command]
pub async fn list(app: tauri::AppHandle) -> Result<Vec<PersonSummary>, String> {
    let owner = app.clone();
    let state = owner.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let path = db_path(&app)?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        let people = database::summaries(&database::open(&path)?)?;
        super::thumbnails::warm(
            &app,
            people
                .iter()
                .map(|p| p.representative_face.clone())
                .collect(),
        );
        Ok(people)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn faces(app: tauri::AppHandle, id: Option<String>) -> Result<Vec<FaceRecord>, String> {
    let owner = app.clone();
    let state = owner.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let rows = database::faces(&database::open(&db_path(&app)?)?, id.as_deref())?;
        Ok(if id.is_none() {
            rows.into_iter().filter(|f| f.ignored).collect()
        } else {
            rows
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn paths(app: tauri::AppHandle, id: String) -> Result<Vec<String>, String> {
    let owner = app.clone();
    let state = owner.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        database::paths(&database::open(&db_path(&app)?)?, &id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn mutate(app: tauri::AppHandle, mutation: mutations::Mutation) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    if state.cancel.lock().unwrap().is_some() {
        return Err("Cancel the People job before making corrections".into());
    }
    let copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        mutations::apply(&mut database::open(&db_path(&copy)?)?, mutation)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let _ = app.emit("people-index-updated", ());
    Ok(())
}
#[tauri::command]
pub async fn clear(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _slots = state
        .thumbnail_slots
        .acquire_many(2)
        .await
        .map_err(|e| e.to_string())?;
    let _guard = state.maintenance.lock().await;
    if state.cancel.lock().unwrap().is_some() {
        return Err("Cancel the People job before clearing people data".into());
    }
    preview::clear_cache();
    state.warmed.lock().unwrap().clear();
    let path = db_path(&app).map_err(|e| e.to_string())?;
    for path in [
        path.clone(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    let cache = cache_path(&app).map_err(|e| e.to_string())?;
    if cache.exists() {
        std::fs::remove_dir_all(cache).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("people-index-updated", ());
    Ok(())
}
