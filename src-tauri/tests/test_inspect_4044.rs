use std::fs;
use std::path::Path;
use image::GenericImageView;
use rapidraw_lib::exif_processing;

#[test]
fn test_inspect_4044_to_4052() {
    println!("\n=== CR2 SOURCE FILES DIAGNOSTICS (4044 - 4052) ===");
    for i in 4044..=4052 {
        let p_str = format!("D:/neapdirbti/IMG_{}.CR2", i);
        let path = Path::new(&p_str);
        if path.exists() {
            let bytes = fs::read(path).unwrap();
            let exp_time = exif_processing::read_exposure_time_secs(&p_str, &bytes);
            let f_num = exif_processing::read_f_number(&p_str, &bytes);
            let iso = exif_processing::read_iso(&p_str, &bytes);
            let date = exif_processing::get_creation_date_from_path(path);
            println!(
                "IMG_{}.CR2: Exp={:?}s, Aperture=f/{:?}, ISO={:?}, Date={}",
                i, exp_time, f_num, iso, date
            );
        } else {
            println!("IMG_{}.CR2: NOT FOUND", i);
        }
    }

    let pano_path = "D:/neapdirbti/IMG_4044_Pano_UltraHDR.jpg";
    println!("\n=== PANO OUTPUT DIAGNOSTICS: {} ===", pano_path);
    if Path::new(pano_path).exists() {
        let pano_bytes = fs::read(pano_path).unwrap();
        println!("File Size: {:.2} MB ({} bytes)", pano_bytes.len() as f64 / 1_000_000.0, pano_bytes.len());

        let img = image::open(pano_path).expect("open pano");
        let (w, h) = img.dimensions();
        println!("Dimensions: {}x{}", w, h);

        let rgb = img.to_rgb8();
        let mut min_r = 255u8;
        let mut max_r = 0u8;
        let mut min_g = 255u8;
        let mut max_g = 0u8;
        let mut min_b = 255u8;
        let mut max_b = 0u8;
        let mut sum_lum = 0.0f64;
        let total_pixels = (w as f64) * (h as f64);

        let mut bottom_black_rows = 0;
        for y in (0..h).rev() {
            let mut row_sum = 0u64;
            for x in 0..w {
                let p = rgb.get_pixel(x, y);
                row_sum += p[0] as u64 + p[1] as u64 + p[2] as u64;
            }
            if row_sum == 0 {
                bottom_black_rows += 1;
            } else {
                break;
            }
        }

        for y in 0..h {
            for x in 0..w {
                let p = rgb.get_pixel(x, y);
                min_r = min_r.min(p[0]);
                max_r = max_r.max(p[0]);
                min_g = min_g.min(p[1]);
                max_g = max_g.max(p[1]);
                min_b = min_b.min(p[2]);
                max_b = max_b.max(p[2]);
                let lum = 0.2126 * (p[0] as f64) + 0.7152 * (p[1] as f64) + 0.0722 * (p[2] as f64);
                sum_lum += lum;
            }
        }

        let mean_lum = sum_lum / total_pixels;
        println!("Min RGB: [{}, {}, {}]", min_r, min_g, min_b);
        println!("Max RGB: [{}, {}, {}]", max_r, max_g, max_b);
        println!("Mean Luminance: {:.2} / 255.0 ({:.1}%)", mean_lum, (mean_lum / 255.0) * 100.0);
        println!("Bottom Dead Black Rows: {}", bottom_black_rows);

        // Check for UltraHDR / MPF / Gain Map markers
        let has_xmp = pano_bytes.windows(4).any(|w| w == b"http" || w == b"<x:xmpmeta");
        let has_gainmap_tag = pano_bytes.windows(7).any(|w| w == b"GainMap" || w == b"gainMap" || w == b"hdrgm:");
        let has_mpf = pano_bytes.windows(4).any(|w| w == b"MPF\0");
        println!("Has XMP metadata: {}", has_xmp);
        println!("Has GainMap XMP tag: {}", has_gainmap_tag);
        println!("Has MPF (Multi-Picture Format) marker: {}", has_mpf);
    }
}
