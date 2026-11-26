struct Params {
    grid: Grid,
    tint: vec4<f32>,
    amount: f32,
    start: f32,
    density: f32,
    height: f32,
    variation: f32,
    glow: f32,
    display_aspect: f32,
    norm: f32,
    near: f32,
    z_near: f32,
    z_range: f32,
    _pad0: f32,
    orientation: u32,
    flip_h: u32,
    flip_v: u32,
    _pad1: u32,
    depth_size: vec2<u32>,
    low_size: vec2<u32>,
}

@group(0) @binding(7) var<uniform> params: Params;

const STATS_THREADS: u32 = 256u;

var<workgroup> far_sums: array<vec4<f32>, 256>;
var<workgroup> mean_sums: array<vec3<f32>, 256>;

fn to_display(uv: vec2<f32>) -> vec2<f32> {
    var p = uv;
    switch params.orientation {
        case 1u: { p = vec2<f32>(1.0 - uv.y, uv.x); }
        case 2u: { p = vec2<f32>(1.0 - uv.x, 1.0 - uv.y); }
        case 3u: { p = vec2<f32>(uv.y, 1.0 - uv.x); }
        default: {}
    }
    if (params.flip_h != 0u) { p.x = 1.0 - p.x; }
    if (params.flip_v != 0u) { p.y = 1.0 - p.y; }
    return p;
}

fn fog_hash(x: i32, y: i32) -> f32 {
    var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u);
    h = (h ^ (h >> 13u)) * 0x85ebca6bu;
    h = h ^ (h >> 16u);
    return f32(h) / 4294967296.0;
}

fn fog_noise(x: f32, y: f32) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    for (var octave = 0; octave < 4; octave++) {
        let px = x * frequency + f32(octave) * 17.3;
        let py = y * frequency;
        let ix = i32(floor(px));
        let iy = i32(floor(py));
        let fx = px - f32(ix);
        let fy = py - f32(iy);
        let sx = fx * fx * (3.0 - 2.0 * fx);
        let sy = fy * fy * (3.0 - 2.0 * fy);
        let top = fog_hash(ix, iy) + (fog_hash(ix + 1, iy) - fog_hash(ix, iy)) * sx;
        let bot = fog_hash(ix, iy + 1) + (fog_hash(ix + 1, iy + 1) - fog_hash(ix, iy + 1)) * sx;
        value += (top + (bot - top) * sy) * amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    return value / 0.9375;
}

@compute @workgroup_size(8, 8, 1)
fn fog_noise_map(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(params.grid.dst);
    let p = to_display(uv);
    let n = fog_noise(p.x * 3.0 * params.display_aspect, p.y * 8.0);
    textureStore(out_f32, id.xy, vec4<f32>(n, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(256, 1, 1)
fn fog_stats(@builtin(local_invocation_index) li: u32) {
    let size = params.low_size;
    let count = size.x * size.y;
    var far = vec4<f32>(0.0);
    var mean = vec3<f32>(0.0);
    for (var i = li; i < count; i += STATS_THREADS) {
        let xy = vec2<u32>(i % size.x, i / size.x);
        let tap = tap_uv((vec2<f32>(xy) + 0.5) / vec2<f32>(size), params.depth_size);
        let weight = clamp((0.3 - tap_sample(t1, tap).x) / 0.3, 0.0, 1.0);
        let rgb = textureLoad(t0, xy, 0).rgb;
        far += vec4<f32>(rgb * weight, weight);
        mean += rgb;
    }
    far_sums[li] = far;
    mean_sums[li] = mean;
    workgroupBarrier();
    for (var stride = STATS_THREADS / 2u; stride > 0u; stride /= 2u) {
        if (li < stride) {
            far_sums[li] += far_sums[li + stride];
            mean_sums[li] += mean_sums[li + stride];
        }
        workgroupBarrier();
    }
    if (li != 0u) { return; }

    let mean_rgb = mean_sums[0] / f32(count);
    var far_rgb = mean_rgb;
    if (far_sums[0].w > 1.0) {
        far_rgb = far_sums[0].rgb / far_sums[0].w;
    }
    let far_luma = max(plain_luma(far_rgb), 1e-4);
    let atmosphere = max(far_luma, plain_luma(mean_rgb));
    let chroma = max(far_rgb, vec3<f32>(0.0)) / far_luma;
    let fog_rgb = (chroma + (1.0 - chroma) * 0.4) * atmosphere * params.tint.rgb / params.tint.w;
    atomicStore(&scratch[0], bitcast<u32>(atmosphere));
    atomicStore(&scratch[1], bitcast<u32>(fog_rgb.r));
    atomicStore(&scratch[2], bitcast<u32>(fog_rgb.g));
    atomicStore(&scratch[3], bitcast<u32>(fog_rgb.b));
}

@compute @workgroup_size(8, 8, 1)
fn fog_bloom(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let atmosphere = bitcast<f32>(atomicLoad(&scratch[0]));
    let rgb = textureLoad(t0, id.xy, 0).rgb;
    let t = clamp((plain_luma(rgb) - atmosphere * 0.8) / (atmosphere * 1.7), 0.0, 1.0);
    let k = t * t * (3.0 - 2.0 * t);
    textureStore(out_f32, id.xy, vec4<f32>(rgb * k, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn fog_apply(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let size = vec2<f32>(params.grid.dst);
    let pixel = textureLoad(t0, id.xy, 0);
    let uv = vec2<f32>((f32(id.x) + 0.5) / size.x, (f32(id.y) + 0.5) / size.y);
    let depth_tap = tap_uv(uv, params.depth_size);
    let d = clamp(guided(tap_sample(t1, depth_tap), relight_luma(pixel.rgb)), 0.0, 1.0);
    let distance = (1.0 / (d + params.near) - params.z_near) / params.z_range;
    let t = clamp((distance - params.start) / (1.0 - params.start), 0.0, 1.0);

    let up = 1.0 - to_display(uv).y;
    let patches = max(1.0 + 1.6 * params.variation * (tap_sample(t2, depth_tap).x * 2.0 - 1.0), 0.0);
    let optical = params.density * t * exp(-params.height * up) * patches;
    let fog = clamp(params.amount * (1.0 - exp(-optical)) / params.norm, 0.0, 1.0);
    if (fog <= 0.0) {
        textureStore(out_f16, id.xy, vec4<f32>(pixel.rgb, 1.0));
        return;
    }

    let fog_rgb = vec3<f32>(
        bitcast<f32>(atomicLoad(&scratch[1])),
        bitcast<f32>(atomicLoad(&scratch[2])),
        bitcast<f32>(atomicLoad(&scratch[3])),
    );
    let low_tap = tap_uv(uv, params.low_size);
    let scattered = fog_rgb + (tap_sample(t3, low_tap).rgb - fog_rgb) * 0.35;
    var halo = vec3<f32>(0.0);
    if (params.glow > 0.0) {
        halo = tap_sample(t4, low_tap).rgb * params.glow;
    }
    textureStore(out_f16, id.xy, vec4<f32>(pixel.rgb * (1.0 - fog) + (scattered + halo) * fog, 1.0));
}
