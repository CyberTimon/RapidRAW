struct Params {
    grid: Grid,
    planes: vec4<u32>,
    chroma: vec4<u32>,
    mode: vec4<u32>,
    siting: vec4<f32>,
    levels: vec4<f32>,
    coeffs: vec4<f32>,
    to_working_r: vec4<f32>,
    to_working_g: vec4<f32>,
    to_working_b: vec4<f32>,
    hdr: vec4<f32>,
    log_curve: vec4<f32>,
    log_toe: vec4<f32>,
    log_code: vec4<f32>,
}

@group(0) @binding(7) var<uniform> params: Params;

const TRANSFER_SDR: u32 = 0u;
const TRANSFER_PQ: u32 = 1u;
const TRANSFER_HLG: u32 = 2u;

const PQ_M1: f32 = 2610.0 / 16384.0;
const PQ_M2: f32 = 2523.0 / 4096.0 * 128.0;
const PQ_C1: f32 = 3424.0 / 4096.0;
const PQ_C2: f32 = 2413.0 / 4096.0 * 32.0;
const PQ_C3: f32 = 2392.0 / 4096.0 * 32.0;
const HLG_A: f32 = 0.17883277;
const HLG_B: f32 = 0.28466892;
const HLG_C: f32 = 0.5599107;
const BT2020_LUMA: vec3<f32> = vec3<f32>(0.2627, 0.6780, 0.0593);

fn raw_sample(index: u32) -> f32 {
    let wide = params.planes.w == 2u;
    let byte = index * params.planes.w;
    let word = bitcast<vec4<u32>>(data[byte / 16u])[(byte / 4u) % 4u];
    let shift = (byte % 4u) * 8u;
    return f32(select((word >> shift) & 0xFFu, (word >> shift) & 0xFFFFu, wide) >> params.mode.z);
}

fn chroma_sample(plane: u32, position: vec2<f32>) -> f32 {
    let size = params.chroma.xy;
    let clamped = clamp(position, vec2<f32>(0.0), vec2<f32>(size - 1u));
    let p0 = vec2<u32>(floor(clamped));
    let p1 = min(p0 + 1u, size - 1u);
    let f = clamped - floor(clamped);
    let stride = params.mode.y;
    let top = mix(raw_sample(plane + (p0.y * size.x + p0.x) * stride), raw_sample(plane + (p0.y * size.x + p1.x) * stride), f.x);
    let bottom = mix(raw_sample(plane + (p1.y * size.x + p0.x) * stride), raw_sample(plane + (p1.y * size.x + p1.x) * stride), f.x);
    return mix(top, bottom, f.y);
}

fn pq_to_relative(encoded: vec3<f32>) -> vec3<f32> {
    let power = pow(clamp(encoded, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / PQ_M2));
    let linear = pow(max(power - PQ_C1, vec3<f32>(0.0)) / (PQ_C2 - PQ_C3 * power), vec3<f32>(1.0 / PQ_M1));
    return linear * params.hdr.w / params.hdr.x;
}

fn hlg_to_relative(encoded: vec3<f32>) -> vec3<f32> {
    let v = clamp(encoded, vec3<f32>(0.0), vec3<f32>(1.0));
    let scene = select((exp((v - HLG_C) / HLG_A) + HLG_B) / 12.0, v * v / 3.0, v <= vec3<f32>(0.5));
    let luminance = max(dot(scene, BT2020_LUMA), 1e-6);
    return scene * params.hdr.y * pow(luminance, params.hdr.z - 1.0) / params.hdr.x;
}

fn log_to_scene(code: f32) -> f32 {
    let curve = params.log_curve;
    let toe = params.log_toe;
    if (code >= toe.x) {
        return (exp2((code - curve.y) * curve.x) - curve.z) / curve.w;
    }
    if (toe.w < 0.5) {
        return (code - toe.z) / toe.y;
    }
    if (toe.w < 1.5) {
        let base = code / toe.y;
        return base * base * base - toe.z;
    }
    return sqrt(max(code, 0.0) / toe.y) + toe.z;
}

fn log_to_relative(rgb: vec3<f32>) -> vec3<f32> {
    let code = rgb * params.log_code.x + params.log_code.y;
    return vec3<f32>(log_to_scene(code.r), log_to_scene(code.g), log_to_scene(code.b));
}

