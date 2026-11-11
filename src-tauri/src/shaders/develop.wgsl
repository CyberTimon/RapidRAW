struct Finish {
    dims: vec4<u32>,
    mode: vec4<u32>,
    grid: vec4<u32>,
    wb: vec4<f32>,
    neutral: vec4<f32>,
    matrix: array<vec4<f32>, 3>,
    comp: array<vec4<f32>, 3>,
    amounts: vec4<f32>,
    half: vec4<u32>,
    quarter: vec4<u32>,
    planes: array<vec4<u32>, 5>,
    cells: vec4<u32>,
    pyr: array<vec4<u32>, 32>,
}

@group(0) @binding(0) var<uniform> F: Finish;
@group(0) @binding(1) var<uniform> T: vec4<u32>;
@group(0) @binding(2) var<storage, read> cam: array<f32>;
@group(0) @binding(3) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> grid: array<f32>;
@group(0) @binding(5) var<storage, read_write> pl: array<f32>;
@group(0) @binding(6) var<storage, read_write> dst: array<f32>;

const HIGHLIGHTS: u32 = 1u;
const DENOISE: u32 = 2u;
const SHARPEN: u32 = 4u;
const COLOR: u32 = 8u;

const CLIP_THRESHOLD: f32 = 0.985;
const SOFT_THRESHOLD: f32 = 0.90;
const MIN_SAMPLE_LEVEL: f32 = 0.2;
const ITERATIONS: i32 = 3;
const FULL_CLIP_CHROMA: f32 = 0.35;
const HEADROOM_FADE: f32 = 0.3;
const FILL_SPREAD_START: f32 = 0.25;
const FILL_SPREAD_END: f32 = 0.6;
const FILL_STRENGTH: f32 = 0.5;
const FILL_SAMPLE_SPREAD: f32 = 0.25;
const LEVEL_BINS: u32 = 2048u;
const LEVEL_LOW: f32 = 0.75;
const LEVEL_HIGH: f32 = 1.25;
const PLATEAU_RATIO: f32 = 8.0;
const COMPRESSION_POWER: f32 = 1.2;
const FLOOR: f32 = 0.002;
const PAD: i32 = 2;

const HIST: u32 = 0u;
const RADIX: u32 = 6144u;
const ANY_MASK: u32 = 8192u;
const ANY_BLOWN: u32 = 8193u;
const PREFIX: u32 = 8194u;
const RANK: u32 = 8195u;

const G_CLIPS: u32 = 0u;
const G_THRESHOLDS: u32 = 3u;
const G_SOFT: u32 = 6u;
const G_ANY_MASK: u32 = 9u;
const G_ANY_BLOWN: u32 = 10u;
const G_MEDIANS: u32 = 11u;

const MED_HALF_Q: u32 = 0u;
const MED_HALF_C: u32 = 1u;
const MED_QUARTER_Q: u32 = 2u;
const MED_QUARTER_C: u32 = 3u;
const MED_CORE: u32 = 4u;
const MED_FULL_C: u32 = 5u;
const MED_SHARPEN: u32 = 6u;

var<workgroup> bins: array<atomic<u32>, 2048>;

fn flag(f: u32) -> bool {
    return (F.mode.y & f) != 0u;
}

fn global3(i: u32) -> vec3<f32> {
    return vec3<f32>(grid[i], grid[i + 1u], grid[i + 2u]);
}

fn clips() -> vec3<f32> {
    return global3(G_CLIPS);
}

fn thresholds() -> vec3<f32> {
    return global3(G_THRESHOLDS);
}

fn softs() -> vec3<f32> {
    return global3(G_SOFT);
}

fn any_mask() -> bool {
    return grid[G_ANY_MASK] != 0.0;
}

fn any_blown() -> bool {
    return grid[G_ANY_BLOWN] != 0.0;
}

fn median(m: u32) -> f32 {
    return grid[G_MEDIANS + m];
}

fn ease(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

fn croot(v: f32) -> f32 {
    return select(0.0, pow(v, 1.0 / 3.0), v > 0.0);
}

fn observed(x: i32, y: i32) -> vec3<f32> {
    let w = i32(F.dims.x);
    let i = u32(clamp(y, 0, i32(F.dims.y) - 1) * w + clamp(x, 0, w - 1)) * 3u;
    return vec3<f32>(cam[i], cam[i + 1u], cam[i + 2u]);
}

fn mask_bits(p: vec3<f32>) -> u32 {
    let t = thresholds();
    return u32(p.x >= t.x) | (u32(p.y >= t.y) << 1u) | (u32(p.z >= t.z) << 2u);
}

fn blends(p: vec3<f32>) -> vec3<f32> {
    let s = softs();
    let t = thresholds();
    return vec3<f32>(ease(s.x, t.x, p.x), ease(s.y, t.y, p.y), ease(s.z, t.z, p.z));
}

fn full_blend(p: vec3<f32>) -> f32 {
    let b = blends(p);
    return min(min(b.x, b.y), b.z);
}

fn near_mask(x: i32, y: i32) -> u32 {
    var bits = 0u;
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            bits |= mask_bits(observed(x + dx, y + dy));
        }
    }
    return bits;
}

fn near_blown(x: i32, y: i32) -> bool {
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            if (full_blend(observed(x + dx, y + dy)) > 0.0) {
                return true;
            }
        }
    }
    return false;
}

fn opposed(r: vec3<f32>, c: u32) -> f32 {
    var m: f32;
    if (c == 0u) {
        m = 0.5 * (r.y + r.z);
    } else if (c == 1u) {
        m = 0.5 * (r.z + r.x);
    } else {
        m = 0.5 * (r.x + r.y);
    }
    return m * m * m;
}

fn level(p: u32, l: u32) -> vec4<u32> {
    return F.pyr[p * 16u + l];
}

