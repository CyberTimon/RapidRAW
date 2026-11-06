/// H-D (Hurter-Driffield) characteristic curve interpolation.
///
/// Maps log exposure → density for each CMY channel using the
/// per-profile density curve tables.
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::interp;

/// Interpolate density from log exposure for a single pixel value.
#[inline]
pub fn interpolate_density(
    log_exposure_axis: &[f32],
    density_curves: &[[f32; 3]],
    log_exp: f32,
    gamma: f32,
) -> [f32; 3] {
    if (gamma - 1.0).abs() < 1e-6 {
        interp::interp_uniform_3ch(
            log_exposure_axis[0],
            *log_exposure_axis.last().unwrap(),
            density_curves,
            log_exp,
        )
    } else {
        // Per-channel gamma: scale the x-axis by 1/gamma per channel
        // In Python: log_exposure[:,None]/gamma_factor[None,:]
        // This means we query at log_exp but on a stretched x-axis
        let x_min = log_exposure_axis[0];
        let x_max = *log_exposure_axis.last().unwrap();
        [
            interp::interp_uniform(
                x_min / gamma,
                x_max / gamma,
                &extract_col(density_curves, 0),
                log_exp,
            ),
            interp::interp_uniform(
                x_min / gamma,
                x_max / gamma,
                &extract_col(density_curves, 1),
                log_exp,
            ),
            interp::interp_uniform(
                x_min / gamma,
                x_max / gamma,
                &extract_col(density_curves, 2),
                log_exp,
            ),
        ]
    }
}

/// f64 variant — preserves precision through the interpolation.
pub fn interpolate_exposure_to_density_f64(
    log_raw: &ImageBuf,
    density_curves: &[[f64; 3]],
    log_exposure: &[f64],
    gamma_factor: f64,
) -> ImageBuf {
    if (gamma_factor - 1.0).abs() < 1e-12 {
        interp::fast_interp_image_f64(log_raw, log_exposure, density_curves)
    } else {
        let x_axes: Vec<[f64; 3]> = log_exposure
            .iter()
            .map(|&le| [le / gamma_factor, le / gamma_factor, le / gamma_factor])
            .collect();
        interp::fast_interp_image_perchannel_f64(log_raw, &x_axes, density_curves)
    }
}

/// Interpolate density for a full image. Port of Python `interpolate_exposure_to_density`.
pub fn interpolate_exposure_to_density(
    log_raw: &ImageBuf,
    density_curves: &[[f32; 3]],
    log_exposure: &[f32],
    gamma_factor: f32,
) -> ImageBuf {
    if (gamma_factor - 1.0).abs() < 1e-6 {
        interp::fast_interp_image(log_raw, log_exposure, density_curves)
    } else {
        // Build per-channel x-axes: log_exposure / gamma_factor
        let x_axes: Vec<[f32; 3]> = log_exposure
            .iter()
            .map(|&le| [le / gamma_factor, le / gamma_factor, le / gamma_factor])
            .collect();
        interp::fast_interp_image_perchannel(log_raw, &x_axes, density_curves)
    }
}

/// f64 variant — normalize density curves by subtracting the per-channel minimum.
pub fn normalize_density_curves_f64(curves: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut min = [f64::INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] < min[c] {
                min[c] = row[c];
            }
        }
    }
    curves
        .iter()
        .map(|row| [row[0] - min[0], row[1] - min[1], row[2] - min[2]])
        .collect()
}

/// Normalize density curves by subtracting the per-channel minimum.
pub fn normalize_density_curves(curves: &[[f32; 3]]) -> Vec<[f32; 3]> {
    let mut min = [f32::INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] < min[c] {
                min[c] = row[c];
            }
        }
    }
    curves
        .iter()
        .map(|row| [row[0] - min[0], row[1] - min[1], row[2] - min[2]])
        .collect()
}

/// Get max density per channel from curves.
pub fn max_density(curves: &[[f32; 3]]) -> [f32; 3] {
    let mut max = [f32::NEG_INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] > max[c] {
                max[c] = row[c];
            }
        }
    }
    max
}

/// Get max density per channel from f64 curves — Python parity for grain
/// which reads the profile's f64 `density_curves` directly.
pub fn max_density_f64(curves: &[[f64; 3]]) -> [f64; 3] {
    let mut max = [f64::NEG_INFINITY; 3];
    for row in curves {
        for c in 0..3 {
            if row[c].is_finite() && row[c] > max[c] {
                max[c] = row[c];
            }
        }
    }
    max
}

fn extract_col(data: &[[f32; 3]], c: usize) -> Vec<f32> {
    data.iter().map(|row| row[c]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interpolate_density_midpoint() {
        let axis: Vec<f32> = (0..5).map(|i| i as f32).collect();
        let curves = vec![
            [0.0, 0.0, 0.0],
            [0.5, 0.4, 0.3],
            [1.0, 0.8, 0.6],
            [1.5, 1.2, 0.9],
            [2.0, 1.6, 1.2],
        ];
        let d = interpolate_density(&axis, &curves, 1.5, 1.0);
        assert!((d[0] - 0.75).abs() < 1e-5);
        assert!((d[1] - 0.60).abs() < 1e-5);
        assert!((d[2] - 0.45).abs() < 1e-5);
    }

    #[test]
    fn test_normalize_density_curves() {
        let curves = vec![[1.0, 2.0, 3.0], [2.0, 3.0, 4.0]];
        let norm = normalize_density_curves(&curves);
        assert_eq!(norm[0], [0.0, 0.0, 0.0]);
        assert_eq!(norm[1], [1.0, 1.0, 1.0]);
    }

    #[test]
    fn test_max_density() {
        let curves = vec![[0.1, 0.2, 0.3], [2.0, 1.5, 1.0], [1.5, 1.8, 0.8]];
        let max = max_density(&curves);
        assert_eq!(max, [2.0, 1.8, 1.0]);
    }
}
