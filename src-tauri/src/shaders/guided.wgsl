struct GfParams {
    radius: u32,
    is_raw: u32,
    eps: f32,
    _pad: f32,
}

@group(0) @binding(0) var src_a: texture_2d<f32>;
@group(0) @binding(1) var src_b: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> params: GfParams;

const GF_LUMA_FLOOR: f32 = 1.0e-4;
const LUMA_COEFF = vec3<f32>(0.2126, 0.7152, 0.0722);

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let a = vec3<f32>(0.055);
    let higher = pow((c + a) / (1.0 + a), vec3<f32>(2.4));
    let lower = c / 12.92;
    return select(higher, lower, c <= cutoff);
}

@compute @workgroup_size(8, 8, 1)
fn gf_downsample(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_dims = textureDimensions(dst);
    if (id.x >= dst_dims.x || id.y >= dst_dims.y) { return; }

    let src_dims = textureDimensions(src_a);
    let ratio = vec2<f32>(src_dims) / vec2<f32>(dst_dims);
    let taps = vec2<i32>(clamp(ceil(ratio), vec2<f32>(1.0), vec2<f32>(8.0)));
    let origin = vec2<f32>(id.xy) * ratio;
    let max_idx = vec2<i32>(src_dims) - vec2<i32>(1);

    var sum = vec4<f32>(0.0);
    for (var j = 0; j < taps.y; j = j + 1) {
        for (var i = 0; i < taps.x; i = i + 1) {
            let pos = origin + (vec2<f32>(f32(i), f32(j)) + 0.5) / vec2<f32>(taps) * ratio;
            let coord = clamp(vec2<i32>(pos), vec2<i32>(0), max_idx);
            var lin = clamp(textureLoad(src_a, coord, 0).rgb, vec3<f32>(0.0), vec3<f32>(65504.0));
            if (params.is_raw == 0u) {
                lin = srgb_to_linear(lin);
            }
            let l = log2(max(dot(lin, LUMA_COEFF), GF_LUMA_FLOOR));
            sum += vec4<f32>(l, l * l, 0.0, 0.0);
        }
    }
    textureStore(dst, id.xy, sum / f32(taps.x * taps.y));
}

@compute @workgroup_size(8, 8, 1)
fn gf_box_down(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_dims = textureDimensions(dst);
    if (id.x >= dst_dims.x || id.y >= dst_dims.y) { return; }

    let src_dims = textureDimensions(src_a);
    let ratio = vec2<f32>(src_dims) / vec2<f32>(dst_dims);
    let taps = vec2<i32>(clamp(ceil(ratio), vec2<f32>(1.0), vec2<f32>(8.0)));
    let origin = vec2<f32>(id.xy) * ratio;
    let max_idx = vec2<i32>(src_dims) - vec2<i32>(1);

    var sum = vec4<f32>(0.0);
    for (var j = 0; j < taps.y; j = j + 1) {
        for (var i = 0; i < taps.x; i = i + 1) {
            let pos = origin + (vec2<f32>(f32(i), f32(j)) + 0.5) / vec2<f32>(taps) * ratio;
            let coord = clamp(vec2<i32>(pos), vec2<i32>(0), max_idx);
            sum += textureLoad(src_a, coord, 0);
        }
    }
    textureStore(dst, id.xy, sum / f32(taps.x * taps.y));
}

fn gf_blur(id: vec2<u32>, dir: vec2<i32>) {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id);
    if (p.x >= dims.x || p.y >= dims.y) { return; }

    let radius = i32(params.radius);
    let sigma = max(f32(radius) * 0.5, 0.5);
    let max_idx = dims - vec2<i32>(1);

    var total = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var o = -radius; o <= radius; o = o + 1) {
        let c = clamp(p + dir * o, vec2<i32>(0), max_idx);
        let x = f32(o);
        let w = exp(-(x * x) / (2.0 * sigma * sigma));
        total += textureLoad(src_a, c, 0) * w;
        weight_sum += w;
    }
    textureStore(dst, id, total / weight_sum);
}

@compute @workgroup_size(8, 8, 1)
fn gf_blur_h(@builtin(global_invocation_id) id: vec3<u32>) {
    gf_blur(id.xy, vec2<i32>(1, 0));
}

