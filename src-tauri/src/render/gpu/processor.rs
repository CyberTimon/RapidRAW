use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use half::f16;
use image::{ImageBuffer, Luma};

use wgpu::util::{DeviceExt, TextureDataOrder};

use crate::adjustments::lut_processing::Lut;
use crate::app::state::{AnalyticsConfig, AnalyticsJob, GpuImageEntry};
use crate::render::analytics::{AnalyticsFrame, AnalyticsPixels};
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::pipelines::{
    ALL_SHADER_FEATURES, GpuPipelines, HighPrecisionPipeline, high_precision_shader_source,
    shader_features,
};
use crate::render::uniforms::{AllAdjustments, MAX_MASKS, MaskAdjustments};

#[derive(Clone, Copy, Debug)]
pub struct Roi {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RenderOutputPrecision {
    #[default]
    EightBit,
    SixteenBit,
}

pub struct RenderRequest<'a> {
    pub adjustments: AllAdjustments,
    pub mask_bitmaps: &'a [ImageBuffer<Luma<u8>, Vec<u8>>],
    pub mask_cache_key: Option<u64>,
    pub lut: Option<Arc<Lut>>,
    pub roi: Option<Roi>,
    pub hsl_probe: bool,
    pub motion_blur: crate::effects::motion_blur::MotionBlurs,
}

fn read_texture_data_roi(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    origin: wgpu::Origin3d,
    size: wgpu::Extent3d,
    bytes_per_pixel: u32,
) -> Result<Vec<u8>, String> {
    let unpadded_bytes_per_row = bytes_per_pixel * size.width;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) & !(align - 1);
    let output_buffer_size = (padded_bytes_per_row * size.height) as u64;

    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Readback Buffer"),
        size: output_buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &output_buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(size.height),
            },
        },
        size,
    );

    queue.submit(Some(encoder.finish()));
    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_secs(60)),
        })
        .map_err(|e| format!("Failed while polling mapped GPU buffer: {}", e))?;
    let map_result = rx
        .recv()
        .map_err(|e| format!("Failed receiving GPU map result: {}", e))?;
    map_result.map_err(|e| e.to_string())?;

    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mapped = buffer_slice.get_mapped_range();
        let data = if padded_bytes_per_row == unpadded_bytes_per_row {
            mapped.to_vec()
        } else {
            let mut unpadded_data =
                Vec::with_capacity((unpadded_bytes_per_row * size.height) as usize);
            for chunk in mapped.chunks(padded_bytes_per_row as usize) {
                unpadded_data.extend_from_slice(&chunk[..unpadded_bytes_per_row as usize]);
            }
            unpadded_data
        };
        drop(mapped);
        output_buffer.unmap();
        data
    }))
    .map_err(|_| "GPU device was lost while reading back the image".to_string())
}

#[repr(C)]
#[derive(Debug, Copy, Clone, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurParams {
    radius: u32,
    tile_offset_x: u32,
    tile_offset_y: u32,
    input_width: u32,
    input_height: u32,
    _pad1: u32,
    _pad2: u32,
    _pad3: u32,
}

pub static NEXT_GPU_IMAGE_ID: AtomicU64 = AtomicU64::new(1);

const BLUR_H_GROUP_WIDTH: u32 = 256;
const BLUR_V_GROUP_SIZE: (u32, u32) = (8, 64);
const DIRECT_BLUR_MAX_RADIUS: u32 = 8;

const GF_SHORT_EDGE: u32 = 1080;
const GF_COARSE_DIV: u32 = 4;
const TB_FINE_DIV: u32 = 2;
const TB_FINE_RADIUS: f32 = 8.0;
const TB_FINE_RANGE: f32 = 0.3;
const TB_FINE_ITERATIONS: usize = 3;
const TB_BROAD_DIV: u32 = 8;
const TB_BROAD_RADIUS: f32 = 64.0;
const TB_CLIP_RADIUS: f32 = 48.0;
const GF_TONAL_RADIUS: f32 = 10.0;
const GF_TONAL_EPS: f32 = 0.25;
const HZ_DIV: u32 = 2;
const HZ_PATCH_RADIUS: f32 = 12.0;
const HZ_GF_RADIUS: f32 = 48.0;
const HZ_GF_EPS: f32 = 1.0e-3;

pub struct GuidedTextures {
    pub coeffs: wgpu::TextureView,
    pub tone_base: wgpu::TextureView,
    pub haze: wgpu::TextureView,
    pub airlight: wgpu::TextureView,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct GfParams {
    radius: u32,
    is_raw: u32,
    eps: f32,
    _pad: f32,
}

pub struct GpuProcessor {
    context: GpuContext,
    pipelines: Arc<GpuPipelines>,
    blur_params_buffer: wgpu::Buffer,
    light_cache: std::sync::Mutex<
        Option<(
            crate::effects::light::LightJob,
            Arc<crate::effects::light::LightMaps>,
        )>,
    >,

    high_precision_tile: std::sync::OnceLock<HighPrecisionTile>,
    tile_output_size: wgpu::Extent3d,
    adjustments_buffer: wgpu::Buffer,
    mask_cache: std::sync::Mutex<Option<MaskCache>>,
    motion_cache: std::sync::Mutex<Vec<(u64, Arc<MotionBlurred>)>>,
    motion_grain: std::sync::Mutex<Vec<(u64, f32)>>,
    lut_cache: std::sync::Mutex<Option<LutCache>>,
    ping_pong_view: wgpu::TextureView,
    sharpness_blur_view: wgpu::TextureView,
    tonal_blur_view: wgpu::TextureView,
    blur_sources: std::sync::Mutex<[Option<(u64, BlurParams)>; 2]>,

