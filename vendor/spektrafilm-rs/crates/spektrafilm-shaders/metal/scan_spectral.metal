// Scanning stage: density CMY → XYZ → RGB via spectral integration.
// Metal compute shader — dispatched per-pixel on Apple GPU.

#include <metal_stdlib>
using namespace metal;

struct Params {
    uint width;
    uint height;
    uint n_wavelengths;
    float normalization;
    float3x3 xyz_to_rgb;
};

kernel void scan_spectral(
    device const float* density_cmy     [[buffer(0)]],
    constant Params& params             [[buffer(1)]],
    device const float* channel_density [[buffer(2)]],  // [N_WL*3]
    device const float* base_density    [[buffer(3)]],  // [N_WL]
    device const float* illuminant      [[buffer(4)]],  // [N_WL]
    device const float* cmf_x           [[buffer(5)]],  // [N_WL]
    device const float* cmf_y           [[buffer(6)]],  // [N_WL]
    device const float* cmf_z           [[buffer(7)]],  // [N_WL]
    device float* output_rgb            [[buffer(8)]],  // [H*W*3]
    uint gid [[thread_position_in_grid]]
) {
    uint total_pixels = params.width * params.height;
    if (gid >= total_pixels) return;

    uint base = gid * 3;
    float cmy_r = density_cmy[base];
    float cmy_g = density_cmy[base + 1];
    float cmy_b = density_cmy[base + 2];

    float3 xyz = float3(0.0);

    for (uint wl = 0; wl < params.n_wavelengths; wl++) {
        uint cd_base = wl * 3;
        float d = cmy_r * channel_density[cd_base]
                + cmy_g * channel_density[cd_base + 1]
                + cmy_b * channel_density[cd_base + 2]
                + base_density[wl];

        float light = pow(10.0f, -d) * illuminant[wl];

        xyz.x += light * cmf_x[wl];
        xyz.y += light * cmf_y[wl];
        xyz.z += light * cmf_z[wl];
    }

    xyz /= params.normalization;

    float3 rgb = params.xyz_to_rgb * xyz;

    output_rgb[base]     = clamp(rgb.x, 0.0f, 1.0f);
    output_rgb[base + 1] = clamp(rgb.y, 0.0f, 1.0f);
    output_rgb[base + 2] = clamp(rgb.z, 0.0f, 1.0f);
}
