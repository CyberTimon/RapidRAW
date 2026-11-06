// Scanning stage: density CMY → XYZ → RGB via spectral integration.
// CUDA compute kernel — dispatched per-pixel on NVIDIA GPU.

struct Params {
    unsigned int width;
    unsigned int height;
    unsigned int n_wavelengths;
    float normalization;
    // xyz_to_rgb matrix (row-major)
    float xyz_to_rgb[9];
};

extern "C" __global__ void scan_spectral(
    const float* __restrict__ density_cmy,
    const Params* __restrict__ params,
    const float* __restrict__ channel_density,
    const float* __restrict__ base_density,
    const float* __restrict__ illuminant,
    const float* __restrict__ cmf_x,
    const float* __restrict__ cmf_y,
    const float* __restrict__ cmf_z,
    float* __restrict__ output_rgb
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int total_pixels = params->width * params->height;
    if (gid >= total_pixels) return;

    unsigned int base = gid * 3;
    float cmy_r = density_cmy[base];
    float cmy_g = density_cmy[base + 1];
    float cmy_b = density_cmy[base + 2];

    float xyz_x = 0.0f, xyz_y = 0.0f, xyz_z = 0.0f;

    for (unsigned int wl = 0; wl < params->n_wavelengths; wl++) {
        unsigned int cd_base = wl * 3;
        float d = cmy_r * channel_density[cd_base]
                + cmy_g * channel_density[cd_base + 1]
                + cmy_b * channel_density[cd_base + 2]
                + base_density[wl];

        float light = powf(10.0f, -d) * illuminant[wl];

        xyz_x += light * cmf_x[wl];
        xyz_y += light * cmf_y[wl];
        xyz_z += light * cmf_z[wl];
    }

    float norm = params->normalization;
    xyz_x /= norm;
    xyz_y /= norm;
    xyz_z /= norm;

    // XYZ → RGB matrix multiply (row-major)
    const float* m = params->xyz_to_rgb;
    float r = m[0] * xyz_x + m[1] * xyz_y + m[2] * xyz_z;
    float g = m[3] * xyz_x + m[4] * xyz_y + m[5] * xyz_z;
    float b = m[6] * xyz_x + m[7] * xyz_y + m[8] * xyz_z;

    output_rgb[base]     = fminf(fmaxf(r, 0.0f), 1.0f);
    output_rgb[base + 1] = fminf(fmaxf(g, 0.0f), 1.0f);
    output_rgb[base + 2] = fminf(fmaxf(b, 0.0f), 1.0f);
}
