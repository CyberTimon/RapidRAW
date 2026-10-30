struct Point {
    x: f32,
    y: f32,
    _pad1: f32,
    _pad2: f32,
}

struct HslColor {
    hue: f32,
    saturation: f32,
    luminance: f32,
    _pad: f32,
}

struct ColorGradeSettings {
    hue: f32,
    saturation: f32,
    luminance: f32,
    _pad: f32,
}

struct ColorCalibrationSettings {
    shadows_tint: f32,
    red_hue: f32,
    red_saturation: f32,
    green_hue: f32,
    green_saturation: f32,
    blue_hue: f32,
    blue_saturation: f32,
    _pad1: f32,
}

struct MonochromeSettings {
    enabled: u32,
    weight_r: f32,
    weight_g: f32,
    weight_b: f32,
    mix: array<f32, 8>,
    shadow_a: f32,
    shadow_b: f32,
    highlight_a: f32,
    highlight_b: f32,
    toning_balance: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
}

struct GlobalAdjustments {
    exposure: f32,
    brightness: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    hue: f32,
    wb_log_gain_l: f32,
    wb_log_gain_m: f32,
    wb_log_gain_s: f32,
    centre_x: f32,
    centre_y: f32,

    sharpness: f32,
    luma_noise_reduction: f32,
    color_noise_reduction: f32,
    clarity: f32,
    dehaze: f32,
    structure: f32,
    centre: f32,
    vignette_amount: f32,
    vignette_midpoint: f32,
    vignette_roundness: f32,
    vignette_feather: f32,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,

    chromatic_aberration_red_cyan: f32,
    chromatic_aberration_blue_yellow: f32,
    show_clipping: u32,
    is_raw_image: u32,
    _pad_ca1: f32,

    has_lut: u32,
    lut_intensity: f32,
    tonemapper_mode: u32,
    lut_is_scene_referred: u32,
    vignette_center_x: f32,
    vignette_center_y: f32,
    _pad_lut5: f32,

    _pad_agx1: f32,
    _pad_agx2: f32,
    _pad_agx3: f32,
    agx_pipe_to_rendering_matrix: mat3x3<f32>,
    agx_rendering_to_pipe_matrix: mat3x3<f32>,
    wb_rgb_to_lms_matrix: mat3x3<f32>,
    wb_lms_to_rgb_matrix: mat3x3<f32>,

    _pad_cg1: f32,
    _pad_cg2: f32,
    _pad_cg3: f32,
    _pad_cg4: f32,
    color_grading_shadows: ColorGradeSettings,
    color_grading_midtones: ColorGradeSettings,
    color_grading_highlights: ColorGradeSettings,
    color_grading_global: ColorGradeSettings,
    color_grading_blending: f32,
    color_grading_balance: f32,
    _pad2: f32,
    _pad3: f32,

    color_calibration: ColorCalibrationSettings,

    hsl: array<HslColor, 8>,
    luma_curve: array<Point, 16>,
    red_curve: array<Point, 16>,
    green_curve: array<Point, 16>,
    blue_curve: array<Point, 16>,
    luma_curve_count: u32,
    red_curve_count: u32,
    green_curve_count: u32,
    blue_curve_count: u32,
    _pad_end1: f32,
    _pad_end2: f32,
    _pad_end3: f32,
    _pad_end4: f32,

    glow_amount: f32,
    halation_amount: f32,
    flare_amount: f32,
    sharpness_threshold: f32,

    monochrome: MonochromeSettings,
}

struct MaskAdjustments {
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
    luma_noise_reduction: f32,
    color_noise_reduction: f32,
    clarity: f32,
    dehaze: f32,
    structure: f32,

    glow_amount: f32,
    halation_amount: f32,
    flare_amount: f32,
    sharpness_threshold: f32,

    hue: f32,
    wb_log_gain_l: f32,
    wb_log_gain_m: f32,
    wb_log_gain_s: f32,
    _pad_wb: f32,
    color_grading_shadows: ColorGradeSettings,
    color_grading_midtones: ColorGradeSettings,
    color_grading_highlights: ColorGradeSettings,
    color_grading_global: ColorGradeSettings,
    color_grading_blending: f32,
    color_grading_balance: f32,
    _pad5: f32,
    _pad6: f32,

    hsl: array<HslColor, 8>,
    luma_curve: array<Point, 16>,
    red_curve: array<Point, 16>,
    green_curve: array<Point, 16>,
    blue_curve: array<Point, 16>,
    luma_curve_count: u32,
    red_curve_count: u32,
    green_curve_count: u32,
    blue_curve_count: u32,
    _pad_end4: f32,
    _pad_end5: f32,
    _pad_end6: f32,
    _pad_end7: f32,
}

struct AllAdjustments {
    global: GlobalAdjustments,
    mask_adjustments: array<MaskAdjustments, 32>,
    mask_count: u32,
    tile_offset_x: u32,
    tile_offset_y: u32,
    mask_atlas_cols: u32,
}

struct HslRange {
    center: f32,
    width: f32,
}

const HSL_RANGES: array<HslRange, 8> = array<HslRange, 8>(
    HslRange(358.0, 35.0),  // Red
    HslRange(25.0, 45.0),   // Orange
    HslRange(60.0, 40.0),   // Yellow
    HslRange(115.0, 90.0),  // Green
    HslRange(180.0, 60.0),  // Aqua
    HslRange(225.0, 60.0),  // Blue
    HslRange(280.0, 55.0),  // Purple
    HslRange(330.0, 50.0)   // Magenta
);

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var output_texture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read> adjustments: AllAdjustments;

@group(0) @binding(3) var mask_textures: texture_2d_array<f32>;

@group(0) @binding(4) var lut_texture: texture_3d<f32>;
@group(0) @binding(5) var lut_sampler: sampler;

@group(0) @binding(6) var sharpness_blur_texture: texture_2d<f32>;
@group(0) @binding(7) var tonal_blur_texture: texture_2d<f32>;
@group(0) @binding(8) var clarity_blur_texture: texture_2d<f32>;
@group(0) @binding(9) var structure_blur_texture: texture_2d<f32>;

@group(0) @binding(10) var flare_texture: texture_2d<f32>;
@group(0) @binding(11) var flare_sampler: sampler;

@group(0) @binding(12) var gf_coeffs_texture: texture_2d<f32>;
@group(0) @binding(13) var gf_structure_texture: texture_2d<f32>;
@group(0) @binding(14) var haze_texture: texture_2d<f32>;
@group(0) @binding(15) var airlight_texture: texture_2d<f32>;

const GF_LUMA_FLOOR: f32 = 1.0e-4;
const GF_DETAIL_SIGMA: f32 = 1.5;
const GF_REINJECT_SIGMA: f32 = 0.8;
const HZ_OMEGA: f32 = 0.95;
const HZ_FLOOR: f32 = 0.35;
const HZ_KNEE: f32 = 0.1;
const HZ_T_MIN: f32 = 0.1;
const HZ_TOLERANCE: f32 = 0.25;
const HZ_BRIGHT_LO: f32 = 0.8;
const HZ_BRIGHT_HI: f32 = 1.25;
const HZ_GUIDE_GAMMA: f32 = 0.4545;
const HZ_GUIDE_MAX: f32 = 1.5;
const HZ_MIST: f32 = 0.5;
const HZ_LIFT: f32 = 0.55;
const HZ_DETAIL_MAX: f32 = 2.5;
const HZ_DETAIL_SIGMA: f32 = 0.8;
const HZ_CHROMA_MAX: f32 = 1.45;
const HZ_CHROMA_FLOOR: f32 = 0.01;
const GF_CLARITY_GAIN: f32 = 1.8;
const GF_STRUCTURE_GAIN: f32 = 1.8;
const GF_NEG_GAIN: f32 = 1.0;
const GF_BRIGHT_SIGMA: f32 = 0.8;
const GF_NOISE_LO: f32 = 0.0;
const GF_NOISE_HI: f32 = 0.01;

override HIGH_PRECISION_OUTPUT: u32 = 0u;
override FEATURES: u32 = 0xFFFFFFFFu;

const F_NOISE_REDUCTION: u32 = 1u;
const F_HSL: u32 = 2u;
const F_MASKS: u32 = 4u;
const F_SHARPEN: u32 = 8u;
const F_DEHAZE: u32 = 16u;
const F_GLOW_HALATION_FLARE: u32 = 32u;
const F_GRAIN: u32 = 64u;
const F_VIGNETTE: u32 = 128u;
const F_LUT: u32 = 256u;
const F_CA: u32 = 512u;
const F_AGX: u32 = 1024u;
const F_MONOCHROME: u32 = 2048u;

fn has_feature(f: u32) -> bool {
    return (FEATURES & f) != 0u;
}

const LUMA_COEFF = vec3<f32>(0.2126, 0.7152, 0.0722);

fn get_luma(c: vec3<f32>) -> f32 {
    return dot(c, LUMA_COEFF);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let a = vec3<f32>(0.055);
    let higher = pow((c + a) / (1.0 + a), vec3<f32>(2.4));
    let lower = c / 12.92;
    return select(higher, lower, c <= cutoff);
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let c_clamped = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    let cutoff = vec3<f32>(0.0031308);
    let a = vec3<f32>(0.055);
    let higher = (1.0 + a) * pow(c_clamped, vec3<f32>(1.0 / 2.4)) - a;
    let lower = c_clamped * 12.92;
    return select(higher, lower, c_clamped <= cutoff);
}

fn linear_to_srgb_extended(c: vec3<f32>) -> vec3<f32> {
    let safe_c = max(c, vec3<f32>(0.0));
    let cutoff = vec3<f32>(0.0031308);
    let a = vec3<f32>(0.055);
    let higher = (1.0 + a) * pow(safe_c, vec3<f32>(1.0 / 2.4)) - a;
    let lower = safe_c * 12.92;
    return select(higher, lower, safe_c <= cutoff);
}

fn linear_to_vlog(c: vec3<f32>) -> vec3<f32> {
    let safe_c = max(c, vec3<f32>(0.0));
    let low = 5.6 * safe_c + 0.125;
    let log10_val = log2(safe_c + 0.00873) * 0.30102999566398;
    let high = 0.241514 * log10_val + 0.598206;
    return select(high, low, safe_c <= vec3<f32>(0.01));
}

fn rgb_to_hsv(c: vec3<f32>) -> vec3<f32> {
    let c_max = max(c.r, max(c.g, c.b));
    let c_min = min(c.r, min(c.g, c.b));
    let delta = c_max - c_min;
    var h: f32 = 0.0;
    if (delta > 0.0) {
        if (c_max == c.r) { h = 60.0 * (((c.g - c.b) / delta) % 6.0); }
        else if (c_max == c.g) { h = 60.0 * (((c.b - c.r) / delta) + 2.0); }
        else { h = 60.0 * (((c.r - c.g) / delta) + 4.0); }
    }
    if (h < 0.0) { h += 360.0; }
    let s = select(0.0, delta / c_max, c_max > 0.0);
    return vec3<f32>(h, s, c_max);
}

fn hsv_to_rgb(c: vec3<f32>) -> vec3<f32> {
    let h = c.x; let s = c.y; let v = c.z;
    let C = v * s;
    let X = C * (1.0 - abs((h / 60.0) % 2.0 - 1.0));
    let m = v - C;
    var rgb_prime: vec3<f32>;
    if (h < 60.0) { rgb_prime = vec3<f32>(C, X, 0.0); }
    else if (h < 120.0) { rgb_prime = vec3<f32>(X, C, 0.0); }
    else if (h < 180.0) { rgb_prime = vec3<f32>(0.0, C, X); }
    else if (h < 240.0) { rgb_prime = vec3<f32>(0.0, X, C); }
    else if (h < 300.0) { rgb_prime = vec3<f32>(X, 0.0, C); }
    else { rgb_prime = vec3<f32>(C, 0.0, X); }
    return rgb_prime + vec3<f32>(m, m, m);
}

fn apply_hue_shift(color: vec3<f32>, shift_degrees: f32) -> vec3<f32> {
    if (abs(shift_degrees) < 0.01) {
        return color;
    }
    let srgb_color = linear_to_srgb_extended(color);
    let hsv = rgb_to_hsv(srgb_color);
    var shifted_h = hsv.x + shift_degrees;
    shifted_h = (shifted_h + 360.0) % 360.0;
    let shifted_srgb = hsv_to_rgb(vec3<f32>(shifted_h, hsv.y, hsv.z));
    return srgb_to_linear(shifted_srgb);
}

fn get_raw_hsl_influence(hue: f32, center: f32, width: f32) -> f32 {
    let dist = min(abs(hue - center), 360.0 - abs(hue - center));
    const sharpness = 1.5;
    let falloff = dist / (width * 0.5);
    return exp(-sharpness * falloff * falloff);
}

