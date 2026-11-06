// Emulsion density calculation and development.
//
// Core operations: spectral density computation, develop (simple and full with couplers+grain).

use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::to_f32;

use crate::density_curves::{interpolate_exposure_to_density, normalize_density_curves};

/// Compute spectral density from CMY density and channel density spectra.
///
/// Port of Python `compute_density_spectral`:
///   density_spectral = einsum('ijk, lk->ijl', density_cmy, channel_density)
///   + base_density
///
/// `channel_density`: [81][3] spectral dye density per channel.
/// `density_cmy`: image of CMY densities [H][W][3].
/// `base_density`: optional [81] base film density.
///
/// Returns: spectral density image [H*W][81] (flattened for efficiency).
pub fn compute_density_spectral(
    channel_density: &[[f32; 3]],
    density_cmy: &ImageBuf,
    base_density: Option<&[f32]>,
) -> Vec<Vec<f32>> {
    let n_wl = channel_density.len();
    let n_pixels = density_cmy.pixel_count();

    let mut result = vec![vec![0.0f32; n_wl]; n_pixels];

    for (i, px) in density_cmy.pixels().enumerate() {
        let p0 = to_f32(px[0]);
        let p1 = to_f32(px[1]);
        let p2 = to_f32(px[2]);
        for wl in 0..n_wl {
            // density_spectral[wl] = sum_k density_cmy[k] * channel_density[wl][k]
            let mut d = p0 * channel_density[wl][0]
                + p1 * channel_density[wl][1]
                + p2 * channel_density[wl][2];
            if let Some(base) = base_density {
                d += base[wl];
            }
            result[i][wl] = d;
        }
    }

    result
}

/// Simple development: log_raw → density_cmy via curve interpolation.
pub fn develop_simple(
    log_raw: &ImageBuf,
    log_exposure: &[f32],
    density_curves: &[[f32; 3]],
    gamma_factor: f32,
) -> ImageBuf {
    let norm_curves = normalize_density_curves(density_curves);
    interpolate_exposure_to_density(log_raw, &norm_curves, log_exposure, gamma_factor)
}

/// f64 variant of develop_simple — preserves full precision through curve interpolation.
/// Python parity: `develop_simple(log_raw, log_exposure, normalized_density_curves, gamma_factor)`.
pub fn develop_simple_f64(
    log_raw: &ImageBuf,
    log_exposure: &[f64],
    density_curves: &[[f64; 3]],
    gamma_factor: f64,
) -> ImageBuf {
    let norm_curves = crate::density_curves::normalize_density_curves_f64(density_curves);
    crate::density_curves::interpolate_exposure_to_density_f64(
        log_raw,
        &norm_curves,
        log_exposure,
        gamma_factor,
    )
}

/// Convert density → light transmittance.
/// Port of Python `density_to_light`: transmitted = 10^(-density) * light
pub fn density_to_light(density_spectral: &[f32], illuminant: &[f32]) -> Vec<f32> {
    density_spectral
        .iter()
        .zip(illuminant.iter())
        .map(|(&d, &light)| {
            let transmitted = 10.0f32.powf(-d) * light;
            if transmitted.is_nan() {
                0.0
            } else {
                transmitted
            }
        })
        .collect()
}
