use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::formats::is_raw_file;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

pub const MIN_TEMPERATURE: f64 = 2000.0;
pub const MAX_TEMPERATURE: f64 = 50000.0;
pub const MAX_TINT: f64 = 150.0;
pub const MIRED_PER_RELATIVE_UNIT: f64 = 1.5;
pub const TINT_PER_RELATIVE_UNIT: f64 = 1.5;

const TINT_SCALE: f64 = -3000.0;
const D65_XY: (f64, f64) = (0.31271, 0.32902);

const BRADFORD: [[f64; 3]; 3] = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];

const ROBERTSON_ISOTHERMS: [[f64; 4]; 31] = [
    [0.0, 0.18006, 0.26352, -0.24341],
    [10.0, 0.18066, 0.26589, -0.25479],
    [20.0, 0.18133, 0.26846, -0.26876],
    [30.0, 0.18208, 0.27119, -0.28539],
    [40.0, 0.18293, 0.27407, -0.30470],
    [50.0, 0.18388, 0.27709, -0.32675],
    [60.0, 0.18494, 0.28021, -0.35156],
    [70.0, 0.18611, 0.28342, -0.37915],
    [80.0, 0.18740, 0.28668, -0.40955],
    [90.0, 0.18880, 0.28997, -0.44278],
    [100.0, 0.19032, 0.29326, -0.47888],
    [125.0, 0.19462, 0.30141, -0.58204],
    [150.0, 0.19962, 0.30921, -0.70471],
    [175.0, 0.20525, 0.31647, -0.84901],
    [200.0, 0.21142, 0.32312, -1.0182],
    [225.0, 0.21807, 0.32909, -1.2168],
    [250.0, 0.22511, 0.33439, -1.4512],
    [275.0, 0.23247, 0.33904, -1.7298],
    [300.0, 0.24010, 0.34308, -2.0637],
    [325.0, 0.24792, 0.34655, -2.4681],
    [350.0, 0.25591, 0.34951, -2.9641],
    [375.0, 0.26400, 0.35200, -3.5814],
    [400.0, 0.27218, 0.35407, -4.3633],
    [425.0, 0.28039, 0.35577, -5.3762],
    [450.0, 0.28863, 0.35714, -6.7262],
    [475.0, 0.29685, 0.35823, -8.5955],
    [500.0, 0.30505, 0.35907, -11.324],
    [525.0, 0.31320, 0.35968, -15.628],
    [550.0, 0.32129, 0.36011, -23.325],
    [575.0, 0.32931, 0.36038, -40.770],
    [600.0, 0.33724, 0.36051, -116.45],
];

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct WhiteBalance {
    pub temperature: f64,
    pub tint: f64,
}

fn isotherm_direction(slope: f64) -> (f64, f64) {
    let len = (1.0 + slope * slope).sqrt();
    (1.0 / len, slope / len)
}

impl WhiteBalance {
    pub fn reference() -> Self {
        Self::from_xy(D65_XY.0, D65_XY.1)
    }

    pub fn from_xy(x: f64, y: f64) -> Self {
        let denom = 1.5 - x + 6.0 * y;
        let u = 2.0 * x / denom;
        let v = 3.0 * y / denom;

        let mut last_distance = 0.0;
        let mut last_direction = (0.0, 0.0);
        for i in 1..ROBERTSON_ISOTHERMS.len() {
            let [mired, iso_u, iso_v, slope] = ROBERTSON_ISOTHERMS[i];
            let direction = isotherm_direction(slope);
            let distance = (v - iso_v) * direction.0 - (u - iso_u) * direction.1;
            let is_last = i == ROBERTSON_ISOTHERMS.len() - 1;

            if distance <= 0.0 || is_last {
                let distance = (-distance).max(0.0);
                let f = if i == 1 {
                    0.0
                } else {
                    distance / (last_distance + distance)
                };
                let [prev_mired, prev_u, prev_v, _] = ROBERTSON_ISOTHERMS[i - 1];
                let locus_u = prev_u * f + iso_u * (1.0 - f);
                let locus_v = prev_v * f + iso_v * (1.0 - f);
                let du = direction.0 * (1.0 - f) + last_direction.0 * f;
                let dv = direction.1 * (1.0 - f) + last_direction.1 * f;
                let len = (du * du + dv * dv).sqrt();
                let offset = ((u - locus_u) * du + (v - locus_v) * dv) / len;

                return Self {
                    temperature: 1.0e6 / (prev_mired * f + mired * (1.0 - f)),
                    tint: offset * TINT_SCALE,
                };
            }

            last_distance = distance;
            last_direction = direction;
        }
        unreachable!()
    }

    pub fn to_xy(self) -> (f64, f64) {
        let mired = 1.0e6 / self.temperature;
        let i = ROBERTSON_ISOTHERMS
            .iter()
            .skip(1)
            .position(|row| mired < row[0])
            .map_or(ROBERTSON_ISOTHERMS.len() - 1, |p| p + 1);

        let [prev_mired, prev_u, prev_v, prev_slope] = ROBERTSON_ISOTHERMS[i - 1];
        let [next_mired, next_u, next_v, next_slope] = ROBERTSON_ISOTHERMS[i];
        let f = (next_mired - mired) / (next_mired - prev_mired);

        let prev_direction = isotherm_direction(prev_slope);
        let next_direction = isotherm_direction(next_slope);
        let du = prev_direction.0 * f + next_direction.0 * (1.0 - f);
        let dv = prev_direction.1 * f + next_direction.1 * (1.0 - f);
        let len = (du * du + dv * dv).sqrt();

        let u = prev_u * f + next_u * (1.0 - f) + du / len * self.tint / TINT_SCALE;
        let v = prev_v * f + next_v * (1.0 - f) + dv / len * self.tint / TINT_SCALE;
        let denom = u - 4.0 * v + 2.0;
        (1.5 * u / denom, v / denom)
    }

