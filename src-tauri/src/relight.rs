use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, Rgb32FImage, RgbaImage};
use rayon::prelude::*;
use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use crate::lens_blur::{LumaGuide, build_guided_model, build_luma_guide, dof_box_filter};

const SPECULAR_POWER: f32 = 24.0;
// How far in front of the nearest surface the light can be pulled, in units of the longest image side.
const MAX_FRONT_DISTANCE: f32 = 1.5;

// Below this size there is nothing to gain from snapping the maps to the image edges.
const MIN_REFINE_SIZE: u32 = 64;
const MAX_LIGHTS: usize = 8;
// Brightness slope to surface tilt, for a detail amount of 100.
const DETAIL_GAIN: f32 = 2.0;

type DepthMap = ImageBuffer<Luma<u16>, Vec<u16>>;

/// Normal, coverage and depth for every pixel of the image being relit.
struct SurfaceMaps {
    normals: Vec<[i8; 3]>,
    coverage: Vec<u8>,
    depth: Vec<u16>,
    // Fine relief (hair, pores, fabric) read from the photo's own texture, as an X / Y tilt
    // to add to the normal. The AI maps are too coarse to carry it.
    detail: Vec<[i8; 2]>,
}

impl SurfaceMaps {
    #[inline(always)]
    fn normal(&self, i: usize, detail_strength: f32) -> (f32, f32, f32) {
        let n = self.normals[i];
        let (nx, ny, nz) = (
            n[0] as f32 / 127.0,
            n[1] as f32 / 127.0,
            n[2] as f32 / 127.0,
        );
        if detail_strength <= 0.0 {
            return (nx, ny, nz);
        }

        let d = self.detail[i];
        let nx = nx + d[0] as f32 / 127.0 * detail_strength;
        let ny = ny + d[1] as f32 / 127.0 * detail_strength;
        let inv_len = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt().max(1e-6);
        (nx * inv_len, ny * inv_len, nz * inv_len)
    }
}

// Building the maps only depends on the photo and the AI maps, never on the light, so the
// last result is kept around while the light is being moved.
static SURFACE_MAPS_CACHE: Mutex<Option<(blake3::Hash, Arc<SurfaceMaps>)>> = Mutex::new(None);

// The on-screen normal map view keeps its own, smaller maps so that looking at it never
// evicts the full-size ones the relight pass is using.
const PREVIEW_MAX_SIZE: u32 = 2048;
type PreviewMaps = (blake3::Hash, (u32, u32), Arc<SurfaceMaps>);
static PREVIEW_MAPS_CACHE: Mutex<Option<PreviewMaps>> = Mutex::new(None);

struct Light {
    // Position as a fraction of the image width / height.
    x: f32,
    y: f32,
    // Depth in units of the longest image side: 0 is the nearest surface, positive values
    // move towards the viewer and negative values go into the scene.
    z: f32,
    // Falloff radius, in units of the longest image side.
    radius: f32,
    color: [f32; 3],
    intensity: f32,
}

struct RelightParams {
    lights: Vec<Light>,
    // Depth covered by the full range of the depth map, in units of the longest image side.
    depth_scale: f32,
    ambient: f32,
    wrap: f32,
    specular: f32,
    detail: f32,
}

pub fn apply_relight<'a>(
    image: Cow<'a, DynamicImage>,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    if !adjustments["relightEnabled"].as_bool().unwrap_or(false) {
        return image;
    }

    let (w, h) = image.dimensions();
    if w < 2 || h < 2 {
        return image;
    }

    let start = std::time::Instant::now();
    let mut out = image.as_ref().to_rgb32f();

    let Some(maps) = cached_surface_maps(&out, adjustments) else {
        return image;
    };

    let has_depth_map = !adjustments["relightDepthMap"]
        .as_str()
        .unwrap_or("")
        .is_empty();
    let params = read_params(adjustments, has_depth_map);
    relight_in_place(&mut out, &maps, &params);

    log::info!("relight ({}x{}) took {:.2?}", w, h, start.elapsed());

    Cow::Owned(DynamicImage::ImageRgb32F(out))
}

