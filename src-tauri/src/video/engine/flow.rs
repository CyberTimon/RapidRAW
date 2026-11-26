use std::sync::Arc;

use crate::render::gpu::compute::{
    self, Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot, Tex,
};
use crate::render::gpu::context::GpuContext;
use crate::video::compose;

const BASE_LONGEST: f32 = 960.0;
const MIN_LEVEL_SIDE: u32 = 16;
const PATCH: u32 = 8;
const STRIDE: u32 = 4;
const RIDGE: f32 = 1.0e-5;
const FINE_ITERATIONS: f32 = 8.0;
const COARSE_ITERATIONS: f32 = 6.0;
pub const LINK_BINS: usize = 64;

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Params {
    pub grid: Grid,
    pub values: [[f32; 4]; 2],
    pub modes: [u32; 4],
}

impl Params {
    pub fn new(size: (u32, u32)) -> Self {
        Self {
            grid: Grid::new(size),
            ..Default::default()
        }
    }
}

fn dispatch(
    enc: &mut ComputeEncoder,
    entry: &str,
    params: Params,
    inputs: &[&wgpu::TextureView],
    out: Out,
    bind: Bind,
) {
    let size = (params.grid.dst[0], params.grid.dst[1]);
    enc.run(Group::Flow, entry, &params, size, inputs, out, bind);
}

pub fn run(
    enc: &mut ComputeEncoder,
    entry: &str,
    params: Params,
    inputs: &[&wgpu::TextureView],
    out: Out,
) {
    dispatch(enc, entry, params, inputs, out, Bind::default());
}

pub fn fitted((width, height): (u32, u32), longest: f32) -> (u32, u32) {
    let scale = (longest / width.max(height) as f32).min(1.0);
    let side = |value: u32| ((value as f32 * scale).round() as u32).max(PATCH);
    (side(width), side(height))
}

pub fn base_size(size: (u32, u32)) -> (u32, u32) {
    fitted(size, BASE_LONGEST)
}

fn patches(side: u32) -> u32 {
    side.saturating_sub(PATCH).div_ceil(STRIDE) + 1
}

struct Pyramid {
    levels: Vec<(Slot, Slot)>,
}

fn pyramid(enc: &mut ComputeEncoder, frame: &Slot) -> Pyramid {
    let mut size = base_size(frame.size);
    let mut luma = enc.texture("Flow Luma", size, wgpu::TextureFormat::R32Float);
    run(
        enc,
        "fl_luma",
        Params {
            grid: Grid::new(size).with_src(frame.size),
            ..Default::default()
        },
        &[&frame.view],
        Out::R32(&luma.view),
    );
    let mut levels = Vec::new();
    loop {
        let gradient = enc.texture("Flow Gradient", size, wgpu::TextureFormat::Rgba32Float);
        run(
            enc,
            "fl_grad",
            Params::new(size),
            &[&luma.view],
            Out::F32(&gradient.view),
        );
        let next = (size.0.div_ceil(2), size.1.div_ceil(2));
        let coarser = (next.0.min(next.1) >= MIN_LEVEL_SIDE).then(|| {
            let down = enc.texture("Flow Luma", next, wgpu::TextureFormat::R32Float);
            run(
                enc,
                "fl_down",
                Params::new(next),
                &[&luma.view],
                Out::R32(&down.view),
            );
            down
        });
        levels.push((luma.detach(), gradient.detach()));
        match coarser {
            Some(down) => {
                luma = down;
                size = next;
            }
            None => break,
        }
    }
    Pyramid { levels }
}

impl Pyramid {
    fn luma(&self) -> &Slot {
        &self.levels[0].0
    }

    fn gradient(&self) -> &Slot {
        &self.levels[0].1
    }
}

