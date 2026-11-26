use image::GrayImage;
use wgpu::util::DeviceExt;

use crate::masks::generation::{
    MaskDefinition, SubMaskMode, generate_mask_bitmap, generate_sub_mask_bitmap,
};
use crate::masks::morphology::{feather_sigma, gaussian_kernel, grow_radius};
use crate::masks::parametric::{RangeMask, RangeReference, range_mask};
use crate::render::gpu::compute::{self, Bind, ComputeEncoder, Grid, Group, Out, Tex};
use crate::render::gpu::context::GpuContext;
use crate::render::uniforms::MAX_MASKS;

const LUMINANCE: u32 = 1;
const SAMPLE_REFERENCE: u32 = 2;
const ERODE: u32 = 1;
const FIRST: u32 = 4;
const STATIC: u32 = 8;
const VALUE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Float;

#[repr(C)]
#[derive(Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    color: [f32; 4],
    pick: [f32; 4],
    blend: [f32; 4],
    finish: [f32; 4],
}

struct Range {
    flags: u32,
    color: [f32; 4],
    pick: [f32; 4],
    grow: Option<(u32, u32)>,
    feather: Option<(u32, wgpu::Buffer)>,
}

enum Source {
    Range(Range),
    Static(u32),
}

struct Step {
    source: Source,
    blend: [f32; 4],
}

struct Container {
    index: usize,
    layer: u32,
    steps: Vec<Step>,
    finish: [f32; 4],
}

struct Cutout {
    base: wgpu::TextureView,
    layers: (u32, u32),
    output: wgpu::TextureView,
}

#[derive(Clone, Copy)]
pub struct MaskSpace {
    pub size: (u32, u32),
    pub scale: f32,
    pub crop_offset: (f32, f32),
}

pub struct RangeMasks {
    size: (u32, u32),
    containers: Vec<Container>,
    statics: Option<wgpu::TextureView>,
    packed: wgpu::Buffer,
    row_words: u32,
    cutout: Option<Cutout>,
}

fn opacity(percent: f32) -> f32 {
    (percent / 100.0).clamp(0.0, 1.0)
}

fn blend_mode(mode: SubMaskMode) -> f32 {
    match mode {
        SubMaskMode::Additive => 0.0,
        SubMaskMode::Subtractive => 1.0,
        SubMaskMode::Intersect => 2.0,
    }
}

impl Range {
    fn new(context: &GpuContext, range: RangeMask, space: MaskSpace) -> Self {
        let MaskSpace {
            size: (width, height),
            scale,
            crop_offset,
        } = space;
        let mut flags = if range.luminance { LUMINANCE } else { 0 };
        let mut color = [0.0, 0.0, 0.0, range.tolerance];
        let mut pick = [0.0; 4];
        match range.reference {
            RangeReference::Color([r, g, b]) => color[..3].copy_from_slice(&[r, g, b]),
            RangeReference::Target(x, y) => {
                flags |= SAMPLE_REFERENCE;
                let at = |value: f32, offset: f32, size: u32| {
                    ((value + 0.5) * scale - offset)
                        .floor()
                        .clamp(0.0, size.saturating_sub(1) as f32)
                };
                pick[0] = at(x, crop_offset.0, width);
                pick[1] = at(y, crop_offset.1, height);
            }
        }
        let feather = feather_sigma(range.feather, width, height).map(|sigma| {
            let mut kernel = gaussian_kernel(sigma);
            let radius = (kernel.len() / 2) as u32;
            kernel.resize(kernel.len().next_multiple_of(4), 0.0);
            let weights = context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Range Mask Kernel"),
                    contents: bytemuck::cast_slice(&kernel),
                    usage: wgpu::BufferUsages::STORAGE,
                });
            (radius, weights)
        });
        Self {
            flags,
            color,
            pick,
            grow: grow_radius(range.grow, width, height)
                .map(|(amount, dilate)| (amount as u32, if dilate { 0 } else { ERODE })),
            feather,
        }
    }

    fn render(&self, enc: &mut ComputeEncoder, input: &wgpu::TextureView, size: (u32, u32)) -> Tex {
        let grid = Grid::new(size);
        let mut value = enc.texture("Range Mask", size, VALUE_FORMAT);
        enc.run(
            Group::RangeMask,
            "rm_eval",
            &Params {
                grid: Grid {
                    flags: self.flags,
                    ..grid
                },
                color: self.color,
                pick: self.pick,
                ..Default::default()
            },
            size,
            &[input],
            Out::R32(&value.view),
            Bind::default(),
        );
        let passes = self
            .grow
            .map(|(radius, flags)| ("rm_grow", radius, flags, None))
            .into_iter()
            .chain(
                self.feather
                    .as_ref()
                    .map(|(radius, weights)| ("rm_blur", *radius, 0, Some(weights))),
            );
        for (entry, radius, flags, weights) in passes {
            for channel in 0..2 {
                let next = enc.texture("Range Mask", size, VALUE_FORMAT);
                enc.run(
                    Group::RangeMask,
                    entry,
                    &Params {
                        grid: Grid {
                            radius,
                            channel,
                            flags,
                            ..grid
                        },
                        ..Default::default()
                    },
                    size,
                    &[&value.view],
                    Out::R32(&next.view),
                    Bind {
                        data: weights,
                        ..Default::default()
                    },
                );
                value = next;
            }
        }
        value
    }
}

