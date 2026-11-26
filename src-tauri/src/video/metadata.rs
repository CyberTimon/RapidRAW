use std::collections::HashMap;

use chrono::{DateTime, Local, NaiveDateTime};
use serde_json::Value;

use crate::video::ffmpeg::{PixelLayout, number};

const MAKE_KEYS: &[&str] = &[
    "com.apple.quicktime.make",
    "make",
    "com.android.manufacturer",
];
const MODEL_KEYS: &[&str] = &["com.apple.quicktime.model", "model", "com.android.model"];
const SOFTWARE_KEYS: &[&str] = &["com.apple.quicktime.software", "software"];
const DATE_KEYS: &[&str] = &["com.apple.quicktime.creationdate", "creation_time", "date"];
const LOCATION_KEYS: &[&str] = &["com.apple.quicktime.location.iso6709", "location"];
const EXIF_DATE: &str = "%Y:%m:%d %H:%M:%S";

pub struct Stream<'a> {
    pub json: &'a Value,
    pub layout: PixelLayout,
    pub rotation: i64,
}

pub struct Summary<'a> {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub fps: f64,
    pub variable_frame_rate: bool,
    pub bit_rate: Option<u64>,
    pub video: Option<Stream<'a>>,
    pub audio: Option<&'a Value>,
}

fn tag<'a>(sources: &[&'a Value], keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        sources.iter().find_map(|source| {
            source["tags"]
                .as_object()?
                .iter()
                .find_map(|(name, value)| {
                    name.eq_ignore_ascii_case(key)
                        .then(|| value.as_str())
                        .flatten()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
        })
    })
}

fn exif_date(value: &str) -> Option<String> {
    let local = DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%z")
        .map(|date| date.naive_local())
        .or_else(|_| {
            DateTime::parse_from_rfc3339(value).map(|date| {
                if value.ends_with('Z') {
                    date.with_timezone(&Local).naive_local()
                } else {
                    date.naive_local()
                }
            })
        })
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .ok()?;
    Some(local.format(EXIF_DATE).to_string())
}

fn iso6709(value: &str) -> Option<(f64, f64, Option<f64>)> {
    let body = value.split('/').next()?.trim();
    let mut starts: Vec<usize> = body
        .char_indices()
        .filter(|(_, c)| *c == '+' || *c == '-')
        .map(|(index, _)| index)
        .collect();
    starts.push(body.len());
    let parts: Vec<f64> = starts
        .windows(2)
        .filter_map(|pair| body[pair[0]..pair[1]].parse().ok())
        .collect();
    match parts.as_slice() {
        [latitude, longitude, rest @ ..] => Some((*latitude, *longitude, rest.first().copied())),
        _ => None,
    }
}

fn dms(value: f64) -> String {
    let value = value.abs();
    let degrees = value.trunc();
    let minutes = (value - degrees) * 60.0;
    let seconds = (minutes - minutes.trunc()) * 60.0;
    format!("{} deg {} min {:.2} sec", degrees, minutes.trunc(), seconds)
}

fn duration(seconds: f64) -> String {
    let total = seconds.max(0.0);
    let hours = (total / 3600.0).floor();
    let minutes = ((total - hours * 3600.0) / 60.0).floor();
    let rest = total - hours * 3600.0 - minutes * 60.0;
    if hours > 0.0 {
        format!("{}:{:02}:{:02}", hours, minutes, rest.floor())
    } else {
        format!("{}:{:05.2}", minutes, rest)
    }
}

fn frame_rate(fps: f64, variable: bool) -> String {
    let rounded = (fps * 100.0).round() / 100.0;
    let text = if (rounded - rounded.round()).abs() < 1e-6 {
        format!("{} fps", rounded.round())
    } else {
        format!("{} fps", rounded)
    };
    if variable {
        format!("{} (variable)", text)
    } else {
        text
    }
}

fn primaries_name(name: &str) -> Option<&str> {
    match name {
        "" | "unknown" | "unspecified" | "reserved" => None,
        "bt709" => Some("BT.709"),
        "bt2020" => Some("BT.2020"),
        "smpte432" => Some("Display P3"),
        "smpte431" => Some("DCI-P3"),
        "bt470bg" | "smpte170m" => Some("BT.601"),
        other => Some(other),
    }
}

