// Hanatos2025 RGB → film raw exposure (per-pixel parallelization).
//
// For each pixel:
//   1. RGB (linear, source colorspace) → XYZ via rgb_to_xyz matrix
//   2. CAT02 adapt XYZ from source white → ref illuminant white (CAT applied as combined matrix)
//   3. b = X + Y + Z (brightness)
//   4. xy = (X/b, Y/b) clipped to [0,1]
//   5. tc = ((1-x)², y/max(1-x, eps))    (Python _tri2quad)
//   6. Lookup tc_lut[lut_x, lut_y] via Mitchell-Netravali bicubic 2D with reflected boundary
//      where (lut_x, lut_y) = (tc.y * (size-1), tc.x * (size-1))    (Python's lut[x,y] axis swap)
//   7. raw_per_channel = lookup * b
//
// All matrix work is f32 on GPU. The combined `rgb_to_lut_xyz` already bakes in CAT02 +
// source colorspace → ref-illuminant XYZ, so the shader does one matrix multiply.

struct Params {
    width: u32,
    height: u32,
    lut_size: u32,
    _pad: u32,
    // Combined matrix: source-RGB → CAT-adapted XYZ (in ref-illuminant white).
    rgb_to_xyz_adapted: mat3x3<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> rgb_in: array<f32>;        // [H*W*3]
@group(0) @binding(2) var<storage, read> tc_lut: array<f32>;        // [size*size*3]
@group(0) @binding(3) var<storage, read_write> raw_out: array<f32>; // [H*W*3]

// Mitchell-Netravali B=C=1/3 weight (Python `fast_interp_lut._cubic_kernel`).
fn mitchell(t: f32) -> f32 {
    let at = abs(t);
    let b = 1.0 / 3.0;
    let c = 1.0 / 3.0;
    if at < 1.0 {
        let t2 = at * at;
        let t3 = t2 * at;
        return ((12.0 - 9.0 * b - 6.0 * c) * t3
            + (-18.0 + 12.0 * b + 6.0 * c) * t2
            + (6.0 - 2.0 * b)) / 6.0;
    } else if at < 2.0 {
        let t2 = at * at;
        let t3 = t2 * at;
        return ((-b - 6.0 * c) * t3
            + (6.0 * b + 30.0 * c) * t2
            + (-12.0 * b - 48.0 * c) * at
            + (8.0 * b + 24.0 * c)) / 6.0;
    } else {
        return 0.0;
    }
}

// Reflected index for bicubic boundary handling.
fn reflect_index(i: i32, n: i32) -> u32 {
    var idx = i;
    if idx < 0 {
        idx = -idx;
    }
    let period = 2 * (n - 1);
    if period > 0 {
        idx = idx % period;
        if idx >= n {
            idx = period - idx;
        }
    } else {
        idx = 0;
    }
    return u32(clamp(idx, 0, n - 1));
}

fn sample_lut_bicubic(lut_x: f32, lut_y: f32) -> vec3<f32> {
    let size_i = i32(params.lut_size);
    let max_xy = f32(size_i - 1);
    let xf = clamp(lut_x, 0.0, max_xy);
    let yf = clamp(lut_y, 0.0, max_xy);
    var xi = i32(floor(xf));
    var yi = i32(floor(yf));
    if xi >= size_i - 1 { xi = size_i - 2; }
    if yi >= size_i - 1 { yi = size_i - 2; }
    let fx = xf - f32(xi);
    let fy = yf - f32(yi);

    let wx0 = mitchell(fx + 1.0);
    let wx1 = mitchell(fx);
    let wx2 = mitchell(fx - 1.0);
    let wx3 = mitchell(fx - 2.0);
    let wy0 = mitchell(fy + 1.0);
    let wy1 = mitchell(fy);
    let wy2 = mitchell(fy - 1.0);
    let wy3 = mitchell(fy - 2.0);

    var sum = vec3<f32>(0.0, 0.0, 0.0);
    var weight_sum = 0.0;

    for (var dy = 0i; dy < 4i; dy++) {
        let sy = reflect_index(yi + dy - 1i, size_i);
        var wy: f32;
        if dy == 0 { wy = wy0; } else if dy == 1 { wy = wy1; } else if dy == 2 { wy = wy2; } else { wy = wy3; }
        for (var dx = 0i; dx < 4i; dx++) {
            let sx = reflect_index(xi + dx - 1i, size_i);
            var wx: f32;
            if dx == 0 { wx = wx0; } else if dx == 1 { wx = wx1; } else if dx == 2 { wx = wx2; } else { wx = wx3; }
            let w = wx * wy;
            weight_sum += w;
            let lut_base = (sy * u32(size_i) + sx) * 3u;
            sum.x += w * tc_lut[lut_base];
            sum.y += w * tc_lut[lut_base + 1u];
            sum.z += w * tc_lut[lut_base + 2u];
        }
    }
    if weight_sum != 0.0 {
        sum /= weight_sum;
    }
    return sum;
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pixel_idx = gid.x;
    let total_pixels = params.width * params.height;
    if pixel_idx >= total_pixels {
        return;
    }

    let base = pixel_idx * 3u;
    let rgb = vec3<f32>(rgb_in[base], rgb_in[base + 1u], rgb_in[base + 2u]);

    // RGB → CAT-adapted XYZ via the combined matrix (CAT02 + colorspace).
    let xyz = params.rgb_to_xyz_adapted * rgb;
    let b = xyz.x + xyz.y + xyz.z;

    if b <= 1e-10 {
        raw_out[base] = 0.0;
        raw_out[base + 1u] = 0.0;
        raw_out[base + 2u] = 0.0;
        return;
    }

    // xy chromaticity + tc transform (Python _tri2quad). No xy clip
    // (upstream 0.3.4 removed it — the input gamut compression baked into
    // the tc_lut handles OOG chromaticities); the tc clamps below keep the
    // LUT lookup coordinates in-bounds.
    let xc = xyz.x / b;
    let yc = xyz.y / b;
    let omx = max(1.0 - xc, 1e-10);
    let tx = clamp((1.0 - xc) * (1.0 - xc), 0.0, 1.0);
    let ty = clamp(yc / omx, 0.0, 1.0);

    // Swap axes to match Python's lut[x, y] indexing (Python x → our y in storage order).
    let scale = f32(params.lut_size - 1u);
    let lut_x = ty * scale;
    let lut_y = tx * scale;

    let lookup = sample_lut_bicubic(lut_x, lut_y);

    raw_out[base] = lookup.x * b;
    raw_out[base + 1u] = lookup.y * b;
    raw_out[base + 2u] = lookup.z * b;
}
