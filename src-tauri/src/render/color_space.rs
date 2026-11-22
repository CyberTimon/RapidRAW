use glam::{DMat3, DVec2, DVec3, Mat3, Vec3};
use moxcms::{
    Chromaticity, ColorPrimaries, ColorProfile, LocalizableString, ProfileText, ToneReprCurve, XyY,
    Xyzd,
};
use serde::{Deserialize, Serialize};
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
const WHITE_D50: DVec2 = DVec2::new(0.3457, 0.3585);

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

const DISPLAY_P3: RgbSpace = RgbSpace {
    primaries: [
        DVec2::new(0.680, 0.320),
        DVec2::new(0.265, 0.690),
        DVec2::new(0.150, 0.060),
    ],
    white: WHITE_D65,
};

const ADOBE_RGB: RgbSpace = RgbSpace {
    primaries: [
        DVec2::new(0.64, 0.33),
        DVec2::new(0.21, 0.71),
        DVec2::new(0.15, 0.06),
    ],
    white: WHITE_D65,
};

const PRO_PHOTO_RGB: RgbSpace = RgbSpace {
    primaries: [
        DVec2::new(0.734699, 0.265301),
        DVec2::new(0.159597, 0.840403),
        DVec2::new(0.036598, 0.000105),
    ],
    white: WHITE_D50,
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransferCurve {
    power: f32,
    offset: f32,
    slope: f32,
    cutoff: f32,
}

impl TransferCurve {
    pub const SRGB: Self = Self {
        power: 1.0 / 2.4,
        offset: 0.055,
        slope: 12.92,
        cutoff: 0.0031308,
    };

    const REC709: Self = Self {
        power: 0.45,
        offset: 0.099_296_83,
        slope: 4.5,
        cutoff: 0.018_053_97,
    };

    pub const fn gamma(gamma: f32) -> Self {
        Self {
            power: 1.0 / gamma,
            offset: 0.0,
            slope: 0.0,
            cutoff: 0.0,
        }
    }

    pub fn encode(self, linear: f32) -> f32 {
        if linear <= self.cutoff {
            linear.max(0.0) * self.slope
        } else {
            (1.0 + self.offset) * linear.powf(self.power) - self.offset
        }
    }

    pub fn decode(self, encoded: f32) -> f32 {
        if encoded <= self.cutoff * self.slope {
            if self.slope > 0.0 {
                encoded / self.slope
            } else {
                0.0
            }
        } else {
            ((encoded + self.offset) / (1.0 + self.offset)).powf(1.0 / self.power)
        }
    }

    pub fn uniform(self) -> [f32; 4] {
        [self.power, self.offset, self.slope, self.cutoff]
    }

    fn tone_curve(self) -> ToneReprCurve {
        let gamma = 1.0 / self.power;
        let scale = 1.0 + self.offset;
        ToneReprCurve::Parametric(if self.cutoff > 0.0 {
            vec![
                gamma,
                1.0 / scale,
                self.offset / scale,
                1.0 / self.slope,
                self.cutoff * self.slope,
            ]
        } else {
            vec![gamma]
        })
    }
}

fn color_profile(space: RgbSpace, curve: TransferCurve, name: &str) -> ColorProfile {
    let chromaticity = |xy: DVec2| Chromaticity {
        x: xy.x as f32,
        y: xy.y as f32,
    };
    let [red, green, blue] = space.primaries.map(chromaticity);
    let white = chromaticity_to_xyz(space.white);
    let mut profile = ColorProfile::new_srgb();
    profile.update_rgb_colorimetry(
        XyY {
            x: space.white.x,
            y: space.white.y,
            yb: 1.0,
        },
        ColorPrimaries { red, green, blue },
    );
    profile.media_white_point = Some(Xyzd {
        x: white.x,
        y: white.y,
        z: white.z,
    });
    profile.red_trc = Some(curve.tone_curve());
    profile.green_trc = Some(curve.tone_curve());
    profile.blue_trc = Some(curve.tone_curve());
    profile.description = Some(ProfileText::Localizable(vec![LocalizableString::new(
        "en".to_string(),
        "US".to_string(),
        name.to_string(),
    )]));
    profile
}

pub fn working_profile() -> ColorProfile {
    color_profile(
        WORKING,
        TransferCurve::SRGB,
        "Rec.2020 with sRGB tone curve",
    )
}

pub fn working_icc_profile() -> &'static [u8] {
    &WORKING_SPACE.icc
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OutputColorSpace {
    #[default]
    Srgb,
    DisplayP3,
    AdobeRgb,
    ProPhotoRgb,
    Rec2020,
}

impl OutputColorSpace {
    const ALL: [Self; 5] = [
        Self::Srgb,
        Self::DisplayP3,
        Self::AdobeRgb,
        Self::ProPhotoRgb,
        Self::Rec2020,
    ];

    pub fn rgb(self) -> RgbSpace {
        match self {
            Self::Srgb => SRGB,
            Self::DisplayP3 => DISPLAY_P3,
            Self::AdobeRgb => ADOBE_RGB,
            Self::ProPhotoRgb => PRO_PHOTO_RGB,
            Self::Rec2020 => REC2020,
        }
    }

    pub fn working_matrix(self) -> Mat3 {
        WORKING.to(self.rgb()).as_mat3()
    }

    pub fn profile(self) -> ColorProfile {
        self.profile_with_curve(self.curve())
    }

    pub fn profile_with_curve(self, curve: TransferCurve) -> ColorProfile {
        color_profile(self.rgb(), curve, self.name())
    }

    pub fn curve(self) -> TransferCurve {
        match self {
            Self::Srgb | Self::DisplayP3 => TransferCurve::SRGB,
            Self::AdobeRgb => TransferCurve::gamma(563.0 / 256.0),
            Self::ProPhotoRgb => TransferCurve::gamma(1.8),
            Self::Rec2020 => TransferCurve::REC709,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Srgb => "sRGB",
            Self::DisplayP3 => "Display P3",
            Self::AdobeRgb => "Adobe RGB (1998) compatible",
            Self::ProPhotoRgb => "ProPhoto RGB",
            Self::Rec2020 => "Rec. 2020",
        }
    }

    pub fn icc_profile(self) -> &'static [u8] {
        static PROFILES: LazyLock<[Vec<u8>; 5]> = LazyLock::new(|| {
            OutputColorSpace::ALL.map(|space| match space {
                OutputColorSpace::Srgb => include_bytes!("../../icc/sRGB-v2-magic.icc").to_vec(),
                _ => space
                    .profile()
                    .encode()
                    .expect("output color profile encodes"),
            })
        });
        let index = Self::ALL.iter().position(|space| *space == self);
        &PROFILES[index.expect("every output color space is listed")]
    }

    pub fn srgb_converter(self) -> impl Fn([f32; 3]) -> [f32; 3] {
        let matrix = SRGB.to(self.rgb()).as_mat3();
        let curve = self.curve();
        move |srgb| {
            (matrix * Vec3::from_array(srgb.map(|c| TransferCurve::SRGB.decode(c))))
                .to_array()
                .map(|c| curve.encode(c.min(1.0)))
        }
    }

    pub fn srgb_matrix(self) -> Mat3 {
        self.rgb().to(SRGB).as_mat3()
    }

    pub fn linear_srgb_decoder(self) -> impl Fn([u8; 3]) -> [f32; 3] + Sync {
        let matrix = self.srgb_matrix();
        let curve = self.curve();
        let decoded: [f32; 256] = std::array::from_fn(|i| curve.decode(i as f32 / 255.0));
        move |encoded| (matrix * Vec3::from_array(encoded.map(|c| decoded[c as usize]))).to_array()
    }
}

