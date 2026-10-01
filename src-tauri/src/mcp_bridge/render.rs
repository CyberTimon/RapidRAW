//! Rendering and delivery adapter. The original remains in the isolated session;
//! all transformations, masks, color processing and export options reuse the
//! native engine. Initially previews render at source resolution then resize, so
//! detail-dependent effects match final exports exactly.
mod comparison;
mod review;
use super::sessions::{Bridge, Session, atomic_write};
use super::{Result, flag, number, required, validation};
use crate::app_state::AppState;
use crate::delivery::{self, normalize_webp_metadata_header};
use crate::export_processing::{
    ExportSettings, ResizeMode, ResizeOptions, TiffBitDepth, WatermarkSettings,
    apply_export_resize_and_watermark, calculate_resize_target, encode_image_to_bytes,
    export_adjustments_as_lut_high_precision,
};
use crate::gpu_processing::{RenderRequest, Roi, process_and_get_dynamic_image_high_precision};
use crate::image_processing::{
    calculate_histogram_from_image, calculate_waveform_from_image, get_all_adjustments_from_json,
    get_or_init_gpu_context, resolve_tonemapper_override_from_handle,
};
use crate::mask_generation::{MaskDefinition, render_source_mask_bitmaps};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, GenericImageView, GrayImage, ImageBuffer, ImageFormat, Luma, imageops};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    fs,
    io::Cursor,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
use tauri::Manager;

struct Prepared {
    image: DynamicImage,
    adjustments: Value,
    masks: Vec<MaskDefinition>,
    bitmaps: Vec<GrayImage>,
    crop_offset: (f32, f32),
    warnings: Vec<String>,
}

fn render_mcp_source_masks(
    masks: &[MaskDefinition],
    composited_source: &DynamicImage,
    is_raw: bool,
    adjustments: &Value,
    dimensions: (u32, u32),
    crop_offset: (f32, f32),
) -> Result<(Vec<GrayImage>, Vec<String>)> {
    let bitmaps = render_source_mask_bitmaps(
        masks,
        Some(composited_source),
        is_raw,
        adjustments,
        dimensions.0,
        dimensions.1,
        1.0,
        crop_offset,
    )
    .map_err(|error| format!("MASK_RENDER_FAILED: {error}"))?;
    if bitmaps.len() != masks.len() {
        return Err("MASK_RENDER_FAILED: Could not rasterize every visible mask".into());
    }
    let warnings = masks
        .iter()
        .zip(&bitmaps)
        .filter(|(_, bitmap)| !bitmap.as_raw().iter().any(|value| *value > 0))
        .map(|(mask, _)| {
            format!(
                "Mask {} ({}) has no coverage in the rendered image; it may lie outside the current crop.",
                mask.name, mask.id
            )
        })
        .collect();
    Ok((bitmaps, warnings))
}

struct Frame {
    image: DynamicImage,
    rendered_dimensions: (u32, u32),
    region: Roi,
    crop_offset: (f32, f32),
    mask_coverage: Option<Value>,
    review_images: Vec<(String, DynamicImage)>,
    warnings: Vec<String>,
}

// Display previews use eight-bit channels, matching ordinary photo previews.
// Quantization happens after native rendering and geometry; retain the exact
// Luma8 selection values and leave full-precision export encoding separate.
fn encode_preview_image(image: &DynamicImage, format: &str, quality: u8) -> Result<Vec<u8>> {
    let preview = if matches!(image, DynamicImage::ImageLuma8(_)) {
        Cow::Borrowed(image)
    } else {
        Cow::Owned(DynamicImage::ImageRgb8(image.to_rgb8()))
    };
    encode_image_to_bytes(&preview, format, quality, TiffBitDepth::Eight)
}

fn preview_blocks(frame: &Frame, format: &str, quality: u8) -> Result<(Value, Vec<Value>)> {
    let main = json!({"mimeType":if format=="png"{"image/png"}else{"image/jpeg"},
        "data":STANDARD.encode(encode_preview_image(&frame.image, format, quality)?)});
    let matched = frame.review_images.iter().map(|(label, image)| {
        Ok(json!({"label":label,"width":image.width(),"height":image.height(),"mimeType":"image/png",
            "data":STANDARD.encode(encode_preview_image(image, "png", 100)?)}))
    }).collect::<Result<Vec<_>>>()?;
    Ok((main, matched))
}

impl Bridge {
    fn prepare_render(&self, session: &Session, original: bool) -> Result<Prepared> {
        if self.active.as_deref() != Some(session.id.as_str()) {
            return Err("SESSION_NOT_ACTIVE: Activate the session before rendering".into());
        }
        let state = self.handle.state::<AppState>();
        let loaded = state
            .original_image
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .cloned()
            .ok_or("IMAGE_NOT_LOADED: No active source image")?;
        if loaded.path != session.working_path {
            return Err("SESSION_NOT_ACTIVE: Loaded image does not match the session".into());
        }
        let adjustments = if original {
            validation::default_adjustments()
        } else {
            session.current().adjustments.clone()
        };
        validation::validate_adjustments(&adjustments, session.dimensions)?;
        let composite =
            crate::image_loader::composite_patches_on_image(&loaded.image, &adjustments)
                .map_err(|e| format!("PATCH_RENDER_FAILED: {e}"))?;
        let (image, crop_offset) =
            crate::apply_all_transformations(Cow::Borrowed(&composite), &adjustments);
        // Native cropping rounds source pixels; masks use the same sampled origin.
        let crop_offset = (crop_offset.0.round(), crop_offset.1.round());
        let image = image.into_owned();
        let masks = crate::marigold_surface::render_masks(&adjustments);
        let masks: Vec<_> = masks.into_iter().filter(|m| m.visible).collect();
        // Bind image-dependent masks to this session's captured photo, even if
        // the editor switches to another image while the MCP render is running.
        let (bitmaps, warnings) = render_mcp_source_masks(
            &masks,
            &composite,
            loaded.is_raw,
            &adjustments,
            image.dimensions(),
            crop_offset,
        )?;
        Ok(Prepared {
            image,
            adjustments,
            masks,
            bitmaps,
            crop_offset,
            warnings,
        })
    }

    fn render_prepared(
        &self,
        session: &Session,
        prepared: &Prepared,
        region: Roi,
        isolated_mask: Option<usize>,
    ) -> Result<DynamicImage> {
        let state = self.handle.state::<AppState>();
        let context = get_or_init_gpu_context(&state, &self.handle)?;
        let tm = resolve_tonemapper_override_from_handle(&self.handle, session.is_raw);
        let mut adjustments =
            get_all_adjustments_from_json(&prepared.adjustments, session.is_raw, tm);
        adjustments.global.show_clipping = 0;
        let lut = match prepared.adjustments["lutPath"]
            .as_str()
            .filter(|p| !p.is_empty())
        {
            Some(path) => Some(
                crate::lut_processing::get_or_load_lut(&state, path)
                    .map_err(|e| format!("LUT_LOAD_FAILED: {e}"))?,
            ),
            None => None,
        };
        let isolated_bitmap;
        let bitmaps = if let Some(index) = isolated_mask {
            adjustments.mask_adjustments[0] = adjustments.mask_adjustments[index];
            adjustments.mask_count = 1;
            for mask in &mut adjustments.mask_adjustments[1..] {
                *mask = Default::default();
            }
            isolated_bitmap = vec![ImageBuffer::from_pixel(
                prepared.image.width(),
                prepared.image.height(),
                Luma([255u8]),
            )];
            &isolated_bitmap
        } else {
            &prepared.bitmaps
        };
        process_and_get_dynamic_image_high_precision(
            &context,
            &prepared.image,
            RenderRequest {
                adjustments,
                mask_bitmaps: bitmaps,
                lut,
                roi: Some(region),
            },
        )
        .map_err(|e| format!("RENDER_FAILED: {e}"))
    }

