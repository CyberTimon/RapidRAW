use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use half::f16;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, Rgba};
use std::num::NonZero;

#[cfg(not(any(target_os = "android", target_os = "linux")))]
use tauri::Manager;
use wgpu::util::{DeviceExt, TextureDataOrder};

use crate::image_processing::{
    AllAdjustments, AnalyticsFrame, AnalyticsPixels, GpuContext, MAX_MASKS, MaskAdjustments,
};
use crate::lut_processing::Lut;
use crate::{AppState, GpuImageCache, GpuImageEntry};

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
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DisplayTransform {
    pub rect: [f32; 4],
    pub clip: [f32; 4],
    pub window: [f32; 2],
    pub image_size: [f32; 2],
    pub texture_size: [f32; 2],
    pub pixelated: f32,
    pub _pad: f32,
    pub bg_primary: [f32; 4],
    pub bg_secondary: [f32; 4],
    pub original_size: [f32; 2],
    pub split_origin: [f32; 2],
    pub split_normal: [f32; 2],
    pub split_offset: [f32; 2],
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum DisplayLayer {
    Edited,
    Original,
}

pub struct WgpuDisplay {
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub pipeline: wgpu::RenderPipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub transform_buffer: wgpu::Buffer,
    pub latest_transform: DisplayTransform,
    pub current_bind_group: Option<wgpu::BindGroup>,
    pub edited_view: Option<wgpu::TextureView>,
    pub original_texture: Option<(wgpu::Texture, wgpu::TextureView)>,
}

impl WgpuDisplay {
    fn original_texture(
        &mut self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> &wgpu::Texture {
        if self
            .original_texture
            .as_ref()
            .is_none_or(|(t, _)| t.width() != width || t.height() != height)
        {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Original Display Texture"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            self.original_texture = Some((texture, view));
        }
        &self.original_texture.as_ref().unwrap().0
    }

    pub fn rebind(&mut self, device: &wgpu::Device) {
        let Some(edited_view) = &self.edited_view else {
            return;
        };
        let original_view = self
            .original_texture
            .as_ref()
            .map_or(edited_view, |(_, view)| view);
        self.current_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.transform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(edited_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(original_view),
                },
            ],
            label: None,
        }));
    }

    pub fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        if let Some(bind_group) = &self.current_bind_group {
            let output = match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(tex)
                | wgpu::CurrentSurfaceTexture::Suboptimal(tex) => tex,
                wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                    self.surface.configure(device, &self.config);
                    match self.surface.get_current_texture() {
                        wgpu::CurrentSurfaceTexture::Success(tex)
                        | wgpu::CurrentSurfaceTexture::Suboptimal(tex) => tex,
                        _ => panic!("Failed to acquire surface texture"),
                    }
                }
                _ => return,
            };
            let view = output
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder =
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: self.latest_transform.bg_primary[0] as f64,
                                g: self.latest_transform.bg_primary[1] as f64,
                                b: self.latest_transform.bg_primary[2] as f64,
                                a: self.latest_transform.bg_primary[3] as f64,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: NonZero::new(0),
                });
                let clip_x1 = self.latest_transform.clip[0].max(0.0);
                let clip_y1 = self.latest_transform.clip[1].max(0.0);
                let clip_x2 =
                    (self.latest_transform.clip[0] + self.latest_transform.clip[2]).max(0.0);
                let clip_y2 =
                    (self.latest_transform.clip[1] + self.latest_transform.clip[3]).max(0.0);

                let final_clip_x = clip_x1.floor() as u32;
                let final_clip_y = clip_y1.floor() as u32;
                let final_clip_w = (clip_x2.ceil() as u32).saturating_sub(final_clip_x);
                let final_clip_h = (clip_y2.ceil() as u32).saturating_sub(final_clip_y);

                let max_x = self.config.width;
                let max_y = self.config.height;

                if final_clip_x < max_x && final_clip_y < max_y {
                    let clamped_width = final_clip_w.min(max_x - final_clip_x);
                    let clamped_height = final_clip_h.min(max_y - final_clip_y);

                    if clamped_width > 0 && clamped_height > 0 {
                        rpass.set_scissor_rect(
                            final_clip_x,
                            final_clip_y,
                            clamped_width,
                            clamped_height,
                        );

                        rpass.set_pipeline(&self.pipeline);
                        rpass.set_bind_group(0, bind_group, &[]);
                        rpass.draw(0..4, 0..1);
                    }
                }
            }
            queue.submit(Some(encoder.finish()));
            output.present();
        }
    }
}

static GPU_DEVICE_LOST: AtomicBool = AtomicBool::new(false);

