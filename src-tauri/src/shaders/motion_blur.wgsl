struct MotionParams {
    axis: vec2<f32>,
    spacing: f32,
    strength: f32,
    scale: f32,
    gain: f32,
    noise: f32,
    parallax: f32,
    depth_ref: f32,
    kind: u32,
    layer: u32,
    mask_layer: u32,
    is_raw: u32,
    row_words: u32,
    seed: u32,
    guard: f32,
    channel: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct Spin {
    center: vec2<f32>,
    _pad: vec2<f32>,
    frame: vec4<f32>,
    frame_inv: vec4<f32>,
}

struct Spins {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    items: array<Spin, 8>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var aux: texture_2d<f32>;
@group(0) @binding(2) var masks: texture_2d_array<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: MotionParams;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var<storage, read_write> packed: array<u32>;
@group(0) @binding(7) var fill: texture_2d<f32>;
@group(0) @binding(8) var<uniform> spins: Spins;
@group(0) @binding(9) var depth: texture_2d<f32>;
@group(0) @binding(10) var front: texture_2d<f32>;

const KIND_ZOOM: u32 = 1u;
const KIND_SPIN: u32 = 2u;
const LAYER_SUBJECT: u32 = 0u;
const LAYER_PANNING: u32 = 1u;
const FULL_FRAME: u32 = 0xffffffffu;
const TAPS: i32 = 8;
const HOLE_EDGE: f32 = 0.25;
const KNEE: f32 = 0.75;
const MAX_DEPTH_FACTOR: f32 = 4.0;
const TWO_PI: f32 = 6.2831853;
const QUARTER_PI: f32 = 0.7853982;
const FRONT_GUARD: f32 = 0.5;
const MIN_ALPHA: f32 = 1.0e-4;
const FILL_DIV: i32 = 4;
const FILL_WEIGHT: f32 = 0.01;

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let a = vec3<f32>(0.055);
    let higher = pow((c + a) / (1.0 + a), vec3<f32>(2.4));
    let lower = c / 12.92;
    return select(higher, lower, c <= cutoff);
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.0031308);
    let higher = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    let lower = c * 12.92;
    return select(higher, lower, c <= cutoff);
}

fn decode(c: vec3<f32>) -> vec3<f32> {
    let v = clamp(c, vec3<f32>(0.0), vec3<f32>(65504.0));
    if (params.is_raw == 0u) {
        return srgb_to_linear(v);
    }
    return v;
}

fn encode(c: vec3<f32>) -> vec3<f32> {
    if (params.is_raw == 0u) {
        return linear_to_srgb(max(c, vec3<f32>(0.0)));
    }
    return c;
}

fn energy(c: vec3<f32>) -> vec3<f32> {
    let v = decode(c);
    let over = max(v - KNEE, vec3<f32>(0.0));
    return v + params.gain * over * over / (1.0 - KNEE);
}

fn radiance(e: vec3<f32>) -> vec3<f32> {
    if (params.gain <= 0.0) {
        return e;
    }
    let k = params.gain / (1.0 - KNEE);
    let over = max(e - KNEE, vec3<f32>(0.0));
    return select(e, KNEE + (sqrt(1.0 + 4.0 * k * over) - 1.0) / (2.0 * k), e > vec3<f32>(KNEE));
}

fn coverage(p: vec2<i32>) -> f32 {
    if (params.mask_layer == FULL_FRAME) {
        return 1.0;
    }
    let max_idx = vec2<i32>(textureDimensions(masks).xy) - vec2<i32>(1);
    let c = clamp(p, vec2<i32>(0), max_idx);
    return clamp(textureLoad(masks, c, i32(params.mask_layer), 0).r * params.scale, 0.0, 1.0);
}

fn hole(p: vec2<i32>) -> f32 {
    let q = coverage(p);
    return select(1.0 - q, q, params.layer == LAYER_SUBJECT);
}

fn layer_hole(p: vec2<i32>, is_front: bool) -> f32 {
    let h = hole(p);
    return select(h, 1.0 - h, is_front);
}

fn known_weight(p: vec2<i32>, is_front: bool) -> f32 {
    let reach = select(params.guard, params.guard * FRONT_GUARD, is_front);
    var h = layer_hole(p, is_front);
    for (var k = 0; k < 8; k = k + 1) {
        let d = vec2<f32>(cos(f32(k) * QUARTER_PI), sin(f32(k) * QUARTER_PI)) * reach;
        h = max(h, layer_hole(p + vec2<i32>(round(d)), is_front));
        h = max(h, layer_hole(p + vec2<i32>(round(d * 0.5)), is_front));
    }
    return 1.0 - smoothstep(0.0, HOLE_EDGE, h);
}

