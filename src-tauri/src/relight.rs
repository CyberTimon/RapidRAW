use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, GenericImageView, RgbaImage};
use rayon::prelude::*;
use std::borrow::Cow;

const SPECULAR_POWER: f32 = 24.0;

struct RelightParams {
    // Light position as a fraction of the image width / height.
    light_x: f32,
    light_y: f32,
    // Distance of the light from the image plane, in units of the longest image side.
    light_z: f32,
    // Falloff radius, in units of the longest image side.
    radius: f32,
    light_color: [f32; 3],
    intensity: f32,
    ambient: f32,
    wrap: f32,
    specular: f32,
}

pub fn apply_relight<'a>(
    image: Cow<'a, DynamicImage>,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get("effects"))
        .and_then(|s| s.as_bool())
        .unwrap_or(true);

    if !adjustments["relightEnabled"].as_bool().unwrap_or(false) || !effects_visible {
        return image;
    }

    let normal_b64 = adjustments["relightNormalMap"].as_str().unwrap_or("");
    if normal_b64.is_empty() {
        return image;
    }

    let b64_data = match normal_b64.find(',') {
        Some(idx) => &normal_b64[idx + 1..],
        None => normal_b64,
    };
    let decoded = match BASE64.decode(b64_data) {
        Ok(b) => b,
        Err(_) => return image,
    };
    let normal_map = match image::load_from_memory(&decoded) {
        Ok(img) => img.into_rgba8(),
        Err(_) => return image,
    };
    if normal_map.width() < 2 || normal_map.height() < 2 {
        return image;
    }

    let (w, h) = image.dimensions();
    if w < 2 || h < 2 {
        return image;
    }

    let params = read_params(adjustments);

    let start = std::time::Instant::now();
    let mut out = image.as_ref().to_rgb32f();
    relight_in_place(&mut out, &normal_map, &params);

    log::info!("relight ({}x{}) took {:.2?}", w, h, start.elapsed());

    Cow::Owned(DynamicImage::ImageRgb32F(out))
}

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Parses "#rrggbb" into a linear light tint that keeps roughly the same brightness as white.
fn parse_light_color(hex: &str) -> [f32; 3] {
    let hex = hex.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.is_ascii() {
        return [1.0; 3];
    }

    let mut color = [1.0f32; 3];
    for (i, c) in color.iter_mut().enumerate() {
        match u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16) {
            Ok(v) => *c = srgb_to_linear(v as f32 / 255.0),
            Err(_) => return [1.0; 3],
        }
    }

    let luma = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    let norm = luma.max(0.3);
    color.map(|c| c / norm)
}

fn read_params(adjustments: &serde_json::Value) -> RelightParams {
    let num = |key: &str, default: f64| adjustments[key].as_f64().unwrap_or(default) as f32;

    let range = (num("relightRange", 60.0) / 100.0).clamp(0.0, 1.0);

    RelightParams {
        light_x: num("relightX", 0.3),
        light_y: num("relightY", 0.3),
        light_z: 0.02 + (num("relightHeight", 30.0) / 100.0).clamp(0.0, 1.0),
        radius: 0.1 + 1.9 * range * range,
        light_color: parse_light_color(adjustments["relightColor"].as_str().unwrap_or("#ffffff")),
        intensity: (num("relightIntensity", 50.0) / 100.0).clamp(0.0, 1.0) * 2.0,
        ambient: (num("relightAmbient", 80.0) / 100.0).clamp(0.0, 1.0),
        wrap: (num("relightSoftness", 30.0) / 100.0).clamp(0.0, 1.0),
        specular: (num("relightSpecular", 0.0) / 100.0).clamp(0.0, 1.0),
    }
}

