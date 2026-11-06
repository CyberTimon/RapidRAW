use rayon::prelude::*;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::{Scalar, from_f32, from_f64, to_f32};
use spektrafilm_math::spectral;

use crate::{ComputeBackend, Lut3D};

use spektrafilm_math::vforce::exp10_inplace;

#[derive(Clone, Copy)]
enum Transpose {
    None,
    Ordinary,
}

/// Row-major `C[M×N] = A[M×K] · op(B)`, rayon-parallel over rows.
/// (This fork drops the BLAS dependency entirely: the naive kernel is
/// fast enough for both preview and export, and it removes the
/// OpenBLAS/Accelerate system dependency on Linux/macOS.)
///
/// `trans_b` controls whether B is transposed on the fly; `ldb` is
/// ignored (kept for signature compatibility).
#[allow(clippy::too_many_arguments)]
fn dgemm_blas(
    a: &[f64],
    b: &[f64],
    c: &mut [f64],
    m: usize,
    n: usize,
    k: usize,
    trans_b: Transpose,
    ldb: i32,
) {
    assert_eq!(a.len(), m * k, "dgemm_blas: a.len() != m*k");
    assert_eq!(c.len(), m * n, "dgemm_blas: c.len() != m*n");
    let _ = ldb;
    c.par_chunks_exact_mut(n).enumerate().for_each(|(row, crow)| {
        for col in 0..n {
            let mut sum = 0.0f64;
            for kk in 0..k {
                let bv = match trans_b {
                    Transpose::None => b[kk * n + col],
                    Transpose::Ordinary => b[col * k + kk],
                };
                sum += a[row * k + kk] * bv;
            }
            crow[col] = sum;
        }
    });
}

pub struct CpuBackend;

impl ComputeBackend for CpuBackend {
    fn colorspace_convert(&self, img: &ImageBuf, matrix: &[[f32; 3]; 3]) -> ImageBuf {
        let m: [[Scalar; 3]; 3] = [
            [
                from_f32(matrix[0][0]),
                from_f32(matrix[0][1]),
                from_f32(matrix[0][2]),
            ],
            [
                from_f32(matrix[1][0]),
                from_f32(matrix[1][1]),
                from_f32(matrix[1][2]),
            ],
            [
                from_f32(matrix[2][0]),
                from_f32(matrix[2][1]),
                from_f32(matrix[2][2]),
            ],
        ];
        let mut out = img.clone();
        out.par_pixels_mut().for_each(|px| {
            let r = px[0];
            let g = px[1];
            let b = px[2];
            px[0] = m[0][0] * r + m[0][1] * g + m[0][2] * b;
            px[1] = m[1][0] * r + m[1][1] * g + m[1][2] * b;
            px[2] = m[2][0] * r + m[2][1] * g + m[2][2] * b;
        });
        out
    }

    fn cctf_encode_srgb(&self, img: &ImageBuf) -> ImageBuf {
        let mut out = img.clone();
        out.data
            .par_iter_mut()
            .for_each(|v| *v = spektrafilm_math::precision::srgb_encode(*v));
        out
    }

    fn cctf_decode_srgb(&self, img: &ImageBuf) -> ImageBuf {
        let mut out = img.clone();
        out.data
            .par_iter_mut()
            .for_each(|v| *v = spektrafilm_math::precision::srgb_decode(*v));
        out
    }

    fn gaussian_blur(&self, img: &ImageBuf, sigma: f32) -> ImageBuf {
        if sigma <= 0.0 {
            return img.clone();
        }
        spektrafilm_math::gaussian::gaussian_blur(img, sigma)
    }

    fn table_lookup(&self, img: &ImageBuf, table_x: &[f32], table_y: &[[f32; 3]]) -> ImageBuf {
        let mut out = img.clone();
        out.par_pixels_mut().for_each(|px| {
            for c in 0..3 {
                let y_col: Vec<f32> = table_y.iter().map(|row| row[c]).collect();
                px[c] = from_f32(spektrafilm_math::interp::interp_1d(
                    table_x,
                    &y_col,
                    to_f32(px[c]),
                ));
            }
        });
        out
    }

