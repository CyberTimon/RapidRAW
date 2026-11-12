use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use image::{DynamicImage, Rgb32FImage};
use rawler::Orientation;
use rayon::prelude::*;
use wgpu::util::DeviceExt;

use crate::image_processing::{GpuContext, into_rgb32f_parallel};

const SHADER: &str = include_str!("shaders/develop.wgsl");
const WORKGROUP: u32 = 8;
const LINEAR: u32 = 256;
const STRIDE_GROUPS: u32 = 1024;
const STATS_WORDS: u64 = 8196;
const GLOBALS: u64 = 32;
const BAND_BYTES: u64 = 64 << 20;
const COPY_CHUNK: usize = 1 << 20;
const PAD: u32 = 2;
const PYRAMID_LEVELS: usize = 16;
const SAMPLE_BAND_PX: u32 = 24;
const FILL_SUPPORT_DIVISOR: f32 = 28.0;
const PLATEAU_SHARE: u32 = 5000;

const HIGHLIGHTS: u32 = 1;
const DENOISE: u32 = 2;
const SHARPEN: u32 = 4;
const COLOR: u32 = 8;

const ENTRIES: &[&str] = &[
    "hl_hist",
    "hl_levels",
    "hl_cells",
    "hl_flags",
    "hl_dilate",
    "hl_inpaint",
    "hl_fill",
    "pp_down",
    "pp_up",
    "nr_half",
    "nr_quarter",
    "nr_relwiden",
    "nr_filter",
    "nr_upsample",
    "nr_core",
    "sh_luma",
    "md_sample",
    "md_hist",
    "md_pick",
    "out_band",
];

#[derive(Clone, Copy)]
pub struct Camera {
    pub wb: [f32; 3],
    pub matrix: [[f32; 3]; 3],
    pub compression: [Option<(f32, f32)>; 3],
    pub clamp_limit: f32,
}

#[derive(Clone, Copy)]
pub struct Finish {
    pub camera: Option<Camera>,
    pub orientation: Orientation,
    pub denoise: f32,
    pub sharpen: f32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    dims: [u32; 4],
    mode: [u32; 4],
    grid: [u32; 4],
    wb: [f32; 4],
    neutral: [f32; 4],
    matrix: [[f32; 4]; 3],
    comp: [[f32; 4]; 3],
    amounts: [f32; 4],
    half: [u32; 4],
    quarter: [u32; 4],
    planes: [[u32; 4]; 5],
    cells: [u32; 4],
    pyr: [[u32; 4]; 2 * PYRAMID_LEVELS],
}

struct Kernels {
    device: Arc<wgpu::Device>,
    bind_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
}

static KERNELS: Mutex<Option<Kernels>> = Mutex::new(None);

impl Kernels {
    fn new(device: &Arc<wgpu::Device>) -> Self {
        let buffer = |binding, ty, dynamic| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: dynamic,
                min_binding_size: None,
            },
            count: None,
        };
        let storage = |read_only| wgpu::BufferBindingType::Storage { read_only };
        let entries = [
            buffer(0, wgpu::BufferBindingType::Uniform, false),
            buffer(1, wgpu::BufferBindingType::Uniform, true),
            buffer(2, storage(true), false),
            buffer(3, storage(false), false),
            buffer(4, storage(false), false),
            buffer(5, storage(false), false),
            buffer(6, storage(false), false),
        ];
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Develop BGL"),
            entries: &entries,
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Develop Layout"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Develop Shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipelines = ENTRIES
            .iter()
            .map(|&entry| {
                let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(entry),
                    layout: Some(&layout),
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    cache: None,
                });
                (entry, pipeline)
            })
            .collect();
        Self {
            device: Arc::clone(device),
            bind_layout,
            pipelines,
        }
    }
}

