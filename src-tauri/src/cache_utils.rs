use crate::AppState;
use crate::app_state::PreviewAssetCacheUsage;
use image::DynamicImage;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// The physical file backing an editor path. Virtual copies share this revision,
/// while their sidecars and adjustment histories remain separate.
/// A rewrite that preserves every available file identity and timestamp needs
/// explicit invalidation; this deliberately avoids hashing a RAW on navigation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceRevision {
    canonical_path: PathBuf,
    file_size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    unix_identity: (u64, u64, i64, i64),
}

impl SourceRevision {
    pub fn read(path: &Path) -> Result<Self, String> {
        let canonical_path = fs::canonicalize(path)
            .map_err(|error| format!("Cannot resolve image source {}: {error}", path.display()))?;
        let metadata = fs::metadata(&canonical_path)
            .map_err(|error| format!("Cannot read image source {}: {error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("Image source is not a file: {}", path.display()));
        }

        #[cfg(unix)]
        let unix_identity = {
            use std::os::unix::fs::MetadataExt;
            (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        };

        Ok(Self {
            canonical_path,
            file_size: metadata.len(),
            modified: metadata.modified().map_err(|error| {
                format!(
                    "Cannot read image source timestamp {}: {error}",
                    path.display()
                )
            })?,
            #[cfg(unix)]
            unix_identity,
        })
    }

    pub fn token(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            hasher.update(self.canonical_path.as_os_str().as_bytes());
        }
        #[cfg(not(unix))]
        hasher.update(self.canonical_path.to_string_lossy().as_bytes());
        hasher.update(&self.file_size.to_le_bytes());
        match self.modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => {
                hasher.update(&[1]);
                hasher.update(&duration.as_secs().to_le_bytes());
                hasher.update(&duration.subsec_nanos().to_le_bytes());
            }
            Err(error) => {
                let duration = error.duration();
                hasher.update(&[0]);
                hasher.update(&duration.as_secs().to_le_bytes());
                hasher.update(&duration.subsec_nanos().to_le_bytes());
            }
        }
        #[cfg(unix)]
        {
            let (device, inode, changed_seconds, changed_nanos) = self.unix_identity;
            hasher.update(&device.to_le_bytes());
            hasher.update(&inode.to_le_bytes());
            hasher.update(&changed_seconds.to_le_bytes());
            hasher.update(&changed_nanos.to_le_bytes());
        }
        hasher.finalize().to_hex().to_string()
    }
}

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

pub fn calculate_geometry_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    if let Some(patches) = adjustments.get("aiPatches") {
        patches.to_string().hash(&mut hasher);
    }

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

pub fn calculate_thumbnail_base_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_patched_warped_hash(adjustments).hash(&mut hasher);

    adjustments["orientationSteps"]
        .as_u64()
        .unwrap_or(0)
        .hash(&mut hasher);

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

    // Share the complete patch/blur/warp fingerprint with the upstream cache.
    // Equal-length encoded maps or patch replacements can contain different pixels.
    calculate_patched_warped_hash(adjustments).hash(&mut hasher);
    if let Some(crop) = adjustments.get("crop") {
        crop.to_string().hash(&mut hasher);
    }

    hasher.finish()
}

pub fn calculate_full_job_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    adjustments.to_string().hash(&mut hasher);
    hasher.finish()
}

/// LRU storage bounded by retained pixel bytes as well as entry count.
pub struct MaskBitmapCache<K> {
    entries: std::collections::VecDeque<(K, Arc<image::GrayImage>)>,
    bytes: usize,
    max_bytes: usize,
}

impl<K: PartialEq> MaskBitmapCache<K> {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            entries: Default::default(),
            bytes: 0,
            max_bytes,
        }
    }

    pub fn get(&mut self, key: &K) -> Option<Arc<image::GrayImage>> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        let entry = self.entries.remove(index)?;
        let image = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(image)
    }

    pub fn insert(&mut self, key: K, image: Arc<image::GrayImage>) {
        if let Some(index) = self.entries.iter().position(|(k, _)| k == &key) {
            let (_, old) = self.entries.remove(index).unwrap();
            self.bytes -= old.as_raw().len();
        }
        let bytes = image.as_raw().len();
        if bytes > self.max_bytes {
            return;
        }
        while self.entries.len() >= 32 || self.bytes + bytes > self.max_bytes {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.as_raw().len();
        }
        self.bytes += bytes;
        self.entries.push_back((key, image));
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}

