use std::path::Path;
use std::sync::Arc;

use image::{DynamicImage, Rgb32FImage};
use rayon::prelude::*;

use crate::decode::avif::ContainerColor;
use crate::decode::image_loader::container_image_to_working;
use crate::render::color_space::srgb_transfer;
use crate::render::gpu::compute::{Slot, upload_image};
use crate::render::gpu::context::{GpuContext, shared_gpu_context};
use crate::video::ffmpeg::{MediaInfo, VideoColor};
use crate::video::gpu::{self, PlaneUploads};
use crate::video::libav::video::{Demand, DeviceScale, FrameShape, Grid, VideoSpec};
use crate::video::media::RawVideo;
use crate::video::timelapse::Deflicker;

const HARDWARE_FRAME_PIXELS: u64 = 2560 * 1440;

pub struct FrameRange {
    pub start: f64,
    pub speed: f64,
    pub fps: Option<f64>,
    pub frames: Option<u64>,
    pub size: Option<(u32, u32)>,
    pub hwaccel: bool,
    pub preview: bool,
    pub keyframe: bool,
}

impl FrameRange {
    pub fn single(time: f64) -> Self {
        Self {
            start: time,
            speed: 1.0,
            fps: None,
            frames: Some(1),
            size: None,
            hwaccel: false,
            preview: false,
            keyframe: false,
        }
    }

    pub fn poster(time: f64, size: Option<(u32, u32)>) -> Self {
        Self {
            size,
            keyframe: true,
            ..Self::single(time)
        }
    }
}

enum Conversion {
    Gpu,
    Cpu,
}

enum Pending {
    Planes {
        bytes: Vec<u8>,
        color: VideoColor,
        planes: (u32, u32),
        size: (u32, u32),
        deflicker: Option<Deflicker>,
    },
    Image(DynamicImage),
}

pub struct PendingFrame {
    pending: Pending,
    source_time: Option<f64>,
}

impl PendingFrame {
    pub fn source_time(&self) -> Option<f64> {
        self.source_time
    }

    pub fn slot(self, uploads: &mut PlaneUploads) -> Option<Slot> {
        let context = shared_gpu_context().ok()?;
        match self.pending {
            Pending::Planes {
                bytes,
                color,
                planes,
                size,
                deflicker,
            } => {
                let buffer = uploads.write(&context, bytes.len(), |target| {
                    target.copy_from_slice(&bytes);
                    true
                })?;
                convert_frame(
                    &context,
                    &color,
                    (planes, size),
                    buffer,
                    deflicker.as_ref(),
                    self.source_time,
                )
            }
            Pending::Image(image) => Some(upload_image(&context, &image)),
        }
    }
}

fn convert_frame(
    context: &GpuContext,
    color: &VideoColor,
    (planes, size): ((u32, u32), (u32, u32)),
    buffer: &wgpu::Buffer,
    deflicker: Option<&Deflicker>,
    source_time: Option<f64>,
) -> Option<Slot> {
    let slot = gpu::convert_planes(context, color, planes, size, buffer);
    match deflicker {
        Some(deflicker) => slot.and_then(|slot| deflicker.apply_slot(context, slot, source_time)),
        None => slot,
    }
    .inspect_err(|e| log::error!("GPU video frame conversion failed: {}", e))
    .ok()
}

pub struct FrameReader {
    source: RawVideo,
    frame_bytes: usize,
    size: (u32, u32),
    color: VideoColor,
    conversion: Conversion,
    buffer: Vec<u8>,
    uploads: PlaneUploads,
    deflicker: Option<Deflicker>,
}

impl FrameReader {
    pub fn open(path: &Path, info: &MediaInfo, range: &FrameRange) -> Result<Self, String> {
        Self::open_at(path, info, range, range.start)
    }

