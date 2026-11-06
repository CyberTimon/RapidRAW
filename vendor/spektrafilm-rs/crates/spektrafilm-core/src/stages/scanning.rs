/// Scanning stage: convert print/film density back to RGB.
///
/// Dispatches the spectral integration to the GPU backend when available.
use rayon::prelude::*;
use spektrafilm_gpu::ComputeBackend;
use spektrafilm_math::colorspace;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::pchip3d::{pchip_interp, prepare_pchip_3d};
use spektrafilm_math::precision::{Scalar, from_f64};
use spektrafilm_math::spectral;

use crate::params::RuntimeParams;
use crate::profile::Profile;

/// Build a `steps × steps² × 3` ImageBuf holding the LUT-input cmy grid.
/// Same layout as the enlarger LUT helper in `printing.rs`.
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

/// Scanner LUT bounds. When scan_film=true: `-grain.density_min` to
/// `nanmax(film.density_curves)`. Else: `nanmin..nanmax` of
/// `print.density_curves`. Mirrors Python `ScanningStage._density_to_rgb`.
fn scanner_lut_bounds(profile: &Profile, params: &RuntimeParams) -> ([f64; 3], [f64; 3]) {
    let curves = profile.density_curves_f64();
    let mut dmin_curves = [f64::INFINITY; 3];
    let mut dmax_curves = [f64::NEG_INFINITY; 3];
    for row in &curves {
        for c in 0..3 {
            if !row[c].is_nan() {
                if row[c] < dmin_curves[c] {
                    dmin_curves[c] = row[c];
                }
                if row[c] > dmax_curves[c] {
                    dmax_curves[c] = row[c];
                }
            }
        }
    }
    let (data_min, data_max) = if params.io.scan_film {
        let gmin = params.film_render.grain.density_min;
        ([-gmin[0], -gmin[1], -gmin[2]], dmax_curves)
    } else {
        (dmin_curves, dmax_curves)
    };
    let mut dm = data_min;
    let mut dx = data_max;
    for c in 0..3 {
        if !dm[c].is_finite() {
            dm[c] = 0.0;
        }
        if !dx[c].is_finite() {
            dx[c] = 1.0;
        }
        if dx[c] <= dm[c] {
            dx[c] = dm[c] + 1.0;
        }
    }
    (dm, dx)
}

