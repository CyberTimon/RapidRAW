use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::decode::hdr_source::HdrTransfer;
use crate::video::blocking;
use crate::video::ffmpeg::{PixelLayout, VideoColor};
use crate::video::libav;
use crate::video::libav::encode::{AudioSettings, ColorTags, VideoSettings};

const PROBE_SIZE: (u32, u32) = (256, 256);
const HARDWARE_SUFFIXES: [&str; 5] = ["_nvenc", "_qsv", "_amf", "_vaapi", "_videotoolbox"];
const HARDWARE_MEDIA_FOUNDATION: bool = cfg!(all(windows, target_arch = "aarch64"));
const AUDIO_TOOLBOX_AAC: AudioSettings = AudioSettings {
    encoder: "aac_at",
    sample_format: "s16",
    bit_rate: None,
};
const CANDIDATES: [(Codec, &[&str]); 5] = [
    (
        Codec::H264,
        &[
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_vaapi",
            "h264_videotoolbox",
            "libx264",
            "h264_mf",
            "libopenh264",
        ],
    ),
    (
        Codec::Hevc,
        &[
            "hevc_nvenc",
            "hevc_qsv",
            "hevc_amf",
            "hevc_vaapi",
            "hevc_videotoolbox",
            "libx265",
            "hevc_mf",
            "libkvazaar",
        ],
    ),
    (
        Codec::Av1,
        &["av1_nvenc", "av1_qsv", "av1_amf", "av1_vaapi", "libsvtav1"],
    ),
    (Codec::ProRes, &["prores_videotoolbox", "prores_ks"]),
    (Codec::Vp9, &["libvpx-vp9"]),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Codec {
    H264,
    Hevc,
    Av1,
    ProRes,
    Vp9,
}

impl Codec {
    fn label(self) -> &'static str {
        match self {
            Codec::H264 => "H.264",
            Codec::Hevc => "HEVC",
            Codec::Av1 => "AV1",
            Codec::ProRes => "ProRes",
            Codec::Vp9 => "VP9",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Mp4,
    Mov,
    Mkv,
    Webm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioCodec {
    Aac,
    Opus,
    Pcm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    High,
    Medium,
    Low,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dynamic {
    #[default]
    Sdr,
    Hlg,
    Pq,
}

impl Dynamic {
    pub fn color(self) -> VideoColor {
        let (matrix, primaries, transfer) = match self {
            Dynamic::Sdr => ("bt709", zenavif::ColorPrimaries::BT709, None),
            Dynamic::Hlg => (
                "bt2020",
                zenavif::ColorPrimaries::BT2020,
                Some(HdrTransfer::Hlg),
            ),
            Dynamic::Pq => (
                "bt2020",
                zenavif::ColorPrimaries::BT2020,
                Some(HdrTransfer::Pq),
            ),
        };
        VideoColor {
            matrix: Some(matrix),
            primaries: Some(primaries),
            transfer,
            ..VideoColor::default()
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub codec: Codec,
    pub encoder: String,
    pub hardware: bool,
    pub ten_bit: bool,
}

pub struct Container {
    pub format: &'static str,
    pub faststart: bool,
}

impl Container {
    pub fn keeps_codec_tag(&self) -> bool {
        matches!(self.format, "mp4" | "mov")
    }
}

static ENCODERS: OnceLock<Vec<EncoderInfo>> = OnceLock::new();
static AUDIO_TOOLBOX: OnceLock<bool> = OnceLock::new();

fn encodes(info: &EncoderInfo, dynamic: Dynamic) -> bool {
    libav::encode::probe_encoder(&video_settings(
        info,
        Quality::Medium,
        dynamic,
        25.0,
        PROBE_SIZE,
        None,
    ))
}

fn probe(codec: Codec, encoder: &str) -> Option<EncoderInfo> {
    let attempts: &[bool] = if HARDWARE_MEDIA_FOUNDATION && encoder.ends_with("_mf") {
        &[true, false]
    } else if HARDWARE_SUFFIXES
        .iter()
        .any(|suffix| encoder.ends_with(suffix))
    {
        &[true]
    } else {
        &[false]
    };
    attempts.iter().find_map(|&hardware| {
        let mut info = EncoderInfo {
            codec,
            encoder: encoder.to_string(),
            hardware,
            ten_bit: false,
        };
        if !encodes(&info, Dynamic::Sdr) {
            return None;
        }
        info.ten_bit = encodes(&info, Dynamic::Pq);
        Some(info)
    })
}

fn probe_all() -> Vec<EncoderInfo> {
    CANDIDATES
        .iter()
        .flat_map(|&(codec, encoders)| encoders.iter().map(move |&encoder| (codec, encoder)))
        .filter_map(|(codec, encoder)| probe(codec, encoder))
        .collect()
}

pub fn available() -> Result<Vec<EncoderInfo>, String> {
    libav::require()?;
    Ok(ENCODERS.get_or_init(probe_all).clone())
}

pub fn select(codec: Codec, prefer_hardware: bool, ten_bit: bool) -> Result<EncoderInfo, String> {
    available()?
        .into_iter()
        .filter(|info| info.codec == codec && (info.ten_bit || !ten_bit))
        .min_by_key(|info| info.hardware != prefer_hardware)
        .ok_or_else(|| {
            format!(
                "FFmpeg has no working {}{} encoder",
                if ten_bit { "10-bit " } else { "" },
                codec.label()
            )
        })
}

pub fn container(codec: Codec, format: Option<Format>) -> Container {
    let format = format.unwrap_or(match codec {
        Codec::ProRes => Format::Mov,
        Codec::Vp9 => Format::Webm,
        Codec::H264 | Codec::Hevc | Codec::Av1 => Format::Mp4,
    });
    Container {
        format: match format {
            Format::Mp4 => "mp4",
            Format::Mov => "mov",
            Format::Mkv => "matroska",
            Format::Webm => "webm",
        },
        faststart: format == Format::Mp4,
    }
}

fn pixel_format(info: &EncoderInfo, dynamic: Dynamic) -> &'static str {
    match (info.codec, dynamic, info.hardware) {
        (Codec::ProRes, _, false) => "yuv422p10le",
        (Codec::ProRes, _, true) => "p210le",
        (_, Dynamic::Sdr, false) => "yuv420p",
        (_, Dynamic::Sdr, true) => "nv12",
        (_, _, false) => "yuv420p10le",
        (_, _, true) => "p010le",
    }
}

pub fn packed_layout(pixel_format: &str) -> Option<PixelLayout> {
    let (chroma_shift, bits, interleaved) = match pixel_format {
        "yuv420p" => ((1, 1), 8, false),
        "nv12" => ((1, 1), 8, true),
        "yuv420p10le" => ((1, 1), 10, false),
        "p010le" => ((1, 1), 10, true),
        "yuv422p10le" => ((1, 0), 10, false),
        "p210le" => ((1, 0), 10, true),
        _ => return None,
    };
    Some(PixelLayout {
        chroma_shift,
        bits,
        rgb: false,
        interleaved,
    })
}

fn hardware_qp(codec: Codec, level: usize) -> &'static str {
    let values = match codec {
        Codec::H264 => ["20", "24", "29"],
        Codec::Av1 => ["80", "100", "120"],
        _ => ["24", "28", "33"],
    };
    values[level]
}

fn bit_rate(codec: Codec, level: usize, fps: f64, size: (u32, u32)) -> u64 {
    let bits_per_pixel = [0.14, 0.09, 0.055][level] * if codec == Codec::H264 { 1.0 } else { 0.7 };
    ((bits_per_pixel * size.0 as f64 * size.1 as f64 * fps) as u64).max(500_000)
}

fn option(key: &'static str, value: impl ToString) -> (&'static str, String) {
    (key, value.to_string())
}

pub fn video_settings(
    info: &EncoderInfo,
    quality: Quality,
    dynamic: Dynamic,
    fps: f64,
    size: (u32, u32),
    target_rate: Option<u64>,
) -> VideoSettings {
    let level = quality as usize;
    let encoder = info.encoder.as_str();
    let target = target_rate.map(|rate| option("b", rate));
    let mut options = Vec::new();
    match encoder {
        "libx264" => options.extend([
            option("preset", "medium"),
            target.unwrap_or_else(|| option("crf", ["17", "21", "26"][level])),
        ]),
        "libx265" => {
            options.extend([
                option("preset", "medium"),
                target.unwrap_or_else(|| option("crf", ["20", "24", "29"][level])),
            ]);
            if dynamic == Dynamic::Pq {
                options.push(option(
                    "x265-params",
                    "hdr10=1:hdr10-opt=1:repeat-headers=1",
                ));
            }
        }
        "libopenh264" => options.extend([
            option("rc_mode", "bitrate"),
            target.unwrap_or_else(|| option("b", bit_rate(info.codec, level, fps, size))),
            option("allow_skip_frames", "0"),
        ]),
        "libkvazaar" => match target {
            Some(target) => options.extend([option("kvazaar-params", "preset=fast"), target]),
            None => options.push(option(
                "kvazaar-params",
                format!("preset=fast,qp={}", ["22", "26", "31"][level]),
            )),
        },
        "libsvtav1" => options.extend([
            option("preset", "6"),
            target.unwrap_or_else(|| option("crf", ["28", "34", "40"][level])),
        ]),
        "libvpx-vp9" => {
            match target {
                Some(target) => options.push(target),
                None => {
                    options.extend([option("crf", ["31", "35", "40"][level]), option("b", "0")])
                }
            }
            options.extend([
                option("row-mt", "1"),
                option("deadline", "good"),
                option("cpu-used", "2"),
            ]);
        }
        "prores_ks" => options.extend([
            option("profile", ["3", "2", "1"][level]),
            option("vendor", "apl0"),
        ]),
        "prores_videotoolbox" => options.push(option("profile", ["3", "2", "1"][level])),
        _ if encoder.ends_with("_nvenc") => {
            options.extend([option("preset", "p5"), option("tune", "hq")]);
            match target {
                Some(target) => options.extend([option("rc", "vbr"), target]),
                None => options.extend([
                    option("rc", "constqp"),
                    option("qp", hardware_qp(info.codec, level)),
                ]),
            }
        }
        _ if encoder.ends_with("_qsv") => {
            let scale = if info.codec == Codec::Av1 {
                Codec::Hevc
            } else {
                info.codec
            };
            options.extend([
                option("preset", "medium"),
                target.unwrap_or_else(|| option("global_quality", hardware_qp(scale, level))),
            ]);
        }
        _ if encoder.ends_with("_amf") => match (target, target_rate) {
            (Some(target), Some(rate)) => options.extend([
                option("quality", "quality"),
                option("rc", "vbr_peak"),
                target,
                option("maxrate", rate * 3 / 2),
            ]),
            _ => {
                let qp = hardware_qp(info.codec, level);
                options.extend([
                    option("quality", "quality"),
                    option("rc", "cqp"),
                    option("qp_i", qp),
                    option("qp_p", qp),
                ]);
                if info.codec != Codec::Hevc {
                    options.push(option("qp_b", qp));
                }
            }
        },
        _ if encoder.ends_with("_vaapi") => match target_rate {
            Some(rate) => options.extend([
                option("rc_mode", "VBR"),
                option("b", rate),
                option("maxrate", rate * 3 / 2),
            ]),
            None => options.extend([
                option("rc_mode", "CQP"),
                option("global_quality", hardware_qp(info.codec, level)),
            ]),
        },
        _ if encoder.ends_with("_mf") => {
            match target {
                Some(target) => options.extend([option("rate_control", "u_vbr"), target]),
                None => options.extend([
                    option("rate_control", "quality"),
                    option("quality", ["85", "70", "55"][level]),
                ]),
            }
            if info.hardware {
                options.push(option("hw_encoding", "1"));
            }
        }
        _ if encoder.ends_with("_videotoolbox") => {
            options.push(
                target.unwrap_or_else(|| option("b", bit_rate(info.codec, level, fps, size))),
            );
        }
        _ => {}
    }
    if info.hardware && info.codec == Codec::H264 && !encoder.ends_with("_mf") {
        options.push(option(
            "profile",
            if dynamic == Dynamic::Sdr {
                "high"
            } else {
                "high10"
            },
        ));
    }
    VideoSettings {
        encoder: info.encoder.clone(),
        pixel_format: pixel_format(info, dynamic),
        options,
        gop: (info.codec != Codec::ProRes).then(|| ((fps * 2.0).round() as i32).max(1)),
        quality_scale: None,
        codec_tag: (info.codec == Codec::Hevc).then_some(*b"hvc1"),
        color: dynamic.color().tags(),
    }
}

pub struct Intermediate {
    pub profile: &'static str,
    pub full_chroma: bool,
    pub quality_scale: Option<i32>,
    pub color: ColorTags,
}

impl Intermediate {
    fn settings(&self, info: &EncoderInfo) -> VideoSettings {
        let mut options = vec![option("profile", self.profile)];
        if !info.hardware {
            options.push(option("vendor", "apl0"));
        }
        VideoSettings {
            encoder: info.encoder.clone(),
            pixel_format: match (self.full_chroma, info.hardware) {
                (true, false) => "yuv444p10le",
                (true, true) => "p410le",
                (false, _) => pixel_format(info, Dynamic::Sdr),
            },
            options,
            gop: None,
            quality_scale: self.quality_scale.filter(|_| !info.hardware),
            codec_tag: None,
            color: self.color,
        }
    }

    pub fn open<T>(&self, open: impl Fn(&VideoSettings) -> Result<T, String>) -> Result<T, String> {
        let preferred = select(Codec::ProRes, true, true)?;
        match open(&self.settings(&preferred)) {
            Err(error) if preferred.hardware => {
                let software = select(Codec::ProRes, false, true)?;
                if software.hardware {
                    return Err(error);
                }
                log::warn!("{}, encoding with {} instead", error, software.encoder);
                open(&self.settings(&software))
            }
            opened => opened,
        }
    }
}

pub fn rgb_input_filter(dynamic: Dynamic) -> String {
    format!(
        "scale=out_color_matrix={}:out_range=tv",
        dynamic.color().matrix.unwrap_or("bt709")
    )
}

fn audio_toolbox() -> bool {
    cfg!(target_os = "macos")
        && *AUDIO_TOOLBOX
            .get_or_init(|| libav::encode::audio_frame_size(&AUDIO_TOOLBOX_AAC).is_ok())
}

pub fn audio_settings(
    codec: Codec,
    audio: Option<AudioCodec>,
    bit_rate: Option<i64>,
) -> AudioSettings {
    let audio = audio.unwrap_or(match codec {
        Codec::ProRes => AudioCodec::Pcm,
        Codec::Vp9 => AudioCodec::Opus,
        Codec::H264 | Codec::Hevc | Codec::Av1 => AudioCodec::Aac,
    });
    match audio {
        AudioCodec::Pcm => AudioSettings {
            encoder: "pcm_s16le",
            sample_format: "s16",
            bit_rate: None,
        },
        AudioCodec::Opus => AudioSettings {
            encoder: "libopus",
            sample_format: "flt",
            bit_rate: Some(bit_rate.unwrap_or(160_000)),
        },
        AudioCodec::Aac if audio_toolbox() => AudioSettings {
            bit_rate: Some(bit_rate.unwrap_or(192_000)),
            ..AUDIO_TOOLBOX_AAC
        },
        AudioCodec::Aac => AudioSettings {
            encoder: "aac",
            sample_format: "fltp",
            bit_rate: Some(bit_rate.unwrap_or(192_000)),
        },
    }
}

#[tauri::command]
pub async fn video_encoders() -> Result<Vec<EncoderInfo>, String> {
    blocking(available).await?
}
