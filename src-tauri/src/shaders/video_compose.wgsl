struct Params {
    grid: Grid,
    values: array<vec4<f32>, 4>,
    modes: array<vec4<u32>, 2>,
}

@group(0) @binding(7) var<uniform> params: Params;

const BLEND_NORMAL: u32 = 0u;
const BLEND_MULTIPLY: u32 = 1u;
const BLEND_SCREEN: u32 = 2u;
const BLEND_OVERLAY: u32 = 3u;
const BLEND_SOFT_LIGHT: u32 = 4u;
const BLEND_ADD: u32 = 5u;
const BLEND_DIFFERENCE: u32 = 6u;
const BLEND_DARKEN: u32 = 7u;
const WIDE: u32 = 1u;
const PACK_RGBA8: u32 = 0u;
const PACK_RGB48: u32 = 1u;
const PACK_YUV_INTERLEAVED: u32 = 3u;
const SWS_HALF_TAP_0: f32 = 0.4359375;
const SWS_HALF_TAP_1: f32 = 0.1203125;
const SWS_HALF_TAP_2: f32 = -0.0421875;
const SWS_HALF_TAP_3: f32 = -0.0140625;
const SQRT3_HALF: f32 = 0.8660254;
const INV_SQRT3: f32 = 0.57735027;

fn bilinear(t: texture_2d<f32>, position: vec2<f32>) -> vec4<f32> {
    return tap_sample(t, tap_from(position - 0.5, textureDimensions(t)));
}

fn centre(id: vec3<u32>) -> vec2<f32> {
    return vec2<f32>(id.xy) + 0.5;
}

fn store(id: vec3<u32>, value: vec4<f32>) {
    if (params.grid.flags == WIDE) {
        textureStore(out_f32, id.xy, value);
    } else {
        textureStore(out_f16, id.xy, value);
    }
}

fn unpremultiply(c: vec4<f32>) -> vec3<f32> {
    return select(vec3<f32>(0.0), c.rgb / c.a, c.a > 0.0);
}

fn blend_colors(b: vec3<f32>, s: vec3<f32>, mode: u32) -> vec3<f32> {
    switch mode {
        case BLEND_MULTIPLY: {
            return b * s;
        }
        case BLEND_SCREEN: {
            return b + s - b * s;
        }
        case BLEND_OVERLAY: {
            let lifted = 2.0 * b - 1.0;
            return select(s + lifted - s * lifted, 2.0 * b * s, b <= vec3<f32>(0.5));
        }
        case BLEND_SOFT_LIGHT: {
            let curve = select(sqrt(max(b, vec3<f32>(0.0))), ((16.0 * b - 12.0) * b + 4.0) * b, b <= vec3<f32>(0.25));
            return select(b + (2.0 * s - 1.0) * (curve - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), s <= vec3<f32>(0.5));
        }
        case BLEND_ADD: {
            return b + s;
        }
        case BLEND_DIFFERENCE: {
            return abs(b - s);
        }
        case BLEND_DARKEN: {
            return min(b, s);
        }
        default: {
            return max(b, s);
        }
    }
}

fn blend(canvas: vec4<f32>, layer: vec4<f32>, mode: u32) -> vec4<f32> {
    let uncovered = canvas * (1.0 - layer.a);
    if (mode == BLEND_NORMAL) {
        return layer + uncovered;
    }
    let mixed = blend_colors(unpremultiply(canvas), unpremultiply(layer), mode);
    let rgb = layer.rgb * (1.0 - canvas.a) + uncovered.rgb + layer.a * canvas.a * mixed;
    return vec4<f32>(rgb, layer.a + uncovered.a);
}

@compute @workgroup_size(8, 8, 1)
fn vc_fill(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    textureStore(out_f16, id.xy, params.values[0]);
}

@compute @workgroup_size(8, 8, 1)
fn vc_premultiply(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let c = textureLoad(t0, id.xy, 0);
    textureStore(out_f16, id.xy, vec4<f32>(c.rgb * c.a, c.a));
}

