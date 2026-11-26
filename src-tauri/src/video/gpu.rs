use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use glam::Mat3;
use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, Rgb32FImage};
use rayon::prelude::*;

use crate::decode::hdr_source::{HLG_PEAK_NITS, HLG_SYSTEM_GAMMA, HdrTransfer, PQ_PEAK_NITS};
use crate::decode::image_loader::primaries_to_working;
use crate::render::color_space::TransferCurve;
use crate::render::gpu::compute::{self, Bind, Grid, Group, IMAGE_FORMAT, Out, Slot};
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::processor::read_texture_rows;
use crate::render::hdr::REFERENCE_WHITE_NITS;
use crate::video::ffmpeg::VideoColor;

const BUFFER_ALIGNMENT: usize = 16;
const SHARED_PLANES: usize = 6;
const READBACK_CHANNELS: usize = 4;
const HDR_CONSTANTS: [f32; 4] = [
    REFERENCE_WHITE_NITS,
    HLG_PEAK_NITS,
    HLG_SYSTEM_GAMMA,
    PQ_PEAK_NITS,
];

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct FrameParams {
    grid: Grid,
    planes: [u32; 4],
    chroma: [u32; 4],
    mode: [u32; 4],
    siting: [f32; 4],
    levels: [f32; 4],
    coeffs: [f32; 4],
    to_working: [[f32; 4]; 3],
    hdr: [f32; 4],
    log: [[f32; 4]; 3],
}

pub fn luma_weights(matrix: Option<&str>) -> (f32, f32) {
    match matrix {
        Some("bt2020") => (0.2627, 0.0593),
        Some("bt601") => (0.299, 0.114),
        Some("smpte240m") => (0.212, 0.087),
        _ => (0.2126, 0.0722),
    }
}

fn matrix_rows(matrix: Mat3) -> [[f32; 4]; 3] {
    let row = |r: usize| [matrix.col(0)[r], matrix.col(1)[r], matrix.col(2)[r], 0.0];
    [row(0), row(1), row(2)]
}

fn levels(bits: u32, full_range: bool) -> [f32; 4] {
    let step = (1u32 << (bits - 8)) as f32;
    if full_range {
        let max = ((1u64 << bits) - 1) as f32;
        [0.0, 1.0 / max, (1u32 << (bits - 1)) as f32, 1.0 / max]
    } else {
        [
            16.0 * step,
            1.0 / (219.0 * step),
            128.0 * step,
            1.0 / (224.0 * step),
        ]
    }
}

fn frame_params(color: &VideoColor, size: (u32, u32)) -> FrameParams {
    let layout = color.layout;
    let (chroma_w, chroma_h) = layout.chroma_size(size);
    let luma_samples = size.0 * size.1;
    let (kr, kb) = luma_weights(color.matrix);
    let kg = 1.0 - kr - kb;
    let matrix = match color.log {
        Some(log) => log.to_working(),
        None => primaries_to_working(color.primaries.unwrap_or(zenavif::ColorPrimaries::BT709)),
    };
    let sited = |subsampled: u32, sited: bool| if subsampled == 1 && sited { 0.25 } else { 0.0 };
    let second_chroma = if layout.interleaved {
        luma_samples + 1
    } else {
        luma_samples + chroma_w * chroma_h
    };
    FrameParams {
        grid: Grid::new(size),
        planes: [0, luma_samples, second_chroma, layout.sample_bytes() as u32],
        chroma: [
            chroma_w,
            chroma_h,
            layout.chroma_shift.0,
            layout.chroma_shift.1,
        ],
        mode: [
            match (color.log, color.transfer) {
                (Some(_), _) => 3,
                (None, None) => 0,
                (None, Some(HdrTransfer::Pq)) => 1,
                (None, Some(HdrTransfer::Hlg)) => 2,
            },
            if layout.interleaved { 2 } else { 1 },
            layout.sample_shift(),
            0,
        ],
        siting: [
            sited(layout.chroma_shift.0, color.chroma_left),
            sited(layout.chroma_shift.1, color.chroma_top),
            0.0,
            0.0,
        ],
        levels: levels(layout.bits, color.full_range),
        coeffs: [
            2.0 * (1.0 - kr),
            -2.0 * kb * (1.0 - kb) / kg,
            -2.0 * kr * (1.0 - kr) / kg,
            2.0 * (1.0 - kb),
        ],
        to_working: matrix_rows(matrix),
        hdr: HDR_CONSTANTS,
        log: color.log.map_or([[0.0; 4]; 3], |log| {
            log.uniforms(layout.bits, color.full_range)
        }),
    }
}

