use std::path::Path;
use rapidraw_lib::app_settings::AppSettings;
use rapidraw_lib::hugin_engine::{find_tool, run_hugin_hdr};

#[test]
fn test_hugin_tools_discovery() {
    println!("\n=== HUGIN ENGINE TOOLS DISCOVERY ===");
    let required_tools = [
        "align_image_stack",
        "enfuse",
        "pto_gen",
        "cpfind",
        "linefind",
        "autooptimiser",
        "pano_modify",
        "nona",
        "enblend",
    ];

    for tool in &required_tools {
        let path = find_tool(tool).unwrap_or_else(|e| panic!("Tool {} missing: {}", tool, e));
        println!("Found tool {:<20} -> {}", tool, path.display());
        assert!(path.exists(), "Tool binary must exist at resolved path");
    }
}

#[test]
fn test_hugin_hdr_merge_4002() {
    println!("\n=== HUGIN HDR MERGE TEST (IMG_4002 - IMG_4004) ===");
    let paths = vec![
        "D:/neapdirbti/IMG_4002.CR2".to_string(),
        "D:/neapdirbti/IMG_4003.CR2".to_string(),
        "D:/neapdirbti/IMG_4004.CR2".to_string(),
    ];

    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping live merge test.", p);
            return;
        }
    }

    let settings = AppSettings::default();
    let start_time = std::time::Instant::now();
    let hdr_result = run_hugin_hdr::<tauri::Wry>(&paths, &settings, false, None, None);

    assert!(hdr_result.is_ok(), "HDR merge must succeed: {:?}", hdr_result.err());
    let master_f32 = hdr_result.unwrap();
    let (w, h) = master_f32.dimensions();
    let elapsed = start_time.elapsed();

    println!("Master HDR fused in {:.1}s: {}x{} px", elapsed.as_secs_f32(), w, h);
    assert!(w > 5000, "Expected full-res width > 5000 px, got {}", w);
    assert!(h > 3500, "Expected full-res height > 3500 px, got {}", h);

    let _ = image::DynamicImage::ImageRgb32F(master_f32.clone())
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_HDR_4002.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_4002.jpg");

    // Verify dynamic range: check that pixel values span a valid range
    let raw_pixels = master_f32.as_raw();
    let min_val = raw_pixels.iter().copied().fold(f32::INFINITY, f32::min);
    let max_val = raw_pixels.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    println!("Dynamic Range: min={:.4}, max={:.4}", min_val, max_val);

    assert!(max_val > 0.1, "Max intensity must be positive");
    assert!(min_val >= 0.0, "Min intensity must be non-negative");
}

#[test]
fn test_hugin_hdr_pano_4065() {
    println!("\n=== HUGIN HDR PANORAMA TEST (IMG_4065 - IMG_4088, 24 frames) ===");
    let paths: Vec<String> = (4065..=4088)
        .map(|i| format!("D:/neapdirbti/IMG_{}.CR2", i))
        .collect();

    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping live HDR pano test.", p);
            return;
        }
    }

    let settings = AppSettings::default();
    let start_time = std::time::Instant::now();
    // Use half_size = true for fast regression verification of 24-frame stitch and duplicate angle pruning
    let pano_result = rapidraw_lib::hugin_engine::run_hugin_hdr_panorama::<tauri::Wry>(
        &paths,
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        &settings,
        true,
        None,
        None,
    );

    assert!(pano_result.is_ok(), "HDR panorama must succeed: {:?}", pano_result.err());
    let master_pano = pano_result.unwrap();
    let (w, h) = master_pano.dimensions();
    let elapsed = start_time.elapsed();

    println!("Master HDR Panorama 4065-4088 stitched in {:.1}s: {}x{} px", elapsed.as_secs_f32(), w, h);
    let _ = image::DynamicImage::ImageRgb32F(master_pano)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_PANO_4065.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_PANO_4065.jpg");
    assert!(w > 2000, "Expected panoramic width > 2000 px, got {}", w);
    assert!(h > 500, "Expected panoramic height > 500 px, got {}", h);
}

#[test]
fn test_hugin_hdr_pano_5021() {
    println!("\n=== HUGIN HDR PANORAMA TEST (IMG_5021 - IMG_5032, 12 frames) ===");
    let paths: Vec<String> = (5021..=5032)
        .map(|i| format!("D:/neapdirbti/IMG_{}.CR2", i))
        .collect();

    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping live HDR pano test.", p);
            return;
        }
    }

    let settings = AppSettings::default();
    let start_time = std::time::Instant::now();
    let pano_result = rapidraw_lib::hugin_engine::run_hugin_hdr_panorama::<tauri::Wry>(
        &paths,
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        &settings,
        true,
        None,
        None,
    );

    assert!(pano_result.is_ok(), "HDR panorama 5021 must succeed: {:?}", pano_result.err());
    let master_pano = pano_result.unwrap();
    let (w, h) = master_pano.dimensions();
    let elapsed = start_time.elapsed();

    println!("Master HDR Panorama 5021 stitched in {:.1}s: {}x{} px", elapsed.as_secs_f32(), w, h);
    let _ = image::DynamicImage::ImageRgb32F(master_pano)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_PANO_5021.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_PANO_5021.jpg");
    assert!(w > 1500, "Expected half-size panoramic width > 1500 px, got {}", w);
    assert!(h > 500, "Expected half-size panoramic height > 500 px, got {}", h);
}