    fn render_frame(&self, session: &Session, params: &Value) -> Result<Frame> {
        let original = flag(params, "original", false)?;
        if original && params.get("mask_id").is_some() {
            return Err("INVALID_ARGUMENT: original and mask_id cannot be combined".into());
        }
        let mask_mode = params["mask_mode"].as_str().unwrap_or("grayscale");
        if !["grayscale", "overlay"].contains(&mask_mode) {
            return Err("INVALID_ARGUMENT: mask_mode must be grayscale or overlay".into());
        }
        if params.get("mask_id").is_none() && params.get("mask_mode").is_some() {
            return Err("INVALID_ARGUMENT: mask_mode requires mask_id".into());
        }
        let clipping_overlay = flag(params, "clipping_overlay", false)?;
        if clipping_overlay && params.get("mask_id").is_some() {
            return Err(
                "INVALID_ARGUMENT: clipping_overlay cannot be combined with mask_id".into(),
            );
        }
        let prepared = self.prepare_render(session, original)?;
        let rendered_dimensions = prepared.image.dimensions();
        let region = parse_region(params.get("region"), rendered_dimensions)?;
        let mut review_images = Vec::new();
        let (image, mask_coverage) = if let Some(id) = params.get("mask_id") {
            let id = id
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("INVALID_ARGUMENT: mask_id must be a nonempty string")?;
            let index = prepared
                .masks
                .iter()
                .position(|mask| mask.id == id)
                .ok_or_else(|| format!("MASK_NOT_FOUND: No enabled mask with id {id}"))?;
            let bitmap = imageops::crop_imm(
                &prepared.bitmaps[index],
                region.x,
                region.y,
                region.width,
                region.height,
            )
            .to_image();
            let mut coverage = mask_coverage(&bitmap);
            coverage["bounds_rendered"] = review::mask_bounds(&bitmap, (region.x, region.y), 1);
            coverage["core_bounds_rendered"] =
                review::mask_bounds(&bitmap, (region.x, region.y), 128);
            let image = if mask_mode == "overlay" {
                let rgb = self.render_prepared(session, &prepared, region, None)?;
                coverage["selected_rgb_statistics"] = review::weighted_statistics(&rgb, &bitmap);
                review_images.push(("Matched edited photograph".to_string(), rgb.clone()));
                review_images.push((
                    "Matched grayscale selection".to_string(),
                    DynamicImage::ImageLuma8(bitmap.clone()),
                ));
                let opacity = number(params, "overlay_opacity", 0.5, 0.0, 1.0)?;
                review::overlay_mask(&rgb, &bitmap, opacity)?
            } else {
                DynamicImage::ImageLuma8(bitmap)
            };
            (image, Some(coverage))
        } else {
            (
                self.render_prepared(session, &prepared, region, None)?,
                None,
            )
        };
        // Clipping is a display diagnostic only. Exports use render_prepared
        // directly, so saved showClipping state never contaminates deliverables.
        let image = if clipping_overlay {
            review::clipping_overlay(&image)
        } else {
            image
        };
        // The ROI is selected at full resolution, before delivery scaling.
        let image = resize_long_edge(image, optional_long_edge(params)?)?;
        let review_images = review_images
            .into_iter()
            .map(|(label, image)| {
                Ok((label, resize_long_edge(image, optional_long_edge(params)?)?))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Frame {
            image,
            rendered_dimensions,
            region,
            crop_offset: prepared.crop_offset,
            mask_coverage,
            review_images,
            warnings: prepared.warnings,
        })
    }

    pub(super) fn render_response(&self, session: &Session, params: &Value) -> Result<Value> {
        let mut params = params.clone();
        if params.get("long_edge").is_none() && params.get("region").is_none() {
            params["long_edge"] = json!(1600);
        }
        if params.get("clipping_overlay").is_none() && params.get("mask_id").is_none() {
            params["clipping_overlay"] = json!(
                session.current().adjustments["showClipping"]
                    .as_bool()
                    .unwrap_or(false)
            );
        }
        let use_cache = flag(&params, "cache", true)?;
        let cache_key = if use_cache {
            Some(review::cache_key(self, session, &params)?)
        } else {
            None
        };
        if let Some(key) = cache_key.as_ref()
            && let Some(mut response) = review::cached_preview(key)
        {
            response["cache"] = json!({"hit":true,"native_full_resolution":true});
            return Ok(response);
        }
        let frame = self.render_frame(session, &params)?;
        let format = params
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("jpeg");
        if !matches!(format, "jpeg" | "jpg" | "png") {
            return Err("INVALID_ARGUMENT: Preview format must be jpeg or png".into());
        }
        let quality = integer(&params, "quality", 90, 1, 100)? as u8;
        let (image, matched) = preview_blocks(&frame, format, quality)?;
        let mut response = frame_info(session, &frame);
        response["image"] = image;
        response["original"] = json!(flag(&params, "original", false)?);
        if !frame.review_images.is_empty() {
            response["images"] = Value::Array(matched);
            response["overlay_legend"] = json!({"color":"magenta","opacity":number(&params,"overlay_opacity",0.5,0.0,1.0)?,"matched_images":true});
        }
        if let Some(coverage) = frame.mask_coverage {
            response["mask_coverage"] = coverage;
            response["mask_id"] = params["mask_id"].clone();
            response["mask_mode"] = json!(params["mask_mode"].as_str().unwrap_or("grayscale"));
        }
        response["clipping_overlay"] = json!(flag(&params, "clipping_overlay", false)?);
        response["cache"] = json!({"hit":false,"enabled":use_cache,"native_full_resolution":true});
        if let Some(key) = cache_key {
            review::cache_preview(key, &response);
        }
        Ok(response)
    }

    pub(super) fn analyze(&self, session: &Session, params: &Value) -> Result<Value> {
        let mut params = params.clone();
        if params.get("long_edge").is_none() && params.get("region").is_none() {
            params["long_edge"] = json!(1600);
        }
        let frame = self.render_frame(session, &params)?;
        let mut response = frame_info(session, &frame);
        response["statistics"] = image_statistics(&frame.image);
        response["analysis_scope"] = json!(
            "Rendered sRGB preview; clipping fractions describe displayed pixels, not sensor RAW headroom."
        );
        if flag(&params, "histogram", true)? {
            response["histogram"] =
                serde_json::to_value(calculate_histogram_from_image(&frame.image)?)
                    .map_err(|e| e.to_string())?;
            response["histogram_normalization"] = json!(
                "Native 256-bin per-channel display histogram, normalized to the 99th-percentile bin."
            );
        }
        if flag(&params, "scopes", false)? {
            response["scopes"] =
                serde_json::to_value(calculate_waveform_from_image(&frame.image, None)?)
                    .map_err(|e| e.to_string())?;
            response["scopes"]["encoding"] =
                json!("base64 RGBA8, row-major; width and height are supplied");
        }
        Ok(response)
    }

    pub(super) fn export_photo(&self, session: &Session, params: &Value) -> Result<Value> {
        let target = self.output_path(required(params, "path")?, "exports")?;
        self.protect_source_destination(&target)?;
        let overwrite = flag(params, "overwrite", false)?;
        check_destination(&target, overwrite)?;
        let extension = target.extension().and_then(|s| s.to_str()).unwrap_or("");
        let format = normalize_format(
            params
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or(extension),
        )?;
        if normalize_format(extension)? != format {
            return Err("INVALID_ARGUMENT: Filename extension must match the export format".into());
        }
        let quality = integer(params, "quality", 95, 1, 100)? as u8;
        if format == "cube" {
            for key in [
                "color_profile",
                "long_edge",
                "resize",
                "bit_depth",
                "watermark",
                "export_masks",
                "quality",
                "keep_metadata",
            ] {
                if params
                    .get(key)
                    .is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
                {
                    return Err(format!(
                        "INVALID_ARGUMENT: {key} is not applicable to LUT exports"
                    ));
                }
            }
            let state = self.handle.state::<AppState>();
            let context = Arc::new(get_or_init_gpu_context(&state, &self.handle)?);
            let bytes = export_adjustments_as_lut_high_precision(
                &session.current().adjustments,
                &session.working_path,
                &context,
                &state,
                &self.handle,
                &AtomicBool::new(false),
            )?;
            if !String::from_utf8_lossy(&bytes).contains("LUT_3D_SIZE") {
                return Err(
                    "EXPORT_VERIFICATION_FAILED: Engine produced an invalid cube LUT".into(),
                );
            }
            atomic_write(&target, &bytes, overwrite)?;
            if flag(params, "preserve_timestamps", false)? {
                self.save_sidecar(&session.id)?;
                preserve_timestamps(session, &target)?;
            }
            let cube = crate::lut_processing::parse_lut_file(
                target.to_str().ok_or("INVALID_PATH: Non-UTF8 LUT path")?,
            )
            .map_err(|e| format!("EXPORT_VERIFICATION_FAILED: {e}"))?;
            if cube.size != 33
                || cube.data.len() != 33 * 33 * 33 * 3
                || cube.data.iter().any(|v| !v.is_finite())
            {
                return Err("EXPORT_VERIFICATION_FAILED: LUT size or samples are invalid".into());
            }
            let excluded = lut_excluded_adjustments(&session.current().adjustments);
            return Ok(
                json!({"session_id":session.id,"revision":session.revision,"path":target,"format":"cube","bytes":bytes.len(),"source_unchanged":true,"verified":{"parsed":true,"size":33,"samples":33*33*33},"render_precision":"float32 GPU processing with 16-bit sample quantization","global_color_only":true,"excluded_adjustments":excluded,"warnings":["LUTs encode global color adjustments only; listed spatial edits and masks remain in the recipe and cannot be represented in a cube."]}),
            );
        }
        let bit_depth = integer(
            params,
            "bit_depth",
            if matches!(format, "png" | "tiff") {
                16
            } else {
                8
            },
            8,
            16,
        )?;
        if ![8, 16].contains(&bit_depth) || (bit_depth == 16 && !matches!(format, "png" | "tiff")) {
            return Err("INVALID_ARGUMENT: 16-bit output is supported by PNG and TIFF only; bit_depth must be 8 or 16".into());
        }
        let mut settings = export_settings(params, quality)?;
        let metadata_default_disabled = params.get("keep_metadata").is_none()
            && crate::exif_processing::preflight_metadata_retention(
                &session.working_path,
                format,
                true,
            )
            .is_err();
        if metadata_default_disabled {
            settings.keep_metadata = false;
        }
        crate::exif_processing::preflight_metadata_retention(
            &session.working_path,
            format,
            settings.keep_metadata,
        )?;
        let profile_policy = params
            .get("color_profile")
            .map(|v| {
                v.as_str()
                    .ok_or("INVALID_ARGUMENT: color_profile must be auto, srgb or none")
            })
            .transpose()?
            .unwrap_or("auto");
        if !["auto", "srgb", "none"].contains(&profile_policy) {
            return Err("INVALID_ARGUMENT: color_profile must be auto, srgb or none".into());
        }
        let supports_profile = delivery::supports_icc(format);
        if profile_policy == "srgb" && !supports_profile {
            return Err(format!(
                "UNSUPPORTED_COLOR_PROFILE: Explicit ICC embedding is unavailable for {format}; use auto for native signalling or none"
            ));
        }
        let embed_profile = profile_policy != "none" && supports_profile;
        self.save_sidecar(&session.id)?;
        let prepared = self.prepare_render(session, false)?;
        preflight_resize(prepared.image.dimensions(), &settings)?;
        let region = parse_region(None, prepared.image.dimensions())?;
        let image = self.render_prepared(session, &prepared, region, None)?;
        let image = apply_export_resize_and_watermark(image, &settings)?;
        let mut jxl_lossless_alpha =
            format == "jxl" && crate::export_processing::jxl_uses_lossless_alpha(&image, quality);
        let (bytes, metadata_applied) =
            self.encode_export(session, &image, format, bit_depth, &settings, embed_profile)?;
        let mut mask_paths = Vec::new();
        if settings.export_masks {
            let parent = target.parent().unwrap();
            let stem = target.file_stem().unwrap().to_string_lossy();
            for (index, mask) in prepared.masks.iter().enumerate() {
                let image_path = parent.join(format!("{stem}_mask_{index}_image.{extension}"));
                let alpha_path = parent.join(format!("{stem}_mask_{index}_alpha.png"));
                check_destination(&image_path, overwrite)?;
                check_destination(&alpha_path, overwrite)?;
                // Resolve every derived filename through the same workspace and
                // symlink checks as the main export before writing anything.
                let image_path = self.output_path(
                    image_path
                        .to_str()
                        .ok_or("INVALID_PATH: Non-UTF8 mask path")?,
                    "exports",
                )?;
                let alpha_path = self.output_path(
                    alpha_path
                        .to_str()
                        .ok_or("INVALID_PATH: Non-UTF8 mask path")?,
                    "exports",
                )?;
                self.protect_source_destination(&image_path)?;
                self.protect_source_destination(&alpha_path)?;
                mask_paths.push((index, mask.id.clone(), image_path, alpha_path));
            }
        }
        atomic_write(&target, &bytes, overwrite)?;
        let verified = verify_raster(&target, image.dimensions(), bit_depth)?;
        if settings.preserve_timestamps {
            preserve_timestamps(session, &target)?;
        }
        let mut exported_masks = Vec::new();
        for (index, id, image_path, alpha_path) in mask_paths {
            let local_image = self.render_prepared(session, &prepared, region, Some(index))?;
            let local_image = apply_export_resize_and_watermark(local_image, &settings)?;
            jxl_lossless_alpha |= format == "jxl"
                && crate::export_processing::jxl_uses_lossless_alpha(&local_image, quality);
            let (local_bytes, _) = self.encode_export(
                session,
                &local_image,
                format,
                bit_depth,
                &settings,
                embed_profile,
            )?;
            let alpha = imageops::resize(
                &prepared.bitmaps[index],
                local_image.width(),
                local_image.height(),
                imageops::FilterType::Lanczos3,
            );
            let alpha_bytes = encode_image_to_bytes(
                &DynamicImage::ImageLuma8(alpha.clone()),
                "png",
                100,
                TiffBitDepth::Eight,
            )?;
            atomic_write(&image_path, &local_bytes, overwrite)?;
            atomic_write(&alpha_path, &alpha_bytes, overwrite)?;
            verify_raster(&image_path, local_image.dimensions(), bit_depth)?;
            verify_raster(&alpha_path, alpha.dimensions(), 8)?;
            if settings.preserve_timestamps {
                preserve_timestamps(session, &image_path)?;
                preserve_timestamps(session, &alpha_path)?;
            }
            exported_masks.push(json!({"mask_id":id,"image_path":image_path,"alpha_path":alpha_path,"coverage":mask_coverage(&alpha)}));
        }
        let mut warnings = prepared.warnings.clone();
        if metadata_default_disabled {
            warnings.push(format!(
                "Capture metadata is not retained for this {format} export; set keep_metadata=true to request an explicit capability check."
            ));
        }
        if settings.keep_metadata && !metadata_applied {
            warnings.push("The native metadata writer could not preserve EXIF for this source/output format; metadata remains in the session sidecar.".to_string());
        }
        if format == "avif" {
            warnings.push("AVIF was verified using container dimensions and channel depth; this build has no AVIF pixel decoder.".to_string());
        }
        if jxl_lossless_alpha {
            warnings.push("Transparent JPEG XL images larger than 256 pixels on either axis are encoded losslessly to preserve a decodable alpha channel; the quality setting is not applied and the file may be larger.".to_string());
        }
        Ok(
            json!({"session_id":session.id,"revision":session.revision,"path":target,"format":format,
            "width":image.width(),"height":image.height(),"bytes":bytes.len(),"bit_depth":bit_depth,
            "verified":verified,"source_unchanged":true,"metadata_applied":metadata_applied,"strip_gps":settings.strip_gps,
            "preserve_timestamps":settings.preserve_timestamps,"masks":exported_masks,"warnings":warnings,
            "color_profile":{"space":"sRGB","policy":profile_policy,"icc_embedded":embed_profile,"icc_verified":if embed_profile {delivery::verify_profile(&bytes,format)?}else{false}}}),
        )
    }

    fn encode_export(
        &self,
        session: &Session,
        image: &DynamicImage,
        format: &str,
        bit_depth: u32,
        settings: &ExportSettings,
        embed_profile: bool,
    ) -> Result<(Vec<u8>, bool)> {
        crate::exif_processing::preflight_metadata_retention(
            &session.working_path,
            format,
            settings.keep_metadata,
        )?;
        let mut bytes = if embed_profile && matches!(format, "png" | "tiff") {
            delivery::encode_profiled_raster(image, format, bit_depth, false)?
        } else {
            encode_at_depth(image, format, bit_depth, settings.jpeg_quality)?
        };
        if format == "webp" && settings.keep_metadata {
            // Upgrade first: little_exif cannot upgrade a simple lossy WebP and
            // otherwise returns an error after partially inserting its metadata.
            normalize_webp_metadata_header(&mut bytes, image.dimensions(), true)?;
        }
        crate::exif_processing::write_image_with_metadata(
            &mut bytes,
            &session.working_path,
            format,
            settings.keep_metadata,
            settings.strip_gps,
        )?;
        if embed_profile && matches!(format, "jpeg" | "webp") {
            delivery::add_profile(&mut bytes, format)?;
        }
        if format == "webp" {
            normalize_webp_metadata_header(&mut bytes, image.dimensions(), false)?;
        }
        if delivery::supports_icc(format) {
            delivery::verify_raster_header(&bytes, format, image.dimensions(), bit_depth)?;
        }
        let (has_metadata, has_gps) = metadata_summary(&bytes, format);
        let metadata_applied = settings.keep_metadata && has_metadata;
        if settings.strip_gps && has_gps {
            return Err(
                "EXPORT_VERIFICATION_FAILED: GPS coordinates remained after metadata stripping"
                    .into(),
            );
        }
        if embed_profile && !delivery::verify_profile(&bytes, format)? {
            return Err(
                "EXPORT_VERIFICATION_FAILED: Embedded sRGB ICC profile did not survive encoding"
                    .into(),
            );
        }
        Ok((bytes, metadata_applied))
    }

    fn protect_source_destination(&self, target: &Path) -> Result<()> {
        for session in self.sessions.values() {
            reject_source_destination(target, Path::new(&session.source_path))?;
            reject_source_destination(target, Path::new(&session.working_path))?;
        }
        // Closed sessions still own their sources. Checking persisted manifests
        // keeps overwrite protection independent of the active connection.
        for entry in fs::read_dir(self.paths.root.join("sessions")).map_err(|e| e.to_string())? {
            let manifest = entry
                .map_err(|e| e.to_string())?
                .path()
                .join("session.json");
            if !manifest.is_file() {
                continue;
            }
            let session = super::sessions::session_from_manifest_bytes(
                &fs::read(&manifest).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("INVALID_SESSION: Cannot verify protected source paths: {e}"))?;
            reject_source_destination(target, Path::new(&session.source_path))?;
            reject_source_destination(target, Path::new(&session.working_path))?;
        }
        Ok(())
    }
}

fn metadata_summary(bytes: &Vec<u8>, format: &str) -> (bool, bool) {
    if format == "png" {
        // Native PNG metadata uses a compressed zTXt raw EXIF profile; the
        // kamadak reader only sees the eXIf representation. Read both through
        // the same library the native writer uses.
        use little_exif::{filetype::FileExtension, ifd::ExifTagGroup, metadata::Metadata};
        if let Ok(metadata) = Metadata::new_from_vec(
            bytes,
            FileExtension::PNG {
                as_zTXt_chunk: true,
            },
        ) {
            let software = metadata
                .get_tag_by_hex(0x0131, Some(ExifTagGroup::GENERIC))
                .next()
                .is_some();
            let gps = metadata
                .get_ifds()
                .iter()
                .any(|ifd| ifd.get_ifd_type() == ExifTagGroup::GPS && !ifd.get_tags().is_empty());
            return (software, gps);
        }
    }
    let metadata = exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok();
    (
        metadata.as_ref().is_some_and(|data| {
            data.get_field(exif::Tag::Software, exif::In::PRIMARY)
                .is_some()
        }),
        metadata.as_ref().is_some_and(|data| {
            data.fields()
                .any(|field| field.tag.context() == exif::Context::Gps)
        }),
    )
}

fn lut_excluded_adjustments(adjustments: &Value) -> Vec<String> {
    let defaults = validation::default_adjustments();
    [
        "masks",
        "aiPatches",
        "crop",
        "rotation",
        "orientationSteps",
        "flipHorizontal",
        "flipVertical",
        "vignetteAmount",
        "grainAmount",
        "sharpness",
        "clarity",
        "dehaze",
        "structure",
        "centré",
        "glowAmount",
        "halationAmount",
        "flareAmount",
        "lumaNoiseReduction",
        "colorNoiseReduction",
        "chromaticAberrationRedCyan",
        "chromaticAberrationBlueYellow",
        "lensBlurEnabled",
        "transformDistortion",
        "transformVertical",
        "transformHorizontal",
        "transformAspect",
        "transformXOffset",
        "transformYOffset",
        "transformRotate",
        "transformScale",
        "guidedPerspective",
        "lensProfile",
    ]
    .into_iter()
    .filter(|key| {
        adjustments
            .get(*key)
            .is_some_and(|value| !value.is_null() && value != &defaults[*key])
    })
    .map(str::to_owned)
    .collect()
}

fn frame_info(session: &Session, frame: &Frame) -> Value {
    json!({"session_id":session.id,"revision":session.revision,"width":frame.image.width(),"height":frame.image.height(),
        "source_width":session.dimensions.0,"source_height":session.dimensions.1,
        "rendered_width":frame.rendered_dimensions.0,"rendered_height":frame.rendered_dimensions.1,
        "region":{"x":frame.region.x,"y":frame.region.y,"width":frame.region.width,"height":frame.region.height},
        "coordinates":{"space":"rendered image pixels after orientation, geometry, rotation, flips and user crop",
            "pixel_origin":"top-left","crop_offset":{"x":frame.crop_offset.0,"y":frame.crop_offset.1},
            "preview_to_rendered_scale":{"x":frame.region.width as f64/frame.image.width() as f64,"y":frame.region.height as f64/frame.image.height() as f64},
            "mapping":"rendered_x = region.x + (preview_x + 0.5) * scale.x - 0.5; rendered_y = region.y + (preview_y + 0.5) * scale.y - 0.5",
            "pixel_coordinate_convention":"pixel centers; top-left pixel is (0,0)","coordinate_mapping_tool":"map_coordinates"},
        "render_precision":"float32 processing with 16-bit final raster; preview encoding may be 8-bit", "warnings":frame.warnings})
}

fn parse_region(value: Option<&Value>, dimensions: (u32, u32)) -> Result<Roi> {
    let (width, height) = dimensions;
    let Some(value) = value else {
        return Ok(Roi {
            x: 0,
            y: 0,
            width,
            height,
        });
    };
    if !value.is_object() {
        return Err("INVALID_ARGUMENT: region must be a rectangle object".into());
    }
    let roi = Roi {
        x: integer(value, "x", u32::MAX, 0, u32::MAX)?,
        y: integer(value, "y", u32::MAX, 0, u32::MAX)?,
        width: integer(value, "width", 0, 1, u32::MAX)?,
        height: integer(value, "height", 0, 1, u32::MAX)?,
    };
    if roi.x.checked_add(roi.width).is_none_or(|v| v > width)
        || roi.y.checked_add(roi.height).is_none_or(|v| v > height)
    {
        return Err(format!(
            "INVALID_REGION: Region lies outside the {width}x{height} rendered image (coordinates are after crop)"
        ));
    }
    Ok(roi)
}

fn integer(params: &Value, key: &str, default: u32, min: u32, max: u32) -> Result<u32> {
    let value = number(params, key, default as f64, min as f64, max as f64)?;
    if value.fract() != 0.0 {
        return Err(format!("INVALID_ARGUMENT: {key} must be an integer"));
    }
    Ok(value as u32)
}

fn optional_long_edge(params: &Value) -> Result<Option<u32>> {
    params
        .get("long_edge")
        .map(|_| integer(params, "long_edge", 1600, 1, 32768))
        .transpose()
}

fn resize_long_edge(image: DynamicImage, long_edge: Option<u32>) -> Result<DynamicImage> {
    if let Some(max) = long_edge
        && image.width().max(image.height()) > max
    {
        return Ok(image.resize(max, max, imageops::FilterType::Lanczos3));
    }
    Ok(image)
}

fn mask_coverage(mask: &GrayImage) -> Value {
    let count = mask.as_raw().len() as f64;
    let nonzero = mask.as_raw().iter().filter(|v| **v > 0).count();
    let total: u64 = mask.as_raw().iter().map(|v| *v as u64).sum();
    json!({"nonzero_pixels":nonzero,"pixels":mask.as_raw().len(),"nonzero_fraction":nonzero as f64/count,
        "weighted_fraction":total as f64/(255.0*count),"minimum":mask.as_raw().iter().min(),"maximum":mask.as_raw().iter().max()})
}

fn image_statistics(image: &DynamicImage) -> Value {
    let image = image.to_rgb16();
    let mut sum = [0f64; 3];
    let mut minimum = [65535u16; 3];
    let mut maximum = [0u16; 3];
    let mut low = [0u64; 3];
    let mut high = [0u64; 3];
    let mut any_low = 0u64;
    let mut any_high = 0u64;
    let count = image.width() as u64 * image.height() as u64;
    for pixel in image.pixels() {
        for c in 0..3 {
            sum[c] += pixel[c] as f64;
            minimum[c] = minimum[c].min(pixel[c]);
            maximum[c] = maximum[c].max(pixel[c]);
            low[c] += u64::from(pixel[c] == 0);
            high[c] += u64::from(pixel[c] == 65535);
        }
        any_low += u64::from(pixel.0.contains(&0));
        any_high += u64::from(pixel.0.contains(&65535));
    }
    let mean = sum.map(|v| v / (count as f64 * 65535.0));
    json!({"pixels":count,"mean_rgb":mean,"mean_luminance":mean[0]*0.2126+mean[1]*0.7152+mean[2]*0.0722,
        "minimum_rgb":minimum.map(|v|v as f64/65535.0),"maximum_rgb":maximum.map(|v|v as f64/65535.0),
        "clipped_black_fraction":any_low as f64/count as f64,"clipped_white_fraction":any_high as f64/count as f64,
        "clipped_black_rgb_fraction":low.map(|v|v as f64/count as f64),"clipped_white_rgb_fraction":high.map(|v|v as f64/count as f64),
        "clipping_thresholds":{"black":0,"white":65535,"bit_depth":16}})
}

fn normalize_format(value: &str) -> Result<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Ok("jpeg"),
        "png" => Ok("png"),
        "tif" | "tiff" => Ok("tiff"),
        "webp" => Ok("webp"),
        "avif" => Ok("avif"),
        "jxl" => Ok("jxl"),
        "cube" => Ok("cube"),
        _ => Err("INVALID_ARGUMENT: Unsupported export format or filename extension".into()),
    }
}

