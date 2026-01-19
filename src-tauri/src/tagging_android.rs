use tauri::{AppHandle, State};

use crate::AppState;

pub const COLOR_TAG_PREFIX: &str = "color:";
pub const USER_TAG_PREFIX: &str = "user:";

#[tauri::command]
pub async fn start_background_indexing(
    _folder_path: String,
    _app_handle: AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn add_tag_for_paths(_paths: Vec<String>, _tag: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn remove_tag_for_paths(_paths: Vec<String>, _tag: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn clear_ai_tags(_root_path: String) -> Result<usize, String> {
    Ok(0)
}

#[tauri::command]
pub fn clear_all_tags(_root_path: String) -> Result<usize, String> {
    Ok(0)
}
