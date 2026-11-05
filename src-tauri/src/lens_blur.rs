use std::sync::Arc;

use crate::image_processing::GeometryParams;

use image::GrayImage;

use crate::gpu_compute::{Bind, ComputeEncoder, Grid, Group, KEEP_ZW, Out, Slot, Tex};

const EPS: f32 = 4.0e-3;

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    radii: [[f32; 4]; 2],
    max_radius: f32,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    diffusion: f32,
    cat_eye: f32,
    veil: f32,
    span2: f32,
    first: u32,
    scale: [f32; 2],
    layer: u32,
    near: u32,
    taps: u32,
    direct: u32,
    threshold: u32,
    diffusion_on: u32,
    guide_size: [u32; 2],
    small_size: [u32; 2],
    ext: u32,
    _pad1: u32,
}

pub struct LensBlur {
    depth_map: Arc<GrayImage>,
    map_key: u64,
    max_radius: f32,
    shape: String,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    diffusion: f32,
}

struct BokehTap {
    x: i32,
    y: i32,
    ux: f32,
    uy: f32,
    weight: f32,
}

pub fn prepare(
    adjustments: &serde_json::Value,
    geometry: Option<&GeometryParams>,
    (w, h): (u32, u32),
) -> Option<LensBlur> {
    if !crate::image_processing::is_effect_enabled(adjustments, "lensBlur", "lensBlurEnabled") {
        return None;
    }
    let depth_b64 = adjustments["lensBlurDepthMap"]
        .as_str()
        .filter(|map| !map.is_empty())?;
    let amount = adjustments["lensBlurAmount"].as_f64().unwrap_or(50.0) as f32;
    if amount <= 0.0 {
        return None;
    }
    let depth_map = crate::effect_maps::resolve_luma_map(depth_b64, adjustments, geometry)?;
    if depth_map.width() < 2 || depth_map.height() < 2 || w < 8 || h < 8 {
        return None;
    }
    let max_radius = (amount / 100.0) * (w.max(h) as f32) * 0.012;
    if max_radius < 0.35 {
        return None;
    }

    let get = |key: &str, default: f64| adjustments[key].as_f64().unwrap_or(default) as f32 / 100.0;
    Some(LensBlur {
        map_key: crate::effect_maps::effect_map_key(depth_b64, adjustments),
        depth_map,
        max_radius,
        shape: adjustments["lensBlurShape"]
            .as_str()
            .unwrap_or("circle")
            .to_string(),
        min_depth: get("lensBlurMinDepth", 10.0),
        max_depth: get("lensBlurMaxDepth", 90.0),
        min_fade: get("lensBlurMinFade", 10.0),
        max_fade: get("lensBlurMaxFade", 10.0),
        diffusion: get("lensBlurDiffusion", 0.0).clamp(0.0, 1.0),
    })
}

fn downsample_factor(pixels: usize, max_radius: f32) -> usize {
    let mut ds = (max_radius / 18.0).ceil().max(1.0) as usize;
    while ds < 6 {
        let rw = max_radius / ds as f32;
        let taps = (std::f32::consts::PI * rw * rw).min(128.0) as f64;
        if (pixels as f64 / (ds * ds) as f64) * taps <= 7.0e8 {
            break;
        }
        ds += 1;
    }
    ds
}

#[inline(always)]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn polygon_scale(theta: f32, blades: u32) -> f32 {
    let seg = std::f32::consts::TAU / blades as f32;
    let half = seg * 0.5;
    let a = theta.rem_euclid(seg) - half;
    half.cos() / a.cos().max(1e-4)
}

fn aperture_intensity(rr: f32, shape: &str, diffusion: f32) -> f32 {
    let crisp = if shape == "ring" {
        0.22 + 3.2 * smoothstep(0.60, 0.93, rr)
    } else {
        1.0 + 0.12 * smoothstep(0.55, 1.0, rr)
    };
    if diffusion <= 1.0e-3 {
        return crisp;
    }
    let soft = (-2.6 * rr * rr).exp() + 0.05;
    crisp * (1.0 - diffusion) + soft * diffusion
}