fn export_settings(params: &Value, quality: u8) -> Result<ExportSettings> {
    if params.get("long_edge").is_some() && params.get("resize").is_some() {
        return Err("INVALID_ARGUMENT: Supply either long_edge or resize, not both".into());
    }
    let resize = if let Some(value) = params.get("resize") {
        let object = value
            .as_object()
            .ok_or("INVALID_ARGUMENT: resize must be an object")?;
        if object
            .keys()
            .any(|key| !["mode", "value", "dont_enlarge"].contains(&key.as_str()))
        {
            return Err(
                "INVALID_ARGUMENT: resize accepts mode, value and dont_enlarge only".into(),
            );
        }
        let mode =
            match required(value, "mode")? {
                "longEdge" => ResizeMode::LongEdge,
                "shortEdge" => ResizeMode::ShortEdge,
                "width" => ResizeMode::Width,
                "height" => ResizeMode::Height,
                _ => return Err(
                    "INVALID_ARGUMENT: resize.mode must be longEdge, shortEdge, width or height"
                        .into(),
                ),
            };
        Some(ResizeOptions {
            mode,
            value: integer(value, "value", 0, 1, 32768)?,
            dont_enlarge: flag(value, "dont_enlarge", true)?,
        })
    } else {
        optional_long_edge(params)?.map(|value| ResizeOptions {
            mode: ResizeMode::LongEdge,
            value,
            dont_enlarge: true,
        })
    };
    let watermark = match params.get("watermark") {
        Some(value) => {
            let settings: WatermarkSettings = serde_json::from_value(value.clone())
                .map_err(|e| format!("INVALID_ARGUMENT: Invalid watermark: {e}"))?;
            if !settings.scale.is_finite()
                || settings.scale <= 0.0
                || settings.scale > 1000.0
                || !settings.spacing.is_finite()
                || settings.spacing < 0.0
                || !settings.opacity.is_finite()
                || !(0.0..=100.0).contains(&settings.opacity)
            {
                return Err(
                    "INVALID_ARGUMENT: Watermark scale, spacing or opacity is out of range".into(),
                );
            }
            if !Path::new(&settings.path).is_file() {
                return Err("INVALID_ARGUMENT: Watermark file does not exist".into());
            }
            Some(settings)
        }
        None => None,
    };
    Ok(ExportSettings {
        jpeg_quality: quality,
        // The MCP export flow threads channel depth through the separate
        // `bit_depth` argument at encode time; keep the upstream default here.
        tiff_bit_depth: TiffBitDepth::default(),
        resize,
        keep_metadata: flag(params, "keep_metadata", true)?,
        strip_gps: flag(params, "strip_gps", true)?,
        preserve_timestamps: flag(params, "preserve_timestamps", false)?,
        watermark,
        export_masks: flag(params, "export_masks", false)?,
        filename_template: None,
        preserve_folders: false,
        destination_type: None,
        subfolder: None,
    })
}

