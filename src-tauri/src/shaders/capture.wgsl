struct Params {
    dims: vec4<u32>,
    tile: vec4<u32>,
    band: vec4<u32>,
    taps: array<vec4<f32>, 13>,
}

const TILE: u32 = 42u;
const PEDESTAL: f32 = 0.001;
const STOP_PEDESTAL: f32 = 0.9;
const SETTLED: f32 = 0.01;
const OUTSIDE: f32 = -3.0e38;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> luma: array<f32>;
@group(0) @binding(2) var<storage, read> blend: array<f32>;
@group(0) @binding(3) var<storage, read_write> stops: array<f32>;

var<workgroup> plane_a: array<f32, 1764>;
var<workgroup> plane_b: array<f32, 1764>;
var<workgroup> peak: atomic<u32>;
var<workgroup> stopped: atomic<u32>;
var<workgroup> verdict: u32;

struct Block {
    x0: u32,
    y0: u32,
    cols: u32,
    rows: u32,
}

struct Row {
    orig: vec3<f32>,
    floor: vec3<f32>,
    blend: vec3<f32>,
}

fn source(b: Block, tx: u32, ty: u32) -> u32 {
    let border = i32(P.tile.x);
    let x = clamp(i32(b.x0 + tx) - border, 0, i32(P.dims.x) - 1);
    let y = clamp(i32(b.y0 + ty) - border, 0, i32(P.dims.y) - 1);
    return u32(y - i32(P.dims.z)) * P.dims.x + u32(x);
}

fn inside(b: Block, tx: u32, ty: u32) -> bool {
    let border = P.tile.x;
    return tx >= border && tx < border + b.cols && ty >= border && ty < border + b.rows;
}

fn pixel(b: Block, tx: u32, ty: u32) -> vec3<f32> {
    let i = source(b, tx, ty);
    let o = luma[i];
    if (!inside(b, tx, ty)) {
        return vec3<f32>(o, OUTSIDE, 0.0);
    }
    let w = blend[i];
    return vec3<f32>(o, ((o - PEDESTAL) * 0.5 + PEDESTAL * STOP_PEDESTAL) * w, w);
}

fn load_row(b: Block, px: u32, ty: u32) -> Row {
    let p0 = pixel(b, px, ty);
    let p1 = pixel(b, px + 1u, ty);
    let p2 = pixel(b, px + 2u, ty);
    return Row(
        vec3<f32>(p0.x, p1.x, p2.x),
        vec3<f32>(p0.y, p1.y, p2.y),
        vec3<f32>(p0.z, p1.z, p2.z),
    );
}

fn tap(k: i32) -> f32 {
    return P.taps[k].x;
}

fn put_a(x: u32, y: u32, v: vec3<f32>) {
    let i = y * TILE + x;
    plane_a[i] = v.x;
    plane_a[i + 1u] = v.y;
    plane_a[i + 2u] = v.z;
}

fn put_b(x: u32, y: u32, v: vec3<f32>) {
    let i = y * TILE + x;
    plane_b[i] = v.x;
    plane_b[i + 1u] = v.y;
    plane_b[i + 2u] = v.z;
}

fn row_blur(x: u32, y: u32) -> vec3<f32> {
    let half = i32(P.tile.z);
    let base = y * TILE;
    var sum = vec3<f32>(0.0);
    for (var k = 0; k <= 2 * half; k++) {
        let c = clamp(vec3<i32>(i32(x)) + vec3<i32>(0, 1, 2) + vec3<i32>(k - half), vec3<i32>(0), vec3<i32>(i32(TILE) - 1));
        sum += tap(k) * vec3<f32>(plane_a[base + u32(c.x)], plane_a[base + u32(c.y)], plane_a[base + u32(c.z)]);
    }
    return sum;
}

fn col_blur(x: u32, y: u32) -> vec3<f32> {
    let half = i32(P.tile.z);
    var sum = vec3<f32>(0.0);
    for (var k = 0; k <= 2 * half; k++) {
        let r = u32(clamp(i32(y) + k - half, 0, i32(TILE) - 1)) * TILE + x;
        sum += tap(k) * vec3<f32>(plane_b[r], plane_b[r + 1u], plane_b[r + 2u]);
    }
    return sum;
}

