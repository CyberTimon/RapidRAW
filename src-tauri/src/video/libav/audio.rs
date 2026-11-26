use std::ffi::{c_char, c_int};
use std::path::Path;
use std::ptr;

use super::sys::types::*;
use super::{
    AGAIN, Codec, END, Frame, Graph, Input, Libav, NO_PTS, Packet, q2d, rational, require, text,
};

const SEEK_LEAD: f64 = 0.25;
const ORDER_UNSPEC: AVChannelOrder = 0;

pub struct AudioInput<'a> {
    pub path: &'a Path,
    pub seek: f64,
}

struct Source {
    input: Input,
    stream_index: c_int,
    time_base: AVRational,
    offset: i64,
    sample_rate: c_int,
    decoder: Codec,
    buffer: *mut AVFilterContext,
    packet: Packet,
    frame: Frame,
    next_pts: i64,
    input_done: bool,
    decoder_flushed: bool,
    closed: bool,
}

pub struct AudioMix {
    libav: &'static Libav,
    _graph: Graph,
    sink: *mut AVFilterContext,
    sources: Vec<Source>,
    frame: Frame,
    cursor: usize,
}

unsafe impl Send for AudioMix {}

fn open_source(libav: &'static Libav, input: &AudioInput) -> Result<(Source, String), String> {
    let opened = Input::open(libav, input.path)?;
    let stream_index = opened.best_stream(AVMEDIA_TYPE_AUDIO);
    libav.check(
        stream_index,
        &format!("'{}' has no audio stream", input.path.display()),
    )?;
    opened.keep_only(stream_index);
    let stream = opened.stream(stream_index);
    let (parameters, time_base) = unsafe { ((*stream).codecpar, (*stream).time_base) };
    let codec = unsafe { libav.codec.avcodec_find_decoder((*parameters).codec_id) };
    if codec.is_null() {
        return Err(format!(
            "FFmpeg cannot decode the audio in '{}'",
            input.path.display()
        ));
    }
    let decoder = Codec::new(libav, codec)?;
    libav.check(
        unsafe {
            libav
                .codec
                .avcodec_parameters_to_context(decoder.0, parameters)
        },
        "Could not configure the audio decoder",
    )?;
    unsafe { (*decoder.0).pkt_timebase = time_base };
    libav.check(
        unsafe { libav.codec.avcodec_open2(decoder.0, codec, ptr::null_mut()) },
        "Could not open the audio decoder",
    )?;
    let offset = opened.start_offset(time_base);
    if input.seek > SEEK_LEAD {
        let target = offset + ((input.seek - SEEK_LEAD) / q2d(time_base)) as i64;
        unsafe {
            libav
                .format
                .avformat_seek_file(opened.0, stream_index, i64::MIN, target, target, 0)
        };
    }
    let (sample_rate, sample_format, layout) = unsafe {
        (
            (*decoder.0).sample_rate,
            (*decoder.0).sample_fmt,
            &(*decoder.0).ch_layout as *const AVChannelLayout,
        )
    };
    let format_name =
        unsafe { text(libav.util.av_get_sample_fmt_name(sample_format)) }.unwrap_or_default();
    let channels = unsafe {
        if (*layout).order == ORDER_UNSPEC {
            format!("channels={}", (*layout).nb_channels)
        } else {
            let mut description = [0 as c_char; 128];
            libav.util.av_channel_layout_describe(
                layout,
                description.as_mut_ptr(),
                description.len(),
            );
            format!(
                "channel_layout={}",
                text(description.as_ptr()).unwrap_or_default()
            )
        }
    };
    let args = format!(
        "time_base=1/{}:sample_rate={}:sample_fmt={}:{}",
        sample_rate, sample_rate, format_name, channels
    );
    Ok((
        Source {
            input: opened,
            stream_index,
            time_base,
            offset,
            sample_rate,
            decoder,
            buffer: ptr::null_mut(),
            packet: Packet::new(libav)?,
            frame: Frame::new(libav)?,
            next_pts: NO_PTS,
            input_done: false,
            decoder_flushed: false,
            closed: false,
        },
        args,
    ))
}

