// Poisson-binomial film grain on density CMY.
//
// CPU equivalent: `spektrafilm_model::grain::apply_grain_to_density` →
// `layer_particle_model`. The GPU port uses normal-approximation
// Poisson+Binomial sampling (which the CPU also does whenever λ > 30 or
// variance > 9 — typical for 6 MP renders where n_particles_per_pixel
// is large). Per-pixel deterministic RNG via PCG-hashed seeds; same
// `base_seed` + same image dimensions reproduce the same noise.
//
// Reads `density_cmy` and writes the post-grain density back to the
// same buffer (read_write). Caller is responsible for the optional
// `grain_blur` post-pass.

struct Params {
    n_pixels: u32,
    base_seed: u32,
    n_sub_layers: u32,
    // 1 = B&W monochrome grain: all lanes share the channel-0 RNG stream,
    // producing one noise field (upstream n_channels==1 has a single
    // emulsion). 0 = independent per-channel streams (colour).
    monochrome: u32,
    density_min: vec4<f32>,            // .xyz used
    density_max: vec4<f32>,            // .xyz used (already includes density_min)
    n_particles_per_pixel: vec4<f32>,  // .xyz used (already divided by n_sub_layers)
    grain_uniformity: vec4<f32>,       // .xyz used
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> density_cmy: array<f32>;

// PCG XSH-RR style 32-bit hash. Cheap to evaluate, well-distributed.
fn pcg(state: u32) -> u32 {
    var s: u32 = state * 747796405u + 2891336453u;
    let word: u32 = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (word >> 22u) ^ word;
}

fn unit_f32(x: u32) -> f32 {
    // 1 / 2^32 → maps u32 uniformly into [0, 1).
    return f32(x) * (1.0 / 4294967296.0);
}

// SplitMix64 finalizer truncated to u32. Used to derive a per-pixel,
// per-channel, per-sublayer seed from the user `base_seed`.
fn splitmix32(x: u32) -> u32 {
    var z: u32 = x;
    z = (z ^ (z >> 16u)) * 0x85ebca6bu;
    z = (z ^ (z >> 13u)) * 0xc2b2ae35u;
    return z ^ (z >> 16u);
}

fn next_u32(state: ptr<function, u32>) -> u32 {
    let s = pcg(*state);
    *state = s;
    return s;
}

// Box-Muller standard normal. log(0) guarded with a small epsilon.
fn standard_normal(state: ptr<function, u32>) -> f32 {
    let u1 = unit_f32(next_u32(state));
    let u2 = unit_f32(next_u32(state));
    let r = sqrt(-2.0 * log(max(u1, 1e-7)));
    return r * cos(6.28318530717958647 * u2);
}

@compute @workgroup_size(1024)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if idx >= params.n_pixels { return; }
    let base = idx * 3u;

    let n_sl_f = f32(params.n_sub_layers);
    let n_sl = i32(params.n_sub_layers);

    for (var ch_i: i32 = 0; ch_i < 3; ch_i++) {
        let ch = u32(ch_i);
        let dmin = params.density_min[ch];
        let dmax = params.density_max[ch];
        let npp = params.n_particles_per_pixel[ch];
        let gu = params.grain_uniformity[ch];
        let od_particle = dmax / npp;

        // CPU adds density_min before grain calc, subtracts after.
        let d_in = density_cmy[base + ch] + dmin;
        let p_raw = d_in / dmax;
        let p = clamp(p_raw, 1e-6, 1.0 - 1e-6);
        let saturation = 1.0 - p * gu * (1.0 - 1e-6);
        let lambda = npp / saturation;

        var sum: f32 = 0.0;
        for (var sl: i32 = 0; sl < n_sl; sl++) {
            // Matches the CPU stream split: seed = ch + sl*10, then mix
            // with pixel index. Use SplitMix to decorrelate small ints
            // before xor-combining. Monochrome (B&W) shares channel 0's
            // stream across all lanes.
            var seed_ch = u32(ch_i);
            if params.monochrome != 0u {
                seed_ch = 0u;
            }
            let layer_seed = seed_ch + u32(sl) * 10u + params.base_seed;
            var rng = splitmix32(layer_seed) ^ splitmix32(idx);

            // Poisson(λ) via normal approximation: N(λ, √λ).
            let z1 = standard_normal(&rng);
            let n_seeds = max(0.0, round(lambda + sqrt(lambda) * z1));

            // Binomial(n_seeds, p) via normal approximation: N(np, √(np(1-p))).
            let mean = n_seeds * p;
            let variance = n_seeds * p * (1.0 - p);
            let z2 = standard_normal(&rng);
            var developed: f32 = mean;
            if variance > 0.0 {
                developed = clamp(round(mean + sqrt(variance) * z2), 0.0, n_seeds);
            }
            sum = sum + developed * od_particle * saturation;
        }

        density_cmy[base + ch] = sum / n_sl_f - dmin;
    }
}