/// Renders the normal map for inspection: scaled up, snapped to the photo's edges and with
/// the detail amount applied, like the relight pass does. It works on a reduced copy of the
/// image, which is plenty for the screen and several times faster than the full size.
pub fn render_normal_preview(
    image: &DynamicImage,
    adjustments: &serde_json::Value,
) -> Option<image::RgbImage> {
    let normal_b64 = adjustments["relightNormalMap"].as_str().unwrap_or("");
    if normal_b64.is_empty() || image.width() < 2 || image.height() < 2 {
        return None;
    }
    let depth_b64 = adjustments["relightDepthMap"].as_str().unwrap_or("");
    let depth_scale = adjustments["relightDepthScale"].as_f64().unwrap_or(0.0) as f32;

    // Keyed on the full-size image so that a hit does not even need the reduced copy.
    let mut hasher = blake3::Hasher::new();
    hasher.update(&image.width().to_le_bytes());
    hasher.update(&image.height().to_le_bytes());
    hasher.update(&depth_scale.to_le_bytes());
    hasher.update(&(normal_b64.len() as u64).to_le_bytes());
    hasher.update(normal_b64.as_bytes());
    hasher.update(depth_b64.as_bytes());
    let bytes = image.as_bytes();
    let step = (bytes.len() / 4096).max(1);
    for chunk in bytes.chunks(16).step_by(step.div_ceil(16)) {
        hasher.update(chunk);
    }
    let cache_key = hasher.finalize();

    let cached = PREVIEW_MAPS_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(key, _, _)| *key == cache_key)
        .map(|(_, size, maps)| (*size, Arc::clone(maps)));

    let ((w, h), maps) = match cached {
        Some(cached) => cached,
        None => {
            let start = std::time::Instant::now();
            let small = if image.width().max(image.height()) > PREVIEW_MAX_SIZE {
                image
                    .thumbnail(PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE)
                    .to_rgb32f()
            } else {
                image.to_rgb32f()
            };
            let size = small.dimensions();

            let normal_map = decode_data_url(normal_b64)?.into_rgba8();
            if normal_map.width() < 2 || normal_map.height() < 2 {
                return None;
            }
            let depth_map = decode_data_url(depth_b64)
                .map(|img| img.into_luma16())
                .filter(|depth| depth.dimensions() == normal_map.dimensions());

            let refine = size.0 >= MIN_REFINE_SIZE && size.1 >= MIN_REFINE_SIZE;
            let maps = Arc::new(build_surface_maps(
                &small,
                &normal_map,
                depth_map.as_ref(),
                depth_scale,
                refine,
            ));
            log::info!(
                "relight preview maps ({}x{}) built in {:.2?}",
                size.0,
                size.1,
                start.elapsed()
            );

            *PREVIEW_MAPS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((cache_key, size, Arc::clone(&maps)));
            (size, maps)
        }
    };

    let detail = read_params(adjustments, false).detail;
    // Areas without geometry (sky) are shown dark instead of as a made-up normal.
    const EMPTY: f32 = 32.0;

    let mut raw = vec![0u8; w as usize * h as usize * 3];
    raw.par_chunks_exact_mut(3).enumerate().for_each(|(i, px)| {
        let (nx, ny, nz) = maps.normal(i, detail);
        let coverage = maps.coverage[i] as f32 / 255.0;
        for (c, n) in [nx, ny, nz].into_iter().enumerate() {
            let packed = (n * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0;
            px[c] = (EMPTY + (packed - EMPTY) * coverage).round() as u8;
        }
    });

    image::RgbImage::from_raw(w, h, raw)
}

fn cached_surface_maps(
    image: &Rgb32FImage,
    adjustments: &serde_json::Value,
) -> Option<Arc<SurfaceMaps>> {
    let normal_b64 = adjustments["relightNormalMap"].as_str().unwrap_or("");
    if normal_b64.is_empty() {
        return None;
    }
    let depth_b64 = adjustments["relightDepthMap"].as_str().unwrap_or("");
    let depth_scale = adjustments["relightDepthScale"].as_f64().unwrap_or(0.0) as f32;
    let cache_key = surface_maps_key(image, normal_b64, depth_b64, depth_scale);

    let cached = SURFACE_MAPS_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(key, _)| *key == cache_key)
        .map(|(_, maps)| Arc::clone(maps));
    if cached.is_some() {
        return cached;
    }

    let start = std::time::Instant::now();
    let normal_map = decode_data_url(normal_b64)?.into_rgba8();
    if normal_map.width() < 2 || normal_map.height() < 2 {
        return None;
    }
    let depth_map = decode_data_url(depth_b64)
        .map(|img| img.into_luma16())
        .filter(|depth| depth.dimensions() == normal_map.dimensions());

    let (w, h) = image.dimensions();
    let refine = w >= MIN_REFINE_SIZE && h >= MIN_REFINE_SIZE;
    let maps = Arc::new(build_surface_maps(
        image,
        &normal_map,
        depth_map.as_ref(),
        depth_scale,
        refine,
    ));
    log::info!(
        "relight maps ({}x{}) built in {:.2?}",
        w,
        h,
        start.elapsed()
    );

    *SURFACE_MAPS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((cache_key, Arc::clone(&maps)));
    Some(maps)
}