fn sample_filled(p: u32, l: u32, gx: f32, gy: f32) -> vec3<f32> {
    let lv = level(p, l);
    let w = i32(lv.x);
    let h = i32(lv.y);
    let x = clamp(gx, 0.0, f32(w - 1));
    let y = clamp(gy, 0.0, f32(h - 1));
    let x0 = i32(x);
    let y0 = i32(y);
    let x1 = min(x0 + 1, w - 1);
    let y1 = min(y0 + 1, h - 1);
    let fx = x - f32(x0);
    let fy = y - f32(y0);
    let o = lv.w;
    let ia = o + u32(y0 * w + x0) * 3u;
    let ib = o + u32(y0 * w + x1) * 3u;
    let ic = o + u32(y1 * w + x0) * 3u;
    let id = o + u32(y1 * w + x1) * 3u;
    let a = vec3<f32>(grid[ia], grid[ia + 1u], grid[ia + 2u]);
    let b = vec3<f32>(grid[ib], grid[ib + 1u], grid[ib + 2u]);
    let c = vec3<f32>(grid[ic], grid[ic + 1u], grid[ic + 2u]);
    let d = vec3<f32>(grid[id], grid[id + 1u], grid[id + 2u]);
    let top = a + (b - a) * fx;
    let bottom = c + (d - c) * fx;
    return top + (bottom - top) * fy;
}

fn cell_coord(v: i32) -> f32 {
    return (f32(v) + 0.5) / f32(F.mode.z) - 0.5;
}

fn rebuild(x: i32, y: i32, obs: vec3<f32>) -> vec3<f32> {
    if (!flag(HIGHLIGHTS) || !any_mask()) {
        return obs;
    }
    let blend = blends(obs);
    if (blend.x == 0.0 && blend.y == 0.0 && blend.z == 0.0) {
        return obs;
    }
    let offset = sample_filled(0u, 0u, cell_coord(x), cell_coord(y));
    var pixel = obs;
    var roots = vec3<f32>(croot(obs.x), croot(obs.y), croot(obs.z));
    for (var iteration = 0; iteration < ITERATIONS; iteration++) {
        for (var c = 0u; c < 3u; c++) {
            if (blend[c] > 0.0) {
                let rebuilt = max(obs[c], opposed(roots, c) + offset[c]);
                pixel[c] = obs[c] + (rebuilt - obs[c]) * blend[c];
            }
        }
        if (iteration + 1 < ITERATIONS) {
            for (var c = 0u; c < 3u; c++) {
                if (blend[c] > 0.0) {
                    roots[c] = croot(pixel[c]);
                }
            }
        }
    }
    let bits = mask_bits(obs);
    let cl = clips();
    var headroom = 0.0;
    for (var c = 0u; c < 3u; c++) {
        if ((bits & (1u << c)) == 0u) {
            headroom = max(headroom, 1.0 - obs[c] / cl[c]);
        }
    }
    let keep = FULL_CLIP_CHROMA + (1.0 - FULL_CLIP_CHROMA) * ease(0.0, HEADROOM_FADE, headroom);
    let mean = (pixel.x + pixel.y + pixel.z) / 3.0;
    for (var c = 0u; c < 3u; c++) {
        if (blend[c] > 0.0) {
            let faded = max(obs[c], mean + (pixel[c] - mean) * keep);
            pixel[c] = obs[c] + (faded - obs[c]) * blend[c];
        }
    }
    return pixel;
}

fn refill(x: i32, y: i32, obs: vec3<f32>, rebuilt: vec3<f32>) -> vec3<f32> {
    if (!flag(HIGHLIGHTS) || !any_mask() || !any_blown()) {
        return rebuilt;
    }
    let full = full_blend(obs);
    if (full <= 0.0) {
        return rebuilt;
    }
    let chroma = sample_filled(1u, 0u, cell_coord(x), cell_coord(y));
    let rg = chroma.x;
    let bg = chroma.y;
    let spread = max(max(rg, bg), 0.0) - min(min(rg, bg), 0.0);
    let strength = FILL_STRENGTH * (1.0 - ease(FILL_SPREAD_START, FILL_SPREAD_END, spread));
    let tint = vec3<f32>(exp(rg * strength), 1.0, exp(bg * strength));
    let brightness = (rebuilt.x + rebuilt.y + rebuilt.z) / (tint.x + tint.y + tint.z);
    var scale = brightness;
    for (var c = 0u; c < 3u; c++) {
        scale = max(scale, obs[c] / tint[c]);
    }
    return rebuilt + (scale * tint - rebuilt) * full;
}

fn compress(c: u32, d: f32) -> f32 {
    let k = F.comp[c];
    if (k.x == 0.0 || d <= k.y) {
        return d;
    }
    let excess = d - k.y;
    return k.y + excess / pow(1.0 + pow(excess / k.z, COMPRESSION_POWER), 1.0 / COMPRESSION_POWER);
}

fn to_output(p: vec3<f32>) -> vec3<f32> {
    if (!flag(COLOR)) {
        return p;
    }
    let c = p * F.neutral.xyz;
    var rgb = vec3<f32>(
        F.matrix[0].x * c.x + F.matrix[0].y * c.y + F.matrix[0].z * c.z,
        F.matrix[1].x * c.x + F.matrix[1].y * c.y + F.matrix[1].z * c.z,
        F.matrix[2].x * c.x + F.matrix[2].y * c.y + F.matrix[2].z * c.z,
    );
    let achromatic = max(max(rgb.x, rgb.y), rgb.z);
    if (achromatic <= 0.0) {
        return vec3<f32>(0.0);
    }
    for (var i = 0u; i < 3u; i++) {
        let distance = (achromatic - rgb[i]) / achromatic;
        rgb[i] = achromatic - compress(i, distance) * achromatic;
    }
    return clamp(rgb, vec3<f32>(0.0), vec3<f32>(F.wb.w));
}

