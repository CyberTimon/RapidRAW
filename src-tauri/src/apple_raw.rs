use anyhow::Result;
use image::DynamicImage;

#[derive(Clone, Copy, Debug)]
pub struct Raw9Options {
    pub luminance_noise_reduction: Option<f32>,
    pub sharpness: f32,
}

impl Raw9Options {
    pub fn for_loading() -> Self {
        Self {
            luminance_noise_reduction: None,
            sharpness: 0.0,
        }
    }

    pub fn for_denoise(intensity: f32) -> Self {
        Self {
            luminance_noise_reduction: Some(intensity.clamp(0.0, 1.0)),
            sharpness: 0.0,
        }
    }
}

pub fn denoise_raw9(bytes: &[u8], path: &str, intensity: f32) -> Result<DynamicImage> {
    let img = develop_raw9(bytes, path, &Raw9Options::for_denoise(intensity))?;
    Ok(DynamicImage::ImageRgb32F(img.to_rgb32f()))
}

#[tauri::command]
pub async fn is_raw9_available(paths: Vec<String>) -> bool {
    if paths.is_empty() {
        return false;
    }
    tokio::task::spawn_blocking(move || {
        paths.iter().all(|p| {
            let (source_path, _) = crate::file_management::parse_virtual_path(p);
            let source = source_path.to_string_lossy();
            crate::formats::is_raw_file(&source_path) && is_raw9_supported_for_path(&source)
        })
    })
    .await
    .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn develop_raw9(_bytes: &[u8], _path: &str, _opts: &Raw9Options) -> Result<DynamicImage> {
    Err(anyhow::anyhow!("Apple RAW 9 is only available on macOS"))
}

#[cfg(not(target_os = "macos"))]
pub fn is_raw9_supported_for_path(_path: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
pub use imp::{develop_raw9, is_raw9_supported_for_path};

#[cfg(target_os = "macos")]
mod imp {
    use super::Raw9Options;
    use anyhow::{Result, anyhow};
    use image::{DynamicImage, ImageBuffer, Rgba};
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_core_foundation::CGRect;
    use objc2_core_graphics::{CGColorSpace, kCGColorSpaceExtendedLinearSRGB};
    use objc2_core_image::{
        CIContext, CIContextOption, CIRAWFilter, kCIContextCacheIntermediates, kCIFormatRGBAf,
    };
    use objc2_foundation::{NSData, NSDictionary, NSNumber, NSString, NSURL};
    use std::ptr::NonNull;
    use std::time::Instant;

    const RAW9_EXPOSURE_GAIN: f32 = 1.0;
    const FLIP_ROWS: bool = false;
    const MAX_LINEAR_VALUE: f32 = 10000.0;

    fn core_image_raw_available() -> bool {
        AnyClass::get(c"CIRAWFilter").is_some()
    }

    fn is_dng(path: &str) -> bool {
        path.to_ascii_lowercase().ends_with(".dng")
    }

    fn make_filter(bytes: Option<&[u8]>, path: &str) -> Option<Retained<CIRAWFilter>> {
        unsafe {
            if std::path::Path::new(path).exists() {
                let url = NSURL::fileURLWithPath(&NSString::from_str(path));
                if let Some(filter) = CIRAWFilter::filterWithImageURL(&url) {
                    return Some(filter);
                }
            }

            if let Some(bytes) = bytes {
                let data = NSData::with_bytes(bytes);
                if let Some(filter) = CIRAWFilter::filterWithImageData_identifierHint(&data, None) {
                    return Some(filter);
                }
            }
            
            None
        }
    }

    fn pick_raw9_version(filter: &CIRAWFilter, prefer_dng: bool) -> Option<Retained<NSString>> {
        let versions = unsafe { filter.supportedDecoderVersions() };

        let mut plain: Option<Retained<NSString>> = None;
        let mut dng: Option<Retained<NSString>> = None;
        let mut all = Vec::new();

        for version in versions.iter() {
            let s = version.to_string();
            all.push(s.clone());
            if !s.starts_with('9') {
                continue;
            }
            if s.to_ascii_lowercase().contains("dng") {
                dng = Some(version);
            } else {
                plain = Some(version);
            }
        }

        log::info!("CIRAWFilter supported decoder versions: {:?}", all);

        if prefer_dng { dng.or(plain) } else { plain.or(dng) }
    }

    fn configure(filter: &CIRAWFilter, opts: &Raw9Options) {
        unsafe {
            filter.setBoostAmount(0.0);
            filter.setBaselineExposure(0.0);
            filter.setExtendedDynamicRangeAmount(1.0);

            if filter.isLocalToneMapSupported() {
                filter.setLocalToneMapAmount(0.0);
            }
            if filter.isContrastSupported() {
                filter.setContrastAmount(0.0);
            }
            if filter.isSharpnessSupported() {
                filter.setSharpnessAmount(opts.sharpness);
            }
            if filter.isLensCorrectionSupported() {
                filter.setLensCorrectionEnabled(false);
            }
            if filter.isHighlightRecoverySupported() {
                filter.setHighlightRecoveryEnabled(true);
            }
            if let Some(amount) = opts.luminance_noise_reduction
                && filter.isLuminanceNoiseReductionSupported()
            {
                filter.setLuminanceNoiseReductionAmount(amount);
            }
        }
    }

    fn render_rgba_f32(filter: &CIRAWFilter) -> Result<DynamicImage> {
        unsafe {
            let image = filter
                .outputImage()
                .ok_or_else(|| anyhow!("CIRAWFilter produced no output image"))?;

            let extent: CGRect = image.extent();
            let width = extent.size.width.round() as usize;
            let height = extent.size.height.round() as usize;
            if width == 0 || height == 0 {
                return Err(anyhow!("CIRAWFilter output has an empty extent"));
            }

            let color_space = CGColorSpace::with_name(Some(kCGColorSpaceExtendedLinearSRGB))
                .ok_or_else(|| anyhow!("Could not create extended linear sRGB color space"))?;

            let cache_key: &CIContextOption = kCIContextCacheIntermediates;
            let no_cache = NSNumber::new_bool(false);
            let no_cache_obj: &AnyObject = &no_cache;
            let options = NSDictionary::from_slices(&[cache_key], &[no_cache_obj]);
            let context = CIContext::contextWithOptions(Some(&options));

            let row_bytes = width * 4 * std::mem::size_of::<f32>();
            let mut buf = vec![0f32; width * height * 4];
            let data_ptr = NonNull::new(buf.as_mut_ptr().cast())
                .ok_or_else(|| anyhow!("Failed to allocate RAW 9 render buffer"))?;

            context.render_toBitmap_rowBytes_bounds_format_colorSpace(
                &image,
                data_ptr,
                row_bytes as isize,
                extent,
                kCIFormatRGBAf,
                Some(&color_space),
            );

            if FLIP_ROWS {
                let row = width * 4;
                for y in 0..height / 2 {
                    let (top, bottom) = buf.split_at_mut((height - 1 - y) * row);
                    top[y * row..(y + 1) * row].swap_with_slice(&mut bottom[..row]);
                }
            }

            for px in buf.chunks_exact_mut(4) {
                px[0] = (px[0] * RAW9_EXPOSURE_GAIN).clamp(0.0, MAX_LINEAR_VALUE);
                px[1] = (px[1] * RAW9_EXPOSURE_GAIN).clamp(0.0, MAX_LINEAR_VALUE);
                px[2] = (px[2] * RAW9_EXPOSURE_GAIN).clamp(0.0, MAX_LINEAR_VALUE);
                px[3] = 1.0;
            }

            let buffer = ImageBuffer::<Rgba<f32>, _>::from_raw(width as u32, height as u32, buf)
                .ok_or_else(|| anyhow!("RAW 9 buffer size mismatch"))?;
            Ok(DynamicImage::ImageRgba32F(buffer))
        }
    }

    pub fn develop_raw9(bytes: &[u8], path: &str, opts: &Raw9Options) -> Result<DynamicImage> {
        if !core_image_raw_available() {
            return Err(anyhow!("CIRAWFilter is not available on this macOS version"));
        }

        autoreleasepool(|_| {
            let filter = make_filter(Some(bytes), path)
                .ok_or_else(|| anyhow!("Core Image could not open '{}' as a RAW file", path))?;

            let version = pick_raw9_version(&filter, is_dng(path)).ok_or_else(|| {
                anyhow!(
                    "Apple RAW 9 is not available for '{}' (requires macOS 27+ and a supported camera)",
                    path
                )
            })?;

            unsafe { filter.setDecoderVersion(&version) };
            configure(&filter, opts);

            let start = Instant::now();
            let image = render_rgba_f32(&filter)?;
            log::info!(
                "Apple RAW 9 ({}) developed '{}' ({}x{}) in {:?}",
                version,
                path,
                image.width(),
                image.height(),
                start.elapsed()
            );
            Ok(image)
        })
    }

    pub fn is_raw9_supported_for_path(path: &str) -> bool {
        if !core_image_raw_available() {
            return false;
        }
        autoreleasepool(|_| {
            make_filter(None, path)
                .map(|filter| pick_raw9_version(&filter, is_dng(path)).is_some())
                .unwrap_or(false)
        })
    }
}