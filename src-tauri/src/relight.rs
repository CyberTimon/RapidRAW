use image::{DynamicImage, GenericImageView};
use rayon::prelude::*;
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct RelightCache {
    key: u64,
    nw: usize,
    nh: usize,
    surface_models: Arc<Vec<(Vec<f32>, Vec<f32>)>>,
    shadow_inputs: Option<Arc<ShadowInputs>>,
    shadow_models: Vec<(u64, Arc<GuidedModel>)>,
}

static RELIGHT_CACHE: Mutex<Option<RelightCache>> = Mutex::new(None);

enum RelightKind {
    Point,
    Spot {
        beam: [f32; 3],
        outer: f32,
        inner: f32,
    },
    Directional {
        dir: [f32; 3],
    },
}

struct RelightLight {
    kind: RelightKind,
    pos: [f32; 3],
    color: [f32; 3],
    radius2: f32,
}

#[inline(always)]
fn relight_smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
pub(crate) fn relight_luma(r: f32, g: f32, b: f32) -> f32 {
    (0.2126 * r + 0.7152 * g + 0.0722 * b).max(0.0).sqrt()
}

pub(crate) struct RelightTap {
    i00: usize,
    i10: usize,
    i01: usize,
    i11: usize,
    wx: f32,
    wy: f32,
}

impl RelightTap {
    #[inline(always)]
    pub(crate) fn new(u: f32, v: f32, w: usize, h: usize) -> Self {
        let fx = (u * w as f32 - 0.5).clamp(0.0, (w - 1) as f32);
        let fy = (v * h as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        Self {
            i00: y0 * w + x0,
            i10: y0 * w + x1,
            i01: y1 * w + x0,
            i11: y1 * w + x1,
            wx: fx - x0 as f32,
            wy: fy - y0 as f32,
        }
    }

    #[inline(always)]
    pub(crate) fn sample(&self, buf: &[f32]) -> f32 {
        let top = buf[self.i00] + (buf[self.i10] - buf[self.i00]) * self.wx;
        let bot = buf[self.i01] + (buf[self.i11] - buf[self.i01]) * self.wx;
        top + (bot - top) * self.wy
    }

    #[inline(always)]
    pub(crate) fn guided(&self, model: &(Vec<f32>, Vec<f32>), guide: f32) -> f32 {
        self.sample(&model.0) * guide + self.sample(&model.1)
    }
}

pub(crate) fn build_relight_guide(
    raw: &[f32],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
) -> Vec<f32> {
    let mut guide = vec![0.0f32; dw * dh];
    guide
        .par_chunks_exact_mut(dw)
        .enumerate()
        .for_each(|(dy, row)| {
            let sy0 = dy * h / dh;
            let sy1 = ((dy + 1) * h / dh).clamp(sy0 + 1, h);
            for (dx, out) in row.iter_mut().enumerate() {
                let sx0 = dx * w / dw;
                let sx1 = ((dx + 1) * w / dw).clamp(sx0 + 1, w);
                let mut acc = 0.0f32;
                for sy in sy0..sy1 {
                    for sx in sx0..sx1 {
                        let i = (sy * w + sx) * 3;
                        acc += relight_luma(raw[i], raw[i + 1], raw[i + 2]);
                    }
                }
                *out = acc / ((sy1 - sy0) * (sx1 - sx0)) as f32;
            }
        });
    guide
}

pub(crate) struct GuideStats {
    radius: usize,
    mean_i: Vec<f32>,
    var_i: Vec<f32>,
}

impl GuideStats {
    pub(crate) fn new(guide: &[f32], w: usize, h: usize, radius: usize) -> Self {
        let mut mean_i = guide.to_vec();
        crate::lens_blur::dof_box_filter(&mut mean_i, w, h, 1, radius);
        let mut var_i: Vec<f32> = guide.iter().map(|g| g * g).collect();
        crate::lens_blur::dof_box_filter(&mut var_i, w, h, 1, radius);
        var_i
            .par_iter_mut()
            .zip(mean_i.par_iter())
            .for_each(|(v, m)| *v = (*v - m * m).max(0.0));
        Self {
            radius,
            mean_i,
            var_i,
        }
    }
}

pub(crate) fn build_guided_model(
    guide: &[f32],
    p: &[f32],
    w: usize,
    h: usize,
    radius: usize,
    eps: f32,
) -> (Vec<f32>, Vec<f32>) {
    let stats = GuideStats::new(guide, w, h, radius);
    build_guided_model_with(&stats, guide, p, w, h, eps)
}

pub(crate) fn build_guided_model_with(
    stats: &GuideStats,
    guide: &[f32],
    p: &[f32],
    w: usize,
    h: usize,
    eps: f32,
) -> (Vec<f32>, Vec<f32>) {
    let box_mean = |mut buf: Vec<f32>| {
        crate::lens_blur::dof_box_filter(&mut buf, w, h, 1, stats.radius);
        buf
    };

    let mean_p = box_mean(p.to_vec());
    let corr_ip = box_mean(guide.iter().zip(p).map(|(g, q)| g * q).collect());

    let (a, b): (Vec<f32>, Vec<f32>) = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let mean_i = stats.mean_i[i];
            let a = (corr_ip[i] - mean_i * mean_p[i]) / (stats.var_i[i] + eps);
            (a, mean_p[i] - a * mean_i)
        })
        .unzip();

    (box_mean(a), box_mean(b))
}

