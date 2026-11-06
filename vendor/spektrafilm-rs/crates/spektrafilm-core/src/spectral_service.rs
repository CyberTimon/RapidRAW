/// Spectral upsampling service: loads the Hanatos2025 spectra LUT and computes
/// the TC LUT for a given film stock's sensitivity.
///
/// Port of Python `compute_hanatos2025_tc_lut` and `_load_hanatos2025_spectra_lut`.
use std::path::Path;

use spektrafilm_math::npy;
use spektrafilm_math::spectral::{self, N_WAVELENGTHS, TcLut};

// Pure-Rust matmul (BLAS removed in this fork; the tc_lut contraction is a
// one-time per-stock build cost, so a naive loop is sufficient).
fn dgemm_no_transpose(a: &[f64], b: &[f64], c: &mut [f64], m: usize, n: usize, k: usize) {
    assert_eq!(a.len(), m * k, "dgemm_no_transpose: a.len() != m*k");
    assert_eq!(b.len(), k * n, "dgemm_no_transpose: b.len() != k*n");
    assert_eq!(c.len(), m * n, "dgemm_no_transpose: c.len() != m*n");

    for row in 0..m {
        for col in 0..n {
            let mut sum = 0.0f64;
            for kk in 0..k {
                sum += a[row * k + kk] * b[kk * n + col];
            }
            c[row * n + col] = sum;
        }
    }
}

/// Load the spectra LUT from the .npy file.
/// Shape: (size, size, 81) — maps tc coordinates → 81-wavelength spectra.
pub fn load_spectra_lut(data_dir: &Path) -> Result<SpectraLut, String> {
    let path = data_dir
        .join("luts")
        .join("spectral_upsampling")
        .join("irradiance_xy_tc.npy");

    let file = std::fs::File::open(&path)
        .map_err(|e| format!("opening spectra LUT {}: {e}", path.display()))?;
    let reader = std::io::BufReader::new(file);

    let (shape, data) =
        npy::load_npy_f32(reader).map_err(|e| format!("loading spectra LUT: {e}"))?;

    if shape.len() != 3 || shape[2] != N_WAVELENGTHS {
        return Err(format!(
            "spectra LUT shape mismatch: expected (N, N, {N_WAVELENGTHS}), got {shape:?}"
        ));
    }
    if shape[0] != shape[1] {
        return Err(format!(
            "spectra LUT must be square, got {}x{}",
            shape[0], shape[1]
        ));
    }

    Ok(SpectraLut {
        size: shape[0],
        n_wavelengths: shape[2],
        data,
    })
}

/// Load the arctic2026alpha02 effective-reflectance LUT.
///
/// Shape: (size, size, 81). The table is a D65-recovered unit-bright
/// reflectance surface in triangular coordinates. At render time we relight it
/// by the film reference illuminant before integrating against film
/// sensitivity.
pub fn load_arctic2026alpha02_lut(data_dir: &Path) -> Result<SpectraLut, String> {
    let path = data_dir
        .join("luts")
        .join("spectral_upsampling")
        .join("arctic2026alpha02")
        .join("reflectance_xy_tc.npy");

    let file = std::fs::File::open(&path)
        .map_err(|e| format!("opening arctic2026alpha02 LUT {}: {e}", path.display()))?;
    let reader = std::io::BufReader::new(file);

    let (shape, data) =
        npy::load_npy_f32(reader).map_err(|e| format!("loading arctic2026alpha02 LUT: {e}"))?;

    if shape.len() != 3 || shape[2] != N_WAVELENGTHS {
        return Err(format!(
            "arctic2026alpha02 LUT shape mismatch: expected (N, N, {N_WAVELENGTHS}), got {shape:?}"
        ));
    }
    if shape[0] != shape[1] {
        return Err(format!(
            "arctic2026alpha02 LUT must be square, got {}x{}",
            shape[0], shape[1]
        ));
    }

    Ok(SpectraLut {
        size: shape[0],
        n_wavelengths: shape[2],
        data,
    })
}

pub struct SpectraLut {
    pub size: usize,
    pub n_wavelengths: usize,
    /// Flat: [size * size * n_wavelengths]
    pub data: Vec<f32>,
}

impl SpectraLut {
    /// Get spectrum at grid position (i, j). Returns slice of n_wavelengths.
    pub fn spectrum(&self, i: usize, j: usize) -> &[f32] {
        let start = (i * self.size + j) * self.n_wavelengths;
        &self.data[start..start + self.n_wavelengths]
    }
}

