use std::fs;
use std::path::Path;
use image::GenericImageView;
use rawler::{decoders::RawDecodeParams, rawsource::RawSource};

#[test]
fn test_inspect_img_4029_pano_tiff() {
    let tiff_path = "D:/neapdirbti/IMG_4029_Pano.tiff";
    if !Path::new(tiff_path).exists() {
        println!("TIFF not found at {}", tiff_path);
        return;
    }

    let tiff_bytes = fs::read(tiff_path).expect("Failed to read TIFF");
    println!("=== PANO TIFF FILE INFO ===");
    println!("File Size: {} bytes ({:.2} MB)", tiff_bytes.len(), tiff_bytes.len() as f64 / 1_048_576.0);

    // Read with tiff decoder and image crate with no limits
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&tiff_bytes));
    reader.set_format(image::ImageFormat::Tiff);
    let mut limits = image::Limits::no_limits();
    limits.max_alloc = Some(2 * 1024 * 1024 * 1024); // 2 GB
    reader.limits(limits);
    let dyn_img = reader.decode().expect("Failed to load TIFF image with image-rs");
    let (width, height) = dyn_img.dimensions();
    let color_type = dyn_img.color();
    println!("Dimensions: {}x{} (Aspect Ratio: {:.3}:1)", width, height, width as f32 / height as f32);
    println!("Color Type: {:?}", color_type);

    // Pixel statistics
    match &dyn_img {
        image::DynamicImage::ImageRgba8(rgba) => {
            let mut transparent_pixels = 0usize;
            let mut solid_black_pixels = 0usize;
            let mut r_sum = 0u64;
            let mut g_sum = 0u64;
            let mut b_sum = 0u64;
            let total = (width * height) as usize;

            for p in rgba.pixels() {
                if p[3] == 0 {
                    transparent_pixels += 1;
                } else if p[0] == 0 && p[1] == 0 && p[2] == 0 {
                    solid_black_pixels += 1;
                } else {
                    r_sum += p[0] as u64;
                    g_sum += p[1] as u64;
                    b_sum += p[2] as u64;
                }
            }
            let valid = total - transparent_pixels;
            let avg_r = if valid > 0 { r_sum as f64 / valid as f64 } else { 0.0 };
            let avg_g = if valid > 0 { g_sum as f64 / valid as f64 } else { 0.0 };
            let avg_b = if valid > 0 { b_sum as f64 / valid as f64 } else { 0.0 };

            println!("Pixel Stats (RGBA8): Total={}, Transparent={:.2}%, Black Borders={:.2}%, Avg RGB=[{:.1}, {:.1}, {:.1}]",
                total, (transparent_pixels as f64 / total as f64) * 100.0,
                (solid_black_pixels as f64 / total as f64) * 100.0,
                avg_r, avg_g, avg_b);
        }
        image::DynamicImage::ImageRgb8(rgb) => {
            let mut black_pixels = 0usize;
            let mut r_sum = 0u64;
            let mut g_sum = 0u64;
            let mut b_sum = 0u64;
            let total = (width * height) as usize;

            for p in rgb.pixels() {
                if p[0] == 0 && p[1] == 0 && p[2] == 0 {
                    black_pixels += 1;
                } else {
                    r_sum += p[0] as u64;
                    g_sum += p[1] as u64;
                    b_sum += p[2] as u64;
                }
            }
            let valid = total - black_pixels;
            let avg_r = if valid > 0 { r_sum as f64 / valid as f64 } else { 0.0 };
            let avg_g = if valid > 0 { g_sum as f64 / valid as f64 } else { 0.0 };
            let avg_b = if valid > 0 { b_sum as f64 / valid as f64 } else { 0.0 };

            println!("Pixel Stats (RGB8 - NO ALPHA CHANNEL): Total={}, Black Borders={:.2}%, Avg RGB=[{:.1}, {:.1}, {:.1}]",
                total, (black_pixels as f64 / total as f64) * 100.0, avg_r, avg_g, avg_b);
        }
        image::DynamicImage::ImageRgb32F(rgb32f) => {
            let raw = rgb32f.as_raw();
            let mut min_val = f32::MAX;
            let mut max_val = f32::MIN;
            let mut sum = 0.0f64;
            let mut nan_cnt = 0;
            let mut inf_cnt = 0;
            let mut black_cnt = 0;

            for chunk in raw.chunks_exact(3) {
                let (r, g, b) = (chunk[0], chunk[1], chunk[2]);
                if r.is_nan() || g.is_nan() || b.is_nan() {
                    nan_cnt += 1;
                } else if r.is_infinite() || g.is_infinite() || b.is_infinite() {
                    inf_cnt += 1;
                } else {
                    min_val = min_val.min(r.min(g.min(b)));
                    max_val = max_val.max(r.max(g.max(b)));
                    if r == 0.0 && g == 0.0 && b == 0.0 {
                        black_cnt += 1;
                    }
                    sum += (r + g + b) as f64 / 3.0;
                }
            }
            let total_pixels = (width * height) as usize;
            let avg = sum / total_pixels as f64;
            println!("Pixel Stats (RGB32F): Min={}, Max={}, Avg={}, NaNs={}, Infs={}, Black Borders={:.2}%",
                min_val, max_val, avg, nan_cnt, inf_cnt, (black_cnt as f64 / total_pixels as f64) * 100.0);
        }
        other => {
            println!("Pixel Stats: Other format {:?}", other.color());
        }
    }

    // Check EXIF / XMP / Metadata in TIFF
    println!("\n=== EXIF / XMP / METADATA IN TIFF ===");
    let exif_reader = exif::Reader::new();
    let mut cursor = std::io::Cursor::new(&tiff_bytes);
    match exif_reader.read_from_container(&mut cursor) {
        Ok(exif_data) => {
            println!("EXIF Tag Count: {}", exif_data.fields().count());
            for field in exif_data.fields() {
                println!("  {:?}: {}", field.tag, field.display_value().with_unit(&exif_data));
            }
        }
        Err(e) => {
            println!("No standard EXIF table found in TIFF container: {}", e);
        }
    }

    // Check if GPano XMP exists in bytes
    let has_xmp = tiff_bytes.windows(11).any(|w| w == b"<x:xmpmeta " || w == b"<x:xmpmeta>");
    let has_gpano = tiff_bytes.windows(6).any(|w| w == b"GPano:" || w == b"gpano:");
    println!("Has XMP Metadata Header: {}", has_xmp);
    println!("Has Google Photosphere GPano Tags: {}", has_gpano);

    // Save a downsampled visual preview for review
    let preview_path = "D:/neapdirbti/IMG_4029_Pano_diagnostic_preview.jpg";
    let rgb8 = dyn_img.to_rgb8();
    rgb8.save(preview_path).expect("Failed to save preview");
    println!("Saved preview JPEG to {}", preview_path);

    // Now inspect source images IMG_4029.CR2 -> IMG_4034.CR2
    println!("\n=== SOURCE IMAGES INSPECTION (IMG_4029.CR2 -> IMG_4034.CR2) ===");
    let source_files = [
        "D:/neapdirbti/IMG_4029.CR2",
        "D:/neapdirbti/IMG_4030.CR2",
        "D:/neapdirbti/IMG_4031.CR2",
        "D:/neapdirbti/IMG_4032.CR2",
        "D:/neapdirbti/IMG_4033.CR2",
        "D:/neapdirbti/IMG_4034.CR2",
    ];

    for path in &source_files {
        if !Path::new(path).exists() {
            println!("Source file not found: {}", path);
            continue;
        }
        let bytes = fs::read(path).expect("Failed to read CR2");
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).expect("decoder");
        let metadata = decoder.raw_metadata(&source, &RawDecodeParams::default()).expect("metadata");
        let raw_img = decoder.raw_image(&source, &RawDecodeParams::default(), false).expect("raw_image");

        println!("File: {} -> Dim: {}x{}, ExpTime: {:?}, FNumber: {:?}, Orientation: {:?}",
            path,
            raw_img.width,
            raw_img.height,
            metadata.exif.exposure_time,
            metadata.exif.fnumber,
            metadata.exif.orientation,
        );
    }
}