    fn lut3d_interp(&self, img: &ImageBuf, lut: &Lut3D) -> ImageBuf {
        let mut out = img.clone();
        let size = lut.size as usize;
        out.par_pixels_mut().for_each(|px| {
            let rgb = spektrafilm_math::lut::trilinear_3d(
                &lut.data,
                size,
                to_f32(px[0]),
                to_f32(px[1]),
                to_f32(px[2]),
            );
            px[0] = from_f32(rgb[0]);
            px[1] = from_f32(rgb[1]);
            px[2] = from_f32(rgb[2]);
        });
        out
    }

    fn name(&self) -> &str {
        "CPU (rayon)"
    }
}

/// Tiled spectral integration shared by the print and scan CPU paths.
///
/// For each pixel: `proj · (10^(-(density·channel_densityᵀ + base)) · illuminant)`,
/// i.e. GEMM(density, channel_densityᵀ) → `10^(-…)·illuminant` (NaN→0) →
/// GEMM(·, proj). Returns the projected `n_pix × 3` buffer (XYZ via the CMFs,
/// or raw via the print sensitivity).
///
/// Tiles over pixels so the `tile × n_wl` spectral intermediate stays bounded —
/// the full `n_pix × n_wl` buffer is ~15 GB at 24 MP and thrashes swap. BLAS is
/// internally threaded so tiles run sequentially with no throughput loss, and
/// the vForce passes still parallelise within each tile. Bit-identical to the
/// untiled version (each output pixel is computed independently).
#[allow(clippy::too_many_arguments)]
fn spectral_to_proj_tiled(
    density_f64: &[f64],
    cd_flat: &[f64],
    base_density: &[f64],
    has_base: bool,
    illuminant: &[f64],
    proj_flat: &[f64],
    n_pix: usize,
    n_wl: usize,
) -> Vec<f64> {
    // ~256K px/tile → 256K × 81 × 8 B ≈ 170 MB spectral scratch, reused.
    const TILE: usize = 1 << 18;
    const ROWS_PER_TASK: usize = 4096;
    let mut out = vec![0.0f64; n_pix * 3];
    let mut spectral = vec![0.0f64; TILE.min(n_pix.max(1)) * n_wl];
    let mut start = 0;
    while start < n_pix {
        let tpx = (n_pix - start).min(TILE);
        let spec = &mut spectral[..tpx * n_wl];
        // GEMM 1: spec [tpx × n_wl] = density [tpx × 3] · channel_densityᵀ [3 × n_wl]
        dgemm_blas(
            &density_f64[start * 3..(start + tpx) * 3],
            cd_flat,
            spec,
            tpx,
            n_wl,
            3,
            Transpose::Ordinary,
            3,
        );
        // Three-pass vForce: -(d + base) → 10^x → ×illuminant (NaN→0).
        spec.par_chunks_mut(ROWS_PER_TASK * n_wl).for_each(|chunk| {
            if has_base {
                for row in chunk.chunks_exact_mut(n_wl) {
                    for wl in 0..n_wl {
                        row[wl] = -(row[wl] + base_density[wl]);
                    }
                }
            } else {
                for v in chunk.iter_mut() {
                    *v = -*v;
                }
            }
            exp10_inplace(chunk);
            for row in chunk.chunks_exact_mut(n_wl) {
                for wl in 0..n_wl {
                    let t = row[wl] * illuminant[wl];
                    row[wl] = if t.is_nan() { 0.0 } else { t };
                }
            }
        });
        // GEMM 2: out [tpx × 3] = spec [tpx × n_wl] · proj [n_wl × 3]
        dgemm_blas(
            spec,
            proj_flat,
            &mut out[start * 3..(start + tpx) * 3],
            tpx,
            3,
            n_wl,
            Transpose::None,
            3,
        );
        start += tpx;
    }
    out
}