fn source(o: vec2<i32>) -> vec2<i32> {
    let w = i32(F.dims.x);
    let h = i32(F.dims.y);
    switch (F.mode.x) {
        case 1u: {
            return vec2<i32>(w - 1 - o.x, o.y);
        }
        case 2u: {
            return vec2<i32>(w - 1 - o.x, h - 1 - o.y);
        }
        case 3u: {
            return vec2<i32>(o.x, h - 1 - o.y);
        }
        case 4u: {
            return vec2<i32>(o.y, o.x);
        }
        case 5u: {
            return vec2<i32>(o.y, h - 1 - o.x);
        }
        case 6u: {
            return vec2<i32>(w - 1 - o.y, h - 1 - o.x);
        }
        case 7u: {
            return vec2<i32>(w - 1 - o.y, o.x);
        }
        default: {
            return o;
        }
    }
}

fn developed(o: vec2<i32>) -> vec3<f32> {
    let s = source(o);
    let obs = observed(s.x, s.y);
    return to_output(refill(s.x, s.y, obs, rebuild(s.x, s.y, obs)));
}

fn stabilize(rgb: vec3<f32>) -> vec3<f32> {
    let l = 0.2126 * rgb.x + 0.7152 * rgb.y + 0.0722 * rgb.z;
    let s = sqrt(max(l, 0.0) + FLOOR);
    return vec3<f32>(s, sqrt(max(rgb.x, 0.0) + FLOOR) - s, sqrt(max(rgb.z, 0.0) + FLOOR) - s);
}

@compute @workgroup_size(256)
fn hl_hist(@builtin(local_invocation_index) li: u32, @builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
    let n = F.dims.x * F.dims.y;
    let stride = nw.x * 256u;
    let per_unit = f32(LEVEL_BINS) / (LEVEL_HIGH - LEVEL_LOW);
    for (var c = 0u; c < 3u; c++) {
        for (var b = li; b < LEVEL_BINS; b += 256u) {
            atomicStore(&bins[b], 0u);
        }
        workgroupBarrier();
        for (var i = gid.x; i < n; i += stride) {
            let bin = (cam[i * 3u + c] * F.neutral[c] - LEVEL_LOW) * per_unit;
            if (bin >= 0.0 && bin < f32(LEVEL_BINS)) {
                atomicAdd(&bins[u32(bin)], 1u);
            }
        }
        workgroupBarrier();
        for (var b = li; b < LEVEL_BINS; b += 256u) {
            let v = atomicLoad(&bins[b]);
            if (v != 0u) {
                atomicAdd(&stats[HIST + c * LEVEL_BINS + b], v);
            }
        }
        workgroupBarrier();
    }
}

@compute @workgroup_size(1)
fn hl_levels() {
    let per_unit = f32(LEVEL_BINS) / (LEVEL_HIGH - LEVEL_LOW);
    var found = vec3<f32>(-1.0);
    for (var c = 0u; c < 3u; c++) {
        var peak = 0u;
        var count = 0u;
        for (var b = 0u; b < LEVEL_BINS; b++) {
            let v = atomicLoad(&stats[HIST + c * LEVEL_BINS + b]);
            if (v >= count) {
                count = v;
                peak = b;
            }
        }
        if (count < F.grid.w || peak < 80u) {
            continue;
        }
        var below: array<u32, 60>;
        for (var k = 0u; k < 60u; k++) {
            below[k] = atomicLoad(&stats[HIST + c * LEVEL_BINS + peak - 80u + k]);
        }
        for (var a = 1u; a < 60u; a++) {
            let v = below[a];
            var j = a;
            while (j > 0u && below[j - 1u] > v) {
                below[j] = below[j - 1u];
                j--;
            }
            below[j] = v;
        }
        let baseline = f32(below[30]);
        var above = 0u;
        for (var b = min(peak + 4u, LEVEL_BINS); b < LEVEL_BINS; b++) {
            above += atomicLoad(&stats[HIST + c * LEVEL_BINS + b]);
        }
        if (f32(count) >= PLATEAU_RATIO * (baseline + 1.0) && above < count) {
            found[c] = LEVEL_LOW + (f32(peak) + 0.5) / per_unit;
        }
    }
    var fallback = 1.0;
    var any = false;
    for (var c = 0u; c < 3u; c++) {
        if (found[c] >= 0.0) {
            fallback = select(found[c], min(fallback, found[c]), any);
            any = true;
        }
    }
    for (var c = 0u; c < 3u; c++) {
        let lv = select(fallback, found[c], found[c] >= 0.0);
        let clip = F.wb[c] * lv;
        grid[G_CLIPS + c] = clip;
        grid[G_THRESHOLDS + c] = clip * CLIP_THRESHOLD;
        grid[G_SOFT + c] = clip * SOFT_THRESHOLD;
    }
}

@compute @workgroup_size(8, 8)
fn hl_cells(@builtin(global_invocation_id) id: vec3<u32>) {
    let gw = F.grid.x;
    if (id.x >= gw || id.y >= F.grid.y) {
        return;
    }
    let cell = F.mode.z;
    var bits = 0u;
    for (var y = id.y * cell; y < min((id.y + 1u) * cell, F.dims.y); y++) {
        for (var x = id.x * cell; x < min((id.x + 1u) * cell, F.dims.x); x++) {
            let p = observed(i32(x), i32(y));
            bits |= mask_bits(p);
            if (full_blend(p) > 0.0) {
                bits |= 8u;
            }
        }
    }
    if ((bits & 7u) != 0u) {
        atomicOr(&stats[ANY_MASK], 1u);
    }
    if ((bits & 8u) != 0u) {
        atomicOr(&stats[ANY_BLOWN], 1u);
    }
    grid[F.cells.x + id.y * gw + id.x] = f32(bits);
}

@compute @workgroup_size(1)
fn hl_flags() {
    grid[G_ANY_MASK] = f32(atomicLoad(&stats[ANY_MASK]));
    grid[G_ANY_BLOWN] = f32(atomicLoad(&stats[ANY_BLOWN]));
}

