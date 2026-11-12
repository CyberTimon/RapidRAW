use crate::app_settings::AppSettings;
use crate::{AppState, PreviewTarget};
use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, GenericImageView, Rgb32FImage, Rgba32FImage};
use rayon::prelude::*;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::SystemTime;

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
    "lensCorrectionMode",
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

            let mask_from_sub_masks = if let Some(patch_data) = patch.get("patchData") {
                let color = patch_data
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let color_len = color.len();
                color_len.hash(hasher);
                color
                    .as_bytes()
                    .iter()
                    .step_by((color_len / 256).max(1))
                    .for_each(|b| b.hash(hasher));

                let mask_len = patch_data
                    .get("mask")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                mask_len.hash(hasher);

                color_len > 0 && mask_len == 0
            } else {
                let data_len = patch
                    .get("patchDataBase64")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .len();
                data_len.hash(hasher);
                true
            };

            if mask_from_sub_masks && let Some(sub_masks_val) = patch.get("subMasks") {
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
        hash_effect_keys(
            adjustments,
            &["aiDenoiseMethod", "aiDenoiseAmount", "aiDenoiseDetail"],
            hasher,
        );
        crate::ai_denoise::cache_epoch().hash(hasher);
    }
    let upscale = crate::ai_upscale::is_enabled(adjustments);
    upscale.hash(hasher);
    if upscale {
        hash_effect_keys(adjustments, &["aiUpscaleDetail"], hasher);
        crate::ai_upscale::cache_epoch().hash(hasher);
    }
}

fn hash_negative_conversion(adjustments: &serde_json::Value, hasher: &mut DefaultHasher) {
    let enabled = crate::negative_conversion::is_enabled(adjustments);
    enabled.hash(hasher);
    if enabled {
        hash_effect_keys(adjustments, crate::negative_conversion::PARAM_KEYS, hasher);
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
    hash_negative_conversion(adjustments, &mut hasher);

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

pub fn calculate_thumbnail_source_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    calculate_patch_hash(adjustments).hash(&mut hasher);
    (!crate::image_processing::is_geometry_identity(
        &crate::image_processing::get_geometry_params_from_json(path, adjustments),
    ))
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
    hash_negative_conversion(adjustments, &mut hasher);

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

    fn full_byte_size(&self) -> usize {
        match self {
            CachedImage::Full(image) => image.as_bytes().len(),
            CachedImage::Half { data, .. } => data.len() * std::mem::size_of::<f32>(),
        }
    }

    fn to_half(image: &DynamicImage) -> Option<Self> {
        let (width, height) = image.dimensions();
        let (channels, raw) = match image {
            DynamicImage::ImageRgb32F(buffer) => (3, buffer.as_raw()),
            DynamicImage::ImageRgba32F(buffer) => (4, buffer.as_raw()),
            _ => return None,
        };

        let mut data = vec![f16::ZERO; raw.len()];
        data.par_chunks_mut(HALF_CONVERSION_CHUNK)
            .zip(raw.par_chunks(HALF_CONVERSION_CHUNK))
            .for_each(|(dst, src)| dst.convert_from_f32_slice(src));

        Some(CachedImage::Half {
            width,
            height,
            channels,
            data,
        })
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

/// A path alone goes stale: tethering reuses file names and raw settings change the pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeFingerprint {
    len: u64,
    modified: Option<SystemTime>,
    settings_hash: u64,
}

impl DecodeFingerprint {
    pub fn for_file(path: &Path, settings: &AppSettings) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        let mut hasher = DefaultHasher::new();
        settings
            .raw_highlight_compression
            .map(f32::to_bits)
            .hash(&mut hasher);
        settings.linear_raw_mode.hash(&mut hasher);
        settings
            .raw_preprocessing_color_nr
            .map(f32::to_bits)
            .hash(&mut hasher);
        settings
            .raw_preprocessing_sharpening
            .map(f32::to_bits)
            .hash(&mut hasher);
        settings.apply_preprocessing_to_non_raws.hash(&mut hasher);
        settings.use_apple_raw9.hash(&mut hasher);
        Some(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            settings_hash: hasher.finish(),
        })
    }
}

struct DecodedEntry {
    path: String,
    fingerprint: DecodeFingerprint,
    image: CachedImage,
    exif: HashMap<String, String>,
}

pub struct DecodedImageCache {
    capacity: usize,
    items: Vec<DecodedEntry>,
    current: Option<String>,
}

