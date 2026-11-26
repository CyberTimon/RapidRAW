use crate::export::geometry::parse_hex_color;
use crate::export::settings::{TextWatermark, WatermarkAlign, WatermarkSettings, WatermarkSource};
use crate::render::color_space::OutputColorSpace;
use crate::render::text::TextBlock;
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba, Rgba32FImage, RgbaImage, imageops};
use std::fs;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

const MAX_PREPARED_WATERMARKS: usize = 4;
const PREVIEW_MAX_SIZE: u32 = 1024;
const TEXT_PREVIEW_SIZE: u32 = 2048;
const DEFAULT_TEXT_COLOR: [u8; 3] = [255, 255, 255];

#[derive(Clone, Copy, PartialEq, Eq)]
enum SampleDepth {
    Eight,
    Sixteen,
    Float,
}

#[derive(Clone, Copy, PartialEq)]
struct PreparedKey {
    width: u32,
    height: u32,
    color_space: OutputColorSpace,
    opacity: f32,
    depth: SampleDepth,
}

enum PreparedWatermark {
    Eight(RgbaImage),
    Sixteen(ImageBuffer<Rgba<u16>, Vec<u16>>),
    Float(Rgba32FImage),
}

#[derive(PartialEq)]
enum SourceKey {
    Image {
        path: String,
        modified: Option<SystemTime>,
        len: Option<u64>,
    },
    Text(TextWatermark),
}

impl SourceKey {
    fn of(source: &WatermarkSource) -> Self {
        match source {
            WatermarkSource::Image { path } => {
                let metadata = fs::metadata(path).ok();
                Self::Image {
                    path: path.clone(),
                    modified: metadata.as_ref().and_then(|m| m.modified().ok()),
                    len: metadata.as_ref().map(|m| m.len()),
                }
            }
            WatermarkSource::Text(text) => Self::Text(text.clone()),
        }
    }

    fn is_cacheable(&self) -> bool {
        match self {
            Self::Image { modified, .. } => modified.is_some(),
            Self::Text(_) => true,
        }
    }
}

enum Watermark {
    Image(DynamicImage),
    Text { block: TextBlock, color: [u8; 3] },
}

impl Watermark {
    fn load(source: &WatermarkSource) -> Result<Self, String> {
        match source {
            WatermarkSource::Image { path } => image::ImageReader::open(path)
                .and_then(|reader| reader.with_guessed_format())
                .map_err(|e| e.to_string())
                .and_then(|reader| reader.decode().map_err(|e| e.to_string()))
                .map(Self::Image)
                .map_err(|e| format!("Failed to open watermark image: {}", e)),
            WatermarkSource::Text(text) => Ok(Self::Text {
                block: TextBlock::layout(&text.text, text.font.as_deref(), text.weight)?,
                color: parse_hex_color(&text.color).unwrap_or(DEFAULT_TEXT_COLOR),
            }),
        }
    }

    fn dimensions(&self) -> (u32, u32) {
        match self {
            Self::Image(image) => image.dimensions(),
            Self::Text { block, .. } => (block.width, block.height),
        }
    }

    fn scaled(&self, width: u32, height: u32) -> DynamicImage {
        match self {
            Self::Image(image) => image.resize_exact(width, height, imageops::FilterType::Lanczos3),
            Self::Text { block, color } => {
                DynamicImage::ImageRgba32F(block.render(width, height, *color))
            }
        }
    }

    fn preview(&self) -> RgbaImage {
        match self {
            Self::Image(image) if image.width().max(image.height()) > PREVIEW_MAX_SIZE => image
                .resize(
                    PREVIEW_MAX_SIZE,
                    PREVIEW_MAX_SIZE,
                    imageops::FilterType::Triangle,
                )
                .to_rgba8(),
            Self::Image(image) => image.to_rgba8(),
            Self::Text { block, color } => {
                let (width, height) = block.fit(TEXT_PREVIEW_SIZE);
                DynamicImage::ImageRgba32F(block.render(width, height, *color)).to_rgba8()
            }
        }
    }
}

