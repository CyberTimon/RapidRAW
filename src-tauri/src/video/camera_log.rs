use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use glam::{DVec2, Mat3, Vec3};
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};

use crate::render::color_space::{REC2020, RgbSpace, SRGB, WHITE_D65, WORKING};

const MAX_SOURCE_PEAK: f64 = 16.0;
const LOG2_10: f64 = std::f64::consts::LOG2_10;
const LOG2_E: f64 = std::f64::consts::LOG2_E;
const FULL_BOX: u64 = 4;
const XML_LIMIT: u64 = 1 << 16;
const SAMPLE_LIMIT: u32 = 1 << 20;
const DJI_METADATA: &[u8] = b"djmd";
const FRAGMENT: &[u8; 4] = b"moof";
const DJI_D_LOG: u64 = 2;
const DJI_D_LOG_M: u64 = 19;
const SONY_PICTURE_PROFILE_9: &str = "user9";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum CameraLog {
    SLog3Cine,
    SLog3,
    VLog,
    CLog3,
    LogC3,
    LogC4,
    FLog2,
    NLog,
    AppleLog,
    SLog2,
    DLog,
    DLogM,
}

#[derive(Clone, Copy)]
enum Toe {
    Linear,
    Cubic,
    Root,
}

#[derive(Clone, Copy)]
struct Curve {
    exponent: f64,
    offset: f64,
    black: f64,
    gain: f64,
    cut: f64,
    toe: Toe,
    toe_slope: f64,
    toe_offset: f64,
    code_values: bool,
}

impl Curve {
    fn decode(&self, code: f64) -> f64 {
        if code >= self.cut {
            return (((code - self.offset) * self.exponent).exp2() - self.black) / self.gain;
        }
        match self.toe {
            Toe::Linear => (code - self.toe_offset) / self.toe_slope,
            Toe::Cubic => (code / self.toe_slope).powi(3) - self.toe_offset,
            Toe::Root => (code.max(0.0) / self.toe_slope).sqrt() + self.toe_offset,
        }
    }

    fn code_range(&self, bits: u32, full_range: bool) -> (f64, f64) {
        let max = ((1u64 << bits) - 1) as f64;
        let step = (1u64 << (bits - 8)) as f64;
        if self.code_values && !full_range {
            (219.0 * step / max, 16.0 * step / max)
        } else {
            (1.0, 0.0)
        }
    }
}

const fn space(red: (f64, f64), green: (f64, f64), blue: (f64, f64)) -> RgbSpace {
    RgbSpace {
        primaries: [
            DVec2::new(red.0, red.1),
            DVec2::new(green.0, green.1),
            DVec2::new(blue.0, blue.1),
        ],
        white: WHITE_D65,
    }
}

const S_GAMUT3_CINE: RgbSpace = space((0.766, 0.275), (0.225, 0.800), (0.089, -0.087));
const S_GAMUT: RgbSpace = space((0.730, 0.280), (0.140, 0.855), (0.100, -0.050));
const D_GAMUT: RgbSpace = space((0.71, 0.31), (0.21, 0.88), (0.09, -0.08));
const V_GAMUT: RgbSpace = space((0.730, 0.280), (0.165, 0.840), (0.100, -0.030));
const CINEMA_GAMUT: RgbSpace = space((0.740, 0.270), (0.170, 1.140), (0.080, -0.100));
const ARRI_WIDE_GAMUT_3: RgbSpace = space((0.6840, 0.3130), (0.2210, 0.8480), (0.0861, -0.1020));
const ARRI_WIDE_GAMUT_4: RgbSpace = space((0.7347, 0.2653), (0.1424, 0.8576), (0.0991, -0.0308));

fn s_log3() -> Curve {
    let cut = 171.2102946929;
    Curve {
        exponent: LOG2_10 / (261.5 / 1023.0),
        offset: 420.0 / 1023.0,
        black: 0.01 / 0.19,
        gain: 1.0 / 0.19,
        cut: cut / 1023.0,
        toe: Toe::Linear,
        toe_slope: (cut - 95.0) / (1023.0 * 0.01125),
        toe_offset: 95.0 / 1023.0,
        code_values: true,
    }
}

fn s_log2() -> Curve {
    let legal = 876.0 / 1023.0;
    let black = 64.0 / 1023.0;
    let gain = 155.0 / (219.0 * 0.9);
    let toe_offset = black + 0.030001222851889303 * legal;
    Curve {
        exponent: LOG2_10 / (0.432699 * legal),
        offset: black + 0.646596 * legal,
        black: 0.037584,
        gain,
        cut: toe_offset,
        toe: Toe::Linear,
        toe_slope: 5.0 * gain * legal,
        toe_offset,
        code_values: true,
    }
}

