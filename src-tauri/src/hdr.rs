//! HDR color-science primitives for the PQ/HLG export path.
//!
//! Everything that maps RapidRAW's *linear scene-referred* pixels (diffuse white = 1.0,
//! headroom > 1.0 preserved) to a tagged HDR transfer encoding lives here, so that the
//! encoders (`export_processing.rs`) and the verification harness (`tests/hdr_export.rs`)
//! share ONE implementation of the math. Constants are pinned from SMPTE ST 2084 /
//! ITU-R BT.2100 and ISO 22028-5 — do not "tidy" them.
//!
//! Reference white anchor: per ISO 22028-5, diffuse/reference white (203 cd/m²) sits at
//! ~58% of the PQ code range. We map linear `1.0` -> 203 cd/m² -> `L = 203/10000` -> PQ.

// These are canonical reference constants (ST 2084 dyadic rationals, BT.2087 matrix) written at
// full published precision on purpose; truncating them to satisfy the lint would lose accuracy.
#![allow(clippy::excessive_precision)]

use image::{ImageBuffer, Rgba};

/// Linear `1.0` (diffuse white) maps to this absolute luminance.
pub const REFERENCE_WHITE_NITS: f32 = 203.0;
/// PQ is normalized so code `1.0` == this peak luminance.
pub const PQ_MAX_NITS: f32 = 10000.0;

// --- SMPTE ST 2084 (PQ) constants. Pinned; do not modify. ---
const PQ_M1: f32 = 0.1593017578125; // 2610/16384
const PQ_M2: f32 = 78.84375; // 2523/4096 * 128
const PQ_C1: f32 = 0.8359375; // 3424/4096
const PQ_C2: f32 = 18.8515625; // 2413/4096 * 32
const PQ_C3: f32 = 18.6875; // 2392/4096 * 32

/// PQ inverse-EOTF (a.k.a. OETF): normalized linear luminance `L` (1.0 == 10000 cd/m²)
/// -> non-linear PQ code in `[0, 1]`.
pub fn pq_inverse_eotf(l_norm: f32) -> f32 {
    let lp = l_norm.max(0.0).powf(PQ_M1);
    ((PQ_C1 + PQ_C2 * lp) / (1.0 + PQ_C3 * lp)).powf(PQ_M2)
}

/// PQ EOTF (decode): PQ code in `[0,1]` -> normalized linear luminance (1.0 == 10000 cd/m²).
/// Exact inverse of [`pq_inverse_eotf`]; used by the harness to reason about decoded codes.
pub fn pq_eotf(e: f32) -> f32 {
    let ep = e.clamp(0.0, 1.0).powf(1.0 / PQ_M2);
    let num = (ep - PQ_C1).max(0.0);
    let den = PQ_C2 - PQ_C3 * ep;
    if den <= 0.0 {
        return 1.0;
    }
    (num / den).powf(1.0 / PQ_M1)
}

/// Convenience: linear scene value (diffuse white = 1.0) -> PQ code, applying the 203-nit anchor.
pub fn linear_scene_to_pq(linear: f32) -> f32 {
    pq_inverse_eotf(linear * (REFERENCE_WHITE_NITS / PQ_MAX_NITS))
}

// --- ITU-R BT.2100 HLG OETF (scene-referred, normalized E in [0,1]). ---
const HLG_A: f32 = 0.17883277;
const HLG_B: f32 = 0.28466892;
const HLG_C: f32 = 0.55991073;

/// HLG OETF: scene-linear `E` in `[0,1]` -> HLG signal in `[0,1]`.
pub fn hlg_oetf(e: f32) -> f32 {
    let e = e.max(0.0);
    if e <= 1.0 / 12.0 {
        (3.0 * e).sqrt()
    } else {
        HLG_A * (12.0 * e - HLG_B).ln() + HLG_C
    }
}

/// HLG nominal peak is 12x diffuse white; normalize the scene by this so diffuse white
/// (linear 1.0) and headroom up to 12.0 fit the HLG `[0,1]` signal range.
pub const HLG_PEAK_RATIO: f32 = 12.0;

/// Convenience: linear scene value (diffuse white = 1.0) -> HLG signal.
/// NOTE: HLG is relative/scene-referred — unlike PQ it has no single absolute-nit anchor here.
pub fn linear_scene_to_hlg(linear: f32) -> f32 {
    hlg_oetf(linear / HLG_PEAK_RATIO)
}

