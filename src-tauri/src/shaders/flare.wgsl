struct FlareParams {
    amount: f32,
    is_raw: u32,
    exposure: f32,
    brightness: f32,
    contrast: f32,
    whites: f32,
    aspect_ratio: f32,
    _pad: f32,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var threshold_texture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: FlareParams;
@group(0) @binding(3) var input_sampler: sampler;

fn get_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let higher = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
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

fn apply_tonal_adjustments(color: vec3<f32>, con: f32, wh: f32) -> vec3<f32> {
    var rgb = color;

    if (wh != 0.0) {
        let white_level = 1.0 - wh * 0.25;
        rgb = rgb / max(white_level, 0.01);
    }
    return rgb;
}

@compute @workgroup_size(16, 16, 1)
fn threshold_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let out_dims = vec2<u32>(textureDimensions(threshold_texture));
    if (id.x >= out_dims.x || id.y >= out_dims.y) { return; }

    let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(out_dims);

    let raw_sample = textureSampleLevel(input_texture, input_sampler, uv, 0.0).rgb;

    var linear_color: vec3<f32>;
    if (params.is_raw == 1u) {
        linear_color = raw_sample;
    } else {
        linear_color = srgb_to_linear(raw_sample);
    }

    if (params.exposure != 0.0) {
        linear_color = linear_color * pow(2.0, params.exposure);
    }

    linear_color = apply_filmic_exposure(linear_color, params.brightness);
    linear_color = apply_tonal_adjustments(linear_color, params.contrast, params.whites);

    let true_luma = get_luma(linear_color);
    let luma_for_threshold = min(true_luma, 1.0);

    let threshold_val = mix(0.88, 0.50, clamp(params.amount, 0.0, 1.0));
    let knee = 0.15;

    let x = luma_for_threshold - threshold_val + knee;
    var bright_contrib: f32;

    if (x <= 0.0) {
        bright_contrib = 0.0;
    } else if (x < knee * 2.0) {
        bright_contrib = (x * x) / (knee * 4.0);
    } else {
        bright_contrib = x - knee;
    }

    let output_color = linear_color * (bright_contrib / max(true_luma, 0.001));

    textureStore(threshold_texture, id.xy, vec4<f32>(output_color, 1.0));
}

@group(1) @binding(0) var threshold_input: texture_2d<f32>;
@group(1) @binding(1) var flare_output: texture_storage_2d<rgba16float, write>;

fn sample_bilinear(uv: vec2<f32>, dims: vec2<f32>) -> vec3<f32> {
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let xy = clamped_uv * dims - 0.5;
    let base = floor(xy);
    let frac_part = xy - base;
    let coord = vec2<i32>(base);
    let max_d = vec2<i32>(dims) - 1;

    let c00 = textureLoad(threshold_input, clamp(coord, vec2(0), max_d), 0).rgb;
    let c10 = textureLoad(threshold_input, clamp(coord + vec2(1, 0), vec2(0), max_d), 0).rgb;
    let c01 = textureLoad(threshold_input, clamp(coord + vec2(0, 1), vec2(0), max_d), 0).rgb;
    let c11 = textureLoad(threshold_input, clamp(coord + vec2(1, 1), vec2(0), max_d), 0).rgb;

    return mix(mix(c00, c10, frac_part.x), mix(c01, c11, frac_part.x), frac_part.y);
}