impl Container {
    fn plan(
        context: &GpuContext,
        index: usize,
        layer: u32,
        definition: &MaskDefinition,
        space: MaskSpace,
        statics: &mut Vec<GrayImage>,
    ) -> Option<Self> {
        let ranges: Vec<Option<RangeMask>> = definition
            .sub_masks
            .iter()
            .map(|sub_mask| {
                sub_mask
                    .visible
                    .then(|| range_mask(&sub_mask.mask_type, &sub_mask.parameters))
                    .flatten()
            })
            .collect();
        if ranges.iter().all(Option::is_none) {
            return None;
        }
        let steps = definition
            .sub_masks
            .iter()
            .zip(ranges)
            .filter_map(|(sub_mask, range)| {
                let source = match range {
                    Some(range) => Source::Range(Range::new(context, range, space)),
                    None => {
                        statics.push(generate_sub_mask_bitmap(
                            sub_mask,
                            space.size.0,
                            space.size.1,
                            space.scale,
                            space.crop_offset,
                            None,
                        )?);
                        Source::Static(statics.len() as u32 - 1)
                    }
                };
                Some(Step {
                    source,
                    blend: [
                        sub_mask.invert as u32 as f32,
                        opacity(sub_mask.opacity),
                        blend_mode(sub_mask.mode),
                        0.0,
                    ],
                })
            })
            .collect();
        Some(Self {
            index,
            layer,
            steps,
            finish: [
                definition.invert as u32 as f32,
                opacity(definition.opacity),
                0.0,
                0.0,
            ],
        })
    }
}

fn upload_statics(
    context: &GpuContext,
    (width, height): (u32, u32),
    statics: &[GrayImage],
) -> Option<wgpu::TextureView> {
    if statics.is_empty() {
        return None;
    }
    let data: Vec<u8> = statics
        .iter()
        .flat_map(|bitmap| bitmap.iter().copied())
        .collect();
    let texture = context.device.create_texture_with_data(
        &context.queue,
        &wgpu::TextureDescriptor {
            label: Some("Range Mask Statics"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: statics.len() as u32,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &data,
    );
    Some(texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    }))
}

pub fn generate(
    context: &GpuContext,
    definitions: &[MaskDefinition],
    space: MaskSpace,
) -> (Vec<Option<GrayImage>>, Option<RangeMasks>) {
    let MaskSpace {
        size,
        scale,
        crop_offset,
    } = space;
    let mut statics = Vec::new();
    let mut containers = Vec::new();
    let mut layer = 0;
    let bitmaps = definitions
        .iter()
        .enumerate()
        .map(|(index, definition)| {
            if !definition.visible || definition.sub_masks.is_empty() {
                return None;
            }
            layer += 1;
            let planned = (layer <= MAX_MASKS as u32)
                .then(|| {
                    Container::plan(context, index, layer - 1, definition, space, &mut statics)
                })
                .flatten();
            match planned {
                Some(container) => {
                    containers.push(container);
                    Some(GrayImage::new(size.0, size.1))
                }
                None => generate_mask_bitmap(definition, size.0, size.1, scale, crop_offset, None),
            }
        })
        .collect();
    if containers.is_empty() {
        return (bitmaps, None);
    }
    let row_words = size.0.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * (wgpu::COPY_BYTES_PER_ROW_ALIGNMENT / 4);
    let packed = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Range Mask Packed"),
        size: row_words as u64 * 4 * size.1 as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let ranges = RangeMasks {
        size,
        statics: upload_statics(context, size, &statics),
        containers,
        packed,
        row_words,
        cutout: None,
    };
    (bitmaps, Some(ranges))
}

