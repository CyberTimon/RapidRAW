struct Params {
    tile: vec4<i32>,
    inner: vec4<i32>,
    domain: vec4<i32>,
    strides: vec4<u32>,
    pattern: vec4<i32>,
    black: vec4<f32>,
    wb: vec4<f32>,
    colors: array<vec4<u32>, 9>,
    hex: array<vec4<i32>, 36>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> cfa: array<f32>;
@group(0) @binding(3) var<storage, read_write> b0: array<f32>;
@group(0) @binding(4) var<storage, read_write> b1: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> b2: array<f32>;
@group(0) @binding(6) var<storage, read_write> words: array<u32>;
@group(0) @binding(7) var<storage, read_write> dst: array<f32>;

const PHASE_BIAS: i32 = 600;

fn pmod(a: i32, m: i32) -> i32 {
    return (a + PHASE_BIAS) % m;
}

fn sq(v: f32) -> f32 {
    return v * v;
}

fn at(x: i32, y: i32) -> u32 {
    return u32(clamp(y, 0, P.tile.w - 1) * P.tile.z + clamp(x, 0, P.tile.z - 1));
}

fn color(x: i32, y: i32) -> u32 {
    let i = u32(pmod(P.tile.y + y, 6) * 6 + pmod(P.tile.x + x, 6));
    return P.colors[i >> 2u][i & 3u];
}

fn mos(x: i32, y: i32) -> f32 {
    return cfa[at(x, y)];
}

fn in_tile(id: vec3<u32>) -> bool {
    return i32(id.x) < P.tile.z && i32(id.y) < P.tile.w;
}

fn in_inner(id: vec3<u32>) -> bool {
    return i32(id.x) < P.inner.z && i32(id.y) < P.inner.w;
}

fn emit(id: vec3<u32>, c: vec3<f32>) {
    let o = ((id.y * P.strides.z) + P.strides.w + id.x) * 3u;
    let value = max(c, vec3<f32>(0.0));
    dst[o] = value.x;
    dst[o + 1u] = value.y;
    dst[o + 2u] = value.z;
}

fn fold(v: i32, lo: i32, hi: i32, period: i32) -> i32 {
    var r = v;
    if (v < lo) {
        r = 2 * lo - v;
        r -= pmod(r - v, period);
        if (r < lo) {
            r += period;
        }
    } else if (v >= hi) {
        r = 2 * (hi - 1) - v;
        r += pmod(v - r, period);
        if (r >= hi) {
            r -= period;
        }
    }
    return clamp(r, lo, hi - 1);
}

@compute @workgroup_size(8, 8)
fn unpack(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    let ax = fold(P.tile.x + x, P.domain.x, P.domain.z, P.pattern.x);
    let ay = fold(P.tile.y + y, P.domain.y, P.domain.w, P.pattern.x);
    let e = u32(ay) * P.strides.x + u32(ax) - P.strides.y;
    let value = f32((raw[e >> 1u] >> ((e & 1u) * 16u)) & 0xffffu);
    let black = P.black[u32((ay & 1) * 2 + (ax & 1))];
    cfa[at(x, y)] = max(value - black, 0.0) * P.wb.w * P.wb[color(x, y)];
}

const EPS: f32 = 1e-5;
const EPSSQ: f32 = 1e-10;
const DEBIAS_RADIUS: i32 = 3;
const DEBIAS_NORM: f32 = 1.0 / 64.0;
const DEBIAS_LIMIT: f32 = 0.04;
const RB_EPS: f32 = 1e-5;
const RB_SHOT: f32 = 1e-4;
const RB_SIGMA: f32 = 1.5;
const RB_TINY: f32 = 1e-20;
const RB_RADIUS: i32 = 4;
const RB_AREA: f32 = 81.0;

const STATE: u32 = 0u;
const STATS: u32 = 2u;
const COEF: u32 = 6u;
const CRIT: u32 = 9u;
const SMOOTH: u32 = COEF;
const TENTATIVE: u32 = STATE;
const REFINED: u32 = 1u;

struct ColorCoef {
    ri: vec2<f32>,
    ml: vec3<f32>,
}

fn layer(i: u32, p: vec2<i32>) -> vec4<f32> {
    return b1[plane(i) + at(p.x, p.y)];
}

fn put(i: u32, p: vec2<i32>, v: vec4<f32>) {
    b1[plane(i) + at(p.x, p.y)] = v;
}

fn gauss(s: i32, sigma: f32) -> f32 {
    let f = f32(s) / sigma;
    return exp(-0.5 * f * f);
}

fn green_at(p: vec2<i32>) -> f32 {
    return b2[at(p.x, p.y)];
}

fn hpf_v(x: i32, y: i32) -> f32 {
    return sq(mos(x, y - 3) - mos(x, y - 1) - mos(x, y + 1) + mos(x, y + 3)
        - 3.0 * (mos(x, y - 2) + mos(x, y + 2)) + 6.0 * mos(x, y));
}

fn hpf_h(x: i32, y: i32) -> f32 {
    return sq(mos(x - 3, y) - mos(x - 1, y) - mos(x + 1, y) + mos(x + 3, y)
        - 3.0 * (mos(x - 2, y) + mos(x + 2, y)) + 6.0 * mos(x, y));
}

fn refine(center: f32, around: f32) -> f32 {
    return clamp(select(center, around, abs(0.5 - center) < abs(0.5 - around)), 0.0, 1.0);
}

fn vh(x: i32, y: i32) -> f32 {
    return b0[at(x, y) * 2u];
}

fn lowpass(x: i32, y: i32) -> f32 {
    return b0[at(x, y) * 2u + 1u];
}

fn vh_disc(x: i32, y: i32) -> f32 {
    return refine(vh(x, y), 0.25 * (vh(x - 1, y - 1) + vh(x + 1, y - 1) + vh(x - 1, y + 1) + vh(x + 1, y + 1)));
}

@compute @workgroup_size(8, 8)
fn rcd_vh(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    let v = max(EPSSQ, hpf_v(x, y - 1) + hpf_v(x, y) + hpf_v(x, y + 1));
    let h = max(EPSSQ, hpf_h(x - 1, y) + hpf_h(x, y) + hpf_h(x + 1, y));
    let i = at(x, y) * 2u;
    b0[i] = v / (v + h);
    b0[i + 1u] = mos(x, y)
        + 0.5 * (mos(x, y - 1) + mos(x, y + 1) + mos(x - 1, y) + mos(x + 1, y))
        + 0.25 * (mos(x - 1, y - 1) + mos(x + 1, y - 1) + mos(x - 1, y + 1) + mos(x + 1, y + 1));
}

@compute @workgroup_size(8, 8)
fn rcd_green(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    let c0 = mos(x, y);
    if (color(x, y) == 1u) {
        b2[at(x, y)] = c0;
        return;
    }
    let n_grad = EPS + abs(mos(x, y - 1) - mos(x, y + 1)) + abs(c0 - mos(x, y - 2))
        + abs(mos(x, y - 1) - mos(x, y - 3)) + abs(mos(x, y - 2) - mos(x, y - 4));
    let s_grad = EPS + abs(mos(x, y + 1) - mos(x, y - 1)) + abs(c0 - mos(x, y + 2))
        + abs(mos(x, y + 1) - mos(x, y + 3)) + abs(mos(x, y + 2) - mos(x, y + 4));
    let w_grad = EPS + abs(mos(x - 1, y) - mos(x + 1, y)) + abs(c0 - mos(x - 2, y))
        + abs(mos(x - 1, y) - mos(x - 3, y)) + abs(mos(x - 2, y) - mos(x - 4, y));
    let e_grad = EPS + abs(mos(x + 1, y) - mos(x - 1, y)) + abs(c0 - mos(x + 2, y))
        + abs(mos(x + 1, y) - mos(x + 3, y)) + abs(mos(x + 2, y) - mos(x + 4, y));

    let l = lowpass(x, y);
    let n_est = mos(x, y - 1) * (l + l) / (EPS + l + lowpass(x, y - 2));
    let s_est = mos(x, y + 1) * (l + l) / (EPS + l + lowpass(x, y + 2));
    let w_est = mos(x - 1, y) * (l + l) / (EPS + l + lowpass(x - 2, y));
    let e_est = mos(x + 1, y) * (l + l) / (EPS + l + lowpass(x + 2, y));

    let v_est = (s_grad * n_est + n_grad * s_est) / (n_grad + s_grad);
    let h_est = (w_grad * e_est + e_grad * w_est) / (e_grad + w_grad);
    b2[at(x, y)] = mix(v_est, h_est, vh_disc(x, y));
}

@compute @workgroup_size(8, 8)
fn rcd_debias_h(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let y = i32(id.y);
    var modulated = 0.0;
    var level = 0.0;
    var weight = 1.0;
    for (var k = 0; k <= 2 * DEBIAS_RADIUS; k++) {
        let x = clamp(i32(id.x) + k - DEBIAS_RADIUS, 0, P.tile.z - 1);
        let g = b2[at(x, y)];
        modulated += weight * select(g, -g, color(x, y) == 1u);
        level += weight * g;
        weight *= f32(2 * DEBIAS_RADIUS - k) / f32(k + 1);
    }
    let i = at(i32(id.x), y) * 2u;
    b0[i] = modulated * DEBIAS_NORM;
    b0[i + 1u] = level * DEBIAS_NORM;
}

@compute @workgroup_size(8, 8)
fn rcd_debias_v(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = i32(id.x);
    if (!in_tile(id) || color(x, i32(id.y)) == 1u) {
        return;
    }
    var modulated = 0.0;
    var level = 0.0;
    var weight = 1.0;
    for (var k = 0; k <= 2 * DEBIAS_RADIUS; k++) {
        let y = clamp(i32(id.y) + k - DEBIAS_RADIUS, 0, P.tile.w - 1);
        let i = at(x, y) * 2u;
        modulated += weight * b0[i];
        level += weight * b0[i + 1u];
        weight *= f32(2 * DEBIAS_RADIUS - k) / f32(k + 1);
    }
    let limit = DEBIAS_LIMIT * level * DEBIAS_NORM;
    b2[at(x, i32(id.y))] -= clamp(2.0 * modulated * DEBIAS_NORM, -limit, limit);
}

@compute @workgroup_size(8, 8)
fn rb_prepare(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    if (tint(p) == 1u) {
        put(STATE, p, vec4<f32>(0.0));
        put(STATE + 1u, p, vec4<f32>(0.0));
        return;
    }
    let g = green_at(p);
    let x = pick(p);
    let lg = 4.0 * g - green_at(p + vec2<i32>(-2, 0)) - green_at(p + vec2<i32>(2, 0))
        - green_at(p + vec2<i32>(0, -2)) - green_at(p + vec2<i32>(0, 2));
    let lx = 4.0 * x - pick(p + vec2<i32>(-2, 0)) - pick(p + vec2<i32>(2, 0))
        - pick(p + vec2<i32>(0, -2)) - pick(p + vec2<i32>(0, 2));
    put(STATE, p, vec4<f32>(1.0, g, x, g * g));
    put(STATE + 1u, p, vec4<f32>(x * x, g * x, lg * lx, lg * lg));
}

@compute @workgroup_size(8, 8)
fn rb_stats(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    var r0 = vec4<f32>(0.0);
    var r1 = vec4<f32>(0.0);
    var u0 = vec4<f32>(0.0);
    var u1 = vec4<f32>(0.0);
    for (var s = -RB_RADIUS; s <= RB_RADIUS; s++) {
        let q = p + vec2<i32>(s, 0);
        let red = f32(tint(q) == 0u);
        let a = layer(STATE, q);
        let b = layer(STATE + 1u, q);
        r0 += red * a;
        r1 += red * b;
        u0 += (1.0 - red) * a;
        u1 += (1.0 - red) * b;
    }
    put(STATS, p, r0);
    put(STATS + 1u, p, r1);
    put(STATS + 2u, p, u0);
    put(STATS + 3u, p, u1);
}

fn color_coef(s0: vec4<f32>, s1: vec4<f32>) -> ColorCoef {
    let n = max(s0.x, 1e-12);
    let mg = s0.y / n;
    let mx = s0.z / n;
    let a = (s1.y / n - mg * mx) / (s0.w / n - mg * mg + RB_EPS + RB_SHOT * mg);
    let b = mx - a * mg;
    let a2 = s1.z / (s1.w + RB_EPS + RB_SHOT * 20.0 * s0.y);
    let b2 = mx - a2 * mg;
    let e = (s1.x - 2.0 * a2 * s1.y - 2.0 * b2 * s0.z + a2 * a2 * s0.w + 2.0 * a2 * b2 * s0.y + b2 * b2 * s0.x) / n;
    let wt = 1.0 / max(e, 1e-10);
    return ColorCoef(vec2<f32>(a, b), vec3<f32>(wt * a2, wt * b2, wt));
}

@compute @workgroup_size(8, 8)
fn rb_coef(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    var m0 = vec4<f32>(0.0);
    var m1 = vec4<f32>(0.0);
    var m2 = vec4<f32>(0.0);
    var m3 = vec4<f32>(0.0);
    for (var s = -RB_RADIUS; s <= RB_RADIUS; s++) {
        let q = p + vec2<i32>(0, s);
        m0 += layer(STATS, q);
        m1 += layer(STATS + 1u, q);
        m2 += layer(STATS + 2u, q);
        m3 += layer(STATS + 3u, q);
    }
    let r = color_coef(m0 / RB_AREA, m1 / RB_AREA);
    let b = color_coef(m2 / RB_AREA, m3 / RB_AREA);
    put(COEF, p, vec4<f32>(r.ri, b.ri));
    put(COEF + 1u, p, vec4<f32>(r.ml, b.ml.x));
    put(COEF + 2u, p, vec4<f32>(b.ml.yz, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn rb_average(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    var s0 = vec4<f32>(0.0);
    var s1 = vec4<f32>(0.0);
    var s2 = vec4<f32>(0.0);
    for (var s = -RB_RADIUS; s <= RB_RADIUS; s++) {
        let q = p + vec2<i32>(s, 0);
        s0 += layer(COEF, q);
        s1 += layer(COEF + 1u, q);
        s2 += layer(COEF + 2u, q);
    }
    put(STATS, p, s0);
    put(STATS + 1u, p, s1);
    put(STATS + 2u, p, s2);
}

@compute @workgroup_size(8, 8)
fn rb_tentative(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    var s0 = vec4<f32>(0.0);
    var s1 = vec4<f32>(0.0);
    var s2 = vec4<f32>(0.0);
    for (var s = -RB_RADIUS; s <= RB_RADIUS; s++) {
        let q = p + vec2<i32>(0, s);
        s0 += layer(STATS, q);
        s1 += layer(STATS + 1u, q);
        s2 += layer(STATS + 2u, q);
    }
    let g = green_at(p);
    put(TENTATIVE, p, vec4<f32>(
        (s0.x * g + s0.y) / RB_AREA,
        (s1.x * g + s1.y) / s1.z,
        (s0.z * g + s0.w) / RB_AREA,
        (s1.w * g + s2.x) / s2.y,
    ));
}

@compute @workgroup_size(8, 8)
fn rb_residual(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    var resid = vec4<f32>(0.0);
    var base = vec2<f32>(0.0);
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let q = p + vec2<i32>(dx, dy);
            let col = tint(q);
            if (col == 1u) {
                continue;
            }
            let k = select(select(0.25, 0.5, dx == 0 || dy == 0), 1.0, dx == 0 && dy == 0);
            let c = pick(q);
            let t = layer(TENTATIVE, q);
            if (col == 0u) {
                resid += k * vec4<f32>(c - t.x, c - t.y, 0.0, 0.0);
                base.x += k * (c - green_at(q));
            } else {
                resid += k * vec4<f32>(0.0, 0.0, c - t.z, c - t.w);
                base.y += k * (c - green_at(q));
            }
        }
    }
    let t = layer(TENTATIVE, p);
    let g = green_at(p);
    put(REFINED, p, t + resid);
    put(CRIT, p, t - vec4<f32>(g + base.x, g + base.x, g + base.y, g + base.y));
}

fn color_crit(q: vec2<i32>) -> vec4<f32> {
    let d = layer(CRIT, q);
    let gx = abs(layer(CRIT, q + vec2<i32>(1, 0)) - layer(CRIT, q - vec2<i32>(1, 0)));
    let gy = abs(layer(CRIT, q + vec2<i32>(0, 1)) - layer(CRIT, q - vec2<i32>(0, 1)));
    return d * d * (gx + gy) * 0.5;
}

@compute @workgroup_size(8, 8)
fn rb_smooth(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    var acc = vec4<f32>(0.0);
    var total = 0.0;
    for (var s = -5; s <= 5; s++) {
        let k = gauss(s, RB_SIGMA);
        acc += k * color_crit(p + vec2<i32>(s, 0));
        total += k;
    }
    put(SMOOTH, p, acc / total);
}

@compute @workgroup_size(8, 8)
fn rb_out(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_inner(id)) {
        return;
    }
    let p = P.inner.xy + vec2<i32>(id.xy);
    var acc = vec4<f32>(0.0);
    var total = 0.0;
    for (var s = -5; s <= 5; s++) {
        let k = gauss(s, RB_SIGMA);
        acc += k * layer(SMOOTH, p + vec2<i32>(0, s));
        total += k;
    }
    let wt = 1.0 / (acc / total + vec4<f32>(RB_TINY));
    let x = layer(REFINED, p) * wt;
    var r = (x.x + x.y) / (wt.x + wt.y);
    var b = (x.z + x.w) / (wt.z + wt.w);
    let col = tint(p);
    let c = pick(p);
    r = select(r, c, col == 0u);
    b = select(b, c, col == 2u);
    emit(id, vec3<f32>(r, green_at(p), b));
}

fn hex(p: vec2<i32>, k: u32) -> vec2<i32> {
    let e = u32(pmod(P.tile.y + p.y, 3) * 3 + pmod(P.tile.x + p.x, 3)) * 8u + k;
    let pair = P.hex[e >> 1u];
    return select(pair.zw, pair.xy, (e & 1u) == 0u);
}

fn row_phase(p: vec2<i32>) -> i32 {
    return pmod(P.tile.y + p.y - P.pattern.z, 3);
}

fn col_phase(p: vec2<i32>) -> i32 {
    return pmod(P.tile.x + p.x - P.pattern.y, 3);
}

fn tint(p: vec2<i32>) -> u32 {
    return color(p.x, p.y);
}

fn pick(p: vec2<i32>) -> f32 {
    return mos(p.x, p.y);
}

fn plane(d: u32) -> u32 {
    return d * u32(P.tile.z * P.tile.w);
}

fn slot(p: vec2<i32>, d: u32) -> u32 {
    return plane(d) + at(p.x, p.y);
}

fn green(p: vec2<i32>, d: u32) -> f32 {
    return b1[slot(p, d)].y;
}

fn chan(p: vec2<i32>, d: u32, c: u32) -> f32 {
    return b1[slot(p, d)][c];
}

fn rgb(p: vec2<i32>, d: u32) -> vec3<f32> {
    return b1[slot(p, d)].xyz;
}

fn green_range(p: vec2<i32>) -> vec2<f32> {
    let i = at(p.x, p.y) * 2u;
    return vec2<f32>(b0[i], b0[i + 1u]);
}

@compute @workgroup_size(8, 8)
fn xt_minmax(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id) || tint(p) == 1u) {
        return;
    }
    var lo = 3.4e38;
    var hi = 0.0;
    for (var k = 0u; k < 6u; k++) {
        let v = pick(p + hex(p, k));
        lo = min(lo, v);
        hi = max(hi, v);
    }
    let i = at(p.x, p.y) * 2u;
    b0[i] = lo;
    b0[i + 1u] = hi;
}