    pub fn open_at(
        path: &Path,
        info: &MediaInfo,
        range: &FrameRange,
        origin: f64,
    ) -> Result<Self, String> {
        if !info.has_video {
            return Err(format!("'{}' has no video stream", path.display()));
        }
        let color = info.color;
        let device_format = color
            .layout
            .interleaved_format()
            .filter(|_| range.preview && range.hwaccel);
        let size = range.size.unwrap_or((info.width, info.height));
        let size = if device_format.is_some() {
            ((size.0 & !1).max(2), (size.1 & !1).max(2))
        } else {
            size
        };
        let context = shared_gpu_context().ok();
        let source_size = (info.width, info.height);
        let resizes = range.preview
            && !color.layout.rgb
            && size != source_size
            && size.0 <= source_size.0
            && size.1 <= source_size.1
            && context
                .as_ref()
                .is_some_and(|context| gpu::fits(context, &color, source_size));
        let decoded = if resizes { source_size } else { size };
        let conversion = if context
            .as_ref()
            .is_some_and(|context| gpu::fits(context, &color, decoded))
        {
            Conversion::Gpu
        } else {
            Conversion::Cpu
        };

        let mut filters = Vec::new();
        let mut timing = Vec::new();
        if (range.speed - 1.0).abs() > 1e-6 {
            timing.push(format!("setpts=PTS/{}", range.speed));
        }
        let grid = range.fps.filter(|_| origin != range.start).map(|fps| Grid {
            origin,
            first: ((range.start - origin) * fps / range.speed).round() as i64,
        });
        if let Some(fps) = range.fps {
            timing.push(match grid {
                Some(_) => format!("fps={}", fps),
                None => format!("fps={}:start_time=0", fps),
            });
        }
        let planar = color.layout.ffmpeg_format();
        if !resizes {
            let rgb_source = if color.layout.rgb {
                ":out_color_matrix=bt709:out_range=full"
            } else {
                ""
            };
            filters.push(format!(
                "scale={}:{}:flags=bicubic{}",
                size.0, size.1, rgb_source
            ));
        }
        let pixel_format = match color.layout.interleaved_format().filter(|_| resizes) {
            Some(native) => format!("{}|{}", planar, native),
            None => planar,
        };
        let frame_bytes = color.layout.frame_bytes(decoded);

        let device_scale = device_format
            .filter(|_| matches!(conversion, Conversion::Gpu))
            .map(|format| DeviceScale { size, format });
        let source = RawVideo::open(
            &VideoSpec {
                path,
                start: range.start,
                timing: &timing.join(","),
                filters: &filters.join(","),
                pixel_format: &pixel_format,
                frames: range.frames,
                hwaccel: range.hwaccel,
                keyframes_only: range.keyframe,
                low_delay: range.keyframe,
                device_scale,
            },
            grid,
        )?;
        Ok(Self {
            source,
            frame_bytes,
            size,
            color,
            conversion,
            buffer: Vec::with_capacity(frame_bytes),
            uploads: PlaneUploads::default(),
            deflicker: info.deflicker.clone(),
        })
    }

    fn read(&mut self) -> Option<()> {
        (self.source.read(&mut self.buffer) && self.buffer.len() == self.frame_bytes).then_some(())
    }

    pub fn skip_frame(&mut self) -> bool {
        self.source.skip()
    }

    pub fn demand(&mut self, demand: Demand) {
        self.source.demand(demand);
    }

    fn keyframe_before(&self) -> bool {
        self.source.keyframe_before()
    }

    pub fn next_frame(&mut self) -> Option<Arc<DynamicImage>> {
        self.read()?;
        let frame = match self.conversion {
            Conversion::Gpu => {
                let context = shared_gpu_context().ok()?;
                gpu::to_working(&context, &self.color, self.size, &self.buffer)
                    .inspect_err(|e| log::error!("GPU video frame conversion failed: {}", e))
                    .ok()?
            }
            Conversion::Cpu => Arc::new(self.cpu_frame()?),
        };
        Some(match &self.deflicker {
            Some(deflicker) => {
                Arc::new(deflicker.apply(Arc::unwrap_or_clone(frame), self.source_time()))
            }
            None => frame,
        })
    }

    pub fn source_time(&self) -> Option<f64> {
        self.source.source_time()
    }

    pub fn source_tick(&self) -> f64 {
        self.source.source_tick()
    }

    fn shaped_color(&self, shape: &FrameShape) -> VideoColor {
        VideoColor {
            layout: if shape.interleaved {
                self.color.layout.as_interleaved()
            } else {
                self.color.layout
            },
            ..self.color
        }
    }

    fn cpu_image(&mut self) -> Option<DynamicImage> {
        self.read()?;
        let image = self.cpu_frame()?;
        Some(match &self.deflicker {
            Some(deflicker) => deflicker.apply(image, self.source_time()),
            None => image,
        })
    }