/// Same spectral-integration core as `scan_spectral_cpu`, but stops at
/// `log_xyz = log10(max(xyz / normalization, 0) + 1e-10)` — i.e. it
/// mirrors Python's `cmy_to_log_xyz` *exactly*. Used to build the
/// scanner LUT so the PCHIP-interpolated function is the same one
/// Python interpolates (not the post-`10^x`-CAT-matrix surface, which
/// would diverge sub-LSB from Python's output).
///
/// Returns a flat `n_pix × 3` f64 row-major buffer of log10 XYZ values.
pub fn scan_log_xyz_cpu(
    density_cmy: &ImageBuf,
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    illuminant: &[f64],
    normalization: f64,
) -> Vec<f64> {
    let n_wl = channel_density
        .len()
        .min(illuminant.len())
        .min(spectral::N_WAVELENGTHS);
    let has_base = !base_density.is_empty() && base_density.len() >= n_wl;
    let n_pix = (density_cmy.width as usize) * (density_cmy.height as usize);

    let density_f64: Vec<f64> = density_cmy.data.par_iter().map(|&v| v as f64).collect();
    let cd_flat: Vec<f64> = channel_density[..n_wl]
        .iter()
        .flat_map(|r| [r[0], r[1], r[2]])
        .collect();
    let mut cmf_flat = Vec::with_capacity(n_wl * 3);
    for wl in 0..n_wl {
        cmf_flat.push(spectral::CMF_X_F64[wl]);
        cmf_flat.push(spectral::CMF_Y_F64[wl]);
        cmf_flat.push(spectral::CMF_Z_F64[wl]);
    }
    let mut xyz_flat = spectral_to_proj_tiled(
        &density_f64,
        &cd_flat,
        base_density,
        has_base,
        illuminant,
        &cmf_flat,
        n_pix,
        n_wl,
    );

    // Final step — exactly Python's `np.log10(np.fmax(xyz, 0.0) + 1e-10)`
    // where `xyz` is the post-normalisation value. No 10^x roundtrip
    // here: the LUT stores log_xyz, the consumer applies 10^x once
    // post-interpolation.
    let inv_norm = 1.0 / normalization;
    xyz_flat.par_iter_mut().for_each(|v| {
        let after_norm = *v * inv_norm;
        *v = (after_norm.max(0.0) + 1e-10).log10();
    });
    xyz_flat
}