@compute @workgroup_size(8, 8)
fn xt_green(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    let f = tint(p);
    let v = pick(p);
    var init = vec4<f32>(0.0);
    init[f] = v;
    for (var d = 0u; d < 4u; d++) {
        b1[slot(p, d)] = init;
    }
    if (f == 1u) {
        return;
    }
    let h0 = hex(p, 0u);
    let h1 = hex(p, 1u);
    let h2 = hex(p, 2u);
    let h3 = hex(p, 3u);
    let h4 = hex(p, 4u);
    let h5 = hex(p, 5u);
    var est: array<f32, 4>;
    est[0] = (174.0 * (pick(p + h1) + pick(p + h0)) - 46.0 * (pick(p + 2 * h1) + pick(p + 2 * h0))) / 256.0;
    est[1] = (223.0 * pick(p + h3) + 33.0 * pick(p + h2) + 92.0 * (v - pick(p - h2))) / 256.0;
    est[2] = (164.0 * pick(p + h4) + 92.0 * pick(p - 2 * h4)
        + 33.0 * (2.0 * v - pick(p + 3 * h4) - pick(p - 3 * h4))) / 256.0;
    est[3] = (164.0 * pick(p + h5) + 92.0 * pick(p - 2 * h5)
        + 33.0 * (2.0 * v - pick(p + 3 * h5) - pick(p - 3 * h5))) / 256.0;
    let range = green_range(p);
    let swap = select(0u, 1u, row_phase(p) == 0);
    for (var k = 0u; k < 4u; k++) {
        b1[slot(p, k ^ swap)].y = clamp(est[k], range.x, range.y);
    }
}

