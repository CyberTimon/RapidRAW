use crate::AppState;
use half::f16;
use image::{DynamicImage, GenericImageView, Rgb32FImage, Rgba32FImage};
use rayon::prelude::*;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

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
];

pub fn calculate_thumbnail_base_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_geometry_hash(adjustments).hash(&mut hasher);

    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get("effects"))
        .and_then(|s| s.as_bool())
        .unwrap_or(true);

    let blur_enabled = effects_visible && adjustments["lensBlurEnabled"].as_bool().unwrap_or(false);
    blur_enabled.hash(&mut hasher);

    if blur_enabled {
        let blur_keys = [
            "lensBlurAmount",
            "lensBlurDiffusion",
            "lensBlurShape",
            "lensBlurMinDepth",
            "lensBlurMaxDepth",
            "lensBlurMinFade",
            "lensBlurMaxFade",
            "lensBlurDepthMap",
        ];

        for key in blur_keys {
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

    if let Some(patches) = adjustments.get("aiPatches") {
        patches.to_string().hash(&mut hasher);
    }

    adjustments["orientationSteps"].as_u64().hash(&mut hasher);

    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut hasher);
            val.to_string().hash(&mut hasher);
        }
    }

    hasher.finish()
}

pub fn calculate_visual_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);

    if let Some(obj) = adjustments.as_object() {
        for (key, value) in obj {
            if GEOMETRY_KEYS.contains(&key.as_str()) {
                continue;
            }

            match key.as_str() {
                "crop" | "rotation" | "orientationSteps" | "flipHorizontal" | "flipVertical" => (),
                _ => {
                    key.hash(&mut hasher);
                    value.to_string().hash(&mut hasher);
                }
            }
        }
    }

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

    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get("effects"))
        .and_then(|s| s.as_bool())
        .unwrap_or(true);

    let blur_enabled = effects_visible && adjustments["lensBlurEnabled"].as_bool().unwrap_or(false);
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

    if let Some(patches_val) = adjustments.get("aiPatches")
        && let Some(patches_arr) = patches_val.as_array()
    {
        patches_arr.len().hash(&mut hasher);

        for patch in patches_arr {
            if let Some(id) = patch.get("id").and_then(|v| v.as_str()) {
                id.hash(&mut hasher);
            }

            let is_visible = patch
                .get("visible")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            is_visible.hash(&mut hasher);

            if let Some(patch_data) = patch.get("patchData") {
                let color_len = patch_data
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                color_len.hash(&mut hasher);

                let mask_len = patch_data
                    .get("mask")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                mask_len.hash(&mut hasher);
            } else {
                let data_len = patch
                    .get("patchDataBase64")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                data_len.hash(&mut hasher);
            }

            if let Some(sub_masks_val) = patch.get("subMasks") {
                sub_masks_val.to_string().hash(&mut hasher);
            }

            let invert = patch
                .get("invert")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            invert.hash(&mut hasher);
        }
    }

    hasher.finish()
}

pub fn calculate_full_job_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    adjustments.to_string().hash(&mut hasher);
    hasher.finish()
}

/// Upper bound in bytes for the decoded-image cache, derived from physical RAM.
///
/// Eviction previously ran on item count alone, so a handful of large RAWs
/// (a 60-megapixel image is ~700 MB once decoded to f32) could pin several
/// gigabytes and push lower-RAM machines into swap. An eighth of physical RAM,
/// clamped to [256 MB, 4 GB], bounds that without shrinking the cache on
/// machines that have memory to spare.
fn default_byte_budget() -> usize {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let budget = (sys.total_memory() / 8).clamp(256 * 1024 * 1024, 4 * 1024 * 1024 * 1024);
    usize::try_from(budget).unwrap_or(usize::MAX)
}

/// Cached pixels are stored at half precision: a cached original is only read
/// back when the user returns to a recently viewed photo, and the GPU pipeline
/// already samples it through Rgba16Float textures, so keeping the cache at
/// f32 doubles its footprint without changing what gets rendered. Images that
/// are not f32 (already compact) are kept as-is.
enum CachedPixels {
    RgbF16(Vec<f16>),
    RgbaF16(Vec<f16>),
    Original(Arc<DynamicImage>),
}

