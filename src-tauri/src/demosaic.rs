use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Result, anyhow};
use image::Rgb32FImage;
use rawler::RawImageData;
use rawler::imgop::{Dim2, Point, Rect};
use rawler::rawimage::{RawImage, RawPhotometricInterpretation};
use rayon::prelude::*;
use wgpu::util::DeviceExt;

use crate::develop::{Finish, release, scoped, storage, upload, whole};
use crate::image_processing::GpuContext;

const SHADER: &str = include_str!("shaders/demosaic.wgsl");
const WORKGROUP: u32 = 8;
const TILE_BUDGET: u64 = 320 << 20;
const MAX_TILE: u32 = 2048;
const RAW_ROW_SLACK: usize = 8;

const BAYER_STAGES: &[&str] = &[
    "unpack",
    "rcd_vh",
    "rcd_green",
    "rcd_debias_h",
    "rcd_debias_v",
    "rb_prepare",
    "rb_stats",
    "rb_coef",
    "rb_average",
    "rb_tentative",
    "rb_residual",
    "rb_smooth",
];
const MARKESTEIJN_STAGES: &[&str] = &[
    "unpack",
    "xt_minmax",
    "xt_green",
    "xt_solitary_0",
    "xt_redblue_0",
    "xt_greens_0",
    "xt_recalc_0",
    "xt_commit_0",
    "xt_solitary_4",
    "xt_redblue_4",
    "xt_greens_4",
    "xt_recalc_4",
    "xt_commit_4",
    "xt_solitary_4",
    "xt_redblue_4",
    "xt_greens_4",
    "xt_drv",
    "xt_homo",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pattern {
    Bayer,
    XTrans,
}

impl Pattern {
    fn period(self) -> usize {
        match self {
            Pattern::Bayer => 2,
            Pattern::XTrans => 6,
        }
    }

    fn margin(self) -> u32 {
        match self {
            Pattern::Bayer => 40,
            Pattern::XTrans => 32,
        }
    }

    fn texel_bytes(self) -> [u64; 5] {
        match self {
            Pattern::Bayer => [4, 8, 160, 4, 0],
            Pattern::XTrans => [4, 8, 128, 32, 4],
        }
    }

    fn stages(self) -> &'static [&'static str] {
        match self {
            Pattern::Bayer => BAYER_STAGES,
            Pattern::XTrans => MARKESTEIJN_STAGES,
        }
    }

    fn output(self) -> &'static str {
        match self {
            Pattern::Bayer => "rb_out",
            Pattern::XTrans => "xt_out",
        }
    }

    fn bin(self) -> usize {
        match self {
            Pattern::Bayer => 4,
            Pattern::XTrans => 3,
        }
    }
}

type Hexagons = [[[[i32; 2]; 8]; 3]; 3];

pub struct Mosaic<'a> {
    data: &'a [u16],
    stride: usize,
    domain: Rect,
    pattern: Pattern,
    colors: [[u8; 6]; 6],
    hex: Hexagons,
    solitary: [usize; 2],
    black: [f32; 4],
    scale: f32,
    wb: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    tile: [i32; 4],
    inner: [i32; 4],
    domain: [i32; 4],
    strides: [u32; 4],
    pattern: [i32; 4],
    black: [f32; 4],
    wb: [f32; 4],
    colors: [[u32; 4]; 9],
    hex: [[i32; 4]; 36],
}

fn markesteijn_hexagons(colors: &[[u8; 6]; 6]) -> Option<(Hexagons, [usize; 2])> {
    const ORTH: [i32; 12] = [1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1];
    const PATT: [[i32; 16]; 2] = [
        [0, 1, 0, -1, 2, 0, -1, 0, 1, 1, 1, -1, 0, 0, 0, 0],
        [0, 1, 0, -2, 1, 0, -2, 0, 1, 1, -2, -2, 1, -1, -1, 1],
    ];
    let color = |row: i32, col: i32| colors[row.rem_euclid(6) as usize][col.rem_euclid(6) as usize];
    let mut hex: Hexagons = Default::default();
    let mut filled = [[false; 3]; 3];
    let mut solitary = None;
    for row in 0..3 {
        for col in 0..3 {
            let g = (color(row, col) == 1) as usize;
            let mut ng = 0;
            for d in (0..10).step_by(2) {
                if color(row + ORTH[d], col + ORTH[d + 2]) == 1 {
                    ng = 0;
                } else {
                    ng += 1;
                }
                if ng == 4 {
                    solitary = Some([row as usize, col as usize]);
                }
                if ng == g + 1 {
                    for c in 0..8 {
                        let v = ORTH[d] * PATT[g][c * 2] + ORTH[d + 1] * PATT[g][c * 2 + 1];
                        let h = ORTH[d + 2] * PATT[g][c * 2] + ORTH[d + 3] * PATT[g][c * 2 + 1];
                        hex[row as usize][col as usize][c ^ ((g * 2) & d)] = [h, v];
                    }
                    filled[row as usize][col as usize] = true;
                }
            }
        }
    }
    if !filled.iter().flatten().all(|&f| f) {
        return None;
    }
    Some((hex, solitary?))
}

