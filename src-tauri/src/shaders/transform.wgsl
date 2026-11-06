struct Params {
    grid: Grid,
    inverse_x: vec4<f32>,
    inverse_y: vec4<f32>,
    inverse_z: vec4<f32>,
    center: vec2<f32>,
    lens_scale: f32,
    max_radius_sq_inv: f32,
    distortion: f32,
    auto_crop_scale: f32,
    warp_flags: u32,
    orientation: u32,
    lens_k: vec4<f32>,
    vignette_k: vec3<f32>,
    vignette_amount: f32,
    tca_red: vec3<f32>,
    tca_scale: f32,
    tca_blue: vec3<f32>,
    vignette_scale: f32,
    rotation: vec4<f32>,
    rotation_offset: vec2<f32>,
    crop_origin: vec2<u32>,
    oriented_size: vec2<u32>,
    flip: vec2<u32>,
    grain: vec4<u32>,
}

@group(0) @binding(7) var<uniform> params: Params;

const WARP_LENS: u32 = 1u;
const WARP_TCA: u32 = 2u;
const WARP_VIGNETTE: u32 = 4u;
const WARP_DISTORTION: u32 = 8u;
const FRAME_ROTATE: u32 = 1u;

fn sample_inside(p: vec2<f32>, size: vec2<u32>) -> vec3<f32> {
    let last = vec2<f32>(size) - 1.0;
    if (!(p.x >= 0.0 && p.y >= 0.0 && p.x < last.x && p.y < last.y)) {
        return vec3<f32>(0.0);
    }
    let p0 = vec2<u32>(floor(p));
    let w = p - vec2<f32>(p0);
    let a = textureLoad(t0, p0, 0).rgb;
    let b = textureLoad(t0, p0 + vec2<u32>(1u, 0u), 0).rgb;
    let c = textureLoad(t0, p0 + vec2<u32>(0u, 1u), 0).rgb;
    let d = textureLoad(t0, p0 + vec2<u32>(1u, 1u), 0).rgb;
    let top = a * (1.0 - w.x) + b * w.x;
    let bot = c * (1.0 - w.x) + d * w.x;
    return top * (1.0 - w.y) + bot * w.y;
}

fn sample_channel(p: vec2<f32>, size: vec2<u32>, channel: u32) -> f32 {
    let last = vec2<f32>(size) - 1.0;
    let q = clamp(p, vec2<f32>(0.0), last);
    let p0 = min(vec2<u32>(floor(q)), max(size, vec2<u32>(2u)) - 2u);
    let w = q - vec2<f32>(p0);
    let a = textureLoad(t0, p0, 0)[channel];
    let b = textureLoad(t0, p0 + vec2<u32>(1u, 0u), 0)[channel];
    let c = textureLoad(t0, p0 + vec2<u32>(0u, 1u), 0)[channel];
    let d = textureLoad(t0, p0 + vec2<u32>(1u, 1u), 0)[channel];
    let top = a * (1.0 - w.x) + b * w.x;
    let bot = c * (1.0 - w.x) + d * w.x;
    return top * (1.0 - w.y) + bot * w.y;
}

fn tca_point(c: vec2<f32>, p: vec2<f32>, k: vec3<f32>) -> vec2<f32> {
    let d = p - c;
    let r = length(d) * params.tca_scale;
    return c + d * (k.x + r * (k.y + r * k.z));
}

@compute @workgroup_size(8, 8, 1)
fn tf_warp(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let size = params.grid.dst;
    let h = params.inverse_x * f32(id.x) + params.inverse_y * f32(id.y) + params.inverse_z;
    var rgb = vec3<f32>(0.0);
    if (abs(h.z) > 1e-6) {
        let flags = params.warp_flags;
        let c = params.center;
        var p = h.xy * (1.0 / h.z);
        if (params.auto_crop_scale > 1.0) {
            p = c + (p - c) / params.auto_crop_scale;
        }
        if ((flags & WARP_DISTORTION) != 0u) {
            let d = p - c;
            p = c + d * (1.0 + params.distortion * (dot(d, d) * params.max_radius_sq_inv));
        }
        if ((flags & WARP_LENS) != 0u) {
            let d = p - c;
            let r = length(d) * params.lens_scale;
            let k = params.lens_k;
            p = c + d * (1.0 + r * (k.x + r * (k.y + r * (k.z + r * k.w))));
        }
        if ((flags & WARP_TCA) != 0u) {
            rgb = vec3<f32>(
                sample_channel(tca_point(c, p, params.tca_red), size, 0u),
                sample_channel(p, size, 1u),
                sample_channel(tca_point(c, p, params.tca_blue), size, 2u),
            );
        } else {
            rgb = sample_inside(p, size);
        }
        if ((flags & WARP_VIGNETTE) != 0u) {
            let r = length(p - c) * params.vignette_scale;
            let r2 = r * r;
            let k = params.vignette_k;
            let falloff = 1.0 + r2 * (k.x + r2 * (k.y + r2 * k.z));
            if (falloff > 1e-6) {
                rgb *= 1.0 + (1.0 / falloff - 1.0) * params.vignette_amount;
            }
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(rgb, 1.0));
}

fn oriented(p: vec2<i32>) -> vec4<f32> {
    let size = vec2<i32>(params.oriented_size);
    if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) {
        return vec4<f32>(0.0);
    }
    var q = p;
    if (params.flip.x != 0u) { q.x = size.x - 1 - q.x; }
    if (params.flip.y != 0u) { q.y = size.y - 1 - q.y; }
    let src = vec2<i32>(params.grid.src);
    var s = q;
    switch params.orientation {
        case 1u: { s = vec2<i32>(q.y, src.y - 1 - q.x); }
        case 2u: { s = vec2<i32>(src.x - 1 - q.x, src.y - 1 - q.y); }
        case 3u: { s = vec2<i32>(src.x - 1 - q.y, q.x); }
        default: {}
    }
    return textureLoad(t0, s, 0);
}

