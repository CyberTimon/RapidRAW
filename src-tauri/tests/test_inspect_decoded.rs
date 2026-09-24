use image::codecs::png::{PngEncoder, CompressionType, FilterType};
use image::ImageEncoder;

#[test]
fn test_png_16bit_roundtrip() {
    let mut raw_png = Vec::new();
    let encoder = PngEncoder::new_with_quality(&mut raw_png, CompressionType::Default, FilterType::Sub);
    
    // Pixel (0,0): R=1000, G=2000, B=3000
    // Pixel (1,0): R=4000, G=5000, B=6000
    let u16_vals: [u16; 6] = [1000, 2000, 3000, 4000, 5000, 6000];
    let mut ne_bytes = Vec::new();
    for &u in &u16_vals {
        ne_bytes.extend_from_slice(&u.to_ne_bytes());
    }

    encoder.write_image(&ne_bytes, 2, 1, image::ExtendedColorType::Rgb16).unwrap();

    // Read back with image-rs
    let reader = image::ImageReader::new(std::io::Cursor::new(&raw_png))
        .with_guessed_format().unwrap();
    let decoded = reader.decode().unwrap();
    println!("Decoded color type: {:?}", decoded.color());
    let rgb16 = decoded.as_rgb16().unwrap();
    println!("Decoded (0,0): {:?}", rgb16.get_pixel(0, 0));
    println!("Decoded (1,0): {:?}", rgb16.get_pixel(1, 0));
    assert_eq!(rgb16.get_pixel(0, 0).0, [1000, 2000, 3000]);
    assert_eq!(rgb16.get_pixel(1, 0).0, [4000, 5000, 6000]);
}