const DEFAULT_DECODED_CACHE_BYTES: usize = 512 * 1024 * 1024;

struct DecodedImageEntry {
    revision: SourceRevision,
    image: Arc<DynamicImage>,
    exif: HashMap<String, String>,
    exif_bytes: usize,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedCacheUsage {
    pub retained_bytes: usize,
    pub budget_bytes: usize,
    pub entries: usize,
    pub max_entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub invalidations: u64,
    /// Pixel bytes already included in retained_bytes and held by the active image.
    pub active_shared_pixel_bytes: usize,
    /// Pixel bytes held by the active image after the cache skips or evicts it.
    pub active_uncached_pixel_bytes: usize,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheUsage {
    pub generation_before: usize,
    pub generation_after: usize,
    pub decoded: DecodedCacheUsage,
    pub transported_assets: PreviewAssetCacheUsage,
}

/// Sample each cache without taking the long-lived preview session gate.
/// A source switch during sampling is visible through the generation pair.
pub fn collect_preview_cache_usage(state: &AppState) -> PreviewCacheUsage {
    let generation_before = state
        .load_image_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let active = state
        .original_image
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|loaded| Arc::clone(&loaded.image));
    let decoded = state
        .decoded_image_cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .usage(active.as_ref());
    let transported_assets = state
        .patch_cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .usage();
    let generation_after = state
        .load_image_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    PreviewCacheUsage {
        generation_before,
        generation_after,
        decoded,
        transported_assets,
    }
}

#[tauri::command]
pub fn get_preview_cache_usage(state: tauri::State<'_, AppState>) -> PreviewCacheUsage {
    collect_preview_cache_usage(&state)
}

fn decoded_cache_trace_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("RAPIDRAW_PREVIEW_CACHE_TRACE")
            .is_ok_and(|value| matches!(value.as_str(), "1" | "true"))
    })
}

/// Only retained decoded sources count toward this limit. The selected image
/// and in-flight readers own their Arc independently when an entry is evicted.
pub struct DecodedImageCache {
    capacity: usize,
    max_bytes: usize,
    bytes: usize,
    items: Vec<DecodedImageEntry>,
    hits: u64,
    misses: u64,
    evictions: u64,
    invalidations: u64,
}

impl DecodedImageCache {
    pub fn new(capacity: usize) -> Self {
        Self::with_budget(capacity, DEFAULT_DECODED_CACHE_BYTES)
    }