fn preflight_resize(dimensions: (u32, u32), settings: &ExportSettings) -> Result<()> {
    if let Some(options) = &settings.resize {
        let (width, height) = calculate_resize_target(dimensions.0, dimensions.1, options);
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 100_000_000 {
            return Err(format!(
                "INVALID_ARGUMENT: Requested resize produces {width}x{height}; output must be nonempty and at most 100 megapixels"
            ));
        }
    }
    Ok(())
}

fn encode_at_depth(
    image: &DynamicImage,
    format: &str,
    bit_depth: u32,
    quality: u8,
) -> Result<Vec<u8>> {
    let image = if bit_depth == 16 {
        DynamicImage::ImageRgba16(image.to_rgba16())
    } else {
        DynamicImage::ImageRgba8(image.to_rgba8())
    };
    // The legacy TIFF helper always writes RGB16. An explicit 8-bit request must
    // actually produce an 8-bit file, so specialize that encoding case.
    if format == "tiff" && bit_depth == 8 {
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image.to_rgb8())
            .write_to(&mut output, ImageFormat::Tiff)
            .map_err(|e| e.to_string())?;
        Ok(output.into_inner())
    } else if format == "avif" {
        // The generic AVIF helper fixes quality at 80; honor the explicit
        // delivery quality through the same image crate encoder.
        let mut bytes = Vec::new();
        let encoder =
            image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut bytes, 4, quality);
        image
            .write_with_encoder(encoder)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    } else {
        let tiff_bit_depth = if bit_depth == 16 {
            TiffBitDepth::Sixteen
        } else {
            TiffBitDepth::Eight
        };
        encode_image_to_bytes(&image, format, quality, tiff_bit_depth)
    }
}

