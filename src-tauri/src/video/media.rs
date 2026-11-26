use std::path::Path;

use crate::video::ffmpeg::MediaInfo;
use crate::video::libav::video::{FrameShape, Grid, VideoPipe, VideoSpec};
use crate::video::vision::GrayFrame;

const MIN_ANALYSIS_SIDE: u32 = 16;

pub fn even_fit(size: (u32, u32), longest: u32, minimum: u32) -> (u32, u32) {
    let scale = (longest as f64 / size.0.max(size.1).max(1) as f64).min(1.0);
    let even = |value: u32| ((value as f64 * scale / 2.0).round() as u32 * 2).max(minimum);
    (even(size.0), even(size.1))
}

pub struct RawVideo(VideoPipe);

impl RawVideo {
    pub fn open(spec: &VideoSpec, grid: Option<Grid>) -> Result<Self, String> {
        VideoPipe::open_at(spec, grid).map(Self)
    }

    pub fn next_shape(&mut self) -> Option<FrameShape> {
        self.0
            .next_shape()
            .inspect_err(|e| log::warn!("Video decoding stopped: {}", e))
            .ok()
            .flatten()
    }

    pub fn skip(&mut self) -> bool {
        self.0
            .skip()
            .inspect_err(|e| log::warn!("Video decoding stopped: {}", e))
            .unwrap_or(false)
    }

    pub fn read_into(&mut self, destination: &mut [u8]) -> bool {
        self.0
            .read_into(destination)
            .inspect_err(|e| log::warn!("Video decoding stopped: {}", e))
            .ok()
            .flatten()
            .is_some()
    }

    pub fn keyframe_before(&self) -> bool {
        self.0.keyframe_before()
    }

    pub fn source_time(&self) -> Option<f64> {
        self.0.source_time()
    }

    pub fn source_tick(&self) -> f64 {
        self.0.source_tick()
    }

    pub fn read(&mut self, buffer: &mut Vec<u8>) -> bool {
        self.0
            .read(buffer)
            .inspect_err(|e| log::warn!("Video decoding stopped: {}", e))
            .ok()
            .flatten()
            .is_some()
    }
}

pub struct GrayVideo {
    frames: RawVideo,
    size: (u32, u32),
    buffer: Vec<u8>,
}

impl GrayVideo {
    pub fn open(
        path: &Path,
        info: &MediaInfo,
        longest: u32,
        start: f64,
        frames: Option<u64>,
    ) -> Result<Self, String> {
        let size = even_fit((info.width, info.height), longest, MIN_ANALYSIS_SIDE);
        let frames = RawVideo::open(
            &VideoSpec {
                path,
                start,
                timing: "",
                filters: &format!(
                    "scale={}:{}:flags=area,fps={:.6}:start_time=0",
                    size.0, size.1, info.fps
                ),
                pixel_format: "gray",
                frames,
                hwaccel: true,
                keyframes_only: false,
                low_delay: false,
                device_scale: None,
            },
            None,
        )?;
        Ok(Self {
            frames,
            size,
            buffer: Vec::new(),
        })
    }

    pub fn size(&self) -> (u32, u32) {
        self.size
    }

    pub fn read(&mut self, luma: &mut Vec<u8>) -> bool {
        self.frames.read(luma)
    }

    pub fn next_frame(&mut self) -> Option<GrayFrame> {
        self.frames
            .read(&mut self.buffer)
            .then(|| GrayFrame::from_luma8(self.size.0, self.size.1, &self.buffer))
    }
}
