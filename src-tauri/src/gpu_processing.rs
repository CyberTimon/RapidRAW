use std::sync::Arc;
use std::time::Instant;

use half::f16;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, Rgba};
use std::num::NonZero;

#[cfg(not(any(target_os = "android", target_os = "linux")))]
use tauri::Manager;
use wgpu::util::{DeviceExt, TextureDataOrder};

use crate::app_state::{PreviewCancellation, PreviewIdentity, PreviewLane};
use crate::image_processing::{AllAdjustments, GpuContext, MAX_MASKS};
use crate::lut_processing::Lut;
use crate::{AppState, GpuImageCache};

fn submit_current_preview_display<T>(
    state: &AppState,
    identity: Option<PreviewIdentity>,
    submit: impl FnOnce() -> T,
) -> Result<T, String> {
    if let Some(identity) = identity {
        state.with_current_preview_identity(identity, submit)
    } else {
        Ok(submit())
    }
}

pub(crate) fn display_frame_matches_generation(
    frame_generation: Option<usize>,
    generation: usize,
) -> bool {
    frame_generation == Some(generation)
}

/// Present a neutral frame as soon as a new photo generation begins, before
/// waiting for the previous generation's session readers to drain.
pub fn clear_preview_display_for_generation(
    state: &AppState,
    generation: usize,
) -> Result<(), String> {
    let context = state
        .gpu_context
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .cloned();
    let Some(context) = context else {
        return Ok(());
    };
    let identity = PreviewIdentity {
        generation,
        lane: PreviewLane::Main,
        revision: None,
    };
    state.with_current_preview_identity(identity, || {
        let mut display = context
            .display
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(display) = display.as_mut() {
            display.current_bind_group = None;
            display.frame_generation = None;
            display.render(&context.device, &context.queue);
        }
    })
}

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
    pub frame_generation: Option<usize>,
}

impl WgpuDisplay {
    pub fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
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
            if let Some(bind_group) = &self.current_bind_group {
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
        }
        queue.submit(Some(encoder.finish()));
        output.present();
    }
}

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
            },
            sampler,
            current_bind_group: None,
            frame_generation: None,
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
    if texture.format().block_copy_size(None) != Some(bytes_per_pixel) {
        return Err("Readback pixel stride does not match the output texture format".into());
    }
    let extent = texture.size();
    if size.width == 0
        || size.height == 0
        || size.depth_or_array_layers != 1
        || origin
            .x
            .checked_add(size.width)
            .is_none_or(|end| end > extent.width)
        || origin
            .y
            .checked_add(size.height)
            .is_none_or(|end| end > extent.height)
        || origin
            .z
            .checked_add(1)
            .is_none_or(|end| end > extent.depth_or_array_layers)
    {
        return Err("Readback region exceeds the output texture".into());
    }
    let layout = readback_layout(
        size.width,
        size.height,
        bytes_per_pixel,
        device.limits().max_buffer_size,
    )?;

    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Readback Buffer"),
        size: layout.buffer_size,
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
                bytes_per_row: Some(layout.padded_row),
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

    let padded_data = buffer_slice.get_mapped_range().to_vec();
    output_buffer.unmap();

    if layout.padded_row == layout.row {
        Ok(padded_data)
    } else {
        remove_readback_padding(&padded_data, layout, size.height)
    }
}

#[derive(Clone, Copy, Debug)]
struct ReadbackLayout {
    row: u32,
    padded_row: u32,
    buffer_size: u64,
    data_len: usize,
}

