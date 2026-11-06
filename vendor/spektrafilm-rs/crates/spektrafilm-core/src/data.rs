pub use spektrafilm_math::colorspace::{
    ACES_TO_XYZ, D50_XYZ, D55_XYZ, D65_XYZ, PROPHOTO_TO_XYZ, REC2020_TO_XYZ, SRGB_TO_XYZ,
    XYZ_TO_ACES, XYZ_TO_PROPHOTO, XYZ_TO_REC2020, XYZ_TO_SRGB,
};
/// Re-export baked spectral constants from spektrafilm-math.
pub use spektrafilm_math::spectral::{
    CMF_X, CMF_Y, CMF_Z, ILLUMINANT_D50, ILLUMINANT_D55, ILLUMINANT_D65, N_WAVELENGTHS,
    WAVELENGTH_MAX, WAVELENGTH_MIN, WAVELENGTH_STEP,
};

/// Log exposure axis: 256 uniformly spaced values from -3 to +4 EV.
/// Matches Python `config.LOG_EXPOSURE = np.linspace(-3, 4, 256)`.
pub const LOG_EXPOSURE_MIN: f32 = -3.0;
pub const LOG_EXPOSURE_MAX: f32 = 4.0;
pub const LOG_EXPOSURE_LEN: usize = 256;
