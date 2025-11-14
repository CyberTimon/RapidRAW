//! Image processing cache with LRU eviction strategy.
//!
//! This module provides caching for expensive image processing operations that occur during
//! mask generation and AI patch compositing. By caching decoded masks and patches, we avoid
//! redundant base64 decoding, image loading, and resizing operations.
//!
//! ## Cache Design
//!
//! The cache uses an LRU (Least Recently Used) eviction policy with a configurable size limit
//! (default: 2GB). This provides a safety net against memory exhaustion while acting like an
//! unbounded cache for typical use cases.
//!
//! ## Relationship to Other Caches
//!
//! This cache is part of a multi-layer caching strategy:
//!
//! - `cached_preview` (in AppState): Stores the final transformed CPU-side preview image
//! - `gpu_image_cache` (in gpu_processing): Caches GPU texture uploads to avoid redundant transfers
//! - `processing_cache` (this module): Caches intermediate decoded masks and AI patches
//! - `gpu_processor` (in AppState): Reusable GPU pipeline/shader resources (global scope)
//!
//! Each cache serves a distinct purpose in the rendering pipeline and does not duplicate functionality.

use image::{DynamicImage, GrayImage, Rgb32FImage};
use lru::LruCache;
use std::hash::Hash;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Cache key for identifying cached image processing results.
///
/// Each variant includes the image path and processing parameters to ensure cache correctness.
/// The key must uniquely identify the cached data - any change in parameters that affects
/// the output must be reflected in the key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CacheKey {
    /// A decoded mask from base64 data, specific to an image and transform state.
    ///
    /// Masks are decoded from base64 strings and can be transformed (rotated, flipped, etc).
    /// The transform_hash ensures we cache different versions for different transform states.
    DecodedMask {
        image_path: String,
        mask_id: String,
        width: u32,
        height: u32,
        transform_hash: u64,
    },
    /// A decoded AI patch (generative replace result) specific to an image.
    ///
    /// Patches are decoded from base64 RGB32F data and resized to match the target dimensions.
    /// content_hash ensures we invalidate when the patch is regenerated with the same ID.
    DecodedPatch {
        image_path: String,
        patch_id: String,
        width: u32,
        height: u32,
        content_hash: u64,
    },
    /// A blended mask result combining multiple masks for an image.
    ///
    /// When multiple masks are active, they are blended together. The masks_hash uniquely
    /// identifies the combination and ordering of masks to ensure cache correctness.
    BlendedMask {
        image_path: String,
        masks_hash: u64,
        width: u32,
        height: u32,
    },
    /// A full-resolution transformed image (after orientation, rotation, crop).
    ///
    /// Caches the CPU-side transform pipeline output to avoid re-running expensive operations
    /// when only tone adjustments change. The composite_hash includes both transform state and
    /// context (Preview/OriginalPreview/Fullscreen/Export) to prevent contamination.
    TransformedImage {
        image_path: String,
        composite_hash: u64,
        width: u32,
        height: u32,
    },
}

/// Cached image processing data with size tracking.
///
/// Each variant stores an Arc to the image data for efficient cloning, along with the
/// byte size for cache eviction calculations.
pub enum CachedData {
    Mask(Arc<GrayImage>, usize),
    Patch(Arc<Rgb32FImage>, usize),
    BlendedMask(Arc<GrayImage>, usize),
    TransformedImage(Arc<DynamicImage>, (f32, f32), usize),
}

impl CachedData {
    pub fn byte_size(&self) -> usize {
        match self {
            CachedData::Mask(_, size) => *size,
            CachedData::Patch(_, size) => *size,
            CachedData::BlendedMask(_, size) => *size,
            CachedData::TransformedImage(_, _, size) => *size,
        }
    }

    pub fn as_mask(&self) -> Option<Arc<GrayImage>> {
        match self {
            CachedData::Mask(img, _) | CachedData::BlendedMask(img, _) => Some(Arc::clone(img)),
            _ => None,
        }
    }

    pub fn as_patch(&self) -> Option<Arc<Rgb32FImage>> {
        match self {
            CachedData::Patch(img, _) => Some(Arc::clone(img)),
            _ => None,
        }
    }

    pub fn as_transformed_image(&self) -> Option<(Arc<DynamicImage>, (f32, f32))> {
        match self {
            CachedData::TransformedImage(img, offset, _) => Some((Arc::clone(img), *offset)),
            _ => None,
        }
    }
}

/// Statistics for cache performance monitoring.
///
/// Provides metrics for understanding cache effectiveness and memory usage.
/// Use `hit_rate()` and `utilization()` for derived metrics.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub hits: usize,
    pub misses: usize,
    pub evictions: usize,
    pub current_size_bytes: usize,
    pub max_size_bytes: usize,
    pub entry_count: usize,
}

