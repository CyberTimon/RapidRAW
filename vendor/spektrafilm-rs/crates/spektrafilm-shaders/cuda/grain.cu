// Grain generation: Poisson-binomial particle model.
// CUDA kernel — each pixel gets its own RNG state via PCG.

struct GrainParams {
    unsigned int width;
    unsigned int height;
    float density_max;
    float n_particles_per_pixel;
    float grain_uniformity;
    float od_particle;
    unsigned long long seed;
    unsigned int _pad;
};

// PCG random number generator (minimal state, GPU-friendly)
__device__ unsigned int pcg32(unsigned long long* state) {
    unsigned long long old = *state;
    *state = old * 6364136223846793005ULL + 1442695040888963407ULL;
    unsigned int xorshifted = (unsigned int)(((old >> 18u) ^ old) >> 27u);
    unsigned int rot = (unsigned int)(old >> 59u);
    return (xorshifted >> rot) | (xorshifted << ((-rot) & 31));
}

__device__ float pcg32_float(unsigned long long* state) {
    return (float)pcg32(state) / 4294967296.0f;
}

// Poisson sampling via Knuth for small lambda, normal approx for large
__device__ unsigned int sample_poisson(unsigned long long* state, float lambda) {
    if (lambda <= 0.0f) return 0;
    if (lambda > 30.0f) {
        // Normal approximation
        float u1 = pcg32_float(state);
        float u2 = pcg32_float(state);
        float z = sqrtf(-2.0f * logf(u1 + 1e-20f)) * cosf(6.2831853f * u2);
        float val = lambda + sqrtf(lambda) * z;
        return (unsigned int)fmaxf(roundf(val), 0.0f);
    }
    // Knuth's algorithm
    float L = expf(-lambda);
    unsigned int k = 0;
    float p = 1.0f;
    do {
        k++;
        p *= pcg32_float(state);
    } while (p > L && k < 1000);
    return k - 1;
}

// Binomial sampling
__device__ unsigned int sample_binomial(unsigned long long* state, unsigned int n, float p) {
    if (n == 0 || p <= 0.0f) return 0;
    if (p >= 1.0f) return n;
    float np = (float)n * p;
    float var = np * (1.0f - p);
    if (var > 9.0f) {
        // Normal approximation
        float u1 = pcg32_float(state);
        float u2 = pcg32_float(state);
        float z = sqrtf(-2.0f * logf(u1 + 1e-20f)) * cosf(6.2831853f * u2);
        float val = np + sqrtf(var) * z;
        return (unsigned int)fminf(fmaxf(roundf(val), 0.0f), (float)n);
    }
    unsigned int count = 0;
    for (unsigned int i = 0; i < n; i++) {
        if (pcg32_float(state) < p) count++;
    }
    return count;
}

extern "C" __global__ void grain_kernel(
    const float* __restrict__ density,
    const GrainParams* __restrict__ params,
    float* __restrict__ grain_out
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int total = params->width * params->height;
    if (gid >= total) return;

    // Initialize per-pixel RNG state
    unsigned long long rng_state = params->seed + (unsigned long long)gid * 12345ULL;
    // Warm up RNG
    pcg32(&rng_state);
    pcg32(&rng_state);

    float d = density[gid];
    float p = fminf(fmaxf(d / params->density_max, 1e-6f), 1.0f - 1e-6f);
    float saturation = 1.0f - p * params->grain_uniformity * (1.0f - 1e-6f);
    unsigned int n_seeds = sample_poisson(&rng_state, params->n_particles_per_pixel / saturation);
    unsigned int developed = sample_binomial(&rng_state, n_seeds, p);
    grain_out[gid] = (float)developed * params->od_particle * saturation;
}
