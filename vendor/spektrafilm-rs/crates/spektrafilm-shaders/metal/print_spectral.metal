// Printing stage: film CMY density → print log-exposure via spectral integration.
// Metal compute shader.

#include <metal_stdlib>
using namespace metal;

struct Params {
    uint width;
    uint height;
    uint n_wavelengths;
    float normalization_factor;
};

kernel void print_spectral(
    device const float* density_cmy     [[buffer(0)]],
    constant Params& params             [[buffer(1)]],
    device const float* channel_density [[buffer(2)]],
    device const float* base_density    [[buffer(3)]],
    device const float* illuminant      [[buffer(4)]],
    device const float* sensitivity     [[buffer(5)]],  // [N_WL*3]
    device float* output                [[buffer(6)]],   // [H*W*3]
    uint gid [[thread_position_in_grid]]
) {
    uint total_pixels = params.width * params.height;
    if (gid >= total_pixels) return;

    uint base = gid * 3;
    float cmy_r = density_cmy[base];
    float cmy_g = density_cmy[base + 1];
    float cmy_b = density_cmy[base + 2];

    float3 raw = float3(0.0);

    for (uint wl = 0; wl < params.n_wavelengths; wl++) {
        uint cd_base = wl * 3;
        float d = cmy_r * channel_density[cd_base]
                + cmy_g * channel_density[cd_base + 1]
                + cmy_b * channel_density[cd_base + 2]
                + base_density[wl];

        float light = pow(10.0f, -d) * illuminant[wl];

        raw.x += light * sensitivity[cd_base];
        raw.y += light * sensitivity[cd_base + 1];
        raw.z += light * sensitivity[cd_base + 2];
    }

    raw *= params.normalization_factor;

    output[base]     = log10(max(raw.x, 1e-10f));
    output[base + 1] = log10(max(raw.y, 1e-10f));
    output[base + 2] = log10(max(raw.z, 1e-10f));
}
