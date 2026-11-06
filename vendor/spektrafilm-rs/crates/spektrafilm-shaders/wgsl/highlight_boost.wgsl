// Highlight boost on flat interleaved raw film exposure values.
// Matches spektrafilm-model diffusion::boost_highlights in f32.

struct Params {
    n_values: u32,
    boost_ev: f32,
    boost_range: f32,
    protect_ev: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> max_raw_buf: array<f32>;
@group(0) @binding(2) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_values {
        return;
    }

    let midgray = 0.184;
    let max_raw = max_raw_buf[0];
    if max_raw == 0.0 {
        data[idx] = 0.0;
        return;
    }

    let raw_x0 = clamp(midgray * exp2(params.protect_ev), 0.0, max_raw);
    if raw_x0 == max_raw {
        return;
    }

    let a = pow(28.0, 1.0 - params.boost_range);
    let x0 = raw_x0 / max_raw;
    let span = 1.0 - x0;
    let denom = exp(a * span) - a * span - 1.0;
    if denom <= 0.0 {
        return;
    }

    let k = (exp2(params.boost_ev) - 1.0) / denom;
    let boost_scale = k * max_raw;
    let xv = data[idx];
    if xv > raw_x0 {
        let dx = (xv - raw_x0) / max_raw;
        data[idx] = xv + boost_scale * (exp(a * dx) - a * dx - 1.0);
    }
}
