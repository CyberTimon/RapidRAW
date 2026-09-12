use super::types::Face;
use image::RgbImage;

/// Penalize newly lost detail, with extra protection for faces. Pixels already
/// near white (lamps/windows) do not veto recovery throughout the entire frame.
pub fn clipping_cost(before: &RgbImage, after: &RgbImage, faces: &[Face]) -> f64 {
    if before.dimensions() != after.dimensions() || before.is_empty() {
        return 1.;
    }
    let (w, h) = before.dimensions();
    let bright_fraction = before
        .pixels()
        .filter(|p| *p.0.iter().max().unwrap() >= 230)
        .count() as f64
        / (w as f64 * h as f64);
    let isolated_lights = bright_fraction < 0.05;
    let mut new_detail_loss = 0.;
    let mut face_loss = 0.;
    let mut face_pixels: f64 = 0.;
    for (x, y, p) in before.enumerate_pixels() {
        let old_max = *p.0.iter().max().unwrap();
        let new_max = *after.get_pixel(x, y).0.iter().max().unwrap();
        let in_face = faces.iter().any(|f| {
            let [left, top, width, height] = f.bounds;
            let (x, y) = (x as f32 / w as f32, y as f32 / h as f32);
            x >= left && x <= left + width && y >= top && y <= top + height
        });
        if in_face {
            face_pixels += 1.;
            if new_max >= 253 && old_max < 253 {
                face_loss += 1.;
            }
        }
        if new_max >= 253 && old_max < 253 {
            if old_max < 230 {
                new_detail_loss += 1.;
            } else if !isolated_lights {
                new_detail_loss += 0.25;
            }
        }
    }
    3. * (new_detail_loss / (w as f64 * h as f64) - 0.003).max(0.)
        + 0.5 * (face_loss / face_pixels.max(1.) - 0.015).max(0.)
}

/// Measures normalized opponent-color movement, with a tighter limit inside
/// detected faces so optional color families cannot noticeably recolor skin.
pub fn color_cost(before: &RgbImage, after: &RgbImage, faces: &[Face]) -> f64 {
    if before.dimensions() != after.dimensions() || before.is_empty() {
        return 1.;
    }
    let (w, h) = before.dimensions();
    let mut global = 0_f64;
    let mut global_pixels = 0_f64;
    let mut face = 0_f64;
    let mut face_pixels = 0_f64;
    for (x, y, old) in before.enumerate_pixels() {
        let new = after.get_pixel(x, y);
        let metric = |p: &image::Rgb<u8>| {
            let scale = (p[0] as f64 + p[1] as f64 + p[2] as f64).max(24.);
            (
                (p[0] as f64 - p[1] as f64) / scale,
                (p[2] as f64 - p[1] as f64) / scale,
            )
        };
        let (old_rg, old_bg) = metric(old);
        let (new_rg, new_bg) = metric(new);
        let movement = (new_rg - old_rg).hypot(new_bg - old_bg);
        global += movement;
        global_pixels += 1.;
        if faces.iter().any(|f| {
            let [left, top, width, height] = f.bounds;
            let (nx, ny) = (x as f32 / w as f32, y as f32 / h as f32);
            nx >= left && nx <= left + width && ny >= top && ny <= top + height
        }) {
            face += movement;
            face_pixels += 1.;
        }
    }
    global / global_pixels.max(1.) + 2. * face / face_pixels.max(1.)
}