#[test]
fn test_hdr_set_4788() {
    println!("\n=== HDR TEST 2: IMG_4788 - IMG_4790 ===");
    let paths = vec![
        "D:/neapdirbti/IMG_4788.CR2".to_string(),
        "D:/neapdirbti/IMG_4789.CR2".to_string(),
        "D:/neapdirbti/IMG_4790.CR2".to_string(),
    ];
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = run_hugin_hdr::<tauri::Wry>(&paths, &settings, true, None, None);
    assert!(res.is_ok(), "HDR 4788-4790 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR 4788 fused in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_HDR_4788.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_4788.jpg");
}

#[test]
fn test_hdr_set_3973() {
    println!("\n=== HDR TEST 3: IMG_3973 - IMG_3975 ===");
    let paths = vec![
        "D:/neapdirbti/IMG_3973.CR2".to_string(),
        "D:/neapdirbti/IMG_3974.CR2".to_string(),
        "D:/neapdirbti/IMG_3975.CR2".to_string(),
    ];
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = run_hugin_hdr::<tauri::Wry>(&paths, &settings, true, None, None);
    assert!(res.is_ok(), "HDR 3973-3975 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR 3973 fused in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_HDR_3973.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_3973.jpg");
}

#[test]
fn test_pano_std_3980() {
    println!("\n=== PANORAMA TEST 1: IMG_3980 - IMG_3983 ===");
    let paths = vec![
        "D:/neapdirbti/IMG_3980.CR2".to_string(),
        "D:/neapdirbti/IMG_3981.CR2".to_string(),
        "D:/neapdirbti/IMG_3982.CR2".to_string(),
        "D:/neapdirbti/IMG_3983.CR2".to_string(),
    ];
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = rapidraw_lib::hugin_engine::run_hugin_panorama::<tauri::Wry>(
        &paths,
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        &settings,
        true,
        None,
        None,
        None,
    );
    assert!(res.is_ok(), "Panorama 3980-3983 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("Panorama 3980 stitched in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_PANO_3980.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_PANO_3980.jpg");
}

#[test]
fn test_pano_4746() {
    println!("\n=== HUGIN HDR PANORAMA TEST 4746 (IMG_4746 - IMG_4751, 6 frames) ===");
    let paths: Vec<String> = (4746..=4751)
        .map(|i| format!("D:/neapdirbti/IMG_{}.CR2", i))
        .collect();
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = rapidraw_lib::hugin_engine::run_hugin_hdr_panorama::<tauri::Wry>(
        &paths,
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        &settings,
        true,
        None,
        None,
    );
    assert!(res.is_ok(), "HDR panorama 4746 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR Pano 4746 stitched in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let dynamic_img = image::DynamicImage::ImageRgb32F(img);
    let _ = dynamic_img.to_rgb8().save("D:/neapdirbti/TEST_OUTPUT_HDR_4746.jpg");
    let _ = dynamic_img.to_rgb8().save("D:/neapdirbti/TEST_OUTPUT_PANO_4746.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_4746.jpg and TEST_OUTPUT_PANO_4746.jpg");
}

#[test]
fn test_hugin_hdr_pano_4029() {
    println!("\n=== HUGIN HDR PANORAMA TEST (IMG_4029 - IMG_4034, 6 frames, 2 angles) ===");
    let paths: Vec<String> = (4029..=4034)
        .map(|i| format!("D:/neapdirbti/IMG_{}.CR2", i))
        .collect();
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = rapidraw_lib::hugin_engine::run_hugin_hdr_panorama::<tauri::Wry>(
        &paths,
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        &settings,
        true,
        None,
        None,
    );
    assert!(res.is_ok(), "HDR panorama 4029-4034 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR Pano 4029 stitched in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_PANO_4029.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_PANO_4029.jpg");
}

#[test]
fn test_hugin_hdr_pano_4044() {
    println!("\n=== HUGIN HDR PANORAMA TEST (IMG_4044 - IMG_4052, 9 frames, 3 angles) ===");
    let paths: Vec<String> = (4044..=4052)
        .map(|i| format!("D:/neapdirbti/IMG_{}.CR2", i))
        .collect();
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = rapidraw_lib::hugin_engine::run_hugin_hdr_panorama::<tauri::Wry>(
        &paths,
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        &settings,
        true,
        None,
        None,
    );
    assert!(res.is_ok(), "HDR panorama 4044-4052 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR Pano 4044 stitched in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_PANO_4044.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_PANO_4044.jpg");
}

#[test]
fn test_hdr_set_4818() {
    println!("\n=== HDR TEST: IMG_4818 - IMG_4820 ===");
    let paths = vec![
        "D:/neapdirbti/IMG_4818.CR2".to_string(),
        "D:/neapdirbti/IMG_4819.CR2".to_string(),
        "D:/neapdirbti/IMG_4820.CR2".to_string(),
    ];
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = run_hugin_hdr::<tauri::Wry>(&paths, &settings, true, None, None);
    assert!(res.is_ok(), "HDR 4818-4820 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR 4818 fused in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_HDR_4818.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_4818.jpg");
}

#[test]
fn test_hdr_set_3999() {
    println!("\n=== HDR TEST: IMG_3999 - IMG_4001 ===");
    let paths = vec![
        "D:/neapdirbti/IMG_3999.CR2".to_string(),
        "D:/neapdirbti/IMG_4000.CR2".to_string(),
        "D:/neapdirbti/IMG_4001.CR2".to_string(),
    ];
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = run_hugin_hdr::<tauri::Wry>(&paths, &settings, true, None, None);
    assert!(res.is_ok(), "HDR 3999-4001 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR 3999 fused in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_HDR_3999.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_3999.jpg");
}

#[test]
fn test_hdr_set_4053() {
    println!("\n=== HDR TEST: IMG_4053 - IMG_4055 ===");
    let paths = vec![
        "D:/neapdirbti/IMG_4053.CR2".to_string(),
        "D:/neapdirbti/IMG_4054.CR2".to_string(),
        "D:/neapdirbti/IMG_4055.CR2".to_string(),
    ];
    for p in &paths {
        if !Path::new(p).exists() {
            println!("Test photo {} not found, skipping.", p);
            return;
        }
    }
    let settings = AppSettings::default();
    let start = std::time::Instant::now();
    let res = run_hugin_hdr::<tauri::Wry>(&paths, &settings, true, None, None);
    assert!(res.is_ok(), "HDR 4053-4055 must succeed: {:?}", res.err());
    let img = res.unwrap();
    println!("HDR 4053 fused in {:.1}s: {}x{} px", start.elapsed().as_secs_f32(), img.width(), img.height());
    let _ = image::DynamicImage::ImageRgb32F(img)
        .to_rgb8()
        .save("D:/neapdirbti/TEST_OUTPUT_HDR_4053.jpg");
    println!("Saved: D:/neapdirbti/TEST_OUTPUT_HDR_4053.jpg");
}

#[test]
fn test_all_user_hdrs() {
    println!("\n=== BATCH RUN OF ALL 19 USER HDR TARGETS ===");
    let hdr_sets: [(&str, &[u32]); 19] = [
        ("4089", &[4089, 4090, 4091]),
        ("4098", &[4098, 4099, 4100]),
        ("4818", &[4818, 4819, 4820]),
        ("3999", &[3999, 4000, 4001]),
        ("4788", &[4788, 4789, 4790]),
        ("4898", &[4899, 4900, 4901]),
        ("4932", &[4932, 4933, 4934]),
        ("3993", &[3993, 3994, 3995]),
        ("4425", &[4425, 4426, 4427]),
        ("4443", &[4443, 4444, 4445]),
        ("4497", &[4497, 4498, 4499]),
        ("4509", &[4509, 4510, 4511]),
        ("4563", &[4563, 4564, 4565]),
        ("4626", &[4626, 4627, 4628]),
        ("4851", &[4851, 4852, 4853]),
        ("4832", &[4833, 4834, 4835]),
        ("4770", &[4770, 4771, 4772]),
        ("4779", &[4779, 4780, 4781]),
        ("4782", &[4782, 4783, 4784]),
    ];

    let settings = AppSettings::default();
    for (name, ids) in hdr_sets {
        let paths: Vec<String> = ids.iter().map(|id| format!("D:/neapdirbti/IMG_{}.CR2", id)).collect();
        let exists = paths.iter().all(|p| Path::new(p).exists());
        if !exists {
            println!("Skipping HDR {}: missing files", name);
            continue;
        }

        let start = std::time::Instant::now();
        let res = run_hugin_hdr::<tauri::Wry>(&paths, &settings, true, None, None);
        assert!(res.is_ok(), "HDR {} must succeed: {:?}", name, res.err());
        let img = res.unwrap();
        let out_path = format!("D:/neapdirbti/TEST_OUTPUT_HDR_{}.jpg", name);
        let _ = image::DynamicImage::ImageRgb32F(img).to_rgb8().save(&out_path);
        println!("Fused HDR {:<5} in {:.1}s -> {}", name, start.elapsed().as_secs_f32(), out_path);
    }
}

#[test]
fn test_export_5021_scratch() {
    let settings = AppSettings::default();
    let out_tiff = std::path::Path::new("D:/neapdirbti/test_rapid_5021.tif");
    rapidraw_lib::hugin_engine::export_frame_to_scratch_tiff("D:/neapdirbti/IMG_5021.CR2", out_tiff, &settings, true).unwrap();
    println!("Exported D:/neapdirbti/test_rapid_5021.tif");
}

