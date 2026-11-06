// Density curve interpolation: log_raw → density_cmy per channel.
//
// Per pixel per channel:
//   t = (log_raw[c] * gamma_inv - log_exp[0]) / step    (uniform-grid lookup)
//   density[c] = lerp(curve[low][c], curve[low+1][c], frac)
//
// Falls back to bisect-style binary search if `uniform_grid == 0`,
// matching numpy `searchsorted(side='right') - 1` semantics.

struct Params {
    width: u32,
    height: u32,
    k: u32,              // number of curve samples
    uniform_grid: u32,   // 1 if log_exposure is uniformly spaced (fast path)
    gamma_inv: vec3<f32>,
    _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> log_raw: array<f32>;        // [H*W*3]
@group(0) @binding(2) var<storage, read> log_exposure: array<f32>;   // [K]
@group(0) @binding(3) var<storage, read> density_curves: array<f32>; // [K*3]
@group(0) @binding(4) var<storage, read_write> output: array<f32>;   // [H*W*3]

fn interp_channel(xq: f32, gamma_inv_c: f32, channel: u32) -> f32 {
    let k = params.k;
    if k == 0u {
        return 0.0;
    }
    // First and last x-axis values for this channel.
    let xa0 = log_exposure[0] * gamma_inv_c;
    let xa_last = log_exposure[k - 1u] * gamma_inv_c;

    // Endpoint clamps — matches Python `fast_interp` behavior.
    if xq <= xa0 {
        return density_curves[0u * 3u + channel];
    }
    if xq >= xa_last {
        return density_curves[(k - 1u) * 3u + channel];
    }

    if params.uniform_grid != 0u {
        // Uniform grid fast path — direct index computation.
        let step = (xa_last - xa0) / f32(k - 1u);
        let t = (xq - xa0) / step;
        let i = u32(floor(t));
        let frac = t - f32(i);
        let y0 = density_curves[i * 3u + channel];
        let y1 = density_curves[(i + 1u) * 3u + channel];
        return y0 + frac * (y1 - y0);
    }

    // Bisect — numpy searchsorted(side='right') - 1.
    var lo = 0u;
    var hi = k;
    loop {
        if lo + 1u >= hi { break; }
        let mid = (lo + hi) / 2u;
        let xa_mid = log_exposure[mid] * gamma_inv_c;
        if xa_mid <= xq {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let xa_lo = log_exposure[lo] * gamma_inv_c;
    let xa_hi = log_exposure[lo + 1u] * gamma_inv_c;
    let dx = xa_hi - xa_lo;
    let frac = select(0.0, (xq - xa_lo) / dx, dx != 0.0);
    let y0 = density_curves[lo * 3u + channel];
    let y1 = density_curves[(lo + 1u) * 3u + channel];
    return y0 + frac * (y1 - y0);
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pixel_idx = gid.x;
    let total = params.width * params.height;
    if pixel_idx >= total {
        return;
    }
    let base = pixel_idx * 3u;
    output[base] = interp_channel(log_raw[base], params.gamma_inv.x, 0u);
    output[base + 1u] = interp_channel(log_raw[base + 1u], params.gamma_inv.y, 1u);
    output[base + 2u] = interp_channel(log_raw[base + 2u], params.gamma_inv.z, 2u);
}
