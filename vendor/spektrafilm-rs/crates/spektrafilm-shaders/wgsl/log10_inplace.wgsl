// In-place log10 transform: data[i] = log10(max(data[i], 1e-10))
// Used between the Hanatos2025 (raw) and density-curve interp stages.
//
// `n` is the total number of pixels (not elements). Each thread processes
// the 3 channels of one pixel — keeps workgroup count under the 65535 limit
// for large images.

struct Params {
    n_pixels: u32,
    _pad: vec3<u32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels {
        return;
    }
    let base = idx * 3u;
    let log10_inv = 1.0 / log(10.0);
    data[base] = log(max(data[base], 1e-10)) * log10_inv;
    data[base + 1u] = log(max(data[base + 1u], 1e-10)) * log10_inv;
    data[base + 2u] = log(max(data[base + 2u], 1e-10)) * log10_inv;
}