pub fn get_or_init_gpu_context(
    state: &tauri::State<AppState>,
    _app_handle: &tauri::AppHandle,
) -> Result<GpuContext, String> {
    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    let app_handle = _app_handle;

    let mut context_lock = match state.gpu_context.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!(
                "GPU context lock was poisoned (previous crash). Wiping state to self-heal."
            );
            let mut guard = poisoned.into_inner();
            *guard = None;
            guard
        }
    };
    if GPU_DEVICE_LOST.load(Ordering::Acquire) {
        log::warn!("Recreating GPU context after the device was lost.");
        if let Some(context) = context_lock.take() {
            *context.display.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        *lock_or_reset(&state.gpu_processor, "GPU processor") = None;
        *lock_or_reset(&state.gpu_image_cache, "GPU image cache") = None;
        GPU_DEVICE_LOST.store(false, Ordering::Release);
    }
    if let Some(context) = &*context_lock {
        return Ok(context.clone());
    }

    #[allow(unused_mut)]
    let mut instance_desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();

    #[cfg(target_os = "windows")]
    if std::env::var("WGPU_BACKEND").is_err() {
        instance_desc.backends = wgpu::Backends::PRIMARY;
    }

    let flag_path = state.gpu_crash_flag_path.lock().unwrap().clone();
    if let Some(p) = &flag_path {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, "initializing_gpu");
    }

    let instance = wgpu::Instance::new(instance_desc);

    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    let surface_opt = {
        let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
        let use_wgpu_renderer = settings.use_wgpu_renderer.unwrap_or(true);

        if use_wgpu_renderer {
            if let Some(window) = app_handle.get_webview_window("main") {
                match instance.create_surface(window) {
                    Ok(surface) => Some(surface),
                    Err(e) => {
                        log::warn!(
                            "Failed to create surface, falling back to compute-only: {}",
                            e
                        );
                        if let Some(p) = &flag_path {
                            let _ = std::fs::remove_file(p);
                        }
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    };

    #[cfg(any(target_os = "android", target_os = "linux"))]
    let surface_opt: Option<wgpu::Surface> = None;

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: surface_opt.as_ref(),
        ..Default::default()
    }))
    .map_err(|e| {
        if let Some(p) = &flag_path {
            let _ = std::fs::remove_file(p);
        }
        format!("Failed to find a wgpu adapter: {}", e)
    })?;

    let adapter_info = adapter.get_info();
    log::info!(
        "Using GPU adapter: {} ({:?}, {:?}, driver: {} {})",
        adapter_info.name,
        adapter_info.backend,
        adapter_info.device_type,
        adapter_info.driver,
        adapter_info.driver_info
    );

    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
    {
        required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    }

    let limits = adapter.limits();

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("Processing Device"),
        required_features,
        required_limits: limits.clone(),
        experimental_features: wgpu::ExperimentalFeatures::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .map_err(|e| {
        if let Some(p) = &flag_path {
            let _ = std::fs::remove_file(p);
        }
        e.to_string()
    })?;

    device.on_uncaptured_error(Arc::new(|err: wgpu::Error| {
        log::error!("[wgpu-error] {}", err);
    }));
    device.set_device_lost_callback(|reason, message| {
        if reason == wgpu::DeviceLostReason::Unknown {
            log::error!("GPU device lost: {}", message);
            GPU_DEVICE_LOST.store(true, Ordering::Release);
        }
    });

    if let Some(p) = &flag_path {
        let _ = std::fs::remove_file(p);
    }

    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    let display_opt = if let Some(surface) = surface_opt {
        let window = app_handle
            .get_webview_window("main")
            .ok_or("Failed to get main window")?;

        let swapchain_caps = surface.get_capabilities(&adapter);
        let swapchain_format = swapchain_caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(swapchain_caps.formats[0]);

        let alpha_mode = if cfg!(target_os = "windows")
            && swapchain_caps
                .alpha_modes
                .contains(&wgpu::CompositeAlphaMode::Opaque)
        {
            wgpu::CompositeAlphaMode::Opaque
        } else if swapchain_caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else if swapchain_caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PostMultiplied)
        {
            wgpu::CompositeAlphaMode::PostMultiplied
        } else {
            swapchain_caps.alpha_modes[0]
        };

        let size = window
            .inner_size()
            .unwrap_or(tauri::PhysicalSize::new(1280, 720));
        let config = wgpu::SurfaceConfiguration {
            width: size.width.max(1),
            height: size.height.max(1),
            format: swapchain_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Display Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/display.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Display BGL"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    count: None,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    count: None,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    count: None,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    count: None,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Display Pipeline Layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Display Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: NonZero::new(0),
            cache: None,
        });

        let transform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Transform Buffer"),
            size: std::mem::size_of::<DisplayTransform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Display Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Some(WgpuDisplay {
            surface,
            config,
            pipeline,
            bind_group_layout,
            transform_buffer,
            latest_transform: DisplayTransform {
                rect: [0.0, 0.0, 100.0, 100.0],
                clip: [0.0, 0.0, 10000.0, 10000.0],
                window: [1280.0, 720.0],
                image_size: [100.0, 100.0],
                texture_size: [100.0, 100.0],
                pixelated: 0.0,
                _pad: 0.0,
                bg_primary: [24.0 / 255.0, 24.0 / 255.0, 24.0 / 255.0, 1.0],
                bg_secondary: [35.0 / 255.0, 35.0 / 255.0, 35.0 / 255.0, 1.0],
                original_size: [100.0, 100.0],
                split_origin: [0.0, 0.0],
                split_normal: [0.0, 0.0],
                split_offset: [0.0, 0.0],
            },
            sampler,
            current_bind_group: None,
            edited_view: None,
            original_texture: None,
        })
    } else {
        None
    };

    #[cfg(any(target_os = "android", target_os = "linux"))]
    let display_opt = None;

    let new_context = GpuContext {
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        adapter_info,
        display: Arc::new(std::sync::Mutex::new(display_opt)),
    };
    *context_lock = Some(new_context.clone());
    Ok(new_context)
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

