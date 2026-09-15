use std::path::Path;
use std::time::Instant;
use image::{DynamicImage, Rgb32FImage};

fn main() {
    let _ = rayon::ThreadPoolBuilder::new().num_threads(4).build_global();

    let args: Vec<String> = std::env::args().collect();
    let target_filter = args.windows(2).find(|w| w[0] == "--target").map(|w| w[1].clone());
    let certified_only = args.iter().any(|a| a == "--certified-suite");
    let force = !args.iter().any(|a| a == "--skip-existing");
    if let Some(ref target) = target_filter {
        println!(">>> Targeted single-render mode active: only rendering '{}' (force: {}) <<<", target, force);
    } else if certified_only {
        println!(">>> CERTIFIED 16-DATASET INTEGRATION SUITE ACTIVE (force: {}) <<<", force);
    }

    let certified_suite_targets: [&str; 16] = [
        "IMG_4053_Certified.jpg",
        "IMG_4059_Certified.jpg",
        "IMG_4800_Certified.jpg",
        "IMG_4824_Certified.jpg",
        "IMG_4905_Certified.jpg",
        "IMG_4632_Certified.jpg",
        "IMG_4221_Certified.jpg",
        "IMG_4608_Certified.jpg",
        "Perseids_ISO6400.jpg",
        "Perseids_Extreme25600.jpg",
        "IMG_4053_Single.jpg",
        "IMG_4059_Single.jpg",
        "IMG_4130_Single.jpg",
        "IMG_4165_Single.jpg",
        "IMG_3986_Single.jpg",
        "IMG_5081_Single.jpg",
    ];

    let base_dir = Path::new(r"D:\neapdirbti");
    println!("Base dir exists: {}", base_dir.exists());
    if !base_dir.exists() {
        println!("Test directory D:\\neapdirbti does not exist. Exiting.");
        return;
    }

    let settings = rapidraw_lib::app_settings::AppSettings::default();

    println!("================================================================================");
    println!(">>> RAPIDRAW STUDIO: EXECUTING TARGETED/BATCH INTEGRATION SUITE <<<");
    println!("================================================================================");

    // =========================================================================
    // 1. SINGLE HDR BRACKET SETS (22 Datasets)
    // =========================================================================
    let hdr_sets = [
        ("IMG_4713_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4712.CR2", "IMG_4713.CR2", "IMG_4714.CR2"]),
        ("IMG_3986_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_3986.CR2", "IMG_3987.CR2", "IMG_3988.CR2"]),
        ("IMG_3996_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_3996.CR2", "IMG_3997.CR2", "IMG_3998.CR2"]),
        ("IMG_3999_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_3999.CR2", "IMG_4000.CR2", "IMG_4001.CR2"]),
        ("IMG_4014_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4014.CR2", "IMG_4015.CR2", "IMG_4016.CR2"]),
        ("IMG_4062_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4062.CR2", "IMG_4063.CR2", "IMG_4064.CR2"]),
        ("IMG_4110_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4110.CR2", "IMG_4111.CR2", "IMG_4112.CR2"]),
        ("IMG_4122_Hdr.jpg", "jpeg", vec!["IMG_4121.CR2", "IMG_4122.CR2", "IMG_4123.CR2"]),
        ("IMG_4497_Hdr.jpg", "jpeg", vec!["IMG_4497.CR2", "IMG_4498.CR2", "IMG_4499.CR2"]),
        ("IMG_4593_Hdr.jpg", "jpeg", vec!["IMG_4593.CR2", "IMG_4594.CR2", "IMG_4595.CR2"]),
        ("IMG_4605_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4605.CR2", "IMG_4606.CR2", "IMG_4607.CR2"]),
        ("IMG_4608_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4608.CR2", "IMG_4609.CR2", "IMG_4610.CR2"]),
        ("IMG_4632_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4632.CR2", "IMG_4633.CR2", "IMG_4634.CR2", "IMG_4635.CR2"]),
        ("IMG_4632_Certified.jpg", "ultrahdr", vec!["IMG_4632.CR2", "IMG_4633.CR2", "IMG_4634.CR2", "IMG_4635.CR2"]),
        ("IMG_4647_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4647.CR2", "IMG_4648.CR2", "IMG_4649.CR2"]),
        ("IMG_4653_Hdr.jpg", "jpeg", vec!["IMG_4653.CR2", "IMG_4654.CR2", "IMG_4655.CR2"]),
        ("IMG_4659_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4658.CR2", "IMG_4659.CR2", "IMG_4660.CR2"]),
        ("IMG_4671_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4671.CR2", "IMG_4672.CR2", "IMG_4673.CR2"]),
        ("IMG_4710_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4710.CR2", "IMG_4711.CR2", "IMG_4712.CR2"]),
        ("IMG_4731_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4731.CR2", "IMG_4732.CR2", "IMG_4733.CR2"]),
        ("IMG_4758_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4758.CR2", "IMG_4759.CR2", "IMG_4760.CR2"]),
        ("IMG_4818_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4818.CR2", "IMG_4819.CR2", "IMG_4820.CR2"]),
        ("IMG_4824_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4824.CR2", "IMG_4825.CR2", "IMG_4826.CR2"]),
        ("IMG_4824_Certified.jpg", "ultrahdr", vec!["IMG_4824.CR2", "IMG_4825.CR2", "IMG_4826.CR2"]),
        ("IMG_4860_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4860.CR2", "IMG_4861.CR2", "IMG_4862.CR2"]),
        ("IMG_4767_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4767.CR2", "IMG_4768.CR2", "IMG_4769.CR2"]),
        ("IMG_4842_Hdr.jpg", "jpeg", vec!["IMG_4842.CR2", "IMG_4843.CR2", "IMG_4844.CR2"]),
        ("IMG_4941_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4941.CR2", "IMG_4942.CR2", "IMG_4943.CR2"]),
        ("IMG_4002_Hdr.jpg", "jpeg", vec!["IMG_4002.CR2", "IMG_4003.CR2", "IMG_4004.CR2"]),
        ("IMG_4053_Certified.jpg", "ultrahdr", vec!["IMG_4053.CR2", "IMG_4054.CR2", "IMG_4055.CR2"]),
        ("IMG_4059_Certified.jpg", "ultrahdr", vec!["IMG_4059.CR2", "IMG_4060.CR2", "IMG_4061.CR2"]),
        ("IMG_4221_Hdr.jpg", "jpeg", vec!["IMG_4221.CR2", "IMG_4222.CR2", "IMG_4223.CR2"]),
        ("IMG_4221_Certified.jpg", "ultrahdr", vec!["IMG_4221.CR2", "IMG_4222.CR2", "IMG_4223.CR2"]),
        ("IMG_4224_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4224.CR2", "IMG_4225.CR2", "IMG_4226.CR2"]),
        ("IMG_4515_Hdr.jpg", "jpeg", vec!["IMG_4515.CR2", "IMG_4516.CR2", "IMG_4517.CR2"]),
        ("IMG_4800_Certified.jpg", "ultrahdr", vec!["IMG_4800.CR2", "IMG_4801.CR2", "IMG_4802.CR2"]),
        ("IMG_4821_Hdr.jpg", "jpeg", vec!["IMG_4821.CR2", "IMG_4822.CR2", "IMG_4823.CR2"]),
        ("IMG_4905_Certified.jpg", "ultrahdr", vec!["IMG_4905.CR2", "IMG_4906.CR2", "IMG_4907.CR2"]),
        ("IMG_4350_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4350.CR2", "IMG_4351.CR2", "IMG_4352.CR2"]),
        ("IMG_4128_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4128.CR2", "IMG_4129.CR2", "IMG_4130.CR2", "IMG_4131.CR2", "IMG_4132.CR2"]),
        ("IMG_4164_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4164.CR2", "IMG_4165.CR2", "IMG_4166.CR2"]),
        ("IMG_4245_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4245.CR2", "IMG_4246.CR2", "IMG_4247.CR2"]),
        ("IMG_4662_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4662.CR2", "IMG_4663.CR2", "IMG_4664.CR2"]),
        ("IMG_4734_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4734.CR2", "IMG_4735.CR2", "IMG_4736.CR2"]),
        ("IMG_4608_Certified.jpg", "ultrahdr", vec!["IMG_4608.CR2", "IMG_4609.CR2", "IMG_4610.CR2"]),
        ("IMG_4278_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4278.CR2", "IMG_4279.CR2", "IMG_4280.CR2"]),
        ("IMG_4290_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4290.CR2", "IMG_4291.CR2", "IMG_4292.CR2"]),
    ];

    for (out_name, format, files) in hdr_sets {
        if let Some(ref target) = target_filter {
            if out_name != target {
                continue;
            }
        } else if certified_only {
            if !certified_suite_targets.contains(&out_name) {
                continue;
            }
        }
        let out_path = base_dir.join(out_name);
        if !force && out_path.exists() {
            println!("Skipping HDR {} (Already rendered)", out_name);
            continue;
        }
        let file_paths: Vec<String> = files
            .iter()
            .map(|f| base_dir.join(f).to_string_lossy().into_owned())
            .collect();

        let all_exist = file_paths.iter().all(|p| Path::new(p).exists());
        if !all_exist {
            println!("Skipping HDR {} - some files missing", out_name);
            continue;
        }

        println!("------------------------------------------------------------");
        println!(">>> PROCESSING HDR SET: {} ({} frames) <<<", out_name, files.len());
        let start = Instant::now();

        let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("Failed to load frames for {}: {}", out_name, e);
                continue;
            }
        };

        let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
        rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
        rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);

        let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
        let exposure_scales: Vec<f32> = frames
            .iter()
            .map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4))
            .collect();

        let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
        options.reference_index = Some(ref_idx);
        options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

        let fusion_result = match rapidraw_lib::hdr_fusion::fuse_exposures_dual::<tauri::Wry>(
            &rgb_frames,
            &exposure_scales,
            &options,
            None,
            None,
        ) {
            Ok(res) => res,
            Err(e) => {
                eprintln!("Fusion failed for {}: {}", out_name, e);
                continue;
            }
        };

        let sdr_preview = DynamicImage::ImageRgb32F(fusion_result.tone_mapped_preview.clone()).to_rgb8();
        let out_path = base_dir.join(out_name);
        let first_raw = &file_paths[ref_idx];

        match format {
            "ultrahdr" => {
                match rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(
                    &out_path,
                    &fusion_result.linear_radiance,
                    &sdr_preview,
                    Some(first_raw),
                ) {
                    Ok(()) => println!("Successfully rendered UltraHDR {} in {:.2?}", out_name, start.elapsed()),
                    Err(e) => eprintln!("Failed to save UltraHDR {}: {}", out_name, e),
                }
            }
            "jpeg" => {
                match rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(
                    &out_path,
                    &sdr_preview,
                    Some(first_raw),
                ) {
                    Ok(()) => println!("Successfully rendered JPEG {} in {:.2?}", out_name, start.elapsed()),
                    Err(e) => eprintln!("Failed to save JPEG {}: {}", out_name, e),
                }
            }
            "tiff" => {
                match rapidraw_lib::export_processing::save_tiff_compressed(
                    &out_path,
                    &fusion_result.tone_mapped_preview,
                ) {
                    Ok(()) => println!("Successfully rendered TIFF {} in {:.2?}", out_name, start.elapsed()),
                    Err(e) => eprintln!("Failed to save TIFF {}: {}", out_name, e),
                }
            }
            "png" => {
                match rapidraw_lib::export_processing::save_png_high_quality_with_metadata(
                    &out_path,
                    &DynamicImage::ImageRgb8(sdr_preview),
                    Some(first_raw),
                ) {
                    Ok(()) => println!("Successfully rendered PNG {} in {:.2?}", out_name, start.elapsed()),
                    Err(e) => eprintln!("Failed to save PNG {}: {}", out_name, e),
                }
            }
            _ => {}
        }
    }

    if !certified_only {
    // =========================================================================
    // 2. PANORAMA DATASETS
    // =========================================================================
    println!("\n================================================================================");
    println!(">>> STARTING PANORAMA BATCH RENDERING <<<");
    println!("================================================================================");

    // Panorama 1-3: IMG_4029_Pano (6 frames: 2 angles x 3-exposure brackets)
    {
        let out_name = "IMG_4029_Pano.jpg";
        let ultrahdr_name = "IMG_4029_Pano_UltraHDR.jpg";
        let targets = ["IMG_4029_Pano.jpg", "IMG_4029_Pano_UltraHDR.jpg", "IMG_4029_Pano.png", "IMG_4029_Pano.dng", "IMG_4029_Pano.tiff"];
        let should_render = target_filter.as_ref().map_or(true, |t| targets.contains(&t.as_str()));
        if should_render {
            let angle_groups = vec![
                vec!["IMG_4029.CR2", "IMG_4030.CR2", "IMG_4031.CR2"],
                vec!["IMG_4032.CR2", "IMG_4033.CR2", "IMG_4034.CR2"],
            ];
            let all_files: Vec<&str> = angle_groups.iter().flat_map(|g| g.iter().copied()).collect();
            let all_exist = all_files.iter().all(|f| base_dir.join(f).exists());

            if all_exist {
                println!("\n>>> PROCESSING 6-FRAME (2-ANGLE) HDR PANORAMA: IMG_4029_Pano <<<");
                let start = Instant::now();

                let mut hdr_panels: Vec<Rgb32FImage> = Vec::new();
                for (g_idx, group) in angle_groups.iter().enumerate() {
                    let file_paths: Vec<String> = group.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
                    let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                        Ok(f) => f,
                        Err(e) => {
                            eprintln!("Failed to load frames for angle {}: {}", g_idx, e);
                            continue;
                        }
                    };
                    let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
                    rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
                    rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);
                    let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                    let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
                    let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                    options.reference_index = Some(ref_idx);
                    options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

                    if let Ok(fused) = rapidraw_lib::hdr_fusion::fuse_exposures_linear_radiance::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                        println!("  - Merged HDR angle {} of {}", g_idx + 1, angle_groups.len());
                        hdr_panels.push(fused);
                    }
                }

                if hdr_panels.len() >= 2 {
                    match rapidraw_lib::hdr_panorama::stitch_hdr_panels(
                        &hdr_panels,
                        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                        0.5,
                        Some((24.0, Some(8.0))),
                        None,
                    ) {
                        Ok(stitched_hdr) => {
                            let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(
                                &stitched_hdr,
                                &rapidraw_lib::hdr_fusion::HdrMergeOptions::default(),
                                None,
                            );
                            let sdr_preview = DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                            let first_raw = base_dir.join("IMG_4029.CR2").to_string_lossy().into_owned();

                            let jpg_path = base_dir.join(out_name);
                            if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(&jpg_path, &sdr_preview, Some(&first_raw)) {
                                eprintln!("Failed to save JPEG {}: {}", out_name, e);
                            } else {
                                println!("Successfully rendered JPEG {} in {:.2?}", out_name, start.elapsed());
                            }

                            let ultrahdr_path = base_dir.join(ultrahdr_name);
                            if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(&ultrahdr_path, &stitched_hdr, &sdr_preview, Some(&first_raw)) {
                                eprintln!("Failed to save UltraHDR {}: {}", ultrahdr_name, e);
                            } else {
                                println!("Successfully rendered UltraHDR {} in {:.2?}", ultrahdr_name, start.elapsed());
                            }
                        }
                        Err(e) => eprintln!("Failed to stitch HDR panorama IMG_4029_Pano: {}", e),
                    }
                }
            }
        }
    }

    // Panorama 4-5: IMG_4044_Pano (6 frames: 2 valid angles x 3-exposure brackets: [4047-4049], [4050-4052])
    {
        let out_name = "IMG_4044_Pano.jpg";
        let ultrahdr_name = "IMG_4044_Pano_UltraHDR.jpg";
        let targets = ["IMG_4044_Pano.jpg", "IMG_4044_Pano_UltraHDR.jpg", "IMG_4044_Pano.tiff", "IMG_4044_Pano.dng"];
        let should_render = target_filter.as_ref().map_or(true, |t| targets.contains(&t.as_str()));
        if should_render {
            let angle_groups = vec![
                vec!["IMG_4047.CR2", "IMG_4048.CR2", "IMG_4049.CR2"],
                vec!["IMG_4050.CR2", "IMG_4051.CR2", "IMG_4052.CR2"],
            ];
            let all_files: Vec<&str> = angle_groups.iter().flat_map(|g| g.iter().copied()).collect();
            let all_exist = all_files.iter().all(|f| base_dir.join(f).exists());

            if all_exist {
                println!("\n>>> PROCESSING 6-FRAME (2-ANGLE) HDR PANORAMA: IMG_4044_Pano <<<");
                let start = Instant::now();

                let mut hdr_panels: Vec<Rgb32FImage> = Vec::new();
                for (g_idx, group) in angle_groups.iter().enumerate() {
                    let file_paths: Vec<String> = group.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
                    let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                        Ok(f) => f,
                        Err(e) => {
                            eprintln!("Failed to load frames for angle {}: {}", g_idx, e);
                            continue;
                        }
                    };
                    let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
                    rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
                    rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);
                    let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                    let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
                    let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                    options.reference_index = Some(ref_idx);
                    options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

                    if let Ok(fused) = rapidraw_lib::hdr_fusion::fuse_exposures_linear_radiance::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                        println!("  - Merged HDR angle {} of {}", g_idx + 1, angle_groups.len());
                        hdr_panels.push(fused);
                    }
                }

                if hdr_panels.len() >= 2 {
                    match rapidraw_lib::hdr_panorama::stitch_hdr_panels(
                        &hdr_panels,
                        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                        0.5,
                        Some((24.0, Some(8.0))),
                        None,
                    ) {
                        Ok(stitched_hdr) => {
                            let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(
                                &stitched_hdr,
                                &rapidraw_lib::hdr_fusion::HdrMergeOptions::default(),
                                None,
                            );
                            let sdr_preview = DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                            let first_raw = base_dir.join("IMG_4047.CR2").to_string_lossy().into_owned();

                            let jpg_path = base_dir.join(out_name);
                            if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(&jpg_path, &sdr_preview, Some(&first_raw)) {
                                eprintln!("Failed to save JPEG {}: {}", out_name, e);
                            } else {
                                println!("Successfully rendered JPEG {} in {:.2?}", out_name, start.elapsed());
                            }

                            let ultrahdr_path = base_dir.join(ultrahdr_name);
                            if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(&ultrahdr_path, &stitched_hdr, &sdr_preview, Some(&first_raw)) {
                                eprintln!("Failed to save UltraHDR {}: {}", ultrahdr_name, e);
                            } else {
                                println!("Successfully rendered UltraHDR {} in {:.2?}", ultrahdr_name, start.elapsed());
                            }
                        }
                        Err(e) => eprintln!("Failed to stitch HDR panorama IMG_4044_Pano: {}", e),
                    }
                }
            }
        }
    }

    // Panorama 6: IMG_4065_Pano_UltraHDR.jpg (FULL 24 frames: 8 angles x 3-exposure brackets)
    {
        let out_name = "IMG_4065_Pano_UltraHDR.jpg";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let angle_groups = vec![
                vec!["IMG_4065.CR2", "IMG_4066.CR2", "IMG_4067.CR2"],
                vec!["IMG_4068.CR2", "IMG_4069.CR2", "IMG_4070.CR2"],
                vec!["IMG_4071.CR2", "IMG_4072.CR2", "IMG_4073.CR2"],
                vec!["IMG_4074.CR2", "IMG_4075.CR2", "IMG_4076.CR2"],
                vec!["IMG_4077.CR2", "IMG_4078.CR2", "IMG_4079.CR2"],
                vec!["IMG_4080.CR2", "IMG_4081.CR2", "IMG_4082.CR2"],
                vec!["IMG_4083.CR2", "IMG_4084.CR2", "IMG_4085.CR2"],
                vec!["IMG_4086.CR2", "IMG_4087.CR2", "IMG_4088.CR2"],
            ];

            println!("\n>>> PROCESSING FULL 24-FRAME (8-ANGLE) HDR PANORAMA: {} <<<", out_name);
            let start = Instant::now();
            let out_path = base_dir.join(out_name);

            let mut hdr_panels: Vec<Rgb32FImage> = Vec::new();
            for (g_idx, group) in angle_groups.iter().enumerate() {
                let file_paths: Vec<String> = group.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
                let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!("Failed to load frames for angle {}: {}", g_idx, e);
                        continue;
                    }
                };
                let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
                rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
                rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);
                let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
                let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                options.reference_index = Some(ref_idx);
                options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

                if let Ok(fused) = rapidraw_lib::hdr_fusion::fuse_exposures_linear_radiance::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                    println!("  - Merged HDR angle {} of {}", g_idx + 1, angle_groups.len());
                    hdr_panels.push(fused);
                }
            }

            if hdr_panels.len() >= 2 {
                match rapidraw_lib::hdr_panorama::stitch_hdr_panels(
                    &hdr_panels,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                    Some((24.0, Some(8.0))),
                    None,
                ) {
                    Ok(stitched_hdr) => {
                        let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(
                            &stitched_hdr,
                            &rapidraw_lib::hdr_fusion::HdrMergeOptions::default(),
                            None,
                        );
                        let sdr_preview = DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                        let first_raw = base_dir.join("IMG_4065.CR2").to_string_lossy().into_owned();

                        if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(
                            &out_path,
                            &stitched_hdr,
                            &sdr_preview,
                            Some(&first_raw),
                        ) {
                            eprintln!("Failed to save UltraHDR {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered 24-frame UltraHDR {} in {:.2?}", out_name, start.elapsed());
                        }

                        let jpg_out_path = base_dir.join("IMG_4065_Pano.jpg");
                        if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(
                            &jpg_out_path,
                            &sdr_preview,
                            Some(&first_raw),
                        ) {
                            eprintln!("Failed to save JPEG IMG_4065_Pano.jpg: {}", e);
                        } else {
                            println!("Successfully rendered JPEG IMG_4065_Pano.jpg in {:.2?}", start.elapsed());
                        }

                        let dng_out_path = base_dir.join("IMG_4065_Pano.dng");
                        let mut dng_meta = rapidraw_lib::dng_encoder::DngExportMetadata::default();
                        dng_meta.description = Some("RapidRAW 32-Bit Linear Panoramic Composite (IMG_4065_Pano.dng)".to_string());
                        if let Err(e) = rapidraw_lib::dng_encoder::write_linear_dng_file(&dng_out_path, &stitched_hdr, Some(&dng_meta)) {
                            eprintln!("Failed to save DNG IMG_4065_Pano.dng: {}", e);
                        } else {
                            println!("Successfully rendered DNG IMG_4065_Pano.dng in {:.2?}", start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch HDR panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 7: IMG_4746_Pano_UltraHDR.jpg (6 frames: 2 angles x 3-exposure brackets)
    {
        let out_name = "IMG_4746_Pano_UltraHDR.jpg";
        if target_filter.as_ref().map_or(true, |t| t == out_name || t == "IMG_4746_Pano.tiff") {
            let angle_groups = vec![
                vec!["IMG_4746.CR2", "IMG_4747.CR2", "IMG_4748.CR2"],
                vec!["IMG_4749.CR2", "IMG_4750.CR2", "IMG_4751.CR2"],
            ];

            let all_files: Vec<&str> = angle_groups.iter().flat_map(|g| g.iter().copied()).collect();
            let all_exist = all_files.iter().all(|f| base_dir.join(f).exists());

            if all_exist {
                println!("\n>>> PROCESSING 6-FRAME (2-ANGLE) HDR PANORAMA: {} <<<", out_name);
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                let mut hdr_panels: Vec<Rgb32FImage> = Vec::new();
                for (g_idx, group) in angle_groups.iter().enumerate() {
                    let file_paths: Vec<String> = group.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
                    let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                        Ok(f) => f,
                        Err(e) => {
                            eprintln!("Failed to load frames for angle {}: {}", g_idx, e);
                            continue;
                        }
                    };
                    let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
                    rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
                    rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);
                    let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                    let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
                    let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                    options.reference_index = Some(ref_idx);
                    options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

                    if let Ok(fused) = rapidraw_lib::hdr_fusion::fuse_exposures_linear_radiance::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                        println!("  - Merged HDR angle {} of {}", g_idx + 1, angle_groups.len());
                        hdr_panels.push(fused);
                    }
                }

                if hdr_panels.len() >= 2 {
                    match rapidraw_lib::hdr_panorama::stitch_hdr_panels(
                        &hdr_panels,
                        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                        0.5,
                        None,
                        None,
                    ) {
                        Ok(stitched_hdr) => {
                            let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(
                                &stitched_hdr,
                                &rapidraw_lib::hdr_fusion::HdrMergeOptions::default(),
                                None,
                            );
                            let sdr_preview = DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                            let first_raw = base_dir.join("IMG_4746.CR2").to_string_lossy().into_owned();

                            if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(
                                &out_path,
                                &stitched_hdr,
                                &sdr_preview,
                                Some(&first_raw),
                            ) {
                                eprintln!("Failed to save UltraHDR {}: {}", out_name, e);
                            } else {
                                println!("Successfully rendered UltraHDR {} in {:.2?}", out_name, start.elapsed());
                            }

                            let tiff_out_path = base_dir.join("IMG_4746_Pano.tiff");
                            if let Err(e) = rapidraw_lib::export_processing::save_tiff_compressed(&tiff_out_path, &stitched_hdr) {
                                eprintln!("Failed to save TIFF IMG_4746_Pano.tiff: {}", e);
                            } else {
                                println!("Successfully rendered TIFF IMG_4746_Pano.tiff in {:.2?}", start.elapsed());
                            }
                        }
                        Err(e) => eprintln!("Failed to stitch HDR panorama {}: {}", out_name, e),
                    }
                }
            }
        }
    }

    // Panorama 8: IMG_5021_Pano_UltraHDR.jpg (12 frames: 4 angles x 3-exposure brackets)
    {
        let out_name = "IMG_5021_Pano_UltraHDR.jpg";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let angle_groups = vec![
                vec!["IMG_5021.CR2", "IMG_5022.CR2", "IMG_5023.CR2"],
                vec!["IMG_5024.CR2", "IMG_5025.CR2", "IMG_5026.CR2"],
                vec!["IMG_5027.CR2", "IMG_5028.CR2", "IMG_5029.CR2"],
                vec!["IMG_5030.CR2", "IMG_5031.CR2", "IMG_5032.CR2"],
            ];

            let all_files: Vec<&str> = angle_groups.iter().flat_map(|g| g.iter().copied()).collect();
            let all_exist = all_files.iter().all(|f| base_dir.join(f).exists());

            if all_exist {
                println!("\n>>> PROCESSING 12-FRAME (4-ANGLE) HDR PANORAMA: {} <<<", out_name);
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                let mut hdr_panels: Vec<Rgb32FImage> = Vec::new();
                for (g_idx, group) in angle_groups.iter().enumerate() {
                    let file_paths: Vec<String> = group.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
                    let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                        Ok(f) => f,
                        Err(e) => {
                            eprintln!("Failed to load frames for angle {}: {}", g_idx, e);
                            continue;
                        }
                    };
                    let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
                    rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
                    rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);
                    let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                    let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
                    let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                    options.reference_index = Some(ref_idx);
                    options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

                    if let Ok(fused) = rapidraw_lib::hdr_fusion::fuse_exposures_linear_radiance::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                        println!("  - Merged HDR angle {} of {}", g_idx + 1, angle_groups.len());
                        hdr_panels.push(fused);
                    }
                }

                if hdr_panels.len() >= 2 {
                    match rapidraw_lib::hdr_panorama::stitch_hdr_panels(
                        &hdr_panels,
                        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                        0.5,
                        None,
                        None,
                    ) {
                        Ok(stitched_hdr) => {
                            let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(
                                &stitched_hdr,
                                &rapidraw_lib::hdr_fusion::HdrMergeOptions::default(),
                                None,
                            );
                            let sdr_preview = DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                            let first_raw = base_dir.join("IMG_5021.CR2").to_string_lossy().into_owned();

                            if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(
                                &out_path,
                                &stitched_hdr,
                                &sdr_preview,
                                Some(&first_raw),
                            ) {
                                eprintln!("Failed to save UltraHDR {}: {}", out_name, e);
                            } else {
                                println!("Successfully rendered UltraHDR {} in {:.2?}", out_name, start.elapsed());
                            }
                        }
                        Err(e) => eprintln!("Failed to stitch HDR panorama {}: {}", out_name, e),
                    }
                }
            }
        }
    }

    // Panorama 9: IMG_5024_Pano.jpg (9 frames: 3 angles x 3-exposure brackets: 5024 -> 5032)
    {
        let out_name = "IMG_5024_Pano.jpg";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let angle_groups = vec![
                vec!["IMG_5024.CR2", "IMG_5025.CR2", "IMG_5026.CR2"],
                vec!["IMG_5027.CR2", "IMG_5028.CR2", "IMG_5029.CR2"],
                vec!["IMG_5030.CR2", "IMG_5031.CR2", "IMG_5032.CR2"],
            ];
            let all_files: Vec<&str> = angle_groups.iter().flat_map(|g| g.iter().copied()).collect();
            let all_exist = all_files.iter().all(|f| base_dir.join(f).exists());

            if all_exist {
                println!("\n>>> PROCESSING 9-FRAME (3-ANGLE) HDR PANORAMA JPEG: {} <<<", out_name);
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                let mut hdr_panels: Vec<Rgb32FImage> = Vec::new();
                for (g_idx, group) in angle_groups.iter().enumerate() {
                    let file_paths: Vec<String> = group.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
                    let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                        Ok(f) => f,
                        Err(e) => {
                            eprintln!("Failed to load frames for angle {}: {}", g_idx, e);
                            continue;
                        }
                    };
                    let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
                    rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
                    rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);
                    let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
                    let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
                    let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                    options.reference_index = Some(ref_idx);
                    options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

                    if let Ok(fused) = rapidraw_lib::hdr_fusion::fuse_exposures_linear_radiance::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                        println!("  - Merged HDR angle {} of {}", g_idx + 1, angle_groups.len());
                        hdr_panels.push(fused);
                    }
                }

                if hdr_panels.len() >= 2 {
                    match rapidraw_lib::hdr_panorama::stitch_hdr_panels(
                        &hdr_panels,
                        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                        0.5,
                        None,
                        None,
                    ) {
                        Ok(stitched_hdr) => {
                            let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(
                                &stitched_hdr,
                                &rapidraw_lib::hdr_fusion::HdrMergeOptions::default(),
                                None,
                            );
                            let sdr_preview = DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                            let first_raw = base_dir.join("IMG_5024.CR2").to_string_lossy().into_owned();

                            if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(
                                &out_path,
                                &sdr_preview,
                                Some(&first_raw),
                            ) {
                                eprintln!("Failed to save JPEG {}: {}", out_name, e);
                            } else {
                                println!("Successfully rendered JPEG {} in {:.2?}", out_name, start.elapsed());
                            }
                        }
                        Err(e) => eprintln!("Failed to stitch HDR panorama {}: {}", out_name, e),
                    }
                }
            }
        }
    }


    // Panorama 11: IMG_4350_Pano.jpg (12 frames: 4350 -> 4361)
    {
        let out_name = "IMG_4350_Pano.jpg";
        let targets = ["IMG_4350_Pano.jpg", "IMG_4350_Pano.tiff"];
        if target_filter.as_ref().map_or(true, |t| targets.contains(&t.as_str())) {
            let files: Vec<String> = (4350..=4361).map(|i| format!("IMG_{}.CR2", i)).collect();
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING 12-FRAME F/8 ARCHITECTURAL PANORAMA: {} <<<", out_name);
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths.clone(),
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let sdr_rgb8 = dyn_img.to_rgb8();
                        let first_raw = &file_paths[0];
                        if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(&out_path, &sdr_rgb8, Some(first_raw)) {
                            eprintln!("Failed to save JPEG {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered JPEG {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 12: IMG_4851_Pano.jpg (18 frames: 4851 -> 4868)
    {
        let out_name = "IMG_4851_Pano.jpg";
        let targets = ["IMG_4851_Pano.jpg", "IMG_4851_Pano.tiff"];
        if target_filter.as_ref().map_or(true, |t| targets.contains(&t.as_str())) {
            let files: Vec<String> = (4851..=4868).map(|i| format!("IMG_{}.CR2", i)).collect();
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING 18-FRAME 70MM HORIZON PANORAMA: {} <<<", out_name);
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths.clone(),
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let sdr_rgb8 = dyn_img.to_rgb8();
                        let first_raw = &file_paths[0];
                        if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(&out_path, &sdr_rgb8, Some(first_raw)) {
                            eprintln!("Failed to save JPEG {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered JPEG {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // =========================================================================
    // 3. MACRO FOCUS STACK DATASETS
    // =========================================================================
    println!("\n================================================================================");
    println!(">>> STARTING MACRO FOCUS STACK RENDERING <<<");
    println!("================================================================================");

    // Focus Stack 1: IMG_4932_Stacked.tiff (12 frames)
    {
        let out_name = "IMG_4932_Stacked.tiff";
        if target_filter.as_ref().map_or(true, |t| t == out_name || t == "IMG_4932_Stacked_preview.jpg") {
            let files = vec![
                "IMG_4932.CR2", "IMG_4933.CR2", "IMG_4934.CR2", "IMG_4935.CR2", "IMG_4936.CR2", "IMG_4937.CR2",
                "IMG_4938.CR2", "IMG_4939.CR2", "IMG_4940.CR2", "IMG_4941.CR2", "IMG_4942.CR2", "IMG_4943.CR2"
            ];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING FOCUS STACK: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                match rapidraw_lib::focus_stacking::stack_images_headless(&file_paths, &out_path) {
                    Ok(()) => {
                        println!("Successfully rendered Focus Stack {} in {:.2?}", out_name, start.elapsed());
                    }
                    Err(e) => eprintln!("Failed to stack focus frames {}: {}", out_name, e),
                }
            }
        }
    }
    }

    // =========================================================================
    // 4. SINGLE-SHOT EVERYDAY RAW DEVELOPMENT (6 Datasets)
    // =========================================================================
    println!("\n================================================================================");
    println!(">>> STARTING SINGLE-SHOT EVERYDAY RAW RENDERING <<<");
    println!("================================================================================");

    let perseoidai_dir = Path::new(r"D:\perseoidai - Copy");
    let single_raw_sets = [
        ("IMG_4053_Single.jpg", base_dir.join("IMG_4053.CR2")),
        ("IMG_4059_Single.jpg", base_dir.join("IMG_4059.CR2")),
        ("IMG_4130_Single.jpg", base_dir.join("IMG_4130.CR2")),
        ("IMG_4165_Single.jpg", base_dir.join("IMG_4165.CR2")),
        ("IMG_3986_Single.jpg", base_dir.join("IMG_3986.CR2")),
        ("IMG_5081_Single.jpg", perseoidai_dir.join("IMG_5081.CR2")),
    ];

    for (out_name, raw_path) in single_raw_sets {
        if let Some(ref target) = target_filter {
            if out_name != target {
                continue;
            }
        } else if certified_only {
            if !certified_suite_targets.contains(&out_name) {
                continue;
            }
        }
        if !raw_path.exists() {
            println!("Skipping Single RAW {} - file {:?} does not exist", out_name, raw_path);
            continue;
        }

        let out_path = if raw_path.starts_with(perseoidai_dir) {
            perseoidai_dir.join(out_name)
        } else {
            base_dir.join(out_name)
        };
        if !force && out_path.exists() {
            println!("Skipping Single RAW {} (Already rendered)", out_name);
            continue;
        }

        println!("------------------------------------------------------------");
        println!(">>> PROCESSING SINGLE RAW: {} from {:?} <<<", out_name, raw_path.file_name().unwrap());
        let start = Instant::now();
        let raw_path_str = raw_path.to_string_lossy().to_string();

        match std::fs::read(&raw_path) {
            Ok(bytes) => {
                match rapidraw_lib::image_loader::load_base_image_from_bytes(&bytes, &raw_path_str, false, &settings, None) {
                    Ok(dyn_img) => {
                        let rgb32f = dyn_img.to_rgb32f();
                        let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
                        let is_astro = raw_path.starts_with(perseoidai_dir);
                        options.detail_boost = Some(if is_astro { 1.00 } else { 1.20 });
                        let tone_mapped = rapidraw_lib::hdr_fusion::tone_map_radiance_image::<tauri::Wry>(&rgb32f, &options, None);
                        let sdr_rgb = image::DynamicImage::ImageRgb32F(tone_mapped).to_rgb8();
                        match rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(&out_path, &sdr_rgb, Some(&raw_path_str)) {
                            Ok(()) => println!("Successfully rendered Single RAW {} in {:.2?}", out_name, start.elapsed()),
                            Err(e) => eprintln!("Failed to save JPEG {}: {}", out_name, e),
                        }
                    }
                    Err(e) => eprintln!("Failed to develop RAW {}: {}", out_name, e),
                }
            }
            Err(e) => eprintln!("Failed to read RAW file {:?}: {}", raw_path, e),
        }
    }

    // =========================================================================
    // 5. ASTROPHOTOGRAPHY & PERSEID METEOR SHOWER (4 Datasets)
    // =========================================================================
    println!("\n================================================================================");
    println!(">>> STARTING ASTROPHOTOGRAPHY RENDERING <<<");
    println!("================================================================================");

    if perseoidai_dir.exists() {
        let astro_sets = [
            ("Perseids_Certified.jpg", vec!["IMG_5010.CR2", "IMG_5011.CR2", "IMG_5012.CR2", "IMG_5013.CR2", "IMG_5014.CR2", "IMG_5015.CR2", "IMG_5016.CR2"]),
            ("Perseids_Stack_10f.jpg", vec!["IMG_5034.CR2", "IMG_5035.CR2", "IMG_5036.CR2", "IMG_5037.CR2", "IMG_5038.CR2", "IMG_5039.CR2", "IMG_5040.CR2", "IMG_5041.CR2", "IMG_5042.CR2", "IMG_5043.CR2"]),
            ("Perseids_ISO6400.jpg", vec!["IMG_5081.CR2", "IMG_5082.CR2", "IMG_5083.CR2", "IMG_5084.CR2", "IMG_5085.CR2"]),
            ("Perseids_Extreme25600.jpg", vec!["IMG_5075.CR2", "IMG_5076.CR2", "IMG_5077.CR2"]),
        ];

        for (out_name, files) in astro_sets {
            if let Some(ref target) = target_filter {
                if out_name != target {
                    continue;
                }
            } else if certified_only {
                if !certified_suite_targets.contains(&out_name) {
                    continue;
                }
            }
            let out_path = perseoidai_dir.join(out_name);
            if !force && out_path.exists() {
                println!("Skipping Astro {} (Already rendered)", out_name);
                continue;
            }
            let file_paths: Vec<String> = files.iter().map(|f| perseoidai_dir.join(f).to_string_lossy().into_owned()).collect();
            if !file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("Skipping Astro {} - some files missing", out_name);
                continue;
            }

            println!("------------------------------------------------------------");
            println!(">>> PROCESSING ASTRO SET: {} ({} frames) <<<", out_name, files.len());
            let start = Instant::now();
            let mut frames = match rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("Failed to load astro frames for {}: {}", out_name, e);
                    continue;
                }
            };
            let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
            rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);

            let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
            let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();
            let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
            options.reference_index = Some(ref_idx);
            options.frame_isos = Some(frames.iter().map(|f| f.3).collect());

            if let Ok(fusion_result) = rapidraw_lib::hdr_fusion::fuse_exposures_dual::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None) {
                let sdr_preview = DynamicImage::ImageRgb32F(fusion_result.tone_mapped_preview).to_rgb8();
                let out_path = perseoidai_dir.join(out_name);
                let first_raw = &file_paths[ref_idx];

                if let Err(e) = rapidraw_lib::export_processing::save_jpeg_high_quality_with_metadata(&out_path, &sdr_preview, Some(first_raw)) {
                    eprintln!("Failed to save Astro JPEG {}: {}", out_name, e);
                } else {
                    println!("Successfully rendered Astro JPEG {} in {:.2?}", out_name, start.elapsed());
                }
            }
        }
    }

    println!("\n================================================================================");
    println!(">>> RAPIDRAW: ALL MASTER DATASETS COMPLETED SUCCESSFULLY! <<<");
    println!("================================================================================");
}

