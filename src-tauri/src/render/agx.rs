use crate::render::color_space::{
    REC2020, RgbSpace, WORKING, chromatic_adaptation, chromaticity_to_xyz, srgb_transfer,
    wgsl_mat3, wgsl_vec3, xyz_to_chromaticity,
};
use crate::render::hdr::scene_linear_knee;
use glam::{DMat3, DVec2, DVec3, Mat3, Vec3};
use std::sync::LazyLock;

const BLACK_EV: f64 = -10.0;
const WHITE_EV: f64 = 3.4;
const HDR_WHITE_EV: f64 = 6.5;
const MIDDLE_GREY: f64 = 0.18;
const EXPOSURE_BIAS_EV: f64 = 0.3;
const CONTRAST: f64 = 3.0;
const TOE_POWER: f64 = 1.5;
const SHOULDER_POWER: f64 = 3.3;
const GAMMA: f64 = 2.2;
const HUE_PRESERVATION: f32 = 0.6;
const EPSILON: f32 = 1.0e-6;

const INSET: [f64; 3] = [0.29462451, 0.25861925, 0.14641371];
const ROTATION: [f64; 3] = [0.03540329, -0.02108586, -0.06305724];
const OUTSET: [f64; 3] = [0.290776401758, 0.263155400753, 0.045810721815];
const PROFILE_WHITE: DVec3 = DVec3::new(0.9642, 1.0, 0.8249);
const GAMUT_LUMA: DVec3 = DVec3::new(0.2658180370250449, 0.59846986045365, 0.1357121025213052);

const CURVE_LUT_SIZE: usize = 4096;

pub struct Agx {
    working_to_rendering: Mat3,
    rendering_to_working: Mat3,
    scene_grey: f32,
    black_ev: f32,
    range_ev: f32,
    pivot_x: f32,
    pivot_y: f32,
    slope: f32,
    toe_scale: f32,
    shoulder_scale: f32,
    gamut_luma: Vec3,
    linear_curve: Vec<f32>,
    white_level: f32,
    hdr_max_x: f32,
    hdr_knee_x: f32,
    hdr_knee_linear: f32,
}

fn sigmoid_scale(run: f64, rise: f64, slope: f64, power: f64) -> f64 {
    (rise.powf(-power) - (slope * run).powf(-power)).powf(-1.0 / power)
}

fn distance_to_gamut_edge(space: &RgbSpace, direction: DVec2) -> f64 {
    (0..3)
        .filter_map(|i| {
            let start = space.primaries[i];
            let edge = space.primaries[(i + 1) % 3] - start;
            let denominator = direction.perp_dot(edge);
            let distance = (start - space.white).perp_dot(edge) / denominator;
            (denominator != 0.0 && distance >= 0.0).then_some(distance)
        })
        .fold(f64::MAX, f64::min)
}

fn moved_primary(space: &RgbSpace, index: usize, scale: f64, rotation: f64) -> DVec2 {
    let direction =
        DVec2::from_angle(rotation).rotate((space.primaries[index] - space.white).normalize());
    space.white + direction * (scale * distance_to_gamut_edge(space, direction))
}

fn rendering_matrix(base: &RgbSpace, attenuation: [f64; 3], rotation: [f64; 3]) -> DMat3 {
    let rendering = RgbSpace {
        primaries: [0, 1, 2].map(|i| moved_primary(base, i, 1.0 - attenuation[i], rotation[i])),
        white: base.white,
    };
    base.to_xyz().inverse() * rendering.to_xyz()
}

fn scalar_sigmoid(x: f32, power: f32) -> f32 {
    x / (1.0 + x.powf(power)).powf(1.0 / power)
}