    pub fn with_budget(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            bytes: 0,
            items: Vec::with_capacity(capacity),
            hits: 0,
            misses: 0,
            evictions: 0,
            invalidations: 0,
        }
    }

    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity;
        self.evict_to_budget();
    }

    pub fn get(
        &mut self,
        revision: &SourceRevision,
    ) -> Option<(Arc<DynamicImage>, HashMap<String, String>)> {
        let Some(pos) = self
            .items
            .iter()
            .position(|entry| entry.revision.canonical_path == revision.canonical_path)
        else {
            self.misses += 1;
            return None;
        };
        let entry = self.items.remove(pos);
        if entry.revision != *revision {
            self.misses += 1;
            self.invalidations += 1;
            self.refresh_bytes();
            self.trace("invalidate");
            return None;
        }
        self.hits += 1;
        let result = (Arc::clone(&entry.image), entry.exif.clone());
        self.items.push(entry);
        Some(result)
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.bytes = 0;
    }

    pub fn insert(
        &mut self,
        revision: SourceRevision,
        image: Arc<DynamicImage>,
        exif: HashMap<String, String>,
    ) -> bool {
        if let Some(pos) = self
            .items
            .iter()
            .position(|entry| entry.revision.canonical_path == revision.canonical_path)
        {
            self.items.remove(pos);
        }

        let exif_bytes = exif
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>();
        if self.capacity == 0 || image.as_bytes().len() + exif_bytes > self.max_bytes {
            self.refresh_bytes();
            self.trace("skip_oversize");
            return false;
        }
        self.items.push(DecodedImageEntry {
            revision,
            image,
            exif,
            exif_bytes,
        });
        self.refresh_bytes();
        self.evict_to_budget();
        self.trace("insert");
        true
    }

    pub fn usage(&self, active: Option<&Arc<DynamicImage>>) -> DecodedCacheUsage {
        let active_pixel_bytes = active.map_or(0, |image| image.as_bytes().len());
        let active_is_cached = active.is_some_and(|image| {
            self.items
                .iter()
                .any(|entry| Arc::ptr_eq(&entry.image, image))
        });
        DecodedCacheUsage {
            retained_bytes: self.bytes,
            budget_bytes: self.max_bytes,
            entries: self.items.len(),
            max_entries: self.capacity,
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            invalidations: self.invalidations,
            active_shared_pixel_bytes: if active_is_cached {
                active_pixel_bytes
            } else {
                0
            },
            active_uncached_pixel_bytes: if active_is_cached {
                0
            } else {
                active_pixel_bytes
            },
        }
    }

    fn refresh_bytes(&mut self) {
        let mut pixel_allocations = HashSet::new();
        self.bytes = self
            .items
            .iter()
            .map(|entry| {
                let pixels = if pixel_allocations.insert(Arc::as_ptr(&entry.image)) {
                    entry.image.as_bytes().len()
                } else {
                    0
                };
                pixels + entry.exif_bytes
            })
            .sum();
    }

    fn trace(&self, event: &str) {
        if decoded_cache_trace_enabled() {
            let usage = self.usage(None);
            log::info!(
                "[preview_cache] cache=decoded event={event} entries={} retained_bytes={} budget_bytes={} hits={} misses={} evictions={} invalidations={}",
                usage.entries,
                usage.retained_bytes,
                usage.budget_bytes,
                usage.hits,
                usage.misses,
                usage.evictions,
                usage.invalidations
            );
        }
    }

    fn evict_to_budget(&mut self) {
        while self.items.len() > self.capacity || self.bytes > self.max_bytes {
            self.items.remove(0);
            self.evictions += 1;
            self.refresh_bytes();
            self.trace("evict");
        }
    }
}

#[tauri::command]
pub fn clear_image_caches(state: tauri::State<AppState>) {
    let _session = state
        .preview_session_gate
        .write()
        .unwrap_or_else(|e| e.into_inner());
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
    if let Ok(mut patched_warped_cache) = state.patched_warped_cache.lock() {
        *patched_warped_cache = None;
    }
    if let Ok(mut transformed_cache) = state.full_transformed_cache.lock() {
        *transformed_cache = None;
    }
}

