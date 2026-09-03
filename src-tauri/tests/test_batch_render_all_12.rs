use std::path::Path;
use std::time::Instant;
use image::{DynamicImage, Rgb32FImage};

#[test]
fn test_batch_render_all_master_datasets() {
    let base_dir = Path::new(r"D:\neapdirbti");
    println!("Base dir exists: {}", base_dir.exists());
    if !base_dir.exists() {
        println!("Test directory D:\\neapdirbti does not exist. Skipping.");
        return;
    }

    let out_dir = base_dir;
    println!("Out dir: {:?}", out_dir);

    let settings = rapidraw_lib::app_settings::AppSettings::default();

    // 1. Single HDR Datasets (1 to 9)
    let hdr_sets = [
        ("IMG_4053_Certified.jpg", vec!["IMG_4053.CR2", "IMG_4054.CR2", "IMG_4055.CR2"]),
        ("IMG_4059_Certified.jpg", vec!["IMG_4059.CR2", "IMG_4060.CR2", "IMG_4061.CR2"]),
        ("IMG_3986_Certified.jpg", vec!["IMG_3986.CR2", "IMG_3987.CR2", "IMG_3988.CR2"]),
        ("IMG_3996_Certified.jpg", vec!["IMG_3996.CR2", "IMG_3997.CR2", "IMG_3998.CR2"]),
        ("IMG_3999_Certified.jpg", vec!["IMG_3999.CR2", "IMG_4000.CR2", "IMG_4001.CR2"]),
        ("IMG_4633_Certified.jpg", vec!["IMG_4633.CR2", "IMG_4634.CR2", "IMG_4635.CR2"]),
        ("IMG_4800_Certified.jpg", vec!["IMG_4800.CR2", "IMG_4801.CR2", "IMG_4802.CR2"]),
        ("IMG_4824_Certified.jpg", vec!["IMG_4824.CR2", "IMG_4825.CR2", "IMG_4826.CR2"]),
        ("IMG_4905_Certified.jpg", vec!["IMG_4905.CR2", "IMG_4906.CR2", "IMG_4907.CR2"]),
    ];

    for (out_name, files) in hdr_sets {
        let file_paths: Vec<String> = files
            .iter()
            .map(|f| base_dir.join(f).to_string_lossy().into_owned())
            .collect();

        let all_exist = file_paths.iter().all(|p| Path::new(p).exists());
        if !all_exist {
            println!("Skipping {} - some files missing: {:?}", out_name, file_paths);
            continue;
        }

        println!("------------------------------------------------------------");
        println!(">>> PROCESSING HDR SET: {} <<<", out_name);
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
        options.engine = Some(rapidraw_lib::hdr_fusion::HdrEngineMode::LinearRadiance);

        let fused = rapidraw_lib::hdr_fusion::fuse_exposures_mertens::<tauri::Wry>(
            &rgb_frames,
            &exposure_scales,
            &options,
            None,
            None,
        ).expect("Fusion failed");

        let sdr_preview = DynamicImage::ImageRgb32F(fused.clone()).to_rgb8();
        let out_path = out_dir.join(out_name);

        rapidraw_lib::export_processing::save_ultrahdr_jpeg(
            &out_path,
            &fused,
            &sdr_preview,
        ).expect("Failed to save UltraHDR JPEG");

        println!("Successfully rendered {} to {:?} in {:.2?}", out_name, out_path, start.elapsed());
    }
}
