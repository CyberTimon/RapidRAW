use std::collections::HashMap;
use std::ffi::c_int;
use std::path::Path;
use std::ptr;

use super::audio::AudioMix;
use super::sys::types::*;
use super::{
    AGAIN, Codec, Dictionary, END, Frame, Graph, Libav, Packet, cstring, path_cstring, rational,
    require,
};

const FLAG_QSCALE: c_int = 1 << 1;
const FLAG_GLOBAL_HEADER: c_int = 1 << 22;
const QP_TO_LAMBDA: c_int = 118;
const FORMAT_NO_FILE: c_int = 0x0001;
const FORMAT_GLOBAL_HEADER: c_int = 0x0040;
const IO_WRITE: c_int = 2;
const RANGE_TV: AVColorRange = 1;
const RANGE_PC: AVColorRange = 2;
const PROBE_SIZE: c_int = 256;
const PROBE_FRAMES: i64 = 3;
const UPLOADS: [(&str, &str); 1] = [("_vaapi", "vaapi")];

#[derive(Clone, Copy, Debug)]
pub struct ColorTags {
    pub primaries: &'static str,
    pub transfer: &'static str,
    pub matrix: &'static str,
}

#[derive(Clone, Debug)]
pub struct VideoSettings {
    pub encoder: String,
    pub pixel_format: &'static str,
    pub options: Vec<(&'static str, String)>,
    pub gop: Option<i32>,
    pub quality_scale: Option<i32>,
    pub codec_tag: Option<[u8; 4]>,
    pub color: ColorTags,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioSettings {
    pub encoder: &'static str,
    pub sample_format: &'static str,
    pub bit_rate: Option<i64>,
}

pub struct VideoInput<'a> {
    pub size: (u32, u32),
    pub frame_rate: (i32, i32),
    pub time_base: (i32, i32),
    pub pixel_format: &'a str,
    pub rgb: bool,
    pub filters: &'a str,
}

pub struct OutputSpec<'a> {
    pub path: &'a Path,
    pub container: &'a str,
    pub faststart: bool,
    pub creation_time: Option<&'a str>,
    pub video: &'a VideoSettings,
    pub input: VideoInput<'a>,
    pub audio: Option<(&'a AudioSettings, AudioMix)>,
}

struct VideoEncoder {
    codec: Codec,
    stream: *mut AVStream,
    _graph: Graph,
    source: *mut AVFilterContext,
    sink: *mut AVFilterContext,
    input: Frame,
    filtered: Frame,
    input_format: AVPixelFormat,
    size: (c_int, c_int),
    colorspace: AVColorSpace,
    range: AVColorRange,
}

struct EncoderInput {
    graph: Graph,
    source: *mut AVFilterContext,
    sink: *mut AVFilterContext,
}

struct AudioEncoder {
    codec: Codec,
    stream: *mut AVStream,
    mix: AudioMix,
    written: i64,
}

struct OutputFile(*mut AVFormatContext);

impl Drop for OutputFile {
    fn drop(&mut self) {
        let libav = super::libav();
        unsafe {
            if !(*self.0).pb.is_null() && (*(*self.0).oformat).flags & FORMAT_NO_FILE == 0 {
                libav.format.avio_closep(&mut (*self.0).pb);
            }
            libav.format.avformat_free_context(self.0);
        }
    }
}

pub struct Muxer {
    libav: &'static Libav,
    output: OutputFile,
    video: VideoEncoder,
    audio: Option<AudioEncoder>,
    packet: Packet,
    end_pts: i64,
    time_base: (i32, i32),
    frame_duration: i64,
    durations: HashMap<i64, i64>,
}

unsafe impl Send for Muxer {}

fn color_value(libav: &Libav, kind: &str, name: &str) -> Result<c_int, String> {
    let name_c = cstring(name)?;
    let value = unsafe {
        match kind {
            "primaries" => libav.util.av_color_primaries_from_name(name_c.as_ptr()),
            "transfer" => libav.util.av_color_transfer_from_name(name_c.as_ptr()),
            _ => libav.util.av_color_space_from_name(name_c.as_ptr()),
        }
    };
    if value < 0 {
        Err(format!("Unknown color tag {}", name))
    } else {
        Ok(value)
    }
}

fn encoder_input(
    libav: &Libav,
    settings: &VideoSettings,
    source: &str,
    filters: &str,
) -> Result<EncoderInput, String> {
    let device = UPLOADS
        .iter()
        .find(|(suffix, _)| settings.encoder.ends_with(suffix))
        .map(|&(_, name)| {
            super::video::named_device(libav, name)
                .ok_or_else(|| format!("Could not open the {} device", name))
        })
        .transpose()?;
    let graph = Graph::new(libav)?;
    let source = graph.create(libav, "buffer", "in", source)?;
    let sink = graph.create(libav, "buffersink", "out", "")?;
    let mut chain = Vec::new();
    if !filters.is_empty() {
        chain.push(filters.to_string());
    }
    chain.push(format!("format=pix_fmts={}", settings.pixel_format));
    let chain = chain.join(",");
    match device {
        Some(device) => {
            let upload = graph.create_on_device(libav, "hwupload", "upload", device)?;
            graph.link(
                libav,
                &format!("[in]{}[up];[upload]null[out]", chain),
                &[("in", source), ("upload", upload)],
                &[("up", upload), ("out", sink)],
            )?;
        }
        None => graph.link(libav, &chain, &[("in", source)], &[("out", sink)])?,
    }
    Ok(EncoderInput {
        graph,
        source,
        sink,
    })
}

fn configure_video(
    libav: &Libav,
    settings: &VideoSettings,
    size: (c_int, c_int),
    frame_rate: (i32, i32),
    time_base: (i32, i32),
    global_header: bool,
    input: &EncoderInput,
) -> Result<(Codec, *const AVCodec), String> {
    let name = cstring(&settings.encoder)?;
    let codec = unsafe { libav.codec.avcodec_find_encoder_by_name(name.as_ptr()) };
    if codec.is_null() {
        return Err(format!("FFmpeg has no {} encoder", settings.encoder));
    }
    let context = Codec::new(libav, codec)?;
    unsafe {
        let c = context.0;
        (*c).width = size.0;
        (*c).height = size.1;
        let frames = libav.filter.av_buffersink_get_hw_frames_ctx(input.sink);
        if frames.is_null() {
            (*c).pix_fmt = libav.pixel_format(settings.pixel_format)?;
        } else {
            (*c).pix_fmt = (*(*frames).data.cast::<AVHWFramesContext>()).format;
            (*c).hw_frames_ctx = libav.util.av_buffer_ref(frames);
        }
        (*c).time_base = rational(time_base.0, time_base.1);
        (*c).framerate = rational(frame_rate.0, frame_rate.1);
        (*c).sample_aspect_ratio = rational(1, 1);
        (*c).color_primaries = color_value(libav, "primaries", settings.color.primaries)?;
        (*c).color_trc = color_value(libav, "transfer", settings.color.transfer)?;
        (*c).colorspace = color_value(libav, "matrix", settings.color.matrix)?;
        (*c).color_range = RANGE_TV;
        (*c).thread_count = 0;
        if let Some(gop) = settings.gop {
            (*c).gop_size = gop;
        }
        if let Some(scale) = settings.quality_scale {
            (*c).flags |= FLAG_QSCALE;
            (*c).global_quality = scale * QP_TO_LAMBDA;
        }
        if global_header {
            (*c).flags |= FLAG_GLOBAL_HEADER;
        }
    }
    let mut options = Dictionary::default();
    for (key, value) in &settings.options {
        options.set(key, value)?;
    }
    let opened = unsafe { libav.codec.avcodec_open2(context.0, codec, &mut options.0) };
    libav.check(
        opened,
        &format!("Could not start the {} encoder", settings.encoder),
    )?;
    Ok((context, codec))
}

pub fn probe_encoder(settings: &VideoSettings) -> bool {
    let Ok(libav) = require() else {
        return false;
    };
    let Ok(format) = libav.pixel_format(settings.pixel_format) else {
        return false;
    };
    let size = (PROBE_SIZE, PROBE_SIZE);
    let source = format!(
        "video_size={}x{}:pix_fmt={}:time_base=1/25:pixel_aspect=1/1",
        size.0, size.1, format
    );
    let Ok(input) = encoder_input(libav, settings, &source, "") else {
        return false;
    };
    let Ok((context, _)) = configure_video(libav, settings, size, (25, 1), (1, 25), false, &input)
    else {
        return false;
    };
    let (Ok(frame), Ok(filtered), Ok(packet)) =
        (Frame::new(libav), Frame::new(libav), Packet::new(libav))
    else {
        return false;
    };
    let bytes = unsafe {
        libav
            .util
            .av_image_get_buffer_size(format, size.0, size.1, 1)
    };
    if bytes <= 0 {
        return false;
    }
    let pixels = vec![0u8; bytes as usize];
    let mut produced = 0;
    let mut encode = |frame: *const AVFrame| {
        if unsafe { libav.codec.avcodec_send_frame(context.0, frame) } < 0 {
            return false;
        }
        loop {
            let received = unsafe { libav.codec.avcodec_receive_packet(context.0, packet.0) };
            if received == AGAIN || received == END {
                return true;
            }
            if received < 0 {
                return false;
            }
            produced += 1;
            packet.unref();
        }
    };
    for index in 0..=PROBE_FRAMES {
        let added = if index < PROBE_FRAMES {
            unsafe {
                (*frame.0).width = size.0;
                (*frame.0).height = size.1;
                (*frame.0).format = format;
                (*frame.0).pts = index;
                libav.util.av_image_fill_arrays(
                    (*frame.0).data.as_mut_ptr(),
                    (*frame.0).linesize.as_mut_ptr(),
                    pixels.as_ptr(),
                    format,
                    size.0,
                    size.1,
                    1,
                );
                libav
                    .filter
                    .av_buffersrc_add_frame_flags(input.source, frame.0, 0)
            }
        } else {
            unsafe {
                libav
                    .filter
                    .av_buffersrc_add_frame_flags(input.source, ptr::null_mut(), 0)
            }
        };
        frame.unref();
        if added < 0 {
            return false;
        }
        loop {
            let pulled = unsafe { libav.filter.av_buffersink_get_frame(input.sink, filtered.0) };
            if pulled == AGAIN || pulled == END {
                break;
            }
            if pulled < 0 {
                return false;
            }
            let sent = encode(filtered.0);
            filtered.unref();
            if !sent {
                return false;
            }
        }
    }
    let flushed = encode(ptr::null());
    flushed && produced > 0
}

impl Muxer {
    pub fn open(spec: OutputSpec) -> Result<Self, String> {
        let libav = require()?;
        let path_c = path_cstring(spec.path)?;
        let container = cstring(spec.container)?;
        let mut output: *mut AVFormatContext = ptr::null_mut();
        libav.check(
            unsafe {
                libav.format.avformat_alloc_output_context2(
                    &mut output,
                    ptr::null(),
                    container.as_ptr(),
                    path_c.as_ptr(),
                )
            },
            "Could not create the output file",
        )?;
        let output = OutputFile(output);
        let video = open_video(libav, output.0, &spec)?;
        let frame_duration = unsafe {
            let codec = video.codec.0;
            let rate = (*codec).framerate;
            libav
                .util
                .av_rescale_q(1, rational(rate.den, rate.num), (*codec).time_base)
        };
        let mut muxer = Self {
            libav,
            video,
            output,
            audio: None,
            packet: Packet::new(libav)?,
            end_pts: 0,
            time_base: spec.input.time_base,
            frame_duration,
            durations: HashMap::new(),
        };
        if let Some((settings, mix)) = spec.audio {
            muxer.audio = Some(open_audio(libav, muxer.output.0, settings, mix)?);
        }
        let output = muxer.output.0;
        unsafe {
            if (*(*output).oformat).flags & FORMAT_NO_FILE == 0 {
                libav.check(
                    libav
                        .format
                        .avio_open(&mut (*output).pb, path_c.as_ptr(), IO_WRITE),
                    &format!("Could not write '{}'", spec.path.display()),
                )?;
            }
        }
        if let Some(time) = spec.creation_time {
            let (key, value) = (cstring("creation_time")?, cstring(time)?);
            libav.check(
                unsafe {
                    libav
                        .util
                        .av_dict_set(&mut (*output).metadata, key.as_ptr(), value.as_ptr(), 0)
                },
                "Could not set the creation time",
            )?;
        }
        let mut options = Dictionary::default();
        if spec.faststart {
            options.set("movflags", "+faststart")?;
        }
        libav.check(
            unsafe { libav.format.avformat_write_header(output, &mut options.0) },
            "Could not start the output file",
        )?;
        Ok(muxer)
    }

