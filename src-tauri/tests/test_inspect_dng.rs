use std::fs;
use std::path::Path;
use rawler::{decoders::RawDecodeParams, rawsource::RawSource};

#[test]
fn test_inspect_img_3393_bracket() {
    let files = [
        "D:/100CANON/IMG_3390.CR2",
        "D:/100CANON/IMG_3391.CR2",
        "D:/100CANON/IMG_3392.CR2",
        "D:/100CANON/IMG_3393.CR2",
        "D:/100CANON/IMG_3394.CR2",
        "D:/100CANON/IMG_3395.CR2",
        "D:/100CANON/IMG_3396.CR2",
        "D:/100CANON/IMG_3397.CR2",
        "D:/100CANON/IMG_3398.CR2",
        "D:/100CANON/IMG_3399.CR2",
    ];
    for path in &files {
        if !Path::new(path).exists() {
            println!("Path not found: {}", path);
            continue;
        }
        let bytes = fs::read(path).expect("Failed to read");
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).expect("Failed to get decoder");
        let raw_image = decoder.raw_image(&source, &RawDecodeParams::default(), false).expect("raw image");
        let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default()).expect("raw metadata");

        println!("=== File: {} ===", path);
        println!("Dimensions: {}x{}", raw_image.width, raw_image.height);
        println!("Photometric: {:?}", raw_image.photometric);
        println!("Whitelevel: {:?}", raw_image.whitelevel);
        println!("Blacklevel: {:?}", raw_image.blacklevel);
        println!("WB Coeffs: {:?}", raw_image.wb_coeffs);
        println!("Exif ExposureTime: {:?}", metadata.exif.exposure_time);
        println!("Exif FNumber: {:?}", metadata.exif.fnumber);

        // Try developing with load_base_image_from_bytes
        let settings = rapidraw_lib::app_settings::AppSettings::default();
        let developed = rapidraw_lib::image_loader::load_base_image_from_bytes(&bytes, path, false, &settings, None)
            .expect("Failed to develop raw image");
        let rgb32f = developed.to_rgb32f();
        let raw = rgb32f.as_raw();
        let mut min_val = f32::MAX;
        let mut max_val = f32::MIN;
        let mut sum = 0.0f64;
        for &v in raw {
            min_val = min_val.min(v);
            max_val = max_val.max(v);
            sum += v as f64;
        }
        let avg = sum / raw.len() as f64;
        println!("Developed DynamicImage: Min = {}, Max = {}, Avg = {}", min_val, max_val, avg);
    }
}