fn pair_flow(enc: &mut ComputeEncoder, from: &Pyramid, to: &Pyramid) -> Slot {
    let mut dense: Option<Tex> = None;
    let coarsest = from.levels.len() - 1;
    for level in (0..from.levels.len()).rev() {
        let (from_luma, from_gradient) = &from.levels[level];
        let (to_luma, to_gradient) = &to.levels[level];
        let size = from_gradient.size;
        let grid = (2 * patches(size.0), patches(size.1));
        let iterations = if level == 0 {
            FINE_ITERATIONS
        } else {
            COARSE_ITERATIONS
        };
        let found = enc.texture("Flow Patches", grid, wgpu::TextureFormat::Rgba32Float);
        let mut inputs = vec![
            &from_gradient.view,
            &to_luma.view,
            &to_gradient.view,
            &from_luma.view,
        ];
        inputs.extend(dense.as_ref().map(|tex| &tex.view));
        dispatch(
            enc,
            "fl_patch",
            Params {
                grid: Grid {
                    radius: STRIDE,
                    ..Grid::new(grid)
                },
                values: [[RIDGE, iterations, 0.0, 0.0], [0.0; 4]],
                modes: [(level != coarsest) as u32, 0, 0, 0],
            },
            &inputs,
            Out::F32(&found.view),
            Bind {
                groups: Some(grid),
                ..Default::default()
            },
        );
        let pair = (2 * size.0, size.1);
        let next = enc.texture("Flow Dense", pair, wgpu::TextureFormat::Rgba32Float);
        run(
            enc,
            "fl_densify",
            Params {
                grid: Grid {
                    radius: STRIDE,
                    ..Grid::new(pair)
                },
                ..Default::default()
            },
            &[
                &from_gradient.view,
                &to_luma.view,
                &to_gradient.view,
                &from_luma.view,
                &found.view,
            ],
            Out::F32(&next.view),
        );
        dense = Some(next);
    }
    dense
        .map(Tex::detach)
        .expect("pyramids have at least one level")
}

#[derive(Clone, Copy)]
pub struct Frame<'a> {
    pub key: u64,
    pub slot: &'a Slot,
}

pub struct Flow {
    pub field: Slot,
}

impl Flow {
    pub fn size(&self) -> (u32, u32) {
        (self.field.size.0 / 2, self.field.size.1)
    }
}

#[derive(Default)]
pub struct FlowCache {
    stream: u64,
    pyramids: Vec<(u64, Arc<Pyramid>)>,
    pairs: Vec<([u64; 2], Slot)>,
    splats: Option<((u32, u32), wgpu::Buffer)>,
}

impl FlowCache {
    pub fn follow(&mut self, stream: u64, keys: &[u64]) {
        if self.stream != stream {
            *self = Self {
                stream,
                splats: self.splats.take(),
                ..Default::default()
            };
        }
        self.pyramids.retain(|(key, _)| keys.contains(key));
        self.pairs
            .retain(|(pair, _)| pair.iter().all(|key| keys.contains(key)));
    }

    fn splats(&mut self, device: &wgpu::Device, size: (u32, u32)) -> wgpu::Buffer {
        match &self.splats {
            Some((at, buffer)) if *at == size => buffer.clone(),
            _ => {
                let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Flow Splats"),
                    size: (2 * size.0 as u64 * size.1 as u64 + 1) * 4,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                self.splats = Some((size, buffer.clone()));
                buffer
            }
        }
    }

    fn pyramid(&mut self, enc: &mut ComputeEncoder, frame: Frame) -> Arc<Pyramid> {
        if let Some((_, found)) = self.pyramids.iter().find(|(at, _)| *at == frame.key) {
            return Arc::clone(found);
        }
        let built = Arc::new(pyramid(enc, frame.slot));
        self.pyramids.push((frame.key, Arc::clone(&built)));
        built
    }

    pub fn gradient(&mut self, enc: &mut ComputeEncoder, frame: Frame) -> Slot {
        self.pyramid(enc, frame).gradient().clone()
    }

    pub fn between(&mut self, enc: &mut ComputeEncoder, from: Frame, to: Frame) -> Flow {
        let keys = [from.key, to.key];
        if let Some((_, found)) = self.pairs.iter().find(|(at, _)| *at == keys) {
            return Flow {
                field: found.clone(),
            };
        }
        let from_pyramid = self.pyramid(enc, from);
        let to_pyramid = self.pyramid(enc, to);
        let field = pair_flow(enc, &from_pyramid, &to_pyramid);
        self.pairs.push((keys, field.clone()));
        Flow { field }
    }
}

#[derive(Clone, Copy)]
pub enum End {
    From,
    To,
}