fn bokeh_kernel(radius: f32, shape: &str, diffusion: f32) -> Vec<BokehTap> {
    let r = radius.max(0.6);
    let blades: u32 = match shape {
        "hexagon" => 6,
        "octagon" => 8,
        _ => 0,
    };

    let mut taps: Vec<BokehTap> = Vec::new();
    if r <= 3.5 {
        let ri = r.ceil() as i32;
        for y in -ri..=ri {
            for x in -ri..=ri {
                let d = ((x * x + y * y) as f32).sqrt();
                let cov = (r + 0.5 - d).clamp(0.0, 1.0);
                if cov <= 0.0 {
                    continue;
                }
                taps.push(BokehTap {
                    x,
                    y,
                    ux: x as f32 / r,
                    uy: y as f32 / r,
                    weight: cov * aperture_intensity((d / r).min(1.0), shape, diffusion),
                });
            }
        }
    } else {
        let n = ((std::f32::consts::PI * r * r).ceil() as usize).clamp(24, 128);
        let golden = 2.399_963_2f32;
        for i in 0..n {
            let t = (i as f32 + 0.5) / n as f32;
            let rr = t.sqrt();
            let ang = i as f32 * golden;
            let (s, c) = ang.sin_cos();
            let (mut ux, mut uy) = (rr * c, rr * s);
            let mut jw = 1.0f32;
            if blades > 0 {
                let poly = polygon_scale(ang, blades);
                let shaped = 1.0 + (poly - 1.0) * (1.0 - diffusion * 0.6);
                ux *= shaped;
                uy *= shaped;
                jw = shaped * shaped;
            }
            taps.push(BokehTap {
                x: (ux * r).round() as i32,
                y: (uy * r).round() as i32,
                ux,
                uy,
                weight: jw * aperture_intensity(rr, shape, diffusion),
            });
        }
    }

    let sum: f32 = taps.iter().map(|t| t.weight).sum();
    if sum > 0.0 {
        let inv = 1.0 / sum;
        taps.iter_mut().for_each(|t| t.weight *= inv);
    }
    taps
}

