/// Printing stage: enlarge the film negative onto virtual paper.
///
/// Uses the pre-computed enlarger illuminant and exposure normalization factor.
use rayon::prelude::*;
use spektrafilm_gpu::ComputeBackend;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::pchip3d::{PreparedPchip3d, pchip_interp, prepare_pchip_3d};
use spektrafilm_math::precision::from_f64;

use crate::params::RuntimeParams;
use crate::profile::Profile;

/// Build a `steps × steps² × 3` ImageBuf holding the LUT-input cmy
/// grid. Layout mirrors Python's `_create_lut_3d`:
///
/// ```text
///   reshape(meshgrid(x_r, x_g, x_b, indexing='ij'), (steps², steps, 3))
/// ```
///
/// → pixel at (col=k, row=i*steps+j) carries cmy = (x_r[i], x_g[j], x_b[k]).
/// Running the spectral function on this 2-D image then reshapes back to
/// a `steps × steps × steps × 3` LUT indexed by `((i, j, k), c)`.
fn build_lut_grid(steps: usize, data_min: [f64; 3], data_max: [f64; 3]) -> ImageBuf {
    let mut grid = ImageBuf::new(steps as u32, (steps * steps) as u32);
    let step_inv = (steps - 1) as f64;
    for i in 0..steps {
        let x_r = data_min[0] + (data_max[0] - data_min[0]) * (i as f64) / step_inv;
        for j in 0..steps {
            let x_g = data_min[1] + (data_max[1] - data_min[1]) * (j as f64) / step_inv;
            for k in 0..steps {
                let x_b = data_min[2] + (data_max[2] - data_min[2]) * (k as f64) / step_inv;
                let row = i * steps + j;
                let base = (row * steps + k) * 3;
                grid.data[base] = from_f64(x_r);
                grid.data[base + 1] = from_f64(x_g);
                grid.data[base + 2] = from_f64(x_b);
            }
        }
    }
    grid
}

/// Run `print_spectral` on a `steps³` grid of CMY inputs spanning
/// `[data_min, data_max]` per channel, then PCHIP-interpolate the
/// full image against that LUT. Bit-parity with Python's
/// `_lut_service.spectral_compute_enlarger(use_lut=True)` path.
#[allow(clippy::too_many_arguments)]
fn print_spectral_via_lut(
    cmy_film: &ImageBuf,
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    print_illuminant: &[f64],
    print_sensitivity: &[[f64; 3]],
    exposure_factor: f64,
    preflash: [f64; 3],
    backend: &dyn ComputeBackend,
    data_min: [f64; 3],
    data_max: [f64; 3],
    steps: usize,
) -> ImageBuf {
    let grid = build_lut_grid(steps, data_min, data_max);
    let lut_image = backend.print_spectral(
        &grid,
        channel_density,
        base_density,
        print_illuminant,
        print_sensitivity,
        exposure_factor,
        preflash,
    );
    // Convert Scalar storage to f64 — no-op cast in precision-f64 mode,
    // a widening in f32 mode. The PCHIP slopes are computed in f64
    // regardless to match Python's f64 LUT type.
    let lut_f64: Vec<f64> = lut_image.data.iter().map(|&v| v as f64).collect();
    let prepared = prepare_pchip_3d(lut_f64, steps);
    apply_pchip_lut(cmy_film, &prepared, data_min, data_max)
}

/// Apply a prepared PCHIP LUT to every pixel. Mirrors Python's
/// `compute_with_lut` normalisation (`(x - xmin) / (xmax - xmin)`)
/// followed by `_apply_lut_pchip_3d_prepared` (which multiplies by
/// `size - 1` and interpolates). Rayon-parallel per pixel.
fn apply_pchip_lut(
    image: &ImageBuf,
    prepared: &PreparedPchip3d,
    data_min: [f64; 3],
    data_max: [f64; 3],
) -> ImageBuf {
    let scale = (prepared.size - 1) as f64;
    let inv = [
        scale / (data_max[0] - data_min[0]),
        scale / (data_max[1] - data_min[1]),
        scale / (data_max[2] - data_min[2]),
    ];
    let mut out = image.clone();
    out.data
        .par_chunks_exact_mut(3)
        .zip(image.data.par_chunks_exact(3))
        .for_each(|(dst, src)| {
            let r = (src[0] as f64 - data_min[0]) * inv[0];
            let g = (src[1] as f64 - data_min[1]) * inv[1];
            let b = (src[2] as f64 - data_min[2]) * inv[2];
            let v = pchip_interp(prepared, r, g, b);
            dst[0] = from_f64(v[0]);
            dst[1] = from_f64(v[1]);
            dst[2] = from_f64(v[2]);
        });
    out
}

