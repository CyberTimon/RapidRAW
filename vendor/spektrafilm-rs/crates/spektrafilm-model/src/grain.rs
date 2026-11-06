// Stochastic grain generation.
// Poisson-binomial particle model with dye cloud blur and lognormal micro-structure.

use spektrafilm_gpu::ComputeBackend;
use spektrafilm_math::gaussian;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::{Scalar, ZERO, from_f64};
use rayon::prelude::*;
use std::time::Instant;

fn stage_timings_enabled() -> bool {
    std::env::var_os("SPEKTRAFILM_STAGE_TIMINGS").is_some()
}

fn print_stage_timing(enabled: bool, stage: &str, start: Instant) {
    if enabled {
        eprintln!("stage {stage}: {} ms", start.elapsed().as_millis());
    }
}

/// Apply the Poisson-binomial grain particle model to a single-channel density image.
///
/// Port of Python `layer_particle_model`. Density values flow through in `Scalar`
/// (full f64 precision in `precision-f64` mode); RNG sampling uses f64 directly.
pub fn layer_particle_model(
    density: &[Scalar],
    width: u32,
    height: u32,
    density_max: f64,
    n_particles_per_pixel: f64,
    grain_uniformity: f64,
    seed: u64,
    blur_particle: f32,
) -> Vec<Scalar> {
    // Inputs are f64 to match Python's `layer_particle_model` —
    // density_max/uniformity/agx-area come from JSON profiles at full
    // f64 precision in Python. Passing them as f32 in Rust truncated
    // ~7-decimal noise into `od_particle` and `saturation` which then
    // shifted every Poisson lambda by ~5e-8, producing a different
    // RNG stream and thus visibly different grain patterns.
    let dmax = density_max;
    let od_particle = dmax / n_particles_per_pixel;
    let gu = grain_uniformity;
    let npp = n_particles_per_pixel;

    // Python-bit-exact RNG: numpy's MT19937 + RandomState distribution
    // algorithms (`rk_poisson` / `rk_binomial`). Numpy's seed-to-stream
    // takes a `u32`, so truncate the 64-bit seed — for the CPU export
    // path we never need more than 24 distinct streams (3 channels × N
    // sub-layers). Iteration is single-threaded so the RNG state advances
    // in row-major order exactly like `numpy.random.RandomState(seed)
    // .poisson(lambda_array)` does internally.
    //
    // CRITICAL — match Python's call order: it does
    //   seeds = np.random.poisson(lam_array)   # whole array, then
    //   grain = np.random.binomial(seeds, p)   # whole array.
    // So the RNG must draw ALL Poisson samples first, THEN ALL Binomial
    // samples. Interleaving Poisson/Binomial per pixel (what we used to
    // do) gives a different RNG state at each draw and produces a
    // completely different grain pattern.
    let n = density.len();
    let mut rng = rand_mt::Mt::new(seed as u32);
    let mut p_arr = Vec::with_capacity(n);
    let mut sat_arr = Vec::with_capacity(n);
    for &d in density.iter() {
        let p = ((d as f64) / dmax).clamp(1e-6, 1.0 - 1e-6);
        let saturation = 1.0 - p * gu * (1.0 - 1e-6);
        p_arr.push(p);
        sat_arr.push(saturation);
    }
    let mut seeds = Vec::with_capacity(n);
    for sat in &sat_arr {
        seeds.push(spektrafilm_math::numpy_rng::rk_poisson(&mut rng, npp / sat));
    }
    let mut grain = vec![ZERO; n];
    for (i, slot) in grain.iter_mut().enumerate() {
        let developed = spektrafilm_math::numpy_rng::rk_binomial(&mut rng, seeds[i], p_arr[i]);
        *slot = from_f64((developed as f64) * od_particle * sat_arr[i]);
    }

    if blur_particle > 0.4 {
        // Match Python: `sigma = blur_particle * np.sqrt(od_particle)`
        // — keep the multiplication in f64 and narrow at the end.
        let sigma = (blur_particle as f64 * od_particle.sqrt()) as f32;
        if sigma > 0.1 {
            let mut img = ImageBuf::from_data(
                width,
                height,
                grain.iter().flat_map(|&v| [v, v, v]).collect(),
            );
            img = gaussian::gaussian_blur(&img, sigma);
            grain = img.extract_channel(0);
        }
    }

    grain
}

/// Apply grain to a CMY density image.
///
/// Port of Python `apply_grain_to_density`.
#[allow(clippy::too_many_arguments)]
pub fn apply_grain_to_density(
    density_cmy: &ImageBuf,
    pixel_size_um: f32,
    agx_particle_area_um2: f64,
    agx_particle_scale: [f64; 3],
    density_min: [f64; 3],
    density_max_curves: [f64; 3],
    grain_uniformity: [f64; 3],
    grain_blur: f32,
    n_sub_layers: u32,
    monochrome: bool,
    backend: &dyn ComputeBackend,
) -> ImageBuf {
    let stage_timings = stage_timings_enabled();
    let w = density_cmy.width;
    let h = density_cmy.height;
    let pixel_area = (pixel_size_um as f64) * (pixel_size_um as f64);
    let density_max: [f64; 3] = [
        density_max_curves[0] + density_min[0],
        density_max_curves[1] + density_min[1],
        density_max_curves[2] + density_min[2],
    ];

    let channels: Vec<(usize, Vec<Scalar>)> = (0..3)
        .into_par_iter()
        .map(|ch| {
            let t_ch = Instant::now();
            let particle_area = agx_particle_area_um2 * agx_particle_scale[ch];
            let mut n_particles = pixel_area / particle_area;
            if n_sub_layers > 1 {
                n_particles /= n_sub_layers as f64;
            }

            // Add density_min to input (kept in Scalar precision)
            let dmin_s = from_f64(density_min[ch]);
            let t = Instant::now();
            let density_ch: Vec<Scalar> =
                density_cmy.pixels().map(|px| px[ch] + dmin_s).collect();
            print_stage_timing(stage_timings, "grain.extract_channel", t);

            let mut grain_sum = vec![ZERO; density_ch.len()];

            for sl in 0..n_sub_layers {
                let t = Instant::now();
                // Monochrome (B&W): one shared noise field — every lane draws
                // from channel 0's RNG stream (upstream n_channels==1 has a
                // single emulsion, seed ch=0).
                let seed_ch = if monochrome { 0 } else { ch as u64 };
                let seed = seed_ch + (sl as u64) * 10;
                let g = layer_particle_model(
                    &density_ch,
                    w,
                    h,
                    density_max[ch],
                    n_particles,
                    grain_uniformity[ch],
                    seed,
                    0.0,
                );
                print_stage_timing(stage_timings, "grain.layer_particle_model", t);
                for (s, &v) in grain_sum.iter_mut().zip(g.iter()) {
                    *s += v;
                }
            }

            // Average sub-layers
            let scale = from_f64(1.0 / n_sub_layers as f64);
            for v in &mut grain_sum {
                *v = *v * scale - dmin_s;
            }

            print_stage_timing(stage_timings, "grain.channel_total", t_ch);
            (ch, grain_sum)
        })
        .collect();

    let mut out = ImageBuf::new(w, h);
    for (ch, grain_sum) in channels {
        out.write_channel(ch, &grain_sum);
    }

    // Final blur — typically a few px sigma at 1–6 MP, big enough that the
    // GPU separable kernel wins.
    if grain_blur > 0.4 {
        let t = Instant::now();
        out = backend.gaussian_blur(&out, grain_blur);
        print_stage_timing(stage_timings, "grain.final_blur", t);
    }

    out
}
