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

const EPS: f32 = 1e-5;
const EPSSQ: f32 = 1e-10;

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

fn hpf_v(x: i32, y: i32) -> f32 {
    return sq(mos(x, y - 3) - mos(x, y - 1) - mos(x, y + 1) + mos(x, y + 3)
        - 3.0 * (mos(x, y - 2) + mos(x, y + 2)) + 6.0 * mos(x, y));
}

fn hpf_h(x: i32, y: i32) -> f32 {
    return sq(mos(x - 3, y) - mos(x - 1, y) - mos(x + 1, y) + mos(x + 3, y)
        - 3.0 * (mos(x - 2, y) + mos(x + 2, y)) + 6.0 * mos(x, y));
}

fn hpf_p(x: i32, y: i32) -> f32 {
    return sq(mos(x - 3, y - 3) - mos(x - 1, y - 1) - mos(x + 1, y + 1) + mos(x + 3, y + 3)
        - 3.0 * (mos(x - 2, y - 2) + mos(x + 2, y + 2)) + 6.0 * mos(x, y));
}

fn hpf_q(x: i32, y: i32) -> f32 {
    return sq(mos(x + 3, y - 3) - mos(x + 1, y - 1) - mos(x - 1, y + 1) + mos(x - 3, y + 3)
        - 3.0 * (mos(x + 2, y - 2) + mos(x - 2, y + 2)) + 6.0 * mos(x, y));
}

fn refine(center: f32, around: f32) -> f32 {
    return clamp(select(center, around, abs(0.5 - center) < abs(0.5 - around)), 0.0, 1.0);
}

fn vh(x: i32, y: i32) -> f32 {
    return b0[at(x, y)];
}

fn vh_disc(x: i32, y: i32) -> f32 {
    return refine(vh(x, y), 0.25 * (vh(x - 1, y - 1) + vh(x + 1, y - 1) + vh(x - 1, y + 1) + vh(x + 1, y + 1)));
}

fn rcd_green_at(x: i32, y: i32) -> f32 {
    return aux(x, y, 3u);
}

fn aux(x: i32, y: i32, k: u32) -> f32 {
    return b2[at(x, y) * 4u + k];
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
    b0[at(x, y)] = v / (v + h);
}

@compute @workgroup_size(8, 8)
fn rcd_lpf(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    b2[at(x, y) * 4u] = mos(x, y)
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
        b2[at(x, y) * 4u + 3u] = c0;
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

    let l = aux(x, y, 0u);
    let n_est = mos(x, y - 1) * (l + l) / (EPS + l + aux(x, y - 2, 0u));
    let s_est = mos(x, y + 1) * (l + l) / (EPS + l + aux(x, y + 2, 0u));
    let w_est = mos(x - 1, y) * (l + l) / (EPS + l + aux(x - 2, y, 0u));
    let e_est = mos(x + 1, y) * (l + l) / (EPS + l + aux(x + 2, y, 0u));

    let v_est = (s_grad * n_est + n_grad * s_est) / (n_grad + s_grad);
    let h_est = (w_grad * e_est + e_grad * w_est) / (e_grad + w_grad);
    b2[at(x, y) * 4u + 3u] = mix(v_est, h_est, vh_disc(x, y));
}

@compute @workgroup_size(8, 8)
fn rcd_pq(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    if (color(x, y) == 1u) {
        return;
    }
    let p = max(EPSSQ, hpf_p(x - 1, y - 1) + hpf_p(x, y) + hpf_p(x + 1, y + 1));
    let q = max(EPSSQ, hpf_q(x + 1, y - 1) + hpf_q(x, y) + hpf_q(x - 1, y + 1));
    b2[at(x, y) * 4u] = p / (p + q);
}

