use super::{analysis, render, storage, types::*};
use crate::{app_settings::AppSettings, image_processing::GpuContext};
use anyhow::Result;
use image::DynamicImage;
use std::{fs, sync::Mutex};

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
static DETECTOR: Mutex<Option<crate::people::models::Models>> = Mutex::new(None);

pub fn prepare(app: &tauri::AppHandle) -> Result<()> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut model = DETECTOR.lock().unwrap();
        if model.is_none() {
            *model = Some(tauri::async_runtime::block_on(crate::people::models::Models::detector_only(app))?);
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    anyhow::bail!("Subject detection is unavailable on this platform")
}
fn faces(image: &image::RgbImage) -> Result<Vec<Face>> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut model = DETECTOR.lock().unwrap();
        let model = model.as_mut().ok_or_else(|| anyhow::anyhow!("Face detector unavailable"))?;
        let mut detected = model.detect(image)?;
        if detected.is_empty() {
            // Detection-only exposure normalization; measurements still use the original render.
            let mut normalized = image.clone();
            let lookup: Vec<u8> =
                (0..=255).map(|v| ((v as f32 / 255.).powf(0.55) * 255.).round() as u8).collect();
            for pixel in normalized.pixels_mut() {
                for channel in &mut pixel.0 {
                    *channel = lookup[*channel as usize];
                }
            }
            detected = model.detect(&normalized)?;
        }
        Ok(detected
            .into_iter()
            .filter(|f| f.confidence >= 0.85)
            .take(32)
            .map(|f| Face { bounds: f.bounds, confidence: f.confidence, luma: 0. })
            .collect())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    anyhow::bail!("Face detector unavailable")
}
// Geometry and remaining manual edits affect the rendered analysis as well as decode settings.
fn key(e: &Entry) -> String {
    blake3::hash(
        format!("{VERSION}:{}:{}", e.fingerprint, super::correction::neutral(&e.baseline)).as_bytes(),
    )
    .to_hex()
    .to_string()
}
pub fn analyze(
    app: &tauri::AppHandle,
    e: &Entry,
    settings: &AppSettings,
    gpu: &GpuContext,
    reduced: bool,
) -> Result<Analysis> {
    let dir = storage::root(app)?.join("analysis");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", key(e)));
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(a) = serde_json::from_slice::<Analysis>(&bytes) {
            if a.reduced == reduced {
                return Ok(a);
            }
        }
    }
    let base = render::decode(&e.path, settings)?;
    let view = render::preview(app, &e.path, &base, gpu, super::correction::neutral(&e.baseline))?;
    let (source, _) = crate::file_management::parse_virtual_path(&e.path);
    let bytes = fs::read(&source)?;
    let iso = crate::exif_processing::read_iso(&source.to_string_lossy(), &bytes);
    let captured = crate::exif_processing::try_get_exif_creation_date(&source).map(|v| v.timestamp());
    let mut detected =
        if reduced { Err(anyhow::anyhow!("Detector unavailable")) } else { faces(&view.to_rgb8()) };
    if detected.as_ref().is_ok_and(|faces| faces.is_empty()) {
        // Retain profile/small-face detail without keeping large previews for the batch.
        let detail = crate::file_management::render_auto_preview(
            &e.path,
            Some(gpu),
            Some(&base),
            app,
            Some(1280),
            Some(crate::image_processing::ImageMetadata {
                adjustments: super::correction::neutral(&e.baseline),
                ..crate::image_processing::ImageMetadata::default()
            }),
        )?;
        detected = faces(&detail.to_rgb8());
    }
    let failed = detected.is_err();
    let a = analysis::measure(&view.to_rgb8(), detected.unwrap_or_default(), iso, captured, failed);
    storage::atomic(&path, &serde_json::to_vec(&a)?)?;
    Ok(a)
}
/// One-image look-ahead; full decoded images never accumulate with selection size.
pub fn prefetch<'a>(
    scope: &'a std::thread::Scope<'a, '_>,
    path: String,
    settings: AppSettings,
) -> std::thread::ScopedJoinHandle<'a, Result<DynamicImage>> {
    scope.spawn(move || render::decode(&path, &settings))
}
