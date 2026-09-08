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
            return Err("A people scan is already running".into());
        }
        *token = Some(cancel.clone());
        *state.progress.lock().unwrap() = PeopleScanProgress {
            running: true,
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
        database::summaries(&database::open(&path)?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn faces(app: tauri::AppHandle, id: String) -> Result<Vec<FaceRecord>, String> {
    let owner = app.clone();
    let state = owner.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        database::faces(&database::open(&db_path(&app)?)?, Some(&id))
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
        return Err("Pause corrections until the scan finishes or is cancelled".into());
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
pub async fn thumbnail(app: tauri::AppHandle, id: String) -> Result<String, String> {
    use base64::Engine;
    let owner = app.clone();
    let state = owner.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        uuid::Uuid::parse_str(&id)?;
        let db = database::open(&db_path(&app)?)?;
        let face = database::face(&db, &id)?;
        let dir = cache_path(&app)?;
        std::fs::create_dir_all(&dir)?;
        let fingerprint = preview::fingerprint(&face.path)?;
        let key = blake3::hash(format!("{id}:{fingerprint}:{:?}", face.landmarks).as_bytes());
        let path = dir.join(format!("{key}.webp"));
        let representative: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM people WHERE representative=?)",
            [&id],
            |r| r.get(0),
        )?;
        if !path.exists() {
            anyhow::ensure!(
                !crate::file_management::is_cloud_placeholder(std::path::Path::new(&face.path)),
                "Image is not local"
            );
            let image = preview::load(&face.path)?;
            let points = face
                .landmarks
                .map(|p| [p[0] * image.width() as f32, p[1] * image.height() as f32]);
            let crop = geometry::align(&image, &points)?;
            let mut bytes = std::io::Cursor::new(Vec::new());
            crop.write_to(&mut bytes, image::ImageFormat::WebP)?;
            if representative {
                std::fs::write(&path, bytes.get_ref())?;
            }
            return Ok(format!(
                "data:image/webp;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
            ));
        }
        Ok(format!(
            "data:image/webp;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(std::fs::read(path)?)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn clear(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<PeopleState>();
    let _guard = state.maintenance.lock().await;
    if state.cancel.lock().unwrap().is_some() {
        return Err("Cancel the scan before clearing people data".into());
    }
    preview::clear_cache();
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
