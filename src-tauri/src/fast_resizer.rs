use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::{DynamicImage, GenericImageView, GrayImage, Rgb32FImage, RgbImage, Rgba32FImage, RgbaImage};
use std::sync::Arc;

/// Fast SIMD-accelerated image resizer using AVX2 / SSE4.1 / NEON.
pub fn fast_resize_rgb8(src: &RgbImage, dst_w: u32, dst_h: u32) -> RgbImage {
    let (src_w, src_h) = src.dimensions();
    if src_w == dst_w && src_h == dst_h {
        return src.clone();
    }
    let src_image = match ImageRef::new(src_w, src_h, src.as_raw(), PixelType::U8x3) {
        Ok(img) => img,
        Err(_) => return image::imageops::resize(src, dst_w, dst_h, image::imageops::FilterType::Lanczos3),
    };
    let mut dst_image = Image::new(dst_w, dst_h, PixelType::U8x3);
    let mut resizer = Resizer::new();
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    if resizer.resize(&src_image, &mut dst_image, &options).is_ok() {
        if let Some(buf) = RgbImage::from_raw(dst_w, dst_h, dst_image.into_vec()) {
            return buf;
        }
    }
    image::imageops::resize(src, dst_w, dst_h, image::imageops::FilterType::Lanczos3)
}

pub fn fast_resize_rgba8(src: &RgbaImage, dst_w: u32, dst_h: u32) -> RgbaImage {
    let (src_w, src_h) = src.dimensions();
    if src_w == dst_w && src_h == dst_h {
        return src.clone();
    }
    let src_image = match ImageRef::new(src_w, src_h, src.as_raw(), PixelType::U8x4) {
        Ok(img) => img,
        Err(_) => return image::imageops::resize(src, dst_w, dst_h, image::imageops::FilterType::Lanczos3),
    };
    let mut dst_image = Image::new(dst_w, dst_h, PixelType::U8x4);
    let mut resizer = Resizer::new();
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    if resizer.resize(&src_image, &mut dst_image, &options).is_ok() {
        if let Some(buf) = RgbaImage::from_raw(dst_w, dst_h, dst_image.into_vec()) {
            return buf;
        }
    }
    image::imageops::resize(src, dst_w, dst_h, image::imageops::FilterType::Lanczos3)
}

pub fn fast_resize_gray8(src: &GrayImage, dst_w: u32, dst_h: u32) -> GrayImage {
    let (src_w, src_h) = src.dimensions();
    if src_w == dst_w && src_h == dst_h {
        return src.clone();
    }
    let src_image = match ImageRef::new(src_w, src_h, src.as_raw(), PixelType::U8) {
        Ok(img) => img,
        Err(_) => return image::imageops::resize(src, dst_w, dst_h, image::imageops::FilterType::Triangle),
    };
    let mut dst_image = Image::new(dst_w, dst_h, PixelType::U8);
    let mut resizer = Resizer::new();
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear));
    if resizer.resize(&src_image, &mut dst_image, &options).is_ok() {
        if let Some(buf) = GrayImage::from_raw(dst_w, dst_h, dst_image.into_vec()) {
            return buf;
        }
    }
    image::imageops::resize(src, dst_w, dst_h, image::imageops::FilterType::Triangle)
}

pub fn fast_resize_rgb32f(src: &Rgb32FImage, dst_w: u32, dst_h: u32) -> Rgb32FImage {
    let (src_w, src_h) = src.dimensions();
    if src_w == dst_w && src_h == dst_h {
        return src.clone();
    }
    let raw_bytes: &[u8] = bytemuck::cast_slice(src.as_raw());
    let src_image = match ImageRef::new(src_w, src_h, raw_bytes, PixelType::F32x3) {
        Ok(img) => img,
        Err(_) => return fast_resize_rgb32f_fallback(src, dst_w, dst_h),
    };
    let mut dst_image = Image::new(dst_w, dst_h, PixelType::F32x3);
    let mut resizer = Resizer::new();
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    if resizer.resize(&src_image, &mut dst_image, &options).is_ok() {
        let float_vec: Vec<f32> = bytemuck::cast_slice(dst_image.buffer()).to_vec();
        if let Some(buf) = Rgb32FImage::from_raw(dst_w, dst_h, float_vec) {
            return buf;
        }
    }
    fast_resize_rgb32f_fallback(src, dst_w, dst_h)
}

