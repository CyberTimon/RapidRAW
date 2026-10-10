use image::{DynamicImage, GenericImageView};
use rayon::prelude::*;
use std::borrow::Cow;

use crate::relight::{RelightTap, build_guided_model, build_relight_guide, relight_luma};

#[inline(always)]
fn fog_hash(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841);
    h = (h ^ (h >> 13)).wrapping_mul(0x85eb_ca6b);
    h ^= h >> 16;
    h as f32 / u32::MAX as f32
}

fn fog_noise(x: f32, y: f32) -> f32 {
    let mut value = 0.0f32;
    let mut amplitude = 0.5f32;
    let mut frequency = 1.0f32;
    for octave in 0..4 {
        let (px, py) = (x * frequency + octave as f32 * 17.3, y * frequency);
        let (ix, iy) = (px.floor() as i32, py.floor() as i32);
        let (fx, fy) = (px - ix as f32, py - iy as f32);
        let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
        let top = fog_hash(ix, iy) + (fog_hash(ix + 1, iy) - fog_hash(ix, iy)) * sx;
        let bot = fog_hash(ix, iy + 1) + (fog_hash(ix + 1, iy + 1) - fog_hash(ix, iy + 1)) * sx;
        value += (top + (bot - top) * sy) * amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    value / 0.9375
}

fn fog_downsample(raw: &[f32], w: usize, h: usize, dw: usize, dh: usize) -> [Vec<f32>; 3] {
    let mut planes = [
        vec![0.0f32; dw * dh],
        vec![0.0f32; dw * dh],
        vec![0.0f32; dw * dh],
    ];
    let [r, g, b] = &mut planes;
    r.par_chunks_exact_mut(dw)
        .zip(g.par_chunks_exact_mut(dw))
        .zip(b.par_chunks_exact_mut(dw))
        .enumerate()
        .for_each(|(dy, ((r_row, g_row), b_row))| {
            let sy0 = dy * h / dh;
            let sy1 = ((dy + 1) * h / dh).clamp(sy0 + 1, h);
            for dx in 0..dw {
                let sx0 = dx * w / dw;
                let sx1 = ((dx + 1) * w / dw).clamp(sx0 + 1, w);
                let mut acc = [0.0f32; 3];
                for sy in sy0..sy1 {
                    for sx in sx0..sx1 {
                        let i = (sy * w + sx) * 3;
                        acc[0] += raw[i];
                        acc[1] += raw[i + 1];
                        acc[2] += raw[i + 2];
                    }
                }
                let inv = 1.0 / ((sy1 - sy0) * (sx1 - sx0)) as f32;
                r_row[dx] = acc[0] * inv;
                g_row[dx] = acc[1] * inv;
                b_row[dx] = acc[2] * inv;
            }
        });
    planes
}

fn fog_blur(planes: &mut [Vec<f32>; 3], w: usize, h: usize, radius: usize) {
    for plane in planes.iter_mut() {
        crate::lens_blur::dof_box_filter(plane, w, h, 1, radius);
        crate::lens_blur::dof_box_filter(plane, w, h, 1, radius);
    }
}

pub fn apply_fog<'a>(
    image: Cow<'a, DynamicImage>,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get("effects"))
        .and_then(|s| s.as_bool())
        .unwrap_or(true);

    if !adjustments["fogEnabled"].as_bool().unwrap_or(false) || !effects_visible {
        return image;
    }

    let depth_b64 = adjustments["fogDepthMap"].as_str().unwrap_or("");
    if depth_b64.is_empty() {
        return image;
    }

    let get = |key: &str, default: f64| {
        (adjustments[key].as_f64().unwrap_or(default) as f32 / 100.0).clamp(0.0, 1.0)
    };
    let amount = get("fogAmount", 50.0);
    if amount <= 0.0 {
        return image;
    }
    let start = get("fogStart", 0.0).min(0.99);
    let density = 0.5 + get("fogDensity", 50.0) * 7.5;
    let height = get("fogHeight", 0.0) * 6.0;
    let variation = get("fogVariation", 25.0);
    let glow = get("fogGlow", 25.0) * 1.5;
    let temperature = adjustments["fogTemperature"].as_f64().unwrap_or(0.0) as f32 / 100.0;
    let tint_shift = adjustments["fogTint"].as_f64().unwrap_or(0.0) as f32 / 100.0;
    let tint = [
        1.0 + 0.45 * temperature + 0.15 * tint_shift,
        1.0 - 0.35 * tint_shift,
        1.0 - 0.45 * temperature + 0.15 * tint_shift,
    ]
    .map(|c| c.max(0.0));
    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) % 4;
    let flip_horizontal = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);

    let depth_map = match crate::effect_maps::resolve_luma_map(depth_b64, adjustments) {
        Some(map) => map,
        None => return image,
    };
    let (dw, dh) = (depth_map.width() as usize, depth_map.height() as usize);
    let (w, h) = image.dimensions();
    if dw < 2 || dh < 2 || w < 2 || h < 2 {
        return image;
    }

    let start_time = std::time::Instant::now();
    let (wu, hu) = (w as usize, h as usize);
    let mut out = image.into_owned().into_rgb32f();

    let to_display = |u: f32, v: f32| {
        let (mut x, mut y) = match orientation_steps {
            1 => (1.0 - v, u),
            2 => (1.0 - u, 1.0 - v),
            3 => (v, 1.0 - u),
            _ => (u, v),
        };
        if flip_horizontal {
            x = 1.0 - x;
        }
        if flip_vertical {
            y = 1.0 - y;
        }
        (x, y)
    };
    let display_aspect = if orientation_steps % 2 == 1 {
        h as f32 / w as f32
    } else {
        w as f32 / h as f32
    };

    let disparity: Vec<f32> = depth_map.pixels().map(|p| p[0] as f32 / 255.0).collect();
    let guide = build_relight_guide(out.as_raw(), wu, hu, dw, dh);
    let radius = ((dw.max(dh) as f32 * 0.01).round() as usize).max(2);
    let model = build_guided_model(&guide, &disparity, dw, dh, radius, 2.0e-3);

    let noise: Vec<f32> = (0..dw * dh)
        .into_par_iter()
        .map(|i| {
            let (x, y) = to_display(
                ((i % dw) as f32 + 0.5) / dw as f32,
                ((i / dw) as f32 + 0.5) / dh as f32,
            );
            fog_noise(x * 3.0 * display_aspect, y * 8.0)
        })
        .collect();

    let scale = (384.0 / w.max(h) as f32).min(1.0);
    let lw = ((w as f32 * scale).round() as usize).max(2);
    let lh = ((h as f32 * scale).round() as usize).max(2);
    let low = fog_downsample(out.as_raw(), wu, hu, lw, lh);

    let (far_sum, far_weight, mean_sum) = (0..lw * lh)
        .into_par_iter()
        .map(|i| {
            let tap = RelightTap::new(
                ((i % lw) as f32 + 0.5) / lw as f32,
                ((i / lw) as f32 + 0.5) / lh as f32,
                dw,
                dh,
            );
            let weight = ((0.3 - tap.sample(&disparity)) / 0.3).clamp(0.0, 1.0);
            let rgb = [low[0][i], low[1][i], low[2][i]];
            (rgb.map(|c| c * weight), weight, rgb)
        })
        .reduce(
            || ([0.0; 3], 0.0, [0.0; 3]),
            |a, b| {
                (
                    [a.0[0] + b.0[0], a.0[1] + b.0[1], a.0[2] + b.0[2]],
                    a.1 + b.1,
                    [a.2[0] + b.2[0], a.2[1] + b.2[1], a.2[2] + b.2[2]],
                )
            },
        );
    let mean_rgb = mean_sum.map(|c| c / (lw * lh) as f32);
    let far_rgb = if far_weight > 1.0 {
        far_sum.map(|c| c / far_weight)
    } else {
        mean_rgb
    };
    let luma = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let far_luma = luma(far_rgb).max(1e-4);
    let atmosphere = far_luma.max(luma(mean_rgb));
    let tint_luma = luma(tint).max(1e-3);
    let fog_rgb = [0, 1, 2].map(|c| {
        let chroma = far_rgb[c].max(0.0) / far_luma;
        (chroma + (1.0 - chroma) * 0.4) * atmosphere * tint[c] / tint_luma
    });

    let mut soft = low.clone();
    fog_blur(
        &mut soft,
        lw,
        lh,
        ((lw.max(lh) as f32 * 0.02).round() as usize).max(1),
    );

    let mut bloom = low;
    if glow > 0.0 {
        let [bloom_r, bloom_g, bloom_b] = &mut bloom;
        bloom_r
            .par_iter_mut()
            .zip(bloom_g.par_iter_mut())
            .zip(bloom_b.par_iter_mut())
            .for_each(|((r, g), b)| {
                let l = luma([*r, *g, *b]);
                let t = ((l - atmosphere * 0.8) / (atmosphere * 1.7)).clamp(0.0, 1.0);
                let k = t * t * (3.0 - 2.0 * t);
                *r *= k;
                *g *= k;
                *b *= k;
            });
        fog_blur(
            &mut bloom,
            lw,
            lh,
            ((lw.max(lh) as f32 * 0.06).round() as usize).max(1),
        );
    }

    let near = 0.1f32;
    let z_near = 1.0 / (1.0 + near);
    let z_range = 1.0 / near - z_near;
    let norm = 1.0 - (-density).exp();

    out.par_chunks_exact_mut(wu * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let v = (y as f32 + 0.5) / h as f32;
            for x in 0..wu {
                let i = x * 3;
                let u = (x as f32 + 0.5) / w as f32;
                let depth_tap = RelightTap::new(u, v, dw, dh);
                let d = depth_tap
                    .guided(&model, relight_luma(row[i], row[i + 1], row[i + 2]))
                    .clamp(0.0, 1.0);
                let distance = (1.0 / (d + near) - z_near) / z_range;
                let t = ((distance - start) / (1.0 - start)).clamp(0.0, 1.0);

                let up = 1.0 - to_display(u, v).1;
                let patches =
                    (1.0 + 1.6 * variation * (depth_tap.sample(&noise) * 2.0 - 1.0)).max(0.0);
                let optical = density * t * (-height * up).exp() * patches;
                let fog = (amount * (1.0 - (-optical).exp()) / norm).clamp(0.0, 1.0);
                if fog <= 0.0 {
                    continue;
                }

                let low_tap = RelightTap::new(u, v, lw, lh);
                for c in 0..3 {
                    let scattered = fog_rgb[c] + (low_tap.sample(&soft[c]) - fog_rgb[c]) * 0.35;
                    let halo = if glow > 0.0 {
                        low_tap.sample(&bloom[c]) * glow
                    } else {
                        0.0
                    };
                    row[i + c] = row[i + c] * (1.0 - fog) + (scattered + halo) * fog;
                }
            }
        });

    log::info!("fog ({}x{}) took {:.2?}", w, h, start_time.elapsed());

    Cow::Owned(DynamicImage::ImageRgb32F(out))
}