fn decode_data_url(data_url: &str) -> Option<DynamicImage> {
    if data_url.is_empty() {
        return None;
    }
    let b64_data = match data_url.find(',') {
        Some(idx) => &data_url[idx + 1..],
        None => data_url,
    };
    let decoded = BASE64.decode(b64_data).ok()?;
    image::load_from_memory(&decoded).ok()
}

fn surface_maps_key(
    image: &Rgb32FImage,
    normal_b64: &str,
    depth_b64: &str,
    depth_scale: f32,
) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&image.width().to_le_bytes());
    hasher.update(&image.height().to_le_bytes());
    hasher.update(&depth_scale.to_le_bytes());
    hasher.update(&(normal_b64.len() as u64).to_le_bytes());
    hasher.update(normal_b64.as_bytes());
    hasher.update(depth_b64.as_bytes());

    // A sparse sample is enough to notice that the photo itself changed.
    let raw = image.as_raw();
    let step = (raw.len() / 4096).max(1);
    for value in raw.iter().step_by(step) {
        hasher.update(&value.to_le_bytes());
    }

    hasher.finalize()
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Position of a destination pixel inside a smaller source grid, for bilinear sampling.
struct Tap {
    i0: usize,
    i1: usize,
    t: f32,
}

fn taps(dst: usize, src: usize) -> Vec<Tap> {
    let scale = src as f32 / dst as f32;
    (0..dst)
        .map(|d| {
            let f = ((d as f32 + 0.5) * scale - 0.5).clamp(0.0, (src - 1) as f32);
            let i0 = f as usize;
            Tap {
                i0,
                i1: (i0 + 1).min(src - 1),
                t: f - i0 as f32,
            }
        })
        .collect()
}

fn resample_plane(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    let x_taps = taps(dw, sw);
    let y_taps = taps(dh, sh);
    let mut out = vec![0.0f32; dw * dh];
    out.par_chunks_exact_mut(dw)
        .enumerate()
        .for_each(|(y, row)| {
            let ty = &y_taps[y];
            for (x, value) in row.iter_mut().enumerate() {
                let tx = &x_taps[x];
                let top = src[ty.i0 * sw + tx.i0] * (1.0 - tx.t) + src[ty.i0 * sw + tx.i1] * tx.t;
                let bot = src[ty.i1 * sw + tx.i0] * (1.0 - tx.t) + src[ty.i1 * sw + tx.i1] * tx.t;
                *value = top + (bot - top) * ty.t;
            }
        });
    out
}

/// Local standard deviation of a plane, used to find where it has a hard edge.
fn local_deviation(plane: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    let mut mean = plane.to_vec();
    dof_box_filter(&mut mean, w, h, 1, radius);
    let mut mean_sq: Vec<f32> = plane.iter().map(|v| v * v).collect();
    dof_box_filter(&mut mean_sq, w, h, 1, radius);
    mean.iter()
        .zip(&mean_sq)
        .map(|(m, sq)| (sq - m * m).max(0.0).sqrt())
        .collect()
}