/// CPU spectral scanning: density CMY → RGB via 81-wavelength spectral integration.
/// All inputs are f64 for Python parity. Python: `density_to_light` → einsum CMFs / norm.
/// CPU spectral scanning: print/film density → final RGB via spectral
/// integration. BLAS-backed GEMMs for numpy parity (same Accelerate
/// BLAS that numpy uses on macOS).
///
/// Algorithm:
///   1. density_spectral = density_cmy @ channel_density.T + base_density
///   2. light             = 10^(-density_spectral) * illuminant   (NaN → 0)
///   3. xyz               = light @ CMF                            (CMF = [n_wl × 3] of X,Y,Z)
///   4. rgb               = (xyz / normalization) @ xyz_to_rgb.T
pub fn scan_spectral_cpu(
    density_cmy: &ImageBuf,
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    illuminant: &[f64],
    normalization: f64,
    cat: &[[f64; 3]; 3],
    xyz_to_rgb: &[[f64; 3]; 3],
) -> ImageBuf {
    let n_wl = channel_density
        .len()
        .min(illuminant.len())
        .min(spectral::N_WAVELENGTHS);
    let has_base = !base_density.is_empty() && base_density.len() >= n_wl;
    let n_pix = (density_cmy.width as usize) * (density_cmy.height as usize);

    // ── density_spectral = density_cmy @ channel_density.T + base_density
    // Promote density_cmy to f64 directly — never round-trip through
    // f32, even with Scalar=f64 (`to_f32(v) as f64` quietly narrows).
    // The `as f64` conversion is per-element and embarrassingly parallel;
    // the prior serial collect ran ~60M conversions on one core.
    // ── xyz = (10^(-(density·channel_densityᵀ + base)) · illuminant) @ CMF.
    // Use f64 CMF constants — the f32 ones drop ~7 digits per sample and
    // accumulate ~5e-6 of drift after the 81-wavelength reduction. The
    // spectral integration is tiled (see `spectral_to_proj_tiled`) so the
    // intermediate stays bounded at high resolution.
    let density_f64: Vec<f64> = density_cmy.data.par_iter().map(|&v| v as f64).collect();
    let cd_flat: Vec<f64> = channel_density[..n_wl]
        .iter()
        .flat_map(|r| [r[0], r[1], r[2]])
        .collect();
    let mut cmf_flat = Vec::with_capacity(n_wl * 3);
    for wl in 0..n_wl {
        cmf_flat.push(spectral::CMF_X_F64[wl]);
        cmf_flat.push(spectral::CMF_Y_F64[wl]);
        cmf_flat.push(spectral::CMF_Z_F64[wl]);
    }
    let mut xyz_flat = spectral_to_proj_tiled(
        &density_f64,
        &cd_flat,
        base_density,
        has_base,
        illuminant,
        &cmf_flat,
        n_pix,
        n_wl,
    );

    // Python's `_density_to_rgb` does:
    //   log_xyz = log10(max(xyz/norm, 0) + 1e-10)
    //   xyz_again = 10**log_xyz
    //   rgb = colour.XYZ_to_RGB(xyz_again, ...)
    // The log/exp roundtrip introduces a small but reproducible
    // precision noise — `10**log10(x + 1e-10)` ≠ `x` after f64
    // arithmetic. We replicate it bit-for-bit so the residual error
    // at the final stage matches numpy.
    // Fuse the normalization log/exp roundtrip with the per-pixel CAT
    // multiply. xyz_flat is interleaved [X,Y,Z]; one parallel chunk
    // per pixel handles all three components, replacing two serial
    // passes (3·n_pix scalar log10+powf, then 9·n_pix muls).
    let inv_norm = 1.0 / normalization;
    xyz_flat.par_chunks_exact_mut(3).for_each(|px| {
        let mut tmp = [0.0f64; 3];
        for k in 0..3 {
            let after_norm = px[k] * inv_norm;
            let log_xyz = (after_norm.max(0.0) + 1e-10).log10();
            tmp[k] = 10.0f64.powf(log_xyz);
        }
        // Apply CAT (xyz_adapted = cat @ xyz). Python's `colour.XYZ_to_RGB`
        // calls `vecmul(M_CAT, XYZ)` and `vecmul(matrix_XYZ_to_RGB, ...)`
        // as two sequential matmuls; collapsing loses ~1 ULP per output.
        px[0] = cat[0][0] * tmp[0] + cat[0][1] * tmp[1] + cat[0][2] * tmp[2];
        px[1] = cat[1][0] * tmp[0] + cat[1][1] * tmp[1] + cat[1][2] * tmp[2];
        px[2] = cat[2][0] * tmp[0] + cat[2][1] * tmp[1] + cat[2][2] * tmp[2];
    });

    // ── rgb = xyz_adapted @ xyz_to_rgb.T
    let xyz_to_rgb_flat: Vec<f64> = xyz_to_rgb.iter().flat_map(|r| [r[0], r[1], r[2]]).collect();
    let mut rgb_flat = vec![0.0f64; n_pix * 3];
    dgemm_blas(
        &xyz_flat,
        &xyz_to_rgb_flat,
        &mut rgb_flat,
        n_pix,
        3,
        3,
        Transpose::Ordinary,
        3,
    );

    let mut rgb = ImageBuf::new(density_cmy.width, density_cmy.height);
    rgb.data
        .par_iter_mut()
        .zip(rgb_flat.par_iter())
        .for_each(|(dst, &src)| *dst = from_f64(src));
    rgb
}

