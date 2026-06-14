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

// ---------------------------------------------------------------------------------------------
// HDR encoders. Input is always LINEAR scene-referred Rgba<f32> (diffuse white = 1.0, headroom
// preserved). These apply the primaries conversion + transfer OETF, then encode + tag CICP.
// ---------------------------------------------------------------------------------------------

/// Map an export quality (0..=100) to a rav1e quantizer (0 = best). 100 -> 0 (near-lossless).
fn quality_to_quantizer(quality: u8) -> usize {
    let q = quality.min(100) as usize;
    ((100 - q) * 255 / 100).min(255)
}

/// Encode a linear `Rgba<f32>` image to a tagged HDR AVIF (10 or 12 bit).
///
/// Uses CICP matrix_coefficients = 0 (Identity / RGB) at 4:4:4 full-range: the planes carry the
/// RGB transfer-encoded codes directly (no YCbCr conversion, no chroma subsampling), so the
/// round-trip is exact for every color — not just neutrals. The AV1 spec stores identity planes
/// in G, B, R order. `primaries` is tagged AND applied (Rec.709->Rec.2020 matrix) to the pixels.
pub fn encode_avif_hdr(
    img: &ImageBuffer<Rgba<f32>, Vec<f32>>,
    bit_depth: u8,
    transfer: TransferFunction,
    primaries: ColorPrimaries,
    quality: u8,
) -> Result<Vec<u8>, String> {
    use rav1e::config::SpeedSettings;
    // Explicit imports (not a glob) so this module's own ColorPrimaries/TransferFunction enums
    // are not shadowed by rav1e's same-named enums.
    use rav1e::prelude::{
        ChromaSamplePosition, ChromaSampling, ColorDescription, Config, Context, EncoderConfig,
        EncoderStatus, PixelRange,
    };

    if bit_depth != 10 && bit_depth != 12 {
        return Err(format!(
            "AVIF HDR bit depth must be 10 or 12, got {bit_depth}"
        ));
    }
    if transfer == TransferFunction::Srgb {
        return Err("encode_avif_hdr requires a PQ or HLG transfer".into());
    }
    let w = img.width() as usize;
    let h = img.height() as usize;
    if w == 0 || h == 0 {
        return Err("cannot encode an empty image".into());
    }

    // linear -> primaries -> transfer code -> quantized u16, into G/B/R planes (identity order).
    let mut plane_g = vec![0u16; w * h];
    let mut plane_b = vec![0u16; w * h];
    let mut plane_r = vec![0u16; w * h];
    for (i, px) in img.pixels().enumerate() {
        let code = encode_pixel_linear_to_code([px.0[0], px.0[1], px.0[2]], primaries, transfer);
        plane_r[i] = quantize_full_range(code[0], bit_depth);
        plane_g[i] = quantize_full_range(code[1], bit_depth);
        plane_b[i] = quantize_full_range(code[2], bit_depth);
    }

    let mut enc = EncoderConfig::default();
    enc.width = w;
    enc.height = h;
    enc.bit_depth = bit_depth as usize;
    enc.chroma_sampling = ChromaSampling::Cs444;
    enc.chroma_sample_position = ChromaSamplePosition::Unknown;
    enc.still_picture = true;
    enc.pixel_range = PixelRange::Full;
    enc.color_description = Some(ColorDescription {
        color_primaries: match primaries {
            ColorPrimaries::Bt2020 => rav1e::prelude::ColorPrimaries::BT2020,
            ColorPrimaries::Srgb => rav1e::prelude::ColorPrimaries::BT709,
        },
        transfer_characteristics: match transfer {
            TransferFunction::Pq => rav1e::prelude::TransferCharacteristics::SMPTE2084,
            TransferFunction::Hlg => rav1e::prelude::TransferCharacteristics::HLG,
            TransferFunction::Srgb => unreachable!(),
        },
        matrix_coefficients: rav1e::prelude::MatrixCoefficients::Identity,
    });
    enc.quantizer = quality_to_quantizer(quality);
    enc.speed_settings = SpeedSettings::from_preset(6);

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(2);
    let cfg = Config::new().with_encoder_config(enc).with_threads(threads);
    let mut ctx: Context<u16> = cfg
        .new_context()
        .map_err(|e| format!("rav1e new_context failed: {e:?}"))?;

    let mut frame = ctx.new_frame();
    // Identity plane order: 0=G, 1=B, 2=R. copy_from_raw_u8 writes at the plane origin
    // (handles rav1e's internal padding), unlike a raw chunks_mut over the padded buffer.
    let to_le = |p: &[u16]| -> Vec<u8> { p.iter().flat_map(|v| v.to_le_bytes()).collect() };
    frame.planes[0].copy_from_raw_u8(&to_le(&plane_g), w * 2, 2);
    frame.planes[1].copy_from_raw_u8(&to_le(&plane_b), w * 2, 2);
    frame.planes[2].copy_from_raw_u8(&to_le(&plane_r), w * 2, 2);

    ctx.send_frame(std::sync::Arc::new(frame))
        .map_err(|e| format!("rav1e send_frame failed: {e:?}"))?;
    ctx.flush();

    let mut av1_obu: Vec<u8> = Vec::new();
    loop {
        match ctx.receive_packet() {
            Ok(pkt) => av1_obu.extend_from_slice(&pkt.data),
            Err(EncoderStatus::Encoded) => continue,
            Err(EncoderStatus::LimitReached) | Err(EncoderStatus::NeedMoreData) => break,
            Err(e) => return Err(format!("rav1e receive_packet failed: {e:?}")),
        }
    }

    use avif_serialize::Aviffy;
    use avif_serialize::constants::{
        ColorPrimaries as AvifPrimaries, MatrixCoefficients as AvifMatrix,
        TransferCharacteristics as AvifTransfer,
    };
    let mut aviffy = Aviffy::new();
    aviffy
        .set_color_primaries(match primaries {
            ColorPrimaries::Bt2020 => AvifPrimaries::Bt2020,
            ColorPrimaries::Srgb => AvifPrimaries::Bt709,
        })
        .set_transfer_characteristics(match transfer {
            TransferFunction::Pq => AvifTransfer::Smpte2084,
            TransferFunction::Hlg => AvifTransfer::Hlg,
            TransferFunction::Srgb => unreachable!(),
        })
        .set_matrix_coefficients(AvifMatrix::Rgb)
        .set_full_color_range(true)
        .set_bit_depth(bit_depth)
        .set_chroma_subsampling((false, false)); // 4:4:4

    Ok(aviffy.to_vec(&av1_obu, None, w as u32, h as u32, bit_depth))
}

