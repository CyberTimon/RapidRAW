use glam::{DMat3, DVec2, DVec3, Mat3, Vec3};
use moxcms::{ColorProfile, LocalizableString, ProfileText};
use std::sync::LazyLock;

pub const BRADFORD: DMat3 = DMat3::from_cols_array(&[
    0.8951, -0.7502, 0.0389, 0.2664, 1.7135, -0.0685, -0.1614, 0.0367, 1.0296,
]);

const OKLAB_XYZ_TO_LMS: DMat3 = DMat3::from_cols_array(&[
    0.8189330101,
    0.0329845436,
    0.0482003018,
    0.3618667424,
    0.9293118715,
    0.2643662691,
    -0.1288597137,
    0.0361456387,
    0.6338517070,
]);

pub const WHITE_D65: DVec2 = DVec2::new(0.3127, 0.3290);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RgbSpace {
    pub primaries: [DVec2; 3],
    pub white: DVec2,
}

pub const SRGB: RgbSpace = RgbSpace {
    primaries: [
        DVec2::new(0.64, 0.33),
        DVec2::new(0.30, 0.60),
        DVec2::new(0.15, 0.06),
    ],
    white: WHITE_D65,
};

pub const REC2020: RgbSpace = RgbSpace {
    primaries: [
        DVec2::new(0.708, 0.292),
        DVec2::new(0.170, 0.797),
        DVec2::new(0.131, 0.046),
    ],
    white: WHITE_D65,
};

pub const WORKING: RgbSpace = REC2020;

pub fn chromaticity_to_xyz(xy: DVec2) -> DVec3 {
    DVec3::new(xy.x / xy.y, 1.0, (1.0 - xy.x - xy.y) / xy.y)
}

pub fn xyz_to_chromaticity(xyz: DVec3) -> DVec2 {
    xyz.truncate() / xyz.element_sum()
}

pub fn chromatic_adaptation(from: DVec3, to: DVec3) -> DMat3 {
    BRADFORD.inverse() * DMat3::from_diagonal((BRADFORD * to) / (BRADFORD * from)) * BRADFORD
}

impl RgbSpace {
    pub fn to_xyz(self) -> DMat3 {
        let [r, g, b] = self.primaries.map(chromaticity_to_xyz);
        let primaries = DMat3::from_cols(r, g, b);
        let scale = primaries.inverse() * chromaticity_to_xyz(self.white);
        primaries * DMat3::from_diagonal(scale)
    }

    pub fn luma(self) -> DVec3 {
        self.to_xyz().row(1)
    }

    pub fn to(self, target: RgbSpace) -> DMat3 {
        let adaptation = chromatic_adaptation(
            chromaticity_to_xyz(self.white),
            chromaticity_to_xyz(target.white),
        );
        target.to_xyz().inverse() * adaptation * self.to_xyz()
    }
}

struct WorkingSpace {
    luma: Vec3,
    to_srgb: Mat3,
    from_srgb: Mat3,
    to_oklab_lms: Mat3,
    from_oklab_lms: Mat3,
    icc: Vec<u8>,
}

static WORKING_SPACE: LazyLock<WorkingSpace> = LazyLock::new(|| {
    let to_lms = OKLAB_XYZ_TO_LMS * WORKING.to_xyz();
    let to_oklab_lms = DMat3::from_diagonal(1.0 / (to_lms * DVec3::ONE)) * to_lms;
    WorkingSpace {
        luma: WORKING.luma().as_vec3(),
        to_srgb: WORKING.to(SRGB).as_mat3(),
        from_srgb: SRGB.to(WORKING).as_mat3(),
        to_oklab_lms: to_oklab_lms.as_mat3(),
        from_oklab_lms: to_oklab_lms.inverse().as_mat3(),
        icc: working_profile()
            .encode()
            .expect("working color profile encodes"),
    }
});

pub fn working_luma() -> [f32; 3] {
    WORKING_SPACE.luma.to_array()
}