    pub fn write_video(
        &mut self,
        pixels: &[u8],
        pts: i64,
        duration: Option<i64>,
    ) -> Result<(), String> {
        let libav = self.libav;
        let video = &self.video;
        unsafe {
            let frame = video.input.0;
            (*frame).width = video.size.0;
            (*frame).height = video.size.1;
            (*frame).format = video.input_format;
            (*frame).pts = pts;
            (*frame).colorspace = video.colorspace;
            (*frame).color_range = video.range;
            libav.util.av_image_fill_arrays(
                (*frame).data.as_mut_ptr(),
                (*frame).linesize.as_mut_ptr(),
                pixels.as_ptr(),
                video.input_format,
                video.size.0,
                video.size.1,
                1,
            );
            let added = libav
                .filter
                .av_buffersrc_add_frame_flags(video.source, frame, 0);
            video.input.unref();
            libav.check(added, "Could not convert a video frame")?;
        }
        if let Some(duration) = duration {
            self.durations.insert(pts, duration);
        }
        self.end_pts = self.end_pts.max(pts + 1);
        self.drain_video()?;
        self.write_audio_until(self.end_pts)
    }

    fn drain_video(&mut self) -> Result<(), String> {
        let libav = self.libav;
        loop {
            let pulled = unsafe {
                libav
                    .filter
                    .av_buffersink_get_frame(self.video.sink, self.video.filtered.0)
            };
            if pulled == AGAIN || pulled == END {
                return Ok(());
            }
            libav.check(pulled, "Could not convert a video frame")?;
            let sent = unsafe {
                libav
                    .codec
                    .avcodec_send_frame(self.video.codec.0, self.video.filtered.0)
            };
            self.video.filtered.unref();
            libav.check(sent, "Could not encode a video frame")?;
            self.write_packets(true)?;
        }
    }

