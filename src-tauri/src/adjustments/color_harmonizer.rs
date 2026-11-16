use super::white_balance_picker::read_linear_rgb;
use crate::app::state::{AppState, PreviewTarget};
use image::{DynamicImage, GenericImageView};

#[tauri::command]
pub async fn sample_color_harmony_histogram(
    image_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<f32>, String> {
    let loaded = state
        .original_image
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("No image loaded")?;
    if loaded.path != image_path {
        return Err("Requested image is not loaded yet".into());
    }
    let preview = state
        .cached_preview_for(PreviewTarget::Editor)
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Preview not ready")?;
    if preview.source_path != image_path {
        return Err("Preview for requested image is not ready yet".into());
    }
    let image = preview.preview.image;
    tokio::task::spawn_blocking(move || color_harmony_histogram(&image, loaded.is_raw))
        .await
        .map_err(|error| error.to_string())?
}

fn color_harmony_histogram(image: &DynamicImage, is_raw: bool) -> Result<Vec<f32>, String> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("Empty preview".into());
    }

    let stride = (((width as f64 * height as f64) / 65_000.0).sqrt().ceil() as u32).max(1);
    let mut histogram = vec![0.0_f32; 72];
    for y in (0..height).step_by(stride as usize) {
        for x in (0..width).step_by(stride as usize) {
            let Some(rgb) = read_linear_rgb(image, x, y, is_raw) else {
                continue;
            };
            let r = rgb[0].max(0.0);
            let g = rgb[1].max(0.0);
            let b = rgb[2].max(0.0);
            let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
            let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
            let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
            let a = 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s;
            let b2 = 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s;
            let chroma = a.hypot(b2);
            if chroma <= 0.01 {
                continue;
            }
            let hue = b2.atan2(a).to_degrees().rem_euclid(360.0);
            let idx = (hue / 5.0) as usize % 72;
            histogram[idx] += chroma;
        }
    }
    let max = histogram.iter().copied().fold(0.0_f32, f32::max);
    if max > 0.0 {
        histogram
            .iter_mut()
            .for_each(|value| *value = (*value / max).sqrt());
    }
    Ok(histogram)
}
