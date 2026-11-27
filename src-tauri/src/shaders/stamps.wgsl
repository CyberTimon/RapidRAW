struct Params {
    grid: Grid,
    origin: vec2<i32>,
    offset: vec2<f32>,
    frame: vec2<u32>,
    coarsest: u32,
    pad: u32,
    to_mask: array<vec4<f32>, 2>,
}

@group(0) @binding(7) var<uniform> params: Params;

const TOE: f32 = 0.0078125;

fn spot(id: vec3<u32>) -> vec2<i32> {
    return vec2<i32>(id.xy) + params.origin;
}

fn frame_at(p: vec2<i32>) -> vec4<f32> {
    return textureLoad(t0, clamp(p, vec2<i32>(0), vec2<i32>(params.frame) - 1), 0);
}

fn source_at(p: vec2<i32>) -> vec4<f32> {
    return tap_sample(t0, tap_from(vec2<f32>(p) + params.offset, params.frame));
}

fn mask_texel(p: vec2<i32>) -> f32 {
    let size = vec2<i32>(textureDimensions(t1));
    if (any(p < vec2<i32>(0)) || any(p >= size)) { return 0.0; }
    return textureLoad(t1, p, 0).r;
}

fn alpha_at(p: vec2<i32>) -> f32 {
    let w = vec2<f32>(p);
    let row0 = params.to_mask[0];
    let row1 = params.to_mask[1];
    let c = vec2<f32>(dot(row0.xy, w) + row0.z, dot(row1.xy, w) + row1.z);
    let base = floor(c);
    let t = c - base;
    let q = vec2<i32>(base);
    let top = mix(mask_texel(q), mask_texel(q + vec2<i32>(1, 0)), t.x);
    let bottom = mix(mask_texel(q + vec2<i32>(0, 1)), mask_texel(q + vec2<i32>(1, 1)), t.x);
    return mix(top, bottom, t.y);
}

fn toe_log(c: vec3<f32>) -> vec3<f32> {
    return log2(max(c, vec3<f32>(0.0)) + TOE);
}

@compute @workgroup_size(8, 8, 1)
fn st_copy(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    textureStore(out_f16, id.xy, textureLoad(t0, id.xy, 0));
}

@compute @workgroup_size(8, 8, 1)
fn st_clone(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = spot(id);
    let dest = frame_at(p);
    let source = source_at(p);
    textureStore(out_f16, id.xy, vec4<f32>(mix(dest.rgb, source.rgb, alpha_at(p)), dest.a));
}

@compute @workgroup_size(8, 8, 1)
fn st_seed(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = spot(id);
    let known = select(0.0, 1.0, alpha_at(p) <= 0.0);
    let ratio = toe_log(frame_at(p).rgb) - toe_log(source_at(p).rgb);
    textureStore(out_f32, id.xy, vec4<f32>(ratio * known, known));
}

@compute @workgroup_size(8, 8, 1)
fn st_push(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let base = vec2<i32>(id.xy) * 2;
    let fine = vec2<i32>(params.grid.src);
    var sum = vec4<f32>(0.0);
    for (var j = 0; j < 2; j = j + 1) {
        for (var i = 0; i < 2; i = i + 1) {
            let q = base + vec2<i32>(i, j);
            if (q.x < fine.x && q.y < fine.y) {
                sum = sum + textureLoad(t0, q, 0);
            }
        }
    }
    textureStore(out_f32, id.xy, sum);
}

@compute @workgroup_size(8, 8, 1)
fn st_pull(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let pushed = textureLoad(t0, id.xy, 0);
    if (pushed.a > 0.0) {
        textureStore(out_f32, id.xy, vec4<f32>(pushed.rgb / pushed.a, 1.0));
        return;
    }
    var coarse = vec3<f32>(0.0);
    if (params.coarsest == 0u) {
        let at = (vec2<f32>(id.xy) + 0.5) * 0.5 - 0.5;
        coarse = tap_sample(t1, tap_from(at, params.grid.src)).rgb;
    }
    textureStore(out_f32, id.xy, vec4<f32>(coarse, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn st_relax(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let center = textureLoad(t0, id.xy, 0);
    if (center.a > 0.0) {
        textureStore(out_f32, id.xy, center);
        return;
    }
    let p = vec2<i32>(id.xy);
    let size = vec2<i32>(params.grid.dst);
    var sum = vec3<f32>(0.0);
    var count = 0.0;
    for (var n = 0; n < 4; n = n + 1) {
        let step = select(vec2<i32>(0, 1 - 2 * (n & 1)), vec2<i32>(1 - 2 * (n & 1), 0), n < 2);
        let q = p + step;
        if (all(q >= vec2<i32>(0)) && all(q < size)) {
            sum = sum + textureLoad(t0, q, 0).rgb;
            count = count + 1.0;
        }
    }
    textureStore(out_f32, id.xy, vec4<f32>(sum / max(count, 1.0), 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn st_heal(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = spot(id);
    let dest = frame_at(p);
    let ratio = textureLoad(t2, id.xy, 0).rgb;
    let healed = exp2(toe_log(source_at(p).rgb) + ratio) - TOE;
    textureStore(out_f16, id.xy, vec4<f32>(mix(dest.rgb, healed, alpha_at(p)), dest.a));
}
