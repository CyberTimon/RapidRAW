/// Precision type alias for the pixel pipeline.
///
/// Default: f32 for GPU speed and memory efficiency.
/// With `--features precision-f64`: f64 for 1:1 parity with Python.
///
/// The calibration chain (Hanatos2025 tc/b, CAT02 adaptation, exposure factor)
/// always uses f64 regardless of this flag.

#[cfg(feature = "precision-f64")]
pub type Scalar = f64;
#[cfg(not(feature = "precision-f64"))]
pub type Scalar = f32;

/// Convert f64 to Scalar (no-op in f64 mode, truncation in f32 mode).
#[inline(always)]
pub fn from_f64(v: f64) -> Scalar {
    v as Scalar
}

/// Convert Scalar to f64 (no-op in f64 mode, promotion in f32 mode).
#[inline(always)]
pub fn to_f64(v: Scalar) -> f64 {
    v as f64
}

/// Convert f32 to Scalar.
#[inline(always)]
pub fn from_f32(v: f32) -> Scalar {
    v as Scalar
}

/// Convert Scalar to f32.
#[inline(always)]
pub fn to_f32(v: Scalar) -> f32 {
    v as f32
}

/// Zero constant.
pub const ZERO: Scalar = 0.0;
/// One constant.
pub const ONE: Scalar = 1.0;

/// Scalar-aware pow(10, x).
#[inline(always)]
pub fn pow10(x: Scalar) -> Scalar {
    from_f64(10.0).powf(x)
}

/// Scalar-aware log10.
#[inline(always)]
pub fn log10(x: Scalar) -> Scalar {
    x.log10()
}

/// Scalar-aware powf.
#[inline(always)]
pub fn powf(base: Scalar, exp: Scalar) -> Scalar {
    base.powf(exp)
}

/// sRGB OETF (linear → gamma) for Scalar.
#[inline(always)]
pub fn srgb_encode(x: Scalar) -> Scalar {
    let threshold = from_f64(0.0031308);
    if x <= threshold {
        from_f64(12.92) * x
    } else {
        from_f64(1.055) * powf(x, from_f64(1.0 / 2.4)) - from_f64(0.055)
    }
}

/// sRGB EOTF (gamma → linear) for Scalar.
#[inline(always)]
pub fn srgb_decode(x: Scalar) -> Scalar {
    let threshold = from_f64(0.04045);
    if x <= threshold {
        x / from_f64(12.92)
    } else {
        powf((x + from_f64(0.055)) / from_f64(1.055), from_f64(2.4))
    }
}
