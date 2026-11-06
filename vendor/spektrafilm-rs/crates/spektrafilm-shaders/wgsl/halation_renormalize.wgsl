// Halation renormalize: result[c] /= 1 + a_tot[c]   (per channel).
//
// Equivalent to a per-channel scale by precomputed `inv_factor[c] =
// 1 / (1 + a_tot[c])`. Same pattern as the CPU loop in
// `apply_halation_um` — preserves overall luminance when halation pulls
// energy from the surround into the highlights.

struct Params {
    n_pixels: u32,
    _pad: u32,
    inv_factor: vec4<f32>, // .xyz = per-channel scale, .w padding
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    result[base] = result[base] * params.inv_factor.x;
    result[base + 1u] = result[base + 1u] * params.inv_factor.y;
    result[base + 2u] = result[base + 2u] * params.inv_factor.z;
}
