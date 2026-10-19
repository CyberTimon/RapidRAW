use crate::AppState;
use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, GenericImageView, Rgb32FImage, Rgba32FImage};
use rayon::prelude::*;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, LazyLock};

pub const GEOMETRY_KEYS: &[&str] = &[
    "transformDistortion",
    "transformVertical",
    "transformHorizontal",
    "transformRotate",
    "transformAspect",
    "transformScale",
    "transformXOffset",
    "transformYOffset",
    "lensDistortionAmount",
    "lensVignetteAmount",
    "lensTcaAmount",
    "lensDistortionParams",
    "lensMaker",
    "lensModel",
    "lensDistortionEnabled",
    "lensTcaEnabled",
    "lensVignetteEnabled",
    "guidedPerspective",
];

fn hash_ai_patches(adjustments: &serde_json::Value, hasher: &mut DefaultHasher) {
    if let Some(patches_val) = adjustments.get("aiPatches")
        && let Some(patches_arr) = patches_val.as_array()
    {
        patches_arr.len().hash(hasher);

        for patch in patches_arr {
            if let Some(id) = patch.get("id").and_then(|v| v.as_str()) {
                id.hash(hasher);
            }

            let is_visible = patch
                .get("visible")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            is_visible.hash(hasher);

            if let Some(patch_data) = patch.get("patchData") {
                let color_len = patch_data
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                color_len.hash(hasher);

                let mask_len = patch_data
                    .get("mask")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                mask_len.hash(hasher);
            } else {
                let data_len = patch
                    .get("patchDataBase64")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                data_len.hash(hasher);
            }

            if let Some(sub_masks_val) = patch.get("subMasks") {
                sub_masks_val.to_string().hash(hasher);
            }

            let invert = patch
                .get("invert")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            invert.hash(hasher);
        }
    }
}

fn hash_ai_denoise(adjustments: &serde_json::Value, hasher: &mut DefaultHasher) {
    let enabled = crate::ai_denoise::is_enabled(adjustments);
    enabled.hash(hasher);
    if enabled {
        hash_effect_keys(adjustments, &["aiDenoiseAmount", "aiDenoiseDetail"], hasher);
        crate::ai_denoise::cache_epoch().hash(hasher);
    }
}

fn hash_orientation(adjustments: &serde_json::Value, hasher: &mut DefaultHasher) {
    adjustments["orientationSteps"]
        .as_u64()
        .unwrap_or(0)
        .hash(hasher);
    adjustments["rotation"]
        .as_f64()
        .unwrap_or(0.0)
        .to_bits()
        .hash(hasher);
    adjustments["flipHorizontal"]
        .as_bool()
        .unwrap_or(false)
        .hash(hasher);
    adjustments["flipVertical"]
        .as_bool()
        .unwrap_or(false)
        .hash(hasher);
}

fn hash_effect_keys(adjustments: &serde_json::Value, keys: &[&str], hasher: &mut DefaultHasher) {
    for key in keys {
        if let Some(val) = adjustments.get(*key) {
            key.hash(hasher);
            match val.as_str() {
                Some(s) => s.hash(hasher),
                None => val.to_string().hash(hasher),
            }
        }
    }
}

pub fn calculate_patch_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    hash_ai_patches(adjustments, &mut hasher);
    hash_ai_denoise(adjustments, &mut hasher);

    let uses_generated_masks = adjustments
        .get("aiPatches")
        .and_then(|v| v.as_array())
        .is_some_and(|patches| {
            patches.iter().any(|patch| {
                patch
                    .get("patchData")
                    .and_then(|data| data.get("mask"))
                    .and_then(|mask| mask.as_str())
                    .is_none_or(|mask| mask.is_empty())
            })
        });
    uses_generated_masks.hash(&mut hasher);

    if uses_generated_masks {
        hash_orientation(adjustments, &mut hasher);

        for key in GEOMETRY_KEYS {
            if let Some(val) = adjustments.get(key) {
                key.hash(&mut hasher);
                val.to_string().hash(&mut hasher);
            }
        }
    }

    hasher.finish()
}

pub fn calculate_geometry_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_patch_hash(adjustments).hash(&mut hasher);

    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut hasher);
            val.to_string().hash(&mut hasher);
        }
    }

    hasher.finish()
}

pub fn calculate_patched_warped_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_geometry_hash(adjustments).hash(&mut hasher);
    calculate_effects_hash(adjustments).hash(&mut hasher);

    hasher.finish()
}

