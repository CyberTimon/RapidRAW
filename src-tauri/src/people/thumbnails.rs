use super::{PeopleState, database, geometry, preview, types::FaceRecord};
use anyhow::Result;
use base64::Engine;
use image::RgbImage;
use tauri::Manager;

fn key(app: &tauri::AppHandle, face: &FaceRecord) -> Result<std::path::PathBuf> {
    let dir = super::cache_path(app)?;
    std::fs::create_dir_all(&dir)?;
    let hash = blake3::hash(
        format!(
            "{}:{}:{:?}",
            face.id,
            preview::fingerprint(&face.path)?,
            face.landmarks
        )
        .as_bytes(),
    );
    Ok(dir.join(format!("{hash}.webp")))
}

pub fn cache(app: &tauri::AppHandle, face: &FaceRecord, image: &RgbImage) -> Result<()> {
    let path = key(app, face)?;
    if path.exists() {
        return Ok(());
    }
    let points = face
        .landmarks
        .map(|p| [p[0] * image.width() as f32, p[1] * image.height() as f32]);
    let crop = geometry::align(image, &points)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        crop.save_with_format(&temporary, image::ImageFormat::WebP)?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[tauri::command]
pub async fn thumbnail(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let state = app.state::<PeopleState>();
    let _permit = state
        .thumbnail_slots
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let face = {
        let _guard = state.maintenance.lock().await;
        let copy = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<_> {
            uuid::Uuid::parse_str(&id)?;
            database::face(&database::open(&super::db_path(&copy)?)?, &id)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
    };
    let copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let path = key(&copy, &face)?;
        if !path.exists() {
            anyhow::ensure!(
                !crate::file_management::is_cloud_placeholder(std::path::Path::new(&face.path)),
                "Image is not local"
            );
            let image = preview::load(&face.path)?;
            cache(&copy, &face, &image)?;
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

// Native work continues even when WebKit suspends intersection callbacks in the background.
pub fn warm(app: &tauri::AppHandle, ids: Vec<String>) {
    use std::sync::atomic::Ordering;
    if app
        .state::<PeopleState>()
        .warming
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let ids = {
        let state = app.state::<PeopleState>();
        let warmed = state.warmed.lock().unwrap();
        ids.into_iter()
            .filter(|id| !warmed.contains(id))
            .collect::<Vec<_>>()
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for id in ids {
            if thumbnail(app.clone(), id.clone()).await.is_ok() {
                app.state::<PeopleState>().warmed.lock().unwrap().insert(id);
            }
        }
        app.state::<PeopleState>()
            .warming
            .store(false, Ordering::SeqCst);
    });
}
