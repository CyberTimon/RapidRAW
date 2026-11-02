use crate::cache_utils::GEOMETRY_KEYS;
use crate::image_processing::{
    GeometryParams, get_geometry_params_from_json, is_geometry_identity, warp_image_geometry,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, GrayImage, Luma, Rgb, Rgb32FImage, Rgba, RgbaImage};
use rayon::prelude::*;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SOURCE_SPACE_MAP_PREFIX: &str = "data:image/png;space=source;base64,";
const MAP_REFERENCE_PREFIX: &str = "rrmap:";

const MAP_CACHE_CAPACITY: usize = 4;

static LUMA_MAP_CACHE: Mutex<Vec<(u64, Arc<GrayImage>)>> = Mutex::new(Vec::new());
static RGBA_MAP_CACHE: Mutex<Vec<(u64, Arc<RgbaImage>)>> = Mutex::new(Vec::new());
static MAP_CACHE_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static MAP_DISK_CACHE_LIMIT_BYTES: AtomicU64 = AtomicU64::new(u64::MAX);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectMapKind {
    Depth,
    Normal,
}

impl EffectMapKind {
    pub const ALL: [EffectMapKind; 2] = [EffectMapKind::Depth, EffectMapKind::Normal];

    fn model_tag(self) -> &'static str {
        match self {
            EffectMapKind::Depth => "depth-anything-v2",
            EffectMapKind::Normal => "normal-v1",
        }
    }

    pub fn adjustment_keys(self) -> &'static [(&'static str, &'static str, &'static str)] {
        match self {
            EffectMapKind::Depth => &[
                ("lensBlur", "lensBlurEnabled", "lensBlurDepthMap"),
                ("fog", "fogEnabled", "fogDepthMap"),
            ],
            EffectMapKind::Normal => &[("relight", "relightEnabled", "relightNormalMap")],
        }
    }
}

pub fn initialize_cache_dir(cache_dir: PathBuf) {
    let dir = cache_dir.join("ai_maps");
    let _ = fs::create_dir_all(&dir);
    *MAP_CACHE_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
}

pub fn set_disk_cache_limit_gb(limit_gb: u32) {
    let limit = u64::from(limit_gb.max(1)) * 1024 * 1024 * 1024;
    let dir = MAP_CACHE_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if MAP_DISK_CACHE_LIMIT_BYTES.swap(limit, Ordering::Relaxed) > limit
        && let Some(dir) = dir
    {
        std::thread::spawn(move || evict_map_disk_cache(&dir, None));
    }
}

fn map_file_name(kind: EffectMapKind, source_id: &str) -> String {
    format!("{}-{}.png", kind.model_tag(), source_id)
}

fn map_file_path(file_name: &str) -> Option<PathBuf> {
    MAP_CACHE_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|dir| dir.join(file_name))
}

pub fn store_source_map(
    kind: EffectMapKind,
    source_id: &str,
    map: &DynamicImage,
) -> Result<String, String> {
    let file_name = map_file_name(kind, source_id);
    let path = map_file_path(&file_name).ok_or("AI map cache directory is not initialized")?;

    let mut buf = std::io::Cursor::new(Vec::new());
    map.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    crate::file_management::write_file_atomic(&path, buf.get_ref()).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        evict_map_disk_cache(dir, Some(&path));
    }

    Ok(format!("{}{}", MAP_REFERENCE_PREFIX, file_name))
}

pub fn is_map_reference(value: &serde_json::Value) -> bool {
    value
        .as_str()
        .is_some_and(|map| map.starts_with(MAP_REFERENCE_PREFIX))
}

pub fn is_map_valid_for(value: &serde_json::Value, kind: EffectMapKind, source_id: &str) -> bool {
    match value.as_str() {
        Some(map) if map.starts_with(MAP_REFERENCE_PREFIX) => {
            let file_name = map_file_name(kind, source_id);
            map[MAP_REFERENCE_PREFIX.len()..] == file_name
                && map_file_path(&file_name).is_some_and(|path| path.exists())
        }
        Some(map) => !map.is_empty(),
        None => false,
    }
}