impl DecodedImageCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            items: Vec::with_capacity(capacity),
            current: None,
        }
    }

    fn capacity(&self) -> usize {
        self.capacity.max(1)
    }

    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity;
        self.evict();
    }

    pub fn contains(&self, path: &str, fingerprint: &DecodeFingerprint) -> bool {
        self.items
            .iter()
            .any(|e| e.path == path && e.fingerprint == *fingerprint)
    }

    pub fn get(
        &mut self,
        path: &str,
        fingerprint: &DecodeFingerprint,
    ) -> Option<(Arc<DynamicImage>, HashMap<String, String>)> {
        let pos = self.items.iter().position(|e| e.path == path)?;
        let entry = self.items.remove(pos);
        if entry.fingerprint != *fingerprint {
            return None;
        }
        let image = entry.image.expand();
        let exif = entry.exif.clone();
        self.items.push(DecodedEntry {
            image: CachedImage::Full(Arc::clone(&image)),
            ..entry
        });
        Some((image, exif))
    }

    pub fn promote(&mut self, path: &str) {
        self.current = Some(path.to_string());
        if let Some(pos) = self.items.iter().position(|e| e.path == path) {
            let item = self.items.remove(pos);
            self.items.push(item);
        }
        self.evict();
    }

    pub fn has_room_for(&self, keep: &[String]) -> bool {
        let Some(estimate) = self
            .items
            .iter()
            .find(|e| self.current.as_ref() == Some(&e.path))
            .map(|e| e.image.full_byte_size())
        else {
            return false;
        };
        let (kept_count, kept_bytes) = self
            .items
            .iter()
            .filter(|e| self.current.as_ref() == Some(&e.path) || keep.contains(&e.path))
            .fold((0, 0), |(count, bytes), e| {
                (count + 1, bytes + e.image.byte_size())
            });
        kept_count < self.capacity() && kept_bytes + estimate <= *DECODED_CACHE_BUDGET_BYTES
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn insert(
        &mut self,
        path: String,
        fingerprint: DecodeFingerprint,
        image: Arc<DynamicImage>,
        exif: HashMap<String, String>,
    ) {
        if let Some(pos) = self.items.iter().position(|e| e.path == path) {
            self.items.remove(pos);
        }
        self.items.push(DecodedEntry {
            path,
            fingerprint,
            image: CachedImage::Full(image),
            exif,
        });
        self.evict();
    }

    fn oldest_evictable(&self) -> Option<usize> {
        let newest = self.items.len().checked_sub(1)?;
        self.items[..newest]
            .iter()
            .position(|e| self.current.as_ref() != Some(&e.path))
    }

    fn evict(&mut self) {
        while self.items.len() > self.capacity()
            && let Some(pos) = self.oldest_evictable()
        {
            self.items.remove(pos);
        }
        while self
            .items
            .iter()
            .map(|e| e.image.byte_size())
            .sum::<usize>()
            > *DECODED_CACHE_BUDGET_BYTES
            && let Some(pos) = self.oldest_evictable()
        {
            self.items.remove(pos);
        }
    }

    pub fn compaction_candidates(&self, keep: &[String]) -> Vec<String> {
        self.items
            .iter()
            .filter(|e| {
                matches!(e.image, CachedImage::Full(_))
                    && self.current.as_ref() != Some(&e.path)
                    && !keep.contains(&e.path)
            })
            .map(|e| e.path.clone())
            .collect()
    }

    pub fn take_for_compaction(&self, path: &str) -> Option<Arc<DynamicImage>> {
        if self.current.as_deref() == Some(path) {
            return None;
        }
        match &self.items.iter().find(|e| e.path == path)?.image {
            CachedImage::Full(image) if Arc::strong_count(image) == 1 => Some(Arc::clone(image)),
            _ => None,
        }
    }

    pub fn store_compacted(&mut self, path: &str, source: &Arc<DynamicImage>, half: HalfImage) {
        if self.current.as_deref() == Some(path) {
            return;
        }
        let Some(entry) = self.items.iter_mut().find(|e| e.path == path) else {
            return;
        };
        if let CachedImage::Full(image) = &entry.image
            && Arc::ptr_eq(image, source)
            && Arc::strong_count(image) == 2
        {
            entry.image = half.0;
        }
    }
}

pub struct HalfImage(CachedImage);

impl HalfImage {
    pub fn from_image(image: &DynamicImage) -> Option<Self> {
        CachedImage::to_half(image).map(Self)
    }
}

/// Lets concurrent callers share one decode of a file instead of each decoding it.
#[derive(Default)]
pub struct DecodeFlights {
    inflight: Mutex<HashMap<String, Arc<Flight>>>,
}

#[derive(Default)]
pub struct Flight {
    done: Mutex<bool>,
    finished: Condvar,
}

impl Flight {
    pub fn wait(&self) {
        let mut done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        while !*done {
            done = self.finished.wait(done).unwrap_or_else(|e| e.into_inner());
        }
    }
}

pub enum FlightRole<'a> {
    Leader(FlightGuard<'a>),
    Follower(Arc<Flight>),
}

/// Wakes waiters when dropped, including on error or panic.
pub struct FlightGuard<'a> {
    flights: &'a DecodeFlights,
    path: String,
    flight: Arc<Flight>,
}

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        self.flights
            .inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.path);
        *self.flight.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.flight.finished.notify_all();
    }
}

impl DecodeFlights {
    pub fn begin(&self, path: &str) -> FlightRole<'_> {
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flight) = inflight.get(path) {
            return FlightRole::Follower(Arc::clone(flight));
        }
        let flight = Arc::new(Flight::default());
        inflight.insert(path.to_string(), Arc::clone(&flight));
        FlightRole::Leader(FlightGuard {
            flights: self,
            path: path.to_string(),
            flight,
        })
    }
}

pub fn clear_preview_stage_caches(state: &AppState) {
    *state
        .patched_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state
        .cleanup_source_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state
        .working_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

pub fn clear_preview_slot(state: &AppState, target: PreviewTarget) {
    *state
        .gpu_image_cache_for(target)
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    *state
        .cached_preview_for(target)
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

#[tauri::command]
pub fn clear_image_caches(state: tauri::State<AppState>) {
    if let Ok(mut decoded_cache) = state.decoded_image_cache.lock() {
        decoded_cache.clear();
    }
    for target in PreviewTarget::ALL {
        clear_preview_slot(&state, target);
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
    if let Ok(mut uncropped_source_cache) = state.uncropped_source_cache.lock() {
        uncropped_source_cache.clear();
    }
}
