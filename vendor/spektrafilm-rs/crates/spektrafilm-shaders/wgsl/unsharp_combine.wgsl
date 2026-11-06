// Unsharp mask combine pass:
//   out[i] = a[i] + amount * (a[i] - b[i])
//          = (1 + amount) * a[i] - amount * b[i]
//
// `a` is the original image (read), `b` is the blurred version (read),
// `out` is the destination (write — different buffer from a, b).

struct Params {
    n_pixels: u32,
    amount: f32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> a_buf: array<f32>;
@group(0) @binding(2) var<storage, read> b_buf: array<f32>;
@group(0) @binding(3) var<storage, read_write> out_buf: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    let k1 = 1.0 + params.amount;
    let k2 = params.amount;
    out_buf[base] = k1 * a_buf[base] - k2 * b_buf[base];
    out_buf[base + 1u] = k1 * a_buf[base + 1u] - k2 * b_buf[base + 1u];
    out_buf[base + 2u] = k1 * a_buf[base + 2u] - k2 * b_buf[base + 2u];
}