struct Kernels {
    device: Arc<wgpu::Device>,
    bind_layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    module: wgpu::ShaderModule,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
}

static KERNELS: Mutex<Option<Kernels>> = Mutex::new(None);

impl Kernels {
    fn new(device: &Arc<wgpu::Device>) -> Self {
        let buffer = |binding, ty| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let mut entries = vec![
            buffer(0, wgpu::BufferBindingType::Uniform),
            buffer(1, wgpu::BufferBindingType::Storage { read_only: true }),
        ];
        entries.extend((2..8).map(|binding| {
            buffer(
                binding,
                wgpu::BufferBindingType::Storage { read_only: false },
            )
        }));
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Demosaic BGL"),
            entries: &entries,
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Demosaic Layout"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Demosaic Shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        Self {
            device: Arc::clone(device),
            bind_layout,
            pipeline_layout,
            module,
            pipelines: HashMap::new(),
        }
    }

    fn prepare(&mut self, pattern: Pattern) {
        for entry in pattern.stages().iter().copied().chain([pattern.output()]) {
            self.pipelines.entry(entry).or_insert_with(|| {
                self.device
                    .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some(entry),
                        layout: Some(&self.pipeline_layout),
                        module: &self.module,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        cache: None,
                    })
            });
        }
    }
}

fn with_kernels<T>(device: &Arc<wgpu::Device>, f: impl FnOnce(&mut Kernels) -> T) -> T {
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
    with_kernels(device, |kernels| {
        kernels.prepare(Pattern::Bayer);
        kernels.prepare(Pattern::XTrans);
    });
}

impl<'a> Mosaic<'a> {
    pub fn new(raw_image: &'a RawImage, wb: [f32; 3]) -> Option<Self> {
        let RawPhotometricInterpretation::Cfa(config) = &raw_image.photometric else {
            return None;
        };
        let RawImageData::Integer(data) = &raw_image.data else {
            return None;
        };
        if raw_image.cpp != 1
            || raw_image.fuji_rotation_width.is_some()
            || data.len() < raw_image.width * raw_image.height
            || wb.iter().any(|c| !c.is_finite() || *c <= 0.0)
        {
            return None;
        }
        let pattern = match (config.cfa.width, config.cfa.height) {
            (2, 2) => Pattern::Bayer,
            (6, 6) => Pattern::XTrans,
            _ => return None,
        };
        let colors: [[u8; 6]; 6] =
            std::array::from_fn(|y| std::array::from_fn(|x| config.cfa.color_at(y, x) as u8));
        let counts = [0u8, 1, 2].map(|c| colors.iter().flatten().filter(|&&v| v == c).count());
        if colors.iter().flatten().any(|&c| c > 2) || counts.contains(&0) {
            return None;
        }
        let (hex, solitary) = match pattern {
            Pattern::Bayer => Default::default(),
            Pattern::XTrans if counts == [8, 20, 8] => markesteijn_hexagons(&colors)?,
            Pattern::XTrans => return None,
        };

        let full = Rect::new(Point::zero(), raw_image.dim());
        let domain = raw_image.active_area.unwrap_or(full);
        if domain.p.x + domain.d.w > raw_image.width
            || domain.p.y + domain.d.h > raw_image.height
            || domain.d.w < 64
            || domain.d.h < 64
        {
            return None;
        }

        let black = raw_image.blacklevel.as_bayer_array();
        let white = raw_image
            .whitelevel
            .0
            .first()
            .copied()
            .unwrap_or(u16::MAX as u32) as f32;

        Some(Self {
            data,
            stride: raw_image.width,
            domain,
            pattern,
            colors,
            hex,
            solitary,
            black,
            scale: 1.0 / (white - black[0]).max(1.0),
            wb,
        })
    }

    pub fn domain(&self) -> Rect {
        self.domain
    }