/// Bounds for the enlarger LUT: `data_min = -grain.density_min` and
/// `data_max = nanmax(film.density_curves, axis=0)` per channel.
/// Mirrors Python `PrintingStage.expose`.
fn enlarger_lut_bounds(film: &Profile, params: &RuntimeParams) -> ([f64; 3], [f64; 3]) {
    let gmin = params.film_render.grain.density_min;
    let data_min = [-gmin[0], -gmin[1], -gmin[2]];
    let mut data_max = [f64::NEG_INFINITY; 3];
    for row in film.density_curves_f64() {
        for c in 0..3 {
            if !row[c].is_nan() && row[c] > data_max[c] {
                data_max[c] = row[c];
            }
        }
    }
    // Guard against an all-NaN column (shouldn't happen with real profiles).
    for c in 0..3 {
        if !data_max[c].is_finite() {
            data_max[c] = 1.0;
        }
        if data_max[c] <= data_min[c] {
            data_max[c] = data_min[c] + 1.0;
        }
    }
    (data_min, data_max)
}

/// Expose with pre-calibrated illuminant and exposure factor.
///
/// Mirrors Python's `printing.expose` *exactly*, including the
/// double-log roundtrip:
///   log_raw_print = log10(max(raw_p * factor_midgray + preflash, 0) + 1e-10)
///   raw           = 10^log_raw_print * print_exposure * bw_correction
///   raw           = apply_diffusion_filter_um(raw, ...)   // no-op when inactive
///   return         log10(max(raw, 0) + 1e-10)
/// The +1e-10 floor is applied at *both* log10s — collapsing them to a
/// single log10 of `max(raw_p * factor_midgray * print_exposure, 0) + 1e-10`
/// looks equivalent but doubles the epsilon contribution (the inner
/// 1e-10 survives the 10^x roundtrip and gets multiplied by
/// print_exposure before the outer 1e-10 is added). The discrepancy
/// is on the order of 1e-8 in log-space and is the seed of the print
/// stage's remaining parity drift.
#[allow(clippy::too_many_arguments)]
pub fn expose_calibrated(
    cmy_film: &ImageBuf,
    film: &Profile,
    print: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
    print_illuminant: &[f64],
    exposure_factor: f64,
    preflash: [f64; 3],
    bw_print_correction: f64,
) -> ImageBuf {
    // Python parity — `channel_density` and `base_density` are f64 in the profile JSON.
    let channel_density: Vec<[f64; 3]> = film
        .data
        .channel_density
        .iter()
        .map(|row| {
            [
                row.get(0).copied().unwrap_or(0.0),
                row.get(1).copied().unwrap_or(0.0),
                row.get(2).copied().unwrap_or(0.0),
            ]
        })
        .collect();
    let base_density: Vec<f64> = film.data.base_density.clone();
    // Python: `sensitivity = np.nan_to_num(10 ** log_sensitivity)` — f64 with NaN→0.
    let print_sensitivity: Vec<[f64; 3]> = print
        .log_sensitivity_f64()
        .iter()
        .map(|row| {
            let mut out = [0.0f64; 3];
            for c in 0..3 {
                let v = 10.0f64.powf(row[c]);
                out[c] = if v.is_nan() { 0.0 } else { v };
            }
            out
        })
        .collect();

    // Stage 1: spectral integration → `log_raw_print` (Python parity).
    // print_spectral applies factor_midgray (exposure_factor) and the
    // inner log10(max(., 0) + 1e-10).
    //
    // If `use_enlarger_lut` is set, evaluate the spectral function on
    // a `lut_resolution³` grid of cmy values (4913 nodes at the
    // default resolution=17) and PCHIP-interpolate per pixel.
    // Matches Python's `_lut_service.spectral_compute_enlarger`.
    let mut log_raw_print = if params.settings.use_enlarger_lut {
        let (data_min, data_max) = enlarger_lut_bounds(film, params);
        print_spectral_via_lut(
            cmy_film,
            &channel_density,
            &base_density,
            print_illuminant,
            &print_sensitivity,
            exposure_factor,
            preflash,
            backend,
            data_min,
            data_max,
            params.settings.lut_resolution as usize,
        )
    } else {
        backend.print_spectral(
            cmy_film,
            &channel_density,
            &base_density,
            print_illuminant,
            &print_sensitivity,
            exposure_factor,
            preflash,
        )
    };

    // Stage 2: 10^log_raw_print, scale by print_exposure × bw, then
    // the outer log10. With print_exposure=1 and bw=1 the operations
    // still matter because of the floor-and-add roundtrip noise.
    //
    // vForce path: bulk `10^x` into a chunk-local f64 buffer, then
    // walk it once to multiply, floor and log10. The scalar
    // `f64::powf` per element was the dominant export bottleneck
    // (~38s of a 60s run on a 20MP image) — Accelerate's vvexp10
    // is what numpy invokes for the same expression, so this path
    // closes the perf gap without changing the math (vForce wraps
    // the same IEEE 754 pow algorithm as libm).
    const BLOCK: usize = 1 << 16;
    let print_exposure = params.enlarger.print_exposure as f64;
    // B&W/print scanner exposure correction — Python applies it as a second
    // in-place multiply after print_exposure, so we keep the two multiplies
    // separate (left-to-right) rather than pre-combining the scalars. 1.0 = no-op.
    let bw = bw_print_correction;

    // Enlarger diffusion filter operates on the *linear* print raw (Python:
    // raw = 10^log_raw_print * print_exposure * bw; raw = diffusion(raw); log10).
    // When active we materialise that linear buffer, diffuse, then log10;
    // otherwise the 10^x → ×exposure → log10 collapse into one pass.
    let edf = &params.enlarger.diffusion_filter;
    if edf.active {
        let mut lin = log_raw_print;
        lin.data.par_chunks_mut(BLOCK).for_each(|chunk| {
            let mut tmp: Vec<f64> = chunk.iter().map(|&v| v as f64).collect();
            spektrafilm_math::vforce::exp10_inplace(&mut tmp);
            for (out, &raw) in chunk.iter_mut().zip(tmp.iter()) {
                *out = spektrafilm_math::precision::from_f64(raw * print_exposure * bw);
            }
        });
        let pix_um = crate::stages::filming::pixel_size_um(
            params.camera.film_format_mm,
            lin.width,
            lin.height,
        );
        let dm = edf.to_model();
        lin = if backend.is_gpu() {
            spektrafilm_model::diffusion::apply_diffusion_filter_blur(
                &lin,
                &dm,
                pix_um as f64,
                backend,
            )
        } else {
            spektrafilm_model::diffusion::apply_diffusion_filter_um(&lin, &dm, pix_um as f64)
        };
        lin.data.par_iter_mut().for_each(|v| {
            let x = *v as f64;
            *v = spektrafilm_math::precision::from_f64((x.max(0.0) + 1e-10).log10());
        });
        return lin;
    }

    log_raw_print.data.par_chunks_mut(BLOCK).for_each(|chunk| {
        let mut tmp: Vec<f64> = chunk.iter().map(|&v| v as f64).collect();
        spektrafilm_math::vforce::exp10_inplace(&mut tmp);
        for (out, &raw) in chunk.iter_mut().zip(tmp.iter()) {
            let v = raw * print_exposure * bw;
            *out = spektrafilm_math::precision::from_f64((v.max(0.0) + 1e-10).log10());
        }
    });
    log_raw_print
}