pub fn planes_to_rgb(color: &VideoColor, size: (u32, u32), raw: &[u8]) -> Vec<f32> {
    let params = frame_params(color, size);
    let [luma_plane, blue_plane, red_plane, sample_bytes] = params.planes.map(|v| v as usize);
    let [chroma_w, chroma_h, shift_x, shift_y] = params.chroma;
    let stride = params.mode[1] as usize;
    let sample = |index: usize| -> f32 {
        let value = if sample_bytes == 2 {
            u16::from_le_bytes([raw[index * 2], raw[index * 2 + 1]]) as u32
        } else {
            raw[index] as u32
        };
        (value >> params.mode[2]) as f32
    };
    let mix = |a: f32, b: f32, t: f32| a * (1.0 - t) + b * t;
    let chroma = |plane: usize, x: f32, y: f32| {
        let x = x.clamp(0.0, (chroma_w - 1) as f32);
        let y = y.clamp(0.0, (chroma_h - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = (
            (x0 + 1).min(chroma_w as usize - 1),
            (y0 + 1).min(chroma_h as usize - 1),
        );
        let at = |x: usize, y: usize| sample(plane + (y * chroma_w as usize + x) * stride);
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        mix(
            mix(at(x0, y0), at(x1, y0), fx),
            mix(at(x0, y1), at(x1, y1), fx),
            fy,
        )
    };
    let [black, luma_scale, mid, chroma_scale] = params.levels;
    let [cr_red, cb_green, cr_green, cb_blue] = params.coeffs;
    let clamps = color.log.is_none();
    let width = size.0 as usize;
    let mut rgb = vec![0.0f32; width * size.1 as usize * 3];
    rgb.par_chunks_exact_mut(width.max(1) * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let chroma_y = (y as f32 + 0.5) / (1u32 << shift_y) as f32 - 0.5 + params.siting[1];
            for (x, pixel) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let chroma_x = (x as f32 + 0.5) / (1u32 << shift_x) as f32 - 0.5 + params.siting[0];
                let luma = (sample(luma_plane + y * width + x) - black) * luma_scale;
                let cb = (chroma(blue_plane, chroma_x, chroma_y) - mid) * chroma_scale;
                let cr = (chroma(red_plane, chroma_x, chroma_y) - mid) * chroma_scale;
                let value = [
                    luma + cr_red * cr,
                    luma + cb_green * cb + cr_green * cr,
                    luma + cb_blue * cb,
                ];
                *pixel = if clamps {
                    value.map(|c| c.clamp(0.0, 1.0))
                } else {
                    value
                };
            }
        });
    rgb
}

pub fn fits(context: &GpuContext, color: &VideoColor, size: (u32, u32)) -> bool {
    let bytes = color
        .layout
        .frame_bytes(size)
        .next_multiple_of(BUFFER_ALIGNMENT) as u64;
    let limit = context.limits.max_texture_dimension_2d;
    bytes <= context.limits.max_storage_buffer_binding_size
        && bytes <= context.limits.max_buffer_size
        && size.0 <= limit
        && size.1 <= limit
}

fn fill_planes(
    mut view: wgpu::WriteOnly<'_, [u8]>,
    bytes: usize,
    write: impl FnOnce(&mut [u8]) -> bool,
) -> bool {
    let length = view.len();
    let pointer = view.as_raw_element_ptr();
    let planes = unsafe { std::slice::from_raw_parts_mut(pointer.as_ptr(), length) };
    let (frame, padding) = planes.split_at_mut(bytes);
    padding.fill(0);
    write(frame)
}

struct SharedPlanes {
    buffer: wgpu::Buffer,
    ready: Arc<AtomicBool>,
}

impl SharedPlanes {
    fn new(context: &GpuContext, size: u64) -> Self {
        Self {
            buffer: context.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Video Frame Planes"),
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::MAP_WRITE,
                mapped_at_creation: true,
            }),
            ready: Arc::new(AtomicBool::new(true)),
        }
    }

    fn remap(&self) {
        let ready = Arc::clone(&self.ready);
        self.buffer
            .slice(..)
            .map_async(wgpu::MapMode::Write, move |mapped| {
                ready.store(mapped.is_ok(), Ordering::Release)
            });
    }
}