    fn write_packets(&mut self, video: bool) -> Result<(), String> {
        let libav = self.libav;
        let (codec, stream) = if video {
            (self.video.codec.0, self.video.stream)
        } else {
            let audio = self.audio.as_ref().expect("audio is set up");
            (audio.codec.0, audio.stream)
        };
        loop {
            let received = unsafe { libav.codec.avcodec_receive_packet(codec, self.packet.0) };
            if received == AGAIN || received == END {
                return Ok(());
            }
            libav.check(received, "Could not encode the video")?;
            unsafe {
                if video && (*self.packet.0).duration == 0 {
                    (*self.packet.0).duration = self
                        .durations
                        .remove(&(*self.packet.0).pts)
                        .unwrap_or(self.frame_duration);
                }
                libav.codec.av_packet_rescale_ts(
                    self.packet.0,
                    (*codec).time_base,
                    (*stream).time_base,
                );
                (*self.packet.0).stream_index = (*stream).index;
                let written = libav
                    .format
                    .av_interleaved_write_frame(self.output.0, self.packet.0);
                libav.check(written, "Could not write the video file")?;
            }
        }
    }

    fn write_audio_until(&mut self, end_pts: i64) -> Result<(), String> {
        let libav = self.libav;
        let (num, den) = self.time_base;
        loop {
            let Some(audio) = self.audio.as_mut() else {
                return Ok(());
            };
            let sample_rate = unsafe { (*audio.codec.0).sample_rate } as i64;
            if audio.written >= end_pts * sample_rate * num as i64 / den.max(1) as i64 {
                return Ok(());
            }
            let Some(frame) = audio.mix.pull()? else {
                return Ok(());
            };
            let sent = unsafe {
                (*frame).pts = audio.written;
                audio.written += (*frame).nb_samples as i64;
                libav.codec.avcodec_send_frame(audio.codec.0, frame)
            };
            libav.check(sent, "Could not encode the audio")?;
            self.write_packets(false)?;
        }
    }

