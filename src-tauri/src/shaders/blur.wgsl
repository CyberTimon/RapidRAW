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

const H_THREADS: i32 = 64;
const H_PER_THREAD: i32 = 4;
const H_OUTPUTS: i32 = 256;
const V_COLUMNS: i32 = 8;
const V_THREAD_ROWS: i32 = 8;
const V_PER_THREAD: i32 = 8;
const V_OUTPUTS: i32 = 64;
const MAX_TABLE_RADIUS: i32 = 512;

var<workgroup> weight_table: array<f32, 1068>;
var<workgroup> h_cache: array<vec3<f32>, H_OUTPUTS>;
var<workgroup> v_cache: array<vec3<f32>, 512>;

fn gaussian(x: f32, sigma: f32) -> f32 {
    return exp(-(x * x) / (2.0 * sigma * sigma));
}

fn weight_slot(i: i32) -> i32 {
    return i + (i >> 5u);
}

fn fill_weight_table(local_index: u32, thread_count: u32, radius: i32, sigma: f32) {
    let entries = u32(2 * radius + V_PER_THREAD);
    for (var i = local_index; i < entries; i = i + thread_count) {
        let w = gaussian(f32(i32(i) - radius), sigma);
        weight_table[weight_slot(i32(i))] = select(0.0, w, i32(i) <= 2 * radius);
    }
}

fn tap_weight(index: i32, radius: i32, sigma: f32, use_table: bool) -> f32 {
    if (use_table) {
        return weight_table[weight_slot(index)];
    }
    let w = gaussian(f32(index - radius), sigma);
    return select(0.0, w, index <= 2 * radius);
}

fn load_clamped(coord: vec2<i32>) -> vec3<f32> {
    return clamp(textureLoad(input_texture, coord, 0).rgb, vec3(0.0), vec3(F16_MAX));
}

fn h_cache_slot(e: i32) -> i32 {
    return (e & 3) * (H_OUTPUTS / H_PER_THREAD) + (e >> 2u);
}

@compute @workgroup_size(64, 1, 1)
fn horizontal_blur(
    @builtin(local_invocation_index) local_index: u32,
    @builtin(workgroup_id) group_id: vec3<u32>
) {
    let dims = vec2<i32>(textureDimensions(output_texture));
    let full_dims = vec2<i32>(textureDimensions(input_texture));

    let radius = i32(params.radius);
    let sigma = f32(radius) / 2.0;
    let use_table = radius <= MAX_TABLE_RADIUS;
    if (use_table) {
        fill_weight_table(local_index, u32(H_THREADS), radius, sigma);
    }

    let t = i32(local_index);
    let out_y = i32(group_id.y);
    let row = out_y + i32(params.tile_offset_y);
    let group_x = i32(group_id.x) * H_OUTPUTS;
    let window_start = group_x + i32(params.tile_offset_x) - radius;
    let window_len = H_OUTPUTS + 2 * radius;
    let first = t * H_PER_THREAD;
    let last = first + H_PER_THREAD - 1 + 2 * radius;

    var acc0 = vec3<f32>(0.0); var acc1 = vec3<f32>(0.0); var acc2 = vec3<f32>(0.0); var acc3 = vec3<f32>(0.0);
    var tw0 = 0.0; var tw1 = 0.0; var tw2 = 0.0; var tw3 = 0.0;
    var w0 = 0.0; var w1 = 0.0; var w2 = 0.0; var w3 = 0.0;

    for (var chunk = 0; chunk < window_len; chunk = chunk + H_OUTPUTS) {
        workgroupBarrier();
        let chunk_len = min(H_OUTPUTS, window_len - chunk);
        for (var m = 0; m < H_PER_THREAD; m = m + 1) {
            let e = t + m * H_THREADS;
            if (e < chunk_len) {
                let sample_x = clamp(window_start + chunk + e, 0, full_dims.x - 1);
                h_cache[h_cache_slot(e)] = load_clamped(vec2<i32>(sample_x, row));
            }
        }
        workgroupBarrier();

        let k_end = min(last, chunk + H_OUTPUTS - 1);
        for (var k = max(first, chunk); k <= k_end; k = k + 1) {
            w3 = w2; w2 = w1; w1 = w0;
            w0 = tap_weight(k - first, radius, sigma, use_table);
            let s = h_cache[h_cache_slot(k - chunk)];
            acc0 += s * w0; tw0 += w0;
            acc1 += s * w1; tw1 += w1;
            acc2 += s * w2; tw2 += w2;
            acc3 += s * w3; tw3 += w3;
        }
    }

    let x = group_x + first;
    if (x < dims.x) { textureStore(output_texture, vec2<i32>(x, out_y), vec4<f32>(acc0 / tw0, 1.0)); }
    if (x + 1 < dims.x) { textureStore(output_texture, vec2<i32>(x + 1, out_y), vec4<f32>(acc1 / tw1, 1.0)); }
    if (x + 2 < dims.x) { textureStore(output_texture, vec2<i32>(x + 2, out_y), vec4<f32>(acc2 / tw2, 1.0)); }
    if (x + 3 < dims.x) { textureStore(output_texture, vec2<i32>(x + 3, out_y), vec4<f32>(acc3 / tw3, 1.0)); }
}