pub fn calculate_effects_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    let blur_enabled =
        crate::image_processing::is_effect_enabled(adjustments, "lensBlur", "lensBlurEnabled");
    blur_enabled.hash(&mut hasher);

    if blur_enabled {
        hash_effect_keys(
            adjustments,
            &[
                "lensBlurAmount",
                "lensBlurDiffusion",
                "lensBlurShape",
                "lensBlurMinDepth",
                "lensBlurMaxDepth",
                "lensBlurMinFade",
                "lensBlurMaxFade",
                "lensBlurDepthMap",
            ],
            &mut hasher,
        );
    }

    let relight_enabled =
        crate::image_processing::is_effect_enabled(adjustments, "relight", "relightEnabled");
    relight_enabled.hash(&mut hasher);

    if relight_enabled {
        hash_effect_keys(
            adjustments,
            &[
                "relightLights",
                "relightAmbient",
                "relightSoftness",
                "relightShine",
                "relightShadows",
                "relightShadowSoftness",
                "relightNormalMap",
            ],
            &mut hasher,
        );
    }

    let fog_enabled = crate::image_processing::is_effect_enabled(adjustments, "fog", "fogEnabled");
    fog_enabled.hash(&mut hasher);

    if fog_enabled {
        hash_effect_keys(
            adjustments,
            &[
                "fogAmount",
                "fogStart",
                "fogDensity",
                "fogHeight",
                "fogVariation",
                "fogGlow",
                "fogTemperature",
                "fogTint",
                "fogDepthMap",
            ],
            &mut hasher,
        );
        hash_orientation(adjustments, &mut hasher);
    }

    hasher.finish()
}

pub fn calculate_thumbnail_base_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_patched_warped_hash(adjustments).hash(&mut hasher);

    adjustments["orientationSteps"]
        .as_u64()
        .unwrap_or(0)
        .hash(&mut hasher);

    hasher.finish()
}

pub fn calculate_transform_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0);
    orientation_steps.hash(&mut hasher);

    let rotation = adjustments["rotation"].as_f64().unwrap_or(0.0);
    (rotation.to_bits()).hash(&mut hasher);

    let flip_h = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    flip_h.hash(&mut hasher);

    let flip_v = adjustments["flipVertical"].as_bool().unwrap_or(false);
    flip_v.hash(&mut hasher);

    let blur_enabled =
        crate::image_processing::is_effect_enabled(adjustments, "lensBlur", "lensBlurEnabled");
    blur_enabled.hash(&mut hasher);
    if blur_enabled {
        if let Some(val) = adjustments.get("lensBlurAmount") {
            val.to_string().hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurDiffusion") {
            val.to_string().hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurShape") {
            val.as_str().unwrap_or("").hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurMinDepth") {
            val.to_string().hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurMaxDepth") {
            val.to_string().hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurMinFade") {
            val.to_string().hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurMaxFade") {
            val.to_string().hash(&mut hasher);
        }
        if let Some(val) = adjustments.get("lensBlurDepthMap") {
            val.as_str().unwrap_or("").len().hash(&mut hasher);
        }
    }

    let relight_enabled =
        crate::image_processing::is_effect_enabled(adjustments, "relight", "relightEnabled");
    relight_enabled.hash(&mut hasher);
    if relight_enabled {
        for key in [
            "relightLights",
            "relightAmbient",
            "relightSoftness",
            "relightShine",
            "relightShadows",
            "relightShadowSoftness",
        ] {
            if let Some(val) = adjustments.get(key) {
                val.to_string().hash(&mut hasher);
            }
        }
        if let Some(val) = adjustments.get("relightNormalMap") {
            val.as_str().unwrap_or("").len().hash(&mut hasher);
        }
    }

    let fog_enabled = crate::image_processing::is_effect_enabled(adjustments, "fog", "fogEnabled");
    fog_enabled.hash(&mut hasher);
    if fog_enabled {
        for key in [
            "fogAmount",
            "fogStart",
            "fogDensity",
            "fogHeight",
            "fogVariation",
            "fogGlow",
            "fogTemperature",
            "fogTint",
        ] {
            if let Some(val) = adjustments.get(key) {
                val.to_string().hash(&mut hasher);
            }
        }
        if let Some(val) = adjustments.get("fogDepthMap") {
            val.as_str().unwrap_or("").len().hash(&mut hasher);
        }
    }

    if let Some(crop_val) = adjustments.get("crop")
        && !crop_val.is_null()
    {
        crop_val.to_string().hash(&mut hasher);
    }

    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut hasher);
            val.to_string().hash(&mut hasher);
        }
    }

    hash_ai_patches(adjustments, &mut hasher);
    hash_ai_denoise(adjustments, &mut hasher);

    hasher.finish()
}

pub fn calculate_full_job_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    adjustments.to_string().hash(&mut hasher);
    hasher.finish()
}

const HALF_CONVERSION_CHUNK: usize = 64 * 1024;

static DECODED_CACHE_BUDGET_BYTES: LazyLock<usize> = LazyLock::new(|| {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total = sys.total_memory() as usize;
    if total > 0 {
        total / 5
    } else {
        2 * 1024 * 1024 * 1024
    }
});

enum CachedImage {
    Full(Arc<DynamicImage>),
    Half {
        width: u32,
        height: u32,
        channels: usize,
        data: Vec<f16>,
    },
}

impl CachedImage {
    fn byte_size(&self) -> usize {
        match self {
            CachedImage::Full(image) => image.as_bytes().len(),
            CachedImage::Half { data, .. } => data.len() * std::mem::size_of::<f16>(),
        }
    }