fn with_kernels<T>(device: &Arc<wgpu::Device>, f: impl FnOnce(&Kernels) -> T) -> T {
    let mut guard = KERNELS.lock().unwrap_or_else(|e| e.into_inner());
    if guard
        .as_ref()
        .is_some_and(|kernels| !Arc::ptr_eq(&kernels.device, device))
    {
        *guard = None;
    }
    f(guard.get_or_insert_with(|| Kernels::new(device)))
}

pub fn warm(device: &Arc<wgpu::Device>) {
    with_kernels(device, |_| ());
}

fn orientation_code(orientation: Orientation) -> u32 {
    match orientation {
        Orientation::HorizontalFlip => 1,
        Orientation::Rotate180 => 2,
        Orientation::VerticalFlip => 3,
        Orientation::Transpose => 4,
        Orientation::Rotate90 => 5,
        Orientation::Transverse => 6,
        Orientation::Rotate270 => 7,
        Orientation::Normal | Orientation::Unknown => 0,
    }
}

fn swaps_axes(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Transpose
            | Orientation::Rotate90
            | Orientation::Transverse
            | Orientation::Rotate270
    )
}

fn noise_samples(w: u32, h: u32, channels: u32) -> u32 {
    h.div_ceil(8) * w.saturating_sub(4).div_ceil(7) * channels
}

struct Op {
    entry: &'static str,
    step: [u32; 4],
    groups: (u32, u32),
}

struct Plan {
    ops: Vec<Op>,
}

impl Plan {
    fn grid(&mut self, entry: &'static str, step: [u32; 4], w: u32, h: u32) {
        self.ops.push(Op {
            entry,
            step,
            groups: (w.div_ceil(WORKGROUP), h.div_ceil(WORKGROUP)),
        });
    }

    fn linear(&mut self, entry: &'static str, step: [u32; 4], n: u32) {
        self.ops.push(Op {
            entry,
            step,
            groups: (n.div_ceil(LINEAR).clamp(1, STRIDE_GROUPS), 1),
        });
    }

    fn single(&mut self, entry: &'static str, step: [u32; 4]) {
        self.ops.push(Op {
            entry,
            step,
            groups: (1, 1),
        });
    }

    fn median(&mut self, kind: u32, slot: u32, n: u32) {
        self.linear("md_sample", [kind, n, 0, 0], n);
        for pass in 0..3 {
            self.linear("md_hist", [pass, n, 0, 0], n);
            self.single("md_pick", [pass, n, slot, 0]);
        }
    }
}

struct Layout {
    params: Params,
    grid_floats: u64,
    plane_floats: u64,
    plan: Plan,
}