@compute @workgroup_size(8, 8, 1)
fn vertical_blur(
    @builtin(local_invocation_id) local_id: vec3<u32>,
    @builtin(local_invocation_index) local_index: u32,
    @builtin(workgroup_id) group_id: vec3<u32>
) {
    let radius = i32(params.radius);
    let sigma = f32(radius) / 2.0;
    let use_table = radius <= MAX_TABLE_RADIUS;
    if (use_table) {
        fill_weight_table(local_index, u32(V_COLUMNS * V_THREAD_ROWS), radius, sigma);
    }

    let width = i32(params.input_width);
    let height = i32(params.input_height);
    let max_y = height - 1;
    let lx = i32(local_id.x);
    let ly = i32(local_id.y);
    let x = i32(group_id.x) * V_COLUMNS + lx;
    let load_x = min(x, width - 1);
    let group_y = i32(group_id.y) * V_OUTPUTS;
    let window_start = group_y - radius;
    let window_len = V_OUTPUTS + 2 * radius;
    let first = ly * V_PER_THREAD;
    let last = first + V_PER_THREAD - 1 + 2 * radius;

    var acc0 = vec3<f32>(0.0); var acc1 = vec3<f32>(0.0); var acc2 = vec3<f32>(0.0); var acc3 = vec3<f32>(0.0);
    var acc4 = vec3<f32>(0.0); var acc5 = vec3<f32>(0.0); var acc6 = vec3<f32>(0.0); var acc7 = vec3<f32>(0.0);
    var tw0 = 0.0; var tw1 = 0.0; var tw2 = 0.0; var tw3 = 0.0; var tw4 = 0.0; var tw5 = 0.0; var tw6 = 0.0; var tw7 = 0.0;
    var w0 = 0.0; var w1 = 0.0; var w2 = 0.0; var w3 = 0.0; var w4 = 0.0; var w5 = 0.0; var w6 = 0.0; var w7 = 0.0;

    for (var chunk = 0; chunk < window_len; chunk = chunk + V_OUTPUTS) {
        workgroupBarrier();
        let chunk_len = min(V_OUTPUTS, window_len - chunk);
        for (var m = 0; m < V_PER_THREAD; m = m + 1) {
            let e = ly + m * V_THREAD_ROWS;
            if (e < chunk_len) {
                let sample_y = clamp(window_start + chunk + e, 0, max_y);
                v_cache[e * V_COLUMNS + lx] = load_clamped(vec2<i32>(load_x, sample_y));
            }
        }
        workgroupBarrier();

        let k_end = min(last, chunk + V_OUTPUTS - 1);
        for (var k = max(first, chunk); k <= k_end; k = k + 1) {
            w7 = w6; w6 = w5; w5 = w4; w4 = w3; w3 = w2; w2 = w1; w1 = w0;
            w0 = tap_weight(k - first, radius, sigma, use_table);
            let s = v_cache[(k - chunk) * V_COLUMNS + lx];
            acc0 += s * w0; tw0 += w0;
            acc1 += s * w1; tw1 += w1;
            acc2 += s * w2; tw2 += w2;
            acc3 += s * w3; tw3 += w3;
            acc4 += s * w4; tw4 += w4;
            acc5 += s * w5; tw5 += w5;
            acc6 += s * w6; tw6 += w6;
            acc7 += s * w7; tw7 += w7;
        }
    }

    if (x < width) {
        let y = group_y + first;
        if (y < height) { textureStore(output_texture, vec2<i32>(x, y), vec4<f32>(acc0 / tw0, 1.0)); }
        if (y + 1 < height) { textureStore(output_texture, vec2<i32>(x, y + 1), vec4<f32>(acc1 / tw1, 1.0)); }
        if (y + 2 < height) { textureStore(output_texture, vec2<i32>(x, y + 2), vec4<f32>(acc2 / tw2, 1.0)); }
        if (y + 3 < height) { textureStore(output_texture, vec2<i32>(x, y + 3), vec4<f32>(acc3 / tw3, 1.0)); }
        if (y + 4 < height) { textureStore(output_texture, vec2<i32>(x, y + 4), vec4<f32>(acc4 / tw4, 1.0)); }
        if (y + 5 < height) { textureStore(output_texture, vec2<i32>(x, y + 5), vec4<f32>(acc5 / tw5, 1.0)); }
        if (y + 6 < height) { textureStore(output_texture, vec2<i32>(x, y + 6), vec4<f32>(acc6 / tw6, 1.0)); }
        if (y + 7 < height) { textureStore(output_texture, vec2<i32>(x, y + 7), vec4<f32>(acc7 / tw7, 1.0)); }
    }
}

