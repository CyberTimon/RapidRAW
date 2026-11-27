use std::ffi::c_int;
use std::path::Path;
use std::ptr;
use std::sync::Mutex;

use super::probe::rotation;
use super::sys::types::*;
use super::{
    AGAIN, BufferRef, Codec, END, Frame, Graph, Input, Libav, NO_PTS, Packet, cstring, q2d, require,
};

#[derive(Clone, Copy)]
pub struct FrameInfo {
    pub width: u32,
    pub height: u32,
    pub pts: i64,
    pub duration: i64,
    pub time_base: AVRational,
}

#[derive(Clone, Copy)]
pub struct Grid {
    pub origin: f64,
    pub first: i64,
}

pub type Demand = Box<dyn FnMut(f64) -> bool + Send>;

pub struct DeviceScale<'a> {
    pub size: (u32, u32),
    pub format: &'a str,
}

#[derive(Clone, Copy)]
pub struct FrameShape {
    pub size: (u32, u32),
    pub interleaved: bool,
    pub bytes: usize,
}

pub struct VideoSpec<'a> {
    pub path: &'a Path,
    pub start: f64,
    pub timing: &'a str,
    pub filters: &'a str,
    pub pixel_format: &'a str,
    pub frames: Option<u64>,
    pub hwaccel: bool,
    pub keyframes_only: bool,
    pub low_delay: bool,
    pub device_scale: Option<DeviceScale<'a>>,
}

#[cfg(windows)]
const HARDWARE: &[&str] = &["d3d11va", "dxva2", "cuda"];
#[cfg(target_os = "macos")]
const HARDWARE: &[&str] = &["videotoolbox"];
#[cfg(all(unix, not(target_os = "macos")))]
const HARDWARE: &[&str] = &["vaapi", "cuda", "vdpau"];
const DEVICE_SCALERS: [(&str, AVPixelFormat, Scaler); 3] = [
    ("cuda", AV_PIX_FMT_CUDA, |(width, height), format| {
        format!(
            "scale_cuda={}:{}:format={}:interp_algo=bicubic",
            width, height, format
        )
    }),
    ("vaapi", AV_PIX_FMT_VAAPI, |(width, height), format| {
        format!("scale_vaapi=w={}:h={}:format={}", width, height, format)
    }),
    (
        "videotoolbox",
        AV_PIX_FMT_VIDEOTOOLBOX,
        |(width, height), _| format!("scale_vt=w={}:h={}", width, height),
    ),
];
const SLICE_THREADS: c_int = 2;
const EXTRA_HARDWARE_FRAMES: c_int = 4;
const PASSTHROUGH: &str = "null";
const RETREAT_SECONDS: f64 = 1.0;

static DEVICES: Mutex<Vec<(AVHWDeviceType, BufferRef)>> = Mutex::new(Vec::new());

type Scaler = fn((u32, u32), &str) -> String;

struct DeviceChain {
    size: (u32, u32),
    format: String,
    tail: String,
}

impl DeviceChain {
    fn filters(&self, scale: Scaler) -> String {
        format!(
            "{},hwdownload,format={},{}",
            scale(self.size, &self.format),
            self.format,
            self.tail
        )
    }
}

fn scaler_rank(name: &str) -> usize {
    DEVICE_SCALERS
        .iter()
        .position(|(scaler, ..)| *scaler == name)
        .unwrap_or(DEVICE_SCALERS.len())
}

struct FilterChain {
    _graph: Graph,
    source: *mut AVFilterContext,
    sink: *mut AVFilterContext,
    input: (c_int, c_int, c_int),
}

impl FilterChain {
    fn accepts(&self, frame: *const AVFrame) -> bool {
        self.input == unsafe { ((*frame).width, (*frame).height, (*frame).format) }
    }
}

#[derive(Clone, Copy, Default)]
struct Position {
    input: Option<i64>,
    output: Option<i64>,
    converted: Option<i64>,
}

fn reached(mark: Option<i64>, pts: i64) -> bool {
    pts != NO_PTS && mark.is_some_and(|mark| pts <= mark)
}

fn retreat_step(time_base: AVRational) -> i64 {
    (RETREAT_SECONDS / q2d(time_base)).round().max(1.0) as i64
}