    pub tile_output_texture: wgpu::Texture,
    pub tile_output_texture_view: wgpu::TextureView,
    full_image_size: wgpu::Extent3d,
    display_textures: std::sync::OnceLock<DisplayTextures>,
    pub readback_pool: ReadbackPool,
}

type ReadbackPool = Arc<std::sync::Mutex<Vec<wgpu::Buffer>>>;

const READBACK_POOL_SIZE: usize = 3;

fn recycle_readback_buffer(pool: &ReadbackPool, buffer: wgpu::Buffer) {
    let mut pool = pool.lock().unwrap_or_else(|e| e.into_inner());
    if pool.len() >= READBACK_POOL_SIZE {
        pool.remove(0);
    }
    pool.push(buffer);
}

pub struct PooledReadback {
    view: Option<wgpu::BufferView>,
    buffer: wgpu::Buffer,
    pool: ReadbackPool,
}

impl std::ops::Deref for PooledReadback {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        self.view.as_deref().unwrap_or(&[])
    }
}

impl Drop for PooledReadback {
    fn drop(&mut self) {
        drop(self.view.take());
        self.buffer.unmap();
        recycle_readback_buffer(&self.pool, self.buffer.clone());
    }
}

pub struct AnalyticsReadback {
    pub device: Arc<wgpu::Device>,
    pub buffer: wgpu::Buffer,
    pub pool: ReadbackPool,
    pub submission: wgpu::SubmissionIndex,
    pub analytics: AnalyticsConfig,
    pub width: u32,
    pub height: u32,
    pub row_stride: usize,
}

pub fn analytics_readback_sender() -> &'static std::sync::mpsc::Sender<AnalyticsReadback> {
    static SENDER: std::sync::OnceLock<std::sync::mpsc::Sender<AnalyticsReadback>> =
        std::sync::OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<AnalyticsReadback>();
        std::thread::spawn(move || {
            while let Ok(mut readback) = rx.recv() {
                while let Ok(newer) = rx.try_recv() {
                    recycle_readback_buffer(&readback.pool, readback.buffer);
                    readback = newer;
                }
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    complete_analytics_readback(readback)
                }));
            }
        });
        tx
    })
}

fn complete_analytics_readback(readback: AnalyticsReadback) {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), wgpu::BufferAsyncError>>();
    readback
        .buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

    if let Err(e) = readback.device.poll(wgpu::PollType::Wait {
        submission_index: Some(readback.submission),
        timeout: Some(std::time::Duration::from_secs(60)),
    }) {
        log::error!("Async analytics readback poll failed: {}", e);
        return;
    }

    if let Ok(Ok(())) = rx.recv() {
        let analytics = readback.analytics;
        let _ = analytics.sender.send(AnalyticsJob {
            path: analytics.path,
            frame: AnalyticsFrame {
                data: AnalyticsPixels::Mapped(PooledReadback {
                    view: Some(readback.buffer.slice(..).get_mapped_range()),
                    buffer: readback.buffer,
                    pool: readback.pool,
                }),
                width: readback.width,
                height: readback.height,
                row_stride: readback.row_stride,
            },
            compute_waveform: analytics.compute_waveform,
            active_waveform_channel: analytics.active_waveform_channel,
        });
    }
}

struct HighPrecisionTile {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

struct MaskCache {
    width: u32,
    height: u32,
    layers: u32,
    key: u64,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

struct LutCache {
    lut: Arc<Lut>,
    view: wgpu::TextureView,
    sampler: wgpu::Sampler,
}

pub struct MotionBlurred {
    pub entry: GpuImageEntry,
    pub mask_view: Option<wgpu::TextureView>,
}

pub enum RenderedPixels {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

pub const GPU_IMAGE_CACHE_ENTRIES: usize = 3;
pub const GPU_IMAGE_CACHE_PIXELS: u64 = 50_000_000;
pub const GPU_SOURCE_CACHE_ENTRIES: usize = 2;

impl GpuProcessor {
    pub fn new(context: GpuContext, max_width: u32, max_height: u32) -> Result<Self, String> {
        let device = &context.device;
        let pipelines = Arc::clone(
            context
                .pipelines
                .get_or_init(|| Arc::new(GpuPipelines::new(device))),
        );

        let blur_params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Blur Params Buffer"),
            size: std::mem::size_of::<BlurParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let adjustments_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Adjustments Buffer"),
            size: std::mem::size_of::<AllAdjustments>() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        const TILE_SIZE: u32 = 2048;
        const TILE_OVERLAP: u32 = 128;

        let clamped_tile_width = max_width.min(TILE_SIZE + TILE_OVERLAP * 2);
        let clamped_tile_height = max_height.min(TILE_SIZE + TILE_OVERLAP * 2);

        let clamped_tile_size = wgpu::Extent3d {
            width: clamped_tile_width,
            height: clamped_tile_height,
            depth_or_array_layers: 1,
        };

        let full_image_size = wgpu::Extent3d {
            width: max_width,
            height: max_height,
            depth_or_array_layers: 1,
        };

        let reusable_texture_desc = wgpu::TextureDescriptor {
            label: None,
            size: clamped_tile_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        };

        let ping_pong_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Ping Pong Texture"),
            ..reusable_texture_desc
        });
        let ping_pong_view = ping_pong_texture.create_view(&Default::default());

        let sharpness_blur_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Sharpness Blur Texture"),
            ..reusable_texture_desc
        });
        let sharpness_blur_view = sharpness_blur_texture.create_view(&Default::default());

