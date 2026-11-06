//! Black & white / slide-film scanner exposure correction.
//!
//! Port of Python `runtime/services/color_reference.py`. Gated behind
//! `scanner.white_correction` / `black_correction` (a complete no-op
//! otherwise). The correction remaps scan luminance through a linear
//! `clip(m·Y + q, 0, 1)` built from the white/black target levels and
//! reference luminances (`y_white`/`y_black`) computed off the film/print
//! at zero / maximum dye density, and — for slide film scanned directly —
//! shifts the filming exposure so the corrected midgray lands right.
//!
//! Two faithful paths are covered:
//!
//! * **scan_film + positive (slide)** — filming exposure correction +
//!   the scan-XYZ luminance remap, with `y_white`/`y_black` taken off the
//!   film at zero / maximum dye density.
//! * **print (not scan_film, negative paper)** — the print *raw* exposure
//!   correction + the scan-XYZ luminance remap, with `y_white`/`y_black`
//!   taken off the film's black/white reference exposures pushed through the
//!   enlarger (print-spectral) and developed on the paper. Mirrors Python's
//!   `black_white_printing_exposure_correction` + the print branch of
//!   `_update_cmy_black_white_references`.
//!
//! Both build the same `clip(m·Y + q, 0, 1)` remap (`_correction_fucntion`).
//! Combos neither path covers get no correction: scan_film+negative because
//! Python explicitly skips it (`black_white_xyz_correction`: "do not correct
//! negative film scans"), and a positive print paper because Python crashes
//! there (unsupported upstream; all shipped papers are negative anyway).

use spektrafilm_gpu::cpu_backend::scan_log_xyz_cpu;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::interp::fast_interp_image_f64;
use spektrafilm_math::precision::from_f64;
use spektrafilm_math::spectral::{self, CMF_Y_F64};

use crate::params::RuntimeParams;
use crate::profile::Profile;
use crate::stages::printing::compute_single_pixel_raw;
use crate::stages::scanning::select_illuminant_f64;

/// Pre-computed scanner exposure correction for the active stocks/params.
#[derive(Clone, Copy, Debug)]
pub struct ColorReference {
    /// Linear luminance remap `(m, q)` applied to scan XYZ as
    /// `clip(m·Y + q, 0, 1)`. Built by both the slide and print paths;
    /// `None` when no correction is active.
    xyz_remap: Option<(f64, f64)>,
    /// Multiplicative exposure correction applied to the filming raw
    /// (scan_film + positive film). `1.0` otherwise.
    pub filming_exposure_correction: f64,
    /// Multiplicative exposure correction applied to the print raw
    /// (print path). `1.0` otherwise.
    pub printing_exposure_correction: f64,
}

impl ColorReference {
    /// No-op correction (identity).
    pub fn identity() -> Self {
        Self {
            xyz_remap: None,
            filming_exposure_correction: 1.0,
            printing_exposure_correction: 1.0,
        }
    }

    /// Whether the scan-XYZ luminance remap is active (either the slide or
    /// print path). When false, scanning applies no white/black correction.
    pub fn has_remap(&self) -> bool {
        self.xyz_remap.is_some()
    }

    /// The scan-XYZ luminance remap `(m, q)`, for the GPU-resident chain to
    /// apply per-pixel (`clip(m·Y+q, 0, 1)/(Y+1e-10)`). `None` is identity.
    pub fn xyz_remap(&self) -> Option<(f64, f64)> {
        self.xyz_remap
    }

    /// Per-pixel multiplicative scale for scan XYZ given its luminance `y`.
    /// `1.0` when no remap is active. Scaling XYZ by this ratio is the
    /// energy-preserving luminance remap Python applies before the
    /// XYZ→RGB matrix.
    #[inline]
    pub fn xyz_scale(&self, y: f64) -> f64 {
        match self.xyz_remap {
            Some((m, q)) => (m * y + q).clamp(0.0, 1.0) / (y + 1e-10),
            None => 1.0,
        }
    }

