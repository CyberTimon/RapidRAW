struct Params {
    grid: Grid,
    aspect: vec2<f32>,
    ambient_gain: f32,
    softness: f32,
    shine: f32,
    lights: u32,
    shadows: u32,
    _pad: u32,
    map_size: vec2<u32>,
    shadow_size: vec2<u32>,
}

@group(0) @binding(7) var<uniform> params: Params;

const DIRECTIONAL: f32 = 2.0;
const SPOT: f32 = 1.0;

var<workgroup> wg_lo: atomic<u32>;
var<workgroup> wg_hi: atomic<u32>;

@compute @workgroup_size(8, 8, 1)
fn rl_merge(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let c = params.grid.channel;
    textureStore(out_f32, id.xy, vec4<f32>(
        textureLoad(t0, id.xy, 0)[c],
        textureLoad(t1, id.xy, 0)[c],
        textureLoad(t2, id.xy, 0)[c],
        textureLoad(t3, id.xy, 0)[c],
    ));
}

@compute @workgroup_size(8, 8, 1)
fn rl_depth(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_index) li: u32,
) {
    if (li == 0u) {
        atomicStore(&wg_lo, 0xffffffffu);
        atomicStore(&wg_hi, 0u);
    }
    workgroupBarrier();
    if (!outside(id)) {
        let size = vec2<f32>(params.grid.dst);
        let uv = (vec2<f32>(id.xy) + 0.5) / size;
        let tap = tap_uv(uv, params.map_size);
        let guide = textureLoad(t0, id.xy, 0).x;
        let d = clamp(tap_sample(t1, tap).w * guide + tap_sample(t2, tap).w, 0.0, 1.0);
        textureStore(out_f32, id.xy, vec4<f32>(d, 0.0, 0.0, 0.0));
        let bits = select(bitcast<u32>(d), 0u, d <= 0.0);
        atomicMin(&wg_lo, bits);
        atomicMax(&wg_hi, bits);
    }
    workgroupBarrier();
    if (li == 0u) {
        atomicMin(&scratch[0], atomicLoad(&wg_lo));
        atomicMax(&scratch[1], atomicLoad(&wg_hi));
    }
}

@compute @workgroup_size(8, 8, 1)
fn rl_shadow(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let size = params.grid.dst;
    let swf = f32(size.x);
    let shf = f32(size.y);
    let z_lo = bitcast<f32>(atomicLoad(&scratch[0])) + 0.01;
    let z_hi = bitcast<f32>(atomicLoad(&scratch[1])) + 0.3;
    let base = params.grid.channel * 4u;
    let d0 = data[base];
    let d2 = data[base + 2u];

    let u = (f32(id.x) + 0.5) / swf;
    let v = (f32(id.y) + 0.5) / shf;
    let p = vec3<f32>((u - 0.5) * params.aspect.x, (v - 0.5) * params.aspect.y, textureLoad(t0, id.xy, 0).x);
    var ray: vec3<f32>;
    if (d0.x == DIRECTIONAL) {
        let planar = sqrt(d2.x * d2.x + d2.y * d2.y);
        let len = min(0.5 / max(planar, 1e-3), 2.0);
        ray = d2.xyz * len;
    } else {
        ray = d0.yzw - p;
    }

    let f0 = vec2<f32>(u * swf, v * shf);
    let dxy = vec2<f32>(ray.x / params.aspect.x * swf, ray.y / params.aspect.y * shf);
    let rising = ray.z >= 0.0;
    let jitter = fract(52.982918 * fract(0.06711056 * f32(id.x) + 0.00583715 * f32(id.y)));
    var occlusion = 0.0;
    for (var k = 1; k <= 64; k++) {
        let t = (f32(k) - jitter) * (1.0 / 64.0);
        let f = f0 + dxy * t;
        if (f.x < 0.0 || f.x >= swf || f.y < 0.0 || f.y >= shf) { break; }
        let rz = p.z + ray.z * t;
        if ((rising && rz >= z_hi) || (!rising && rz <= z_lo)) { break; }
        let diff = rz - textureLoad(t0, vec2<u32>(f), 0).x;
        if (diff <= 0.01 || diff >= 0.3) { continue; }
        occlusion = max(occlusion, smooth_step(0.01, 0.04, diff) * (1.0 - smooth_step(0.15, 0.3, diff)));
        if (occlusion >= 1.0) { break; }
    }
    textureStore(out_f32, id.xy, vec4<f32>(1.0 - occlusion, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn rl_apply(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let size = vec2<f32>(params.grid.dst);
    let pixel = textureLoad(t0, id.xy, 0);
    let u = (f32(id.x) + 0.5) / size.x;
    let v = (f32(id.y) + 0.5) / size.y;
    let guide = relight_luma(pixel.rgb);
    let map_tap = tap_uv(vec2<f32>(u, v), params.map_size);
    let shadow_tap = tap_uv(vec2<f32>(u, v), params.shadow_size);

    let s = tap_sample(t1, map_tap) * guide + tap_sample(t2, map_tap);
    let len = max(sqrt(s.x * s.x + s.y * s.y + s.z * s.z), 1e-6);
    let n = s.xyz / len;
    let p = vec3<f32>((u - 0.5) * params.aspect.x, (v - 0.5) * params.aspect.y, clamp(s.w, 0.0, 1.0));
    let softness = params.softness;
    let shine = params.shine;

    var gain = vec3<f32>(params.ambient_gain);
    for (var i = 0u; i < params.lights; i++) {
        let d0 = data[i * 4u];
        let d1 = data[i * 4u + 1u];
        let d2 = data[i * 4u + 2u];
        let d3 = data[i * 4u + 3u];
        var l: vec3<f32>;
        var atten = 1.0;
        if (d0.x == DIRECTIONAL) {
            l = d2.xyz;
        } else {
            let d = d0.yzw - p;
            let dist2 = max(d.x * d.x + d.y * d.y + d.z * d.z, 1e-8);
            let inv = 1.0 / sqrt(dist2);
            l = d * inv;
            atten = d1.w / (d1.w + dist2);
            if (d0.x == SPOT) {
                let cos_beam = -(l.x * d2.x + l.y * d2.y + l.z * d2.z);
                atten *= smooth_step(d2.w, d3.x, cos_beam);
            }
        }

        if (params.shadows != 0u) {
            atten *= clamp(guided(tap_layer(shadow_tap, i32(i)), guide), 0.0, 1.0);
        }

        let ndl = n.x * l.x + n.y * l.y + n.z * l.z;
        let diffuse = max((ndl + softness) / (1.0 + softness), 0.0);
        var specular = 0.0;
        if (shine > 0.0 && ndl > 0.0) {
            let hz = l.z - 1.0;
            let hl = max(sqrt(l.x * l.x + l.y * l.y + hz * hz), 1e-6);
            let ndh = max((n.x * l.x + n.y * l.y + n.z * hz) / hl, 0.0);
            specular = pow(ndh, 8.0 + 56.0 * (1.0 - softness)) * shine * 2.0;
        }
        gain += d1.xyz * ((diffuse + specular) * atten);
    }

    textureStore(out_f16, id.xy, vec4<f32>(pixel.rgb * max(gain, vec3<f32>(0.0)), 1.0));
}
