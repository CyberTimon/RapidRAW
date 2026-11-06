// Element-wise `dst[i] += scale * src[i]` over an interleaved 3-channel
// image. Each thread handles all 3 channels of one pixel.
//
// `clear_first` (0 or 1) lets the caller zero `dst` before adding —
// useful for the first bounce in an accumulation loop.

struct Params {
    n_pixels: u32,
    scale: f32,
    clear_first: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    let scale = params.scale;
    if params.clear_first != 0u {
        dst[base] = scale * src[base];
        dst[base + 1u] = scale * src[base + 1u];
        dst[base + 2u] = scale * src[base + 2u];
    } else {
        dst[base] += scale * src[base];
        dst[base + 1u] += scale * src[base + 1u];
        dst[base + 2u] += scale * src[base + 2u];
    }
}
