use crate::app::state::{AppState, LoadedImage, PreviewSource};
use crate::decode::image_loader::prepare_base_image_cow;
use crate::library::sidecars::parse_virtual_path;
use crate::masks::generation::{
    MaskDefinition, build_full_warped_image_rgb8, get_cached_or_generate_masks,
};
use crate::render::cache_utils::calculate_geometry_hash;
use crate::render::geometry::{Crop, get_geometry_params_from_json, is_geometry_identity};
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::processor::RenderRequest;
use crate::render::image_processing::downscale_f32_image;
use crate::render::options::RenderOptions;
use crate::render::source::{Frame, SourceTransform};
use crate::render::uniforms::{AllAdjustments, get_all_adjustments_from_json};
use image::{DynamicImage, GenericImageView};
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

const PREVIEW_SOURCE_SUPERSAMPLE: f64 = 4.0;

const WARPED_PREVIEW_MAX_PIXELS: f64 = 50_000_000.0;

const WORKING_SCALE_STEPS_PER_OCTAVE: f64 = 2.0;

fn working_scale_step(scale: f64) -> f64 {
    if scale >= 1.0 {
        return 1.0;
    }
    let steps = (scale.log2() * WORKING_SCALE_STEPS_PER_OCTAVE).ceil();
    2f64.powf(steps / WORKING_SCALE_STEPS_PER_OCTAVE)
}

pub fn get_or_compute_stage<T>(
    cache: &Mutex<Option<(u64, Arc<T>)>>,
    key: u64,
    compute: impl FnOnce() -> Result<Arc<T>, String>,
) -> Result<Arc<T>, String> {
    let mut cache_lock = cache.lock().unwrap_or_else(|e| e.into_inner());

    if let Some((hash, img)) = cache_lock.as_ref()
        && *hash == key
    {
        return Ok(Arc::clone(img));
    }

    *cache_lock = None;
    let img = compute()?;
    *cache_lock = Some((key, Arc::clone(&img)));
    Ok(img)
}