pub fn luminance(rgb: &[f32]) -> f32 {
    let luma = WORKING_SPACE.luma;
    luma.x * rgb[0] + luma.y * rgb[1] + luma.z * rgb[2]
}

pub fn working_to_srgb() -> Mat3 {
    WORKING_SPACE.to_srgb
}

pub fn srgb_to_working() -> Mat3 {
    WORKING_SPACE.from_srgb
}

pub fn working_profile() -> ColorProfile {
    let srgb = ColorProfile::new_srgb();
    let mut profile = ColorProfile::new_bt2020();
    profile.red_trc = srgb.red_trc;
    profile.green_trc = srgb.green_trc;
    profile.blue_trc = srgb.blue_trc;
    profile.description = Some(ProfileText::Localizable(vec![LocalizableString::new(
        "en".to_string(),
        "US".to_string(),
        "Rec.2020 with sRGB tone curve".to_string(),
    )]));
    profile
}

pub fn working_icc_profile() -> &'static [u8] {
    &WORKING_SPACE.icc
}

const SRGB_LINEAR_SEGMENT_END: f32 = 0.0031308;
const TRANSFER_STEPS: usize = 4095;

type TransferTable = [f32; TRANSFER_STEPS + 2];

#[derive(Debug)]
pub struct SrgbTransfer {
    decode: TransferTable,
    encode_from_sqrt: TransferTable,
}