const TRANSFER_STEPS: usize = 4095;

type TransferTable = [f32; TRANSFER_STEPS + 2];

#[derive(Debug)]
pub struct SrgbTransfer {
    decode: TransferTable,
    encode_from_sqrt: TransferTable,
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
            TransferCurve::SRGB.decode(c)
        }
    }

    #[inline]
    pub fn encode(&self, c: f32) -> f32 {
        if c > TransferCurve::SRGB.cutoff && c <= 1.0 {
            interpolate(&self.encode_from_sqrt, c.sqrt())
        } else {
            TransferCurve::SRGB.encode(c)
        }
    }
}

pub fn srgb_transfer() -> &'static SrgbTransfer {
    static TRANSFER: LazyLock<SrgbTransfer> = LazyLock::new(|| SrgbTransfer {
        decode: transfer_table(|c| TransferCurve::SRGB.decode(c)),
        encode_from_sqrt: transfer_table(|root| TransferCurve::SRGB.encode(root * root)),
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
    pub curve: TransferCurve,
    transfer: &'static SrgbTransfer,
}

impl OutputTransform {
    pub fn new(space: OutputColorSpace, compress_gamut: bool) -> Self {
        let matrix = WORKING.to(space.rgb()).as_mat3();
        let compression = if compress_gamut {
            gamut_limits(&matrix.to_cols_array_2d()).map(GamutCompression::new)
        } else {
            [None; 3]
        };
        Self {
            matrix,
            compression,
            curve: space.curve(),
            transfer: srgb_transfer(),
        }
    }

    pub fn srgb(compress_gamut: bool) -> Self {
        Self::new(OutputColorSpace::Srgb, compress_gamut)
    }

    #[inline]
    pub fn apply_srgb_encoded(&self, working: [f32; 3]) -> [f32; 3] {
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
