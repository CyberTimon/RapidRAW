// Halation scatter pass — final mix.
//
// Computes, per pixel, per channel c:
//   scattered = (1 - tail_weight[c]) * core[i,c] + tail_weight[c] * tail[i,c]
//   result[i,c] = (1 - scatter_amount) * result[i,c] + scatter_amount * scattered
//
// `tail_weight` is per-channel (Python parity — film stocks have
// noticeably different tail weights across channels, e.g. Portra
// 0.78 / 0.65 / 0.67). `result` is read-modify-written in place.

struct Params {
    n_pixels: u32,
    scatter_amount: f32,
    _pad0: u32,
    _pad1: u32,
    tail_weight: vec4<f32>, // .xyz used (per channel), .w padding
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> core_buf: array<f32>;
@group(0) @binding(2) var<storage, read> tail_buf: array<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    let sa = params.scatter_amount;
    let atw = params.tail_weight.xyz;
    for (var c = 0u; c < 3u; c++) {
        let r = result[base + c];
        let scattered = (1.0 - atw[c]) * core_buf[base + c] + atw[c] * tail_buf[base + c];
        result[base + c] = (1.0 - sa) * r + sa * scattered;
    }
}