pub fn prepare_preview_source(
    state: &tauri::State<AppState>,
    context: &GpuContext,
    loaded_image: &LoadedImage,
    adjustments: &serde_json::Value,
    preview_dim: u32,
) -> Result<PreviewSource, String> {
    let patched_key = patched_cache_key(&loaded_image.path, adjustments);

    let patched = get_or_compute_stage(&state.patched_cache, patched_key, || {
        compute_patched(loaded_image, adjustments)
    })?;

    let (full_w_px, full_h_px) = patched.dimensions();
    let base_scale = crate::ai::upscale::scale_between(&loaded_image.image, &patched) as f64;
    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0);
    let (oriented_w, oriented_h) = if orientation_steps % 2 == 1 {
        (full_h_px as f64, full_w_px as f64)
    } else {
        (full_w_px as f64, full_h_px as f64)
    };

    let canonical_crop: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();
    let crop = canonical_crop.map(|c| Crop {
        x: c.x * base_scale,
        y: c.y * base_scale,
        width: c.width * base_scale,
        height: c.height * base_scale,
    });
    let (full_w, full_h) = crop
        .as_ref()
        .and_then(|c| {
            let (x, y) = (c.x.round().max(0.0), c.y.round().max(0.0));
            let (w, h) = (c.width.round(), c.height.round());
            (w > 0.0 && h > 0.0 && x < oriented_w && y < oriented_h)
                .then(|| ((oriented_w - x).min(w), (oriented_h - y).min(h)))
        })
        .unwrap_or((oriented_w, oriented_h));

    let target_scale = (preview_dim as f64 / full_w.max(full_h)).min(1.0);
    let target_w = ((full_w_px as f64 * target_scale).round() as u32).max(1);
    let target_h = ((full_h_px as f64 * target_scale).round() as u32).max(1);

    let geometry = get_geometry_params_from_json(&loaded_image.path, adjustments);
    let warp = (!is_geometry_identity(&geometry)).then_some(geometry);
    let texture_scale =
        context.limits.max_texture_dimension_2d as f64 / full_w_px.max(full_h_px).max(1) as f64;
    let budget_scale = if warp.is_some() {
        (WARPED_PREVIEW_MAX_PIXELS / (full_w_px as f64 * full_h_px as f64).max(1.0)).sqrt()
    } else {
        1.0
    };
    let working_target_scale = working_scale_step(target_scale * PREVIEW_SOURCE_SUPERSAMPLE)
        .min(budget_scale.max(working_scale_step(target_scale)))
        .min(texture_scale);

    let working = if working_target_scale < 1.0 {
        let working_w = ((full_w_px as f64 * working_target_scale).round() as u32).max(1);
        let working_h = ((full_h_px as f64 * working_target_scale).round() as u32).max(1);

        let mut hasher = DefaultHasher::new();
        patched_key.hash(&mut hasher);
        (working_w, working_h).hash(&mut hasher);

        get_or_compute_stage(&state.working_cache, hasher.finish(), || {
            Ok(Arc::new(downscale_f32_image(
                &patched, working_w, working_h,
            )))
        })?
    } else {
        *state
            .working_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        Arc::clone(&patched)
    };
    drop(patched);

    let working_size = working.dimensions();
    let mut transform = SourceTransform {
        working_fit: (working_size.0 > target_w).then_some((target_w, target_h)),
        warp,
        effects: true,
        ..Default::default()
    };
    let working_scale = transform.working_size(working_size).0 as f64 / full_w_px.max(1) as f64;
    let max_dim = preview_dim as f64;
    transform.frame = Frame {
        crop: crop.map(|c| Crop {
            x: c.x * working_scale,
            y: c.y * working_scale,
            width: (c.width * working_scale).min(max_dim),
            height: (c.height * working_scale).min(max_dim),
        }),
        ..Frame::from_adjustments(adjustments)
    };

    let scale = if full_w > 0.0 {
        (transform.output_size(working_size).0 as f64 / full_w * base_scale) as f32
    } else {
        1.0
    };

    let mut hasher = DefaultHasher::new();
    (patched_key, working_size).hash(&mut hasher);

    Ok(PreviewSource {
        image: working,
        id: hasher.finish(),
        transform,
        scale,
        unscaled_crop_offset: canonical_crop.map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32)),
    })
}

pub fn patched_cache_key(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    crate::render::cache_utils::calculate_patch_hash(adjustments).hash(&mut hasher);
    hasher.finish()
}

pub fn cached_patched_image(
    state: &AppState,
    base_image: &DynamicImage,
    adjustments: &serde_json::Value,
) -> Option<Arc<DynamicImage>> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()?;
    if !std::ptr::eq(&*loaded_image.image, base_image) {
        return None;
    }

    let key = patched_cache_key(&loaded_image.path, adjustments);
    let cache = state
        .patched_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some((hash, image)) if *hash == key => Some(Arc::clone(image)),
        _ => None,
    }
}

pub fn compute_patched(
    loaded_image: &LoadedImage,
    adjustments: &serde_json::Value,
) -> Result<Arc<DynamicImage>, String> {
    match prepare_base_image_cow(&loaded_image.image, &loaded_image.path, adjustments)
        .map_err(|e| format!("Failed to composite AI patches: {}", e))?
    {
        Cow::Owned(img) => Ok(Arc::new(img)),
        Cow::Borrowed(_) => Ok(Arc::clone(&loaded_image.image)),
    }
}

pub fn build_ai_source_image(
    image: &DynamicImage,
    is_raw: bool,
    path: &str,
    js_adjustments: &serde_json::Value,
) -> DynamicImage {
    let source = crate::adjustments::negative_conversion::apply_negative_conversion(
        Cow::Borrowed(image),
        js_adjustments,
    );
    build_full_warped_image_rgb8(
        &source,
        crate::adjustments::negative_conversion::effective_is_raw(is_raw, js_adjustments),
        path,
        js_adjustments,
    )
}

