@group(0) @binding(1) var output_texture: texture_storage_2d<rgba8unorm, write>;

fn store_output(coords: vec2<u32>, color: vec4<f32>) {
    textureStore(output_texture, coords, color);
}
