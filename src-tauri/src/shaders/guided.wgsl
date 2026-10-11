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
            let d = log2(max(min(lin.r, min(lin.g, lin.b)), GF_LUMA_FLOOR));
            sum += vec4<f32>(l, l * l, d, d * d);
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
