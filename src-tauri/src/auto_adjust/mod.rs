mod analysis;
mod cache;
mod completion;
mod correction;
pub(crate) mod evaluation;
mod groups;
mod jobs;
mod quality;
mod render;
pub(crate) mod storage;
#[cfg(test)]
mod tests;
mod types;
mod worker;

use std::{
    collections::HashSet,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager};
use types::*;
#[derive(Default)]
pub struct AutoState {
    progress: Mutex<Progress>,
    cancel: AtomicBool,
    protected: Mutex<HashSet<String>>,
}
impl AutoState {
    fn publish(&self, app: &tauri::AppHandle) {
        let _ = app.emit("scene-auto-progress", self.progress.lock().unwrap().clone());
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}
#[tauri::command]
fn status(app: tauri::AppHandle) -> Progress {
    app.state::<AutoState>().progress.lock().unwrap().clone()
}
#[tauri::command]
fn cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AutoState>();
    if state.progress.lock().unwrap().id != id {
        return Err("Auto job is no longer active".into());
    }
    state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn protect(app: tauri::AppHandle, path: String) {
    app.state::<AutoState>().protected.lock().unwrap().insert(path);
}
#[tauri::command]
async fn inspect(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    // The controls need group summaries, never all baseline/mask data over IPC.
    tauri::async_runtime::spawn_blocking(move || {
        let batch = storage::load(&app, &id).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "id": batch.id, "groups": batch.groups }))
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("scene-auto")
        .setup(|app, _| {
            app.manage(AutoState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![jobs::start_job, status, cancel, protect, inspect])
        .build()
}
