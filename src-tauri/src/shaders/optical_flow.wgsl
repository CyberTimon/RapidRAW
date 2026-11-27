struct Params {
    grid: Grid,
    values: array<vec4<f32>, 2>,
    modes: vec4<u32>,
    steady: array<vec4<f32>, 2>,
}

@group(0) @binding(7) var<uniform> params: Params;

const PATCH: i32 = 8;
const DENSE_FLOOR: f32 = 0.004;
const MIN_DET: f32 = 1.0e-9;
const CONVERGED: f32 = 0.01;
const FB_SLACK: f32 = 0.5;
const FB_RATIO: f32 = 0.01;
const FRONT_FLAG: f32 = 0.5;
const FRONT_RINGS: i32 = 6;
const FRONT_DIRECTIONS: i32 = 12;
const SELECT_SLACK: f32 = 0.5;
const RESPONSE_REFERENCE: f32 = 4.0;
const RESPONSE_POWER: f32 = 1.5;
const RESPONSE_MAX: f32 = 3.0;

fn exposed(v: vec2<f32>) -> vec2<f32> {
    let scaled = v * params.values[0].x;
    let len = length(scaled);
    if (len <= 0.0) { return scaled; }
    return scaled * min(pow(len / RESPONSE_REFERENCE, RESPONSE_POWER - 1.0), RESPONSE_MAX);
}

fn steadied(v: vec2<f32>, at: vec2<f32>) -> vec2<f32> {
    if (params.modes.z == 0u) { return v; }
    let point = vec3<f32>(at, 1.0);
    return v + vec2<f32>(dot(params.steady[0].xyz, point), dot(params.steady[1].xyz, point));
}
const SELECT_SPREAD: f32 = 0.1;
const SELECT_BIAS: f32 = 0.01;
const SELECT_MOVING: f32 = 0.5;
const STILL_MARGIN: f32 = 0.04;
const STILL_LIMIT: f32 = 0.12;
const STILL_CENTER: f32 = 0.03;
const STILL_RATIO: f32 = 4.0;
const CLEAN_ALONE: i32 = 2;
const TRUST_RADIUS: i32 = 2;
const MEASURED_SHARE: f32 = 0.5;

fn load_r(t: texture_2d<f32>, p: vec2<i32>) -> f32 {
    let last = vec2<i32>(textureDimensions(t)) - vec2<i32>(1);
    return textureLoad(t, clamp(p, vec2<i32>(0), last), 0).r;
}

fn bilinear(t: texture_2d<f32>, f: vec2<f32>) -> vec4<f32> {
    return tap_sample(t, tap_from(f, textureDimensions(t)));
}

fn luma_at(t: texture_2d<f32>, f: vec2<f32>) -> f32 {
    return plain_luma(bilinear(t, f).rgb);
}