fn hash(p: vec2<f32>) -> f32 {
    var p3  = fract(vec3<f32>(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn gradient_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    let ga = vec2<f32>(hash(i + vec2(0.0, 0.0)), hash(i + vec2(0.0, 0.0) + vec2(11.0, 37.0))) * 2.0 - 1.0;
    let gb = vec2<f32>(hash(i + vec2(1.0, 0.0)), hash(i + vec2(1.0, 0.0) + vec2(11.0, 37.0))) * 2.0 - 1.0;
    let gc = vec2<f32>(hash(i + vec2(0.0, 1.0)), hash(i + vec2(0.0, 1.0) + vec2(11.0, 37.0))) * 2.0 - 1.0;
    let gd = vec2<f32>(hash(i + vec2(1.0, 1.0)), hash(i + vec2(1.0, 1.0) + vec2(11.0, 37.0))) * 2.0 - 1.0;

    let dot_00 = dot(ga, f - vec2(0.0, 0.0));
    let dot_10 = dot(gb, f - vec2(1.0, 0.0));
    let dot_01 = dot(gc, f - vec2(0.0, 1.0));
    let dot_11 = dot(gd, f - vec2(1.0, 1.0));

    let bottom_interp = mix(dot_00, dot_10, u.x);
    let top_interp = mix(dot_01, dot_11, u.x);

    return mix(bottom_interp, top_interp, u.y);
}

fn dither(coords: vec2<u32>) -> f32 {
    let p = vec2<f32>(coords);
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
}

fn interpolate_cubic_hermite(x: f32, p1: Point, p2: Point, m1: f32, m2: f32) -> f32 {
    let dx = p2.x - p1.x;
    if (dx <= 0.0) { return p1.y; }
    let t = (x - p1.x) / dx;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    return h00 * p1.y + h10 * m1 * dx + h01 * p2.y + h11 * m2 * dx;
}

const CURVE_SRC_GLOBAL: u32 = 0xFFFFFFFFu;

fn curve_point(src: u32, ch: u32, i: u32) -> Point {
    if (src == CURVE_SRC_GLOBAL) {
        switch ch {
            case 0u: { return adjustments.global.luma_curve[i]; }
            case 1u: { return adjustments.global.red_curve[i]; }
            case 2u: { return adjustments.global.green_curve[i]; }
            default: { return adjustments.global.blue_curve[i]; }
        }
    }
    switch ch {
        case 0u: { return adjustments.mask_adjustments[src].luma_curve[i]; }
        case 1u: { return adjustments.mask_adjustments[src].red_curve[i]; }
        case 2u: { return adjustments.mask_adjustments[src].green_curve[i]; }
        default: { return adjustments.mask_adjustments[src].blue_curve[i]; }
    }
}

fn curve_count(src: u32, ch: u32) -> u32 {
    if (src == CURVE_SRC_GLOBAL) {
        switch ch {
            case 0u: { return adjustments.global.luma_curve_count; }
            case 1u: { return adjustments.global.red_curve_count; }
            case 2u: { return adjustments.global.green_curve_count; }
            default: { return adjustments.global.blue_curve_count; }
        }
    }
    switch ch {
        case 0u: { return adjustments.mask_adjustments[src].luma_curve_count; }
        case 1u: { return adjustments.mask_adjustments[src].red_curve_count; }
        case 2u: { return adjustments.mask_adjustments[src].green_curve_count; }
        default: { return adjustments.mask_adjustments[src].blue_curve_count; }
    }
}

fn apply_curve(val: f32, src: u32, ch: u32, count: u32) -> f32 {
    if (count < 2u) { return val; }
    let x = val * 255.0;
    let first = curve_point(src, ch, 0u);
    if (x <= first.x) { return first.y / 255.0; }
    let last = curve_point(src, ch, count - 1u);
    if (x >= last.x) { return last.y / 255.0; }
    for (var i = 0u; i < 15u; i = i + 1u) {
        if (i >= count - 1u) { break; }
        let p2 = curve_point(src, ch, i + 1u);
        if (x <= p2.x) {
            let p1 = curve_point(src, ch, i);
            let p0 = curve_point(src, ch, select(i - 1u, 0u, i == 0u));
            let p3 = curve_point(src, ch, min(count - 1u, i + 2u));
            let delta_before = (p1.y - p0.y) / max(0.001, p1.x - p0.x);
            let delta_current = (p2.y - p1.y) / max(0.001, p2.x - p1.x);
            let delta_after = (p3.y - p2.y) / max(0.001, p3.x - p2.x);
            var tangent_at_p1: f32;
            var tangent_at_p2: f32;
            if (i == 0u) { tangent_at_p1 = delta_current; } else {
                if (delta_before * delta_current <= 0.0) { tangent_at_p1 = 0.0; } else { tangent_at_p1 = (delta_before + delta_current) / 2.0; }
            }
            if (i + 1u == count - 1u) { tangent_at_p2 = delta_current; } else {
                if (delta_current * delta_after <= 0.0) { tangent_at_p2 = 0.0; } else { tangent_at_p2 = (delta_current + delta_after) / 2.0; }
            }
            if (delta_current != 0.0) {
                let alpha = tangent_at_p1 / delta_current;
                let beta = tangent_at_p2 / delta_current;
                if (alpha * alpha + beta * beta > 9.0) {
                    let tau = 3.0 / sqrt(alpha * alpha + beta * beta);
                    tangent_at_p1 = tangent_at_p1 * tau;
                    tangent_at_p2 = tangent_at_p2 * tau;
                }
            }
            let result_y = interpolate_cubic_hermite(x, p1, p2, tangent_at_p1, tangent_at_p2);
            return clamp(result_y / 255.0, 0.0, 1.0);
        }
    }
    return last.y / 255.0;
}

fn apply_tonal_adjustments(
    color: vec3<f32>,
    local_log_detail: f32,
    mid_log_detail: f32,
    is_raw: u32,
    con: f32,
    sh: f32,
    wh: f32,
    bl: f32
) -> vec3<f32> {
    var rgb = color;

    if (wh != 0.0) {
        let w_luma = max(get_luma(max(rgb, vec3<f32>(0.0))), 0.0001);
        let w_base = max(w_luma * exp2(-clamp(local_log_detail + mid_log_detail, -3.0, 3.0)), 0.0001);
        let t_w = pow(w_base, 0.4545);
        let w_pivot = 0.4;
        let u = max(t_w - w_pivot, 0.0);

        var t_new = t_w;
        if (wh > 0.0) {
            t_new = t_w + wh * 0.35 * (u * u) / (1.0 + u * u);
        } else if (u > 0.0) {
            t_new = w_pivot + u / (1.0 + (-wh) * 0.3 * u);
        }
        let w_ramp = smoothstep(0.1, 0.9, t_w);
        t_new = mix(t_w, t_new, w_ramp);

        let w_amount = abs(t_new - t_w) * w_ramp;
        rgb *= pow(t_new, 2.2) / w_base;

        let w_log_d = local_log_detail * 0.4545;
        let w_safe_detail = exp2(w_log_d / (1.0 + abs(w_log_d) * 0.4));
        let w_corr = pow(w_safe_detail, 1.0 + w_amount * 1.0) / w_safe_detail;
        rgb *= pow(w_corr, 2.2);
        rgb *= exp2(shape_detail(mid_log_detail, GF_REINJECT_SIGMA) * w_amount * 4.0);
    }

    let pixel_luma = get_luma(max(rgb, vec3<f32>(0.0)));

    let safe_pixel_luma = max(pixel_luma, 0.0001);

    if (sh != 0.0 || bl != 0.0) {
        let t_pixel = pow(safe_pixel_luma, 0.4545);
        let t_detail = exp2(local_log_detail * 0.4545);
        let t_blurred = t_pixel / max(t_detail, 0.0001);

        let shadow_lift = sh * t_pixel * pow(max(1.0 - t_pixel, 0.0), 4.5);
        let black_lift = bl * t_pixel * pow(max(1.0 - t_pixel, 0.0), 12.0);
        let lift_amount = max(shadow_lift + black_lift, 0.0);

        let t_pixel_curved = max(t_pixel + shadow_lift + black_lift, 0.0);

        let shadow_pivot = 0.2;
        let stretch_focus = 1.0 - smoothstep(0.1, 0.85, t_pixel);
        let detail_focus = 1.0 - smoothstep(0.05, 0.55, t_pixel);
        let stretch_factor = 1.0 + (lift_amount * stretch_focus * 4.4);
        let contrasted_t = shadow_pivot + (t_pixel_curved - shadow_pivot) * stretch_factor;

        let final_t = max(contrasted_t, 0.0);
        let curved_luma = pow(final_t, 2.2);

        let luma_ratio = curved_luma / safe_pixel_luma;
        rgb *= luma_ratio;

        let log_d = log2(max(t_detail, 0.0001));
        let safe_detail = exp2(log_d / (1.0 + abs(log_d) * 0.4));

        let noise_protection = smoothstep(0.0, 0.1, t_blurred);

        let detail_amp = 1.0 + (lift_amount * detail_focus * 1.5 * noise_protection);

        let enhanced_detail = pow(safe_detail, detail_amp);
        let detail_correction = enhanced_detail / safe_detail;

        let linear_correction = pow(detail_correction, 2.2);
        rgb *= linear_correction;

        let lift_structure = lift_amount * detail_focus * noise_protection * 6.0;
        rgb *= exp2(shape_detail(mid_log_detail, GF_REINJECT_SIGMA) * lift_structure);

        if (luma_ratio > 1.0) {
            let recovered_luma = get_luma(rgb);
            let boost_amount = clamp((luma_ratio - 1.0) * 0.05, 0.0, 0.12);
            rgb = mix(rgb, vec3<f32>(recovered_luma), boost_amount);
        }
    }

    if (con != 0.0) {
        let safe_rgb = max(rgb, vec3<f32>(0.0));
        let g = 2.2;
        let perceptual = pow(safe_rgb, vec3<f32>(1.0 / g));
        let clamped_perceptual = clamp(perceptual, vec3<f32>(0.0), vec3<f32>(1.0));
        let strength = pow(2.0, con * 1.25);
        let condition = clamped_perceptual < vec3<f32>(0.5);
        let high_part = 1.0 - 0.5 * pow(2.0 * (1.0 - clamped_perceptual), vec3<f32>(strength));
        let low_part = 0.5 * pow(2.0 * clamped_perceptual, vec3<f32>(strength));
        let curved_perceptual = select(high_part, low_part, condition);
        let contrast_adjusted_rgb = pow(curved_perceptual, vec3<f32>(g));
        let mix_factor = smoothstep(vec3<f32>(1.0), vec3<f32>(1.01), safe_rgb);
        rgb = mix(contrast_adjusted_rgb, rgb, mix_factor);
    }
    return rgb;
}

fn apply_highlights_adjustment(
    color_in: vec3<f32>,
    local_log_detail: f32,
    mid_log_detail: f32,
    is_raw: u32,
    highlights_adj: f32
) -> vec3<f32> {
    if (abs(highlights_adj) < 0.001) {
        return color_in;
    }

    let pixel_luma = get_luma(max(color_in, vec3<f32>(0.0)));
    if (pixel_luma < 0.0001) {
        return color_in;
    }

    const l_pivot: f32 = 0.06;
    if (pixel_luma <= l_pivot) {
        return color_in;
    }

    let luma_base = pixel_luma * exp2(-local_log_detail);
    let detail_ratio = pixel_luma / max(luma_base, 1e-4);
    let orig_log_detail = log2(max(detail_ratio, 1e-4));

    let safe_detail = clamp(detail_ratio, 0.65, 1.55);

    let log_detail = log2(safe_detail);
    let soft_log_detail = log_detail / (1.0 + abs(log_detail) * 0.40);

    let k_abs = min(abs(highlights_adj), 1.0);
    let detail_ramp = k_abs * (2.0 - k_abs);

    var target_luma: f32 = pixel_luma;

    if (highlights_adj < 0.0) {
        let k = -highlights_adj;
        let delta_base = max(luma_base - l_pivot, 0.0);

        let compression_strength = k * 2.2;
        let compressed_delta = delta_base / (1.0 + compression_strength * (delta_base / (1.0 + delta_base * 0.35)));
        let target_base = luma_base + (compressed_delta - delta_base);

        let neg_soft_detail = local_log_detail / (1.0 + abs(local_log_detail) * 0.80);
        let restoration_gain = 1.0 + k * 0.3;
        let structure_gain = shape_detail(mid_log_detail, GF_REINJECT_SIGMA) * k * 0.6;
        let recovered_log = mix(orig_log_detail, neg_soft_detail * restoration_gain, detail_ramp);
        let recovered_detail = exp2(recovered_log + structure_gain);

        let recovered_target = target_base * recovered_detail;

        let blend = smoothstep(l_pivot, l_pivot + 0.22, pixel_luma);
        target_luma = mix(pixel_luma, recovered_target, blend);

    } else {
        let boost = highlights_adj * 0.70;
        let delta_base = max(luma_base - l_pivot, 0.0);
        let boosted_delta = delta_base * (1.0 + boost / (1.0 + delta_base * 0.25));
        let target_base = luma_base + (boosted_delta - delta_base);

        let boosted_log = mix(orig_log_detail, soft_log_detail * (1.0 + highlights_adj * 0.20), detail_ramp);
        let detail_boost = exp2(boosted_log);
        let boosted_target = target_base * detail_boost;

        let blend = smoothstep(l_pivot, l_pivot + 0.22, pixel_luma);
        target_luma = mix(pixel_luma, boosted_target, blend);
    }

    let luma_ratio = target_luma / pixel_luma;
    var final_color = color_in * luma_ratio;

    if (highlights_adj < 0.0 && pixel_luma > 1.0) {
        let blowout = smoothstep(1.0, 3.5, pixel_luma) * (-highlights_adj) * 0.40;
        final_color = mix(final_color, vec3<f32>(target_luma), blowout);
    }

    return final_color;
}

fn apply_linear_exposure(color_in: vec3<f32>, exposure_adj: f32) -> vec3<f32> {
    if (exposure_adj == 0.0) {
        return color_in;
    }
    return color_in * pow(2.0, exposure_adj);
}

fn apply_filmic_exposure(color_in: vec3<f32>, brightness_adj: f32) -> vec3<f32> {
    if (brightness_adj == 0.0) {
        return color_in;
    }
    const RATIONAL_CURVE_MIX: f32 = 1.0;
    const MIDTONE_STRENGTH: f32 = 1.2;
    const TOP_ANCHOR: f32 = 1.0;

    let original_luma = get_luma(color_in);
    if (abs(original_luma) < 0.00001) {
        return color_in;
    }

    let direct_adj = brightness_adj * (1.0 - RATIONAL_CURVE_MIX);
    let rational_adj = brightness_adj * RATIONAL_CURVE_MIX;
    let scale = pow(2.0, direct_adj);
    let k = pow(2.0, -rational_adj * MIDTONE_STRENGTH);
    let luma_abs = abs(original_luma);

    var shaped_luma_abs: f32;
    if (luma_abs <= TOP_ANCHOR) {
        let luma_norm = luma_abs / TOP_ANCHOR;
        let shaped_norm = luma_norm / (luma_norm + (1.0 - luma_norm) * k);
        shaped_luma_abs = shaped_norm * TOP_ANCHOR;
    } else {
        shaped_luma_abs = TOP_ANCHOR + (luma_abs - TOP_ANCHOR) * k;
    }

    let new_luma_abs = shaped_luma_abs * scale;
    let new_luma = sign(original_luma) * new_luma_abs;
    let chroma = color_in - vec3<f32>(original_luma);

    let total_luma_scale = new_luma_abs / luma_abs;
    let luma_weight = clamp(new_luma_abs, 0.0, 2.0) * 0.5;
    let dynamic_exp = mix(0.95, 0.65, luma_weight);
    let base_chroma_scale = pow(total_luma_scale, dynamic_exp);

    let highlight_rolloff = clamp((1.05 - new_luma_abs) / max(1.05 - original_luma, 1e-4), 0.0, 1.0);
    let chroma_scale = base_chroma_scale * mix(1.0, highlight_rolloff, clamp(abs(brightness_adj), 0.0, 1.0));

    return vec3<f32>(new_luma) + chroma * chroma_scale;
}

fn apply_color_calibration(color: vec3<f32>, cal: ColorCalibrationSettings) -> vec3<f32> {
    let h_r = cal.red_hue;
    let h_g = cal.green_hue;
    let h_b = cal.blue_hue;
    let r_prime = vec3<f32>(1.0 - abs(h_r), max(0.0, h_r), max(0.0, -h_r));
    let g_prime = vec3<f32>(max(0.0, -h_g), 1.0 - abs(h_g), max(0.0, h_g));
    let b_prime = vec3<f32>(max(0.0, h_b), max(0.0, -h_b), 1.0 - abs(h_b));
    let hue_matrix = mat3x3<f32>(r_prime, g_prime, b_prime);
    var c = hue_matrix * color;

    let luma = get_luma(max(vec3(0.0), c));
    let desaturated_color = vec3<f32>(luma);
    let sat_vector = c - desaturated_color;

    let color_sum = c.r + c.g + c.b;
    var masks = vec3<f32>(0.0);
    if (color_sum > 0.001) {
        masks = c / color_sum;
    }

    let total_sat_adjustment =
        masks.r * cal.red_saturation +
        masks.g * cal.green_saturation +
        masks.b * cal.blue_saturation;

    c += sat_vector * total_sat_adjustment;

    let st = cal.shadows_tint;
    if (abs(st) > 0.001) {
        let shadow_luma = get_luma(max(vec3(0.0), c));
        let mask = 1.0 - smoothstep(0.0, 0.3, shadow_luma);
        let tint_mult = vec3<f32>(1.0 + st * 0.25, 1.0 - st * 0.25, 1.0 + st * 0.25);
        c = mix(c, c * tint_mult, mask);
    }

    return c;
}

fn apply_white_balance(color: vec3<f32>, log_gains: vec3<f32>) -> vec3<f32> {
    if (all(log_gains == vec3<f32>(0.0))) {
        return color;
    }
    let rgb_to_lms = adjustments.global.wb_rgb_to_lms_matrix;
    let lms_to_rgb = adjustments.global.wb_lms_to_rgb_matrix;
    let gains = exp(log_gains);
    let white = lms_to_rgb * (gains * (rgb_to_lms * vec3<f32>(1.0)));
    return lms_to_rgb * (gains * (rgb_to_lms * color)) / get_luma(white);
}

fn apply_creative_color(color: vec3<f32>, sat: f32, vib: f32) -> vec3<f32> {
    if (sat == 0.0 && vib == 0.0) {
        return color;
    }

    var processed = color;
    let luma = get_luma(max(processed, vec3<f32>(0.0)));

    let srgb = linear_to_srgb_extended(max(processed, vec3<f32>(0.0)));
    let hsv = rgb_to_hsv(srgb);
    let current_sat = hsv.y;
    let hue = hsv.x;

    var vib_factor: f32 = 0.0;
    if (vib != 0.0) {
        if (vib > 0.0) {
            let sat_weight = pow(max(1.0 - current_sat, 0.0), 1.25);
            let skin_center = 25.0;
            let hue_dist = min(abs(hue - skin_center), 360.0 - abs(hue - skin_center));
            let is_skin = 1.0 - smoothstep(12.0, 38.0, hue_dist);
            let skin_dampener = mix(1.0, 0.50, is_skin);

            vib_factor = vib * sat_weight * skin_dampener * 1.5;
        } else {
            let desat_weight = smoothstep(0.05, 0.75, current_sat);
            vib_factor = vib * desat_weight;
        }
    }

    let sat_scale = max(1.0 + sat, 0.0);
    let vib_scale = max(1.0 + vib_factor, 0.0);
    let final_mult = sat_scale * vib_scale;

    processed = mix(vec3<f32>(luma), processed, final_mult);

    return max(processed, vec3<f32>(0.0));
}

fn apply_hsl_panel(color: vec3<f32>, hsl_adjustments: array<HslColor, 8>, coords_i: vec2<i32>) -> vec3<f32> {
    var has_adjustments = false;
    for (var i = 0u; i < 8u; i = i + 1u) {
        if (abs(hsl_adjustments[i].hue) > 0.0001 ||
            abs(hsl_adjustments[i].saturation) > 0.0001 ||
            abs(hsl_adjustments[i].luminance) > 0.0001) {
            has_adjustments = true;
            break;
        }
    }
    if (!has_adjustments) {
        return color;
    }

    let safe_color = max(color, vec3<f32>(0.0));
    if (distance(safe_color.r, safe_color.g) < 0.001 && distance(safe_color.g, safe_color.b) < 0.001) {
        return safe_color;
    }
    let original_hsv = rgb_to_hsv(linear_to_srgb_extended(safe_color));
    let original_luma = get_luma(safe_color);

    let saturation_mask = smoothstep(0.05, 0.20, original_hsv.y);
    let luminance_weight = smoothstep(0.0, 1.0, original_hsv.y);

    if (saturation_mask < 0.001 && luminance_weight < 0.001) {
        return safe_color;
    }

    let original_hue = original_hsv.x;

    var raw_influences: array<f32, 8>;
    var total_raw_influence: f32 = 0.0;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let range = HSL_RANGES[i];
        let influence = get_raw_hsl_influence(original_hue, range.center, range.width);
        raw_influences[i] = influence;
        total_raw_influence += influence;
    }

    var total_hue_shift: f32 = 0.0;
    var total_sat_multiplier: f32 = 0.0;
    var total_lum_adjust: f32 = 0.0;

    for (var i = 0u; i < 8u; i = i + 1u) {
        let normalized_influence = raw_influences[i] / total_raw_influence;

        let hue_sat_influence = normalized_influence * saturation_mask;
        let luma_influence = normalized_influence * luminance_weight;

        total_hue_shift += hsl_adjustments[i].hue * 2.0 * hue_sat_influence;
        total_sat_multiplier += hsl_adjustments[i].saturation * hue_sat_influence;
        total_lum_adjust += hsl_adjustments[i].luminance * luma_influence;
    }

    if (original_hsv.y * (1.0 + total_sat_multiplier) < 0.0001) {
        let final_luma = original_luma * (1.0 + total_lum_adjust);
        return vec3<f32>(final_luma);
    }
    var hsv = original_hsv;
    hsv.x = (hsv.x + total_hue_shift + 360.0) % 360.0;
    hsv.y = clamp(hsv.y * (1.0 + total_sat_multiplier), 0.0, 1.0);
    let hs_shifted_rgb = srgb_to_linear(hsv_to_rgb(vec3<f32>(hsv.x, hsv.y, original_hsv.z)));
    let new_luma = get_luma(hs_shifted_rgb);
    let target_luma = original_luma * (1.0 + total_lum_adjust);
    if (new_luma < 0.0001) {
        return vec3<f32>(max(0.0, target_luma));
    }
    let final_color = hs_shifted_rgb * (target_luma / new_luma);
    return final_color;
}

fn apply_color_grading(color: vec3<f32>, shadows: ColorGradeSettings, midtones: ColorGradeSettings, highlights: ColorGradeSettings, global: ColorGradeSettings, blending: f32, balance: f32) -> vec3<f32> {
    let luma = get_luma(max(vec3(0.0), color));
    let base_shadow_crossover = 0.1;
    let base_highlight_crossover = 0.5;
    let balance_range = 0.5;
    let shadow_crossover = base_shadow_crossover + max(0.0, -balance) * balance_range;
    let highlight_crossover = base_highlight_crossover - max(0.0, balance) * balance_range;
    let feather = 0.2 * blending;
    let final_shadow_crossover = min(shadow_crossover, highlight_crossover - 0.01);
    let shadow_mask = 1.0 - smoothstep(final_shadow_crossover - feather, final_shadow_crossover + feather, luma);
    let highlight_mask = smoothstep(highlight_crossover - feather, highlight_crossover + feather, luma);
    let midtone_mask = max(0.0, 1.0 - shadow_mask - highlight_mask);
    let global_mask = 1.0;
    var graded_color = color;
    let shadow_sat_strength = 0.1;
    let shadow_lum_strength = 0.5;
    let midtone_sat_strength = 0.6;
    let midtone_lum_strength = 0.8;
    let highlight_sat_strength = 0.8;
    let highlight_lum_strength = 1.0;
    let global_sat_strength = 1.0;
    let global_lum_strength = 1.0;
    if (shadows.saturation > 0.001) { let tint_rgb = hsv_to_rgb(vec3<f32>(shadows.hue, 1.0, 1.0)); graded_color += (tint_rgb - 0.5) * shadows.saturation * shadow_mask * shadow_sat_strength; }
    graded_color += shadows.luminance * shadow_mask * shadow_lum_strength;
    if (midtones.saturation > 0.001) { let tint_rgb = hsv_to_rgb(vec3<f32>(midtones.hue, 1.0, 1.0)); graded_color += (tint_rgb - 0.5) * midtones.saturation * midtone_mask * midtone_sat_strength; }
    graded_color += midtones.luminance * midtone_mask * midtone_lum_strength;
    if (highlights.saturation > 0.001) { let tint_rgb = hsv_to_rgb(vec3<f32>(highlights.hue, 1.0, 1.0)); graded_color += (tint_rgb - 0.5) * highlights.saturation * highlight_mask * highlight_sat_strength; }
    graded_color += highlights.luminance * highlight_mask * highlight_lum_strength;
    if (global.saturation > 0.001) { let tint_rgb = hsv_to_rgb(vec3<f32>(global.hue, 1.0, 1.0)); graded_color += (tint_rgb - 0.5) * global.saturation * global_mask * global_sat_strength; }
    graded_color += global.luminance * global_mask * global_lum_strength;
    return graded_color;
}

const MONOCHROME_MIX_EV: f32 = 2.0;

fn apply_monochrome_mix(color: vec3<f32>, mono: MonochromeSettings, local_hsl: array<HslColor, 8>) -> vec3<f32> {
    let safe_color = max(color, vec3<f32>(0.0));
    var gray = max(dot(safe_color, vec3<f32>(mono.weight_r, mono.weight_g, mono.weight_b)), 0.0);

    let srgb = linear_to_srgb_extended(safe_color);
    let hsv = rgb_to_hsv(srgb);
    let chroma = hsv.y * hsv.z;
    let chroma_gate = smoothstep(0.05, 0.4, hsv.y) * smoothstep(0.0, 0.1, chroma);
    if (chroma_gate <= 0.0) {
        return vec3<f32>(gray);
    }

    var total_influence: f32 = 0.0;
    var total_mix: f32 = 0.0;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let range = HSL_RANGES[i];
        let influence = get_raw_hsl_influence(hsv.x, range.center, range.width);
        total_influence += influence;
        total_mix += influence * clamp(mono.mix[i] + local_hsl[i].luminance, -1.0, 1.0);
    }
    if (total_influence > 0.0) {
        gray *= exp2(total_mix / total_influence * chroma_gate * MONOCHROME_MIX_EV);
    }
    return vec3<f32>(gray);
}