#[derive(Clone, Copy)]
struct Seek {
    wanted: i64,
    at: i64,
    back: i64,
}

impl Seek {
    fn to(target: i64, time_base: AVRational) -> Self {
        Self {
            wanted: target,
            at: target,
            back: retreat_step(time_base),
        }
    }
}

impl Position {
    fn skips_input(&self, timestamp: i64) -> bool {
        timestamp != NO_PTS && self.input.is_some_and(|input| timestamp < input)
    }

    fn skips_output(&self, pts: i64) -> bool {
        reached(self.output, pts)
    }

    fn skips_conversion(&self, pts: i64) -> bool {
        reached(self.converted, pts)
    }
}

pub struct VideoPipe {
    libav: &'static Libav,
    input: Input,
    stream_index: c_int,
    time_base: AVRational,
    offset: i64,
    start: i64,
    origin: i64,
    first_limit: Option<i64>,
    seek: Option<Seek>,
    keyframe_before: bool,
    tolerance: i64,
    codec: *const AVCodec,
    options: DecoderOptions,
    decoder: Codec,
    passed: Position,
    resume: Position,
    last_input: Option<i64>,
    last_output: Option<i64>,
    timing: Option<FilterChain>,
    timing_filters: String,
    conversion: Option<FilterChain>,
    filters: String,
    device_chain: Option<DeviceChain>,
    packet: Packet,
    decoded: Frame,
    transferred: Frame,
    held: Frame,
    holding: bool,
    timed: Frame,
    output: Frame,
    limit: Option<u64>,
    emitted: u64,
    source: Option<f64>,
    pending: bool,
    input_done: bool,
    decoder_flushed: bool,
    timing_flushed: bool,
    conversion_flushed: bool,
    demand: Option<Demand>,
}

unsafe impl Send for VideoPipe {}

fn rotation_filters(matrix: Option<[i32; 9]>, libav: &Libav) -> Vec<&'static str> {
    let Some(matrix) = matrix else {
        return Vec::new();
    };
    let degrees = unsafe { libav.util.av_display_rotation_get(matrix.as_ptr()) };
    if degrees.is_nan() {
        return Vec::new();
    }
    let mut theta = -degrees.round();
    theta -= 360.0 * (theta / 360.0 + 0.9 / 360.0).floor();
    if (theta - 90.0).abs() < 1.0 {
        vec![if matrix[3] > 0 {
            "transpose=cclock_flip"
        } else {
            "transpose=clock"
        }]
    } else if (theta - 180.0).abs() < 1.0 {
        let mut filters = Vec::new();
        if matrix[0] < 0 {
            filters.push("hflip");
        }
        if matrix[4] < 0 {
            filters.push("vflip");
        }
        filters
    } else if (theta - 270.0).abs() < 1.0 {
        vec![if matrix[3] < 0 {
            "transpose=clock_flip"
        } else {
            "transpose=cclock"
        }]
    } else if theta.abs() < 1.0 && matrix[4] < 0 {
        vec!["vflip"]
    } else {
        Vec::new()
    }
}

fn shared_device(libav: &Libav, device_type: AVHWDeviceType) -> Option<*mut AVBufferRef> {
    let mut devices = DEVICES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, device)) = devices.iter().find(|(kind, _)| *kind == device_type) {
        return Some(device.0);
    }
    let mut device = ptr::null_mut();
    let created = unsafe {
        libav
            .util
            .av_hwdevice_ctx_create(&mut device, device_type, ptr::null(), ptr::null_mut(), 0)
    };
    if created < 0 {
        return None;
    }
    devices.push((device_type, BufferRef(device)));
    Some(device)
}

pub(super) fn named_device(libav: &Libav, name: &str) -> Option<*mut AVBufferRef> {
    let name = cstring(name).ok()?;
    let device_type = unsafe { libav.util.av_hwdevice_find_type_by_name(name.as_ptr()) };
    if device_type == AV_HWDEVICE_TYPE_NONE {
        return None;
    }
    shared_device(libav, device_type)
}

pub fn warm_hardware() {
    let Some(libav) = super::get() else {
        return;
    };
    let create = |name: &str| named_device(libav, name).is_some();
    if !DEVICE_SCALERS
        .iter()
        .map(|(name, ..)| *name)
        .filter(|name| HARDWARE.contains(name))
        .any(create)
    {
        HARDWARE.iter().copied().any(create);
    }
}