fn readback_layout(
    width: u32,
    height: u32,
    pixel_bytes: u32,
    max_buffer_size: u64,
) -> Result<ReadbackLayout, String> {
    let row = u64::from(width)
        .checked_mul(u64::from(pixel_bytes))
        .ok_or("Readback row size overflow")?;
    let align = u64::from(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let padded_row = row
        .checked_add(align - 1)
        .ok_or("Readback row alignment overflow")?
        / align
        * align;
    let buffer_size = padded_row
        .checked_mul(u64::from(height))
        .ok_or("Readback buffer size overflow")?;
    let data_len = row
        .checked_mul(u64::from(height))
        .and_then(|v| usize::try_from(v).ok())
        .ok_or("Readback data size overflow")?;
    if width == 0
        || height == 0
        || pixel_bytes == 0
        || padded_row > u64::from(u32::MAX)
        || buffer_size > max_buffer_size
        || usize::try_from(buffer_size).is_err()
    {
        return Err("Readback dimensions exceed device or host buffer limits".into());
    }
    Ok(ReadbackLayout {
        row: row as u32,
        padded_row: padded_row as u32,
        buffer_size,
        data_len,
    })
}

fn remove_readback_padding(
    data: &[u8],
    layout: ReadbackLayout,
    height: u32,
) -> Result<Vec<u8>, String> {
    if data.len() as u64 != layout.buffer_size {
        return Err("Readback buffer length does not match its layout".into());
    }
    let mut result = Vec::with_capacity(layout.data_len);
    for chunk in data
        .chunks_exact(layout.padded_row as usize)
        .take(height as usize)
    {
        result.extend_from_slice(&chunk[..layout.row as usize]);
    }
    Ok(result)
}

fn to_rgba_f16(img: &DynamicImage) -> Vec<f16> {
    let rgba_f32 = img.to_rgba32f();
    rgba_f32.into_raw().into_iter().map(f16::from_f32).collect()
}

// Fail explicitly if an upstream shader changes the integration points instead
// of silently dropping back to an 8-bit output or an incompatible texture.
fn replace_shader_token(source: &str, token: &str, replacement: &str) -> Result<String, String> {
    if source.matches(token).count() != 1 {
        return Err(format!(
            "High-precision shader integration requires exactly one '{token}'"
        ));
    }
    Ok(source.replacen(token, replacement, 1))
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
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
    high_precision: bool,
    tile_overlap: u32,
    blur_bgl: wgpu::BindGroupLayout,
    h_blur_pipeline: wgpu::ComputePipeline,
    v_blur_pipeline: wgpu::ComputePipeline,
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

    main_bgl: wgpu::BindGroupLayout,
    main_pipeline: wgpu::ComputePipeline,
    high_precision_bgl: wgpu::BindGroupLayout,
    high_precision_pipeline: wgpu::ComputePipeline,
    high_precision_tile: std::sync::OnceLock<HighPrecisionTile>,
    tile_output_size: wgpu::Extent3d,
    /// Identifies the tile currently held in the blur textures. Blurs depend
    /// only on the input pixels, so slider changes can reuse them.
    blur_cache: std::sync::Mutex<Option<BlurCacheKey>>,
    /// Mask layers last uploaded for a keyed preview input.
    mask_texture_cache: std::sync::Mutex<Option<(u64, wgpu::TextureView)>>,
    empty_mask_view: wgpu::TextureView,
    /// The last uploaded LUT; `Lut`s are shared from the loader's cache.
    lut_cache: std::sync::Mutex<Option<(Arc<Lut>, wgpu::TextureView, wgpu::Sampler)>>,
    adjustments_buffer: wgpu::Buffer,
    dummy_blur_view: wgpu::TextureView,
    dummy_lut_view: wgpu::TextureView,
    dummy_lut_sampler: wgpu::Sampler,
    ping_pong_view: wgpu::TextureView,
    sharpness_blur_view: wgpu::TextureView,
    tonal_blur_view: wgpu::TextureView,
    clarity_blur_view: wgpu::TextureView,
    structure_blur_view: wgpu::TextureView,

    pub tile_output_texture: wgpu::Texture,
    pub tile_output_texture_view: wgpu::TextureView,
    pub working_texture: wgpu::Texture,
    pub working_texture_view: wgpu::TextureView,
    pub output_texture: wgpu::Texture,
    pub output_texture_view: wgpu::TextureView,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct BlurCacheKey {
    input: u64,
    origin: (u32, u32),
    extent: (u32, u32),
    scale_bits: u32,
}

/// Display processors up to this many pixels render in one tile, so their
/// blur textures cover the whole preview and can be reused between frames.
const SINGLE_TILE_MAX_PIXELS: u64 = 3840 * 2560;

fn fits_single_tile(width: u32, height: u32, context: &GpuContext) -> bool {
    u64::from(width) * u64::from(height) <= SINGLE_TILE_MAX_PIXELS
        && width.max(height) <= context.limits.max_texture_dimension_2d
}

struct HighPrecisionTile {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

enum RenderedPixels {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

const HIGH_PRECISION_OUTPUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
const HIGH_PRECISION_OUTPUT_PIXEL_BYTES: u32 = 16;

fn high_precision_shader_source() -> Result<String, String> {
    replace_shader_token(
        include_str!("shaders/shader.wgsl"),
        "rgba8unorm, write>",
        "rgba32float, write>",
    )
}

const FLARE_MAP_SIZE: u32 = 512;

/// Four native blur passes use base radii 1, 3.5, 8 and 40 pixels at 1080px.
/// The vertical pass samples the intermediate tile, so its support must fit
/// inside the overlap as well as inside the full input image.
fn processing_tile_overlap(dimensions: (u32, u32)) -> u32 {
    ((40.0 * dimensions.0.min(dimensions.1) as f32 / 1080.0).ceil() as u32).max(128)
}

/// A mask-only flare still needs the shared flare source map. Use the upper
/// bound of enabled local contributions; the main shader weights their actual
/// influence per pixel. Global-only recipes retain exactly their old amount.
fn flare_map_amount(adjustments: &AllAdjustments) -> f32 {
    adjustments.global.flare_amount.max(0.0)
        + adjustments
            .mask_adjustments
            .iter()
            .take((adjustments.mask_count as usize).min(MAX_MASKS))
            .map(|mask| mask.flare_amount.max(0.0))
            .sum::<f32>()
}

impl GpuProcessor {
    pub fn new(context: GpuContext, max_width: u32, max_height: u32) -> Result<Self, String> {
        Self::new_with_precision(context, max_width, max_height, false)
    }

    // Keep the UI's textures and shader unchanged. The opt-in export path shares
    // the processing algorithm, but avoids quantizing input, blurs and output.
    fn new_with_precision(
        context: GpuContext,
        max_width: u32,
        max_height: u32,
        high_precision: bool,
    ) -> Result<Self, String> {
        let overlap = processing_tile_overlap((max_width, max_height));
        Self::new_with_precision_overlap(context, max_width, max_height, high_precision, overlap)
    }

    fn new_with_precision_overlap(
        context: GpuContext,
        max_width: u32,
        max_height: u32,
        high_precision: bool,
        tile_overlap: u32,
    ) -> Result<Self, String> {
        let tile_extent = 2048u32
            .checked_add(tile_overlap.checked_mul(2).ok_or("Blur overlap overflow")?)
            .ok_or("Blur tile extent overflow")?;
        if max_width.min(tile_extent) > context.limits.max_texture_dimension_2d
            || max_height.min(tile_extent) > context.limits.max_texture_dimension_2d
        {
            return Err(
                "Native blur radius exceeds the device's reusable texture dimensions".into(),
            );
        }
        let device = &context.device;
        const MAX_MASK_BINDINGS: u32 = 1;
        let output_format = if high_precision {
            wgpu::TextureFormat::Rgba32Float
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        };
        let blur_format = if high_precision {
            wgpu::TextureFormat::Rgba32Float
        } else {
            wgpu::TextureFormat::Rgba16Float
        };
        let blur_source = include_str!("shaders/blur.wgsl");
        let blur_source = if high_precision {
            replace_shader_token(blur_source, "rgba16float", "rgba32float")?
        } else {
            blur_source.to_owned()
        };

        let blur_shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blur Shader"),
            source: wgpu::ShaderSource::Wgsl(blur_source.into()),
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
                        format: blur_format,
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

        let blur_params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Blur Params Buffer"),
            size: std::mem::size_of::<BlurParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let flare_source = include_str!("shaders/flare.wgsl");
        let flare_source = if high_precision {
            // rgba32float is intentionally unfilterable: manual bilinear
            // sampling avoids requiring optional FLOAT32_FILTERABLE support.
            let source = replace_shader_token(
                flare_source,
                "textureSampleLevel(input_texture, input_sampler, uv, 0.0)",
                "sample_input_bilinear(uv)",
            )?;
            format!("{}\n{source}", include_str!("shaders/export_sampling.wgsl"))
        } else {
            flare_source.to_owned()
        };
        let flare_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Flare Shader"),
            source: wgpu::ShaderSource::Wgsl(flare_source.into()),
        });

        let flare_bgl_0 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Flare BGL 0"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float {
                            filterable: !high_precision,
                        },
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

        let main_source = include_str!("shaders/shader.wgsl");
        let main_source = if high_precision {
            let source = replace_shader_token(main_source, "rgba8unorm", "rgba32float")?;
            let source = replace_shader_token(
                &source,
                "let dither_amount = 1.0 / 255.0;",
                "let dither_amount = 1.0 / 65535.0;",
            )?;
            // A detail crop should match the same pixels in a full export.
            replace_shader_token(&source, "dither(id.xy)", "dither(absolute_coord)")?
        } else {
            main_source.to_owned()
        };
        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Image Processing Shader"),
            source: wgpu::ShaderSource::Wgsl(main_source.into()),
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
                    format: output_format,
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

        let main_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Main BGL"),
            entries: &bind_group_layout_entries,
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Pipeline Layout"),
            bind_group_layouts: &[Some(&main_bgl)],
            immediate_size: 0,
        });

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
            format: HIGH_PRECISION_OUTPUT_FORMAT,
            view_dimension: wgpu::TextureViewDimension::D2,
        };
        let high_precision_bgl =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("High Precision Main BGL"),
                entries: &bind_group_layout_entries,
            });
        let high_precision_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("High Precision Pipeline Layout"),
                bind_group_layouts: &[Some(&high_precision_bgl)],
                immediate_size: 0,
            });
        let high_precision_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("High Precision Image Processing Shader"),
            source: wgpu::ShaderSource::Wgsl(high_precision_shader_source()?.into()),
        });
        let high_precision_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("High Precision Compute Pipeline"),
                layout: Some(&high_precision_pipeline_layout),
                module: &high_precision_shader,
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[("HIGH_PRECISION_OUTPUT", 1.0)],
                    ..Default::default()
                },
                cache: None,
            });

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
        let empty_mask_view = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Empty Mask Texture Array"),
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

        let single_tile = !high_precision && fits_single_tile(max_width, max_height, &context);
        let (clamped_tile_width, clamped_tile_height) = if single_tile {
            (max_width, max_height)
        } else {
            (max_width.min(tile_extent), max_height.min(tile_extent))
        };

        let clamped_tile_size = wgpu::Extent3d {
            width: clamped_tile_width,
            height: clamped_tile_height,
            depth_or_array_layers: 1,
        };

        let full_image_size = wgpu::Extent3d {
            // Export reads tiles directly and never uses display textures.
            width: if high_precision { 1 } else { max_width },
            height: if high_precision { 1 } else { max_height },
            depth_or_array_layers: 1,
        };

        let reusable_texture_desc = wgpu::TextureDescriptor {
            label: None,
            size: clamped_tile_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: blur_format,
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
            format: output_format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let tile_output_texture_view = tile_output_texture.create_view(&Default::default());

        let working_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Working Output Texture"),
            size: full_image_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let working_texture_view = working_texture.create_view(&Default::default());

        let output_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Full Output Texture"),
            size: full_image_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let output_texture_view = output_texture.create_view(&Default::default());

        Ok(Self {
            context,
            high_precision,
            tile_overlap,
            blur_bgl,
            h_blur_pipeline,
            v_blur_pipeline,
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
            main_bgl,
            main_pipeline,
            high_precision_bgl,
            high_precision_pipeline,
            high_precision_tile: std::sync::OnceLock::new(),
            tile_output_size: clamped_tile_size,
            blur_cache: std::sync::Mutex::new(None),
            mask_texture_cache: std::sync::Mutex::new(None),
            empty_mask_view,
            lut_cache: std::sync::Mutex::new(None),
            adjustments_buffer,
            dummy_blur_view,
            dummy_lut_view,
            dummy_lut_sampler,
            ping_pong_view,
            sharpness_blur_view,
            tonal_blur_view,
            clarity_blur_view,
            structure_blur_view,
            tile_output_texture,
            tile_output_texture_view,
            working_texture,
            working_texture_view,
            output_texture,
            output_texture_view,
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
                    format: HIGH_PRECISION_OUTPUT_FORMAT,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::STORAGE_BINDING
                        | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
            let view = texture.create_view(&Default::default());
            HighPrecisionTile { texture, view }
        })
    }

    fn renders_single_tile(&self, width: u32, height: u32) -> bool {
        width <= self.tile_output_size.width && height <= self.tile_output_size.height
    }

    /// Returns the mask layers for `request`. A keyed preview reuses its last
    /// upload while only slider values change; without masks the shader never
    /// samples the array, so a shared placeholder replaces a full-size upload.
    fn mask_texture_view(
        &self,
        request: &RenderRequest,
        width: u32,
        height: u32,
        key: Option<(u64, u64)>,
    ) -> wgpu::TextureView {
        if request.mask_bitmaps.is_empty() && request.adjustments.mask_count == 0 {
            return self.empty_mask_view.clone();
        }
        let layer_count = request.mask_bitmaps.len().clamp(2, MAX_MASKS) as u32;
        let key = key.map(|key| {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (key, width, height, layer_count).hash(&mut hasher);
            hasher.finish()
        });
        let mut cache = self
            .mask_texture_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let (Some(key), Some((cached_key, view))) = (key, cache.as_ref())
            && key == *cached_key
        {
            return view.clone();
        }

        let device = &self.context.device;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Full Mask Texture Array"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: layer_count,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // Layers without a bitmap keep wgpu's zero initialization.
        for (layer, mask) in request.mask_bitmaps.iter().take(MAX_MASKS).enumerate() {
            self.context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: layer as u32,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                mask.as_raw(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(width),
                    rows_per_image: Some(height),
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        *cache = key.map(|key| (key, view.clone()));
        view
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        input_texture_view: &wgpu::TextureView,
        input_key: Option<u64>,
        mask_key: Option<u64>,
        width: u32,
        height: u32,
        request: RenderRequest,
        output_to_display: bool,
        output_precision: RenderOutputPrecision,
        cancellation: Option<&PreviewCancellation<'_>>,
    ) -> Result<(RenderedPixels, u32, u32, u32, u32), String> {
        if let Some(cancel) = cancellation {
            cancel.check()?;
        }
        let device = &self.context.device;
        let queue = &self.context.queue;
        let effect_width = if request.adjustments.image_width > 0 {
            request.adjustments.image_width
        } else {
            width
        };
        let effect_height = if request.adjustments.image_height > 0 {
            request.adjustments.image_height
        } else {
            height
        };
        let scale = (effect_width.min(effect_height) as f32) / 1080.0;
        if processing_tile_overlap((effect_width, effect_height)) > self.tile_overlap {
            return Err(
                "Native processor must be recreated for the larger full-image blur radius".into(),
            );
        }
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
        let (output_pipeline, output_bgl, output_tile_texture, output_tile_view, bytes_per_pixel) =
            if let Some(high_precision_tile) = high_precision_tile {
                (
                    &self.high_precision_pipeline,
                    &self.high_precision_bgl,
                    &high_precision_tile.texture,
                    &high_precision_tile.view,
                    HIGH_PRECISION_OUTPUT_PIXEL_BYTES,
                )
            } else {
                (
                    &self.main_pipeline,
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
            self.mask_texture_view(&request, width, height, input_key.zip(mask_key));
        if let Some(cancel) = cancellation {
            cancel.check()?;
        }

        let mut lut_cache = self.lut_cache.lock().unwrap_or_else(|e| e.into_inner());
        let (lut_texture_view, lut_sampler) = if let Some(lut_arc) = &request.lut
            && let Some((cached, view, sampler)) = lut_cache.as_ref()
            && Arc::ptr_eq(cached, lut_arc)
        {
            (view.clone(), sampler.clone())
        } else if let Some(lut_arc) = &request.lut {
            let lut_data = &lut_arc.data;
            let size = lut_arc.size;
            let mut rgba_lut_data = Vec::with_capacity(lut_data.len() / 3 * 4);
            for chunk in lut_data.as_chunks::<3>().0 {
                rgba_lut_data.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 1.0]);
            }
            let (lut_format, lut_bytes) = if self.high_precision {
                (
                    wgpu::TextureFormat::Rgba32Float,
                    bytemuck::cast_slice(&rgba_lut_data).to_vec(),
                )
            } else {
                let rgba_f16: Vec<f16> = rgba_lut_data.into_iter().map(f16::from_f32).collect();
                (
                    wgpu::TextureFormat::Rgba16Float,
                    bytemuck::cast_slice(&rgba_f16).to_vec(),
                )
            };
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
                    format: lut_format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                },
                TextureDataOrder::MipMajor,
                &lut_bytes,
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
            *lut_cache = Some((Arc::clone(lut_arc), view.clone(), sampler.clone()));
            (view, sampler)
        } else {
            (self.dummy_lut_view.clone(), self.dummy_lut_sampler.clone())
        };
        drop(lut_cache);

        let adjustments = request.adjustments;
        let flare_amount = flare_map_amount(&adjustments);
        if flare_amount > 0.0 && adjustments.precomputed_flare == 0 {
            let mut encoder = device.create_command_encoder(&Default::default());

            let aspect_ratio = if effect_height > 0 {
                effect_width as f32 / effect_height as f32
            } else {
                1.0
            };
            let f_params = FlareParams {
                amount: flare_amount,
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

            if let Some(cancel) = cancellation {
                cancel.check()?;
            }
            queue.submit(Some(encoder.finish()));
        }

        const TILE_SIZE: u32 = 2048;
        let overlap = self.tile_overlap;
        let (tile_size_x, tile_size_y) = if self.renders_single_tile(width, height) {
            (width, height)
        } else {
            (TILE_SIZE, TILE_SIZE)
        };
        let single_tile = tile_size_x == width && tile_size_y == height;
        let mut blur_cache = self.blur_cache.lock().unwrap_or_else(|e| e.into_inner());

        let output_len = if output_to_display {
            0
        } else {
            usize::try_from(u64::from(out_width) * u64::from(out_height) * 4)
                .map_err(|_| "Output image exceeds host allocation limits")?
        };
        let mut final_pixels = match output_precision {
            RenderOutputPrecision::EightBit => RenderedPixels::U8(vec![0u8; output_len]),
            RenderOutputPrecision::SixteenBit => RenderedPixels::U16(vec![0u16; output_len]),
        };

        let start_tile_x = bounds.x / tile_size_x;
        let start_tile_y = bounds.y / tile_size_y;
        let end_tile_x = (bounds.x + bounds.width).div_ceil(tile_size_x);
        let end_tile_y = (bounds.y + bounds.height).div_ceil(tile_size_y);

        for tile_y in start_tile_y..end_tile_y {
            for tile_x in start_tile_x..end_tile_x {
                if let Some(cancel) = cancellation {
                    cancel.check()?;
                }
                let x_start_unclamped = tile_x * tile_size_x;
                let y_start_unclamped = tile_y * tile_size_y;

                let x_start = x_start_unclamped.max(bounds.x);
                let y_start = y_start_unclamped.max(bounds.y);
                let x_end = (x_start_unclamped + tile_size_x)
                    .min(bounds.x + bounds.width)
                    .min(width);
                let y_end = (y_start_unclamped + tile_size_y)
                    .min(bounds.y + bounds.height)
                    .min(height);

                let tile_width = x_end - x_start;
                let tile_height = y_end - y_start;

                let input_x_start = x_start.saturating_sub(overlap);
                let input_y_start = y_start.saturating_sub(overlap);
                let input_x_end = (x_end + overlap).min(width);
                let input_y_end = (y_end + overlap).min(height);
                let input_width = input_x_end - input_x_start;
                let input_height = input_y_end - input_y_start;

                let input_texture_size = wgpu::Extent3d {
                    width: input_width,
                    height: input_height,
                    depth_or_array_layers: 1,
                };

                let run_blur = |base_radius: f32, output_view: &wgpu::TextureView| -> bool {
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

                    {
                        let mut cpass = blur_encoder.begin_compute_pass(&Default::default());
                        cpass.set_pipeline(&self.h_blur_pipeline);
                        cpass.set_bind_group(0, &h_blur_bg, &[]);
                        cpass.dispatch_workgroups(input_width.div_ceil(256), input_height, 1);
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
                        cpass.set_pipeline(&self.v_blur_pipeline);
                        cpass.set_bind_group(0, &v_blur_bg, &[]);
                        cpass.dispatch_workgroups(input_width, input_height.div_ceil(256), 1);
                    }

                    queue.submit(Some(blur_encoder.finish()));
                    true
                };

                let tile_key = input_key.filter(|_| single_tile).map(|input| BlurCacheKey {
                    input,
                    origin: (input_x_start, input_y_start),
                    extent: (input_width, input_height),
                    scale_bits: scale.to_bits(),
                });
                let (
                    did_create_sharpness_blur,
                    did_create_tonal_blur,
                    did_create_clarity_blur,
                    did_create_structure_blur,
                ) = if tile_key.is_some() && *blur_cache == tile_key {
                    (true, true, true, true)
                } else {
                    // Clear first: a cancelled pass must not leave a stale key.
                    *blur_cache = None;
                    let sharpness = run_blur(1.0, &self.sharpness_blur_view);
                    if let Some(cancel) = cancellation {
                        cancel.check()?;
                    }
                    let tonal = run_blur(3.5, &self.tonal_blur_view);
                    if let Some(cancel) = cancellation {
                        cancel.check()?;
                    }
                    let clarity = run_blur(8.0, &self.clarity_blur_view);
                    if let Some(cancel) = cancellation {
                        cancel.check()?;
                    }
                    let structure = run_blur(40.0, &self.structure_blur_view);
                    if let Some(cancel) = cancellation {
                        cancel.check()?;
                    }
                    *blur_cache = tile_key;
                    (sharpness, tonal, clarity, structure)
                };

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

                let use_flare = flare_amount > 0.0;
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

                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Tile Bind Group"),
                    layout: output_bgl,
                    entries: &bind_group_entries,
                });

                {
                    let mut compute_pass = main_encoder.begin_compute_pass(&Default::default());
                    compute_pass.set_pipeline(output_pipeline);
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
                            texture: &self.working_texture,
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

                if let Some(cancel) = cancellation {
                    cancel.check()?;
                }
                queue.submit(Some(main_encoder.finish()));

                if !output_to_display {
                    let processed_tile_data = read_texture_data_roi(
                        device,
                        queue,
                        output_tile_texture,
                        wgpu::Origin3d::ZERO,
                        input_texture_size,
                        bytes_per_pixel,
                    )?;
                    if let Some(cancel) = cancellation {
                        cancel.check()?;
                    }

                    match &mut final_pixels {
                        RenderedPixels::U8(final_pixels) => {
                            for row in 0..tile_height {
                                let final_y = y_start + row - bounds.y;
                                let final_x = x_start - bounds.x;
                                let final_row_offset = (final_y * out_width + final_x) as usize * 4;
                                let source_y = crop_y_start + row;
                                let source_row_offset =
                                    (source_y * input_width + crop_x_start) as usize * 4;
                                let copy_bytes = (tile_width * 4) as usize;

                                final_pixels[final_row_offset..final_row_offset + copy_bytes]
                                    .copy_from_slice(
                                        &processed_tile_data
                                            [source_row_offset..source_row_offset + copy_bytes],
                                    );
                            }
                        }
                        RenderedPixels::U16(final_pixels) => {
                            copy_f32_tile_to_u16(
                                &processed_tile_data,
                                (input_width, input_height),
                                (crop_x_start, crop_y_start),
                                (tile_width, tile_height),
                                final_pixels,
                                (out_width, out_height),
                                (x_start - bounds.x, y_start - bounds.y),
                            )?;
                        }
                    }
                }
            }
        }

        Ok((final_pixels, out_width, out_height, bounds.x, bounds.y))
    }
}