fn solitary_axis(p: vec2<i32>, d: u32, unit: vec2<i32>) -> vec3<f32> {
    var out = vec3<f32>(0.0);
    let g0 = green(p, d);
    for (var dist = 1; dist <= 2; dist++) {
        let o = unit * dist;
        let c = tint(p + o);
        let gp = green(p + o, d);
        let gm = green(p - o, d);
        let cp = chan(p + o, d, c);
        let cm = chan(p - o, d, c);
        let g = 2.0 * g0 - gp - gm;
        out[c >> 1u] = (g + cp + cm) * 0.5;
        out.z += sq(gp - gm - cp + cm) + sq(g);
    }
    return out;
}

fn solitary(id: vec3<u32>, base: u32) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id) || row_phase(p) != 0 || col_phase(p) != 0) {
        return;
    }
    for (var k = 0u; k < 4u; k++) {
        let d = base + k;
        var rb: vec3<f32>;
        if (k == 0u) {
            rb = solitary_axis(p, d, vec2<i32>(1, 0));
        } else if (k == 1u) {
            rb = solitary_axis(p, d, vec2<i32>(0, 1));
        } else {
            let h = solitary_axis(p, d, vec2<i32>(1, 0));
            let v = solitary_axis(p, d, vec2<i32>(0, 1));
            rb = select(v, h, h.z < v.z);
        }
        let s = slot(p, d);
        b1[s].x = rb.x;
        b1[s].z = rb.y;
    }
}

