use image::{Rgb32FImage, Rgb};

#[test]
fn test_encode_linear_dng_and_tags() {
    let (w, h) = (64u32, 64u32);
    let mut img = Rgb32FImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            img.put_pixel(x, y, Rgb([0.5, 0.75, 1.2]));
        }
    }

    let meta = rapidraw_lib::dng_encoder::DngExportMetadata {
        make: Some("Canon".to_string()),
        model: Some("Canon EOS 77D".to_string()),
        software: Some("RapidRAW Studio".to_string()),
        description: Some("Linear DNG Float".to_string()),
        as_shot_neutral: Some([1.0, 1.0, 1.0]),
        baseline_exposure: Some(0.0),
        white_level: None,
    };

    let dng_bytes = rapidraw_lib::dng_encoder::encode_linear_dng(&img, Some(&meta)).expect("DNG encoding failed");
    assert!(!dng_bytes.is_empty());
    assert_eq!(&dng_bytes[0..4], &[b'I', b'I', 42, 0]);
}

#[test]
fn test_save_tiff_deflate_compression() {
    use tiff::encoder::{TiffEncoder, colortype::RGB32Float, Compression, DeflateLevel};
    let (w, h) = (100u32, 100u32);
    let mut img = Rgb32FImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            img.put_pixel(x, y, Rgb([0.2, 0.4, 0.8]));
        }
    }

    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut encoder = TiffEncoder::new(&mut cursor)
            .expect("TIFF encoder init failed")
            .with_compression(Compression::Deflate(DeflateLevel::default()));
        let tiff_image = encoder
            .new_image::<RGB32Float>(w, h)
            .expect("New image failed");
        tiff_image.write_data(img.as_raw()).expect("Write data failed");
    }

    let buf = cursor.into_inner();
    assert!(!buf.is_empty());
    println!("Compressed 100x100 TIFF size: {} bytes (Uncompressed: 120,000 bytes)", buf.len());
    assert!(buf.len() < 10000, "Deflate compression must dramatically reduce size");
}

#[test]
fn test_tiff_icc_profile_injection() {
    let (w, h) = (32u32, 32u32);
    let img = Rgb32FImage::new(w, h);
    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join("test_icc_injection.tiff");
    rapidraw_lib::export_processing::save_tiff_compressed(&temp_path, &img).expect("Save TIFF failed");

    let data = std::fs::read(&temp_path).expect("Read TIFF failed");
    assert!(data.len() > 8);
    let ifd_offset = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let num_tags = u16::from_le_bytes([data[ifd_offset], data[ifd_offset + 1]]) as usize;
    let mut found_icc_tag = false;
    let mut cur = ifd_offset + 2;
    for _ in 0..num_tags {
        let tag = u16::from_le_bytes([data[cur], data[cur + 1]]);
        if tag == 34675 {
            found_icc_tag = true;
            break;
        }
        cur += 12;
    }
    let _ = std::fs::remove_file(&temp_path);
    assert!(found_icc_tag, "Tag 34675 (ICC Profile) must be present in IFD");
}

#[test]
#[ignore = "Full dataset render - use 'cargo run --release --bin render_all' for batch rendering"]
fn test_render_hdr_and_pano_targets() {
    let base_dir = std::path::PathBuf::from(r"D:\neapdirbti");

    // 1. Re-render IMG_4713_Hdr.tiff using tonemapped preview
    {
        let out_name = "IMG_4713_Hdr.tiff";
        let files = vec!["IMG_4712.CR2", "IMG_4713.CR2", "IMG_4714.CR2"];
        let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
        if file_paths.iter().all(|p| std::path::Path::new(p).exists()) {
            let settings = rapidraw_lib::app_settings::AppSettings::default();
            let mut frames = rapidraw_lib::hdr_deghosting::load_hdr_frames::<tauri::Wry>(&file_paths, None, &settings).unwrap();
            let ref_idx = rapidraw_lib::hdr_deghosting::select_best_reference_index(&frames);
            rapidraw_lib::hdr_deghosting::align_hdr_frames::<tauri::Wry>(&mut frames, None);
            rapidraw_lib::hdr_deghosting::apply_reference_deghosting_mask::<tauri::Wry>(&mut frames, ref_idx, None, None, None);

            let rgb_frames: Vec<Rgb32FImage> = frames.iter().map(|f| f.1.to_rgb32f()).collect();
            let exposure_scales: Vec<f32> = frames.iter().map(|f| rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(f.2, f.3, f.4)).collect();

            let mut options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
            options.reference_index = Some(ref_idx);

            let fusion_result = rapidraw_lib::hdr_fusion::fuse_exposures_dual::<tauri::Wry>(&rgb_frames, &exposure_scales, &options, None, None).unwrap();
            let out_path = base_dir.join(out_name);

            rapidraw_lib::export_processing::save_tiff_compressed(&out_path, &fusion_result.tone_mapped_preview).unwrap();
            println!("Successfully re-rendered {}", out_name);
        }
    }

    // 2. Re-render IMG_4029_Pano.png with sRGB chunk
    {
        let out_name = "IMG_4029_Pano.png";
        let files = vec!["IMG_4029.CR2", "IMG_4030.CR2", "IMG_4031.CR2", "IMG_4032.CR2", "IMG_4033.CR2", "IMG_4034.CR2"];
        let file_paths: Vec<String> = files.iter().map(|f| base_dir.join(f).to_string_lossy().into_owned()).collect();
        if file_paths.iter().all(|p| std::path::Path::new(p).exists()) {
            let out_path = base_dir.join(out_name);
            let dyn_img = rapidraw_lib::panorama_stitching::stitch_images_headless(
                file_paths,
                rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
                0.5,
            ).unwrap();

            rapidraw_lib::export_processing::save_png_high_quality_with_metadata(&out_path, &dyn_img, None).unwrap();
            println!("Successfully re-rendered {}", out_name);
        }
    }
}