pub fn fast_resize_rgba32f(src: &Rgba32FImage, dst_w: u32, dst_h: u32) -> Rgba32FImage {
    let (src_w, src_h) = src.dimensions();
    if src_w == dst_w && src_h == dst_h {
        return src.clone();
    }
    let raw_bytes: &[u8] = bytemuck::cast_slice(src.as_raw());
    let src_image = match ImageRef::new(src_w, src_h, raw_bytes, PixelType::F32x4) {
        Ok(img) => img,
        Err(_) => return fast_resize_rgba32f_fallback(src, dst_w, dst_h),
    };
    let mut dst_image = Image::new(dst_w, dst_h, PixelType::F32x4);
    let mut resizer = Resizer::new();
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    if resizer.resize(&src_image, &mut dst_image, &options).is_ok() {
        let float_vec: Vec<f32> = bytemuck::cast_slice(dst_image.buffer()).to_vec();
        if let Some(buf) = Rgba32FImage::from_raw(dst_w, dst_h, float_vec) {
            return buf;
        }
    }
    fast_resize_rgba32f_fallback(src, dst_w, dst_h)
}

fn fast_resize_rgb32f_fallback(src: &Rgb32FImage, dst_w: u32, dst_h: u32) -> Rgb32FImage {
    let dyn_img = DynamicImage::ImageRgb32F(src.clone());
    dyn_img.resize_exact(dst_w, dst_h, image::imageops::FilterType::Lanczos3).into_rgb32f()
}

fn fast_resize_rgba32f_fallback(src: &Rgba32FImage, dst_w: u32, dst_h: u32) -> Rgba32FImage {
    let dyn_img = DynamicImage::ImageRgba32F(src.clone());
    dyn_img.resize_exact(dst_w, dst_h, image::imageops::FilterType::Lanczos3).into_rgba32f()
}

/// Fast downscaler maintaining aspect ratio within max bounds
pub fn fast_downscale_dynamic(img: &DynamicImage, max_w: u32, max_h: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w <= max_w && h <= max_h {
        return img.clone();
    }
    let ratio = (max_w as f32 / w as f32).min(max_h as f32 / h as f32);
    let dst_w = ((w as f32 * ratio).round() as u32).max(1);
    let dst_h = ((h as f32 * ratio).round() as u32).max(1);

    match img {
        DynamicImage::ImageRgb32F(rgb) => DynamicImage::ImageRgb32F(fast_resize_rgb32f(rgb, dst_w, dst_h)),
        DynamicImage::ImageRgba32F(rgba) => DynamicImage::ImageRgba32F(fast_resize_rgba32f(rgba, dst_w, dst_h)),
        DynamicImage::ImageRgb8(rgb) => DynamicImage::ImageRgb8(fast_resize_rgb8(rgb, dst_w, dst_h)),
        DynamicImage::ImageRgba8(rgba) => DynamicImage::ImageRgba8(fast_resize_rgba8(rgba, dst_w, dst_h)),
        DynamicImage::ImageLuma8(luma) => DynamicImage::ImageLuma8(fast_resize_gray8(luma, dst_w, dst_h)),
        _ => img.resize(max_w, max_h, image::imageops::FilterType::Lanczos3),
    }
}

/// Multi-resolution preview pyramid for instant pan/zoom responsiveness
#[derive(Clone)]
pub struct MultiResPyramid {
    pub proxy_1080p: Arc<DynamicImage>,     // Level 0: 1920x1080
    pub proxy_2k: Arc<DynamicImage>,        // Level 1: 2560x1440
    pub proxy_4k: Arc<DynamicImage>,        // Level 2: 3840x2160
    pub proxy_native_8_7mp: Arc<DynamicImage>, // Level 3: 3600x2400
}

impl MultiResPyramid {
    pub fn build(full_res: &DynamicImage) -> Self {
        let p_1080 = Arc::new(fast_downscale_dynamic(full_res, 1920, 1080));
        let p_2k = Arc::new(fast_downscale_dynamic(full_res, 2560, 1440));
        let p_4k = Arc::new(fast_downscale_dynamic(full_res, 3840, 2160));
        let p_8_7mp = Arc::new(fast_downscale_dynamic(full_res, 3600, 2400));

        Self {
            proxy_1080p: p_1080,
            proxy_2k: p_2k,
            proxy_4k: p_4k,
            proxy_native_8_7mp: p_8_7mp,
        }
    }

    pub fn get_optimal_level(&self, target_dim: u32) -> Arc<DynamicImage> {
        if target_dim <= 1920 {
            Arc::clone(&self.proxy_1080p)
        } else if target_dim <= 2560 {
            Arc::clone(&self.proxy_2k)
        } else if target_dim <= 3600 {
            Arc::clone(&self.proxy_native_8_7mp)
        } else {
            Arc::clone(&self.proxy_4k)
        }
    }
}