impl CacheStats {
    pub fn hit_rate(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }

    pub fn utilization(&self) -> f64 {
        if self.max_size_bytes == 0 {
            0.0
        } else {
            self.current_size_bytes as f64 / self.max_size_bytes as f64
        }
    }
}

/// LRU cache for intermediate image processing results.
///
/// Caches decoded masks and AI patches to avoid redundant base64 decoding, image loading,
/// and resizing operations. The cache tracks memory usage and evicts least-recently-used
/// entries when the size limit is exceeded.
///
/// ## Thread Safety
///
/// This cache is designed to be wrapped in a `Mutex` in the AppState. While individual
/// operations use atomic counters for statistics, the LRU cache itself requires exclusive
/// access for get/insert operations.
///
/// ## Memory Management
///
/// The cache enforces a strict size limit (default: 2GB) by evicting LRU entries before
/// inserting new data that would exceed the limit. Each entry tracks its byte size for
/// accurate memory accounting.
pub struct ImageProcessingCache {
    cache: LruCache<CacheKey, CachedData>,
    current_size: AtomicUsize,
    max_size: usize,
    hits: AtomicUsize,
    misses: AtomicUsize,
    evictions: AtomicUsize,
}

impl ImageProcessingCache {
    pub fn new(max_size_bytes: usize) -> Self {
        Self {
            cache: LruCache::unbounded(),
            current_size: AtomicUsize::new(0),
            max_size: max_size_bytes,
            hits: AtomicUsize::new(0),
            misses: AtomicUsize::new(0),
            evictions: AtomicUsize::new(0),
        }
    }

    pub fn get_transformed_image(&mut self, image_path: &str, composite_hash: u64) -> Option<CachedData> {
        // Find TransformedImage by path and composite_hash, ignoring dimensions
        let key = self.cache.iter().find_map(|(k, _)| {
            if let CacheKey::TransformedImage { image_path: path, composite_hash: hash, .. } = k {
                if path == image_path && *hash == composite_hash {
                    return Some(k.clone());
                }
            }
            None
        })?;

        self.get(&key)
    }

    pub fn get(&mut self, key: &CacheKey) -> Option<CachedData> {
        let key_summary = self.cache_key_summary(key);

        if let Some(data) = self.cache.get(key) {
            self.hits.fetch_add(1, Ordering::Relaxed);
            let hit_count = self.hits.load(Ordering::Relaxed);
            log::info!("Cache: hit (total hits: {}) - {}", hit_count, key_summary);
            Some(match data {
                CachedData::Mask(img, size) => CachedData::Mask(Arc::clone(img), *size),
                CachedData::Patch(img, size) => CachedData::Patch(Arc::clone(img), *size),
                CachedData::BlendedMask(img, size) => {
                    CachedData::BlendedMask(Arc::clone(img), *size)
                }
                CachedData::TransformedImage(img, offset, size) => {
                    CachedData::TransformedImage(Arc::clone(img), *offset, *size)
                }
            })
        } else {
            self.misses.fetch_add(1, Ordering::Relaxed);
            let miss_count = self.misses.load(Ordering::Relaxed);
            log::info!("Cache: miss (total misses: {}) - {}", miss_count, key_summary);
            None
        }
    }

