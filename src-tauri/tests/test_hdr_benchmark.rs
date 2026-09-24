use image::{DynamicImage, ImageFormat, Rgb32FImage};
use std::fs;
use std::path::Path;
use std::time::Instant;

#[test]
fn test_hdr_all_benchmarks() {
    let base_dir = Path::new("D:/neapdirbti");
    if !base_dir.exists() {
        eprintln!("Test directory {:?} does not exist. Skipping benchmark.", base_dir);
        return;
    }

    let out_dir = base_dir.join("debug_hdr");
    let _ = fs::create_dir_all(&out_dir);

    let test_sets = [
        ("4002", vec!["IMG_4002.CR2", "IMG_4003.CR2", "IMG_4004.CR2"]),
        ("4068", vec!["IMG_4068.CR2", "IMG_4069.CR2", "IMG_4070.CR2"]),
        ("4659", vec!["IMG_4659.CR2", "IMG_4660.CR2", "IMG_4661.CR2"]),
        ("4821", vec!["IMG_4821.CR2", "IMG_4822.CR2", "IMG_4823.CR2"]),
        ("4515", vec!["IMG_4515.CR2", "IMG_4516.CR2", "IMG_4517.CR2"]),
        ("4221", vec!["IMG_4221.CR2", "IMG_4222.CR2", "IMG_4223.CR2"]),
    ];

    let settings = rapidraw_lib::app_settings::AppSettings::default();

    for (name, files) in test_sets {
        let file_paths: Vec<String> = files
            .iter()
            .map(|f| base_dir.join(f).to_string_lossy().into_owned())
            .collect();

        let all_exist = file_paths.iter().all(|p| Path::new(p).exists());
        if !all_exist {
            println!("Skipping set {} - files not found", name);
            continue;
        }

        println!("============================================================");
        println!("TESTING HDR SET: {}", name);
        let start = Instant::now();

        let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
            Ok(f) => f,
            Err(e) => {
                panic!("Failed to load frames for set {}: {}", name, e);
            }
        };

        let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
        println!("Set {}: Selected best reference frame index: {}", name, ref_idx);

        println!("Set {}: Running 3-DoF Euclidean alignment...", name);
        rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);

        println!("Set {}: Running Dinic Graph-Cut deghosting...", name);
        rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);

        let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
        let exposure_scales: Vec<f32> = frames
            .iter()
            .map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4))
            .collect();

        // 1. Test Physical Linear Radiance Engine (Halo-Free, True 16+ EV)
        println!("Set {}: Running Linear Radiance Physical Engine...", name);
        let mut rad_options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
        rad_options.reference_index = Some(ref_idx);
        rad_options.engine = Some(rapidraw_lib::hdr_fusion::HdrEngineMode::LinearRadiance);

        let rad_fused = rapidraw_lib::hdr_fusion::fuse_exposures_mertens::<tauri::Wry>(
            &rgb_frames,
            &exposure_scales,
            &rad_options,
            None,
            None,
        ).expect("Linear Radiance fusion failed");

        let out_rad_tiff = out_dir.join(format!("{}_Hdr_LinearRadiance.tiff", name));
        let rad_dyn = DynamicImage::ImageRgb32F(rad_fused);
        let _ = rad_dyn.save_with_format(&out_rad_tiff, ImageFormat::Tiff);
        let out_rad_jpg = out_dir.join(format!("{}_Hdr_LinearRadiance_preview.jpg", name));
        let _ = rad_dyn.to_rgb8().save_with_format(&out_rad_jpg, ImageFormat::Jpeg);
        println!("Saved Linear Radiance to {:?}", out_rad_jpg);

        // 2. Test Fixed Mertens Guided Filter Engine
        println!("Set {}: Running Mertens Guided Filter Engine...", name);
        let mut mertens_options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
        mertens_options.reference_index = Some(ref_idx);
        mertens_options.engine = Some(rapidraw_lib::hdr_fusion::HdrEngineMode::MertensLaplacian);

        let mertens_fused = rapidraw_lib::hdr_fusion::fuse_exposures_mertens::<tauri::Wry>(
            &rgb_frames,
            &exposure_scales,
            &mertens_options,
            None,
            None,
        ).expect("Mertens fusion failed");

        let out_mertens_tiff = out_dir.join(format!("{}_Hdr_MertensGuided.tiff", name));
        let mertens_dyn = DynamicImage::ImageRgb32F(mertens_fused);
        let _ = mertens_dyn.save_with_format(&out_mertens_tiff, ImageFormat::Tiff);
        let out_mertens_jpg = out_dir.join(format!("{}_Hdr_MertensGuided_preview.jpg", name));
        let _ = mertens_dyn.to_rgb8().save_with_format(&out_mertens_jpg, ImageFormat::Jpeg);
        println!("Saved Mertens Guided to {:?}", out_mertens_jpg);

        let elapsed = start.elapsed();
        println!("Set {} completed in {:.2?}", name, elapsed);
    }
}

#[test]
fn test_hdr_linear_radiance_focused() {
    let base_dir = Path::new("D:/neapdirbti");
    if !base_dir.exists() {
        return;
    }
    let out_dir = base_dir.join("debug_hdr");
    let _ = fs::create_dir_all(&out_dir);

    let test_sets = [
        ("4002", vec!["IMG_4002.CR2", "IMG_4003.CR2", "IMG_4004.CR2"]),
        ("4068", vec!["IMG_4068.CR2", "IMG_4069.CR2", "IMG_4070.CR2"]),
        ("4659", vec!["IMG_4659.CR2", "IMG_4660.CR2", "IMG_4661.CR2"]),
        ("4821", vec!["IMG_4821.CR2", "IMG_4822.CR2", "IMG_4823.CR2"]),
        ("4515", vec!["IMG_4515.CR2", "IMG_4516.CR2", "IMG_4517.CR2"]),
        ("4221", vec!["IMG_4221.CR2", "IMG_4222.CR2", "IMG_4223.CR2"]),
    ];

    let settings = rapidraw_lib::app_settings::AppSettings::default();

    for (name, files) in test_sets {
        let file_paths: Vec<String> = files
            .iter()
            .map(|f| base_dir.join(f).to_string_lossy().into_owned())
            .collect();

        println!("============================================================");
        println!("TESTING FOCUSED LINEAR RADIANCE: {}", name);
        let start = Instant::now();

        let mut frames = rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings).unwrap();
        let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
        rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
        rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);

        let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
        let exposure_scales: Vec<f32> = frames
            .iter()
            .map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4))
            .collect();

        let mut rad_options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
        rad_options.reference_index = Some(ref_idx);
        rad_options.engine = Some(rapidraw_lib::hdr_fusion::HdrEngineMode::LinearRadiance);

        let rad_fused = rapidraw_lib::hdr_fusion::fuse_exposures_mertens::<tauri::Wry>(
            &rgb_frames,
            &exposure_scales,
            &rad_options,
            None,
            None,
        ).unwrap();

        let out_rad_jpg = out_dir.join(format!("{}_Hdr_LinearRadiance_preview.jpg", name));
        let rad_dyn = DynamicImage::ImageRgb32F(rad_fused);
        let _ = rad_dyn.to_rgb8().save_with_format(&out_rad_jpg, ImageFormat::Jpeg);
        println!("Saved focused Linear Radiance to {:?} in {:.2?}", out_rad_jpg, start.elapsed());
    }
}