fn decode_output_f32(bytes: &[u8]) -> u16 {
    let value = f32::from_ne_bytes(bytes.try_into().expect("one f32 channel"));
    if value.is_finite() {
        (value.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16
    } else {
        0
    }
}

fn copy_f32_tile_to_u16(
    source: &[u8],
    source_size: (u32, u32),
    crop_origin: (u32, u32),
    crop_size: (u32, u32),
    destination: &mut [u16],
    destination_size: (u32, u32),
    destination_origin: (u32, u32),
) -> Result<(), String> {
    let fits = |origin: (u32, u32), size: (u32, u32), extent: (u32, u32)| {
        origin
            .0
            .checked_add(size.0)
            .is_some_and(|end| end <= extent.0)
            && origin
                .1
                .checked_add(size.1)
                .is_some_and(|end| end <= extent.1)
    };
    let source_samples = u64::from(source_size.0) * u64::from(source_size.1) * 4;
    let destination_samples = u64::from(destination_size.0) * u64::from(destination_size.1) * 4;
    if !fits(crop_origin, crop_size, source_size)
        || !fits(destination_origin, crop_size, destination_size)
        || source.len() as u64 != source_samples * 4
        || destination.len() as u64 != destination_samples
    {
        return Err("Float32 output tile dimensions or readback length are invalid".into());
    }
    for row in 0..crop_size.1 {
        let source_pixel =
            u64::from(crop_origin.1 + row) * u64::from(source_size.0) + u64::from(crop_origin.0);
        let destination_pixel = u64::from(destination_origin.1 + row)
            * u64::from(destination_size.0)
            + u64::from(destination_origin.0);
        for sample in 0..u64::from(crop_size.0) * 4 {
            let at = ((source_pixel * 4 + sample) * 4) as usize;
            destination[(destination_pixel * 4 + sample) as usize] =
                decode_output_f32(&source[at..at + 4]);
        }
    }
    Ok(())
}

/// Render an export without the preview pipeline's half-float input or 8-bit
/// output bottleneck. Input, tonal blur and main output use 32-bit floats; the
/// final sRGB pixels are quantized once to RGBA16 for PNG/TIFF encoding.
///
/// This opt-in path does not touch the UI processor/image cache or its display.
/// Flare's low-resolution effect maps and mask coverage retain their native
/// formats. Callers must encode this image as 16-bit to retain the precision.
pub fn process_and_get_dynamic_image_high_precision(
    context: &GpuContext,
    base_image: &DynamicImage,
    request: RenderRequest,
) -> Result<DynamicImage, String> {
    let (width, height) = base_image.dimensions();
    validate_precision_request(width, height, u32::MAX, &request)?;
    high_precision_render_preflight((width, height), &request.adjustments, context)?;
    let allocation_scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = context.device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let result = if width > context.limits.max_texture_dimension_2d
        || height > context.limits.max_texture_dimension_2d
    {
        render_streamed_precision(context, base_image, request, 4096)
    } else {
        render_high_precision(context, base_image, request)
    };
    // Always drain every scope, including after a CPU-side validation failure.
    let validation_error = pollster::block_on(validation_scope.pop());
    let internal_error = pollster::block_on(internal_scope.pop());
    let allocation_error = pollster::block_on(allocation_scope.pop());
    if let Some(error) = validation_error.or(internal_error).or(allocation_error) {
        return Err(format!("High-precision GPU render failed: {error}"));
    }
    result
}

fn render_high_precision(
    context: &GpuContext,
    base_image: &DynamicImage,
    request: RenderRequest,
) -> Result<DynamicImage, String> {
    let (width, height) = base_image.dimensions();
    let processor = GpuProcessor::new_with_precision(context.clone(), width, height, true)?;
    render_precision_with_processor(context, &processor, base_image, request)
}

fn render_precision_with_processor(
    context: &GpuContext,
    processor: &GpuProcessor,
    base_image: &DynamicImage,
    request: RenderRequest,
) -> Result<DynamicImage, String> {
    let (width, height) = base_image.dimensions();
    let input = base_image.to_rgba32f();
    if input.as_raw().iter().any(|channel| !channel.is_finite()) {
        return Err("Input image contains non-finite pixels".to_string());
    }
    let texture = context.device.create_texture_with_data(
        &context.queue,
        &wgpu::TextureDescriptor {
            label: Some("High-Precision Export Input"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        TextureDataOrder::MipMajor,
        bytemuck::cast_slice(input.as_raw()),
    );
    drop(input);
    let view = texture.create_view(&Default::default());
    let (pixels, out_width, out_height, _, _) = processor.run(
        &view,
        None,
        None,
        width,
        height,
        request,
        false,
        RenderOutputPrecision::SixteenBit,
        None,
    )?;
    match pixels {
        RenderedPixels::U16(data) => {
            let img_buf = ImageBuffer::<Rgba<u16>, Vec<u16>>::from_raw(out_width, out_height, data)
                .ok_or("Failed to create 16-bit image buffer from GPU data")?;
            Ok(DynamicImage::ImageRgba16(img_buf))
        }
        RenderedPixels::U8(_) => Err("High-precision render returned 8-bit pixels".to_string()),
    }
}

/// Validate the exact bounded input tile allocation used by native rendering.
/// `None` means a full input texture fits; a tuple is (halo, default core).
pub(crate) fn high_precision_render_preflight(
    dimensions: (u32, u32),
    adjustments: &AllAdjustments,
    context: &GpuContext,
) -> Result<Option<(u32, u32)>, String> {
    let (width, height) = dimensions;
    let limit = context.limits.max_texture_dimension_2d;
    if width == 0 || height == 0 {
        return Err("Image dimensions must be nonzero".into());
    }
    if width <= limit && height <= limit {
        return Ok(None);
    }
    streaming_tile_plan(dimensions, adjustments, limit).map(Some)
}

fn streaming_tile_plan(
    dimensions: (u32, u32),
    adjustments: &AllAdjustments,
    limit: u32,
) -> Result<(u32, u32), String> {
    let (width, height) = dimensions;
    if u64::from(width) * u64::from(height) > 100_000_000 {
        return Err("Streamed native rendering is limited to 100 megapixels per image".into());
    }
    let scale = width.min(height) as f32 / 1080.0;
    let ca = adjustments
        .global
        .chromatic_aberration_red_cyan
        .abs()
        .max(adjustments.global.chromatic_aberration_blue_yellow.abs());
    let radius = (40.0 * scale)
        .ceil()
        .max(width.max(height) as f32 * ca)
        .max(32.0) as u32;
    let halo = radius
        .div_ceil(2048)
        .checked_mul(2048)
        .ok_or("Effect radius exceeds tile limits")?;
    let margin = halo
        .checked_mul(2)
        .and_then(|v| v.checked_add(2048))
        .ok_or("Effect radius exceeds tile limits")?;
    if margin > limit {
        return Err("Required effect halo exceeds GPU tile limits; reduce spatial effect radius or use a smaller image".into());
    }
    let core = 4096.min((limit - halo * 2) / 2048 * 2048);
    Ok((halo, core))
}

/// Keep input/mask textures within device limits. The shader receives the real
/// image extent/origin so grain, vignette, CA, mask coordinates and effect scale
/// remain continuous. Overlapping windows align with the native 2048px grid.
fn render_streamed_precision(
    context: &GpuContext,
    source: &DynamicImage,
    request: RenderRequest,
    requested_core: u32,
) -> Result<DynamicImage, String> {
    let (width, height) = source.dimensions();
    let (halo, default_core) = streaming_tile_plan(
        (width, height),
        &request.adjustments,
        context.limits.max_texture_dimension_2d,
    )?;
    let core = requested_core.max(2048).min(default_core);
    let bounds = request.roi.unwrap_or(Roi {
        x: 0,
        y: 0,
        width,
        height,
    });
    let processor = GpuProcessor::new_with_precision_overlap(
        context.clone(),
        (core + halo * 2).min(width),
        (core + halo * 2).min(height),
        true,
        processing_tile_overlap((width, height)),
    )?;
    let flare_amount = flare_map_amount(&request.adjustments);
    if flare_amount > 0.0 {
        // The native flare threshold samples a fixed 512x512 map. Reproduce its
        // bilinear samples in float32, then reuse one global flare map for tiles.
        let input = source.to_rgba32f();
        let sampled = ImageBuffer::from_fn(FLARE_MAP_SIZE, FLARE_MAP_SIZE, |x, y| {
            let sx = (x as f32 + 0.5) / FLARE_MAP_SIZE as f32 * width as f32 - 0.5;
            let sy = (y as f32 + 0.5) / FLARE_MAP_SIZE as f32 * height as f32 - 0.5;
            let ix = sx.floor();
            let iy = sy.floor();
            let fx = sx - ix;
            let fy = sy - iy;
            let mut channels = [0.0; 4];
            for (c, value) in channels.iter_mut().enumerate() {
                let pixel = |dx: f32, dy: f32| {
                    input
                        .get_pixel(
                            (ix + dx).clamp(0.0, width as f32 - 1.0) as u32,
                            (iy + dy).clamp(0.0, height as f32 - 1.0) as u32,
                        )
                        .0[c]
                };
                *value = (pixel(0.0, 0.0) * (1.0 - fx) + pixel(1.0, 0.0) * fx) * (1.0 - fy)
                    + (pixel(0.0, 1.0) * (1.0 - fx) + pixel(1.0, 1.0) * fx) * fy;
            }
            Rgba(channels)
        });
        drop(input);
        let mut adjustments = request.adjustments;
        adjustments.image_width = width;
        adjustments.image_height = height;
        adjustments.global.flare_amount = flare_amount;
        adjustments.mask_count = 0;
        render_precision_with_processor(
            context,
            &processor,
            &DynamicImage::ImageRgba32F(sampled),
            RenderRequest {
                adjustments,
                mask_bitmaps: &[],
                lut: request.lut.clone(),
                roi: Some(Roi {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                }),
            },
        )?;
    }
    let mut output = ImageBuffer::<Rgba<u16>, Vec<u16>>::new(bounds.width, bounds.height);
    let end_x = bounds.x + bounds.width;
    let end_y = bounds.y + bounds.height;
    for gy in (bounds.y / core * core..end_y).step_by(core as usize) {
        for gx in (bounds.x / core * core..end_x).step_by(core as usize) {
            let ox = gx.saturating_sub(halo);
            let oy = gy.saturating_sub(halo);
            let ex = (gx + core + halo).min(width);
            let ey = (gy + core + halo).min(height);
            let x = gx.max(bounds.x);
            let y = gy.max(bounds.y);
            let w = (gx + core).min(end_x) - x;
            let h = (gy + core).min(end_y) - y;
            let tile = source.crop_imm(ox, oy, ex - ox, ey - oy);
            let masks = request
                .mask_bitmaps
                .iter()
                .map(|mask| image::imageops::crop_imm(mask, ox, oy, ex - ox, ey - oy).to_image())
                .collect::<Vec<_>>();
            let mut adjustments = request.adjustments;
            adjustments.image_width = width;
            adjustments.image_height = height;
            adjustments.image_origin_x = ox;
            adjustments.image_origin_y = oy;
            adjustments.precomputed_flare = 1;
            let rendered = render_precision_with_processor(
                context,
                &processor,
                &tile,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: &masks,
                    lut: request.lut.clone(),
                    roi: Some(Roi {
                        x: x - ox,
                        y: y - oy,
                        width: w,
                        height: h,
                    }),
                },
            )?
            .to_rgba16();
            image::imageops::replace(
                &mut output,
                &rendered,
                i64::from(x - bounds.x),
                i64::from(y - bounds.y),
            );
        }
    }
    Ok(DynamicImage::ImageRgba16(output))
}

fn validate_precision_request(
    width: u32,
    height: u32,
    max_dimension: u32,
    request: &RenderRequest,
) -> Result<(), String> {
    if width == 0 || height == 0 || width > max_dimension || height > max_dimension {
        return Err(format!(
            "Image dimensions {width}x{height} are outside GPU limits (1..={max_dimension})"
        ));
    }
    if let Some(roi) = request.roi
        && (roi.width == 0
            || roi.height == 0
            || roi.x.checked_add(roi.width).is_none_or(|end| end > width)
            || roi.y.checked_add(roi.height).is_none_or(|end| end > height))
    {
        return Err("Render region must be nonempty and inside the image".to_string());
    }
    if request.mask_bitmaps.len() != request.adjustments.mask_count as usize
        || request.mask_bitmaps.len() > MAX_MASKS
        || request
            .mask_bitmaps
            .iter()
            .any(|mask| mask.dimensions() != (width, height))
    {
        return Err(
            "Every enabled mask requires a matching bitmap at the image dimensions".to_string(),
        );
    }
    Ok(())
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
        false,
        None,
        None,
        false,
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
        false,
        None,
        None,
        false,
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
    output_to_display: bool,
    analytics_config: Option<crate::AnalyticsConfig>,
    preview_identity: Option<PreviewIdentity>,
    mask_key: Option<u64>,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        base_image,
        transform_hash,
        request,
        caller_id,
        RenderOutputPrecision::EightBit,
        output_to_display,
        analytics_config,
        preview_identity,
        true,
        mask_key,
    )
}

fn ordinary_texture_extent(
    width: u32,
    height: u32,
    limit: u32,
    request: &RenderRequest,
) -> Result<(u32, u32), String> {
    validate_precision_request(width, height, u32::MAX, request)?;
    let rounded = |value: u32| value.checked_add(255).map(|v| v & !255);
    let (Some(rounded_width), Some(rounded_height)) = (rounded(width), rounded(height)) else {
        return Err(format!(
            "GPU render cannot process {width}x{height}; maximum texture dimension is {limit}. Use a supported image size or a high-precision tiled final export."
        ));
    };
    if width == 0 || height == 0 || rounded_width > limit || rounded_height > limit {
        return Err(format!(
            "GPU render cannot process {width}x{height}; maximum texture dimension is {limit} (including 256-pixel allocation alignment). Use a supported image size or a high-precision tiled final export."
        ));
    }
    Ok((rounded_width, rounded_height))
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
    output_to_display: bool,
    analytics_config: Option<crate::AnalyticsConfig>,
    preview_identity: Option<PreviewIdentity>,
    retain_input: bool,
    mask_key: Option<u64>,
) -> Result<DynamicImage, String> {
    let start_time = Instant::now();
    let cancellation = preview_identity.map(|identity| PreviewCancellation { state, identity });
    if let Some(cancel) = &cancellation {
        cancel.check()?;
    }
    let (width, height) = base_image.dimensions();
    let device = &context.device;
    let queue = &context.queue;

    let max_dim = context.limits.max_texture_dimension_2d;
    let (new_width, new_height) = ordinary_texture_extent(width, height, max_dim, &request)?;

    let mut processor_lock = match state.gpu_processor.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("GPU processor lock was poisoned. Resetting to self-heal.");
            let mut guard = poisoned.into_inner();
            *guard = None;
            guard
        }
    };
    if let Some(cancel) = &cancellation {
        cancel.check()?;
    }
    let mut needs_new_processor = false;

    if let Some(p) = processor_lock.as_ref() {
        if p.width < width || p.height < height {
            needs_new_processor = true;
        } else if retain_input
            && !p.processor.renders_single_tile(width, height)
            && fits_single_tile(new_width, new_height, context)
        {
            // A larger render (such as 100% zoom or an export) left a tiled
            // processor. Rebuild so the preview regains its cached blurs.
            needs_new_processor = true;
        }
    } else {
        needs_new_processor = true;
    }

    if needs_new_processor {
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

    let mut cache_lock = state
        .gpu_image_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(cancel) = &cancellation {
        cancel.check()?;
    }
    let is_input = |cache: &GpuImageCache| {
        cache.transform_hash == transform_hash && cache.width == width && cache.height == height
    };
    let cache_hit = cache_lock.get(is_input).is_some();

    // Only the editor preview retains its input. Thumbnails and exports upload
    // a transient texture so they never evict the image being edited.
    let transient_input;
    let (input_view, input_key) = if cache_hit {
        let cache = cache_lock.get(is_input).unwrap();
        (&cache.texture_view, Some(cache.id))
    } else {
        let img_rgba_f16 = to_rgba_f16(base_image);
        if let Some(cancel) = &cancellation {
            cancel.check()?;
        }
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("Input Texture"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
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
        let texture_view = texture.create_view(&Default::default());
        if retain_input {
            static NEXT_INPUT_ID: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(1);
            let id = NEXT_INPUT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let cache = cache_lock.insert(
                GpuImageCache {
                    texture,
                    texture_view,
                    width,
                    height,
                    transform_hash,
                    id,
                },
                is_input,
            );
            (&cache.texture_view, Some(id))
        } else {
            transient_input = (texture, texture_view);
            (&transient_input.1, None)
        }
    };

    let skip_readback = output_to_display;

    let (processed_pixels, out_w, out_h, out_x, out_y) = processor.run(
        input_view,
        input_key,
        mask_key,
        width,
        height,
        request,
        output_to_display,
        output_precision,
        cancellation.as_ref(),
    )?;
    if let Some(cancel) = &cancellation {
        cancel.check()?;
    }

    let mut final_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Final Passes Encoder"),
    });
    let mut submit_final_encoder = false;

    let mut async_readback_buffer: Option<wgpu::Buffer> = None;
    let mut async_padded_bpr: u32 = 0;
    let mut async_unpadded_bpr: u32 = 0;

    if analytics_config.is_some() && skip_readback {
        let unpadded_bytes_per_row = 4 * out_w;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) & !(align - 1);
        let output_buffer_size = (padded_bytes_per_row * out_h) as u64;

        let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Async Analytics Readback Buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        final_encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &processor.working_texture,
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
        async_unpadded_bpr = unpadded_bytes_per_row;
        submit_final_encoder = true;
    }

    if output_to_display {
        final_encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &processor.working_texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: out_x,
                    y: out_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &processor.output_texture,
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

    // The working texture may hold obsolete pixels after a superseded tile
    // run. Only copy it into the displayed texture, submit that copy, and
    // present while this revision still owns the main lane. The intent lock
    // makes the final check atomic with the copy/presentation submission;
    // queued GPU work itself remains ordered on the same queue.
    let submit_and_display = || {
        if submit_final_encoder {
            queue.submit(Some(final_encoder.finish()));
        }

        if output_to_display
            && let Some(display) = context
                .display
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
        {
            display.latest_transform.image_size = [width as f32, height as f32];
            display.latest_transform.texture_size =
                [processor_state.width as f32, processor_state.height as f32];

            queue.write_buffer(
                &display.transform_buffer,
                0,
                bytemuck::bytes_of(&display.latest_transform),
            );

            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &display.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: display.transform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            &processor.output_texture_view,
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&display.sampler),
                    },
                ],
                label: None,
            });
            display.current_bind_group = Some(bind_group);
            display.frame_generation = preview_identity.map(|identity| identity.generation);
            display.render(device, queue);
            static REMAINING_PRESENT_TRACES: std::sync::atomic::AtomicUsize =
                std::sync::atomic::AtomicUsize::new(10_000);
            if std::env::var_os("RAPIDRAW_PREVIEW_TRACE").as_deref()
                == Some(std::ffi::OsStr::new("1"))
                && REMAINING_PRESENT_TRACES
                    .fetch_update(
                        std::sync::atomic::Ordering::Relaxed,
                        std::sync::atomic::Ordering::Relaxed,
                        |n| n.checked_sub(1),
                    )
                    .is_ok()
            {
                log::info!(
                    "[preview_trace] surface_present_called generation={:?} revision={:?} size={}x{} processing_to_submit_ms={:.2}",
                    preview_identity.map(|identity| identity.generation),
                    preview_identity.and_then(|identity| identity.revision),
                    width,
                    height,
                    start_time.elapsed().as_secs_f64() * 1000.0,
                );
            }
        }
    };
    submit_current_preview_display(state, preview_identity, submit_and_display)?;

    if let Some(analytics) = analytics_config {
        if let Some(buffer) = async_readback_buffer {
            let output_buffer: wgpu::Buffer = buffer;
            let padded_bytes_per_row: u32 = async_padded_bpr;
            let unpadded_bytes_per_row: u32 = async_unpadded_bpr;
            let device_clone = context.device.clone();

            std::thread::spawn(move || {
                let buffer_slice = output_buffer.slice(..);
                let (tx, rx) = std::sync::mpsc::channel::<Result<(), wgpu::BufferAsyncError>>();

                buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
                    let _ = tx.send(result);
                });

                if let Err(e) = device_clone.poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(60)),
                }) {
                    log::error!("Async analytics readback poll failed: {}", e);
                    return;
                }

                if let Ok(Ok(())) = rx.recv() {
                    let padded_data = buffer_slice.get_mapped_range().to_vec();
                    output_buffer.unmap();

                    let mut unpadded_data =
                        Vec::with_capacity((unpadded_bytes_per_row * out_h) as usize);
                    if padded_bytes_per_row == unpadded_bytes_per_row {
                        unpadded_data = padded_data;
                    } else {
                        for chunk in padded_data.chunks(padded_bytes_per_row as usize) {
                            unpadded_data
                                .extend_from_slice(&chunk[..unpadded_bytes_per_row as usize]);
                        }
                    }

                    if let Some(img_buf) =
                        ImageBuffer::<Rgba<u8>, _>::from_raw(out_w, out_h, unpadded_data)
                    {
                        let dynamic_img = DynamicImage::ImageRgba8(img_buf);
                        let _ = analytics.sender.send(crate::AnalyticsJob {
                            generation: analytics.generation,
                            input_revision: analytics.input_revision,
                            render_attempt: analytics.render_attempt,
                            quality_tier: analytics.quality_tier,
                            path: analytics.path,
                            image: std::sync::Arc::new(dynamic_img),
                            compute_waveform: analytics.compute_waveform,
                            active_waveform_channel: analytics.active_waveform_channel,
                        });
                    }
                }
            });
        } else {
            if let RenderedPixels::U8(pixels) = &processed_pixels {
                let pixels_clone = pixels.clone();
                std::thread::spawn(move || {
                    if let Some(img_buf) =
                        ImageBuffer::<Rgba<u8>, _>::from_raw(out_w, out_h, pixels_clone)
                    {
                        let dynamic_img = DynamicImage::ImageRgba8(img_buf);
                        let _ = analytics.sender.send(crate::AnalyticsJob {
                            generation: analytics.generation,
                            input_revision: analytics.input_revision,
                            render_attempt: analytics.render_attempt,
                            quality_tier: analytics.quality_tier,
                            path: analytics.path,
                            image: std::sync::Arc::new(dynamic_img),
                            compute_waveform: analytics.compute_waveform,
                            active_waveform_channel: analytics.active_waveform_channel,
                        });
                    }
                });
            } else {
                log::warn!("Skipping analytics for a high-precision CPU readback");
            }
        }
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

    match processed_pixels {
        RenderedPixels::U8(pixels) => {
            let img_buf = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(out_w, out_h, pixels)
                .ok_or("Failed to create 8-bit image buffer from GPU data")?;
            Ok(DynamicImage::ImageRgba8(img_buf))
        }
        RenderedPixels::U16(pixels) => {
            let img_buf = ImageBuffer::<Rgba<u16>, Vec<u16>>::from_raw(out_w, out_h, pixels)
                .ok_or("Failed to create 16-bit image buffer from GPU data")?;
            Ok(DynamicImage::ImageRgba16(img_buf))
        }
    }
}