fn redblue(id: vec3<u32>, base: u32) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    let own = tint(p);
    if (own == 1u) {
        return;
    }
    let f = 2u - own;
    let vertical = row_phase(p) != 0;
    let cu = select(vec2<i32>(1, 0), vec2<i32>(0, 1), vertical);
    let hu = select(vec2<i32>(0, 3), vec2<i32>(3, 0), vertical);
    for (var k = 0u; k < 4u; k++) {
        let d = base + k;
        let g0 = green(p, d);
        var use_c = k > 1u || (select(k ^ 1u, k, vertical) & 1u) != 0u;
        if (!use_c) {
            use_c = abs(g0 - green(p + cu, d)) + abs(g0 - green(p - cu, d))
                < 2.0 * (abs(g0 - green(p + hu, d)) + abs(g0 - green(p - hu, d)));
        }
        let i = select(hu, cu, use_c);
        b1[slot(p, d)][f] = (chan(p + i, d, f) + chan(p - i, d, f) + 2.0 * g0 - green(p + i, d) - green(p - i, d)) * 0.5;
    }
}

fn greens(id: vec3<u32>, base: u32) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id) || tint(p) != 1u || row_phase(p) == 0 || col_phase(p) == 0) {
        return;
    }
    for (var k = 0u; k < 4u; k++) {
        let d = base + k;
        let a = hex(p, 2u * k);
        let b = hex(p, 2u * k + 1u);
        let g0 = green(p, d);
        let ca = rgb(p + a, d);
        let cb = rgb(p + b, d);
        var r: f32;
        var bl: f32;
        if (any(a + b != vec2<i32>(0))) {
            let g = 3.0 * g0 - 2.0 * ca.y - cb.y;
            r = (g + 2.0 * ca.x + cb.x) / 3.0;
            bl = (g + 2.0 * ca.z + cb.z) / 3.0;
        } else {
            let g = 2.0 * g0 - ca.y - cb.y;
            r = (g + ca.x + cb.x) * 0.5;
            bl = (g + ca.z + cb.z) * 0.5;
        }
        let s = slot(p, d);
        b1[s].x = r;
        b1[s].z = bl;
    }
}

