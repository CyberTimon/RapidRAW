// Per-pixel density curve interpolation.
// Maps log_exposure (HxWx3) → density_cmy (HxWx3) using a uniform lookup table.

struct Params {
    width: u32,
    height: u32,
    table_len: u32,
    x_min: f32,
    x_max: f32,
    gamma: f32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> log_exposure: array<f32>;      // [H*W*3]
@group(0) @binding(2) var<storage, read> density_table: array<f32>;     // [table_len*3]
@group(0) @binding(3) var<storage, read_write> density_out: array<f32>; // [H*W*3]

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pixel_idx = gid.x;
    let total_pixels = params.width * params.height;
    if pixel_idx >= total_pixels {
        return;
    }

    let base = pixel_idx * 3u;
    let n = params.table_len;
    let step = (params.x_max - params.x_min) / f32(n - 1u);

    for (var c = 0u; c < 3u; c++) {
        let x = log_exposure[base + c];
        let x_scaled = x; // gamma would scale x_min/x_max, not x itself
        let t = (x_scaled - params.x_min / params.gamma) / (step / params.gamma);

        var result: f32;
        if t <= 0.0 {
            result = density_table[c];
        } else if t >= f32(n - 1u) {
            result = density_table[(n - 1u) * 3u + c];
        } else {
            let i = u32(t);
            let frac = t - f32(i);
            let y0 = density_table[i * 3u + c];
            let y1 = density_table[(i + 1u) * 3u + c];
            result = y0 + frac * (y1 - y0);
        }
        density_out[base + c] = result;
    }
}