fn evict_device(decoder: &Codec) {
    let device = unsafe { (*decoder.0).hw_device_ctx };
    if device.is_null() {
        return;
    }
    let data = unsafe { (*device).data };
    DEVICES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(_, cached)| unsafe { (*cached.0).data } != data);
}

fn timestamp_of(frame: *const AVFrame) -> i64 {
    unsafe {
        match (*frame).best_effort_timestamp {
            NO_PTS => (*frame).pts,
            timestamp => timestamp,
        }
    }
}

fn attach_hardware(
    libav: &Libav,
    codec: *const AVCodec,
    decoder: *mut AVCodecContext,
    order: &[&str],
) {
    for name in order {
        let Ok(name_c) = cstring(name) else {
            return;
        };
        let device_type = unsafe { libav.util.av_hwdevice_find_type_by_name(name_c.as_ptr()) };
        if device_type == AV_HWDEVICE_TYPE_NONE {
            continue;
        }
        let supported = (0..)
            .map_while(|index| {
                let config = unsafe { libav.codec.avcodec_get_hw_config(codec, index) };
                (!config.is_null()).then_some(config)
            })
            .any(|config| unsafe {
                (*config).methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX as c_int != 0
                    && (*config).device_type == device_type
            });
        if !supported {
            continue;
        }
        if let Some(device) = shared_device(libav, device_type) {
            unsafe {
                (*decoder).hw_device_ctx = libav.util.av_buffer_ref(device);
                (*decoder).extra_hw_frames = EXTRA_HARDWARE_FRAMES;
            }
            return;
        }
    }
}

#[derive(Clone, Copy)]
struct DecoderOptions {
    keyframes_only: bool,
    low_delay: bool,
    scales_on_device: bool,
}

fn open_decoder(
    libav: &Libav,
    stream: *const AVStream,
    codec: *const AVCodec,
    options: DecoderOptions,
    hardware: bool,
) -> Result<Codec, String> {
    let decoder = Codec::new(libav, codec)?;
    libav.check(
        unsafe {
            libav
                .codec
                .avcodec_parameters_to_context(decoder.0, (*stream).codecpar)
        },
        "Could not configure the video decoder",
    )?;
    unsafe {
        (*decoder.0).pkt_timebase = (*stream).time_base;
        (*decoder.0).thread_count = 0;
        if options.low_delay {
            (*decoder.0).thread_type = SLICE_THREADS;
        }
        if options.keyframes_only {
            (*decoder.0).skip_frame = AVDISCARD_NONKEY;
        }
    }
    if hardware {
        let mut order = HARDWARE.to_vec();
        if options.scales_on_device {
            order.sort_by_key(|name| scaler_rank(name));
        }
        attach_hardware(libav, codec, decoder.0, &order);
    }
    let opened = unsafe { libav.codec.avcodec_open2(decoder.0, codec, ptr::null_mut()) };
    if opened < 0 {
        evict_device(&decoder);
    }
    libav.check(opened, "Could not open the video decoder")?;
    Ok(decoder)
}

impl VideoPipe {
    pub fn open(spec: &VideoSpec) -> Result<Self, String> {
        Self::open_at(spec, None)
    }