struct CachedImage {
    width: u32,
    height: u32,
    pixels: CachedPixels,
    byte_size: usize,
}

impl CachedImage {
    fn new(image: &Arc<DynamicImage>) -> Self {
        let (width, height) = image.dimensions();
        match image.as_ref() {
            DynamicImage::ImageRgb32F(buffer) => {
                let data: Vec<f16> = buffer
                    .as_raw()
                    .par_iter()
                    .map(|v| f16::from_f32(*v))
                    .collect();
                let byte_size = data.len() * size_of::<f16>();
                Self {
                    width,
                    height,
                    pixels: CachedPixels::RgbF16(data),
                    byte_size,
                }
            }
            DynamicImage::ImageRgba32F(buffer) => {
                let data: Vec<f16> = buffer
                    .as_raw()
                    .par_iter()
                    .map(|v| f16::from_f32(*v))
                    .collect();
                let byte_size = data.len() * size_of::<f16>();
                Self {
                    width,
                    height,
                    pixels: CachedPixels::RgbaF16(data),
                    byte_size,
                }
            }
            _ => {
                let byte_size = image.as_bytes().len();
                Self {
                    width,
                    height,
                    pixels: CachedPixels::Original(image.clone()),
                    byte_size,
                }
            }
        }
    }

    fn to_image(&self) -> Arc<DynamicImage> {
        match &self.pixels {
            CachedPixels::RgbF16(data) => {
                let raw: Vec<f32> = data.par_iter().map(|v| v.to_f32()).collect();
                let buffer = Rgb32FImage::from_raw(self.width, self.height, raw)
                    .expect("cached pixel count matches cached dimensions");
                Arc::new(DynamicImage::ImageRgb32F(buffer))
            }
            CachedPixels::RgbaF16(data) => {
                let raw: Vec<f32> = data.par_iter().map(|v| v.to_f32()).collect();
                let buffer = Rgba32FImage::from_raw(self.width, self.height, raw)
                    .expect("cached pixel count matches cached dimensions");
                Arc::new(DynamicImage::ImageRgba32F(buffer))
            }
            CachedPixels::Original(image) => image.clone(),
        }
    }
}

pub struct DecodedImageCache {
    capacity: usize,
    byte_budget: usize,
    total_bytes: usize,
    items: Vec<(String, CachedImage, HashMap<String, String>)>,
}

impl DecodedImageCache {
    pub fn new(capacity: usize) -> Self {
        Self::with_byte_budget(capacity, default_byte_budget())
    }