fn rgb_to_hsv(rgb: Vec3) -> Vec3 {
    let max = rgb.max_element();
    let delta = max - rgb.min_element();
    if max.abs() <= EPSILON || delta.abs() <= EPSILON {
        return Vec3::new(0.0, 0.0, max);
    }
    let hue = if rgb.x == max {
        (rgb.y - rgb.z) / delta
    } else if rgb.y == max {
        2.0 + (rgb.z - rgb.x) / delta
    } else {
        4.0 + (rgb.x - rgb.y) / delta
    };
    Vec3::new((hue / 6.0).rem_euclid(1.0), delta / max, max)
}

fn hsv_to_rgb(hsv: Vec3) -> Vec3 {
    let chroma = hsv.y * hsv.z;
    let floor = hsv.z - chroma;
    let sector = hsv.x.rem_euclid(1.0) * 6.0 % 6.0;
    let rising = floor + chroma * sector.fract();
    let falling = floor + chroma * (1.0 - sector.fract());
    match sector as u32 {
        0 => Vec3::new(hsv.z, rising, floor),
        1 => Vec3::new(falling, hsv.z, floor),
        2 => Vec3::new(floor, hsv.z, rising),
        3 => Vec3::new(floor, falling, hsv.z),
        4 => Vec3::new(rising, floor, hsv.z),
        _ => Vec3::new(hsv.z, floor, falling),
    }
}

impl Agx {
    fn new() -> Self {
        let range_ev = WHITE_EV - BLACK_EV;
        let pivot_x = -BLACK_EV / range_ev;
        let pivot_y = MIDDLE_GREY.powf(1.0 / GAMMA);
        let slope = CONTRAST * range_ev / (HDR_WHITE_EV - BLACK_EV);
        let scene_grey = MIDDLE_GREY * (-EXPOSURE_BIAS_EV).exp2();

        let to_profile = chromatic_adaptation(chromaticity_to_xyz(REC2020.white), PROFILE_WHITE);
        let base_to_xyz = to_profile * REC2020.to_xyz();
        let base = RgbSpace {
            primaries: [0, 1, 2].map(|i| xyz_to_chromaticity(base_to_xyz.col(i))),
            white: xyz_to_chromaticity(PROFILE_WHITE),
        };
        let working_to_base = WORKING.to(REC2020);
        let base_to_rendering = rendering_matrix(&base, INSET, ROTATION);
        let rendering_to_base = rendering_matrix(&base, OUTSET, [0.0; 3]).inverse();

        let mut agx = Self {
            working_to_rendering: (base_to_rendering * working_to_base).as_mat3(),
            rendering_to_working: (working_to_base.inverse() * rendering_to_base).as_mat3(),
            scene_grey: scene_grey as f32,
            black_ev: BLACK_EV as f32,
            range_ev: range_ev as f32,
            pivot_x: pivot_x as f32,
            pivot_y: pivot_y as f32,
            slope: slope as f32,
            toe_scale: -sigmoid_scale(pivot_x, pivot_y, slope, TOE_POWER) as f32,
            shoulder_scale: sigmoid_scale(1.0 - pivot_x, 1.0 - pivot_y, slope, SHOULDER_POWER)
                as f32,
            gamut_luma: GAMUT_LUMA.as_vec3(),
            linear_curve: Vec::new(),
            white_level: (scene_grey.log2() + WHITE_EV) as f32,
            hdr_max_x: ((HDR_WHITE_EV - BLACK_EV) / range_ev) as f32,
            hdr_knee_x: 1.0,
            hdr_knee_linear: 1.0,
        };
        agx.linear_curve = (0..CURVE_LUT_SIZE)
            .map(|i| {
                agx.curve(i as f32 / (CURVE_LUT_SIZE - 1) as f32)
                    .powf(GAMMA as f32)
            })
            .collect();
        let knee = scene_linear_knee(|scene| agx.linear_display(scene), MIDDLE_GREY as f32, 1.0);
        agx.hdr_knee_x = ((knee.scene / agx.scene_grey).log2() - agx.black_ev) / agx.range_ev;
        agx.hdr_knee_linear = knee.display;
        agx
    }