fn recalc(id: vec3<u32>, src: u32) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    let own = tint(p);
    if (own == 1u) {
        return;
    }
    let s = at(p.x, p.y);
    for (var k = 0u; k < 4u; k++) {
        b2[plane(k) + s] = green(p, src + k);
    }
    let range = green_range(p);
    let swap = select(0u, 1u, row_phase(p) == 0);
    for (var e = 3u; e < 6u; e++) {
        let t = (e - 2u) ^ swap;
        let d = src + t;
        let a = hex(p, e);
        let value = green(p - 2 * a, d) + 2.0 * green(p + a, d) - chan(p - 2 * a, d, own)
            - 2.0 * chan(p + a, d, own) + 3.0 * chan(p, d, own);
        b2[plane(t) + s] = clamp(value / 3.0, range.x, range.y);
    }
}

fn commit(id: vec3<u32>, src: u32) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    let refined = tint(p) != 1u;
    let s = at(p.x, p.y);
    for (var k = 0u; k < 4u; k++) {
        var value = b1[slot(p, src + k)];
        if (refined) {
            value.y = b2[plane(k) + s];
        }
        b1[slot(p, 4u + k)] = value;
    }
}

@compute @workgroup_size(8, 8)
fn xt_solitary_0(@builtin(global_invocation_id) id: vec3<u32>) {
    solitary(id, 0u);
}

