@group(0) @binding(1) var output_texture: texture_storage_2d<rgba16uint, write>;

fn store_output(coords: vec2<u32>, color: vec4<f32>) {
    let normalized = clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
    let codes = vec4<u32>(floor(normalized * 65535.0 + 0.5));
    textureStore(output_texture, coords, codes);
}
