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

struct GlobalAdjustments {
    exposure: f32,
    brightness: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    temperature: f32,
    tint: f32,
    vibrance: f32,

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
    _pad_lut2: f32,
    _pad_lut3: f32,
    _pad_lut4: f32,
    _pad_lut5: f32,

    _pad_agx1: f32,
    _pad_agx2: f32,
    _pad_agx3: f32,
    agx_pipe_to_rendering_matrix: mat3x3<f32>,
    agx_rendering_to_pipe_matrix: mat3x3<f32>,

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

    _pad_creative_1: f32,
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
    temperature: f32,
    tint: f32,
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
    _pad1: f32,

    _pad_cg1: f32,
    _pad_cg2: f32,
    _pad_cg3: f32,
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
    mask_adjustments: array<MaskAdjustments, 8>,
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
@group(0) @binding(2) var<uniform> adjustments: AllAdjustments;

@group(0) @binding(3) var mask0: texture_2d<f32>;
@group(0) @binding(4) var mask1: texture_2d<f32>;
@group(0) @binding(5) var mask2: texture_2d<f32>;
@group(0) @binding(6) var mask3: texture_2d<f32>;
@group(0) @binding(7) var mask4: texture_2d<f32>;
@group(0) @binding(8) var mask5: texture_2d<f32>;
@group(0) @binding(9) var mask6: texture_2d<f32>;
@group(0) @binding(10) var mask7: texture_2d<f32>;

@group(0) @binding(11) var lut_texture: texture_3d<f32>;
@group(0) @binding(12) var lut_sampler: sampler;

@group(0) @binding(13) var sharpness_blur_texture: texture_2d<f32>;
@group(0) @binding(14) var tonal_blur_texture: texture_2d<f32>;
@group(0) @binding(15) var clarity_blur_texture: texture_2d<f32>;
@group(0) @binding(16) var structure_blur_texture: texture_2d<f32>;

@group(0) @binding(17) var flare_texture: texture_2d<f32>;
@group(0) @binding(18) var flare_sampler: sampler;

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

fn apply_curve(val: f32, points: array<Point, 16>, count: u32) -> f32 {
    if (count < 2u) { return val; }
    var local_points = points;
    let x = val * 255.0;
    if (x <= local_points[0].x) { return local_points[0].y / 255.0; }
    if (x >= local_points[count - 1u].x) { return local_points[count - 1u].y / 255.0; }
    for (var i = 0u; i < 15u; i = i + 1u) {
        if (i >= count - 1u) { break; }
        let p1 = local_points[i];
        let p2 = local_points[i + 1u];
        if (x <= p2.x) {
            let p0 = local_points[max(0u, i - 1u)];
            let p3 = local_points[min(count - 1u, i + 2u)];
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
    return local_points[count - 1u].y / 255.0;
}

fn get_shadow_mult(luma: f32, sh: f32, bl: f32) -> f32 {
    var mult = 1.0;
    let safe_luma = max(luma, 0.0001);

    if (bl != 0.0) {
        let limit = 0.05;
        if (safe_luma < limit) {
            let x = safe_luma / limit;
            let mask = (1.0 - x) * (1.0 - x);
            let factor = min(exp2(bl * 0.75), 3.9);
            mult *= mix(1.0, factor, mask);
        }
    }
    if (sh != 0.0) {
        let limit = 0.1;
        if (safe_luma < limit) {
            let x = safe_luma / limit;
            let mask = (1.0 - x) * (1.0 - x);
            let factor = min(exp2(sh * 1.5), 3.9);
            mult *= mix(1.0, factor, mask);
        }
    }
    return mult;
}

fn apply_tonal_adjustments(
    color: vec3<f32>,
    blurred_color_input_space: vec3<f32>,
    is_raw: u32,
    con: f32,
    sh: f32,
    wh: f32,
    bl: f32
) -> vec3<f32> {
    var rgb = color;

    var blurred_linear: vec3<f32>;
    if (is_raw == 1u) {
        blurred_linear = blurred_color_input_space;
    } else {
        blurred_linear = srgb_to_linear(blurred_color_input_space);
    }

    if (wh != 0.0) {
        let white_level = 1.0 - wh * 0.25;
        let w_mult = 1.0 / max(white_level, 0.01);
        rgb *= w_mult;
        blurred_linear *= w_mult;
    }

    let pixel_luma = get_luma(max(rgb, vec3<f32>(0.0)));
    let blurred_luma = get_luma(max(blurred_linear, vec3<f32>(0.0)));

    let safe_pixel_luma = max(pixel_luma, 0.0001);
    let safe_blurred_luma = max(blurred_luma, 0.0001);

    let perc_pixel = pow(safe_pixel_luma, 0.5);
    let perc_blurred = pow(safe_blurred_luma, 0.5);
    let edge_diff = abs(perc_pixel - perc_blurred);
    let halo_protection = smoothstep(0.05, 0.25, edge_diff);

    if (sh != 0.0 || bl != 0.0) {
        let spatial_mult = get_shadow_mult(safe_blurred_luma, sh, bl);
        let pixel_mult   = get_shadow_mult(safe_pixel_luma, sh, bl);

        let final_mult = mix(spatial_mult, pixel_mult, halo_protection);
        rgb *= final_mult;
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
    blurred_color_input_space: vec3<f32>,
    is_raw: u32,
    highlights_adj: f32
) -> vec3<f32> {
    if (highlights_adj == 0.0) { return color_in; }

    let pixel_luma = get_luma(max(color_in, vec3<f32>(0.0)));
    let safe_pixel_luma = max(pixel_luma, 0.0001);

    let pixel_mask_input = tanh(safe_pixel_luma * 1.5);
    let highlight_mask = smoothstep(0.3, 0.95, pixel_mask_input);

    if (highlight_mask < 0.001) {
        return color_in;
    }

    let luma = pixel_luma;
    var final_adjusted_color: vec3<f32>;

    if (highlights_adj < 0.0) {
        var new_luma: f32;
        if (luma <= 1.0) {
            let gamma = 1.0 - highlights_adj * 1.75;
            new_luma = pow(luma, gamma);
        } else {
            let luma_excess = luma - 1.0;
            let compression_strength = -highlights_adj * 6.0;
            let compressed_excess = luma_excess / (1.0 + luma_excess * compression_strength);
            new_luma = 1.0 + compressed_excess;
        }
        let tonally_adjusted_color = color_in * (new_luma / max(luma, 0.0001));
        let desaturation_amount = smoothstep(1.0, 10.0, luma);
        let white_point = vec3<f32>(new_luma);
        final_adjusted_color = mix(tonally_adjusted_color, white_point, desaturation_amount);
    } else {
        let adjustment = highlights_adj * 1.75;
        let factor = pow(2.0, adjustment);
        final_adjusted_color = color_in * factor;
    }

    return mix(color_in, final_adjusted_color, highlight_mask);
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
    const RATIONAL_CURVE_MIX: f32 = 0.95;
    const MIDTONE_STRENGTH: f32 = 1.2;
    let original_luma = get_luma(color_in);
    if (abs(original_luma) < 0.00001) {
        return color_in;
    }
    let direct_adj = brightness_adj * (1.0 - RATIONAL_CURVE_MIX);
    let rational_adj = brightness_adj * RATIONAL_CURVE_MIX;
    let scale = pow(2.0, direct_adj);
    let k = pow(2.0, -rational_adj * MIDTONE_STRENGTH);
    let luma_abs = abs(original_luma);
    let luma_floor = floor(luma_abs);
    let luma_fract = luma_abs - luma_floor;
    let shaped_fract = luma_fract / (luma_fract + (1.0 - luma_fract) * k);
    let shaped_luma_abs = luma_floor + shaped_fract;
    let new_luma = sign(original_luma) * shaped_luma_abs * scale;
    let chroma = color_in - vec3<f32>(original_luma);
    let total_luma_scale = new_luma / original_luma;
    let chroma_scale = pow(total_luma_scale, 0.8);
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

fn apply_white_balance(color: vec3<f32>, temp: f32, tnt: f32) -> vec3<f32> {
    var rgb = color;
    let temp_kelvin_mult = vec3<f32>(1.0 + temp * 0.2, 1.0 + temp * 0.05, 1.0 - temp * 0.2);
    let tint_mult = vec3<f32>(1.0 + tnt * 0.25, 1.0 - tnt * 0.25, 1.0 + tnt * 0.25);
    rgb *= temp_kelvin_mult * tint_mult;
    return rgb;
}

fn apply_creative_color(color: vec3<f32>, sat: f32, vib: f32) -> vec3<f32> {
    var processed = color;
    let luma = get_luma(processed);

    if (sat != 0.0) {
        processed = mix(vec3<f32>(luma), processed, 1.0 + sat);
    }
    if (vib == 0.0) { return processed; }
    let c_max = max(processed.r, max(processed.g, processed.b));
    let c_min = min(processed.r, min(processed.g, processed.b));
    let delta = c_max - c_min;
    if (delta < 0.02) {
        return processed;
    }
    let current_sat = delta / max(c_max, 0.001);
    if (vib > 0.0) {
        let sat_mask = 1.0 - smoothstep(0.4, 0.9, current_sat);
        let hsv = rgb_to_hsv(processed);
        let hue = hsv.x;
        let skin_center = 25.0;
        let hue_dist = min(abs(hue - skin_center), 360.0 - abs(hue - skin_center));
        let is_skin = smoothstep(35.0, 10.0, hue_dist);
        let skin_dampener = mix(1.0, 0.6, is_skin);
        let amount = vib * sat_mask * skin_dampener * 3.0;
        processed = mix(vec3<f32>(luma), processed, 1.0 + amount);
    } else {
        let desat_mask = 1.0 - smoothstep(0.2, 0.8, current_sat);
        let amount = vib * desat_mask;
        processed = mix(vec3<f32>(luma), processed, 1.0 + amount);
    }
    return processed;
}

fn apply_hsl_panel(color: vec3<f32>, hsl_adjustments: array<HslColor, 8>, coords_i: vec2<i32>) -> vec3<f32> {
    let safe_color = max(color, vec3<f32>(0.0));
    if (distance(safe_color.r, safe_color.g) < 0.001 && distance(safe_color.g, safe_color.b) < 0.001) {
        return safe_color;
    }
    let original_hsv = rgb_to_hsv(safe_color);
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
    let hs_shifted_rgb = hsv_to_rgb(vec3<f32>(hsv.x, hsv.y, original_hsv.z));
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
    let shadow_sat_strength = 0.3;
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

fn apply_local_contrast(
    processed_color_linear: vec3<f32>,
    blurred_color_input_space: vec3<f32>,
    amount: f32,
    is_raw: u32,
    mode: u32
) -> vec3<f32> {
    if (amount == 0.0) {
        return processed_color_linear;
    }

    let center_luma = get_luma(processed_color_linear);

    let shadow_threshold = select(0.03, 0.1, is_raw == 1u);
    let shadow_protection = smoothstep(0.0, shadow_threshold, center_luma);
    let highlight_protection = 1.0 - smoothstep(0.9, 1.0, center_luma);
    let midtone_mask = shadow_protection * highlight_protection;

    if (midtone_mask < 0.001) {
        return processed_color_linear;
    }

    var blurred_color_linear: vec3<f32>;
    if (is_raw == 1u) {
        blurred_color_linear = blurred_color_input_space;
    } else {
        blurred_color_linear = srgb_to_linear(blurred_color_input_space);
    }

    let blurred_luma = get_luma(blurred_color_linear);
    let safe_center_luma = max(center_luma, 0.0001);
    let safe_blurred_luma = max(blurred_luma, 0.0001);

    var final_color: vec3<f32>;

    if (amount < 0.0) {
        let blurred_color_projected = processed_color_linear * (safe_blurred_luma / safe_center_luma);
        var blur_amount = -amount;
        if (mode == 0u) {
            blur_amount = blur_amount * 0.5;
        }
        final_color = mix(processed_color_linear, blurred_color_projected, blur_amount);
    } else {
        let log_ratio = log2(safe_center_luma / safe_blurred_luma);

        var effective_amount = amount;

        if (mode == 0u) {
            let edge_magnitude = abs(log_ratio);
            let normalized_edge = clamp(edge_magnitude / 3.0, 0.0, 1.0);
            let edge_dampener = 1.0 - pow(normalized_edge, 0.5);

            effective_amount = amount * edge_dampener * 0.8;
        }
        else {
            effective_amount = amount;
        }

        let contrast_factor = exp2(log_ratio * effective_amount);
        final_color = processed_color_linear * contrast_factor;
    }

    return mix(processed_color_linear, final_color, midtone_mask);
}

fn apply_centre_local_contrast(
    color_in: vec3<f32>,
    centre_amount: f32,
    coords_i: vec2<i32>,
    blurred_color_srgb: vec3<f32>,
    is_raw: u32
) -> vec3<f32> {
    if (centre_amount == 0.0) {
        return color_in;
    }
    let full_dims_f = vec2<f32>(textureDimensions(input_texture));
    let coord_f = vec2<f32>(coords_i);
    let midpoint = 0.4;
    let feather = 0.375;
    let aspect = full_dims_f.y / full_dims_f.x;
    let uv_centered = (coord_f / full_dims_f - 0.5) * 2.0;
    let d = length(uv_centered * vec2<f32>(1.0, aspect)) * 0.5;
    let vignette_mask = smoothstep(midpoint - feather, midpoint + feather, d);
    let centre_mask = 1.0 - vignette_mask;

    const CLARITY_SCALE: f32 = 0.9;
    var processed_color = color_in;
    let clarity_strength = centre_amount * (2.0 * centre_mask - 1.0) * CLARITY_SCALE;

    if (abs(clarity_strength) > 0.001) {
        processed_color = apply_local_contrast(processed_color, blurred_color_srgb, clarity_strength, is_raw, 1u);
    }

    return processed_color;
}

fn apply_centre_tonal_and_color(
    color_in: vec3<f32>,
    centre_amount: f32,
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
    let uv_centered = (coord_f / full_dims_f - 0.5) * 2.0;
    let d = length(uv_centered * vec2<f32>(1.0, aspect)) * 0.5;
    let vignette_mask = smoothstep(midpoint - feather, midpoint + feather, d);
    let centre_mask = 1.0 - vignette_mask;

    const EXPOSURE_SCALE: f32 = 0.5;
    const VIBRANCE_SCALE: f32 = 0.4;
    const SATURATION_CENTER_SCALE: f32 = 0.3;
    const SATURATION_EDGE_SCALE: f32 = 0.8;

    var processed_color = color_in;

    let exposure_boost = centre_mask * centre_amount * EXPOSURE_SCALE;
    processed_color = apply_filmic_exposure(processed_color, exposure_boost);

    let vibrance_center_boost = centre_mask * centre_amount * VIBRANCE_SCALE;
    let saturation_center_boost = centre_mask * centre_amount * SATURATION_CENTER_SCALE;
    let saturation_edge_effect = -(1.0 - centre_mask) * centre_amount * SATURATION_EDGE_SCALE;
    let total_saturation_effect = saturation_center_boost + saturation_edge_effect;
    processed_color = apply_creative_color(processed_color, total_saturation_effect, vibrance_center_boost);

    return processed_color;
}

fn apply_dehaze(color: vec3<f32>, blurred_color_input_space: vec3<f32>, is_raw: u32, amount: f32) -> vec3<f32> {
    if (amount == 0.0) { return color; }

    var blurred_linear: vec3<f32>;
    if (is_raw == 1u) {
        blurred_linear = blurred_color_input_space;
    } else {
        blurred_linear = srgb_to_linear(blurred_color_input_space);
    }

    let atmospheric_light = vec3<f32>(0.95, 0.97, 1.0);

    if (amount > 0.0) {
        let pixel_dark = min(color.r, min(color.g, color.b));
        let regional_dark = min(blurred_linear.r, min(blurred_linear.g, blurred_linear.b));
        let pixel_luma = get_luma(max(color, vec3<f32>(0.0)));
        let blurred_luma = get_luma(max(blurred_linear, vec3<f32>(0.0)));
        let edge_diff = abs(pow(pixel_luma, 0.5) - pow(blurred_luma, 0.5));
        let halo_protection = smoothstep(0.02, 0.15, edge_diff);
        let spatial_dark = mix(regional_dark, pixel_dark, halo_protection);
        let safe_dark = max(spatial_dark - 0.02, 0.0);
        let mapped_haze = safe_dark / (safe_dark + 0.2);
        let t = max(1.0 - amount * mapped_haze * 0.85, 0.15);
        var recovered = (color - atmospheric_light) / t + atmospheric_light;
        let rec_luma = get_luma(max(recovered, vec3<f32>(0.0)));
        let shadow_lift = smoothstep(0.1, 0.0, rec_luma) * (1.0 - t) * 0.15;
        recovered += shadow_lift;
        let haze_removed = 1.0 - t;
        let sat_boost = haze_removed * 0.5;
        let final_luma = get_luma(max(recovered, vec3<f32>(0.0)));
        recovered = mix(vec3<f32>(final_luma), recovered, 1.0 + sat_boost);
        return max(recovered, vec3<f32>(0.0));
    } else {
        let regional_dark = min(blurred_linear.r, min(blurred_linear.g, blurred_linear.b));
        let safe_dark = max(regional_dark - 0.02, 0.0);
        let mapped_depth = safe_dark / (safe_dark + 0.2);
        let depth_factor = mix(0.4, 1.0, mapped_depth);
        return mix(color, atmospheric_light, abs(amount) * 0.7 * depth_factor);
    }
}

fn apply_noise_reduction(color: vec3<f32>, coords_i: vec2<i32>, luma_amount: f32, color_amount: f32, scale: f32) -> vec3<f32> {
    if (luma_amount <= 100.0 && color_amount <= 100.0) { return color; } // temporarily disable NR for now

    let luma_threshold = 0.1 / scale;
    let color_threshold = 0.2 / scale;

    var accum_color = vec3<f32>(0.0);
    var total_weight = 0.0;
    let center_luma = get_luma(color);
    let max_coords = vec2<i32>(textureDimensions(input_texture) - 1u);
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            let offset = vec2<i32>(x, y);
            let sample_coords = clamp(coords_i + offset, vec2<i32>(0), max_coords);
            let sample_color_linear = srgb_to_linear(textureLoad(input_texture, vec2<u32>(sample_coords), 0).rgb);
            var luma_weight = 1.0;
            if (luma_amount > 0.0) {
                let luma_diff = abs(get_luma(sample_color_linear) - center_luma);
                luma_weight = 1.0 - smoothstep(0.0, luma_threshold, luma_diff / luma_amount);
            }
            var color_weight = 1.0;
            if (color_amount > 0.0) {
                let color_diff = distance(sample_color_linear, color);
                color_weight = 1.0 - smoothstep(0.0, color_threshold, color_diff / color_amount);
            }
            let weight = luma_weight * color_weight;
            accum_color += sample_color_linear * weight;
            total_weight += weight;
        }
    }
    if (total_weight > 0.0) { return accum_color / total_weight; }
    return color;
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

fn is_default_curve(points: array<Point, 16>, count: u32) -> bool {
    if (count != 2u) {
        return false;
    }
    let p0 = points[0];
    let p1 = points[1];

    let p0_is_origin = abs(p0.x - 0.0) < 0.1 && abs(p0.y - 0.0) < 0.1;
    let p1_is_end = abs(p1.x - 255.0) < 0.1 && abs(p1.y - 255.0) < 0.1;

    return p0_is_origin && p1_is_end;
}

fn apply_all_curves(color: vec3<f32>, luma_curve: array<Point, 16>, luma_curve_count: u32, red_curve: array<Point, 16>, red_curve_count: u32, green_curve: array<Point, 16>, green_curve_count: u32, blue_curve: array<Point, 16>, blue_curve_count: u32) -> vec3<f32> {
    let red_is_default = is_default_curve(red_curve, red_curve_count);
    let green_is_default = is_default_curve(green_curve, green_curve_count);
    let blue_is_default = is_default_curve(blue_curve, blue_curve_count);
    let rgb_curves_are_active = !red_is_default || !green_is_default || !blue_is_default;

    if (rgb_curves_are_active) {
        let color_graded = vec3<f32>(apply_curve(color.r, red_curve, red_curve_count), apply_curve(color.g, green_curve, green_curve_count), apply_curve(color.b, blue_curve, blue_curve_count));
        let luma_initial = get_luma(color);
        let luma_target = apply_curve(luma_initial, luma_curve, luma_curve_count);
        let luma_graded = get_luma(color_graded);
        var final_color: vec3<f32>;
        if (luma_graded > 0.001) { final_color = color_graded * (luma_target / luma_graded); } else { final_color = vec3<f32>(luma_target); }
        let max_comp = max(final_color.r, max(final_color.g, final_color.b));
        if (max_comp > 1.0) { final_color = final_color / max_comp; }
        return final_color;
    } else {
        return vec3<f32>(apply_curve(color.r, luma_curve, luma_curve_count), apply_curve(color.g, luma_curve, luma_curve_count), apply_curve(color.b, luma_curve, luma_curve_count));
    }
}

fn apply_all_adjustments(
    initial_rgb: vec3<f32>,
    adj: GlobalAdjustments,
    coords_i: vec2<i32>,
    id: vec2<u32>,
    scale: f32,
    tonal_blurred: vec3<f32>,
    structure_blurred: vec3<f32>,
    is_raw: u32
) -> vec3<f32> {
    var processed_rgb = apply_noise_reduction(initial_rgb, coords_i, adj.luma_noise_reduction, adj.color_noise_reduction, scale);

    processed_rgb = apply_dehaze(processed_rgb, structure_blurred, is_raw, adj.dehaze);
    processed_rgb = apply_centre_tonal_and_color(processed_rgb, adj.centre, coords_i);
    processed_rgb = apply_white_balance(processed_rgb, adj.temperature, adj.tint);
    processed_rgb = apply_filmic_exposure(processed_rgb, adj.brightness);
    processed_rgb = apply_tonal_adjustments(processed_rgb, tonal_blurred, is_raw, adj.contrast, adj.shadows, adj.whites, adj.blacks);
    processed_rgb = apply_highlights_adjustment(processed_rgb, tonal_blurred, is_raw, adj.highlights);

    processed_rgb = apply_color_calibration(processed_rgb, adj.color_calibration);
    processed_rgb = apply_hsl_panel(processed_rgb, adj.hsl, coords_i);
    processed_rgb = apply_creative_color(processed_rgb, adj.saturation, adj.vibrance);

    return processed_rgb;
}

fn apply_all_mask_adjustments(
    initial_rgb: vec3<f32>,
    adj: MaskAdjustments,
    coords_i: vec2<i32>,
    id: vec2<u32>,
    scale: f32,
    is_raw: u32,
    tonemapper_mode: u32,
    tonal_blurred: vec3<f32>,
    structure_blurred: vec3<f32>
) -> vec3<f32> {
    var processed_rgb = apply_noise_reduction(initial_rgb, coords_i, adj.luma_noise_reduction, adj.color_noise_reduction, scale);

    processed_rgb = apply_dehaze(processed_rgb, structure_blurred, is_raw, adj.dehaze);
    processed_rgb = apply_linear_exposure(processed_rgb, adj.exposure);
    processed_rgb = apply_white_balance(processed_rgb, adj.temperature, adj.tint);
    processed_rgb = apply_filmic_exposure(processed_rgb, adj.brightness);
    processed_rgb = apply_highlights_adjustment(processed_rgb, tonal_blurred, is_raw, adj.highlights);
    processed_rgb = apply_tonal_adjustments(processed_rgb, tonal_blurred, is_raw, adj.contrast, adj.shadows, adj.whites, adj.blacks);

    processed_rgb = apply_hsl_panel(processed_rgb, adj.hsl, coords_i);
    processed_rgb = apply_color_grading(processed_rgb, adj.color_grading_shadows, adj.color_grading_midtones, adj.color_grading_highlights, adj.color_grading_global, adj.color_grading_blending, adj.color_grading_balance);
    processed_rgb = apply_creative_color(processed_rgb, adj.saturation, adj.vibrance);

    return processed_rgb;
}

fn get_mask_influence(mask_index: u32, coords: vec2<u32>) -> f32 {
    switch (mask_index) {
        case 0u: { return textureLoad(mask0, coords, 0).r; }
        case 1u: { return textureLoad(mask1, coords, 0).r; }
        case 2u: { return textureLoad(mask2, coords, 0).r; }
        case 3u: { return textureLoad(mask3, coords, 0).r; }
        case 4u: { return textureLoad(mask4, coords, 0).r; }
        case 5u: { return textureLoad(mask5, coords, 0).r; }
        case 6u: { return textureLoad(mask6, coords, 0).r; }
        case 7u: { return textureLoad(mask7, coords, 0).r; }
        default: { return 0.0; }
    }
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
    blurred_linear = apply_tonal_adjustments(blurred_linear, blurred_color_input_space, is_raw, 0.0, 0.0, wh, 0.0);

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
    blurred_linear = apply_tonal_adjustments(blurred_linear, blurred_color_input_space, is_raw, 0.0, 0.0, wh, 0.0);

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

fn scale_mask_adjustments(adj: MaskAdjustments, influence: f32) -> MaskAdjustments {
    var scaled = adj;

    scaled.exposure *= influence;
    scaled.brightness *= influence;
    scaled.contrast *= influence;
    scaled.highlights *= influence;
    scaled.shadows *= influence;
    scaled.whites *= influence;
    scaled.blacks *= influence;

    scaled.saturation *= influence;
    scaled.temperature *= influence;
    scaled.tint *= influence;
    scaled.vibrance *= influence;

    scaled.sharpness *= influence;
    scaled.luma_noise_reduction *= influence;
    scaled.color_noise_reduction *= influence;
    scaled.clarity *= influence;
    scaled.dehaze *= influence;
    scaled.structure *= influence;

    scaled.glow_amount *= influence;
    scaled.halation_amount *= influence;
    scaled.flare_amount *= influence;

    scaled.color_grading_shadows.saturation *= influence;
    scaled.color_grading_shadows.luminance *= influence;

    scaled.color_grading_midtones.saturation *= influence;
    scaled.color_grading_midtones.luminance *= influence;

    scaled.color_grading_highlights.saturation *= influence;
    scaled.color_grading_highlights.luminance *= influence;

    scaled.color_grading_global.saturation *= influence;
    scaled.color_grading_global.luminance *= influence;

    for (var i = 0u; i < 8u; i = i + 1u) {
        scaled.hsl[i].hue *= influence;
        scaled.hsl[i].saturation *= influence;
        scaled.hsl[i].luminance *= influence;
    }

    return scaled;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let out_dims = vec2<u32>(textureDimensions(output_texture));
    if (id.x >= out_dims.x || id.y >= out_dims.y) { return; }

    const REFERENCE_DIMENSION: f32 = 1080.0;
    let full_dims = vec2<f32>(textureDimensions(input_texture));
    let current_ref_dim = min(full_dims.x, full_dims.y);
    let scale = max(0.1, current_ref_dim / REFERENCE_DIMENSION);

    let absolute_coord = id.xy + vec2<u32>(adjustments.tile_offset_x, adjustments.tile_offset_y);
    let absolute_coord_i = vec2<i32>(absolute_coord);

    let ca_rc = adjustments.global.chromatic_aberration_red_cyan;
    let ca_by = adjustments.global.chromatic_aberration_blue_yellow;
    var color_from_texture = textureLoad(input_texture, absolute_coord, 0).rgb;
    if (abs(ca_rc) > 0.000001 || abs(ca_by) > 0.000001) {
        color_from_texture = apply_ca_correction(absolute_coord, ca_rc, ca_by);
    }
    let original_alpha = textureLoad(input_texture, absolute_coord, 0).a;

    var initial_linear_rgb: vec3<f32>;
    if (adjustments.global.is_raw_image == 0u) {
        initial_linear_rgb = srgb_to_linear(color_from_texture);
    } else {
        initial_linear_rgb = color_from_texture;
    }

    let sharpness_blurred = textureLoad(sharpness_blur_texture, id.xy, 0).rgb;
    let tonal_blurred = textureLoad(tonal_blur_texture, id.xy, 0).rgb;
    let clarity_blurred = textureLoad(clarity_blur_texture, id.xy, 0).rgb;
    let structure_blurred = textureLoad(structure_blur_texture, id.xy, 0).rgb;

    var locally_contrasted_rgb = initial_linear_rgb;
    locally_contrasted_rgb = apply_local_contrast(locally_contrasted_rgb, sharpness_blurred, adjustments.global.sharpness, adjustments.global.is_raw_image, 0u);
    locally_contrasted_rgb = apply_local_contrast(locally_contrasted_rgb, clarity_blurred, adjustments.global.clarity, adjustments.global.is_raw_image, 1u);
    locally_contrasted_rgb = apply_local_contrast(locally_contrasted_rgb, structure_blurred, adjustments.global.structure, adjustments.global.is_raw_image, 1u);
    locally_contrasted_rgb = apply_centre_local_contrast(locally_contrasted_rgb, adjustments.global.centre, absolute_coord_i, clarity_blurred, adjustments.global.is_raw_image);

    for (var i = 0u; i < adjustments.mask_count; i = i + 1u) {
        let influence = get_mask_influence(i, absolute_coord);
        if (influence > 0.001) {
            let mask_adj = adjustments.mask_adjustments[i];
            locally_contrasted_rgb = apply_local_contrast(locally_contrasted_rgb, sharpness_blurred, mask_adj.sharpness * influence, adjustments.global.is_raw_image, 0u);
            locally_contrasted_rgb = apply_local_contrast(locally_contrasted_rgb, clarity_blurred, mask_adj.clarity * influence, adjustments.global.is_raw_image, 1u);
            locally_contrasted_rgb = apply_local_contrast(locally_contrasted_rgb, structure_blurred, mask_adj.structure * influence, adjustments.global.is_raw_image, 1u);
        }
    }

    var processed_rgb = apply_linear_exposure(locally_contrasted_rgb, adjustments.global.exposure);

    if (adjustments.global.glow_amount > 0.0) {
        processed_rgb = apply_glow_bloom(
            processed_rgb,
            structure_blurred,
            adjustments.global.glow_amount,
            adjustments.global.is_raw_image,
            adjustments.global.exposure, adjustments.global.brightness, adjustments.global.contrast, adjustments.global.whites
        );
    }
    if (adjustments.global.halation_amount > 0.0) {
        processed_rgb = apply_halation(
            processed_rgb,
            clarity_blurred,
            adjustments.global.halation_amount,
            adjustments.global.is_raw_image,
            adjustments.global.exposure, adjustments.global.brightness, adjustments.global.contrast, adjustments.global.whites
        );
    }
    if (adjustments.global.flare_amount > 0.0) {
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
        processed_rgb += flare_color * adjustments.global.flare_amount * protection;
    }

    let globally_adjusted_linear = apply_all_adjustments(
        processed_rgb,
        adjustments.global,
        absolute_coord_i,
        id.xy,
        scale,
        tonal_blurred,
        structure_blurred,
        adjustments.global.is_raw_image
    );
    var composite_rgb_linear = globally_adjusted_linear;

    for (var i = 0u; i < adjustments.mask_count; i = i + 1u) {
        let influence = get_mask_influence(i, absolute_coord);
        if (influence > 0.001) {
            let mask_adj = adjustments.mask_adjustments[i];
            let scaled_adj = scale_mask_adjustments(mask_adj, influence);

            if (scaled_adj.glow_amount > 0.0) {
                composite_rgb_linear = apply_glow_bloom(
                    composite_rgb_linear,
                    structure_blurred,
                    scaled_adj.glow_amount,
                    adjustments.global.is_raw_image,
                    adjustments.global.exposure + scaled_adj.exposure,
                    adjustments.global.brightness + scaled_adj.brightness,
                    adjustments.global.contrast + scaled_adj.contrast,
                    adjustments.global.whites + scaled_adj.whites
                );
            }
            if (scaled_adj.halation_amount > 0.0) {
                composite_rgb_linear = apply_halation(
                    composite_rgb_linear,
                    clarity_blurred,
                    scaled_adj.halation_amount,
                    adjustments.global.is_raw_image,
                    adjustments.global.exposure + scaled_adj.exposure,
                    adjustments.global.brightness + scaled_adj.brightness,
                    adjustments.global.contrast + scaled_adj.contrast,
                    adjustments.global.whites + scaled_adj.whites
                );
            }

            composite_rgb_linear = apply_all_mask_adjustments(
                composite_rgb_linear,
                scaled_adj,
                absolute_coord_i,
                id.xy,
                scale,
                adjustments.global.is_raw_image,
                adjustments.global.tonemapper_mode,
                tonal_blurred,
                structure_blurred
            );
        }
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

    let g = adjustments.global;
    if (g.vignette_amount != 0.0) {
        let full_dims_f = vec2<f32>(textureDimensions(input_texture));
        let coord_f = vec2<f32>(absolute_coord);
        let v_amount = g.vignette_amount;
        let v_mid = g.vignette_midpoint;
        let v_round = 1.0 - g.vignette_roundness;
        let v_feather = g.vignette_feather * 0.5;
        let aspect = full_dims_f.y / full_dims_f.x;
        let uv_centered = (coord_f / full_dims_f - 0.5) * 2.0;
        let uv_round = sign(uv_centered) * pow(abs(uv_centered), vec2<f32>(v_round, v_round));
        let d = length(uv_round * vec2<f32>(1.0, aspect)) * 0.5;
        let vignette_mask = smoothstep(v_mid - v_feather, v_mid + v_feather, d);
        if (v_amount < 0.0) {
            composite_rgb_linear *= (1.0 + v_amount * vignette_mask);
        } else {
            composite_rgb_linear = mix(composite_rgb_linear, vec3<f32>(1.0), v_amount * vignette_mask);
        }
    }

    var base_srgb: vec3<f32>;
    if (adjustments.global.tonemapper_mode == 1u) {
        base_srgb = agx_full_transform(composite_rgb_linear);
    } else if (adjustments.global.is_raw_image == 1u) {
        var srgb_emulated = linear_to_srgb(composite_rgb_linear);
        const BRIGHTNESS_GAMMA: f32 = 1.1;
        srgb_emulated = pow(srgb_emulated, vec3<f32>(1.0 / BRIGHTNESS_GAMMA));
        const CONTRAST_MIX: f32 = 0.75;
        let contrast_curve = srgb_emulated * srgb_emulated * (3.0 - 2.0 * srgb_emulated);
        base_srgb = mix(srgb_emulated, contrast_curve, CONTRAST_MIX);
    } else {
        base_srgb = linear_to_srgb(composite_rgb_linear);
    }

    var final_rgb = apply_all_curves(base_srgb,
        adjustments.global.luma_curve, adjustments.global.luma_curve_count,
        adjustments.global.red_curve, adjustments.global.red_curve_count,
        adjustments.global.green_curve, adjustments.global.green_curve_count,
        adjustments.global.blue_curve, adjustments.global.blue_curve_count
    );

    for (var i = 0u; i < adjustments.mask_count; i = i + 1u) {
        let influence = get_mask_influence(i, absolute_coord);
        if (influence > 0.001) {
            let mask_curved_srgb = apply_all_curves(final_rgb,
                adjustments.mask_adjustments[i].luma_curve, adjustments.mask_adjustments[i].luma_curve_count,
                adjustments.mask_adjustments[i].red_curve, adjustments.mask_adjustments[i].red_curve_count,
                adjustments.mask_adjustments[i].green_curve, adjustments.mask_adjustments[i].green_curve_count,
                adjustments.mask_adjustments[i].blue_curve, adjustments.mask_adjustments[i].blue_curve_count
            );
            final_rgb = mix(final_rgb, mask_curved_srgb, influence);
        }
    }

    if (adjustments.global.has_lut == 1u) {
        let lut_color = sample_lut_tetrahedral(final_rgb);
        final_rgb = mix(final_rgb, lut_color, adjustments.global.lut_intensity);
    }

    if (adjustments.global.grain_amount > 0.0) {
        let g = adjustments.global;
        let coord = vec2<f32>(absolute_coord_i);
        let amount = g.grain_amount * 0.5;
        let grain_frequency = (1.0 / max(g.grain_size, 0.1)) / scale;
        let roughness = g.grain_roughness;
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

    let dither_amount = 1.0 / 255.0;
    final_rgb += dither(id.xy) * dither_amount;

    textureStore(output_texture, id.xy, vec4<f32>(clamp(final_rgb, vec3<f32>(0.0), vec3<f32>(1.0)), original_alpha));
}
