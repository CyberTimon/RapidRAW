// Apply viewing glare:  rgb[c] += glare_amount[i] * offset[c] / 100
//
// `offset.xyz` is the per-channel illuminant offset (CPU pre-multiplies
// the XYZ→RGB matrix through `illuminant_xyz` and bundles the / 100 into
// this vector before upload). All three channels of `glare_amount` hold
// the same scalar (broadcast from `glare_gen.wgsl`); reading channel 0
// is sufficient.

struct Params {
    n_pixels: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    offset: vec4<f32>, // .xyz used; pre-divided by 100 by caller
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> glare_amount: array<f32>;
@group(0) @binding(2) var<storage, read_write> image: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    let g = glare_amount[base];
    image[base] = image[base] + g * params.offset.x;
    image[base + 1u] = image[base + 1u] + g * params.offset.y;
    image[base + 2u] = image[base + 2u] + g * params.offset.z;
}
