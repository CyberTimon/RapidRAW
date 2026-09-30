struct BlurParams {
    radius: u32,
    tile_offset_x: u32,
    tile_offset_y: u32,
    input_width: u32,
    input_height: u32,
    _pad1: u32,
    _pad2: u32,
    _pad3: u32,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var output_texture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: BlurParams;

const F16_MAX = 65504.0;

fn load_clamped(coord: vec2<i32>) -> vec3<f32> {
    return clamp(textureLoad(input_texture, vec2<u32>(coord), 0).rgb, vec3(0.0), vec3(F16_MAX));
}

// Gaussian weights are generated incrementally: w(k) = q^(k*k) with
// q = exp(-1 / (2 sigma^2)), so w(k + 1) = w(k) * q^(2k + 1). Taps at +k and
// -k share a weight. This replaces an exp() per tap with two multiplies.
struct GaussianStep {
    q: f32,
    q2: f32,
}

fn gaussian_step(radius: i32) -> GaussianStep {
    let sigma = f32(radius) / 2.0;
    let q = exp(-1.0 / (2.0 * sigma * sigma));
    return GaussianStep(q, q * q);
}

@compute @workgroup_size(256, 1, 1)
fn horizontal_blur(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(output_texture));
    if (id.x >= u32(dims.x)) {
        return;
    }

    let radius = i32(params.radius);

    let absolute_coord = vec2<u32>(id.x + params.tile_offset_x, id.y + params.tile_offset_y);
    let full_dims = vec2<i32>(textureDimensions(input_texture));

    let row = i32(absolute_coord.y);
    let x = i32(absolute_coord.x);
    let max_x = full_dims.x - 1;

    let step = gaussian_step(radius);
    var total_color = load_clamped(vec2<i32>(x, row));
    var total_weight = 1.0;
    var weight = 1.0;
    var ratio = step.q;
    for (var offset = 1; offset <= radius; offset = offset + 1) {
        weight *= ratio;
        ratio *= step.q2;
        let left = load_clamped(vec2<i32>(clamp(x - offset, 0, max_x), row));
        let right = load_clamped(vec2<i32>(clamp(x + offset, 0, max_x), row));
        total_color += (left + right) * weight;
        total_weight += 2.0 * weight;
    }

    let final_color = total_color / total_weight;
    textureStore(output_texture, id.xy, vec4<f32>(final_color, 1.0));
}

@compute @workgroup_size(1, 256, 1)
fn vertical_blur(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.y >= params.input_height) {
        return;
    }

    let radius = i32(params.radius);

    let local_coord = vec2<i32>(id.xy);
    let max_y = i32(params.input_height) - 1;

    let step = gaussian_step(radius);
    var total_color = load_clamped(local_coord);
    var total_weight = 1.0;
    var weight = 1.0;
    var ratio = step.q;
    for (var offset = 1; offset <= radius; offset = offset + 1) {
        weight *= ratio;
        ratio *= step.q2;
        let above = load_clamped(vec2<i32>(local_coord.x, clamp(local_coord.y - offset, 0, max_y)));
        let below = load_clamped(vec2<i32>(local_coord.x, clamp(local_coord.y + offset, 0, max_y)));
        total_color += (above + below) * weight;
        total_weight += 2.0 * weight;
    }

    let final_color = total_color / total_weight;
    textureStore(output_texture, id.xy, vec4<f32>(final_color, 1.0));
}