@compute @workgroup_size(8, 8, 1)
fn tf_frame(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<f32>(id.xy + params.crop_origin);
    if ((params.grid.flags & FRAME_ROTATE) == 0u) {
        textureStore(out_f16, id.xy, oriented(vec2<i32>(p)));
        return;
    }
    let r = params.rotation;
    let s = vec2<f32>(r.x * p.x + r.y * p.y, r.z * p.x + r.w * p.y) + params.rotation_offset;
    let left = i32(floor(s.x));
    let top = i32(floor(s.y));
    let w = s - vec2<f32>(f32(left), f32(top));
    let upper = oriented(vec2<i32>(left, top)) * (1.0 - w.x) + oriented(vec2<i32>(left + 1, top)) * w.x;
    let lower = oriented(vec2<i32>(left, top + 1)) * (1.0 - w.x) + oriented(vec2<i32>(left + 1, top + 1)) * w.x;
    textureStore(out_f16, id.xy, upper * (1.0 - w.y) + lower * w.y);
}

@compute @workgroup_size(8, 8, 1)
fn tf_downscale(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let src = params.grid.src;
    let ratio = vec2<f32>(src) / vec2<f32>(params.grid.dst);
    let start = vec2<f32>(id.xy) * ratio;
    let end = vec2<f32>(id.xy + 1u) * ratio;
    let lo = vec2<u32>(floor(start));
    let hi = min(vec2<u32>(ceil(end)), src);
    var total = vec2<f32>(0.0);
    for (var x = lo.x; x < hi.x; x++) {
        total.x += max(min(end.x, f32(x + 1u)) - max(start.x, f32(x)), 0.0);
    }
    for (var y = lo.y; y < hi.y; y++) {
        total.y += max(min(end.y, f32(y + 1u)) - max(start.y, f32(y)), 0.0);
    }
    var acc = vec3<f32>(0.0);
    if (total.x > 0.0 && total.y > 0.0) {
        let inv = 1.0 / total;
        for (var y = lo.y; y < hi.y; y++) {
            let wy = max(min(end.y, f32(y + 1u)) - max(start.y, f32(y)), 0.0) * inv.y;
            if (wy <= 0.0) { continue; }
            for (var x = lo.x; x < hi.x; x++) {
                let wx = max(min(end.x, f32(x + 1u)) - max(start.x, f32(x)), 0.0) * inv.x;
                if (wx <= 0.0) { continue; }
                acc += max(textureLoad(t0, vec2<u32>(x, y), 0).rgb, vec3<f32>(0.0)) * (wx * wy);
            }
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(acc, 1.0));
}

fn grain_luma(p: vec2<u32>) -> f32 {
    let v = max(plain_luma(textureLoad(t0, p, 0).rgb), 0.0);
    if (params.grain.w == 0u) {
        return v;
    }
    if (v <= 0.0031308) {
        return v * 12.92;
    }
    return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

@compute @workgroup_size(8, 8, 1)
fn tf_grain(@builtin(global_invocation_id) id: vec3<u32>) {
    let blocks = params.grain.yz;
    if (id.x >= blocks.x || id.y >= blocks.y) { return; }
    let origin = vec2<u32>(1u) + id.xy * params.grain.x;
    var energy = 0.0;
    for (var y = 0u; y < 8u; y++) {
        for (var x = 0u; x < 8u; x++) {
            let p = origin + vec2<u32>(x, y);
            let around = grain_luma(p - vec2<u32>(1u, 0u)) + grain_luma(p + vec2<u32>(1u, 0u))
                + grain_luma(p - vec2<u32>(0u, 1u)) + grain_luma(p + vec2<u32>(0u, 1u));
            let r = grain_luma(p) - 0.25 * around;
            energy += r * r;
        }
    }
    atomicStore(&scratch[id.y * blocks.x + id.x], bitcast<u32>(sqrt(energy / 64.0)));
}