fn oklab_to_linear_srgb(lab: vec3<f32>) -> vec3<f32> {
    let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    return vec3<f32>(
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    );
}

fn apply_monochrome_toning(srgb_gray: f32, mono: MonochromeSettings) -> vec3<f32> {
    let shadow_ab = vec2<f32>(mono.shadow_a, mono.shadow_b);
    let highlight_ab = vec2<f32>(mono.highlight_a, mono.highlight_b);
    let gray = clamp(srgb_gray, 0.0, 1.0);
    if (all(shadow_ab == vec2<f32>(0.0)) && all(highlight_ab == vec2<f32>(0.0))) {
        return vec3<f32>(gray);
    }

    let lightness = pow(srgb_to_linear(vec3<f32>(gray)).x, 1.0 / 3.0);
    let highlight_weight = smoothstep(0.2, 0.8, lightness + 0.4 * mono.toning_balance);
    let envelope = smoothstep(0.0, 0.3, lightness) * (1.0 - 0.6 * smoothstep(0.8, 1.0, lightness));
    let ab = mix(shadow_ab, highlight_ab, highlight_weight) * envelope;
    return linear_to_srgb(oklab_to_linear_srgb(vec3<f32>(lightness, ab)));
}

fn sample_gf_tex(tex: texture_2d<f32>, abs_coord: vec2<u32>) -> vec4<f32> {
    let full = vec2<f32>(textureDimensions(input_texture));
    let low_i = vec2<i32>(textureDimensions(tex));
    let p = (vec2<f32>(abs_coord) + 0.5) / full * vec2<f32>(low_i) - 0.5;
    let fl = floor(p);
    let w = p - fl;
    let max_idx = low_i - vec2<i32>(1);
    let c0 = clamp(vec2<i32>(fl), vec2<i32>(0), max_idx);
    let c1 = clamp(vec2<i32>(fl) + vec2<i32>(1), vec2<i32>(0), max_idx);
    let v00 = textureLoad(tex, c0, 0);
    let v10 = textureLoad(tex, vec2<i32>(c1.x, c0.y), 0);
    let v01 = textureLoad(tex, vec2<i32>(c0.x, c1.y), 0);
    let v11 = textureLoad(tex, c1, 0);
    return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
}