fn filled(p: vec2<i32>, c: vec3<f32>, is_front: bool) -> vec4<f32> {
    let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(textureDimensions(src));
    var f = textureSampleLevel(fill, samp, uv, 0.0).rgb;
    if (is_front) {
        f = textureSampleLevel(front, samp, uv, 0.0).rgb;
    }
    let w = known_weight(p, is_front);
    return vec4<f32>(mix(f, c, w), w);
}

fn plate(p: vec2<i32>, c: vec3<f32>) -> vec4<f32> {
    return filled(p, c, false);
}

fn subject_colour(p: vec2<i32>, c: vec3<f32>) -> vec3<f32> {
    return filled(p, c, true).rgb;
}

fn depth_factor(p: vec2<f32>) -> f32 {
    if (params.parallax <= 0.0) {
        return 1.0;
    }
    let d = textureSampleLevel(depth, samp, p / vec2<f32>(textureDimensions(dst)), 0.0).r;
    return clamp(mix(1.0, d / params.depth_ref, params.parallax), 0.0, MAX_DEPTH_FACTOR);
}

fn nearest_spin(p: vec2<f32>) -> u32 {
    var best = 0u;
    var best_dist = 3.4e38;
    for (var k = 0u; k < spins.count; k = k + 1u) {
        let s = spins.items[k];
        let d = length(mat2x2<f32>(s.frame_inv.xy, s.frame_inv.zw) * (p - s.center));
        if (d < best_dist) {
            best_dist = d;
            best = k;
        }
    }
    return best;
}

fn tap(p: vec2<f32>, t: f32, spin: u32) -> vec2<f32> {
    if (params.kind == KIND_ZOOM) {
        return params.axis + (p - params.axis) * exp(t);
    }
    if (params.kind == KIND_SPIN) {
        let s = spins.items[spin];
        let d = mat2x2<f32>(s.frame_inv.xy, s.frame_inv.zw) * (p - s.center);
        let r = vec2<f32>(cos(t), sin(t));
        return s.center + mat2x2<f32>(s.frame.xy, s.frame.zw) * vec2<f32>(d.x * r.x - d.y * r.y, d.x * r.y + d.y * r.x);
    }
    return p + params.axis * t;
}

fn grain(p: vec2<u32>) -> vec3<f32> {
    var h = vec3<u32>(p, params.seed) * 1664525u + 1013904223u;
    h.x += h.y * h.z;
    h.y += h.z * h.x;
    h.z += h.x * h.y;
    h = h ^ (h >> vec3<u32>(16u));
    h.x += h.y * h.z;
    h.y += h.z * h.x;
    h.z += h.x * h.y;
    let u = max(vec3<f32>(h >> vec3<u32>(8u)) / 16777216.0, vec3<f32>(1.0e-7));
    let v = vec3<f32>((h * 747796405u) >> vec3<u32>(8u)) / 16777216.0;
    return sqrt(-2.0 * log(u)) * cos(TWO_PI * v);
}

fn pull_first(id: vec2<u32>, is_front: bool) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let max_idx = vec2<i32>(textureDimensions(src)) - vec2<i32>(1);
    var acc = vec4<f32>(0.0);
    for (var j = 0; j < FILL_DIV; j = j + 1) {
        for (var i = 0; i < FILL_DIV; i = i + 1) {
            let p = min(vec2<i32>(id) * FILL_DIV + vec2<i32>(i, j), max_idx);
            let w = known_weight(p, is_front);
            acc += vec4<f32>(energy(textureLoad(src, p, 0).rgb) * w, w);
        }
    }
    textureStore(dst, id, acc / f32(FILL_DIV * FILL_DIV));
}

@compute @workgroup_size(8, 8, 1)
fn mb_pull_first(@builtin(global_invocation_id) id: vec3<u32>) {
    pull_first(id.xy, false);
}

@compute @workgroup_size(8, 8, 1)
fn mb_pull_front(@builtin(global_invocation_id) id: vec3<u32>) {
    pull_first(id.xy, true);
}

@compute @workgroup_size(8, 8, 1)
fn mb_pull(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let max_idx = vec2<i32>(textureDimensions(src)) - vec2<i32>(1);
    var acc = vec4<f32>(0.0);
    for (var j = 0; j < 2; j = j + 1) {
        for (var i = 0; i < 2; i = i + 1) {
            acc += textureLoad(src, min(vec2<i32>(id.xy) * 2 + vec2<i32>(i, j), max_idx), 0);
        }
    }
    textureStore(dst, id.xy, acc * 0.25);
}