@compute @workgroup_size(8, 8, 1)
fn gf_blur_v(@builtin(global_invocation_id) id: vec3<u32>) {
    gf_blur(id.xy, vec2<i32>(0, 1));
}

@compute @workgroup_size(8, 8, 1)
fn gf_coeffs(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let m = textureLoad(src_a, vec2<i32>(id.xy), 0);
    let variance = max(vec2<f32>(m.y, m.w) - vec2<f32>(m.x, m.z) * vec2<f32>(m.x, m.z), vec2<f32>(0.0));
    let a = variance / (variance + params.eps);
    let b = vec2<f32>(m.x, m.z) * (1.0 - a);
    textureStore(dst, id.xy, vec4<f32>(a.x, b.x, a.y, b.y));
}

@compute @workgroup_size(8, 8, 1)
fn gf_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let p = vec2<i32>(id.xy);
    let c = textureLoad(src_a, p, 0).xy;
    let s = textureLoad(src_b, p, 0).xy;
    textureStore(dst, id.xy, vec4<f32>(c, s));
}

const HZ_BINS: u32 = 256u;
const HZ_BINS_PER_STOP: f32 = 8.0;
const HZ_LOG_FLOOR: f32 = -16.0;
const HZ_TOP_SHARE: f32 = 0.003;
const HZ_GUIDE_GAMMA: f32 = 0.4545;
const HZ_GUIDE_MAX: f32 = 1.5;

var<workgroup> hz_hist: array<atomic<u32>, 256>;
var<workgroup> hz_sum: array<vec4<f32>, 256>;
var<workgroup> hz_mean: array<vec4<f32>, 256>;
var<workgroup> hz_threshold: u32;

fn hz_bin(rgb: vec3<f32>) -> u32 {
    let d = log2(max(min(rgb.r, min(rgb.g, rgb.b)), 1.0e-8));
    return u32(clamp((d - HZ_LOG_FLOOR) * HZ_BINS_PER_STOP, 0.0, f32(HZ_BINS - 1u)));
}

fn hz_guide(rgb: vec3<f32>, air_luma: f32) -> f32 {
    let l = max(dot(max(rgb, vec3<f32>(0.0)), LUMA_COEFF), 0.0) / air_luma;
    return min(pow(l, HZ_GUIDE_GAMMA), HZ_GUIDE_MAX);
}