@compute @workgroup_size(8, 8)
fn hl_dilate(@builtin(global_invocation_id) id: vec3<u32>) {
    let gw = i32(F.grid.x);
    let gh = i32(F.grid.y);
    if (i32(id.x) >= gw || i32(id.y) >= gh) {
        return;
    }
    let r = i32(F.mode.w);
    var bits = 0u;
    for (var k = -r; k <= r; k++) {
        var x = i32(id.x);
        var y = i32(id.y);
        if (T.x == 0u) {
            y = clamp(y + k, 0, gh - 1);
        } else {
            x = clamp(x + k, 0, gw - 1);
        }
        bits |= u32(grid[T.y + u32(y * gw + x)]);
    }
    grid[T.z + id.y * u32(gw) + id.x] = f32(bits);
}

@compute @workgroup_size(8, 8)
fn hl_inpaint(@builtin(global_invocation_id) id: vec3<u32>) {
    let gw = F.grid.x;
    if (id.x >= gw || id.y >= F.grid.y) {
        return;
    }
    let o = level(0u, 0u).z + (id.y * gw + id.x) * 6u;
    var weight = vec3<f32>(0.0);
    var offset = vec3<f32>(0.0);
    let channels = u32(grid[F.cells.z + id.y * gw + id.x]) & 7u;
    if (channels != 0u && any_mask()) {
        let cell = F.mode.z;
        let cl = clips();
        let th = thresholds();
        let lo = cl * MIN_SAMPLE_LEVEL;
        for (var y = id.y * cell; y < min((id.y + 1u) * cell, F.dims.y); y++) {
            for (var x = id.x * cell; x < min((id.x + 1u) * cell, F.dims.x); x++) {
                let usable = channels & ~near_mask(i32(x), i32(y));
                if (usable == 0u) {
                    continue;
                }
                let p = observed(i32(x), i32(y));
                let roots = vec3<f32>(croot(p.x), croot(p.y), croot(p.z));
                for (var c = 0u; c < 3u; c++) {
                    if ((usable & (1u << c)) == 0u || p[c] <= lo[c] || p[c] >= th[c]) {
                        continue;
                    }
                    let lv = p[c] * (1.0 / cl[c]);
                    let w = lv * lv;
                    weight[c] += w;
                    offset[c] += w * (p[c] - opposed(roots, c));
                }
            }
        }
    }
    grid[o] = weight.x;
    grid[o + 1u] = weight.y;
    grid[o + 2u] = weight.z;
    grid[o + 3u] = offset.x;
    grid[o + 4u] = offset.y;
    grid[o + 5u] = offset.z;
}

@compute @workgroup_size(8, 8)
fn hl_fill(@builtin(global_invocation_id) id: vec3<u32>) {
    let gw = F.grid.x;
    if (id.x >= gw || id.y >= F.grid.y) {
        return;
    }
    let o = level(1u, 0u).z + (id.y * gw + id.x) * 6u;
    var weight = 0.0;
    var rg_sum = 0.0;
    var bg_sum = 0.0;
    let band = (u32(grid[F.cells.z + id.y * gw + id.x]) & 8u) != 0u;
    if (band && any_mask() && any_blown()) {
        let cell = F.mode.z;
        for (var y = id.y * cell; y < min((id.y + 1u) * cell, F.dims.y); y++) {
            for (var x = id.x * cell; x < min((id.x + 1u) * cell, F.dims.x); x++) {
                let obs = observed(i32(x), i32(y));
                if (countOneBits(mask_bits(obs)) != 1u || near_blown(i32(x), i32(y))) {
                    continue;
                }
                let p = rebuild(i32(x), i32(y), obs);
                if (p.x <= 0.0 || p.y <= 0.0 || p.z <= 0.0) {
                    continue;
                }
                let rg = log(p.x / p.y);
                let bg = log(p.z / p.y);
                let spread = (max(max(rg, bg), 0.0) - min(min(rg, bg), 0.0)) / FILL_SAMPLE_SPREAD;
                let w = 1.0 / (1.0 + spread * spread);
                weight += w;
                rg_sum += w * rg;
                bg_sum += w * bg;
            }
        }
    }
    grid[o] = weight;
    grid[o + 1u] = weight;
    grid[o + 2u] = 0.0;
    grid[o + 3u] = rg_sum;
    grid[o + 4u] = bg_sum;
    grid[o + 5u] = 0.0;
}

@compute @workgroup_size(8, 8)
fn pp_down(@builtin(global_invocation_id) id: vec3<u32>) {
    let src = level(T.x, T.y);
    let dst = level(T.x, T.y + 1u);
    if (id.x >= dst.x || id.y >= dst.y) {
        return;
    }
    var acc: array<f32, 6>;
    for (var yy = 2u * id.y; yy < min(2u * id.y + 2u, src.y); yy++) {
        for (var xx = 2u * id.x; xx < min(2u * id.x + 2u, src.x); xx++) {
            let o = src.z + (yy * src.x + xx) * 6u;
            for (var k = 0u; k < 6u; k++) {
                acc[k] += grid[o + k];
            }
        }
    }
    let o = dst.z + (id.y * dst.x + id.x) * 6u;
    for (var k = 0u; k < 6u; k++) {
        grid[o + k] = acc[k];
    }
}