#[tauri::command]
pub fn clear_session_caches(state: tauri::State<AppState>) {
    let _session = state
        .preview_session_gate
        .write()
        .unwrap_or_else(|e| e.into_inner());
    crate::mask_generation::clear_component_mask_cache();
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
    use serde_json::json;
    use std::fs;

    #[test]
    fn mask_cache_bounds_bytes_updates_duplicates_and_keeps_recent_entries() {
        let mut cache = MaskBitmapCache::new(8);
        let image = || Arc::new(image::GrayImage::new(2, 2));
        cache.insert(1, image());
        cache.insert(2, image());
        assert!(cache.get(&1).is_some());
        cache.insert(3, image());
        assert!(cache.get(&2).is_none());
        assert!(cache.get(&1).is_some());
        cache.insert(3, image());
        assert_eq!(cache.bytes, 8);
        assert_eq!(cache.entries.len(), 2);
        cache.insert(4, Arc::new(image::GrayImage::new(3, 3)));
        assert!(cache.get(&4).is_none());
        assert_eq!(cache.bytes, 8);
        cache.clear();
        assert_eq!(cache.bytes, 0);
        assert!(cache.get(&1).is_none());
    }

    #[test]
    fn decoded_cache_bounds_pixel_bytes_and_preserves_in_flight_arcs() {
        let folder = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..3)
            .map(|index| {
                let path = folder.path().join(format!("{index}.png"));
                fs::write(&path, [index]).unwrap();
                path
            })
            .collect();
        let revisions: Vec<_> = paths
            .iter()
            .map(|path| SourceRevision::read(path).unwrap())
            .collect();
        let image = || Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::new(2, 2)));
        let mut cache = DecodedImageCache::with_budget(3, 96);

        assert!(cache.insert(revisions[0].clone(), image(), HashMap::new()));
        assert!(cache.insert(revisions[1].clone(), image(), HashMap::new()));
        assert_eq!(cache.bytes, 96);
        let held = cache.get(&revisions[0]).unwrap().0;
        assert!(cache.insert(revisions[2].clone(), image(), HashMap::new()));
        assert!(cache.get(&revisions[1]).is_none());
        assert!(cache.get(&revisions[0]).is_some());
        assert_eq!(held.as_bytes().len(), 48);
        assert_eq!(cache.bytes, 96);

        assert!(cache.insert(revisions[0].clone(), image(), HashMap::new()));
        assert_eq!(cache.bytes, 96);
        cache.set_capacity(1);
        assert_eq!(cache.items.len(), 1);
        assert_eq!(cache.bytes, 48);
        cache.clear();
        assert_eq!(cache.bytes, 0);
        assert_eq!(held.as_bytes().len(), 48);
    }

    #[test]
    fn decoded_cache_skips_oversize_and_zero_capacity_entries() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        fs::write(&path, b"source").unwrap();
        let revision = SourceRevision::read(&path).unwrap();
        let image = Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::new(2, 2)));

        let mut cache = DecodedImageCache::with_budget(2, 47);
        assert!(!cache.insert(revision.clone(), Arc::clone(&image), HashMap::new()));
        assert_eq!(cache.bytes, 0);
        assert!(cache.get(&revision).is_none());
        let mut disabled = DecodedImageCache::with_budget(0, 100);
        assert!(!disabled.insert(revision, image, HashMap::new()));
        assert!(disabled.items.is_empty());
    }

    #[test]
    fn decoded_usage_counts_shared_arc_once_and_identifies_active_pin() {
        let folder = tempfile::tempdir().unwrap();
        let first = folder.path().join("first.png");
        let second = folder.path().join("second.png");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let first_revision = SourceRevision::read(&first).unwrap();
        let second_revision = SourceRevision::read(&second).unwrap();
        let shared = Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::new(2, 2)));
        let mut cache = DecodedImageCache::with_budget(2, 48);
        assert!(cache.insert(first_revision.clone(), Arc::clone(&shared), HashMap::new()));
        assert!(cache.insert(second_revision, Arc::clone(&shared), HashMap::new()));
        let usage = cache.usage(Some(&shared));
        assert_eq!(usage.entries, 2);
        assert_eq!(usage.retained_bytes, 48);
        assert_eq!(usage.active_shared_pixel_bytes, 48);
        assert_eq!(usage.active_uncached_pixel_bytes, 0);
        assert!(cache.get(&first_revision).is_some());
        cache.set_capacity(0);
        let usage = cache.usage(Some(&shared));
        assert_eq!(usage.retained_bytes, 0);
        assert_eq!(usage.active_shared_pixel_bytes, 0);
        assert_eq!(usage.active_uncached_pixel_bytes, 48);
        assert_eq!(usage.hits, 1);
        assert_eq!(usage.evictions, 2);
    }

    #[test]
    fn preview_cache_usage_reports_both_caches_without_changing_their_state() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        fs::write(&path, b"source").unwrap();
        let revision = SourceRevision::read(&path).unwrap();
        let image = Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::new(2, 2)));
        let state = AppState::default();
        *state.original_image.lock().unwrap() = Some(crate::app_state::LoadedImage {
            path: path.to_string_lossy().into_owned(),
            image: Arc::clone(&image),
            is_raw: false,
        });
        state
            .decoded_image_cache
            .lock()
            .unwrap()
            .insert(revision, image, HashMap::new());
        state.patch_cache.lock().unwrap().insert_group(
            "patch:revision".into(),
            HashMap::from([("patchData".into(), json!({"color":"AAAA"}))]),
        );

        let first = collect_preview_cache_usage(&state);
        let second = collect_preview_cache_usage(&state);
        assert_eq!(first.generation_before, first.generation_after);
        assert_eq!(first.decoded.retained_bytes, 48);
        assert_eq!(first.decoded.active_shared_pixel_bytes, 48);
        assert_eq!(first.decoded.active_uncached_pixel_bytes, 0);
        assert_eq!(first.transported_assets.entries, 1);
        assert!(first.transported_assets.retained_bytes > 0);
        assert_eq!(first.decoded.hits, second.decoded.hits);
        assert_eq!(
            first.transported_assets.cache_epoch,
            second.transported_assets.cache_epoch
        );

        state.decoded_image_cache.lock().unwrap().clear();
        let uncached = collect_preview_cache_usage(&state);
        assert_eq!(uncached.decoded.retained_bytes, 0);
        assert_eq!(uncached.decoded.active_uncached_pixel_bytes, 48);
    }

    #[test]
    fn source_revision_rejects_missing_file_and_shared_virtual_copy_pixels() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        fs::write(&path, b"source").unwrap();
        let initial = SourceRevision::read(&path).unwrap();
        let virtual_path = format!("{}?vc=copy-1", path.display());
        let physical = crate::file_management::parse_virtual_path(&virtual_path).0;
        assert_eq!(
            initial.token(),
            SourceRevision::read(&physical).unwrap().token()
        );

        // A sidecar edit changes the virtual copy's recipe, not its decoded pixels.
        fs::write(path.with_file_name("source.png.copy-1.rrdata"), b"edited").unwrap();
        assert_eq!(initial, SourceRevision::read(&path).unwrap());

        fs::write(&path, b"longer source").unwrap();
        assert_ne!(
            initial.token(),
            SourceRevision::read(&path).unwrap().token()
        );
        fs::remove_file(&path).unwrap();
        assert!(SourceRevision::read(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn source_replacement_invalidates_cached_pixels_even_with_same_size_and_mtime() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        fs::write(&path, b"AAAA").unwrap();
        let original = SourceRevision::read(&path).unwrap();
        let old_mtime =
            filetime::FileTime::from_last_modification_time(&fs::metadata(&path).unwrap());
        let image = Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::new(2, 2)));
        let mut cache = DecodedImageCache::with_budget(2, 100);
        assert!(cache.insert(original.clone(), image, HashMap::new()));

        let replacement = folder.path().join("replacement.png");
        fs::write(&replacement, b"BBBB").unwrap();
        filetime::set_file_mtime(&replacement, old_mtime).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let current = SourceRevision::read(&path).unwrap();
        assert_eq!(original.file_size, current.file_size);
        assert_eq!(original.modified, current.modified);
        assert_ne!(original.token(), current.token());
        assert!(cache.get(&current).is_none());
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn transform_keys_follow_content_but_ignore_tonal_edits() {
        let base = json!({"lensBlurEnabled":true,"lensBlurDepthMap":"AAAA",
            "aiPatches":[{"id":"p","patchData":{"color":"AAAA","mask":"BBBB"}}]});
        let original = calculate_transform_hash(&base);
        for (key, value) in [
            ("lensBlurDepthMap", json!("CCCC")),
            ("crop", json!({"x":2})),
            ("rotation", json!(5)),
            ("flipHorizontal", json!(true)),
            ("transformScale", json!(1.5)),
        ] {
            let mut changed = base.clone();
            changed[key] = value;
            assert_ne!(original, calculate_transform_hash(&changed), "{key}");
        }
        let mut changed = base.clone();
        changed["aiPatches"][0]["patchData"]["color"] = json!("CCCC");
        assert_ne!(original, calculate_transform_hash(&changed));
        changed = base.clone();
        changed["aiPatches"][0]["opacity"] = json!(40);
        assert_ne!(original, calculate_transform_hash(&changed));
        changed = base;
        changed["exposure"] = json!(1.5);
        assert_eq!(original, calculate_transform_hash(&changed));
    }

    #[test]
    fn subject_image_cache_changes_with_retouch_pixels() {
        let base = json!({
            "transformScale": 1.0,
            "aiPatches": [{"visible": true, "patchData": {"color": "AAAA", "mask": "BBBB"}}]
        });
        let original = calculate_geometry_hash(&base);
        let mut changed = base.clone();
        changed["aiPatches"][0]["patchData"]["color"] = json!("CCCC");
        assert_ne!(original, calculate_geometry_hash(&changed));
        changed = base.clone();
        changed["aiPatches"][0]["visible"] = json!(false);
        assert_ne!(original, calculate_geometry_hash(&changed));
        changed = base;
        changed["exposure"] = json!(1.0);
        assert_eq!(original, calculate_geometry_hash(&changed));
    }
}