fn layout(w: u32, h: u32, finish: &Finish) -> Layout {
    let (ow, oh) = if swaps_axes(finish.orientation) {
        (h, w)
    } else {
        (w, h)
    };
    let denoise = finish.denoise > 0.0;
    let sharpen_samples = oh.div_ceil(16) * ow.div_ceil(5);
    let sharpen = finish.sharpen > 0.0 && sharpen_samples > 0;
    let highlights = finish.camera.is_some();

    let mut flags = 0;
    flags |= if highlights { HIGHLIGHTS | COLOR } else { 0 };
    flags |= if denoise { DENOISE } else { 0 };
    flags |= if sharpen { SHARPEN } else { 0 };

    let cell = (w.max(h) / 1024).clamp(1, 8);
    let gw = w.div_ceil(cell);
    let gh = h.div_ceil(cell);
    let band_radius = SAMPLE_BAND_PX.div_ceil(cell);

    let mut grid_floats = GLOBALS;
    let mut take = |n: u64| {
        let o = grid_floats;
        grid_floats += n.max(1);
        o as u32
    };
    let cells = [
        take(gw as u64 * gh as u64),
        take(gw as u64 * gh as u64),
        take(gw as u64 * gh as u64),
        0,
    ];
    let mut pyr = [[0u32; 4]; 2 * PYRAMID_LEVELS];
    let mut levels = 0usize;
    for p in 0..2 {
        let (mut lw, mut lh) = (gw, gh);
        let mut l = 0;
        loop {
            let n = lw as u64 * lh as u64;
            pyr[p * PYRAMID_LEVELS + l] = [lw, lh, take(n * 6), take(n * 3)];
            if lw == 1 && lh == 1 {
                break;
            }
            lw = lw.div_ceil(2);
            lh = lh.div_ceil(2);
            l += 1;
        }
        levels = l;
    }

    let hw = ow.div_ceil(2);
    let hh = oh.div_ceil(2);
    let (pw, ph) = (hw + 2 * PAD, hh + 2 * PAD);
    let qw = hw.div_ceil(2);
    let qh = hh.div_ceil(2);
    let (qpw, qph) = (qw + 2 * PAD, qh + 2 * PAD);

    let half_samples = noise_samples(pw, ph, 1);
    let quarter_samples = noise_samples(qpw, qph, 1);
    let core_samples = (hw * hh).div_ceil(7);
    let full_samples = noise_samples(ow, oh, 2);
    let max_samples = [
        2 * half_samples,
        2 * quarter_samples,
        core_samples,
        full_samples,
        sharpen_samples,
    ]
    .into_iter()
    .max()
    .unwrap_or(1);

    let mut plane_floats = 0u64;
    let mut plane = |n: u64, used: bool| {
        let o = plane_floats;
        plane_floats += if used { n.max(1) } else { 1 };
        o as u32
    };
    let padded = pw as u64 * ph as u64;
    let unpadded = hw as u64 * hh as u64;
    let qpadded = qpw as u64 * qph as u64;
    let qunpadded = qw as u64 * qh as u64;
    let half_q = plane(padded, denoise);
    let half_cr = plane(padded, denoise);
    let half_cb = plane(padded, denoise);
    let half_rel = plane(padded, denoise);
    let half_widen = plane(padded, denoise);
    let ref_r = plane(unpadded, denoise);
    let ref_b = plane(unpadded, denoise);
    let half_fr = plane(unpadded, denoise);
    let half_fb = plane(unpadded, denoise);
    let quarter_q = plane(qpadded, denoise);
    let quarter_cr = plane(qpadded, denoise);
    let quarter_cb = plane(qpadded, denoise);
    let quarter_rel = plane(qpadded, denoise);
    let quarter_widen = plane(qpadded, denoise);
    let quarter_fr = plane(qunpadded, denoise);
    let quarter_fb = plane(qunpadded, denoise);
    let luma = plane(ow as u64 * oh as u64, sharpen);
    let samples = plane(max_samples as u64, denoise || sharpen);

    let (wb, neutral, matrix, comp, clamp_limit) = match finish.camera {
        Some(camera) => (
            camera.wb,
            camera.wb.map(|c| 1.0 / c),
            camera.matrix.map(|r| [r[0], r[1], r[2], 0.0]),
            camera
                .compression
                .map(|c| c.map_or([0.0; 4], |(t, s)| [1.0, t, s, 0.0])),
            camera.clamp_limit,
        ),
        None => ([1.0; 3], [1.0; 3], [[0.0; 4]; 3], [[0.0; 4]; 3], f32::MAX),
    };
    let support = w.max(h) as f32 / FILL_SUPPORT_DIVISOR;

    let params = Params {
        dims: [w, h, ow, oh],
        mode: [
            orientation_code(finish.orientation),
            flags,
            cell,
            band_radius,
        ],
        grid: [gw, gh, levels as u32, (w * h / PLATEAU_SHARE).max(64)],
        wb: [wb[0], wb[1], wb[2], clamp_limit],
        neutral: [neutral[0], neutral[1], neutral[2], 0.0],
        matrix,
        comp,
        amounts: [
            finish.denoise.min(1.0),
            finish.sharpen,
            0.25 * (cell * cell) as f32,
            0.5 * support * support,
        ],
        half: [hw, hh, pw, ph],
        quarter: [qw, qh, qpw, qph],
        planes: [
            [half_q, half_cr, half_cb, half_rel],
            [half_widen, ref_r, ref_b, half_fr],
            [quarter_q, quarter_cr, quarter_cb, half_fb],
            [quarter_rel, quarter_widen, quarter_fr, quarter_fb],
            [luma, samples, 0, 0],
        ],
        cells,
        pyr,
    };

    let mut plan = Plan { ops: Vec::new() };
    if highlights {
        plan.linear("hl_hist", [0; 4], w * h / 64);
        plan.single("hl_levels", [0; 4]);
        plan.grid("hl_cells", [0; 4], gw, gh);
        plan.single("hl_flags", [0; 4]);
        plan.grid("hl_dilate", [0, cells[0], cells[1], 0], gw, gh);
        plan.grid("hl_dilate", [1, cells[1], cells[2], 0], gw, gh);
        for p in 0..2u32 {
            plan.grid(
                if p == 0 { "hl_inpaint" } else { "hl_fill" },
                [0; 4],
                gw,
                gh,
            );
            for l in 0..levels as u32 {
                let next = pyr[p as usize * PYRAMID_LEVELS + l as usize + 1];
                plan.grid("pp_down", [p, l, 0, 0], next[0], next[1]);
            }
            for l in (0..=levels as u32).rev() {
                let lv = pyr[p as usize * PYRAMID_LEVELS + l as usize];
                plan.grid(
                    "pp_up",
                    [p, l, (l == levels as u32) as u32, 0],
                    lv[0],
                    lv[1],
                );
            }
        }
    }
    if denoise {
        plan.grid("nr_half", [0; 4], pw, ph);
        plan.median(0, 0, half_samples);
        plan.median(1, 1, 2 * half_samples);
        plan.grid("nr_quarter", [0; 4], qpw, qph);
        plan.median(2, 2, quarter_samples);
        plan.median(3, 3, 2 * quarter_samples);
        plan.grid("nr_relwiden", [1, 0, 0, 0], qpw, qph);
        plan.grid("nr_filter", [1, 0, 0, 0], qw, qh);
        plan.grid("nr_upsample", [0; 4], hw, hh);
        plan.grid("nr_relwiden", [0; 4], pw, ph);
        plan.grid("nr_filter", [0, 1, 0, 0], hw, hh);
        plan.median(4, 4, core_samples);
        plan.grid("nr_core", [0; 4], hw, hh);
        plan.median(5, 5, full_samples);
    }
    if sharpen {
        plan.grid("sh_luma", [0; 4], ow, oh);
        plan.median(6, 6, sharpen_samples);
    }

    Layout {
        params,
        grid_floats,
        plane_floats,
        plan,
    }
}

