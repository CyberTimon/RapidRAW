struct Grid {
    dst: vec2<u32>,
    src: vec2<u32>,
    radius: u32,
    channel: u32,
    flags: u32,
    eps: f32,
}

@group(0) @binding(0) var t0: texture_2d<f32>;
@group(0) @binding(1) var t1: texture_2d<f32>;
@group(0) @binding(2) var t2: texture_2d<f32>;
@group(0) @binding(3) var t3: texture_2d<f32>;
@group(0) @binding(4) var t4: texture_2d<f32>;
@group(0) @binding(5) var t5: texture_2d<f32>;
@group(0) @binding(6) var layers: texture_2d_array<f32>;
@group(0) @binding(8) var out_f32: texture_storage_2d<rgba32float, write>;
@group(0) @binding(9) var out_f16: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var out_r32: texture_storage_2d<r32float, write>;
@group(0) @binding(11) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read> data: array<vec4<f32>>;

const KEEP_ZW: u32 = 1u;
const RGB_MODE: u32 = 2u;

struct Tap {
    p00: vec2<i32>,
    p11: vec2<i32>,
    w: vec2<f32>,
}

fn outside(id: vec3<u32>) -> bool {
    return id.x >= params.grid.dst.x || id.y >= params.grid.dst.y;
}

fn smooth_step(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

fn plain_luma(c: vec3<f32>) -> f32 {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

fn relight_luma(c: vec3<f32>) -> f32 {
    return sqrt(max(plain_luma(c), 0.0));
}

fn tap_from(f: vec2<f32>, size: vec2<u32>) -> Tap {
    let last = vec2<f32>(size) - 1.0;
    let c = clamp(f, vec2<f32>(0.0), last);
    let p0 = vec2<i32>(floor(c));
    let p1 = min(p0 + vec2<i32>(1), vec2<i32>(size) - vec2<i32>(1));
    return Tap(p0, p1, c - vec2<f32>(p0));
}

fn tap_uv(uv: vec2<f32>, size: vec2<u32>) -> Tap {
    return tap_from(uv * vec2<f32>(size) - 0.5, size);
}

fn tap_sample(t: texture_2d<f32>, tap: Tap) -> vec4<f32> {
    let a = textureLoad(t, tap.p00, 0);
    let b = textureLoad(t, vec2<i32>(tap.p11.x, tap.p00.y), 0);
    let c = textureLoad(t, vec2<i32>(tap.p00.x, tap.p11.y), 0);
    let d = textureLoad(t, tap.p11, 0);
    let top = a + (b - a) * tap.w.x;
    let bot = c + (d - c) * tap.w.x;
    return top + (bot - top) * tap.w.y;
}

fn tap_layer(tap: Tap, layer: i32) -> vec4<f32> {
    let a = textureLoad(layers, tap.p00, layer, 0);
    let b = textureLoad(layers, vec2<i32>(tap.p11.x, tap.p00.y), layer, 0);
    let c = textureLoad(layers, vec2<i32>(tap.p00.x, tap.p11.y), layer, 0);
    let d = textureLoad(layers, tap.p11, layer, 0);
    let top = a + (b - a) * tap.w.x;
    let bot = c + (d - c) * tap.w.x;
    return top + (bot - top) * tap.w.y;
}

fn guided(model: vec4<f32>, guide: f32) -> f32 {
    return model.x * guide + model.y;
}

fn box_pass(id: vec3<u32>, dir: vec2<i32>) {
    if (outside(id)) { return; }
    let r = i32(params.grid.radius);
    let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
    let p = vec2<i32>(id.xy);
    var sum = vec4<f32>(0.0);
    for (var k = -r; k <= r; k++) {
        sum += textureLoad(t0, clamp(p + dir * k, vec2<i32>(0), last), 0);
    }
    var v = sum * (1.0 / f32(2 * r + 1));
    if ((params.grid.flags & KEEP_ZW) != 0u) {
        v = vec4<f32>(v.xy, textureLoad(t0, p, 0).zw);
    }
    textureStore(out_f32, id.xy, v);
}

@compute @workgroup_size(8, 8, 1)
fn box_h(@builtin(global_invocation_id) id: vec3<u32>) {
    box_pass(id, vec2<i32>(1, 0));
}

@compute @workgroup_size(8, 8, 1)
fn box_v(@builtin(global_invocation_id) id: vec3<u32>) {
    box_pass(id, vec2<i32>(0, 1));
}

@compute @workgroup_size(8, 8, 1)
fn area_down(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let dst = params.grid.dst;
    let src = params.grid.src;
    let sy0 = id.y * src.y / dst.y;
    let sy1 = clamp((id.y + 1u) * src.y / dst.y, sy0 + 1u, src.y);
    let sx0 = id.x * src.x / dst.x;
    let sx1 = clamp((id.x + 1u) * src.x / dst.x, sx0 + 1u, src.x);
    let rgb = (params.grid.flags & RGB_MODE) != 0u;
    var acc = vec3<f32>(0.0);
    var luma = 0.0;
    for (var sy = sy0; sy < sy1; sy++) {
        for (var sx = sx0; sx < sx1; sx++) {
            let c = textureLoad(t0, vec2<u32>(sx, sy), 0).rgb;
            if (rgb) {
                acc += c;
            } else {
                luma += relight_luma(c);
            }
        }
    }
    let count = (sy1 - sy0) * (sx1 - sx0);
    if (rgb) {
        textureStore(out_f32, id.xy, vec4<f32>(acc * (1.0 / f32(count)), 1.0));
    } else {
        textureStore(out_f32, id.xy, vec4<f32>(luma / f32(count), 0.0, 0.0, 0.0));
    }
}

@compute @workgroup_size(8, 8, 1)
fn gf_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let g = textureLoad(t0, id.xy, 0).x;
    let p = textureLoad(t1, id.xy, 0)[params.grid.channel];
    textureStore(out_f32, id.xy, vec4<f32>(g, p, g * g, g * p));
}

@compute @workgroup_size(8, 8, 1)
fn gf_coeffs(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let m = textureLoad(t0, id.xy, 0);
    let var_i = max(m.z - m.x * m.x, 0.0);
    let a = (m.w - m.x * m.y) / (var_i + params.grid.eps);
    textureStore(out_f32, id.xy, vec4<f32>(a, m.y - a * m.x, 0.0, 0.0));
}
