struct Params {
    grid: Grid,
    gain: f32,
    is_raw: u32,
    brightness_k: f32,
    whites: f32,
    glow_cutoff: f32,
    halation_cutoff: f32,
    fine_weight: vec2<f32>,
    coarse_weight: vec2<f32>,
    aspect: f32,
    flare_cutoff: f32,
}

@group(0) @binding(7) var<uniform> params: Params;

const OUT_F16: u32 = 4u;

const GLOW_KNEE: f32 = 0.3;
const FLARE_KNEE: f32 = 0.1;
const COMPACT_LO: f32 = 1.2;
const COMPACT_HI: f32 = 4.0;
const FLARE_COMPRESS: f32 = 0.05;
const CLIP_BOOST: f32 = 4.0;
const GLARE_GAIN: f32 = 0.4;
const GHOST_GAIN: f32 = 0.35;
const HALO_RADIUS: f32 = 0.4;
const HALO_REACH: f32 = 0.6;
const HALO_GAIN: f32 = 0.22;
const GHOST_DISPERSION: f32 = 0.03;
const APERTURE_RADIUS: i32 = 5;
const APERTURE_BLADES: f32 = 7.0;
const APERTURE_ROTATION: f32 = 0.2;

fn lt_srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let higher = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(higher, c / 12.92, c <= vec3<f32>(0.04045));
}

fn perceptual(l: f32) -> f32 {
    if (l <= 1.0) {
        return pow(max(l, 0.0), 1.0 / 2.2);
    }
    return 1.0 + pow(l - 1.0, 1.0 / 2.2);
}

fn graded_luma(l: f32) -> f32 {
    var y = max(l, 0.0);
    let k = params.brightness_k;
    if (k != 1.0) {
        if (y <= 1.0) {
            y = y / (y + (1.0 - y) * k);
        } else {
            y = 1.0 + (y - 1.0) * k;
        }
    }
    let wh = params.whites;
    if (wh != 0.0) {
        let t_w = pow(max(y, 1.0e-4), 0.4545);
        let u = max(t_w - 0.4, 0.0);
        var t_new = t_w;
        if (wh > 0.0) {
            t_new = t_w + wh * 0.35 * (u * u) / (1.0 + u * u);
        } else if (u > 0.0) {
            t_new = 0.4 + u / (1.0 + (-wh) * 0.3 * u);
        }
        t_new = mix(t_w, t_new, smooth_step(0.1, 0.9, t_w));
        y = pow(t_new, 2.2);
    }
    return y;
}

fn bilinear(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
    return tap_sample(t, tap_uv(uv, textureDimensions(t)));
}

fn dst_uv(id: vec3<u32>) -> vec2<f32> {
    return (vec2<f32>(id.xy) + 0.5) / vec2<f32>(params.grid.dst);
}