fn transfer_name(name: &str) -> Option<&str> {
    match name {
        "" | "unknown" | "unspecified" | "reserved" => None,
        "arib-std-b67" => Some("HLG"),
        "smpte2084" => Some("PQ"),
        "bt709" | "bt2020-10" | "bt2020-12" | "smpte170m" | "bt470bg" => Some("BT.709"),
        "iec61966-2-1" => Some("sRGB"),
        "linear" => Some("Linear"),
        other => Some(other),
    }
}

fn chroma(layout: PixelLayout) -> &'static str {
    match (layout.rgb, layout.chroma_shift) {
        (true, _) => "RGB",
        (_, (1, 1)) => "4:2:0",
        (_, (1, 0)) => "4:2:2",
        (_, (2, 0)) => "4:1:1",
        _ => "4:4:4",
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

pub fn exif(format: &Value, summary: Summary) -> HashMap<String, String> {
    let mut exif = HashMap::new();
    let mut put = |key: &str, value: String| {
        exif.insert(key.to_string(), value);
    };
    let mut sources = vec![format];
    sources.extend(summary.video.as_ref().map(|video| video.json));
    sources.extend(summary.audio);

    put("PixelXDimension", summary.width.to_string());
    put("PixelYDimension", summary.height.to_string());
    put("Duration", duration(summary.duration));
    if let Some(bit_rate) = summary.bit_rate {
        put(
            "BitRate",
            format!("{:.1} Mbit/s", bit_rate as f64 / 1_000_000.0),
        );
    }
    if let Some(container) = format["format_long_name"].as_str() {
        put("Container", container.to_string());
    }
    for (key, keys) in [
        ("Make", MAKE_KEYS),
        ("Model", MODEL_KEYS),
        ("Software", SOFTWARE_KEYS),
    ] {
        if let Some(value) = tag(&sources, keys) {
            put(key, value.to_string());
        }
    }
    if let Some(date) = tag(&sources, DATE_KEYS).and_then(exif_date) {
        put("DateTimeOriginal", date);
    }
    if let Some((latitude, longitude, altitude)) = tag(&sources, LOCATION_KEYS).and_then(iso6709) {
        put("GPSLatitude", dms(latitude));
        put(
            "GPSLatitudeRef",
            if latitude < 0.0 { "S" } else { "N" }.to_string(),
        );
        put("GPSLongitude", dms(longitude));
        put(
            "GPSLongitudeRef",
            if longitude < 0.0 { "W" } else { "E" }.to_string(),
        );
        if let Some(altitude) = altitude {
            put("GPSAltitude", format!("{:.1} m", altitude));
        }
    }
    if let Some(video) = &summary.video {
        let stream = video.json;
        let text = |key: &str| stream[key].as_str().unwrap_or("");
        if let Some(codec) = stream["codec_name"].as_str() {
            put("VideoCodec", codec.to_uppercase());
        }
        put(
            "FrameRate",
            frame_rate(summary.fps, summary.variable_frame_rate),
        );
        put("BitDepth", format!("{}-bit", video.layout.bits));
        put("ChromaSubsampling", chroma(video.layout).to_string());
        let mut color: Vec<&str> = [
            primaries_name(text("color_primaries")),
            transfer_name(text("color_transfer")),
        ]
        .into_iter()
        .flatten()
        .collect();
        color.dedup();
        if !color.is_empty() {
            put("ColorSpace", color.join(" · "));
        }
        match text("color_range") {
            "pc" => put("ColorRange", "Full".to_string()),
            "tv" => put("ColorRange", "Limited".to_string()),
            _ => {}
        }
        if video.rotation != 0 {
            put("Rotation", format!("{}°", video.rotation));
        }
    }
    if let Some(audio) = summary.audio {
        if let Some(codec) = audio["codec_name"].as_str() {
            put("AudioCodec", codec.to_uppercase());
        }
        if let Some(rate) = number(&audio["sample_rate"]).filter(|rate| *rate > 0.0) {
            put("AudioSampleRate", format!("{} kHz", rate / 1000.0));
        }
        let channels = audio["channel_layout"]
            .as_str()
            .map(capitalized)
            .or_else(|| {
                number(&audio["channels"])
                    .filter(|count| *count > 0.0)
                    .map(|count| format!("{} channels", count))
            });
        if let Some(channels) = channels {
            put("AudioChannels", channels);
        }
        if let Some(rate) = number(&audio["bit_rate"]).filter(|rate| *rate > 0.0) {
            put("AudioBitRate", format!("{:.0} kbit/s", rate / 1000.0));
        }
    }
    exif
}
