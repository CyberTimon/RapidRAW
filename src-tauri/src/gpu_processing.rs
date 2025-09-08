use std::sync::Arc;

use bytemuck;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, Rgba};
use wgpu::util::{DeviceExt, TextureDataOrder};

use crate::{AppState, GpuImageCache};
use crate::image_processing::{AllAdjustments, GpuContext};
use crate::lut_processing::Lut;


/// Initializes or retrieves the GPU context for image processing.
/// This context contains the device, queue, and hardware limits.
/// Returns a cloned `GpuContext` if already initialized, or creates a new one.
///
/// # Arguments
/// * `state` - Application state containing the GPU context.
///
/// # Returns
/// * `Result<GpuContext, String>` - The GPU context or an error message.
pub fn get_or_init_gpu_context(state: &tauri::State<AppState>) -> Result<GpuContext, String> {
    let mut context_lock = state.gpu_context.lock().unwrap();
    if let Some(context) = &*context_lock {
        return Ok(context.clone());
    }
    let instance_desc = wgpu::InstanceDescriptor::from_env_or_default();
    let instance = wgpu::Instance::new(&instance_desc);
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .map_err(|e| format!("Failed to find a wgpu adapter: {}", e))?;

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
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .map_err(|e| e.to_string())?;

    let new_context = GpuContext {
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
    };
    *context_lock = Some(new_context.clone());
    Ok(new_context)
}


/// Reads pixel data from a GPU texture and returns it as a byte vector.
/// Handles row padding required by the GPU.
///
/// # Arguments
/// * `device` - The GPU device.
/// * `queue` - The GPU queue.
/// * `texture` - The texture to read from.
/// * `size` - The size of the texture.
///
/// # Returns
/// * `Result<Vec<u8>, String>` - The raw pixel data or an error message.
fn read_texture_data(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    size: wgpu::Extent3d,
) -> Result<Vec<u8>, String> {
    let unpadded_bytes_per_row = 4 * size.width;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) & !(align - 1);
    let output_buffer_size = (padded_bytes_per_row * size.height) as u64;

    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Readback Buffer"),
        size: output_buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Readback Encoder"),
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
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
        tx.send(result).unwrap();
    });
    device.poll(wgpu::PollType::Wait).unwrap();
    rx.recv().unwrap().map_err(|e| e.to_string())?;

    let padded_data = buffer_slice.get_mapped_range().to_vec();
    output_buffer.unmap();

    if padded_bytes_per_row == unpadded_bytes_per_row {
        Ok(padded_data)
    } else {
        let mut unpadded_data = Vec::with_capacity((unpadded_bytes_per_row * size.height) as usize);
        for chunk in padded_data.chunks(padded_bytes_per_row as usize) {
            unpadded_data.extend_from_slice(&chunk[..unpadded_bytes_per_row as usize]);
        }
        Ok(unpadded_data)
    }
}