    pub fn bin(&self) -> (Vec<[f32; 3]>, Dim2) {
        let size = self.pattern.bin();
        let align = |start: usize, solitary: usize| match self.pattern {
            Pattern::Bayer => start,
            Pattern::XTrans => start + (solitary + 2 + 3 - start % 3) % 3,
        };
        let x0 = align(self.domain.p.x, self.solitary[1]);
        let y0 = align(self.domain.p.y, self.solitary[0]);
        let width = (self.domain.p.x + self.domain.d.w - x0) / size;
        let height = (self.domain.p.y + self.domain.d.h - y0) / size;

        let gain: [[(usize, f32, f32); 6]; 6] = std::array::from_fn(|y| {
            std::array::from_fn(|x| {
                let c = self.colors[y][x] as usize;
                (
                    c,
                    self.black[(y & 1) * 2 + (x & 1)],
                    self.scale * self.wb[c],
                )
            })
        });
        let mut counts = [0f32; 3];
        for y in 0..size {
            for x in 0..size {
                counts[gain[(y0 + y) % 6][(x0 + x) % 6].0] += 1.0;
            }
        }
        let norm = counts.map(|n| 1.0 / n);

        let mut out = vec![[0.0f32; 3]; width * height];
        out.par_chunks_exact_mut(width)
            .enumerate()
            .for_each(|(by, row)| {
                let top = y0 + by * size;
                for (bx, px) in row.iter_mut().enumerate() {
                    let left = x0 + bx * size;
                    let mut sum = [0.0f32; 3];
                    for y in top..top + size {
                        let line = &self.data[y * self.stride..];
                        let lut = &gain[y % 6];
                        for x in left..left + size {
                            let (c, black, mul) = lut[x % 6];
                            sum[c] += (line[x] as f32 - black).max(0.0) * mul;
                        }
                    }
                    *px = std::array::from_fn(|c| sum[c] * norm[c]);
                }
            });
        (out, Dim2::new(width, height))
    }

    pub fn develop(
        &self,
        context: &GpuContext,
        crop: Rect,
        finish: &Finish,
    ) -> Result<Rgb32FImage> {
        let started = Instant::now();
        let result = scoped(&context.device, || {
            with_kernels(&context.device, |kernels| {
                kernels.prepare(self.pattern);
                self.run(kernels, context, crop, finish)
            })
        });
        if result.is_ok() {
            log::info!(
                "GPU develop of {}x{} took {:?}",
                crop.d.w,
                crop.d.h,
                started.elapsed()
            );
        }
        result
    }

    fn params(&self) -> Params {
        let mut colors = [[0u32; 4]; 9];
        for i in 0..36 {
            colors[i / 4][i % 4] = self.colors[i / 6][i % 6] as u32;
        }
        let mut hex = [[0i32; 4]; 36];
        for row in 0..3 {
            for col in 0..3 {
                for k in 0..8 {
                    let e = (row * 3 + col) * 8 + k;
                    let [dx, dy] = self.hex[row][col][k];
                    hex[e / 2][(e % 2) * 2] = dx;
                    hex[e / 2][(e % 2) * 2 + 1] = dy;
                }
            }
        }
        Params {
            tile: [0; 4],
            inner: [0; 4],
            domain: [
                self.domain.p.x as i32,
                self.domain.p.y as i32,
                (self.domain.p.x + self.domain.d.w) as i32,
                (self.domain.p.y + self.domain.d.h) as i32,
            ],
            strides: [0; 4],
            pattern: [
                self.pattern.period() as i32,
                self.solitary[1] as i32,
                self.solitary[0] as i32,
                0,
            ],
            black: self.black,
            wb: [self.wb[0], self.wb[1], self.wb[2], self.scale],
            colors,
            hex,
        }
    }