fn hz_dark(rgb: vec3<f32>, air: vec3<f32>) -> f32 {
    let n = max(rgb, vec3<f32>(0.0)) / air;
    return clamp(min(n.r, min(n.g, n.b)), 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn hz_downsample(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_dims = textureDimensions(dst);
    if (id.x >= dst_dims.x || id.y >= dst_dims.y) { return; }

    let src_dims = textureDimensions(src_a);
    let ratio = vec2<f32>(src_dims) / vec2<f32>(dst_dims);
    let taps = vec2<i32>(clamp(ceil(ratio), vec2<f32>(1.0), vec2<f32>(8.0)));
    let origin = vec2<f32>(id.xy) * ratio;
    let max_idx = vec2<i32>(src_dims) - vec2<i32>(1);

    var sum = vec3<f32>(0.0);
    for (var j = 0; j < taps.y; j = j + 1) {
        for (var i = 0; i < taps.x; i = i + 1) {
            let pos = origin + (vec2<f32>(f32(i), f32(j)) + 0.5) / vec2<f32>(taps) * ratio;
            let coord = clamp(vec2<i32>(pos), vec2<i32>(0), max_idx);
            var lin = clamp(textureLoad(src_a, coord, 0).rgb, vec3<f32>(0.0), vec3<f32>(65504.0));
            if (params.is_raw == 0u) {
                lin = srgb_to_linear(lin);
            }
            sum += lin;
        }
    }
    textureStore(dst, id.xy, vec4<f32>(sum / f32(taps.x * taps.y), 0.0));
}

@compute @workgroup_size(256, 1, 1)
fn hz_airlight(@builtin(local_invocation_index) li: u32) {
    atomicStore(&hz_hist[li], 0u);
    workgroupBarrier();

    let dims = textureDimensions(src_a);
    let count = dims.x * dims.y;
    var mean = vec4<f32>(0.0);
    for (var i = li; i < count; i = i + 256u) {
        let rgb = max(textureLoad(src_a, vec2<u32>(i % dims.x, i / dims.x), 0).rgb, vec3<f32>(0.0));
        atomicAdd(&hz_hist[hz_bin(rgb)], 1u);
        mean += vec4<f32>(rgb, dot(rgb, LUMA_COEFF));
    }
    hz_mean[li] = mean;
    workgroupBarrier();

    if (li == 0u) {
        let wanted = max(u32(f32(count) * HZ_TOP_SHARE), 1u);
        var seen = 0u;
        var bin = i32(HZ_BINS) - 1;
        loop {
            seen += atomicLoad(&hz_hist[bin]);
            if (seen >= wanted || bin == 0) { break; }
            bin = bin - 1;
        }
        hz_threshold = u32(bin);
    }
    workgroupBarrier();

    let threshold = hz_threshold;
    var acc = vec4<f32>(0.0);
    for (var i = li; i < count; i = i + 256u) {
        let rgb = max(textureLoad(src_a, vec2<u32>(i % dims.x, i / dims.x), 0).rgb, vec3<f32>(0.0));
        if (hz_bin(rgb) >= threshold) {
            acc += vec4<f32>(rgb, 1.0);
        }
    }
    hz_sum[li] = acc;
    workgroupBarrier();

    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (li < stride) {
            hz_sum[li] += hz_sum[li + stride];
            hz_mean[li] += hz_mean[li + stride];
        }
        workgroupBarrier();
    }

    if (li == 0u) {
        let air_luma = max(dot(hz_sum[0].rgb / max(hz_sum[0].w, 1.0), LUMA_COEFF), 1.0e-6);
        let air_out = vec4<f32>(vec3<f32>(air_luma), air_luma);
        let scene = hz_mean[0] / f32(max(count, 1u));
        textureStore(dst, vec2<u32>(0u, 0u), air_out);
        textureStore(dst, vec2<u32>(1u, 0u), vec4<f32>(max(scene.rgb, vec3<f32>(0.0)), max(scene.w, 1.0e-6)));
    }
}

@compute @workgroup_size(8, 8, 1)
fn hz_min_h(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id.xy);
    if (p.x >= dims.x || p.y >= dims.y) { return; }

    let air = textureLoad(src_b, vec2<i32>(0, 0), 0);
    let radius = i32(params.radius);
    var lowest = 1.0;
    for (var o = -radius; o <= radius; o = o + 1) {
        let c = vec2<i32>(clamp(p.x + o, 0, dims.x - 1), p.y);
        lowest = min(lowest, hz_dark(textureLoad(src_a, c, 0).rgb, air.rgb));
    }
    let guide = hz_guide(textureLoad(src_a, p, 0).rgb, air.w);
    textureStore(dst, id.xy, vec4<f32>(lowest, guide, 0.0, 0.0));
}

fn hz_morph(id: vec2<u32>, dir: vec2<i32>, dilate: bool) -> vec2<f32> {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id);
    let radius = i32(params.radius);
    var value = select(1.0, 0.0, dilate);
    for (var o = -radius; o <= radius; o = o + 1) {
        let c = clamp(p + dir * o, vec2<i32>(0), dims - vec2<i32>(1));
        let v = textureLoad(src_a, c, 0).x;
        value = select(min(value, v), max(value, v), dilate);
    }
    return vec2<f32>(value, textureLoad(src_a, p, 0).y);
}

@compute @workgroup_size(8, 8, 1)
fn hz_min_v(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }
    textureStore(dst, id.xy, vec4<f32>(hz_morph(id.xy, vec2<i32>(0, 1), false), 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn hz_max_h(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }
    textureStore(dst, id.xy, vec4<f32>(hz_morph(id.xy, vec2<i32>(1, 0), true), 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn hz_max_v(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }
    let m = hz_morph(id.xy, vec2<i32>(0, 1), true);
    let g = m.y;
    textureStore(dst, id.xy, vec4<f32>(g, g * g, m.x, g * m.x));
}

@compute @workgroup_size(8, 8, 1)
fn hz_coeffs(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let m = textureLoad(src_a, vec2<i32>(id.xy), 0);
    let variance = max(m.y - m.x * m.x, 0.0);
    let covariance = m.w - m.x * m.z;
    let a = covariance / (variance + params.eps);
    let b = m.z - a * m.x;
    textureStore(dst, id.xy, vec4<f32>(a, b, 0.0, 0.0));
}