@compute @workgroup_size(8, 8, 1)
fn lt_prefilter(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let dst = params.grid.dst;
    let src = params.grid.src;
    let sy0 = id.y * src.y / dst.y;
    let sy1 = clamp((id.y + 1u) * src.y / dst.y, sy0 + 1u, src.y);
    let sx0 = id.x * src.x / dst.x;
    let sx1 = clamp((id.x + 1u) * src.x / dst.x, sx0 + 1u, src.x);
    let halation_range = max(1.5 - params.halation_cutoff, 0.1) * 0.6;

    var glow = vec4<f32>(0.0);
    var flare = vec3<f32>(0.0);
    for (var sy = sy0; sy < sy1; sy++) {
        for (var sx = sx0; sx < sx1; sx++) {
            var c = max(textureLoad(t0, vec2<u32>(sx, sy), 0).rgb, vec3<f32>(0.0));
            let clipped = smooth_step(0.92, 1.0, max(c.r, max(c.g, c.b)));
            if (params.is_raw == 0u) {
                c = lt_srgb_to_linear(c);
            }
            c *= params.gain;
            let l = plain_luma(c);
            let p = perceptual(graded_luma(l));
            let wg = smooth_step(params.glow_cutoff, params.glow_cutoff + GLOW_KNEE, p);
            let wh = smooth_step(params.halation_cutoff, params.halation_cutoff + halation_range, p);
            let wf = smooth_step(params.flare_cutoff, params.flare_cutoff + FLARE_KNEE, p);
            glow += vec4<f32>(c * wg, l * wh);
            flare += c * wf * (1.0 + CLIP_BOOST * clipped);
        }
    }
    let inv = 1.0 / f32((sy1 - sy0) * (sx1 - sx0));
    textureStore(out_f32, id.xy, glow * inv);
    textureStore(out_f16, id.xy, vec4<f32>(flare * inv, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn lt_down(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let uv = dst_uv(id);
    let ts = 1.0 / vec2<f32>(textureDimensions(t0));
    let a = bilinear(t0, uv + ts * vec2<f32>(-2.0, -2.0));
    let b = bilinear(t0, uv + ts * vec2<f32>(0.0, -2.0));
    let c = bilinear(t0, uv + ts * vec2<f32>(2.0, -2.0));
    let d = bilinear(t0, uv + ts * vec2<f32>(-1.0, -1.0));
    let e = bilinear(t0, uv + ts * vec2<f32>(1.0, -1.0));
    let f = bilinear(t0, uv + ts * vec2<f32>(-2.0, 0.0));
    let g = bilinear(t0, uv);
    let h = bilinear(t0, uv + ts * vec2<f32>(2.0, 0.0));
    let i = bilinear(t0, uv + ts * vec2<f32>(-1.0, 1.0));
    let j = bilinear(t0, uv + ts * vec2<f32>(1.0, 1.0));
    let k = bilinear(t0, uv + ts * vec2<f32>(-2.0, 2.0));
    let l = bilinear(t0, uv + ts * vec2<f32>(0.0, 2.0));
    let m = bilinear(t0, uv + ts * vec2<f32>(2.0, 2.0));
    let v = (d + e + i + j) * 0.125
        + (a + c + k + m) * 0.03125
        + (b + f + h + l) * 0.0625
        + g * 0.125;
    textureStore(out_f32, id.xy, v);
}

@compute @workgroup_size(8, 8, 1)
fn lt_up(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let uv = dst_uv(id);
    let tc = 1.0 / vec2<f32>(textureDimensions(t0));
    let tent = (bilinear(t0, uv) * 4.0
        + (bilinear(t0, uv + vec2<f32>(tc.x, 0.0)) + bilinear(t0, uv - vec2<f32>(tc.x, 0.0))
            + bilinear(t0, uv + vec2<f32>(0.0, tc.y)) + bilinear(t0, uv - vec2<f32>(0.0, tc.y))) * 2.0
        + bilinear(t0, uv + tc) + bilinear(t0, uv - tc)
        + bilinear(t0, uv + vec2<f32>(tc.x, -tc.y)) + bilinear(t0, uv + vec2<f32>(-tc.x, tc.y)))
        * (1.0 / 16.0);
    let fine = textureLoad(t1, id.xy, 0);
    let fw = params.fine_weight;
    let cw = params.coarse_weight;
    let v = fine * vec4<f32>(fw.x, fw.x, fw.x, fw.y) + tent * vec4<f32>(cw.x, cw.x, cw.x, cw.y);
    if ((params.grid.flags & OUT_F16) != 0u) {
        textureStore(out_f16, id.xy, v);
    } else {
        textureStore(out_f32, id.xy, v);
    }
}

@compute @workgroup_size(8, 8, 1)
fn lt_source(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let f = textureLoad(t0, id.xy, 0).rgb;
    let l = plain_luma(f);
    let surround = plain_luma(bilinear(t1, dst_uv(id)).rgb);
    let compact = smooth_step(COMPACT_LO, COMPACT_HI, l / max(surround, 1.0e-6));
    let compressed = f / (1.0 + l * FLARE_COMPRESS);
    let weight = 0.05 + 0.95 * compact * compact;
    textureStore(out_f32, id.xy, vec4<f32>(compressed * weight, 1.0));
}

fn aperture_weight(p: vec2<f32>) -> f32 {
    let radius = f32(APERTURE_RADIUS);
    let sector = 6.2831853 / APERTURE_BLADES;
    let angle = atan2(p.y, p.x) + APERTURE_ROTATION;
    let local = angle - sector * floor(angle / sector) - sector * 0.5;
    let d = length(p) / radius * cos(local) / cos(sector * 0.5);
    let coverage = clamp((1.0 - d) * radius + 0.5, 0.0, 1.0);
    return coverage * (0.65 + 0.35 * pow(min(d, 1.0), 4.0));
}

@compute @workgroup_size(8, 8, 1)
fn lt_aperture(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
    let p = vec2<i32>(id.xy);
    var acc = vec3<f32>(0.0);
    var total = 0.0;
    for (var y = -APERTURE_RADIUS; y <= APERTURE_RADIUS; y++) {
        for (var x = -APERTURE_RADIUS; x <= APERTURE_RADIUS; x++) {
            let w = aperture_weight(vec2<f32>(f32(x), f32(y)));
            if (w > 0.0) {
                let q = p + vec2<i32>(x, y);
                if (all(q >= vec2<i32>(0)) && all(q <= last)) {
                    acc += textureLoad(t0, q, 0).rgb * w;
                }
                total += w;
            }
        }
    }
    textureStore(out_f32, id.xy, vec4<f32>(acc / total, 1.0));
}

fn aperture_level(level: i32, uv: vec2<f32>) -> vec3<f32> {
    switch level {
        case 1: { return bilinear(t1, uv).rgb; }
        case 2: { return bilinear(t2, uv).rgb; }
        case 3: { return bilinear(t3, uv).rgb; }
        default: { return bilinear(t4, uv).rgb; }
    }
}

fn aperture(lod: f32, uv: vec2<f32>) -> vec3<f32> {
    let l = clamp(lod, 1.0, 4.0);
    let i = i32(floor(l));
    let lo = aperture_level(i, uv);
    let hi = aperture_level(min(i + 1, 4), uv);
    return mix(lo, hi, l - f32(i));
}

fn frame_fade(uv: vec2<f32>) -> f32 {
    let edge = min(uv, vec2<f32>(1.0) - uv);
    let fade = smoothstep(vec2<f32>(-0.02), vec2<f32>(0.04), edge);
    return fade.x * fade.y;
}

fn ghost(r: vec2<f32>, m: f32, size: f32, tint: vec3<f32>) -> vec3<f32> {
    let lod = log2(max(size / (abs(m) * f32(APERTURE_RADIUS)), 1.0));
    var c = vec3<f32>(0.0);
    for (var ch = 0; ch < 3; ch++) {
        let scale = m * (1.0 + GHOST_DISPERSION * f32(ch - 1));
        let uv = vec2<f32>(0.5) + r / scale;
        let off_axis = length((uv - 0.5) * vec2<f32>(params.aspect, 1.0));
        let weight = frame_fade(uv) * (1.0 - smoothstep(0.2, 0.75, off_axis));
        c[ch] = aperture(lod, uv)[ch] * weight;
    }
    return c * tint;
}

@compute @workgroup_size(8, 8, 1)
fn lt_flare(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let uv = dst_uv(id);
    let r = uv - 0.5;
    let glare = textureLoad(t0, id.xy, 0).rgb;

    var ghosts = ghost(r, -0.16, 9.0, vec3<f32>(0.85, 1.0, 0.88)) * 0.9;
    ghosts += ghost(r, -0.34, 15.0, vec3<f32>(1.0, 0.86, 0.7)) * 0.55;
    ghosts += ghost(r, -0.58, 24.0, vec3<f32>(0.78, 0.86, 1.0)) * 0.35;
    ghosts += ghost(r, -0.9, 36.0, vec3<f32>(0.88, 1.0, 0.8)) * 0.22;
    ghosts += ghost(r, -1.3, 52.0, vec3<f32>(1.0, 0.82, 0.95)) * 0.15;
    ghosts += ghost(r, -2.0, 72.0, vec3<f32>(0.82, 0.9, 1.0)) * 0.08;
    ghosts += ghost(r, 0.24, 7.0, vec3<f32>(1.0, 0.95, 0.85)) * 0.6;
    ghosts += ghost(r, 0.5, 18.0, vec3<f32>(0.86, 0.95, 1.0)) * 0.2;

    let aspect = vec2<f32>(params.aspect, 1.0);
    let ra = r * aspect;
    let d = length(ra);
    let toward = ra / max(d, 1.0e-5);
    var halo = vec3<f32>(0.0);
    for (var ch = 0; ch < 3; ch++) {
        let radius = HALO_RADIUS * (1.0 + 0.025 * f32(ch - 1));
        let s = -toward * (d - radius);
        let suv = vec2<f32>(0.5) + s / aspect;
        let weight = pow(max(1.0 - length(s) / HALO_REACH, 0.0), 4.0) * frame_fade(suv);
        halo[ch] = aperture(3.2, suv)[ch] * weight;
    }

    let flare = glare * GLARE_GAIN + ghosts * GHOST_GAIN + halo * vec3<f32>(0.85, 0.92, 1.0) * HALO_GAIN;
    textureStore(out_f16, id.xy, vec4<f32>(flare, 1.0));
}