fn d_log_m() -> Curve {
    let (scale, black, offset, cut) = (0.50838, 0.04232, 0.74598, 0.1);
    let at_cut = 10f64.powf((cut - offset) / scale) - black;
    let toe_slope = scale / (std::f64::consts::LN_10 * (at_cut + black));
    Curve {
        exponent: LOG2_10 / scale,
        offset,
        black,
        gain: 1.0,
        cut,
        toe: Toe::Linear,
        toe_slope,
        toe_offset: cut - toe_slope * at_cut,
        code_values: false,
    }
}

fn log_c4() -> Curve {
    let a = (2f64.powi(18) - 16.0) / 117.45;
    let b = (1023.0 - 95.0) / 1023.0;
    let c = 95.0 / 1023.0;
    let slope = (7.0 * std::f64::consts::LN_2 * 2f64.powf(7.0 - 14.0 * c / b)) / (a * b);
    let intercept = (2f64.powf(6.0 - 14.0 * c / b) - 64.0) / a;
    Curve {
        exponent: 14.0 / b,
        offset: c - 6.0 * b / 14.0,
        black: 64.0,
        gain: a,
        cut: 0.0,
        toe: Toe::Linear,
        toe_slope: 1.0 / slope,
        toe_offset: -intercept / slope,
        code_values: true,
    }
}

impl CameraLog {
    fn curve(self) -> Curve {
        match self {
            Self::SLog3Cine | Self::SLog3 => s_log3(),
            Self::VLog => Curve {
                exponent: LOG2_10 / 0.241514,
                offset: 0.598206,
                black: 0.00873,
                gain: 1.0,
                cut: 0.181,
                toe: Toe::Linear,
                toe_slope: 5.6,
                toe_offset: 0.125,
                code_values: true,
            },
            Self::CLog3 => Curve {
                exponent: LOG2_10 / 0.36726845,
                offset: 0.12240537,
                black: 1.0,
                gain: 14.98325 / 0.9,
                cut: 1.9754798 * 0.014 + 0.12512219,
                toe: Toe::Linear,
                toe_slope: 1.9754798 / 0.9,
                toe_offset: 0.12512219,
                code_values: false,
            },
            Self::LogC3 => Curve {
                exponent: LOG2_10 / 0.247190,
                offset: 0.385537,
                black: 0.052272,
                gain: 5.555556,
                cut: 5.367655 * 0.010591 + 0.092809,
                toe: Toe::Linear,
                toe_slope: 5.367655,
                toe_offset: 0.092809,
                code_values: true,
            },
            Self::LogC4 => log_c4(),
            Self::FLog2 => Curve {
                exponent: LOG2_10 / 0.245281,
                offset: 0.384316,
                black: 0.064829,
                gain: 5.555556,
                cut: 0.100686,
                toe: Toe::Linear,
                toe_slope: 8.799461,
                toe_offset: 0.092864,
                code_values: true,
            },
            Self::NLog => Curve {
                exponent: LOG2_E / (150.0 / 1023.0),
                offset: 619.0 / 1023.0,
                black: 0.0,
                gain: 1.0,
                cut: 452.0 / 1023.0,
                toe: Toe::Cubic,
                toe_slope: 650.0 / 1023.0,
                toe_offset: 0.0075,
                code_values: true,
            },
            Self::AppleLog => Curve {
                exponent: 1.0 / 0.08550479,
                offset: 0.69336945,
                black: 0.00964052,
                gain: 1.0,
                cut: 0.08550479 * (0.01f64 + 0.00964052).log2() + 0.69336945,
                toe: Toe::Root,
                toe_slope: 47.28711236,
                toe_offset: -0.05641088,
                code_values: false,
            },
            Self::SLog2 => s_log2(),
            Self::DLog => Curve {
                exponent: LOG2_10 * 3.89616,
                offset: 2.27752 / 3.89616,
                black: 0.0108,
                gain: 0.9892,
                cut: 0.14,
                toe: Toe::Linear,
                toe_slope: 6.025,
                toe_offset: 0.0929,
                code_values: false,
            },
            Self::DLogM => d_log_m(),
        }
    }