/// Compute the TC LUT for a given film stock.
///
/// Port of Python `compute_hanatos2025_tc_lut`:
///   tc_lut[i][j][c] = sum_wl( spectra_lut[i][j][wl] * sensitivity[wl][c] )
///
/// The result maps tc coordinates → per-channel film raw exposure,
/// normalized so that the reference illuminant midgray produces balanced
/// exposure on the green channel (matching Python's `raw / raw_midgray[1]`).
pub fn compute_tc_lut(spectra_lut: &SpectraLut, sensitivity: &[[f64; 3]]) -> TcLut {
    let size = spectra_lut.size;
    let n_wl = spectra_lut.n_wavelengths.min(sensitivity.len());
    let channels = 3;

    let mut data = vec![0.0f64; size * size * channels];

    for i in 0..size {
        for j in 0..size {
            let spectrum = spectra_lut.spectrum(i, j);
            let mut raw = [0.0f64; 3];
            for wl in 0..n_wl {
                for c in 0..3 {
                    raw[c] += spectrum[wl] as f64 * sensitivity[wl][c];
                }
            }
            let base = (i * size + j) * channels;
            data[base] = raw[0];
            data[base + 1] = raw[1];
            data[base + 2] = raw[2];
        }
    }

    TcLut {
        size,
        channels,
        data,
    }
}

/// Build a TC→film-raw LUT from an effective-reflectance surface by relighting
/// each reflectance with the film/reference illuminant first:
///
/// `raw[i,j,c] = sum_wl reflectance[i,j,wl] * illuminant[wl] * sensitivity[wl,c]`
pub fn compute_reflectance_tc_lut(
    reflectance_lut: &SpectraLut,
    sensitivity: &[[f64; 3]],
    illuminant: &[f64],
) -> TcLut {
    let size = reflectance_lut.size;
    let n_wl = reflectance_lut
        .n_wavelengths
        .min(sensitivity.len())
        .min(illuminant.len());
    let channels = 3;
    let mut data = vec![0.0f64; size * size * channels];

    for i in 0..size {
        for j in 0..size {
            let spectrum = reflectance_lut.spectrum(i, j);
            let mut raw = [0.0f64; 3];
            for wl in 0..n_wl {
                let lit = spectrum[wl] as f64 * illuminant[wl];
                for c in 0..3 {
                    raw[c] += lit * sensitivity[wl][c];
                }
            }
            let base = (i * size + j) * channels;
            data[base] = raw[0];
            data[base + 1] = raw[1];
            data[base + 2] = raw[2];
        }
    }

    TcLut {
        size,
        channels,
        data,
    }
}

/// Compute the TC LUT with spectral bandpass window (erf4 model).
///
/// The window models the camera's UV/IR sensitivity cutoff. It's applied
/// to the sensitivity before integration, with normalization to preserve
/// white balance.
///
/// `window_params`: (c_uv, sigma_uv, c_ir, sigma_ir) — erf4 bandpass parameters.
/// `illuminant`: reference illuminant SPD for normalization (f64 to
/// match Python parity — f32 illuminants drop ~7 decimal places per
/// sample, accumulating ~1e-9 error per LUT cell).
pub fn compute_tc_lut_with_window(
    spectra_lut: &SpectraLut,
    sensitivity: &[[f64; 3]],
    window_params: &[f64],
    illuminant: &[f64],
) -> TcLut {
    let n_wl = spectra_lut
        .n_wavelengths
        .min(sensitivity.len())
        .min(N_WAVELENGTHS);

    // Compute erf4 bandpass window in f64
    let window = if window_params.len() >= 4 {
        eval_erf4_bandpass(window_params)
    } else {
        vec![[1.0f64; 3]; N_WAVELENGTHS]
    };

    // Window normalization — Python:
    //   norm_num = np.sum(sens * illuminant[:, None] * window, axis=0)
    //   norm_den = np.sum(sens * illuminant[:, None], axis=0)
    //   normalization = norm_num / norm_den
    //   window /= normalization
    // Multiplication order per cell: `(sens * illuminant) * window`
    // — left-to-right. The 81-wavelength reduction in numpy uses
    // pairwise summation; for 81 elements that's recursive halving.
    // We replicate it via `pairwise_sum_f64`.
    let mut num_per_wl = [
        Vec::<f64>::with_capacity(n_wl),
        Vec::with_capacity(n_wl),
        Vec::with_capacity(n_wl),
    ];
    let mut den_per_wl = [
        Vec::<f64>::with_capacity(n_wl),
        Vec::with_capacity(n_wl),
        Vec::with_capacity(n_wl),
    ];
    for wl in 0..n_wl {
        for c in 0..3 {
            let si = sensitivity[wl][c] * illuminant[wl];
            num_per_wl[c].push(si * window[wl][c]);
            den_per_wl[c].push(si);
        }
    }
    let mut window_normalized = window.clone();
    for c in 0..3 {
        let num_c = pairwise_sum_f64(&num_per_wl[c]);
        let den_c = pairwise_sum_f64(&den_per_wl[c]);
        if num_c > 1e-10 && den_c > 1e-10 {
            let normalization_c = num_c / den_c;
            for wl in 0..n_wl {
                window_normalized[wl][c] = window[wl][c] / normalization_c;
            }
        }
    }

    // Compute raw LUT via BLAS dgemm to match Python's
    // `opt_einsum.contract('ijl,lm->ijm', spectra, sens*window)`.
    // numpy/opt_einsum routes this through GEMM with pairwise
    // accumulation, so a hand-rolled left-to-right loop is off by
    // 1-2 ULP per cell. Going through dgemm matches bit-for-bit.
    let size = spectra_lut.size;
    let channels = 3;
    let n_pix = size * size;
    let mut spec_f64 = vec![0.0f64; n_pix * n_wl];
    for i in 0..n_pix {
        let src =
            &spectra_lut.data[i * spectra_lut.n_wavelengths..i * spectra_lut.n_wavelengths + n_wl];
        let dst = &mut spec_f64[i * n_wl..(i + 1) * n_wl];
        for (d, s) in dst.iter_mut().zip(src.iter()) {
            *d = *s as f64;
        }
    }
    // Build sens*window as (n_wl × 3) row-major.
    let mut sw_flat = vec![0.0f64; n_wl * 3];
    for wl in 0..n_wl {
        for c in 0..3 {
            sw_flat[wl * 3 + c] = sensitivity[wl][c] * window_normalized[wl][c];
        }
    }
    let mut data = vec![0.0f64; n_pix * channels];
    dgemm_no_transpose(&spec_f64, &sw_flat, &mut data, n_pix, channels, n_wl);

    TcLut {
        size,
        channels,
        data,
    }
}

