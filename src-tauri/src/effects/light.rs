use crate::render::gpu::compute::{
    Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot, Tex,
};
use crate::render::gpu::context::GpuContext;
use crate::render::uniforms::{AllAdjustments, MAX_MASKS, MaskAdjustments};

const BASE_SHORT_EDGE: f32 = 720.0;
const GLOW_WEIGHTS: [f32; 7] = [0.0, 0.08, 0.2, 0.3, 0.25, 0.12, 0.05];
const HALATION_WEIGHTS: [f32; 7] = [0.2, 0.45, 0.25, 0.1, 0.0, 0.0, 0.0];
const GLARE_WEIGHTS: [f32; 7] = [0.0, 0.1, 0.14, 0.14, 0.16, 0.2, 0.26];
const SURROUND_LEVEL: usize = 4;
const APERTURE_LEVELS: usize = 4;
const OUT_F16: u32 = 4;

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    gain: f32,
    is_raw: u32,
    brightness_k: f32,
    whites: f32,
    glow_cutoff: f32,
    halation_cutoff: f32,
    fine_weight: [f32; 2],
    coarse_weight: [f32; 2],
    aspect: f32,
    flare_cutoff: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LightJob {
    input: u64,
    exposure: f32,
    brightness: f32,
    whites: f32,
    is_raw: u32,
    glow_cutoff: f32,
    halation_cutoff: f32,
    flare_cutoff: f32,
    bloom: bool,
    flare: bool,
}

pub struct LightMaps {
    pub bloom: Option<Slot>,
    pub flare: Option<Slot>,
}

impl LightJob {
    pub fn new(input: u64, adjustments: &AllAdjustments) -> Option<Self> {
        let g = &adjustments.global;
        let masks =
            &adjustments.mask_adjustments[..(adjustments.mask_count as usize).min(MAX_MASKS)];
        let strongest = |global: f32, pick: fn(&MaskAdjustments) -> f32| {
            let amount = if global > 0.0 {
                global
            } else {
                masks.iter().map(pick).fold(0.0, f32::max)
            };
            amount.clamp(0.0, 1.0)
        };
        let glow = strongest(g.glow_amount, |m| m.glow_amount);
        let halation = strongest(g.halation_amount, |m| m.halation_amount);
        let flare = strongest(g.flare_amount, |m| m.flare_amount);
        let bloom = glow > 0.0 || halation > 0.0;
        if !bloom && flare <= 0.0 {
            return None;
        }
        Some(Self {
            input,
            exposure: g.exposure,
            brightness: g.brightness,
            whites: g.whites,
            is_raw: g.is_raw_image,
            glow_cutoff: 0.75 + (0.08 - 0.75) * glow,
            halation_cutoff: 0.85 + (0.1 - 0.85) * halation,
            flare_cutoff: 0.94 + (0.72 - 0.94) * flare,
            bloom,
            flare: flare > 0.0,
        })
    }
}

pub fn render(
    context: &GpuContext,
    source: &wgpu::TextureView,
    (w, h): (u32, u32),
    job: &LightJob,
) -> Result<LightMaps, String> {
    let scale = BASE_SHORT_EDGE / w.min(h).max(1) as f32;
    let base = (
        ((w as f32 * scale).round() as u32).max(2),
        ((h as f32 * scale).round() as u32).max(2),
    );
    let params = Params {
        grid: Grid::new(base).with_src((w, h)),
        gain: job.exposure.exp2(),
        is_raw: job.is_raw,
        brightness_k: (-job.brightness * 1.2).exp2(),
        whites: job.whites,
        glow_cutoff: job.glow_cutoff,
        halation_cutoff: job.halation_cutoff,
        flare_cutoff: job.flare_cutoff,
        aspect: base.0 as f32 / base.1 as f32,
        ..Default::default()
    };

    crate::render::gpu::compute::encode(context, |enc| {
        let glow = enc.texture("Light Glow Source", base, wgpu::TextureFormat::Rgba32Float);
        let flare = enc.texture("Light Flare Source", base, IMAGE_FORMAT);
        enc.run(
            Group::Light,
            "lt_prefilter",
            &params,
            base,
            &[source],
            Out::Both(&glow.view, &flare.view),
            Bind::default(),
        );
        LightMaps {
            bloom: job.bloom.then(|| bloom(enc, &params, glow).detach()),
            flare: job.flare.then(|| lens_flare(enc, &params, flare).detach()),
        }
    })
}