/// Build a 17³ log_xyz LUT (matching Python's `cmy_to_log_xyz`),
/// PCHIP-interpolate per pixel, then apply `10^log_xyz → CAT →
/// xyz_to_rgb` to get RGB. Glare is added after this returns in RGB
/// space — algebraically equivalent to Python's add_glare-in-XYZ
/// because the matrices are linear (see comment in `scan()` below).
///
/// This LUTs the *same intermediate quantity* Python LUTs
/// (`cmy_to_log_xyz`), not the post-`10^x`/post-matrix RGB output —
/// keeps the PCHIP interpolating the smoother log10-domain surface
/// for bit-identical parity with Python's LUT path.
#[allow(clippy::too_many_arguments)]
fn scan_spectral_via_lut(
    density_cmy: &ImageBuf,
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    illuminant: &[f64],
    normalization: f64,
    cat: &[[f64; 3]; 3],
    xyz_to_rgb: &[[f64; 3]; 3],
    _backend: &dyn ComputeBackend,
    data_min: [f64; 3],
    data_max: [f64; 3],
    steps: usize,
    color_ref: &crate::color_reference::ColorReference,
) -> ImageBuf {
    let grid = build_lut_grid(steps, data_min, data_max);
    // log_xyz LUT — same function Python LUTs.
    let lut_log_xyz = spektrafilm_gpu::cpu_backend::scan_log_xyz_cpu(
        &grid,
        channel_density,
        base_density,
        illuminant,
        normalization,
    );
    let prepared = prepare_pchip_3d(lut_log_xyz, steps);
    let scale = (steps - 1) as f64;
    let inv = [
        scale / (data_max[0] - data_min[0]),
        scale / (data_max[1] - data_min[1]),
        scale / (data_max[2] - data_min[2]),
    ];
    let mut out = density_cmy.clone();
    out.data
        .par_chunks_exact_mut(3)
        .zip(density_cmy.data.par_chunks_exact(3))
        .for_each(|(dst, src)| {
            let r = (src[0] as f64 - data_min[0]) * inv[0];
            let g = (src[1] as f64 - data_min[1]) * inv[1];
            let b = (src[2] as f64 - data_min[2]) * inv[2];
            let log_xyz = pchip_interp(&prepared, r, g, b);
            // Post-LUT: 10^log_xyz → CAT → xyz_to_rgb, mirroring Python's
            // `_density_to_rgb` AFTER the LUT call. bw_correction and
            // glare run after this returns (RGB space).
            let mut xyz = [
                10.0f64.powf(log_xyz[0]),
                10.0f64.powf(log_xyz[1]),
                10.0f64.powf(log_xyz[2]),
            ];
            // B&W/slide luminance remap on the pre-CAT scan XYZ (Python's
            // black_white_xyz_correction). Scalar scale from the Y channel;
            // no-op when color_ref has no remap.
            let scale = color_ref.xyz_scale(xyz[1]);
            if scale != 1.0 {
                xyz[0] *= scale;
                xyz[1] *= scale;
                xyz[2] *= scale;
            }
            let xa = cat[0][0] * xyz[0] + cat[0][1] * xyz[1] + cat[0][2] * xyz[2];
            let ya = cat[1][0] * xyz[0] + cat[1][1] * xyz[1] + cat[1][2] * xyz[2];
            let za = cat[2][0] * xyz[0] + cat[2][1] * xyz[1] + cat[2][2] * xyz[2];
            dst[0] =
                from_f64(xyz_to_rgb[0][0] * xa + xyz_to_rgb[0][1] * ya + xyz_to_rgb[0][2] * za);
            dst[1] =
                from_f64(xyz_to_rgb[1][0] * xa + xyz_to_rgb[1][1] * ya + xyz_to_rgb[1][2] * za);
            dst[2] =
                from_f64(xyz_to_rgb[2][0] * xa + xyz_to_rgb[2][1] * ya + xyz_to_rgb[2][2] * za);
        });
    out
}

