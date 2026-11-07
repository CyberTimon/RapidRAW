use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use half::f16;
use half::slice::HalfFloatSliceExt;
use image::DynamicImage;
use rayon::prelude::*;
use wgpu::util::DeviceExt;

use crate::image_processing::GpuContext;

pub const KEEP_ZW: u32 = 1;
pub const RGB_MODE: u32 = 2;
pub const IMAGE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const WORKGROUP: u32 = 8;
const POOL_KEEP_BYTES: u64 = 768 << 20;
const POOL_KEEP_ENCODES: u64 = 4;
const MAP_CACHE_ENTRIES: usize = 6;
const MAP_CACHE_BYTES: u64 = 256 << 20;
const COMMON_SOURCE: &str = include_str!("shaders/compute_common.wgsl");
const COMMON_PARAMS: &str =
    "struct Params { grid: Grid }\n@group(0) @binding(7) var<uniform> params: Params;\n";

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Grid {
    pub dst: [u32; 2],
    pub src: [u32; 2],
    pub radius: u32,
    pub channel: u32,
    pub flags: u32,
    pub eps: f32,
}

impl Grid {
    pub fn new(dst: (u32, u32)) -> Self {
        Self {
            dst: [dst.0, dst.1],
            ..Default::default()
        }
    }

    pub fn with_src(self, src: (u32, u32)) -> Self {
        Self {
            src: [src.0, src.1],
            ..self
        }
    }
}

#[derive(Clone, Copy)]
pub enum Group {
    Common,
    Transform,
    Relight,
    Fog,
    LensBlur,
    Light,
}

impl Group {
    const ALL: [Group; 6] = [
        Group::Common,
        Group::Transform,
        Group::Relight,
        Group::Fog,
        Group::LensBlur,
        Group::Light,
    ];

    fn source(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Group::Common => (
                COMMON_PARAMS,
                &["box_h", "box_v", "area_down", "gf_pack", "gf_coeffs"],
            ),
            Group::Transform => (
                include_str!("shaders/transform.wgsl"),
                &["tf_warp", "tf_frame", "tf_downscale", "tf_grain"],
            ),
            Group::Relight => (
                include_str!("shaders/relight.wgsl"),
                &["rl_merge", "rl_depth", "rl_shadow", "rl_apply"],
            ),
            Group::Fog => (
                include_str!("shaders/fog.wgsl"),
                &["fog_noise_map", "fog_stats", "fog_bloom", "fog_apply"],
            ),
            Group::LensBlur => (
                include_str!("shaders/lens_blur.wgsl"),
                &[
                    "lb_luma",
                    "lb_guide",
                    "lb_pack",
                    "lb_coeffs",
                    "lb_coc",
                    "lb_median_h",
                    "lb_median_v",
                    "lb_down",
                    "lb_tiles",
                    "lb_gather",
                    "lb_accum",
                    "lb_lin",
                    "lb_bloom",
                    "lb_final",
                ],
            ),
            Group::Light => (
                include_str!("shaders/light_effects.wgsl"),
                &[
                    "lt_prefilter",
                    "lt_down",
                    "lt_up",
                    "lt_source",
                    "lt_aperture",
                    "lt_flare",
                ],
            ),
        }
    }
}

