// Mallett2019 RGB → film raw exposure: one 3×3 matmul per pixel.
//
// The matrix is `core · M_cs` (reflectance-basis integration × input
// colour-space → linear-sRGB) with the exposure scale folded in by the
// caller. CPU reference: `mallett::apply(film_matrix(core, cs), rgb)`.

struct Params {
    width: u32,
    height: u32,
    _pad0: u32,
    _pad1: u32,
    // rgb → raw matrix (columns uploaded as the Rust row-major matrix's columns,
    // so `m * rgb` is the standard matrix-vector product).
    m: mat3x3<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> rgb_in: array<f32>;        // [H*W*3]
@group(0) @binding(2) var<storage, read_write> raw_out: array<f32>; // [H*W*3]

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pixel_idx = gid.x;
    if pixel_idx >= params.width * params.height {
        return;
    }
    let base = pixel_idx * 3u;
    let rgb = vec3<f32>(rgb_in[base], rgb_in[base + 1u], rgb_in[base + 2u]);
    let raw = params.m * rgb;
    raw_out[base] = raw.x;
    raw_out[base + 1u] = raw.y;
    raw_out[base + 2u] = raw.z;
}
