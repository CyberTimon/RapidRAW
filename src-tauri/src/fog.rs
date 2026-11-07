use std::sync::Arc;

use crate::image_processing::GeometryParams;

use image::GrayImage;

use crate::gpu_compute::{Bind, ComputeEncoder, Grid, Group, Out, RGB_MODE, Slot};

const EPS: f32 = 2.0e-3;
const NEAR: f32 = 0.1;

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    tint: [f32; 4],
    amount: f32,
    start: f32,
    density: f32,
    height: f32,
    variation: f32,
    glow: f32,
    display_aspect: f32,
    norm: f32,
    near: f32,
    z_near: f32,
    z_range: f32,
    _pad0: f32,
    orientation: u32,
    flip_h: u32,
    flip_v: u32,
    _pad1: u32,
    depth_size: [u32; 2],
    low_size: [u32; 2],
}

pub struct Fog {
    depth_map: Arc<GrayImage>,
    map_key: u64,
    tint: [f32; 4],
    amount: f32,
    start: f32,
    density: f32,
    height: f32,
    variation: f32,
    glow: f32,
    orientation: u32,
    flip_h: bool,
    flip_v: bool,
}

pub fn prepare(
    adjustments: &serde_json::Value,
    geometry: Option<&GeometryParams>,
    (w, h): (u32, u32),
) -> Option<Fog> {
    if !crate::image_processing::is_effect_enabled(adjustments, "fog", "fogEnabled") {
        return None;
    }
    let depth_b64 = adjustments["fogDepthMap"]
        .as_str()
        .filter(|map| !map.is_empty())?;

    let get = |key: &str, default: f64| {
        (adjustments[key].as_f64().unwrap_or(default) as f32 / 100.0).clamp(0.0, 1.0)
    };
    let amount = get("fogAmount", 50.0);
    if amount <= 0.0 {
        return None;
    }
    let temperature = adjustments["fogTemperature"].as_f64().unwrap_or(0.0) as f32 / 100.0;
    let tint_shift = adjustments["fogTint"].as_f64().unwrap_or(0.0) as f32 / 100.0;
    let tint = [
        1.0 + 0.45 * temperature + 0.15 * tint_shift,
        1.0 - 0.35 * tint_shift,
        1.0 - 0.45 * temperature + 0.15 * tint_shift,
    ]
    .map(|c| c.max(0.0));
    let tint_luma = (0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]).max(1e-3);

    let depth_map = crate::effect_maps::resolve_luma_map(depth_b64, adjustments, geometry)?;
    let depth_size = depth_map.dimensions();
    if depth_size.0 < 2 || depth_size.1 < 2 || w < 2 || h < 2 {
        return None;
    }

    Some(Fog {
        map_key: crate::effect_maps::effect_map_key(depth_b64, adjustments),
        depth_map,
        tint: [tint[0], tint[1], tint[2], tint_luma],
        amount,
        start: get("fogStart", 0.0).min(0.99),
        density: 0.5 + get("fogDensity", 50.0) * 7.5,
        height: get("fogHeight", 0.0) * 6.0,
        variation: get("fogVariation", 25.0),
        glow: get("fogGlow", 25.0) * 1.5,
        orientation: (adjustments["orientationSteps"].as_u64().unwrap_or(0) % 4) as u32,
        flip_h: adjustments["flipHorizontal"].as_bool().unwrap_or(false),
        flip_v: adjustments["flipVertical"].as_bool().unwrap_or(false),
    })
}

pub fn encode(enc: &mut ComputeEncoder, job: &Fog, src: &Slot, dst: &Slot) {
    let (w, h) = src.size;
    let depth_size = job.depth_map.dimensions();
    let scale = (384.0 / w.max(h) as f32).min(1.0);
    let low_size = (
        ((w as f32 * scale).round() as u32).max(2),
        ((h as f32 * scale).round() as u32).max(2),
    );
    let z_near = 1.0 / (1.0 + NEAR);
    let params = Params {
        grid: Grid::new((w, h)),
        tint: job.tint,
        amount: job.amount,
        start: job.start,
        density: job.density,
        height: job.height,
        variation: job.variation,
        glow: job.glow,
        display_aspect: if job.orientation % 2 == 1 {
            h as f32 / w as f32
        } else {
            w as f32 / h as f32
        },
        norm: 1.0 - (-job.density).exp(),
        near: NEAR,
        z_near,
        z_range: 1.0 / NEAR - z_near,
        _pad0: 0.0,
        orientation: job.orientation,
        flip_h: job.flip_h as u32,
        flip_v: job.flip_v as u32,
        _pad1: 0,
        depth_size: [depth_size.0, depth_size.1],
        low_size: [low_size.0, low_size.1],
    };
    let at = |size: (u32, u32)| Params {
        grid: Grid::new(size),
        ..params
    };

    let disparity = enc.cached_map(
        "Fog Disparity",
        job.map_key,
        depth_size,
        wgpu::TextureFormat::R32Float,
        || {
            job.depth_map
                .pixels()
                .map(|p| p[0] as f32 / 255.0)
                .collect()
        },
    );
    let guide = enc.area_down(src, depth_size, 0);
    let radius = ((depth_size.0.max(depth_size.1) as f32 * 0.01).round() as u32).max(2);
    let model = enc.guided_model(&guide, &disparity, 0, radius, EPS);

    let noise = enc.texture("Fog Noise", depth_size, wgpu::TextureFormat::Rgba32Float);
    enc.run(
        Group::Fog,
        "fog_noise_map",
        &at(depth_size),
        depth_size,
        &[],
        Out::F32(&noise.view),
        Bind::default(),
    );

    let low = enc.area_down(src, low_size, RGB_MODE);
    let stats = enc.buffer("Fog Stats", bytemuck::cast_slice(&[0u32; 4]));
    enc.run(
        Group::Fog,
        "fog_stats",
        &params,
        low_size,
        &[&low.view, &disparity.view],
        Out::None,
        Bind {
            scratch: Some(&stats),
            groups: Some((1, 1)),
            ..Default::default()
        },
    );

    let low_long = low_size.0.max(low_size.1) as f32;
    let bloom = (job.glow > 0.0).then(|| {
        let prepared = enc.texture("Fog Bloom", low_size, wgpu::TextureFormat::Rgba32Float);
        enc.run(
            Group::Fog,
            "fog_bloom",
            &at(low_size),
            low_size,
            &[&low.view],
            Out::F32(&prepared.view),
            Bind {
                scratch: Some(&stats),
                ..Default::default()
            },
        );
        enc.blur(prepared, ((low_long * 0.06).round() as u32).max(1), 2, 0)
    });
    let soft = enc.blur(low, ((low_long * 0.02).round() as u32).max(1), 2, 0);

    enc.run(
        Group::Fog,
        "fog_apply",
        &params,
        (w, h),
        &[
            &src.view,
            &model.view,
            &noise.view,
            &soft.view,
            &bloom.as_ref().unwrap_or(&soft).view,
        ],
        Out::F16(&dst.view),
        Bind {
            scratch: Some(&stats),
            ..Default::default()
        },
    );
}