    pub fn finish(mut self) -> Result<(), String> {
        let libav = self.libav;
        unsafe {
            libav
                .filter
                .av_buffersrc_add_frame_flags(self.video.source, ptr::null_mut(), 0)
        };
        self.drain_video()?;
        unsafe {
            libav
                .codec
                .avcodec_send_frame(self.video.codec.0, ptr::null())
        };
        self.write_packets(true)?;
        self.write_audio_until(self.end_pts)?;
        if let Some(audio) = &self.audio {
            unsafe { libav.codec.avcodec_send_frame(audio.codec.0, ptr::null()) };
            self.write_packets(false)?;
        }
        libav.check(
            unsafe { libav.format.av_write_trailer(self.output.0) },
            "Could not finish the video file",
        )?;
        Ok(())
    }
}

fn open_video(
    libav: &Libav,
    output: *mut AVFormatContext,
    spec: &OutputSpec,
) -> Result<VideoEncoder, String> {
    let size = (spec.input.size.0 as c_int, spec.input.size.1 as c_int);
    let global_header = unsafe { (*(*output).oformat).flags & FORMAT_GLOBAL_HEADER != 0 };
    let input_format = libav.pixel_format(spec.input.pixel_format)?;
    let (colorspace, range) = if spec.input.rgb {
        (0, RANGE_PC)
    } else {
        (
            color_value(libav, "matrix", spec.video.color.matrix)?,
            RANGE_TV,
        )
    };
    let args = format!(
        "video_size={}x{}:pix_fmt={}:time_base={}/{}:pixel_aspect=1/1:colorspace={}:range={}",
        size.0,
        size.1,
        input_format,
        spec.input.time_base.0,
        spec.input.time_base.1,
        colorspace,
        range
    );
    let input = encoder_input(libav, spec.video, &args, spec.input.filters)?;
    let (codec, _) = configure_video(
        libav,
        spec.video,
        size,
        spec.input.frame_rate,
        spec.input.time_base,
        global_header,
        &input,
    )?;
    let stream = unsafe { libav.format.avformat_new_stream(output, ptr::null()) };
    if stream.is_null() {
        return Err("Could not add the video stream".to_string());
    }
    unsafe {
        libav.check(
            libav
                .codec
                .avcodec_parameters_from_context((*stream).codecpar, codec.0),
            "Could not describe the video stream",
        )?;
        (*stream).time_base = (*codec.0).time_base;
        if let Some(tag) = spec.video.codec_tag {
            (*(*stream).codecpar).codec_tag = u32::from_le_bytes(tag);
        }
    }
    Ok(VideoEncoder {
        codec,
        stream,
        _graph: input.graph,
        source: input.source,
        sink: input.sink,
        input: Frame::new(libav)?,
        filtered: Frame::new(libav)?,
        input_format,
        size,
        colorspace,
        range,
    })
}

fn configure_audio(
    libav: &Libav,
    settings: &AudioSettings,
    global_header: bool,
) -> Result<Codec, String> {
    let name = cstring(settings.encoder)?;
    let codec = unsafe { libav.codec.avcodec_find_encoder_by_name(name.as_ptr()) };
    if codec.is_null() {
        return Err(format!("FFmpeg has no {} encoder", settings.encoder));
    }
    let context = Codec::new(libav, codec)?;
    let sample_format = cstring(settings.sample_format)?;
    unsafe {
        let c = context.0;
        (*c).sample_rate = crate::video::audio::SAMPLE_RATE as c_int;
        (*c).sample_fmt = libav.util.av_get_sample_fmt(sample_format.as_ptr());
        libav
            .util
            .av_channel_layout_default(&mut (*c).ch_layout, crate::video::audio::CHANNELS as c_int);
        (*c).time_base = rational(1, (*c).sample_rate);
        if let Some(bit_rate) = settings.bit_rate {
            (*c).bit_rate = bit_rate;
        }
        if global_header {
            (*c).flags |= FLAG_GLOBAL_HEADER;
        }
    }
    libav.check(
        unsafe { libav.codec.avcodec_open2(context.0, codec, ptr::null_mut()) },
        &format!("Could not start the {} encoder", settings.encoder),
    )?;
    Ok(context)
}

fn open_audio(
    libav: &Libav,
    output: *mut AVFormatContext,
    settings: &AudioSettings,
    mix: AudioMix,
) -> Result<AudioEncoder, String> {
    let global_header = unsafe { (*(*output).oformat).flags & FORMAT_GLOBAL_HEADER != 0 };
    let context = configure_audio(libav, settings, global_header)?;
    let stream = unsafe { libav.format.avformat_new_stream(output, ptr::null()) };
    if stream.is_null() {
        return Err("Could not add the audio stream".to_string());
    }
    unsafe {
        libav.check(
            libav
                .codec
                .avcodec_parameters_from_context((*stream).codecpar, context.0),
            "Could not describe the audio stream",
        )?;
        (*stream).time_base = (*context.0).time_base;
    }
    Ok(AudioEncoder {
        codec: context,
        stream,
        mix,
        written: 0,
    })
}

pub fn audio_frame_size(settings: &AudioSettings) -> Result<Option<u32>, String> {
    let context = configure_audio(require()?, settings, false)?;
    let frame_size = unsafe { (*context.0).frame_size };
    Ok((frame_size > 0).then_some(frame_size as u32))
}