    fn compact(self) -> Self {
        let CachedImage::Full(image) = self else {
            return self;
        };
        if Arc::strong_count(&image) > 1 {
            return CachedImage::Full(image);
        }

        let (width, height) = image.dimensions();
        let (channels, raw) = match image.as_ref() {
            DynamicImage::ImageRgb32F(buffer) => (3, buffer.as_raw()),
            DynamicImage::ImageRgba32F(buffer) => (4, buffer.as_raw()),
            _ => return CachedImage::Full(image),
        };

        let mut data = vec![f16::ZERO; raw.len()];
        data.par_chunks_mut(HALF_CONVERSION_CHUNK)
            .zip(raw.par_chunks(HALF_CONVERSION_CHUNK))
            .for_each(|(dst, src)| dst.convert_from_f32_slice(src));

        CachedImage::Half {
            width,
            height,
            channels,
            data,
        }
    }

    fn expand(&self) -> Arc<DynamicImage> {
        match self {
            CachedImage::Full(image) => Arc::clone(image),
            CachedImage::Half {
                width,
                height,
                channels,
                data,
            } => {
                let mut raw = vec![0.0f32; data.len()];
                raw.par_chunks_mut(HALF_CONVERSION_CHUNK)
                    .zip(data.par_chunks(HALF_CONVERSION_CHUNK))
                    .for_each(|(dst, src)| src.convert_to_f32_slice(dst));

                let image = if *channels == 4 {
                    DynamicImage::ImageRgba32F(
                        Rgba32FImage::from_raw(*width, *height, raw)
                            .expect("RGBA buffer matches image dimensions"),
                    )
                } else {
                    DynamicImage::ImageRgb32F(
                        Rgb32FImage::from_raw(*width, *height, raw)
                            .expect("RGB buffer matches image dimensions"),
                    )
                };
                Arc::new(image)
            }
        }
    }
}

pub struct DecodedImageCache {
    capacity: usize,
    items: Vec<(String, CachedImage, HashMap<String, String>)>,
}

impl DecodedImageCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            items: Vec::with_capacity(capacity),
        }
    }

    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity;
        self.evict();
    }

    pub fn contains(&self, path: &str) -> bool {
        self.items.iter().any(|(p, _, _)| p == path)
    }

    pub fn get(&mut self, path: &str) -> Option<(Arc<DynamicImage>, HashMap<String, String>)> {
        let pos = self.items.iter().position(|(p, _, _)| p == path)?;
        let (path, cached, exif) = self.items.remove(pos);
        let image = cached.expand();
        drop(cached);
        self.items
            .push((path, CachedImage::Full(Arc::clone(&image)), exif.clone()));
        Some((image, exif))
    }

    pub fn compact_except(&mut self, keep_path: &str) {
        if let Some(pos) = self.items.iter().position(|(p, _, _)| p == keep_path) {
            let item = self.items.remove(pos);
            self.items.push(item);
        }
        for item in self.items.iter_mut() {
            if item.0 != keep_path {
                let cached = std::mem::replace(&mut item.1, CachedImage::Full(Arc::default()));
                item.1 = cached.compact();
            }
        }
        self.evict();
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn insert(
        &mut self,
        path: String,
        image: Arc<DynamicImage>,
        exif: HashMap<String, String>,
    ) {
        if let Some(pos) = self.items.iter().position(|(p, _, _)| *p == path) {
            self.items.remove(pos);
        }
        self.items.push((path, CachedImage::Full(image), exif));
        self.evict();
    }

    fn evict(&mut self) {
        while self.items.len() > self.capacity.max(1) {
            self.items.remove(0);
        }
        while self.items.len() > 1
            && self
                .items
                .iter()
                .map(|(_, c, _)| c.byte_size())
                .sum::<usize>()
                > *DECODED_CACHE_BUDGET_BYTES
        {
            self.items.remove(0);
        }
    }
}

pub fn clear_preview_stage_caches(state: &AppState) {
    *state
        .patched_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state.warped_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state
        .working_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state
        .effects_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state
        .full_transformed_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

#[tauri::command]
pub fn clear_image_caches(state: tauri::State<AppState>) {
    if let Ok(mut decoded_cache) = state.decoded_image_cache.lock() {
        decoded_cache.clear();
    }
    if let Ok(mut gpu_cache) = state.gpu_image_cache.lock() {
        *gpu_cache = None;
    }
    if let Ok(mut preview_cache) = state.cached_preview.lock() {
        *preview_cache = None;
    }
    if let Ok(mut warped_cache) = state.full_warped_cache.lock() {
        *warped_cache = None;
    }
    clear_preview_stage_caches(&state);
}

#[tauri::command]
pub fn clear_session_caches(state: tauri::State<AppState>) {
    if let Ok(mut patch_cache) = state.patch_cache.lock() {
        patch_cache.clear();
    }
    if let Ok(mut mask_cache) = state.mask_cache.lock() {
        mask_cache.clear();
    }
    if let Ok(mut geometry_cache) = state.geometry_cache.lock() {
        geometry_cache.clear();
    }
}