fn srgb_eotf(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn srgb_oetf(c: f32) -> f32 {
    if c <= SRGB_LINEAR_SEGMENT_END {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn transfer_table(curve: impl Fn(f32) -> f32) -> TransferTable {
    std::array::from_fn(|i| curve(i.min(TRANSFER_STEPS) as f32 / TRANSFER_STEPS as f32))
}

#[inline]
fn interpolate(table: &TransferTable, position: f32) -> f32 {
    let scaled = position * TRANSFER_STEPS as f32;
    let index = (scaled as usize).min(TRANSFER_STEPS);
    table[index] + (table[index + 1] - table[index]) * (scaled - index as f32)
}

impl SrgbTransfer {
    #[inline]
    pub fn decode(&self, c: f32) -> f32 {
        if (0.0..=1.0).contains(&c) {
            interpolate(&self.decode, c)
        } else {
            srgb_eotf(c)
        }
    }

    #[inline]
    pub fn encode(&self, c: f32) -> f32 {
        if c > SRGB_LINEAR_SEGMENT_END && c <= 1.0 {
            interpolate(&self.encode_from_sqrt, c.sqrt())
        } else {
            srgb_oetf(c.max(0.0))
        }
    }
}

pub fn srgb_transfer() -> &'static SrgbTransfer {
    static TRANSFER: LazyLock<SrgbTransfer> = LazyLock::new(|| SrgbTransfer {
        decode: transfer_table(srgb_eotf),
        encode_from_sqrt: transfer_table(|root| srgb_oetf(root * root)),
    });
    &TRANSFER
}

pub fn srgb_decode(c: f32) -> f32 {
    srgb_transfer().decode(c)
}

pub fn srgb_encode(c: f32) -> f32 {
    srgb_transfer().encode(c)
}

#[derive(Clone, Copy, Debug)]
pub struct GamutCompression {
    scale: f32,
}

impl GamutCompression {
    const THRESHOLD: f32 = 0.8;
    const POWER: f32 = 1.2;

    pub fn new(limit: f32) -> Option<Self> {
        if limit <= 1.0 {
            return None;
        }
        let span = limit - Self::THRESHOLD;
        let scale = span
            / (((1.0 - Self::THRESHOLD) / span).powf(-Self::POWER) - 1.0).powf(1.0 / Self::POWER);
        Some(Self { scale })
    }

    #[inline]
    pub fn compress(&self, distance: f32) -> f32 {
        if distance <= Self::THRESHOLD {
            return distance;
        }
        let excess = distance - Self::THRESHOLD;
        Self::THRESHOLD
            + excess / (1.0 + (excess / self.scale).powf(Self::POWER)).powf(1.0 / Self::POWER)
    }
}

pub fn gamut_limits(source_primaries: &[[f32; 3]]) -> [f32; 3] {
    let mut limits = [0.0f32; 3];
    for primary in source_primaries {
        let peak = primary[0].max(primary[1]).max(primary[2]);
        if peak > 0.0 {
            for (limit, value) in limits.iter_mut().zip(primary) {
                *limit = limit.max((peak - value) / peak);
            }
        }
    }
    limits
}

pub fn compression_uniform(compression: &[Option<GamutCompression>; 3]) -> [f32; 4] {
    let scale = compression.map(|c| c.map_or(0.0, |c| c.scale));
    [scale[0], scale[1], scale[2], GamutCompression::THRESHOLD]
}

#[inline]
pub fn fit_gamut(rgb: [f32; 3], compression: &[Option<GamutCompression>; 3]) -> [f32; 3] {
    let peak = rgb[0].max(rgb[1]).max(rgb[2]);
    if peak <= 0.0 {
        return [0.0; 3];
    }
    let mut distance = [0.0f32; 3];
    for ((distance, value), compression) in distance.iter_mut().zip(rgb).zip(compression) {
        let raw = (peak - value) / peak;
        *distance = compression.map_or(raw, |c| c.compress(raw));
    }
    let furthest = distance[0].max(distance[1]).max(distance[2]).max(1.0);
    distance.map(|d| peak - d / furthest * peak)
}

#[derive(Clone, Copy, Debug)]
pub struct OutputTransform {
    pub matrix: Mat3,
    pub compression: [Option<GamutCompression>; 3],
    transfer: &'static SrgbTransfer,
}

impl OutputTransform {
    pub fn srgb(compress_gamut: bool) -> Self {
        let matrix = working_to_srgb();
        let compression = if compress_gamut {
            gamut_limits(&matrix.to_cols_array_2d()).map(GamutCompression::new)
        } else {
            [None; 3]
        };
        Self {
            matrix,
            compression,
            transfer: srgb_transfer(),
        }
    }

    #[inline]
    pub fn apply_encoded(&self, working: [f32; 3]) -> [f32; 3] {
        let linear = Vec3::from_array(working.map(|c| self.transfer.decode(c.max(0.0))));
        fit_gamut((self.matrix * linear).to_array(), &self.compression)
            .map(|c| self.transfer.encode(c.min(1.0)))
    }
}

pub fn wgsl_vec3(v: Vec3) -> String {
    format!("vec3<f32>({:?}, {:?}, {:?})", v.x, v.y, v.z)
}

pub fn wgsl_mat3(m: Mat3) -> String {
    format!(
        "mat3x3<f32>({}, {}, {})",
        wgsl_vec3(m.x_axis),
        wgsl_vec3(m.y_axis),
        wgsl_vec3(m.z_axis)
    )
}

pub fn with_shader_prelude(source: &str) -> String {
    let space = &*WORKING_SPACE;
    format!(
        "const LUMA_COEFF = {};\n\
         const SRGB_LUMA_COEFF = {};\n\
         const WORKING_TO_SRGB = {};\n\
         const SRGB_TO_WORKING = {};\n\
         const WORKING_TO_OKLAB_LMS = {};\n\
         const OKLAB_LMS_TO_WORKING = {};\n\
         const GAMUT_COMPRESSION_POWER: f32 = {:?};\n\
         {}\n{}",
        wgsl_vec3(space.luma),
        wgsl_vec3(SRGB.luma().as_vec3()),
        wgsl_mat3(space.to_srgb),
        wgsl_mat3(space.from_srgb),
        wgsl_mat3(space.to_oklab_lms),
        wgsl_mat3(space.from_oklab_lms),
        GamutCompression::POWER,
        include_str!("../shaders/color.wgsl"),
        source
    )
}
