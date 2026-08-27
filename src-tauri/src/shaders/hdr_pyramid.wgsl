// WGSL Compute Shaders for RapidRAW HDR Multi-Scale Exposure Fusion & Oklab Tone Science

struct WeightParams {
    width: u32,
    height: u32,
    wc: f32,
    ws: f32,
    we: f32,
    detail_boost: f32,
    exposure_scale: f32,
    ref_scale: f32,
};

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var output_texture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: WeightParams;

// 1. Compute Mertens Multi-Metric Weight Map
@compute @workgroup_size(16, 16)
fn compute_weights(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;
    if (x >= params.width || y >= params.height) {
        return;
    }

    let center_rgb = textureLoad(input_texture, vec2<i32>(i32(x), i32(y)), 0).rgb;
    let center_l = 0.2126 * center_rgb.r + 0.7152 * center_rgb.g + 0.0722 * center_rgb.b;

    // 4-neighborhood Laplacian contrast
    let up_l = 0.2126 * textureLoad(input_texture, vec2<i32>(i32(x), max(0, i32(y) - 1)), 0).r
             + 0.7152 * textureLoad(input_texture, vec2<i32>(i32(x), max(0, i32(y) - 1)), 0).g
             + 0.0722 * textureLoad(input_texture, vec2<i32>(i32(x), max(0, i32(y) - 1)), 0).b;
    let down_l = 0.2126 * textureLoad(input_texture, vec2<i32>(i32(x), min(i32(params.height - 1u), i32(y) + 1)), 0).r
               + 0.7152 * textureLoad(input_texture, vec2<i32>(i32(x), min(i32(params.height - 1u), i32(y) + 1)), 0).g
               + 0.0722 * textureLoad(input_texture, vec2<i32>(i32(x), min(i32(params.height - 1u), i32(y) + 1)), 0).b;
    let left_l = 0.2126 * textureLoad(input_texture, vec2<i32>(max(0, i32(x) - 1), i32(y)), 0).r
                + 0.7152 * textureLoad(input_texture, vec2<i32>(max(0, i32(x) - 1), i32(y)), 0).g
                + 0.0722 * textureLoad(input_texture, vec2<i32>(max(0, i32(x) - 1), i32(y)), 0).b;
    let right_l = 0.2126 * textureLoad(input_texture, vec2<i32>(min(i32(params.width - 1u), i32(x) + 1), i32(y)), 0).r
                 + 0.7152 * textureLoad(input_texture, vec2<i32>(min(i32(params.width - 1u), i32(x) + 1), i32(y)), 0).g
                 + 0.0722 * textureLoad(input_texture, vec2<i32>(min(i32(params.width - 1u), i32(x) + 1), i32(y)), 0).b;

    let contrast = abs(4.0 * center_l - up_l - down_l - left_l - right_l);

    // Saturation: std dev of RGB
    let mean_rgb = (center_rgb.r + center_rgb.g + center_rgb.b) / 3.0;
    let sat_sq = (pow(center_rgb.r - mean_rgb, 2.0) + pow(center_rgb.g - mean_rgb, 2.0) + pow(center_rgb.b - mean_rgb, 2.0)) / 3.0;
    let saturation = sqrt(sat_sq);

    // Well-Exposedness: Gaussian bell curve at 0.5 (sigma = 0.2)
    let two_sigma_sq = 2.0 * 0.2 * 0.2;
    let exp_r = exp(-pow(center_rgb.r - 0.5, 2.0) / two_sigma_sq);
    let exp_g = exp(-pow(center_rgb.g - 0.5, 2.0) / two_sigma_sq);
    let exp_b = exp(-pow(center_rgb.b - 0.5, 2.0) / two_sigma_sq);
    let well_exposedness = exp_r * exp_g * exp_b;

    // Highlight clip hard-cut & Shadow SNR protection
    let max_c = max(center_rgb.r, max(center_rgb.g, center_rgb.b));
    var clip_penalty = 1.0;
    if (max_c > 0.95) {
        clip_penalty = pow(clamp((1.0 - max_c) / 0.05, 0.0, 1.0), 3.0);
    }
    let snr_penalty = clamp(center_l / (center_l + 0.02), 0.05, 1.0);

    let weight = max(pow(contrast, params.wc) * pow(saturation, params.ws) * pow(well_exposedness, params.we) * clip_penalty * snr_penalty, 1e-6);

    textureStore(output_texture, vec2<i32>(i32(x), i32(y)), vec4<f32>(weight, weight, weight, 1.0));
}

