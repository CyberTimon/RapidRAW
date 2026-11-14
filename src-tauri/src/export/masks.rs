use crate::adjustments::lut_processing::get_or_load_lut;
use crate::app::state::AppState;
use crate::decode::as_shot::as_shot;
use crate::export::encode::{save_image_with_metadata, set_timestamps_from_exif};
use crate::export::geometry::{apply_export_geometry_and_watermark, place_photo_on_canvas};
use crate::export::settings::{ExportSettings, render_output_precision};
use crate::export::tasks::ensure_export_not_cancelled;
use crate::masks::generation::{
    MaskDefinition, build_warped_image_for_masks, generate_mask_bitmap,
};
use crate::metadata::export_metadata;
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::output::process_and_get_dynamic_image_with_precision;
use crate::render::gpu::processor::RenderRequest;
use crate::render::options::resolve_render_options_from_handle;
use crate::render::source::{RenderSource, fit_to_gpu, source_id};
use crate::render::uniforms::{AllAdjustments, get_all_adjustments_from_json};
use image::{DynamicImage, GrayImage, ImageBuffer, ImageFormat, Luma, imageops};
use serde_json::Value;
#[cfg(not(target_os = "android"))]
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

fn build_single_mask_adjustments(all: &AllAdjustments, mask_index: usize) -> AllAdjustments {
    let mut single = AllAdjustments {
        global: all.global,
        mask_adjustments: all.mask_adjustments,
        mask_count: 1,
        tile_offset_x: all.tile_offset_x,
        tile_offset_y: all.tile_offset_y,
        mask_atlas_cols: all.mask_atlas_cols,
    };
    single.mask_adjustments[0] = all.mask_adjustments[mask_index];
    for i in 1..single.mask_adjustments.len() {
        single.mask_adjustments[i] = Default::default();
    }
    single
}

fn encode_grayscale_to_png(bitmap: &GrayImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    bitmap
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

#[allow(clippy::too_many_arguments)]
pub fn export_masks_for_image(
    base_image: &DynamicImage,
    base_scale: f32,
    js_adjustments: &Value,
    export_settings: &ExportSettings,
    output_path_obj: &std::path::Path,
    source_path_str: &str,
    export_xmp: &export_metadata::ExportXmp,
    context: &Arc<GpuContext>,
    state: &tauri::State<AppState>,
    is_raw: bool,
    app_handle: &tauri::AppHandle,
    cancellation_token: &AtomicBool,
) -> Result<(), String> {
    ensure_export_not_cancelled(cancellation_token)?;
    let (fitted, fit_scale) = fit_to_gpu(context, base_image);
    let scale = fit_scale * base_scale;
    let source = RenderSource::edited(
        &fitted,
        source_id("export", source_path_str, js_adjustments),
        source_path_str,
        js_adjustments,
    )
    .scaled(scale);
    let crop_offset = source.crop_offset();
    let (img_w, img_h) = source.size();
    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let warped_image = build_warped_image_for_masks(
        base_image,
        base_scale,
        is_raw,
        source_path_str,
        js_adjustments,
        &mask_definitions,
    );
    let mut mask_bitmaps = Vec::with_capacity(mask_definitions.len());
    for definition in &mask_definitions {
        ensure_export_not_cancelled(cancellation_token)?;
        if let Some(bitmap) = generate_mask_bitmap(
            definition,
            img_w,
            img_h,
            scale,
            crop_offset,
            warped_image.as_deref(),
        ) {
            mask_bitmaps.push(bitmap);
        }
        ensure_export_not_cancelled(cancellation_token)?;
    }

    if !mask_bitmaps.is_empty() {
        let render = resolve_render_options_from_handle(app_handle, is_raw);
        let all_adjustments =
            get_all_adjustments_from_json(js_adjustments, is_raw, as_shot(source_path_str), render);
        let lut_path = js_adjustments["lutPath"].as_str();
        let lut = lut_path.and_then(|p| get_or_load_lut(state, p).ok());
        let output_dir = output_path_obj.parent().unwrap_or(output_path_obj);
        let stem = output_path_obj
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export");
        let extension = output_path_obj
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("jpg");

        for (i, _) in mask_bitmaps.iter().enumerate() {
            ensure_export_not_cancelled(cancellation_token)?;
            let single_adjustments = build_single_mask_adjustments(&all_adjustments, i);
            let full_white_mask = ImageBuffer::from_fn(img_w, img_h, |_, _| Luma([255u8]));
            let single_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = vec![full_white_mask];

            let processed = process_and_get_dynamic_image_with_precision(
                context,
                state,
                &source,
                RenderRequest {
                    adjustments: single_adjustments,
                    mask_bitmaps: &single_bitmaps,
                    mask_cache_key: None,
                    lut: lut.clone(),
                    roi: None,
                    hsl_probe: false,
                    motion_blur: Default::default(),
                },
                "export_mask_image",
                render_output_precision(extension, export_settings),
            )?;
            ensure_export_not_cancelled(cancellation_token)?;

            let (with_options, geometry) =
                apply_export_geometry_and_watermark(processed, export_settings)?;

            let alpha_scaled = imageops::resize(
                &mask_bitmaps[i],
                geometry.photo_w,
                geometry.photo_h,
                imageops::FilterType::Lanczos3,
            );

            let alpha_resized: GrayImage = if geometry.is_identity() {
                alpha_scaled
            } else {
                place_photo_on_canvas(&alpha_scaled, &geometry, Luma([0u8]), None)
            };
            ensure_export_not_cancelled(cancellation_token)?;

            let mask_image_path =
                output_dir.join(format!("{}_mask_{}_image.{}", stem, i, extension));
            let mask_alpha_path = output_dir.join(format!("{}_mask_{}_alpha.png", stem, i));

            save_image_with_metadata(
                &with_options,
                &mask_image_path,
                source_path_str,
                export_xmp,
                export_settings,
            )?;
            ensure_export_not_cancelled(cancellation_token)?;

            if export_settings.preserve_timestamps {
                set_timestamps_from_exif(Path::new(source_path_str), &mask_image_path);
            }

            let alpha_bytes = encode_grayscale_to_png(&alpha_resized)?;
            ensure_export_not_cancelled(cancellation_token)?;
            #[cfg(target_os = "android")]
            {
                let file_name = mask_alpha_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "Missing Android mask export file name".to_string())?;
                crate::platform::android::save_image_bytes_to_android_gallery(
                    file_name,
                    "image/png",
                    &alpha_bytes,
                )?;
            }

            #[cfg(not(target_os = "android"))]
            fs::write(&mask_alpha_path, alpha_bytes).map_err(|e| e.to_string())?;
            ensure_export_not_cancelled(cancellation_token)?;
        }
    }
    Ok(())
}