fn sample_gf_coeffs(abs_coord: vec2<u32>) -> vec4<f32> {
    return sample_gf_tex(gf_coeffs_texture, abs_coord);
}

fn shape_detail(d: f32, sigma: f32) -> f32 {
    let x = d / sigma;
    return d / (1.0 + x * x);
}

fn shape_detail_gf(d: f32) -> f32 {
    return shape_detail(d, select(GF_DETAIL_SIGMA, GF_BRIGHT_SIGMA, d > 0.0));
}

fn centre_clarity_strength(centre_amount: f32, centre_pos: vec2<f32>, coords_i: vec2<i32>) -> f32 {
    if (centre_amount == 0.0) {
        return 0.0;
    }
    let full_dims_f = vec2<f32>(textureDimensions(input_texture));
    let coord_f = vec2<f32>(coords_i);
    let midpoint = 0.4;
    let feather = 0.375;
    let aspect = full_dims_f.y / full_dims_f.x;
    let uv_centered = (coord_f / full_dims_f - centre_pos) * 2.0;
    let d = length(uv_centered * vec2<f32>(1.0, aspect)) * 0.5;
    let vignette_mask = smoothstep(midpoint - feather, midpoint + feather, d);
    let centre_mask = 1.0 - vignette_mask;

    const CLARITY_SCALE: f32 = 0.9;
    return centre_amount * (2.0 * centre_mask - 1.0) * CLARITY_SCALE;
}

fn sharpen_perc(c: vec3<f32>, is_raw: u32) -> f32 {
    let y = max(get_luma(c), 0.0);
    if (is_raw == 1u) { return sqrt(y); }
    return y;
}

fn sharpen_tap(coords: vec2<i32>, max_idx: vec2<i32>, is_raw: u32) -> f32 {
    let c = clamp(coords, vec2<i32>(0), max_idx);
    return sharpen_perc(textureLoad(input_texture, vec2<u32>(c), 0).rgb, is_raw);
}

fn sharpen_core(d: f32, t: f32) -> f32 {
    return d * d * d / (d * d + t * t);
}

fn apply_sharpen(
    color: vec3<f32>,
    b1_in: vec3<f32>,
    b2_in: vec3<f32>,
    coords_i: vec2<i32>,
    amount: f32,
    threshold: f32,
    is_raw: u32
) -> vec3<f32> {
    if (abs(amount) < 0.0005) {
        return color;
    }

    if (amount < 0.0) {
        var b1_lin = b1_in;
        if (is_raw == 0u) { b1_lin = srgb_to_linear(b1_in); }
        return mix(color, b1_lin, clamp(-amount * 0.5, 0.0, 1.0));
    }

    var color_enc = color;
    if (is_raw == 0u) {
        color_enc = linear_to_srgb_extended(color);
    }
    let l = select(get_luma(color_enc), sqrt(max(get_luma(color), 0.0)), is_raw == 1u);
    let l1 = sharpen_perc(b1_in, is_raw);
    let l2 = sharpen_perc(b2_in, is_raw);

    let max_idx = vec2<i32>(textureDimensions(input_texture)) - vec2<i32>(1);
    var lo = l;
    var hi = l;
    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            let s = sharpen_tap(coords_i + vec2<i32>(dx, dy), max_idx, is_raw);
            lo = min(lo, s);
            hi = max(hi, s);
        }
    }

    let t = max(threshold * 0.07, 1e-4);
    let detail = sharpen_core(l - l1, t) + 0.5 * sharpen_core(l1 - l2, t);
    let tapered = detail / (1.0 + abs(detail) * 12.0);
    let delta = tapered * amount * 5.2 / (1.0 + 0.4 * max(amount - 1.0, 0.0));
    let range = hi - lo;
    let up_room = (hi - l + range * 0.15 + 0.004) * 0.7;
    let down_room = (l - lo + range * 0.05 + 0.002) * 0.7;
    let up = max(delta, 0.0);
    let down = max(-delta, 0.0) * 0.7;
    var l_new = l + up * up_room / (up_room + up) - down * down_room / (down_room + down);

    let shadow_floor = select(0.03, 0.10, is_raw == 1u);
    let prot = smoothstep(0.0, shadow_floor, l) * (1.0 - smoothstep(0.92, 1.0, l));
    l_new = max(mix(l, l_new, prot), 0.0);

    let ratio = l_new / max(l, 1e-4);
    if (is_raw == 1u) {
        return color * (ratio * ratio);
    }
    return srgb_to_linear(max(color_enc * ratio, vec3<f32>(0.0)));
}

fn apply_centre_tonal_and_color(
    color_in: vec3<f32>,
    centre_amount: f32,
    centre_pos: vec2<f32>,
    coords_i: vec2<i32>
) -> vec3<f32> {
    if (centre_amount == 0.0) {
        return color_in;
    }
    let full_dims_f = vec2<f32>(textureDimensions(input_texture));
    let coord_f = vec2<f32>(coords_i);
    let midpoint = 0.4;
    let feather = 0.375;
    let aspect = full_dims_f.y / full_dims_f.x;
    let uv_centered = (coord_f / full_dims_f - centre_pos) * 2.0;
    let d = length(uv_centered * vec2<f32>(1.0, aspect)) * 0.5;
    let vignette_mask = smoothstep(midpoint - feather, midpoint + feather, d);
    let centre_mask = 1.0 - vignette_mask;

    const EXPOSURE_SCALE: f32 = 0.5;
    const VIBRANCE_SCALE: f32 = 0.4;
    const SATURATION_CENTER_SCALE: f32 = 0.3;
    const SATURATION_EDGE_SCALE: f32 = 0.8;

    var processed_color = color_in;

    let exposure_boost = centre_mask * centre_amount * EXPOSURE_SCALE;
    processed_color = apply_linear_exposure(processed_color, exposure_boost);

    let vibrance_center_boost = centre_mask * centre_amount * VIBRANCE_SCALE;
    let saturation_center_boost = centre_mask * centre_amount * SATURATION_CENTER_SCALE;
    let saturation_edge_effect = -(1.0 - centre_mask) * centre_amount * SATURATION_EDGE_SCALE;
    let total_saturation_effect = saturation_center_boost + saturation_edge_effect;
    processed_color = apply_creative_color(processed_color, total_saturation_effect, vibrance_center_boost);

    return processed_color;
}

fn apply_dehaze(color: vec3<f32>, abs_coord: vec2<u32>, local_luma: f32, amount: f32) -> vec3<f32> {
    if (amount == 0.0) { return color; }

    let air = textureLoad(airlight_texture, vec2<i32>(0, 0), 0);
    let rgb = max(color, vec3<f32>(0.0));
    let guide = min(pow(get_luma(rgb) / air.w, HZ_GUIDE_GAMMA), HZ_GUIDE_MAX);
    let ab = sample_gf_tex(haze_texture, abs_coord).xy;
    let veil = clamp(ab.x * guide + ab.y, 0.0, 1.0);

    if (amount < 0.0) {
        let scene = textureLoad(airlight_texture, vec2<i32>(1, 0), 0);
        let mist_tint = mix(vec3<f32>(1.0), scene.rgb / scene.w, 0.5);
        let mist_light = mist_tint * sqrt(scene.w * air.w);
        let density = min(-amount, 1.0) * HZ_MIST * mix(0.4, 1.0, veil);
        return mix(color, mist_light, density);
    }

    let detail = clamp(get_luma(rgb) / max(local_luma, 1.0e-6), 0.25, 4.0);
    let local_rgb = rgb / detail;
    let n = local_rgb / air.rgb;
    let pixel_dark = min(n.r, min(n.g, n.b));
    let strength = 1.0 - (1.0 - min(amount, 1.0)) * (1.0 - min(amount, 1.0));
    let t_smooth = max(1.0 - strength * HZ_OMEGA * veil, HZ_T_MIN);
    let t_floor = (1.0 - min(pixel_dark, 1.0)) / (1.0 - HZ_FLOOR * min(pixel_dark, 1.0));
    let knee = max(HZ_KNEE - abs(t_smooth - t_floor), 0.0) / HZ_KNEE;
    var t = min(max(t_smooth, t_floor) + knee * knee * HZ_KNEE * 0.25, 1.0);
    let distance = max(abs(n.r - 1.0), max(abs(n.g - 1.0), abs(n.b - 1.0)));
    let near_air = distance / HZ_TOLERANCE;
    let bright = smoothstep(HZ_BRIGHT_LO, HZ_BRIGHT_HI, max(n.r, max(n.g, n.b)));
    t = mix(t, 1.0, max(exp(-near_air * near_air), bright));
    var recovered = max(local_rgb + (1.0 / t - 1.0) * min(local_rgb - air.rgb, vec3<f32>(0.0)), vec3<f32>(0.0));
    let local_l = max(get_luma(local_rgb), 1.0e-6);
    let recovered_l = max(get_luma(recovered), 1.0e-6);
    let chroma_in = length(local_rgb / local_l - 1.0);
    let chroma_out = recovered / recovered_l - 1.0;
    let chroma_limit = HZ_CHROMA_MAX * chroma_in + HZ_CHROMA_FLOOR;
    recovered = max(recovered_l * (1.0 + chroma_out * min(chroma_limit / max(length(chroma_out), 1.0e-6), 1.0)), vec3<f32>(0.0));
    let contrast_gain = get_luma(local_rgb) / max(t * get_luma(recovered), 1.0e-6);
    let detail_gain = clamp(contrast_gain, 1.0, HZ_DETAIL_MAX);
    let detail_log = log2(detail);
    let detail_out = exp2(detail_log + (detail_gain - 1.0) * shape_detail(detail_log, HZ_DETAIL_SIGMA));
    let lift = pow(t_smooth, -HZ_LIFT);
    let dehazed = recovered * detail_out;
    let rolloff = min(get_luma(dehazed) / air.w, 1.0);
    return dehazed * (lift / (1.0 + (lift - 1.0) * rolloff));
}

const NR_FLOOR: f32 = 0.002;
const NR_GUIDE_VAR: f32 = 0.3;
const NR_COARSE_VAR: f32 = 0.15;
const NR_SPATIAL: f32 = 0.03;

var<workgroup> nr_tile: array<u32, 676>;
var<workgroup> nr_coarse: array<f32, 676>;

