struct Transform {
    rect: vec4<f32>,
    clip: vec4<f32>,
    window: vec2<f32>,
    image_size: vec2<f32>,
    texture_size: vec2<f32>,
    pixelated: f32,
    hdr_white: f32,
    bg_primary: vec4<f32>,
    bg_secondary: vec4<f32>,
    original_size: vec2<f32>,
    split_origin: vec2<f32>,
    split_normal: vec2<f32>,
    split_offset: vec2<f32>,
    lut: vec4<f32>,
    frame_curve: vec4<f32>,
    frame_to_srgb: mat3x3<f32>,
    linear_max: f32,
};

@group(0) @binding(0) var<uniform> transform: Transform;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var original_tex: texture_2d<f32>;
@group(0) @binding(4) var color_lut: texture_3d<f32>;

struct VertexOutput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) id: u32) -> VertexOutput {
    let uvs = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0)
    );
    let pos = uvs[id];

    let uv_x = transform.clip.x + pos.x * transform.clip.z;
    let uv_y = transform.clip.y + pos.y * transform.clip.w;

    let half_pixel_x = 0.5;
    let half_pixel_y = 0.5;
    let outset_x = (pos.x * 2.0 - 1.0) * half_pixel_x;
    let outset_y = (pos.y * 2.0 - 1.0) * half_pixel_y;

    let screen_x = uv_x + outset_x;
    let screen_y = uv_y + outset_y;

    let ndc_x = (screen_x / transform.window.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (screen_y / transform.window.y) * 2.0;

    var out: VertexOutput;
    out.pos = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);

    out.uv = vec2<f32>(
        (uv_x - transform.rect.x) / transform.rect.z,
        (uv_y - transform.rect.y) / transform.rect.w
    );

    return out;
}

fn sample_layer(layer: texture_2d<f32>, uv: vec2<f32>, image_size: vec2<f32>, texture_size: vec2<f32>) -> vec4<f32> {
    let adjusted_uv = uv * (image_size / texture_size);
    let half_texel = vec2<f32>(0.5, 0.5) / texture_size;

    let min_uv = half_texel;
    let max_uv = (image_size / texture_size) - half_texel;

    if (transform.pixelated > 0.5) {
        let texel_coords = floor(adjusted_uv * texture_size);
        let nearest_uv = (texel_coords + vec2<f32>(0.5, 0.5)) / texture_size;

        let clamped_nearest = clamp(nearest_uv, min_uv, max_uv);
        return textureSampleLevel(layer, samp, clamped_nearest, 0.0);
    } else {
        let clamped_uv = clamp(adjusted_uv, min_uv, max_uv);
        return textureSampleLevel(layer, samp, clamped_uv, 0.0);
    }
}

fn frame_to_linear(encoded: vec3<f32>) -> vec3<f32> {
    let curve = transform.frame_curve;
    let value = max(encoded, vec3<f32>(0.0));
    let toe = value / max(curve.z, 0.000001);
    let power = pow((value + curve.y) / (1.0 + curve.y), vec3<f32>(1.0 / curve.x));
    return select(power, toe, value <= vec3<f32>(curve.w * curve.z));
}

fn present(color: vec4<f32>) -> vec4<f32> {
    if (transform.hdr_white > 0.0) {
        let linear = transform.frame_to_srgb * frame_to_linear(color.rgb) * transform.hdr_white;
        return vec4<f32>(min(linear, vec3<f32>(transform.linear_max)), color.a);
    }
    if (transform.lut.x > 0.0) {
        let shaped = pow(frame_to_linear(min(color.rgb, vec3<f32>(1.0))), vec3<f32>(transform.lut.z));
        let position = shaped * transform.lut.x + transform.lut.y;
        return vec4<f32>(textureSampleLevel(color_lut, samp, position, 0.0).rgb, color.a);
    }
    return color;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let is_original = dot(in.pos.xy - transform.split_origin, transform.split_normal) < 0.0;
    let uv = select(in.uv, in.uv + transform.split_offset / transform.rect.zw, is_original);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return present(transform.bg_secondary);
    }

    if (is_original) {
        return present(sample_layer(original_tex, uv, transform.original_size, transform.original_size));
    }
    return present(sample_layer(tex, uv, transform.image_size, transform.texture_size));
}
