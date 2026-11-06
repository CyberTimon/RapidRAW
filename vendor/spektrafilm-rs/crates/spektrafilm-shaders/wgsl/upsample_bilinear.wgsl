// Bilinear upsample of an interleaved 3-channel image, inverting the
// `downsample_area` block mapping (sample centre at `(x + 0.5)/factor − 0.5`
// in small-pixel coords). Each thread produces one output pixel. Mirrors the
// CPU `upsample_bilinear` used by the diffusion filter.

struct Params {
    in_w: u32,
    in_h: u32,
    out_w: u32,
    out_h: u32,
    inv_factor: f32, // 1.0 / factor
    _p0: u32,
    _p1: u32,
    _p2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

fn sample(sx: u32, sy: u32, c: u32) -> f32 {
    return input[(sy * params.in_w + sx) * 3u + c];
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if x >= params.out_w || y >= params.out_h {
        return;
    }
    let max_x = f32(params.in_w - 1u);
    let max_y = f32(params.in_h - 1u);
    let fx = clamp((f32(x) + 0.5) * params.inv_factor - 0.5, 0.0, max_x);
    let fy = clamp((f32(y) + 0.5) * params.inv_factor - 0.5, 0.0, max_y);
    let x0 = u32(floor(fx));
    let y0 = u32(floor(fy));
    let x1 = min(x0 + 1u, params.in_w - 1u);
    let y1 = min(y0 + 1u, params.in_h - 1u);
    let wx = fx - floor(fx);
    let wy = fy - floor(fy);

    let o = (y * params.out_w + x) * 3u;
    for (var c = 0u; c < 3u; c++) {
        let top = sample(x0, y0, c) * (1.0 - wx) + sample(x1, y0, c) * wx;
        let bot = sample(x0, y1, c) * (1.0 - wx) + sample(x1, y1, c) * wx;
        output[o + c] = top * (1.0 - wy) + bot * wy;
    }
}