    /// Build the correction for the current stocks + params. Identity unless
    /// scanner white/black correction is on AND one of the two faithful
    /// paths (slide or print) applies; other combos get no correction.
    ///
    /// `print_illuminant` is the enlarger's filtered illuminant and
    /// `print_exposure_factor` the midgray normalization — both already
    /// computed by the pipeline for the printing stage and reused here so the
    /// print references match `_film_cmy_to_print_log_raw` exactly.
    pub fn compute(
        film: &Profile,
        print: &Profile,
        params: &RuntimeParams,
        print_illuminant: &[f64],
        print_exposure_factor: f64,
    ) -> Self {
        let white_corr = params.scanner.white_correction;
        let black_corr = params.scanner.black_correction;
        if !white_corr && !black_corr {
            return Self::identity();
        }
        if params.io.scan_film && film.is_positive() {
            Self::compute_slide(film, params, white_corr, black_corr)
        } else if !params.io.scan_film && print.is_negative() {
            Self::compute_print(
                film,
                print,
                params,
                print_illuminant,
                print_exposure_factor,
                white_corr,
                black_corr,
            )
        } else {
            // scan_film+negative ("do not correct negative film scans"), or
            // a combo Python doesn't support (positive paper) — no correction.
            Self::identity()
        }
    }

    /// Slide path: scan the film directly; references are the film at zero /
    /// maximum dye density and the correction shifts the *filming* exposure.
    fn compute_slide(
        film: &Profile,
        params: &RuntimeParams,
        white_corr: bool,
        black_corr: bool,
    ) -> Self {
        // Scan spectral inputs come from the film (scan_film scans the film).
        let channel_density = profile_channel_density(film);
        let base_density = film.data.base_density.clone();
        let illuminant: Vec<f64> = select_illuminant_f64(&film.info.viewing_illuminant).to_vec();
        let normalization = scan_normalization(&illuminant, &channel_density);

        let scan_y = |cmy: [f64; 3]| -> f64 {
            scan_reference_y(
                cmy,
                &channel_density,
                &base_density,
                &illuminant,
                normalization,
            )
        };

        // References: white = zero dye density, black = max dye density.
        let curves = film.density_curves_f64();
        let cmy_black = nanmax_per_channel(&curves);
        let y_white = scan_y([0.0, 0.0, 0.0]);
        let y_black = scan_y(cmy_black);

        let (m, q, midgray_corrected) =
            build_remap(y_white, y_black, params, white_corr, black_corr);

        // Filming exposure correction: find the log-exposure that yields the
        // corrected vs uncorrected midgray density, shift by the ratio.
        // Mirrors `black_white_filming_exposure_correction`.
        let density_midgray = -(0.184f64.log10());
        let density_midgray_corrected = -(midgray_corrected.log10());
        let density_curve_av = nanmean_per_step(&curves);
        let density_min_av = nanmean(&base_density);
        let log_exposure = film.log_exposure_f64();
        // Positive film: density falls with exposure, so Python negates both
        // axes to feed np.interp an ascending x.
        let neg_curve: Vec<f64> = density_curve_av.iter().map(|d| -d).collect();
        let le_corrected = -interp(
            -(density_midgray_corrected - density_min_av),
            &neg_curve,
            &log_exposure,
        );
        let le_midgray = -interp(
            -(density_midgray - density_min_av),
            &neg_curve,
            &log_exposure,
        );
        let exposure_correction = 10f64.powf(le_corrected - le_midgray);

        Self {
            xyz_remap: Some((m, q)),
            filming_exposure_correction: 1.0 / exposure_correction,
            printing_exposure_correction: 1.0,
        }
    }