    fn curve(&self, x: f32) -> f32 {
        let (scale, power) = if x < self.pivot_x {
            (self.toe_scale, TOE_POWER as f32)
        } else {
            (self.shoulder_scale, SHOULDER_POWER as f32)
        };
        let curved =
            scale * scalar_sigmoid(self.slope * (x - self.pivot_x) / scale, power) + self.pivot_y;
        curved.clamp(0.0, 1.0)
    }

    fn linear_display(&self, scene: f32) -> f32 {
        let exposure = (scene / self.scene_grey).max(EPSILON).log2();
        let position = ((exposure - self.black_ev) / self.range_ev).clamp(0.0, 1.0)
            * (CURVE_LUT_SIZE - 1) as f32;
        let index = (position as usize).min(CURVE_LUT_SIZE - 2);
        let low = self.linear_curve[index];
        low + (self.linear_curve[index + 1] - low) * (position - index as f32)
    }

    fn compress_into_gamut(&self, rgb: Vec3) -> Vec3 {
        let opponent = rgb.max_element() - rgb;
        let target =
            opponent.max_element() - opponent.dot(self.gamut_luma) + rgb.dot(self.gamut_luma);
        let lifted = rgb + (-rgb.min_element()).max(0.0);
        let lifted_opponent = lifted.max_element() - lifted;
        let luminance = lifted_opponent.max_element() - lifted_opponent.dot(self.gamut_luma)
            + lifted.dot(self.gamut_luma);
        if luminance > target && luminance > EPSILON {
            lifted * (target / luminance)
        } else {
            lifted
        }
    }

    pub fn tonemap(&self, working: Vec3) -> Vec3 {
        let rendering = self.working_to_rendering * self.compress_into_gamut(working);
        let hue = rgb_to_hsv(rendering).x;
        let mut hsv = rgb_to_hsv(rendering.map(|c| self.linear_display(c)));
        let shift = hsv.x - hue;
        hsv.x = hue + (1.0 - HUE_PRESERVATION) * (shift - shift.round());
        let transfer = srgb_transfer();
        (self.rendering_to_working * hsv_to_rgb(hsv)).map(|c| transfer.encode(c.min(1.0)))
    }

    pub fn shader_constants(&self) -> String {
        let scalars = [
            ("AGX_EPSILON", EPSILON),
            ("AGX_SCENE_GREY", self.scene_grey),
            ("AGX_BLACK_EV", self.black_ev),
            ("AGX_RANGE_EV", self.range_ev),
            ("AGX_PIVOT_X", self.pivot_x),
            ("AGX_PIVOT_Y", self.pivot_y),
            ("AGX_SLOPE", self.slope),
            ("AGX_TOE_POWER", TOE_POWER as f32),
            ("AGX_TOE_SCALE", self.toe_scale),
            ("AGX_SHOULDER_POWER", SHOULDER_POWER as f32),
            ("AGX_SHOULDER_SCALE", self.shoulder_scale),
            ("AGX_GAMMA", GAMMA as f32),
            ("AGX_HUE_PRESERVATION", HUE_PRESERVATION),
            ("AGX_WHITE_LEVEL", self.white_level),
            ("AGX_HDR_MAX_X", self.hdr_max_x),
            ("AGX_HDR_KNEE_X", self.hdr_knee_x),
            ("AGX_HDR_KNEE_LINEAR", self.hdr_knee_linear),
        ];
        let mut constants: String = scalars
            .iter()
            .map(|(name, value)| format!("const {}: f32 = {:?};\n", name, value))
            .collect();
        constants.push_str(&format!(
            "const AGX_GAMUT_LUMA = {};\n\
             const AGX_WORKING_TO_RENDERING = {};\n\
             const AGX_RENDERING_TO_WORKING = {};\n",
            wgsl_vec3(self.gamut_luma),
            wgsl_mat3(self.working_to_rendering),
            wgsl_mat3(self.rendering_to_working),
        ));
        constants
    }
}

pub fn agx() -> &'static Agx {
    static AGX: LazyLock<Agx> = LazyLock::new(Agx::new);
    &AGX
}
