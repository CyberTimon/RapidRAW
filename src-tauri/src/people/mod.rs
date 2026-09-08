mod commands;
mod database;
mod geometry;
mod models;
mod mutations;
mod preview;
mod scan;
#[cfg(test)]
mod tests;
mod types;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};
use tauri::Manager;

#[derive(Default)]
pub struct PeopleState {
    models: tokio::sync::Mutex<Option<models::Models>>,
    progress: Mutex<types::PeopleScanProgress>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    maintenance: tokio::sync::Mutex<()>,
}

fn db_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("people-v1.sqlite3"))
}
fn cache_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    Ok(app.path().app_cache_dir()?.join("people-faces-v1"))
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("people")
        .setup(|app, _| {
            app.manage(PeopleState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start,
            commands::cancel,
            commands::status,
            commands::list,
            commands::faces,
            commands::paths,
            commands::mutate,
            commands::thumbnail,
            commands::clear
        ])
        .build()
}
