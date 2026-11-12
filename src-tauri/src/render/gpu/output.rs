use crate::app::state::{
    AnalyticsConfig, AnalyticsJob, AppState, GpuImageCache, GpuImageEntry, GpuProcessorState,
    PreviewTarget, UploadedSource,
};
use crate::render::analytics::{AnalyticsFrame, AnalyticsPixels};
use crate::render::gpu::context::{GpuContext, lock_or_reset};
use crate::render::gpu::display::{DisplayLayer, DisplayOutput, align_texture_dimension};
use crate::render::gpu::processor::{
    AnalyticsReadback, GPU_IMAGE_CACHE_ENTRIES, GPU_IMAGE_CACHE_PIXELS, GPU_SOURCE_CACHE_ENTRIES,
    GpuProcessor, NEXT_GPU_IMAGE_ID, RenderOutputPrecision, RenderRequest, RenderedPixels,
    analytics_readback_sender,
};
use crate::render::source::RenderSource;
use half::f16;
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

pub fn process_and_get_dynamic_image(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    source: &RenderSource,
    request: RenderRequest,
    caller_id: &str,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        source,
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
    source: &RenderSource,
    request: RenderRequest,
    caller_id: &str,
    output_precision: RenderOutputPrecision,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        source,
        request,
        caller_id,
        output_precision,
        None,
        None,
    )
}

pub fn process_and_get_dynamic_image_with_analytics(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    source: &RenderSource,
    request: RenderRequest,
    caller_id: &str,
    display_output: Option<DisplayOutput>,
    analytics_config: Option<AnalyticsConfig>,
) -> Result<DynamicImage, String> {
    process_and_get_dynamic_image_inner(
        context,
        state,
        source,
        request,
        caller_id,
        RenderOutputPrecision::EightBit,
        display_output,
        analytics_config,
    )
}

#[allow(clippy::too_many_arguments)]
fn process_and_get_dynamic_image_inner(
    context: &GpuContext,
    state: &tauri::State<AppState>,
    source: &RenderSource,
    request: RenderRequest,
    caller_id: &str,
    output_precision: RenderOutputPrecision,
    display_output: Option<DisplayOutput>,
    analytics_config: Option<AnalyticsConfig>,
) -> Result<DynamicImage, String> {
    let start_time = Instant::now();
    let display_layer = display_output
        .filter(|output| output.target == PreviewTarget::Editor)
        .map(|output| output.layer);
    let output_to_display = display_output.is_some();
    let (width, height) = source.size();
    let source_size = source.image.dimensions();
    let device = &context.device;
    let queue = &context.queue;

    let max_dim = context.limits.max_texture_dimension_2d;
    if width.max(source_size.0) > max_dim || height.max(source_size.1) > max_dim {
        return Err(format!(
            "Image dimensions ({}x{}) exceed the GPU texture limit ({}). The image could not be processed; try reducing its dimensions.",
            source_size.0, source_size.1, max_dim
        ));
    }

    let is_raw = request.adjustments.global.is_raw_image;
    let identity = source.identity();
    let transform_key = source.key();
    let matches = |e: &GpuImageEntry| {
        e.transform_key == transform_key
            && e.width == width
            && e.height == height
            && e.is_raw == is_raw
            && e.source_identity == identity
    };
    let has_input = |cache: &Option<GpuImageCache>| {
        cache.as_ref().is_some_and(|c| {
            c.entries.iter().any(matches) || c.sources.iter().any(|s| s.identity == identity)
        })
    };

    let cache_target = display_output.map_or(PreviewTarget::Editor, |output| output.target);
    let image_cache = state.gpu_image_cache_for(cache_target);
    let mut source_halves: Option<Vec<f16>> = None;
    let (mut processor_lock, mut cache_lock) = loop {
        if !has_input(&lock_or_reset(image_cache, "GPU image cache")) && source_halves.is_none() {
            source_halves = Some(crate::render::gpu::compute::rgba_halves(source.image));
        }

        let processor_lock = lock_or_reset(&state.gpu_processor, "GPU processor");
        let cache_lock = lock_or_reset(image_cache, "GPU image cache");
        if has_input(&cache_lock) || source_halves.is_some() {
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
        let new_width = align_texture_dimension(width).max(old_width);
        let new_height = align_texture_dimension(height).max(old_height);
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

        *processor_lock = Some(GpuProcessorState {
            processor: new_processor,
            width: new_width,
            height: new_height,
        });
    }

    let processor_state = processor_lock.as_ref().unwrap();
    let processor = &processor_state.processor;

    let cache = cache_lock.get_or_insert_with(GpuImageCache::default);

    if let Some(index) = cache.entries.iter().position(matches) {
        let entry = cache.entries.remove(index);
        cache.entries.push(entry);
    } else {
        let uploaded = match cache.sources.iter().position(|s| s.identity == identity) {
            Some(index) => cache.sources.remove(index),
            None => UploadedSource {
                identity,
                slot: crate::render::gpu::compute::upload_image(
                    context,
                    source_size,
                    &source_halves
                        .take()
                        .ok_or("Source image was not prepared for upload")?,
                ),
            },
        };
        let input = source.render(context, &uploaded.slot)?;
        cache.sources.push(uploaded);
        let pixels = |s: &UploadedSource| s.slot.size.0 as u64 * s.slot.size.1 as u64;
        while cache.sources.len() > GPU_SOURCE_CACHE_ENTRIES
            || (cache.sources.len() > 1
                && cache.sources.iter().map(pixels).sum::<u64>() > GPU_IMAGE_CACHE_PIXELS)
        {
            cache.sources.remove(0);
        }

        let guided = processor.build_guided_coeffs(&input.view, width, height, is_raw);

        cache.entries.push(GpuImageEntry {
            id: NEXT_GPU_IMAGE_ID.fetch_add(1, Ordering::Relaxed),
            texture: input.texture,
            texture_view: input.view,
            gf_coeffs_view: guided.coeffs,
            tone_base_view: guided.tone_base,
            haze_view: guided.haze,
            airlight_view: guided.airlight,
            is_raw,
            width,
            height,
            transform_key,
            source_identity: identity,
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
    let mask_view =
        processor.mask_view(request.mask_bitmaps, width, height, request.mask_cache_key);
    let motion = processor.motion_blurred(cache, &request, &mask_view)?;
    let (input, mask_view) = match &motion {
        Some(blurred) => (
            &blurred.entry,
            blurred.mask_view.clone().unwrap_or(mask_view),
        ),
        None => (cache, mask_view),
    };

    let skip_readback = output_to_display;

    let (processed_pixels, out_w, out_h, out_x, out_y) = processor.run(
        input,
        &mask_view,
        request,
        output_to_display,
        output_precision,
    )?;

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
                let _ = analytics.sender.send(AnalyticsJob {
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

    let image_size = [width as f32, height as f32];
    let texture_size = [processor_state.width as f32, processor_state.height as f32];
    if let (Some(layer), Some(display)) = (display_layer, display) {
        match layer {
            DisplayLayer::Edited => display.show_texture(
                device,
                queue,
                &processor.display_textures().output_texture_view,
                image_size,
                texture_size,
                display_output.map(|output| output.content),
            ),
            DisplayLayer::Original => {
                display.latest_transform.original_size = image_size;
                display.rebind(device);
                display.flush(device, queue);
            }
        }
    }
    drop(display_lock);

    if display_output.is_some_and(|output| output.to_viewer)
        && let Some(display) = context
            .viewer_display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
    {
        display.show_frame(
            device,
            queue,
            &processor.display_textures().working_texture,
            [width, height],
            context.limits.max_texture_dimension_2d,
        );
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
