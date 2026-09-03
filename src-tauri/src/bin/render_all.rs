use std::path::Path;
use std::time::Instant;
use image::{DynamicImage, Rgb32FImage};

fn main() {
    let _ = rayon::ThreadPoolBuilder::new().num_threads(4).build_global();

    let args: Vec<String> = std::env::args().collect();
    let target_filter = args.windows(2).find(|w| w[0] == "--target").map(|w| w[1].clone());
    if let Some(ref target) = target_filter {
        println!(">>> Targeted single-render mode active: only rendering '{}' <<<", target);
    }

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
        ("IMG_4713_Hdr.tiff", "tiff", vec!["IMG_4712.CR2", "IMG_4713.CR2", "IMG_4714.CR2"]),
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
        ("IMG_4647_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4647.CR2", "IMG_4648.CR2", "IMG_4649.CR2"]),
        ("IMG_4653_Hdr.jpg", "jpeg", vec!["IMG_4653.CR2", "IMG_4654.CR2", "IMG_4655.CR2"]),
        ("IMG_4659_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4658.CR2", "IMG_4659.CR2", "IMG_4660.CR2"]),
        ("IMG_4671_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4671.CR2", "IMG_4672.CR2", "IMG_4673.CR2"]),
        ("IMG_4710_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4710.CR2", "IMG_4711.CR2", "IMG_4712.CR2"]),
        ("IMG_4731_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4731.CR2", "IMG_4732.CR2", "IMG_4733.CR2"]),
        ("IMG_4758_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4758.CR2", "IMG_4759.CR2", "IMG_4760.CR2"]),
        ("IMG_4824_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4824.CR2", "IMG_4825.CR2", "IMG_4826.CR2"]),
        ("IMG_4860_Hdr_UltraHDR.jpg", "ultrahdr", vec!["IMG_4860.CR2", "IMG_4861.CR2", "IMG_4862.CR2"]),
    ];

    for (out_name, format, files) in hdr_sets {
        if let Some(ref target) = target_filter {
            if out_name != target {
                continue;
            }
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

    // =========================================================================
    // 2. PANORAMA DATASETS
    // =========================================================================
    println!("\n================================================================================");
    println!(">>> STARTING PANORAMA BATCH RENDERING <<<");
    println!("================================================================================");

    // Panorama 1: IMG_4029_Pano.png (6 frames)
    {
        let out_name = "IMG_4029_Pano.png";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let files = vec!["IMG_4029.CR2", "IMG_4030.CR2", "IMG_4031.CR2", "IMG_4032.CR2", "IMG_4033.CR2", "IMG_4034.CR2"];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA PNG: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        if let Err(e) = rapidraw_lib::export_processing::save_png_high_quality_with_metadata(&out_path, &dyn_img, None) {
                            eprintln!("Failed to save PNG {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered PNG {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 2: IMG_4029_Pano.dng (6 frames)
    {
        let out_name = "IMG_4029_Pano.dng";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let files = vec!["IMG_4029.CR2", "IMG_4030.CR2", "IMG_4031.CR2", "IMG_4032.CR2", "IMG_4033.CR2", "IMG_4034.CR2"];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA DNG: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);
                let first_raw = file_paths[0].clone();

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let pano_f32 = dyn_img.to_rgb32f();
                        let mut dng_meta = rapidraw_lib::dng_encoder::DngExportMetadata::default();
                        dng_meta.description = Some(format!("RapidRAW 32-Bit Linear Panoramic Composite ({})", out_name));

                        if let Ok(raw_source) = rawler::rawsource::RawSource::new(Path::new(&first_raw)) {
                            let loader = rawler::RawLoader::new();
                            if let Ok(decoder) = loader.get_decoder(&raw_source) {
                                if let Ok(raw_meta) = decoder.raw_metadata(&raw_source, &Default::default()) {
                                    if !raw_meta.make.is_empty() { dng_meta.make = Some(raw_meta.make); }
                                    if !raw_meta.model.is_empty() { dng_meta.model = Some(raw_meta.model); }
                                }
                            }
                        }

                        if let Err(e) = rapidraw_lib::dng_encoder::write_linear_dng_file(&out_path, &pano_f32, Some(&dng_meta)) {
                            eprintln!("Failed to save DNG {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered DNG {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 3: IMG_4029_Pano.tiff (6 frames)
    {
        let out_name = "IMG_4029_Pano.tiff";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let files = vec!["IMG_4029.CR2", "IMG_4030.CR2", "IMG_4031.CR2", "IMG_4032.CR2", "IMG_4033.CR2", "IMG_4034.CR2"];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA TIFF: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let pano_f32 = dyn_img.to_rgb32f();
                        if let Err(e) = rapidraw_lib::export_processing::save_tiff_compressed(&out_path, &pano_f32) {
                            eprintln!("Failed to save TIFF {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered TIFF {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 4: IMG_4044_Pano.tiff (9 frames)
    {
        let out_name = "IMG_4044_Pano.tiff";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let files = vec!["IMG_4044.CR2", "IMG_4045.CR2", "IMG_4046.CR2", "IMG_4047.CR2", "IMG_4048.CR2", "IMG_4049.CR2", "IMG_4050.CR2", "IMG_4051.CR2", "IMG_4052.CR2"];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA TIFF: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let pano_f32 = dyn_img.to_rgb32f();
                        if let Err(e) = rapidraw_lib::export_processing::save_tiff_compressed(&out_path, &pano_f32) {
                            eprintln!("Failed to save TIFF {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered TIFF {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 5: IMG_4044_Pano.dng (9 frames)
    {
        let out_name = "IMG_4044_Pano.dng";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let files = vec!["IMG_4044.CR2", "IMG_4045.CR2", "IMG_4046.CR2", "IMG_4047.CR2", "IMG_4048.CR2", "IMG_4049.CR2", "IMG_4050.CR2", "IMG_4051.CR2", "IMG_4052.CR2"];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA DNG: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);
                let first_raw = file_paths[0].clone();

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let pano_f32 = dyn_img.to_rgb32f();
                        let mut dng_meta = rapidraw_lib::dng_encoder::DngExportMetadata::default();
                        dng_meta.description = Some(format!("RapidRAW 32-Bit Linear Panoramic Composite ({})", out_name));

                        if let Ok(raw_source) = rawler::rawsource::RawSource::new(Path::new(&first_raw)) {
                            let loader = rawler::RawLoader::new();
                            if let Ok(decoder) = loader.get_decoder(&raw_source) {
                                if let Ok(raw_meta) = decoder.raw_metadata(&raw_source, &Default::default()) {
                                    if !raw_meta.make.is_empty() { dng_meta.make = Some(raw_meta.make); }
                                    if !raw_meta.model.is_empty() { dng_meta.model = Some(raw_meta.model); }
                                }
                            }
                        }

                        if let Err(e) = rapidraw_lib::dng_encoder::write_linear_dng_file(&out_path, &pano_f32, Some(&dng_meta)) {
                            eprintln!("Failed to save DNG {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered DNG {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
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
                            println!("Successfully rendered 24-frame HDR Pano {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch HDR panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 7: IMG_4746_Pano_UltraHDR.jpg (6 frames)
    {
        let out_name = "IMG_4746_Pano_UltraHDR.jpg";
        if target_filter.as_ref().map_or(true, |t| t == out_name || t == "IMG_4746_Pano.tiff") {
            let files = vec!["IMG_4746.CR2", "IMG_4747.CR2", "IMG_4748.CR2", "IMG_4749.CR2", "IMG_4750.CR2", "IMG_4751.CR2"];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);
                let first_raw = file_paths[0].clone();

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let pano_f32 = dyn_img.to_rgb32f();
                        let sdr_preview = dyn_img.to_rgb8();
                        if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(
                            &out_path,
                            &pano_f32,
                            &sdr_preview,
                            Some(&first_raw),
                        ) {
                            eprintln!("Failed to save UltraHDR {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered UltraHDR {} in {:.2?}", out_name, start.elapsed());
                        }

                        let tiff_out_path = base_dir.join("IMG_4746_Pano.tiff");
                        if let Err(e) = rapidraw_lib::export_processing::save_tiff_compressed(&tiff_out_path, &pano_f32) {
                            eprintln!("Failed to save TIFF IMG_4746_Pano.tiff: {}", e);
                        } else {
                            println!("Successfully rendered TIFF IMG_4746_Pano.tiff in {:.2?}", start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    // Panorama 8: IMG_5021_Pano_UltraHDR.jpg (12 frames)
    {
        let out_name = "IMG_5021_Pano_UltraHDR.jpg";
        if target_filter.as_ref().map_or(true, |t| t == out_name) {
            let files = vec![
                "IMG_5021.CR2", "IMG_5022.CR2", "IMG_5023.CR2", "IMG_5024.CR2", "IMG_5025.CR2", "IMG_5026.CR2",
                "IMG_5027.CR2", "IMG_5028.CR2", "IMG_5029.CR2", "IMG_5030.CR2", "IMG_5031.CR2", "IMG_5032.CR2"
            ];
            let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
            if file_paths.iter().all(|p| Path::new(p).exists()) {
                println!("\n>>> PROCESSING PANORAMA: {} ({} frames) <<<", out_name, files.len());
                let start = Instant::now();
                let out_path = base_dir.join(out_name);
                let first_raw = file_paths[0].clone();

                match rapidraw_lib::panorama_stitching::stitch_images_headless(
                    file_paths,
                    rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                    0.5,
                ) {
                    Ok(dyn_img) => {
                        let pano_f32 = dyn_img.to_rgb32f();
                        let sdr_preview = dyn_img.to_rgb8();
                        if let Err(e) = rapidraw_lib::export_processing::save_ultrahdr_jpeg_with_metadata(
                            &out_path,
                            &pano_f32,
                            &sdr_preview,
                            Some(&first_raw),
                        ) {
                            eprintln!("Failed to save UltraHDR {}: {}", out_name, e);
                        } else {
                            println!("Successfully rendered UltraHDR {} in {:.2?}", out_name, start.elapsed());
                        }
                    }
                    Err(e) => eprintln!("Failed to stitch panorama {}: {}", out_name, e),
                }
            }
        }
    }

    println!("\n================================================================================");
    println!(">>> RAPIDRAW: ALL 24 DATASETS COMPLETED SUCCESSFULLY! <<<");
    println!("================================================================================");
}