    fn gamut(self) -> RgbSpace {
        match self {
            Self::SLog3Cine => S_GAMUT3_CINE,
            Self::SLog3 | Self::SLog2 => S_GAMUT,
            Self::VLog => V_GAMUT,
            Self::CLog3 => CINEMA_GAMUT,
            Self::LogC3 => ARRI_WIDE_GAMUT_3,
            Self::LogC4 => ARRI_WIDE_GAMUT_4,
            Self::FLog2 | Self::NLog | Self::AppleLog => REC2020,
            Self::DLog => D_GAMUT,
            Self::DLogM => SRGB,
        }
    }

    pub fn source_peak(self) -> f32 {
        self.curve().decode(1.0).min(MAX_SOURCE_PEAK) as f32
    }

    pub fn to_working(self) -> Mat3 {
        self.gamut().to(WORKING).as_mat3()
    }

    pub fn decoder(self, bits: u32, full_range: bool) -> impl Fn([f32; 3]) -> [f32; 3] + Sync {
        let curve = self.curve();
        let (scale, bias) = curve.code_range(bits, full_range);
        let matrix = self.to_working();
        move |rgb| {
            let scene = rgb.map(|value| curve.decode(value as f64 * scale + bias) as f32);
            (matrix * Vec3::from_array(scene)).to_array()
        }
    }

    pub fn uniforms(self, bits: u32, full_range: bool) -> [[f32; 4]; 3] {
        let curve = self.curve();
        let toe = match curve.toe {
            Toe::Linear => 0.0,
            Toe::Cubic => 1.0,
            Toe::Root => 2.0,
        };
        let (scale, bias) = curve.code_range(bits, full_range);
        [
            [
                curve.exponent as f32,
                curve.offset as f32,
                curve.black as f32,
                curve.gain as f32,
            ],
            [
                curve.cut as f32,
                curve.toe_slope as f32,
                curve.toe_offset as f32,
                toe,
            ],
            [scale as f32, bias as f32, 0.0, 0.0],
        ]
    }
}

#[derive(Clone, Copy)]
struct Atom {
    kind: [u8; 4],
    body: u64,
    end: u64,
}

enum Wire<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

pub fn detect(path: &Path) -> Option<CameraLog> {
    let mut file = File::open(path).ok()?;
    let end = file.metadata().ok()?.len();
    children(&mut file, 0, end)
        .into_iter()
        .find_map(|atom| match &atom.kind {
            b"meta" => sony_metadata(&mut file, atom),
            b"moov" => dji_metadata(&mut file, atom),
            _ => None,
        })
}

fn children(file: &mut File, start: u64, end: u64) -> Vec<Atom> {
    let mut atoms = Vec::new();
    let mut position = start;
    let mut header = [0u8; 16];
    while position + 8 <= end
        && file.seek(SeekFrom::Start(position)).is_ok()
        && file.read_exact(&mut header[..8]).is_ok()
    {
        let kind = [header[4], header[5], header[6], header[7]];
        if &kind == FRAGMENT {
            break;
        }
        let (size, body) = match u32::from_be_bytes([header[0], header[1], header[2], header[3]]) {
            0 => (end - position, position + 8),
            1 if file.read_exact(&mut header[8..]).is_ok() => (
                u64::from_be_bytes(header[8..].try_into().unwrap()),
                position + 16,
            ),
            1 => break,
            size => (u64::from(size), position + 8),
        };
        let atom_end = position.saturating_add(size);
        if atom_end < body || atom_end > end {
            break;
        }
        atoms.push(Atom {
            kind,
            body,
            end: atom_end,
        });
        position = atom_end;
    }
    atoms
}

fn child(file: &mut File, parent: Atom, kind: &[u8; 4], skip: u64) -> Option<Atom> {
    children(file, parent.body + skip, parent.end)
        .into_iter()
        .find(|atom| &atom.kind == kind)
}

