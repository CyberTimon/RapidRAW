use crate::adjustments::lut_processing::get_or_load_lut;
use crate::app::settings::load_settings;
use crate::app::state::AppState;
use crate::decode::as_shot::as_shot;
use crate::decode::formats::is_raw_file;
use crate::decode::image_loader::load_base_image_from_bytes;
use crate::export::encode::encode_image_to_bytes;
use crate::export::geometry::{compute_export_output_size, upscale_factor};
use crate::export::settings::{ExportSettings, render_output_precision};
use crate::library::file_ops::read_file_mapped;
use crate::library::sidecars::parse_virtual_path;
use crate::masks::generation::{MaskDefinition, get_cached_or_generate_masks};
use crate::render::adjustment_utils::{hydrate_adjustments, transformed_dimensions};
use crate::render::cache_utils::calculate_transform_hash;
use crate::render::geometry::Crop;
use crate::render::gpu::context::get_or_init_gpu_context;
use crate::render::gpu::output::process_and_get_dynamic_image_with_precision;
use crate::render::gpu::processor::RenderRequest;
use crate::render::options::resolve_render_options_from_handle;
use crate::render::preview::prepare_preview_source;
use crate::render::source::{RenderSource, fit_to_gpu, source_id};
use crate::render::uniforms::get_all_adjustments_from_json;
use image::GenericImageView;
use serde_json::Value;
use std::fs;
use std::path::Path;

