use std::sync::Arc;

use crate::render::geometry::GeometryParams;

use image::RgbaImage;

use crate::render::adjustment_utils::is_effect_enabled;
use crate::render::gpu::compute::{Bind, ComputeEncoder, Grid, Group, Out, Slot, Tex};

const EPS: f32 = 2.0e-3;
const POINT: f32 = 0.0;
const SPOT: f32 = 1.0;
const DIRECTIONAL: f32 = 2.0;

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    aspect: [f32; 2],
    ambient_gain: f32,
    softness: f32,
    shine: f32,
    lights: u32,
    shadows: u32,
    _pad: u32,
    map_size: [u32; 2],
    shadow_size: [u32; 2],
}

pub struct Relight {
    lights: Vec<[f32; 16]>,
    normal_map: Arc<RgbaImage>,
    map_key: u64,
    ambient_gain: f32,
    softness: f32,
    shine: f32,
    shadows: bool,
    shadow_softness: f32,
}

fn parse_light(l: &serde_json::Value, aspect: [f32; 2]) -> [f32; 16] {
    let get = |key: &str, default: f64| l[key].as_f64().unwrap_or(default) as f32;
    let temperature = get("temperature", 0.0) / 100.0;
    let tint = get("tint", 0.0) / 100.0;
    let base = l["color"]
        .as_str()
        .and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
        .map(|hex| [hex >> 16, hex >> 8, hex].map(|c| ((c & 255) as f32 / 255.0).powf(2.2)))
        .unwrap_or([1.0; 3]);
    let rgb = [
        base[0] * (1.0 + 0.45 * temperature + 0.15 * tint),
        base[1] * (1.0 - 0.35 * tint),
        base[2] * (1.0 - 0.45 * temperature + 0.15 * tint),
    ];
    let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let strength = get("intensity", 40.0).max(0.0) / 100.0 * 4.0 / luma.max(1e-3);
    let radius = 0.05 + get("radius", 30.0) / 100.0 * 1.45;
    let angle = get("angle", 135.0).to_radians();
    let elevation = get("elevation", 60.0).clamp(-180.0, 180.0).to_radians();
    let (plane_x, plane_y) = (
        angle.cos() * elevation.cos(),
        -angle.sin() * elevation.cos(),
    );
    let (kind, vector, outer, inner) = match l["type"].as_str().unwrap_or("point") {
        "directional" => (DIRECTIONAL, [plane_x, plane_y, -elevation.sin()], 0.0, 0.0),
        "spot" => {
            let half = (5.0 + get("cone", 40.0).clamp(0.0, 100.0) / 100.0 * 80.0).to_radians();
            let feather = get("feather", 50.0).clamp(0.0, 100.0) / 100.0;
            (
                SPOT,
                [plane_x, plane_y, elevation.sin()],
                half.cos(),
                (half * (1.0 - feather)).cos(),
            )
        }
        _ => (POINT, [0.0; 3], 0.0, 0.0),
    };
    let color = rgb.map(|c| c.max(0.0) * strength);
    [
        kind,
        (get("x", 0.5) - 0.5) * aspect[0],
        (get("y", 0.5) - 0.5) * aspect[1],
        get("depth", 0.0) / 100.0 * 1.25 - 0.25,
        color[0],
        color[1],
        color[2],
        radius * radius,
        vector[0],
        vector[1],
        vector[2],
        outer,
        inner,
        0.0,
        0.0,
        0.0,
    ]
}

pub fn prepare(
    adjustments: &serde_json::Value,
    geometry: Option<&GeometryParams>,
    (w, h): (u32, u32),
) -> Option<Relight> {
    if !is_effect_enabled(adjustments, "relight", "relightEnabled") {
        return None;
    }
    let normal_b64 = adjustments["relightNormalMap"]
        .as_str()
        .filter(|map| !map.is_empty())?;
    if w < 2 || h < 2 {
        return None;
    }

    let ambient = adjustments["relightAmbient"].as_f64().unwrap_or(-50.0) as f32;
    let long_side = w.max(h) as f32;
    let aspect = [w as f32 / long_side, h as f32 / long_side];
    let lights: Vec<[f32; 16]> = adjustments["relightLights"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|l| l["visible"].as_bool().unwrap_or(true))
                .map(|l| parse_light(l, aspect))
                .collect()
        })
        .unwrap_or_default();
    if lights.is_empty() && ambient == 0.0 {
        return None;
    }

    let normal_map = crate::effects::maps::resolve_rgba_map(normal_b64, adjustments, geometry)?;
    if normal_map.width() < 2 || normal_map.height() < 2 {
        return None;
    }

    let percent = |key: &str, default: f64| {
        (adjustments[key].as_f64().unwrap_or(default) as f32 / 100.0).clamp(0.0, 1.0)
    };
    Some(Relight {
        lights,
        normal_map,
        map_key: crate::effects::maps::effect_map_key(normal_b64, adjustments),
        ambient_gain: (ambient / 50.0).exp2(),
        softness: percent("relightSoftness", 25.0),
        shine: percent("relightShine", 0.0),
        shadows: adjustments["relightShadows"].as_bool().unwrap_or(false),
        shadow_softness: percent("relightShadowSoftness", 15.0),
    })
}