// 2. Downsample 2x via Binomial Filter
@compute @workgroup_size(16, 16)
fn downsample_2x(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;
    let dst_w = (params.width + 1u) / 2u;
    let dst_h = (params.height + 1u) / 2u;

    if (x >= dst_w || y >= dst_h) {
        return;
    }

    let sx0 = min(i32(params.width - 1u), i32(x * 2u));
    let sy0 = min(i32(params.height - 1u), i32(y * 2u));
    let sx1 = min(i32(params.width - 1u), sx0 + 1);
    let sy1 = min(i32(params.height - 1u), sy0 + 1);

    let c00 = textureLoad(input_texture, vec2<i32>(sx0, sy0), 0);
    let c10 = textureLoad(input_texture, vec2<i32>(sx1, sy0), 0);
    let c01 = textureLoad(input_texture, vec2<i32>(sx0, sy1), 0);
    let c11 = textureLoad(input_texture, vec2<i32>(sx1, sy1), 0);

    let downsampled = (c00 + c10 + c01 + c11) * 0.25;
    textureStore(output_texture, vec2<i32>(i32(x), i32(y)), downsampled);
}

// 3. Sensor Noise SNR Weighted Radiance Accumulation
@compute @workgroup_size(16, 16)
fn accumulate_radiance_snr(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;
    if (x >= params.width || y >= params.height) {
        return;
    }

    let rgb = textureLoad(input_texture, vec2<i32>(i32(x), i32(y)), 0).rgb;
    let s_factor = params.ref_scale / max(params.exposure_scale, 1e-6);

    let a_shot = 0.0012;
    let b_read = 0.00004;

    let var_r = max((a_shot * rgb.r + b_read) * (s_factor * s_factor), 1e-6);
    let var_g = max((a_shot * rgb.g + b_read) * (s_factor * s_factor), 1e-6);
    let var_b = max((a_shot * rgb.b + b_read) * (s_factor * s_factor), 1e-6);

    var w_r = 1.0 / var_r;
    var w_g = 1.0 / var_g;
    var w_b = 1.0 / var_b;

    if (rgb.r > 0.94) { w_r *= pow(clamp((1.0 - rgb.r) / 0.06, 0.0, 1.0), 3.0); }
    if (rgb.g > 0.94) { w_g *= pow(clamp((1.0 - rgb.g) / 0.06, 0.0, 1.0), 3.0); }
    if (rgb.b > 0.94) { w_b *= pow(clamp((1.0 - rgb.b) / 0.06, 0.0, 1.0), 3.0); }

    let rad_r = rgb.r * s_factor * w_r;
    let rad_g = rgb.g * s_factor * w_g;
    let rad_b = rgb.b * s_factor * w_b;

    textureStore(output_texture, vec2<i32>(i32(x), i32(y)), vec4<f32>(rad_r, rad_g, rad_b, (w_r + w_g + w_b) / 3.0));
}

// 4. Oklab Perceptual Tone Compression & ACES Filmic Roll-Off
fn cbrt_approx(v: f32) -> f32 {
    return sign(v) * pow(abs(v), 1.0 / 3.0);
}

fn linear_srgb_to_oklab(c: vec3<f32>) -> vec3<f32> {
    let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
    let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
    let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;

    let l_ = cbrt_approx(l);
    let m_ = cbrt_approx(m);
    let s_ = cbrt_approx(s);

    return vec3<f32>(
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    );
}

fn oklab_to_linear_srgb(c: vec3<f32>) -> vec3<f32> {
    let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
    let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
    let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    return vec3<f32>(
        4.0767434759 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    );
}

@compute @workgroup_size(16, 16)
fn oklab_tone_compress(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;
    if (x >= params.width || y >= params.height) {
        return;
    }

    let rad = textureLoad(input_texture, vec2<i32>(i32(x), i32(y)), 0).rgb;
    let orig_luma = max(0.2126 * rad.r + 0.7152 * rad.g + 0.0722 * rad.b, 1e-6);

    // Dynamic Filmic Logarithmic compression with ACES shoulder
    let log_luma = log2(1.0 + orig_luma * 8.0) / log2(9.0);
    var filmic_luma = log_luma;
    if (log_luma > 0.72) {
        let h = (log_luma - 0.72) / 0.28;
        let shoulder = h / (1.0 + 0.45 * h);
        filmic_luma = 0.72 + 0.28 * shoulder;
    }

    let gain = clamp(filmic_luma / orig_luma, 0.0, 1000.0);
    let r_lin = max(rad.r * gain, 0.0);
    let g_lin = max(rad.g * gain, 0.0);
    let b_lin = max(rad.b * gain, 0.0);

    let oklab = linear_srgb_to_oklab(vec3<f32>(r_lin, g_lin, b_lin));
    let target_oklab = linear_srgb_to_oklab(vec3<f32>(filmic_luma, filmic_luma, filmic_luma));

    var sat_preservation = 1.0;
    if (oklab.x > 1e-4) {
        sat_preservation = clamp(pow(target_oklab.x / oklab.x, 0.12), 0.85, 1.25);
    }

    let final_oklab = vec3<f32>(target_oklab.x, oklab.y * sat_preservation, oklab.z * sat_preservation);
    let out_srgb = oklab_to_linear_srgb(final_oklab);

    textureStore(output_texture, vec2<i32>(i32(x), i32(y)), vec4<f32>(out_srgb.r, out_srgb.g, out_srgb.b, 1.0));
}