fn nr_fetch(coord: vec2<i32>, max_idx: vec2<i32>, gain: f32, is_raw: u32) -> vec3<f32> {
    var s = textureLoad(input_texture, vec2<u32>(clamp(coord, vec2<i32>(0), max_idx)), 0).rgb;
    if (is_raw == 0u) { s = srgb_to_linear(s); }
    return s * gain;
}

fn nr_halo(scale: f32) -> i32 {
    return select(5, 9, scale > 1.5);
}

fn nr_p(k: i32) -> f32 {
    return unpack2x16float(nr_tile[k]).x;
}

fn nr_g(k: i32) -> f32 {
    return unpack2x16float(nr_tile[k]).y;
}

fn nr_lin(p: vec4<f32>) -> vec4<f32> {
    let q = p + sqrt(NR_FLOOR);
    return q * q - NR_FLOOR;
}

fn nr_load_tile(local_id: vec2<i32>, group_origin: vec2<i32>, exposure: f32, is_raw: u32, scale: f32) {
    let max_idx = vec2<i32>(textureDimensions(input_texture)) - vec2<i32>(1);
    let gain = exp2(clamp(exposure, -10.0, 10.0));
    let halo = nr_halo(scale);
    let t = 8 + 2 * halo;
    for (var y = local_id.y; y < t; y = y + 8) {
        for (var x = local_id.x; x < t; x = x + 8) {
            let l = get_luma(nr_fetch(group_origin + vec2<i32>(x - halo, y - halo), max_idx, gain, is_raw));
            nr_tile[y * t + x] = pack2x16float(vec2<f32>(sqrt(max(l, 0.0) + NR_FLOOR) - sqrt(NR_FLOOR), 0.0));
        }
    }
}

fn nr_build_guide(local_id: vec2<i32>, scale: f32) {
    let r = 8 + 2 * nr_halo(scale);
    for (var y = local_id.y + 1; y < r - 1; y = y + 8) {
        for (var x = local_id.x + 1; x < r - 1; x = x + 8) {
            let k = y * r + x;
            let c = nr_p(k - r - 1) + 2.0 * nr_p(k - r) + nr_p(k - r + 1)
                  + 2.0 * nr_p(k - 1) + 4.0 * nr_p(k) + 2.0 * nr_p(k + 1)
                  + nr_p(k + r - 1) + 2.0 * nr_p(k + r) + nr_p(k + r + 1);
            nr_coarse[k] = c * 0.0625;
        }
    }
}

fn nr_pack_guide(local_id: vec2<i32>, scale: f32) {
    let r = 8 + 2 * nr_halo(scale);
    for (var y = local_id.y + 1; y < r - 1; y = y + 8) {
        for (var x = local_id.x + 1; x < r - 1; x = x + 8) {
            let k = y * r + x;
            nr_tile[k] = pack2x16float(vec2<f32>(nr_p(k), nr_coarse[k]));
        }
    }
}

fn nr_enabled() -> bool {
    var on = adjustments.global.luma_noise_reduction != 0.0 || adjustments.global.color_noise_reduction != 0.0;
    for (var i = 0u; i < adjustments.mask_count; i = i + 1u) {
        let m = adjustments.mask_adjustments[i];
        on = on || m.luma_noise_reduction != 0.0 || m.color_noise_reduction != 0.0;
    }
    return on;
}

fn nr_build_coarse_guide(local_id: vec2<i32>, scale: f32) {
    let halo = nr_halo(scale);
    if (halo < 9) { return; }
    let r = 8 + 2 * halo;
    for (var y = local_id.y + 3; y < r - 3; y = y + 8) {
        for (var x = local_id.x + 3; x < r - 3; x = x + 8) {
            let k = y * r + x;
            let c = nr_g(k - 2 * r - 2) + 2.0 * nr_g(k - 2 * r) + nr_g(k - 2 * r + 2)
                  + 2.0 * nr_g(k - 2) + 4.0 * nr_g(k) + 2.0 * nr_g(k + 2)
                  + nr_g(k + 2 * r - 2) + 2.0 * nr_g(k + 2 * r) + nr_g(k + 2 * r + 2);
            nr_coarse[k] = c * 0.0625;
        }
    }
}

fn nr_fine_row(k: i32) -> array<vec4<f32>, 3> {
    return array<vec4<f32>, 3>(
        vec4<f32>(nr_g(k), nr_g(k + 1), nr_g(k + 2), nr_g(k + 3)),
        vec4<f32>(nr_g(k + 4), nr_g(k + 5), nr_g(k + 6), nr_g(k + 7)),
        vec4<f32>(nr_g(k + 8), 0.0, 0.0, 0.0)
    );
}

fn nr_fine_d2(r: array<vec4<f32>, 3>, p: vec3<f32>) -> array<vec4<f32>, 2> {
    let a = r[0];
    let b = r[1];
    let c = r[2];
    let l0 = a - p.x;
    let l1 = vec4<f32>(a.yzw, b.x) - p.y;
    let l2 = vec4<f32>(a.zw, b.xy) - p.z;
    let h0 = b - p.x;
    let h1 = vec4<f32>(b.yzw, c.x) - p.y;
    let h2 = vec4<f32>(b.zw, c.x, 0.0) - p.z;
    return array<vec4<f32>, 2>(l0 * l0 + l1 * l1 + l2 * l2, h0 * h0 + h1 * h1 + h2 * h2);
}

fn nr_coarse_row(k: i32) -> array<vec4<f32>, 2> {
    return array<vec4<f32>, 2>(
        vec4<f32>(nr_coarse[k - 6], nr_coarse[k - 4], nr_coarse[k - 2], nr_coarse[k]),
        vec4<f32>(nr_coarse[k + 2], nr_coarse[k + 4], nr_coarse[k + 6], 0.0)
    );
}

fn nr_coarse_d2(r: array<vec4<f32>, 2>, p: vec3<f32>) -> vec4<f32> {
    let a = r[0];
    let b = r[1];
    let e0 = a - p.x;
    let e1 = vec4<f32>(a.yzw, b.x) - p.y;
    let e2 = vec4<f32>(a.zw, b.xy) - p.z;
    return e0 * e0 + e1 * e1 + e2 * e2;
}

fn nr_coarse_d2_last(r: array<vec4<f32>, 2>, p: vec3<f32>) -> f32 {
    let f = r[1].xyz - p;
    return dot(f, f);
}

fn nr_weight(d2: vec4<f32>, inv: f32, r2: vec4<f32>) -> vec4<f32> {
    return exp(-max(d2 * inv - 1.0, vec4<f32>(0.0)) - r2 * NR_SPATIAL);
}

fn apply_noise_reduction(
    center_linear: vec3<f32>,
    coords_i: vec2<i32>,
    local_i: vec2<i32>,
    luma_amount: f32,
    color_amount: f32,
    scale: f32,
    is_raw: u32,
    exposure: f32,
    tile_exposure: f32
) -> vec3<f32> {
    let luma_a  = clamp(luma_amount,  0.0, 1.0);
    let color_a = clamp(color_amount, 0.0, 1.0);
    if (luma_a < 0.001 && color_a < 0.001) {
        return center_linear;
    }

    let max_idx = vec2<i32>(textureDimensions(input_texture)) - vec2<i32>(1);
    let gain = exp2(clamp(exposure, -10.0, 10.0));
    let tile_ratio = gain / exp2(clamp(tile_exposure, -10.0, 10.0));
    let tile_ratio_sqrt = sqrt(tile_ratio);
    let res = clamp(sqrt(scale), 0.75, 2.5);
    let halo = nr_halo(scale);
    let row = 8 + 2 * halo;
    let base = (local_i.y + halo) * row + local_i.x + halo;

    let center_l = center_linear * gain;
    let center_yl = get_luma(center_l);
    let sf = sqrt(NR_FLOOR);
    let center_y = sqrt(max(center_yl, 0.0) + NR_FLOOR) - sf;
    let center_t = unpack2x16float(nr_tile[base]);

    let c_curve = sqrt(color_a);
    let sigma = select(mix(0.012, 0.03, c_curve), 0.002 + 0.06 * pow(luma_a, 1.3), luma_a > 0.001);

    var new_yl = center_yl;
    var ref_y = center_y + (center_t.y - center_t.x) * tile_ratio_sqrt;
    if (luma_a > 0.001) {
        let inv_g = tile_ratio / (sigma * sigma * NR_GUIDE_VAR * 9.0);
        let pa = vec3<f32>(nr_g(base - row - 1), nr_g(base - row), nr_g(base - row + 1));
        let pb = vec3<f32>(nr_g(base - 1), center_t.y, nr_g(base + 1));
        let pc = vec3<f32>(nr_g(base + row - 1), nr_g(base + row), nr_g(base + row + 1));
        var acc = 0.0;
        var acc_p = 0.0;
        var wsum = 0.0;
        for (var dj: i32 = -3; dj <= 3; dj = dj + 1) {
            let k = base + dj * row - 4;
            let d0 = nr_fine_d2(nr_fine_row(k - row), pa);
            let d1 = nr_fine_d2(nr_fine_row(k), pb);
            let d2 = nr_fine_d2(nr_fine_row(k + row), pc);
            let dj2 = f32(dj * dj);
            let wl = nr_weight(d0[0] + d1[0] + d2[0], inv_g, vec4<f32>(9.0, 4.0, 1.0, 0.0) + dj2);
            var wh = nr_weight(d0[1] + d1[1] + d2[1], inv_g, vec4<f32>(1.0, 4.0, 9.0, 0.0) + dj2);
            wh.w = 0.0;
            let pl = vec4<f32>(nr_p(k + 1), nr_p(k + 2), nr_p(k + 3), nr_p(k + 4));
            let ph = vec4<f32>(nr_p(k + 5), nr_p(k + 6), nr_p(k + 7), 0.0);
            acc += dot(nr_lin(pl), wl) + dot(nr_lin(ph), wh);
            acc_p += dot(pl, wl) + dot(ph, wh);
            wsum += dot(wl, vec4<f32>(1.0)) + dot(wh, vec4<f32>(1.0));
        }
        if (halo == 9) {
            let coarse_a = smoothstep(1.5, 2.5, scale);
            let inv_c = tile_ratio / (sigma * sigma * NR_COARSE_VAR * 9.0);
            let t2 = 2 * row;
            let qa = vec3<f32>(nr_coarse[base - t2 - 2], nr_coarse[base - t2], nr_coarse[base - t2 + 2]);
            let qb = vec3<f32>(nr_coarse[base - 2], nr_coarse[base], nr_coarse[base + 2]);
            let qc = vec3<f32>(nr_coarse[base + t2 - 2], nr_coarse[base + t2], nr_coarse[base + t2 + 2]);
            for (var dj: i32 = -2; dj <= 2; dj = dj + 1) {
                let k = base + 2 * dj * row;
                let r0 = nr_coarse_row(k - t2);
                let r1 = nr_coarse_row(k);
                let r2 = nr_coarse_row(k + t2);
                let dj2 = f32(4 * dj * dj);
                var wv = coarse_a * nr_weight(nr_coarse_d2(r0, qa) + nr_coarse_d2(r1, qb) + nr_coarse_d2(r2, qc), inv_c, vec4<f32>(16.0, 4.0, 0.0, 4.0) + dj2);
                if (dj == 0) { wv.z = 0.0; }
                let ws = coarse_a * nr_weight(vec4<f32>(nr_coarse_d2_last(r0, qa) + nr_coarse_d2_last(r1, qb) + nr_coarse_d2_last(r2, qc)), inv_c, vec4<f32>(16.0 + dj2)).x;
                let pv = vec4<f32>(nr_p(k - 4), nr_p(k - 2), nr_p(k), nr_p(k + 2));
                let pw = nr_p(k + 4);
                acc += dot(nr_lin(pv), wv) + nr_lin(vec4<f32>(pw)).x * ws;
                acc_p += dot(pv, wv) + pw * ws;
                wsum += dot(wv, vec4<f32>(1.0)) + ws;
            }
        }
        ref_y = center_y + (acc_p / wsum - center_t.x) * tile_ratio_sqrt;
        new_yl = mix(center_yl, acc * tile_ratio / wsum, min(luma_a * 5.0, 1.0));
    }

    var new_c = center_l - vec3<f32>(center_yl);
    if (color_a > 0.001) {
        let ref_tol = -1.0 / (9.0 * sigma * sigma + 1e-4);
        var cref = vec3<f32>(0.0);
        var cref_w = 0.0;
        for (var j: i32 = -2; j <= 2; j = j + 1) {
            for (var i: i32 = -2; i <= 2; i = i + 1) {
                let s = nr_fetch(coords_i + vec2<i32>(i, j), max_idx, gain, is_raw);
                let sl = get_luma(s);
                let q = sqrt(max(sl, 0.0) + NR_FLOOR);
                let dy = q - sf - ref_y;
                let w = exp(dy * dy * ref_tol);
                cref += (s - vec3<f32>(sl)) * (0.5 / q) * w;
                cref_w += w;
            }
        }
        cref /= max(cref_w, 1e-6);

        let ct = clamp(i32(round(mix(2.0, 5.5, c_curve) * res * res * 0.52)), 1, 16);
        let y_tol = -1.0 / (2.0 * pow(mix(0.04, 0.1, c_curve) + 2.0 * sigma, 2.0));
        let c_tol = -1.0 / (2.0 * pow(mix(0.03, 0.12, c_curve), 2.0));
        var sw = 0.0;
        var sy = 0.0;
        var syy = 0.0;
        var sc = vec3<f32>(0.0);
        var syc = vec3<f32>(0.0);
        for (var j: i32 = -3; j <= 3; j = j + 1) {
            let span = select(select(1, 2, abs(j) == 2), 3, abs(j) <= 1);
            for (var i: i32 = -span; i <= span; i = i + 1) {
                let r2 = f32(i * i + j * j);
                let o = coords_i + vec2<i32>(i, j) * ct;
                let s = 0.25 * (nr_fetch(o, max_idx, gain, is_raw) + nr_fetch(o + vec2<i32>(1, 0), max_idx, gain, is_raw)
                    + nr_fetch(o + vec2<i32>(0, 1), max_idx, gain, is_raw) + nr_fetch(o + vec2<i32>(1, 1), max_idx, gain, is_raw));
                let sl = get_luma(s);
                let q = sqrt(max(sl, 0.0) + NR_FLOOR);
                let y = q - sf;
                let dy = y - ref_y;
                let c = (s - vec3<f32>(sl)) * (0.5 / q);
                let dc = c - cref;
                let w = exp(dy * dy * y_tol + dot(dc, dc) * c_tol - r2 * 0.06);
                sw += w;
                sy += y * w;
                syy += y * y * w;
                sc += c * w;
                syc += c * (y * w);
            }
        }
        if (sw > 1e-4) {
            let my = sy / sw;
            let mc = sc / sw;
            let slope = (syc / sw - mc * my) / max(syy / sw - my * my + 0.0004, 1e-6);
            let c_hat = mc + slope * (ref_y - my);
            let c_lin = c_hat * (2.0 * sqrt(max(new_yl, 0.0) + NR_FLOOR));
            new_c = mix(new_c, c_lin, min(color_a * 4.0, 1.0));
        }
    }

    return (vec3<f32>(new_yl) + new_c) / gain;
}