fn to_rgba_f16(img: &DynamicImage) -> Vec<f16> {
    use rayon::prelude::*;
    let convert = |src: &[f32], channels: usize| {
        let mut out = vec![f16::ZERO; src.len() / channels * 4];
        out.par_chunks_exact_mut(4)
            .zip(src.par_chunks_exact(channels))
            .for_each(|(dst, p)| {
                dst[0] = f16::from_f32(p[0]);
                dst[1] = f16::from_f32(p[1]);
                dst[2] = f16::from_f32(p[2]);
                dst[3] = if channels == 4 {
                    f16::from_f32(p[3])
                } else {
                    f16::ONE
                };
            });
        out
    };
    match img {
        DynamicImage::ImageRgba32F(buffer) => convert(buffer.as_raw(), 4),
        DynamicImage::ImageRgb32F(buffer) => convert(buffer.as_raw(), 3),
        other => convert(other.to_rgba32f().as_raw(), 4),
    }
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

static NEXT_GPU_IMAGE_ID: AtomicU64 = AtomicU64::new(1);

const BLUR_H_GROUP_WIDTH: u32 = 256;
const BLUR_V_GROUP_SIZE: (u32, u32) = (8, 64);
const DIRECT_BLUR_MAX_RADIUS: u32 = 8;

const GF_SHORT_EDGE: u32 = 1080;
const GF_CLARITY_RADIUS: f32 = 8.0;
const GF_STRUCTURE_RADIUS: f32 = 40.0;
const GF_CLARITY_EPS: f32 = 0.25;
const GF_STRUCTURE_EPS: f32 = 0.5;
const GF_COARSE_DIV: u32 = 4;
const GF_TONAL_RADIUS: f32 = 10.0;
const GF_TONAL_EPS: f32 = 0.25;
const HZ_DIV: u32 = 2;
const HZ_PATCH_RADIUS: f32 = 12.0;
const HZ_GF_RADIUS: f32 = 48.0;
const HZ_GF_EPS: f32 = 1.0e-3;

pub struct GuidedTextures {
    pub coeffs: wgpu::TextureView,
    pub structure: wgpu::TextureView,
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

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct FlareParams {
    amount: f32,
    is_raw: u32,
    exposure: f32,
    brightness: f32,
    contrast: f32,
    whites: f32,
    aspect_ratio: f32,
    _pad: f32,
}

pub struct GpuProcessor {
    context: GpuContext,
    blur_bgl: wgpu::BindGroupLayout,
    h_blur_pipeline: wgpu::ComputePipeline,
    v_blur_pipeline: wgpu::ComputePipeline,
    h_blur_direct_pipeline: wgpu::ComputePipeline,
    v_blur_direct_pipeline: wgpu::ComputePipeline,
    blur_params_buffer: wgpu::Buffer,

    flare_bgl_0: wgpu::BindGroupLayout,
    flare_bgl_1: wgpu::BindGroupLayout,
    flare_threshold_pipeline: wgpu::ComputePipeline,
    flare_ghosts_pipeline: wgpu::ComputePipeline,
    flare_params_buffer: wgpu::Buffer,
    flare_threshold_view: wgpu::TextureView,
    flare_ghosts_view: wgpu::TextureView,
    flare_final_view: wgpu::TextureView,
    flare_sampler: wgpu::Sampler,

    gf_bgl: wgpu::BindGroupLayout,
    gf_downsample_pipeline: wgpu::ComputePipeline,
    gf_box_down_pipeline: wgpu::ComputePipeline,
    gf_blur_h_pipeline: wgpu::ComputePipeline,
    gf_blur_v_pipeline: wgpu::ComputePipeline,
    gf_coeffs_pipeline: wgpu::ComputePipeline,
    gf_pack_pipeline: wgpu::ComputePipeline,
    hz_downsample_pipeline: wgpu::ComputePipeline,
    hz_airlight_pipeline: wgpu::ComputePipeline,
    hz_min_h_pipeline: wgpu::ComputePipeline,
    hz_min_v_pipeline: wgpu::ComputePipeline,
    hz_max_h_pipeline: wgpu::ComputePipeline,
    hz_max_v_pipeline: wgpu::ComputePipeline,
    hz_coeffs_pipeline: wgpu::ComputePipeline,

    main_bgl: wgpu::BindGroupLayout,
    main_pipeline: wgpu::ComputePipeline,
    main_shader_module: wgpu::ShaderModule,
    main_pipeline_layout: wgpu::PipelineLayout,
    specialized_pipelines: SpecializedPipelines,
    high_precision_entries: Vec<wgpu::BindGroupLayoutEntry>,
    high_precision_pipeline: std::sync::OnceLock<HighPrecisionPipeline>,
    high_precision_tile: std::sync::OnceLock<HighPrecisionTile>,
    tile_output_size: wgpu::Extent3d,
    adjustments_buffer: wgpu::Buffer,
    dummy_blur_view: wgpu::TextureView,
    dummy_lut_view: wgpu::TextureView,
    dummy_lut_sampler: wgpu::Sampler,
    dummy_mask_view: wgpu::TextureView,
    mask_cache: std::sync::Mutex<Option<MaskCache>>,
    lut_cache: std::sync::Mutex<Option<LutCache>>,
    ping_pong_view: wgpu::TextureView,
    sharpness_blur_view: wgpu::TextureView,
    tonal_blur_view: wgpu::TextureView,
    clarity_blur_view: wgpu::TextureView,
    structure_blur_view: wgpu::TextureView,
    blur_sources: std::sync::Mutex<[Option<(u64, BlurParams)>; 4]>,

    pub tile_output_texture: wgpu::Texture,
    pub tile_output_texture_view: wgpu::TextureView,
    full_image_size: wgpu::Extent3d,
    display_textures: std::sync::OnceLock<DisplayTextures>,
    readback_pool: ReadbackPool,
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

struct AnalyticsReadback {
    device: Arc<wgpu::Device>,
    buffer: wgpu::Buffer,
    pool: ReadbackPool,
    submission: wgpu::SubmissionIndex,
    analytics: crate::AnalyticsConfig,
    width: u32,
    height: u32,
    row_stride: usize,
}

fn analytics_readback_sender() -> &'static std::sync::mpsc::Sender<AnalyticsReadback> {
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
        let _ = analytics.sender.send(crate::AnalyticsJob {
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

pub struct DisplayTextures {
    pub working_texture: wgpu::Texture,
    pub output_texture: wgpu::Texture,
    pub output_texture_view: wgpu::TextureView,
}

struct HighPrecisionPipeline {
    bgl: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    shader: wgpu::ShaderModule,
    layout: wgpu::PipelineLayout,
}

type SpecializedPipelines =
    Arc<std::sync::Mutex<HashMap<(bool, u32), Option<wgpu::ComputePipeline>>>>;

const ALL_SHADER_FEATURES: u32 = u32::MAX;
const F_NOISE_REDUCTION: u32 = 1;
const F_HSL: u32 = 2;
const F_MASKS: u32 = 4;
const F_SHARPEN: u32 = 8;
const F_DEHAZE: u32 = 16;
const F_GLOW_HALATION_FLARE: u32 = 32;
const F_GRAIN: u32 = 64;
const F_VIGNETTE: u32 = 128;
const F_LUT: u32 = 256;
const F_CA: u32 = 512;
const F_AGX: u32 = 1024;
const F_MONOCHROME: u32 = 2048;

fn shader_features(adjustments: &AllAdjustments) -> u32 {
    let g = &adjustments.global;
    let masks = &adjustments.mask_adjustments[..(adjustments.mask_count as usize).min(MAX_MASKS)];
    let any = |global: f32, pick: fn(&MaskAdjustments) -> f32| {
        global != 0.0 || masks.iter().any(|m| pick(m) != 0.0)
    };
    let hsl_nonzero = |hsl: &[crate::image_processing::HslColor; 8]| {
        bytemuck::cast_slice::<_, f32>(hsl)
            .iter()
            .any(|&v| v != 0.0)
    };

    let mut features = 0;
    let mut set = |flag: u32, on: bool| {
        if on {
            features |= flag;
        }
    };
    set(
        F_NOISE_REDUCTION,
        any(g.luma_noise_reduction, |m| m.luma_noise_reduction)
            || any(g.color_noise_reduction, |m| m.color_noise_reduction),
    );
    set(
        F_HSL,
        hsl_nonzero(&g.hsl) || masks.iter().any(|m| hsl_nonzero(&m.hsl)),
    );
    set(F_MASKS, adjustments.mask_count > 0);
    set(F_SHARPEN, any(g.sharpness, |m| m.sharpness));
    set(F_DEHAZE, any(g.dehaze, |m| m.dehaze));
    set(
        F_GLOW_HALATION_FLARE,
        any(g.glow_amount, |m| m.glow_amount)
            || any(g.halation_amount, |m| m.halation_amount)
            || any(g.flare_amount, |m| m.flare_amount),
    );
    set(F_GRAIN, g.grain_amount > 0.0);
    set(F_VIGNETTE, g.vignette_amount != 0.0);
    set(F_LUT, g.has_lut == 1);
    set(
        F_CA,
        g.chromatic_aberration_red_cyan.abs() > 0.000001
            || g.chromatic_aberration_blue_yellow.abs() > 0.000001,
    );
    set(F_AGX, g.tonemapper_mode == 1);
    set(F_MONOCHROME, g.monochrome.enabled == 1);
    features
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

enum RenderedPixels {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

fn high_precision_shader_source() -> String {
    include_str!("shaders/shader.wgsl").replace("rgba8unorm, write>", "rgba16float, write>")
}

const FLARE_MAP_SIZE: u32 = 512;
const GPU_IMAGE_CACHE_ENTRIES: usize = 3;
const GPU_IMAGE_CACHE_PIXELS: u64 = 50_000_000;

fn lock_or_reset<'a, T>(
    mutex: &'a std::sync::Mutex<Option<T>>,
    name: &str,
) -> std::sync::MutexGuard<'a, Option<T>> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::warn!("{} lock was poisoned. Resetting to self-heal.", name);
        let mut guard = poisoned.into_inner();
        *guard = None;
        guard
    })
}

impl GpuProcessor {
    pub fn new(context: GpuContext, max_width: u32, max_height: u32) -> Result<Self, String> {
        let device = &context.device;
        const MAX_MASK_BINDINGS: u32 = 1;

        let blur_shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blur Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/blur.wgsl").into()),
        });

        let blur_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Blur BGL"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let blur_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Blur Pipeline Layout"),
            bind_group_layouts: &[Some(&blur_bgl)],
            immediate_size: 0,
        });

        let h_blur_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Horizontal Blur Pipeline"),
            layout: Some(&blur_pipeline_layout),
            module: &blur_shader_module,
            entry_point: Some("horizontal_blur"),
            compilation_options: Default::default(),
            cache: None,
        });

        let v_blur_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Vertical Blur Pipeline"),
            layout: Some(&blur_pipeline_layout),
            module: &blur_shader_module,
            entry_point: Some("vertical_blur"),
            compilation_options: Default::default(),
            cache: None,
        });

        let h_blur_direct_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Horizontal Direct Blur Pipeline"),
                layout: Some(&blur_pipeline_layout),
                module: &blur_shader_module,
                entry_point: Some("horizontal_blur_direct"),
                compilation_options: Default::default(),
                cache: None,
            });

        let v_blur_direct_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Vertical Direct Blur Pipeline"),
                layout: Some(&blur_pipeline_layout),
                module: &blur_shader_module,
                entry_point: Some("vertical_blur_direct"),
                compilation_options: Default::default(),
                cache: None,
            });

        let blur_params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Blur Params Buffer"),
            size: std::mem::size_of::<BlurParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let flare_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Flare Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/flare.wgsl").into()),
        });

        let flare_bgl_0 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Flare BGL 0"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let flare_bgl_1 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Flare BGL 1"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });

        let flare_threshold_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Flare Threshold Layout"),
                bind_group_layouts: &[Some(&flare_bgl_0)],
                immediate_size: 0,
            });

        let flare_ghosts_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Flare Ghosts Layout"),
            bind_group_layouts: &[Some(&flare_bgl_0), Some(&flare_bgl_1)],
            immediate_size: 0,
        });

        let flare_threshold_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Flare Threshold Pipeline"),
                layout: Some(&flare_threshold_layout),
                module: &flare_shader,
                entry_point: Some("threshold_main"),
                compilation_options: Default::default(),
                cache: None,
            });

        let flare_ghosts_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Flare Ghosts Pipeline"),
                layout: Some(&flare_ghosts_layout),
                module: &flare_shader,
                entry_point: Some("ghosts_main"),
                compilation_options: Default::default(),
                cache: None,
            });

        let flare_params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Flare Params Buffer"),
            size: std::mem::size_of::<FlareParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let flare_tex_desc = wgpu::TextureDescriptor {
            label: Some("Flare Tex"),
            size: wgpu::Extent3d {
                width: FLARE_MAP_SIZE,
                height: FLARE_MAP_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        };

        let flare_threshold_texture = device.create_texture(&flare_tex_desc);
        let flare_threshold_view = flare_threshold_texture.create_view(&Default::default());
        let flare_ghosts_texture = device.create_texture(&flare_tex_desc);
        let flare_ghosts_view = flare_ghosts_texture.create_view(&Default::default());
        let flare_final_texture = device.create_texture(&flare_tex_desc);
        let flare_final_view = flare_final_texture.create_view(&Default::default());

        let flare_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Flare Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let gf_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Guided Filter Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/guided.wgsl").into()),
        });

        let gf_texture_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };

        let gf_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Guided Filter BGL"),
            entries: &[
                gf_texture_entry(0),
                gf_texture_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba32Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let gf_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Guided Filter Pipeline Layout"),
            bind_group_layouts: &[Some(&gf_bgl)],
            immediate_size: 0,
        });

        let gf_pipeline = |entry: &'static str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&gf_layout),
                module: &gf_shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        let gf_downsample_pipeline = gf_pipeline("gf_downsample");
        let gf_box_down_pipeline = gf_pipeline("gf_box_down");
        let gf_blur_h_pipeline = gf_pipeline("gf_blur_h");
        let gf_blur_v_pipeline = gf_pipeline("gf_blur_v");
        let gf_coeffs_pipeline = gf_pipeline("gf_coeffs");
        let gf_pack_pipeline = gf_pipeline("gf_pack");
        let hz_downsample_pipeline = gf_pipeline("hz_downsample");
        let hz_airlight_pipeline = gf_pipeline("hz_airlight");
        let hz_min_h_pipeline = gf_pipeline("hz_min_h");
        let hz_min_v_pipeline = gf_pipeline("hz_min_v");
        let hz_max_h_pipeline = gf_pipeline("hz_max_h");
        let hz_max_v_pipeline = gf_pipeline("hz_max_v");
        let hz_coeffs_pipeline = gf_pipeline("hz_coeffs");

        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Image Processing Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/shader.wgsl").into()),
        });

        let mut bind_group_layout_entries = vec![
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ];

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2Array,
                multisampled: false,
            },
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D3,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 4 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 5 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 6 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 7 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 8 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 9 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 10 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 11 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });

        for binding in 12..15 {
            bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
                binding: binding + MAX_MASK_BINDINGS,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
        }

        let main_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Main BGL"),
            entries: &bind_group_layout_entries,
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Pipeline Layout"),
            bind_group_layouts: &[Some(&main_bgl)],
            immediate_size: 0,
        });

        let main_shader_module = shader_module.clone();
        let main_pipeline_layout = pipeline_layout.clone();
        let main_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Compute Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader_module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        bind_group_layout_entries[1].ty = wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: wgpu::TextureFormat::Rgba16Float,
            view_dimension: wgpu::TextureViewDimension::D2,
        };
        let adjustments_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Adjustments Buffer"),
            size: std::mem::size_of::<AllAdjustments>() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let dummy_texture_desc = wgpu::TextureDescriptor {
            label: Some("Dummy Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        };
        let dummy_blur_texture = device.create_texture(&dummy_texture_desc);
        let dummy_blur_view = dummy_blur_texture.create_view(&Default::default());

        let dummy_lut_texture = device.create_texture(&wgpu::TextureDescriptor {
            dimension: wgpu::TextureDimension::D3,
            ..dummy_texture_desc
        });
        let dummy_lut_view = dummy_lut_texture.create_view(&Default::default());
        let dummy_lut_sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
        let dummy_mask_view = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Dummy Mask Texture Array"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 2,
                },
                format: wgpu::TextureFormat::R8Unorm,
                ..dummy_texture_desc
            })
            .create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
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

        let clarity_blur_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Clarity Blur Texture"),
            ..reusable_texture_desc
        });
        let clarity_blur_view = clarity_blur_texture.create_view(&Default::default());

        let structure_blur_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Structure Blur Texture"),
            ..reusable_texture_desc
        });
        let structure_blur_view = structure_blur_texture.create_view(&Default::default());

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
            blur_bgl,
            h_blur_pipeline,
            v_blur_pipeline,
            h_blur_direct_pipeline,
            v_blur_direct_pipeline,
            blur_params_buffer,
            flare_bgl_0,
            flare_bgl_1,
            flare_threshold_pipeline,
            flare_ghosts_pipeline,
            flare_params_buffer,
            flare_threshold_view,
            flare_ghosts_view,
            flare_final_view,
            flare_sampler,
            gf_bgl,
            gf_downsample_pipeline,
            gf_box_down_pipeline,
            gf_blur_h_pipeline,
            gf_blur_v_pipeline,
            gf_coeffs_pipeline,
            gf_pack_pipeline,
            hz_downsample_pipeline,
            hz_airlight_pipeline,
            hz_min_h_pipeline,
            hz_min_v_pipeline,
            hz_max_h_pipeline,
            hz_max_v_pipeline,
            hz_coeffs_pipeline,
            main_bgl,
            main_pipeline,
            main_shader_module,
            main_pipeline_layout,
            specialized_pipelines: Arc::new(std::sync::Mutex::new(HashMap::new())),
            high_precision_entries: bind_group_layout_entries,
            high_precision_pipeline: std::sync::OnceLock::new(),
            high_precision_tile: std::sync::OnceLock::new(),
            tile_output_size: clamped_tile_size,
            adjustments_buffer,
            dummy_blur_view,
            dummy_lut_view,
            dummy_lut_sampler,
            dummy_mask_view,
            mask_cache: std::sync::Mutex::new(None),
            lut_cache: std::sync::Mutex::new(None),
            ping_pong_view,
            sharpness_blur_view,
            tonal_blur_view,
            clarity_blur_view,
            structure_blur_view,
            blur_sources: std::sync::Mutex::new([None; 4]),
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
        let cw = lw.div_ceil(GF_COARSE_DIV).max(1);
        let ch = lh.div_ceil(GF_COARSE_DIV).max(1);
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
        let ab_clarity = make_view("GF Coeffs Clarity", lw, lh);
        let c_moments = make_view("GF Coarse Moments", cw, ch);
        let c_tmp = make_view("GF Coarse Ping Pong", cw, ch);
        let c_blurred = make_view("GF Coarse Blurred", cw, ch);
        let c_ab = make_view("GF Coarse Coeffs", cw, ch);
        let hz_a = make_view("Haze Ping", hw, hh);
        let hz_b = make_view("Haze Pong", hw, hh);
        let hz_coarse = make_view("Haze Coarse", hcw, hch);
        let haze = make_view("Haze Coeffs", hw, hh);
        let airlight = make_view("Haze Airlight", 2, 1);

        let params_clarity = make_params(GF_CLARITY_RADIUS, GF_CLARITY_EPS, 1.0);
        let params_tonal = make_params(GF_TONAL_RADIUS, GF_TONAL_EPS, 1.0);
        let params_coarse =
            make_params(GF_STRUCTURE_RADIUS, GF_STRUCTURE_EPS, GF_COARSE_DIV as f32);
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
                layout: &self.gf_bgl,
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
        let coarse = (cw, ch);
        let half = (hw, hh);

        pass(
            &self.gf_downsample_pipeline,
            input_view,
            input_view,
            &moments,
            &params_clarity,
            fine,
        );

        pass(
            &self.gf_box_down_pipeline,
            &moments,
            &moments,
            &c_moments,
            &params_coarse,
            coarse,
        );
        pass(
            &self.gf_blur_h_pipeline,
            &c_moments,
            &c_moments,
            &c_tmp,
            &params_coarse,
            coarse,
        );
        pass(
            &self.gf_blur_v_pipeline,
            &c_tmp,
            &c_tmp,
            &c_blurred,
            &params_coarse,
            coarse,
        );
        pass(
            &self.gf_coeffs_pipeline,
            &c_blurred,
            &c_blurred,
            &c_ab,
            &params_coarse,
            coarse,
        );
        pass(
            &self.gf_blur_h_pipeline,
            &c_ab,
            &c_ab,
            &c_tmp,
            &params_coarse,
            coarse,
        );
        pass(
            &self.gf_blur_v_pipeline,
            &c_tmp,
            &c_tmp,
            &c_moments,
            &params_coarse,
            coarse,
        );

        for (params, out) in [(&params_clarity, &ab_clarity), (&params_tonal, &blurred)] {
            pass(
                &self.gf_blur_h_pipeline,
                &moments,
                &moments,
                &tmp,
                params,
                fine,
            );
            pass(&self.gf_blur_v_pipeline, &tmp, &tmp, &blurred, params, fine);
            pass(
                &self.gf_coeffs_pipeline,
                &blurred,
                &blurred,
                &ab,
                params,
                fine,
            );
            pass(&self.gf_blur_h_pipeline, &ab, &ab, &tmp, params, fine);
            pass(&self.gf_blur_v_pipeline, &tmp, &tmp, out, params, fine);
        }

        pass(
            &self.gf_pack_pipeline,
            &ab_clarity,
            &blurred,
            &ab,
            &params_clarity,
            fine,
        );

        pass(
            &self.hz_downsample_pipeline,
            input_view,
            input_view,
            &hz_a,
            &params_hz_patch,
            half,
        );
        pass(
            &self.gf_box_down_pipeline,
            &hz_a,
            &hz_a,
            &hz_coarse,
            &params_hz_patch,
            (hcw, hch),
        );
        pass(
            &self.hz_airlight_pipeline,
            &hz_coarse,
            &hz_coarse,
            &airlight,
            &params_hz_patch,
            (1, 1),
        );
        pass(
            &self.hz_min_h_pipeline,
            &hz_a,
            &airlight,
            &hz_b,
            &params_hz_patch,
            half,
        );
        pass(
            &self.hz_min_v_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_patch,
            half,
        );
        pass(
            &self.hz_max_h_pipeline,
            &hz_a,
            &hz_a,
            &hz_b,
            &params_hz_patch,
            half,
        );
        pass(
            &self.hz_max_v_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_patch,
            half,
        );
        pass(
            &self.gf_blur_h_pipeline,
            &hz_a,
            &hz_a,
            &hz_b,
            &params_hz_gf,
            half,
        );
        pass(
            &self.gf_blur_v_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_gf,
            half,
        );
        pass(
            &self.hz_coeffs_pipeline,
            &hz_a,
            &hz_a,
            &hz_b,
            &params_hz_gf,
            half,
        );
        pass(
            &self.gf_blur_h_pipeline,
            &hz_b,
            &hz_b,
            &hz_a,
            &params_hz_gf,
            half,
        );
        pass(
            &self.gf_blur_v_pipeline,
            &hz_a,
            &hz_a,
            &haze,
            &params_hz_gf,
            half,
        );

        queue.submit(Some(encoder.finish()));
        GuidedTextures {
            coeffs: ab,
            structure: c_moments,
            haze,
            airlight,
        }
    }

    fn mask_view(
        &self,
        mask_bitmaps: &[ImageBuffer<Luma<u8>, Vec<u8>>],
        width: u32,
        height: u32,
        cache_key: Option<u64>,
    ) -> wgpu::TextureView {
        if mask_bitmaps.is_empty() {
            return self.dummy_mask_view.clone();
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
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
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
                &self.main_pipeline,
                &self.main_shader_module,
                &self.main_pipeline_layout,
            )
        };
        if features == ALL_SHADER_FEATURES {
            return generic.clone();
        }

        let key = (high_precision, features);
        let mut pipelines = self
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
        let specialized_pipelines = Arc::clone(&self.specialized_pipelines);
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

    fn readback_buffer(&self, size: u64) -> wgpu::Buffer {
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
        self.high_precision_pipeline.get_or_init(|| {
            let device = &self.context.device;
            let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("High Precision Main BGL"),
                entries: &self.high_precision_entries,
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

    fn run(
        &self,
        input: &GpuImageEntry,
        request: RenderRequest,
        output_to_display: bool,
        output_precision: RenderOutputPrecision,
    ) -> Result<(RenderedPixels, u32, u32, u32, u32), String> {
        let input_texture_view = &input.texture_view;
        let gf_coeffs_view = &input.gf_coeffs_view;
        let gf_structure_view = &input.gf_structure_view;
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
        let output_pipeline = self.main_pipeline_for(
            high_precision_tile.is_some(),
            shader_features(&request.adjustments),
        );
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
                    &self.main_bgl,
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
        let mask_texture_view =
            self.mask_view(request.mask_bitmaps, width, height, request.mask_cache_key);
        let (lut_texture_view, lut_sampler) = match &request.lut {
            Some(lut) => self.lut_view(lut),
            None => (self.dummy_lut_view.clone(), self.dummy_lut_sampler.clone()),
        };

        let adjustments = request.adjustments;
        if adjustments.global.flare_amount > 0.0 {
            let mut encoder = device.create_command_encoder(&Default::default());

            let aspect_ratio = if height > 0 {
                width as f32 / height as f32
            } else {
                1.0
            };
            let f_params = FlareParams {
                amount: adjustments.global.flare_amount,
                is_raw: adjustments.global.is_raw_image,
                exposure: adjustments.global.exposure,
                brightness: adjustments.global.brightness,
                contrast: adjustments.global.contrast,
                whites: adjustments.global.whites,
                aspect_ratio,
                _pad: 0.0,
            };
            queue.write_buffer(&self.flare_params_buffer, 0, bytemuck::bytes_of(&f_params));

            let bg0 = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Flare BG0"),
                layout: &self.flare_bgl_0,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(input_texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&self.flare_threshold_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: self.flare_params_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Sampler(&self.flare_sampler),
                    },
                ],
            });

            {
                let mut cpass = encoder.begin_compute_pass(&Default::default());
                cpass.set_pipeline(&self.flare_threshold_pipeline);
                cpass.set_bind_group(0, &bg0, &[]);
                cpass.dispatch_workgroups(FLARE_MAP_SIZE / 16, FLARE_MAP_SIZE / 16, 1);
            }

            let bg0_ghosts = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Flare BG0 Ghosts"),
                layout: &self.flare_bgl_0,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(input_texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&self.flare_final_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: self.flare_params_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Sampler(&self.flare_sampler),
                    },
                ],
            });

            let bg1 = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Flare BG1"),
                layout: &self.flare_bgl_1,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&self.flare_threshold_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&self.flare_ghosts_view),
                    },
                ],
            });

            {
                let mut cpass = encoder.begin_compute_pass(&Default::default());
                cpass.set_pipeline(&self.flare_ghosts_pipeline);
                cpass.set_bind_group(0, &bg0_ghosts, &[]);
                cpass.set_bind_group(1, &bg1, &[]);
                cpass.dispatch_workgroups(FLARE_MAP_SIZE / 16, FLARE_MAP_SIZE / 16, 1);
            }

            queue.submit(Some(encoder.finish()));
        }

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
                        layout: &self.blur_bgl,
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
                            &self.h_blur_direct_pipeline
                        } else {
                            &self.h_blur_pipeline
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
                        layout: &self.blur_bgl,
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
                            cpass.set_pipeline(&self.v_blur_direct_pipeline);
                            cpass.dispatch_workgroups(input_width, input_height.div_ceil(256), 1);
                        } else {
                            cpass.set_pipeline(&self.v_blur_pipeline);
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
                let need_halation = any_term(
                    adjustments.global.halation_amount,
                    &|m| m.halation_amount,
                    true,
                );
                let need_structure =
                    any_term(adjustments.global.glow_amount, &|m| m.glow_amount, true);

                let did_create_sharpness_blur =
                    need_sharpen && run_blur(0, 1.0, &self.sharpness_blur_view);
                let did_create_tonal_blur = need_sharpen && run_blur(1, 3.5, &self.tonal_blur_view);
                let did_create_clarity_blur =
                    need_halation && run_blur(2, 8.0, &self.clarity_blur_view);
                let did_create_structure_blur =
                    need_structure && run_blur(3, 40.0, &self.structure_blur_view);

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
                    resource: wgpu::BindingResource::TextureView(&mask_texture_view),
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
                        &self.dummy_blur_view
                    }),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 6 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(if did_create_tonal_blur {
                        &self.tonal_blur_view
                    } else {
                        &self.dummy_blur_view
                    }),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 7 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(if did_create_clarity_blur {
                        &self.clarity_blur_view
                    } else {
                        &self.dummy_blur_view
                    }),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 8 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(if did_create_structure_blur {
                        &self.structure_blur_view
                    } else {
                        &self.dummy_blur_view
                    }),
                });

                let use_flare = adjustments.global.flare_amount > 0.0;
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 9 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(if use_flare {
                        &self.flare_ghosts_view
                    } else {
                        &self.dummy_blur_view
                    }),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 10 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::Sampler(&self.flare_sampler),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 11 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(gf_coeffs_view),
                });
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 12 + MAX_MASK_BINDINGS,
                    resource: wgpu::BindingResource::TextureView(gf_structure_view),
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

