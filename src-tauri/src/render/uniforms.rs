use crate::decode::as_shot::AsShot;
use crate::decode::white_balance::{self, WhiteBalance};
use crate::masks::generation::MaskDefinition;
use crate::render::adjustment_utils::{effective_baseline_exposure, is_tool_active};
use crate::render::color_space::calculate_agx_matrices_glam;
use crate::render::options::RenderOptions;
use bytemuck::{Pod, Zeroable};
use glam::{Mat3, Vec2, Vec3};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct Point {
    x: f32,
    y: f32,
    _pad1: f32,
    _pad2: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct HslColor {
    hue: f32,
    saturation: f32,
    luminance: f32,
    _pad: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct ColorGradeSettings {
    pub tint_a: f32,
    pub tint_b: f32,
    pub luminance: f32,
    _pad: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct ColorCalibrationSettings {
    pub shadows_tint: f32,
    pub red_hue: f32,
    pub red_saturation: f32,
    pub green_hue: f32,
    pub green_saturation: f32,
    pub blue_hue: f32,
    pub blue_saturation: f32,
    _pad1: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct MonochromeSettings {
    pub enabled: u32,
    pub weight_r: f32,
    pub weight_g: f32,
    pub weight_b: f32,
    pub mix: [f32; 8],
    pub shadow_a: f32,
    pub shadow_b: f32,
    pub highlight_a: f32,
    pub highlight_b: f32,
    pub toning_balance: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct GpuMat3 {
    col0: [f32; 4],
    col1: [f32; 4],
    col2: [f32; 4],
}

impl Default for GpuMat3 {
    fn default() -> Self {
        Self {
            col0: [1.0, 0.0, 0.0, 0.0],
            col1: [0.0, 1.0, 0.0, 0.0],
            col2: [0.0, 0.0, 1.0, 0.0],
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct GlobalAdjustments {
    pub exposure: f32,
    pub brightness: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub saturation: f32,
    pub vibrance: f32,
    pub hue: f32,
    pub wb_log_gain_l: f32,
    pub wb_log_gain_m: f32,
    pub wb_log_gain_s: f32,
    pub centre_x: f32,
    pub centre_y: f32,

    pub sharpness: f32,
    pub luma_noise_reduction: f32,
    pub color_noise_reduction: f32,
    pub clarity: f32,
    pub dehaze: f32,
    pub structure: f32,
    pub centré: f32,
    pub vignette_amount: f32,
    pub vignette_midpoint: f32,
    pub vignette_roundness: f32,
    pub vignette_feather: f32,
    pub grain_amount: f32,
    pub grain_size: f32,
    pub grain_roughness: f32,

    pub chromatic_aberration_red_cyan: f32,
    pub chromatic_aberration_blue_yellow: f32,
    pub show_clipping: u32,
    pub is_raw_image: u32,
    pub grain_softness: f32,

    pub has_lut: u32,
    pub lut_intensity: f32,
    pub tonemapper_mode: u32,
    pub lut_is_scene_referred: u32,
    pub vignette_center_x: f32,
    pub vignette_center_y: f32,
    _pad_lut5: f32,

    _pad_agx1: f32,
    _pad_agx2: f32,
    _pad_agx3: f32,
    pub agx_pipe_to_rendering_matrix: GpuMat3,
    pub agx_rendering_to_pipe_matrix: GpuMat3,
    pub wb_rgb_to_lms_matrix: GpuMat3,
    pub wb_lms_to_rgb_matrix: GpuMat3,

    _pad_cg1: f32,
    _pad_cg2: f32,
    _pad_cg3: f32,
    _pad_cg4: f32,
    pub color_grading_shadows: ColorGradeSettings,
    pub color_grading_midtones: ColorGradeSettings,
    pub color_grading_highlights: ColorGradeSettings,
    pub color_grading_global: ColorGradeSettings,
    pub color_grading_blending: f32,
    pub color_grading_balance: f32,
    _pad2: f32,
    _pad3: f32,

    pub color_calibration: ColorCalibrationSettings,

    pub hsl: [HslColor; 8],
    pub luma_curve: [Point; 16],
    pub red_curve: [Point; 16],
    pub green_curve: [Point; 16],
    pub blue_curve: [Point; 16],
    pub luma_curve_count: u32,
    pub red_curve_count: u32,
    pub green_curve_count: u32,
    pub blue_curve_count: u32,
    _pad_end1: f32,
    _pad_end2: f32,
    _pad_end3: f32,
    _pad_end4: f32,

    pub glow_amount: f32,
    pub halation_amount: f32,
    pub flare_amount: f32,
    pub sharpness_threshold: f32,

    pub monochrome: MonochromeSettings,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct MaskAdjustments {
    pub exposure: f32,
    pub brightness: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub saturation: f32,
    pub vibrance: f32,

    pub sharpness: f32,
    pub luma_noise_reduction: f32,
    pub color_noise_reduction: f32,
    pub clarity: f32,
    pub dehaze: f32,
    pub structure: f32,

    pub glow_amount: f32,
    pub halation_amount: f32,
    pub flare_amount: f32,
    pub sharpness_threshold: f32,

    pub hue: f32,
    pub wb_log_gain_l: f32,
    pub wb_log_gain_m: f32,
    pub wb_log_gain_s: f32,
    _pad_wb: f32,
    pub color_grading_shadows: ColorGradeSettings,
    pub color_grading_midtones: ColorGradeSettings,
    pub color_grading_highlights: ColorGradeSettings,
    pub color_grading_global: ColorGradeSettings,
    pub color_grading_blending: f32,
    pub color_grading_balance: f32,
    _pad5: f32,
    _pad6: f32,

    pub hsl: [HslColor; 8],
    pub luma_curve: [Point; 16],
    pub red_curve: [Point; 16],
    pub green_curve: [Point; 16],
    pub blue_curve: [Point; 16],
    pub luma_curve_count: u32,
    pub red_curve_count: u32,
    pub green_curve_count: u32,
    pub blue_curve_count: u32,
    _pad_end4: f32,
    _pad_end5: f32,
    _pad_end6: f32,
    _pad_end7: f32,
}

pub const MAX_MASKS: usize = 32;

#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct AllAdjustments {
    pub global: GlobalAdjustments,
    pub mask_adjustments: [MaskAdjustments; MAX_MASKS],
    pub mask_count: u32,
    pub tile_offset_x: u32,
    pub tile_offset_y: u32,
    pub mask_atlas_cols: u32,
}

struct AdjustmentScales {
    exposure: f32,
    brightness: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,

    sharpness: f32,
    sharpness_threshold: f32,
    luma_noise_reduction: f32,
    color_noise_reduction: f32,
    clarity: f32,
    dehaze: f32,
    structure: f32,
    centré: f32,

    vignette_amount: f32,
    vignette_midpoint: f32,
    vignette_roundness: f32,
    vignette_feather: f32,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,

    chromatic_aberration: f32,

    hsl_hue_multiplier: f32,
    hsl_saturation: f32,
    hsl_luminance: f32,

    color_grading_saturation: f32,
    color_grading_luminance: f32,
    color_grading_blending: f32,
    color_grading_balance: f32,

    color_calibration_hue: f32,
    color_calibration_saturation: f32,

    monochrome_mix: f32,
    monochrome_toning_saturation: f32,

    glow: f32,
    halation: f32,
    flares: f32,
}

const SCALES: AdjustmentScales = AdjustmentScales {
    exposure: 0.8,
    brightness: 0.8,
    contrast: 100.0,
    highlights: 120.0,
    shadows: 120.0,
    whites: 40.0,
    blacks: 40.0,
    saturation: 100.0,
    vibrance: 100.0,

    sharpness: 50.0,
    sharpness_threshold: 100.0,
    luma_noise_reduction: 100.0,
    color_noise_reduction: 100.0,
    clarity: 125.0,
    dehaze: 100.0,
    structure: 125.0,
    centré: 250.0,

    vignette_amount: 100.0,
    vignette_midpoint: 100.0,
    vignette_roundness: 100.0,
    vignette_feather: 100.0,
    grain_amount: 250.0,
    grain_size: 60.0,
    grain_roughness: 100.0,

    chromatic_aberration: 10000.0,

    hsl_hue_multiplier: 0.3,
    hsl_saturation: 100.0,
    hsl_luminance: 100.0,

    color_grading_saturation: 1000.0,
    color_grading_luminance: 1000.0,
    color_grading_blending: 100.0,
    color_grading_balance: 200.0,

    color_calibration_hue: 400.0,
    color_calibration_saturation: 120.0,

    monochrome_mix: 100.0,
    monochrome_toning_saturation: 800.0,

    glow: 100.0,
    halation: 100.0,
    flares: 100.0,
};

fn parse_hsl_adjustments(js_hsl: &serde_json::Value) -> [HslColor; 8] {
    let mut hsl_array = [HslColor::default(); 8];
    if let Some(hsl_map) = js_hsl.as_object() {
        let color_map = [
            ("reds", 0),
            ("oranges", 1),
            ("yellows", 2),
            ("greens", 3),
            ("aquas", 4),
            ("blues", 5),
            ("purples", 6),
            ("magentas", 7),
        ];
        for (name, index) in color_map.iter() {
            if let Some(color_data) = hsl_map.get(*name) {
                hsl_array[*index] = HslColor {
                    hue: color_data["hue"].as_f64().unwrap_or(0.0) as f32
                        * SCALES.hsl_hue_multiplier,
                    saturation: color_data["saturation"].as_f64().unwrap_or(0.0) as f32
                        / SCALES.hsl_saturation,
                    luminance: color_data["luminance"].as_f64().unwrap_or(0.0) as f32
                        / SCALES.hsl_luminance,
                    _pad: 0.0,
                };
            }
        }
    }
    hsl_array
}

fn parse_color_grade_settings(js_cg: &serde_json::Value) -> ColorGradeSettings {
    if js_cg.is_null() {
        return ColorGradeSettings::default();
    }
    let saturation = (js_cg["saturation"].as_f64().unwrap_or(0.0) as f32).clamp(0.0, 100.0);
    let tint = oklab_hue_direction(js_cg["hue"].as_f64().unwrap_or(0.0) as f32)
        * (saturation / SCALES.color_grading_saturation);
    ColorGradeSettings {
        tint_a: tint.x,
        tint_b: tint.y,
        luminance: js_cg["luminance"].as_f64().unwrap_or(0.0) as f32
            / SCALES.color_grading_luminance,
        _pad: 0.0,
    }
}

fn hue_to_linear_srgb(hue_degrees: f32) -> Vec3 {
    let h = hue_degrees.rem_euclid(360.0) / 60.0;
    let x = 1.0 - ((h % 2.0) - 1.0).abs();
    let srgb = match h as u32 {
        0 => Vec3::new(1.0, x, 0.0),
        1 => Vec3::new(x, 1.0, 0.0),
        2 => Vec3::new(0.0, 1.0, x),
        3 => Vec3::new(0.0, x, 1.0),
        4 => Vec3::new(x, 0.0, 1.0),
        _ => Vec3::new(1.0, 0.0, x),
    };
    srgb.map(|c| {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    })
}

fn oklab_hue_direction(hue_degrees: f32) -> Vec2 {
    let rgb = hue_to_linear_srgb(hue_degrees);
    let l = (0.412_221_47 * rgb.x + 0.536_332_55 * rgb.y + 0.051_445_995 * rgb.z).cbrt();
    let m = (0.211_903_5 * rgb.x + 0.680_699_5 * rgb.y + 0.107_396_96 * rgb.z).cbrt();
    let s = (0.088_302_46 * rgb.x + 0.281_718_85 * rgb.y + 0.629_978_7 * rgb.z).cbrt();
    let ab = Vec2::new(
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    );
    ab.normalize_or_zero()
}

fn monochrome_film_response(film: &str) -> (Vec3, [f32; 8]) {
    match film {
        "panchromatic" => (Vec3::new(0.19, 0.36, 0.45), [0.0; 8]),
        "balanced" => (Vec3::new(0.33, 0.36, 0.31), [0.0; 8]),
        "orthoPanchromatic" => (Vec3::new(0.237, 0.418, 0.345), [0.0; 8]),
        "extendedRed" => (Vec3::new(0.45, 0.35, 0.20), [0.0; 8]),
        "orthochromatic" => (Vec3::new(0.0, 0.4, 0.6), [0.0; 8]),
        "infrared" => (
            Vec3::new(0.45, 0.55, 0.0),
            [0.3, 0.3, 0.6, 1.0, -0.5, -1.0, -0.3, 0.2],
        ),
        _ => (Vec3::new(0.2126, 0.7152, 0.0722), [0.0; 8]),
    }
}

fn parse_monochrome_settings(
    js_adjustments: &serde_json::Value,
    mix_visible: bool,
    toning_visible: bool,
) -> MonochromeSettings {
    let get = |value: &serde_json::Value, default: f64| value.as_f64().unwrap_or(default) as f32;

    let filter_strength =
        (get(&js_adjustments["monochromeFilterStrength"], 0.0) / 100.0).clamp(0.0, 1.0);
    let filter = Vec3::ONE.lerp(
        hue_to_linear_srgb(get(&js_adjustments["monochromeFilterHue"], 0.0)),
        filter_strength,
    );
    let (film, mut mix) =
        monochrome_film_response(js_adjustments["monochromeFilm"].as_str().unwrap_or(""));
    let filtered = (film * filter).max(Vec3::ZERO);
    let filtered_sum = filtered.x + filtered.y + filtered.z;
    let weights = if filtered_sum > 1e-4 {
        filtered / filtered_sum
    } else {
        film
    };

    if mix_visible {
        let js_mix = &js_adjustments["monochromeMix"];
        for (index, name) in [
            "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
        ]
        .iter()
        .enumerate()
        {
            mix[index] =
                (mix[index] + get(&js_mix[*name], 0.0) / SCALES.monochrome_mix).clamp(-1.0, 1.0);
        }
    }

    let js_toning = &js_adjustments["monochromeToning"];
    let toning = |hue_key: &str, saturation_key: &str| {
        if !toning_visible {
            return Vec2::ZERO;
        }
        let saturation = get(&js_toning[saturation_key], 0.0).clamp(0.0, 100.0);
        oklab_hue_direction(get(&js_toning[hue_key], 0.0))
            * (saturation / SCALES.monochrome_toning_saturation)
    };
    let shadow = toning("shadowHue", "shadowSaturation");
    let highlight = toning("highlightHue", "highlightSaturation");

    MonochromeSettings {
        enabled: 1,
        weight_r: weights.x,
        weight_g: weights.y,
        weight_b: weights.z,
        mix,
        shadow_a: shadow.x,
        shadow_b: shadow.y,
        highlight_a: highlight.x,
        highlight_b: highlight.y,
        toning_balance: if toning_visible {
            get(&js_toning["balance"], 0.0) / 100.0
        } else {
            0.0
        },
        _pad1: 0.0,
        _pad2: 0.0,
        _pad3: 0.0,
    }
}

fn convert_points_to_aligned(frontend_points: Vec<serde_json::Value>) -> [Point; 16] {
    let mut aligned_points = [Point::default(); 16];
    for (i, point) in frontend_points.iter().enumerate().take(16) {
        if let (Some(x), Some(y)) = (point["x"].as_f64(), point["y"].as_f64()) {
            aligned_points[i] = Point {
                x: x as f32,
                y: y as f32,
                _pad1: 0.0,
                _pad2: 0.0,
            };
        }
    }
    aligned_points
}

fn mat3_to_gpu_mat3(m: Mat3) -> GpuMat3 {
    GpuMat3 {
        col0: [m.x_axis.x, m.x_axis.y, m.x_axis.z, 0.0],
        col1: [m.y_axis.x, m.y_axis.y, m.y_axis.z, 0.0],
        col2: [m.z_axis.x, m.z_axis.y, m.z_axis.z, 0.0],
    }
}

fn calculate_agx_matrices() -> (GpuMat3, GpuMat3) {
    let (pipe_to_rendering, rendering_to_pipe) = calculate_agx_matrices_glam();
    (
        mat3_to_gpu_mat3(pipe_to_rendering),
        mat3_to_gpu_mat3(rendering_to_pipe),
    )
}

fn get_global_adjustments_from_json(
    js_adjustments: &serde_json::Value,
    is_raw: bool,
    white_balance_gains: [f32; 3],
    baseline_exposure: f32,
    tonemapper_override: Option<u32>,
) -> GlobalAdjustments {
    let is_visible = |tool: &str| is_tool_active(js_adjustments, tool);

    let get_val = |tool: &str, key: &str, scale: f32, default: Option<f64>| -> f32 {
        if is_visible(tool) {
            js_adjustments[key]
                .as_f64()
                .unwrap_or(default.unwrap_or(0.0)) as f32
                / scale
        } else {
            if let Some(d) = default {
                d as f32 / scale
            } else {
                0.0
            }
        }
    };

    let default_curve = serde_json::json!([{"x": 0.0, "y": 0.0}, {"x": 255.0, "y": 255.0}]);
    let curves_obj = js_adjustments.get("curves").cloned().unwrap_or_default();

    let luma_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj
            .get("luma")
            .unwrap_or(&default_curve)
            .as_array()
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let red_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj
            .get("red")
            .unwrap_or(&default_curve)
            .as_array()
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let green_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj
            .get("green")
            .unwrap_or(&default_curve)
            .as_array()
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let blue_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj
            .get("blue")
            .unwrap_or(&default_curve)
            .as_array()
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let is_monochrome = js_adjustments["monochromeEnabled"]
        .as_bool()
        .unwrap_or(false)
        && is_visible("colorPresence");
    let color_grading_visible = is_visible("colorGrading") && !is_monochrome;
    let color_mixer_visible = is_visible("colorMixer") && !is_monochrome;

    let cg_obj = js_adjustments
        .get("colorGrading")
        .cloned()
        .unwrap_or_default();

    let cal_obj = js_adjustments
        .get("colorCalibration")
        .cloned()
        .unwrap_or_default();

    let color_cal_settings = if is_visible("colorCalibration") && !is_monochrome {
        ColorCalibrationSettings {
            shadows_tint: cal_obj["shadowsTint"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_hue,
            red_hue: cal_obj["redHue"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_hue,
            red_saturation: cal_obj["redSaturation"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_saturation,
            green_hue: cal_obj["greenHue"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_hue,
            green_saturation: cal_obj["greenSaturation"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_saturation,
            blue_hue: cal_obj["blueHue"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_hue,
            blue_saturation: cal_obj["blueSaturation"].as_f64().unwrap_or(0.0) as f32
                / SCALES.color_calibration_saturation,
            _pad1: 0.0,
        }
    } else {
        ColorCalibrationSettings::default()
    };

    let tone_mapper = js_adjustments["toneMapper"].as_str().unwrap_or("basic");
    let (pipe_to_rendering, rendering_to_pipe) = calculate_agx_matrices();
    let rgb_to_lms = white_balance::rgb_to_lms();

    let (has_lut, lut_intensity, lut_is_scene_referred) = if is_visible("lut") {
        (
            if js_adjustments["lutPath"].is_string() {
                1
            } else {
                0
            },
            js_adjustments["lutIntensity"].as_f64().unwrap_or(100.0) as f32 / 100.0,
            if js_adjustments["lutIsSceneReferred"]
                .as_bool()
                .unwrap_or(false)
            {
                1
            } else {
                0
            },
        )
    } else {
        (0, 1.0, 0)
    };

    let grain_amount = get_val("grain", "grainAmount", SCALES.grain_amount, None);
    let grain_size = 0.243 * get_val("grain", "grainSize", SCALES.grain_size, Some(25.0)).exp2();

    GlobalAdjustments {
        exposure: get_val("basic", "exposure", SCALES.exposure, None) + baseline_exposure,
        brightness: get_val("basic", "brightness", SCALES.brightness, None),
        contrast: get_val("basic", "contrast", SCALES.contrast, None),
        highlights: get_val("basic", "highlights", SCALES.highlights, None),
        shadows: get_val("basic", "shadows", SCALES.shadows, None),
        whites: get_val("basic", "whites", SCALES.whites, None),
        blacks: get_val("basic", "blacks", SCALES.blacks, None),

        saturation: if is_monochrome {
            0.0
        } else {
            get_val("colorPresence", "saturation", SCALES.saturation, None)
        },
        vibrance: if is_monochrome {
            0.0
        } else {
            get_val("colorPresence", "vibrance", SCALES.vibrance, None)
        },
        hue: if is_monochrome {
            0.0
        } else {
            get_val("hue", "hue", 1.0, None)
        },
        wb_log_gain_l: white_balance_gains[0],
        wb_log_gain_m: white_balance_gains[1],
        wb_log_gain_s: white_balance_gains[2],
        centre_x: get_val("presence", "centréX", 1.0, Some(0.5)),
        centre_y: get_val("presence", "centréY", 1.0, Some(0.5)),

        sharpness: get_val("sharpening", "sharpness", SCALES.sharpness, None),
        luma_noise_reduction: get_val(
            "noiseReduction",
            "lumaNoiseReduction",
            SCALES.luma_noise_reduction,
            None,
        ),
        color_noise_reduction: get_val(
            "noiseReduction",
            "colorNoiseReduction",
            SCALES.color_noise_reduction,
            None,
        ),

        clarity: get_val("presence", "clarity", SCALES.clarity, None),
        dehaze: get_val("presence", "dehaze", SCALES.dehaze, None),
        structure: get_val("presence", "structure", SCALES.structure, None),
        centré: get_val("presence", "centré", SCALES.centré, None),
        vignette_amount: get_val("vignette", "vignetteAmount", SCALES.vignette_amount, None),
        vignette_midpoint: get_val(
            "vignette",
            "vignetteMidpoint",
            SCALES.vignette_midpoint,
            Some(50.0),
        ),
        vignette_roundness: get_val(
            "vignette",
            "vignetteRoundness",
            SCALES.vignette_roundness,
            Some(0.0),
        ),
        vignette_feather: get_val(
            "vignette",
            "vignetteFeather",
            SCALES.vignette_feather,
            Some(50.0),
        ),
        grain_amount,
        grain_size,
        grain_roughness: get_val(
            "grain",
            "grainRoughness",
            SCALES.grain_roughness,
            Some(50.0),
        ),

        chromatic_aberration_red_cyan: get_val(
            "chromaticAberration",
            "chromaticAberrationRedCyan",
            SCALES.chromatic_aberration,
            None,
        ),
        chromatic_aberration_blue_yellow: get_val(
            "chromaticAberration",
            "chromaticAberrationBlueYellow",
            SCALES.chromatic_aberration,
            None,
        ),
        show_clipping: if js_adjustments["showClipping"].as_bool().unwrap_or(false) {
            1
        } else {
            0
        },
        is_raw_image: if is_raw { 1 } else { 0 },
        grain_softness: (grain_amount * 3.75).min(1.0) * grain_size.min(1.0) * 0.75,

        has_lut,
        lut_intensity,

        tonemapper_mode: tonemapper_override
            .unwrap_or_else(|| if tone_mapper == "agx" { 1 } else { 0 }),
        lut_is_scene_referred,
        vignette_center_x: get_val("vignette", "vignetteCenterX", 1.0, Some(0.5)),
        vignette_center_y: get_val("vignette", "vignetteCenterY", 1.0, Some(0.5)),
        _pad_lut5: 0.0,

        _pad_agx1: 0.0,
        _pad_agx2: 0.0,
        _pad_agx3: 0.0,
        agx_pipe_to_rendering_matrix: pipe_to_rendering,
        agx_rendering_to_pipe_matrix: rendering_to_pipe,
        wb_rgb_to_lms_matrix: mat3_to_gpu_mat3(rgb_to_lms),
        wb_lms_to_rgb_matrix: mat3_to_gpu_mat3(rgb_to_lms.inverse()),

        _pad_cg1: 0.0,
        _pad_cg2: 0.0,
        _pad_cg3: 0.0,
        _pad_cg4: 0.0,
        color_grading_shadows: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["shadows"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_midtones: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["midtones"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_highlights: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["highlights"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_global: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["global"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_blending: if color_grading_visible {
            cg_obj["blending"].as_f64().unwrap_or(50.0) as f32 / SCALES.color_grading_blending
        } else {
            0.5
        },
        color_grading_balance: if color_grading_visible {
            cg_obj["balance"].as_f64().unwrap_or(0.0) as f32 / SCALES.color_grading_balance
        } else {
            0.0
        },
        _pad2: 0.0,
        _pad3: 0.0,

        color_calibration: color_cal_settings,

        hsl: if color_mixer_visible {
            parse_hsl_adjustments(&js_adjustments.get("hsl").cloned().unwrap_or_default())
        } else {
            [HslColor::default(); 8]
        },
        luma_curve: convert_points_to_aligned(luma_points.clone()),
        red_curve: convert_points_to_aligned(red_points.clone()),
        green_curve: convert_points_to_aligned(green_points.clone()),
        blue_curve: convert_points_to_aligned(blue_points.clone()),
        luma_curve_count: luma_points.len() as u32,
        red_curve_count: red_points.len() as u32,
        green_curve_count: green_points.len() as u32,
        blue_curve_count: blue_points.len() as u32,
        _pad_end1: 0.0,
        _pad_end2: 0.0,
        _pad_end3: 0.0,
        _pad_end4: 0.0,

        glow_amount: get_val("creative", "glowAmount", SCALES.glow, None),
        halation_amount: get_val("creative", "halationAmount", SCALES.halation, None),
        flare_amount: get_val("creative", "flareAmount", SCALES.flares, None),
        sharpness_threshold: get_val(
            "sharpening",
            "sharpnessThreshold",
            SCALES.sharpness_threshold,
            Some(15.0),
        ),

        monochrome: if is_monochrome {
            parse_monochrome_settings(
                js_adjustments,
                is_visible("colorMixer"),
                is_visible("colorGrading"),
            )
        } else {
            MonochromeSettings::default()
        },
    }
}

fn get_mask_adjustments_from_json(
    adj: &serde_json::Value,
    global_white_balance: WhiteBalance,
) -> MaskAdjustments {
    if adj.is_null() {
        return MaskAdjustments::default();
    }

    let is_visible = |tool: &str| is_tool_active(adj, tool);

    let get_val = |tool: &str, key: &str, scale: f32| -> f32 {
        if is_visible(tool) {
            adj[key].as_f64().unwrap_or(0.0) as f32 / scale
        } else {
            0.0
        }
    };

    let curves_obj = adj.get("curves").cloned().unwrap_or_default();
    let luma_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj["luma"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let red_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj["red"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let green_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj["green"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let blue_points: Vec<serde_json::Value> = if is_visible("curves") {
        curves_obj["blue"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let color_grading_visible = is_visible("colorGrading");
    let color_mixer_visible = is_visible("colorMixer");

    let cg_obj = adj.get("colorGrading").cloned().unwrap_or_default();
    let [wb_log_gain_l, wb_log_gain_m, wb_log_gain_s] = if is_visible("whiteBalance") {
        white_balance::adaptation_log_gains(
            global_white_balance,
            global_white_balance.shifted(
                adj["temperature"].as_f64().unwrap_or(0.0),
                adj["tint"].as_f64().unwrap_or(0.0),
            ),
        )
    } else {
        [0.0; 3]
    };

    MaskAdjustments {
        exposure: get_val("basic", "exposure", SCALES.exposure),
        brightness: get_val("basic", "brightness", SCALES.brightness),
        contrast: get_val("basic", "contrast", SCALES.contrast),
        highlights: get_val("basic", "highlights", SCALES.highlights),
        shadows: get_val("basic", "shadows", SCALES.shadows),
        whites: get_val("basic", "whites", SCALES.whites),
        blacks: get_val("basic", "blacks", SCALES.blacks),

        saturation: get_val("colorPresence", "saturation", SCALES.saturation),
        vibrance: get_val("colorPresence", "vibrance", SCALES.vibrance),

        sharpness: get_val("sharpening", "sharpness", SCALES.sharpness),
        luma_noise_reduction: get_val(
            "noiseReduction",
            "lumaNoiseReduction",
            SCALES.luma_noise_reduction,
        ),
        color_noise_reduction: get_val(
            "noiseReduction",
            "colorNoiseReduction",
            SCALES.color_noise_reduction,
        ),

        clarity: get_val("presence", "clarity", SCALES.clarity),
        dehaze: get_val("presence", "dehaze", SCALES.dehaze),
        structure: get_val("presence", "structure", SCALES.structure),

        glow_amount: get_val("creative", "glowAmount", SCALES.glow),
        halation_amount: get_val("creative", "halationAmount", SCALES.halation),
        flare_amount: get_val("creative", "flareAmount", SCALES.flares),
        sharpness_threshold: get_val(
            "sharpening",
            "sharpnessThreshold",
            SCALES.sharpness_threshold,
        ),

        hue: get_val("hue", "hue", 1.0),
        wb_log_gain_l,
        wb_log_gain_m,
        wb_log_gain_s,
        _pad_wb: 0.0,
        color_grading_shadows: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["shadows"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_midtones: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["midtones"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_highlights: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["highlights"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_global: if color_grading_visible {
            parse_color_grade_settings(&cg_obj["global"])
        } else {
            ColorGradeSettings::default()
        },
        color_grading_blending: if color_grading_visible {
            cg_obj["blending"].as_f64().unwrap_or(50.0) as f32 / SCALES.color_grading_blending
        } else {
            0.5
        },
        color_grading_balance: if color_grading_visible {
            cg_obj["balance"].as_f64().unwrap_or(0.0) as f32 / SCALES.color_grading_balance
        } else {
            0.0
        },
        _pad5: 0.0,
        _pad6: 0.0,

        hsl: if color_mixer_visible {
            parse_hsl_adjustments(&adj.get("hsl").cloned().unwrap_or_default())
        } else {
            [HslColor::default(); 8]
        },
        luma_curve: convert_points_to_aligned(luma_points.clone()),
        red_curve: convert_points_to_aligned(red_points.clone()),
        green_curve: convert_points_to_aligned(green_points.clone()),
        blue_curve: convert_points_to_aligned(blue_points.clone()),
        luma_curve_count: luma_points.len() as u32,
        red_curve_count: red_points.len() as u32,
        green_curve_count: green_points.len() as u32,
        blue_curve_count: blue_points.len() as u32,
        _pad_end4: 0.0,
        _pad_end5: 0.0,
        _pad_end6: 0.0,
        _pad_end7: 0.0,
    }
}

pub fn get_all_adjustments_from_json(
    js_adjustments: &serde_json::Value,
    is_raw: bool,
    as_shot: AsShot,
    render: RenderOptions,
) -> AllAdjustments {
    let (is_raw, as_shot, render) =
        if crate::adjustments::negative_conversion::is_enabled(js_adjustments) {
            let exposure = AsShot::reference().exposure;
            let tonemapper_override = render.non_raw_tonemapper_override;
            (
                false,
                AsShot {
                    exposure,
                    ..as_shot
                },
                RenderOptions {
                    tonemapper_override,
                    ..render
                },
            )
        } else {
            (is_raw, as_shot, render)
        };
    let target_white_balance = if is_tool_active(js_adjustments, "whiteBalance") {
        white_balance::from_adjustments(js_adjustments, as_shot.white_balance)
    } else {
        as_shot.white_balance
    };
    let global = get_global_adjustments_from_json(
        js_adjustments,
        is_raw,
        white_balance::adaptation_log_gains(as_shot.white_balance, target_white_balance),
        effective_baseline_exposure(js_adjustments, as_shot, render.baseline),
        render.tonemapper_override,
    );
    let mut mask_adjustments = [MaskAdjustments::default(); MAX_MASKS];
    let mut mask_count = 0;

    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    for (i, mask_def) in mask_definitions
        .iter()
        .filter(|m| m.visible && !m.sub_masks.is_empty())
        .enumerate()
        .take(MAX_MASKS)
    {
        mask_adjustments[i] =
            get_mask_adjustments_from_json(&mask_def.adjustments, target_white_balance);
        mask_count += 1;
    }

    AllAdjustments {
        global,
        mask_adjustments,
        mask_count,
        tile_offset_x: 0,
        tile_offset_y: 0,
        mask_atlas_cols: 1,
    }
}