/// CPU spectral printing: film density → print log-exposure via spectral integration.
/// All inputs are f64 for Python parity. Uses BLAS GEMM for the two
/// reductions, matching numpy's einsum bit-for-bit on macOS Accelerate.
///
/// Algorithm (mirrors `spektrafilm/model/emulsion.py:compute_density_spectral`
/// + `spektrafilm/utils/conversions.py:density_to_light` + the
/// `einsum("ijk,kl->ijl", light, sensitivity)` in `printing.py`):
///   1. density_spectral = density_cmy @ channel_density.T + base_density
///   2. light             = 10^(-density_spectral) * illuminant   (NaN → 0)
///   3. raw               = light @ sensitivity
///   4. output            = log10(max(raw * normalization, 0) + 1e-10)
pub fn print_spectral_cpu(
    density_cmy: &ImageBuf,
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    illuminant: &[f64],
    sensitivity: &[[f64; 3]],
    normalization_factor: f64,
    preflash: [f64; 3],
) -> ImageBuf {
    let n_wl = channel_density
        .len()
        .min(illuminant.len())
        .min(sensitivity.len());
    let has_base = !base_density.is_empty() && base_density.len() >= n_wl;
    let n_pix = (density_cmy.width as usize) * (density_cmy.height as usize);

    // density_cmy stored as Scalar (interleaved RGB). Promote to f64
    // directly — `to_f32(v) as f64` quietly round-trips through f32
    // even with Scalar=f64 and was the seed of ~1e-9 print drift.
    let density_f64: Vec<f64> = density_cmy.data.par_iter().map(|&v| v as f64).collect();

    // channel_density: Vec<[f64; 3]> is already row-major [n_wl × 3].
    // For the GEMM density_cmy @ channel_density.T we pass TransB so BLAS
    // transposes channel_density on the fly.
    let cd_flat: Vec<f64> = channel_density[..n_wl]
        .iter()
        .flat_map(|r| [r[0], r[1], r[2]])
        .collect();

    // raw [n_pix × 3] = (10^(-(density·channel_densityᵀ + base)) · illuminant) @ sensitivity.
    // Tiled over pixels so the [tile × n_wl] spectral intermediate stays bounded
    // at high resolution (see `spectral_to_proj_tiled`).
    let sens_flat: Vec<f64> = sensitivity[..n_wl]
        .iter()
        .flat_map(|r| [r[0], r[1], r[2]])
        .collect();
    let raw_flat = spectral_to_proj_tiled(
        &density_f64,
        &cd_flat,
        base_density,
        has_base,
        illuminant,
        &sens_flat,
        n_pix,
        n_wl,
    );

    // Apply normalization, add the constant preflash exposure, then
    // log10(max(., 0) + 1e-10), in parallel. Preflash is a per-channel
    // constant broadcast over every pixel (Python `raw += preflash`); adding
    // it here — before the inner log10 — bakes it into LUT nodes when this
    // path generates a print LUT, matching upstream `_film_cmy_to_print_log_raw`.
    let mut output = ImageBuf::new(density_cmy.width, density_cmy.height);
    output
        .data
        .par_chunks_exact_mut(3)
        .zip(raw_flat.par_chunks_exact(3))
        .for_each(|(dst, src)| {
            for c in 0..3 {
                let v = src[c] * normalization_factor + preflash[c];
                dst[c] = from_f64((v.max(0.0) + 1e-10).log10());
            }
        });
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use spektrafilm_math::precision::{srgb_decode, srgb_encode};

    #[test]
    fn test_srgb_roundtrip() {
        for &v in &[0.0_f64, 0.001, 0.01, 0.1, 0.5, 0.9, 1.0] {
            let s = from_f64(v);
            let encoded = srgb_encode(s);
            let decoded = srgb_decode(encoded);
            assert!(
                (s - decoded).abs() < from_f64(1e-5),
                "roundtrip failed for {v}: got {decoded}"
            );
        }
    }

    #[test]
    fn test_colorspace_convert_identity() {
        let identity = [[1.0_f32, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let img = ImageBuf::from_data(
            2,
            1,
            vec![
                from_f64(0.2),
                from_f64(0.4),
                from_f64(0.6),
                from_f64(0.8),
                from_f64(0.1),
                from_f64(0.3),
            ],
        );
        let backend = CpuBackend;
        let out = backend.colorspace_convert(&img, &identity);
        assert_eq!(img.data, out.data);
    }
}