/// Inverse of the shader's `linear_to_srgb_extended` (`shader.wgsl` L237) for c >= 0.
/// The HDR GPU variant stores extended-sRGB-encoded values with headroom; this recovers
/// the underlying linear light on readback. Matches `srgb_to_linear` (shader L220).
pub fn srgb_extended_to_linear(c: f32) -> f32 {
    let c = c.max(0.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Forward extended sRGB OETF (matches shader `linear_to_srgb_extended`); provided for tests.
pub fn linear_to_srgb_extended(c: f32) -> f32 {
    let c = c.max(0.0);
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// Linear Rec.709/sRGB primaries -> linear Rec.2020 primaries (BT.2087, D65, no adaptation).
/// White-preserving: each row sums to 1.0, so neutral (R=G=B) is unchanged — which is why the
/// harness's neutral patches hit the same PQ codes whether or not this is applied.
pub fn rec709_to_rec2020_linear(rgb: [f32; 3]) -> [f32; 3] {
    [
        0.627403896 * rgb[0] + 0.329283038 * rgb[1] + 0.043313066 * rgb[2],
        0.069097289 * rgb[0] + 0.919540395 * rgb[1] + 0.011362316 * rgb[2],
        0.016391439 * rgb[0] + 0.088013308 * rgb[1] + 0.895595253 * rgb[2],
    ]
}

/// Transfer function selector for HDR export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferFunction {
    /// Plain sRGB (the existing SDR path).
    Srgb,
    /// SMPTE ST 2084 (PQ). CICP transfer_characteristics = 16.
    Pq,
    /// ITU-R BT.2100 HLG. CICP transfer_characteristics = 18.
    Hlg,
}

/// Color primaries selector for HDR export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorPrimaries {
    /// Rec.709 / sRGB. CICP colour_primaries = 1.
    Srgb,
    /// Rec.2020. CICP colour_primaries = 9.
    Bt2020,
}

/// CICP code points (ISO/IEC 23091-2) for a given selection, plus matrix + range we target.
pub struct CicpTags {
    pub colour_primaries: u16,
    pub transfer_characteristics: u16,
    pub matrix_coefficients: u16,
    pub full_range: bool,
}

pub fn cicp_for(primaries: ColorPrimaries, transfer: TransferFunction) -> CicpTags {
    CicpTags {
        colour_primaries: match primaries {
            ColorPrimaries::Srgb => 1,
            ColorPrimaries::Bt2020 => 9,
        },
        transfer_characteristics: match transfer {
            TransferFunction::Srgb => 13, // IEC 61966-2-1 sRGB
            TransferFunction::Pq => 16,
            TransferFunction::Hlg => 18,
        },
        // BT.2020 non-constant luminance for HDR; we feed RGB and let the encoder build YCbCr.
        matrix_coefficients: match primaries {
            ColorPrimaries::Srgb => 1,   // BT.709
            ColorPrimaries::Bt2020 => 9, // BT.2020 NCL
        },
        full_range: true,
    }
}

/// Map a linear scene-referred pixel to a non-linear code in `[0,1]` for the chosen encoding,
/// including the primaries conversion. Alpha is passed through unchanged by callers.
pub fn encode_pixel_linear_to_code(
    rgb_linear: [f32; 3],
    primaries: ColorPrimaries,
    transfer: TransferFunction,
) -> [f32; 3] {
    let rgb = match primaries {
        ColorPrimaries::Srgb => rgb_linear,
        ColorPrimaries::Bt2020 => rec709_to_rec2020_linear(rgb_linear),
    };
    let f = |c: f32| match transfer {
        TransferFunction::Srgb => linear_to_srgb_extended(c),
        TransferFunction::Pq => linear_scene_to_pq(c),
        TransferFunction::Hlg => linear_scene_to_hlg(c),
    };
    [f(rgb[0]), f(rgb[1]), f(rgb[2])]
}

/// Quantize a `[0,1]` code to an integer at the given bit depth, full-range, round-to-nearest.
pub fn quantize_full_range(code: f32, bit_depth: u8) -> u16 {
    let max = ((1u32 << bit_depth) - 1) as f32;
    (code.clamp(0.0, 1.0) * max + 0.5).floor() as u16
}

// ---------------------------------------------------------------------------------------------
// Synthetic test input (linear light, scene-referred, diffuse white = 1.0).
// ---------------------------------------------------------------------------------------------

/// A synthetic HDR test image plus the pixel coordinates of each known patch, so the harness
/// can sample exact values after a full encode->decode round-trip.
pub struct SyntheticInput {
    pub image: ImageBuffer<Rgba<f32>, Vec<f32>>,
    /// Diffuse/reference white: linear 1.0 (-> 203 nits -> PQ ~0.5807).
    pub diffuse_white_px: (u32, u32),
    /// Above diffuse white: linear 2.0 (-> 406 nits).
    pub rel2_px: (u32, u32),
    /// Above diffuse white: linear 4.0 (-> 812 nits).
    pub rel4_px: (u32, u32),
    /// Black: linear 0.0.
    pub black_px: (u32, u32),
    /// Midpoints of a 0.0 -> 1.0 ramp (left to right), for monotonicity checks.
    pub ramp_px: Vec<(u32, u32)>,
    pub width: u32,
    pub height: u32,
}

/// Build the synthetic input: four flat patches (black, diffuse white, 2x, 4x) followed by a
/// 0->1 linear ramp. Neutral grey (R=G=B) throughout so values are primaries-invariant.
pub fn synthetic_linear_image() -> SyntheticInput {
    let height: u32 = 8;
    let patch_w: u32 = 16;
    let ramp_w: u32 = 64;
    let width = patch_w * 4 + ramp_w; // 128

    let mut image = ImageBuffer::<Rgba<f32>, Vec<f32>>::new(width, height);

    let patch_value = |idx: u32| -> f32 {
        match idx {
            0 => 0.0, // black
            1 => 1.0, // diffuse white
            2 => 2.0, // 2x headroom
            3 => 4.0, // 4x headroom
            _ => 0.0,
        }
    };

    for y in 0..height {
        for x in 0..width {
            let v = if x < patch_w * 4 {
                patch_value(x / patch_w)
            } else {
                // ramp 0..1 across ramp_w
                let t = (x - patch_w * 4) as f32 / (ramp_w as f32 - 1.0);
                t.clamp(0.0, 1.0)
            };
            image.put_pixel(x, y, Rgba([v, v, v, 1.0]));
        }
    }

    let cy = height / 2;
    let center = |idx: u32| (idx * patch_w + patch_w / 2, cy);
    let ramp_px = (0..4)
        .map(|i| (patch_w * 4 + 4 + i * ((ramp_w - 8) / 3), cy))
        .collect();

    SyntheticInput {
        image,
        black_px: center(0),
        diffuse_white_px: center(1),
        rel2_px: center(2),
        rel4_px: center(3),
        ramp_px,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent ground-truth: pinned literal from the brief / ISO 22028-5.
    #[test]
    fn pq_reference_white_is_about_058() {
        let l = REFERENCE_WHITE_NITS / PQ_MAX_NITS; // 0.0203
        let code = pq_inverse_eotf(l);
        assert!(
            (code - 0.580689).abs() < 1e-4,
            "203-nit PQ code = {code}, expected ~0.580689"
        );
        // 10-bit full-range code lands at 594 (brief says ~593; <1 code, within tolerance).
        let code10 = quantize_full_range(code, 10);
        assert!(
            (code10 as i32 - 593).abs() <= 2,
            "10-bit ref-white code = {code10}, expected within 2 of 593"
        );
    }

    #[test]
    fn pq_roundtrip_is_stable() {
        for &l in &[0.0f32, 0.001, 0.0203, 0.0406, 0.0812, 0.5, 1.0] {
            let back = pq_eotf(pq_inverse_eotf(l));
            assert!((back - l).abs() < 1e-4, "PQ roundtrip {l} -> {back}");
        }
    }

    #[test]
    fn headroom_codes_strictly_increase() {
        let c1 = linear_scene_to_pq(1.0);
        let c2 = linear_scene_to_pq(2.0);
        let c4 = linear_scene_to_pq(4.0);
        assert!(c1 < c2 && c2 < c4, "codes not increasing: {c1} {c2} {c4}");
        assert!(c4 < 1.0, "4x must stay below PQ full scale, got {c4}");
        // and as quantized 10-bit codes they must remain distinct
        let q = |c: f32| quantize_full_range(c, 10);
        assert!(q(c1) < q(c2) && q(c2) < q(c4));
    }

    #[test]
    fn srgb_extended_inverts_cleanly_with_headroom() {
        for &c in &[0.0f32, 0.5, 1.0, 2.0, 4.0] {
            let round =
                linear_to_srgb_extended(srgb_extended_to_linear(linear_to_srgb_extended(c)));
            let direct = linear_to_srgb_extended(c);
            assert!((round - direct).abs() < 1e-4);
        }
        // headroom survives the linear<->srgb roundtrip
        let lin = srgb_extended_to_linear(linear_to_srgb_extended(4.0));
        assert!((lin - 4.0).abs() < 1e-3, "headroom lost: {lin}");
    }

    #[test]
    fn rec2020_matrix_preserves_neutral() {
        let n = rec709_to_rec2020_linear([0.5, 0.5, 0.5]);
        for c in n {
            assert!((c - 0.5).abs() < 1e-5, "neutral not preserved: {c}");
        }
    }

    #[test]
    fn synthetic_input_has_expected_patches() {
        let s = synthetic_linear_image();
        assert_eq!(
            s.image
                .get_pixel(s.diffuse_white_px.0, s.diffuse_white_px.1)
                .0[0],
            1.0
        );
        assert_eq!(s.image.get_pixel(s.rel2_px.0, s.rel2_px.1).0[0], 2.0);
        assert_eq!(s.image.get_pixel(s.rel4_px.0, s.rel4_px.1).0[0], 4.0);
        assert_eq!(s.image.get_pixel(s.black_px.0, s.black_px.1).0[0], 0.0);
    }
}