@compute @workgroup_size(8, 8, 1)
fn mb_push_top(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let v = textureLoad(src, vec2<i32>(id.xy), 0);
    let c = select(vec3<f32>(0.0), v.rgb / max(v.a, 1.0e-6), v.a > 1.0e-6);
    textureStore(dst, id.xy, vec4<f32>(c, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn mb_push(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(dims);
    let coarse = textureSampleLevel(aux, samp, uv, 0.0).rgb;
    let v = textureLoad(src, vec2<i32>(id.xy), 0);
    textureStore(dst, id.xy, vec4<f32>(v.rgb + (1.0 - v.a) * coarse, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn mb_source(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let p = vec2<i32>(id.xy);
    let c = energy(textureLoad(src, p, 0).rgb);
    let q = coverage(p);
    var out = vec4<f32>(c * q, q);
    if (params.layer == LAYER_SUBJECT) {
        out = vec4<f32>(subject_colour(p, c) * q, q);
    } else if (params.layer == LAYER_PANNING) {
        let behind = plate(p, c);
        let weight = max(behind.a, FILL_WEIGHT);
        out = vec4<f32>(behind.rgb * weight, weight);
    }
    textureStore(dst, id.xy, out);
}

@compute @workgroup_size(8, 8, 1)
fn mb_cascade(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let size = vec2<f32>(dims);
    let p = vec2<f32>(id.xy) + 0.5;
    var spin = 0u;
    var spacing = params.spacing;
    if (params.kind == KIND_SPIN) {
        spin = nearest_spin(p);
    } else {
        spacing *= depth_factor(p);
    }
    var acc = vec4<f32>(0.0);
    for (var i = 0; i < TAPS; i = i + 1) {
        let t = (f32(i) - 0.5 * f32(TAPS - 1)) * spacing;
        acc += textureSampleLevel(src, samp, tap(p, t, spin) / size, 0.0);
    }
    textureStore(dst, id.xy, acc / f32(TAPS));
}

@compute @workgroup_size(8, 8, 1)
fn mb_composite(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let p = vec2<i32>(id.xy);
    let original = textureLoad(src, p, 0);
    let blurred = textureLoad(aux, p, 0);
    let q = coverage(p);

    var influence = q;
    if (params.layer == LAYER_SUBJECT) {
        influence = max(q, blurred.a);
    }
    if (influence * params.strength <= 0.0) {
        textureStore(dst, id.xy, original);
        return;
    }

    let c = energy(original.rgb);
    var moved = mix(c, blurred.rgb / max(blurred.a, MIN_ALPHA), q * step(MIN_ALPHA, blurred.a));
    var replaced = q;
    if (params.layer == LAYER_SUBJECT) {
        let behind = plate(p, c);
        moved = blurred.rgb + (1.0 - blurred.a) * behind.rgb;
        replaced = blurred.a + (1.0 - blurred.a) * (1.0 - behind.a);
    } else if (params.layer == LAYER_PANNING) {
        let behind = mix(plate(p, c).rgb, c, smoothstep(0.5, 1.0, q));
        let swapped = blurred.rgb / max(blurred.a, MIN_ALPHA) - behind;
        moved = max(c + q * swapped, vec3<f32>(0.0));
    }

    var result = radiance(mix(c, moved, params.strength));
    let lost = clamp(replaced * params.strength, 0.0, 1.0);
    if (params.noise > 0.0 && lost > 0.0) {
        let perceptual = linear_to_srgb(max(result, vec3<f32>(0.0)));
        let added = grain(id.xy) * params.noise * sqrt(lost * (2.0 - lost));
        result = srgb_to_linear(max(perceptual + added, vec3<f32>(0.0)));
    }
    textureStore(dst, id.xy, vec4<f32>(encode(result), original.a));
}

@compute @workgroup_size(8, 8, 1)
fn mb_mask_source(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let layers = textureNumLayers(masks);
    var q = vec4<f32>(0.0);
    for (var c = 0u; c < 4u; c = c + 1u) {
        let layer = params.mask_layer + c;
        if (layer < layers) {
            q[c] = textureLoad(masks, vec2<i32>(id.xy), i32(layer), 0).r;
        }
    }
    textureStore(dst, id.xy, q);
}

@compute @workgroup_size(8, 8, 1)
fn mb_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(aux);
    let x0 = id.x * 4u;
    if (x0 >= dims.x || id.y >= dims.y) { return; }

    var word = 0u;
    for (var k = 0u; k < 4u; k = k + 1u) {
        let x = x0 + k;
        if (x < dims.x) {
            let a = clamp(textureLoad(aux, vec2<u32>(x, id.y), 0)[params.channel] * params.strength, 0.0, 1.0);
            word = word | (u32(round(a * 255.0)) << (8u * k));
        }
    }
    packed[id.y * params.row_words + id.x] = word;
}