    /// Print path: the film's black/white reference exposures are pushed
    /// through the enlarger (print-spectral) and developed on the paper, so
    /// the references are *print* densities. The correction shifts the
    /// *printing* raw exposure. Mirrors the `in_print=True` branch of
    /// `_update_cmy_black_white_references` + `black_white_printing_exposure_correction`.
    #[allow(clippy::too_many_arguments)]
    fn compute_print(
        film: &Profile,
        print: &Profile,
        params: &RuntimeParams,
        print_illuminant: &[f64],
        print_exposure_factor: f64,
        white_corr: bool,
        black_corr: bool,
    ) -> Self {
        // Reference film densities, mirroring `PrintingStage.expose`:
        //   black = -grain.density_min, white = nanmax(film.density_curves).
        let gmin = params.film_render.grain.density_min;
        let cmy_film_black = [-gmin[0], -gmin[1], -gmin[2]];
        let film_curves = film.density_curves_f64();
        let cmy_film_white = nanmax_per_channel(&film_curves);

        // Enlarger spectral exposure of those references
        // (`_film_cmy_to_print_log_raw`, sans the unported preflash term).
        let film_channel_density = profile_channel_density(film);
        let film_base_density = film.data.base_density.clone();
        let print_sensitivity = profile_sensitivity(print);
        let n_wl = print_illuminant
            .len()
            .min(film_channel_density.len())
            .min(print_sensitivity.len())
            .min(spectral::N_WAVELENGTHS);
        let has_base = !film_base_density.is_empty() && film_base_density.len() >= n_wl;
        let to_print_log_raw = |cmy: [f64; 3]| -> [f64; 3] {
            let raw = compute_single_pixel_raw(
                &cmy,
                &film_channel_density,
                &film_base_density,
                has_base,
                n_wl,
                print_illuminant,
                &print_sensitivity,
            );
            let mut out = [0.0f64; 3];
            for c in 0..3 {
                out[c] = ((raw[c] * print_exposure_factor).max(0.0) + 1e-10).log10();
            }
            out
        };
        let log_raw_black = to_print_log_raw(cmy_film_black);
        let log_raw_white = to_print_log_raw(cmy_film_white);

        // Develop the references through the paper emulsion (raw —
        // un-normalized — curves). Upstream (>=v0.3.3) fixes the reference
        // develop to gamma_factor=1.0, decoupling it from the user's print
        // density_curve_gamma (the main image develop in `printing::develop`
        // still honours that gamma; only these black/white references don't).
        let log_exposure = print.log_exposure_f64();
        let print_curves = print.density_curves_f64();
        let cmy_black = develop_single(log_raw_black, &log_exposure, &print_curves, 1.0);
        let cmy_white = develop_single(log_raw_white, &log_exposure, &print_curves, 1.0);

        // Scan those densities through the print profile → reference luminances.
        let print_channel_density = profile_channel_density(print);
        let print_base_density = print.data.base_density.clone();
        let illuminant: Vec<f64> = select_illuminant_f64(&print.info.viewing_illuminant).to_vec();
        let normalization = scan_normalization(&illuminant, &print_channel_density);
        let scan_y = |cmy: [f64; 3]| -> f64 {
            scan_reference_y(
                cmy,
                &print_channel_density,
                &print_base_density,
                &illuminant,
                normalization,
            )
        };
        let y_black = scan_y(cmy_black);
        let y_white = scan_y(cmy_white);

        let (m, q, midgray_corrected) =
            build_remap(y_white, y_black, params, white_corr, black_corr);

        // Printing exposure correction: interp the corrected vs uncorrected
        // midgray density against the *print* curve, which rises with
        // exposure (paper is negative-working) — so np.interp sees an
        // ascending x directly, and the factor is applied (not inverted).
        let density_midgray = -(0.184f64.log10());
        let density_midgray_corrected = -(midgray_corrected.log10());
        let density_curve_av = nanmean_per_step(&print_curves);
        let density_min_av = nanmean(&print_base_density);
        let le_corrected = interp(
            density_midgray_corrected - density_min_av,
            &density_curve_av,
            &log_exposure,
        );
        let le_midgray = interp(
            density_midgray - density_min_av,
            &density_curve_av,
            &log_exposure,
        );
        let exposure_correction = 10f64.powf(le_corrected - le_midgray);

        Self {
            xyz_remap: Some((m, q)),
            filming_exposure_correction: 1.0,
            printing_exposure_correction: exposure_correction,
        }
    }
}

/// XYZ-luminance normalization (`sum illuminant·CMF_Y`) over the shared
/// wavelength range — the denominator `scan_log_xyz_cpu` divides by.
fn scan_normalization(illuminant: &[f64], channel_density: &[[f64; 3]]) -> f64 {
    let n_wl = illuminant
        .len()
        .min(channel_density.len())
        .min(spectral::N_WAVELENGTHS);
    (0..n_wl).map(|i| illuminant[i] * CMF_Y_F64[i]).sum()
}