/// Runs the main GPU image processing pipeline.
/// Applies adjustments, masks, and optional LUT to the input image using compute shaders.
/// Returns the processed image as a byte vector.
///
/// # Arguments
/// * `context` - The GPU context.
/// * `input_texture_view` - The input texture view.
/// * `width` - Image width.
/// * `height` - Image height.
/// * `adjustments` - Image adjustments.
/// * `mask_bitmaps` - Array of mask bitmaps.
/// * `lut` - Optional LUT for color grading.
///
/// # Returns
/// * `Result<Vec<u8>, String>` - The processed image data or an error message.
pub fn run_gpu_processing(
    context: &GpuContext,
    input_texture_view: &wgpu::TextureView,
    width: u32,
    height: u32,
    adjustments: AllAdjustments,
    mask_bitmaps: &[ImageBuffer<Luma<u8>, Vec<u8>>],
    lut: Option<Arc<Lut>>,
) -> Result<Vec<u8>, String> {
    let device = &context.device;
    let queue = &context.queue;
    let max_dim = context.limits.max_texture_dimension_2d;
    const MAX_MASKS: u32 = 14;

    if width > max_dim || height > max_dim {
        return Err(format!(
            "Image dimensions ({}x{}) exceed GPU limits ({}).",
            width, height, max_dim
        ));
    }

    let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Image Processing Shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
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
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        },
    ];

    for i in 0..MAX_MASKS {
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3 + i,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
    }

    bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
        binding: 3 + MAX_MASKS,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D3,
            multisampled: false,
        },
        count: None,
    });
    bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
        binding: 4 + MAX_MASKS,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
        count: None,
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Dynamic Bind Group Layout"),
        entries: &bind_group_layout_entries,
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Pipeline Layout"),
        bind_group_layouts: &[&bind_group_layout],
        push_constant_ranges: &[],
    });

    let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("Compute Pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader_module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let full_texture_size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };

    let mut mask_views = Vec::new();
    for mask_bitmap in mask_bitmaps.iter() {
        let mask_texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("Full Mask Texture"),
                size: full_texture_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            TextureDataOrder::MipMajor,
            mask_bitmap,
        );
        mask_views.push(mask_texture.create_view(&Default::default()));
    }

    let dummy_mask_texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Dummy Mask Texture"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let dummy_mask_view = dummy_mask_texture.create_view(&Default::default());

    let (lut_texture_view, lut_sampler) = if let Some(lut_arc) = lut {
        let lut_data = &lut_arc.data;
        let size = lut_arc.size;

        let mut rgba_lut_data = Vec::with_capacity(lut_data.len() / 3 * 4);
        for chunk in lut_data.chunks_exact(3) {
            rgba_lut_data.push(chunk[0]);
            rgba_lut_data.push(chunk[1]);
            rgba_lut_data.push(chunk[2]);
            rgba_lut_data.push(1.0);
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
                format: wgpu::TextureFormat::Rgba32Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            TextureDataOrder::MipMajor,
            bytemuck::cast_slice(&rgba_lut_data),
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
        (view, sampler)
    } else {
        let dummy_lut_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Dummy LUT Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = dummy_lut_texture.create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
        (view, sampler)
    };

    let tile_size = 2048;
    let mut final_pixels = vec![0u8; (width * height * 4) as usize];
    let tiles_x = (width + tile_size - 1) / tile_size;
    let tiles_y = (height + tile_size - 1) / tile_size;

    for tile_y in 0..tiles_y {
        for tile_x in 0..tiles_x {
            let x_start = tile_x * tile_size;
            let y_start = tile_y * tile_size;
            let tile_width = (width - x_start).min(tile_size);
            let tile_height = (height - y_start).min(tile_size);
            let tile_texture_size = wgpu::Extent3d {
                width: tile_width,
                height: tile_height,
                depth_or_array_layers: 1,
            };

            let output_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Output Tile Texture"),
                size: tile_texture_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let output_texture_view = output_texture.create_view(&Default::default());

            let mut tile_adjustments = adjustments;
            tile_adjustments.tile_offset_x = x_start;
            tile_adjustments.tile_offset_y = y_start;

            let adjustments_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Tile Adjustments Buffer"),
                contents: bytemuck::bytes_of(&tile_adjustments),
                usage: wgpu::BufferUsages::UNIFORM,
            });

            let mut bind_group_entries = vec![
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&input_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&output_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: adjustments_buffer.as_entire_binding(),
                },
            ];

            for i in 0..MAX_MASKS as usize {
                let view = mask_views.get(i).unwrap_or(&dummy_mask_view);
                bind_group_entries.push(wgpu::BindGroupEntry {
                    binding: 3 + i as u32,
                    resource: wgpu::BindingResource::TextureView(view),
                });
            }

            bind_group_entries.push(wgpu::BindGroupEntry {
                binding: 3 + MAX_MASKS,
                resource: wgpu::BindingResource::TextureView(&lut_texture_view),
            });
            bind_group_entries.push(wgpu::BindGroupEntry {
                binding: 4 + MAX_MASKS,
                resource: wgpu::BindingResource::Sampler(&lut_sampler),
            });

            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Tile Bind Group"),
                layout: &bind_group_layout,
                entries: &bind_group_entries,
            });

            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Tile Encoder"),
            });
            {
                let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: None,
                    timestamp_writes: None,
                });
                compute_pass.set_pipeline(&compute_pipeline);
                compute_pass.set_bind_group(0, &bind_group, &[]);
                compute_pass.dispatch_workgroups((tile_width + 7) / 8, (tile_height + 7) / 8, 1);
            }
            queue.submit(Some(encoder.finish()));

            let processed_tile_data =
                read_texture_data(device, queue, &output_texture, tile_texture_size)?;

            for row in 0..tile_height {
                let final_y = y_start + row;
                let final_row_offset = (final_y * width + x_start) as usize * 4;
                let tile_row_offset = (row * tile_width) as usize * 4;
                let copy_bytes = (tile_width * 4) as usize;
                final_pixels[final_row_offset..final_row_offset + copy_bytes].copy_from_slice(
                    &processed_tile_data[tile_row_offset..tile_row_offset + copy_bytes],
                );
            }
        }
    }

    Ok(final_pixels)
}


/// Processes the input image on the GPU and returns a `DynamicImage`.
/// Uses caching to avoid redundant GPU uploads for identical transformations.
/// Applies all adjustments, masks, and optional LUT.
///
/// # Arguments
/// * `context` - The GPU context.
/// * `state` - Application state for caching.
/// * `base_image` - The input image.
/// * `transform_hash` - Hash representing the transformation.
/// * `all_adjustments` - All image adjustments.
/// * `mask_bitmaps` - Array of mask bitmaps.
/// * `lut` - Optional LUT for color grading.
///
/// # Returns
/// * `Result<DynamicImage, String>` - The processed image or an error message.
pub fn process_and_get_dynamic_image(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    all_adjustments: AllAdjustments,
    mask_bitmaps: &[ImageBuffer<Luma<u8>, Vec<u8>>],
    lut: Option<Arc<Lut>>,
) -> Result<DynamicImage, String> {
    let (width, height) = base_image.dimensions();
    let device = &context.device;
    let queue = &context.queue;

    let mut cache_lock = state.gpu_image_cache.lock().unwrap();

    if let Some(cache) = &*cache_lock {
        if cache.transform_hash != transform_hash || cache.width != width || cache.height != height {
            *cache_lock = None;
        }
    }

    if cache_lock.is_none() {
        let img_rgba = base_image.to_rgba8();
        let texture_size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("Cached Input Texture"),
                size: texture_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            TextureDataOrder::MipMajor,
            &img_rgba,
        );
        let texture_view = texture.create_view(&Default::default());

        *cache_lock = Some(GpuImageCache {
            texture,
            texture_view,
            width,
            height,
            transform_hash,
        });
    }

    let cache = cache_lock.as_ref().unwrap();

    let processed_pixels = run_gpu_processing(
        context,
        &cache.texture_view,
        cache.width,
        cache.height,
        all_adjustments,
        mask_bitmaps,
        lut,
    )?;

    let img_buf = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, processed_pixels)
        .ok_or("Failed to create image buffer from GPU data")?;
    Ok(DynamicImage::ImageRgba8(img_buf))
}
