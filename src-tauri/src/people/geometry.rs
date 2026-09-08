use super::types::Detection;
use anyhow::{Result, ensure};
use image::{Rgb, RgbImage};

pub const TEMPLATE: [[f32; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

pub fn normalize(v: &mut [f32]) -> Result<()> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    ensure!(norm.is_finite() && norm > 1e-8, "Invalid face embedding");
    for x in v {
        *x /= norm;
    }
    Ok(())
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return -1.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let w = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let h = (a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1]);
    let intersection = w.max(0.0) * h.max(0.0);
    intersection / (a[2] * a[3] + b[2] * b[3] - intersection).max(1e-8)
}

pub fn suppress(mut faces: Vec<Detection>) -> Vec<Detection> {
    faces.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    let mut result: Vec<Detection> = Vec::new();
    for face in faces {
        if result
            .iter()
            .all(|other| iou(&face.bounds, &other.bounds) < 0.3)
        {
            result.push(face);
        }
    }
    result
}

// Least-squares orientation-preserving similarity transform from template to source.
pub fn align(image: &RgbImage, points: &[[f32; 2]; 5]) -> Result<RgbImage> {
    let mean = |p: &[[f32; 2]; 5]| {
        [
            p.iter().map(|v| v[0]).sum::<f32>() / 5.0,
            p.iter().map(|v| v[1]).sum::<f32>() / 5.0,
        ]
    };
    let src = mean(points);
    let dst = mean(&TEMPLATE);
    let (mut a, mut b, mut den) = (0.0, 0.0, 0.0);
    for (p, q) in points.iter().zip(TEMPLATE) {
        let (x, y, u, v) = (q[0] - dst[0], q[1] - dst[1], p[0] - src[0], p[1] - src[1]);
        a += x * u + y * v;
        b += x * v - y * u;
        den += x * x + y * y;
    }
    a /= den;
    b /= den;
    ensure!(
        a.is_finite() && b.is_finite() && a * a + b * b > 1e-8,
        "Invalid face landmarks"
    );
    Ok(RgbImage::from_fn(112, 112, |x, y| {
        let dx = x as f32 - dst[0];
        let dy = y as f32 - dst[1];
        let sx = a * dx - b * dy + src[0];
        let sy = b * dx + a * dy + src[1];
        let ix = sx.floor() as i32;
        let iy = sy.floor() as i32;
        let (fx, fy) = (sx - ix as f32, sy - iy as f32);
        let mut pixel = [0.0; 3];
        for (ox, oy, weight) in [
            (0, 0, (1.0 - fx) * (1.0 - fy)),
            (1, 0, fx * (1.0 - fy)),
            (0, 1, (1.0 - fx) * fy),
            (1, 1, fx * fy),
        ] {
            let (px, py) = (ix + ox, iy + oy);
            if px >= 0 && py >= 0 && px < image.width() as i32 && py < image.height() as i32 {
                for (c, out) in pixel.iter_mut().enumerate() {
                    *out += image.get_pixel(px as u32, py as u32)[c] as f32 * weight;
                }
            }
        }
        Rgb(pixel.map(|v| v.round().clamp(0.0, 255.0) as u8))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_and_similarity() {
        let mut a = vec![3.0, 4.0];
        normalize(&mut a).unwrap();
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-6);
        assert_eq!(cosine(&[1.0, 0.0], &[0.5, 0.8660254]), 0.5);
        assert!(normalize(&mut [0.0, 0.0]).is_err());
    }
    #[test]
    fn identity_alignment() {
        let img = RgbImage::from_fn(112, 112, |x, y| Rgb([x as u8, y as u8, 0]));
        assert_eq!(
            align(&img, &TEMPLATE).unwrap().get_pixel(50, 60),
            img.get_pixel(50, 60)
        );
    }
}