pub fn encode(enc: &mut ComputeEncoder, job: &Relight, src: &Slot, dst: &Slot) {
    let (w, h) = src.size;
    let long_side = w.max(h) as f32;
    let map_size = job.normal_map.dimensions();
    let shadow_scale = (2048.0 / long_side).min(1.0);
    let shadow_size = (
        ((w as f32 * shadow_scale).round() as u32).max(2),
        ((h as f32 * shadow_scale).round() as u32).max(2),
    );
    let shadows = job.shadows && !job.lights.is_empty();
    let params = Params {
        grid: Grid::new((w, h)),
        aspect: [w as f32 / long_side, h as f32 / long_side],
        ambient_gain: job.ambient_gain,
        softness: job.softness,
        shine: job.shine,
        lights: job.lights.len() as u32,
        shadows: shadows as u32,
        _pad: 0,
        map_size: [map_size.0, map_size.1],
        shadow_size: [shadow_size.0, shadow_size.1],
    };

    let normals = enc.cached_map(
        "Relight Normals",
        job.map_key,
        map_size,
        wgpu::TextureFormat::Rgba32Float,
        || {
            job.normal_map
                .pixels()
                .flat_map(|p| {
                    [
                        p[0] as f32 / 127.5 - 1.0,
                        1.0 - p[1] as f32 / 127.5,
                        1.0 - p[2] as f32 / 127.5,
                        p[3] as f32 / 255.0,
                    ]
                })
                .collect()
        },
    );
    let map_guide = enc.area_down(src, map_size, 0);
    let map_radius = ((map_size.0.max(map_size.1) as f32 * 0.006).round() as u32).max(2);
    let models: Vec<Tex> = (0..4)
        .map(|channel| enc.guided_model(&map_guide, &normals, channel, map_radius, EPS))
        .collect();
    let model_views: Vec<&wgpu::TextureView> = models.iter().map(|m| &m.view).collect();
    let surface: Vec<Tex> = (0..2)
        .map(|channel| {
            let out = enc.texture(
                "Relight Surface",
                map_size,
                wgpu::TextureFormat::Rgba32Float,
            );
            enc.run(
                Group::Relight,
                "rl_merge",
                &Params {
                    grid: Grid {
                        channel,
                        ..Grid::new(map_size)
                    },
                    ..params
                },
                map_size,
                &model_views,
                Out::F32(&out.view),
                Bind::default(),
            );
            out
        })
        .collect();

    let lights: Vec<f32> = job.lights.iter().flatten().copied().collect();
    let light_buffer =
        (!lights.is_empty()).then(|| enc.buffer("Relight Lights", bytemuck::cast_slice(&lights)));

    let shadow_layers = shadows.then(|| {
        let shadow_params = Params {
            grid: Grid::new(shadow_size),
            ..params
        };
        let shadow_guide = enc.area_down(src, shadow_size, 0);
        let range = enc.buffer(
            "Relight Depth Range",
            bytemuck::cast_slice(&[u32::MAX, 0u32]),
        );
        let depth = enc.texture(
            "Relight Depth",
            shadow_size,
            wgpu::TextureFormat::Rgba32Float,
        );
        enc.run(
            Group::Relight,
            "rl_depth",
            &shadow_params,
            shadow_size,
            &[&shadow_guide.view, &surface[0].view, &surface[1].view],
            Out::F32(&depth.view),
            Bind {
                scratch: Some(&range),
                ..Default::default()
            },
        );

        let shadow_radius =
            ((shadow_size.0.max(shadow_size.1) as f32 * 0.003).round() as u32).max(2);
        let blur_radius =
            (job.shadow_softness * shadow_size.0.max(shadow_size.1) as f32 * 0.02).round() as u32;
        let layers = enc.layered("Relight Shadows", shadow_size, job.lights.len() as u32);
        for index in 0..job.lights.len() as u32 {
            let shadow = enc.texture(
                "Relight Shadow",
                shadow_size,
                wgpu::TextureFormat::Rgba32Float,
            );
            enc.run(
                Group::Relight,
                "rl_shadow",
                &Params {
                    grid: Grid {
                        channel: index,
                        ..Grid::new(shadow_size)
                    },
                    ..params
                },
                shadow_size,
                &[&depth.view],
                Out::F32(&shadow.view),
                Bind {
                    scratch: Some(&range),
                    data: light_buffer.as_ref(),
                    ..Default::default()
                },
            );
            let shadow = enc.blur(shadow, blur_radius, 2, 0);
            let model = enc.guided_model(&shadow_guide, &shadow, 0, shadow_radius, EPS);
            enc.encoder.copy_texture_to_texture(
                model.texture.as_image_copy(),
                wgpu::TexelCopyTextureInfo {
                    texture: &layers.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: index,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: shadow_size.0,
                    height: shadow_size.1,
                    depth_or_array_layers: 1,
                },
            );
        }
        layers
    });

    enc.run(
        Group::Relight,
        "rl_apply",
        &params,
        (w, h),
        &[&src.view, &surface[0].view, &surface[1].view],
        Out::F16(&dst.view),
        Bind {
            layers: shadow_layers.as_ref().map(|layers| &layers.view),
            data: light_buffer.as_ref(),
            ..Default::default()
        },
    );
}