@compute @workgroup_size(8, 8)
fn pp_up(@builtin(global_invocation_id) id: vec3<u32>) {
    let lv = level(T.x, T.y);
    if (id.x >= lv.x || id.y >= lv.y) {
        return;
    }
    let o = lv.z + (id.y * lv.x + id.x) * 6u;
    let weight = vec3<f32>(grid[o], grid[o + 1u], grid[o + 2u]);
    let offset = vec3<f32>(grid[o + 3u], grid[o + 4u], grid[o + 5u]);
    var out = vec3<f32>(0.0);
    if (T.z == 1u) {
        for (var i = 0u; i < 3u; i++) {
            out[i] = select(0.0, offset[i] / weight[i], weight[i] > 0.0);
        }
    } else {
        let up = level(T.x, T.y + 1u);
        let sx = (f32(id.x) + 0.5) * (f32(up.x) / f32(lv.x)) - 0.5;
        let sy = (f32(id.y) + 0.5) * (f32(up.y) / f32(lv.y)) - 0.5;
        let coarse = sample_filled(T.x, T.y + 1u, sx, sy);
        let full_weight = F.amounts[2u + T.x];
        for (var i = 0u; i < 3u; i++) {
            if (weight[i] > 0.0) {
                let alpha = min(weight[i] / full_weight, 1.0);
                out[i] = coarse[i] + (offset[i] / weight[i] - coarse[i]) * alpha;
            } else {
                out[i] = coarse[i];
            }
        }
    }
    let f = lv.w + (id.y * lv.x + id.x) * 3u;
    grid[f] = out.x;
    grid[f + 1u] = out.y;
    grid[f + 2u] = out.z;
}

fn half_at(x: i32, y: i32) -> u32 {
    return u32((y + PAD) * i32(F.half.z) + x + PAD);
}

@compute @workgroup_size(8, 8)
fn nr_half(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= F.half.z || id.y >= F.half.w) {
        return;
    }
    let x = min(u32(max(i32(id.x) - PAD, 0)), F.half.x - 1u);
    let y = min(u32(max(i32(id.y) - PAD, 0)), F.half.y - 1u);
    var sum = vec3<f32>(0.0);
    for (var k = 0u; k < 2u; k++) {
        let sy = min(2u * y + k, F.dims.w - 1u);
        for (var j = 0u; j < 2u; j++) {
            let sx = min(2u * x + j, F.dims.z - 1u);
            sum += developed(vec2<i32>(i32(sx), i32(sy))) * 0.25;
        }
    }
    let s = stabilize(sum);
    let i = id.y * F.half.z + id.x;
    pl[F.planes[0].x + i] = s.x;
    pl[F.planes[0].y + i] = s.y;
    pl[F.planes[0].z + i] = s.z;
}

@compute @workgroup_size(8, 8)
fn nr_quarter(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= F.quarter.z || id.y >= F.quarter.w) {
        return;
    }
    let x = min(u32(max(i32(id.x) - PAD, 0)), F.quarter.x - 1u);
    let y = min(u32(max(i32(id.y) - PAD, 0)), F.quarter.y - 1u);
    var sum = vec3<f32>(0.0);
    for (var k = 0u; k < 2u; k++) {
        let sy = min(2u * y + k, F.half.y - 1u);
        for (var j = 0u; j < 2u; j++) {
            let sx = min(2u * x + j, F.half.x - 1u);
            let i = half_at(i32(sx), i32(sy));
            sum.x += pl[F.planes[0].x + i] * 0.25;
            sum.y += pl[F.planes[0].y + i] * 0.25;
            sum.z += pl[F.planes[0].z + i] * 0.25;
        }
    }
    let i = id.y * F.quarter.z + id.x;
    pl[F.planes[2].x + i] = sum.x;
    pl[F.planes[2].y + i] = sum.y;
    pl[F.planes[2].z + i] = sum.z;
}

struct Scale {
    q: u32,
    cr: u32,
    cb: u32,
    rel: u32,
    widen: u32,
    out_r: u32,
    out_b: u32,
    w: u32,
    h: u32,
    pw: u32,
    ph: u32,
    noise_q: f32,
    noise_c: f32,
}

fn noise(m: u32) -> f32 {
    return max(median(m) * 1.4826 / sqrt(2.0), 1e-3);
}

fn scale_of(s: u32) -> Scale {
    if (s == 0u) {
        return Scale(F.planes[0].x, F.planes[0].y, F.planes[0].z, F.planes[0].w, F.planes[1].x,
            F.planes[1].w, F.planes[2].w, F.half.x, F.half.y, F.half.z, F.half.w,
            noise(MED_HALF_Q), noise(MED_HALF_C));
    }
    return Scale(F.planes[2].x, F.planes[2].y, F.planes[2].z, F.planes[3].x, F.planes[3].y,
        F.planes[3].z, F.planes[3].w, F.quarter.x, F.quarter.y, F.quarter.z, F.quarter.w,
        noise(MED_QUARTER_Q), noise(MED_QUARTER_C));
}

@compute @workgroup_size(8, 8)
fn nr_relwiden(@builtin(global_invocation_id) id: vec3<u32>) {
    let s = scale_of(T.x);
    if (id.x >= s.pw || id.y >= s.ph) {
        return;
    }
    let i = id.y * s.pw + id.x;
    var rel = 1.0;
    var widen = 1.0;
    if (id.y > 0u && id.y + 1u < s.ph && id.x > 0u && id.x + 1u < s.pw) {
        let luma_tol = (1.5 + 2.0 * F.amounts.x) * s.noise_q;
        let g = 0.5 * max(abs(pl[s.q + i + 1u] - pl[s.q + i - 1u]), abs(pl[s.q + i + s.pw] - pl[s.q + i - s.pw]));
        let t = g / luma_tol;
        rel = 1.0 / (1.0 + t * t);
        let f = 1.0 + 2.0 * t;
        widen = 1.0 / (f * f);
    }
    pl[s.rel + i] = rel;
    pl[s.widen + i] = widen;
}