fn check_destination(path: &Path, overwrite: bool) -> Result<()> {
    if path.exists() && !overwrite {
        return Err(format!("OUTPUT_EXISTS: {}", path.display()));
    }
    Ok(())
}

fn verify_raster(path: &Path, expected: (u32, u32), depth: u32) -> Result<Value> {
    if path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("avif"))
    {
        return verify_avif_container(&fs::read(path).map_err(|e| e.to_string())?, expected, depth);
    }
    let decoded = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| {
            format!(
                "EXPORT_VERIFICATION_FAILED: Could not decode {}: {e}",
                path.display()
            )
        })?;
    let actual_depth =
        decoded.color().bits_per_pixel() as u32 / decoded.color().channel_count() as u32;
    if decoded.dimensions() != expected || actual_depth != depth {
        return Err(format!(
            "EXPORT_VERIFICATION_FAILED: Expected {}x{} at {depth}-bit, got {}x{} at {actual_depth}-bit",
            expected.0,
            expected.1,
            decoded.width(),
            decoded.height()
        ));
    }
    Ok(
        json!({"decoded":true,"width":decoded.width(),"height":decoded.height(),"bit_depth":actual_depth,
        "bytes_on_disk":fs::metadata(path).map_err(|e|e.to_string())?.len()}),
    )
}

// `image` enables AVIF encoding by default, but pixel decoding requires an
// additional system dav1d library. Validate the actual encoded container and
// report that narrower verification explicitly rather than claiming a decode.
fn verify_avif_container(bytes: &[u8], expected: (u32, u32), depth: u32) -> Result<Value> {
    #[derive(Default)]
    struct Properties {
        avif_brand: bool,
        payload: bool,
        dimensions: Vec<(u32, u32)>,
        depths: Vec<u8>,
    }
    fn visit(bytes: &[u8], level: usize, result: &mut Properties) -> Result<()> {
        if level > 8 {
            return Err("EXPORT_VERIFICATION_FAILED: AVIF box nesting is too deep".into());
        }
        let mut remaining = bytes;
        while !remaining.is_empty() {
            if remaining.len() < 8 {
                return Err("EXPORT_VERIFICATION_FAILED: Truncated AVIF box".into());
            }
            let short_size = u32::from_be_bytes(remaining[..4].try_into().unwrap()) as usize;
            let (size, header) = if short_size == 1 {
                if remaining.len() < 16 {
                    return Err("EXPORT_VERIFICATION_FAILED: Truncated AVIF extended size".into());
                }
                let size =
                    usize::try_from(u64::from_be_bytes(remaining[8..16].try_into().unwrap()))
                        .map_err(|_| "EXPORT_VERIFICATION_FAILED: AVIF box size overflow")?;
                (size, 16)
            } else if short_size == 0 {
                (remaining.len(), 8)
            } else {
                (short_size, 8)
            };
            if size < header || size > remaining.len() {
                return Err("EXPORT_VERIFICATION_FAILED: Invalid AVIF box size".into());
            }
            let data = &remaining[header..size];
            match &remaining[4..8] {
                b"ftyp" => {
                    if data.len() >= 8 {
                        result.avif_brand |= &data[..4] == b"avif"
                            || &data[..4] == b"avis"
                            || data[8..]
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .any(|brand| brand == b"avif" || brand == b"avis");
                    }
                }
                b"mdat" => result.payload |= !data.is_empty(),
                b"meta" => {
                    if data.len() < 4 {
                        return Err("EXPORT_VERIFICATION_FAILED: Truncated AVIF metadata".into());
                    }
                    visit(&data[4..], level + 1, result)?;
                }
                b"iprp" | b"ipco" => visit(data, level + 1, result)?,
                b"ispe" => {
                    if data.len() < 12 {
                        return Err("EXPORT_VERIFICATION_FAILED: Truncated AVIF dimensions".into());
                    }
                    result.dimensions.push((
                        u32::from_be_bytes(data[4..8].try_into().unwrap()),
                        u32::from_be_bytes(data[8..12].try_into().unwrap()),
                    ));
                }
                b"pixi" => {
                    if data.len() < 5 || data[4] == 0 || data.len() < 5 + data[4] as usize {
                        return Err(
                            "EXPORT_VERIFICATION_FAILED: Truncated AVIF channel depth".into()
                        );
                    }
                    result
                        .depths
                        .extend_from_slice(&data[5..5 + data[4] as usize]);
                }
                _ => {}
            }
            remaining = &remaining[size..];
        }
        Ok(())
    }
    let mut properties = Properties::default();
    visit(bytes, 0, &mut properties)?;
    if !properties.avif_brand
        || !properties.payload
        || properties.dimensions.is_empty()
        || properties
            .dimensions
            .iter()
            .any(|dimensions| *dimensions != expected)
        || properties.depths.is_empty()
        || properties.depths.iter().any(|value| *value as u32 != depth)
    {
        return Err("EXPORT_VERIFICATION_FAILED: AVIF container dimensions, pixel depth or payload do not match the requested export".into());
    }
    Ok(
        json!({"decoded":false,"container_verified":true,"width":expected.0,"height":expected.1,
        "bit_depth":depth,"bytes_on_disk":bytes.len(),"verification":"AVIF brand, image spatial extent, channel bit depth and nonempty payload; no pixel decode"}),
    )
}

