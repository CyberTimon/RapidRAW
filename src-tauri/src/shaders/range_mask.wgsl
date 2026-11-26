struct Params {
    grid: Grid,
    color: vec4<f32>,
    pick: vec4<f32>,
    blend: vec4<f32>,
    finish: vec4<f32>,
}

@group(0) @binding(7) var<uniform> params: Params;

const LUMINANCE: u32 = 1u;
const SAMPLE_REFERENCE: u32 = 2u;
const ERODE: u32 = 1u;
const FIRST: u32 = 4u;
const STATIC: u32 = 8u;

fn srgb8(working: vec3<f32>) -> vec3<f32> {
    let linear = srgb_to_linear(max(working, vec3<f32>(0.0)));
    let srgb = linear_to_srgb(fit_gamut(WORKING_TO_SRGB * linear, 0.0, vec3<f32>(0.0)));
    return floor(clamp(srgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0 + 0.5);
}

fn luma8(c: vec3<f32>) -> f32 {
    return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

fn reference_color() -> vec3<f32> {
    if ((params.grid.flags & SAMPLE_REFERENCE) != 0u) {
        return srgb8(textureLoad(t0, vec2<u32>(params.pick.xy), 0).rgb);
    }
    return params.color.rgb;
}

fn axis() -> vec2<i32> {
    return select(vec2<i32>(1, 0), vec2<i32>(0, 1), params.grid.channel == 1u);
}

fn kernel_weight(index: u32) -> f32 {
    let group = data[index / 4u];
    switch index % 4u {
        case 0u: { return group.x; }
        case 1u: { return group.y; }
        case 2u: { return group.z; }
        default: { return group.w; }
    }
}

fn step_value(p: vec2<u32>) -> f32 {
    if ((params.grid.flags & STATIC) != 0u) {
        return floor(textureLoad(layers, p, i32(params.blend.w), 0).r * 255.0 + 0.5);
    }
    return textureLoad(t1, p, 0).r;
}

fn combined(p: vec2<u32>) -> f32 {
    var value = step_value(p);
    if (params.blend.x > 0.5) {
        value = 255.0 - value;
    }
    value = floor(value * params.blend.y);
    var previous = 0.0;
    if ((params.grid.flags & FIRST) == 0u) {
        previous = textureLoad(t0, p, 0).r;
    }
    switch u32(params.blend.z) {
        case 1u: { return max(previous - value, 0.0); }
        case 2u: { return min(previous, value); }
        default: { return max(previous, value); }
    }
}

@compute @workgroup_size(8, 8, 1)
fn rm_eval(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let pixel = srgb8(textureLoad(t0, id.xy, 0).rgb);
    let reference = reference_color();
    let tolerance = params.color.w;
    var value = 0.0;
    if ((params.grid.flags & LUMINANCE) != 0u) {
        let distance = abs(luma8(pixel) - luma8(reference));
        if (distance <= tolerance) {
            value = floor((1.0 - distance / tolerance) * 255.0);
        }
    } else {
        let d = pixel - reference;
        let distance_sq = d.r * d.r + d.g * d.g + d.b * d.b;
        if (distance_sq <= tolerance) {
            value = floor((1.0 - sqrt(distance_sq) / sqrt(tolerance)) * 255.0);
        }
    }
    textureStore(out_r32, id.xy, vec4<f32>(value, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn rm_grow(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let dir = axis();
    let p = vec2<i32>(id.xy);
    let along = dot(p, dir);
    let last = dot(vec2<i32>(params.grid.dst), dir) - 1;
    let radius = i32(params.grid.radius);
    let erode = (params.grid.flags & ERODE) != 0u;
    var value = select(0.0, 255.0, erode);
    for (var i = max(along - radius, 0); i <= min(along + radius, last); i++) {
        let tap = textureLoad(t0, p + dir * (i - along), 0).r;
        value = select(max(value, tap), min(value, tap), erode);
    }
    textureStore(out_r32, id.xy, vec4<f32>(value, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn rm_blur(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let dir = axis();
    let p = vec2<i32>(id.xy);
    let last = vec2<i32>(params.grid.dst) - 1;
    let radius = i32(params.grid.radius);
    var sum = 0.0;
    for (var i = 0; i <= 2 * radius; i++) {
        let q = clamp(p + dir * (i - radius), vec2<i32>(0), last);
        sum = sum + textureLoad(t0, q, 0).r * kernel_weight(u32(i));
    }
    textureStore(out_r32, id.xy, vec4<f32>(clamp(floor(sum), 0.0, 255.0), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn rm_combine(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    textureStore(out_r32, id.xy, vec4<f32>(combined(id.xy), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn rm_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    let width = params.grid.dst.x;
    if (id.x * 4u >= width || id.y >= params.grid.dst.y) { return; }
    var word = 0u;
    for (var k = 0u; k < 4u; k++) {
        let x = id.x * 4u + k;
        if (x < width) {
            var value = combined(vec2<u32>(x, id.y));
            if (params.finish.x > 0.5) {
                value = 255.0 - value;
            }
            value = floor(value * params.finish.y);
            word = word | (u32(value) << (8u * k));
        }
    }
    atomicStore(&scratch[id.y * params.grid.src.x + id.x], word);
}

@compute @workgroup_size(8, 8, 1)
fn rm_cutout(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    var cut = textureLoad(t0, id.xy, 0).rg;
    let plain = params.grid.radius;
    let keyed = params.grid.channel;
    for (var layer = 0u; layer < min(textureNumLayers(layers), 32u); layer++) {
        let bit = 1u << layer;
        if (((plain | keyed) & bit) != 0u) {
            let value = textureLoad(layers, id.xy, i32(layer), 0).r;
            cut = max(cut, vec2<f32>(select(0.0, value, (plain & bit) != 0u), select(0.0, value, (keyed & bit) != 0u)));
        }
    }
    textureStore(out_f16, id.xy, vec4<f32>(cut, 0.0, 1.0));
}
