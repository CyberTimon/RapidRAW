// Scanning stage: density CMY → XYZ via spectral path.
//
// For each pixel:
//   1. Compute spectral density: d = cmy.r * channel_density[wl].r + cmy.g * ... + cmy.b * ...  + base_density[wl]
//   2. Transmittance: light = pow(10, -d) * illuminant[wl]
//   3. XYZ += light * cmf[wl]
//   4. XYZ /= normalization
//   5. RGB = xyz_to_rgb_matrix * XYZ

struct Params {
    width: u32,
    height: u32,
    n_wavelengths: u32,
    normalization: f32,
    xyz_to_rgb: mat3x3<f32>,
    // B&W/slide scanner luminance remap: x=m, y=q, z=enable (0/1).
    // Mirrors ColorReference::xyz_scale — clip(m*Y+q, 0, 1)/(Y+1e-10) on the
    // pre-matrix scan XYZ. Identity (skipped) when z==0.
    // w=skip_clamp (0/1): when 1 the output is NOT clamped to [0,1] —
    // required when output gamut compression follows (it needs the
    // out-of-gamut values; the CPU scan path never clamps here either).
    bw: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> density_cmy: array<f32>;        // [H*W*3]
@group(0) @binding(2) var<storage, read> channel_density: array<f32>;    // [N_WL*3]
@group(0) @binding(3) var<storage, read> base_density: array<f32>;       // [N_WL]
@group(0) @binding(4) var<storage, read> illuminant: array<f32>;         // [N_WL]
@group(0) @binding(5) var<storage, read> cmf_x: array<f32>;             // [N_WL]
@group(0) @binding(6) var<storage, read> cmf_y: array<f32>;             // [N_WL]
@group(0) @binding(7) var<storage, read> cmf_z: array<f32>;             // [N_WL]
@group(0) @binding(8) var<storage, read_write> output_rgb: array<f32>;  // [H*W*3]

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let pixel_idx = gid.x;
    let total_pixels = params.width * params.height;
    if pixel_idx >= total_pixels {
        return;
    }

    let base = pixel_idx * 3u;
    let cmy_r = density_cmy[base];
    let cmy_g = density_cmy[base + 1u];
    let cmy_b = density_cmy[base + 2u];

    var xyz = vec3<f32>(0.0, 0.0, 0.0);

    for (var wl = 0u; wl < params.n_wavelengths; wl++) {
        let cd_base = wl * 3u;
        // Same NaN handling as print_spectral — guard inputs before pow/multiply.
        let cd_r = channel_density[cd_base];
        let cd_g = channel_density[cd_base + 1u];
        let cd_b = channel_density[cd_base + 2u];
        let bd = base_density[wl];
        if cd_r != cd_r || cd_g != cd_g || cd_b != cd_b || bd != bd {
            continue;
        }
        let d = cmy_r * cd_r + cmy_g * cd_g + cmy_b * cd_b + bd;
        let light = pow(10.0, -d) * illuminant[wl];
        xyz.x += light * cmf_x[wl];
        xyz.y += light * cmf_y[wl];
        xyz.z += light * cmf_z[wl];
    }

    xyz /= params.normalization;

    // B&W/slide luminance remap on the pre-matrix XYZ (the combined
    // CAT × xyz_to_rgb matrix is linear, so scaling here == scaling the
    // pre-CAT XYZ as the CPU LUT path does).
    if params.bw.z != 0.0 {
        let y = xyz.y;
        let scale = clamp(params.bw.x * y + params.bw.y, 0.0, 1.0) / (y + 1e-10);
        xyz = xyz * scale;
    }

    // XYZ → RGB via matrix multiply
    let rgb = params.xyz_to_rgb * xyz;

    if params.bw.w != 0.0 {
        output_rgb[base] = rgb.x;
        output_rgb[base + 1u] = rgb.y;
        output_rgb[base + 2u] = rgb.z;
    } else {
        output_rgb[base] = clamp(rgb.x, 0.0, 1.0);
        output_rgb[base + 1u] = clamp(rgb.y, 0.0, 1.0);
        output_rgb[base + 2u] = clamp(rgb.z, 0.0, 1.0);
    }
}
