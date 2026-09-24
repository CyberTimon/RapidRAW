use std::fs;
use std::path::Path;
use image::GenericImageView;

#[test]
fn test_inspect_pano_diagnostic_preview() {
    let preview_path = "D:/neapdirbti/IMG_4029_Pano_diagnostic_preview.jpg";
    if !Path::new(preview_path).exists() {
        println!("Preview not found");
        return;
    }
    let img = image::open(preview_path).expect("open preview");
    let (w, h) = img.dimensions();
    println!("Diagnostic Preview Size: {}x{}", w, h);

    // Let's inspect brightness across horizontal columns to check seam and vignetting
    let rgb = img.to_rgb8();
    let mut col_lum = vec![0.0f64; w as usize];
    for x in 0..w {
        let mut sum = 0.0f64;
        for y in 0..h {
            let p = rgb.get_pixel(x, y);
            let lum = 0.2126 * (p[0] as f64) + 0.7152 * (p[1] as f64) + 0.0722 * (p[2] as f64);
            sum += lum;
        }
        col_lum[x as usize] = sum / h as f64;
    }

    println!("Sample Horizontal Luminance Profile (Left to Right):");
    let step = (w as usize) / 10;
    for i in 0..10 {
        let idx = i * step;
        println!("  Col {}/{} ({:.0}%): Lum = {:.2}", idx, w, (i as f32) * 10.0, col_lum[idx]);
    }
}