@compute @workgroup_size(8, 8)
fn nr_filter(@builtin(global_invocation_id) id: vec3<u32>) {
    let s = scale_of(T.x);
    if (id.x >= s.w || id.y >= s.h) {
        return;
    }
    let a = F.amounts.x;
    let luma_tol = (1.5 + 2.0 * a) * s.noise_q;
    let chroma_tol = (2.0 + 3.0 * a) * s.noise_c;
    let sigma = 1.5 + a;
    let kq = 1.0 / (luma_tol * luma_tol);
    let kc = 1.0 / (chroma_tol * chroma_tol);
    let eps = luma_tol * luma_tol;
    let pw = s.pw;
    let c = (id.y + 2u) * pw + id.x + 2u;
    let qc = pl[s.q + c];
    let wc = pl[s.widen + c];
    let o = id.y * s.w + id.x;
    var ref_r = 0.0;
    var ref_b = 0.0;
    if (T.y == 1u) {
        ref_r = pl[F.planes[1].y + o];
        ref_b = pl[F.planes[1].z + o];
    } else {
        var ref_w = 0.0;
        for (var j = 1u; j <= 3u; j++) {
            for (var i = 1u; i <= 3u; i++) {
                let k = (id.y + j) * pw + id.x + i;
                let dx = f32(i) - 2.0;
                let dy = f32(j) - 2.0;
                let sp = exp(-(dx * dx + dy * dy) / (2.0 * sigma * sigma));
                let d = pl[s.q + k] - qc;
                let t = max(1.0 - d * d * kq * wc, 0.0);
                let wt = sp * pl[s.rel + k] * t * t;
                ref_r += wt * pl[s.cr + k];
                ref_b += wt * pl[s.cb + k];
                ref_w += wt;
            }
        }
        let inv = 1.0 / ref_w;
        ref_r *= inv;
        ref_b *= inv;
    }
    var sw = 0.0;
    var sd = 0.0;
    var sdd = 0.0;
    var sr = 0.0;
    var sb = 0.0;
    var sdr = 0.0;
    var sdb = 0.0;
    for (var j = 0u; j < 5u; j++) {
        for (var i = 0u; i < 5u; i++) {
            let k = (id.y + j) * pw + id.x + i;
            let dx = f32(i) - 2.0;
            let dy = f32(j) - 2.0;
            let sp = exp(-(dx * dx + dy * dy) / (2.0 * sigma * sigma));
            let d = pl[s.q + k] - qc;
            let crs = pl[s.cr + k];
            let cbs = pl[s.cb + k];
            let er = crs - ref_r;
            let eb = cbs - ref_b;
            let t = max(1.0 - (d * d * kq + (er * er + eb * eb) * kc) * wc, 0.0);
            let wt = sp * pl[s.rel + k] * t * t;
            let wd = wt * d;
            sw += wt;
            sd += wd;
            sdd += wd * d;
            sr += wt * crs;
            sb += wt * cbs;
            sdr += wd * crs;
            sdb += wd * cbs;
        }
    }
    var fr = ref_r;
    var fb = ref_b;
    if (sw > 1e-6) {
        let inv = 1.0 / sw;
        let md = sd * inv;
        let mr = sr * inv;
        let mb = sb * inv;
        let var_d = max(sdd * inv - md * md, 0.0) + eps;
        let slope_r = (sdr * inv - mr * md) / var_d;
        let slope_b = (sdb * inv - mb * md) / var_d;
        fr = mr - slope_r * md;
        fb = mb - slope_b * md;
    }
    pl[s.out_r + o] = fr;
    pl[s.out_b + o] = fb;
}

fn taps(v: u32, n: u32) -> vec4<f32> {
    let i = min(v / 2u, n - 1u);
    if (v % 2u == 0u) {
        return vec4<f32>(f32(max(i32(i) - 1, 0)), 0.25, f32(i), 0.75);
    }
    return vec4<f32>(f32(i), 0.75, f32(min(i + 1u, n - 1u)), 0.25);
}

struct Upsampled {
    r: f32,
    b: f32,
    q_range: f32,
    r_min: f32,
    r_max: f32,
    b_min: f32,
    b_max: f32,
}

fn upsample(x: u32, y: u32, qc: f32, coarse: Scale, cr: u32, cb: u32, eps: f32) -> Upsampled {
    var u = Upsampled(0.0, 0.0, 0.0, 3.4e38, -3.4e38, 3.4e38, -3.4e38);
    var q_min = 3.4e38;
    var q_max = -3.4e38;
    var sd = 0.0;
    var sdd = 0.0;
    var sdr = 0.0;
    var sdb = 0.0;
    let ty = taps(y, coarse.h);
    let tx = taps(x, coarse.w);
    for (var row = 0u; row < 2u; row++) {
        let ly = u32(select(ty.z, ty.x, row == 0u));
        let wy = select(ty.w, ty.y, row == 0u);
        let qo = coarse.q + (ly + 2u) * coarse.pw + 2u;
        for (var side = 0u; side < 2u; side++) {
            let lx = u32(select(tx.z, tx.x, side == 0u));
            let wx = select(tx.w, tx.y, side == 0u);
            let gq = pl[qo + lx];
            let gr = pl[cr + ly * coarse.w + lx];
            let gb = pl[cb + ly * coarse.w + lx];
            let gw = wy * wx;
            let d = gq - qc;
            let wd = gw * d;
            u.r += gw * gr;
            u.b += gw * gb;
            sd += wd;
            sdd += wd * d;
            sdr += wd * gr;
            sdb += wd * gb;
            q_min = min(q_min, gq);
            q_max = max(q_max, gq);
            u.r_min = min(u.r_min, gr);
            u.r_max = max(u.r_max, gr);
            u.b_min = min(u.b_min, gb);
            u.b_max = max(u.b_max, gb);
        }
    }
    let var_d = max(sdd - sd * sd, 0.0) + eps;
    let slope_r = (sdr - u.r * sd) / var_d;
    let slope_b = (sdb - u.b * sd) / var_d;
    u.r -= slope_r * sd;
    u.b -= slope_b * sd;
    u.q_range = q_max - q_min;
    return u;
}

fn upsample_eps() -> f32 {
    let t = (1.5 + 2.0 * F.amounts.x) * noise(MED_HALF_Q);
    return 16.0 * t * t;
}

