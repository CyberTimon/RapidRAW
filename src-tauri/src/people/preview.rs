use anyhow::Result;
use image::{DynamicImage, RgbImage};
use std::path::Path;
use std::sync::{Arc, Mutex};
type CachedPreview = (String, String, Arc<RgbImage>);
static CACHE: Mutex<Vec<CachedPreview>> = Mutex::new(Vec::new());

pub fn clear_cache() {
    CACHE.lock().unwrap().clear();
}

pub fn load(path: &str) -> Result<Arc<RgbImage>> {
    load_sized(path, 1280)
}

pub fn load_sized(path: &str, size: u32) -> Result<Arc<RgbImage>> {
    let fingerprint = format!("{}:{size}", fingerprint(path)?);
    if let Some((_, _, image)) = CACHE
        .lock()
        .unwrap()
        .iter()
        .find(|(p, f, _)| p == path && f == &fingerprint)
    {
        return Ok(image.clone());
    }
    let image = Arc::new(decode(path, size)?);
    let mut cache = CACHE.lock().unwrap();
    cache.retain(|(p, _, _)| p != path);
    if cache.len() >= 2 {
        cache.remove(0);
    }
    cache.push((path.to_string(), fingerprint, image.clone()));
    Ok(image)
}

// Original, oriented pixels keep face coordinates independent of editor crops and effects.
fn decode(path: &str, size: u32) -> Result<RgbImage> {
    let image = if crate::formats::is_raw_file(path) {
        if let Some(preview) =
            crate::file_management::try_load_embedded_raw_preview(Path::new(path), size)
        {
            preview
        } else {
            let bytes = std::fs::read(path)?;
            let raw =
                crate::raw_processing::develop_raw_image(&bytes, true, 2.5, "gamma".into(), None)?;
            let mut rgb = raw.to_rgb32f();
            for p in rgb.pixels_mut() {
                for v in &mut p.0 {
                    let x = (*v).max(0.0);
                    *v = if x <= 0.0031308 {
                        12.92 * x
                    } else {
                        1.055 * x.powf(1.0 / 2.4) - 0.055
                    };
                }
            }
            DynamicImage::ImageRgb32F(rgb)
        }
    } else {
        crate::image_loader::load_image_with_orientation(&std::fs::read(path)?, None)?
    };
    Ok(if image.width() > size || image.height() > size {
        image
            .resize(size, size, image::imageops::FilterType::Triangle)
            .to_rgb8()
    } else {
        image.to_rgb8()
    })
}

pub fn fingerprint(path: &str) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    Ok(format!(
        "{}:{}",
        meta.len(),
        meta.modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ))
}
