pub mod focus_stacking;
pub mod hdr;
pub mod hdr_alignment;
pub mod hdr_deghosting;
pub mod panorama;

use crate::library::sidecars::parse_virtual_path;
use base64::{Engine as _, engine::general_purpose};
use image::DynamicImage;
use std::path::{Path, PathBuf};

fn write_merged_output(
    first_path: &Path,
    suffix: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| suffix.to_lowercase());
    crate::library::file_ops::write_unique_output(
        parent_dir,
        &format!("{}_{}", stem, suffix),
        extension,
        bytes,
    )
    .map_err(|e| format!("Failed to save {} image: {}", suffix.to_lowercase(), e))
}

pub fn save_merged_image(
    first_path_str: &str,
    suffix: &str,
    image: &DynamicImage,
    extension: &str,
) -> Result<String, String> {
    let (first_path, _) = parse_virtual_path(first_path_str);
    let source = first_path.to_string_lossy();
    let bytes =
        crate::metadata::export_metadata::encode_converted_image(image, extension, &source)?;
    let output_path = write_merged_output(&first_path, suffix, extension, &bytes)?;
    let _ = crate::metadata::exif_processing::write_rrexif_sidecar(&source, &output_path);
    Ok(output_path.to_string_lossy().to_string())
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
    let output_path = write_merged_output(&first_path, "Collage", "png", &decoded_bytes)?;
    Ok(output_path.to_string_lossy().to_string())
}