pub fn get_cached_full_warped_image(
    state: &tauri::State<AppState>,
    js_adjustments: &serde_json::Value,
) -> Result<Arc<DynamicImage>, String> {
    get_cached_full_warped_image_for_path(state, None, js_adjustments)
}

pub fn get_cached_full_warped_image_for_path(
    state: &tauri::State<AppState>,
    path: Option<&str>,
    js_adjustments: &serde_json::Value,
) -> Result<Arc<DynamicImage>, String> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("No original image loaded")?;

    if let Some(path) = path
        && parse_virtual_path(path).0 != parse_virtual_path(&loaded_image.path).0
    {
        return Err(format!("'{}' is not the loaded image", path));
    }

    let mut hasher = DefaultHasher::new();
    loaded_image.path.hash(&mut hasher);
    calculate_geometry_hash(js_adjustments).hash(&mut hasher);
    let cache_key = hasher.finish();

    let cached = || {
        let mut cache_lock = state
            .full_warped_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match cache_lock.as_ref() {
            Some((hash, img)) if *hash == cache_key => Some(Arc::clone(img)),
            _ => {
                *cache_lock = None;
                None
            }
        }
    };

    if let Some(img) = cached() {
        return Ok(img);
    }

    let _build_guard = rayon::current_thread_index().is_none().then(|| {
        state
            .full_warped_build_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    });
    if let Some(img) = cached() {
        return Ok(img);
    }

    let warped_arc = Arc::new(build_ai_source_image(
        &loaded_image.image,
        loaded_image.is_raw,
        &loaded_image.path,
        js_adjustments,
    ));
    *state
        .full_warped_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some((cache_key, Arc::clone(&warped_arc)));

    Ok(warped_arc)
}

pub struct EditorRender {
    adjustments: AllAdjustments,
    masks: crate::masks::generation::GeneratedMasks,
    mask_cache_key: u64,
    lut: Option<Arc<crate::adjustments::lut_processing::Lut>>,
    motion_blur: crate::effects::motion_blur::MotionBlurs,
}

impl EditorRender {
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        state: &tauri::State<AppState>,
        loaded_image: &LoadedImage,
        adjustments: &serde_json::Value,
        (width, height): (u32, u32),
        scale: f32,
        unscaled_crop_offset: (f32, f32),
        render: RenderOptions,
        image_generation: usize,
    ) -> Self {
        let mask_definitions: Vec<MaskDefinition> = adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();
        let crop_offset = (
            unscaled_crop_offset.0 * scale,
            unscaled_crop_offset.1 * scale,
        );
        let masks = get_cached_or_generate_masks(
            state,
            &loaded_image.path,
            &mask_definitions,
            width,
            height,
            scale,
            crop_offset,
            adjustments,
        );
        let (full_w, full_h) = loaded_image.image.dimensions();
        Self {
            adjustments: get_all_adjustments_from_json(
                adjustments,
                loaded_image.is_raw,
                loaded_image.as_shot,
                render,
            ),
            mask_cache_key: masks.cache_key ^ image_generation as u64,
            masks,
            lut: adjustments["lutPath"]
                .as_str()
                .and_then(|p| crate::adjustments::lut_processing::get_or_load_lut(state, p).ok()),
            motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                &loaded_image.path,
                adjustments,
                (width, height),
                crop_offset,
                full_w.max(full_h) as f32 * scale,
            ),
        }
    }

    pub fn request(
        &self,
        roi: Option<crate::render::gpu::processor::Roi>,
        hsl_probe: bool,
    ) -> RenderRequest<'_> {
        RenderRequest {
            adjustments: self.adjustments,
            mask_bitmaps: &self.masks.bitmaps,
            mask_cache_key: Some(self.mask_cache_key),
            lut: self.lut.clone(),
            roi,
            hsl_probe,
            motion_blur: self.motion_blur.clone(),
        }
    }
}
