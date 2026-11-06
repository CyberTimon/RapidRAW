struct Params {
    grid: Grid,
    radii: array<vec4<f32>, 2>,
    max_radius: f32,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    diffusion: f32,
    cat_eye: f32,
    veil: f32,
    span2: f32,
    first: u32,
    scale: vec2<f32>,
    layer: u32,
    near: u32,
    taps: u32,
    direct: u32,
    threshold: u32,
    diffusion_on: u32,
    guide_size: vec2<u32>,
    small_size: vec2<u32>,
    ext: u32,
    _pad1: u32,
}

@group(0) @binding(7) var<uniform> params: Params;

var<workgroup> wg_count: atomic<u32>;
var<workgroup> wg_bits: atomic<u32>;

const TILE: u32 = 8u;

fn radius_at(k: u32) -> f32 {
    return params.radii[k / 4u][k % 4u];
}

fn tent(c: f32, k: u32) -> f32 {
    let rk = radius_at(k);
    if (c <= rk) {
        if (k == 0u) { return 1.0; }
        let rp = radius_at(k - 1u);
        return clamp((c - rp) / max(rk - rp, 1e-5), 0.0, 1.0);
    }
    if (k == 4u) { return 1.0; }
    let rn = radius_at(k + 1u);
    return 1.0 - clamp((c - rk) / max(rn - rk, 1e-5), 0.0, 1.0);
}

fn soft_pow(x: f32) -> f32 {
    return x * (0.8 + 0.2 * x);
}

fn to_energy(v: f32) -> f32 {
    let x = max(v, 0.0);
    let e = x * x;
    return e - max(e - 12.0, 0.0) * 0.85;
}

fn med3(a: f32, b: f32, c: f32) -> f32 {
    return max(min(a, b), min(max(a, b), c));
}

fn signed_coc(d: f32) -> f32 {
    let far = 1.0 - smooth_step(params.min_depth - max(params.min_fade, 1e-4), params.min_depth, d);
    let near = smooth_step(params.max_depth, params.max_depth + max(params.max_fade, 1e-4), d);
    return (soft_pow(far) - soft_pow(near)) * params.max_radius;
}

fn source_span(id: vec2<u32>) -> vec4<u32> {
    let src = params.grid.src;
    let ratio = vec2<f32>(src) / vec2<f32>(params.grid.dst);
    let lo = vec2<u32>(floor(vec2<f32>(id) * ratio));
    let hi = max(min(vec2<u32>(ceil(vec2<f32>(id + 1u) * ratio)), src), lo + 1u);
    return vec4<u32>(lo, hi);
}

fn sqrt_luma(p: vec2<i32>) -> f32 {
    return relight_luma(textureLoad(t0, p, 0).rgb);
}