fn relight_in_place(image: &mut image::Rgb32FImage, normal_map: &RgbaImage, p: &RelightParams) {
    let w = image.width() as usize;
    let h = image.height() as usize;
    let nw = normal_map.width() as usize;
    let nh = normal_map.height() as usize;
    let normals = normal_map.as_raw();

    let x_scale = nw as f32 / w as f32;
    let y_scale = nh as f32 / h as f32;

    let inv_long_side = 1.0 / w.max(h) as f32;
    let light_px = p.light_x * w as f32;
    let light_py = p.light_y * h as f32;
    let inv_radius_sq = 1.0 / (p.radius * p.radius);

    image
        .as_mut()
        .par_chunks_exact_mut(w * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = ((y as f32 + 0.5) * y_scale - 0.5).clamp(0.0, (nh - 1) as f32);
            let y0 = fy as usize;
            let y1 = (y0 + 1).min(nh - 1);
            let ty = fy - y0 as f32;

            // Image rows grow downwards while the normal map uses Y up.
            let ly = -(light_py - (y as f32 + 0.5)) * inv_long_side;

            for (x, px) in row.chunks_exact_mut(3).enumerate() {
                let fx = ((x as f32 + 0.5) * x_scale - 0.5).clamp(0.0, (nw - 1) as f32);
                let x0 = fx as usize;
                let x1 = (x0 + 1).min(nw - 1);
                let tx = fx - x0 as f32;

                let mut s = [0.0f32; 4];
                for (sx, sy, weight) in [
                    (x0, y0, (1.0 - tx) * (1.0 - ty)),
                    (x1, y0, tx * (1.0 - ty)),
                    (x0, y1, (1.0 - tx) * ty),
                    (x1, y1, tx * ty),
                ] {
                    let i = (sy * nw + sx) * 4;
                    for c in 0..4 {
                        s[c] += normals[i + c] as f32 * weight;
                    }
                }

                let coverage = s[3] / 255.0;
                if coverage <= 0.0 {
                    continue;
                }

                let nx = s[0] / 127.5 - 1.0;
                let ny = s[1] / 127.5 - 1.0;
                let nz = s[2] / 127.5 - 1.0;
                let inv_len = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt().max(1e-6);
                let (nx, ny, nz) = (nx * inv_len, ny * inv_len, nz * inv_len);

                let lx = (light_px - (x as f32 + 0.5)) * inv_long_side;
                let planar_dist_sq = lx * lx + ly * ly;
                let inv_l_len = 1.0 / (planar_dist_sq + p.light_z * p.light_z).sqrt();
                let (dx, dy, dz) = (lx * inv_l_len, ly * inv_l_len, p.light_z * inv_l_len);

                let attenuation = 1.0 / (1.0 + planar_dist_sq * inv_radius_sq);

                let n_dot_l = nx * dx + ny * dy + nz * dz;
                let diffuse = ((n_dot_l + p.wrap) / (1.0 + p.wrap)).max(0.0);

                let spec = if p.specular > 0.0 && n_dot_l > 0.0 {
                    // Half vector between the light and the viewer (0, 0, 1).
                    let hz = dz + 1.0;
                    let inv_h_len = 1.0 / (dx * dx + dy * dy + hz * hz).sqrt().max(1e-6);
                    let n_dot_h = (nx * dx + ny * dy + nz * hz) * inv_h_len;
                    n_dot_h.max(0.0).powf(SPECULAR_POWER) * p.specular
                } else {
                    0.0
                };

                let lit = p.intensity * attenuation * (diffuse + spec);
                for c in 0..3 {
                    let gain = p.ambient + lit * p.light_color[c];
                    px[c] *= 1.0 + (gain - 1.0) * coverage;
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, Rgb32FImage, Rgba};
    use serde_json::json;

    fn flat_normal_map(normal: [u8; 3], alpha: u8) -> RgbaImage {
        RgbaImage::from_pixel(4, 4, Rgba([normal[0], normal[1], normal[2], alpha]))
    }

    fn relit_pixel(adjustments: serde_json::Value, normal_map: &RgbaImage, x: u32) -> [f32; 3] {
        let mut image = Rgb32FImage::from_pixel(8, 8, Rgb([0.5, 0.5, 0.5]));
        relight_in_place(&mut image, normal_map, &read_params(&adjustments));
        image.get_pixel(x, 3).0
    }

    #[test]
    fn surface_facing_the_light_gets_brighter_than_one_facing_away() {
        let adjustments = json!({
            "relightX": 1.0, "relightY": 0.5, "relightHeight": 0, "relightSoftness": 0, "relightRange": 100,
        });
        let facing_right = relit_pixel(
            adjustments.clone(),
            &flat_normal_map([255, 128, 128], 255),
            3,
        );
        let facing_left = relit_pixel(adjustments, &flat_normal_map([0, 128, 128], 255), 3);

        assert!(facing_right[1] > 0.5);
        assert!(facing_left[1] < 0.5);
    }

    #[test]
    fn light_above_the_pixel_brightens_upward_facing_surfaces() {
        let adjustments = json!({
            "relightX": 0.5, "relightY": 0.0, "relightHeight": 0, "relightSoftness": 0, "relightRange": 100,
        });
        let facing_up = relit_pixel(
            adjustments.clone(),
            &flat_normal_map([128, 255, 128], 255),
            3,
        );
        let facing_down = relit_pixel(adjustments, &flat_normal_map([128, 0, 128], 255), 3);

        assert!(facing_up[1] > facing_down[1]);
    }

    #[test]
    fn light_falls_off_with_distance() {
        let adjustments =
            json!({ "relightX": 0.0, "relightY": 0.5, "relightHeight": 50, "relightRange": 20 });
        let normal_map = flat_normal_map([128, 128, 255], 255);
        let near = relit_pixel(adjustments.clone(), &normal_map, 0);
        let far = relit_pixel(adjustments, &normal_map, 7);

        assert!(near[1] > far[1]);
    }

    #[test]
    fn light_color_tints_the_lit_surface() {
        let adjustments = json!({ "relightX": 0.5, "relightY": 0.5, "relightColor": "#ff8000" });
        let lit = relit_pixel(adjustments, &flat_normal_map([128, 128, 255], 255), 3);

        assert!(lit[0] > lit[1] && lit[1] > lit[2]);
    }

    #[test]
    fn invalid_light_color_falls_back_to_white() {
        assert_eq!(parse_light_color("not-a-color"), [1.0; 3]);
        assert!(
            parse_light_color("#ffffff")
                .iter()
                .all(|c| (c - 1.0).abs() < 1e-4)
        );
    }

    #[test]
    fn pixels_without_geometry_are_left_untouched() {
        let adjustments = json!({ "relightIntensity": 100, "relightAmbient": 0 });
        let lit = relit_pixel(adjustments, &flat_normal_map([128, 128, 255], 0), 3);

        assert_eq!(lit, [0.5; 3]);
    }
}
