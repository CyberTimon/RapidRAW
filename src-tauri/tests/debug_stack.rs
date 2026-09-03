use std::fs;
use rapidraw_lib::app_settings::AppSettings;
use rapidraw_lib::image_loader::load_base_image_from_bytes;
use rapidraw_lib::astro_stacking::{
    remove_background_gradient, suppress_cosmetic_hot_pixels,
    suppress_horizontal_shadow_banding, RigidTransform2D, warp_rigid_radial,
    calculate_subframe_quality, apply_celestial_photometric_white_balance,
    StarPoint
};

#[test]
fn test_verify_fixes_on_cr2() {
    let p1 = "D:\\neapdirbti\\IMG_5035.CR2";
    let p2 = "D:\\neapdirbti\\IMG_5036.CR2";
    let b1 = fs::read(p1).unwrap();
    let b2 = fs::read(p2).unwrap();
    let settings = AppSettings::default();

    let dyn1 = load_base_image_from_bytes(&b1, p1, false, &settings, None).unwrap();
    let dyn2 = load_base_image_from_bytes(&b2, p2, false, &settings, None).unwrap();
    let mut rgb1 = dyn1.to_rgb32f();
    let mut rgb2 = dyn2.to_rgb32f();

    let (w, h) = rgb1.dimensions();
    println!("=== VERIFYING FIXES ON CR2 FRAMES ===");
    println!("Resolution: {}x{}", w, h);

    // 1. Check hot pixel suppression
    suppress_cosmetic_hot_pixels(&mut rgb1);
    suppress_cosmetic_hot_pixels(&mut rgb2);
    println!("  [SUCCESS] Cosmetic hot-pixel filter applied cleanly.");

    // 2. Check Canon horizontal shadow banding filter
    suppress_horizontal_shadow_banding(&mut rgb1);
    suppress_horizontal_shadow_banding(&mut rgb2);
    println!("  [SUCCESS] Horizontal shadow banding filter applied cleanly.");

    // 3. Check subframe quality scoring
    let dummy_stars = vec![
        StarPoint { x: 500.0, y: 500.0, brightness: 0.8 },
        StarPoint { x: 1200.0, y: 1500.0, brightness: 0.6 },
        StarPoint { x: 3000.0, y: 2000.0, brightness: 0.9 },
        StarPoint { x: 4500.0, y: 1200.0, brightness: 0.75 },
    ];
    let q1 = calculate_subframe_quality(&rgb1, &dummy_stars);
    let q2 = calculate_subframe_quality(&rgb2, &dummy_stars);
    println!("  [SUCCESS] Subframe Quality Scores: Frame 1 = {:.3}, Frame 2 = {:.3}", q1, q2);
    assert!(q1 > 0.0 && q2 > 0.0);

    // 4. Check background gradient removal without artificial lift
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

    // 5. Test Photometric Color Calibration (PCC)
    apply_celestial_photometric_white_balance(&mut test_img, &dummy_stars);
    println!("  [SUCCESS] Photometric Color Calibration (PCC) applied cleanly.");

    // 6. Test radial distortion warp
    let trans = RigidTransform2D { dx: 14.0, dy: -10.0, dtheta: 0.0015 };
    let warped = warp_rigid_radial(&rgb2, trans, -0.02, w, h);
    assert_eq!(warped.dimensions(), (w, h));
    println!("  [SUCCESS] Radial distortion warp succeeded.");
}
