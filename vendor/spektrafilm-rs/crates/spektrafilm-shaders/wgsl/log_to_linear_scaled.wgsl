// In-place print-stage conversion: data = 10^log_raw * scale.

struct Params {
    n_pixels: u32,
    scale: f32,
    _pad: vec2<u32>,
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
    data[base] = pow(10.0, data[base]) * params.scale;
    data[base + 1u] = pow(10.0, data[base + 1u]) * params.scale;
    data[base + 2u] = pow(10.0, data[base + 2u]) * params.scale;
}