/// Compute the midgray normalization factor for Hanatos2025.
///
/// Port of Python: `raw_midgray = einsum('k,km->m', illuminant * 0.184, sensitivity)`
/// then normalize by `raw_midgray[1]` (green channel).
pub fn compute_midgray_normalization(sensitivity: &[[f64; 3]], illuminant: &[f32]) -> f64 {
    let n_wl = sensitivity.len().min(illuminant.len());
    let mut raw_midgray = [0.0f64; 3];
    for wl in 0..n_wl {
        for c in 0..3 {
            raw_midgray[c] += illuminant[wl] as f64 * 0.184 * sensitivity[wl][c];
        }
    }
    if raw_midgray[1] > 1e-10 {
        1.0 / raw_midgray[1]
    } else {
        1.0
    }
}

/// Public re-export: pairwise sum for f64 spectra/wavelength reductions.
/// See `pairwise_sum_f64` doc below.
pub fn pairwise_sum_f64_pub(xs: &[f64]) -> f64 {
    pairwise_sum_f64(xs)
}

/// Pairwise (recursive-halving) f64 summation. Matches numpy's
/// `np.add.reduce` reduction pattern, which is what `np.sum` uses for
/// 1-D arrays. For 81 elements this is recursive halving; the result
/// differs from a naive left-to-right sum by 1-2 ULPs but matches numpy
/// bit-for-bit.
fn pairwise_sum_f64(xs: &[f64]) -> f64 {
    match xs.len() {
        0 => 0.0,
        1 => xs[0],
        2 => xs[0] + xs[1],
        n => {
            let mid = n / 2;
            pairwise_sum_f64(&xs[..mid]) + pairwise_sum_f64(&xs[mid..])
        }
    }
}

/// Evaluate the erf4 spectral bandpass window.
/// params: (c_uv, sigma_uv, c_ir, sigma_ir)
/// Returns [81][3] window values (same for all 3 channels in erf4 model).
fn eval_erf4_bandpass(params: &[f64]) -> Vec<[f64; 3]> {
    let sqrt2 = std::f64::consts::SQRT_2;
    let c_uv = params[0];
    let sigma_uv = params[1];
    let c_ir = params[2];
    let sigma_ir = params[3];

    let mut window = vec![[0.0f64; 3]; N_WAVELENGTHS];
    for i in 0..N_WAVELENGTHS {
        let wl = spectral::WAVELENGTH_MIN as f64 + (i as f64) * spectral::WAVELENGTH_STEP as f64;
        let edge_uv = 0.5 * (1.0 + erf((wl - c_uv) / (sigma_uv * sqrt2)));
        let edge_ir = 0.5 * (1.0 - erf((wl - c_ir) / (sigma_ir * sqrt2)));
        let w = edge_uv * edge_ir;
        window[i] = [w, w, w];
    }
    window
}

/// f64 erf via libm — matches scipy.special.erf at full f64 precision.
#[inline]
fn erf(x: f64) -> f64 {
    libm::erf(x)
}