struct Band {
    slot: usize,
    first_row: usize,
    rows: usize,
    submission: wgpu::SubmissionIndex,
}

pub(crate) fn whole(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

pub(crate) fn storage(
    device: &wgpu::Device,
    label: &'static str,
    bytes: u64,
    usage: wgpu::BufferUsages,
) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: bytes.max(16).div_ceil(16) * 16,
        usage,
        mapped_at_creation: false,
    })
}

pub(crate) fn scoped<T>(device: &wgpu::Device, run: impl FnOnce() -> Result<T>) -> Result<T> {
    let out_of_memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let invalid = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let result = run();
    let invalid = pollster::block_on(invalid.pop());
    if let Some(error) = pollster::block_on(out_of_memory.pop()).or(invalid) {
        return Err(anyhow!("GPU develop failed: {}", error));
    }
    result
}

pub(crate) fn release<T: Send + 'static>(resources: T) {
    rayon::spawn(move || drop(resources));
}

pub(crate) fn upload(
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    offset: usize,
    bytes: &[u8],
) -> Result<()> {
    let size = NonZeroU64::new(bytes.len().div_ceil(4) as u64 * 4)
        .ok_or_else(|| anyhow!("Empty GPU upload"))?;
    let mut view = queue
        .write_buffer_with(buffer, offset as u64, size)
        .ok_or_else(|| anyhow!("GPU upload of {} bytes failed", size))?;
    let (mut data, mut pad) = view.slice(..).split_at(bytes.len());
    data.copy_from_slice(bytes);
    pad.fill(0);
    Ok(())
}

