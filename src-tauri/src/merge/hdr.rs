use crate::app::settings::load_settings;
use crate::app::state::AppState;
use crate::library::sidecars::parse_virtual_path;
use crate::merge::hdr_deghosting::{align_hdr_frames, assert_uniform_dimensions, load_hdr_frames};
use crate::render::image_processing::apply_linear_to_srgb;
use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, ImageFormat};
use image_hdr::hdr_merge_images;
use image_hdr::input::HDRInput;
use std::io::Cursor;
use tauri::Emitter;

#[tauri::command]
pub async fn merge_hdr(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to merge.".to_string());
    }

    let paths: Vec<String> = paths
        .iter()
        .map(|p| {
            crate::library::sidecars::parse_virtual_path(p)
                .0
                .to_string_lossy()
                .into_owned()
        })
        .collect();

    let hdr_result_handle = state.hdr_result.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let mut frames = load_hdr_frames(&paths, &app_handle, &settings)?;
    assert_uniform_dimensions(&frames)?;
    align_hdr_frames(&mut frames, &app_handle);

    let images: Vec<HDRInput> = frames
        .iter()
        .map(|(path, img, exposure, gains)| {
            HDRInput::with_image(img, *exposure, *gains)
                .map_err(|e| format!("Failed to prepare HDR input for {}: {}", path, e))
        })
        .collect::<Result<Vec<HDRInput>, String>>()?;

    log::info!("Starting HDR merge of {} images", images.len());
    let mut hdr_merged = hdr_merge_images(&mut images.into()).map_err(|e| e.to_string())?;
    hdr_merged =
        image_hdr::stretch::apply_histogram_stretch(&hdr_merged).map_err(|e| e.to_string())?;
    hdr_merged = apply_linear_to_srgb(hdr_merged);
    log::info!("HDR merge completed");

    let mut buf = Cursor::new(Vec::new());
    if let Err(e) = hdr_merged.to_rgb8().write_to(&mut buf, ImageFormat::Png) {
        return Err(format!("Failed to encode hdr preview: {}", e));
    }

    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    let final_base64 = format!("data:image/png;base64,{}", base64_str);

    let _ = app_handle.emit("hdr-progress", "Creating preview...");

    *hdr_result_handle.lock().unwrap() = Some(hdr_merged);

    let _ = app_handle.emit(
        "hdr-complete",
        serde_json::json!({
            "base64": final_base64,
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn save_hdr(
    first_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let hdr_image = state.hdr_result.lock().unwrap().take().ok_or_else(|| {
        "No hdr image found in memory to save. It might have already been saved.".to_string()
    })?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("hdr");

    let (extension, image_to_save): (&str, DynamicImage) = if hdr_image.color().has_alpha() {
        ("png", DynamicImage::ImageRgba8(hdr_image.to_rgba8()))
    } else if hdr_image.as_rgb32f().is_some() {
        ("tiff", hdr_image)
    } else {
        ("png", DynamicImage::ImageRgb8(hdr_image.to_rgb8()))
    };

    let bytes = crate::metadata::export_metadata::encode_converted_image(
        &image_to_save,
        extension,
        &first_path.to_string_lossy(),
    )?;
    let output_path = crate::library::file_ops::write_unique_output(
        parent_dir,
        &format!("{}_Hdr", stem),
        extension,
        &bytes,
    )
    .map_err(|e| format!("Failed to save hdr image: {}", e))?;

    let _ = crate::metadata::exif_processing::write_rrexif_sidecar(
        &first_path.to_string_lossy(),
        &output_path,
    );

    Ok(output_path.to_string_lossy().to_string())
}
