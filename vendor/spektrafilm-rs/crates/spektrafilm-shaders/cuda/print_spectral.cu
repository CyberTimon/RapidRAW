// Printing stage: film CMY density → print log-exposure via spectral integration.
// CUDA compute kernel.

struct Params {
    unsigned int width;
    unsigned int height;
    unsigned int n_wavelengths;
    float normalization_factor;
};

extern "C" __global__ void print_spectral(
    const float* __restrict__ density_cmy,
    const Params* __restrict__ params,
    const float* __restrict__ channel_density,
    const float* __restrict__ base_density,
    const float* __restrict__ illuminant,
    const float* __restrict__ sensitivity,
    float* __restrict__ output
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int total_pixels = params->width * params->height;
    if (gid >= total_pixels) return;

    unsigned int base = gid * 3;
    float cmy_r = density_cmy[base];
    float cmy_g = density_cmy[base + 1];
    float cmy_b = density_cmy[base + 2];

    float raw_r = 0.0f, raw_g = 0.0f, raw_b = 0.0f;

    for (unsigned int wl = 0; wl < params->n_wavelengths; wl++) {
        unsigned int cd_base = wl * 3;
        float d = cmy_r * channel_density[cd_base]
                + cmy_g * channel_density[cd_base + 1]
                + cmy_b * channel_density[cd_base + 2]
                + base_density[wl];

        float light = powf(10.0f, -d) * illuminant[wl];

        raw_r += light * sensitivity[cd_base];
        raw_g += light * sensitivity[cd_base + 1];
        raw_b += light * sensitivity[cd_base + 2];
    }

    float nf = params->normalization_factor;
    raw_r *= nf;
    raw_g *= nf;
    raw_b *= nf;

    output[base]     = log10f(fmaxf(raw_r, 1e-10f));
    output[base + 1] = log10f(fmaxf(raw_g, 1e-10f));
    output[base + 2] = log10f(fmaxf(raw_b, 1e-10f));
}
