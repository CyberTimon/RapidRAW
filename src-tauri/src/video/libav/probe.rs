use std::ffi::c_char;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::sys::types::*;
use super::{Input, Libav, NO_PTS, TIME_BASE, q2d, text};

const ATTACHED_PIC: i32 = 0x0400;
const DICT_IGNORE_SUFFIX: i32 = 2;

fn tags(libav: &Libav, dictionary: *const AVDictionary) -> Value {
    let mut tags = Map::new();
    let mut entry: *const AVDictionaryEntry = std::ptr::null();
    loop {
        entry = unsafe {
            libav
                .util
                .av_dict_get(dictionary, c"".as_ptr(), entry, DICT_IGNORE_SUFFIX)
        };
        if entry.is_null() {
            return Value::Object(tags);
        }
        if let (Some(key), Some(value)) = unsafe { (text((*entry).key), text((*entry).value)) } {
            tags.insert(key, Value::String(value));
        }
    }
}

fn channel_layout(libav: &Libav, layout: *const AVChannelLayout) -> Option<String> {
    if unsafe { (*layout).order } == AV_CHANNEL_ORDER_UNSPEC {
        return None;
    }
    let mut description = [0 as c_char; 64];
    let written = unsafe {
        libav
            .util
            .av_channel_layout_describe(layout, description.as_mut_ptr(), description.len())
    };
    (written > 0)
        .then(|| unsafe { text(description.as_ptr()) })
        .flatten()
}

fn rate(rational: AVRational) -> String {
    format!("{}/{}", rational.num, rational.den)
}

fn seconds(duration: i64, time_base: AVRational) -> Value {
    if duration == NO_PTS {
        Value::Null
    } else {
        json!(duration as f64 * q2d(time_base))
    }
}

fn bit_rate(value: i64) -> Value {
    if value > 0 { json!(value) } else { Value::Null }
}

pub fn rotation(libav: &Libav, parameters: *const AVCodecParameters) -> Option<[i32; 9]> {
    unsafe {
        let side = libav.codec.av_packet_side_data_get(
            (*parameters).coded_side_data,
            (*parameters).nb_coded_side_data,
            AV_PKT_DATA_DISPLAYMATRIX,
        );
        if side.is_null() || (*side).size < 36 {
            return None;
        }
        Some(std::ptr::read_unaligned((*side).data as *const [i32; 9]))
    }
}

fn stream_json(libav: &Libav, stream: *const AVStream) -> Value {
    unsafe {
        let parameters = (*stream).codecpar;
        let codec_type = match (*parameters).codec_type {
            AVMEDIA_TYPE_VIDEO => "video",
            AVMEDIA_TYPE_AUDIO => "audio",
            _ => "other",
        };
        let name = |pointer| text(pointer).unwrap_or_default();
        let side_data: Vec<Value> = rotation(libav, parameters)
            .map(|matrix| {
                let degrees = libav.util.av_display_rotation_get(matrix.as_ptr());
                vec![json!({ "rotation": if degrees.is_nan() { 0.0 } else { degrees.round() } })]
            })
            .unwrap_or_default();
        json!({
            "codec_type": codec_type,
            "codec_name": name(libav.codec.avcodec_get_name((*parameters).codec_id)),
            "width": (*parameters).width,
            "height": (*parameters).height,
            "pix_fmt": name(libav.util.av_get_pix_fmt_name((*parameters).format)),
            "color_space": name(libav.util.av_color_space_name((*parameters).color_space)),
            "color_primaries": name(libav.util.av_color_primaries_name((*parameters).color_primaries)),
            "color_transfer": name(libav.util.av_color_transfer_name((*parameters).color_trc)),
            "color_range": name(libav.util.av_color_range_name((*parameters).color_range)),
            "chroma_location": name(libav.util.av_chroma_location_name((*parameters).chroma_location)),
            "sample_rate": (*parameters).sample_rate,
            "channels": (*parameters).ch_layout.nb_channels,
            "channel_layout": channel_layout(libav, &(*parameters).ch_layout),
            "bit_rate": bit_rate((*parameters).bit_rate),
            "bits_per_raw_sample": (*parameters).bits_per_raw_sample,
            "tags": tags(libav, (*stream).metadata),
            "avg_frame_rate": rate((*stream).avg_frame_rate),
            "r_frame_rate": rate((*stream).r_frame_rate),
            "duration": seconds((*stream).duration, (*stream).time_base),
            "disposition": { "attached_pic": i32::from((*stream).disposition & ATTACHED_PIC != 0) },
            "side_data_list": side_data,
        })
    }
}

pub fn probe(libav: &Libav, path: &Path) -> Result<Value, String> {
    let input = Input::open(libav, path)?;
    unsafe {
        let context = input.0;
        let streams: Vec<Value> = (0..(*context).nb_streams as i32)
            .map(|index| stream_json(libav, input.stream(index)))
            .collect();
        Ok(json!({
            "format": {
                "format_long_name": if (*context).iformat.is_null() { None } else { text((*(*context).iformat).long_name) },
                "tags": tags(libav, (*context).metadata),
                "duration": seconds((*context).duration, TIME_BASE),
                "bit_rate": bit_rate((*context).bit_rate),
            },
            "streams": streams,
        }))
    }
}