pub fn develop(
    log_raw_print: &ImageBuf,
    print: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
) -> ImageBuf {
    let log_exposure = print.log_exposure_f64();

    // Mirrors Python `develop_print_morph`: when the profile carries a fitted
    // `density_curves_model`, the print density curves always come from
    // evaluating it (identity evaluation when the morph is inactive, the s023
    // coupled-gamma morph when active), interpolated at gamma 1. Upstream
    // 0.3.4 has no stored-curve print path at all; the fallback below covers
    // model-less custom profiles and evaluation errors.
    let morph = &params.print_render.density_curves_morph;
    if let Some(model) = print.data.density_curves_model.as_ref() {
        match crate::print_morph::morph_density_curves(
            &log_exposure,
            model,
            morph,
            print.is_positive(),
        ) {
            Ok(curves) => {
                return backend.density_curve_interp(log_raw_print, &log_exposure, &curves, 1.0);
            }
            Err(e) => {
                tracing::error!(error = %e, "print-curve model eval failed; using stored curves")
            }
        }
    }

    // Stored-curve fallback (profiles without a fitted model). Python parity
    // note for this path: print's `develop` uses `develop_simple` directly with
    // RAW (un-normalized) density curves — no nanmin subtraction.
    backend.density_curve_interp(
        log_raw_print,
        &log_exposure,
        &print.density_curves_f64(),
        params.print_render.density_curve_gamma as f64,
    )
}