    fn run(
        &self,
        kernels: &Kernels,
        context: &GpuContext,
        crop: Rect,
        finish: &Finish,
    ) -> Result<Rgb32FImage> {
        let device = &*context.device;
        let queue = &*context.queue;
        let limits = &context.limits;
        let binding_limit = limits
            .max_storage_buffer_binding_size
            .min(limits.max_buffer_size);
        let alignment = limits.min_storage_buffer_offset_alignment.max(4) as usize;

        let pattern = self.pattern;
        let margin = pattern.margin();
        let texel = pattern.texel_bytes();
        let largest = texel.iter().copied().max().unwrap_or(4);
        let total: u64 = texel.iter().sum();
        let texels = (binding_limit / largest).min(TILE_BUDGET / total);
        let side = ((texels as f64).sqrt() as u32).min(MAX_TILE) / WORKGROUP * WORKGROUP;

        let (crop_w, crop_h) = (crop.d.w as u32, crop.d.h as u32);
        let inner_w = side.saturating_sub(2 * margin).min(crop_w);
        let inner_h = side.saturating_sub(2 * margin).min(crop_h);
        if inner_w < 16 || inner_h < 16 {
            return Err(anyhow!("GPU limits too small for demosaicing"));
        }
        let tile_texels = (inner_w + 2 * margin) as u64 * (inner_h + 2 * margin) as u64;

        let scratch: Vec<wgpu::Buffer> = texel
            .iter()
            .map(|bytes| {
                storage(
                    device,
                    "Demosaic Scratch",
                    tile_texels * bytes,
                    wgpu::BufferUsages::STORAGE,
                )
            })
            .collect();
        let cam = storage(
            device,
            "Demosaic Camera",
            crop_w as u64 * crop_h as u64 * 12,
            wgpu::BufferUsages::STORAGE,
        );

        let first_row = self.domain.p.y;
        let raw_rows =
            &self.data[first_row * self.stride..(first_row + self.domain.d.h) * self.stride];
        let raw_data: &[u8] = bytemuck::cast_slice(raw_rows);
        let raw_bytes = raw_data.len().div_ceil(4) * 4;
        let raw = storage(
            device,
            "Demosaic Raw",
            raw_bytes as u64,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        );
        let mut uploaded = 0;

        let base = self.params();
        for y0 in (0..crop_h).step_by(inner_h as usize) {
            let rows = inner_h.min(crop_h - y0);
            let top = (crop.p.y as u32 + y0) as i32 - margin as i32;
            let row_lo = (top - RAW_ROW_SLACK as i32).max(first_row as i32) as usize - first_row;
            let row_hi = ((top + (rows + 2 * margin) as i32) as usize + RAW_ROW_SLACK)
                .min(first_row + self.domain.d.h)
                - first_row;
            let start = row_lo * self.stride * 2 / alignment * alignment;
            let end = ((row_hi * self.stride * 2).div_ceil(4) * 4).min(raw_bytes);
            let raw_base = first_row * self.stride + start / 2;
            if end > uploaded {
                upload(
                    queue,
                    &raw,
                    uploaded,
                    &raw_data[uploaded..end.min(raw_data.len())],
                )?;
                uploaded = end;
            }
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Demosaic Encoder"),
            });
            let mut x0 = 0;
            while x0 < crop_w {
                let cols = inner_w.min(crop_w - x0);
                let tile = [cols + 2 * margin, rows + 2 * margin];
                let origin = [(crop.p.x as u32 + x0) as i32 - margin as i32, top];

                let params = Params {
                    tile: [origin[0], origin[1], tile[0] as i32, tile[1] as i32],
                    inner: [margin as i32, margin as i32, cols as i32, rows as i32],
                    strides: [
                        self.stride as u32,
                        raw_base as u32,
                        crop_w,
                        y0 * crop_w + x0,
                    ],
                    ..base
                };
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Demosaic Params"),
                    contents: bytemuck::bytes_of(&params),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let mut entries = vec![
                    whole(0, &uniform),
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &raw,
                            offset: start as u64,
                            size: NonZeroU64::new((end - start) as u64),
                        }),
                    },
                ];
                entries.extend(
                    scratch
                        .iter()
                        .enumerate()
                        .map(|(i, b)| whole(2 + i as u32, b)),
                );
                entries.push(whole(7, &cam));
                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Demosaic BG"),
                    layout: &kernels.bind_layout,
                    entries: &entries,
                });

                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_bind_group(0, &bind_group, &[]);
                for stage in pattern.stages() {
                    pass.set_pipeline(&kernels.pipelines[stage]);
                    pass.dispatch_workgroups(
                        tile[0].div_ceil(WORKGROUP),
                        tile[1].div_ceil(WORKGROUP),
                        1,
                    );
                }
                pass.set_pipeline(&kernels.pipelines[pattern.output()]);
                pass.dispatch_workgroups(cols.div_ceil(WORKGROUP), rows.div_ceil(WORKGROUP), 1);
                drop(pass);
                x0 += cols;
            }
            queue.submit(Some(encoder.finish()));
        }
        drop(scratch);
        let encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Develop Encoder"),
        });
        let developed = crate::develop::finish(context, encoder, &cam, crop_w, crop_h, finish);
        release((cam, raw));
        developed
    }
}