    pub fn insert(&mut self, key: CacheKey, data: CachedData) {
        let data_size = data.byte_size();
        let data_size_mb = data_size as f64 / (1024.0 * 1024.0);
        let key_summary = self.cache_key_summary(&key);

        // Evict LRU entries if needed
        let mut evicted_count = 0;
        while self.current_size.load(Ordering::Relaxed) + data_size > self.max_size {
            if let Some((_, evicted)) = self.cache.pop_lru() {
                self.current_size
                    .fetch_sub(evicted.byte_size(), Ordering::Relaxed);
                self.evictions.fetch_add(1, Ordering::Relaxed);
                evicted_count += 1;
            } else {
                break;
            }
        }

        if evicted_count > 0 {
            log::warn!("Cache: evicted {} LRU entries to make room ({:.2} MB needed)", evicted_count, data_size_mb);
        }

        if let Some((_old_key, old_data)) = self.cache.push(key, data) {
            self.current_size
                .fetch_sub(old_data.byte_size(), Ordering::Relaxed);
            log::debug!("Cache: replaced existing entry");
        }
        self.current_size.fetch_add(data_size, Ordering::Relaxed);

        let total_mb = self.current_size.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0);
        let max_mb = self.max_size as f64 / (1024.0 * 1024.0);
        log::info!("Cache: insert {} ({:.2} MB) | total: {:.1}/{:.0} MB ({} entries)",
            key_summary, data_size_mb, total_mb, max_mb, self.cache.len());
    }

    pub fn clear(&mut self) {
        let entry_count = self.cache.len();
        let size_mb = self.current_size.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0);
        self.cache.clear();
        self.current_size.store(0, Ordering::Relaxed);
        log::info!("Cache: cleared - removed {} entries ({:.1} MB)", entry_count, size_mb);
    }

    pub fn set_max_size(&mut self, max_size_bytes: usize) {
        self.max_size = max_size_bytes;

        while self.current_size.load(Ordering::Relaxed) > self.max_size {
            if let Some((_, evicted)) = self.cache.pop_lru() {
                self.current_size
                    .fetch_sub(evicted.byte_size(), Ordering::Relaxed);
                self.evictions.fetch_add(1, Ordering::Relaxed);
            } else {
                break;
            }
        }
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            evictions: self.evictions.load(Ordering::Relaxed),
            current_size_bytes: self.current_size.load(Ordering::Relaxed),
            max_size_bytes: self.max_size,
            entry_count: self.cache.len(),
        }
    }

    fn cache_key_summary(&self, key: &CacheKey) -> String {
        match key {
            CacheKey::DecodedMask { mask_id, width, height, .. } => {
                format!("Mask(id: {}, {}x{})", mask_id, width, height)
            }
            CacheKey::DecodedPatch { patch_id, width, height, .. } => {
                format!("Patch(id: {}, {}x{})", patch_id, width, height)
            }
            CacheKey::BlendedMask { width, height, .. } => {
                format!("BlendedMask({}x{})", width, height)
            }
            CacheKey::TransformedImage { image_path, composite_hash, width, height } => {
                let filename = std::path::Path::new(image_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(image_path);
                format!("TransformedImage({}, {:016x}, {}x{})", filename, composite_hash, width, height)
            }
        }
    }

    pub fn invalidate_image(&mut self, image_path: &str) {
        let keys_to_remove: Vec<CacheKey> = self
            .cache
            .iter()
            .filter_map(|(key, _)| {
                let matches = match key {
                    CacheKey::DecodedMask { image_path: path, .. } => path == image_path,
                    CacheKey::DecodedPatch { image_path: path, .. } => path == image_path,
                    CacheKey::BlendedMask { image_path: path, .. } => path == image_path,
                    CacheKey::TransformedImage { image_path: path, .. } => path == image_path,
                };
                if matches {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();

        let removed_count = keys_to_remove.len();
        for key in keys_to_remove {
            if let Some(data) = self.cache.pop(&key) {
                self.current_size
                    .fetch_sub(data.byte_size(), Ordering::Relaxed);
            }
        }

        if removed_count > 0 {
            log::debug!("Cache: invalidated {} entries for image: {}", removed_count, image_path);
        }
    }
}

pub fn calculate_mask_size(width: u32, height: u32) -> usize {
    (width * height) as usize
}

pub fn calculate_patch_size(width: u32, height: u32) -> usize {
    (width * height * 12) as usize
}

pub fn calculate_transformed_image_size(width: u32, height: u32) -> usize {
    // DynamicImage from apply_all_transformations is typically Rgb32F (3 channels * 4 bytes)
    // Use conservative estimate of 12 bytes per pixel for proper LRU eviction
    (width * height * 12) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_basic_operations() {
        let mut cache = ImageProcessingCache::new(1000);

        let key = CacheKey::DecodedMask {
            image_path: "test.raw".to_string(),
            mask_id: "mask1".to_string(),
            width: 10,
            height: 10,
            transform_hash: 0,
        };

        let mask = Arc::new(GrayImage::new(10, 10));
        let data = CachedData::Mask(mask, 100);

        cache.insert(key.clone(), data);
        assert!(cache.get(&key).is_some());

        let stats = cache.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 0);
    }

    #[test]
    fn test_cache_eviction() {
        let mut cache = ImageProcessingCache::new(150);

        for i in 0..3 {
            let key = CacheKey::DecodedMask {
                image_path: format!("test{}.raw", i),
                mask_id: "mask1".to_string(),
                width: 10,
                height: 10,
                transform_hash: 0,
            };
            let mask = Arc::new(GrayImage::new(10, 10));
            let data = CachedData::Mask(mask, 100);
            cache.insert(key, data);
        }

        let stats = cache.stats();
        assert!(stats.evictions > 0);
        assert!(stats.current_size_bytes <= 150);
    }
}