@compute @workgroup_size(8, 8, 1)
fn lb_luma(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
    let p = vec2<i32>(id.xy);
    var col = 0.0;
    for (var dy = -2; dy <= 2; dy++) {
        let y = clamp(p.y + dy, 0, last.y);
        var row = 0.0;
        for (var dx = -2; dx <= 2; dx++) {
            row += sqrt_luma(vec2<i32>(clamp(p.x + dx, 0, last.x), y));
        }
        col += row * (1.0 / 5.0);
    }
    textureStore(out_r32, id.xy, vec4<f32>(col * (1.0 / 5.0), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn lb_guide(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let span = source_span(id.xy);
    var acc = 0.0;
    var count = 0.0;
    for (var sy = span.y; sy < span.w; sy++) {
        for (var sx = span.x; sx < span.z; sx++) {
            acc += textureLoad(t0, vec2<u32>(sx, sy), 0).x;
            count += 1.0;
        }
    }
    let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(params.grid.dst);
    let depth = tap_sample(t1, tap_uv(uv, textureDimensions(t1))).x / 255.0;
    textureStore(out_f32, id.xy, vec4<f32>(acc / max(count, 1.0), depth, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn lb_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let g = textureLoad(t0, id.xy, 0);
    if (params.grid.channel == 0u) {
        textureStore(out_f32, id.xy, vec4<f32>(g.x, g.y, g.x * g.x, g.x * g.y));
        return;
    }
    let last = params.grid.dst - vec2<u32>(1u);
    let xl = select(id.x - 1u, 0u, id.x == 0u);
    let xr = min(id.x + 1u, last.x);
    let yu = select(id.y - 1u, 0u, id.y == 0u);
    let yd = min(id.y + 1u, last.y);
    let gx = (textureLoad(t0, vec2<u32>(xr, id.y), 0).x - textureLoad(t0, vec2<u32>(xl, id.y), 0).x) * 0.5;
    let gy = (textureLoad(t0, vec2<u32>(id.x, yd), 0).x - textureLoad(t0, vec2<u32>(id.x, yu), 0).x) * 0.5;
    textureStore(out_f32, id.xy, vec4<f32>(g.y * g.y, gx, gy, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn lb_coeffs(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let m = textureLoad(t0, id.xy, 0);
    let q = textureLoad(t1, id.xy, 0);
    let variance = max(m.z - m.x * m.x, 0.0);
    let cov = m.w - m.x * m.y;
    let structure = (q.y * q.y + q.z * q.z) * params.span2;
    let conf = structure / (structure + 1.4 * variance + 1.0e-5);
    let a = conf * cov / (variance + params.grid.eps);
    let b = m.y - a * m.x;
    let sd = sqrt(max(q.x - m.y * m.y, 0.0));
    let band = 1.1 * sd + 0.004;
    textureStore(out_f32, id.xy, vec4<f32>(a, b, m.y - band, m.y + band));
}

@compute @workgroup_size(8, 8, 1)
fn lb_coc(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let f = (vec2<f32>(id.xy) + 0.5) * params.scale - 0.5;
    let m = tap_sample(t1, tap_from(f, params.guide_size));
    let luma = textureLoad(t0, id.xy, 0).x;
    let d = clamp(clamp(m.x * luma + m.y, m.z, m.w), 0.0, 1.0);
    textureStore(out_r32, id.xy, vec4<f32>(signed_coc(d), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn lb_median_h(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let c = textureLoad(t0, id.xy, 0).x;
    var v = c;
    if (id.x > 0u && id.x + 1u < params.grid.dst.x) {
        v = med3(
            textureLoad(t0, vec2<u32>(id.x - 1u, id.y), 0).x,
            c,
            textureLoad(t0, vec2<u32>(id.x + 1u, id.y), 0).x,
        );
    }
    textureStore(out_r32, id.xy, vec4<f32>(v, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn lb_median_v(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    if (li == 0u) {
        atomicStore(&wg_count, 0u);
    }
    workgroupBarrier();
    if (!outside(id)) {
        let c = textureLoad(t0, id.xy, 0).x;
        var v = c;
        if (id.y > 0u && id.y + 1u < params.grid.dst.y) {
            v = med3(
                textureLoad(t0, vec2<u32>(id.x, id.y - 1u), 0).x,
                c,
                textureLoad(t0, vec2<u32>(id.x, id.y + 1u), 0).x,
            );
        }
        textureStore(out_r32, id.xy, vec4<f32>(v, 0.0, 0.0, 0.0));
        if (abs(v) > 0.4) {
            atomicAdd(&wg_count, 1u);
        }
    }
    workgroupBarrier();
    if (li == 0u) {
        atomicAdd(&scratch[0], atomicLoad(&wg_count));
    }
}

@compute @workgroup_size(8, 8, 1)
fn lb_down(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let span = source_span(id.xy);
    var acc = vec4<f32>(0.0);
    var count = 0.0;
    for (var sy = span.y; sy < span.w; sy++) {
        for (var sx = span.x; sx < span.z; sx++) {
            let p = vec2<u32>(sx, sy);
            let c = textureLoad(t0, p, 0).rgb;
            acc += vec4<f32>(to_energy(c.r), to_energy(c.g), to_energy(c.b), textureLoad(t1, p, 0).x);
            count += 1.0;
        }
    }
    textureStore(out_f32, id.xy, acc * (1.0 / max(count, 1.0)));
}

@compute @workgroup_size(8, 8, 1)
fn lb_tiles(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
    @builtin(workgroup_id) group: vec3<u32>,
    @builtin(num_workgroups) groups: vec3<u32>,
) {
    if (li == 0u) {
        atomicStore(&wg_bits, 0u);
    }
    workgroupBarrier();
    if (!outside(id)) {
        let c = textureLoad(t0, id.xy, 0).w;
        if (c != 0.0) {
            var bits = 0u;
            for (var k = 1u; k <= 4u; k++) {
                if (tent(abs(c), k) > 1.0e-4) {
                    bits |= 1u << (k - 1u);
                }
            }
            if (c < 0.0) {
                bits <<= 4u;
            }
            atomicOr(&wg_bits, bits);
        }
    }
    workgroupBarrier();
    if (li == 0u) {
        atomicStore(&scratch[group.y * groups.x + group.x], atomicLoad(&wg_bits));
    }
}

fn layer_value(p: vec2<i32>) -> vec4<f32> {
    let b = textureLoad(t0, p, 0);
    let c = b.w;
    if ((params.near != 0u && c >= 0.0) || (params.near == 0u && c <= 0.0)) {
        return vec4<f32>(0.0);
    }
    let w = tent(abs(c), params.layer);
    if (w <= 1.0e-4) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(b.rgb * w, w);
}

@compute @workgroup_size(8, 8, 1)
fn lb_gather(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
    @builtin(workgroup_id) group: vec3<u32>,
) {
    let tiles = (params.grid.dst + vec2<u32>(TILE - 1u)) / TILE;
    if (li == 0u) {
        atomicStore(&wg_bits, 0u);
    }
    workgroupBarrier();
    if (params.direct == 0u) {
        let bit = 1u << (params.near * 4u + params.layer - 1u);
        let origin = vec2<i32>(group.xy * TILE);
        let lo = max((origin - i32(params.ext)) / i32(TILE), vec2<i32>(0));
        let hi = min((origin + i32(TILE - 1u + params.ext)) / i32(TILE), vec2<i32>(tiles) - 1);
        let span = hi - lo + 1;
        for (var i = i32(li); i < span.x * span.y; i += 64) {
            let t = lo + vec2<i32>(i % span.x, i / span.x);
            if ((atomicLoad(&scratch[u32(t.y) * tiles.x + u32(t.x)]) & bit) != 0u) {
                atomicOr(&wg_bits, 1u);
            }
        }
    }
    workgroupBarrier();
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy);
    if (params.direct != 0u) {
        textureStore(out_f32, id.xy, layer_value(p));
        return;
    }
    if (atomicLoad(&wg_bits) == 0u) {
        textureStore(out_f32, id.xy, vec4<f32>(0.0));
        return;
    }
    let size = vec2<i32>(params.grid.dst);
    let inv = vec2<f32>(1.0 / f32(size.x), 1.0 / f32(size.y));
    let cc = params.cat_eye * ((vec2<f32>(id.xy) + 0.5) * inv * 2.0 - 1.0);
    let use_cat = params.cat_eye > 0.02;
    var acc = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var i = 0u; i < params.taps; i++) {
        let tap = data[i * 2u];
        let s = p + vec2<i32>(tap.xy);
        if (s.x < 0 || s.y < 0 || s.x >= size.x || s.y >= size.y) { continue; }
        var w = data[i * 2u + 1u].x;
        if (use_cat) {
            let o = tap.zw - cc;
            let d2 = o.x * o.x + o.y * o.y;
            if (d2 >= 1.0) { continue; }
            if (d2 > 0.82) {
                w *= 1.0 - (d2 - 0.82) / 0.18;
            }
        }
        acc += layer_value(s) * w;
        wsum += w;
    }
    var out = vec4<f32>(0.0);
    if (wsum > 1.0e-8) {
        out = acc * (1.0 / wsum);
    }
    textureStore(out_f32, id.xy, out);
}

@compute @workgroup_size(8, 8, 1)
fn lb_accum(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let b = textureLoad(t0, id.xy, 0);
    var acc = vec4<f32>(0.0);
    if (params.first == 0u) {
        acc = textureLoad(t1, id.xy, 0);
    }
    if (b.w <= 1.0e-5) {
        textureStore(out_f32, id.xy, acc);
        return;
    }
    let inv = 1.0 - min(b.w, 1.0);
    textureStore(out_f32, id.xy, vec4<f32>(b.rgb + acc.rgb * inv, min(b.w + acc.w * inv, 1.0)));
}

@compute @workgroup_size(8, 8, 1)
fn lb_lin(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let base = textureLoad(t1, id.xy, 0);
    let edge = tent(abs(base.w), 0u);
    if (params.grid.channel == 2u) {
        textureStore(out_f32, id.xy, vec4<f32>(base.rgb, 1.0 - edge));
        return;
    }
    let acc = textureLoad(t0, id.xy, 0);
    let a = clamp(acc.w, 0.0, 1.0);
    if (params.grid.channel == 0u) {
        var rgb = sqrt(max(base.rgb, vec3<f32>(0.0)));
        if (a > 1.0e-4) {
            rgb = sqrt(max(acc.rgb * (1.0 / a), vec3<f32>(0.0)));
        }
        textureStore(out_f32, id.xy, vec4<f32>(rgb, edge));
        return;
    }
    var rgb = vec3<f32>(0.0);
    if (a > 1.0e-4) {
        rgb = sqrt(max(acc.rgb * (1.0 / a), vec3<f32>(0.0))) * a;
    }
    textureStore(out_f32, id.xy, vec4<f32>(rgb, a));
}

@compute @workgroup_size(8, 8, 1)
fn lb_bloom(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let v = textureLoad(t0, id.xy, 0);
    textureStore(out_f32, id.xy, vec4<f32>(sqrt(max(v.rgb, vec3<f32>(0.0))), clamp(v.w, 0.0, 1.0)));
}

@compute @workgroup_size(8, 8, 1)
fn lb_final(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let pixel = textureLoad(t0, id.xy, 0);
    if (atomicLoad(&scratch[0]) < params.threshold && params.diffusion <= 0.0) {
        textureStore(out_f16, id.xy, vec4<f32>(pixel.rgb, 1.0));
        return;
    }
    let tap = tap_from((vec2<f32>(id.xy) + 0.5) * params.scale - 0.5, params.small_size);
    let fs = tap_sample(t2, tap);
    let ns = tap_sample(t3, tap);
    let fa = min(tent(abs(textureLoad(t1, id.xy, 0).x), 0u), fs.w);
    let na = clamp(ns.w, 0.0, 1.0);
    let inv_na = 1.0 - na;
    let mid = pixel.rgb * fa + fs.rgb * (1.0 - fa);
    let base = ns.rgb + mid * inv_na;
    if (params.diffusion_on == 0u) {
        textureStore(out_f16, id.xy, vec4<f32>(max(base, vec3<f32>(0.0)), 1.0));
        return;
    }
    let bloom = tap_sample(t4, tap);
    let mask = smooth_step(0.0, 1.0, clamp(bloom.w, 0.0, 1.0));
    let veil = params.veil * mask;
    let keep = 1.0 - (0.55 * params.diffusion * mask);
    textureStore(out_f16, id.xy, vec4<f32>(max(base * keep + bloom.rgb * veil, vec3<f32>(0.0)), 1.0));
}