@compute @workgroup_size(8, 8, 1)
fn fl_luma(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let dst = params.grid.dst;
    let src = params.grid.src;
    let y0 = id.y * src.y / dst.y;
    let y1 = clamp((id.y + 1u) * src.y / dst.y, y0 + 1u, src.y);
    let x0 = id.x * src.x / dst.x;
    let x1 = clamp((id.x + 1u) * src.x / dst.x, x0 + 1u, src.x);
    var sum = 0.0;
    for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
            sum += plain_luma(textureLoad(t0, vec2<u32>(x, y), 0).rgb);
        }
    }
    textureStore(out_r32, id.xy, vec4<f32>(sum / f32((y1 - y0) * (x1 - x0)), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn fl_down(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let base = vec2<i32>(id.xy) * 2 - vec2<i32>(1);
    let weights = vec4<f32>(1.0, 3.0, 3.0, 1.0);
    var sum = 0.0;
    for (var j = 0; j < 4; j++) {
        for (var i = 0; i < 4; i++) {
            sum += weights[i] * weights[j] * load_r(t0, base + vec2<i32>(i, j));
        }
    }
    textureStore(out_r32, id.xy, vec4<f32>(sum / 64.0, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn fl_grad(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy);
    let gx = 0.5 * (load_r(t0, p + vec2<i32>(1, 0)) - load_r(t0, p - vec2<i32>(1, 0)));
    let gy = 0.5 * (load_r(t0, p + vec2<i32>(0, 1)) - load_r(t0, p - vec2<i32>(0, 1)));
    textureStore(out_f32, id.xy, vec4<f32>(load_r(t0, p), gx, gy, 0.0));
}

fn patch_origin(index: vec2<u32>, size: vec2<u32>, stride: i32) -> vec2<i32> {
    return clamp(vec2<i32>(index) * stride, vec2<i32>(0), max(vec2<i32>(size) - vec2<i32>(PATCH), vec2<i32>(0)));
}

fn half_bilinear(t: texture_2d<f32>, f: vec2<f32>, upper: bool) -> vec4<f32> {
    let dims = textureDimensions(t);
    let half = dims.x / 2u;
    var tap = tap_from(f, vec2<u32>(half, dims.y));
    if (upper) {
        tap.p00.x += i32(half);
        tap.p11.x += i32(half);
    }
    return tap_sample(t, tap);
}

var<workgroup> sums: array<vec4<f32>, 64>;

fn workgroup_sum(local: u32, value: vec4<f32>) -> vec4<f32> {
    sums[local] = value;
    workgroupBarrier();
    for (var step = 32u; step > 0u; step = step >> 1u) {
        if (local < step) {
            sums[local] = sums[local] + sums[local + step];
        }
        workgroupBarrier();
    }
    let total = workgroupUniformLoad(&sums[0]);
    workgroupBarrier();
    return total;
}

@compute @workgroup_size(8, 8, 1)
fn fl_patch(
    @builtin(workgroup_id) group: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(local_invocation_index) local: u32,
) {
    let pairs = params.grid.dst.x / 2u;
    let backward = group.x >= pairs;
    let index = vec2<u32>(group.x - select(0u, pairs, backward), group.y);
    let size = textureDimensions(t0);
    let origin = patch_origin(index, size, i32(params.grid.radius));
    let q = min(origin + vec2<i32>(lid.xy), vec2<i32>(size) - vec2<i32>(1));
    var t = textureLoad(t0, q, 0);
    if (backward) {
        t = textureLoad(t2, q, 0);
    }
    var initial = vec2<f32>(0.0);
    if (params.modes.x != 0u) {
        initial = 2.0 * half_bilinear(t4, (vec2<f32>(origin) + 0.5 * f32(PATCH)) * 0.5 - 0.5, backward).xy;
    }

    let n = f32(PATCH * PATCH);
    let moments = workgroup_sum(local, vec4<f32>(t.x, t.y * t.y, t.y * t.z, t.z * t.z));
    let weighted = workgroup_sum(local, vec4<f32>(t.yz, t.yz * t.x));
    let mean0 = moments.x / n;
    let gsum = weighted.xy;
    let gi0 = weighted.zw;
    let ridge = params.values[0].x * n;
    let hxx = moments.y - gsum.x * gsum.x / n + ridge;
    let hxy = moments.z - gsum.x * gsum.y / n;
    let hyy = moments.w - gsum.y * gsum.y / n + ridge;
    let det = hxx * hyy - hxy * hxy;

    var u = initial;
    if (det > MIN_DET) {
        let inv = vec3<f32>(hyy, -hxy, hxx) / det;
        let iterations = i32(params.values[0].y);
        for (var k = 0; k < iterations; k++) {
            var w = 0.0;
            if (backward) {
                w = bilinear(t3, vec2<f32>(q) + u).x;
            } else {
                w = bilinear(t1, vec2<f32>(q) + u).x;
            }
            let s = workgroup_sum(local, vec4<f32>(t.yz * w, w, 0.0));
            let b = s.xy - gi0 - (s.z / n - mean0) * gsum;
            let du = vec2<f32>(inv.x * b.x + inv.y * b.y, inv.y * b.x + inv.z * b.y);
            u -= du;
            if (dot(du, du) < CONVERGED * CONVERGED) {
                break;
            }
        }
        if (length(u - initial) > f32(PATCH)) {
            u = initial;
        }
    }
    if (local == 0u) {
        textureStore(out_f32, group.xy, vec4<f32>(u, 0.0, 1.0));
    }
}

fn dense_sum(warped: texture_2d<f32>, p: vec2<i32>, i0: f32, column: i32) -> vec3<f32> {
    let size = textureDimensions(t0);
    let grid = vec2<i32>(textureDimensions(t4));
    let stride = i32(params.grid.radius);
    let low = max(p - vec2<i32>(PATCH) + vec2<i32>(stride), vec2<i32>(0)) / stride;
    let high = vec2<i32>(grid.x / 2, grid.y) - vec2<i32>(1);
    var acc = vec3<f32>(0.0);
    for (var y = low.y; y <= high.y; y++) {
        let oy = patch_origin(vec2<u32>(0u, u32(y)), size, stride).y;
        if (oy > p.y) { break; }
        if (p.y >= oy + PATCH) { continue; }
        for (var x = low.x; x <= high.x; x++) {
            let ox = patch_origin(vec2<u32>(u32(x), 0u), size, stride).x;
            if (ox > p.x) { break; }
            if (p.x >= ox + PATCH) { continue; }
            let u = textureLoad(t4, vec2<i32>(x + column, y), 0).xy;
            let w = 1.0 / max(abs(bilinear(warped, vec2<f32>(p) + u).x - i0), DENSE_FLOOR);
            acc += vec3<f32>(u * w, w);
        }
    }
    return acc;
}

@compute @workgroup_size(8, 8, 1)
fn fl_densify(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let width = params.grid.dst.x / 2u;
    let backward = id.x >= width;
    let p = vec2<i32>(i32(id.x - select(0u, width, backward)), i32(id.y));
    var acc = vec3<f32>(0.0);
    if (backward) {
        acc = dense_sum(t3, p, textureLoad(t2, p, 0).x, i32(textureDimensions(t4).x) / 2);
    } else {
        acc = dense_sum(t1, p, textureLoad(t0, p, 0).x, 0);
    }
    textureStore(out_f32, id.xy, vec4<f32>(acc.xy / max(acc.z, 1.0e-6), 0.0, 1.0));
}

fn side_weight(flow: vec2<f32>, back: vec2<f32>) -> f32 {
    let miss = dot(flow + back, flow + back);
    let bound = FB_RATIO * (dot(flow, flow) + dot(back, back)) + FB_SLACK;
    return 1.0 - smooth_step(bound, 4.0 * bound, miss);
}

@compute @workgroup_size(8, 8, 1)
fn fl_field(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<f32>(id.xy);
    let has_next = params.modes.x != 0u;
    let has_prev = params.modes.y != 0u;
    var ahead = vec2<f32>(0.0);
    var behind = vec2<f32>(0.0);
    var wf = 0.0;
    var wb = 0.0;
    if (has_next) {
        let flow = textureLoad(t0, id.xy, 0).xy;
        wf = side_weight(flow, half_bilinear(t0, p + flow, true).xy);
        ahead = flow * params.values[0].x;
    }
    if (has_prev) {
        let back = textureLoad(t1, id.xy + vec2<u32>(params.grid.dst.x, 0u), 0).xy;
        wb = side_weight(back, half_bilinear(t1, p + back, false).xy);
        behind = -back * params.values[0].y;
    }
    let sides = f32(has_next) + f32(has_prev);
    var v = (ahead + behind) / max(sides, 1.0);
    if (wf + wb > 0.05) {
        v = (wf * ahead + wb * behind) / (wf + wb);
    }
    var flag = 0.0;
    if (has_next && has_prev) {
        flag = abs(wf - wb);
    }
    textureStore(out_f32, id.xy, vec4<f32>(v, flag, max(wf, wb)));
}

@compute @workgroup_size(8, 8, 1)
fn fl_trust(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy);
    let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
    var s = vec3<f32>(0.0);
    for (var j = -TRUST_RADIUS; j <= TRUST_RADIUS; j++) {
        for (var i = -TRUST_RADIUS; i <= TRUST_RADIUS; i++) {
            let g = textureLoad(t1, clamp(p + vec2<i32>(i, j), vec2<i32>(0), last), 0).yz;
            s += vec3<f32>(g.x * g.x, g.x * g.y, g.y * g.y);
        }
    }
    let spread = sqrt((s.x - s.z) * (s.x - s.z) + 4.0 * s.y * s.y);
    let weakest = max(0.5 * (s.x + s.z - spread), 0.0);
    let step = textureLoad(t0, p, 0);
    let trust = step.w * weakest / (weakest + params.values[0].x);
    textureStore(out_f32, id.xy, vec4<f32>(step.xy * trust, trust, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn fl_pull(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let last = vec2<i32>(textureDimensions(t0)) - vec2<i32>(1);
    var sum = vec4<f32>(0.0);
    for (var k = 0; k < 4; k++) {
        sum += textureLoad(t0, min(vec2<i32>(id.xy) * 2 + vec2<i32>(k % 2, k / 2), last), 0);
    }
    textureStore(out_f32, id.xy, 0.25 * sum);
}

@compute @workgroup_size(8, 8, 1)
fn fl_push(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let own = textureLoad(t0, id.xy, 0);
    var coarse = vec2<f32>(0.0);
    var share = 1.0;
    if (params.modes.x != 0u) {
        coarse = bilinear(t1, (vec2<f32>(id.xy) + 0.5) * 0.5 - 0.5).xy;
        share = min(own.z * params.values[0].y, 1.0);
    }
    let v = mix(coarse, own.xy / max(own.z, MIN_DET), select(0.0, share, own.z > MIN_DET));
    var result = vec4<f32>(v, 0.0, 1.0);
    if (params.modes.y != 0u) {
        result = vec4<f32>(v, textureLoad(t2, id.xy, 0).zw);
    }
    textureStore(out_f32, id.xy, result);
}

fn compatible(a: vec2<f32>, b: vec2<f32>) -> f32 {
    let slack = 0.5 + 0.15 * max(length(a), length(b));
    return 1.0 - smooth_step(slack, 2.0 * slack, length(a - b));
}

@compute @workgroup_size(8, 8, 1)
fn fl_front(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let size = vec2<i32>(params.grid.dst);
    let p = vec2<i32>(id.xy);
    let own = textureLoad(t0, p, 0);
    var front = vec2<f32>(0.0);
    if (own.z >= FRONT_FLAG) {
        let reach = params.values[0].y;
        var found = false;
        for (var ring = 0; ring < FRONT_RINGS && !found; ring++) {
            let radius = reach * exp2(f32(ring - FRONT_RINGS + 1));
            if (radius < 1.0) { continue; }
            var best = 0.0;
            for (var k = 0; k < FRONT_DIRECTIONS; k++) {
                let angle = (f32(k) + 0.5 * f32(ring % 2)) * 6.2831853 / f32(FRONT_DIRECTIONS);
                let offset = vec2<i32>(round(vec2<f32>(cos(angle), sin(angle)) * radius));
                let q = textureLoad(t0, clamp(p + offset, vec2<i32>(0), size - vec2<i32>(1)), 0);
                let speed = length(q.xy);
                if (q.z < FRONT_FLAG && compatible(q.xy, own.xy) < 0.5 && speed > best) {
                    best = speed;
                    front = q.xy;
                    found = true;
                }
            }
        }
        if (found) {
            front = steadied(front, vec2<f32>(p));
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(exposed(front), 0.0, 1.0));
}

const CROSS: array<vec2<i32>, 5> = array<vec2<i32>, 5>(
    vec2<i32>(0, 0),
    vec2<i32>(1, 0),
    vec2<i32>(-1, 0),
    vec2<i32>(0, 1),
    vec2<i32>(0, -1),
);

fn luma_load(t: texture_2d<f32>, p: vec2<i32>) -> f32 {
    let last = vec2<i32>(textureDimensions(t)) - vec2<i32>(1);
    return plain_luma(textureLoad(t, clamp(p, vec2<i32>(0), last), 0).rgb);
}

fn frame_pixel(p: vec2<i32>) -> vec2<i32> {
    return vec2<i32>(floor((vec2<f32>(p) + 0.5) * params.values[1].x));
}

fn cross_error(p: vec2<i32>, other: texture_2d<f32>, shift: vec2<f32>) -> f32 {
    var sum = 0.0;
    for (var k = 0; k < 5; k++) {
        let q = frame_pixel(p + CROSS[k]);
        sum += abs(luma_at(other, vec2<f32>(q) + shift) - luma_load(t0, q));
    }
    return sum;
}

fn trimmed_error(p: vec2<i32>, other: texture_2d<f32>, shift: vec2<f32>) -> f32 {
    var total = 0.0;
    var top = vec3<f32>(0.0);
    var center = 0.0;
    for (var k = 0; k < 9; k++) {
        let q = frame_pixel(p + vec2<i32>(k % 3 - 1, k / 3 - 1));
        let d = abs(luma_at(other, vec2<f32>(q) + shift) - luma_load(t0, q));
        if (k == 4) {
            center = d;
            continue;
        }
        total += d;
        let first = max(top.x, d);
        let pushed = min(top.x, d);
        let second = max(top.y, pushed);
        top = vec3<f32>(first, second, max(top.z, min(top.y, pushed)));
    }
    return center + total - top.x - top.y - top.z;
}

fn settled(p: vec2<i32>) -> bool {
    let q = frame_pixel(p);
    let c = luma_load(t0, q);
    let ahead = select(0.0, abs(luma_load(t1, q) - c), params.modes.x != 0u);
    let behind = select(0.0, abs(luma_load(t2, q) - c), params.modes.y != 0u);
    return max(ahead, behind) < STILL_CENTER;
}

fn resting_error(p: vec2<i32>) -> f32 {
    let ahead = trimmed_error(p, t1, vec2<f32>(0.0));
    let behind = trimmed_error(p, t2, vec2<f32>(0.0));
    if (params.modes.x == 0u) { return behind; }
    if (params.modes.y == 0u) { return ahead; }
    return max(ahead, behind);
}

fn moving_error(p: vec2<i32>, v: vec2<f32>) -> f32 {
    let ahead = trimmed_error(p, t1, v * params.values[0].y);
    let behind = trimmed_error(p, t2, -v * params.values[0].z);
    if (params.modes.x == 0u) { return behind; }
    if (params.modes.y == 0u) { return ahead; }
    return min(ahead, behind);
}

fn candidate_error(p: vec2<i32>, v: vec2<f32>) -> f32 {
    var error = 1.0e9;
    if (params.modes.x != 0u) {
        error = min(error, cross_error(p, t1, v * params.values[0].y));
    }
    if (params.modes.y != 0u) {
        error = min(error, cross_error(p, t2, -v * params.values[0].z));
    }
    return error;
}

fn field_at(center: vec2<f32>) -> vec2<f32> {
    let ratio = vec2<f32>(textureDimensions(t3)) / vec2<f32>(params.grid.dst);
    return (center + 0.5) * ratio - 0.5;
}

fn interpolated(center: vec2<f32>) -> vec4<f32> {
    return bilinear(t3, field_at(center));
}

@compute @workgroup_size(8, 8, 1)
fn fl_select(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy);
    let field_size = vec2<i32>(textureDimensions(t3));
    let ratio = vec2<f32>(field_size) / vec2<f32>(params.grid.dst);
    let at = (vec2<f32>(id.xy) + 0.5) * ratio - 0.5;
    let blended = bilinear(t3, at);
    let base = vec2<i32>(floor(at));
    let last = field_size - vec2<i32>(1);
    var spread = 0.0;
    for (var k = 0; k < 4; k++) {
        let c = textureLoad(t3, clamp(base + vec2<i32>(k % 2, k / 2), vec2<i32>(0), last), 0);
        spread = max(spread, length(c.xy - blended.xy));
    }
    let sides = (params.modes.x | params.modes.y) != 0u;
    let slack = SELECT_SLACK + SELECT_SPREAD * length(blended.xy);
    let mixed = sides && spread > slack;
    let measured = bilinear(t4, at);
    let apart = sides && length(measured.xy - blended.xy) > slack;
    let reach = max(params.values[0].y, params.values[0].z);
    let moving = sides && length(blended.xy) * reach >= SELECT_MOVING;
    var chosen = blended;
    var still = 1.0;
    if (moving && settled(p)) {
        let resting = resting_error(p);
        if (resting < STILL_LIMIT && STILL_RATIO * resting + STILL_MARGIN < moving_error(p, blended.xy)) {
            chosen = vec4<f32>(0.0);
            still = 0.0;
        }
    }
    if ((mixed || apart) && still > 0.5) {
        var best = candidate_error(p, blended.xy) - SELECT_BIAS;
        if (apart) {
            let error = candidate_error(p, measured.xy);
            if (error < MEASURED_SHARE * best) {
                best = error;
                chosen = measured;
            }
        }
        let far = i32(params.grid.radius);
        for (var j = -1; j <= 1 && mixed; j++) {
            for (var i = -1; i <= 1; i++) {
                for (var s = 0; s < 2; s++) {
                    if (s == 1 && i == 0 && j == 0) { continue; }
                    let q = clamp(base + vec2<i32>(i, j) * select(1, far, s == 1), vec2<i32>(0), last);
                    let c = textureLoad(t3, q, 0);
                    let error = candidate_error(p, c.xy);
                    if (error < best) {
                        best = error;
                        chosen = c;
                    }
                }
            }
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(exposed(steadied(chosen.xy, at)), chosen.z, still));
}

@compute @workgroup_size(8, 8, 1)
fn fl_clean(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy);
    let own = textureLoad(t0, p, 0);
    var kept = own;
    if (own.w < 0.5) {
        let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
        var still = 0;
        for (var k = 0; k < 9; k++) {
            let q = clamp(p + vec2<i32>(k % 3 - 1, k / 3 - 1), vec2<i32>(0), last);
            still += i32(textureLoad(t0, q, 0).w < 0.5);
        }
        if (still <= CLEAN_ALONE) {
            let blended = interpolated(vec2<f32>(id.xy));
            kept = vec4<f32>(exposed(steadied(blended.xy, field_at(vec2<f32>(id.xy)))), blended.z, 1.0);
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(kept.xyz, 1.0));
}

const SPLAT_OCCLUDED: f32 = 0.1;
const SPLAT_TRAVEL: f32 = 0.002;
const FILL_RINGS: i32 = 4;
const FILL_DIRECTIONS: i32 = 8;
const SMOOTH_SLACK: f32 = 0.75;
const SMOOTH_SPREAD: f32 = 0.1;
const SYNTH_SLACK: f32 = 0.5;
const SYNTH_SPREAD: f32 = 0.1;
const ONE_SIDED: f32 = 0.15;
const STILL_PIXEL: f32 = 0.03;
const STILL_MOVE: f32 = 1.5;
const OVERLAY_GAP: f32 = 0.08;
const OVERLAY_KEEP: f32 = 0.02;
const CUT_VISIBLE: f32 = 0.5;
const CUT_SHARE: f32 = 0.2;

fn splat_cost(p: vec2<i32>, flow: vec2<f32>, own: texture_2d<f32>, other: texture_2d<f32>) -> f32 {
    var sum = 0.0;
    for (var k = 0; k < 9; k++) {
        let q = p + vec2<i32>(k % 3 - 1, k / 3 - 1);
        sum += abs(bilinear(other, vec2<f32>(q) + flow).x - load_r(own, q));
    }
    return sum / 9.0;
}

@compute @workgroup_size(8, 8, 1)
fn fl_splat(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let width = params.grid.dst.x / 2u;
    let height = params.grid.dst.y;
    let side = id.x >= width;
    let p = vec2<i32>(i32(id.x - select(0u, width, side)), i32(id.y));
    let flow = textureLoad(t0, id.xy, 0).xy;
    let visible = side_weight(flow, half_bilinear(t0, vec2<f32>(p) + flow, !side).xy);
    var cost = 0.0;
    if (side) {
        cost = splat_cost(p, flow, t2, t1);
    } else {
        cost = splat_cost(p, flow, t1, t2);
    }
    let reach = select(params.values[0].x, 1.0 - params.values[0].x, side);
    cost += SPLAT_OCCLUDED * (1.0 - visible) + SPLAT_TRAVEL * reach;
    let rank = ~bitcast<u32>(cost);
    let corner = vec2<i32>(floor(vec2<f32>(p) + flow * reach));
    let owner = id.y * params.grid.dst.x + id.x + 1u;
    for (var k = 0; k < 4; k++) {
        let q = corner + vec2<i32>(k % 2, k / 2);
        if (any(q < vec2<i32>(0)) || q.x >= i32(width) || q.y >= i32(height)) { continue; }
        let index = u32(q.y) * width + u32(q.x);
        if (params.modes.x == 0u) {
            atomicMax(&scratch[index], rank);
        } else if (atomicLoad(&scratch[index]) == rank) {
            atomicMax(&scratch[width * height + index], owner);
        }
    }
}

@compute @workgroup_size(8, 8, 1)
fn fl_resolve(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let width = params.grid.dst.x;
    let owner = atomicLoad(&scratch[width * params.grid.dst.y + id.y * width + id.x]);
    if (owner == 0u) {
        textureStore(out_f32, id.xy, vec4<f32>(0.0, 0.0, 0.0, -1.0));
        return;
    }
    let pairs = 2u * width;
    let source = vec2<u32>((owner - 1u) % pairs, (owner - 1u) / pairs);
    let side = source.x >= width;
    let p = vec2<f32>(f32(source.x - select(0u, width, side)), f32(source.y));
    let flow = textureLoad(t0, source, 0).xy;
    let visible = side_weight(flow, half_bilinear(t0, p + flow, !side).xy);
    if (visible > CUT_VISIBLE) {
        atomicAdd(&scratch[2u * width * params.grid.dst.y], 1u);
    }
    textureStore(out_f32, id.xy, vec4<f32>(select(flow, -flow, side), f32(side), visible));
}

fn base_bilateral(p: vec2<f32>, v: vec2<f32>) -> f32 {
    let t = params.values[0].x;
    var sum = 0.0;
    for (var k = 0; k < 5; k++) {
        let q = p + vec2<f32>(CROSS[k]);
        sum += abs(bilinear(t1, q - t * v).x - bilinear(t2, q + (1.0 - t) * v).x);
    }
    return sum;
}

@compute @workgroup_size(8, 8, 1)
fn fl_fill(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy);
    let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
    var best = textureLoad(t0, p, 0);
    if (best.w < 0.0) {
        best = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        var lowest = 1.0e9;
        for (var ring = 0; ring < FILL_RINGS && lowest >= 1.0e9; ring++) {
            let radius = f32(1 << u32(ring));
            for (var k = 0; k < FILL_DIRECTIONS; k++) {
                let angle = f32(k) * 6.2831853 / f32(FILL_DIRECTIONS);
                let q = clamp(p + vec2<i32>(round(vec2<f32>(cos(angle), sin(angle)) * radius)), vec2<i32>(0), last);
                let c = textureLoad(t0, q, 0);
                if (c.w < 0.0) { continue; }
                let error = base_bilateral(vec2<f32>(p), c.xy);
                if (error < lowest) {
                    lowest = error;
                    best = c;
                }
            }
        }
    }
    let slack = SMOOTH_SLACK + SMOOTH_SPREAD * length(best.xy);
    var acc = vec3<f32>(best.xy, 1.0);
    for (var k = 0; k < 8; k++) {
        let c = textureLoad(t0, clamp(p + RING[k], vec2<i32>(0), last), 0);
        if (c.w >= 0.0 && length(c.xy - best.xy) < slack) {
            acc += vec3<f32>(c.xy, 1.0);
        }
    }
    textureStore(out_f32, id.xy, vec4<f32>(acc.xy / acc.z, best.zw));
}

fn cubic_weights(f: f32) -> vec4<f32> {
    let f2 = f * f;
    let f3 = f2 * f;
    return vec4<f32>(
        -0.5 * f3 + f2 - 0.5 * f,
        1.5 * f3 - 2.5 * f2 + 1.0,
        -1.5 * f3 + 2.0 * f2 + 0.5 * f,
        0.5 * f3 - 0.5 * f2,
    );
}

fn cubic(t: texture_2d<f32>, f: vec2<f32>) -> vec4<f32> {
    let last = vec2<i32>(textureDimensions(t)) - vec2<i32>(1);
    let c = clamp(f, vec2<f32>(0.0), vec2<f32>(last));
    let p = vec2<i32>(floor(c));
    let w = c - vec2<f32>(p);
    let wx = cubic_weights(w.x);
    let wy = cubic_weights(w.y);
    var sum = vec4<f32>(0.0);
    for (var j = 0; j < 4; j++) {
        var row = vec4<f32>(0.0);
        for (var i = 0; i < 4; i++) {
            row += wx[i] * textureLoad(t, clamp(p + vec2<i32>(i - 1, j - 1), vec2<i32>(0), last), 0);
        }
        sum += wy[j] * row;
    }
    return max(sum, vec4<f32>(0.0));
}

const RING: array<vec2<i32>, 8> = array<vec2<i32>, 8>(
    vec2<i32>(-1, -1),
    vec2<i32>(0, -1),
    vec2<i32>(1, -1),
    vec2<i32>(-1, 0),
    vec2<i32>(1, 0),
    vec2<i32>(-1, 1),
    vec2<i32>(0, 1),
    vec2<i32>(1, 1),
);

fn tone(c: vec4<f32>) -> f32 {
    return sqrt(max(plain_luma(c.rgb), 0.0));
}

fn tone_px(t: texture_2d<f32>, p: vec2<i32>) -> f32 {
    let last = vec2<i32>(textureDimensions(t)) - vec2<i32>(1);
    return tone(textureLoad(t, clamp(p, vec2<i32>(0), last), 0));
}

fn tone_at(t: texture_2d<f32>, f: vec2<f32>) -> f32 {
    return tone(bilinear(t, f));
}

fn frame_error(x: vec2<f32>, v: vec2<f32>) -> f32 {
    let t = params.values[0].x;
    var sum = 0.0;
    for (var k = 0; k < 5; k++) {
        let q = x + vec2<f32>(CROSS[k]);
        sum += abs(tone_at(t0, q - t * v) - tone_at(t1, q + (1.0 - t) * v));
    }
    return sum;
}

fn overlay(x: vec2<f32>, ratio: vec2<f32>) -> bool {
    let p = vec2<i32>(round(x));
    let still = tone_px(t0, p);
    if (abs(still - tone_px(t1, p)) >= STILL_PIXEL) { return false; }
    let at = (vec2<f32>(p) + 0.5) / ratio - 0.5;
    let ahead = half_bilinear(t3, at, false).xy * ratio;
    let behind = half_bilinear(t3, at, true).xy * ratio;
    let left = length(ahead) > STILL_MOVE && abs(tone_at(t1, vec2<f32>(p) + ahead) - still) > OVERLAY_GAP;
    let right = length(behind) > STILL_MOVE && abs(tone_at(t0, vec2<f32>(p) + behind) - still) > OVERLAY_GAP;
    return left && right;
}

fn record_error(x: vec2<f32>, record: vec4<f32>, ratio: vec2<f32>) -> f32 {
    return mix(ONE_SIDED, frame_error(x, record.xy * ratio), record.w);
}

fn side_factors(record: vec4<f32>) -> vec2<f32> {
    return vec2<f32>(mix(1.0, record.w, record.z), mix(record.w, 1.0, record.z));
}

fn within(p: vec2<f32>, size: vec2<f32>) -> bool {
    return all(p >= vec2<f32>(-0.5)) && all(p <= size - 0.5);
}

@compute @workgroup_size(8, 8, 1)
fn fl_synth(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let t = params.values[0].x;
    let ratio = params.values[0].yz;
    let size = vec2<f32>(params.grid.dst);
    let x = vec2<f32>(id.xy);
    let pixel = vec2<i32>(id.xy);
    let motion_size = textureDimensions(t2);
    if (f32(atomicLoad(&scratch[2u * motion_size.x * motion_size.y])) < CUT_SHARE * f32(motion_size.x * motion_size.y)) {
        textureStore(out_f16, id.xy, select(textureLoad(t1, pixel, 0), textureLoad(t0, pixel, 0), t < 0.5));
        return;
    }
    let at = (x + 0.5) / ratio - 0.5;
    let last = vec2<i32>(motion_size) - vec2<i32>(1);
    let base = vec2<i32>(floor(at));
    let blended = bilinear(t2, at);
    var spread = 0.0;
    for (var k = 0; k < 4; k++) {
        let c = textureLoad(t2, clamp(base + vec2<i32>(k % 2, k / 2), vec2<i32>(0), last), 0);
        spread = max(spread, length(c.xy - blended.xy));
    }
    var chosen = blended;
    var factors = vec2<f32>(0.0);
    if (spread > SYNTH_SLACK + SYNTH_SPREAD * length(blended.xy)) {
        var lowest = 1.0e9;
        for (var k = 0; k < 4; k++) {
            let c = textureLoad(t2, clamp(base + vec2<i32>(k % 2, k / 2), vec2<i32>(0), last), 0);
            let error = record_error(x, c, ratio);
            if (error < lowest) {
                lowest = error;
                chosen = c;
            }
        }
        factors = side_factors(chosen);
    } else {
        let tap = tap_from(at, textureDimensions(t2));
        let a = side_factors(textureLoad(t2, tap.p00, 0));
        let b = side_factors(textureLoad(t2, vec2<i32>(tap.p11.x, tap.p00.y), 0));
        let c = side_factors(textureLoad(t2, vec2<i32>(tap.p00.x, tap.p11.y), 0));
        let d = side_factors(textureLoad(t2, tap.p11, 0));
        factors = mix(mix(a, b, tap.w.x), mix(c, d, tap.w.x), tap.w.y);
    }
    let v = chosen.xy * ratio;
    let p0 = x - t * v;
    let p1 = x + (1.0 - t) * v;
    var w0 = (1.0 - t) * factors.x * f32(within(p0, size));
    var w1 = t * factors.y * f32(within(p1, size));
    let c0 = cubic(t0, p0);
    let c1 = cubic(t1, p1);
    if (abs(tone(c0) - tone(c1)) > OVERLAY_GAP) {
        let s0 = overlay(p0, ratio);
        let s1 = overlay(p1, ratio);
        if (s0 && !s1) {
            w0 *= OVERLAY_KEEP;
        } else if (s1 && !s0) {
            w1 *= OVERLAY_KEEP;
        }
    }
    var moved = mix(c0, c1, t);
    if (w0 + w1 > 1.0e-6) {
        moved = (w0 * c0 + w1 * c1) / (w0 + w1);
    }
    let held = mix(textureLoad(t0, pixel, 0), textureLoad(t1, pixel, 0), t);
    if (overlay(x, ratio)) {
        textureStore(out_f16, id.xy, held);
        return;
    }
    textureStore(out_f16, id.xy, moved);
}

const LINK_BINS: u32 = 64u;
const LINK_FILL: i32 = 6;
const LINK_TAPS: f32 = 49.0;
const LINK_MATCH: f32 = 0.05;
const LINK_MATCH_RATIO: f32 = 0.15;
const CARRY_FLOOR: f32 = 0.05;

fn link_weight(p: vec2<f32>, flow: vec2<f32>, upper: bool) -> f32 {
    let q = p + flow;
    let size = vec2<f32>(params.grid.dst);
    if (any(q < vec2<f32>(-0.5)) || any(q > size - 0.5)) {
        return 0.0;
    }
    return side_weight(flow, half_bilinear(t0, q, !upper).xy);
}

@compute @workgroup_size(8, 8, 1)
fn fl_link(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let upper = params.modes.x != 0u;
    let p = vec2<f32>(id.xy);
    let size = vec2<f32>(params.grid.dst);
    let flow = half_bilinear(t0, p, upper).xy;
    let q = p + flow;
    let inside = all(q >= vec2<f32>(-0.5)) && all(q <= size - 0.5);
    let weight = link_weight(p, flow, upper);
    var kept = vec3<f32>(flow, weight);
    if (weight < 0.5) {
        var sum = vec3<f32>(0.0);
        for (var y = -LINK_FILL; y <= LINK_FILL; y += 2) {
            for (var x = -LINK_FILL; x <= LINK_FILL; x += 2) {
                let n = clamp(p + vec2<f32>(f32(x), f32(y)), vec2<f32>(0.0), size - 1.0);
                let other = half_bilinear(t0, n, upper).xy;
                let w = link_weight(n, other, upper);
                sum += vec3<f32>(other * w, w);
            }
        }
        if (sum.z > 0.5) {
            kept = vec3<f32>(sum.xy / sum.z, max(weight, 0.5 * sum.z / LINK_TAPS));
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(kept, 1.0));
    if (params.modes.y != 0u && (id.x & 1u) == 0u && (id.y & 1u) == 0u) {
        atomicAdd(&scratch[min(u32(length(flow)), LINK_BINS - 1u)], 1u);
        let own = plain_luma(textureLoad(t1, id.xy, 0).rgb);
        let other = luma_at(t2, q);
        if (!inside) {
            atomicAdd(&scratch[LINK_BINS], 1u);
        } else if (abs(own - other) > LINK_MATCH + LINK_MATCH_RATIO * max(own, other)) {
            atomicAdd(&scratch[LINK_BINS + 1u], 1u);
        }
    }
}

struct Carried {
    value: vec4<f32>,
    weight: f32,
}

fn carried(map: texture_2d<f32>, link: texture_2d<f32>, p: vec2<f32>) -> Carried {
    let step = bilinear(link, p);
    let scale = vec2<f32>(textureDimensions(map)) / vec2<f32>(textureDimensions(link));
    return Carried(bilinear(map, (p + step.xy + 0.5) * scale - 0.5), step.z);
}

@compute @workgroup_size(8, 8, 1)
fn fl_carry(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let base = vec2<f32>(textureDimensions(t2));
    let p = (vec2<f32>(id.xy) + 0.5) * base / vec2<f32>(params.grid.dst) - 0.5;
    let alpha = params.values[0].x;
    let a = carried(t0, t2, p);
    var value = a.value;
    var other = 0.0;
    if (params.modes.x != 0u) {
        let b = carried(t1, t3, p);
        other = b.weight;
        let wa = (1.0 - alpha) * (CARRY_FLOOR + a.weight);
        let wb = alpha * (CARRY_FLOOR + b.weight);
        value = (wa * a.value + wb * b.value) / (wa + wb);
    }
    textureStore(out_f32, id.xy, value);
    textureStore(out_r32, id.xy, value);
    textureStore(out_f16, id.xy, vec4<f32>(a.weight, other, 0.0, 1.0));
}