pub fn scan(
    density_cmy: &ImageBuf,
    profile: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
    color_ref: &crate::color_reference::ColorReference,
    gamut: &crate::gamut_compression::OutputGamutCompress,
) -> ImageBuf {
    // Python parity — channel_density / base_density are f64 in the JSON profile.
    let channel_density: Vec<[f64; 3]> = profile
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
    let base_density: Vec<f64> = profile.data.base_density.clone();

    let illuminant_f32 = select_illuminant(&profile.info.viewing_illuminant);
    // Use the full-precision f64 illuminant — the f32 → f64 promotion of
    // the f32 constants drops ~7 digits per sample and accumulates ~5e-6
    // of drift in the scan stage after the 81-wavelength reduction.
    let illuminant: Vec<f64> = select_illuminant_f64(&profile.info.viewing_illuminant).to_vec();
    let n_wl = illuminant
        .len()
        .min(channel_density.len())
        .min(spectral::N_WAVELENGTHS);

    // Compute normalization in f64 — Python parity (81-element sum).
    // Use f64 CMF_Y for the same precision reason.
    let normalization: f64 = (0..n_wl)
        .map(|i| illuminant[i] * spectral::CMF_Y_F64[i])
        .sum();
    // Build XYZ→RGB matrix with chromatic adaptation from viewing illuminant to output colorspace white.
    // Python's `colour.XYZ_to_RGB` applies CAT and the XYZ→RGB matrix as
    // TWO sequential matrix multiplies per pixel; pre-combining them
    // into one (M_rgb @ M_cat) loses ~1 ULP per output channel and
    // accumulates to ~5e-6 scan-stage drift. We keep them split for
    // CPU bit-parity; the GPU path can collapse them for performance.
    //
    // Compute viewing_white at runtime (matches Python's
    // `XYZ_to_xy(integrate(illu, CMFs)/norm) → xy_to_xyZ`). The
    // pre-computed `illuminant_xyz_f64` constant is 3 ULPs off the
    // runtime value because Python's `contract(...)/norm` rounds Y
    // slightly off 1.0, which xy_to_xyY then corrects — replaying that
    // chain is bit-exact.
    let mut illu_xyz_runtime = [0.0f64; 3];
    let illu_y_sum: f64 = (0..n_wl)
        .map(|i| illuminant[i] * spectral::CMF_Y_F64[i])
        .sum();
    for i in 0..n_wl {
        illu_xyz_runtime[0] += illuminant[i] * spectral::CMF_X_F64[i];
        illu_xyz_runtime[1] += illuminant[i] * spectral::CMF_Y_F64[i];
        illu_xyz_runtime[2] += illuminant[i] * spectral::CMF_Z_F64[i];
    }
    let _ = illu_y_sum;
    for c in 0..3 {
        illu_xyz_runtime[c] /= normalization;
    }
    // XYZ_to_xy then xy_to_xyz roundtrip (renormalizes Y to exactly 1).
    let sum_xyz = illu_xyz_runtime[0] + illu_xyz_runtime[1] + illu_xyz_runtime[2];
    let vx = illu_xyz_runtime[0] / sum_xyz;
    let vy = illu_xyz_runtime[1] / sum_xyz;
    let viewing_white = [vx / vy, 1.0f64, (1.0 - vx - vy) / vy];
    let output_white = spectral::colorspace_white_xyz_f64(&params.io.output_color_space);
    let adapt = colorspace::chromatic_adaptation_matrix_f64(viewing_white, output_white);
    let base_xyz_to_rgb = output_colorspace_from_xyz_f64(&params.io.output_color_space);

    // Dispatch spectral integration to backend (GPU or CPU). The backend
    // applies the two matrices in sequence — we pass them separately.
    //
    // `use_scanner_lut` path: evaluate `scan_spectral` on a 17³ CMY
    // grid and PCHIP-interpolate per pixel. Glare is added in RGB
    // space after this returns (the existing post-step at the bottom
    // of this function), so swapping to the LUT path is glare-safe.
    // The faithful B&W/slide luminance remap (color_ref.has_remap) applies
    // per-pixel on the scan XYZ inside scan_spectral_via_lut — so route
    // through the LUT path when it's active (the LUT result matches the
    // direct spectral path to sub-LSB, and only this path exposes the
    // pre-CAT XYZ hook). Otherwise honour use_scanner_lut.
    let mut rgb = if color_ref.has_remap() || params.settings.use_scanner_lut {
        let (data_min, data_max) = scanner_lut_bounds(profile, params);
        scan_spectral_via_lut(
            density_cmy,
            &channel_density,
            &base_density,
            &illuminant,
            normalization,
            &adapt,
            &base_xyz_to_rgb,
            backend,
            data_min,
            data_max,
            params.settings.lut_resolution as usize,
            color_ref,
        )
    } else {
        backend.scan_spectral(
            density_cmy,
            &channel_density,
            &base_density,
            &illuminant,
            normalization,
            &adapt,
            &base_xyz_to_rgb,
        )
    };

    // White/black correction is fully handled by color_ref's XYZ luminance
    // remap (applied inside the scan paths above). For the combos where no
    // remap is built we apply nothing: scan_film+negative because upstream
    // Python explicitly skips it (`black_white_xyz_correction`: "do not
    // correct negative film scans"), and a positive print paper because
    // upstream crashes there (its printing exposure correction returns None)
    // — unsupported, and unrepresentable with the shipped profiles anyway.

    // Viewing glare (Python: `add_glare(xyz, illuminant_xyz, glare)` between scan_spectral
    // and chromatic adapt + matrix). Since CAT+matrix is linear, we equivalently add
    // glare in RGB space by pre-multiplying the illuminant XYZ through the same matrix.
    //   Python: rgb = M @ (xyz + g*illu) = M@xyz + g*(M@illu)
    //   Rust:   rgb = M @ xyz; then rgb += g * (M@illu)
    let glare = if params.io.scan_film {
        &params.film_render.glare
    } else {
        &params.print_render.glare
    };
    if glare.active && glare.percent > 0.0 {
        // Illuminant XYZ (Y=1) from the SPD (matches Python `contract('k,kl->l', illu, CMFs)/norm`).
        // Use the unnormalized integration here — the scaling cancels because we apply M next.
        let mut illu_xyz = [0.0f64; 3];
        for i in 0..n_wl {
            illu_xyz[0] += illuminant[i] * spectral::CMF_X[i] as f64;
            illu_xyz[1] += illuminant[i] * spectral::CMF_Y[i] as f64;
            illu_xyz[2] += illuminant[i] * spectral::CMF_Z[i] as f64;
        }
        for c in 0..3 {
            illu_xyz[c] /= normalization;
        }
        // Two-step: M_base @ M_cat @ illu_xyz — same order as the
        // per-pixel scan path so the glare offset stays consistent.
        let xyz_adapt = [
            adapt[0][0] * illu_xyz[0] + adapt[0][1] * illu_xyz[1] + adapt[0][2] * illu_xyz[2],
            adapt[1][0] * illu_xyz[0] + adapt[1][1] * illu_xyz[1] + adapt[1][2] * illu_xyz[2],
            adapt[2][0] * illu_xyz[0] + adapt[2][1] * illu_xyz[1] + adapt[2][2] * illu_xyz[2],
        ];
        let glare_rgb_offset: [Scalar; 3] = [
            from_f64(
                base_xyz_to_rgb[0][0] * xyz_adapt[0]
                    + base_xyz_to_rgb[0][1] * xyz_adapt[1]
                    + base_xyz_to_rgb[0][2] * xyz_adapt[2],
            ),
            from_f64(
                base_xyz_to_rgb[1][0] * xyz_adapt[0]
                    + base_xyz_to_rgb[1][1] * xyz_adapt[1]
                    + base_xyz_to_rgb[1][2] * xyz_adapt[2],
            ),
            from_f64(
                base_xyz_to_rgb[2][0] * xyz_adapt[0]
                    + base_xyz_to_rgb[2][1] * xyz_adapt[1]
                    + base_xyz_to_rgb[2][2] * xyz_adapt[2],
            ),
        ];
        let glare_amount = spektrafilm_model::glare::compute_random_glare_amount(
            rgb.width,
            rgb.height,
            glare.percent,
            glare.roughness,
            glare.blur,
            42, // fixed seed for reproducible parity tests; Python uses np.random which differs
        );
        spektrafilm_model::glare::add_glare_with_amount(&mut rgb, &glare_amount, glare_rgb_offset);
    }

    // Output gamut compression — mirrors Python's `compress_rgb` after
    // XYZ→RGB and glare, before blur/unsharp. No-op when inactive.
    if gamut.is_active() {
        rgb.data.par_chunks_exact_mut(3).for_each(|px| {
            let out = gamut.compress([px[0] as f64, px[1] as f64, px[2] as f64]);
            px[0] = from_f64(out[0]);
            px[1] = from_f64(out[1]);
            px[2] = from_f64(out[2]);
        });
    }

    // Lens blur
    if params.scanner.lens_blur > 0.0 {
        rgb = backend.gaussian_blur(&rgb, params.scanner.lens_blur);
    }

    // Unsharp mask
    let [usm_sigma, usm_amount] = params.scanner.unsharp_mask;
    if usm_sigma > 0.0 && usm_amount > 0.0 {
        rgb =
            spektrafilm_model::diffusion::apply_unsharp_mask(&rgb, usm_sigma, usm_amount, backend);
    }

    // CCTF encoding + clip.
    //
    // Python's `_apply_cctf_encoding_and_clip` calls
    // `colour.RGB_to_RGB(rgb, output_cs, output_cs, apply_cctf_encoding=True)`,
    // which — even when src == dst — runs `vecmul(M, rgb)` with
    // `M = matrix_RGB_to_RGB(src, dst, 'CAT02')`. With same src/dst
    // M should be identity but in f64 it has off-diagonals around 1e-5
    // (because colour-science's sRGB matrix is 4-decimal-rounded so the
    // inverse round-trip isn't exact). This nudges every RGB pixel by
    // ~1e-5 before encoding. We replicate it so the scan-stage output
    // matches Python bit-for-bit.
    let zero = from_f64(0.0);
    let one = from_f64(1.0);
    if params.io.output_cctf_encoding {
        let m = rgb_to_rgb_identity_matrix(&params.io.output_color_space);
        rgb.data.par_chunks_exact_mut(3).for_each(|px| {
            let r = px[0] as f64;
            let g = px[1] as f64;
            let b = px[2] as f64;
            let r2 = m[0][0] * r + m[0][1] * g + m[0][2] * b;
            let g2 = m[1][0] * r + m[1][1] * g + m[1][2] * b;
            let b2 = m[2][0] * r + m[2][1] * g + m[2][2] * b;
            px[0] = spektrafilm_math::precision::srgb_encode(from_f64(r2).clamp(zero, one));
            px[1] = spektrafilm_math::precision::srgb_encode(from_f64(g2).clamp(zero, one));
            px[2] = spektrafilm_math::precision::srgb_encode(from_f64(b2).clamp(zero, one));
        });
    } else {
        rgb.data
            .par_iter_mut()
            .for_each(|v| *v = (*v).clamp(zero, one));
    }

    rgb
}