fn store(b: Block, tx: u32, ty: u32, value: f32) {
    if (inside(b, tx, ty)) {
        let border = P.tile.x;
        let x = b.x0 + tx - border;
        let y = b.y0 + ty - border;
        stops[(y - P.dims.w) * P.dims.x + x] = value;
    }
}

fn commit(est: f32, orig: f32, weight: f32) -> f32 {
    return log2((orig + weight * (est - orig)) / orig);
}

fn store_row(b: Block, px: u32, ty: u32, est: vec3<f32>, row: Row) {
    store(b, px, ty, commit(est.x, row.orig.x, row.blend.x));
    store(b, px + 1u, ty, commit(est.y, row.orig.y, row.blend.y));
    store(b, px + 2u, ty, commit(est.z, row.orig.z, row.blend.z));
}

fn clear_row(b: Block, px: u32, ty: u32) {
    store(b, px, ty, 0.0);
    store(b, px + 1u, ty, 0.0);
    store(b, px + 2u, ty, 0.0);
}

@compute @workgroup_size(14, 14, 1)
fn deconvolve(
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
    @builtin(workgroup_id) wid: vec3<u32>,
) {
    let inner = P.tile.y;
    let x0 = wid.x * inner;
    let y0 = P.dims.w + wid.y * inner;
    let b = Block(x0, y0, min(inner, P.dims.x - x0), min(inner, P.dims.w + P.band.x - y0));
    let px = lid.x * 3u;
    let py = lid.y * 3u;

    if (li == 0u) {
        atomicStore(&peak, 0u);
        atomicStore(&stopped, 0u);
    }
    workgroupBarrier();

    let r0 = load_row(b, px, py);
    let r1 = load_row(b, px, py + 1u);
    let r2 = load_row(b, px, py + 2u);
    let most = max(max(r0.blend, r1.blend), r2.blend);
    atomicMax(&peak, bitcast<u32>(max(max(most.x, most.y), most.z)));
    workgroupBarrier();
    if (li == 0u) {
        verdict = atomicLoad(&peak);
    }
    if (bitcast<f32>(workgroupUniformLoad(&verdict)) < SETTLED) {
        clear_row(b, px, py);
        clear_row(b, px, py + 1u);
        clear_row(b, px, py + 2u);
        return;
    }

    var e0 = r0.orig;
    var e1 = r1.orig;
    var e2 = r2.orig;
    let iterations = P.tile.w;
    for (var it = 0u; it < iterations; it++) {
        put_a(px, py, e0);
        put_a(px, py + 1u, e1);
        put_a(px, py + 2u, e2);
        workgroupBarrier();
        put_b(px, py, row_blur(px, py));
        put_b(px, py + 1u, row_blur(px, py + 1u));
        put_b(px, py + 2u, row_blur(px, py + 2u));
        workgroupBarrier();
        put_a(px, py, r0.orig / max(col_blur(px, py), vec3<f32>(1e-6)));
        put_a(px, py + 1u, r1.orig / max(col_blur(px, py + 1u), vec3<f32>(1e-6)));
        put_a(px, py + 2u, r2.orig / max(col_blur(px, py + 2u), vec3<f32>(1e-6)));
        workgroupBarrier();
        put_b(px, py, row_blur(px, py));
        put_b(px, py + 1u, row_blur(px, py + 1u));
        put_b(px, py + 2u, row_blur(px, py + 2u));
        workgroupBarrier();
        e0 *= col_blur(px, py);
        e1 *= col_blur(px, py + 1u);
        e2 *= col_blur(px, py + 2u);
        if (it + 1u < iterations) {
            if (any(e0 < r0.floor) || any(e1 < r1.floor) || any(e2 < r2.floor)) {
                atomicStore(&stopped, 1u);
            }
            workgroupBarrier();
            if (li == 0u) {
                verdict = atomicLoad(&stopped);
            }
            if (workgroupUniformLoad(&verdict) != 0u) {
                break;
            }
        }
    }

    store_row(b, px, py, e0, r0);
    store_row(b, px, py + 1u, e1, r1);
    store_row(b, px, py + 2u, e2, r2);
}
