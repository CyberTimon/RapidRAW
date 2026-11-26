use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

use crate::decode::hdr_source::{HLG_PEAK_NITS, HdrTransfer};
use crate::render::hdr::REFERENCE_WHITE_NITS;
use crate::video::camera_log::{self, CameraLog};
use crate::video::libav;
use crate::video::libav::encode::ColorTags;
use crate::video::metadata;
use crate::video::timelapse::Deflicker;

pub fn atempo_filters(speed: f64) -> Vec<String> {
    let mut remaining = speed;
    let mut filters = Vec::new();
    while remaining < 0.5 {
        filters.push("atempo=0.5".to_string());
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > 1e-6 {
        filters.push(format!("atempo={:.6}", remaining));
    }
    filters
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VideoColor {
    pub matrix: Option<&'static str>,
    pub primaries: Option<zenavif::ColorPrimaries>,
    pub transfer: Option<HdrTransfer>,
    pub log: Option<CameraLog>,
    pub layout: PixelLayout,
    pub full_range: bool,
    pub chroma_left: bool,
    pub chroma_top: bool,
}

impl VideoColor {
    pub fn high_bit_depth(&self) -> bool {
        self.layout.bits > 8 || self.transfer.is_some()
    }

    pub fn tags(&self) -> ColorTags {
        ColorTags {
            primaries: match self.primaries {
                Some(zenavif::ColorPrimaries::BT2020) => "bt2020",
                Some(zenavif::ColorPrimaries::SMPTE432) => "smpte432",
                _ => "bt709",
            },
            transfer: match self.transfer {
                Some(HdrTransfer::Pq) => "smpte2084",
                Some(HdrTransfer::Hlg) => "arib-std-b67",
                None => "bt709",
            },
            matrix: match self.matrix {
                Some("bt2020") => "bt2020nc",
                Some("bt601") => "smpte170m",
                Some("smpte240m") => "smpte240m",
                _ => "bt709",
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PixelLayout {
    pub chroma_shift: (u32, u32),
    pub bits: u32,
    pub rgb: bool,
    pub interleaved: bool,
}

impl Default for PixelLayout {
    fn default() -> Self {
        Self {
            chroma_shift: (1, 1),
            bits: 8,
            rgb: false,
            interleaved: false,
        }
    }
}

impl PixelLayout {
    fn parse(pix_fmt: &str) -> Self {
        let depth = |digits: &str| match digits.trim_end_matches("le").trim_end_matches("be") {
            "" => 8,
            "9" | "10" => 10,
            "12" => 12,
            _ => 16,
        };
        let shift = |chroma: &str| match chroma {
            "420" => (1, 1),
            "422" => (1, 0),
            _ => (0, 0),
        };
        if let Some(rest) = ["yuvj", "yuva", "yuv"]
            .iter()
            .find_map(|prefix| pix_fmt.strip_prefix(prefix))
            && let Some((chroma, bits)) = rest.split_once('p')
        {
            return Self {
                chroma_shift: shift(chroma),
                bits: depth(bits),
                rgb: false,
                interleaved: false,
            };
        }
        match pix_fmt {
            "nv12" | "nv21" => Self::default(),
            "p010le" | "p010be" => Self {
                bits: 10,
                ..Self::default()
            },
            "p016le" | "p016be" => Self {
                bits: 16,
                ..Self::default()
            },
            _ => Self {
                chroma_shift: (0, 0),
                bits: if ["10", "12", "16", "48", "64"]
                    .iter()
                    .any(|d| pix_fmt.contains(d))
                {
                    16
                } else {
                    8
                },
                rgb: true,
                interleaved: false,
            },
        }
    }

    pub fn interleaved_format(self) -> Option<&'static str> {
        if self.rgb || self.interleaved || self.chroma_shift != (1, 1) {
            return None;
        }
        match self.bits {
            8 => Some("nv12"),
            10 => Some("p010le"),
            _ => None,
        }
    }

    pub fn as_interleaved(self) -> Self {
        Self {
            interleaved: true,
            ..self
        }
    }

    pub fn sample_shift(self) -> u32 {
        if self.interleaved && self.bits > 8 {
            16 - self.bits
        } else {
            0
        }
    }

    pub fn ffmpeg_format(self) -> String {
        let chroma = match self.chroma_shift {
            (1, 1) => "420",
            (1, 0) => "422",
            _ => "444",
        };
        let depth = match self.bits {
            8 => "",
            10 => "10le",
            12 => "12le",
            _ => "16le",
        };
        format!("yuv{}p{}", chroma, depth)
    }

    pub fn sample_bytes(self) -> usize {
        if self.bits > 8 { 2 } else { 1 }
    }

    pub fn chroma_size(self, (width, height): (u32, u32)) -> (u32, u32) {
        (
            width.div_ceil(1 << self.chroma_shift.0),
            height.div_ceil(1 << self.chroma_shift.1),
        )
    }

    pub fn frame_bytes(self, size: (u32, u32)) -> usize {
        let (chroma_w, chroma_h) = self.chroma_size(size);
        (size.0 as usize * size.1 as usize + 2 * chroma_w as usize * chroma_h as usize)
            * self.sample_bytes()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub variable_frame_rate: bool,
    pub has_video: bool,
    pub has_audio: bool,
    pub codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bit_rate: Option<u64>,
    pub hdr: bool,
    pub is_still: bool,
    pub is_raw: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_log: Option<CameraLog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured: Option<String>,
    #[serde(skip)]
    pub color: VideoColor,
    #[serde(skip)]
    pub exif: HashMap<String, String>,
    #[serde(skip)]
    pub deflicker: Option<Deflicker>,
}

impl MediaInfo {
    pub fn still(width: u32, height: u32, is_raw: bool) -> Self {
        Self {
            duration: 0.0,
            width,
            height,
            fps: 0.0,
            variable_frame_rate: false,
            has_video: true,
            has_audio: false,
            codec: None,
            audio_codec: None,
            bit_rate: None,
            hdr: false,
            is_still: true,
            is_raw,
            detected_log: None,
            captured: None,
            color: VideoColor::default(),
            exif: HashMap::new(),
            deflicker: None,
        }
    }

    pub fn with_log(&self, log: Option<CameraLog>) -> Self {
        let mut info = self.clone();
        info.color.log = log;
        info
    }

    pub fn source_peak(&self) -> f32 {
        match self.color.log {
            Some(log) => log.source_peak(),
            None if self.hdr => HLG_PEAK_NITS / REFERENCE_WHITE_NITS,
            None => 1.0,
        }
    }

    pub fn as_exif(&self) -> HashMap<String, String> {
        self.exif.clone()
    }
}

pub type FileKey = (u64, Option<SystemTime>);
type ProbeCache = HashMap<PathBuf, (FileKey, Arc<MediaInfo>)>;

static PROBE_CACHE: LazyLock<Mutex<ProbeCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn file_key(path: &Path) -> std::io::Result<FileKey> {
    let metadata = std::fs::metadata(path)?;
    Ok((metadata.len(), metadata.modified().ok()))
}

pub fn probe(path: &Path) -> Result<Arc<MediaInfo>, String> {
    let key = file_key(path).map_err(|_| format!("'{}' does not exist", path.display()))?;
    if let Some((cached_key, info)) = PROBE_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        && *cached_key == key
    {
        return Ok(Arc::clone(info));
    }
    let parsed = parse_probe(&libav::probe::probe(libav::require()?, path)?)?;
    let info = Arc::new(MediaInfo {
        detected_log: parsed.has_video.then(|| camera_log::detect(path)).flatten(),
        ..parsed
    });
    PROBE_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), (key, Arc::clone(&info)));
    Ok(info)
}

const VFR_TOLERANCE: f64 = 0.005;

fn is_variable_rate(average: f64, real: f64) -> bool {
    let differs = |rate: f64| (rate - real).abs() > real * VFR_TOLERANCE;
    differs(average) && differs(average * 2.0)
}

fn parse_rate(rate: Option<&str>) -> Option<f64> {
    let (num, den) = rate?.split_once('/')?;
    let (num, den) = (num.parse::<f64>().ok()?, den.parse::<f64>().ok()?);
    (num > 0.0 && den > 0.0).then(|| num / den)
}

pub fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn rotation(stream: &Value) -> i64 {
    stream["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|data| number(&data["rotation"])))
        .or_else(|| number(&stream["tags"]["rotate"]))
        .unwrap_or(0.0)
        .round() as i64
}

fn color(stream: &Value, height: u32) -> VideoColor {
    let text = |key: &str| stream[key].as_str().unwrap_or("");
    let matrix = match text("color_space") {
        "bt709" => Some("bt709"),
        "bt2020nc" | "bt2020c" => Some("bt2020"),
        "smpte170m" | "bt470bg" => Some("bt601"),
        "smpte240m" => Some("smpte240m"),
        _ if height >= 720 => Some("bt709"),
        _ => Some("bt601"),
    };
    let primaries = match text("color_primaries") {
        "bt2020" => Some(zenavif::ColorPrimaries::BT2020),
        "smpte432" | "smpte431" => Some(zenavif::ColorPrimaries::SMPTE432),
        _ => Some(zenavif::ColorPrimaries::BT709),
    };
    let transfer = match text("color_transfer") {
        "smpte2084" => Some(HdrTransfer::Pq),
        "arib-std-b67" => Some(HdrTransfer::Hlg),
        _ => None,
    };
    let pix_fmt = text("pix_fmt");
    let layout = PixelLayout::parse(pix_fmt);
    let location = text("chroma_location");
    VideoColor {
        matrix: if layout.rgb { Some("bt709") } else { matrix },
        primaries,
        transfer,
        log: None,
        layout,
        full_range: layout.rgb || pix_fmt.starts_with("yuvj") || text("color_range") == "pc",
        chroma_left: !matches!(location, "center" | "top" | "bottom"),
        chroma_top: matches!(location, "topleft" | "top"),
    }
}

fn parse_probe(json: &Value) -> Result<MediaInfo, String> {
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| {
        s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 0
    });
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    if video.is_none() && audio.is_none() {
        return Err("The file has no video or audio stream".to_string());
    }

    let duration = number(&json["format"]["duration"])
        .or_else(|| video.and_then(|v| number(&v["duration"])))
        .or_else(|| audio.and_then(|a| number(&a["duration"])))
        .unwrap_or(0.0);

    let (width, height, fps, variable_frame_rate, codec, color) = match video {
        Some(stream) => {
            let (w, h) = (
                stream["width"].as_u64().unwrap_or(0) as u32,
                stream["height"].as_u64().unwrap_or(0) as u32,
            );
            let (w, h) = if rotation(stream).rem_euclid(180) == 90 {
                (h, w)
            } else {
                (w, h)
            };
            let average = parse_rate(stream["avg_frame_rate"].as_str());
            let real = parse_rate(stream["r_frame_rate"].as_str());
            let fps = average.or(real).filter(|fps| *fps < 1000.0).unwrap_or(30.0);
            (
                w,
                h,
                fps,
                average
                    .zip(real)
                    .is_some_and(|(a, r)| is_variable_rate(a, r)),
                stream["codec_name"].as_str().map(str::to_string),
                color(stream, h),
            )
        }
        None => (0, 0, 0.0, false, None, VideoColor::default()),
    };

    let bit_rate = number(&json["format"]["bit_rate"]).map(|rate| rate as u64);
    let exif = metadata::exif(
        &json["format"],
        metadata::Summary {
            width,
            height,
            duration,
            fps,
            variable_frame_rate,
            bit_rate,
            video: video.map(|stream| metadata::Stream {
                json: stream,
                layout: color.layout,
                rotation: rotation(stream),
            }),
            audio,
        },
    );
    Ok(MediaInfo {
        duration,
        width,
        height,
        fps,
        variable_frame_rate,
        has_video: video.is_some() && width > 0 && height > 0,
        has_audio: audio.is_some(),
        codec,
        audio_codec: audio.and_then(|a| a["codec_name"].as_str().map(str::to_string)),
        bit_rate,
        hdr: color.transfer.is_some(),
        is_still: false,
        is_raw: false,
        detected_log: None,
        captured: exif.get("DateTimeOriginal").cloned(),
        color,
        exif,
        deflicker: None,
    })
}