/// Scales the AI maps up to the image. With `refine`, silhouettes (hair, object outlines)
/// are snapped to the edges of the photo instead of being left as a soft blur, while the
/// inside of each surface keeps the detail the model predicted.
fn build_surface_maps(
    image: &Rgb32FImage,
    normal_map: &RgbaImage,
    depth_map: Option<&DepthMap>,
    depth_scale: f32,
    refine: bool,
) -> SurfaceMaps {
    let w = image.width() as usize;
    let h = image.height() as usize;
    let nw = normal_map.width() as usize;
    let nh = normal_map.height() as usize;

    // Planes 0-2: normal packed to 0..1, 3: coverage, 4: depth.
    let normal_raw = normal_map.as_raw();
    let mut planes: Vec<Vec<f32>> = (0..4)
        .map(|c| {
            normal_raw
                .iter()
                .skip(c)
                .step_by(4)
                .map(|v| *v as f32 / 255.0)
                .collect()
        })
        .collect();
    planes.push(match depth_map {
        Some(depth) => depth.as_raw().iter().map(|v| *v as f32 / 65535.0).collect(),
        None => vec![0.0; nw * nh],
    });

    let (gw, gh, models, edge_weight, luma_full) = if refine {
        let LumaGuide {
            luma_full,
            guide,
            gw,
            gh,
        } = build_luma_guide(image);

        planes = planes
            .iter()
            .map(|plane| resample_plane(plane, nw, nh, gw, gh))
            .collect();

        let radius = ((gw.max(gh) as f32) * 0.015).round().max(2.0) as usize;

        // Only trust the photo's edges where the geometry really breaks: a depth jump or the
        // border of the valid area. Elsewhere the filter would just blur the normals.
        let coverage_dev = local_deviation(&planes[3], gw, gh, radius);
        let has_depth = depth_map.is_some() && depth_scale > 0.0;
        let other_dev = if has_depth {
            local_deviation(&planes[4], gw, gh, radius)
        } else {
            local_deviation(&planes[2], gw, gh, radius)
        };
        let mut edge_weight: Vec<f32> = coverage_dev
            .iter()
            .zip(&other_dev)
            .map(|(cov, other)| {
                let geometry = if has_depth {
                    smoothstep(0.01, 0.06, other * depth_scale)
                } else {
                    smoothstep(0.05, 0.2, *other)
                };
                smoothstep(0.05, 0.25, *cov).max(geometry)
            })
            .collect();
        dof_box_filter(&mut edge_weight, gw, gh, 1, (radius / 2).max(1));

        let models: Vec<Vec<f32>> = planes
            .par_iter()
            .map(|plane| build_guided_model(&guide, plane, gw, gh, radius))
            .collect();

        (gw, gh, models, edge_weight, luma_full)
    } else {
        (nw, nh, Vec::new(), Vec::new(), Vec::new())
    };

    let x_taps = taps(w, gw);
    let y_taps = taps(h, gh);

    let mut normals = vec![[0i8; 3]; w * h];
    let mut coverage = vec![0u8; w * h];
    let mut depth = vec![0u16; w * h];
    let mut detail = vec![[0i8; 2]; w * h];

    // A feature that is one pixel wide in a small render spans several pixels in a large
    // one, so slopes are measured against a fixed reference size.
    let detail_gain = DETAIL_GAIN * w.max(h) as f32 / 1000.0;

    normals
        .par_chunks_exact_mut(w)
        .zip(coverage.par_chunks_exact_mut(w))
        .zip(depth.par_chunks_exact_mut(w))
        .zip(detail.par_chunks_exact_mut(w))
        .enumerate()
        .for_each(
            |(y, (((normal_row, coverage_row), depth_row), detail_row))| {
                let ty = &y_taps[y];
                let (r0, r1) = (ty.i0 * gw, ty.i1 * gw);

                for x in 0..w {
                    let tx = &x_taps[x];
                    let (i00, i10, i01, i11) = (r0 + tx.i0, r0 + tx.i1, r1 + tx.i0, r1 + tx.i1);
                    let bilerp = |v00: f32, v10: f32, v01: f32, v11: f32| {
                        let top = v00 + (v10 - v00) * tx.t;
                        let bot = v01 + (v11 - v01) * tx.t;
                        top + (bot - top) * ty.t
                    };

                    let mut values = [0.0f32; 5];
                    for (c, value) in values.iter_mut().enumerate() {
                        let plane = &planes[c];
                        *value = bilerp(plane[i00], plane[i10], plane[i01], plane[i11]);
                    }

                    if refine {
                        let weight = bilerp(
                            edge_weight[i00],
                            edge_weight[i10],
                            edge_weight[i01],
                            edge_weight[i11],
                        );

                        // Treat brightness as height and take its slope (Sobel). A silhouette is
                        // a change of object rather than relief, so it is left out.
                        let (xl, xr) = (x.saturating_sub(1), (x + 1).min(w - 1));
                        let (yu, yd) = (y.saturating_sub(1) * w, (y + 1).min(h - 1) * w);
                        let yc = y * w;
                        let l = |row: usize, col: usize| luma_full[row + col];
                        let slope_x = (l(yu, xr) + 2.0 * l(yc, xr) + l(yd, xr)
                            - l(yu, xl)
                            - 2.0 * l(yc, xl)
                            - l(yd, xl))
                            * 0.125;
                        let slope_y = (l(yd, xl) + 2.0 * l(yd, x) + l(yd, xr)
                            - l(yu, xl)
                            - 2.0 * l(yu, x)
                            - l(yu, xr))
                            * 0.125;
                        // The surface leans away from the uphill direction; image Y points down.
                        let tilt_x = -slope_x * detail_gain;
                        let tilt_y = slope_y * detail_gain;
                        let soft_clip = (1.0 - weight).max(0.0)
                            / (1.0 + (tilt_x * tilt_x + tilt_y * tilt_y).sqrt());
                        detail_row[x] = [
                            (tilt_x * soft_clip * 127.0).round() as i8,
                            (tilt_y * soft_clip * 127.0).round() as i8,
                        ];
                        if weight > 1e-3 {
                            let luma = luma_full[y * w + x];
                            for (c, value) in values.iter_mut().enumerate() {
                                let model = &models[c];
                                let m = |k: usize| {
                                    bilerp(
                                        model[i00 * 4 + k],
                                        model[i10 * 4 + k],
                                        model[i01 * 4 + k],
                                        model[i11 * 4 + k],
                                    )
                                };
                                let mut guided =
                                    (m(0) * luma + m(1)).clamp(m(2), m(3)).clamp(0.0, 1.0);
                                if c == 3 {
                                    // Coverage is a matte: push it back towards solid / empty so the
                                    // photo's texture does not leak into it as a halo.
                                    guided = smoothstep(0.25, 0.75, guided);
                                }
                                *value += (guided - *value) * weight;
                            }
                        }
                    }

                    let nx = values[0] * 2.0 - 1.0;
                    let ny = values[1] * 2.0 - 1.0;
                    let nz = values[2] * 2.0 - 1.0;
                    let scale = 127.0 / (nx * nx + ny * ny + nz * nz).sqrt().max(1e-6);
                    normal_row[x] = [
                        (nx * scale).round() as i8,
                        (ny * scale).round() as i8,
                        (nz * scale).round() as i8,
                    ];
                    coverage_row[x] = (values[3].clamp(0.0, 1.0) * 255.0).round() as u8;
                    depth_row[x] = (values[4].clamp(0.0, 1.0) * 65535.0).round() as u16;
                }
            },
        );

    SurfaceMaps {
        normals,
        coverage,
        depth,
        detail,
    }
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

fn read_light(light: &serde_json::Value, depth_scale: f32) -> Light {
    let num = |key: &str, default: f64| light[key].as_f64().unwrap_or(default) as f32;

    let range = (num("range", 60.0) / 100.0).clamp(0.0, 1.0);

    // Forwards the light moves linearly away from the scene. Backwards it eases in, so
    // small moves place it just behind the subject even when the background is far away.
    let depth = (num("depth", 30.0) / 100.0).clamp(-1.0, 1.0);
    let z = if depth >= 0.0 {
        0.02 + depth * MAX_FRONT_DISTANCE
    } else {
        0.02 - depth * depth * depth_scale.clamp(0.5, 10.0)
    };

    Light {
        x: num("x", 0.3),
        y: num("y", 0.3),
        z,
        radius: 0.1 + 1.9 * range * range,
        color: parse_light_color(light["color"].as_str().unwrap_or("#ffffff")),
        intensity: (num("intensity", 50.0) / 100.0).clamp(0.0, 1.0) * 2.0,
    }
}

fn read_params(adjustments: &serde_json::Value, has_depth_map: bool) -> RelightParams {
    let num = |key: &str, default: f64| adjustments[key].as_f64().unwrap_or(default) as f32;

    let depth_scale = if has_depth_map {
        num("relightDepthScale", 0.0).max(0.0)
    } else {
        0.0
    };

    let lights = match adjustments["relightLights"].as_array() {
        Some(lights) => lights
            .iter()
            .take(MAX_LIGHTS)
            .map(|light| read_light(light, depth_scale))
            .collect(),
        // Edits saved before multiple lights existed describe a single light at the top level.
        None => vec![read_light(
            &serde_json::json!({
                "x": adjustments["relightX"],
                "y": adjustments["relightY"],
                "depth": adjustments["relightDepth"],
                "range": adjustments["relightRange"],
                "color": adjustments["relightColor"],
                "intensity": adjustments["relightIntensity"],
            }),
            depth_scale,
        )],
    };

    RelightParams {
        lights,
        depth_scale,
        ambient: (num("relightAmbient", 80.0) / 100.0).clamp(0.0, 1.0),
        wrap: (num("relightSoftness", 30.0) / 100.0).clamp(0.0, 1.0),
        specular: (num("relightSpecular", 0.0) / 100.0).clamp(0.0, 1.0),
        detail: (num("relightDetail", 30.0) / 100.0).clamp(0.0, 1.0) * 2.0,
    }
}

fn relight_in_place(image: &mut Rgb32FImage, maps: &SurfaceMaps, p: &RelightParams) {
    let w = image.width() as usize;
    let h = image.height() as usize;

    let depth_to_z = -p.depth_scale / 65535.0;
    let inv_long_side = 1.0 / w.max(h) as f32;

    // Per light: position in pixels, depth and inverse squared falloff radius.
    let lights: Vec<(f32, f32, f32, f32, &Light)> = p
        .lights
        .iter()
        .filter(|light| light.intensity > 0.0)
        .map(|light| {
            (
                light.x * w as f32,
                light.y * h as f32,
                light.z,
                1.0 / (light.radius * light.radius),
                light,
            )
        })
        .collect();

    image
        .as_mut()
        .par_chunks_exact_mut(w * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, px) in row.chunks_exact_mut(3).enumerate() {
                let i = y * w + x;

                let coverage = maps.coverage[i] as f32 / 255.0;
                if coverage <= 0.0 {
                    continue;
                }

                let (nx, ny, nz) = maps.normal(i, p.detail);
                let surface_z = maps.depth[i] as f32 * depth_to_z;

                let mut lit = [0.0f32; 3];
                for (light_px, light_py, light_z, inv_radius_sq, light) in &lights {
                    let lx = (light_px - (x as f32 + 0.5)) * inv_long_side;
                    // Image rows grow downwards while the normal map uses Y up.
                    let ly = -(light_py - (y as f32 + 0.5)) * inv_long_side;
                    let lz = light_z - surface_z;
                    let dist_sq = lx * lx + ly * ly + lz * lz;
                    let inv_l_len = 1.0 / dist_sq.sqrt().max(1e-6);
                    let (dx, dy, dz) = (lx * inv_l_len, ly * inv_l_len, lz * inv_l_len);

                    let attenuation = 1.0 / (1.0 + dist_sq * inv_radius_sq);

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

                    let amount = light.intensity * attenuation * (diffuse + spec);
                    for c in 0..3 {
                        lit[c] += amount * light.color[c];
                    }
                }

                for c in 0..3 {
                    let gain = p.ambient + lit[c];
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
        relit_pixel_with_depth(adjustments, normal_map, None, x)
    }

    fn relit_pixel_with_depth(
        adjustments: serde_json::Value,
        normal_map: &RgbaImage,
        depth_map: Option<&DepthMap>,
        x: u32,
    ) -> [f32; 3] {
        let mut image = Rgb32FImage::from_pixel(8, 8, Rgb([0.5, 0.5, 0.5]));
        let params = read_params(&adjustments, depth_map.is_some());
        let maps = build_surface_maps(&image, normal_map, depth_map, params.depth_scale, false);
        relight_in_place(&mut image, &maps, &params);
        image.get_pixel(x, 3).0
    }

    #[test]
    fn surface_facing_the_light_gets_brighter_than_one_facing_away() {
        let adjustments = json!({
            "relightX": 1.0, "relightY": 0.5, "relightDepth": 0, "relightSoftness": 0, "relightRange": 100,
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
            "relightX": 0.5, "relightY": 0.0, "relightDepth": 0, "relightSoftness": 0, "relightRange": 100,
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
            json!({ "relightX": 0.0, "relightY": 0.5, "relightDepth": 50, "relightRange": 20 });
        let normal_map = flat_normal_map([128, 128, 255], 255);
        let near = relit_pixel(adjustments.clone(), &normal_map, 0);
        let far = relit_pixel(adjustments, &normal_map, 7);

        assert!(near[1] > far[1]);
    }

    #[test]
    fn light_behind_a_surface_does_not_light_its_front() {
        let normal_map = flat_normal_map([128, 128, 255], 255);
        let depth_map = DepthMap::from_pixel(4, 4, Luma([0]));
        let adjustments = |depth: i32| {
            json!({
                "relightX": 0.5, "relightY": 0.5, "relightDepth": depth, "relightSoftness": 0,
                "relightAmbient": 100, "relightDepthScale": 2.0,
            })
        };

        let in_front = relit_pixel_with_depth(adjustments(40), &normal_map, Some(&depth_map), 3);
        let behind = relit_pixel_with_depth(adjustments(-40), &normal_map, Some(&depth_map), 3);

        assert!(in_front[1] > 0.5);
        assert_eq!(behind[1], 0.5);
    }

    #[test]
    fn light_behind_the_subject_still_reaches_the_background() {
        let normal_map = flat_normal_map([128, 128, 255], 255);
        let adjustments = json!({
            "relightX": 0.5, "relightY": 0.5, "relightDepth": -40, "relightSoftness": 0,
            "relightAmbient": 100, "relightDepthScale": 2.0,
        });

        let subject = DepthMap::from_pixel(4, 4, Luma([0]));
        let background = DepthMap::from_pixel(4, 4, Luma([u16::MAX]));
        let on_subject =
            relit_pixel_with_depth(adjustments.clone(), &normal_map, Some(&subject), 3);
        let on_background = relit_pixel_with_depth(adjustments, &normal_map, Some(&background), 3);

        assert_eq!(on_subject[1], 0.5);
        assert!(on_background[1] > 0.5);
    }

    #[test]
    fn refinement_snaps_a_soft_depth_edge_to_the_photo_edge() {
        // Photo: dark subject on the left, bright background on the right, hard edge at x = 2048.
        let image = Rgb32FImage::from_fn(4096, 96, |x, _| {
            if x < 2048 {
                Rgb([0.05, 0.05, 0.05])
            } else {
                Rgb([0.8, 0.8, 0.8])
            }
        });
        // Maps: the same split at 1/16 of the resolution, so the edge comes out blurry.
        let normal_map = RgbaImage::from_pixel(256, 6, Rgba([128, 128, 255, 255]));
        let depth_map =
            DepthMap::from_fn(256, 6, |x, _| Luma([if x < 128 { 0 } else { u16::MAX }]));

        // Depth change over the few pixels around the photo edge.
        let depth_step = |refine: bool| {
            let maps = build_surface_maps(&image, &normal_map, Some(&depth_map), 2.0, refine);
            let row = 48 * 4096;
            maps.depth[row + 2051] as f32 - maps.depth[row + 2045] as f32
        };

        let soft = depth_step(false);
        let refined = depth_step(true);

        assert!(soft > 0.0);
        assert!(refined > soft * 1.5, "refined {refined} vs bilinear {soft}");
    }

    #[test]
    fn detail_tilts_the_surface_along_the_photo_texture() {
        // A bright ridge down the middle of a flat, camera-facing surface.
        let image = Rgb32FImage::from_fn(1000, 64, |x, _| {
            let v = 0.2 + 0.6 * (-((x as f32 - 500.0) / 6.0).powi(2)).exp();
            Rgb([v, v, v])
        });
        let normal_map = RgbaImage::from_pixel(16, 16, Rgba([128, 128, 255, 255]));
        let maps = build_surface_maps(&image, &normal_map, None, 0.0, true);
        let row = 32 * 1000;

        // Left of the ridge the surface climbs to the right, so it faces left; and vice versa.
        let (left_nx, _, _) = maps.normal(row + 494, 1.0);
        let (right_nx, _, _) = maps.normal(row + 506, 1.0);
        assert!(left_nx < -0.05, "left side nx {left_nx}");
        assert!(right_nx > 0.05, "right side nx {right_nx}");

        // Without detail the AI normal is used as is.
        let (plain_nx, _, plain_nz) = maps.normal(row + 494, 0.0);
        assert!(plain_nx.abs() < 0.02 && plain_nz > 0.98);
    }

    #[test]
    fn normal_preview_shows_normals_and_darkens_empty_areas() {
        let image = DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(8, 8, Rgb([0.5, 0.5, 0.5])));
        let encode = |alpha: u8| {
            let mut buf = std::io::Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(flat_normal_map([128, 128, 255], alpha))
                .write_to(&mut buf, image::ImageFormat::Png)
                .unwrap();
            format!("data:image/png;base64,{}", BASE64.encode(buf.get_ref()))
        };

        let solid = render_normal_preview(&image, &json!({ "relightNormalMap": encode(255) }));
        let empty = render_normal_preview(&image, &json!({ "relightNormalMap": encode(0) }));

        let solid = solid.unwrap().get_pixel(3, 3).0;
        assert!(solid[2] > 250 && (solid[0] as i32 - 128).abs() <= 2);
        assert_eq!(empty.unwrap().get_pixel(3, 3).0, [32, 32, 32]);
        assert!(render_normal_preview(&image, &json!({})).is_none());
    }

    #[test]
    fn normal_preview_is_rendered_from_a_reduced_copy_of_large_images() {
        let image = DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(4096, 1024, Rgb([0.5; 3])));
        let mut buf = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(flat_normal_map([200, 128, 220], 255))
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let adjustments = json!({
            "relightNormalMap": format!("data:image/png;base64,{}", BASE64.encode(buf.get_ref())),
        });

        let preview = render_normal_preview(&image, &adjustments).unwrap();
        assert_eq!(preview.dimensions(), (2048, 512));
        let px = preview.get_pixel(1000, 200).0;
        assert!(
            px[0] > 180 && px[2] > 200,
            "unexpected normal colour {px:?}"
        );

        // A second request for the same image is served from the cached maps.
        let again = render_normal_preview(&image, &adjustments).unwrap();
        assert_eq!(preview, again);
    }

    #[test]
    fn refinement_keeps_normals_away_from_edges() {
        let image = Rgb32FImage::from_fn(128, 128, |x, y| {
            let v = ((x / 8 + y / 8) % 2) as f32 * 0.5 + 0.2;
            Rgb([v, v, v])
        });
        // A textured photo over a flat, evenly tilted surface: there is no geometric edge to snap to.
        let normal_map = RgbaImage::from_pixel(16, 16, Rgba([200, 128, 220, 255]));
        let depth_map = DepthMap::from_pixel(16, 16, Luma([1000]));

        let plain = build_surface_maps(&image, &normal_map, Some(&depth_map), 2.0, false);
        let refined = build_surface_maps(&image, &normal_map, Some(&depth_map), 2.0, true);

        assert_eq!(plain.normals, refined.normals);
        assert_eq!(plain.depth, refined.depth);
    }

    #[test]
    fn several_lights_add_up_with_their_own_colors() {
        let normal_map = flat_normal_map([128, 128, 255], 255);
        let red = json!({ "x": 0.0, "y": 0.5, "color": "#ff0000", "range": 20 });
        let blue = json!({ "x": 1.0, "y": 0.5, "color": "#0000ff", "range": 20 });
        let both = json!({ "relightLights": [red, blue] });

        let near_red = relit_pixel(both.clone(), &normal_map, 0);
        let near_blue = relit_pixel(both.clone(), &normal_map, 7);
        assert!(near_red[0] > near_red[2]);
        assert!(near_blue[2] > near_blue[0]);

        let only_red = relit_pixel(json!({ "relightLights": [red] }), &normal_map, 0);
        assert!(near_red[2] > only_red[2]);
    }

    #[test]
    fn no_lights_leaves_only_the_ambient_level() {
        let adjustments = json!({ "relightLights": [], "relightAmbient": 50 });
        let lit = relit_pixel(adjustments, &flat_normal_map([128, 128, 255], 255), 3);

        assert_eq!(lit, [0.25; 3]);
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
