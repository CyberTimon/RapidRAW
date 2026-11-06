// Integer-factor box (area-average) downsample of an interleaved 3-channel
// image. Each thread produces one output pixel by averaging the
// `factor × factor` source block (clamped at the right/bottom edges).
// Mirrors the CPU `downsample_area` used by the diffusion filter.

struct Params {
    in_w: u32,
    in_h: u32,
    out_w: u32,
    out_h: u32,
    factor: u32,
    _p0: u32,
    _p1: u32,
    _p2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let sx = gid.x;
    let sy = gid.y;
    if sx >= params.out_w || sy >= params.out_h {
        return;
    }
    let x0 = sx * params.factor;
    let y0 = sy * params.factor;
    let x1 = min(x0 + params.factor, params.in_w);
    let y1 = min(y0 + params.factor, params.in_h);

    var acc = vec3<f32>(0.0, 0.0, 0.0);
    var cnt = 0.0;
    for (var yy = y0; yy < y1; yy++) {
        for (var xx = x0; xx < x1; xx++) {
            let i = (yy * params.in_w + xx) * 3u;
            acc += vec3<f32>(input[i], input[i + 1u], input[i + 2u]);
            cnt += 1.0;
        }
    }
    let o = (sy * params.out_w + sx) * 3u;
    let inv = 1.0 / max(cnt, 1.0);
    output[o] = acc.x * inv;
    output[o + 1u] = acc.y * inv;
    output[o + 2u] = acc.z * inv;
}