fn evict_map_disk_cache(dir: &Path, keep: Option<&Path>) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    let limit = MAP_DISK_CACHE_LIMIT_BYTES.load(Ordering::Relaxed);

    let mut entries: Vec<(PathBuf, u64, SystemTime)> = read_dir
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "png"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.path(), meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)))
        })
        .collect();

    let mut total: u64 = entries.iter().map(|(_, len, _)| len).sum();
    entries.sort_by_key(|(_, _, modified)| *modified);

    for (path, len, _) in entries {
        if total <= limit {
            break;
        }
        if Some(path.as_path()) != keep && fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

pub fn clear_disk_cache() -> Result<(), String> {
    let dir = MAP_CACHE_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(read_dir) = dir.and_then(|dir| fs::read_dir(dir).ok()) else {
        return Ok(());
    };
    for path in read_dir.filter_map(|e| e.ok()).map(|e| e.path()) {
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

pub fn is_source_space_map(data_url: &str) -> bool {
    data_url.starts_with(SOURCE_SPACE_MAP_PREFIX) || data_url.starts_with(MAP_REFERENCE_PREFIX)
}

pub fn effect_map_key(data_url: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    data_url.hash(&mut hasher);

    if is_source_space_map(data_url) {
        for key in GEOMETRY_KEYS {
            if let Some(val) = adjustments.get(key) {
                key.hash(&mut hasher);
                val.to_string().hash(&mut hasher);
            }
        }
    }

    hasher.finish()
}

pub fn resolve_luma_map(data_url: &str, adjustments: &serde_json::Value) -> Option<Arc<GrayImage>> {
    cached_map(
        &LUMA_MAP_CACHE,
        effect_map_key(data_url, adjustments),
        || {
            let map = decode_data_url(data_url)?;
            Some(if is_source_space_map(data_url) {
                warp_effect_map(&map, adjustments).into_luma8()
            } else {
                map.into_luma8()
            })
        },
    )
}

pub fn resolve_rgba_map(data_url: &str, adjustments: &serde_json::Value) -> Option<Arc<RgbaImage>> {
    cached_map(
        &RGBA_MAP_CACHE,
        effect_map_key(data_url, adjustments),
        || {
            let map = decode_data_url(data_url)?.into_rgba8();
            if !is_source_space_map(data_url) {
                return Some(map);
            }

            let alpha = GrayImage::from_fn(map.width(), map.height(), |x, y| {
                Luma([map.get_pixel(x, y)[3]])
            });
            let warped_rgb =
                warp_effect_map(&DynamicImage::ImageRgba8(map), adjustments).into_rgb8();
            let warped_alpha =
                warp_effect_map(&DynamicImage::ImageLuma8(alpha), adjustments).into_luma8();

            let (width, height) = warped_rgb.dimensions();
            let rotations = local_warp_rotations(width, height, adjustments);

            Some(RgbaImage::from_fn(width, height, |x, y| {
                let [r, g, b] = warped_rgb.get_pixel(x, y).0;
                let (r, g) = match &rotations {
                    Some(rotations) => rotate_normal(r, g, rotations[(y * width + x) as usize]),
                    None => (r, g),
                };
                Rgba([r, g, b, warped_alpha.get_pixel(x, y)[0]])
            }))
        },
    )
}

fn effect_map_geometry_params(adjustments: &serde_json::Value) -> GeometryParams {
    let mut params = get_geometry_params_from_json(adjustments);
    params.lens_vignette_enabled = false;
    params.lens_tca_enabled = false;
    params
}

fn warp_effect_map(map: &DynamicImage, adjustments: &serde_json::Value) -> DynamicImage {
    let params = effect_map_geometry_params(adjustments);

    if is_geometry_identity(&params) {
        map.clone()
    } else {
        warp_image_geometry(map, params)
    }
}

fn local_warp_rotations(
    width: u32,
    height: u32,
    adjustments: &serde_json::Value,
) -> Option<Vec<(f32, f32)>> {
    let params = effect_map_geometry_params(adjustments);
    if is_geometry_identity(&params) {
        return None;
    }

    let coords = Rgb32FImage::from_fn(width, height, |x, y| Rgb([x as f32, y as f32, 1.0]));
    let warped = warp_image_geometry(&DynamicImage::ImageRgb32F(coords), params).into_rgb32f();
    let (w, h) = (width as usize, height as usize);
    let src = warped.as_raw();
    let source_at = |x: usize, y: usize| {
        let i = (y * w + x) * 3;
        [src[i], src[i + 1], src[i + 2]]
    };

    Some(
        (0..w * h)
            .into_par_iter()
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let (x0, x1) = (x.saturating_sub(1), (x + 1).min(w - 1));
                let (y0, y1) = (y.saturating_sub(1), (y + 1).min(h - 1));
                if x0 == x1 || y0 == y1 {
                    return (1.0, 0.0);
                }

                let (left, right) = (source_at(x0, y), source_at(x1, y));
                let (top, bottom) = (source_at(x, y0), source_at(x, y1));
                if [left, right, top, bottom].iter().any(|p| p[2] < 0.999) {
                    return (1.0, 0.0);
                }

                let (dx, dy) = ((x1 - x0) as f32, (y1 - y0) as f32);
                let k00 = (right[0] - left[0]) / dx;
                let k10 = (right[1] - left[1]) / dx;
                let k01 = (bottom[0] - top[0]) / dy;
                let k11 = (bottom[1] - top[1]) / dy;

                let (sin, cos) = (-(k10 - k01).atan2(k00 + k11)).sin_cos();
                (cos, sin)
            })
            .collect(),
    )
}

fn rotate_normal(r: u8, g: u8, (cos, sin): (f32, f32)) -> (u8, u8) {
    let nx = r as f32 / 127.5 - 1.0;
    let ny = 1.0 - g as f32 / 127.5;
    let rotated_x = cos * nx - sin * ny;
    let rotated_y = sin * nx + cos * ny;
    let pack = |v: f32| ((v + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
    (pack(rotated_x), pack(-rotated_y))
}

fn decode_data_url(data_url: &str) -> Option<DynamicImage> {
    if let Some(file_name) = data_url.strip_prefix(MAP_REFERENCE_PREFIX) {
        let path = map_file_path(file_name)?;
        let map = image::open(&path).ok()?;
        crate::storage::mark_used(&path);
        return Some(map);
    }

    let b64_data = match data_url.find(',') {
        Some(idx) => &data_url[idx + 1..],
        None => data_url,
    };
    let decoded = BASE64.decode(b64_data).ok()?;
    image::load_from_memory(&decoded).ok()
}

fn cached_map<T>(
    cache: &Mutex<Vec<(u64, Arc<T>)>>,
    key: u64,
    build: impl FnOnce() -> Option<T>,
) -> Option<Arc<T>> {
    if let Some((_, map)) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(k, _)| *k == key)
    {
        return Some(Arc::clone(map));
    }

    let map = Arc::new(build()?);

    let mut cache_lock = cache.lock().unwrap_or_else(|e| e.into_inner());
    if cache_lock.len() >= MAP_CACHE_CAPACITY {
        cache_lock.remove(0);
    }
    cache_lock.push((key, Arc::clone(&map)));

    Some(map)
}