pub fn link(
    enc: &mut ComputeEncoder,
    flow: &Flow,
    (own, other): (&Slot, &Slot),
    end: End,
    counts: Option<&wgpu::Buffer>,
) -> Tex {
    let size = flow.size();
    let link = enc.texture("Flow Link", size, IMAGE_FORMAT);
    dispatch(
        enc,
        "fl_link",
        Params {
            modes: [matches!(end, End::To) as u32, counts.is_some() as u32, 0, 0],
            ..Params::new(size)
        },
        &[&flow.field.view, &own.view, &other.view],
        Out::F16(&link.view),
        Bind {
            scratch: counts,
            ..Default::default()
        },
    );
    link
}

pub fn carry(
    enc: &mut ComputeEncoder,
    size: (u32, u32),
    (map, link): (&Slot, &Slot),
    to: Option<(&Slot, &Slot, f32)>,
    out: Out,
) {
    let (other, other_link, alpha) = to.unwrap_or((map, link, 0.0));
    run(
        enc,
        "fl_carry",
        Params {
            values: [[alpha, 0.0, 0.0, 0.0], [0.0; 4]],
            modes: [to.is_some() as u32, 0, 0, 0],
            ..Params::new(size)
        },
        &[&map.view, &other.view, &link.view, &other_link.view],
        out,
    );
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Interpolation {
    Blend,
    Flow,
}

impl Interpolation {
    pub fn of(name: Option<&str>) -> Option<Self> {
        match name {
            Some("blend") => Some(Self::Blend),
            Some("flow") => Some(Self::Flow),
            _ => None,
        }
    }
}

pub fn interpolated(
    context: &GpuContext,
    cache: &mut FlowCache,
    stream: u64,
    mode: Interpolation,
    frames: [Frame; 2],
    time: f32,
) -> Result<Slot, String> {
    cache.follow(stream, &frames.map(|frame| frame.key));
    let result = compute::encode(context, |enc| interpolate(enc, cache, mode, frames, time));
    if result.is_err() {
        *cache = FlowCache::default();
    }
    result
}

fn interpolate(
    enc: &mut ComputeEncoder,
    cache: &mut FlowCache,
    mode: Interpolation,
    [from, to]: [Frame; 2],
    time: f32,
) -> Slot {
    if mode == Interpolation::Blend {
        return compose::dissolve(enc, from.slot, to.slot, time).detach();
    }
    let before = cache.pyramid(enc, from);
    let after = cache.pyramid(enc, to);
    let flow = cache.between(enc, from, to);
    let size = flow.size();
    let splats = cache.splats(enc.device, size);
    enc.encoder.clear_buffer(&splats, 0, None);
    let lumas = [&before.luma().view, &after.luma().view];
    for claim in 0..2 {
        dispatch(
            enc,
            "fl_splat",
            Params {
                values: [[time, 0.0, 0.0, 0.0], [0.0; 4]],
                modes: [claim, 0, 0, 0],
                ..Params::new((2 * size.0, size.1))
            },
            &[&flow.field.view, lumas[0], lumas[1]],
            Out::None,
            Bind {
                scratch: Some(&splats),
                ..Default::default()
            },
        );
    }
    let motion = enc.texture("Flow Motion", size, wgpu::TextureFormat::Rgba32Float);
    dispatch(
        enc,
        "fl_resolve",
        Params {
            values: [[time, 0.0, 0.0, 0.0], [0.0; 4]],
            ..Params::new(size)
        },
        &[&flow.field.view],
        Out::F32(&motion.view),
        Bind {
            scratch: Some(&splats),
            ..Default::default()
        },
    );
    let filled = enc.texture("Flow Motion", size, wgpu::TextureFormat::Rgba32Float);
    run(
        enc,
        "fl_fill",
        Params {
            values: [[time, 0.0, 0.0, 0.0], [0.0; 4]],
            ..Params::new(size)
        },
        &[&motion.view, lumas[0], lumas[1]],
        Out::F32(&filled.view),
    );
    let frame = from.slot.size;
    let output = enc.texture("Flow Interpolated", frame, IMAGE_FORMAT);
    dispatch(
        enc,
        "fl_synth",
        Params {
            values: [
                [
                    time,
                    frame.0 as f32 / size.0 as f32,
                    frame.1 as f32 / size.1 as f32,
                    0.0,
                ],
                [0.0; 4],
            ],
            ..Params::new(frame)
        },
        &[
            &from.slot.view,
            &to.slot.view,
            &filled.view,
            &flow.field.view,
        ],
        Out::F16(&output.view),
        Bind {
            scratch: Some(&splats),
            ..Default::default()
        },
    );
    output.detach()
}