#[cfg(test)]
mod preview_display_tests {
    use super::*;
    use crate::app_state::{PREVIEW_SUPERSEDED, PreviewLane};

    #[test]
    fn superseded_wgpu_copy_and_present_are_never_submitted() {
        let state = AppState::default();
        let generation = state.begin_preview_generation();
        let old = PreviewIdentity {
            generation,
            lane: PreviewLane::Main,
            revision: Some(1),
        };
        state.register_preview_intent(old).unwrap();
        state
            .register_preview_intent(PreviewIdentity {
                revision: Some(2),
                ..old
            })
            .unwrap();

        let mut copy_submitted = false;
        assert_eq!(
            submit_current_preview_display(&state, Some(old), || copy_submitted = true)
                .unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        assert!(!copy_submitted);
    }

    #[test]
    fn transform_for_old_generation_cannot_redraw_previous_frame() {
        let state = AppState::default();
        let old_generation = state.begin_preview_generation();
        let new_generation = state.begin_preview_generation();
        let old_identity = PreviewIdentity {
            generation: old_generation,
            lane: PreviewLane::Main,
            revision: None,
        };
        let mut transform_submitted = false;
        assert_eq!(
            state
                .with_current_preview_identity(old_identity, || transform_submitted = true)
                .unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        assert!(!transform_submitted);
        assert!(!display_frame_matches_generation(
            Some(old_generation),
            new_generation
        ));
        assert!(!display_frame_matches_generation(None, new_generation));
        assert!(display_frame_matches_generation(
            Some(new_generation),
            new_generation
        ));
    }
}

#[cfg(test)]
mod precision_tests {
    use super::*;

    #[test]
    fn ordinary_render_rejects_nonidentity_oversize_and_unaligned_limit() {
        let mut adjusted = request(None);
        adjusted.adjustments.global.exposure = 0.75;
        let error = ordinary_texture_extent(8193, 2, 8192, &adjusted).unwrap_err();
        assert!(error.contains("8193x2"));
        assert!(error.contains("8192"));
        assert_eq!(
            ordinary_texture_extent(8192, 2, 8192, &adjusted),
            Ok((8192, 256))
        );
        let error = ordinary_texture_extent(8191, 2, 8191, &adjusted).unwrap_err();
        assert!(error.contains("8191x2"));
    }

    fn request(roi: Option<Roi>) -> RenderRequest<'static> {
        RenderRequest {
            adjustments: crate::image_processing::get_all_adjustments_from_json(
                &serde_json::json!({}),
                false,
                None,
            ),
            mask_bitmaps: &[],
            lut: None,
            roi,
        }
    }

    #[test]
    fn invalid_regions_and_missing_masks_fail_before_gpu_work() {
        assert!(validate_precision_request(0, 10, 4096, &request(None)).is_err());
        assert!(validate_precision_request(5000, 10, 4096, &request(None)).is_err());
        for roi in [
            Roi {
                x: 9,
                y: 0,
                width: 2,
                height: 1,
            },
            Roi {
                x: 0,
                y: 0,
                width: 0,
                height: 1,
            },
            Roi {
                x: u32::MAX,
                y: 0,
                width: 2,
                height: 1,
            },
        ] {
            assert!(validate_precision_request(10, 10, 4096, &request(Some(roi))).is_err());
        }
        let mut missing = request(None);
        missing.adjustments.mask_count = 1;
        assert!(validate_precision_request(10, 10, 4096, &missing).is_err());
        assert!(validate_precision_request(10, 10, 4096, &request(None)).is_ok());
    }

    #[test]
    fn upstream_shader_changes_cannot_silently_disable_precision() {
        assert!(replace_shader_token("", "rgba8unorm", "rgba32float").is_err());
        assert!(
            replace_shader_token("rgba8unorm rgba8unorm", "rgba8unorm", "rgba32float").is_err()
        );
        assert!(
            replace_shader_token(
                include_str!("shaders/shader.wgsl"),
                "rgba8unorm",
                "rgba32float"
            )
            .is_ok()
        );
        assert!(
            replace_shader_token(
                include_str!("shaders/shader.wgsl"),
                "let dither_amount = 1.0 / 255.0;",
                "let dither_amount = 1.0 / 65535.0;"
            )
            .is_ok()
        );
        assert!(
            replace_shader_token(
                include_str!("shaders/blur.wgsl"),
                "rgba16float",
                "rgba32float"
            )
            .is_ok()
        );
        assert!(
            replace_shader_token(
                include_str!("shaders/shader.wgsl"),
                "dither(id.xy)",
                "dither(absolute_coord)",
            )
            .is_ok()
        );
        assert!(
            replace_shader_token(
                include_str!("shaders/flare.wgsl"),
                "textureSampleLevel(input_texture, input_sampler, uv, 0.0)",
                "sample_input_bilinear(uv)"
            )
            .is_ok()
        );
    }

    #[test]
    fn selected_float32_output_contract_and_readback_layout() {
        let source = high_precision_shader_source().unwrap();
        assert!(source.contains("rgba32float, write>"));
        assert!(!source.contains("rgba16float, write>"));
        assert_eq!(
            HIGH_PRECISION_OUTPUT_FORMAT,
            wgpu::TextureFormat::Rgba32Float
        );
        assert_eq!(HIGH_PRECISION_OUTPUT_PIXEL_BYTES, 16);
        assert_eq!(
            HIGH_PRECISION_OUTPUT_FORMAT.block_copy_size(None),
            Some(HIGH_PRECISION_OUTPUT_PIXEL_BYTES)
        );
        let padded = readback_layout(3, 2, HIGH_PRECISION_OUTPUT_PIXEL_BYTES, 1024).unwrap();
        assert_eq!(
            (
                padded.row,
                padded.padded_row,
                padded.buffer_size,
                padded.data_len
            ),
            (48, 256, 512, 96)
        );
        let unpadded = readback_layout(16, 2, HIGH_PRECISION_OUTPUT_PIXEL_BYTES, 1024).unwrap();
        assert_eq!(
            (unpadded.row, unpadded.padded_row, unpadded.buffer_size),
            (256, 256, 512)
        );
        assert!(readback_layout(u32::MAX, 2, 16, u64::MAX).is_err());
        assert!(readback_layout(3, 2, 16, 511).is_err());
        assert!(readback_layout(0, 2, 16, 1024).is_err());
    }

    #[test]
    fn float32_readback_padding_channels_offsets_and_finite_policy() {
        let layout = readback_layout(3, 2, 16, 1024).unwrap();
        let mut padded = vec![0xee; layout.buffer_size as usize];
        let values = [
            [0.0, 0.25, 0.5, 1.0],
            [1.5, -0.5, f32::NAN, f32::INFINITY],
            [f32::NEG_INFINITY, 0.125, 0.75, 0.8],
            [0.1, 0.2, 0.3, 0.4],
            [0.2, 0.3, 0.4, 0.5],
            [0.3, 0.4, 0.5, 0.6],
        ];
        for (pixel, channels) in values.iter().enumerate() {
            let row = pixel / 3;
            let col = pixel % 3;
            for (channel, value) in channels.iter().enumerate() {
                let at = row * layout.padded_row as usize + col * 16 + channel * 4;
                padded[at..at + 4].copy_from_slice(&value.to_ne_bytes());
            }
        }
        let data = remove_readback_padding(&padded, layout, 2).unwrap();
        assert_eq!(data.len(), 96);
        let mut output = vec![7u16; 4 * 3 * 4];
        copy_f32_tile_to_u16(&data, (3, 2), (1, 0), (2, 2), &mut output, (4, 3), (1, 1)).unwrap();
        assert_eq!(&output[20..24], &[65535, 0, 0, 0]);
        assert_eq!(&output[24..28], &[0, 8192, 49151, 52428]);
        assert_eq!(output[0], 7);
        assert!(
            copy_f32_tile_to_u16(
                &data[..95],
                (3, 2),
                (0, 0),
                (1, 1),
                &mut output,
                (4, 3),
                (0, 0)
            )
            .is_err()
        );
        assert!(remove_readback_padding(&padded[..511], layout, 2).is_err());
        let direct = (32769f32 / 65535.0 * 65535.0).round() as u16;
        assert_eq!(
            decode_output_f32(&(32769f32 / 65535.0).to_ne_bytes()),
            direct
        );
    }

    #[test]
    fn former_half_float_output_collapses_precision_ramp() {
        let levels: std::collections::HashSet<u16> = (32768u16..=34822)
            .map(|value| {
                let half = f16::from_f32(value as f32 / 65535.0);
                (half.to_f32() * 65535.0).round() as u16
            })
            .collect();
        assert_eq!(levels.len(), 65);
    }

    /// Run explicitly on a machine with a GPU adapter. This checks actual GPU
    /// shader execution, row padding, tile/ROI assembly and effect bindings.
    #[test]
    #[ignore = "requires a GPU adapter; run with --ignored"]
    fn gpu_precision_preserves_ramp_and_tile_boundaries() {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
                .expect("GPU adapter required for precision integration test");
        eprintln!("precision GPU adapter: {:?}", adapter.get_info());
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: limits.clone(),
            ..Default::default()
        }))
        .unwrap();
        let context = GpuContext {
            device: Arc::new(device),
            queue: Arc::new(queue),
            limits,
            display: Arc::new(std::sync::Mutex::new(None)),
        };
        let input = ImageBuffer::<Rgba<u16>, _>::from_fn(2055, 3, |x, y| {
            let value = 32768 + (x + y * 2055) as u16;
            Rgba([value, value, value, 65535])
        });
        let source = DynamicImage::ImageRgba16(input.clone());
        let output = process_and_get_dynamic_image_high_precision(&context, &source, request(None))
            .unwrap()
            .to_rgba16();
        let levels: std::collections::HashSet<u16> = output
            .rows()
            .next()
            .unwrap()
            .map(|pixel| pixel.0[0])
            .collect();
        eprintln!(
            "precision ramp: input first/last={}/{}; output first/last={}/{}; distinct first-row levels={}",
            input.get_pixel(0, 0)[0],
            input.get_pixel(2054, 0)[0],
            output.get_pixel(0, 0)[0],
            output.get_pixel(2054, 0)[0],
            levels.len()
        );
        assert!(
            levels.len() > 1500,
            "Only {} levels survived GPU rendering",
            levels.len()
        );
        let ramp_maximum = output
            .pixels()
            .zip(input.pixels())
            .map(|(actual, expected)| actual.0[0].abs_diff(expected.0[0]))
            .max()
            .unwrap();
        eprintln!("precision ramp maximum u16 error: {ramp_maximum}");
        for format in ["png", "tiff"] {
            let bytes = crate::delivery::encode_profiled_raster(
                &DynamicImage::ImageRgba16(output.clone()),
                format,
                16,
                format == "png",
            )
            .unwrap();
            crate::delivery::verify_raster_header(&bytes, format, (2055, 3), 16).unwrap();
            assert!(crate::delivery::verify_profile(&bytes, format).unwrap());
            let decoded = image::load_from_memory(&bytes).unwrap().to_rgb16();
            assert_eq!(
                decoded,
                DynamicImage::ImageRgba16(output.clone()).to_rgb16()
            );
            let encoded_levels: std::collections::HashSet<u16> = decoded
                .rows()
                .next()
                .unwrap()
                .map(|pixel| pixel.0[0])
                .collect();
            assert!(
                encoded_levels.len() > 1500,
                "{format} preserved only {} levels",
                encoded_levels.len()
            );
            eprintln!(
                "GPU {format} roundtrip: {} first-row levels, ICC present",
                encoded_levels.len()
            );
        }
        for (actual, expected) in output.pixels().zip(input.pixels()) {
            assert!(
                actual.0[0].abs_diff(expected.0[0]) <= 8,
                "Ramp mismatch: {actual:?} != {expected:?}"
            );
            assert_eq!(actual.0[3], 65535);
        }
        let roi = Roi {
            x: 2044,
            y: 1,
            width: 9,
            height: 2,
        };
        let cropped =
            process_and_get_dynamic_image_high_precision(&context, &source, request(Some(roi)))
                .unwrap()
                .to_rgba16();
        assert_eq!(cropped.dimensions(), (9, 2));
        for (x, y, pixel) in cropped.enumerate_pixels() {
            assert_eq!(pixel, output.get_pixel(x + roi.x, y + roi.y));
        }
        let mut effects = request(None);
        effects.adjustments.global.clarity = 0.2;
        effects.adjustments.global.flare_amount = 0.2;
        let effect_output =
            process_and_get_dynamic_image_high_precision(&context, &source, effects).unwrap();
        assert_eq!(effect_output.color(), image::ColorType::Rgba16);
        assert_eq!(effect_output.dimensions(), source.dimensions());

        // Force bounded textures on an image that also fits the ordinary path,
        // checking global spatial effects, masks and seams against that oracle.
        let wide = DynamicImage::ImageRgb16(ImageBuffer::from_fn(8209, 129, |x, y| {
            image::Rgb([
                ((x * 31 + y * 71) % 60000) as u16,
                ((x * 17 + y * 101) % 55000) as u16,
                ((x * 11 + y * 37) % 50000) as u16,
            ])
        }));
        let mask = ImageBuffer::from_fn(8209, 129, |x, y| Luma([((x / 19 + y) % 256) as u8]));
        let mut controls = request(None).adjustments;
        controls.global.vignette_amount = -0.3;
        controls.global.grain_amount = 0.1;
        controls.global.clarity = 0.15;
        controls.global.structure = 0.1;
        controls.global.flare_amount = 0.2;
        controls.global.chromatic_aberration_red_cyan = 0.002;
        controls.mask_count = 1;
        controls.mask_adjustments[0].exposure = 0.3;
        let masks = [mask];
        let make = || RenderRequest {
            adjustments: controls,
            mask_bitmaps: &masks,
            lut: None,
            roi: None,
        };
        let whole = process_and_get_dynamic_image_high_precision(&context, &wide, make())
            .unwrap()
            .to_rgba16();
        let streamed = render_streamed_precision(&context, &wide, make(), 2048)
            .unwrap()
            .to_rgba16();
        let maximum = whole
            .as_raw()
            .iter()
            .zip(streamed.as_raw())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        eprintln!("streamed spatial maximum u16 difference: {maximum}");
        assert!(
            maximum <= 32,
            "Streamed spatial effect/seam mismatch: {maximum}"
        );
        let beyond = DynamicImage::ImageRgb16(ImageBuffer::from_fn(
            context.limits.max_texture_dimension_2d + 17,
            3,
            |x, _| image::Rgb([(x % 65536) as u16, 32000, 12000]),
        ));
        let large =
            process_and_get_dynamic_image_high_precision(&context, &beyond, request(None)).unwrap();
        assert_eq!(large.dimensions(), beyond.dimensions());
    }
    #[test]
    fn blur_overlap_and_flare_requirements_include_full_extent_and_enabled_masks() {
        assert_eq!(processing_tile_overlap((25184, 256)), 128);
        assert_eq!(processing_tile_overlap((4097, 4099)), 152);
        let mut controls = request(None).adjustments;
        controls.global.flare_amount = 0.0;
        controls.mask_adjustments[0].flare_amount = 0.7;
        controls.mask_adjustments[1].flare_amount = 0.9;
        assert_eq!(flare_map_amount(&controls), 0.0);
        controls.mask_count = 1;
        assert_eq!(flare_map_amount(&controls), 0.7);
        controls.global.flare_amount = 0.2;
        assert!((flare_map_amount(&controls) - 0.9).abs() < 1e-6);
    }

    #[test]
    #[ignore = "requires a GPU adapter and bounded tall-image textures; run with --ignored"]
    fn gpu_mask_only_flare_and_tall_blur_region_invariance() {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
                .expect("GPU adapter required");
        eprintln!("spatial GPU adapter: {:?}", adapter.get_info());
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: limits.clone(),
            ..Default::default()
        }))
        .unwrap();
        let context = GpuContext {
            device: Arc::new(device),
            queue: Arc::new(queue),
            limits,
            display: Arc::new(std::sync::Mutex::new(None)),
        };
        let flare_source = DynamicImage::ImageRgb16(ImageBuffer::from_fn(2055, 257, |x, y| {
            let bright = (260..480).contains(&x) && (65..180).contains(&y);
            image::Rgb(if bright {
                [65000, 63000, 60000]
            } else {
                [15000, 12000, 10000]
            })
        }));
        let baseline =
            process_and_get_dynamic_image_high_precision(&context, &flare_source, request(None))
                .unwrap()
                .to_rgba16();
        let mut global = request(None).adjustments;
        global.global.flare_amount = 0.8;
        let global_image = process_and_get_dynamic_image_high_precision(
            &context,
            &flare_source,
            RenderRequest {
                adjustments: global,
                mask_bitmaps: &[],
                lut: None,
                roi: None,
            },
        )
        .unwrap()
        .to_rgba16();
        let mut local = request(None).adjustments;
        local.mask_count = 1;
        local.mask_adjustments[0].flare_amount = 0.8;
        let masks = [image::GrayImage::from_pixel(2055, 257, Luma([255]))];
        let local_request = || RenderRequest {
            adjustments: local,
            mask_bitmaps: &masks,
            lut: None,
            roi: None,
        };
        let local_image =
            process_and_get_dynamic_image_high_precision(&context, &flare_source, local_request())
                .unwrap()
                .to_rgba16();
        let changed = baseline
            .as_raw()
            .iter()
            .zip(local_image.as_raw())
            .filter(|(a, b)| a.abs_diff(**b) > 10)
            .count();
        assert!(
            changed > 1000,
            "Mask-only flare must visibly change actual rendered samples ({changed})"
        );
        let max_global_local = global_image
            .as_raw()
            .iter()
            .zip(local_image.as_raw())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            max_global_local <= 2,
            "Full-mask local flare differs from same global flare: {max_global_local}"
        );
        let streamed = render_streamed_precision(&context, &flare_source, local_request(), 2048)
            .unwrap()
            .to_rgba16();
        let max_stream = local_image
            .as_raw()
            .iter()
            .zip(streamed.as_raw())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(
            max_stream <= 32,
            "Streamed primer missed local flare: {max_stream}"
        );
        drop((
            baseline,
            global_image,
            local_image,
            streamed,
            flare_source,
            masks,
        ));

        // The old fixed128px overlap truncated the152px vertical structure
        // blur. Sparse crops bound output memory while exercising the real
        // full4097x4099 source, global2048px tile boundaries and stream path.
        let tall = DynamicImage::ImageRgb16(ImageBuffer::from_fn(4097, 4099, |x, y| {
            let band = if (y / 47) % 2 == 0 { 10000 } else { 49000 };
            image::Rgb([
                band + (x % 29) as u16 * 100,
                22000 + ((x * 11 + y * 19) % 9000) as u16,
                18000 + ((x * 7 + y * 13) % 17000) as u16,
            ])
        }));
        let roi = Roi {
            x: 2001,
            y: 1977,
            width: 109,
            height: 151,
        };
        let expanded = Roi {
            x: 1801,
            y: 1777,
            width: 509,
            height: 551,
        };
        let mut controls = request(None).adjustments;
        controls.global.structure = 0.8;
        controls.global.clarity = 0.5;
        let make = |roi| RenderRequest {
            adjustments: controls,
            mask_bitmaps: &[],
            lut: None,
            roi: Some(roi),
        };
        let reference =
            process_and_get_dynamic_image_high_precision(&context, &tall, make(expanded))
                .unwrap()
                .to_rgba16();
        let direct = process_and_get_dynamic_image_high_precision(&context, &tall, make(roi))
            .unwrap()
            .to_rgba16();
        let streamed = render_streamed_precision(&context, &tall, make(roi), 2048)
            .unwrap()
            .to_rgba16();
        let mut max_region = 0;
        let mut max_stream = 0;
        for (x, y, pixel) in direct.enumerate_pixels() {
            let reference = reference.get_pixel(x + roi.x - expanded.x, y + roi.y - expanded.y);
            let streamed = streamed.get_pixel(x, y);
            for c in 0..4 {
                max_region = max_region.max(pixel[c].abs_diff(reference[c]));
                max_stream = max_stream.max(pixel[c].abs_diff(streamed[c]));
            }
        }
        assert!(
            max_region <= 4,
            "Native structure blur changes with ROI: {max_region}"
        );
        assert!(
            max_stream <= 32,
            "Tall streamed native structure blur differs at seams: {max_stream}"
        );
    }
}