fn starburst_rays(uv: vec2<f32>, dims: vec2<f32>, aspect: f32) -> vec3<f32> {
    var result = vec3<f32>(0.0);

    let NUM_SPIKES = 6;
    let SAMPLES_PER_DIRECTION = 24;
    let RAY_LENGTH = 0.65;
    let ROTATION = 0.5236;
    let CHROMATIC_SPREAD = 0.01;

    for (var spike = 0; spike < NUM_SPIKES; spike++) {
        let angle = f32(spike) * 3.14159265 / f32(NUM_SPIKES) + ROTATION;
        var dir = vec2<f32>(cos(angle), sin(angle));
        dir.x /= aspect;
        dir = normalize(dir);

        var ray_r = 0.0;
        var ray_g = 0.0;
        var ray_b = 0.0;
        var weight_sum = 0.0;

        for (var i = 1; i <= SAMPLES_PER_DIRECTION; i++) {
            let t = f32(i) / f32(SAMPLES_PER_DIRECTION);
            let dist = t * t * RAY_LENGTH;

            let falloff = exp(-dist * 2.5) + 0.4 * exp(-dist * 0.8);

            let uv_pos = uv + dir * dist;
            if (uv_pos.x >= 0.0 && uv_pos.x <= 1.0 && uv_pos.y >= 0.0 && uv_pos.y <= 1.0) {
                let uv_r = uv + dir * dist * (1.0 + CHROMATIC_SPREAD);
                let uv_b = uv + dir * dist * (1.0 - CHROMATIC_SPREAD);

                ray_r += sample_bilinear(uv_r, dims).r * falloff;
                ray_g += sample_bilinear(uv_pos, dims).g * falloff;
                ray_b += sample_bilinear(uv_b, dims).b * falloff;
                weight_sum += falloff;
            }

            let uv_neg = uv - dir * dist;
            if (uv_neg.x >= 0.0 && uv_neg.x <= 1.0 && uv_neg.y >= 0.0 && uv_neg.y <= 1.0) {
                let uv_r = uv - dir * dist * (1.0 + CHROMATIC_SPREAD);
                let uv_b = uv - dir * dist * (1.0 - CHROMATIC_SPREAD);

                ray_r += sample_bilinear(uv_r, dims).r * falloff;
                ray_g += sample_bilinear(uv_neg, dims).g * falloff;
                ray_b += sample_bilinear(uv_b, dims).b * falloff;
                weight_sum += falloff;
            }
        }

        if (weight_sum > 0.0) {
            result += vec3<f32>(ray_r, ray_g, ray_b) / weight_sum;
        }
    }

    return result / f32(NUM_SPIKES) * 3.0;
}

fn starburst_inner(uv: vec2<f32>, dims: vec2<f32>, aspect: f32) -> vec3<f32> {
    var result = vec3<f32>(0.0);

    let NUM_SPIKES = 6;
    let SAMPLES = 16;
    let RAY_LENGTH = 0.2;
    let ROTATION = 0.5236;

    for (var spike = 0; spike < NUM_SPIKES; spike++) {
        let angle = f32(spike) * 3.14159265 / f32(NUM_SPIKES) + ROTATION;
        var dir = vec2<f32>(cos(angle), sin(angle));
        dir.x /= aspect;
        dir = normalize(dir);

        var ray = vec3<f32>(0.0);
        var weight_sum = 0.0;

        for (var i = 1; i <= SAMPLES; i++) {
            let t = f32(i) / f32(SAMPLES);
            let dist = t * RAY_LENGTH;
            let falloff = exp(-dist * 8.0);

            let uv_pos = uv + dir * dist;
            let uv_neg = uv - dir * dist;

            if (uv_pos.x >= 0.0 && uv_pos.x <= 1.0 && uv_pos.y >= 0.0 && uv_pos.y <= 1.0) {
                ray += sample_bilinear(uv_pos, dims) * falloff;
                weight_sum += falloff;
            }
            if (uv_neg.x >= 0.0 && uv_neg.x <= 1.0 && uv_neg.y >= 0.0 && uv_neg.y <= 1.0) {
                ray += sample_bilinear(uv_neg, dims) * falloff;
                weight_sum += falloff;
            }
        }

        if (weight_sum > 0.0) {
            result += ray / weight_sum;
        }
    }

    return result / f32(NUM_SPIKES) * 2.0;
}

fn radial_glow(uv: vec2<f32>, dims: vec2<f32>, aspect: f32) -> vec3<f32> {
    var result = vec3<f32>(0.0);
    var weight_sum = 0.0;

    let RINGS = 3;
    let SAMPLES_PER_RING = 12;
    let MAX_RADIUS = 0.08;

    result += sample_bilinear(uv, dims) * 2.0;
    weight_sum += 2.0;

    for (var ring = 1; ring <= RINGS; ring++) {
        let radius = f32(ring) / f32(RINGS) * MAX_RADIUS;
        let ring_weight = exp(-radius * radius * 200.0);

        for (var s = 0; s < SAMPLES_PER_RING; s++) {
            let angle = f32(s) * 6.28318 / f32(SAMPLES_PER_RING) + f32(ring) * 0.5;
            var offset = vec2<f32>(cos(angle), sin(angle)) * radius;
            offset.x /= aspect;
            let sample_uv = uv + offset;

            if (sample_uv.x >= 0.0 && sample_uv.x <= 1.0 &&
                sample_uv.y >= 0.0 && sample_uv.y <= 1.0) {
                result += sample_bilinear(sample_uv, dims) * ring_weight;
                weight_sum += ring_weight;
            }
        }
    }

    return result / weight_sum;
}

