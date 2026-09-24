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

/// Lightweight Two-Tier Screen Proxy for ultra-fast (120+ FPS) real-time slider adjustments
#[derive(Clone)]
pub struct ScreenProxy {
    pub image: Arc<DynamicImage>,
    pub width: u32,
    pub height: u32,
}

impl ScreenProxy {
    pub fn build(full_res: &DynamicImage, max_dim: u32) -> Self {
        let downscaled = fast_downscale_dynamic(full_res, max_dim, max_dim);
        let (w, h) = downscaled.dimensions();
        Self {
            image: Arc::new(downscaled),
            width: w,
            height: h,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn test_fast_resize_rgb8_exact() {
        let (w, h) = (100u32, 50u32);
        let mut src = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                src.put_pixel(x, y, Rgb([(x * 2) as u8, (y * 4) as u8, 128]));
            }
        }

        let dst = fast_resize_rgb8(&src, 50, 25);
        assert_eq!(dst.dimensions(), (50, 25));
        let p = dst.get_pixel(25, 12);
        assert_eq!(p[2], 128);
    }

    #[test]
    fn test_fast_resize_rgb32f_exact() {
        let (w, h) = (64u32, 64u32);
        let mut src = Rgb32FImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                src.put_pixel(x, y, Rgb([0.5, 0.25, 0.75]));
            }
        }

        let dst = fast_resize_rgb32f(&src, 32, 32);
        assert_eq!(dst.dimensions(), (32, 32));
        let p = dst.get_pixel(16, 16);
        assert!((p[0] - 0.5).abs() < 1e-4);
        assert!((p[1] - 0.25).abs() < 1e-4);
        assert!((p[2] - 0.75).abs() < 1e-4);
    }

    #[test]
    fn test_screen_proxy_dimensions() {
        let img = DynamicImage::ImageRgb8(RgbImage::new(4000, 3000));
        let proxy = ScreenProxy::build(&img, 1000);
        assert_eq!((proxy.width, proxy.height), (1000, 750));
    }
}