fn preserve_timestamps(session: &Session, target: &Path) -> Result<()> {
    let (accessed, modified) = if let Some(capture) =
        crate::exif_processing::try_get_exif_creation_date(Path::new(&session.working_path))
    {
        let stamp = filetime::FileTime::from_unix_time(
            capture.timestamp(),
            capture.timestamp_subsec_nanos(),
        );
        (stamp, stamp)
    } else {
        // Copied working files have new creation times. Without capture EXIF,
        // preserve the original source's filesystem timestamps instead.
        let metadata = fs::metadata(&session.source_path).map_err(|e| e.to_string())?;
        (
            filetime::FileTime::from_last_access_time(&metadata),
            filetime::FileTime::from_last_modification_time(&metadata),
        )
    };
    filetime::set_file_times(target, accessed, modified)
        .map_err(|e| format!("TIMESTAMP_WRITE_FAILED: {e}"))
}

fn reject_source_destination(target: &Path, source: &Path) -> Result<()> {
    let canonical_target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    let canonical_source = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    if canonical_target == canonical_source {
        return Err(format!(
            "SOURCE_PROTECTED: Cannot export over source {}",
            source.display()
        ));
    }
    #[cfg(unix)]
    if let (Ok(target_meta), Ok(source_meta)) = (fs::metadata(target), fs::metadata(source)) {
        use std::os::unix::fs::MetadataExt;
        if target_meta.dev() == source_meta.dev() && target_meta.ino() == source_meta.ino() {
            return Err(format!(
                "SOURCE_PROTECTED: Output is a hard link to source {}",
                source.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_source_masks_follow_the_session_photo_when_editor_selection_changes() {
        let mask: MaskDefinition = serde_json::from_value(json!({
            "id": "color", "name": "Color", "visible": true, "invert": false,
            "adjustments": {},
            "subMasks": [{
                "id": "sample", "type": "color", "visible": true,
                "mode": "additive",
                "parameters": {"targetX": 1, "targetY": 1, "tolerance": 20, "grow": 0, "feather": 0}
            }]
        }))
        .unwrap();
        let session_photo = DynamicImage::ImageRgb8(image::RgbImage::from_fn(8, 4, |x, _| {
            if x < 4 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        }));
        let other_selected_photo =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(8, 4, image::Rgb([0, 255, 0])));
        let render = |source: &DynamicImage| {
            render_mcp_source_masks(
                std::slice::from_ref(&mask),
                source,
                false,
                &json!({}),
                (8, 4),
                (0.0, 0.0),
            )
            .unwrap()
            .0
            .remove(0)
        };
        assert_eq!(render(&session_photo).get_pixel(6, 1)[0], 0);
        assert!(render(&other_selected_photo).get_pixel(6, 1)[0] > 0);
    }

    fn precision_ramp() -> DynamicImage {
        DynamicImage::ImageRgb16(ImageBuffer::from_fn(1025, 2, |x, y| {
            let level = 32000 + (x + y * 1025) as u16;
            image::Rgb([level, level, level])
        }))
    }

    #[test]
    fn overlay_preview_blocks_are_matching_eight_bit_pngs_without_changing_render_precision() {
        let photograph = DynamicImage::ImageRgba16(precision_ramp().to_rgba16());
        let selection = GrayImage::from_fn(photograph.width(), photograph.height(), |x, y| {
            Luma([((x * 13 + y * 17) % 256) as u8])
        });
        let overlay = review::overlay_mask(&photograph, &selection, 0.5).unwrap();
        let frame = Frame {
            image: overlay.clone(),
            rendered_dimensions: photograph.dimensions(),
            region: Roi {
                x: 0,
                y: 0,
                width: photograph.width(),
                height: photograph.height(),
            },
            crop_offset: (0.0, 0.0),
            mask_coverage: Some(mask_coverage(&selection)),
            review_images: vec![
                ("Matched edited photograph".into(), photograph.clone()),
                (
                    "Matched grayscale selection".into(),
                    DynamicImage::ImageLuma8(selection.clone()),
                ),
            ],
            warnings: Vec::new(),
        };
        let (main, matched) = preview_blocks(&frame, "png", 90).unwrap();
        assert_eq!(matched.len(), 2);
        for (index, block) in [&main, &matched[0], &matched[1]].into_iter().enumerate() {
            let bytes = STANDARD.decode(block["data"].as_str().unwrap()).unwrap();
            assert_eq!(block["mimeType"], "image/png");
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(&bytes[12..16], b"IHDR");
            assert_eq!(bytes[24], 8, "preview block {index} PNG channel bit depth");
            assert_eq!(
                bytes[25],
                if index == 2 { 0 } else { 2 },
                "preserve grayscale PNG selection"
            );
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert_eq!(decoded.dimensions(), photograph.dimensions());
            match index {
                0 => assert_eq!(decoded.to_rgb8(), overlay.to_rgb8()),
                1 => assert_eq!(decoded.to_rgb8(), photograph.to_rgb8()),
                _ => assert_eq!(decoded.to_luma8(), selection),
            }
        }
        assert_eq!(frame.image.color(), image::ColorType::Rgb16);
        assert_eq!(frame.review_images[0].1.color(), image::ColorType::Rgba16);
        assert!(
            photograph
                .to_rgb16()
                .pixels()
                .any(|pixel| pixel[0] % 257 != 0)
        );
        let export = encode_at_depth(&photograph, "png", 16, 95).unwrap();
        assert_eq!(export[24], 16);
        assert_eq!(
            image::load_from_memory(&export).unwrap().to_rgb16(),
            photograph.to_rgb16()
        );
    }

    #[test]
    fn png_and_tiff_preserve_real_sixteen_bit_levels() {
        let original = precision_ramp();
        for format in ["png", "tiff"] {
            let bytes = encode_at_depth(&original, format, 16, 95).unwrap();
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert_eq!(decoded.to_rgb16(), original.to_rgb16());
            assert_eq!(
                decoded.color().bits_per_pixel() / decoded.color().channel_count() as u16,
                16
            );
            assert!(
                decoded
                    .to_rgb16()
                    .as_raw()
                    .iter()
                    .any(|value| value % 257 != 0)
            );
        }
    }

    #[test]
    fn explicit_eight_bit_tiff_is_not_expanded_to_sixteen_bit() {
        let bytes = encode_at_depth(&precision_ramp(), "tiff", 8, 95).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.color(), image::ColorType::Rgb8);
        assert_eq!(decoded.dimensions(), (1025, 2));
    }

    #[test]
    fn region_validation_checks_every_edge_and_preserves_native_extent() {
        let valid =
            parse_region(Some(&json!({"x":9,"y":8,"width":1,"height":2})), (10, 10)).unwrap();
        assert_eq!((valid.x, valid.y, valid.width, valid.height), (9, 8, 1, 2));
        for region in [
            json!({"x":9,"y":8,"width":2,"height":2}),
            json!({"x":0,"y":8,"width":1,"height":3}),
            json!({"x":0.5,"y":0,"width":1,"height":1}),
            json!({"x":0,"y":0,"width":0,"height":1}),
            json!({"width":1,"height":1}),
            json!({"x":4294967295u32,"y":0,"width":2,"height":1}),
        ] {
            assert!(
                parse_region(Some(&region), (10, 10)).is_err(),
                "Accepted {region}"
            );
        }
    }

    #[test]
    fn delivery_resize_keeps_precision_and_does_not_enlarge() {
        let source = precision_ramp();
        let resized = resize_long_edge(source.clone(), Some(513)).unwrap();
        assert_eq!(resized.dimensions(), (513, 1));
        assert_eq!(resized.color(), image::ColorType::Rgb16);
        assert_eq!(
            resize_long_edge(source.clone(), Some(2000))
                .unwrap()
                .dimensions(),
            source.dimensions()
        );
    }

    #[test]
    fn coverage_and_statistics_measure_actual_pixels() {
        let mask = GrayImage::from_raw(4, 1, vec![0, 0, 128, 255]).unwrap();
        let coverage = mask_coverage(&mask);
        assert_eq!(coverage["nonzero_fraction"], 0.5);
        assert!((coverage["weighted_fraction"].as_f64().unwrap() - 383.0 / 1020.0).abs() < 1e-10);
        let image = DynamicImage::ImageRgb16(
            ImageBuffer::from_raw(2, 1, vec![0, 0, 0, 65535, 65535, 65535]).unwrap(),
        );
        let stats = image_statistics(&image);
        assert_eq!(stats["clipped_black_fraction"], 0.5);
        assert_eq!(stats["clipped_white_fraction"], 0.5);
        assert_eq!(stats["mean_rgb"], json!([0.5, 0.5, 0.5]));
    }

    #[test]
    fn export_defaults_strip_gps_without_enlarging() {
        let settings = export_settings(&json!({"long_edge":1600}), 95).unwrap();
        assert!(settings.strip_gps);
        assert!(settings.keep_metadata);
        assert!(settings.resize.unwrap().dont_enlarge);
        assert!(!settings.export_masks);
        assert!(export_settings(&json!({"long_edge":1.5}), 95).is_err());
        assert!(export_settings(&json!({"strip_gps":"yes"}), 95).is_err());
    }

    #[test]
    fn verification_reopens_the_file_and_rejects_wrong_depth() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("export.tiff");
        fs::write(
            &target,
            encode_at_depth(&precision_ramp(), "tiff", 8, 95).unwrap(),
        )
        .unwrap();
        assert!(verify_raster(&target, (1025, 2), 8).is_ok());
        assert!(verify_raster(&target, (1025, 2), 16).is_err());
        assert!(verify_raster(&target, (1024, 2), 8).is_err());
    }

    #[test]
    fn sources_are_protected_even_when_they_are_export_files() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("derived.tiff");
        fs::write(&source, b"source").unwrap();
        assert!(reject_source_destination(&source, &source).is_err());
        let other = directory.path().join("new.tiff");
        assert!(reject_source_destination(&other, &source).is_ok());
        #[cfg(unix)]
        {
            let link = directory.path().join("linked.tiff");
            fs::hard_link(&source, &link).unwrap();
            assert!(reject_source_destination(&link, &source).is_err());
        }
        assert_eq!(fs::read(source).unwrap(), b"source");
    }

    #[test]
    fn avif_export_verifies_real_container_and_rejects_corruption() {
        let image =
            DynamicImage::ImageRgb8(ImageBuffer::from_pixel(17, 13, image::Rgb([127, 63, 191])));
        let bytes = encode_at_depth(&image, "avif", 8, 80).unwrap();
        let result = verify_avif_container(&bytes, (17, 13), 8).unwrap();
        assert_eq!(result["decoded"], false);
        assert_eq!(result["container_verified"], true);
        assert!(verify_avif_container(&bytes, (18, 13), 8).is_err());
        assert!(verify_avif_container(&bytes, (17, 13), 16).is_err());
        assert!(verify_avif_container(&bytes[..bytes.len() - 1], (17, 13), 8).is_err());
    }

    #[test]
    fn jpeg_webp_and_jxl_exports_reopen_with_expected_dimensions() {
        jxl_oxide::integration::register_image_decoding_hook();
        let directory = tempfile::tempdir().unwrap();
        let image =
            DynamicImage::ImageRgb8(ImageBuffer::from_pixel(17, 13, image::Rgb([127, 63, 191])));
        for format in ["jpeg", "webp", "jxl"] {
            let target = directory.path().join(format!("encoded.{format}"));
            let bytes = encode_at_depth(&image, format, 8, 90).unwrap();
            fs::write(&target, &bytes).unwrap();
            assert!(
                verify_raster(&target, (17, 13), 8).is_ok(),
                "Could not verify {format}"
            );
        }
    }

    #[test]
    fn jxl_odd_dimensions_rgb8_and_rgb16_export_as_valid_eight_bit_pixels() {
        jxl_oxide::integration::register_image_decoding_hook();
        let directory = tempfile::tempdir().unwrap();
        for (width, height) in [(240, 321), (321, 240), (241, 321)] {
            let rgb = ImageBuffer::from_fn(width, height, |x, y| {
                image::Rgb([
                    ((x * 23 + y * 17) % 256) as u8,
                    ((x * x + y * 19) % 256) as u8,
                    ((x * 11 + y * y) % 256) as u8,
                ])
            });
            let source = DynamicImage::ImageRgb8(rgb);
            let high_precision = ImageBuffer::from_fn(width, height, |x, y| {
                image::Rgb([
                    ((x * 187 + y * 293) % 65536) as u16,
                    ((x * x * 13 + y * 89) % 65536) as u16,
                    ((x * 233 + y * y * 17) % 65536) as u16,
                ])
            });
            for image in [source.clone(), DynamicImage::ImageRgb16(high_precision)] {
                let mut previous_lossy = None;
                for quality in [90, 95, 100] {
                    let target = directory.path().join("odd.jxl");
                    let encoded = encode_at_depth(&image, "jxl", 8, quality).unwrap();
                    if quality < 100
                        && let Some(previous) = previous_lossy.replace(encoded.clone())
                    {
                        assert_ne!(previous, encoded, "opaque lossy quality remains effective");
                    }
                    fs::write(&target, encoded).unwrap();
                    let result = verify_raster(&target, (width, height), 8);
                    assert!(
                        result.is_ok(),
                        "{width}x{height} {:?} quality {quality}: {result:?}",
                        image.color()
                    );
                    if quality == 100 {
                        let decoded = image::open(&target).unwrap();
                        assert_eq!(decoded.to_rgb8(), image.to_rgb8());
                    }
                }
            }
        }
    }

    #[test]
    fn jxl_odd_dimensions_preserve_actual_alpha() {
        jxl_oxide::integration::register_image_decoding_hook();
        let source = DynamicImage::ImageRgba8(ImageBuffer::from_fn(241, 321, |x, y| {
            image::Rgba([
                (x % 256) as u8,
                (y % 256) as u8,
                ((x + y) % 256) as u8,
                ((x * 17 + y * 29) % 256) as u8,
            ])
        }));
        let directory = tempfile::tempdir().unwrap();
        assert!(crate::export_processing::jxl_uses_lossless_alpha(
            &source, 95
        ));
        assert!(!crate::export_processing::jxl_uses_lossless_alpha(
            &source, 100
        ));
        assert!(!crate::export_processing::jxl_uses_lossless_alpha(
            &DynamicImage::ImageRgb8(source.to_rgb8()),
            95
        ));
        for source in [
            source.clone(),
            DynamicImage::ImageRgba16(source.to_rgba16()),
        ] {
            for quality in [95, 100] {
                let target = directory.path().join("transparent.jxl");
                fs::write(
                    &target,
                    encode_at_depth(&source, "jxl", 8, quality).unwrap(),
                )
                .unwrap();
                let result = verify_raster(&target, source.dimensions(), 8);
                assert!(
                    result.is_ok(),
                    "transparent {:?} quality {quality}: {result:?}",
                    source.color()
                );
                let decoded = image::open(&target).unwrap().to_rgba8();
                assert_eq!(
                    decoded,
                    source.to_rgba8(),
                    "transparent fallback preserves every channel losslessly"
                );
            }
        }
    }

    #[test]
    fn png_metadata_verifier_reads_native_compressed_exif_and_gps() {
        use little_exif::{
            exif_tag::ExifTag, filetype::FileExtension, metadata::Metadata, rational::uR64,
        };
        let mut bytes = encode_at_depth(&precision_ramp(), "png", 16, 95).unwrap();
        let mut metadata = Metadata::new();
        metadata.set_tag(ExifTag::Software("RapidRAW".into()));
        metadata.set_tag(ExifTag::GPSLatitude(vec![
            uR64 {
                nominator: 22,
                denominator: 1,
            },
            uR64 {
                nominator: 10,
                denominator: 1,
            },
            uR64 {
                nominator: 0,
                denominator: 1,
            },
        ]));
        metadata
            .write_to_vec(
                &mut bytes,
                FileExtension::PNG {
                    as_zTXt_chunk: true,
                },
            )
            .unwrap();
        assert_eq!(metadata_summary(&bytes, "png"), (true, true));
        let mut clean = encode_at_depth(&precision_ramp(), "png", 16, 95).unwrap();
        let mut metadata = Metadata::new();
        metadata.set_tag(ExifTag::Software("RapidRAW".into()));
        metadata
            .write_to_vec(
                &mut clean,
                FileExtension::PNG {
                    as_zTXt_chunk: true,
                },
            )
            .unwrap();
        assert_eq!(metadata_summary(&clean, "png"), (true, false));
    }

    #[test]
    fn lut_exclusions_distinguish_color_from_spatial_edits() {
        let mut recipe = validation::default_adjustments();
        recipe["exposure"] = json!(0.7);
        assert!(lut_excluded_adjustments(&recipe).is_empty());
        recipe["crop"] = json!({"x":10,"y":10,"width":100,"height":100});
        recipe["clarity"] = json!(12);
        assert_eq!(lut_excluded_adjustments(&recipe), vec!["crop", "clarity"]);
    }

    #[test]
    fn webp_metadata_declares_extended_format_without_changing_pixels() {
        use image::ImageDecoder;
        use little_exif::{exif_tag::ExifTag, filetype::FileExtension, metadata::Metadata};

        let source = DynamicImage::ImageRgb8(ImageBuffer::from_fn(127, 83, |x, y| {
            image::Rgb([x as u8, y as u8, (x + y) as u8])
        }));
        let mut bytes = encode_at_depth(&source, "webp", 8, 95).unwrap();
        let pixels = image::load_from_memory(&bytes).unwrap().to_rgb8();
        let simple = bytes.clone();
        normalize_webp_metadata_header(&mut bytes, source.dimensions(), false).unwrap();
        assert_eq!(bytes, simple, "simple files need no metadata header");
        let mut metadata = Metadata::new();
        metadata.set_tag(ExifTag::Software("RapidRAW metadata regression".into()));
        // Reproduce the native helper's old partial-write state (it ignores
        // little_exif's unsupported-simple-to-extended conversion error).
        let _ = metadata.write_to_vec(&mut bytes, FileExtension::WEBP);
        let chunks = bytes[12..].to_vec();
        assert_ne!(
            &bytes[12..16],
            b"VP8X",
            "fixture exercises the native writer defect"
        );

        normalize_webp_metadata_header(&mut bytes, source.dimensions(), false).unwrap();
        assert_eq!(&bytes[12..16], b"VP8X");
        assert_eq!(&bytes[16..20], &10u32.to_le_bytes());
        assert_eq!(bytes[20], 0x08);
        assert_eq!(&bytes[24..27], &[126, 0, 0]);
        assert_eq!(&bytes[27..30], &[82, 0, 0]);
        assert_eq!(&bytes[30..], &chunks);
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8,
            bytes.len()
        );
        let mut decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(decoder.dimensions(), source.dimensions());
        assert!(decoder.exif_metadata().unwrap().is_some());
        assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgb8(), pixels);
        assert_eq!(metadata_summary(&bytes, "webp"), (true, false));
        let normalized = bytes.clone();
        normalize_webp_metadata_header(&mut bytes, source.dimensions(), false).unwrap();
        assert_eq!(bytes, normalized, "normalization must be idempotent");
        // The production path upgrades before insertion, so the metadata writer
        // now succeeds instead of relying on its partially written error result.
        let mut clean = simple;
        normalize_webp_metadata_header(&mut clean, source.dimensions(), true).unwrap();
        metadata
            .write_to_vec(&mut clean, FileExtension::WEBP)
            .unwrap();
        normalize_webp_metadata_header(&mut clean, source.dimensions(), false).unwrap();
        assert_eq!(clean, bytes);
    }

    #[test]
    fn webp_metadata_preserves_extended_features_and_rejects_truncation() {
        fn chunk(bytes: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
            bytes.extend_from_slice(data);
            if data.len() & 1 != 0 {
                bytes.push(0);
            }
        }
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        // Preserve ICC/alpha/animation flags, existing chunks and unknown chunks.
        chunk(&mut bytes, b"VP8X", &[0x32, 0, 0, 0, 2, 0, 0, 1, 0, 0]);
        chunk(&mut bytes, b"ICCP", b"profile");
        chunk(&mut bytes, b"ANIM", &[0; 6]);
        chunk(&mut bytes, b"EXIF", b"metadata");
        chunk(&mut bytes, b"XMP ", b"xmp");
        chunk(&mut bytes, b"test", b"custom");
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        let chunks = bytes[30..].to_vec();
        normalize_webp_metadata_header(&mut bytes, (3, 2), false).unwrap();
        assert_eq!(bytes[20], 0x3e);
        assert_eq!(&bytes[24..30], &[2, 0, 0, 1, 0, 0]);
        assert_eq!(&bytes[30..], &chunks);
        let mut truncated = bytes.clone();
        truncated.pop();
        let riff_size = (truncated.len() - 8) as u32;
        truncated[4..8].copy_from_slice(&riff_size.to_le_bytes());
        assert!(normalize_webp_metadata_header(&mut truncated, (3, 2), false).is_err());
        assert!(normalize_webp_metadata_header(&mut bytes, (0, 2), false).is_err());
    }

    #[test]
    fn native_resize_modes_honor_axis_and_no_enlarge() {
        let source = DynamicImage::ImageRgb16(ImageBuffer::from_pixel(
            100,
            60,
            image::Rgb([32001, 32002, 32003]),
        ));
        for (mode, value, enlarge, expected) in [
            ("width", 80, false, (80, 48)),
            ("height", 30, false, (50, 30)),
            ("width", 200, false, (100, 60)),
            ("height", 100, false, (100, 60)),
            ("width", 200, true, (200, 120)),
            ("height", 120, true, (200, 120)),
            ("shortEdge", 30, false, (50, 30)),
            ("longEdge", 80, false, (80, 48)),
        ] {
            let settings = export_settings(
                &json!({"resize":{"mode":mode,"value":value,"dont_enlarge":!enlarge}}),
                95,
            )
            .unwrap();
            preflight_resize(source.dimensions(), &settings).unwrap();
            let result = apply_export_resize_and_watermark(source.clone(), &settings).unwrap();
            assert_eq!(result.dimensions(), expected, "{mode}/{value}/{enlarge}");
            assert_eq!(result.color(), image::ColorType::Rgb16);
        }
        let default = export_settings(&json!({"resize":{"mode":"width","value":200}}), 95).unwrap();
        assert!(default.resize.unwrap().dont_enlarge);
        assert!(
            export_settings(
                &json!({"resize":{"mode":"width","value":200},"long_edge":100}),
                95
            )
            .is_err()
        );
        assert!(export_settings(&json!({"resize":{"mode":"width","value":0}}), 95).is_err());
        let excessive = export_settings(
            &json!({"resize":{"mode":"height","value":32768,"dont_enlarge":false}}),
            95,
        )
        .unwrap();
        assert!(preflight_resize((10000, 100), &excessive).is_err());
    }

    #[test]
    fn native_export_extreme_aspect_ratio_keeps_requested_axis_and_nonzero_extent() {
        for (width, height, mode, value, expected) in [
            (25184, 256, "width", 1024, (1024, 10)),
            (256, 25184, "height", 1024, (10, 1024)),
            (4096, 1, "longEdge", 16, (16, 1)),
            (1, 4096, "longEdge", 16, (1, 16)),
        ] {
            let source = DynamicImage::ImageRgb16(ImageBuffer::from_pixel(
                width,
                height,
                image::Rgb([32001, 32002, 32003]),
            ));
            let settings =
                export_settings(&json!({"resize":{"mode":mode,"value":value}}), 95).unwrap();
            preflight_resize(source.dimensions(), &settings).unwrap();
            let result = apply_export_resize_and_watermark(source, &settings).unwrap();
            assert_eq!(result.dimensions(), expected, "{width}x{height}/{mode}");
            assert_eq!(result.color(), image::ColorType::Rgb16);
            let center = result
                .to_rgb16()
                .get_pixel(expected.0 / 2, expected.1 / 2)
                .0;
            assert_eq!(center, [32001, 32002, 32003]);
        }
    }
}