impl RangeMasks {
    pub fn layer_of(&self, index: usize) -> Option<u32> {
        self.containers
            .iter()
            .find(|container| container.index == index)
            .map(|container| container.layer)
    }

    pub fn cut_out(
        &mut self,
        context: &GpuContext,
        base: wgpu::TextureView,
        layers: (u32, u32),
    ) -> wgpu::TextureView {
        let output = context
            .device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Range Mask Cutout"),
                size: wgpu::Extent3d {
                    width: self.size.0,
                    height: self.size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: compute::IMAGE_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default());
        self.cutout = Some(Cutout {
            base,
            layers,
            output: output.clone(),
        });
        output
    }

    pub fn encode(
        &self,
        context: &GpuContext,
        input: &wgpu::TextureView,
        mask_view: &wgpu::TextureView,
    ) -> Result<(), String> {
        let target = mask_view.texture();
        let size = self.size;
        if target.width() != size.0 || target.height() != size.1 {
            return Err("Mask texture size does not match the range masks".to_string());
        }
        let layers = target.depth_or_array_layers();
        compute::encode(context, |enc| {
            for container in self.containers.iter().filter(|c| c.layer < layers) {
                self.encode_container(enc, input, container);
                enc.encoder.copy_buffer_to_texture(
                    wgpu::TexelCopyBufferInfo {
                        buffer: &self.packed,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(self.row_words * 4),
                            rows_per_image: Some(size.1),
                        },
                    },
                    wgpu::TexelCopyTextureInfo {
                        texture: target,
                        mip_level: 0,
                        origin: wgpu::Origin3d {
                            x: 0,
                            y: 0,
                            z: container.layer,
                        },
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d {
                        width: size.0,
                        height: size.1,
                        depth_or_array_layers: 1,
                    },
                );
            }
            if let Some(cutout) = &self.cutout {
                enc.run(
                    Group::RangeMask,
                    "rm_cutout",
                    &Params {
                        grid: Grid {
                            radius: cutout.layers.0,
                            channel: cutout.layers.1,
                            ..Grid::new(size)
                        },
                        ..Default::default()
                    },
                    size,
                    &[&cutout.base],
                    Out::F16(&cutout.output),
                    Bind {
                        layers: Some(mask_view),
                        ..Default::default()
                    },
                );
            }
        })
    }

    fn encode_container(
        &self,
        enc: &mut ComputeEncoder,
        input: &wgpu::TextureView,
        container: &Container,
    ) {
        let size = self.size;
        let mut previous: Option<Tex> = None;
        for (index, step) in container.steps.iter().enumerate() {
            let (value, flags, layer) = match &step.source {
                Source::Range(range) => (Some(range.render(enc, input, size)), 0, 0.0),
                Source::Static(layer) => (None, STATIC, *layer as f32),
            };
            let params = Params {
                grid: Grid {
                    flags: flags | if previous.is_none() { FIRST } else { 0 },
                    ..Grid::new(size).with_src((self.row_words, 0))
                },
                blend: [step.blend[0], step.blend[1], step.blend[2], layer],
                finish: container.finish,
                ..Default::default()
            };
            let inputs = [
                previous.as_ref().map_or(input, |tex| &tex.view),
                value.as_ref().map_or(input, |tex| &tex.view),
            ];
            let bind = Bind {
                layers: self.statics.as_ref(),
                ..Default::default()
            };
            if index + 1 == container.steps.len() {
                enc.run(
                    Group::RangeMask,
                    "rm_pack",
                    &params,
                    (size.0.div_ceil(4), size.1),
                    &inputs,
                    Out::None,
                    Bind {
                        scratch: Some(&self.packed),
                        ..bind
                    },
                );
            } else {
                let combined = enc.texture("Range Mask", size, VALUE_FORMAT);
                enc.run(
                    Group::RangeMask,
                    "rm_combine",
                    &params,
                    size,
                    &inputs,
                    Out::R32(&combined.view),
                    bind,
                );
                previous = Some(combined);
            }
        }
    }
}