/// Scan a single CMY density to its reference luminance `Y` (the `[1]`
/// channel of `10^log_xyz`), as Python does via `cmy_to_log_xyz`.
fn scan_reference_y(
    cmy: [f64; 3],
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    illuminant: &[f64],
    normalization: f64,
) -> f64 {
    let px = ImageBuf::from_data(
        1,
        1,
        vec![from_f64(cmy[0]), from_f64(cmy[1]), from_f64(cmy[2])],
    );
    let log_xyz = scan_log_xyz_cpu(
        &px,
        channel_density,
        base_density,
        illuminant,
        normalization,
    );
    10f64.powf(log_xyz[1])
}

/// Linear luminance remap `(m, q)` + corrected midgray, shared by both
/// paths. Mirrors `_correction_fucntion`: the sRGB-decoded white/black
/// target levels map onto `y_white`/`y_black`, and a one-sided correction
/// pins the unused level to its reference luminance.
fn build_remap(
    y_white: f64,
    y_black: f64,
    params: &RuntimeParams,
    white_corr: bool,
    black_corr: bool,
) -> (f64, f64, f64) {
    let mut white_level = remove_srgb_cctf(params.scanner.white_level as f64);
    let mut black_level = remove_srgb_cctf(params.scanner.black_level as f64);
    if black_corr && !white_corr {
        white_level = y_white;
    }
    if white_corr && !black_corr {
        black_level = y_black;
    }
    let m = (white_level - black_level) / (y_white - y_black + 1e-10);
    let q = black_level - m * y_black;
    let midgray_corrected = (0.184 - q) / m;
    (m, q, midgray_corrected)
}

/// Single-pixel `develop_simple`: per-channel `np.interp` of `log_raw`
/// against the shared `log_exposure / gamma` axis and the (raw) density
/// curves. Bit-identical to the CPU `density_curve_interp` path.
fn develop_single(
    log_raw: [f64; 3],
    log_exposure: &[f64],
    density_curves: &[[f64; 3]],
    gamma: f64,
) -> [f64; 3] {
    let scaled: Vec<f64> = if (gamma - 1.0).abs() < 1e-12 {
        log_exposure.to_vec()
    } else {
        log_exposure.iter().map(|&v| v / gamma).collect()
    };
    let img = ImageBuf::from_data(
        1,
        1,
        vec![
            from_f64(log_raw[0]),
            from_f64(log_raw[1]),
            from_f64(log_raw[2]),
        ],
    );
    let out = fast_interp_image_f64(&img, &scaled, density_curves);
    let p = out.get(0, 0);
    [p[0] as f64, p[1] as f64, p[2] as f64]
}

/// Print sensitivity: `nan_to_num(10^log_sensitivity)`, matching the
/// printing stage.
fn profile_sensitivity(p: &Profile) -> Vec<[f64; 3]> {
    p.log_sensitivity_f64()
        .iter()
        .map(|row| {
            let mut out = [0.0f64; 3];
            for c in 0..3 {
                let v = 10.0f64.powf(row[c]);
                out[c] = if v.is_nan() { 0.0 } else { v };
            }
            out
        })
        .collect()
}

fn profile_channel_density(p: &Profile) -> Vec<[f64; 3]> {
    p.data
        .channel_density
        .iter()
        .map(|r| {
            [
                r.first().copied().unwrap_or(0.0),
                r.get(1).copied().unwrap_or(0.0),
                r.get(2).copied().unwrap_or(0.0),
            ]
        })
        .collect()
}

/// numpy.nanmax over rows, per channel (`nanmax(curves, axis=0)`).
fn nanmax_per_channel(curves: &[[f64; 3]]) -> [f64; 3] {
    let mut m = [f64::NEG_INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if !row[c].is_nan() && row[c] > m[c] {
                m[c] = row[c];
            }
        }
    }
    m
}