/// Replicate Python `colour.matrix_RGB_to_RGB(cs, cs, 'CAT02')` —
/// returns the redundant near-identity matrix that colour-science
/// computes when src == dst. The result is `M_xyz_to_rgb @ M_rgb_to_xyz`
/// (CAT02 collapses to identity when src/dst whites match), but the
/// product of 4-decimal-rounded sRGB matrices isn't exactly the
/// identity in f64.
fn rgb_to_rgb_identity_matrix(name: &str) -> [[f64; 3]; 3] {
    let xyz_to_rgb = output_colorspace_from_xyz_f64(name);
    let rgb_to_xyz = match name {
        "sRGB" => colorspace::SRGB_TO_XYZ_F64,
        "ProPhoto RGB" => colorspace::PROPHOTO_TO_XYZ_F64,
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::REC2020_TO_XYZ_F64,
        "ACES2065-1" => colorspace::ACES_TO_XYZ_F64,
        _ => colorspace::SRGB_TO_XYZ_F64,
    };
    let mut m = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = xyz_to_rgb[i][0] * rgb_to_xyz[0][j]
                + xyz_to_rgb[i][1] * rgb_to_xyz[1][j]
                + xyz_to_rgb[i][2] * rgb_to_xyz[2][j];
        }
    }
    m
}

