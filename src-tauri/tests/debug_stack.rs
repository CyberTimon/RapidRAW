use std::fs;
use rapidraw_lib::app_settings::AppSettings;
use rapidraw_lib::image_loader::load_base_image_from_bytes;
use rapidraw_lib::astro_stacking::{AstroStackOptions, remove_background_gradient};
use image::{DynamicImage, Rgb, Rgb32FImage};

#[test]
fn test_verify_fixes_on_cr2() {
    let p1 = "D:\\neapdirbti\\IMG_5035.CR2";
    let p2 = "D:\\neapdirbti\\IMG_5036.CR2";
    let b1 = fs::read(p1).unwrap();
    let b2 = fs::read(p2).unwrap();
    let settings = AppSettings::default();

    let dyn1 = load_base_image_from_bytes(&b1, p1, false, &settings, None).unwrap();
    let dyn2 = load_base_image_from_bytes(&b2, p2, false, &settings, None).unwrap();
    let rgb1 = dyn1.to_rgb32f();
    let rgb2 = dyn2.to_rgb32f();

    let (w, h) = rgb1.dimensions();
    println!("=== VERIFYING FIXES ON CR2 FRAMES ===");
    println!("Resolution: {}x{}", w, h);

    // 1. Check background gradient removal without artificial lift
    let mut test_img = rgb1.clone();
    remove_background_gradient(&mut test_img, None);

    let orig_mean: f32 = rgb1.pixels().map(|p| 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]).sum::<f32>() / (w * h) as f32;
    let post_mean: f32 = test_img.pixels().map(|p| 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]).sum::<f32>() / (w * h) as f32;
    let orig_min: f32 = rgb1.pixels().map(|p| 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]).fold(1.0f32, f32::min);
    let post_min: f32 = test_img.pixels().map(|p| 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]).fold(1.0f32, f32::min);

    println!("Original RAW: Min = {:.6}, Mean = {:.6}", orig_min, orig_mean);
    println!("Post-Gradient Removal: Min = {:.6}, Mean = {:.6}", post_min, post_mean);

    assert!(post_min < 0.005, "Post gradient removal black point must not be artificially elevated above 0.005! Got: {}", post_min);
    assert!(post_mean < 0.015, "Post gradient removal mean luminance must preserve natural night darkness! Got: {}", post_mean);
    println!("  [SUCCESS] Black point and dynamic range are preserved!");
}
