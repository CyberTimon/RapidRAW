pub mod focus_stacking;
pub mod hdr;
pub mod hdr_deghosting;
pub mod panorama;

use crate::library::sidecars::parse_virtual_path;
use base64::{Engine as _, engine::general_purpose};

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
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("collage");

    let output_path = crate::library::file_ops::write_unique_output(
        parent_dir,
        &format!("{}_Collage", stem),
        "png",
        &decoded_bytes,
    )
    .map_err(|e| format!("Failed to save collage image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}
