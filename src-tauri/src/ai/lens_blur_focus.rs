use image::imageops::{self, FilterType};
use image::{DynamicImage, GenericImageView};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::ai::models::{AiMaskModel, get_or_init_ai_models};
use crate::ai::processing::run_birefnet_model;
use crate::app::state::AppState;

pub const SUBJECT_FOCUS_KEY: &str = "presetSubjectFocus";

pub fn wants_subject_focus(adjustments: &Value) -> bool {
    adjustments.get(SUBJECT_FOCUS_KEY).and_then(Value::as_bool) == Some(true)
}

const ANALYSIS_SIZE: u32 = 1024;
const SUBJECT_THRESHOLD: u8 = 128;
const MIN_SUBJECT_FRACTION: f64 = 0.005;
const FOCUS_MARGIN: f64 = 4.0;
const FOCUS_FADE: f64 = 12.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LensBlurFocus {
    lens_blur_min_depth: f64,
    lens_blur_max_depth: f64,
    lens_blur_min_fade: f64,
    lens_blur_max_fade: f64,
}

fn percentile(sorted: &[u8], p: f64) -> f64 {
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[i] as f64 / 255.0 * 100.0
}

fn focus_from(depth: &image::GrayImage, subject: &image::GrayImage) -> Option<LensBlurFocus> {
    let subject = imageops::resize(subject, depth.width(), depth.height(), FilterType::Triangle);
    let mut values: Vec<u8> = depth
        .pixels()
        .zip(subject.pixels())
        .filter(|(_, s)| s.0[0] >= SUBJECT_THRESHOLD)
        .map(|(d, _)| d.0[0])
        .collect();
    if (values.len() as f64) < depth.len() as f64 * MIN_SUBJECT_FRACTION {
        return None;
    }
    values.sort_unstable();
    Some(LensBlurFocus {
        lens_blur_min_depth: (percentile(&values, 0.1) - FOCUS_MARGIN)
            .clamp(0.0, 100.0)
            .round(),
        lens_blur_max_depth: (percentile(&values, 0.95) + FOCUS_MARGIN)
            .clamp(0.0, 100.0)
            .round(),
        lens_blur_min_fade: FOCUS_FADE,
        lens_blur_max_fade: FOCUS_FADE,
    })
}

fn subject_focus(
    app_handle: &AppHandle,
    base: &DynamicImage,
    is_raw: bool,
    depth_map: &str,
    adjustments: &Value,
) -> Result<Option<LensBlurFocus>, String> {
    let state = app_handle.state::<AppState>();
    let models = tauri::async_runtime::block_on(get_or_init_ai_models(
        app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Foreground,
    ))
    .map_err(|e| e.to_string())?;
    let depth = crate::effects::maps::resolve_luma_map(depth_map, adjustments, None)
        .ok_or("Depth map unavailable")?;
    let source = crate::masks::generation::build_converted_source_image(base, is_raw, adjustments);
    let (w, h) = source.dimensions();
    let scale = ANALYSIS_SIZE as f64 / w.max(h) as f64;
    let small: DynamicImage = if scale < 1.0 {
        source.resize(
            (w as f64 * scale).round() as u32,
            (h as f64 * scale).round() as u32,
            FilterType::Triangle,
        )
    } else {
        source.into_owned()
    };
    let session = models.birefnet().map_err(|e| e.to_string())?;
    let subject = run_birefnet_model(&small, &session).map_err(|e| e.to_string())?;
    Ok(focus_from(&depth, &subject))
}

pub fn resolve_subject_focus(
    app_handle: &AppHandle,
    base: &DynamicImage,
    is_raw: bool,
    adjustments: &mut Value,
) -> Result<(), String> {
    let Some(flags) = adjustments.as_object_mut() else {
        return Ok(());
    };
    if flags.remove(SUBJECT_FOCUS_KEY).and_then(|v| v.as_bool()) != Some(true) {
        return Ok(());
    }
    let Some(depth_map) = adjustments["lensBlurDepthMap"]
        .as_str()
        .filter(|m| !m.is_empty())
        .map(str::to_string)
    else {
        return Ok(());
    };
    if let Some(focus) = subject_focus(app_handle, base, is_raw, &depth_map, adjustments)?
        && let Value::Object(keys) = serde_json::to_value(focus).map_err(|e| e.to_string())?
        && let Some(target) = adjustments.as_object_mut()
    {
        target.extend(keys);
    }
    Ok(())
}

#[tauri::command]
pub async fn calculate_lens_blur_focus(
    depth_map: String,
    js_adjustments: Value,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Option<LensBlurFocus>, String> {
    let loaded = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No image loaded")?;
    tauri::async_runtime::spawn_blocking(move || {
        subject_focus(
            &app_handle,
            &loaded.image,
            loaded.is_raw,
            &depth_map,
            &js_adjustments,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma};

    #[test]
    fn focuses_on_subject_depth() {
        let depth = GrayImage::from_fn(100, 100, |x, y| {
            Luma([if y > 80 {
                240
            } else if (30..70).contains(&x) {
                150
            } else {
                40
            }])
        });
        let subject = GrayImage::from_fn(100, 100, |x, y| {
            Luma([if (30..70).contains(&x) && y <= 80 {
                255
            } else {
                0
            }])
        });
        let focus = focus_from(&depth, &subject).unwrap();
        assert!(
            focus.lens_blur_min_depth > 40.0 && focus.lens_blur_min_depth < 59.0,
            "{}",
            focus.lens_blur_min_depth
        );
        assert!(
            focus.lens_blur_max_depth > 59.0 && focus.lens_blur_max_depth < 90.0,
            "{}",
            focus.lens_blur_max_depth
        );
    }

    #[test]
    fn no_subject_gives_none() {
        let depth = GrayImage::from_pixel(50, 50, Luma([100]));
        let subject = GrayImage::from_pixel(50, 50, Luma([0]));
        assert!(focus_from(&depth, &subject).is_none());
    }
}