@compute @workgroup_size(8, 8)
fn rcd_rb(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_tile(id)) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    let own = color(x, y);
    if (own == 1u) {
        return;
    }
    let disc = refine(aux(x, y, 0u), 0.25 * (aux(x - 1, y - 1, 0u) + aux(x + 1, y - 1, 0u)
        + aux(x - 1, y + 1, 0u) + aux(x + 1, y + 1, 0u)));
    let g0 = rcd_green_at(x, y);

    let nw_grad = EPS + abs(mos(x - 1, y - 1) - mos(x + 1, y + 1)) + abs(mos(x - 1, y - 1) - mos(x - 3, y - 3))
        + abs(g0 - rcd_green_at(x - 2, y - 2));
    let ne_grad = EPS + abs(mos(x + 1, y - 1) - mos(x - 1, y + 1)) + abs(mos(x + 1, y - 1) - mos(x + 3, y - 3))
        + abs(g0 - rcd_green_at(x + 2, y - 2));
    let sw_grad = EPS + abs(mos(x + 1, y - 1) - mos(x - 1, y + 1)) + abs(mos(x - 1, y + 1) - mos(x - 3, y + 3))
        + abs(g0 - rcd_green_at(x - 2, y + 2));
    let se_grad = EPS + abs(mos(x - 1, y - 1) - mos(x + 1, y + 1)) + abs(mos(x + 1, y + 1) - mos(x + 3, y + 3))
        + abs(g0 - rcd_green_at(x + 2, y + 2));

    let nw_est = mos(x - 1, y - 1) - rcd_green_at(x - 1, y - 1);
    let ne_est = mos(x + 1, y - 1) - rcd_green_at(x + 1, y - 1);
    let sw_est = mos(x - 1, y + 1) - rcd_green_at(x - 1, y + 1);
    let se_est = mos(x + 1, y + 1) - rcd_green_at(x + 1, y + 1);

    let p_est = (nw_grad * se_est + se_grad * nw_est) / (nw_grad + se_grad);
    let q_est = (ne_grad * sw_est + sw_grad * ne_est) / (ne_grad + sw_grad);

    let i = at(x, y) * 4u;
    b2[i + 1u + (own >> 1u)] = mos(x, y);
    b2[i + 2u - (own >> 1u)] = g0 + mix(p_est, q_est, disc);
}

@compute @workgroup_size(8, 8)
fn rcd_out(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!in_inner(id)) {
        return;
    }
    let x = P.inner.x + i32(id.x);
    let y = P.inner.y + i32(id.y);
    let g0 = rcd_green_at(x, y);
    if (color(x, y) != 1u) {
        emit(id, vec3<f32>(aux(x, y, 1u), g0, aux(x, y, 2u)));
        return;
    }
    let disc = vh_disc(x, y);
    let n1 = EPS + abs(g0 - rcd_green_at(x, y - 2));
    let s1 = EPS + abs(g0 - rcd_green_at(x, y + 2));
    let w1 = EPS + abs(g0 - rcd_green_at(x - 2, y));
    let e1 = EPS + abs(g0 - rcd_green_at(x + 2, y));
    var rb = vec2<f32>(0.0);
    for (var k = 1u; k <= 2u; k++) {
        let sn = abs(aux(x, y - 1, k) - aux(x, y + 1, k));
        let ew = abs(aux(x - 1, y, k) - aux(x + 1, y, k));
        let n_grad = n1 + sn + abs(aux(x, y - 1, k) - aux(x, y - 3, k));
        let s_grad = s1 + sn + abs(aux(x, y + 1, k) - aux(x, y + 3, k));
        let w_grad = w1 + ew + abs(aux(x - 1, y, k) - aux(x - 3, y, k));
        let e_grad = e1 + ew + abs(aux(x + 1, y, k) - aux(x + 3, y, k));
        let n_est = aux(x, y - 1, k) - rcd_green_at(x, y - 1);
        let s_est = aux(x, y + 1, k) - rcd_green_at(x, y + 1);
        let w_est = aux(x - 1, y, k) - rcd_green_at(x - 1, y);
        let e_est = aux(x + 1, y, k) - rcd_green_at(x + 1, y);
        let v_est = (n_grad * s_est + s_grad * n_est) / (n_grad + s_grad);
        let h_est = (e_grad * w_est + w_grad * e_est) / (e_grad + w_grad);
        rb[k - 1u] = g0 + mix(v_est, h_est, disc);
    }
    emit(id, vec3<f32>(rb.x, g0, rb.y));
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