fn read_at(file: &mut File, start: u64, length: u64) -> Option<Vec<u8>> {
    let mut bytes = vec![0; usize::try_from(length).ok()?];
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

fn read_body(file: &mut File, atom: Atom, skip: u64, limit: u64) -> Option<Vec<u8>> {
    let start = atom.body + skip;
    read_at(file, start, atom.end.checked_sub(start)?.min(limit))
}

fn child_body(file: &mut File, parent: Atom, kind: &[u8; 4], limit: u64) -> Option<Vec<u8>> {
    let atom = child(file, parent, kind, 0)?;
    read_body(file, atom, 0, limit)
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn sony_metadata(file: &mut File, meta: Atom) -> Option<CameraLog> {
    let xml = child(file, meta, b"xml ", FULL_BOX)?;
    sony_log(std::str::from_utf8(&read_body(file, xml, FULL_BOX, XML_LIMIT)?).ok()?)
}

fn sony_log(xml: &str) -> Option<CameraLog> {
    let mut reader = Reader::from_str(xml);
    let (mut gamma, mut primaries) = (None, None);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(item) | Event::Start(item))
                if item.local_name().as_ref() == b"Item" =>
            {
                let value = |key: &str| {
                    item.try_get_attribute(key)
                        .ok()
                        .flatten()
                        .and_then(|attribute| String::from_utf8(attribute.value.into_owned()).ok())
                        .map(|text| text.to_ascii_lowercase())
                };
                match value("name").as_deref() {
                    Some("capturegammaequation") => gamma = value("value"),
                    Some("capturecolorprimaries") => primaries = value("value"),
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    match (gamma?.as_str(), primaries.as_deref()) {
        ("s-log2", None | Some("s-gamut" | "s-gamut3")) => Some(CameraLog::SLog2),
        ("s-log3" | "s-log3-cine", Some("s-gamut3-cine")) | ("s-log3-cine", None) => {
            Some(CameraLog::SLog3Cine)
        }
        ("s-log3" | "s-log3-cine", Some("s-gamut3")) | ("s-log3", None) => Some(CameraLog::SLog3),
        (SONY_PICTURE_PROFILE_9, None) => Some(CameraLog::SLog3),
        _ => None,
    }
}

fn dji_metadata(file: &mut File, moov: Atom) -> Option<CameraLog> {
    children(file, moov.body, moov.end)
        .into_iter()
        .filter(|atom| &atom.kind == b"trak")
        .find_map(|trak| {
            let media = child(file, trak, b"mdia", 0)?;
            let information = child(file, media, b"minf", 0)?;
            let table = child(file, information, b"stbl", 0)?;
            let description = child_body(file, table, b"stsd", 16)?;
            if description.get(12..16)? != DJI_METADATA {
                return None;
            }
            let sizes = child_body(file, table, b"stsz", 16)?;
            let size = match be_u32(&sizes, 4)? {
                0 => be_u32(&sizes, 12)?,
                size => size,
            };
            let offset = match child_body(file, table, b"stco", 12) {
                Some(chunks) => u64::from(be_u32(&chunks, 8)?),
                None => {
                    let chunks = child_body(file, table, b"co64", 16)?;
                    u64::from_be_bytes(chunks.get(8..16)?.try_into().ok()?)
                }
            };
            dji_log(&read_at(file, offset, u64::from(size.min(SAMPLE_LIMIT)))?)
        })
}

fn varint(data: &[u8], position: &mut usize) -> Option<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let byte = *data.get(*position)?;
        *position += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some(value);
        }
    }
    None
}

fn field(data: &[u8], number: u64) -> Option<Wire<'_>> {
    let mut position = 0;
    while position < data.len() {
        let key = varint(data, &mut position)?;
        let wire = match key & 7 {
            0 => Wire::Varint(varint(data, &mut position)?),
            1 => {
                position += 8;
                Wire::Fixed
            }
            5 => {
                position += 4;
                Wire::Fixed
            }
            2 => {
                let length = usize::try_from(varint(data, &mut position)?).ok()?;
                let bytes = data.get(position..position.checked_add(length)?)?;
                position += length;
                Wire::Bytes(bytes)
            }
            _ => return None,
        };
        if key >> 3 == number {
            return Some(wire);
        }
    }
    None
}

fn message(data: &[u8], number: u64) -> Option<&[u8]> {
    match field(data, number)? {
        Wire::Bytes(bytes) => Some(bytes),
        _ => None,
    }
}

fn dji_log(sample: &[u8]) -> Option<CameraLog> {
    let camera = message(message(sample, 2)?, 2)?;
    let mode = match field(message(camera, 3)?, 1)? {
        Wire::Varint(mode) => mode,
        Wire::Bytes(_) => match field(message(camera, 4)?, 1)? {
            Wire::Varint(mode) => mode,
            _ => return None,
        },
        Wire::Fixed => return None,
    };
    match mode {
        DJI_D_LOG => Some(CameraLog::DLog),
        DJI_D_LOG_M => Some(CameraLog::DLogM),
        _ => None,
    }
}