struct WatermarkCacheEntry {
    key: SourceKey,
    watermark: Arc<Watermark>,
    prepared: Vec<(PreparedKey, Arc<PreparedWatermark>)>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatermarkRect {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

pub fn watermark_rect(
    canvas_w: u32,
    canvas_h: u32,
    source_w: u32,
    source_h: u32,
    settings: &WatermarkSettings,
) -> Option<WatermarkRect> {
    let short_side = canvas_w.min(canvas_h) as f32;
    let factor = (short_side * (settings.scale / 100.0)) / source_w.max(1) as f32;
    let width = (source_w as f32 * factor).round() as u32;
    let height = (source_h as f32 * factor).round() as u32;
    if width == 0 || height == 0 {
        return None;
    }

    let place = |align: WatermarkAlign, extent: u32, size: u32, offset: f32| {
        let offset = short_side * (offset / 100.0);
        match align {
            WatermarkAlign::Start => offset.floor() as i64,
            WatermarkAlign::Center => ((extent as f32 - size as f32) / 2.0 + offset).floor() as i64,
            WatermarkAlign::End => extent as i64 - size as i64 - offset.floor() as i64,
        }
    };
    let (horizontal, vertical) = settings.anchor.alignment();
    Some(WatermarkRect {
        x: place(horizontal, canvas_w, width, settings.offset_x),
        y: place(vertical, canvas_h, height, settings.offset_y),
        width,
        height,
    })
}

fn load_watermark(source: &WatermarkSource) -> Result<Arc<Watermark>, String> {
    let key = SourceKey::of(source);
    let mut cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.as_ref()
        && key.is_cacheable()
        && entry.key == key
    {
        return Ok(Arc::clone(&entry.watermark));
    }
    let watermark = Arc::new(Watermark::load(source)?);
    *cache = Some(WatermarkCacheEntry {
        key,
        watermark: Arc::clone(&watermark),
        prepared: Vec::new(),
    });
    Ok(watermark)
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

fn prepare_watermark(watermark: &Watermark, key: PreparedKey) -> PreparedWatermark {
    let scaled = in_color_space(watermark.scaled(key.width, key.height), key.color_space);
    match key.depth {
        SampleDepth::Eight => {
            let mut rgba = scaled.to_rgba8();
            for pixel in rgba.pixels_mut() {
                pixel[3] = (pixel[3] as f32 * key.opacity).round() as u8;
            }
            PreparedWatermark::Eight(rgba)
        }
        SampleDepth::Sixteen => {
            let mut rgba = scaled.to_rgba16();
            for pixel in rgba.pixels_mut() {
                pixel[3] = (pixel[3] as f32 * key.opacity).round() as u16;
            }
            PreparedWatermark::Sixteen(rgba)
        }
        SampleDepth::Float => {
            let mut rgba = scaled.to_rgba32f();
            for pixel in rgba.pixels_mut() {
                pixel[3] *= key.opacity;
            }
            PreparedWatermark::Float(rgba)
        }
    }
}

fn prepared_watermark(watermark: &Arc<Watermark>, key: PreparedKey) -> Arc<PreparedWatermark> {
    let is_current = |entry: &WatermarkCacheEntry| Arc::ptr_eq(&entry.watermark, watermark);
    {
        let cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.as_ref()
            && is_current(entry)
            && let Some((_, prepared)) = entry.prepared.iter().find(|(cached, _)| *cached == key)
        {
            return Arc::clone(prepared);
        }
    }
    let prepared = Arc::new(prepare_watermark(watermark, key));
    let mut cache = WATERMARK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.as_mut()
        && is_current(entry)
        && !entry.prepared.iter().any(|(cached, _)| *cached == key)
    {
        if entry.prepared.len() >= MAX_PREPARED_WATERMARKS {
            entry.prepared.remove(0);
        }
        entry.prepared.push((key, Arc::clone(&prepared)));
    }
    prepared
}

pub fn apply_watermark(
    base_image: &mut DynamicImage,
    watermark_settings: &WatermarkSettings,
    color_space: OutputColorSpace,
) -> Result<(), String> {
    let watermark = load_watermark(&watermark_settings.source)?;
    let (canvas_w, canvas_h) = base_image.dimensions();
    let (source_w, source_h) = watermark.dimensions();
    let Some(rect) = watermark_rect(canvas_w, canvas_h, source_w, source_h, watermark_settings)
    else {
        return Ok(());
    };

    let depth = match base_image {
        DynamicImage::ImageRgb16(_) | DynamicImage::ImageRgba16(_) => SampleDepth::Sixteen,
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_) => SampleDepth::Float,
        _ => SampleDepth::Eight,
    };
    let prepared = prepared_watermark(
        &watermark,
        PreparedKey {
            width: rect.width,
            height: rect.height,
            color_space,
            opacity: (watermark_settings.opacity / 100.0).clamp(0.0, 1.0),
            depth,
        },
    );

    let (x, y) = (rect.x, rect.y);
    match (prepared.as_ref(), base_image) {
        (PreparedWatermark::Eight(top), DynamicImage::ImageRgba8(base)) => {
            imageops::overlay(base, top, x, y)
        }
        (PreparedWatermark::Sixteen(top), DynamicImage::ImageRgba16(base)) => {
            imageops::overlay(base, top, x, y)
        }
        (PreparedWatermark::Float(top), DynamicImage::ImageRgba32F(base)) => {
            imageops::overlay(base, top, x, y)
        }
        (PreparedWatermark::Eight(top), base) => {
            let mut rgba = base.to_rgba8();
            imageops::overlay(&mut rgba, top, x, y);
            *base = DynamicImage::ImageRgba8(rgba);
        }
        (PreparedWatermark::Sixteen(top), base) => {
            let mut rgba = base.to_rgba16();
            imageops::overlay(&mut rgba, top, x, y);
            *base = DynamicImage::ImageRgba16(rgba);
        }
        (PreparedWatermark::Float(top), base) => {
            let mut rgba = base.to_rgba32f();
            imageops::overlay(&mut rgba, top, x, y);
            *base = DynamicImage::ImageRgba32F(rgba);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn load_watermark_preview(
    source: WatermarkSource,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let watermark = load_watermark(&source)?;
        let (width, height) = watermark.dimensions();
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(watermark.preview())
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(8 + png.len());
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&png);
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}