@compute @workgroup_size(8, 8)
fn xt_solitary_4(@builtin(global_invocation_id) id: vec3<u32>) {
    solitary(id, 4u);
}

@compute @workgroup_size(8, 8)
fn xt_redblue_0(@builtin(global_invocation_id) id: vec3<u32>) {
    redblue(id, 0u);
}

@compute @workgroup_size(8, 8)
fn xt_redblue_4(@builtin(global_invocation_id) id: vec3<u32>) {
    redblue(id, 4u);
}

@compute @workgroup_size(8, 8)
fn xt_greens_0(@builtin(global_invocation_id) id: vec3<u32>) {
    greens(id, 0u);
}

@compute @workgroup_size(8, 8)
fn xt_greens_4(@builtin(global_invocation_id) id: vec3<u32>) {
    greens(id, 4u);
}

@compute @workgroup_size(8, 8)
fn xt_recalc_0(@builtin(global_invocation_id) id: vec3<u32>) {
    recalc(id, 0u);
}

@compute @workgroup_size(8, 8)
fn xt_recalc_4(@builtin(global_invocation_id) id: vec3<u32>) {
    recalc(id, 4u);
}

@compute @workgroup_size(8, 8)
fn xt_commit_0(@builtin(global_invocation_id) id: vec3<u32>) {
    commit(id, 0u);
}