    pub fn next_slot(&mut self) -> Option<Slot> {
        match self.conversion {
            Conversion::Gpu => {
                let context = &shared_gpu_context().ok()?;
                let shape = self.source.next_shape()?;
                let color = self.shaped_color(&shape);
                let planes = self
                    .uploads
                    .write(context, shape.bytes, |planes| self.source.read_into(planes))?;
                convert_frame(
                    context,
                    &color,
                    (shape.size, self.size),
                    planes,
                    self.deflicker.as_ref(),
                    self.source.source_time(),
                )
            }
            Conversion::Cpu => {
                let image = self.cpu_image()?;
                Some(upload_image(&shared_gpu_context().ok()?, &image))
            }
        }
    }

    pub fn next_pending(&mut self) -> Option<PendingFrame> {
        let pending = match self.conversion {
            Conversion::Gpu => {
                let shape = self.source.next_shape()?;
                let mut bytes = vec![0; shape.bytes];
                if !self.source.read_into(&mut bytes) {
                    return None;
                }
                Pending::Planes {
                    bytes,
                    color: self.shaped_color(&shape),
                    planes: shape.size,
                    size: self.size,
                    deflicker: self.deflicker.clone(),
                }
            }
            Conversion::Cpu => Pending::Image(self.cpu_image()?),
        };
        Some(PendingFrame {
            pending,
            source_time: self.source_time(),
        })
    }

    fn cpu_frame(&self) -> Option<DynamicImage> {
        let samples = gpu::planes_to_rgb(&self.color, self.size, &self.buffer);
        let mut rgb = Rgb32FImage::from_raw(self.size.0, self.size.1, samples)?;
        let Some(log) = self.color.log else {
            return Some(container_image_to_working(
                rgb,
                ContainerColor::Cicp {
                    primaries: self
                        .color
                        .primaries
                        .unwrap_or(zenavif::ColorPrimaries::BT709),
                    transfer: self.color.transfer,
                },
            ));
        };
        let decode = log.decoder(self.color.layout.bits, self.color.full_range);
        let transfer = srgb_transfer();
        rgb.as_chunks_mut::<3>().0.par_iter_mut().for_each(|pixel| {
            *pixel = decode(*pixel).map(|c| transfer.encode(c.max(0.0)));
        });
        Some(DynamicImage::ImageRgb32F(rgb))
    }
}

pub fn wide_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .par_chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]) as f32 / 65535.0)
        .collect()
}

fn last_frame(info: &MediaInfo) -> f64 {
    (info.duration - 1.0 / info.fps.max(1.0)).max(0.0)
}

fn decode_range(
    path: &Path,
    info: &MediaInfo,
    range: &FrameRange,
) -> Result<Arc<DynamicImage>, String> {
    FrameReader::open(path, info, range)?
        .next_frame()
        .ok_or_else(|| format!("Could not decode a frame of '{}'", path.display()))
}

fn exact_range(info: &MediaInfo, time: f64, size: Option<(u32, u32)>) -> FrameRange {
    FrameRange {
        size,
        hwaccel: info.width as u64 * info.height as u64 >= HARDWARE_FRAME_PIXELS,
        ..FrameRange::single(time.clamp(0.0, last_frame(info)))
    }
}

pub fn decode_frame(
    path: &Path,
    info: &MediaInfo,
    time: f64,
    size: Option<(u32, u32)>,
) -> Result<Arc<DynamicImage>, String> {
    decode_range(path, info, &exact_range(info, time, size))
}

pub fn decode_poster(
    path: &Path,
    info: &MediaInfo,
    time: f64,
    size: Option<(u32, u32)>,
) -> Result<Arc<DynamicImage>, String> {
    let time = time.clamp(0.0, last_frame(info));
    let mut keyframe = FrameReader::open(path, info, &FrameRange::poster(time, size)).ok();
    if let Some(reader) = keyframe.as_mut().filter(|reader| !reader.keyframe_before())
        && let Some(frame) = reader.next_frame()
    {
        return Ok(frame);
    }
    decode_range(path, info, &exact_range(info, time, size)).or_else(|error| {
        keyframe
            .and_then(|mut reader| reader.next_frame())
            .ok_or(error)
    })
}