        let tonal_blur_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Tonal Blur Texture"),
            ..reusable_texture_desc
        });
        let tonal_blur_view = tonal_blur_texture.create_view(&Default::default());

        let tile_output_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Tile Output Texture"),
            size: clamped_tile_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let tile_output_texture_view = tile_output_texture.create_view(&Default::default());

        Ok(Self {
            context,
            pipelines,
            blur_params_buffer,
            light_cache: std::sync::Mutex::new(None),
            high_precision_tile: std::sync::OnceLock::new(),
            tile_output_size: clamped_tile_size,
            adjustments_buffer,
            mask_cache: std::sync::Mutex::new(None),
            motion_cache: std::sync::Mutex::new(Vec::new()),
            motion_grain: std::sync::Mutex::new(Vec::new()),
            lut_cache: std::sync::Mutex::new(None),
            ping_pong_view,
            sharpness_blur_view,
            tonal_blur_view,
            blur_sources: std::sync::Mutex::new([None; 2]),
            tile_output_texture,
            tile_output_texture_view,
            full_image_size,
            display_textures: std::sync::OnceLock::new(),
            readback_pool: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }

    pub fn build_guided_coeffs(
        &self,
        input_view: &wgpu::TextureView,
        width: u32,
        height: u32,
        is_raw: u32,
    ) -> GuidedTextures {
        let device = &self.context.device;
        let queue = &self.context.queue;

        let short = width.min(height).max(1);
        let k = (GF_SHORT_EDGE as f32 / short as f32).min(1.0);
        let lw = ((width as f32 * k).round() as u32).max(1);
        let lh = ((height as f32 * k).round() as u32).max(1);
        let low_short = lw.min(lh) as f32;
        let hw = lw.div_ceil(HZ_DIV).max(1);
        let hh = lh.div_ceil(HZ_DIV).max(1);
        let hcw = hw.div_ceil(GF_COARSE_DIV).max(1);
        let hch = hh.div_ceil(GF_COARSE_DIV).max(1);

        let make_view = |label: &'static str, w: u32, h: u32| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d {
                        width: w,
                        height: h,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba32Float,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::STORAGE_BINDING,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };

        let make_params = |base_radius: f32, eps: f32, div: f32| {
            let radius = (base_radius * low_short / 1080.0 / div).ceil().max(1.0) as u32;
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Guided Filter Params"),
                contents: bytemuck::bytes_of(&GfParams {
                    radius,
                    is_raw,
                    eps,
                    _pad: 0.0,
                }),
                usage: wgpu::BufferUsages::UNIFORM,
            })
        };

        let moments = make_view("GF Moments", lw, lh);
        let tmp = make_view("GF Ping Pong", lw, lh);
        let blurred = make_view("GF Blurred", lw, lh);
        let ab = make_view("GF Coeffs", lw, lh);
        let tw = lw.div_ceil(TB_FINE_DIV).max(1);
        let th = lh.div_ceil(TB_FINE_DIV).max(1);
        let bw = lw.div_ceil(TB_BROAD_DIV).max(1);
        let bh = lh.div_ceil(TB_BROAD_DIV).max(1);
        let tb_luma = make_view("Tone Base Luma", tw, th);
        let mut tb_ping = make_view("Tone Base Ping", tw, th);
        let mut tb_pong = make_view("Tone Base Pong", tw, th);
        let tb_coarse = make_view("Tone Base Coarse", bw, bh);
        let tb_wide = make_view("Tone Base Wide", bw, bh);
        let tb_fit = make_view("Tone Base Fit", bw, bh);
        let hz_a = make_view("Haze Ping", hw, hh);
        let hz_b = make_view("Haze Pong", hw, hh);
        let hz_coarse = make_view("Haze Coarse", hcw, hch);
        let haze = make_view("Haze Coeffs", hw, hh);
        let airlight = make_view("Haze Airlight", 3, 1);

        let params_tonal = make_params(GF_TONAL_RADIUS, GF_TONAL_EPS, 1.0);
        let params_tb_fine = make_params(TB_FINE_RADIUS, TB_FINE_RANGE, TB_FINE_DIV as f32);
        let params_tb_broad = make_params(TB_BROAD_RADIUS, 0.0, TB_BROAD_DIV as f32);
        let params_tb_clip = make_params(TB_CLIP_RADIUS, 0.0, TB_BROAD_DIV as f32);
        let params_hz_patch = make_params(HZ_PATCH_RADIUS, HZ_GF_EPS, HZ_DIV as f32);
        let params_hz_gf = make_params(HZ_GF_RADIUS, HZ_GF_EPS, HZ_DIV as f32);

        let mut encoder = device.create_command_encoder(&Default::default());

        let mut pass = |pipeline: &wgpu::ComputePipeline,
                        src_a: &wgpu::TextureView,
                        src_b: &wgpu::TextureView,
                        dst: &wgpu::TextureView,
                        params: &wgpu::Buffer,
                        (w, h): (u32, u32)| {
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Guided Filter BG"),
                layout: &self.pipelines.gf_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(src_a),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(src_b),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(dst),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: params.as_entire_binding(),
                    },
                ],
            });
            let mut cpass = encoder.begin_compute_pass(&Default::default());
            cpass.set_pipeline(pipeline);
            cpass.set_bind_group(0, &bind_group, &[]);
            cpass.dispatch_workgroups(w.div_ceil(8), h.div_ceil(8), 1);
        };
        let fine = (lw, lh);
        let half = (hw, hh);

        pass(
            &self.pipelines.gf_downsample_pipeline,
            input_view,
            input_view,
            &moments,
            &params_tonal,
            fine,
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &moments,
            &moments,
            &tmp,
            &params_tonal,
            fine,
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &tmp,
            &tmp,
            &blurred,
            &params_tonal,
            fine,
        );
        pass(
            &self.pipelines.gf_coeffs_pipeline,
            &blurred,
            &blurred,
            &ab,
            &params_tonal,
            fine,
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &ab,
            &ab,
            &tmp,
            &params_tonal,
            fine,
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &tmp,
            &tmp,
            &blurred,
            &params_tonal,
            fine,
        );

        pass(
            &self.pipelines.hz_downsample_pipeline,
            input_view,
            input_view,
            &hz_a,
            &params_hz_patch,
            half,
        );
        pass(
            &self.pipelines.gf_box_down_pipeline,
            &hz_a,
            &hz_a,
            &hz_coarse,
            &params_hz_patch,
            (hcw, hch),
        );
        pass(
            &self.pipelines.hz_airlight_pipeline,
            &hz_coarse,
            &hz_coarse,
            &airlight,
            &params_hz_patch,
            (1, 1),
        );
        pass(
            &self.pipelines.hz_min_h_pipeline,
            &hz_a,
            &airlight,
            &hz_b,
            &params_hz_patch,
            half,
        );
        pass(
            &self.pipelines.hz_min_v_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_patch,
            half,
        );
        pass(
            &self.pipelines.hz_max_h_pipeline,
            &hz_a,
            &hz_a,
            &hz_b,
            &params_hz_patch,
            half,
        );
        pass(
            &self.pipelines.hz_max_v_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_patch,
            half,
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &hz_a,
            &hz_a,
            &hz_b,
            &params_hz_gf,
            half,
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_gf,
            half,
        );
        pass(
            &self.pipelines.hz_coeffs_pipeline,
            &hz_a,
            &hz_a,
            &hz_b,
            &params_hz_gf,
            half,
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_gf,
            half,
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &hz_a,
            &hz_a,
            &haze,
            &params_hz_gf,
            half,
        );

        pass(
            &self.pipelines.gf_box_down_pipeline,
            &moments,
            &moments,
            &tb_luma,
            &params_tb_fine,
            (tw, th),
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &tb_luma,
            &tb_luma,
            &tb_ping,
            &params_tb_fine,
            (tw, th),
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &tb_ping,
            &tb_ping,
            &tb_pong,
            &params_tb_fine,
            (tw, th),
        );
        for _ in 0..TB_FINE_ITERATIONS {
            pass(
                &self.pipelines.tb_bilateral_pipeline,
                &tb_luma,
                &tb_pong,
                &tb_ping,
                &params_tb_fine,
                (tw, th),
            );
            std::mem::swap(&mut tb_ping, &mut tb_pong);
        }
        pass(
            &self.pipelines.tb_refine_pipeline,
            &tb_pong,
            &moments,
            &tmp,
            &params_tb_fine,
            fine,
        );
        pass(
            &self.pipelines.tb_decimate_pipeline,
            &tmp,
            &tmp,
            &tb_coarse,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_box_down_pipeline,
            &tmp,
            &tmp,
            &tb_wide,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &tb_wide,
            &tb_wide,
            &tb_fit,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &tb_fit,
            &tb_fit,
            &tb_wide,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.tb_fit_pipeline,
            &tb_wide,
            &tb_wide,
            &tb_fit,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &tb_fit,
            &tb_fit,
            &tb_wide,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &tb_wide,
            &tb_wide,
            &tb_fit,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.tb_merge_pipeline,
            &tb_fit,
            &tb_coarse,
            &tb_wide,
            &params_tb_broad,
            (bw, bh),
        );
        pass(
            &self.pipelines.tb_pack_pipeline,
            &tb_wide,
            &tmp,
            &ab,
            &params_tb_broad,
            fine,
        );
        pass(
            &self.pipelines.tb_tone_pipeline,
            &tb_fit,
            &ab,
            &tmp,
            &params_tb_broad,
            fine,
        );
        pass(
            &self.pipelines.tb_peak_pipeline,
            &tb_coarse,
            &tb_coarse,
            &airlight,
            &params_tb_broad,
            (1, 1),
        );
        pass(
            &self.pipelines.tb_clip_pipeline,
            &tb_coarse,
            &airlight,
            &tb_wide,
            &params_tb_clip,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_blur_h_pipeline,
            &tb_wide,
            &tb_wide,
            &tb_fit,
            &params_tb_clip,
            (bw, bh),
        );
        pass(
            &self.pipelines.gf_blur_v_pipeline,
            &tb_fit,
            &tb_fit,
            &tb_wide,
            &params_tb_clip,
            (bw, bh),
        );
        pass(
            &self.pipelines.tb_stamp_pipeline,
            &tmp,
            &tb_wide,
            &moments,
            &params_tb_broad,
            fine,
        );

        queue.submit(Some(encoder.finish()));
        GuidedTextures {
            coeffs: blurred,
            tone_base: moments,
            haze,
            airlight,
        }
    }

    pub fn mask_view(
        &self,
        mask_bitmaps: &[ImageBuffer<Luma<u8>, Vec<u8>>],
        width: u32,
        height: u32,
        cache_key: Option<u64>,
    ) -> wgpu::TextureView {
        if mask_bitmaps.is_empty() {
            return self.pipelines.dummy_mask_view.clone();
        }

        let device = &self.context.device;
        let queue = &self.context.queue;
        let layers = mask_bitmaps.len().clamp(2, MAX_MASKS) as u32;
        let buffer_size = (width as usize) * (height as usize) * (layers as usize);

        let mut cache = self.mask_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let (Some(c), Some(key)) = (cache.as_ref(), cache_key)
            && c.width == width
            && c.height == height
            && c.layers == layers
            && c.key == key
        {
            return c.view.clone();
        }

        let mut data = Vec::with_capacity(buffer_size);
        for mask_bitmap in mask_bitmaps.iter().take(MAX_MASKS) {
            data.extend_from_slice(mask_bitmap.as_raw());
        }
        data.resize(buffer_size, 0);

        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: layers,
        };
        let reusable = cache_key.and_then(|_| {
            cache
                .take()
                .filter(|c| c.width == width && c.height == height && c.layers == layers)
        });
        let texture = match reusable {
            Some(c) => {
                queue.write_texture(
                    c.texture.as_image_copy(),
                    &data,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width),
                        rows_per_image: Some(height),
                    },
                    size,
                );
                c.texture
            }
            None => device.create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some("Full Mask Texture Array"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                },
                TextureDataOrder::MipMajor,
                &data,
            ),
        };
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        if let Some(key) = cache_key {
            *cache = Some(MaskCache {
                width,
                height,
                layers,
                key,
                texture,
                view: view.clone(),
            });
        }
        view
    }

    pub fn motion_blurred(
        &self,
        input: &GpuImageEntry,
        request: &RenderRequest,
        mask_view: &wgpu::TextureView,
    ) -> Result<Option<Arc<MotionBlurred>>, String> {
        let mut cache = self.motion_cache.lock().unwrap_or_else(|e| e.into_inner());
        let motion = &request.motion_blur;
        if motion.blurs.is_empty() {
            if request.mask_cache_key.is_some() {
                cache.clear();
            }
            return Ok(None);
        }

        let key = request.mask_cache_key.map(|mask_key| {
            crate::effects::motion_blur::cache_key(
                input.id,
                mask_key,
                motion.depth.as_deref(),
                &motion.blurs,
            )
        });
        if let Some((_, blurred)) = key.and_then(|key| cache.iter().find(|(k, _)| *k == key)) {
            return Ok(Some(Arc::clone(blurred)));
        }

        let grain = {
            let mut grains = self.motion_grain.lock().unwrap_or_else(|e| e.into_inner());
            match grains.iter().find(|(id, _)| *id == input.id) {
                Some((_, grain)) => *grain,
                None => {
                    let grain = crate::effects::motion_blur::estimate_grain(
                        &self.context,
                        &input.texture_view,
                        (input.width, input.height),
                        input.is_raw == 1,
                    )
                    .unwrap_or_else(|error| {
                        log::warn!("Motion blur grain estimate failed: {}", error);
                        0.0
                    });
                    if grains.len() >= GPU_IMAGE_CACHE_ENTRIES {
                        grains.remove(0);
                    }
                    grains.push((input.id, grain));
                    grain
                }
            }
        };
        let pipelines = self.pipelines.motion_blur.get_or_init(|| {
            crate::effects::motion_blur::MotionBlurPipelines::new(&self.context.device)
        });
        let depth = motion.depth.as_deref().map(|map| {
            (
                pipelines.upload_depth(&self.context.device, &self.context.queue, map),
                map,
            )
        });

        let Some(output) = crate::effects::motion_blur::render(
            &self.context,
            pipelines,
            &input.texture_view,
            (input.width, input.height),
            input.is_raw,
            grain,
            &motion.blurs,
            request.mask_bitmaps,
            mask_view,
            depth.as_ref().map(|(view, map)| (view, *map)),
        )?
        else {
            return Ok(None);
        };
        let guided =
            self.build_guided_coeffs(&output.view, input.width, input.height, input.is_raw);
        let blurred = Arc::new(MotionBlurred {
            entry: GpuImageEntry {
                id: NEXT_GPU_IMAGE_ID.fetch_add(1, Ordering::Relaxed),
                texture: output.texture,
                texture_view: output.view,
                gf_coeffs_view: guided.coeffs,
                tone_base_view: guided.tone_base,
                haze_view: guided.haze,
                airlight_view: guided.airlight,
                is_raw: input.is_raw,
                width: input.width,
                height: input.height,
                transform_key: input.transform_key,
                source_identity: input.source_identity,
            },
            mask_view: output.mask_view,
        });
        if let Some(key) = key {
            if cache.len() >= GPU_IMAGE_CACHE_ENTRIES {
                cache.remove(0);
            }
            cache.push((key, Arc::clone(&blurred)));
        }
        Ok(Some(blurred))
    }

    fn lut_view(&self, lut: &Arc<Lut>) -> (wgpu::TextureView, wgpu::Sampler) {
        let mut cache = self.lut_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = cache.as_ref()
            && Arc::ptr_eq(&c.lut, lut)
        {
            return (c.view.clone(), c.sampler.clone());
        }

        let device = &self.context.device;
        let queue = &self.context.queue;
        let size = lut.size;
        let mut rgba_lut_data_f16 = Vec::with_capacity(lut.data.len() / 3 * 4);
        for chunk in lut.data.as_chunks::<3>().0 {
            rgba_lut_data_f16.push(f16::from_f32(chunk[0]));
            rgba_lut_data_f16.push(f16::from_f32(chunk[1]));
            rgba_lut_data_f16.push(f16::from_f32(chunk[2]));
            rgba_lut_data_f16.push(f16::ONE);
        }
        let lut_texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("LUT 3D Texture"),
                size: wgpu::Extent3d {
                    width: size,
                    height: size,
                    depth_or_array_layers: size,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D3,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            TextureDataOrder::MipMajor,
            bytemuck::cast_slice(&rgba_lut_data_f16),
        );
        let view = lut_texture.create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        *cache = Some(LutCache {
            lut: Arc::clone(lut),
            view: view.clone(),
            sampler: sampler.clone(),
        });
        (view, sampler)
    }

    fn main_pipeline_for(&self, high_precision: bool, features: u32) -> wgpu::ComputePipeline {
        let (generic, shader, layout) = if high_precision {
            let hp = self.high_precision_pipeline();
            (&hp.pipeline, &hp.shader, &hp.layout)
        } else {
            (
                &self.pipelines.main_pipeline,
                &self.pipelines.main_shader_module,
                &self.pipelines.main_pipeline_layout,
            )
        };
        if features == ALL_SHADER_FEATURES {
            return generic.clone();
        }

        let key = (high_precision, features);
        let mut pipelines = self
            .pipelines
            .specialized_pipelines
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match pipelines.get(&key) {
            Some(Some(pipeline)) => return pipeline.clone(),
            Some(None) => return generic.clone(),
            None => {}
        }
        pipelines.insert(key, None);
        drop(pipelines);

        let device = self.context.device.clone();
        let shader = shader.clone();
        let layout = layout.clone();
        let specialized_pipelines = Arc::clone(&self.pipelines.specialized_pipelines);
        std::thread::spawn(move || {
            let mut constants = vec![("FEATURES", features as f64)];
            if high_precision {
                constants.push(("HIGH_PRECISION_OUTPUT", 1.0));
            }
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Specialized Compute Pipeline"),
                layout: Some(&layout),
                module: &shader,
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &constants,
                    ..Default::default()
                },
                cache: None,
            });
            specialized_pipelines
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, Some(pipeline));
        });
        generic.clone()
    }

    pub fn readback_buffer(&self, size: u64) -> wgpu::Buffer {
        let pooled = {
            let mut pool = self.readback_pool.lock().unwrap_or_else(|e| e.into_inner());
            pool.iter()
                .position(|buffer| buffer.size() == size)
                .map(|index| pool.swap_remove(index))
        };
        pooled.unwrap_or_else(|| {
            self.context.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Async Analytics Readback Buffer"),
                size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        })
    }

    pub fn display_textures(&self) -> &DisplayTextures {
        self.display_textures.get_or_init(|| {
            let descriptor = |label| wgpu::TextureDescriptor {
                label: Some(label),
                size: self.full_image_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            };
            let device = &self.context.device;
            let working_texture = device.create_texture(&descriptor("Working Output Texture"));
            let output_texture = device.create_texture(&descriptor("Full Output Texture"));
            let output_texture_view = output_texture.create_view(&Default::default());
            DisplayTextures {
                working_texture,
                output_texture,
                output_texture_view,
            }
        })
    }

    fn high_precision_pipeline(&self) -> &HighPrecisionPipeline {
        self.pipelines.high_precision_pipeline.get_or_init(|| {
            let device = &self.context.device;
            let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("High Precision Main BGL"),
                entries: &self.pipelines.high_precision_entries,
            });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("High Precision Pipeline Layout"),
                bind_group_layouts: &[Some(&bgl)],
                immediate_size: 0,
            });
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("High Precision Image Processing Shader"),
                source: wgpu::ShaderSource::Wgsl(high_precision_shader_source().into()),
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("High Precision Compute Pipeline"),
                layout: Some(&layout),
                module: &shader,
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[("HIGH_PRECISION_OUTPUT", 1.0)],
                    ..Default::default()
                },
                cache: None,
            });
            HighPrecisionPipeline {
                bgl,
                pipeline,
                shader,
                layout,
            }
        })
    }

    fn hsl_probe_pipeline(&self) -> &wgpu::ComputePipeline {
        self.pipelines.hsl_probe_pipeline.get_or_init(|| {
            self.context
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("HSL Probe Pipeline"),
                    layout: Some(&self.pipelines.main_pipeline_layout),
                    module: &self.pipelines.main_shader_module,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: &[("HSL_PROBE", 1.0)],
                        ..Default::default()
                    },
                    cache: None,
                })
        })
    }

    fn high_precision_tile(&self) -> &HighPrecisionTile {
        self.high_precision_tile.get_or_init(|| {
            let texture = self
                .context
                .device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("High Precision Tile Output Texture"),
                    size: self.tile_output_size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba16Float,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::STORAGE_BINDING
                        | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
            let view = texture.create_view(&Default::default());
            HighPrecisionTile { texture, view }
        })
    }

    fn light_maps(
        &self,
        input: &GpuImageEntry,
        job: crate::effects::light::LightJob,
    ) -> Result<Arc<crate::effects::light::LightMaps>, String> {
        let mut cache = self.light_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((key, maps)) = cache.as_ref()
            && *key == job
        {
            return Ok(Arc::clone(maps));
        }
        *cache = None;
        let maps = Arc::new(crate::effects::light::render(
            &self.context,
            &input.texture_view,
            (input.width, input.height),
            &job,
        )?);
        *cache = Some((job, Arc::clone(&maps)));
        Ok(maps)
    }

    pub fn run(
        &self,
        input: &GpuImageEntry,
        mask_texture_view: &wgpu::TextureView,
        request: RenderRequest,
        output_to_display: bool,
        output_precision: RenderOutputPrecision,
    ) -> Result<(RenderedPixels, u32, u32, u32, u32), String> {
        let input_texture_view = &input.texture_view;
        let gf_coeffs_view = &input.gf_coeffs_view;
        let tone_base_view = &input.tone_base_view;
        let haze_view = &input.haze_view;
        let airlight_view = &input.airlight_view;
        let (width, height) = (input.width, input.height);
        let device = &self.context.device;
        let queue = &self.context.queue;
        let scale = (width.min(height) as f32) / 1080.0;
        const MAX_MASK_BINDINGS: u32 = 1;

        if output_precision == RenderOutputPrecision::SixteenBit && output_to_display {
            return Err(
                "High-precision GPU output is only supported for CPU-readback renders.".to_string(),
            );
        }

        let high_precision_tile = if output_precision == RenderOutputPrecision::SixteenBit {
            Some(self.high_precision_tile())
        } else {
            None
        };
        let output_pipeline = if request.hsl_probe {
            self.hsl_probe_pipeline().clone()
        } else {
            self.main_pipeline_for(
                high_precision_tile.is_some(),
                shader_features(&request.adjustments),
            )
        };
        let (output_bgl, output_tile_texture, output_tile_view, bytes_per_pixel) =
            if let Some(high_precision_tile) = high_precision_tile {
                let hp = self.high_precision_pipeline();
                (
                    &hp.bgl,
                    &high_precision_tile.texture,
                    &high_precision_tile.view,
                    8,
                )
            } else {
                (
                    &self.pipelines.main_bgl,
                    &self.tile_output_texture,
                    &self.tile_output_texture_view,
                    4,
                )
            };

        let bounds = request.roi.unwrap_or(Roi {
            x: 0,
            y: 0,
            width,
            height,
        });
        let out_width = bounds.width;
        let out_height = bounds.height;
        let (lut_texture_view, lut_sampler) = match &request.lut {
            Some(lut) => self.lut_view(lut),
            None => (
                self.pipelines.dummy_lut_view.clone(),
                self.pipelines.dummy_lut_sampler.clone(),
            ),
        };

        let adjustments = request.adjustments;
        let light = match crate::effects::light::LightJob::new(input.id, &adjustments) {
            Some(job) => Some(self.light_maps(input, job)?),
            None => None,
        };
        let light_view = |pick: fn(
            &crate::effects::light::LightMaps,
        ) -> Option<&crate::render::gpu::compute::Slot>| {
            light
                .as_deref()
                .and_then(pick)
                .map_or(&self.pipelines.dummy_blur_view, |slot| &slot.view)
        };

        const TILE_SIZE: u32 = 2048;
        const TILE_OVERLAP: u32 = 128;

        let output_len = if output_to_display {
            0
        } else {
            (out_width * out_height * 4) as usize
        };
        let mut final_pixels = match output_precision {
            RenderOutputPrecision::EightBit => RenderedPixels::U8(vec![0u8; output_len]),
            RenderOutputPrecision::SixteenBit => RenderedPixels::U16(vec![0u16; output_len]),
        };

        let start_tile_x = bounds.x / TILE_SIZE;
        let start_tile_y = bounds.y / TILE_SIZE;
        let end_tile_x = (bounds.x + bounds.width).div_ceil(TILE_SIZE);
        let end_tile_y = (bounds.y + bounds.height).div_ceil(TILE_SIZE);

        for tile_y in start_tile_y..end_tile_y {
            for tile_x in start_tile_x..end_tile_x {
                let x_start_unclamped = tile_x * TILE_SIZE;
                let y_start_unclamped = tile_y * TILE_SIZE;

                let x_start = x_start_unclamped.max(bounds.x);
                let y_start = y_start_unclamped.max(bounds.y);
                let x_end = (x_start_unclamped + TILE_SIZE)
                    .min(bounds.x + bounds.width)
                    .min(width);
                let y_end = (y_start_unclamped + TILE_SIZE)
                    .min(bounds.y + bounds.height)
                    .min(height);

                let tile_width = x_end - x_start;
                let tile_height = y_end - y_start;

                let input_x_start = (x_start as i32 - TILE_OVERLAP as i32).max(0) as u32;
                let input_y_start = (y_start as i32 - TILE_OVERLAP as i32).max(0) as u32;
                let input_x_end = (x_end + TILE_OVERLAP).min(width);
                let input_y_end = (y_end + TILE_OVERLAP).min(height);
                let input_width = input_x_end - input_x_start;
                let input_height = input_y_end - input_y_start;

                let run_blur = |slot: usize,
                                base_radius: f32,
                                output_view: &wgpu::TextureView|
                 -> bool {
                    let radius = (base_radius * scale).ceil().max(1.0) as u32;
                    if radius == 0 {
                        return false;
                    }

                    let params = BlurParams {
                        radius,
                        tile_offset_x: input_x_start,
                        tile_offset_y: input_y_start,
                        input_width,
                        input_height,
                        _pad1: 0,
                        _pad2: 0,
                        _pad3: 0,
                    };

                    let source = Some((input.id, params));
                    if self.blur_sources.lock().unwrap_or_else(|e| e.into_inner())[slot] == source {
                        return true;
                    }

                    queue.write_buffer(&self.blur_params_buffer, 0, bytemuck::bytes_of(&params));

                    let mut blur_encoder = device.create_command_encoder(&Default::default());

                    let h_blur_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("H-Blur BG"),
                        layout: &self.pipelines.blur_bgl,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(input_texture_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::TextureView(&self.ping_pong_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: self.blur_params_buffer.as_entire_binding(),
                            },
                        ],
                    });

                    let direct = radius <= DIRECT_BLUR_MAX_RADIUS;

                    {
                        let mut cpass = blur_encoder.begin_compute_pass(&Default::default());
                        cpass.set_pipeline(if direct {
                            &self.pipelines.h_blur_direct_pipeline
                        } else {
                            &self.pipelines.h_blur_pipeline
                        });
                        cpass.set_bind_group(0, &h_blur_bg, &[]);
                        cpass.dispatch_workgroups(
                            input_width.div_ceil(BLUR_H_GROUP_WIDTH),
                            input_height,
                            1,
                        );
                    }

                    let v_blur_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("V-Blur BG"),
                        layout: &self.pipelines.blur_bgl,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&self.ping_pong_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::TextureView(output_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: self.blur_params_buffer.as_entire_binding(),
                            },
                        ],
                    });

                    {
                        let mut cpass = blur_encoder.begin_compute_pass(&Default::default());
                        cpass.set_bind_group(0, &v_blur_bg, &[]);
                        if direct {
                            cpass.set_pipeline(&self.pipelines.v_blur_direct_pipeline);
                            cpass.dispatch_workgroups(input_width, input_height.div_ceil(256), 1);
                        } else {
                            cpass.set_pipeline(&self.pipelines.v_blur_pipeline);
                            cpass.dispatch_workgroups(
                                input_width.div_ceil(BLUR_V_GROUP_SIZE.0),
                                input_height.div_ceil(BLUR_V_GROUP_SIZE.1),
                                1,
                            );
                        }
                    }

                    queue.submit(Some(blur_encoder.finish()));
                    self.blur_sources.lock().unwrap_or_else(|e| e.into_inner())[slot] = source;
                    true
                };

                let active_masks = adjustments
                    .mask_adjustments
                    .iter()
                    .take(adjustments.mask_count as usize);
                let any_term =
                    |global: f32, pick: &dyn Fn(&MaskAdjustments) -> f32, positive: bool| {
                        let hit = |v: f32| if positive { v > 0.0 } else { v != 0.0 };
                        hit(global) || active_masks.clone().any(|m| hit(pick(m)))
                    };
                let need_sharpen = any_term(adjustments.global.sharpness, &|m| m.sharpness, false);

                let need_grain_softness = adjustments.global.grain_softness > 0.0;
                let did_create_sharpness_blur = (need_sharpen || need_grain_softness)
                    && run_blur(0, 1.0, &self.sharpness_blur_view);
                let did_create_tonal_blur = need_sharpen && run_blur(1, 3.5, &self.tonal_blur_view);

                let mut main_encoder = device.create_command_encoder(&Default::default());

                let mut tile_adjustments = adjustments;
                tile_adjustments.tile_offset_x = input_x_start;
                tile_adjustments.tile_offset_y = input_y_start;
                queue.write_buffer(
                    &self.adjustments_buffer,
                    0,
                    bytemuck::bytes_of(&tile_adjustments),
                );

                let mut bind_group_entries = vec![
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(input_texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(output_tile_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: self.adjustments_buffer.as_entire_binding(),
                    },
                ];
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(mask_texture_view),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 3 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(&lut_texture_view),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 4 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::Sampler(&lut_sampler),
                });

                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 5 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(if did_create_sharpness_blur {
                        &self.sharpness_blur_view
                    } else {
                        &self.pipelines.dummy_blur_view
                    }),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 6 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(if did_create_tonal_blur {
                        &self.tonal_blur_view
                    } else {
                        &self.pipelines.dummy_blur_view
                    }),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 8 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(light_view(|maps| {
                        maps.bloom.as_ref()
                    })),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 9 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(light_view(|maps| {
                        maps.flare.as_ref()
                    })),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 10 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::Sampler(&self.pipelines.light_sampler),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 11 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(gf_coeffs_view),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 12 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(tone_base_view),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 13 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(haze_view),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 14 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(airlight_view),
                });

                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Tile Bind Group"),
                    layout: output_bgl,
                    entries: &bind_group_entries,
                });

                {
                    let mut compute_pass = main_encoder.begin_compute_pass(&Default::default());
                    compute_pass.set_pipeline(&output_pipeline);
                    compute_pass.set_bind_group(0, &bind_group, &[]);
                    compute_pass.dispatch_workgroups(
                        input_width.div_ceil(8),
                        input_height.div_ceil(8),
                        1,
                    );
                }

                let crop_x_start = x_start - input_x_start;
                let crop_y_start = y_start - input_y_start;

                if output_to_display {
                    main_encoder.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.tile_output_texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d {
                                x: crop_x_start,
                                y: crop_y_start,
                                z: 0,
                            },
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.display_textures().working_texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d {
                                x: x_start,
                                y: y_start,
                                z: 0,
                            },
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::Extent3d {
                            width: tile_width,
                            height: tile_height,
                            depth_or_array_layers: 1,
                        },
                    );
                }

                queue.submit(Some(main_encoder.finish()));

                if !output_to_display {
                    let processed_tile_data = read_texture_data_roi(
                        device,
                        queue,
                        output_tile_texture,
                        wgpu::Origin3d {
                            x: crop_x_start,
                            y: crop_y_start,
                            z: 0,
                        },
                        wgpu::Extent3d {
                            width: tile_width,
                            height: tile_height,
                            depth_or_array_layers: 1,
                        },
                        bytes_per_pixel,
                    )?;

                    match &mut final_pixels {
                        RenderedPixels::U8(final_pixels) => {
                            for row in 0..tile_height {
                                let final_y = y_start + row - bounds.y;
                                let final_x = x_start - bounds.x;
                                let final_row_offset = (final_y * out_width + final_x) as usize * 4;
                                let source_row_offset = (row * tile_width) as usize * 4;
                                let copy_bytes = (tile_width * 4) as usize;

                                final_pixels[final_row_offset..final_row_offset + copy_bytes]
                                    .copy_from_slice(
                                        &processed_tile_data
                                            [source_row_offset..source_row_offset + copy_bytes],
                                    );
                            }
                        }
                        RenderedPixels::U16(final_pixels) => {
                            for row in 0..tile_height {
                                let final_y = y_start + row - bounds.y;
                                let final_x = x_start - bounds.x;
                                let final_row_offset = (final_y * out_width + final_x) as usize * 4;
                                let source_pixel_offset = (row * tile_width) as usize;

                                for sample in 0..(tile_width as usize * 4) {
                                    let source_byte_offset = (source_pixel_offset * 4 + sample) * 2;
                                    final_pixels[final_row_offset + sample] = u16::from_ne_bytes([
                                        processed_tile_data[source_byte_offset],
                                        processed_tile_data[source_byte_offset + 1],
                                    ]);
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok((final_pixels, out_width, out_height, bounds.x, bounds.y))
    }
}

pub struct DisplayTextures {
    pub working_texture: wgpu::Texture,
    pub output_texture: wgpu::Texture,
    pub output_texture_view: wgpu::TextureView,
}