@compute @workgroup_size(8, 8)
fn xt_commit_4(@builtin(global_invocation_id) id: vec3<u32>) {
    commit(id, 4u);
}

fn yuv(c: vec3<f32>) -> vec3<f32> {
    let y = 0.2627 * c.x + 0.6780 * c.y + 0.0593 * c.z;
    return vec3<f32>(y, (c.z - y) * 0.56433, (c.x - y) * 0.67815);
}

fn step_of(d: u32) -> vec2<i32> {
    switch (d & 3u) {
        case 0u: {
            return vec2<i32>(1, 0);
        }
        case 1u: {
            return vec2<i32>(0, 1);
        }
        case 2u: {
            return vec2<i32>(1, 1);
        }
        default: {
            return vec2<i32>(-1, 1);
        }
    }
}

@compute @workgroup_size(8, 8)
fn xt_drv(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    let s = at(p.x, p.y);
    for (var d = 0u; d < 8u; d++) {
        let o = step_of(d);
        let t = 2.0 * yuv(rgb(p, d)) - yuv(rgb(p + o, d)) - yuv(rgb(p - o, d));
        b2[plane(d) + s] = dot(t, t);
    }
}

@compute @workgroup_size(8, 8)
fn xt_homo(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (!in_tile(id)) {
        return;
    }
    let s = at(p.x, p.y);
    var tr = 3.4e38;
    for (var d = 0u; d < 8u; d++) {
        tr = min(tr, b2[plane(d) + s]);
    }
    tr *= 8.0;
    var packed = 0u;
    for (var d = 0u; d < 8u; d++) {
        var n = 0u;
        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                n += select(0u, 1u, b2[plane(d) + at(p.x + dx, p.y + dy)] <= tr);
            }
        }
        packed |= n << (4u * d);
    }
    words[at(p.x, p.y)] = packed;
}

@compute @workgroup_size(8, 8)
fn xt_out(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_inner(id)) {
        return;
    }
    let p = P.inner.xy + vec2<i32>(id.xy);
    var even = 0u;
    var odd = 0u;
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            let w = words[at(p.x + dx, p.y + dy)];
            even += w & 0x0f0f0f0fu;
            odd += (w >> 4u) & 0x0f0f0f0fu;
        }
    }
    var hm: array<u32, 8>;
    var top = 0u;
    for (var d = 0u; d < 8u; d++) {
        hm[d] = (select(even, odd, (d & 1u) == 1u) >> (8u * (d >> 1u))) & 0xffu;
        top = max(top, hm[d]);
    }
    top -= top >> 3u;
    for (var d = 0u; d < 4u; d++) {
        if (hm[d] < hm[d + 4u]) {
            hm[d] = 0u;
        } else if (hm[d] > hm[d + 4u]) {
            hm[d + 4u] = 0u;
        }
    }
    var sum = vec3<f32>(0.0);
    var n = 0.0;
    for (var d = 0u; d < 8u; d++) {
        if (hm[d] >= top) {
            sum += rgb(p, d);
            n += 1.0;
        }
    }
    emit(id, sum / max(n, 1.0));
}