pub fn finish(
    context: &GpuContext,
    encoder: wgpu::CommandEncoder,
    cam: &wgpu::Buffer,
    width: u32,
    height: u32,
    finish: &Finish,
) -> Result<Rgb32FImage> {
    with_kernels(&context.device, |kernels| {
        run(kernels, context, encoder, cam, width, height, finish)
    })
}

pub fn finish_rgb(
    context: &GpuContext,
    data: &[[f32; 3]],
    width: u32,
    height: u32,
    finish: &Finish,
) -> Result<Rgb32FImage> {
    let device = &*context.device;
    scoped(device, || {
        let bytes: &[u8] = bytemuck::cast_slice(data);
        let cam = storage(
            device,
            "Develop Input",
            bytes.len() as u64,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        upload(&context.queue, &cam, 0, bytes)?;
        let encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Develop Encoder"),
        });
        let developed = self::finish(context, encoder, &cam, width, height, finish);
        release(cam);
        developed
    })
}

pub fn enhance(image: DynamicImage, denoise: f32, sharpen: f32) -> Result<DynamicImage> {
    if denoise <= 0.0 && sharpen <= 0.0 {
        return Ok(image);
    }
    let context = crate::gpu_processing::shared_gpu_context().map_err(|e| anyhow!(e))?;
    let image = into_rgb32f_parallel(image);
    let (width, height) = image.dimensions();
    let enhanced = finish_rgb(
        &context,
        bytemuck::cast_slice(image.as_raw()),
        width,
        height,
        &Finish {
            camera: None,
            orientation: Orientation::Normal,
            denoise: denoise.max(0.0),
            sharpen: sharpen.max(0.0),
        },
    )?;
    Ok(DynamicImage::ImageRgb32F(enhanced))
}

