use image::{GrayImage, Rgba, RgbaImage};

pub struct OverlayResult {
    pub boundary_png: Vec<u8>,
    pub winner_map_png: Vec<u8>,
}

// Draws the seam lines on the preview.
pub fn generate_overlay(winners: &[u16], width: u32, height: u32) -> Result<OverlayResult, String> {
    let w = width as usize;
    let h = height as usize;
    assert_eq!(winners.len(), w * h);
    let mut boundary = RgbaImage::new(width, height);
    let mut map = GrayImage::new(width, height);
    for y in 0..h {
        for x in 0..w {
            let id = winners[y * w + x];
            let luma = if id == u16::MAX {
                0
            } else {
                ((id % 255) as u8).saturating_add(1)
            };
            map.put_pixel(x as u32, y as u32, image::Luma([luma]));
            if id == u16::MAX {
                continue;
            }
            let right = if x + 1 < w {
                winners[y * w + x + 1]
            } else {
                id
            };
            let down = if y + 1 < h {
                winners[(y + 1) * w + x]
            } else {
                id
            };
            if (right != u16::MAX && right != id) || (down != u16::MAX && down != id) {
                boundary.put_pixel(x as u32, y as u32, Rgba([255, 255, 255, 200]));
            }
        }
    }
    Ok(OverlayResult {
        boundary_png: encode_png_rgba(&boundary)?,
        winner_map_png: encode_png_gray(&map)?,
    })
}

fn encode_png_rgba(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode overlay: {}", e))?;
    Ok(buf.into_inner())
}

fn encode_png_gray(img: &GrayImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode winner map: {}", e))?;
    Ok(buf.into_inner())
}
