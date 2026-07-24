use std::sync::OnceLock;

const SRGB_TO_LINEAR_CUTOFF: f32 = 0.04045;
const LINEAR_TO_SRGB_CUTOFF: f32 = 0.0031308;
const SRGB_ALPHA: f32 = 0.055;
const SRGB_SLOPE: f32 = 12.92;
const SRGB_GAMMA: f32 = 2.4;
const SRGB_INV_GAMMA: f32 = 1.0 / SRGB_GAMMA;

pub fn srgb_to_linear(value: f32) -> f32 {
    debug_assert!(
        value.is_finite(),
        "srgb_to_linear received non-finite input"
    );

    if value <= SRGB_TO_LINEAR_CUTOFF {
        value / SRGB_SLOPE
    } else {
        ((value + SRGB_ALPHA) / (1.0 + SRGB_ALPHA)).powf(SRGB_GAMMA)
    }
}

pub fn linear_to_srgb(value: f32) -> f32 {
    debug_assert!(
        value.is_finite(),
        "linear_to_srgb received non-finite input"
    );

    let clamped: f32 = value.clamp(0.0, 1.0);
    __encode(clamped)
}

pub fn linear_to_srgb_extended(value: f32) -> f32 {
    debug_assert!(
        value.is_finite(),
        "linear_to_srgb_extended received non-finite input"
    );

    let floored: f32 = value.max(0.0);
    __encode(floored)
}

pub fn srgb_to_linear_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut lut: [f32; 256] = [0.0f32; 256];
        for (i, entry) in lut.iter_mut().enumerate() {
            let code: f32 = i as f32 / 255.0;
            *entry = srgb_to_linear(code);
        }
        lut
    })
}

fn __encode(value: f32) -> f32 {
    debug_assert!(value >= 0.0, "__encode requires a non-negative input");

    if value <= LINEAR_TO_SRGB_CUTOFF {
        value * SRGB_SLOPE
    } else {
        (1.0 + SRGB_ALPHA) * value.powf(SRGB_INV_GAMMA) - SRGB_ALPHA
    }
}