fn iris_pattern(uv: vec2<f32>, dims: vec2<f32>, aspect: f32) -> vec3<f32> {
    var result = vec3<f32>(0.0);
    let center_dist = length((uv - 0.5) * vec2<f32>(aspect, 1.0));
    let ring_radii = array<f32, 4>(0.15, 0.25, 0.35, 0.48);
    let ring_widths = array<f32, 4>(0.02, 0.025, 0.03, 0.035);
    let ring_intensities = array<f32, 4>(0.4, 0.3, 0.2, 0.15);

    let flipped_uv = vec2<f32>(1.0) - uv;
    let source_brightness = sample_bilinear(flipped_uv, dims);

    for (var r = 0; r < 4; r++) {
        let ring_factor = exp(-pow((center_dist - ring_radii[r]) / ring_widths[r], 2.0));
        let angle_vec = (uv - 0.5) * vec2<f32>(aspect, 1.0);
        let angle = atan2(angle_vec.y, angle_vec.x);
        let hex_mod = 0.9 + 0.1 * pow(abs(cos(angle * 3.0)), 4.0);

        result += source_brightness * ring_factor * ring_intensities[r] * hex_mod;
    }

    return result * vec3<f32>(0.7, 0.8, 1.0);
}

@compute @workgroup_size(16, 16, 1)
fn ghosts_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<f32>(textureDimensions(flare_output));
    if (id.x >= u32(dims.x) || id.y >= u32(dims.y)) { return; }

    let uv = (vec2<f32>(id.xy) + 0.5) / dims;
    var flare = vec3<f32>(0.0);

    let aspect = params.aspect_ratio;
    let aspect_vec = vec2<f32>(aspect, 1.0);

    let flipped_uv = vec2<f32>(1.0) - uv;

    let starburst = starburst_rays(uv, dims, aspect);
    flare += starburst * vec3<f32>(1.0, 0.95, 0.85) * 3.5;

    let inner_burst = starburst_inner(uv, dims, aspect);
    flare += inner_burst * vec3<f32>(1.0, 0.9, 0.8) * 1.5;

    let glow = radial_glow(uv, dims, aspect);
    flare += glow * vec3<f32>(1.0, 0.95, 0.9) * 0.4;

    flare += iris_pattern(uv, dims, aspect) * 0.2;

    var ghost_uv: vec2<f32>;
    var ghost: vec3<f32>;
    var dist: f32;
    var vignette: f32;

    ghost_uv = vec2<f32>(0.5) + (flipped_uv - 0.5) * 0.75;
    ghost = sample_bilinear(ghost_uv, dims);
    dist = length((ghost_uv - 0.5) * aspect_vec);
    vignette = 1.0 - smoothstep(0.15, 0.6, dist);
    flare += ghost * vec3<f32>(1.0, 0.92, 0.85) * 0.05 * vignette;

    ghost_uv = vec2<f32>(0.5) + (flipped_uv - 0.5) * 0.4;
    ghost = sample_bilinear(ghost_uv, dims);
    dist = length((ghost_uv - 0.5) * aspect_vec);
    vignette = 1.0 - smoothstep(0.1, 0.45, dist);
    flare += ghost * vec3<f32>(0.92, 1.0, 0.95) * 0.07 * vignette;

    ghost_uv = vec2<f32>(0.5) + (flipped_uv - 0.5) * 0.2;
    ghost = sample_bilinear(ghost_uv, dims);
    dist = length((ghost_uv - 0.5) * aspect_vec);
    vignette = 1.0 - smoothstep(0.08, 0.35, dist);
    flare += ghost * vec3<f32>(0.95, 0.97, 1.0) * 0.08 * vignette;

    ghost_uv = vec2<f32>(0.5) + (flipped_uv - 0.5) * 0.12;
    ghost = sample_bilinear(ghost_uv, dims);
    dist = length((ghost_uv - 0.5) * aspect_vec);
    vignette = 1.0 - smoothstep(0.05, 0.25, dist);
    flare += ghost * vec3<f32>(1.0, 1.0, 0.97) * 0.07 * vignette;

    ghost_uv = vec2<f32>(0.5) + (uv - 0.5) * 1.8;
    if (ghost_uv.x > 0.0 && ghost_uv.x < 1.0 && ghost_uv.y > 0.0 && ghost_uv.y < 1.0) {
        ghost = sample_bilinear(ghost_uv, dims);
        dist = length((ghost_uv - 0.5) * aspect_vec);
        vignette = 1.0 - smoothstep(0.25, 0.75, dist);
        flare += ghost * vec3<f32>(0.85, 0.9, 1.0) * 0.03 * vignette;
    }

    ghost_uv = vec2<f32>(0.5) + (flipped_uv - 0.5) * 1.3;
    if (ghost_uv.x > 0.0 && ghost_uv.x < 1.0 && ghost_uv.y > 0.0 && ghost_uv.y < 1.0) {
        ghost = sample_bilinear(ghost_uv, dims);
        dist = length((ghost_uv - 0.5) * aspect_vec);
        vignette = 1.0 - smoothstep(0.2, 0.55, dist);
        flare += ghost * vec3<f32>(1.0, 0.9, 0.95) * 0.03 * vignette;
    }

    ghost_uv = vec2<f32>(0.5) + (flipped_uv - 0.5) * 0.55;
    ghost = sample_bilinear(ghost_uv, dims);
    dist = length((ghost_uv - 0.5) * aspect_vec);
    vignette = 1.0 - smoothstep(0.2, 0.5, dist);
    flare += ghost * vec3<f32>(0.97, 0.95, 1.0) * 0.04 * vignette;

    let halo_sample = sample_bilinear(flipped_uv, dims);

    let center_dist = length((uv - 0.5) * aspect_vec);
    let halo_radius = 0.4;
    let halo_width = 0.05;
    var halo_factor = exp(-pow((center_dist - halo_radius) / halo_width, 2.0));
    flare += halo_sample * vec3<f32>(0.85, 0.92, 1.0) * halo_factor * 0.07;

    let halo2_radius = 0.22;
    let halo2_width = 0.035;
    halo_factor = exp(-pow((center_dist - halo2_radius) / halo2_width, 2.0));
    flare += halo_sample * vec3<f32>(0.92, 0.88, 1.0) * halo_factor * 0.05;

    let halo3_radius = 0.55;
    let halo3_width = 0.06;
    halo_factor = exp(-pow((center_dist - halo3_radius) / halo3_width, 2.0));
    flare += halo_sample * vec3<f32>(0.85, 0.95, 0.97) * halo_factor * 0.03;

    var streak = vec3<f32>(0.0);
    let streak_length = 0.4 / aspect;
    let streak_samples = 64;
    var total_weight = 0.0;

    for (var i = 0; i < streak_samples; i++) {
        let t = (f32(i) / f32(streak_samples - 1)) * 2.0 - 1.0;
        let offset = t * streak_length;
        let streak_uv = vec2<f32>(uv.x + offset, uv.y);

        let weight = exp(-t * t * 3.5);
        total_weight += weight;

        if (streak_uv.x > 0.0 && streak_uv.x < 1.0) {
            let r_uv = vec2<f32>(uv.x + offset * 1.015, uv.y);
            let b_uv = vec2<f32>(uv.x + offset * 0.985, uv.y);

            streak.r += sample_bilinear(r_uv, dims).r * weight;
            streak.g += sample_bilinear(streak_uv, dims).g * weight;
            streak.b += sample_bilinear(b_uv, dims).b * weight;
        }
    }
    streak /= total_weight;
    flare += streak * vec3<f32>(0.85, 0.92, 1.0) * 1.0;

    textureStore(flare_output, id.xy, vec4<f32>(flare * params.amount * 1.5, 1.0));
}
