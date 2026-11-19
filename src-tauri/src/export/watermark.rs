use crate::export::settings::{WatermarkAnchor, WatermarkSettings};
use crate::render::color_space::OutputColorSpace;
use image::{DynamicImage, GenericImageView};
use std::fs;
use std::sync::{Arc, Mutex};

struct WatermarkCacheEntry {
    path: String,
    modified: Option<std::time::SystemTime>,
    len: Option<u64>,
    image: Arc<DynamicImage>,
    scaled: Option<((u32, u32, OutputColorSpace), Arc<DynamicImage>)>,
}

static WATERMARK_CACHE: Mutex<Option<WatermarkCacheEntry>> = Mutex::new(None);

pub struct WatermarkCacheGuard;

impl Drop for WatermarkCacheGuard {
    fn drop(&mut self) {
        clear_watermark_cache();
    }
}

pub fn clear_watermark_cache() {
    *WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn load_watermark_image(path: &str) -> Result<Arc<DynamicImage>, String> {
    let metadata = fs::metadata(path).ok();
    let modified = metadata.as_ref().and_then(|m| m.modified().ok());
    let len = metadata.as_ref().map(|m| m.len());
    let mut cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.as_ref()
        && entry.path == path
        && entry.modified.is_some()
        && entry.modified == modified
        && entry.len == len
    {
        return Ok(Arc::clone(&entry.image));
    }
    let image =
        Arc::new(image::open(path).map_err(|e| format!("Failed to open watermark image: {}", e))?);
    *cache = Some(WatermarkCacheEntry {
        path: path.to_string(),
        modified,
        len,
        image: Arc::clone(&image),
        scaled: None,
    });
    Ok(image)
}

fn in_color_space(watermark: DynamicImage, color_space: OutputColorSpace) -> DynamicImage {
    if color_space == OutputColorSpace::Srgb {
        return watermark;
    }
    let from_srgb = color_space.srgb_converter();
    let mut converted = watermark.to_rgba32f();
    for pixel in converted.pixels_mut() {
        let [r, g, b] = from_srgb([pixel[0], pixel[1], pixel[2]]);
        pixel.0 = [r, g, b, pixel[3]];
    }
    DynamicImage::ImageRgba32F(converted)
}

fn scaled_watermark_image(
    path: &str,
    watermark_img: &Arc<DynamicImage>,
    new_wm_w: u32,
    new_wm_h: u32,
    color_space: OutputColorSpace,
) -> Arc<DynamicImage> {
    let key = (new_wm_w, new_wm_h, color_space);
    {
        let cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.as_ref()
            && entry.path == path
            && Arc::ptr_eq(&entry.image, watermark_img)
            && let Some((cached_key, scaled)) = &entry.scaled
            && *cached_key == key
        {
            return Arc::clone(scaled);
        }
    }
    let scaled = Arc::new(in_color_space(
        watermark_img.resize_exact(new_wm_w, new_wm_h, image::imageops::FilterType::Lanczos3),
        color_space,
    ));
    let mut cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.as_mut()
        && entry.path == path
        && Arc::ptr_eq(&entry.image, watermark_img)
    {
        entry.scaled = Some((key, Arc::clone(&scaled)));
    }
    scaled
}

pub fn apply_watermark(
    base_image: &mut DynamicImage,
    watermark_settings: &WatermarkSettings,
    color_space: OutputColorSpace,
) -> Result<(), String> {
    let watermark_img = load_watermark_image(&watermark_settings.path)?;

    let (base_w, base_h) = base_image.dimensions();
    let base_min_dim = base_w.min(base_h) as f32;

    let watermark_scale_factor =
        (base_min_dim * (watermark_settings.scale / 100.0)) / watermark_img.width().max(1) as f32;
    let new_wm_w = (watermark_img.width() as f32 * watermark_scale_factor).round() as u32;
    let new_wm_h = (watermark_img.height() as f32 * watermark_scale_factor).round() as u32;

    if new_wm_w == 0 || new_wm_h == 0 {
        return Ok(());
    }

    let scaled_watermark = scaled_watermark_image(
        &watermark_settings.path,
        &watermark_img,
        new_wm_w,
        new_wm_h,
        color_space,
    );
    let opacity_factor = (watermark_settings.opacity / 100.0).clamp(0.0, 1.0);

    let spacing_pixels = (base_min_dim * (watermark_settings.spacing / 100.0)) as i64;
    let (wm_w, wm_h) = scaled_watermark.dimensions();

    let x = match watermark_settings.anchor {
        WatermarkAnchor::TopLeft | WatermarkAnchor::CenterLeft | WatermarkAnchor::BottomLeft => {
            spacing_pixels
        }
        WatermarkAnchor::TopCenter | WatermarkAnchor::Center | WatermarkAnchor::BottomCenter => {
            (base_w as i64 - wm_w as i64) / 2
        }
        WatermarkAnchor::TopRight | WatermarkAnchor::CenterRight | WatermarkAnchor::BottomRight => {
            base_w as i64 - wm_w as i64 - spacing_pixels
        }
    };

    let y = match watermark_settings.anchor {
        WatermarkAnchor::TopLeft | WatermarkAnchor::TopCenter | WatermarkAnchor::TopRight => {
            spacing_pixels
        }
        WatermarkAnchor::CenterLeft | WatermarkAnchor::Center | WatermarkAnchor::CenterRight => {
            (base_h as i64 - wm_h as i64) / 2
        }
        WatermarkAnchor::BottomLeft
        | WatermarkAnchor::BottomCenter
        | WatermarkAnchor::BottomRight => base_h as i64 - wm_h as i64 - spacing_pixels,
    };

    if matches!(
        base_image,
        DynamicImage::ImageRgb16(_) | DynamicImage::ImageRgba16(_)
    ) {
        let mut base_rgba = base_image.to_rgba16();
        let mut watermark_rgba = scaled_watermark.to_rgba16();
        for pixel in watermark_rgba.pixels_mut() {
            pixel[3] = (pixel[3] as f32 * opacity_factor).round() as u16;
        }
        image::imageops::overlay(&mut base_rgba, &watermark_rgba, x, y);
        *base_image = DynamicImage::ImageRgba16(base_rgba);
    } else if matches!(
        base_image,
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_)
    ) {
        let mut base_rgba = base_image.to_rgba32f();
        let mut watermark_rgba = scaled_watermark.to_rgba32f();
        for pixel in watermark_rgba.pixels_mut() {
            pixel[3] *= opacity_factor;
        }
        image::imageops::overlay(&mut base_rgba, &watermark_rgba, x, y);
        *base_image = DynamicImage::ImageRgba32F(base_rgba);
    } else {
        let mut watermark_rgba = scaled_watermark.to_rgba8();
        for pixel in watermark_rgba.pixels_mut() {
            pixel[3] = (pixel[3] as f32 * opacity_factor).round() as u8;
        }
        if let DynamicImage::ImageRgba8(base_rgba) = base_image {
            image::imageops::overlay(base_rgba, &watermark_rgba, x, y);
        } else {
            let mut base_rgba = base_image.to_rgba8();
            image::imageops::overlay(&mut base_rgba, &watermark_rgba, x, y);
            *base_image = DynamicImage::ImageRgba8(base_rgba);
        }
    }

    Ok(())
}