pub fn process_and_get_dynamic_image(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    request: RenderRequest,
    caller_id: &str,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        base_image,
        transform_hash,
        request,
        caller_id,
        RenderOutputPrecision::EightBit,
        None,
        None,
    )
}

pub fn process_and_get_dynamic_image_with_precision(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    request: RenderRequest,
    caller_id: &str,
    output_precision: RenderOutputPrecision,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        base_image,
        transform_hash,
        request,
        caller_id,
        output_precision,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn process_and_get_dynamic_image_with_analytics(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    request: RenderRequest,
    caller_id: &str,
    display_layer: Option<DisplayLayer>,
    analytics_config: Option<crate::AnalyticsConfig>,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        base_image,
        transform_hash,
        request,
        caller_id,
        RenderOutputPrecision::EightBit,
        display_layer,
        analytics_config,
    )
}

#[allow(clippy::too_many_arguments)]
fn process_and_get_dynamic_image_inner(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    request: RenderRequest,
    caller_id: &str,
    output_precision: RenderOutputPrecision,
    display_layer: Option<DisplayLayer>,
    analytics_config: Option<crate::AnalyticsConfig>,
) -> Result<DynamicImage, String> {
    let start_time = Instant::now();
    let output_to_display = display_layer.is_some();
    let (width, height) = base_image.dimensions();
    let device = &context.device;
    let queue = &context.queue;

    let max_dim = context.limits.max_texture_dimension_2d;
    if width > max_dim || height > max_dim {
        log::warn!(
            "Image dimensions ({}x{}) exceed GPU limits ({}). Bypassing GPU processing and returning unprocessed image to prevent a crash. Try upgrading your GPU :)",
            width,
            height,
            max_dim
        );
        return Ok(base_image.clone());
    }

    let is_raw = request.adjustments.global.is_raw_image;
    let source = (
        base_image.as_bytes().as_ptr() as usize,
        base_image.as_bytes().len(),
    );
    let matches = |e: &GpuImageEntry| {
        e.transform_hash == transform_hash
            && e.width == width
            && e.height == height
            && e.is_raw == is_raw
            && e.source == source
    };

    let mut img_rgba_f16: Option<Vec<f16>> = None;
    let (mut processor_lock, mut cache_lock) = loop {
        let is_cached = lock_or_reset(&state.gpu_image_cache, "GPU image cache")
            .as_ref()
            .is_some_and(|c| c.entries.iter().any(matches));
        if !is_cached && img_rgba_f16.is_none() {
            img_rgba_f16 = Some(to_rgba_f16(base_image));
        }

        let processor_lock = lock_or_reset(&state.gpu_processor, "GPU processor");
        let cache_lock = lock_or_reset(&state.gpu_image_cache, "GPU image cache");
        let is_cached = cache_lock
            .as_ref()
            .is_some_and(|c| c.entries.iter().any(matches));
        if is_cached || img_rgba_f16.is_some() {
            break (processor_lock, cache_lock);
        }
    };

    let needs_new_processor = processor_lock
        .as_ref()
        .is_none_or(|p| p.width < width || p.height < height);

    if needs_new_processor {
        let (old_width, old_height) = processor_lock
            .as_ref()
            .map_or((0, 0), |p| (p.width, p.height));
        let new_width = ((width + 255) & !255).max(old_width);
        let new_height = ((height + 255) & !255).max(old_height);
        log::info!(
            "Creating new GPU Processor for dimensions up to {}x{}",
            new_width,
            new_height
        );

        let old_processor = processor_lock.take();
        drop(old_processor);

        let _ = context.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_millis(500)),
        });

        let new_processor = GpuProcessor::new(context.clone(), new_width, new_height)?;

        *processor_lock = Some(crate::GpuProcessorState {
            processor: new_processor,
            width: new_width,
            height: new_height,
        });
    }

    let processor_state = processor_lock.as_ref().unwrap();
    let processor = &processor_state.processor;

    let cache = cache_lock.get_or_insert_with(|| GpuImageCache {
        entries: Vec::new(),
    });

    if let Some(index) = cache.entries.iter().position(matches) {
        let entry = cache.entries.remove(index);
        cache.entries.push(entry);
    } else if let Some(img_rgba_f16) = img_rgba_f16.take() {
        let texture_size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("Input Texture"),
                size: texture_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            TextureDataOrder::MipMajor,
            bytemuck::cast_slice(&img_rgba_f16),
        );
        drop(img_rgba_f16);
        let texture_view = texture.create_view(&Default::default());

        let guided = processor.build_guided_coeffs(&texture_view, width, height, is_raw);

        cache.entries.push(GpuImageEntry {
            id: NEXT_GPU_IMAGE_ID.fetch_add(1, Ordering::Relaxed),
            texture,
            texture_view,
            gf_coeffs_view: guided.coeffs,
            gf_structure_view: guided.structure,
            haze_view: guided.haze,
            airlight_view: guided.airlight,
            is_raw,
            width,
            height,
            transform_hash,
            source,
        });

        let pixels = |e: &GpuImageEntry| e.width as u64 * e.height as u64;
        while cache.entries.len() > GPU_IMAGE_CACHE_ENTRIES
            || (cache.entries.len() > 1
                && cache.entries.iter().map(pixels).sum::<u64>() > GPU_IMAGE_CACHE_PIXELS)
        {
            cache.entries.remove(0);
        }
    }

    let cache = cache.entries.last().unwrap();

    let skip_readback = output_to_display;

    let (processed_pixels, out_w, out_h, out_x, out_y) =
        processor.run(cache, request, output_to_display, output_precision)?;

    let mut final_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Final Passes Encoder"),
    });
    let mut submit_final_encoder = false;

    let mut async_readback_buffer: Option<wgpu::Buffer> = None;
    let mut async_padded_bpr: u32 = 0;

    if analytics_config.is_some() && skip_readback {
        let unpadded_bytes_per_row = 4 * out_w;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) & !(align - 1);
        let output_buffer_size = (padded_bytes_per_row * out_h) as u64;

        let output_buffer = processor.readback_buffer(output_buffer_size);

        final_encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &processor.display_textures().working_texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: out_x,
                    y: out_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &output_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(out_h),
                },
            },
            wgpu::Extent3d {
                width: out_w,
                height: out_h,
                depth_or_array_layers: 1,
            },
        );

        async_readback_buffer = Some(output_buffer);
        async_padded_bpr = padded_bytes_per_row;
        submit_final_encoder = true;
    }

    let mut display_lock =
        output_to_display.then(|| context.display.lock().unwrap_or_else(|e| e.into_inner()));
    let mut display = display_lock.as_mut().and_then(|d| d.as_mut());

    let display_target = match display_layer {
        Some(DisplayLayer::Edited) => Some(&processor.display_textures().output_texture),
        Some(DisplayLayer::Original) => display
            .as_deref_mut()
            .map(|display| display.original_texture(device, width, height)),
        None => None,
    };

    if let Some(target) = display_target {
        final_encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &processor.display_textures().working_texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: out_x,
                    y: out_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: target,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: out_x,
                    y: out_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: out_w,
                height: out_h,
                depth_or_array_layers: 1,
            },
        );
        submit_final_encoder = true;
    }

    let final_submission = submit_final_encoder.then(|| queue.submit(Some(final_encoder.finish())));

    if let Some(analytics) = analytics_config {
        if let (Some(output_buffer), Some(submission)) = (async_readback_buffer, final_submission) {
            let _ = analytics_readback_sender().send(AnalyticsReadback {
                device: Arc::clone(&context.device),
                buffer: output_buffer,
                pool: Arc::clone(&processor.readback_pool),
                submission,
                analytics,
                width: out_w,
                height: out_h,
                row_stride: async_padded_bpr as usize,
            });
        } else {
            if let RenderedPixels::U8(pixels) = &processed_pixels {
                let _ = analytics.sender.send(crate::AnalyticsJob {
                    path: analytics.path,
                    frame: AnalyticsFrame {
                        data: AnalyticsPixels::Owned(pixels.clone()),
                        width: out_w,
                        height: out_h,
                        row_stride: out_w as usize * 4,
                    },
                    compute_waveform: analytics.compute_waveform,
                    active_waveform_channel: analytics.active_waveform_channel,
                });
            } else {
                log::warn!("Skipping analytics for a high-precision CPU readback");
            }
        }
    }

    if let (Some(layer), Some(display)) = (display_layer, display) {
        match layer {
            DisplayLayer::Edited => {
                display.latest_transform.image_size = [width as f32, height as f32];
                display.latest_transform.texture_size =
                    [processor_state.width as f32, processor_state.height as f32];
                display.edited_view =
                    Some(processor.display_textures().output_texture_view.clone());
            }
            DisplayLayer::Original => {
                display.latest_transform.original_size = [width as f32, height as f32];
            }
        }

        queue.write_buffer(
            &display.transform_buffer,
            0,
            bytemuck::bytes_of(&display.latest_transform),
        );
        display.rebind(device);
        display.render(device, queue);
    }

    if skip_readback {
        let duration = start_time.elapsed();
        let fps = 1.0 / duration.as_secs_f64();
        log::info!(
            "[{}] {}x{} native WGPU display updated in {:?} ({:.2} FPS)",
            caller_id,
            width,
            height,
            duration,
            fps
        );
        return Ok(DynamicImage::new_rgba8(0, 0));
    }

    let duration = start_time.elapsed();
    let fps = 1.0 / duration.as_secs_f64();
    log::info!(
        "[{}] {}x{} processed (ROI: {}x{}) on GPU in {:?} ({:.2} FPS)",
        caller_id,
        width,
        height,
        out_w,
        out_h,
        duration,
        fps
    );

    drop(cache_lock);
    drop(processor_lock);

    match processed_pixels {
        RenderedPixels::U8(pixels) => {
            let img_buf = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(out_w, out_h, pixels)
                .ok_or("Failed to create 8-bit image buffer from GPU data")?;
            Ok(DynamicImage::ImageRgba8(img_buf))
        }
        RenderedPixels::U16(mut pixels) => {
            use rayon::prelude::*;
            pixels.par_iter_mut().for_each(|sample| {
                let value = f16::from_bits(*sample).to_f32();
                *sample = if value.is_finite() {
                    (value.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16
                } else {
                    0
                };
            });
            let img_buf = ImageBuffer::<Rgba<u16>, Vec<u16>>::from_raw(out_w, out_h, pixels)
                .ok_or("Failed to create 16-bit image buffer from GPU data")?;
            Ok(DynamicImage::ImageRgba16(img_buf))
        }
    }
}
