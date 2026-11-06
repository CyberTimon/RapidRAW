// Per-channel variant of add_scaled: `dst[i,c] += scale[c] * src[i,c]`.
//
// Used by halation's final additive step where the halation strength
// `a_tot[c] = halation_strength[c] * halation_amount` differs per
// channel (e.g. Portra is `(0.05, 0.015, 0.0)` — blue gets no halation
// at all). Averaging the scalar value produces a uniform cool halo
// around bright edges; the per-channel variant preserves the film's
// chromatic halation signature.

struct Params {
    n_pixels: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    scale: vec4<f32>, // .xyz used (per channel), .w padding
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;
    let s = params.scale.xyz;
    dst[base]      = dst[base]      + s.x * src[base];
    dst[base + 1u] = dst[base + 1u] + s.y * src[base + 1u];
    dst[base + 2u] = dst[base + 2u] + s.z * src[base + 2u];
}