#[tauri::command]
pub async fn estimate_export_sizes(
    paths: Vec<String>,
    export_settings: ExportSettings,
    output_format: String,
    current_edit_path: Option<String>,
    current_edit_adjustments: Option<Value>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<usize>, String> {
    if output_format.to_lowercase() == "cube" {
        return Ok(Some(1_050_000 * paths.len()));
    }

    if paths.is_empty() {
        return Ok(Some(0));
    }

    let first_path = &paths[0];
    let (source_path, sidecar_path) = parse_virtual_path(first_path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let current_edit = match current_edit_adjustments {
        Some(adjustments) if Some(first_path) == current_edit_path.as_ref() => {
            let loaded_image = state
                .original_image
                .lock()
                .unwrap()
                .clone()
                .filter(|image| image.path == *first_path);
            match loaded_image {
                Some(loaded_image) => Some((loaded_image, adjustments)),
                None => return Ok(None),
            }
        }
        _ => None,
    };

    let context = get_or_init_gpu_context(&state, &app_handle)?;
    let is_raw = is_raw_file(&source_path_str);
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let single_image_extrapolated_size: usize = if let Some((loaded_image, mut adjustments_clone)) =
        current_edit
    {
        hydrate_adjustments(&state, &mut adjustments_clone);

        const ESTIMATE_DIM: u32 = 1920;

        let new_transform_hash = calculate_transform_hash(&adjustments_clone);
        let cached_preview_lock = state.cached_preview.lock().unwrap();
        let cached = cached_preview_lock
            .as_ref()
            .filter(|c| c.transform_hash == new_transform_hash)
            .map(|c| c.preview.clone());
        drop(cached_preview_lock);
        let preview = match cached {
            Some(preview) => preview,
            None => prepare_preview_source(
                &state,
                &context,
                &loaded_image,
                &adjustments_clone,
                ESTIMATE_DIM,
            )?,
        };
        let unscaled_crop_offset = preview.unscaled_crop_offset;
        let mut source = preview.render_source(&adjustments_clone);
        let (source_w, _) = source.size();
        source.transform.output_fit = Some((ESTIMATE_DIM, ESTIMATE_DIM));
        let (img_w, img_h) = source.size();
        let scale = preview.scale * img_w as f32 / source_w.max(1) as f32;
        let mask_definitions: Vec<MaskDefinition> = adjustments_clone
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();

        let scaled_crop_offset = (
            unscaled_crop_offset.0 * scale,
            unscaled_crop_offset.1 * scale,
        );

        let mask_bitmaps = get_cached_or_generate_masks(
            &state,
            &loaded_image.path,
            &mask_definitions,
            img_w,
            img_h,
            scale,
            scaled_crop_offset,
            &adjustments_clone,
        )
        .bitmaps;

        let render = resolve_render_options_from_handle(&app_handle, is_raw);
        let mut all_adjustments =
            get_all_adjustments_from_json(&adjustments_clone, is_raw, loaded_image.as_shot, render);
        all_adjustments.global.show_clipping = 0;

        let lut = adjustments_clone["lutPath"]
            .as_str()
            .and_then(|p| get_or_load_lut(&state, p).ok());
        let processed_preview = process_and_get_dynamic_image_with_precision(
            &context,
            &state,
            &source,
            RenderRequest {
                adjustments: all_adjustments,
                mask_bitmaps: &mask_bitmaps,
                mask_cache_key: None,
                lut,
                roi: None,
                hsl_probe: false,
                motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                    &loaded_image.path,
                    &adjustments_clone,
                    (img_w, img_h),
                    scaled_crop_offset,
                    loaded_image.image.width().max(loaded_image.image.height()) as f32 * scale,
                ),
            },
            "estimate_export_size",
            render_output_precision(&output_format, &export_settings),
        )?;

        let preview_bytes =
            encode_image_to_bytes(&processed_preview, &output_format, &export_settings, None)?;
        let preview_byte_size = preview_bytes.len();

        let (full_w, full_h) = transformed_dimensions(
            loaded_image.image.width(),
            loaded_image.image.height(),
            &adjustments_clone,
        );
        let upscale = upscale_factor(&adjustments_clone);
        let (full_w, full_h) = (full_w * upscale, full_h * upscale);

        let (final_full_w, final_full_h) =
            compute_export_output_size(full_w, full_h, &export_settings);

        let (processed_preview_w, processed_preview_h) = processed_preview.dimensions();
        let pixel_ratio = if processed_preview_w > 0 && processed_preview_h > 0 {
            (final_full_w as f64 * final_full_h as f64)
                / (processed_preview_w as f64 * processed_preview_h as f64)
        } else {
            1.0
        };

        (preview_byte_size as f64 * pixel_ratio) as usize
    } else {
        let metadata = crate::metadata::sidecar::load_sidecar(&sidecar_path);
        let mut js_adjustments = metadata.adjustments;

        const ESTIMATE_DIM: u32 = 1280;

        let file_slice: Vec<u8>;
        let mmap_guard;
        let file_data: &[u8] = match read_file_mapped(Path::new(&source_path_str)) {
            Ok(mmap) => {
                mmap_guard = Some(mmap);
                mmap_guard.as_ref().unwrap()
            }
            Err(_) => {
                file_slice = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                &file_slice
            }
        };

        let original_image =
            load_base_image_from_bytes(file_data, &source_path_str, true, &settings, None)
                .map_err(|e| e.to_string())?;

        let raw_scale_factor = if is_raw {
            crate::decode::raw_processing::get_fast_demosaic_scale_factor(
                file_data,
                original_image.width(),
                original_image.height(),
            )
        } else {
            1.0
        };

        if let Some(crop_val) = js_adjustments.get_mut("crop")
            && let Ok(c) = serde_json::from_value::<Crop>(crop_val.clone())
        {
            *crop_val = serde_json::to_value(Crop {
                x: c.x * raw_scale_factor as f64,
                y: c.y * raw_scale_factor as f64,
                width: c.width * raw_scale_factor as f64,
                height: c.height * raw_scale_factor as f64,
            })
            .unwrap_or(serde_json::Value::Null);
        }

        let (fitted, fit_scale) = fit_to_gpu(&context, &original_image);
        let source = RenderSource::edited(
            &fitted,
            source_id("batch-estimate", &source_path_str, &js_adjustments),
            &source_path_str,
            &js_adjustments,
        );
        let unscaled_crop_offset = source.crop_offset();
        let mut source = source.scaled(fit_scale);
        let (fitted_w, fitted_h) = source.size();
        let (shrunk_w, shrunk_h) = (
            (fitted_w as f32 / fit_scale).round() as u32,
            (fitted_h as f32 / fit_scale).round() as u32,
        );
        source.transform.output_fit = Some((ESTIMATE_DIM, ESTIMATE_DIM));
        let (preview_w, preview_h) = source.size();
        let gpu_scale = if shrunk_w > 0 {
            preview_w as f32 / shrunk_w as f32
        } else {
            1.0
        };
        let total_scale = gpu_scale * raw_scale_factor;

        let mask_definitions: Vec<MaskDefinition> = js_adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();
        let scaled_crop_offset = (
            unscaled_crop_offset.0 * gpu_scale,
            unscaled_crop_offset.1 * gpu_scale,
        );

        let mask_bitmaps = get_cached_or_generate_masks(
            &state,
            &source_path_str,
            &mask_definitions,
            preview_w,
            preview_h,
            total_scale,
            scaled_crop_offset,
            &js_adjustments,
        )
        .bitmaps;

        let render = resolve_render_options_from_handle(&app_handle, is_raw);
        let mut all_adjustments = get_all_adjustments_from_json(
            &js_adjustments,
            is_raw,
            as_shot(&source_path_str),
            render,
        );
        all_adjustments.global.show_clipping = 0;

        let lut = js_adjustments["lutPath"]
            .as_str()
            .and_then(|p| get_or_load_lut(&state, p).ok());
        let processed_preview = process_and_get_dynamic_image_with_precision(
            &context,
            &state,
            &source,
            RenderRequest {
                adjustments: all_adjustments,
                mask_bitmaps: &mask_bitmaps,
                mask_cache_key: None,
                lut,
                roi: None,
                hsl_probe: false,
                motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                    &source_path_str,
                    &js_adjustments,
                    (preview_w, preview_h),
                    scaled_crop_offset,
                    original_image.width().max(original_image.height()) as f32 * gpu_scale,
                ),
            },
            "estimate_batch_export_size",
            render_output_precision(&output_format, &export_settings),
        )?;

        let preview_bytes =
            encode_image_to_bytes(&processed_preview, &output_format, &export_settings, None)?;
        let single_image_estimated_size = preview_bytes.len();

        let upscale = upscale_factor(&js_adjustments) as f32;
        let full_w = (shrunk_w as f32 / raw_scale_factor * upscale).round() as u32;
        let full_h = (shrunk_h as f32 / raw_scale_factor * upscale).round() as u32;

        let (final_full_w, final_full_h) =
            compute_export_output_size(full_w, full_h, &export_settings);

        let (processed_preview_w, processed_preview_h) = processed_preview.dimensions();
        let pixel_ratio = if processed_preview_w > 0 && processed_preview_h > 0 {
            (final_full_w as f64 * final_full_h as f64)
                / (processed_preview_w as f64 * processed_preview_h as f64)
        } else {
            1.0
        };

        (single_image_estimated_size as f64 * pixel_ratio) as usize
    };

    Ok(Some(single_image_extrapolated_size * paths.len()))
}
