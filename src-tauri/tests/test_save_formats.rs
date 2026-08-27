use image::{DynamicImage, Rgb32FImage, RgbImage, Rgb};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

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
        let mut tiff_image = encoder
            .new_image::<RGB32Float>(w, h)
            .expect("New image failed");
        tiff_image.write_data(img.as_raw()).expect("Write data failed");
    }

    let buf = cursor.into_inner();
    assert!(!buf.is_empty());
    println!("Compressed 100x100 TIFF size: {} bytes (Uncompressed: 120,000 bytes)", buf.len());
    assert!(buf.len() < 10000, "Deflate compression must dramatically reduce size");
}