    pub fn open_at(spec: &VideoSpec, grid: Option<Grid>) -> Result<Self, String> {
        let libav = require()?;
        let input = Input::open(libav, spec.path)?;
        let stream_index = input.best_stream(AVMEDIA_TYPE_VIDEO);
        libav.check(
            stream_index,
            &format!("'{}' has no video stream", spec.path.display()),
        )?;
        input.keep_only(stream_index);
        let stream = input.stream(stream_index);
        let (parameters, time_base) = unsafe { ((*stream).codecpar, (*stream).time_base) };
        let codec = unsafe { libav.codec.avcodec_find_decoder((*parameters).codec_id) };
        if codec.is_null() {
            return Err(format!(
                "FFmpeg cannot decode the video in '{}'",
                spec.path.display()
            ));
        }
        let options = DecoderOptions {
            keyframes_only: spec.keyframes_only,
            low_delay: spec.low_delay,
            scales_on_device: spec.device_scale.is_some(),
        };
        let decoder =
            open_decoder(libav, stream, codec, options, spec.hwaccel).or_else(|error| {
                if spec.hwaccel {
                    open_decoder(libav, stream, codec, options, false)
                } else {
                    Err(error)
                }
            })?;

        let rotations = rotation_filters(rotation(libav, parameters), libav);
        let output = format!("format=pix_fmts={}", spec.pixel_format);
        let filters: Vec<&str> = rotations
            .iter()
            .copied()
            .chain((!spec.filters.trim().is_empty()).then_some(spec.filters))
            .chain([output.as_str()])
            .collect();
        let device_chain = spec.device_scale.as_ref().map(|scale| {
            let size = if rotations
                .iter()
                .any(|filter| filter.starts_with("transpose"))
            {
                (scale.size.1, scale.size.0)
            } else {
                scale.size
            };
            let interleaved = format!("format=pix_fmts={}", scale.format);
            DeviceChain {
                size,
                format: scale.format.to_string(),
                tail: rotations
                    .iter()
                    .copied()
                    .chain([interleaved.as_str()])
                    .collect::<Vec<_>>()
                    .join(","),
            }
        });

        let offset = input.start_offset(time_base);
        let target = offset + (spec.start.max(0.0) / q2d(time_base)).round() as i64;
        let seek = |min: i64, max: i64| unsafe {
            libav
                .format
                .avformat_seek_file(input.0, stream_index, min, target, max, 0)
        };
        let (start, keyframe_before, sought) = if spec.start <= 0.0 {
            (offset, false, false)
        } else if spec.keyframes_only && seek(target, i64::MAX) >= 0 {
            (target, false, false)
        } else {
            let sought = seek(i64::MIN, target) >= 0;
            if spec.keyframes_only {
                (offset, true, false)
            } else {
                (target, false, sought)
            }
        };
        let origin = grid.map_or(start, |grid| {
            offset + (grid.origin / q2d(time_base)).round() as i64
        });
        let rate = unsafe { (*stream).avg_frame_rate };
        let frame_ticks = if rate.num > 0 && rate.den > 0 {
            (1.0 / q2d(rate) / q2d(time_base)) as i64
        } else {
            0
        };

        Ok(Self {
            libav,
            input,
            stream_index,
            time_base,
            offset,
            start,
            origin,
            first_limit: grid.map(|_| start - origin - frame_ticks / 2),
            seek: sought.then(|| Seek::to(target, time_base)),
            keyframe_before,
            tolerance: frame_ticks / 2,
            codec,
            options,
            decoder,
            passed: Position::default(),
            resume: Position {
                output: grid.map(|grid| grid.first - 1),
                ..Position::default()
            },
            last_input: None,
            last_output: None,
            timing: None,
            timing_filters: if spec.timing.trim().is_empty() {
                PASSTHROUGH.to_string()
            } else {
                spec.timing.to_string()
            },
            conversion: None,
            filters: filters.join(","),
            device_chain,
            packet: Packet::new(libav)?,
            decoded: Frame::new(libav)?,
            transferred: Frame::new(libav)?,
            held: Frame::new(libav)?,
            holding: false,
            timed: Frame::new(libav)?,
            output: Frame::new(libav)?,
            limit: spec.frames,
            emitted: 0,
            source: None,
            pending: false,
            input_done: false,
            decoder_flushed: false,
            timing_flushed: false,
            conversion_flushed: false,
            demand: None,
        })
    }

    pub fn demand(&mut self, demand: Demand) {
        self.demand = Some(demand);
    }

    fn discard_unwanted(&mut self) {
        if self.options.keyframes_only {
            return;
        }
        let Some(demand) = self.demand.as_mut() else {
            return;
        };
        let pts = unsafe { (*self.packet.0).pts };
        let settled = self.seek.is_none() && !self.holding && self.last_input.is_some();
        let wanted = !settled
            || pts == NO_PTS
            || pts <= self.start
            || demand((pts - self.offset) as f64 * q2d(self.time_base));
        unsafe {
            (*self.decoder.0).skip_frame = if wanted {
                AVDISCARD_DEFAULT
            } else {
                AVDISCARD_NONREF
            };
        }
    }