@compute @workgroup_size(256, 1, 1)
fn horizontal_blur_direct(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(output_texture));
    if (id.x >= u32(dims.x)) {
        return;
    }

    let radius = i32(params.radius);
    let sigma = f32(radius) / 2.0;

    let absolute_coord = vec2<u32>(id.x + params.tile_offset_x, id.y + params.tile_offset_y);
    let full_dims = vec2<i32>(textureDimensions(input_texture));

    var total_color = vec3<f32>(0.0);
    var total_weight = 0.0;

    for (var offset = -radius; offset <= radius; offset = offset + 1) {
        let sample_x = clamp(i32(absolute_coord.x) + offset, 0, full_dims.x - 1);
        let sample_coord = vec2<i32>(sample_x, i32(absolute_coord.y));

        let sample_color = load_clamped(sample_coord);
        let weight = gaussian(f32(offset), sigma);

        total_color += sample_color * weight;
        total_weight += weight;
    }

    let final_color = total_color / total_weight;
    textureStore(output_texture, id.xy, vec4<f32>(final_color, 1.0));
}

@compute @workgroup_size(1, 256, 1)
fn vertical_blur_direct(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.y >= params.input_height) {
        return;
    }

    let radius = i32(params.radius);
    let sigma = f32(radius) / 2.0;

    let local_coord = vec2<i32>(id.xy);
    let max_y = i32(params.input_height) - 1;

    var total_color = vec3<f32>(0.0);
    var total_weight = 0.0;

    for (var offset = -radius; offset <= radius; offset = offset + 1) {
        let sample_y = clamp(local_coord.y + offset, 0, max_y);
        let sample_coord = vec2<i32>(local_coord.x, sample_y);

        let sample_color = load_clamped(sample_coord);
        let weight = gaussian(f32(offset), sigma);

        total_color += sample_color * weight;
        total_weight += weight;
    }

    let final_color = total_color / total_weight;
    textureStore(output_texture, id.xy, vec4<f32>(final_color, 1.0));
}
