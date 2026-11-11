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

const TB_UP_SIGMA: f32 = 0.25;
const TB_TEXTURE_KNEE: f32 = 0.06;
const TB_OWN_SIGMA: f32 = 0.4;
const TB_OWN_LO: f32 = 0.35;
const TB_OWN_HI: f32 = 0.65;
const TB_WIDE_EPS: f32 = 0.1;
const TB_TONE_EPS: f32 = 0.3;
const TB_CLIP_BAND: f32 = 0.1;
const TB_CLIP_FLAT: f32 = 0.02;
const TB_CLIP_LO: f32 = 0.0005;
const TB_CLIP_HI: f32 = 0.0015;
const TB_CLIP_HEADROOM: f32 = 8.0;
const TB_CLIP_NEAR_LO: f32 = 0.25;
const TB_CLIP_NEAR_HI: f32 = 1.0;

fn tb_texture(activity: f32) -> f32 {
    return activity / (activity + TB_TEXTURE_KNEE);
}

fn tb_upsample(p: vec2<i32>, level: f32, level_channel: i32) -> vec4<f32> {
    let low = vec2<i32>(textureDimensions(src_a));
    let pos = (vec2<f32>(p) + 0.5) * vec2<f32>(low) / vec2<f32>(textureDimensions(dst)) - 0.5;
    let centre = vec2<i32>(round(pos));
    var total = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let q = centre + vec2<i32>(i, j);
            let tent = max(1.0 - abs(vec2<f32>(q) - pos) / 1.5, vec2<f32>(0.0));
            let v = textureLoad(src_a, clamp(q, vec2<i32>(0), low - vec2<i32>(1)), 0);
            let d = (v[level_channel] - level) / TB_UP_SIGMA;
            let w = tent.x * tent.y / (1.0 + d * d) + 1.0e-7;
            total += v * w;
            weight_sum += w;
        }
    }
    return total / weight_sum;
}

@compute @workgroup_size(8, 8, 1)
fn tb_bilateral(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id.xy);
    if (p.x >= dims.x || p.y >= dims.y) { return; }

    let radius = i32(params.radius);
    let sigma = max(f32(radius) * 0.5, 0.5);
    let own = textureLoad(src_a, p, 0).xy;
    let centre = textureLoad(src_b, p, 0).x;
    var total = 0.0;
    var weight_sum = 0.0;
    for (var j = -radius; j <= radius; j = j + 1) {
        for (var i = -radius; i <= radius; i = i + 1) {
            let c = clamp(p + vec2<i32>(i, j), vec2<i32>(0), dims - vec2<i32>(1));
            let d = (textureLoad(src_b, c, 0).x - centre) / params.eps;
            let w = exp(-f32(i * i + j * j) / (2.0 * sigma * sigma) - 0.5 * d * d);
            total += textureLoad(src_a, c, 0).x * w;
            weight_sum += w;
        }
    }
    textureStore(dst, id.xy, vec4<f32>(total / weight_sum, 0.0, own));
}