    pub fn keyframe_before(&self) -> bool {
        self.keyframe_before
    }

    pub fn read(&mut self, buffer: &mut Vec<u8>) -> Result<Option<FrameInfo>, String> {
        self.read_with(move |size| {
            buffer.resize(size, 0);
            Some(buffer.as_mut_slice())
        })
    }

    pub fn read_into(&mut self, destination: &mut [u8]) -> Result<Option<FrameInfo>, String> {
        self.read_with(move |size| (size == destination.len()).then_some(destination))
    }

    pub fn source_time(&self) -> Option<f64> {
        self.source
    }

    pub fn source_tick(&self) -> f64 {
        q2d(self.time_base)
    }

    pub fn next_shape(&mut self) -> Result<Option<FrameShape>, String> {
        if !self.pull()? {
            return Ok(None);
        }
        let libav = self.libav;
        let (width, height, format) = unsafe {
            (
                (*self.output.0).width,
                (*self.output.0).height,
                (*self.output.0).format,
            )
        };
        let bytes = unsafe {
            libav
                .util
                .av_image_get_buffer_size(format, width, height, 1)
        };
        libav.check(bytes, "Unsupported frame layout")?;
        Ok(Some(FrameShape {
            size: (width as u32, height as u32),
            interleaved: matches!(format, AV_PIX_FMT_NV12 | AV_PIX_FMT_P010LE),
            bytes: bytes as usize,
        }))
    }

