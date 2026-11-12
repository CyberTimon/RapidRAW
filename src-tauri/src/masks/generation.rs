use image::{DynamicImage, GenericImageView, GrayImage, Luma};
use rayon::prelude::*;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tauri::ipc::Response;

use crate::app::state::AppState;
use crate::masks::ai::{
    generate_ai_depth_bitmap, generate_ai_foreground_bitmap, generate_ai_sky_bitmap,
    generate_ai_subject_bitmap,
};
use crate::masks::match_brush::generate_match_brush_bitmap;
use crate::masks::parametric::{generate_color_bitmap, generate_luminance_bitmap};
use crate::masks::shapes::{
    generate_brush_bitmap, generate_flow_bitmap, generate_linear_bitmap, generate_radial_bitmap,
};
use crate::render::geometry::apply_geometry_warp;
use crate::render::image_processing::apply_cpu_default_raw_processing;
use crate::render::preview::{get_cached_full_warped_image, get_cached_full_warped_image_for_path};

const MASK_CACHE_LIMIT_BYTES: usize = 128 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub enum SubMaskMode {
    Additive,
    Subtractive,
    Intersect,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct SubMask {
    pub id: String,
    #[serde(rename = "type")]
    pub mask_type: String,
    pub visible: bool,
    #[serde(default)]
    pub invert: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub mode: SubMaskMode,
    pub parameters: Value,
}

fn default_opacity() -> f32 {
    100.0
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct MaskDefinition {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub invert: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub adjustments: Value,
    pub sub_masks: Vec<SubMask>,
}

impl MaskDefinition {
    pub fn requires_warped_image(&self) -> bool {
        self.sub_masks
            .iter()
            .any(|sm| matches!(sm.mask_type.as_str(), "color" | "luminance" | "match-brush"))
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct PatchData {
    pub color: String,
    pub mask: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
#[serde(rename_all = "camelCase")]
pub struct AiPatchDefinition {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub invert: bool,
    pub prompt: String,
    #[serde(default)]
    pub patch_data: Option<PatchData>,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub sub_masks: Vec<SubMask>,
}

fn generate_all_bitmap(width: u32, height: u32) -> GrayImage {
    GrayImage::from_pixel(width, height, Luma([255]))
}

fn generate_sub_mask_bitmap(
    sub_mask: &SubMask,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    if !sub_mask.visible {
        return None;
    }

    match sub_mask.mask_type.as_str() {
        "radial" => Some(generate_radial_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "linear" => Some(generate_linear_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "brush" | "clone" | "heal" | "liquify" | "retouch" => Some(generate_brush_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "flow" => Some(generate_flow_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "color" => generate_color_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "luminance" => generate_luminance_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "match-brush" => generate_match_brush_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "ai-subject" => {
            generate_ai_subject_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-foreground" => {
            generate_ai_foreground_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-sky" | "ai-text" | "ai-face" => {
            generate_ai_sky_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-depth" => {
            generate_ai_depth_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "quick-eraser" => {
            generate_ai_subject_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "all" => Some(generate_all_bitmap(width, height)),
        _ => None,
    }
}

pub fn generate_mask_bitmap(
    mask_def: &MaskDefinition,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    if !mask_def.visible || mask_def.sub_masks.is_empty() {
        return None;
    }

    let mut final_mask = GrayImage::new(width, height);

    for sub_mask in &mask_def.sub_masks {
        if let Some(mut sub_bitmap) =
            generate_sub_mask_bitmap(sub_mask, width, height, scale, crop_offset, warped_image)
        {
            let invert = sub_mask.invert;
            let opacity_multiplier = (sub_mask.opacity / 100.0).clamp(0.0, 1.0);
            let mode = sub_mask.mode;

            final_mask
                .par_iter_mut()
                .zip(sub_bitmap.par_iter_mut())
                .for_each(|(pixel, sub_pixel)| {
                    if invert {
                        *sub_pixel = 255 - *sub_pixel;
                    }
                    if opacity_multiplier < 1.0 {
                        *sub_pixel = (*sub_pixel as f32 * opacity_multiplier) as u8;
                    }
                    *pixel = match mode {
                        SubMaskMode::Additive => (*pixel).max(*sub_pixel),
                        SubMaskMode::Subtractive => pixel.saturating_sub(*sub_pixel),
                        SubMaskMode::Intersect => (*pixel).min(*sub_pixel),
                    };
                });
        }
    }

    let invert = mask_def.invert;
    let opacity_multiplier = (mask_def.opacity / 100.0).clamp(0.0, 1.0);
    if invert || opacity_multiplier < 1.0 {
        final_mask.par_iter_mut().for_each(|pixel| {
            if invert {
                *pixel = 255 - *pixel;
            }
            if opacity_multiplier < 1.0 {
                *pixel = (*pixel as f32 * opacity_multiplier) as u8;
            }
        });
    }

    Some(final_mask)
}

#[tauri::command(async)]
pub fn generate_mask_overlay(
    mut mask_def: serde_json::Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    mut js_adjustments: Option<serde_json::Value>,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    if let Some(ref mut adj) = js_adjustments {
        crate::render::adjustment_utils::hydrate_adjustments(&state, adj);
    }

    if let Some(sub_masks) = mask_def.get_mut("subMasks").and_then(|v| v.as_array_mut()) {
        let mut cache = state.patch_cache.lock().unwrap_or_else(|e| e.into_inner());
        crate::render::adjustment_utils::hydrate_sub_masks(sub_masks, &mut cache);
    }

    let parsed_mask_def: MaskDefinition = serde_json::from_value(mask_def)
        .map_err(|e| format!("Failed to parse hydrated mask_def: {}", e))?;

    let scaled_crop_offset = (crop_offset.0 * scale, crop_offset.1 * scale);

    let warped_image = js_adjustments.as_ref().and_then(|adj| {
        resolve_warped_image_for_masks(&state, adj, std::slice::from_ref(&parsed_mask_def))
    });

    if let Some(gray_mask) = generate_mask_bitmap(
        &parsed_mask_def,
        width,
        height,
        scale,
        scaled_crop_offset,
        warped_image.as_deref(),
    ) {
        let palette = [255u8, 0, 0].repeat(256);
        let transparency: Vec<u8> = (0..=255u8).map(|i| (i as f32 * 0.5) as u8).collect();

        let mut buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, width, height);
            encoder.set_color(png::ColorType::Indexed);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_palette(palette);
            encoder.set_trns(transparency);
            encoder.set_compression(png::Compression::Fast);
            encoder.set_filter(png::Filter::Adaptive);
            let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
            writer
                .write_image_data(gray_mask.as_raw())
                .map_err(|e| e.to_string())?;
            writer.finish().map_err(|e| e.to_string())?;
        }

        Ok(Response::new(buf))
    } else {
        Ok(Response::new(Vec::new()))
    }
}

pub fn resolve_warped_image_for_masks(
    state: &tauri::State<AppState>,
    adjustments: &serde_json::Value,
    masks: &[MaskDefinition],
) -> Option<Arc<DynamicImage>> {
    if masks.iter().any(|m| m.requires_warped_image()) {
        get_cached_full_warped_image(state, adjustments).ok()
    } else {
        None
    }
}

fn build_full_source_image(base_image: &DynamicImage, is_raw: bool) -> Cow<'_, DynamicImage> {
    let mut image = Cow::Borrowed(base_image);
    if is_raw {
        apply_cpu_default_raw_processing(image.to_mut());
    }
    image
}

pub fn build_converted_source_image<'a>(
    base_image: &'a DynamicImage,
    is_raw: bool,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let mut image = crate::adjustments::negative_conversion::apply_negative_conversion(
        Cow::Borrowed(base_image),
        adjustments,
    );
    if crate::adjustments::negative_conversion::effective_is_raw(is_raw, adjustments) {
        apply_cpu_default_raw_processing(image.to_mut());
    }
    image
}

pub fn build_full_warped_image<'a>(
    base_image: &'a DynamicImage,
    is_raw: bool,
    path: &str,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    apply_geometry_warp(
        build_full_source_image(base_image, is_raw),
        path,
        adjustments,
    )
}

pub fn build_full_warped_image_rgb8(
    base_image: &DynamicImage,
    is_raw: bool,
    path: &str,
    adjustments: &serde_json::Value,
) -> DynamicImage {
    let warped = build_full_warped_image(base_image, is_raw, path, adjustments);
    let rgb8 = match warped.as_rgb32f() {
        Some(buffer) => {
            let data: Vec<u8> = buffer
                .as_raw()
                .par_iter()
                .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect();
            image::RgbImage::from_raw(buffer.width(), buffer.height(), data)
                .expect("RGB8 buffer matches image dimensions")
        }
        None => warped.to_rgb8(),
    };
    DynamicImage::ImageRgb8(rgb8)
}

pub fn build_warped_image_for_masks<'a>(
    base_image: &'a DynamicImage,
    base_scale: f32,
    is_raw: bool,
    path: &str,
    adjustments: &serde_json::Value,
    masks: &[MaskDefinition],
) -> Option<Cow<'a, DynamicImage>> {
    if masks.iter().any(|m| m.requires_warped_image()) {
        let canonical = (base_scale != 1.0).then(|| {
            let (w, h) = base_image.dimensions();
            crate::render::image_processing::downscale_f32_image(
                base_image,
                (w as f32 / base_scale).round() as u32,
                (h as f32 / base_scale).round() as u32,
            )
        });
        Some(Cow::Owned(build_full_warped_image_rgb8(
            canonical.as_ref().unwrap_or(base_image),
            crate::adjustments::negative_conversion::effective_is_raw(is_raw, adjustments),
            path,
            adjustments,
        )))
    } else {
        None
    }
}

pub struct GeneratedMasks {
    pub bitmaps: Vec<GrayImage>,
    pub cache_key: u64,
}

#[allow(clippy::too_many_arguments)]
pub fn get_cached_or_generate_masks(
    state: &tauri::State<AppState>,
    path: &str,
    definitions: &[MaskDefinition],
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    adjustments: &serde_json::Value,
) -> GeneratedMasks {
    let mut combined_hasher = DefaultHasher::new();
    let mut bitmaps = Vec::with_capacity(definitions.len());

    for def in definitions {
        let mut hasher = DefaultHasher::new();
        let def_json = serde_json::to_string(&(
            &def.id,
            &def.name,
            def.visible,
            def.invert,
            def.opacity,
            &def.sub_masks,
        ))
        .unwrap_or_default();
        def_json.hash(&mut hasher);
        path.hash(&mut hasher);
        if def.requires_warped_image() {
            crate::render::cache_utils::calculate_geometry_hash(adjustments).hash(&mut hasher);
        }
        width.hash(&mut hasher);
        height.hash(&mut hasher);
        scale.to_bits().hash(&mut hasher);
        crop_offset.0.to_bits().hash(&mut hasher);
        crop_offset.1.to_bits().hash(&mut hasher);
        let key = hasher.finish();

        let cached = state
            .mask_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned();

        let bitmap = cached.or_else(|| {
            let warped_image = def
                .requires_warped_image()
                .then(|| get_cached_full_warped_image_for_path(state, Some(path), adjustments).ok())
                .flatten();
            let generated = generate_mask_bitmap(
                def,
                width,
                height,
                scale,
                crop_offset,
                warped_image.as_deref(),
            )?;

            let mut cache = state.mask_cache.lock().unwrap_or_else(|e| e.into_inner());
            let cached_bytes: usize = cache.values().map(|m| m.as_raw().len()).sum();
            if cache.len() > 50 || cached_bytes > MASK_CACHE_LIMIT_BYTES {
                cache.clear();
            }
            cache.insert(key, generated.clone());
            Some(generated)
        });

        (key, bitmap.is_some()).hash(&mut combined_hasher);
        bitmaps.extend(bitmap);
    }

    GeneratedMasks {
        bitmaps,
        cache_key: combined_hasher.finish(),
    }
}