/// Encode a linear `Rgba<f32>` image to a tagged HDR JPEG XL (PQ or HLG, Rec.2020), 32-bit float.
/// Requires the `hdr_jxl` feature (system libjxl). Feeds transfer-encoded f32 codes with
/// `uses_original_profile` so libjxl keeps our PQ/HLG color encoding instead of converting to XYB.
#[cfg(feature = "hdr_jxl")]
pub fn encode_jxl_hdr(
    img: &ImageBuffer<Rgba<f32>, Vec<f32>>,
    transfer: TransferFunction,
    primaries: ColorPrimaries,
    lossless: bool,
) -> Result<Vec<u8>, String> {
    use jpegxl_rs::encode::{ColorEncoding, EncoderFrame, EncoderResult, EncoderSpeed};
    use jpegxl_rs::encoder_builder;
    use jpegxl_sys::color::color_encoding::{
        JxlColorEncoding, JxlColorSpace, JxlPrimaries, JxlRenderingIntent, JxlTransferFunction,
        JxlWhitePoint,
    };

    if transfer == TransferFunction::Srgb {
        return Err("encode_jxl_hdr requires a PQ or HLG transfer".into());
    }
    let (w, h) = (img.width(), img.height());

    let mut rgb: Vec<f32> = Vec::with_capacity((w * h * 3) as usize);
    for px in img.pixels() {
        let code = encode_pixel_linear_to_code([px.0[0], px.0[1], px.0[2]], primaries, transfer);
        rgb.extend_from_slice(&code);
    }

    let color = JxlColorEncoding {
        color_space: JxlColorSpace::Rgb,
        white_point: JxlWhitePoint::D65,
        white_point_xy: [0.3127, 0.3290],
        primaries: match primaries {
            ColorPrimaries::Bt2020 => JxlPrimaries::Rec2100,
            ColorPrimaries::Srgb => JxlPrimaries::SRgb,
        },
        primaries_red_xy: [0.0, 0.0],
        primaries_green_xy: [0.0, 0.0],
        primaries_blue_xy: [0.0, 0.0],
        transfer_function: match transfer {
            TransferFunction::Pq => JxlTransferFunction::PQ,
            TransferFunction::Hlg => JxlTransferFunction::HLG,
            TransferFunction::Srgb => unreachable!(),
        },
        gamma: 0.0,
        rendering_intent: JxlRenderingIntent::Relative,
    };

    let mut encoder = encoder_builder()
        .has_alpha(false)
        .speed(EncoderSpeed::Squirrel)
        .uses_original_profile(true)
        .lossless(lossless)
        .color_encoding(ColorEncoding::Custom(color))
        .build()
        .map_err(|e| format!("jxl encoder build failed: {e}"))?;

    let frame = EncoderFrame::new(&rgb).num_channels(3);
    let result: EncoderResult<f32> = encoder
        .encode_frame(&frame, w, h)
        .map_err(|e| format!("jxl encode_frame failed: {e}"))?;
    Ok(result.data.to_vec())
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