@compute @workgroup_size(8, 8, 1)
fn tb_refine(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id.xy);
    if (p.x >= dims.x || p.y >= dims.y) { return; }

    let l = textureLoad(src_b, p, 0).x;
    let radius = i32(params.radius);
    var total = 0.0;
    var similar = 0.0;
    for (var j = -radius; j <= radius; j = j + 1) {
        for (var i = -radius; i <= radius; i = i + 1) {
            let v = textureLoad(src_b, clamp(p + vec2<i32>(i, j), vec2<i32>(0), dims - vec2<i32>(1)), 0).x;
            let d = (v - l) / TB_OWN_SIGMA;
            let w = exp(-0.5 * d * d);
            total += v * w;
            similar += w;
        }
    }
    let side = f32(2 * radius + 1);
    let share = similar / (side * side);
    let level = mix(tb_upsample(p, l, 0).x, total / similar, smoothstep(TB_OWN_LO, TB_OWN_HI, share));
    textureStore(dst, id.xy, vec4<f32>(level, level * level, abs(l - level), 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn tb_decimate(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_dims = textureDimensions(dst);
    if (id.x >= dst_dims.x || id.y >= dst_dims.y) { return; }

    let src_dims = textureDimensions(src_a);
    let ratio = vec2<f32>(src_dims) / vec2<f32>(dst_dims);
    let taps = vec2<i32>(clamp(ceil(ratio), vec2<f32>(1.0), vec2<f32>(8.0)));
    let origin = vec2<f32>(id.xy) * ratio;
    let max_idx = vec2<i32>(src_dims) - vec2<i32>(1);

    let centre = clamp(vec2<i32>(origin + 0.5 * ratio), vec2<i32>(0), max_idx);
    let level = textureLoad(src_a, centre, 0).x;
    var activity = 0.0;
    var weight_sum = 0.0;
    var highest = -1.0e9;
    for (var j = 0; j < taps.y; j = j + 1) {
        for (var i = 0; i < taps.x; i = i + 1) {
            let pos = origin + (vec2<f32>(f32(i), f32(j)) + 0.5) / vec2<f32>(taps) * ratio;
            let v = textureLoad(src_a, clamp(vec2<i32>(pos), vec2<i32>(0), max_idx), 0).xz;
            let d = (v.x - level) / TB_UP_SIGMA;
            let w = 1.0 / (1.0 + d * d);
            activity += v.y * w;
            weight_sum += w;
            highest = max(highest, v.x);
        }
    }
    textureStore(dst, id.xy, vec4<f32>(level, tb_texture(activity / weight_sum), highest, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn tb_fit(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let m = textureLoad(src_a, vec2<i32>(id.xy), 0).xy;
    let variance = max(m.y - m.x * m.x, 0.0);
    let a = variance / vec2<f32>(variance + TB_WIDE_EPS, variance + TB_TONE_EPS);
    textureStore(dst, id.xy, vec4<f32>(a.x, m.x * (1.0 - a.x), a.y, m.x * (1.0 - a.y)));
}

@compute @workgroup_size(8, 8, 1)
fn tb_merge(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let p = vec2<i32>(id.xy);
    textureStore(dst, id.xy, vec4<f32>(textureLoad(src_a, p, 0).xy, textureLoad(src_b, p, 0).xy));
}

@compute @workgroup_size(8, 8, 1)
fn tb_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id.xy);
    if (p.x >= dims.x || p.y >= dims.y) { return; }

    let level = textureLoad(src_b, p, 0).x;
    let low = vec2<i32>(textureDimensions(src_a));
    let pos = (vec2<f32>(p) + 0.5) * vec2<f32>(low) / vec2<f32>(dims) - 0.5;
    let f = pos - floor(pos);
    let c0 = clamp(vec2<i32>(floor(pos)), vec2<i32>(0), low - vec2<i32>(1));
    let c1 = min(c0 + vec2<i32>(1), low - vec2<i32>(1));
    let fit = mix(
        mix(textureLoad(src_a, c0, 0).xy, textureLoad(src_a, vec2<i32>(c1.x, c0.y), 0).xy, f.x),
        mix(textureLoad(src_a, vec2<i32>(c0.x, c1.y), 0).xy, textureLoad(src_a, c1, 0).xy, f.x),
        f.y
    );
    let texture = tb_upsample(p, level, 2).w;
    textureStore(dst, id.xy, vec4<f32>(level, level - (fit.x * level + fit.y), texture, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn tb_tone(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(dst));
    let p = vec2<i32>(id.xy);
    if (p.x >= dims.x || p.y >= dims.y) { return; }

    let base = textureLoad(src_b, p, 0);
    let low = vec2<i32>(textureDimensions(src_a));
    let pos = (vec2<f32>(p) + 0.5) * vec2<f32>(low) / vec2<f32>(dims) - 0.5;
    let f = pos - floor(pos);
    let c0 = clamp(vec2<i32>(floor(pos)), vec2<i32>(0), low - vec2<i32>(1));
    let c1 = min(c0 + vec2<i32>(1), low - vec2<i32>(1));
    let fit = mix(
        mix(textureLoad(src_a, c0, 0).zw, textureLoad(src_a, vec2<i32>(c1.x, c0.y), 0).zw, f.x),
        mix(textureLoad(src_a, vec2<i32>(c0.x, c1.y), 0).zw, textureLoad(src_a, c1, 0).zw, f.x),
        f.y
    );
    textureStore(dst, id.xy, vec4<f32>(base.xyz, base.x - (fit.x * base.x + fit.y)));
}

@compute @workgroup_size(8, 8, 1)
fn tb_peak(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x != 0u || id.y != 0u) { return; }

    let dims = vec2<i32>(textureDimensions(src_a));
    var peak = -1.0e9;
    for (var y = 0; y < dims.y; y = y + 1) {
        for (var x = 0; x < dims.x; x = x + 1) {
            peak = max(peak, textureLoad(src_a, vec2<i32>(x, y), 0).z);
        }
    }
    var clipped = 0.0;
    for (var y = 0; y < dims.y; y = y + 1) {
        for (var x = 0; x < dims.x; x = x + 1) {
            let cell = textureLoad(src_a, vec2<i32>(x, y), 0).yz;
            if (peak - cell.y < TB_CLIP_BAND && cell.x < TB_CLIP_FLAT) {
                clipped += 1.0;
            }
        }
    }
    let confidence = smoothstep(TB_CLIP_LO, TB_CLIP_HI, clipped / f32(dims.x * dims.y));
    textureStore(dst, vec2<u32>(2u, 0u), vec4<f32>(peak + (1.0 - confidence) * TB_CLIP_HEADROOM, confidence, peak, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn tb_clip(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let white = textureLoad(src_b, vec2<i32>(2, 0), 0);
    let cell = textureLoad(src_a, vec2<i32>(id.xy), 0).yz;
    let clipped = (1.0 - smoothstep(TB_CLIP_NEAR_LO, TB_CLIP_NEAR_HI, white.z - cell.y)) * white.y;
    textureStore(dst, id.xy, vec4<f32>(clipped));
}

@compute @workgroup_size(8, 8, 1)
fn tb_stamp(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let p = vec2<i32>(id.xy);
    let base = textureLoad(src_a, p, 0);
    var lowest = base.x;
    var highest = base.x;
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let v = textureLoad(src_a, clamp(p + vec2<i32>(i, j), vec2<i32>(0), vec2<i32>(dims) - vec2<i32>(1)), 0).x;
            lowest = min(lowest, v);
            highest = max(highest, v);
        }
    }
    let low = vec2<i32>(textureDimensions(src_b));
    let pos = (vec2<f32>(id.xy) + 0.5) * vec2<f32>(low) / vec2<f32>(dims) - 0.5;
    let f = pos - floor(pos);
    let c0 = clamp(vec2<i32>(floor(pos)), vec2<i32>(0), low - vec2<i32>(1));
    let c1 = min(c0 + vec2<i32>(1), low - vec2<i32>(1));
    let clipped = mix(
        mix(textureLoad(src_b, c0, 0).x, textureLoad(src_b, vec2<i32>(c1.x, c0.y), 0).x, f.x),
        mix(textureLoad(src_b, vec2<i32>(c0.x, c1.y), 0).x, textureLoad(src_b, c1, 0).x, f.x),
        f.y
    );
    let texture_range = bitcast<f32>(pack2x16float(vec2<f32>(base.z, highest - lowest)));
    textureStore(dst, id.xy, vec4<f32>(base.xy, texture_range, bitcast<f32>(pack2x16float(vec2<f32>(base.w, clipped)))));
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