/// Full printing stage with pre-calibrated enlarger.
#[allow(clippy::too_many_arguments)]
pub fn process_with_calibration(
    cmy_film: &ImageBuf,
    film: &Profile,
    print: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
    print_illuminant: &[f64],
    exposure_factor: f64,
    preflash: [f64; 3],
    bw_print_correction: f64,
) -> ImageBuf {
    let log_raw = expose_calibrated(
        cmy_film,
        film,
        print,
        params,
        backend,
        print_illuminant,
        exposure_factor,
        preflash,
        bw_print_correction,
    );
    develop(&log_raw, print, params, backend)
}

/// Full printing stage (simplified — computes illuminant internally).
pub fn process(
    cmy_film: &ImageBuf,
    film: &Profile,
    print: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
) -> ImageBuf {
    let illuminant: Vec<f64> = crate::enlarger::enlarger_filtered_illuminant_f64(
        &params.enlarger.illuminant,
        params.enlarger.c_filter_neutral as f64,
        (params.enlarger.m_filter_neutral + params.enlarger.m_filter_shift) as f64,
        (params.enlarger.y_filter_neutral + params.enlarger.y_filter_shift) as f64,
    );
    // f64 throughout for Python parity.
    let channel_density: Vec<[f64; 3]> = film
        .data
        .channel_density
        .iter()
        .map(|row| {
            [
                row.get(0).copied().unwrap_or(0.0),
                row.get(1).copied().unwrap_or(0.0),
                row.get(2).copied().unwrap_or(0.0),
            ]
        })
        .collect();
    let base_density: Vec<f64> = film.data.base_density.clone();
    let print_sensitivity: Vec<[f64; 3]> = print
        .log_sensitivity_f64()
        .iter()
        .map(|row| {
            let mut out = [0.0f64; 3];
            for c in 0..3 {
                let v = 10.0f64.powf(row[c]);
                out[c] = if v.is_nan() { 0.0 } else { v };
            }
            out
        })
        .collect();
    let n_wl = illuminant
        .len()
        .min(channel_density.len())
        .min(print_sensitivity.len());
    let has_base = !base_density.is_empty() && base_density.len() >= n_wl;

    let midgray_density = compute_midgray_film_density(cmy_film);
    let midgray_raw = compute_single_pixel_raw(
        &midgray_density,
        &channel_density,
        &base_density,
        has_base,
        n_wl,
        &illuminant,
        &print_sensitivity,
    );
    let midgray_geomean = (midgray_raw[0] * midgray_raw[1] * midgray_raw[2])
        .cbrt()
        .max(1e-10);
    let normalization_factor = params.enlarger.print_exposure as f64 / midgray_geomean;

    let log_raw = backend.print_spectral(
        cmy_film,
        &channel_density,
        &base_density,
        &illuminant,
        &print_sensitivity,
        normalization_factor,
        // The simplified path predates calibration and has no preflash plumbing.
        [0.0; 3],
    );
    develop(&log_raw, print, params, backend)
}

fn compute_midgray_film_density(cmy_film: &ImageBuf) -> [f64; 3] {
    let w = cmy_film.width as usize;
    let h = cmy_film.height as usize;
    let max_dim = w.max(h) as f32;
    let sigma = 0.25f32;
    let mut ws = [0.0f64; 3];
    let mut wt = 0.0f64;
    // Spatial weights computed in f32 (matches prior turn's behavior — the f64
    // upgrade applies only to the value-side accumulators, not the geometry).
    for y in 0..h {
        let ny = (y as f32 / h as f32 - 0.5) * (h as f32 / max_dim);
        for x in 0..w {
            let nx = (x as f32 / w as f32 - 0.5) * (w as f32 / max_dim);
            let weight = (-(nx * nx + ny * ny) / (2.0 * sigma * sigma)).exp() as f64;
            let px = cmy_film.get(x as u32, y as u32);
            for c in 0..3 {
                ws[c] += (px[c] as f64) * weight;
            }
            wt += weight;
        }
    }
    [ws[0] / wt, ws[1] / wt, ws[2] / wt]
}

pub(crate) fn compute_single_pixel_raw(
    density_cmy: &[f64; 3],
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    has_base: bool,
    n_wl: usize,
    illuminant: &[f64],
    sensitivity: &[[f64; 3]],
) -> [f64; 3] {
    let mut raw = [0.0f64; 3];
    for wl in 0..n_wl {
        let mut d = density_cmy[0] * channel_density[wl][0]
            + density_cmy[1] * channel_density[wl][1]
            + density_cmy[2] * channel_density[wl][2];
        if has_base && wl < base_density.len() {
            d += base_density[wl];
        }
        let t = 10.0f64.powf(-d) * illuminant[wl];
        let light = if t.is_nan() { 0.0 } else { t };
        for c in 0..3 {
            raw[c] += light * sensitivity[wl][c];
        }
    }
    raw
}
