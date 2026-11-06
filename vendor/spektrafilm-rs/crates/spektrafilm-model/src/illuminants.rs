/// Spectral illuminant models.
///
/// Blackbody (Planck's law), tungsten-halogen, CIE D-series.
use spektrafilm_math::spectral::{N_WAVELENGTHS, WAVELENGTH_MIN, WAVELENGTH_STEP};

/// Planck's law: spectral radiance at wavelength (nm) and temperature (K).
#[inline]
pub fn blackbody_radiance(wavelength_nm: f32, temperature_k: f32) -> f32 {
    const H: f64 = 6.62607015e-34; // Planck constant (J·s)
    const C: f64 = 2.99792458e8; // Speed of light (m/s)
    const K: f64 = 1.380649e-23; // Boltzmann constant (J/K)

    let lambda_m = wavelength_nm as f64 * 1e-9;
    let t = temperature_k as f64;

    let numerator = 2.0 * H * C * C / (lambda_m.powi(5));
    let exponent = H * C / (lambda_m * K * t);
    let denominator = exponent.exp() - 1.0;

    (numerator / denominator) as f32
}

/// Generate a full blackbody SPD (81 wavelengths, 380-780nm at 5nm).
pub fn blackbody_spd(temperature_k: f32) -> [f32; N_WAVELENGTHS] {
    let mut spd = [0.0f32; N_WAVELENGTHS];
    for i in 0..N_WAVELENGTHS {
        let wl = WAVELENGTH_MIN + (i as f32) * WAVELENGTH_STEP;
        spd[i] = blackbody_radiance(wl, temperature_k);
    }

    // Normalize to peak = 1.0
    let max = spd.iter().cloned().fold(0.0f32, f32::max);
    if max > 0.0 {
        for v in &mut spd {
            *v /= max;
        }
    }
    spd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blackbody_peak_shifts_with_temperature() {
        // Wien's law: peak wavelength decreases with temperature
        let spd_3000 = blackbody_spd(3000.0);
        let spd_6500 = blackbody_spd(6500.0);

        let peak_3000 = spd_3000
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        let peak_6500 = spd_6500
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;

        // 3000K peak should be at longer wavelength than 6500K
        assert!(peak_3000 > peak_6500);
    }

    #[test]
    fn test_blackbody_normalized() {
        let spd = blackbody_spd(5500.0);
        let max = spd.iter().cloned().fold(0.0f32, f32::max);
        assert!((max - 1.0).abs() < 1e-6);
    }
}