/// Timing harness for the interactive preview path. Run on a machine with a GPU:
/// `cargo test --lib preview_perf_bench -- --ignored --nocapture`
#[cfg(test)]
mod preview_perf_bench {
    use super::*;
    use crate::lut_processing::Lut;
    use std::time::Instant;

    fn context() -> GpuContext {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
                .expect("GPU adapter required for the preview benchmark");
        eprintln!("adapter: {:?}", adapter.get_info().name);
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: limits.clone(),
            ..Default::default()
        }))
        .unwrap();
        GpuContext {
            device: Arc::new(device),
            queue: Arc::new(queue),
            limits,
            display: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn source(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb32F(ImageBuffer::from_fn(width, height, |x, y| {
            let v = ((x * 7 + y * 13) % 997) as f32 / 997.0;
            image::Rgb([v, (v * 0.8 + 0.1).fract(), 1.0 - v])
        }))
    }

    fn wait(context: &GpuContext) {
        context
            .device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(30)),
            })
            .unwrap();
    }

    fn time_frames(label: &str, frames: usize, mut frame: impl FnMut(usize)) {
        frame(0);
        let start = Instant::now();
        for i in 1..=frames {
            frame(i);
        }
        let ms = start.elapsed().as_secs_f64() * 1000.0 / frames as f64;
        eprintln!("{label}: {ms:.2} ms/frame");
    }

    fn readback(
        processor: &GpuProcessor,
        view: &wgpu::TextureView,
        keys: (Option<u64>, Option<u64>),
        (width, height): (u32, u32),
        json: serde_json::Value,
        masks: &[image::GrayImage],
        lut: Option<Arc<Lut>>,
    ) -> Vec<u8> {
        let mut adjustments =
            crate::image_processing::get_all_adjustments_from_json(&json, false, None);
        adjustments.mask_count = masks.len() as u32;
        let (pixels, ..) = processor
            .run(
                view,
                keys.0,
                keys.1,
                width,
                height,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: masks,
                    lut,
                    roi: None,
                },
                false,
                RenderOutputPrecision::EightBit,
                None,
            )
            .unwrap();
        match pixels {
            RenderedPixels::U8(pixels) => pixels,
            RenderedPixels::U16(_) => unreachable!(),
        }
    }

    /// Reused blurs, masks and LUTs must produce the same pixels as a fresh
    /// upload, and a changed mask key must replace the cached layers.
    #[test]
    #[ignore = "requires a GPU adapter; run with --ignored"]
    fn cached_preview_resources_match_fresh_renders() {
        let context = context();
        let (width, height) = (1500, 1000);
        let texels = to_rgba_f16(&source(width, height));
        let texture = context.device.create_texture_with_data(
            &context.queue,
            &wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            TextureDataOrder::MipMajor,
            bytemuck::cast_slice(&texels),
        );
        let view = texture.create_view(&Default::default());
        let processor = GpuProcessor::new(context.clone(), 1536, 1024).unwrap();
        let size = (width, height);
        let masks = |value| {
            vec![image::GrayImage::from_fn(width, height, |x, _| {
                Luma([if x < width / 2 { value } else { 0 }])
            })]
        };
        let lut = Arc::new(Lut {
            size: 2,
            data: (0..8)
                .flat_map(|i| [(i & 1) as f32, 0.5, ((i >> 2) & 1) as f32])
                .collect(),
        });
        let edit = |exposure: f64| {
            serde_json::json!({
                "exposure": exposure,
                "clarity": 40,
                "structure": 30,
                "sharpness": 20,
                "lutIntensity": 50,
                "masks": [{ "id": "m", "name": "m", "visible": true, "invert": false, "subMasks": [], "adjustments": { "exposure": 1.0 } }]
            })
        };

        let fresh = readback(
            &processor,
            &view,
            (None, None),
            size,
            edit(0.5),
            &masks(255),
            Some(lut.clone()),
        );
        let _ = readback(
            &processor,
            &view,
            (Some(1), Some(1)),
            size,
            edit(-1.0),
            &masks(255),
            Some(lut.clone()),
        );
        let reused = readback(
            &processor,
            &view,
            (Some(1), Some(1)),
            size,
            edit(0.5),
            &masks(255),
            Some(lut.clone()),
        );
        assert!(
            fresh == reused,
            "cached blur/mask/LUT render differs from a fresh render"
        );

        let other_masks = readback(
            &processor,
            &view,
            (Some(1), Some(2)),
            size,
            edit(0.5),
            &masks(0),
            Some(lut.clone()),
        );
        let fresh_other = readback(
            &processor,
            &view,
            (None, None),
            size,
            edit(0.5),
            &masks(0),
            Some(lut),
        );
        assert!(
            other_masks == fresh_other,
            "a new mask key must upload new layers"
        );
        assert!(
            other_masks != reused,
            "mask layers had no visible effect in the fixture"
        );
    }

    #[test]
    #[ignore = "requires a GPU adapter; run with --ignored --nocapture"]
    fn interactive_preview_frame_costs() {
        let context = context();
        for (width, height) in [(1920, 1280), (3584, 2389)] {
            let image = source(width, height);
            let t = Instant::now();
            let texels = to_rgba_f16(&image);
            let convert_ms = t.elapsed().as_secs_f64() * 1000.0;
            let texture = context.device.create_texture_with_data(
                &context.queue,
                &wgpu::TextureDescriptor {
                    label: Some("Bench Input"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba16Float,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                },
                TextureDataOrder::MipMajor,
                bytemuck::cast_slice(&texels),
            );
            wait(&context);
            eprintln!(
                "{width}x{height}: CPU f32->f16 input conversion {convert_ms:.2} ms, upload+convert {:.2} ms",
                t.elapsed().as_secs_f64() * 1000.0
            );
            let view = texture.create_view(&Default::default());
            let (pw, ph) = ordinary_texture_extent(width, height, u32::MAX, &{
                let r: RenderRequest = RenderRequest {
                    adjustments: crate::image_processing::get_all_adjustments_from_json(
                        &serde_json::json!({}),
                        false,
                        None,
                    ),
                    mask_bitmaps: &[],
                    lut: None,
                    roi: None,
                };
                r
            })
            .unwrap();
            let t = Instant::now();
            let processor = GpuProcessor::new(context.clone(), pw, ph).unwrap();
            eprintln!(
                "{width}x{height}: processor creation {:.2} ms",
                t.elapsed().as_secs_f64() * 1000.0
            );
            let masks: Vec<image::GrayImage> = (0..4)
                .map(|m| {
                    image::GrayImage::from_fn(width, height, |x, _| Luma([((x + m) % 256) as u8]))
                })
                .collect();
            let mask_json: Vec<serde_json::Value> = (0..4)
                .map(|m| serde_json::json!({ "id": format!("m{m}"), "name": "m", "visible": true, "invert": false, "subMasks": [], "adjustments": { "exposure": 0.2 } }))
                .collect();
            for (label, reuse_input, mask_count) in [
                ("slider drag", true, 0),
                ("slider drag, 4 masks", true, 4),
                ("new input", false, 0),
            ] {
                time_frames(&format!("{width}x{height}: {label}"), 20, |i| {
                    let mut adjustments = crate::image_processing::get_all_adjustments_from_json(
                        &serde_json::json!({ "exposure": (i % 10) as f64 * 0.1, "clarity": 20, "masks": mask_json[..mask_count] }),
                        false,
                        None,
                    );
                    adjustments.mask_count = mask_count as u32;
                    let input_key = if reuse_input { 1 } else { 2 + i as u64 };
                    processor
                        .run(
                            &view,
                            Some(input_key),
                            Some(mask_count as u64),
                            width,
                            height,
                            RenderRequest {
                                adjustments,
                                mask_bitmaps: &masks[..mask_count],
                                lut: None,
                                roi: None,
                            },
                            true,
                            RenderOutputPrecision::EightBit,
                            None,
                        )
                        .unwrap();
                    wait(&context);
                });
            }
        }

        for (width, height) in [(1920u32, 1280u32), (3584, 2389)] {
            let rgba =
                DynamicImage::ImageRgba8(image::RgbaImage::from_fn(width, height, |x, y| {
                    image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
                }));
            let t = Instant::now();
            let _ = crate::image_processing::calculate_histogram_from_image(&rgba);
            let hist_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let _ = crate::image_processing::calculate_waveform_from_image(&rgba, Some("luma"));
            let luma_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let _ = crate::image_processing::calculate_waveform_from_image(&rgba, None);
            eprintln!(
                "{width}x{height}: CPU histogram {hist_ms:.2} ms, luma waveform {luma_ms:.2} ms, all scopes {:.2} ms",
                t.elapsed().as_secs_f64() * 1000.0
            );
        }

        let full = source(6000, 4000);
        for target in [3584, 1920] {
            let t = Instant::now();
            let _ = crate::image_processing::downscale_f32_image(&full, target, target);
            eprintln!(
                "6000x4000 -> {target}: CPU downscale {:.2} ms",
                t.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}