    pub fn clamped(self) -> Self {
        Self {
            temperature: self.temperature.clamp(MIN_TEMPERATURE, MAX_TEMPERATURE),
            tint: self.tint.clamp(-MAX_TINT, MAX_TINT),
        }
    }

    pub fn shifted(self, relative_temperature: f64, relative_tint: f64) -> Self {
        if relative_temperature == 0.0 && relative_tint == 0.0 {
            return self;
        }
        let mired = 1.0e6 / self.temperature - relative_temperature * MIRED_PER_RELATIVE_UNIT;
        Self {
            temperature: 1.0e6 / mired.max(1.0e6 / MAX_TEMPERATURE),
            tint: self.tint + relative_tint * TINT_PER_RELATIVE_UNIT,
        }
        .clamped()
    }

    fn lms(self) -> [f64; 3] {
        let (x, y) = self.to_xy();
        let xyz = [x / y, 1.0, (1.0 - x - y) / y];
        BRADFORD.map(|row| row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2])
    }

    pub fn from_camera_neutral(xyz_to_camera: &[f32], neutral: &[f32]) -> Option<Self> {
        let channels = xyz_to_camera.len() / 3;
        if channels < 3 || neutral.len() < channels {
            return None;
        }
        let mut normal = [[0.0; 3]; 3];
        let mut rhs = [0.0; 3];
        for (row, &n) in xyz_to_camera.as_chunks::<3>().0.iter().zip(neutral) {
            let r = row.map(|v| v as f64);
            let n = n as f64;
            for i in 0..3 {
                rhs[i] += r[i] * n;
                for j in 0..3 {
                    normal[i][j] += r[i] * r[j];
                }
            }
        }

        let xyz = solve_3x3(normal, rhs)?;
        let sum = xyz[0] + xyz[1] + xyz[2];
        if !sum.is_finite() || sum <= 0.0 || xyz[1] <= 0.0 {
            return None;
        }
        Some(Self::from_xy(xyz[0] / sum, xyz[1] / sum))
    }
}

fn solve_3x3(m: [[f64; 3]; 3], b: [f64; 3]) -> Option<[f64; 3]> {
    let det = |m: &[[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(&m);
    if d.abs() < 1e-12 {
        return None;
    }
    let mut result = [0.0; 3];
    for (col, value) in result.iter_mut().enumerate() {
        let mut replaced = m;
        for row in 0..3 {
            replaced[row][col] = b[row];
        }
        *value = det(&replaced) / d;
    }
    Some(result)
}

pub fn adaptation_log_gains(current: WhiteBalance, target: WhiteBalance) -> [f32; 3] {
    let from = current.lms();
    let to = target.lms();
    [0, 1, 2].map(|i| (from[i] / to[i]).ln() as f32)
}

pub fn from_adjustments(adjustments: &Value, as_shot: WhiteBalance) -> WhiteBalance {
    adjustments
        .get("whiteBalance")
        .and_then(|v| serde_json::from_value::<WhiteBalance>(v.clone()).ok())
        .unwrap_or(as_shot)
        .shifted(
            adjustments["temperature"].as_f64().unwrap_or(0.0),
            adjustments["tint"].as_f64().unwrap_or(0.0),
        )
}

#[tauri::command]
pub fn pick_white_balance(sample: [f64; 3], current: WhiteBalance) -> Option<WhiteBalance> {
    const SRGB_TO_XYZ: [[f64; 3]; 3] = [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ];
    let to_lms = |rgb: [f64; 3]| {
        let xyz = SRGB_TO_XYZ.map(|row| row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
        BRADFORD.map(|row| row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2])
    };
    let sample_lms = to_lms(sample);
    let white_lms = to_lms([1.0, 1.0, 1.0]);
    let current_lms = current.lms();
    if sample_lms.iter().any(|v| *v <= 0.0) {
        return None;
    }

    let illuminant_lms = [0, 1, 2].map(|i| current_lms[i] * sample_lms[i] / white_lms[i]);
    let xyz = solve_3x3(BRADFORD, illuminant_lms)?;
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !sum.is_finite() || sum <= 0.0 {
        return None;
    }
    Some(WhiteBalance::from_xy(xyz[0] / sum, xyz[1] / sum).clamped())
}

fn as_shot_cache() -> &'static Mutex<HashMap<String, WhiteBalance>> {
    static CACHE: OnceLock<Mutex<HashMap<String, WhiteBalance>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn as_shot_white_balance(path: &str) -> WhiteBalance {
    let (source_path, _) = parse_virtual_path(path);
    let source_path = source_path.to_string_lossy().to_string();
    if !is_raw_file(&source_path) {
        return WhiteBalance::reference();
    }
    if let Some(cached) = as_shot_cache().lock().unwrap().get(&source_path) {
        return *cached;
    }

    let white_balance = read_file_mapped(Path::new(&source_path))
        .ok()
        .and_then(|mmap| crate::raw_processing::read_as_shot_white_balance(&mmap))
        .unwrap_or_else(WhiteBalance::reference);

    as_shot_cache()
        .lock()
        .unwrap()
        .insert(source_path, white_balance);
    white_balance
}
