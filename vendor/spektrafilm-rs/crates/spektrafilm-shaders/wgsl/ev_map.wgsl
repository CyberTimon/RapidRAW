// Per-pixel exposure-offset map application (RapidRAW fork extension).
//
// Two modes sharing one storage layout:
//   mode 0 ("multiply"): img[c] *= 2^ev[i]      — film exposure, on linear RGB
//   mode 1 ("add-log"):  img[c] += ev[i] * log10(2) — print exposure, applied
//                        in the print log-exposure domain (equivalent to
//                        scaling the linear print raw by 2^ev before log10).
//
// The EV map is one f32 per pixel (H*W), the image buffer is H*W*3 f32.

struct Params {
    n_pixels: u32,
    mode: u32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> ev_map: array<f32>;     // [H*W]
@group(0) @binding(2) var<storage, read_write> img: array<f32>;  // [H*W*3]

const LOG10_2: f32 = 0.3010299956639812;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.n_pixels) {
        return;
    }
    let ev = ev_map[i];
    if (ev == 0.0) {
        return;
    }
    let base = i * 3u;
    if (params.mode == 0u) {
        let s = exp2(ev);
        img[base] *= s;
        img[base + 1u] *= s;
        img[base + 2u] *= s;
    } else {
        let d = ev * LOG10_2;
        img[base] += d;
        img[base + 1u] += d;
        img[base + 2u] += d;
    }
}
