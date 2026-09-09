mod cohorts;
mod commands;
mod database;
mod export;
mod export_files;
mod geometry;
mod history;
mod jobs;
#[cfg(test)]
mod local_validation;
mod matching;
pub(crate) mod models;
mod mutations;
mod organize;
mod preview;
#[cfg(test)]
mod recognition_tests;
mod scan;
mod shortcuts;
#[cfg(test)]
mod tests;
mod thumbnails;
pub(crate) mod types;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};
use tauri::Manager;

pub struct PeopleState {
    models: tokio::sync::Mutex<Option<models::Models>>,
    progress: Mutex<types::PeopleScanProgress>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    warming: AtomicBool,
    warmed: Mutex<std::collections::HashSet<String>>,
    thumbnail_slots: tokio::sync::Semaphore,
    maintenance: tokio::sync::Mutex<()>,
}

impl Default for PeopleState {
    fn default() -> Self {
        Self {
            models: Default::default(),
            progress: Default::default(),
            cancel: Default::default(),
            maintenance: Default::default(),
            warming: AtomicBool::new(false),
            warmed: Default::default(),
            thumbnail_slots: tokio::sync::Semaphore::new(2),
        }
    }
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
            thumbnails::thumbnail,
            jobs::organize,
            jobs::suggestions,
            jobs::undo,
            jobs::can_undo,
            jobs::shortcuts,
            jobs::set_shortcut,
            export::export_people,
            commands::clear
        ])
        .build()
}