pub struct ComputePipelines {
    layout: wgpu::PipelineLayout,
    bgl: wgpu::BindGroupLayout,
    groups: [OnceLock<HashMap<&'static str, wgpu::ComputePipeline>>; 6],
    dummy_view: wgpu::TextureView,
    dummy_layers: wgpu::TextureView,
    dummy_f32: wgpu::TextureView,
    dummy_f16: wgpu::TextureView,
    dummy_r32: wgpu::TextureView,
    dummy_scratch: wgpu::Buffer,
    dummy_data: wgpu::Buffer,
    pool: Mutex<Vec<Slot>>,
    maps: Mutex<Vec<(u64, Slot)>>,
    encodes: AtomicU64,
}

impl ComputePipelines {
    pub fn new(device: &wgpu::Device) -> Self {
        let entry = |binding: u32, ty: wgpu::BindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty,
            count: None,
        };
        let texture = |view_dimension| wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension,
            multisampled: false,
        };
        let storage = |format| wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format,
            view_dimension: wgpu::TextureViewDimension::D2,
        };
        let buffer = |ty| wgpu::BindingType::Buffer {
            ty,
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let flat = wgpu::TextureViewDimension::D2;

        let mut entries: Vec<wgpu::BindGroupLayoutEntry> = (0..6)
            .map(|binding| entry(binding, texture(flat)))
            .collect();
        entries.extend([
            entry(6, texture(wgpu::TextureViewDimension::D2Array)),
            entry(7, buffer(wgpu::BufferBindingType::Uniform)),
            entry(8, storage(wgpu::TextureFormat::Rgba32Float)),
            entry(9, storage(IMAGE_FORMAT)),
            entry(10, storage(wgpu::TextureFormat::R32Float)),
            entry(
                11,
                buffer(wgpu::BufferBindingType::Storage { read_only: false }),
            ),
            entry(
                12,
                buffer(wgpu::BufferBindingType::Storage { read_only: true }),
            ),
        ]);
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Compute BGL"),
            entries: &entries,
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Compute Layout"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });

        let dummy = |format, usage, layers| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("Compute Dummy"),
                    size: wgpu::Extent3d {
                        width: 1,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                })
                .create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(layers),
                    ..Default::default()
                })
        };
        let dummy_buffer = || {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Compute Dummy Buffer"),
                size: 16,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        let sampled = wgpu::TextureUsages::TEXTURE_BINDING;
        let written = wgpu::TextureUsages::STORAGE_BINDING;

        Self {
            dummy_view: dummy(wgpu::TextureFormat::Rgba32Float, sampled, flat),
            dummy_layers: dummy(
                wgpu::TextureFormat::Rgba32Float,
                sampled,
                wgpu::TextureViewDimension::D2Array,
            ),
            dummy_f32: dummy(wgpu::TextureFormat::Rgba32Float, written, flat),
            dummy_f16: dummy(IMAGE_FORMAT, written, flat),
            dummy_r32: dummy(wgpu::TextureFormat::R32Float, written, flat),
            dummy_scratch: dummy_buffer(),
            dummy_data: dummy_buffer(),
            groups: Default::default(),
            pool: Mutex::new(Vec::new()),
            maps: Mutex::new(Vec::new()),
            encodes: AtomicU64::new(0),
            layout,
            bgl,
        }
    }

    pub fn warm(&self, device: &wgpu::Device) {
        for group in Group::ALL {
            self.compiled(device, group);
        }
    }

    fn pipeline(&self, device: &wgpu::Device, group: Group, entry: &str) -> &wgpu::ComputePipeline {
        &self.compiled(device, group)[entry]
    }

    fn compiled(
        &self,
        device: &wgpu::Device,
        group: Group,
    ) -> &HashMap<&'static str, wgpu::ComputePipeline> {
        self.groups[group as usize].get_or_init(|| {
            let (source, entries) = group.source();
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Compute Shader"),
                source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", source, COMMON_SOURCE).into()),
            });
            entries
                .iter()
                .map(|&name| {
                    let pipeline =
                        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                            label: Some(name),
                            layout: Some(&self.layout),
                            module: &shader,
                            entry_point: Some(name),
                            compilation_options: Default::default(),
                            cache: None,
                        });
                    (name, pipeline)
                })
                .collect()
        })
    }
}

#[derive(Clone)]
pub struct Slot {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
    format: wgpu::TextureFormat,
    layers: u32,
    last_encode: u64,
}

impl Slot {
    fn bytes(&self) -> u64 {
        let texel = match self.format {
            wgpu::TextureFormat::Rgba32Float => 16,
            IMAGE_FORMAT => 8,
            _ => 4,
        };
        self.size.0 as u64 * self.size.1 as u64 * self.layers.max(1) as u64 * texel
    }
}

pub struct Tex {
    slot: Option<Slot>,
    free: Rc<RefCell<Vec<Slot>>>,
}