pub fn process(
    density_cmy: &ImageBuf,
    profile: &Profile,
    params: &RuntimeParams,
    backend: &dyn ComputeBackend,
    color_ref: &crate::color_reference::ColorReference,
    gamut: &crate::gamut_compression::OutputGamutCompress,
) -> ImageBuf {
    scan(density_cmy, profile, params, backend, color_ref, gamut)
}

fn select_illuminant(name: &str) -> &'static [f32] {
    match name {
        "D50" => &spectral::ILLUMINANT_D50,
        "D55" => &spectral::ILLUMINANT_D55,
        "D65" => &spectral::ILLUMINANT_D65,
        _ => &spectral::ILLUMINANT_D50,
    }
}

pub fn select_illuminant_f64(name: &str) -> &'static [f64] {
    match name {
        "D50" => &spectral::ILLUMINANT_D50_F64,
        "D55" => &spectral::ILLUMINANT_D55_F64,
        "D65" => &spectral::ILLUMINANT_D65_F64,
        _ => &spectral::ILLUMINANT_D50_F64,
    }
}

fn output_colorspace_from_xyz_f64(name: &str) -> [[f64; 3]; 3] {
    match name {
        "sRGB" => colorspace::XYZ_TO_SRGB_F64,
        "ProPhoto RGB" => colorspace::XYZ_TO_PROPHOTO_F64,
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::XYZ_TO_REC2020_F64,
        "ACES2065-1" => colorspace::XYZ_TO_ACES_F64,
        _ => colorspace::XYZ_TO_SRGB_F64,
    }
}