struct ShadowInputs {
    guide: Vec<f32>,
    depth: Vec<f32>,
    depth_range: [f32; 2],
    stats: GuideStats,
}

type GuidedModel = (Vec<f32>, Vec<f32>);

fn shadow_key(light: &RelightLight, shadow_softness: f32) -> u64 {
    let mut hasher = DefaultHasher::new();
    shadow_softness.to_bits().hash(&mut hasher);
    match light.kind {
        RelightKind::Directional { dir } => {
            0u8.hash(&mut hasher);
            dir.map(f32::to_bits).hash(&mut hasher);
        }
        _ => {
            1u8.hash(&mut hasher);
            light.pos.map(f32::to_bits).hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn build_shadow_map(
    depth: &[f32],
    depth_range: [f32; 2],
    sw: usize,
    sh: usize,
    aspect: [f32; 2],
    light: &RelightLight,
    shadow_softness: f32,
) -> Vec<f32> {
    let mut shadow = vec![1.0f32; sw * sh];
    let (swf, shf) = (sw as f32, sh as f32);
    let z_lo = depth_range[0] + 0.01;
    let z_hi = depth_range[1] + 0.3;

    shadow
        .par_chunks_exact_mut(sw)
        .enumerate()
        .for_each(|(y, row)| {
            let v = (y as f32 + 0.5) / shf;
            let depth_row = &depth[y * sw..(y + 1) * sw];
            for (x, out) in row.iter_mut().enumerate() {
                let u = (x as f32 + 0.5) / swf;
                let p = [(u - 0.5) * aspect[0], (v - 0.5) * aspect[1], depth_row[x]];
                let ray = match light.kind {
                    RelightKind::Directional { dir } => {
                        let planar = (dir[0] * dir[0] + dir[1] * dir[1]).sqrt();
                        let len = (0.5 / planar.max(1e-3)).min(2.0);
                        [dir[0] * len, dir[1] * len, dir[2] * len]
                    }
                    _ => [
                        light.pos[0] - p[0],
                        light.pos[1] - p[1],
                        light.pos[2] - p[2],
                    ],
                };

                let (fx0, fy0) = (u * swf, v * shf);
                let (dx, dy) = (ray[0] / aspect[0] * swf, ray[1] / aspect[1] * shf);
                let rising = ray[2] >= 0.0;

                let jitter = (52.982_918
                    * (0.067_110_56 * x as f32 + 0.005_837_15 * y as f32).fract())
                .fract();
                let mut occlusion = 0.0f32;
                for k in 1..=64 {
                    let t = (k as f32 - jitter) * (1.0 / 64.0);
                    let fx = fx0 + dx * t;
                    let fy = fy0 + dy * t;
                    if !(0.0..swf).contains(&fx) || !(0.0..shf).contains(&fy) {
                        break;
                    }
                    let rz = p[2] + ray[2] * t;
                    if (rising && rz >= z_hi) || (!rising && rz <= z_lo) {
                        break;
                    }
                    let diff = rz - depth[fy as usize * sw + fx as usize];
                    if diff <= 0.01 || diff >= 0.3 {
                        continue;
                    }
                    occlusion = occlusion.max(
                        relight_smoothstep(0.01, 0.04, diff)
                            * (1.0 - relight_smoothstep(0.15, 0.3, diff)),
                    );
                    if occlusion >= 1.0 {
                        break;
                    }
                }
                *out = 1.0 - occlusion;
            }
        });

    let radius = (shadow_softness * sw.max(sh) as f32 * 0.02).round() as usize;
    crate::lens_blur::dof_box_filter(&mut shadow, sw, sh, 1, radius);
    crate::lens_blur::dof_box_filter(&mut shadow, sw, sh, 1, radius);
    shadow
}

pub fn apply_relight<'a>(
    image: Cow<'a, DynamicImage>,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    if !crate::image_processing::is_effect_enabled(adjustments, "relight", "relightEnabled") {
        return image;
    }

    let normal_b64 = adjustments["relightNormalMap"].as_str().unwrap_or("");
    if normal_b64.is_empty() {
        return image;
    }

    let ambient = adjustments["relightAmbient"].as_f64().unwrap_or(0.0) as f32;
    let softness =
        (adjustments["relightSoftness"].as_f64().unwrap_or(25.0) as f32 / 100.0).clamp(0.0, 1.0);
    let shine =
        (adjustments["relightShine"].as_f64().unwrap_or(0.0) as f32 / 100.0).clamp(0.0, 1.0);
    let shadows_enabled = adjustments["relightShadows"].as_bool().unwrap_or(false);
    let shadow_softness = (adjustments["relightShadowSoftness"]
        .as_f64()
        .unwrap_or(15.0) as f32
        / 100.0)
        .clamp(0.0, 1.0);

    let (w, h) = image.dimensions();
    if w < 2 || h < 2 {
        return image;
    }
    let long_side = w.max(h) as f32;
    let aspect_x = w as f32 / long_side;
    let aspect_y = h as f32 / long_side;

    let lights: Vec<RelightLight> = adjustments["relightLights"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|l| l["visible"].as_bool().unwrap_or(true))
                .map(|l| {
                    let get = |key: &str, default: f64| l[key].as_f64().unwrap_or(default) as f32;
                    let temperature = get("temperature", 0.0) / 100.0;
                    let tint = get("tint", 0.0) / 100.0;
                    let base = l["color"]
                        .as_str()
                        .and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
                        .map(|hex| {
                            [hex >> 16, hex >> 8, hex].map(|c| ((c & 255) as f32 / 255.0).powf(2.2))
                        })
                        .unwrap_or([1.0; 3]);
                    let rgb = [
                        base[0] * (1.0 + 0.45 * temperature + 0.15 * tint),
                        base[1] * (1.0 - 0.35 * tint),
                        base[2] * (1.0 - 0.45 * temperature + 0.15 * tint),
                    ];
                    let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
                    let strength = get("intensity", 60.0).max(0.0) / 100.0 * 4.0 / luma.max(1e-3);
                    let radius = 0.05 + get("radius", 30.0) / 100.0 * 1.45;
                    let angle = get("angle", 135.0).to_radians();
                    let elevation = get("elevation", 60.0).clamp(-180.0, 180.0).to_radians();
                    let (plane_x, plane_y) = (
                        angle.cos() * elevation.cos(),
                        -angle.sin() * elevation.cos(),
                    );
                    let kind = match l["type"].as_str().unwrap_or("point") {
                        "directional" => RelightKind::Directional {
                            dir: [plane_x, plane_y, -elevation.sin()],
                        },
                        "spot" => {
                            let half = (5.0 + get("cone", 40.0).clamp(0.0, 100.0) / 100.0 * 80.0)
                                .to_radians();
                            let feather = get("feather", 50.0).clamp(0.0, 100.0) / 100.0;
                            RelightKind::Spot {
                                beam: [plane_x, plane_y, elevation.sin()],
                                outer: half.cos(),
                                inner: (half * (1.0 - feather)).cos(),
                            }
                        }
                        _ => RelightKind::Point,
                    };
                    RelightLight {
                        kind,
                        pos: [
                            (get("x", 0.5) - 0.5) * aspect_x,
                            (get("y", 0.5) - 0.5) * aspect_y,
                            get("depth", 0.0) / 100.0 * 1.25 - 0.25,
                        ],
                        color: rgb.map(|c| c.max(0.0) * strength),
                        radius2: radius * radius,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    if lights.is_empty() && ambient == 0.0 {
        return image;
    }

    let start = std::time::Instant::now();

    let wu = w as usize;
    let hu = h as usize;
    let mut out = image.into_owned().into_rgb32f();
    let eps = 2.0e-3;

    let cache_key = {
        let mut hasher = DefaultHasher::new();
        crate::effect_maps::effect_map_key(normal_b64, adjustments).hash(&mut hasher);
        (w, h).hash(&mut hasher);
        let raw = out.as_raw();
        for value in raw.iter().step_by((raw.len() / 4096).max(1)) {
            value.to_bits().hash(&mut hasher);
        }
        hasher.finish()
    };

    let cached = RELIGHT_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|c| c.key == cache_key)
        .cloned();

    let mut cache = match cached {
        Some(cache) => cache,
        None => {
            let normal_map = match crate::effect_maps::resolve_rgba_map(normal_b64, adjustments) {
                Some(map) => map,
                None => return Cow::Owned(DynamicImage::ImageRgb32F(out)),
            };
            let (nw, nh) = (normal_map.width() as usize, normal_map.height() as usize);
            if nw < 2 || nh < 2 {
                return Cow::Owned(DynamicImage::ImageRgb32F(out));
            }

            let map_guide = build_relight_guide(out.as_raw(), wu, hu, nw, nh);
            let map_radius = ((nw.max(nh) as f32 * 0.006).round() as usize).max(2);
            let surface_models = (0..4)
                .map(|c| {
                    let plane: Vec<f32> = normal_map
                        .pixels()
                        .map(|p| match c {
                            0 => p[0] as f32 / 127.5 - 1.0,
                            1 => 1.0 - p[1] as f32 / 127.5,
                            2 => 1.0 - p[2] as f32 / 127.5,
                            _ => p[3] as f32 / 255.0,
                        })
                        .collect();
                    build_guided_model(&map_guide, &plane, nw, nh, map_radius, eps)
                })
                .collect();

            RelightCache {
                key: cache_key,
                nw,
                nh,
                surface_models: Arc::new(surface_models),
                shadow_inputs: None,
                shadow_models: Vec::new(),
            }
        }
    };

    let (nw, nh) = (cache.nw, cache.nh);
    let shadow_scale = (2048.0 / long_side).min(1.0);
    let sw = ((w as f32 * shadow_scale).round() as usize).max(2);
    let sh = ((h as f32 * shadow_scale).round() as usize).max(2);

    if shadows_enabled && !lights.is_empty() && cache.shadow_inputs.is_none() {
        let shadow_guide = build_relight_guide(out.as_raw(), wu, hu, sw, sh);
        let depth: Vec<f32> = (0..sw * sh)
            .into_par_iter()
            .map(|i| {
                let tap = RelightTap::new(
                    ((i % sw) as f32 + 0.5) / sw as f32,
                    ((i / sw) as f32 + 0.5) / sh as f32,
                    nw,
                    nh,
                );
                tap.guided(&cache.surface_models[3], shadow_guide[i])
                    .clamp(0.0, 1.0)
            })
            .collect();
        let depth_range = depth
            .par_iter()
            .fold(
                || [f32::INFINITY, f32::NEG_INFINITY],
                |[lo, hi], &d| [lo.min(d), hi.max(d)],
            )
            .reduce(
                || [f32::INFINITY, f32::NEG_INFINITY],
                |a, b| [a[0].min(b[0]), a[1].max(b[1])],
            );
        let shadow_radius = ((sw.max(sh) as f32 * 0.003).round() as usize).max(2);
        let stats = GuideStats::new(&shadow_guide, sw, sh, shadow_radius);
        cache.shadow_inputs = Some(Arc::new(ShadowInputs {
            guide: shadow_guide,
            depth,
            depth_range,
            stats,
        }));
    }

    let shadow_models: Vec<Arc<GuidedModel>> = match &cache.shadow_inputs {
        Some(inputs) if shadows_enabled => {
            let models: Vec<(u64, Arc<GuidedModel>)> = lights
                .iter()
                .map(|light| {
                    let key = shadow_key(light, shadow_softness);
                    if let Some((_, model)) = cache.shadow_models.iter().find(|(k, _)| *k == key) {
                        return (key, model.clone());
                    }
                    let shadow = build_shadow_map(
                        &inputs.depth,
                        inputs.depth_range,
                        sw,
                        sh,
                        [aspect_x, aspect_y],
                        light,
                        shadow_softness,
                    );
                    let model =
                        build_guided_model_with(&inputs.stats, &inputs.guide, &shadow, sw, sh, eps);
                    (key, Arc::new(model))
                })
                .collect();
            let shadow_models = models.iter().map(|(_, m)| m.clone()).collect();
            cache.shadow_models = models;
            shadow_models
        }
        _ => Vec::new(),
    };

    *RELIGHT_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(cache.clone());

    let surface_models = &cache.surface_models;

    let ambient_gain = (ambient / 50.0).exp2();

    out.par_chunks_exact_mut(wu * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let v = (y as f32 + 0.5) / h as f32;

            for x in 0..wu {
                let u = (x as f32 + 0.5) / w as f32;
                let guide = relight_luma(row[x * 3], row[x * 3 + 1], row[x * 3 + 2]);
                let map_tap = RelightTap::new(u, v, nw, nh);
                let shadow_tap = RelightTap::new(u, v, sw, sh);

                let s = [0, 1, 2, 3].map(|c| map_tap.guided(&surface_models[c], guide));
                let len = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt().max(1e-6);
                let n = [s[0] / len, s[1] / len, s[2] / len];
                let p = [
                    (u - 0.5) * aspect_x,
                    (v - 0.5) * aspect_y,
                    s[3].clamp(0.0, 1.0),
                ];

                let mut gain = [ambient_gain; 3];
                for (index, light) in lights.iter().enumerate() {
                    let (l, mut atten) = if let RelightKind::Directional { dir } = light.kind {
                        (dir, 1.0)
                    } else {
                        let d = [
                            light.pos[0] - p[0],
                            light.pos[1] - p[1],
                            light.pos[2] - p[2],
                        ];
                        let dist2 = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).max(1e-8);
                        let inv = 1.0 / dist2.sqrt();
                        let l = [d[0] * inv, d[1] * inv, d[2] * inv];
                        let mut atten = light.radius2 / (light.radius2 + dist2);
                        if let RelightKind::Spot { beam, outer, inner } = light.kind {
                            let cos_beam = -(l[0] * beam[0] + l[1] * beam[1] + l[2] * beam[2]);
                            atten *= relight_smoothstep(outer, inner, cos_beam);
                        }
                        (l, atten)
                    };

                    if let Some(model) = shadow_models.get(index) {
                        atten *= shadow_tap.guided(model, guide).clamp(0.0, 1.0);
                    }

                    let ndl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
                    let diffuse = ((ndl + softness) / (1.0 + softness)).max(0.0);

                    let specular = if shine > 0.0 && ndl > 0.0 {
                        let hz = l[2] - 1.0;
                        let hl = (l[0] * l[0] + l[1] * l[1] + hz * hz).sqrt().max(1e-6);
                        let ndh = ((n[0] * l[0] + n[1] * l[1] + n[2] * hz) / hl).max(0.0);
                        ndh.powf(8.0 + 56.0 * (1.0 - softness)) * shine * 2.0
                    } else {
                        0.0
                    };

                    let k = (diffuse + specular) * atten;
                    gain[0] += light.color[0] * k;
                    gain[1] += light.color[1] * k;
                    gain[2] += light.color[2] * k;
                }

                let i = x * 3;
                row[i] *= gain[0].max(0.0);
                row[i + 1] *= gain[1].max(0.0);
                row[i + 2] *= gain[2].max(0.0);
            }
        });

    log::info!(
        "relight ({}x{}, {} lights) took {:.2?}",
        w,
        h,
        lights.len(),
        start.elapsed()
    );

    Cow::Owned(DynamicImage::ImageRgb32F(out))
}