fn apply_ca_correction(coords: vec2<u32>, ca_rc: f32, ca_by: f32) -> vec3<f32> {
    let dims = vec2<f32>(textureDimensions(input_texture));
    let center = dims / 2.0;
    let current_pos = vec2<f32>(coords);

    let to_center = current_pos - center;
    let dist = length(to_center);

    if (dist == 0.0) {
        return textureLoad(input_texture, coords, 0).rgb;
    }

    let dir = to_center / dist;

    let red_shift = dir * dist * ca_rc;
    let blue_shift = dir * dist * ca_by;

    let red_coords = vec2<i32>(round(current_pos - red_shift));
    let blue_coords = vec2<i32>(round(current_pos - blue_shift));
    let green_coords = vec2<i32>(current_pos);

    let max_coords = vec2<i32>(dims - 1.0);

    let r = textureLoad(input_texture, vec2<u32>(clamp(red_coords, vec2<i32>(0), max_coords)), 0).r;
    let g = textureLoad(input_texture, vec2<u32>(clamp(green_coords, vec2<i32>(0), max_coords)), 0).g;
    let b = textureLoad(input_texture, vec2<u32>(clamp(blue_coords, vec2<i32>(0), max_coords)), 0).b;

    return vec3<f32>(r, g, b);
}

const AGX_EPSILON: f32 = 1.0e-6;
const AGX_MIN_EV: f32 = -15.2;
const AGX_MAX_EV: f32 = 5.0;
const AGX_RANGE_EV: f32 = AGX_MAX_EV - AGX_MIN_EV;
const AGX_GAMMA: f32 = 2.4;
const AGX_SLOPE: f32 = 2.3843;
const AGX_TOE_POWER: f32 = 1.5;
const AGX_SHOULDER_POWER: f32 = 1.5;
const AGX_TOE_TRANSITION_X: f32 = 0.6060606;
const AGX_TOE_TRANSITION_Y: f32 = 0.43446;
const AGX_SHOULDER_TRANSITION_X: f32 = 0.6060606;
const AGX_SHOULDER_TRANSITION_Y: f32 = 0.43446;
const AGX_INTERCEPT: f32 = -1.0112;
const AGX_TOE_SCALE: f32 = -1.0359;
const AGX_SHOULDER_SCALE: f32 = 1.3475;
const AGX_TARGET_BLACK_PRE_GAMMA: f32 = 0.0;
const AGX_TARGET_WHITE_PRE_GAMMA: f32 = 1.0;

fn agx_sigmoid(x: f32, power: f32) -> f32 {
    return x / pow(1.0 + pow(x, power), 1.0 / power);
}

fn agx_scaled_sigmoid(x: f32, scale: f32, slope: f32, power: f32, transition_x: f32, transition_y: f32) -> f32 {
    return scale * agx_sigmoid(slope * (x - transition_x) / scale, power) + transition_y;
}

fn agx_apply_curve_channel(x: f32) -> f32 {
    var result: f32 = 0.0;
    if (x < AGX_TOE_TRANSITION_X) {
        result = agx_scaled_sigmoid(x, AGX_TOE_SCALE, AGX_SLOPE, AGX_TOE_POWER, AGX_TOE_TRANSITION_X, AGX_TOE_TRANSITION_Y);
    } else if (x <= AGX_SHOULDER_TRANSITION_X) {
        result = AGX_SLOPE * x + AGX_INTERCEPT;
    } else {
        result = agx_scaled_sigmoid(x, AGX_SHOULDER_SCALE, AGX_SLOPE, AGX_SHOULDER_POWER, AGX_SHOULDER_TRANSITION_X, AGX_SHOULDER_TRANSITION_Y);
    }
    return clamp(result, AGX_TARGET_BLACK_PRE_GAMMA, AGX_TARGET_WHITE_PRE_GAMMA);
}

fn agx_compress_gamut(c: vec3<f32>) -> vec3<f32> {
    let min_c = min(c.r, min(c.g, c.b));
    if (min_c < 0.0) {
        return c - min_c;
    }
    return c;
}

fn agx_tonemap(c: vec3<f32>) -> vec3<f32> {
    let x_relative = max(c / 0.18, vec3<f32>(AGX_EPSILON));
    let log_encoded = (log2(x_relative) - AGX_MIN_EV) / AGX_RANGE_EV;
    let mapped = clamp(log_encoded, vec3<f32>(0.0), vec3<f32>(1.0));

    var curved: vec3<f32>;
    curved.r = agx_apply_curve_channel(mapped.r);
    curved.g = agx_apply_curve_channel(mapped.g);
    curved.b = agx_apply_curve_channel(mapped.b);

    let final_color = pow(max(curved, vec3<f32>(0.0)), vec3<f32>(AGX_GAMMA));

    return final_color;
}

fn agx_full_transform(color_in: vec3<f32>) -> vec3<f32> {
    let compressed_color = agx_compress_gamut(color_in);
    let color_in_agx_space = adjustments.global.agx_pipe_to_rendering_matrix * compressed_color;
    let tonemapped_agx = agx_tonemap(color_in_agx_space);
    let final_color = adjustments.global.agx_rendering_to_pipe_matrix * tonemapped_agx;
    return final_color;
}