fn run(
    kernels: &Kernels,
    context: &GpuContext,
    mut encoder: wgpu::CommandEncoder,
    cam: &wgpu::Buffer,
    width: u32,
    height: u32,
    finish: &Finish,
) -> Result<Rgb32FImage> {
    let device = &*context.device;
    let queue = &*context.queue;
    let limits = &context.limits;
    let binding_limit = limits
        .max_storage_buffer_binding_size
        .min(limits.max_buffer_size);

    let Layout {
        params,
        grid_floats,
        plane_floats,
        plan,
    } = layout(width, height, finish);
    let [_, _, ow, oh] = params.dims;
    if cam.size() > binding_limit || plane_floats * 4 > binding_limit {
        return Err(anyhow!("Image too large for the GPU develop pass"));
    }

    let row_bytes = ow as u64 * 12;
    let band_rows = (BAND_BYTES.min(binding_limit) / row_bytes).clamp(1, oh as u64) as u32;
    let band_bytes = row_bytes * band_rows as u64;

    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Develop Params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let step_stride = limits.min_uniform_buffer_offset_alignment.max(16) as usize;
    let band_count = oh.div_ceil(band_rows);
    let mut steps: Vec<[u32; 4]> = plan.ops.iter().map(|op| op.step).collect();
    let band_step = steps.len();
    steps.extend((0..band_count).map(|b| [b * band_rows, band_rows.min(oh - b * band_rows), 0, 0]));
    let mut step_bytes = vec![0u8; steps.len() * step_stride];
    for (chunk, step) in step_bytes.chunks_exact_mut(step_stride).zip(&steps) {
        chunk[..16].copy_from_slice(bytemuck::bytes_of(step));
    }
    let step_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Develop Steps"),
        contents: &step_bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let stats = storage(
        device,
        "Develop Stats",
        STATS_WORDS * 4,
        wgpu::BufferUsages::STORAGE,
    );
    let grid = storage(
        device,
        "Develop Grid",
        grid_floats * 4,
        wgpu::BufferUsages::STORAGE,
    );
    let planes = storage(
        device,
        "Develop Planes",
        plane_floats * 4,
        wgpu::BufferUsages::STORAGE,
    );
    let bands: [wgpu::Buffer; 2] = std::array::from_fn(|_| {
        storage(
            device,
            "Develop Band",
            band_bytes,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        )
    });
    let staging: [wgpu::Buffer; 2] = std::array::from_fn(|_| {
        storage(
            device,
            "Develop Readback",
            band_bytes,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        )
    });

    let bind_groups: [wgpu::BindGroup; 2] = std::array::from_fn(|slot| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Develop BG"),
            layout: &kernels.bind_layout,
            entries: &[
                whole(0, &uniform),
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &step_buffer,
                        offset: 0,
                        size: NonZeroU64::new(16),
                    }),
                },
                whole(2, cam),
                whole(3, &stats),
                whole(4, &grid),
                whole(5, &planes),
                whole(6, &bands[slot]),
            ],
        })
    });

    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        for (i, op) in plan.ops.iter().enumerate() {
            pass.set_bind_group(0, &bind_groups[0], &[(i * step_stride) as u32]);
            pass.set_pipeline(&kernels.pipelines[op.entry]);
            pass.dispatch_workgroups(op.groups.0, op.groups.1, 1);
        }
    }
    queue.submit(Some(encoder.finish()));
    encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Develop Encoder"),
    });

    let pixels = ow as usize * oh as usize;
    let mut out = Vec::with_capacity(pixels);
    out.par_extend(rayon::iter::repeat_n([0.0f32; 3], pixels));
    let mut pending: Option<Band> = None;
    for band in 0..band_count {
        let slot = band as usize % 2;
        let rows = band_rows.min(oh - band * band_rows);
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_bind_group(
                0,
                &bind_groups[slot],
                &[((band_step + band as usize) * step_stride) as u32],
            );
            pass.set_pipeline(&kernels.pipelines["out_band"]);
            pass.dispatch_workgroups(ow.div_ceil(WORKGROUP), rows.div_ceil(WORKGROUP), 1);
        }
        encoder.copy_buffer_to_buffer(&bands[slot], 0, &staging[slot], 0, row_bytes * rows as u64);
        let submission = queue.submit(Some(encoder.finish()));
        encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Develop Encoder"),
        });
        let finished = pending.replace(Band {
            slot,
            first_row: (band * band_rows) as usize,
            rows: rows as usize,
            submission,
        });
        if let Some(finished) = finished {
            read_band(device, &staging, finished, ow as usize, &mut out)?;
        }
    }
    if let Some(finished) = pending {
        read_band(device, &staging, finished, ow as usize, &mut out)?;
    }
    release((bind_groups, staging, bands, planes, grid, stats));
    Rgb32FImage::from_raw(ow, oh, out.into_flattened())
        .ok_or_else(|| anyhow!("Developed image size does not match its dimensions"))
}

fn read_band(
    device: &wgpu::Device,
    staging: &[wgpu::Buffer; 2],
    band: Band,
    width: usize,
    out: &mut [[f32; 3]],
) -> Result<()> {
    let staging = &staging[band.slot];
    let target = &mut out[band.first_row * width..(band.first_row + band.rows) * width];
    let slice = staging.slice(..(target.len() * 12) as u64);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(band.submission),
            timeout: Some(Duration::from_secs(60)),
        })
        .map_err(|e| anyhow!("Develop readback poll failed: {}", e))?;
    rx.recv()?
        .map_err(|e| anyhow!("Develop readback failed: {}", e))?;
    {
        let mapped = slice.get_mapped_range();
        let bytes: &mut [u8] = bytemuck::cast_slice_mut(target);
        bytes
            .par_chunks_mut(COPY_CHUNK)
            .zip(mapped.par_chunks(COPY_CHUNK))
            .for_each(|(dst, src)| dst.copy_from_slice(src));
    }
    staging.unmap();
    Ok(())
}