    fn with_byte_budget(capacity: usize, byte_budget: usize) -> Self {
        Self {
            capacity,
            byte_budget,
            total_bytes: 0,
            items: Vec::with_capacity(capacity),
        }
    }

    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity;
        self.evict_to_limits();
    }

    pub fn contains(&self, path: &str) -> bool {
        self.items.iter().any(|(p, _, _)| p == path)
    }

    pub fn get(&mut self, path: &str) -> Option<(Arc<DynamicImage>, HashMap<String, String>)> {
        let pos = self.items.iter().position(|(p, _, _)| p == path)?;
        let item = self.items.remove(pos);
        let result = (item.1.to_image(), item.2.clone());
        self.items.push(item);
        Some(result)
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.total_bytes = 0;
    }

    pub fn insert(
        &mut self,
        path: String,
        image: Arc<DynamicImage>,
        exif: HashMap<String, String>,
    ) {
        if let Some(pos) = self.items.iter().position(|(p, _, _)| *p == path) {
            let (_, removed, _) = self.items.remove(pos);
            self.total_bytes -= removed.byte_size;
        }
        if self.capacity == 0 {
            return;
        }

        let cached = CachedImage::new(&image);
        if cached.byte_size > self.byte_budget {
            log::debug!(
                "Not caching '{}': {} MB exceeds the {} MB decoded-image cache budget",
                path,
                cached.byte_size / (1024 * 1024),
                self.byte_budget / (1024 * 1024)
            );
            return;
        }

        self.total_bytes += cached.byte_size;
        self.items.push((path, cached, exif));
        self.evict_to_limits();
    }

    fn evict_to_limits(&mut self) {
        while self.items.len() > self.capacity
            || (self.total_bytes > self.byte_budget && !self.items.is_empty())
        {
            let (_, removed, _) = self.items.remove(0);
            self.total_bytes -= removed.byte_size;
        }
    }
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
    if let Ok(mut transformed_cache) = state.full_transformed_cache.lock() {
        *transformed_cache = None;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn rgb_f32_image(width: u32, height: u32) -> Arc<DynamicImage> {
        let buffer = Rgb32FImage::from_fn(width, height, |x, y| {
            let base = (x + y * width) as f32;
            Rgb([base * 0.001, base * 0.0005 + 0.25, 4.0 + base * 0.01])
        });
        Arc::new(DynamicImage::ImageRgb32F(buffer))
    }

    fn f16_bytes(width: u32, height: u32) -> usize {
        (width * height * 3) as usize * size_of::<f16>()
    }

    #[test]
    fn count_eviction_is_least_recently_used() {
        let mut cache = DecodedImageCache::with_byte_budget(2, usize::MAX);
        cache.insert("a".into(), rgb_f32_image(8, 8), HashMap::new());
        cache.insert("b".into(), rgb_f32_image(8, 8), HashMap::new());
        assert!(cache.get("a").is_some());
        cache.insert("c".into(), rgb_f32_image(8, 8), HashMap::new());
        assert!(cache.contains("a"));
        assert!(!cache.contains("b"));
        assert!(cache.contains("c"));
    }

    #[test]
    fn byte_budget_evicts_oldest_entries() {
        let budget = f16_bytes(64, 64) * 2 + 16;
        let mut cache = DecodedImageCache::with_byte_budget(10, budget);
        cache.insert("a".into(), rgb_f32_image(64, 64), HashMap::new());
        cache.insert("b".into(), rgb_f32_image(64, 64), HashMap::new());
        cache.insert("c".into(), rgb_f32_image(64, 64), HashMap::new());
        assert!(!cache.contains("a"));
        assert!(cache.contains("b"));
        assert!(cache.contains("c"));
        assert!(cache.total_bytes <= budget);
    }

    #[test]
    fn oversized_image_is_not_cached() {
        let budget = f16_bytes(64, 64) - 1;
        let mut cache = DecodedImageCache::with_byte_budget(10, budget);
        cache.insert("big".into(), rgb_f32_image(64, 64), HashMap::new());
        assert!(!cache.contains("big"));
        assert_eq!(cache.total_bytes, 0);
    }

    #[test]
    fn f16_roundtrip_stays_within_half_precision() {
        let mut cache = DecodedImageCache::with_byte_budget(2, usize::MAX);
        let original = rgb_f32_image(32, 32);
        cache.insert("img".into(), original.clone(), HashMap::new());
        let (restored, _) = cache.get("img").unwrap();

        let original_buffer = original.to_rgb32f();
        let restored_buffer = restored.to_rgb32f();
        for (a, b) in original_buffer.iter().zip(restored_buffer.iter()) {
            let tolerance = a.abs() * 1e-3 + 1e-6;
            assert!((a - b).abs() <= tolerance, "{a} vs {b}");
        }
    }

    #[test]
    fn non_f32_images_are_stored_unconverted() {
        let mut cache = DecodedImageCache::with_byte_budget(2, usize::MAX);
        let rgb8 = Arc::new(DynamicImage::new_rgb8(16, 16));
        cache.insert("u8".into(), rgb8.clone(), HashMap::new());
        let (restored, _) = cache.get("u8").unwrap();
        assert!(Arc::ptr_eq(&rgb8, &restored));
    }
}