fn legacy_tonemap(c: vec3<f32>) -> vec3<f32> {
    const a: f32 = 2.51;
    const b: f32 = 0.03;
    const c_const: f32 = 2.43;
    const d: f32 = 0.59;
    const e: f32 = 0.14;

    let x = max(c, vec3<f32>(0.0));

    let numerator = x * (a * x + b);
    let denominator = x * (c_const * x + d) + e;

    let tonemapped = select(vec3<f32>(0.0), numerator / denominator, denominator > vec3<f32>(0.00001));

    return clamp(tonemapped, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn no_tonemap(c: vec3<f32>) -> vec3<f32> {
    return c;
}

fn is_default_curve(src: u32, ch: u32, count: u32) -> bool {
    if (count < 2u) {
        return false;
    }

    var is_identity = true;
    for (var i = 0u; i < count; i = i + 1u) {
        let p = curve_point(src, ch, i);
        if (abs(p.x - p.y) > 0.5) {
            is_identity = false;
            break;
        }
    }

    let p0 = curve_point(src, ch, 0u);
    let p_last = curve_point(src, ch, count - 1u);
    let p0_is_origin = abs(p0.x - 0.0) < 0.1 && abs(p0.y - 0.0) < 0.1;
    let p_last_is_end = abs(p_last.x - 255.0) < 0.1 && abs(p_last.y - 255.0) < 0.1;

    return is_identity && p0_is_origin && p_last_is_end;
}

fn apply_all_curves(color: vec3<f32>, src: u32) -> vec3<f32> {
    let luma_count = curve_count(src, 0u);
    var r = apply_curve(color.r, src, 0u, luma_count);
    var g = apply_curve(color.g, src, 0u, luma_count);
    var b = apply_curve(color.b, src, 0u, luma_count);

    let red_count = curve_count(src, 1u);
    if (!is_default_curve(src, 1u, red_count)) {
        r = apply_curve(r, src, 1u, red_count);
    }
    let green_count = curve_count(src, 2u);
    if (!is_default_curve(src, 2u, green_count)) {
        g = apply_curve(g, src, 2u, green_count);
    }
    let blue_count = curve_count(src, 3u);
    if (!is_default_curve(src, 3u, blue_count)) {
        b = apply_curve(b, src, 3u, blue_count);
    }

    return clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn get_mask_influence(mask_index: u32, coords: vec2<u32>) -> f32 {
    return textureLoad(mask_textures, vec2<i32>(coords), i32(mask_index), 0).r;
}

fn sample_lut_tetrahedral(uv: vec3<f32>) -> vec3<f32> {
    let dims = vec3<f32>(textureDimensions(lut_texture));
    let size = dims - vec3<f32>(1.0);
    let scaled = clamp(uv, vec3<f32>(0.0), vec3<f32>(1.0)) * size;
    let i_base = floor(scaled);
    let f = scaled - i_base;
    let coord0 = vec3<i32>(i_base);
    let coord1 = min(coord0 + vec3<i32>(1), vec3<i32>(dims) - vec3<i32>(1));
    let c000 = textureLoad(lut_texture, coord0, 0).rgb;
    let c111 = textureLoad(lut_texture, coord1, 0).rgb;

    var res = vec3<f32>(0.0);

    if (f.r > f.g) {
        if (f.g > f.b) {
            let c100 = textureLoad(lut_texture, vec3<i32>(coord1.x, coord0.y, coord0.z), 0).rgb;
            let c110 = textureLoad(lut_texture, vec3<i32>(coord1.x, coord1.y, coord0.z), 0).rgb;

            res = c000 * (1.0 - f.r) +
                  c100 * (f.r - f.g) +
                  c110 * (f.g - f.b) +
                  c111 * (f.b);
        } else if (f.r > f.b) {
            let c100 = textureLoad(lut_texture, vec3<i32>(coord1.x, coord0.y, coord0.z), 0).rgb;
            let c101 = textureLoad(lut_texture, vec3<i32>(coord1.x, coord0.y, coord1.z), 0).rgb;

            res = c000 * (1.0 - f.r) +
                  c100 * (f.r - f.b) +
                  c101 * (f.b - f.g) +
                  c111 * (f.g);
        } else {
            let c001 = textureLoad(lut_texture, vec3<i32>(coord0.x, coord0.y, coord1.z), 0).rgb;
            let c101 = textureLoad(lut_texture, vec3<i32>(coord1.x, coord0.y, coord1.z), 0).rgb;

            res = c000 * (1.0 - f.b) +
                  c001 * (f.b - f.r) +
                  c101 * (f.r - f.g) +
                  c111 * (f.g);
        }
    } else {
        if (f.b > f.g) {
            let c001 = textureLoad(lut_texture, vec3<i32>(coord0.x, coord0.y, coord1.z), 0).rgb;
            let c011 = textureLoad(lut_texture, vec3<i32>(coord0.x, coord1.y, coord1.z), 0).rgb;

            res = c000 * (1.0 - f.b) +
                  c001 * (f.b - f.g) +
                  c011 * (f.g - f.r) +
                  c111 * (f.r);
        } else if (f.b > f.r) {
            let c010 = textureLoad(lut_texture, vec3<i32>(coord0.x, coord1.y, coord0.z), 0).rgb;
            let c011 = textureLoad(lut_texture, vec3<i32>(coord0.x, coord1.y, coord1.z), 0).rgb;

            res = c000 * (1.0 - f.g) +
                  c010 * (f.g - f.b) +
                  c011 * (f.b - f.r) +
                  c111 * (f.r);
        } else {
            let c010 = textureLoad(lut_texture, vec3<i32>(coord0.x, coord1.y, coord0.z), 0).rgb;
            let c110 = textureLoad(lut_texture, vec3<i32>(coord1.x, coord1.y, coord0.z), 0).rgb;

            res = c000 * (1.0 - f.g) +
                  c010 * (f.g - f.r) +
                  c110 * (f.r - f.b) +
                  c111 * (f.b);
        }
    }

    return res;
}

fn apply_glow_bloom(
    color: vec3<f32>,
    blurred_color_input_space: vec3<f32>,
    amount: f32,
    is_raw: u32,
    exp: f32, bright: f32, con: f32, wh: f32
) -> vec3<f32> {
    if (amount <= 0.0) {
        return color;
    }

    var blurred_linear: vec3<f32>;
    if (is_raw == 1u) {
        blurred_linear = blurred_color_input_space;
    } else {
        blurred_linear = srgb_to_linear(blurred_color_input_space);
    }

    blurred_linear = apply_linear_exposure(blurred_linear, exp);
    blurred_linear = apply_filmic_exposure(blurred_linear, bright);
    blurred_linear = apply_tonal_adjustments(blurred_linear, 0.0, 0.0, is_raw, 0.0, 0.0, wh, 0.0);

    let linear_luma = get_luma(max(blurred_linear, vec3<f32>(0.0)));

    var perceptual_luma: f32;
    if (linear_luma <= 1.0) {
        perceptual_luma = pow(max(linear_luma, 0.0), 1.0 / 2.2);
    } else {
        perceptual_luma = 1.0 + pow(linear_luma - 1.0, 1.0 / 2.2);
    }

    let luma_cutoff = mix(0.75, 0.08, clamp(amount, 0.0, 1.0));

    let cutoff_fade = smoothstep(
        luma_cutoff,
        luma_cutoff + 0.15,
        perceptual_luma
    );

    let excess = max(perceptual_luma - luma_cutoff, 0.0);

    let falloff_range = 5.5;
    let normalized = excess / falloff_range;

    let bloom_intensity =
        pow(smoothstep(0.0, 1.0, normalized), 0.45);

    var bloom_color: vec3<f32>;
    if (linear_luma > 0.01) {
        let color_ratio = blurred_linear / linear_luma;
        let warm_tint = vec3<f32>(1.03, 1.0, 0.97);
        bloom_color = color_ratio * warm_tint;
    } else {
        bloom_color = vec3<f32>(1.0, 0.99, 0.98);
    }

    let luma_factor = pow(linear_luma, 0.6);

    let black_gate_width = 0.5;
    let black_gate_raw = smoothstep(0.0, black_gate_width, linear_luma);
    let black_gate = pow(black_gate_raw, 0.5);

    bloom_color *= bloom_intensity * luma_factor * cutoff_fade * black_gate;

    let current_luma = get_luma(max(color, vec3<f32>(0.0)));
    let protection = 1.0 - smoothstep(1.0, 2.2, current_luma);

    return color + bloom_color * amount * 3.8 * protection;
}

fn apply_halation(
    color: vec3<f32>,
    blurred_color_input_space: vec3<f32>,
    amount: f32,
    is_raw: u32,
    exp: f32, bright: f32, con: f32, wh: f32
) -> vec3<f32> {
    if (amount <= 0.0) { return color; }

    var blurred_linear: vec3<f32>;
    if (is_raw == 1u) {
        blurred_linear = blurred_color_input_space;
    } else {
        blurred_linear = srgb_to_linear(blurred_color_input_space);
    }

    blurred_linear = apply_linear_exposure(blurred_linear, exp);
    blurred_linear = apply_filmic_exposure(blurred_linear, bright);
    blurred_linear = apply_tonal_adjustments(blurred_linear, 0.0, 0.0, is_raw, 0.0, 0.0, wh, 0.0);

    let linear_luma = get_luma(max(blurred_linear, vec3<f32>(0.0)));

    var perceptual_luma: f32;
    if (linear_luma <= 1.0) {
        perceptual_luma = pow(max(linear_luma, 0.0), 1.0 / 2.2);
    } else {
        perceptual_luma = 1.0 + pow(linear_luma - 1.0, 1.0 / 2.2);
    }

    let luma_cutoff = mix(0.85, 0.1, clamp(amount, 0.0, 1.0));

    if (perceptual_luma <= luma_cutoff) { return color; }

    let excess = perceptual_luma - luma_cutoff;
    let range = max(1.5 - luma_cutoff, 0.1);
    let halation_mask = smoothstep(0.0, range * 0.6, excess);

    let halation_core = vec3<f32>(1.0, 0.15, 0.03);
    let halation_fringe = vec3<f32>(1.0, 0.32, 0.10);

    let intensity_blend = smoothstep(0.0, 0.7, halation_mask);
    let halation_tint = mix(halation_fringe, halation_core, intensity_blend);

    let glow_intensity = halation_mask * linear_luma;
    let halation_glow = halation_tint * glow_intensity;

    let color_luma = get_luma(max(color, vec3<f32>(0.0)));
    let desat_strength = halation_mask * 0.12;
    let affected_color = mix(color, vec3<f32>(color_luma), desat_strength);

    let contrast_reduced = mix(vec3<f32>(0.5), affected_color, 1.0 - halation_mask * 0.06);

    return contrast_reduced + halation_glow * amount * 2.5;
}

@compute @workgroup_size(8, 8, 1)
fn main(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>,
    @builtin(workgroup_id) group_id: vec3<u32>
) {
    const REFERENCE_DIMENSION: f32 = 1080.0;
    let full_dims = vec2<f32>(textureDimensions(input_texture));
    let current_ref_dim = min(full_dims.x, full_dims.y);
    let scale = max(0.1, current_ref_dim / REFERENCE_DIMENSION);

    if ((FEATURES & F_NOISE_REDUCTION) != 0u && nr_enabled()) {
        let group_origin = group_id.xy * 8u + vec2<u32>(adjustments.tile_offset_x, adjustments.tile_offset_y);
        let local_i = vec2<i32>(local_id.xy);
        nr_load_tile(local_i, vec2<i32>(group_origin), adjustments.global.exposure, adjustments.global.is_raw_image, scale);
        workgroupBarrier();
        nr_build_guide(local_i, scale);
        workgroupBarrier();
        nr_pack_guide(local_i, scale);
        workgroupBarrier();
        nr_build_coarse_guide(local_i, scale);
        workgroupBarrier();
    }

    let out_dims = vec2<u32>(textureDimensions(output_texture));
    if (id.x >= out_dims.x || id.y >= out_dims.y) { return; }

    let absolute_coord = id.xy + vec2<u32>(adjustments.tile_offset_x, adjustments.tile_offset_y);
    let absolute_coord_i = vec2<i32>(absolute_coord);

    let ca_rc = adjustments.global.chromatic_aberration_red_cyan;
    let ca_by = adjustments.global.chromatic_aberration_blue_yellow;
    var color_from_texture = textureLoad(input_texture, absolute_coord, 0).rgb;
    if (has_feature(F_CA) && (abs(ca_rc) > 0.000001 || abs(ca_by) > 0.000001)) {
        color_from_texture = apply_ca_correction(absolute_coord, ca_rc, ca_by);
    }
    let original_alpha = textureLoad(input_texture, absolute_coord, 0).a;

    var initial_linear_rgb: vec3<f32>;
    let is_raw = adjustments.global.is_raw_image;
    if (is_raw == 0u) {
        initial_linear_rgb = srgb_to_linear(color_from_texture);
    } else {
        initial_linear_rgb = color_from_texture;
    }

    var t_exposure = adjustments.global.exposure;
    var t_brightness = adjustments.global.brightness;
    var t_contrast = adjustments.global.contrast;
    var t_highlights = adjustments.global.highlights;
    var t_shadows = adjustments.global.shadows;
    var t_whites = adjustments.global.whites;
    var t_blacks = adjustments.global.blacks;
    var t_saturation = adjustments.global.saturation;
    var t_wb_log_gains = vec3<f32>(adjustments.global.wb_log_gain_l, adjustments.global.wb_log_gain_m, adjustments.global.wb_log_gain_s);
    var t_vibrance = adjustments.global.vibrance;
    var t_luma_nr = adjustments.global.luma_noise_reduction;
    var t_color_nr = adjustments.global.color_noise_reduction;
    var t_clarity = adjustments.global.clarity;
    var t_dehaze = adjustments.global.dehaze;
    var t_structure = adjustments.global.structure;
    var t_glow = adjustments.global.glow_amount;
    var t_halation = adjustments.global.halation_amount;
    var t_flare = adjustments.global.flare_amount;
    var t_sharpness = adjustments.global.sharpness;
    var t_sharp_thresh = adjustments.global.sharpness_threshold;
    var t_hue = adjustments.global.hue;

    var h0_h = adjustments.global.hsl[0].hue; var h0_s = adjustments.global.hsl[0].saturation; var h0_l = adjustments.global.hsl[0].luminance;
    var h1_h = adjustments.global.hsl[1].hue; var h1_s = adjustments.global.hsl[1].saturation; var h1_l = adjustments.global.hsl[1].luminance;
    var h2_h = adjustments.global.hsl[2].hue; var h2_s = adjustments.global.hsl[2].saturation; var h2_l = adjustments.global.hsl[2].luminance;
    var h3_h = adjustments.global.hsl[3].hue; var h3_s = adjustments.global.hsl[3].saturation; var h3_l = adjustments.global.hsl[3].luminance;
    var h4_h = adjustments.global.hsl[4].hue; var h4_s = adjustments.global.hsl[4].saturation; var h4_l = adjustments.global.hsl[4].luminance;
    var h5_h = adjustments.global.hsl[5].hue; var h5_s = adjustments.global.hsl[5].saturation; var h5_l = adjustments.global.hsl[5].luminance;
    var h6_h = adjustments.global.hsl[6].hue; var h6_s = adjustments.global.hsl[6].saturation; var h6_l = adjustments.global.hsl[6].luminance;
    var h7_h = adjustments.global.hsl[7].hue; var h7_s = adjustments.global.hsl[7].saturation; var h7_l = adjustments.global.hsl[7].luminance;

    for (var i = 0u; has_feature(F_MASKS) && i < adjustments.mask_count; i = i + 1u) {
        let influence = get_mask_influence(i, absolute_coord);
        if (influence > 0.001) {
            let m = adjustments.mask_adjustments[i];

            t_exposure += m.exposure * influence;
            t_brightness += m.brightness * influence;
            t_contrast += m.contrast * influence;
            t_highlights += m.highlights * influence;
            t_shadows += m.shadows * influence;
            t_whites += m.whites * influence;
            t_blacks += m.blacks * influence;

            t_saturation += m.saturation * influence;
            t_wb_log_gains += vec3<f32>(m.wb_log_gain_l, m.wb_log_gain_m, m.wb_log_gain_s) * influence;
            t_vibrance += m.vibrance * influence;

            t_luma_nr += m.luma_noise_reduction * influence;
            t_color_nr += m.color_noise_reduction * influence;
            t_clarity += m.clarity * influence;
            t_dehaze += m.dehaze * influence;
            t_structure += m.structure * influence;

            t_glow += m.glow_amount * influence;
            t_halation += m.halation_amount * influence;
            t_flare += m.flare_amount * influence;
            t_hue += m.hue * influence;
            t_sharpness += m.sharpness * influence;

            h0_h += m.hsl[0].hue * influence; h0_s += m.hsl[0].saturation * influence; h0_l += m.hsl[0].luminance * influence;
            h1_h += m.hsl[1].hue * influence; h1_s += m.hsl[1].saturation * influence; h1_l += m.hsl[1].luminance * influence;
            h2_h += m.hsl[2].hue * influence; h2_s += m.hsl[2].saturation * influence; h2_l += m.hsl[2].luminance * influence;
            h3_h += m.hsl[3].hue * influence; h3_s += m.hsl[3].saturation * influence; h3_l += m.hsl[3].luminance * influence;
            h4_h += m.hsl[4].hue * influence; h4_s += m.hsl[4].saturation * influence; h4_l += m.hsl[4].luminance * influence;
            h5_h += m.hsl[5].hue * influence; h5_s += m.hsl[5].saturation * influence; h5_l += m.hsl[5].luminance * influence;
            h6_h += m.hsl[6].hue * influence; h6_s += m.hsl[6].saturation * influence; h6_l += m.hsl[6].luminance * influence;
            h7_h += m.hsl[7].hue * influence; h7_s += m.hsl[7].saturation * influence; h7_l += m.hsl[7].luminance * influence;
        }
    }

    let final_hsl = array<HslColor, 8>(
        HslColor(h0_h, h0_s, h0_l, 0.0), HslColor(h1_h, h1_s, h1_l, 0.0),
        HslColor(h2_h, h2_s, h2_l, 0.0), HslColor(h3_h, h3_s, h3_l, 0.0),
        HslColor(h4_h, h4_s, h4_l, 0.0), HslColor(h5_h, h5_s, h5_l, 0.0),
        HslColor(h6_h, h6_s, h6_l, 0.0), HslColor(h7_h, h7_s, h7_l, 0.0)
    );

    if (has_feature(F_NOISE_REDUCTION)) {
        initial_linear_rgb = apply_noise_reduction(
            initial_linear_rgb, absolute_coord_i, vec2<i32>(local_id.xy),
            t_luma_nr, t_color_nr, scale, is_raw,
            t_exposure, adjustments.global.exposure
        );
    }

    let sharpness_blurred = textureLoad(sharpness_blur_texture, id.xy, 0).rgb;
    let tonal_blurred = textureLoad(tonal_blur_texture, id.xy, 0).rgb;
    let clarity_blurred = textureLoad(clarity_blur_texture, id.xy, 0).rgb;
    let structure_blurred = textureLoad(structure_blur_texture, id.xy, 0).rgb;

    var locally_contrasted_rgb = initial_linear_rgb;

    if (has_feature(F_SHARPEN)) {
        locally_contrasted_rgb = apply_sharpen(
            locally_contrasted_rgb,
            sharpness_blurred, tonal_blurred,
            absolute_coord_i, t_sharpness, t_sharp_thresh, is_raw
        );
    }

    let gf = sample_gf_coeffs(absolute_coord);
    let gf_luma = max(get_luma(max(locally_contrasted_rgb, vec3<f32>(0.0))), GF_LUMA_FLOOR);
    let gf_i = log2(gf_luma);
    let detail_clarity = gf_i - (gf.x * gf_i + gf.y);
    var detail_structure = 0.0;
    if (t_structure != 0.0) {
        let gf_s = sample_gf_tex(gf_structure_texture, absolute_coord).xy;
        detail_structure = gf_i - (gf_s.x * gf_i + gf_s.y);
    }

    var lc_gate = smoothstep(GF_NOISE_LO, GF_NOISE_HI, gf_luma);
    if (is_raw == 0u) {
        lc_gate *= 1.0 - smoothstep(0.9, 1.0, gf_luma);
    }

    let clarity_total = t_clarity + centre_clarity_strength(adjustments.global.centre, vec2<f32>(adjustments.global.centre_x, adjustments.global.centre_y), absolute_coord_i);
    let structure_smooth = clamp(-t_structure, 0.0, 1.0);
    let clarity_overlap = select(1.0, 1.0 - structure_smooth, clarity_total < 0.0);
    let clarity_term = shape_detail_gf(detail_clarity)
                       * clarity_total * clarity_overlap
                       * select(GF_NEG_GAIN, GF_CLARITY_GAIN, clarity_total > 0.0);
    let structure_term = shape_detail_gf(detail_structure)
                       * t_structure * select(GF_NEG_GAIN, GF_STRUCTURE_GAIN, t_structure > 0.0);

    let lc_log_gain = clarity_term * select(lc_gate, 1.0, clarity_total < 0.0)
                    + structure_term * select(lc_gate, 1.0, t_structure < 0.0);
    locally_contrasted_rgb *= exp2(lc_log_gain);

    if (has_feature(F_DEHAZE)) {
        let local_luma = exp2(gf.z * gf_i + gf.w);
        locally_contrasted_rgb = apply_dehaze(locally_contrasted_rgb, absolute_coord, local_luma, t_dehaze);
    }

    var processed_rgb = apply_linear_exposure(locally_contrasted_rgb, t_exposure);

    if (has_feature(F_GLOW_HALATION_FLARE) && t_glow > 0.0) {
        processed_rgb = apply_glow_bloom(
            processed_rgb, structure_blurred, t_glow, is_raw,
            t_exposure, t_brightness, t_contrast, t_whites
        );
    }
    if (has_feature(F_GLOW_HALATION_FLARE) && t_halation > 0.0) {
        processed_rgb = apply_halation(
            processed_rgb, clarity_blurred, t_halation, is_raw,
            t_exposure, t_brightness, t_contrast, t_whites
        );
    }
    if (has_feature(F_GLOW_HALATION_FLARE) && t_flare > 0.0) {
        let uv = vec2<f32>(absolute_coord) / full_dims;
        var flare_color = textureSampleLevel(flare_texture, flare_sampler, uv, 0.0).rgb;
        flare_color *= 1.4;
        flare_color = flare_color * flare_color;
        let linear_luma = get_luma(max(processed_rgb, vec3<f32>(0.0)));
        var perceptual_luma: f32;
        if (linear_luma <= 1.0) {
            perceptual_luma = pow(max(linear_luma, 0.0), 1.0 / 2.2);
        } else {
            perceptual_luma = 1.0 + pow(linear_luma - 1.0, 1.0 / 2.2);
        }
        let protection = 1.0 - smoothstep(0.7, 1.8, perceptual_luma);
        processed_rgb += flare_color * t_flare * protection;
    }

    var composite_rgb_linear = processed_rgb;
    composite_rgb_linear = apply_white_balance(composite_rgb_linear, t_wb_log_gains);
    composite_rgb_linear = apply_centre_tonal_and_color(composite_rgb_linear, adjustments.global.centre, vec2<f32>(adjustments.global.centre_x, adjustments.global.centre_y), absolute_coord_i);
    var tonal_log_detail = 0.0;
    var tonal_mid_detail = 0.0;
    if (t_shadows != 0.0 || t_blacks != 0.0 || t_highlights != 0.0 || t_whites != 0.0) {
        tonal_log_detail = (gf_i - (gf.z * gf_i + gf.w)) + lc_log_gain;
        let gf_broad = sample_gf_tex(gf_structure_texture, absolute_coord).xy;
        tonal_mid_detail = (gf.z * gf_i + gf.w) - (gf_broad.x * gf_i + gf_broad.y);
    }
    composite_rgb_linear = apply_tonal_adjustments(composite_rgb_linear, tonal_log_detail, tonal_mid_detail, is_raw, t_contrast, t_shadows, t_whites, t_blacks);
    composite_rgb_linear = apply_highlights_adjustment(composite_rgb_linear, tonal_log_detail, tonal_mid_detail, is_raw, t_highlights);
    let is_monochrome = has_feature(F_MONOCHROME) && adjustments.global.monochrome.enabled == 1u;
    if (is_monochrome) {
        composite_rgb_linear = apply_monochrome_mix(composite_rgb_linear, adjustments.global.monochrome, final_hsl);
    } else {
        composite_rgb_linear = apply_color_calibration(composite_rgb_linear, adjustments.global.color_calibration);
        if (has_feature(F_HSL)) {
            composite_rgb_linear = apply_hsl_panel(composite_rgb_linear, final_hsl, absolute_coord_i);
        }
        composite_rgb_linear = apply_hue_shift(composite_rgb_linear, t_hue);
        composite_rgb_linear = apply_creative_color(composite_rgb_linear, t_saturation, t_vibrance);
    }

    composite_rgb_linear = apply_color_grading(
        composite_rgb_linear,
        adjustments.global.color_grading_shadows,
        adjustments.global.color_grading_midtones,
        adjustments.global.color_grading_highlights,
        adjustments.global.color_grading_global,
        adjustments.global.color_grading_blending,
        adjustments.global.color_grading_balance
    );

    for (var i = 0u; has_feature(F_MASKS) && i < adjustments.mask_count; i = i + 1u) {
        let influence = get_mask_influence(i, absolute_coord);
        if (influence > 0.001) {
            let m = adjustments.mask_adjustments[i];
            let mask_graded = apply_color_grading(
                composite_rgb_linear,
                m.color_grading_shadows, m.color_grading_midtones, m.color_grading_highlights, m.color_grading_global, m.color_grading_blending, m.color_grading_balance
            );
            composite_rgb_linear = mix(composite_rgb_linear, mask_graded, influence);
        }
    }

    if (has_feature(F_VIGNETTE) && adjustments.global.vignette_amount != 0.0) {
        let full_dims_f = vec2<f32>(textureDimensions(input_texture));
        let coord_f = vec2<f32>(absolute_coord);
        let v_amount = adjustments.global.vignette_amount;
        let v_mid = adjustments.global.vignette_midpoint;
        let v_round = 1.0 - adjustments.global.vignette_roundness;
        let v_feather = adjustments.global.vignette_feather * 0.5;
        let aspect = full_dims_f.y / full_dims_f.x;
        let v_center = vec2<f32>(adjustments.global.vignette_center_x, adjustments.global.vignette_center_y);
        let uv_centered = (coord_f / full_dims_f - v_center) * 2.0;
        let uv_round = sign(uv_centered) * pow(abs(uv_centered), vec2<f32>(v_round, v_round));
        let d = length(uv_round * vec2<f32>(1.0, aspect)) * 0.5;
        let vignette_mask = smoothstep(v_mid - v_feather, v_mid + v_feather, d);
        if (v_amount < 0.0) {
            composite_rgb_linear *= (1.0 + v_amount * vignette_mask);
        } else {
            composite_rgb_linear = mix(composite_rgb_linear, vec3<f32>(1.0), v_amount * vignette_mask);
        }
    }

    var default_tonemapped: vec3<f32>;
    if (has_feature(F_AGX) && adjustments.global.tonemapper_mode == 1u) {
        default_tonemapped = agx_full_transform(composite_rgb_linear);
    } else if (is_raw == 1u) {
        var srgb_emulated = linear_to_srgb(composite_rgb_linear);
        const BRIGHTNESS_GAMMA: f32 = 1.1;
        srgb_emulated = pow(srgb_emulated, vec3<f32>(1.0 / BRIGHTNESS_GAMMA));
        const CONTRAST_MIX: f32 = 0.75;
        let contrast_curve = srgb_emulated * srgb_emulated * (3.0 - 2.0 * srgb_emulated);
        default_tonemapped = mix(srgb_emulated, contrast_curve, CONTRAST_MIX);
    } else {
        default_tonemapped = linear_to_srgb(composite_rgb_linear);
    }
    var base_srgb: vec3<f32>;
    let is_scene_lut = (has_feature(F_LUT) && adjustments.global.has_lut == 1u && adjustments.global.lut_is_scene_referred == 1u);

    if (is_scene_lut) {
        let vlog_encoded = linear_to_vlog(composite_rgb_linear);
        let lut_color = sample_lut_tetrahedral(vlog_encoded);
        base_srgb = mix(default_tonemapped, lut_color, adjustments.global.lut_intensity);
    } else {
        base_srgb = default_tonemapped;
    }

    base_srgb = apply_filmic_exposure(base_srgb, t_brightness);

    var final_rgb = apply_all_curves(base_srgb, CURVE_SRC_GLOBAL);

    for (var i = 0u; has_feature(F_MASKS) && i < adjustments.mask_count; i = i + 1u) {
        let influence = get_mask_influence(i, absolute_coord);
        if (influence > 0.001) {
            let mask_curved_srgb = apply_all_curves(final_rgb, i);
            final_rgb = mix(final_rgb, mask_curved_srgb, influence);
        }
    }

    if (is_monochrome) {
        final_rgb = apply_monochrome_toning(get_luma(final_rgb), adjustments.global.monochrome);
    }

    if (has_feature(F_LUT) && adjustments.global.has_lut == 1u && adjustments.global.lut_is_scene_referred == 0u) {
        let lut_color = sample_lut_tetrahedral(final_rgb);
        final_rgb = mix(final_rgb, lut_color, adjustments.global.lut_intensity);
    }

    if (has_feature(F_GRAIN) && adjustments.global.grain_amount > 0.0) {
        let coord = vec2<f32>(absolute_coord_i);
        let amount = adjustments.global.grain_amount * 0.5;
        let grain_frequency = (1.0 / max(adjustments.global.grain_size, 0.1)) / scale;
        let roughness = adjustments.global.grain_roughness;
        let luma = max(0.0, get_luma(final_rgb));
        let luma_mask = smoothstep(0.0, 0.15, luma) * (1.0 - smoothstep(0.6, 1.0, luma));
        let base_coord = coord * grain_frequency;
        let rough_coord = coord * grain_frequency * 0.6;
        let noise_base = gradient_noise(base_coord);
        let noise_rough = gradient_noise(rough_coord + vec2<f32>(5.2, 1.3));
        let noise_val = mix(noise_base, noise_rough, roughness);
        final_rgb += vec3<f32>(noise_val) * amount * luma_mask;
    }

    if (adjustments.global.show_clipping == 1u) {
        let HIGHLIGHT_WARNING_COLOR = vec3<f32>(1.0, 0.0, 0.0);
        let SHADOW_WARNING_COLOR = vec3<f32>(0.0, 0.0, 1.0);
        let HIGHLIGHT_CLIP_THRESHOLD = 0.998;
        let SHADOW_CLIP_THRESHOLD = 0.002;
        if (any(final_rgb > vec3<f32>(HIGHLIGHT_CLIP_THRESHOLD))) {
            final_rgb = HIGHLIGHT_WARNING_COLOR;
        } else if (any(final_rgb < vec3<f32>(SHADOW_CLIP_THRESHOLD))) {
            final_rgb = SHADOW_WARNING_COLOR;
        }
    }

    if (HIGH_PRECISION_OUTPUT == 0u) {
        let dither_amount = 1.0 / 255.0;
        final_rgb += dither(id.xy) * dither_amount;
    }

    textureStore(output_texture, id.xy, vec4<f32>(clamp(final_rgb, vec3<f32>(0.0), vec3<f32>(1.0)), original_alpha));
}