/// numpy.nanmean over channels, per exposure step (`nanmean(curves, axis=1)`).
fn nanmean_per_step(curves: &[[f64; 3]]) -> Vec<f64> {
    curves
        .iter()
        .map(|row| {
            let (mut s, mut n) = (0.0, 0.0);
            for &v in row {
                if !v.is_nan() {
                    s += v;
                    n += 1.0;
                }
            }
            if n > 0.0 { s / n } else { f64::NAN }
        })
        .collect()
}

fn nanmean(xs: &[f64]) -> f64 {
    let (mut s, mut n) = (0.0, 0.0);
    for &v in xs {
        if !v.is_nan() {
            s += v;
            n += 1.0;
        }
    }
    if n > 0.0 { s / n } else { 0.0 }
}

/// Decode a scalar sRGB level the way Python's `_remove_sRGB_cctf` does.
///
/// Python routes the gray level through `colour.RGB_to_RGB('sRGB', 'sRGB',
/// apply_cctf_decoding=True)`, i.e. sRGB EOTF then an sRGB→XYZ→sRGB matrix
/// roundtrip. colour's forward/inverse sRGB matrices are not exact inverses,
/// so the roundtrip scales the result by a constant factor. Because the input
/// is gray, the matrix step is linear in the decoded scalar, so the whole
/// operation is exactly `ROUNDTRIP · eotf(v)` — `ROUNDTRIP` being the mean of
/// the roundtrip matrix's row-sums (`mean(rowsum(M_XYZ→RGB · M_RGB→XYZ))`),
/// equivalently `_remove_sRGB_cctf(1.0)`, for colour-science ~0.4.6.
fn remove_srgb_cctf(v: f64) -> f64 {
    const ROUNDTRIP: f64 = 1.0000282666666667;
    let eotf = if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    };
    ROUNDTRIP * eotf
}

/// numpy.interp: clamped piecewise-linear interpolation, `xp` ascending.
fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    let n = xp.len();
    if x <= xp[0] {
        return fp[0];
    }
    if x >= xp[n - 1] {
        return fp[n - 1];
    }
    for i in 1..n {
        if x <= xp[i] {
            let t = (x - xp[i - 1]) / (xp[i] - xp[i - 1]);
            return fp[i - 1] + t * (fp[i] - fp[i - 1]);
        }
    }
    fp[n - 1]
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    use crate::pipeline::Pipeline;
    use std::path::{Path, PathBuf};

    fn data_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("data")
    }

    /// Print-path B&W correction regression guard. The luminance remap
    /// `(m, q)` and the printing-exposure correction were cross-checked
    /// against a faithful transcription of Python's `color_reference.py`
    /// (kodak_portra_400 → kodak_portra_endura); they agree to ~1e-7, the
    /// residual being the f32 storage of the scanner white/black levels.
    #[test]
    fn print_bw_correction_matches_python() {
        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();

        let mut params = crate::params::RuntimeParams::default();
        params.io.scan_film = false;
        params.scanner.white_correction = true;
        params.scanner.black_correction = true;
        params.camera.auto_exposure = false;
        params.film_render.grain.active = false;

        let pipeline = Pipeline::new_with_spectral(film, print, params, &dir).unwrap();
        let cref = ColorReference::compute(
            &pipeline.film,
            &pipeline.print,
            &pipeline.params,
            pipeline.print_illuminant_slice(),
            pipeline.print_exposure_factor(),
        );

        assert!(cref.has_remap(), "print path must build a luminance remap");
        let (m, q) = cref.xyz_remap.unwrap();
        // Reference values from upstream 0.3.4's color_reference.py print
        // path (SimulationPipeline at default params, corrections on):
        //   m = 1.1805080822518117
        //   q = -3.99466139952556459e-3
        //   printing_exposure_correction = 1.0644087236240962
        assert!((m - 1.1805080822518117).abs() < 1e-6, "m = {m}");
        assert!((q - -3.99466139952556459e-3).abs() < 1e-7, "q = {q}");
        assert!(
            (cref.printing_exposure_correction - 1.0644087236240962).abs() < 1e-6,
            "printing_exposure_correction = {}",
            cref.printing_exposure_correction
        );
        assert_eq!(
            cref.filming_exposure_correction, 1.0,
            "print path leaves filming untouched"
        );
    }
}