impl Source {
    fn feed(&mut self, libav: &Libav) -> Result<(), String> {
        loop {
            let received = unsafe {
                libav
                    .codec
                    .avcodec_receive_frame(self.decoder.0, self.frame.0)
            };
            if received >= 0 {
                let samples = rational(1, self.sample_rate);
                unsafe {
                    let timestamp = match (*self.frame.0).best_effort_timestamp {
                        NO_PTS => (*self.frame.0).pts,
                        timestamp => timestamp,
                    };
                    let pts = if timestamp == NO_PTS {
                        self.next_pts.max(0)
                    } else {
                        libav
                            .util
                            .av_rescale_q(timestamp - self.offset, self.time_base, samples)
                    };
                    (*self.frame.0).pts = pts;
                    self.next_pts = pts + (*self.frame.0).nb_samples as i64;
                }
                let added = unsafe {
                    libav
                        .filter
                        .av_buffersrc_add_frame_flags(self.buffer, self.frame.0, 0)
                };
                self.frame.unref();
                return libav
                    .check(added, "Could not mix an audio frame")
                    .map(|_| ());
            }
            if received == AGAIN && !self.decoder_flushed {
                if self.input_done {
                    unsafe { libav.codec.avcodec_send_packet(self.decoder.0, ptr::null()) };
                    self.decoder_flushed = true;
                    continue;
                }
                let read = unsafe { libav.format.av_read_frame(self.input.0, self.packet.0) };
                if read < 0 {
                    self.input_done = true;
                    continue;
                }
                if unsafe { (*self.packet.0).stream_index } == self.stream_index {
                    unsafe {
                        libav
                            .codec
                            .avcodec_send_packet(self.decoder.0, self.packet.0)
                    };
                }
                self.packet.unref();
                continue;
            }
            unsafe {
                libav
                    .filter
                    .av_buffersrc_add_frame_flags(self.buffer, ptr::null_mut(), 0)
            };
            self.closed = true;
            return Ok(());
        }
    }
}

impl AudioMix {
    pub fn open(
        inputs: &[AudioInput],
        description: &str,
        frame_size: Option<u32>,
    ) -> Result<Self, String> {
        let libav = require()?;
        let graph = Graph::new(libav)?;
        let mut sources = Vec::with_capacity(inputs.len());
        let mut pads = Vec::with_capacity(inputs.len());
        let names: Vec<String> = (0..inputs.len())
            .map(|index| format!("in{}", index))
            .collect();
        for (input, name) in inputs.iter().zip(&names) {
            let (mut source, args) = open_source(libav, input)?;
            source.buffer = graph.create(libav, "abuffer", name, &args)?;
            pads.push((name.as_str(), source.buffer));
            sources.push(source);
        }
        let sink = graph.create(libav, "abuffersink", "out", "")?;
        graph.link(libav, description, &pads, &[("out", sink)])?;
        if let Some(frame_size) = frame_size {
            unsafe { libav.filter.av_buffersink_set_frame_size(sink, frame_size) };
        }
        Ok(Self {
            libav,
            _graph: graph,
            sink,
            sources,
            frame: Frame::new(libav)?,
            cursor: 0,
        })
    }

    pub fn pull(&mut self) -> Result<Option<*mut AVFrame>, String> {
        let libav = self.libav;
        self.frame.unref();
        loop {
            let pulled = unsafe {
                libav
                    .filter
                    .av_buffersink_get_frame(self.sink, self.frame.0)
            };
            if pulled >= 0 {
                return Ok(Some(self.frame.0));
            }
            if pulled == END {
                return Ok(None);
            }
            if pulled != AGAIN {
                return Err(libav.error(pulled));
            }
            let open: Vec<usize> = (0..self.sources.len())
                .filter(|index| !self.sources[*index].closed)
                .collect();
            if open.is_empty() {
                return Ok(None);
            }
            let starving = open.iter().copied().max_by_key(|index| unsafe {
                libav
                    .filter
                    .av_buffersrc_get_nb_failed_requests(self.sources[*index].buffer)
            });
            let pick = match starving {
                Some(index)
                    if unsafe {
                        libav
                            .filter
                            .av_buffersrc_get_nb_failed_requests(self.sources[index].buffer)
                    } > 0 =>
                {
                    index
                }
                _ => {
                    self.cursor = (self.cursor + 1) % open.len();
                    open[self.cursor]
                }
            };
            self.sources[pick].feed(libav)?;
        }
    }

    pub fn read_interleaved(&mut self, output: &mut Vec<u8>, bytes: usize) -> Result<(), String> {
        while output.len() < bytes {
            let Some(frame) = self.pull()? else {
                break;
            };
            output.extend_from_slice(packed_samples(self.libav, frame));
        }
        output.resize(bytes, 0);
        Ok(())
    }

    pub fn read_all(&mut self) -> Result<Vec<u8>, String> {
        let mut output = Vec::new();
        while let Some(frame) = self.pull()? {
            output.extend_from_slice(packed_samples(self.libav, frame));
        }
        Ok(output)
    }
}

fn packed_samples<'a>(libav: &Libav, frame: *mut AVFrame) -> &'a [u8] {
    unsafe {
        let length = (*frame).nb_samples as usize
            * (*frame).ch_layout.nb_channels as usize
            * libav.util.av_get_bytes_per_sample((*frame).format) as usize;
        std::slice::from_raw_parts((*frame).data[0], length)
    }
}