    fn read_with<'a>(
        &mut self,
        destination: impl FnOnce(usize) -> Option<&'a mut [u8]>,
    ) -> Result<Option<FrameInfo>, String> {
        if !self.pull()? {
            return Ok(None);
        }
        let libav = self.libav;
        let copied = self.copy_output(destination);
        let time_base = self
            .conversion
            .as_ref()
            .map_or(self.time_base, |chain| unsafe {
                libav.filter.av_buffersink_get_time_base(chain.sink)
            });
        let info = copied.map(|(width, height)| FrameInfo {
            width,
            height,
            pts: unsafe { (*self.output.0).pts },
            duration: unsafe { (*self.output.0).duration },
            time_base,
        });
        self.source = match unsafe { (*self.output.0).best_effort_timestamp } {
            NO_PTS => None,
            timestamp => Some((timestamp - self.offset) as f64 * q2d(self.time_base)),
        };
        self.output.unref();
        self.pending = false;
        self.emitted += 1;
        info.map(Some)
    }

    fn pull(&mut self) -> Result<bool, String> {
        let libav = self.libav;
        loop {
            if self.pending {
                return Ok(true);
            }
            if self.limit.is_some_and(|limit| self.emitted >= limit) {
                return Ok(false);
            }
            if let Some(chain) = &self.conversion {
                let pulled = unsafe {
                    libav
                        .filter
                        .av_buffersink_get_frame(chain.sink, self.output.0)
                };
                if pulled >= 0 {
                    let pts = unsafe { (*self.output.0).pts };
                    if self.resume.skips_conversion(pts) {
                        self.output.unref();
                        continue;
                    }
                    self.passed.converted = Some(pts);
                    self.pending = true;
                    continue;
                }
                if pulled == END {
                    return Ok(false);
                }
                if pulled != AGAIN {
                    return Err(libav.error(pulled));
                }
            }
            if self.conversion_flushed {
                return Ok(false);
            }
            if self.next_timed()? {
                self.convert_timed()?;
            } else {
                if let Some(chain) = &self.conversion {
                    unsafe {
                        libav
                            .filter
                            .av_buffersrc_add_frame_flags(chain.source, ptr::null_mut(), 0)
                    };
                }
                self.conversion_flushed = true;
                if self.conversion.is_none() {
                    return Ok(false);
                }
            }
        }
    }

    pub fn skip(&mut self) -> Result<bool, String> {
        if self.limit.is_some_and(|limit| self.emitted >= limit) || !self.next_timed()? {
            return Ok(false);
        }
        let pts = unsafe { (*self.timed.0).pts };
        self.timed.unref();
        self.handed_off(pts, false);
        self.emitted += 1;
        Ok(true)
    }

    fn handed_off(&mut self, pts: i64, converting: bool) {
        let previous = self.last_output.replace(pts);
        self.passed.output = if converting { previous } else { Some(pts) };
    }

    fn submitted(&mut self, timestamp: i64) {
        self.passed.input = self.last_input.replace(timestamp);
    }

    fn next_timed(&mut self) -> Result<bool, String> {
        let libav = self.libav;
        loop {
            if let Some(chain) = &self.timing {
                let pulled = unsafe {
                    libav
                        .filter
                        .av_buffersink_get_frame(chain.sink, self.timed.0)
                };
                if pulled >= 0 {
                    let pts = unsafe { (*self.timed.0).pts };
                    if self.resume.skips_output(pts) {
                        self.timed.unref();
                        continue;
                    }
                    return Ok(true);
                }
                if pulled == END {
                    return Ok(false);
                }
                if pulled != AGAIN {
                    return Err(libav.error(pulled));
                }
            }
            if self.timing_flushed {
                return Ok(false);
            }
            let received = unsafe {
                libav
                    .codec
                    .avcodec_receive_frame(self.decoder.0, self.decoded.0)
            };
            if received >= 0 {
                self.push_decoded()?;
            } else if received == AGAIN {
                self.feed_decoder()?;
            } else if received != END && self.hardware() {
                self.decode_in_software(received)?;
            } else if let Some(seek) = self.seek.take()
                && self.retreat(seek, seek.at)
            {
                continue;
            } else if self.options.keyframes_only && std::mem::take(&mut self.holding) {
                self.submit_held()?;
            } else {
                if let Some(chain) = &self.timing {
                    unsafe {
                        libav
                            .filter
                            .av_buffersrc_add_frame_flags(chain.source, ptr::null_mut(), 0)
                    };
                }
                self.timing_flushed = true;
                if self.timing.is_none() {
                    return Ok(false);
                }
            }
        }
    }

    fn feed_decoder(&mut self) -> Result<(), String> {
        let libav = self.libav;
        if self.decoder_flushed {
            return Ok(());
        }
        if self.input_done {
            unsafe { libav.codec.avcodec_send_packet(self.decoder.0, ptr::null()) };
            self.decoder_flushed = true;
            return Ok(());
        }
        let read = unsafe { libav.format.av_read_frame(self.input.0, self.packet.0) };
        if read < 0 {
            self.input_done = true;
            return Ok(());
        }
        let sent = if unsafe { (*self.packet.0).stream_index } == self.stream_index {
            self.discard_unwanted();
            unsafe {
                libav
                    .codec
                    .avcodec_send_packet(self.decoder.0, self.packet.0)
            }
        } else {
            0
        };
        self.packet.unref();
        if sent < 0 && sent != AGAIN && sent != END && self.hardware() {
            return self.decode_in_software(sent);
        }
        Ok(())
    }

    fn hardware(&self) -> bool {
        unsafe { !(*self.decoder.0).hw_device_ctx.is_null() }
    }

    fn decode_in_software(&mut self, error: c_int) -> Result<(), String> {
        let libav = self.libav;
        log::warn!(
            "Hardware video decoding failed, continuing in software: {}",
            libav.error(error)
        );
        evict_device(&self.decoder);
        self.decoded.unref();
        self.held.unref();
        self.holding = false;
        self.decoder = open_decoder(
            libav,
            self.input.stream(self.stream_index),
            self.codec,
            self.options,
            false,
        )?;
        let target = self.passed.input.unwrap_or(self.start);
        let sought = unsafe {
            libav.format.avformat_seek_file(
                self.input.0,
                self.stream_index,
                i64::MIN,
                target,
                target,
                0,
            )
        };
        self.seek = (sought >= 0).then(|| Seek::to(target, self.time_base));
        self.input_done = false;
        self.decoder_flushed = false;
        self.timing = None;
        self.timing_flushed = false;
        self.conversion = None;
        self.conversion_flushed = false;
        self.resume = Position {
            output: self.passed.output.max(self.resume.output),
            ..self.passed
        };
        Ok(())
    }

    fn retreat(&mut self, seek: Seek, late: i64) -> bool {
        let floor = self.offset.saturating_sub(retreat_step(self.time_base));
        if seek.at <= floor {
            return false;
        }
        let back = seek.back.max(late.saturating_sub(seek.at));
        let at = seek.at.saturating_sub(back).max(floor);
        let sought = unsafe {
            self.libav.format.avformat_seek_file(
                self.input.0,
                self.stream_index,
                i64::MIN,
                at,
                at,
                0,
            )
        };
        if sought < 0 {
            return false;
        }
        unsafe { self.libav.codec.avcodec_flush_buffers(self.decoder.0) };
        self.input_done = false;
        self.decoder_flushed = false;
        self.seek = Some(Seek {
            at,
            back: back.saturating_mul(2),
            ..seek
        });
        true
    }

    fn device_scaler(&self, frame: *const AVFrame) -> Option<Scaler> {
        self.device_chain.as_ref()?;
        let format = unsafe { (*frame).format };
        DEVICE_SCALERS
            .iter()
            .find(|(_, hardware, _)| *hardware == format)
            .map(|&(.., scale)| scale)
    }

    fn download(&self, frame: *mut AVFrame) -> Result<*mut AVFrame, c_int> {
        let libav = self.libav;
        if unsafe { (*frame).hw_frames_ctx.is_null() } {
            return Ok(frame);
        }
        let transferred = unsafe {
            libav
                .util
                .av_hwframe_transfer_data(self.transferred.0, frame, 0)
        };
        if transferred >= 0 {
            unsafe { libav.util.av_frame_copy_props(self.transferred.0, frame) };
        }
        unsafe { libav.util.av_frame_unref(frame) };
        if transferred < 0 {
            return Err(transferred);
        }
        Ok(self.transferred.0)
    }

    fn push_decoded(&mut self) -> Result<(), String> {
        let timestamp = timestamp_of(self.decoded.0);
        if let Some(seek) = self.seek.take()
            && timestamp != NO_PTS
            && timestamp > seek.wanted
            && self.retreat(seek, timestamp)
        {
            self.decoded.unref();
            return Ok(());
        }
        if self.resume.skips_input(timestamp) {
            self.decoded.unref();
            return Ok(());
        }
        if timestamp != NO_PTS && timestamp < self.start - self.tolerance {
            self.held.unref();
            std::mem::swap(&mut self.held, &mut self.decoded);
            self.holding = true;
            return Ok(());
        }
        if std::mem::take(&mut self.holding)
            && timestamp != NO_PTS
            && (self.origin != self.start || timestamp > self.start + self.tolerance)
        {
            self.submit_held()?;
        }
        let latest = self
            .first_limit
            .filter(|_| self.last_input.is_none())
            .unwrap_or(i64::MAX);
        unsafe {
            (*self.decoded.0).pts = if timestamp == NO_PTS {
                NO_PTS
            } else {
                (timestamp - self.origin).min(latest)
            };
        }
        let frame = self.decoded.0;
        self.submit_timing(frame)?;
        if timestamp != NO_PTS {
            self.submitted(timestamp);
        }
        Ok(())
    }

    fn submit_held(&mut self) -> Result<(), String> {
        let held_at = timestamp_of(self.held.0);
        unsafe { (*self.held.0).pts = (held_at - self.origin).max(0) };
        let frame = self.held.0;
        self.submit_timing(frame)?;
        self.submitted(held_at);
        Ok(())
    }

    fn submit_timing(&mut self, frame: *mut AVFrame) -> Result<(), String> {
        let libav = self.libav;
        if self
            .timing
            .as_ref()
            .is_none_or(|chain| !chain.accepts(frame))
        {
            let filters = self.timing_filters.clone();
            self.timing = Some(self.build_chain(frame, &filters, self.time_base)?);
        }
        let chain = self
            .timing
            .as_ref()
            .expect("the timing filters were just built");
        let added = unsafe {
            libav
                .filter
                .av_buffersrc_add_frame_flags(chain.source, frame, 0)
        };
        unsafe { libav.util.av_frame_unref(frame) };
        libav
            .check(added, "Could not time a video frame")
            .map(|_| ())
    }

    fn convert_timed(&mut self) -> Result<(), String> {
        let libav = self.libav;
        let time_base = self.timing.as_ref().map_or(self.time_base, |chain| unsafe {
            libav.filter.av_buffersink_get_time_base(chain.sink)
        });
        let timed = self.timed.0;
        let pts = unsafe { (*timed).pts };
        let scaler = self.device_scaler(timed);
        let frame = if scaler.is_some() {
            timed
        } else {
            match self.download(timed) {
                Ok(frame) => frame,
                Err(error) => return self.decode_in_software(error),
            }
        };
        if self
            .conversion
            .as_ref()
            .is_none_or(|chain| !chain.accepts(frame))
        {
            let device = self
                .device_chain
                .as_ref()
                .zip(scaler)
                .map(|(chain, scale)| chain.filters(scale));
            let built = match &device {
                Some(filters) => self.build_chain(frame, filters, time_base),
                None => {
                    let filters = self.filters.clone();
                    self.build_chain(frame, &filters, time_base)
                }
            };
            match built {
                Ok(chain) => self.conversion = Some(chain),
                Err(error) if device.is_some() => {
                    log::warn!("Scaling video on the CPU instead of the GPU: {}", error);
                    self.device_chain = None;
                    return self.convert_timed();
                }
                Err(error) => return Err(error),
            }
        }
        let chain = self
            .conversion
            .as_ref()
            .expect("the conversion filters were just built");
        let added = unsafe {
            libav
                .filter
                .av_buffersrc_add_frame_flags(chain.source, frame, 0)
        };
        unsafe { libav.util.av_frame_unref(frame) };
        libav.check(added, "Could not filter a video frame")?;
        self.handed_off(pts, true);
        Ok(())
    }

    fn build_chain(
        &self,
        frame: *const AVFrame,
        description: &str,
        time_base: AVRational,
    ) -> Result<FilterChain, String> {
        let libav = self.libav;
        let graph = Graph::new(libav)?;
        let (width, height, format, aspect, colorspace, range, frames) = unsafe {
            (
                (*frame).width,
                (*frame).height,
                (*frame).format,
                (*frame).sample_aspect_ratio,
                (*frame).colorspace,
                (*frame).color_range,
                (*frame).hw_frames_ctx,
            )
        };
        let source = if frames.is_null() {
            let args = format!(
                "video_size={}x{}:pix_fmt={}:time_base={}/{}:pixel_aspect={}/{}:colorspace={}:range={}",
                width,
                height,
                format,
                time_base.num,
                time_base.den,
                aspect.num.max(1),
                aspect.den.max(1),
                colorspace,
                range
            );
            graph.create(libav, "buffer", "in", &args)?
        } else {
            graph.create_hardware_source(libav, "in", |parameters| {
                parameters.format = format;
                parameters.width = width;
                parameters.height = height;
                parameters.time_base = time_base;
                parameters.sample_aspect_ratio = AVRational {
                    num: aspect.num.max(1),
                    den: aspect.den.max(1),
                };
                parameters.color_space = colorspace;
                parameters.color_range = range;
                parameters.hw_frames_ctx = frames;
            })?
        };
        let sink = graph.create(libav, "buffersink", "out", "")?;
        graph.link(libav, description, &[("in", source)], &[("out", sink)])?;
        Ok(FilterChain {
            _graph: graph,
            source,
            sink,
            input: (width, height, format),
        })
    }

    fn copy_output<'a>(
        &self,
        destination: impl FnOnce(usize) -> Option<&'a mut [u8]>,
    ) -> Result<(u32, u32), String> {
        let libav = self.libav;
        let frame = self.output.0;
        let (width, height, format) = unsafe { ((*frame).width, (*frame).height, (*frame).format) };
        let size = unsafe {
            libav
                .util
                .av_image_get_buffer_size(format, width, height, 1)
        };
        libav.check(size, "Unsupported frame layout")?;
        let buffer = destination(size as usize).ok_or("The video frame has an unexpected size")?;
        let copied = unsafe {
            libav.util.av_image_copy_to_buffer(
                buffer.as_mut_ptr(),
                size,
                (*frame).data.as_ptr() as *const *const u8,
                (*frame).linesize.as_ptr(),
                format,
                width,
                height,
                1,
            )
        };
        libav.check(copied, "Could not copy a video frame")?;
        Ok((width as u32, height as u32))
    }
}
