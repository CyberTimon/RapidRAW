pub mod align;
pub mod blending;
pub mod dng;
pub mod features;
pub mod focus;
pub mod hdr;
pub mod homography;
pub mod matching;
pub mod output;
pub mod panorama;
pub mod raster;
pub mod source;

use crate::app::memory_budget::MemoryBudget;
use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::AppState;
use crate::library::sidecars::parse_virtual_path;
use base64::{Engine as _, engine::general_purpose};
use output::{MergeOutput, MergePreview, save_output, write_output};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use source::{SourceLoader, source_paths};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};

pub trait MergeSession: Send {
    fn preview(&mut self, settings: &Value) -> Result<MergePreview, String>;
    fn render(&mut self, settings: &Value, context: &MergeContext) -> Result<MergeOutput, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    Panorama,
    Hdr,
    FocusStack,
}

pub struct MergeContext<'a> {
    pub settings: &'a AppSettings,
    pub memory_budget: &'a Arc<MemoryBudget>,
    pub progress: &'a (dyn Fn(String) + Sync),
}

impl MergeContext<'_> {
    pub fn loader(&self, linear_raw: bool) -> SourceLoader<'_> {
        SourceLoader::new(self.settings, self.memory_budget, linear_raw)
    }

    pub fn report(&self, message: impl Into<String>) {
        let message = message.into();
        log::info!("merge: {}", message);
        (self.progress)(message);
    }
}

pub fn parse_settings<T: DeserializeOwned>(settings: &Value) -> Result<T, String> {
    serde_json::from_value(settings.clone()).map_err(|e| format!("Invalid merge settings: {}", e))
}

fn build_session(
    kind: MergeKind,
    paths: &[String],
    context: &MergeContext,
) -> Result<Box<dyn MergeSession>, String> {
    Ok(match kind {
        MergeKind::Panorama => Box::new(panorama::build_session(paths, context)?),
        MergeKind::Hdr => Box::new(hdr::build_session(paths, context)?),
        MergeKind::FocusStack => Box::new(focus::build_session(paths, context)?),
    })
}

#[tauri::command]
pub async fn start_merge(
    kind: MergeKind,
    paths: Vec<String>,
    settings: Value,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<MergePreview, String> {
    if paths.len() < 2 {
        return Err("Please select at least two images.".to_string());
    }
    let generation = state.merge_generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.merge_session.lock().unwrap() = None;
    let slot = state.merge_session.clone();
    let current_generation = state.merge_generation.clone();
    let memory_budget = state.memory_budget.clone();
    let paths = source_paths(&paths);

    tokio::task::spawn_blocking(move || {
        let app_settings = load_settings(app_handle.clone()).unwrap_or_default();
        let progress = |message: String| {
            let _ = app_handle.emit("merge-progress", message);
        };
        let context = MergeContext {
            settings: &app_settings,
            memory_budget: &memory_budget,
            progress: &progress,
        };
        let start = std::time::Instant::now();
        let mut session = build_session(kind, &paths, &context)?;
        context.report("Creating preview...");
        let preview = session.preview(&settings)?;
        log::info!(
            "{:?} merge of {} images took {:.2?}",
            kind,
            paths.len(),
            start.elapsed()
        );
        let mut guard = slot.lock().unwrap();
        if current_generation.load(Ordering::SeqCst) != generation {
            return Err("The merge was cancelled.".to_string());
        }
        *guard = Some(session);
        Ok(preview)
    })
    .await
    .map_err(|e| format!("Merge task failed: {}", e))?
}

#[tauri::command]
pub async fn update_merge_preview(
    settings: Value,
    state: tauri::State<'_, AppState>,
) -> Result<MergePreview, String> {
    let slot = state.merge_session.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = slot.lock().unwrap();
        let session = guard
            .as_mut()
            .ok_or("The merge is no longer available. Please run it again.")?;
        session.preview(&settings)
    })
    .await
    .map_err(|e| format!("Merge preview task failed: {}", e))?
}

#[tauri::command]
pub async fn save_merge(
    settings: Value,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let slot = state.merge_session.clone();
    let current_generation = state.merge_generation.clone();
    let generation = current_generation.load(Ordering::SeqCst);
    let memory_budget = state.memory_budget.clone();
    let mut session = slot.lock().unwrap().take().ok_or_else(|| {
        "No merged image found in memory to save. It might have already been saved.".to_string()
    })?;

    tokio::task::spawn_blocking(move || {
        let app_settings = load_settings(app_handle.clone()).unwrap_or_default();
        let progress = |message: String| {
            let _ = app_handle.emit("merge-progress", message);
        };
        let context = MergeContext {
            settings: &app_settings,
            memory_budget: &memory_budget,
            progress: &progress,
        };
        let start = std::time::Instant::now();
        match session.render(&settings, &context) {
            Ok(output) => {
                drop(session);
                context.report("Saving...");
                let path = save_output(output);
                log::info!("Full resolution merge saved in {:.2?}", start.elapsed());
                path
            }
            Err(e) => {
                if current_generation.load(Ordering::SeqCst) == generation {
                    *slot.lock().unwrap() = Some(session);
                }
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Merge save task failed: {}", e))?
}

#[tauri::command]
pub async fn discard_merge(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.merge_generation.fetch_add(1, Ordering::SeqCst);
    let session = state.merge_session.lock().unwrap().take();
    drop(session);
    Ok(())
}

#[tauri::command]
pub async fn save_collage(base64_data: String, first_path_str: String) -> Result<String, String> {
    let data_url_prefix = "data:image/png;base64,";
    if !base64_data.starts_with(data_url_prefix) {
        return Err("Invalid base64 data format".to_string());
    }
    let encoded_data = &base64_data[data_url_prefix.len()..];

    let decoded_bytes = general_purpose::STANDARD
        .decode(encoded_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let output_path = write_output(
        &first_path.to_string_lossy(),
        "Collage",
        "png",
        &decoded_bytes,
    )?;
    Ok(output_path.to_string_lossy().to_string())
}