@compute @workgroup_size(8, 8)
fn nr_upsample(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= F.half.x || id.y >= F.half.y) {
        return;
    }
    let qc = pl[F.planes[0].x + half_at(i32(id.x), i32(id.y))];
    let quarter = scale_of(1u);
    let u = upsample(id.x, id.y, qc, quarter, quarter.out_r, quarter.out_b, upsample_eps());
    let o = id.y * F.half.x + id.x;
    pl[F.planes[1].y + o] = u.r;
    pl[F.planes[1].z + o] = u.b;
}

@compute @workgroup_size(8, 8)
fn nr_core(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= F.half.x || id.y >= F.half.y) {
        return;
    }
    let a = F.amounts.x;
    let core = max(median(MED_CORE) * (1.5 + a), 1e-6);
    let texture = 4.0 * (0.5 + a);
    var lo = 3.4e38;
    var hi = -3.4e38;
    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            let v = pl[F.planes[0].x + half_at(i32(id.x) + i, i32(id.y) + j)];
            lo = min(lo, v);
            hi = max(hi, v);
        }
    }
    let o = id.y * F.half.x + id.x;
    let rr = pl[F.planes[1].y + o];
    let rb = pl[F.planes[1].z + o];
    let er = pl[F.planes[1].w + o] - rr;
    let eb = pl[F.planes[2].w + o] - rb;
    let keep = clamp(sqrt(er * er + eb * eb) / (core + texture * (hi - lo)) - 1.0, 0.0, 1.0);
    pl[F.planes[1].w + o] = rr + er * keep;
    pl[F.planes[2].w + o] = rb + eb * keep;
}

fn luma_at(x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(F.dims.z) - 1);
    let cy = clamp(y, 0, i32(F.dims.w) - 1);
    return pl[F.planes[4].x + u32(cy * i32(F.dims.z) + cx)];
}

@compute @workgroup_size(8, 8)
fn sh_luma(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= F.dims.z || id.y >= F.dims.w) {
        return;
    }
    let p = developed(vec2<i32>(id.xy));
    pl[F.planes[4].x + id.y * F.dims.z + id.x] = sqrt(max(0.2126 * p.x + 0.7152 * p.y + 0.0722 * p.z, 0.0) + FLOOR);
}

fn blur(x: i32, y: i32) -> f32 {
    var v: array<f32, 5>;
    for (var k = 0; k < 5; k++) {
        let cx = x + k - 2;
        v[k] = (luma_at(cx, y - 2) + luma_at(cx, y + 2) + 4.0 * (luma_at(cx, y - 1) + luma_at(cx, y + 1))
            + 6.0 * luma_at(cx, y)) * (1.0 / 16.0);
    }
    return (v[0] + v[4] + 4.0 * (v[1] + v[3]) + 6.0 * v[2]) * (1.0 / 16.0);
}

@compute @workgroup_size(256)
fn md_sample(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
    let n = T.y;
    for (var s = gid.x; s < n; s += nw.x * 256u) {
        var v = 0.0;
        switch (T.x) {
            case 0u, 2u: {
                let sc = scale_of(T.x / 2u);
                let cols = (sc.pw - 4u + 6u) / 7u;
                let i = (s / cols) * 8u * sc.pw + (s % cols) * 7u;
                v = abs(pl[sc.q + i + 4u] - pl[sc.q + i]);
            }
            case 1u, 3u: {
                let sc = scale_of(T.x / 2u);
                let cols = (sc.pw - 4u + 6u) / 7u;
                let k = s / 2u;
                let i = (k / cols) * 8u * sc.pw + (k % cols) * 7u;
                let plane = select(sc.cb, sc.cr, s % 2u == 0u);
                v = abs(pl[plane + i + 4u] - pl[plane + i]);
            }
            case 4u: {
                let i = s * 7u;
                let er = pl[F.planes[1].w + i] - pl[F.planes[1].y + i];
                let eb = pl[F.planes[2].w + i] - pl[F.planes[1].z + i];
                v = sqrt(er * er + eb * eb);
            }
            case 5u: {
                let w = F.dims.z;
                let cols = (w - 4u + 6u) / 7u;
                let k = s / 2u;
                let y = (k / cols) * 8u;
                let x = (k % cols) * 7u;
                let a = stabilize(developed(vec2<i32>(i32(x), i32(y))));
                let b = stabilize(developed(vec2<i32>(i32(x) + 4, i32(y))));
                v = select(abs(b.z - a.z), abs(b.y - a.y), s % 2u == 0u);
            }
            default: {
                let cols = (F.dims.z + 4u) / 5u;
                let y = i32((s / cols) * 16u);
                let x = i32((s % cols) * 5u);
                v = abs(luma_at(x, y) - blur(x, y));
            }
        }
        pl[F.planes[4].y + s] = v;
    }
}

@compute @workgroup_size(256)
fn md_hist(@builtin(local_invocation_index) li: u32, @builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
    for (var b = li; b < 2048u; b += 256u) {
        atomicStore(&bins[b], 0u);
    }
    workgroupBarrier();
    let pass_index = T.x;
    let n = T.y;
    let prefix = atomicLoad(&stats[PREFIX]);
    for (var s = gid.x; s < n; s += nw.x * 256u) {
        let bits = bitcast<u32>(pl[F.planes[4].y + s]);
        if (pass_index == 0u) {
            atomicAdd(&bins[bits >> 21u], 1u);
        } else if (pass_index == 1u) {
            if ((bits >> 21u) == prefix) {
                atomicAdd(&bins[(bits >> 10u) & 2047u], 1u);
            }
        } else if ((bits >> 10u) == prefix) {
            atomicAdd(&bins[bits & 1023u], 1u);
        }
    }
    workgroupBarrier();
    for (var b = li; b < 2048u; b += 256u) {
        let v = atomicLoad(&bins[b]);
        if (v != 0u) {
            atomicAdd(&stats[RADIX + b], v);
        }
    }
}