impl Tex {
    pub fn detach(mut self) -> Slot {
        self.slot.take().unwrap()
    }
}

impl std::ops::Deref for Tex {
    type Target = Slot;

    fn deref(&self) -> &Slot {
        self.slot.as_ref().unwrap()
    }
}

impl Drop for Tex {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            self.free.borrow_mut().push(slot);
        }
    }
}

#[derive(Clone, Copy)]
pub enum Out<'a> {
    F32(&'a wgpu::TextureView),
    F16(&'a wgpu::TextureView),
    R32(&'a wgpu::TextureView),
    Both(&'a wgpu::TextureView, &'a wgpu::TextureView),
    None,
}

#[derive(Clone, Copy, Default)]
pub struct Bind<'a> {
    pub layers: Option<&'a wgpu::TextureView>,
    pub scratch: Option<&'a wgpu::Buffer>,
    pub data: Option<&'a wgpu::Buffer>,
    pub groups: Option<(u32, u32)>,
}

pub struct ComputeEncoder<'a> {
    pub device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    pipelines: &'a ComputePipelines,
    encode_index: u64,
    pub encoder: wgpu::CommandEncoder,
    free: Rc<RefCell<Vec<Slot>>>,
}

pub fn encode<T>(
    context: &GpuContext,
    build: impl FnOnce(&mut ComputeEncoder) -> T,
) -> Result<T, String> {
    let device = &context.device;
    let pipelines = context
        .compute
        .get_or_init(|| ComputePipelines::new(device));
    let out_of_memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let invalid = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let free = std::mem::take(&mut *pipelines.pool.lock().unwrap_or_else(|e| e.into_inner()));
    let encode_index = pipelines.encodes.fetch_add(1, Ordering::Relaxed) + 1;
    let mut enc = ComputeEncoder {
        device,
        queue: &context.queue,
        pipelines,
        encode_index,
        encoder: device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Compute Encoder"),
        }),
        free: Rc::new(RefCell::new(free)),
    };
    let output = build(&mut enc);
    let ComputeEncoder { encoder, free, .. } = enc;
    context.queue.submit(Some(encoder.finish()));

    let invalid = pollster::block_on(invalid.pop());
    if let Some(error) = pollster::block_on(out_of_memory.pop()).or(invalid) {
        pipelines
            .maps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        return Err(error.to_string());
    }

    let free = Rc::try_unwrap(free)
        .map(RefCell::into_inner)
        .unwrap_or_default();
    let mut pool = pipelines.pool.lock().unwrap_or_else(|e| e.into_inner());
    pool.extend(free);
    pool.retain(|slot| encode_index - slot.last_encode.min(encode_index) < POOL_KEEP_ENCODES);
    let mut kept = 0u64;
    let mut index = pool.len();
    while index > 0 {
        index -= 1;
        let bytes = pool[index].bytes();
        if kept + bytes > POOL_KEEP_BYTES {
            pool.remove(index);
        } else {
            kept += bytes;
        }
    }
    drop(pool);
    Ok(output)
}

pub fn rgba_halves(image: &DynamicImage) -> Vec<f16> {
    let convert = |src: &[f32], channels: usize, width: usize| {
        let mut halves = vec![f16::ZERO; src.len() / channels * 4];
        halves
            .par_chunks_exact_mut(width * 4)
            .zip(src.par_chunks_exact(width * channels))
            .for_each(|(out, row)| {
                let mut rgba = vec![1.0f32; width * 4];
                for (dst, px) in rgba
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(row.chunks_exact(channels))
                {
                    dst[..channels].copy_from_slice(px);
                }
                out.convert_from_f32_slice(&rgba);
            });
        halves
    };
    let width = image.width() as usize;
    match image {
        DynamicImage::ImageRgba32F(buffer) => convert(buffer.as_raw(), 4, width),
        DynamicImage::ImageRgb32F(buffer) => convert(buffer.as_raw(), 3, width),
        other if other.color().has_alpha() => convert(other.to_rgba32f().as_raw(), 4, width),
        other => convert(other.to_rgb32f().as_raw(), 3, width),
    }
}

