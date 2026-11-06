// Final resident-chain post-scan pass:
// clamp linear RGB to [0, 1], optionally apply sRGB OETF in place.

struct Params {
    n_pixels: u32,
    output_cctf_encoding: u32,
    _pad: vec2<u32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> rgb: array<f32>;

fn srgb_encode(x_in: f32) -> f32 {
    let x = clamp(x_in, 0.0, 1.0);
    if x <= 0.0031308 {
        return 12.92 * x;
    }
    return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels {
        return;
    }
    let base = idx * 3u;
    if params.output_cctf_encoding != 0u {
        rgb[base] = srgb_encode(rgb[base]);
        rgb[base + 1u] = srgb_encode(rgb[base + 1u]);
        rgb[base + 2u] = srgb_encode(rgb[base + 2u]);
    } else {
        rgb[base] = clamp(rgb[base], 0.0, 1.0);
        rgb[base + 1u] = clamp(rgb[base + 1u], 0.0, 1.0);
        rgb[base + 2u] = clamp(rgb[base + 2u], 0.0, 1.0);
    }
}