var<workgroup> totals: array<u32, 256>;

@compute @workgroup_size(256)
fn md_pick(@builtin(local_invocation_index) li: u32) {
    let pass_index = T.x;
    let n = T.y;
    if (n == 0u) {
        if (li == 0u) {
            grid[G_MEDIANS + T.z] = 0.0;
        }
        return;
    }
    let rank = select(atomicLoad(&stats[RANK]), n / 2u, pass_index == 0u);
    let prefix = select(atomicLoad(&stats[PREFIX]), 0u, pass_index == 0u);
    let buckets = select(2048u, 1024u, pass_index == 2u);
    let per = buckets / 256u;
    let first = li * per;
    var counts: array<u32, 8>;
    var own = 0u;
    for (var k = 0u; k < per; k++) {
        counts[k] = atomicLoad(&stats[RADIX + first + k]);
        atomicStore(&stats[RADIX + first + k], 0u);
        own += counts[k];
    }
    totals[li] = own;
    workgroupBarrier();
    for (var step = 1u; step < 256u; step <<= 1u) {
        var add = 0u;
        if (li >= step) {
            add = totals[li - step];
        }
        workgroupBarrier();
        totals[li] += add;
        workgroupBarrier();
    }
    let before = totals[li] - own;
    if (rank < before || rank >= totals[li]) {
        return;
    }
    var left = rank - before;
    var bucket = first;
    for (var k = 0u; k < per; k++) {
        if (left < counts[k]) {
            bucket = first + k;
            break;
        }
        left -= counts[k];
    }
    let shift = select(11u, 10u, pass_index == 2u);
    let next = select((prefix << shift) | bucket, bucket, pass_index == 0u);
    atomicStore(&stats[PREFIX], next);
    atomicStore(&stats[RANK], left);
    if (pass_index == 2u) {
        grid[G_MEDIANS + T.z] = bitcast<f32>(next);
    }
}

@compute @workgroup_size(8, 8)
fn out_band(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = i32(id.x);
    let y = i32(T.x + id.y);
    if (id.x >= F.dims.z || id.y >= T.y) {
        return;
    }
    var rgb = developed(vec2<i32>(x, y));
    let qc = sqrt(max(0.2126 * rgb.x + 0.7152 * rgb.y + 0.0722 * rgb.z, 0.0) + FLOOR);
    if (flag(DENOISE)) {
        let a = F.amounts.x;
        let lk = 0.2126 * rgb.x + 0.7152 * rgb.y + 0.0722 * rgb.z;
        let cr = sqrt(max(rgb.x, 0.0) + FLOOR) - qc;
        let cb = sqrt(max(rgb.z, 0.0) + FLOOR) - qc;
        let eps = upsample_eps();
        let half = scale_of(0u);
        let up = upsample(id.x, u32(y), qc, half, F.planes[1].w, F.planes[2].w, eps);
        let edge_scale = 0.5 / sqrt(eps);
        let core = (2.0 + 2.0 * a) * noise(MED_FULL_C);
        let texture = 4.0 * (0.5 + a);
        let er = cr - up.r;
        let eb = cb - up.b;
        let edge = up.q_range * edge_scale;
        let keep = clamp(sqrt(er * er + eb * eb) / (core + texture * up.q_range) - 1.0, 0.0, 1.0)
            / (1.0 + edge * edge);
        let nr = min(max(up.r + er * keep, up.r_min), up.r_max);
        let nb = min(max(up.b + eb * keep, up.b_min), up.b_max);
        let vr = max(qc + nr, 0.0);
        let vb = max(qc + nb, 0.0);
        let dr = vr * vr - FLOOR - lk;
        let db = vb * vb - FLOOR - lk;
        let dg = -(0.2126 * dr + 0.0722 * db) * (1.0 / 0.7152);
        let m = min(min(dr, dg), db);
        let s = select(1.0, -lk / m, lk + m < 0.0);
        if (lk > 0.0) {
            rgb = max(vec3<f32>(lk + dr * s, lk + dg * s, lk + db * s), vec3<f32>(0.0));
        }
    }
    if (flag(SHARPEN)) {
        let n = median(MED_SHARPEN) * 1.4826;
        let threshold = max((1.5 * n) * (1.5 * n), 1e-12);
        let strength = 4.5 * F.amounts.y;
        let taper = 0.3 / sqrt(threshold);
        var d = qc - blur(x, y);
        d = d * d * d / (d * d + threshold);
        d = d / (1.0 + abs(d) * taper);
        var lo = 3.4e38;
        var hi = -3.4e38;
        for (var i = -1; i <= 1; i++) {
            for (var j = -1; j <= 1; j++) {
                let v = luma_at(x + i, y + j);
                lo = min(lo, v);
                hi = max(hi, v);
            }
        }
        let delta = strength * d;
        let range = hi - lo;
        let up_room = hi - qc + range * 0.15 + 0.004;
        let down_room = qc - lo + range * 0.05 + 0.002;
        let up = max(delta, 0.0);
        let down = max(-delta, 0.0) * 0.7;
        let qn = qc + up * up_room / (up_room + up) - down * down_room / (down_room + down);
        let l = qc * qc - FLOOR;
        let ln = max(qn * qn - FLOOR, 0.0);
        if (l > 1e-6) {
            let peak = max(max(rgb.x, rgb.y), rgb.z);
            var ratio = ln / l;
            if (ratio > 1.0 && peak * ratio > 1.0) {
                ratio = max(1.0 / peak, 1.0);
            }
            rgb *= ratio;
        } else {
            rgb = max(rgb + vec3<f32>(ln - l), vec3<f32>(0.0));
        }
    }
    let o = (id.y * F.dims.z + id.x) * 3u;
    dst[o] = rgb.x;
    dst[o + 1u] = rgb.y;
    dst[o + 2u] = rgb.z;
}
