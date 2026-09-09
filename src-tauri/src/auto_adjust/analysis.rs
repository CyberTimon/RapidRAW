use super::types::*;
use image::RgbImage;

pub fn quantile(values: &mut [f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * q).round() as usize]
}
fn luma(p: &image::Rgb<u8>) -> f64 {
    (0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64) / 255.
}

/// Display-referred statistics from the actual neutral renderer, never raw linear bytes.
pub fn measure(
    image: &RgbImage,
    faces: Vec<Face>,
    iso: Option<u32>,
    captured: Option<i64>,
    reduced: bool,
) -> Analysis {
    let mut a = Analysis { faces, iso, captured, reduced, ..Analysis::default() };
    let mut ys = Vec::new();
    let mut neutral_r = Vec::new();
    let mut neutral_g = Vec::new();
    let mut noise = Vec::new();
    let mut chroma = Vec::new();
    let mut background = Vec::new();
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return a;
    }
    for (x, y, p) in image.enumerate_pixels() {
        let v = luma(p);
        ys.push(v);
        let max = *p.0.iter().max().unwrap() as f64 / 255.;
        let min = *p.0.iter().min().unwrap() as f64 / 255.;
        let sat = (max - min) / max.max(0.01);
        a.saturation += sat;
        if max >= 0.99 {
            a.clipped += 1.;
        }
        if v < 0.08 {
            a.shadows += 1.;
        }
        let r = p[0] as f64 + 1.;
        let g = p[1] as f64 + 1.;
        let b = p[2] as f64 + 1.;
        if v > 0.08 && max < 0.96 {
            chroma.push((r / b).ln());
            if sat < 0.32 {
                neutral_r.push((r / b).ln());
                neutral_g.push((g / (r * b).sqrt()).ln());
            }
        }
        if x > 0 && y > 0 && x + 1 < w && y + 1 < h && v > 0.015 && v < 0.3 {
            let neighbors = [
                luma(image.get_pixel(x - 1, y)),
                luma(image.get_pixel(x + 1, y)),
                luma(image.get_pixel(x, y - 1)),
                luma(image.get_pixel(x, y + 1)),
            ];
            let lo = neighbors.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = neighbors.iter().copied().fold(0., f64::max);
            if hi - lo < 0.04 {
                noise.push((v - neighbors.iter().sum::<f64>() / 4.).abs());
            }
        }
        if !a.faces.iter().any(|f| inside(x, y, w, h, &f.bounds)) {
            background.push(v);
        }
    }
    let n = ys.len() as f64;
    a.median = quantile(&mut ys, 0.5);
    a.p10 = quantile(&mut ys, 0.1);
    a.p90 = quantile(&mut ys, 0.9);
    a.p99 = quantile(&mut ys, 0.99);
    a.clipped /= n;
    a.shadows /= n;
    a.saturation /= n;
    a.neutral_confidence = (neutral_r.len() as f64 / n / 0.15).clamp(0., 1.);
    a.warmth = quantile(&mut neutral_r, 0.5);
    a.tint = quantile(&mut neutral_g, 0.5);
    a.color_variance = quantile(&mut chroma, 0.9) - quantile(&mut chroma, 0.1);
    a.noise = (quantile(&mut noise, 0.5) * 25.).clamp(0., 1.);
    if iso.unwrap_or(0) >= 3200 {
        a.noise = a.noise.max(0.25);
    }
    for f in &mut a.faces {
        let mut pixels = image
            .enumerate_pixels()
            .filter(|(x, y, _)| inside(*x, *y, w, h, &f.bounds))
            .map(|(_, _, p)| luma(p))
            .collect::<Vec<_>>();
        f.luma = quantile(&mut pixels, 0.5);
    }
    let mut subjects = a.faces.iter().map(|f| f.luma).collect::<Vec<_>>();
    a.subject = if subjects.is_empty() { a.median } else { quantile(&mut subjects, 0.5) };
    a.background = quantile(&mut background, 0.5);
    (a.scene, a.confidence) = classify(&a);
    a
}
fn inside(x: u32, y: u32, w: u32, h: u32, b: &[f32; 4]) -> bool {
    let x = x as f32 / w as f32;
    let y = y as f32 / h as f32;
    x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]
}
pub fn classify(a: &Analysis) -> (Scene, f64) {
    if (a.color_variance > 1.25 && a.saturation > 0.3) || (a.saturation > 0.55 && a.color_variance > 0.8) {
        return (Scene::Mixed, 0.75);
    }
    // Darkness alone is insufficient evidence for night: look for concentrated lights/high ISO.
    if a.shadows > 0.45 && (a.p99 > 0.8 || a.iso.unwrap_or(0) >= 1600) {
        return (Scene::Night, 0.7);
    }
    if a.warmth > 0.15 && a.neutral_confidence > 0.3 {
        return (Scene::WarmIndoor, 0.65);
    }
    if a.neutral_confidence > 0.45 && a.shadows < 0.45 {
        return (Scene::Daylight, 0.7);
    }
    (Scene::Uncertain, 0.3)
}
pub fn default_target(scene: Scene, has_faces: bool) -> f64 {
    match (scene, has_faces) {
        (Scene::Night, true) => 0.48,
        (Scene::Night, false) => 0.20,
        (Scene::Mixed, true) => 0.48,
        (Scene::Mixed, false) => 0.28,
        (_, true) => 0.60,
        (Scene::Uncertain, false) => 0.32,
        _ => 0.42,
    }
}