#[derive(Default)]
pub struct PlaneUploads {
    shared: Vec<SharedPlanes>,
    submitted: Option<usize>,
    queued: Option<wgpu::Buffer>,
}

impl PlaneUploads {
    pub fn write(
        &mut self,
        context: &GpuContext,
        bytes: usize,
        write: impl FnOnce(&mut [u8]) -> bool,
    ) -> Option<&wgpu::Buffer> {
        let size = bytes.next_multiple_of(BUFFER_ALIGNMENT) as u64;
        if context
            .device
            .features()
            .contains(wgpu::Features::MAPPABLE_PRIMARY_BUFFERS)
        {
            self.write_shared(context, bytes, size, write)
        } else {
            self.write_queued(context, bytes, size, write)
        }
    }

    fn write_queued(
        &mut self,
        context: &GpuContext,
        bytes: usize,
        size: u64,
        write: impl FnOnce(&mut [u8]) -> bool,
    ) -> Option<&wgpu::Buffer> {
        if self
            .queued
            .as_ref()
            .is_none_or(|buffer| buffer.size() != size)
        {
            self.queued = Some(context.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Video Frame Planes"),
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        let buffer = self.queued.as_ref()?;
        let mut view = context
            .queue
            .write_buffer_with(buffer, 0, wgpu::BufferSize::new(size)?)?;
        let written = fill_planes(view.slice(..), bytes, write);
        drop(view);
        written.then_some(buffer)
    }

    fn write_shared(
        &mut self,
        context: &GpuContext,
        bytes: usize,
        size: u64,
        write: impl FnOnce(&mut [u8]) -> bool,
    ) -> Option<&wgpu::Buffer> {
        if let Some(planes) = self.submitted.take().and_then(|used| self.shared.get(used)) {
            planes.remap();
        }
        self.shared.retain(|planes| planes.buffer.size() == size);
        let index = self.ready_shared(context, size);
        let planes = &self.shared[index];
        let written = {
            let mut view = planes.buffer.slice(..).get_mapped_range_mut();
            fill_planes(view.slice(..), bytes, write)
        };
        planes.buffer.unmap();
        planes.ready.store(false, Ordering::Release);
        self.submitted = Some(index);
        written.then_some(&planes.buffer)
    }

    fn ready_shared(&mut self, context: &GpuContext, size: u64) -> usize {
        let _ = context.device.poll(wgpu::PollType::Poll);
        if let Some(index) = self
            .shared
            .iter()
            .position(|planes| planes.ready.load(Ordering::Acquire))
        {
            return index;
        }
        if self.shared.len() >= SHARED_PLANES {
            self.shared.remove(0);
        }
        self.shared.push(SharedPlanes::new(context, size));
        self.shared.len() - 1
    }
}

pub fn convert(
    context: &GpuContext,
    color: &VideoColor,
    size: (u32, u32),
    raw: &[u8],
) -> Result<Slot, String> {
    let mut uploads = PlaneUploads::default();
    let buffer = uploads
        .write(context, raw.len(), |planes| {
            planes.copy_from_slice(raw);
            true
        })
        .ok_or("Could not upload a video frame")?;
    convert_planes(context, color, size, size, buffer)
}

pub fn convert_planes(
    context: &GpuContext,
    color: &VideoColor,
    planes: (u32, u32),
    size: (u32, u32),
    buffer: &wgpu::Buffer,
) -> Result<Slot, String> {
    let params = frame_params(color, planes);
    compute::encode(context, |enc| {
        let decoded = enc.texture("Video Frame", planes, IMAGE_FORMAT);
        enc.run(
            Group::Video,
            "vd_to_working",
            &params,
            planes,
            &[],
            Out::F16(&decoded.view),
            Bind {
                data: Some(buffer),
                ..Default::default()
            },
        );
        if planes == size {
            return decoded.detach();
        }
        let output = enc.texture("Video Frame", size, IMAGE_FORMAT);
        crate::render::source::downscale(enc, &decoded, &output);
        output.detach()
    })
}

pub fn to_working(
    context: &GpuContext,
    color: &VideoColor,
    size: (u32, u32),
    raw: &[u8],
) -> Result<Arc<DynamicImage>, String> {
    let slot = convert(context, color, size, raw)?;
    let image = slot_image(context, &slot)?;
    compute::register_upload(context, &image, slot);
    Ok(image)
}

pub fn slot_image(context: &GpuContext, slot: &Slot) -> Result<Arc<DynamicImage>, String> {
    let size = slot.size;
    let width = size.0 as usize;
    let samples = read_texture_rows(
        &context.device,
        &context.queue,
        &slot.texture,
        wgpu::Origin3d::ZERO,
        wgpu::Extent3d {
            width: size.0,
            height: size.1,
            depth_or_array_layers: 1,
        },
        (READBACK_CHANNELS * size_of::<f16>()) as u32,
        |mapped, stride| {
            let mut samples = vec![0.0f32; width * size.1 as usize * 3];
            samples
                .par_chunks_exact_mut(width * 3)
                .zip(mapped.par_chunks(stride))
                .for_each_init(
                    || vec![0.0f32; width * READBACK_CHANNELS],
                    |rgba, (rgb, row)| {
                        let halves: &[f16] = bytemuck::cast_slice(
                            &row[..width * READBACK_CHANNELS * size_of::<f16>()],
                        );
                        halves.convert_to_f32_slice(rgba);
                        for (out, texel) in rgb
                            .as_chunks_mut::<3>()
                            .0
                            .iter_mut()
                            .zip(rgba.as_chunks::<READBACK_CHANNELS>().0)
                        {
                            *out = [texel[0], texel[1], texel[2]];
                        }
                    },
                );
            samples
        },
    )?;
    Ok(Arc::new(DynamicImage::ImageRgb32F(
        Rgb32FImage::from_raw(size.0, size.1, samples).ok_or("Video frame size mismatch")?,
    )))
}

pub fn encode_hdr(
    enc: &mut compute::ComputeEncoder,
    src: &Slot,
    space: crate::render::color_space::OutputColorSpace,
    pq: bool,
) -> compute::Tex {
    let matrix = space
        .rgb()
        .to(crate::render::color_space::OutputColorSpace::Rec2020.rgb())
        .as_mat3();
    let params = FrameParams {
        grid: Grid::new(src.size),
        mode: [if pq { 1 } else { 2 }, 0, 0, 0],
        levels: space.curve().uniform(),
        to_working: matrix_rows(matrix),
        hdr: HDR_CONSTANTS,
        ..Default::default()
    };
    let output = enc.texture("HDR Encode", src.size, IMAGE_FORMAT);
    enc.run(
        Group::Video,
        "vd_encode_hdr",
        &params,
        src.size,
        &[&src.view],
        Out::F16(&output.view),
        Bind::default(),
    );
    output
}

pub fn overlay_to_output(
    enc: &mut compute::ComputeEncoder,
    src: &Slot,
    space: crate::render::color_space::OutputColorSpace,
) -> compute::Tex {
    decode_overlay(enc, src, space.srgb_matrix().inverse(), space.curve())
}

pub fn working_to_linear(enc: &mut compute::ComputeEncoder, src: &Slot) -> compute::Tex {
    decode_overlay(enc, src, Mat3::IDENTITY, TransferCurve::gamma(1.0))
}

pub fn transform_working(
    enc: &mut compute::ComputeEncoder,
    src: &Slot,
    transform: Mat3,
) -> compute::Tex {
    decode_overlay(enc, src, transform, TransferCurve::SRGB)
}

fn decode_overlay(
    enc: &mut compute::ComputeEncoder,
    src: &Slot,
    matrix: Mat3,
    curve: TransferCurve,
) -> compute::Tex {
    let params = FrameParams {
        grid: Grid::new(src.size),
        levels: curve.uniform(),
        to_working: matrix_rows(matrix),
        ..Default::default()
    };
    let output = enc.texture("Overlay Output", src.size, IMAGE_FORMAT);
    enc.run(
        Group::Video,
        "vd_overlay_to_output",
        &params,
        src.size,
        &[&src.view],
        Out::F16(&output.view),
        Bind::default(),
    );
    output
}

pub fn frame_to_working(
    enc: &mut compute::ComputeEncoder,
    src: &Slot,
    space: crate::render::color_space::OutputColorSpace,
) -> compute::Tex {
    let matrix = primaries_to_working(zenavif::ColorPrimaries::BT709) * space.srgb_matrix();
    let params = FrameParams {
        grid: Grid::new(src.size),
        levels: space.curve().uniform(),
        to_working: matrix_rows(matrix),
        ..Default::default()
    };
    let output = enc.texture("Frame Working", src.size, IMAGE_FORMAT);
    enc.run(
        Group::Video,
        "vd_frame_to_working",
        &params,
        src.size,
        &[&src.view],
        Out::F16(&output.view),
        Bind::default(),
    );
    output
}