pub fn upload_image(context: &GpuContext, size: (u32, u32), halves: &[f16]) -> Slot {
    let texture = context.device.create_texture_with_data(
        &context.queue,
        &wgpu::TextureDescriptor {
            label: Some("Source Image"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: IMAGE_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::MipMajor,
        bytemuck::cast_slice(halves),
    );
    let view = texture.create_view(&Default::default());
    Slot {
        texture,
        view,
        size,
        format: IMAGE_FORMAT,
        layers: 0,
        last_encode: 0,
    }
}

impl<'a> ComputeEncoder<'a> {
    pub fn texture(
        &self,
        label: &'static str,
        size: (u32, u32),
        format: wgpu::TextureFormat,
    ) -> Tex {
        self.allocate(label, size, 0, format)
    }

    pub fn layered(&self, label: &'static str, size: (u32, u32), layers: u32) -> Tex {
        self.allocate(label, size, layers, wgpu::TextureFormat::Rgba32Float)
    }

    fn allocate(
        &self,
        label: &'static str,
        size: (u32, u32),
        layers: u32,
        format: wgpu::TextureFormat,
    ) -> Tex {
        let reused = {
            let mut free = self.free.borrow_mut();
            free.iter()
                .rposition(|s| s.size == size && s.layers == layers && s.format == format)
                .map(|index| free.swap_remove(index))
        };
        let mut slot = reused.unwrap_or_else(|| {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: layers.max(1),
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(if layers > 0 {
                    wgpu::TextureViewDimension::D2Array
                } else {
                    wgpu::TextureViewDimension::D2
                }),
                ..Default::default()
            });
            Slot {
                texture,
                view,
                size,
                format,
                layers,
                last_encode: 0,
            }
        });
        slot.last_encode = self.encode_index;
        Tex {
            slot: Some(slot),
            free: Rc::clone(&self.free),
        }
    }

    pub fn cached_map(
        &self,
        name: &'static str,
        map_key: u64,
        size: (u32, u32),
        format: wgpu::TextureFormat,
        values: impl FnOnce() -> Vec<f32>,
    ) -> Slot {
        let key = {
            let mut hasher = DefaultHasher::new();
            (name, map_key).hash(&mut hasher);
            hasher.finish()
        };
        let mut maps = self
            .pipelines
            .maps
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(index) = maps.iter().position(|(k, _)| *k == key) {
            let entry = maps.remove(index);
            let slot = entry.1.clone();
            maps.push(entry);
            return slot;
        }
        let texture = self.device.create_texture_with_data(
            self.queue,
            &wgpu::TextureDescriptor {
                label: Some(name),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::MipMajor,
            bytemuck::cast_slice(&values()),
        );
        let view = texture.create_view(&Default::default());
        let slot = Slot {
            texture,
            view,
            size,
            format,
            layers: 0,
            last_encode: 0,
        };
        let mut bytes: u64 = maps.iter().map(|(_, map)| map.bytes()).sum();
        while !maps.is_empty()
            && (maps.len() >= MAP_CACHE_ENTRIES || bytes + slot.bytes() > MAP_CACHE_BYTES)
        {
            bytes -= maps.remove(0).1.bytes();
        }
        maps.push((key, slot.clone()));
        slot
    }

    pub fn buffer(&self, label: &'static str, bytes: &[u8]) -> wgpu::Buffer {
        self.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn run<P: bytemuck::Pod>(
        &mut self,
        group: Group,
        entry: &str,
        params: &P,
        dst: (u32, u32),
        inputs: &[&wgpu::TextureView],
        out: Out,
        bind: Bind,
    ) {
        let pipes = self.pipelines;
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Compute Params"),
                contents: bytemuck::bytes_of(params),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        fn view(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding,
                resource: wgpu::BindingResource::TextureView(view),
            }
        }
        let mut entries: Vec<wgpu::BindGroupEntry> = (0..6)
            .map(|i| {
                view(
                    i as u32,
                    inputs.get(i).copied().unwrap_or(&pipes.dummy_view),
                )
            })
            .collect();
        let (f32_out, f16_out, r32_out) = match out {
            Out::F32(v) => (v, &pipes.dummy_f16, &pipes.dummy_r32),
            Out::F16(v) => (&pipes.dummy_f32, v, &pipes.dummy_r32),
            Out::R32(v) => (&pipes.dummy_f32, &pipes.dummy_f16, v),
            Out::Both(f32_view, f16_view) => (f32_view, f16_view, &pipes.dummy_r32),
            Out::None => (&pipes.dummy_f32, &pipes.dummy_f16, &pipes.dummy_r32),
        };
        entries.extend([
            view(6, bind.layers.unwrap_or(&pipes.dummy_layers)),
            wgpu::BindGroupEntry {
                binding: 7,
                resource: uniform.as_entire_binding(),
            },
            view(8, f32_out),
            view(9, f16_out),
            view(10, r32_out),
            wgpu::BindGroupEntry {
                binding: 11,
                resource: bind
                    .scratch
                    .unwrap_or(&pipes.dummy_scratch)
                    .as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 12,
                resource: bind.data.unwrap_or(&pipes.dummy_data).as_entire_binding(),
            },
        ]);
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Compute BG"),
            layout: &pipes.bgl,
            entries: &entries,
        });
        let groups = bind
            .groups
            .unwrap_or((dst.0.div_ceil(WORKGROUP), dst.1.div_ceil(WORKGROUP)));
        let mut pass = self.encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipes.pipeline(self.device, group, entry));
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
    }

    pub fn blur(&mut self, src: Tex, radius: u32, passes: u32, flags: u32) -> Tex {
        let size = src.size;
        if radius == 0 || size.0 < 2 || size.1 < 2 {
            return src;
        }
        let grid = Grid {
            radius,
            flags,
            ..Grid::new(size)
        };
        let mut current = src;
        for _ in 0..passes {
            let tmp = self.texture("Compute Box", size, wgpu::TextureFormat::Rgba32Float);
            let out = self.texture("Compute Box", size, wgpu::TextureFormat::Rgba32Float);
            self.run(
                Group::Common,
                "box_h",
                &grid,
                size,
                &[&current.view],
                Out::F32(&tmp.view),
                Bind::default(),
            );
            self.run(
                Group::Common,
                "box_v",
                &grid,
                size,
                &[&tmp.view],
                Out::F32(&out.view),
                Bind::default(),
            );
            current = out;
        }
        current
    }

    pub fn area_down(&mut self, src: &Slot, size: (u32, u32), flags: u32) -> Tex {
        let out = self.texture("Compute Area", size, wgpu::TextureFormat::Rgba32Float);
        let grid = Grid {
            flags,
            ..Grid::new(size).with_src(src.size)
        };
        self.run(
            Group::Common,
            "area_down",
            &grid,
            size,
            &[&src.view],
            Out::F32(&out.view),
            Bind::default(),
        );
        out
    }

    pub fn guided_model(
        &mut self,
        guide: &Slot,
        p: &Slot,
        channel: u32,
        radius: u32,
        eps: f32,
    ) -> Tex {
        let size = guide.size;
        let grid = Grid {
            channel,
            eps,
            ..Grid::new(size)
        };
        let packed = self.texture("Compute Guided", size, wgpu::TextureFormat::Rgba32Float);
        self.run(
            Group::Common,
            "gf_pack",
            &grid,
            size,
            &[&guide.view, &p.view],
            Out::F32(&packed.view),
            Bind::default(),
        );
        let means = self.blur(packed, radius, 1, 0);
        let coeffs = self.texture("Compute Guided", size, wgpu::TextureFormat::Rgba32Float);
        self.run(
            Group::Common,
            "gf_coeffs",
            &grid,
            size,
            &[&means.view],
            Out::F32(&coeffs.view),
            Bind::default(),
        );
        self.blur(coeffs, radius, 1, 0)
    }
}
