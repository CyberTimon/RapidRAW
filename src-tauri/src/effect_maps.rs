use crate::cache_utils::GEOMETRY_KEYS;
use crate::image_processing::{
    get_geometry_params_from_json, is_geometry_identity, warp_image_geometry,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, GrayImage, Luma, Rgba, RgbaImage};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

pub const SOURCE_SPACE_MAP_PREFIX: &str = "data:image/png;space=source;base64,";

const MAP_CACHE_CAPACITY: usize = 4;

static LUMA_MAP_CACHE: Mutex<Vec<(u64, Arc<GrayImage>)>> = Mutex::new(Vec::new());
static RGBA_MAP_CACHE: Mutex<Vec<(u64, Arc<RgbaImage>)>> = Mutex::new(Vec::new());

pub fn encode_source_space_map(image: &DynamicImage) -> Result<String, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "{}{}",
        SOURCE_SPACE_MAP_PREFIX,
        BASE64.encode(buf.get_ref())
    ))
}

pub fn is_source_space_map(data_url: &str) -> bool {
    data_url.starts_with(SOURCE_SPACE_MAP_PREFIX)
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

            Some(RgbaImage::from_fn(
                warped_rgb.width(),
                warped_rgb.height(),
                |x, y| {
                    let [r, g, b] = warped_rgb.get_pixel(x, y).0;
                    Rgba([r, g, b, warped_alpha.get_pixel(x, y)[0]])
                },
            ))
        },
    )
}

fn warp_effect_map(map: &DynamicImage, adjustments: &serde_json::Value) -> DynamicImage {
    let mut params = get_geometry_params_from_json(adjustments);
    params.lens_vignette_enabled = false;
    params.lens_tca_enabled = false;

    if is_geometry_identity(&params) {
        map.clone()
    } else {
        warp_image_geometry(map, params)
    }
}

fn decode_data_url(data_url: &str) -> Option<DynamicImage> {
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