@compute @workgroup_size(8, 8, 1)
fn vd_to_working(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let width = params.grid.dst.x;
    let subsampling = vec2<f32>(f32(1u << params.chroma.z), f32(1u << params.chroma.w));
    let chroma_position = (vec2<f32>(id.xy) + 0.5) / subsampling - 0.5 + params.siting.xy;

    let y = (raw_sample(params.planes.x + id.y * width + id.x) - params.levels.x) * params.levels.y;
    let cb = (chroma_sample(params.planes.y, chroma_position) - params.levels.z) * params.levels.w;
    let cr = (chroma_sample(params.planes.z, chroma_position) - params.levels.z) * params.levels.w;
    let rgb = vec3<f32>(y + params.coeffs.x * cr, y + params.coeffs.y * cb + params.coeffs.z * cr, y + params.coeffs.w * cb);
    let encoded = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));

    var linear: vec3<f32>;
    if (params.mode.x == TRANSFER_SDR) {
        linear = srgb_to_linear(encoded);
    } else if (params.mode.x == TRANSFER_PQ) {
        linear = pq_to_relative(encoded);
    } else if (params.mode.x == TRANSFER_HLG) {
        linear = hlg_to_relative(encoded);
    } else {
        linear = log_to_relative(rgb);
    }
    let working = vec3<f32>(
        dot(params.to_working_r.xyz, linear),
        dot(params.to_working_g.xyz, linear),
        dot(params.to_working_b.xyz, linear),
    );
    textureStore(out_f16, vec2<i32>(id.xy), vec4<f32>(linear_to_srgb_extended(working), 1.0));
}

fn frame_to_linear(encoded: vec3<f32>, curve: vec4<f32>) -> vec3<f32> {
    let value = max(encoded, vec3<f32>(0.0));
    let toe = value / max(curve.z, 0.000001);
    let power = pow((value + curve.y) / (1.0 + curve.y), vec3<f32>(1.0 / curve.x));
    return select(power, toe, value <= vec3<f32>(curve.w * curve.z));
}

fn linear_to_frame(linear: vec3<f32>, curve: vec4<f32>) -> vec3<f32> {
    let value = max(linear, vec3<f32>(0.0));
    let power = (1.0 + curve.y) * pow(value, vec3<f32>(curve.x)) - curve.y;
    return select(power, value * curve.z, value <= vec3<f32>(curve.w));
}

fn relative_to_pq(relative: vec3<f32>) -> vec3<f32> {
    let luminance = clamp(relative * params.hdr.x / params.hdr.w, vec3<f32>(0.0), vec3<f32>(1.0));
    let power = pow(luminance, vec3<f32>(PQ_M1));
    return pow((PQ_C1 + PQ_C2 * power) / (1.0 + PQ_C3 * power), vec3<f32>(PQ_M2));
}

fn relative_to_hlg(relative: vec3<f32>) -> vec3<f32> {
    let display = clamp(relative * params.hdr.x / params.hdr.y, vec3<f32>(0.0), vec3<f32>(1.0));
    let luminance = max(dot(display, BT2020_LUMA), 1e-6);
    let scene = clamp(display * pow(luminance, (1.0 - params.hdr.z) / params.hdr.z), vec3<f32>(0.0), vec3<f32>(1.0));
    let log_part = HLG_A * log(max(12.0 * scene - HLG_B, vec3<f32>(1e-6))) + HLG_C;
    return select(log_part, sqrt(3.0 * scene), scene <= vec3<f32>(1.0 / 12.0));
}

@compute @workgroup_size(8, 8, 1)
fn vd_encode_hdr(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let texel = textureLoad(t0, vec2<i32>(id.xy), 0);
    let linear = frame_to_linear(texel.rgb / max(texel.a, 1e-6), params.levels);
    let bt2020 = vec3<f32>(
        dot(params.to_working_r.xyz, linear),
        dot(params.to_working_g.xyz, linear),
        dot(params.to_working_b.xyz, linear),
    );
    var encoded: vec3<f32>;
    if (params.mode.x == TRANSFER_PQ) {
        encoded = relative_to_pq(bt2020);
    } else {
        encoded = relative_to_hlg(bt2020);
    }
    textureStore(out_f16, vec2<i32>(id.xy), vec4<f32>(encoded, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn vd_overlay_to_output(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let texel = textureLoad(t0, vec2<i32>(id.xy), 0);
    if (texel.a <= 0.0) {
        textureStore(out_f16, vec2<i32>(id.xy), vec4<f32>(0.0));
        return;
    }
    let linear = srgb_to_linear(texel.rgb / texel.a);
    let converted = vec3<f32>(
        dot(params.to_working_r.xyz, linear),
        dot(params.to_working_g.xyz, linear),
        dot(params.to_working_b.xyz, linear),
    );
    textureStore(out_f16, vec2<i32>(id.xy), vec4<f32>(linear_to_frame(converted, params.levels) * texel.a, texel.a));
}

@compute @workgroup_size(8, 8, 1)
fn vd_frame_to_working(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let texel = textureLoad(t0, vec2<i32>(id.xy), 0);
    let linear = frame_to_linear(texel.rgb / max(texel.a, 1e-6), params.levels);
    let working = vec3<f32>(
        dot(params.to_working_r.xyz, linear),
        dot(params.to_working_g.xyz, linear),
        dot(params.to_working_b.xyz, linear),
    );
    textureStore(out_f16, vec2<i32>(id.xy), vec4<f32>(linear_to_srgb_extended(working), 1.0));
}
