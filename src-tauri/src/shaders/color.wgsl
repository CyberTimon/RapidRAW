fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let higher = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(higher, c / 12.92, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb_extended(c: vec3<f32>) -> vec3<f32> {
    let safe_c = max(c, vec3<f32>(0.0));
    let higher = 1.055 * pow(safe_c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(higher, safe_c * 12.92, safe_c <= vec3<f32>(0.0031308));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    return linear_to_srgb_extended(min(c, vec3<f32>(1.0)));
}

fn tint_in_srgb(color: vec3<f32>, tint: vec3<f32>) -> vec3<f32> {
    return SRGB_TO_WORKING * ((WORKING_TO_SRGB * color) * tint);
}

fn rejoin_srgb_excess(processed: vec3<f32>, srgb: vec3<f32>) -> vec3<f32> {
    let source_l = dot(max(srgb, vec3<f32>(0.0)), SRGB_LUMA_COEFF);
    let ratio = dot(processed, SRGB_LUMA_COEFF) / max(source_l, 1.0e-6);
    return SRGB_TO_WORKING * (processed + min(srgb, vec3<f32>(0.0)) * ratio);
}

fn compress_gamut_distance(distance: f32, threshold: f32, scale: f32) -> f32 {
    if (scale <= 0.0 || distance <= threshold) {
        return distance;
    }
    let excess = distance - threshold;
    return threshold + excess / pow(1.0 + pow(excess / scale, GAMUT_COMPRESSION_POWER), 1.0 / GAMUT_COMPRESSION_POWER);
}

fn fit_gamut(rgb: vec3<f32>, threshold: f32, scale: vec3<f32>) -> vec3<f32> {
    let peak = max(rgb.r, max(rgb.g, rgb.b));
    if (peak <= 0.0) {
        return vec3<f32>(0.0);
    }
    let distance = (peak - rgb) / peak;
    let compressed = vec3<f32>(
        compress_gamut_distance(distance.r, threshold, scale.r),
        compress_gamut_distance(distance.g, threshold, scale.g),
        compress_gamut_distance(distance.b, threshold, scale.b)
    );
    let furthest = max(compressed.r, max(compressed.g, compressed.b));
    return peak - compressed / max(furthest, 1.0) * peak;
}