@compute @workgroup_size(8, 8, 1)
fn vc_composite(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let canvas = textureLoad(t0, id.xy, 0);
    let row_x = params.values[0];
    let row_y = params.values[1];
    let p = vec3<f32>(centre(id), 1.0);
    let position = vec2<f32>(dot(row_x.xyz, p), dot(row_y.xyz, p));
    let size = vec2<f32>(textureDimensions(t1));
    let inside = clamp(min(position, size - position) * params.values[2].xy + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    let coverage = inside.x * inside.y * row_x.w;
    if (coverage <= 0.0) {
        textureStore(out_f16, id.xy, canvas);
        return;
    }
    let taps = params.modes[0].yz;
    let step_x = vec2<f32>(row_x.x, row_y.x) / f32(taps.x);
    let step_y = vec2<f32>(row_x.y, row_y.y) / f32(taps.y);
    let first = position - 0.5 * (f32(taps.x - 1u) * step_x + f32(taps.y - 1u) * step_y);
    var sum = vec4<f32>(0.0);
    for (var j = 0u; j < taps.y; j++) {
        for (var i = 0u; i < taps.x; i++) {
            sum += bilinear(t1, first + f32(i) * step_x + f32(j) * step_y);
        }
    }
    let layer = sum * (coverage / f32(taps.x * taps.y));
    textureStore(out_f16, id.xy, blend(canvas, layer, params.modes[0].x));
}

@compute @workgroup_size(8, 8, 1)
fn vc_pin(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let canvas = textureLoad(t0, id.xy, 0);
    let row_x = params.values[0];
    let row_y = params.values[1];
    let row_w = params.values[2].xyz;
    let p = vec3<f32>(centre(id), 1.0);
    let depth = dot(row_w, p);
    if (depth <= 0.5 * length(row_w.xy)) {
        textureStore(out_f16, id.xy, canvas);
        return;
    }
    let position = vec2<f32>(dot(row_x.xyz, p), dot(row_y.xyz, p)) / depth;
    let along_x = (vec2<f32>(row_x.x, row_y.x) - position * row_w.x) / depth;
    let along_y = (vec2<f32>(row_x.y, row_y.y) - position * row_w.y) / depth;
    let size = params.values[3].xy;
    let reach = vec2<f32>(length(vec2<f32>(along_x.x, along_y.x)), length(vec2<f32>(along_x.y, along_y.y)));
    let inside = clamp(min(position, size - position) / max(reach, vec2<f32>(1e-6)) + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    let coverage = inside.x * inside.y * row_x.w;
    if (coverage <= 0.0) {
        textureStore(out_f16, id.xy, canvas);
        return;
    }
    let limit = f32(params.modes[0].y);
    let taps = vec2<u32>(clamp(ceil(vec2<f32>(length(along_x), length(along_y))), vec2<f32>(1.0), vec2<f32>(limit)));
    let step_x = along_x / f32(taps.x);
    let step_y = along_y / f32(taps.y);
    let first = position - 0.5 * (f32(taps.x - 1u) * step_x + f32(taps.y - 1u) * step_y);
    var sum = vec4<f32>(0.0);
    for (var j = 0u; j < taps.y; j++) {
        for (var i = 0u; i < taps.x; i++) {
            sum += bilinear(t1, first + f32(i) * step_x + f32(j) * step_y);
        }
    }
    let layer = sum * (coverage / f32(taps.x * taps.y));
    textureStore(out_f16, id.xy, blend(canvas, layer, params.modes[0].x));
}

fn zoomed(t: texture_2d<f32>, p: vec2<f32>, view: vec4<f32>, angle: f32) -> vec4<f32> {
    let size = vec2<f32>(params.grid.dst);
    let middle = size * 0.5;
    let scaled = (p - middle) * view.x;
    let turned = vec2<f32>(cos(angle) * scaled.x - sin(angle) * scaled.y, sin(angle) * scaled.x + cos(angle) * scaled.y);
    let position = turned + middle - view.yz;
    if (angle != 0.0 && (any(position < vec2<f32>(0.0)) || any(position > size))) {
        return vec4<f32>(0.0);
    }
    return bilinear(t, position);
}

@compute @workgroup_size(8, 8, 1)
fn vc_transition(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = centre(id);
    let edge = params.values[2];
    var weight = params.values[0].w;
    if (params.modes[0].x == 1u) {
        weight = clamp(edge.w - (dot(p, edge.xy) + edge.z) + 0.5, 0.0, 1.0);
    } else if (params.modes[0].x == 2u) {
        weight = clamp((edge.z - distance(p, edge.xy)) / max(edge.w, 1e-3) + 0.5, 0.0, 1.0);
    }
    let outgoing = zoomed(t0, p, params.values[0], params.values[3].x);
    let incoming = zoomed(t1, p, params.values[1], params.values[3].y);
    textureStore(out_f16, id.xy, mix(outgoing, incoming, weight));
}

@compute @workgroup_size(8, 8, 1)
fn vc_wash(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let c = textureLoad(t0, id.xy, 0);
    let wash = params.values[0];
    textureStore(out_f16, id.xy, vec4<f32>(mix(c.rgb, wash.rgb * c.a, wash.w), c.a));
}

fn half_weight(tap: i32) -> f32 {
    return select(0.375, 0.125, tap == 0 || tap == 3);
}

@compute @workgroup_size(8, 8, 1)
fn vc_half(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let first = vec2<i32>(id.xy) * 2 - 1;
    let last = vec2<i32>(params.grid.src) - 1;
    var sum = vec4<f32>(0.0);
    for (var j = 0; j < 4; j++) {
        var row = vec4<f32>(0.0);
        for (var i = 0; i < 4; i++) {
            row += half_weight(i) * textureLoad(t0, clamp(first + vec2<i32>(i, j), vec2<i32>(0), last), 0);
        }
        sum += half_weight(j) * row;
    }
    store(id, sum);
}

@compute @workgroup_size(8, 8, 1)
fn vc_gauss(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let stride = select(vec2<i32>(1, 0), vec2<i32>(0, 1), params.modes[0].x == 1u);
    let radius = i32(params.modes[0].y);
    let falloff = params.values[0].x;
    let last = vec2<i32>(params.grid.dst) - vec2<i32>(1);
    let p = vec2<i32>(id.xy);
    var sum = vec4<f32>(0.0);
    var total = 0.0;
    for (var k = -radius; k <= radius; k++) {
        let weight = exp(f32(k * k) * falloff);
        sum += weight * textureLoad(t0, clamp(p + stride * k, vec2<i32>(0), last), 0);
        total += weight;
    }
    store(id, sum / total);
}

@compute @workgroup_size(8, 8, 1)
fn vc_blur_mix(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let c = textureLoad(t0, id.xy, 0);
    let blurred = bilinear(t1, centre(id) * params.values[0].x);
    let weights = params.values[1];
    let rgb = max(c.rgb * weights.x + blurred.rgb * weights.y, vec3<f32>(0.0));
    textureStore(out_f16, id.xy, vec4<f32>(rgb, c.a * weights.z + blurred.a * weights.w));
}

@compute @workgroup_size(8, 8, 1)
fn vc_reveal(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let size = vec2<f32>(params.grid.dst);
    let p = centre(id) / size;
    var along = p.x;
    switch params.modes[0].x {
        case 0u: { along = 1.0 - p.x; }
        case 2u: { along = 1.0 - p.y; }
        case 3u: { along = p.y; }
        default: {}
    }
    let reveal = params.values[0];
    var coverage: f32;
    if (params.modes[0].y == 1u) {
        coverage = clamp((reveal.x - along) / reveal.y + 0.5, 0.0, 1.0);
    } else {
        coverage = clamp((along - (1.0 - reveal.x)) / reveal.y + 0.5, 0.0, 1.0);
    }
    textureStore(out_f16, id.xy, textureLoad(t0, id.xy, 0) * coverage);
}

@compute @workgroup_size(8, 8, 1)
fn vc_round(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let window = params.values[0];
    let half = 0.5 * (window.zw - window.xy);
    let radius = params.values[1].x;
    let q = abs(centre(id) - 0.5 * (window.xy + window.zw)) - (half - radius);
    let distance = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    let coverage = clamp(0.5 - distance, 0.0, 1.0);
    textureStore(out_f16, id.xy, textureLoad(t0, id.xy, 0) * coverage);
}

@compute @workgroup_size(8, 8, 1)
fn vc_text_reveal(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let glyphs = textureLoad(t0, id.xy, 0);
    let code = round(textureLoad(t1, id.xy, 0).rgb * 255.0);
    if (code.r + code.g == 0.0) {
        textureStore(out_f16, id.xy, glyphs);
        return;
    }
    let character = code.r + code.g * 256.0 - 1.0;
    let word = code.b - 1.0;
    let reveal = params.values[0];
    let entering = select(character, word, params.modes[0].x == 1u);
    let leaving = select(character, word, params.modes[0].y == 1u);
    let shown = clamp((reveal.x - entering) * reveal.y, 0.0, 1.0) * clamp((reveal.z - leaving) * reveal.w, 0.0, 1.0);
    textureStore(out_f16, id.xy, glyphs * shown);
}

@compute @workgroup_size(8, 8, 1)
fn vc_cutout(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let scale = vec2<f32>(textureDimensions(t1)) / vec2<f32>(params.grid.dst);
    let masks = bilinear(t1, centre(id) * scale);
    let c = textureLoad(t0, id.xy, 0);
    if (params.modes[0].x == 0u) {
        textureStore(out_f16, id.xy, c * masks.r);
        return;
    }
    let rgb = unpremultiply(c);
    let key = params.values[0];
    let spill = params.values[1];
    let chroma = vec2<f32>(rgb.r - 0.5 * (rgb.g + rgb.b), SQRT3_HALF * (rgb.g - rgb.b));
    let dominance = dot(chroma, key.xy) - abs(chroma.x * key.y - chroma.y * key.x) * INV_SQRT3;
    let peak = max(max(rgb.r, rgb.g), max(rgb.b, 1e-4));
    let keyed = 1.0 - smooth_step(key.z, key.w, dominance / peak);
    let alpha = c.a * max(masks.r, masks.g * keyed);
    let cleaned = max(rgb - spill.rgb * (spill.w * masks.g * max(dominance, 0.0)), vec3<f32>(0.0));
    textureStore(out_f16, id.xy, vec4<f32>(cleaned * alpha, alpha));
}

@compute @workgroup_size(8, 8, 1)
fn vc_matte(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let canvas = textureLoad(t0, id.xy, 0);
    let layer = textureLoad(t1, id.xy, 0);
    let shape = textureLoad(t2, id.xy, 0);
    var amount = shape.a;
    if (params.modes[0].y == 1u) {
        amount = dot(shape.rgb, params.values[0].xyz);
    }
    amount = clamp(amount, 0.0, 1.0);
    if (params.modes[0].z == 1u) {
        amount = 1.0 - amount;
    }
    textureStore(out_f16, id.xy, blend(canvas, layer * amount, params.modes[0].x));
}

@compute @workgroup_size(8, 8, 1)
fn vc_window(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    let p = vec2<i32>(id.xy) + vec2<i32>(params.values[0].xy);
    var c = vec4<f32>(0.0);
    if (all(p >= vec2<i32>(0)) && all(p < vec2<i32>(textureDimensions(t0)))) {
        c = textureLoad(t0, p, 0);
    }
    textureStore(out_f16, id.xy, c);
}

fn clamped_rgb(x: u32, y: u32) -> vec3<f32> {
    let p = min(vec2<u32>(x, y), params.grid.src - 1u);
    return clamp(textureLoad(t0, p, 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn paired_rgb(x: u32, y: u32, offset: i32) -> vec3<f32> {
    let row = u32(clamp(i32(y) + offset, 0, i32(params.grid.src.y) - 1));
    return 0.5 * (clamped_rgb(x, row) + clamped_rgb(x + 1u, row));
}

fn swscale_chroma_rgb(x: u32, y: u32, rows: u32) -> vec3<f32> {
    if (rows == 1u) {
        return paired_rgb(x, y, 0);
    }
    return SWS_HALF_TAP_0 * (paired_rgb(x, y, 0) + paired_rgb(x, y, 1))
        + SWS_HALF_TAP_1 * (paired_rgb(x, y, -1) + paired_rgb(x, y, 2))
        + SWS_HALF_TAP_2 * (paired_rgb(x, y, -2) + paired_rgb(x, y, 3))
        + SWS_HALF_TAP_3 * (paired_rgb(x, y, -3) + paired_rgb(x, y, 4));
}

fn chroma_code(index: u32, plane: u32) -> u32 {
    let width = params.modes[0].z;
    let rows = params.modes[1].w;
    let x = (index % width) * 2u;
    let y = (index / width) * rows;
    var rgb = vec3<f32>(0.0);
    if (params.values[3].y > 0.5) {
        rgb = swscale_chroma_rgb(x, y, rows);
    } else {
        for (var r = 0u; r < rows; r++) {
            rgb += 0.25 * clamped_rgb(max(x, 1u) - 1u, y + r) + 0.5 * clamped_rgb(x, y + r) + 0.25 * clamped_rgb(x + 1u, y + r);
        }
        rgb /= f32(rows);
    }
    let luma = dot(rgb, params.values[0].xyz);
    let difference = select(rgb.b - luma, rgb.r - luma, plane == 1u) * select(params.values[2].x, params.values[2].y, plane == 1u);
    let levels = params.values[1];
    return u32(round(clamp(levels.z + levels.w * difference, 0.0, params.values[0].w)));
}

fn sample_code(s: u32) -> u32 {
    let size = params.grid.src;
    let pixels = size.x * size.y;
    let kind = params.modes[0].x;
    if (kind == PACK_RGBA8) {
        let pixel = s / 4u;
        let c = textureLoad(t0, vec2<u32>(pixel % size.x, pixel / size.x), 0);
        let straight = vec4<f32>(unpremultiply(c), c.a);
        return u32(round(clamp(straight[s % 4u], 0.0, 1.0) * 255.0));
    }
    if (kind == PACK_RGB48) {
        let pixel = s / 3u;
        let rgb = clamped_rgb(pixel % size.x, pixel / size.x);
        return u32(round(rgb[s % 3u] * 65535.0));
    }
    return yuv_code(s, pixels, kind) << u32(params.values[3].x);
}

fn yuv_code(s: u32, pixels: u32, kind: u32) -> u32 {
    let size = params.grid.src;
    if (s < pixels) {
        let levels = params.values[1];
        let luma = dot(clamped_rgb(s % size.x, s / size.x), params.values[0].xyz);
        return u32(round(clamp(levels.x + levels.y * luma, 0.0, params.values[0].w)));
    }
    let chroma = s - pixels;
    if (kind == PACK_YUV_INTERLEAVED) {
        return chroma_code(chroma / 2u, chroma % 2u);
    }
    let plane_samples = params.modes[0].z * params.modes[0].w;
    return chroma_code(chroma % plane_samples, chroma / plane_samples);
}

@compute @workgroup_size(8, 8, 1)
fn vc_pack(@builtin(global_invocation_id) id: vec3<u32>) {
    let local = id.y * params.grid.dst.x + id.x;
    let chunk = params.modes[1];
    if (id.x >= params.grid.dst.x || local >= chunk.y) { return; }
    let per_word = params.modes[0].y;
    let bits = 32u / per_word;
    let word = chunk.x + local;
    var packed = 0u;
    for (var k = 0u; k < per_word; k++) {
        let s = word * per_word + k;
        if (s < chunk.z) {
            packed = packed | (sample_code(s) << (k * bits));
        }
    }
    atomicStore(&scratch[local], packed);
}