fn half((w, h): (u32, u32)) -> (u32, u32) {
    (w.div_ceil(2).max(1), h.div_ceil(2).max(1))
}

fn at(params: &Params, size: (u32, u32), flags: u32) -> Params {
    Params {
        grid: Grid {
            flags,
            ..Grid::new(size)
        },
        ..*params
    }
}

fn downsample(enc: &mut ComputeEncoder, params: &Params, levels: &mut Vec<Tex>, count: usize) {
    while levels.len() < count {
        let size = half(levels[levels.len() - 1].size);
        if size.0 < 2 || size.1 < 2 {
            break;
        }
        let next = enc.texture("Light Down", size, wgpu::TextureFormat::Rgba32Float);
        enc.run(
            Group::Light,
            "lt_down",
            &at(params, size, 0),
            size,
            &[&levels[levels.len() - 1].view],
            Out::F32(&next.view),
            Bind::default(),
        );
        levels.push(next);
    }
}

fn bloom(enc: &mut ComputeEncoder, params: &Params, source: Tex) -> Tex {
    let mut levels = vec![source];
    downsample(enc, params, &mut levels, GLOW_WEIGHTS.len());
    collapse(enc, params, &levels, &GLOW_WEIGHTS, &HALATION_WEIGHTS, true)
}

fn collapse(
    enc: &mut ComputeEncoder,
    params: &Params,
    levels: &[Tex],
    rgb: &[f32; 7],
    alpha: &[f32; 7],
    half_float: bool,
) -> Tex {
    let count = levels.len();
    let tail = |weights: &[f32; 7]| weights[count - 1..].iter().sum::<f32>();
    let mut acc: Option<Tex> = None;
    for k in (0..count - 1).rev() {
        let size = levels[k].size;
        let packed = k == 0 && half_float;
        let out = if packed {
            enc.texture("Light Collapse", size, IMAGE_FORMAT)
        } else {
            enc.texture("Light Collapse", size, wgpu::TextureFormat::Rgba32Float)
        };
        let coarse_weight = match acc {
            Some(_) => [1.0, 1.0],
            None => [tail(rgb), tail(alpha)],
        };
        let level_params = Params {
            fine_weight: [rgb[k], alpha[k]],
            coarse_weight,
            ..at(params, size, if packed { OUT_F16 } else { 0 })
        };
        let coarse = acc.as_ref().unwrap_or(&levels[k + 1]);
        enc.run(
            Group::Light,
            "lt_up",
            &level_params,
            size,
            &[&coarse.view, &levels[k].view],
            if packed {
                Out::F16(&out.view)
            } else {
                Out::F32(&out.view)
            },
            Bind::default(),
        );
        acc = Some(out);
    }
    acc.unwrap()
}

fn lens_flare(enc: &mut ComputeEncoder, params: &Params, source: Tex) -> Tex {
    let base = source.size;
    let mut levels = vec![source];
    downsample(enc, params, &mut levels, SURROUND_LEVEL + 1);
    let surround = &levels[SURROUND_LEVEL.min(levels.len() - 1)];
    let weighted = enc.texture("Light Flare Points", base, wgpu::TextureFormat::Rgba32Float);
    enc.run(
        Group::Light,
        "lt_source",
        &at(params, base, 0),
        base,
        &[&levels[0].view, &surround.view],
        Out::F32(&weighted.view),
        Bind::default(),
    );
    drop(levels);

    let mut points = vec![weighted];
    downsample(enc, params, &mut points, GLARE_WEIGHTS.len());
    let glare = collapse(enc, params, &points, &GLARE_WEIGHTS, &[0.0; 7], false);
    let apertures: Vec<Tex> = (1..=APERTURE_LEVELS)
        .map(|k| {
            let source = &points[k.min(points.len() - 1)];
            let out = enc.texture(
                "Light Aperture",
                source.size,
                wgpu::TextureFormat::Rgba32Float,
            );
            enc.run(
                Group::Light,
                "lt_aperture",
                &at(params, source.size, 0),
                source.size,
                &[&source.view],
                Out::F32(&out.view),
                Bind::default(),
            );
            out
        })
        .collect();

    let out = enc.texture("Light Flare", base, IMAGE_FORMAT);
    let views: Vec<&wgpu::TextureView> = std::iter::once(&glare.view)
        .chain(apertures.iter().map(|level| &level.view))
        .collect();
    enc.run(
        Group::Light,
        "lt_flare",
        &at(params, base, 0),
        base,
        &views,
        Out::F16(&out.view),
        Bind::default(),
    );
    out
}