pub fn encode(enc: &mut ComputeEncoder, job: &LensBlur, src: &Slot, dst: &Slot) {
    let (w, h) = src.size;
    let full = (w, h);
    let r32 = wgpu::TextureFormat::R32Float;
    let f32x4 = wgpu::TextureFormat::Rgba32Float;

    let scale = (1024.0 / w.max(h) as f32).min(1.0);
    let guide_size = (
        ((w as f32 * scale).round() as u32).clamp(4, w),
        ((h as f32 * scale).round() as u32).clamp(4, h),
    );
    let ds = downsample_factor(w as usize * h as usize, job.max_radius);
    let small_size = ((w / ds as u32).max(4), (h / ds as u32).max(4));
    let mut radii = [0.0f32; 5];
    for (k, r) in radii.iter_mut().enumerate() {
        *r = job.max_radius * (k as f32 / 4.0).powf(1.7);
    }
    let guide_radius = ((guide_size.0.max(guide_size.1) as f32 * 0.015).round() as u32).max(2);
    let span = (2 * guide_radius + 1) as f32;
    let diffusion_on = job.diffusion > 1.0e-3;

    let params = Params {
        grid: Grid::new(full),
        radii: [
            [radii[0], radii[1], radii[2], radii[3]],
            [radii[4], 0.0, 0.0, 0.0],
        ],
        max_radius: job.max_radius,
        min_depth: job.min_depth,
        max_depth: job.max_depth,
        min_fade: job.min_fade,
        max_fade: job.max_fade,
        diffusion: job.diffusion,
        cat_eye: 0.38 * (1.0 - 0.7 * job.diffusion),
        veil: 0.75 * job.diffusion,
        span2: span * span,
        threshold: (w * h).div_ceil(400),
        diffusion_on: diffusion_on as u32,
        guide_size: [guide_size.0, guide_size.1],
        small_size: [small_size.0, small_size.1],
        ..Default::default()
    };
    let at = |grid: Grid| Params { grid, ..params };

    let luma = enc.texture("Lens Blur Luma", full, r32);
    enc.run(
        Group::LensBlur,
        "lb_luma",
        &params,
        full,
        &[&src.view],
        Out::R32(&luma.view),
        Bind::default(),
    );

    let depth = enc.cached_map(
        "Lens Blur Depth",
        job.map_key,
        job.depth_map.dimensions(),
        r32,
        || job.depth_map.pixels().map(|p| p[0] as f32).collect(),
    );
    let guide = enc.texture("Lens Blur Guide", guide_size, f32x4);
    enc.run(
        Group::LensBlur,
        "lb_guide",
        &at(Grid::new(guide_size).with_src(full)),
        guide_size,
        &[&luma.view, &depth.view],
        Out::F32(&guide.view),
        Bind::default(),
    );

    let moments: Vec<Tex> = (0..2)
        .map(|channel| {
            let packed = enc.texture("Lens Blur Moments", guide_size, f32x4);
            enc.run(
                Group::LensBlur,
                "lb_pack",
                &at(Grid {
                    channel,
                    ..Grid::new(guide_size)
                }),
                guide_size,
                &[&guide.view],
                Out::F32(&packed.view),
                Bind::default(),
            );
            enc.blur(packed, guide_radius, 1, 0)
        })
        .collect();
    let coeffs = enc.texture("Lens Blur Coeffs", guide_size, f32x4);
    enc.run(
        Group::LensBlur,
        "lb_coeffs",
        &at(Grid {
            eps: EPS,
            ..Grid::new(guide_size)
        }),
        guide_size,
        &[&moments[0].view, &moments[1].view],
        Out::F32(&coeffs.view),
        Bind::default(),
    );
    let model = enc.blur(coeffs, guide_radius, 1, KEEP_ZW);

    let coc = enc.texture("Lens Blur CoC", full, r32);
    enc.run(
        Group::LensBlur,
        "lb_coc",
        &Params {
            scale: [
                guide_size.0 as f32 / w as f32,
                guide_size.1 as f32 / h as f32,
            ],
            ..params
        },
        full,
        &[&luma.view, &model.view],
        Out::R32(&coc.view),
        Bind::default(),
    );
    let count = enc.buffer("Lens Blur Count", bytemuck::cast_slice(&[0u32; 4]));
    enc.run(
        Group::LensBlur,
        "lb_median_h",
        &params,
        full,
        &[&coc.view],
        Out::R32(&luma.view),
        Bind::default(),
    );
    enc.run(
        Group::LensBlur,
        "lb_median_v",
        &params,
        full,
        &[&luma.view],
        Out::R32(&coc.view),
        Bind {
            scratch: Some(&count),
            ..Default::default()
        },
    );
    drop(luma);

    let small = at(Grid::new(small_size));
    let base = enc.texture("Lens Blur Base", small_size, f32x4);
    enc.run(
        Group::LensBlur,
        "lb_down",
        &at(Grid::new(small_size).with_src(full)),
        small_size,
        &[&src.view, &coc.view],
        Out::F32(&base.view),
        Bind::default(),
    );
    let tile_count = small_size.0.div_ceil(8) * small_size.1.div_ceil(8);
    let tiles = enc.buffer(
        "Lens Blur Tiles",
        bytemuck::cast_slice(&vec![0u32; tile_count as usize]),
    );
    enc.run(
        Group::LensBlur,
        "lb_tiles",
        &small,
        small_size,
        &[&base.view],
        Out::None,
        Bind {
            scratch: Some(&tiles),
            ..Default::default()
        },
    );

    let stack = |enc: &mut ComputeEncoder, near: bool| {
        let order: Vec<u32> = if near {
            (1..5).collect()
        } else {
            (1..5).rev().collect()
        };
        let mut acc: Option<Tex> = None;
        for k in order {
            let r_work = (radii[k as usize] / ds as f32) * (1.0 + 0.3 * job.diffusion);
            let taps = if r_work >= 0.6 {
                bokeh_kernel(r_work, &job.shape, job.diffusion)
            } else {
                Vec::new()
            };
            let tap_data: Vec<f32> = taps
                .iter()
                .flat_map(|t| [t.x as f32, t.y as f32, t.ux, t.uy, t.weight, 0.0, 0.0, 0.0])
                .collect();
            let tap_buffer = (!taps.is_empty())
                .then(|| enc.buffer("Lens Blur Taps", bytemuck::cast_slice(&tap_data)));
            let blurred = enc.texture("Lens Blur Layer", small_size, f32x4);
            enc.run(
                Group::LensBlur,
                "lb_gather",
                &Params {
                    layer: k,
                    near: near as u32,
                    taps: taps.len() as u32,
                    direct: taps.is_empty() as u32,
                    ext: taps
                        .iter()
                        .map(|t| t.x.unsigned_abs().max(t.y.unsigned_abs()))
                        .max()
                        .unwrap_or(0),
                    ..small
                },
                small_size,
                &[&base.view],
                Out::F32(&blurred.view),
                Bind {
                    data: tap_buffer.as_ref(),
                    scratch: Some(&tiles),
                    ..Default::default()
                },
            );
            let passes = (!taps.is_empty() && r_work > 7.0) as u32;
            let blurred = enc.blur(blurred, 1, passes, 0);
            let next = enc.texture("Lens Blur Stack", small_size, f32x4);
            enc.run(
                Group::LensBlur,
                "lb_accum",
                &Params {
                    first: acc.is_none() as u32,
                    ..small
                },
                small_size,
                &[&blurred.view, &acc.as_ref().unwrap_or(&blurred).view],
                Out::F32(&next.view),
                Bind::default(),
            );
            acc = Some(next);
        }
        acc.unwrap()
    };
    let far = stack(enc, false);
    let near = stack(enc, true);

    let linear = |enc: &mut ComputeEncoder, acc: &Tex, channel: u32| {
        let out = enc.texture("Lens Blur Linear", small_size, f32x4);
        enc.run(
            Group::LensBlur,
            "lb_lin",
            &at(Grid {
                channel,
                ..Grid::new(small_size)
            }),
            small_size,
            &[&acc.view, &base.view],
            Out::F32(&out.view),
            Bind::default(),
        );
        out
    };
    let far_lin = linear(enc, &far, 0);
    let near_lin = linear(enc, &near, 1);

    let bloom = diffusion_on.then(|| {
        let prepared = linear(enc, &base, 2);
        let cap = (small_size.0.min(small_size.1) / 2).max(2);
        let br1 = (((job.max_radius / ds as f32) * 0.8).max(6.0) as u32).min(cap);
        let br2 = ((br1 * 2) / 3).max(3).min(cap);
        let once = enc.blur(prepared, br1, 1, 0);
        let twice = enc.blur(once, br2, 1, 0);
        let out = enc.texture("Lens Blur Bloom", small_size, f32x4);
        enc.run(
            Group::LensBlur,
            "lb_bloom",
            &small,
            small_size,
            &[&twice.view],
            Out::F32(&out.view),
            Bind::default(),
        );
        out
    });

    enc.run(
        Group::LensBlur,
        "lb_final",
        &Params {
            scale: [
                small_size.0 as f32 / w as f32,
                small_size.1 as f32 / h as f32,
            ],
            ..params
        },
        full,
        &[
            &src.view,
            &coc.view,
            &far_lin.view,
            &near_lin.view,
            &bloom.as_ref().unwrap_or(&far_lin).view,
        ],
        Out::F16(&dst.view),
        Bind {
            scratch: Some(&count),
            ..Default::default()
        },
    );
}
