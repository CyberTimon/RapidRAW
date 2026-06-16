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

/// Max frame width for 4:2:2 AVIF: rav1e only encodes 4:2:2 conformantly as a single AV1 tile,
/// and AV1 caps a tile at 4096 px wide. (The frontend mirrors this to auto-cap 4:2:2 exports.)
pub const AVIF_422_MAX_WIDTH: usize = 4096;
/// Max frame area (pixels) for 4:2:2 AVIF: AV1's single-tile area cap, 4096 * 2304.
pub const AVIF_422_MAX_PIXELS: usize = 4096 * 2304; // 9_437_184

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

/// Linear scene value (diffuse white = 1.0) -> PQ code, anchoring diffuse white at
/// `reference_white_nits`.
pub fn linear_scene_to_pq_with(linear: f32, reference_white_nits: f32) -> f32 {
    pq_inverse_eotf(linear * (reference_white_nits / PQ_MAX_NITS))
}

/// Convenience: linear scene value (diffuse white = 1.0) -> PQ code, applying the 203-nit anchor.
pub fn linear_scene_to_pq(linear: f32) -> f32 {
    linear_scene_to_pq_with(linear, REFERENCE_WHITE_NITS)
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

/// Linear scene value (diffuse white = 1.0) -> HLG signal, normalizing by `peak_ratio`
/// (headroom above diffuse white that fits the HLG `[0,1]` signal range).
pub fn linear_scene_to_hlg_with(linear: f32, peak_ratio: f32) -> f32 {
    hlg_oetf(linear / peak_ratio)
}

/// Convenience: linear scene value (diffuse white = 1.0) -> HLG signal.
/// NOTE: HLG is relative/scene-referred — unlike PQ it has no single absolute-nit anchor here.
pub fn linear_scene_to_hlg(linear: f32) -> f32 {
    linear_scene_to_hlg_with(linear, HLG_PEAK_RATIO)
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

/// Linear Rec.709/sRGB primaries -> linear Display-P3 primaries (D65, no adaptation).
/// White-preserving: each row sums to 1.0, so neutral (R=G=B) is unchanged.
pub fn rec709_to_displayp3_linear(rgb: [f32; 3]) -> [f32; 3] {
    [
        0.822461969 * rgb[0] + 0.177538031 * rgb[1] + 0.0 * rgb[2],
        0.033194199 * rgb[0] + 0.966805801 * rgb[1] + 0.0 * rgb[2],
        0.017082631 * rgb[0] + 0.072397073 * rgb[1] + 0.910520296 * rgb[2],
    ]
}

/// Transfer function selector for HDR export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferFunction {
    /// Plain sRGB (the existing SDR path).
    #[default]
    Srgb,
    /// SMPTE ST 2084 (PQ). CICP transfer_characteristics = 16.
    Pq,
    /// ITU-R BT.2100 HLG. CICP transfer_characteristics = 18.
    Hlg,
}

/// Color primaries selector for HDR export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorPrimaries {
    /// Rec.709 / sRGB. CICP colour_primaries = 1.
    #[default]
    Srgb,
    /// Rec.2020. CICP colour_primaries = 9.
    Bt2020,
    /// Display-P3 (D65). CICP colour_primaries = 12.
    #[serde(rename = "displayp3")]
    DisplayP3,
}

/// AVIF plane layout: store RGB directly (identity matrix) or convert to non-constant-luminance
/// Y'CbCr. Identity is exact for every color (no chroma subsampling); YCbCr matches conventional
/// HDR pipelines and allows chroma subsampling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatrixMode {
    /// CICP matrix_coefficients = 0 (RGB / GBR planes), forced 4:4:4.
    #[default]
    Identity,
    /// Non-constant-luminance Y'CbCr (BT.709 or BT.2020 NCL depending on primaries).
    Ycbcr,
}

/// Chroma subsampling for the YCbCr path (ignored / forced to 4:4:4 for the identity matrix).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum ChromaSubsampling {
    /// No subsampling.
    #[default]
    #[serde(rename = "444")]
    Cs444,
    /// Horizontal 2:1.
    #[serde(rename = "422")]
    Cs422,
    /// 2x2.
    #[serde(rename = "420")]
    Cs420,
}

/// Quantization range: full (0..2^n-1) or limited/"video" (16..235-scaled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DynamicRange {
    /// Full range: luma 0..max, chroma symmetric around max/2.
    #[default]
    Full,
    /// Limited / studio range: luma 16..235 (scaled by bit depth), chroma 16..240.
    Limited,
}

/// Fully-specified HDR encode configuration. `Default` reproduces the historical default path
/// (identity matrix, 4:4:4, full range, 203-nit anchor, HLG peak ratio 12, quality 100, no
/// mastering metadata) so existing outputs and tests are unchanged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HdrEncodeConfig {
    pub bit_depth: u8,
    pub transfer: TransferFunction,
    pub primaries: ColorPrimaries,
    pub matrix: MatrixMode,
    pub subsampling: ChromaSubsampling,
    pub range: DynamicRange,
    pub reference_white_nits: f32,
    pub hlg_peak_ratio: f32,
    pub quality: u8,
    pub mastering_metadata: bool,
}

impl Default for HdrEncodeConfig {
    fn default() -> Self {
        Self {
            bit_depth: 10,
            transfer: TransferFunction::Pq,
            primaries: ColorPrimaries::Srgb,
            matrix: MatrixMode::Identity,
            subsampling: ChromaSubsampling::Cs444,
            range: DynamicRange::Full,
            reference_white_nits: REFERENCE_WHITE_NITS,
            hlg_peak_ratio: HLG_PEAK_RATIO,
            quality: 100,
            mastering_metadata: false,
        }
    }
}

impl HdrEncodeConfig {
    /// Clamp out-of-range luminance anchors to their canonical defaults. The single owner of that
    /// rule, shared by the AVIF and JXL paths (JXL needs only this; the AVIF [`Self::sanitized`]
    /// additionally validates bit depth and forces 4:4:4 for the identity matrix).
    pub(crate) fn clamp_anchors(&mut self) {
        if self.reference_white_nits <= 0.0 || !self.reference_white_nits.is_finite() {
            self.reference_white_nits = REFERENCE_WHITE_NITS;
        }
        if self.hlg_peak_ratio <= 0.0 || !self.hlg_peak_ratio.is_finite() {
            self.hlg_peak_ratio = HLG_PEAK_RATIO;
        }
    }

    /// Sanitize the config for the AVIF path: clamp out-of-range anchors, force 4:4:4 for the
    /// identity matrix, and validate the bit depth. Returns `Err` for unsupported AVIF bit depths.
    pub fn sanitized(mut self) -> Result<Self, String> {
        if self.bit_depth != 10 && self.bit_depth != 12 {
            return Err(format!(
                "AVIF HDR bit depth must be 10 or 12, got {}",
                self.bit_depth
            ));
        }
        self.clamp_anchors();
        if self.matrix == MatrixMode::Identity {
            self.subsampling = ChromaSubsampling::Cs444;
        }
        Ok(self)
    }
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
            ColorPrimaries::DisplayP3 => 12,
        },
        transfer_characteristics: match transfer {
            TransferFunction::Srgb => 13, // IEC 61966-2-1 sRGB
            TransferFunction::Pq => 16,
            TransferFunction::Hlg => 18,
        },
        // BT.2020 non-constant luminance for HDR; we feed RGB and let the encoder build YCbCr.
        matrix_coefficients: match primaries {
            ColorPrimaries::Srgb | ColorPrimaries::DisplayP3 => 1, // BT.709
            ColorPrimaries::Bt2020 => 9,                           // BT.2020 NCL
        },
        full_range: true,
    }
}

/// Convert a linear RGB triple from Rec.709/sRGB primaries to the target primaries (white-
/// preserving). sRGB target is identity.
pub fn convert_primaries(rgb_linear: [f32; 3], primaries: ColorPrimaries) -> [f32; 3] {
    match primaries {
        ColorPrimaries::Srgb => rgb_linear,
        ColorPrimaries::Bt2020 => rec709_to_rec2020_linear(rgb_linear),
        ColorPrimaries::DisplayP3 => rec709_to_displayp3_linear(rgb_linear),
    }
}

/// Apply the transfer OETF for `transfer` to a single linear channel, parameterized by the PQ
/// reference-white anchor and the HLG peak ratio.
pub fn apply_transfer(
    c: f32,
    transfer: TransferFunction,
    reference_white_nits: f32,
    hlg_peak_ratio: f32,
) -> f32 {
    match transfer {
        TransferFunction::Srgb => linear_to_srgb_extended(c),
        TransferFunction::Pq => linear_scene_to_pq_with(c, reference_white_nits),
        TransferFunction::Hlg => linear_scene_to_hlg_with(c, hlg_peak_ratio),
    }
}

/// Map a linear scene-referred pixel to a non-linear R'G'B' code in `[0,1]` for the chosen
/// encoding, including the primaries conversion, parameterized by the anchor / peak ratio.
pub fn encode_pixel_linear_to_code_with(
    rgb_linear: [f32; 3],
    primaries: ColorPrimaries,
    transfer: TransferFunction,
    reference_white_nits: f32,
    hlg_peak_ratio: f32,
) -> [f32; 3] {
    let rgb = convert_primaries(rgb_linear, primaries);
    let f = |c: f32| apply_transfer(c, transfer, reference_white_nits, hlg_peak_ratio);
    [f(rgb[0]), f(rgb[1]), f(rgb[2])]
}

/// Map a linear scene-referred pixel to a non-linear code in `[0,1]` for the chosen encoding,
/// including the primaries conversion, using the default 203-nit / 12x anchors. Alpha is passed
/// through unchanged by callers.
pub fn encode_pixel_linear_to_code(
    rgb_linear: [f32; 3],
    primaries: ColorPrimaries,
    transfer: TransferFunction,
) -> [f32; 3] {
    encode_pixel_linear_to_code_with(
        rgb_linear,
        primaries,
        transfer,
        REFERENCE_WHITE_NITS,
        HLG_PEAK_RATIO,
    )
}

/// Quantize a `[0,1]` code to an integer at the given bit depth, full-range, round-to-nearest.
pub fn quantize_full_range(code: f32, bit_depth: u8) -> u16 {
    let max = ((1u32 << bit_depth) - 1) as f32;
    (code.clamp(0.0, 1.0) * max + 0.5).floor() as u16
}

/// Quantize a luma-like `[0,1]` code (Y' for YCbCr, or each R/G/B channel for the identity
/// matrix) to an integer at `bit_depth`, applying the chosen dynamic range. Round-to-nearest,
/// clamped to `[0, 2^n-1]`.
pub fn quantize_luma(code: f32, bit_depth: u8, range: DynamicRange) -> u16 {
    let max = ((1u32 << bit_depth) - 1) as i32;
    let v = match range {
        DynamicRange::Full => (code * max as f32).round() as i32,
        DynamicRange::Limited => {
            let s = (1u32 << (bit_depth - 8)) as f32;
            (code * 219.0 * s + 16.0 * s).round() as i32
        }
    };
    v.clamp(0, max) as u16
}

/// Quantize a chroma value (`Cb`/`Cr` in `[-0.5, 0.5]`) to an integer at `bit_depth`, applying
/// the chosen dynamic range. Round-to-nearest, clamped to `[0, 2^n-1]`.
pub fn quantize_chroma(code: f32, bit_depth: u8, range: DynamicRange) -> u16 {
    let max = ((1u32 << bit_depth) - 1) as i32;
    let v = match range {
        DynamicRange::Full => ((code + 0.5) * max as f32).round() as i32,
        DynamicRange::Limited => {
            let s = (1u32 << (bit_depth - 8)) as f32;
            (code * 224.0 * s + 128.0 * s).round() as i32
        }
    };
    v.clamp(0, max) as u16
}

/// Non-constant-luminance Y'CbCr matrix coefficients (Kr, Kg, Kb) plus the Cb/Cr normalizing
/// denominators, selected by primaries: BT.2020 NCL for Rec.2020, BT.709 NCL otherwise.
pub fn ycbcr_coefficients(primaries: ColorPrimaries) -> (f32, f32, f32, f32, f32) {
    match primaries {
        ColorPrimaries::Bt2020 => (0.2627, 0.6780, 0.0593, 1.8814, 1.4746),
        ColorPrimaries::Srgb | ColorPrimaries::DisplayP3 => {
            (0.2126, 0.7152, 0.0722, 1.8556, 1.5748)
        }
    }
}

/// Convert a non-linear R'G'B' code triple to non-constant-luminance Y'CbCr. `Y` lands in
/// `[0,1]`; `Cb`/`Cr` land in `[-0.5, 0.5]`.
pub fn rgb_prime_to_ycbcr(rgb_prime: [f32; 3], primaries: ColorPrimaries) -> [f32; 3] {
    let (kr, kg, kb, cb_denom, cr_denom) = ycbcr_coefficients(primaries);
    let [r, g, b] = rgb_prime;
    let y = kr * r + kg * g + kb * b;
    let cb = (b - y) / cb_denom;
    let cr = (r - y) / cr_denom;
    [y, cb, cr]
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

/// The three quantized planes plus their layout, ready to feed rav1e.
struct AvifPlanes {
    /// Plane 0. Identity: G'. YCbCr: Y'. Full width x height.
    p0: Vec<u16>,
    /// Plane 1. Identity: B'. YCbCr: Cb (possibly subsampled).
    p1: Vec<u16>,
    /// Plane 2. Identity: R'. YCbCr: Cr (possibly subsampled).
    p2: Vec<u16>,
    /// Chroma plane dimensions (== luma for identity / 4:4:4).
    chroma_w: usize,
    chroma_h: usize,
}

/// Average a chroma plane into the requested subsampling layout (input is full-resolution).
fn subsample_chroma(
    full: &[f32],
    w: usize,
    h: usize,
    subsampling: ChromaSubsampling,
) -> (Vec<f32>, usize, usize) {
    match subsampling {
        ChromaSubsampling::Cs444 => (full.to_vec(), w, h),
        ChromaSubsampling::Cs422 => {
            let cw = w.div_ceil(2);
            let mut out = vec![0.0f32; cw * h];
            for y in 0..h {
                for cx in 0..cw {
                    let x0 = cx * 2;
                    let x1 = (x0 + 1).min(w - 1);
                    out[y * cw + cx] = 0.5 * (full[y * w + x0] + full[y * w + x1]);
                }
            }
            (out, cw, h)
        }
        ChromaSubsampling::Cs420 => {
            let cw = w.div_ceil(2);
            let ch = h.div_ceil(2);
            let mut out = vec![0.0f32; cw * ch];
            for cy in 0..ch {
                let y0 = cy * 2;
                let y1 = (y0 + 1).min(h - 1);
                for cx in 0..cw {
                    let x0 = cx * 2;
                    let x1 = (x0 + 1).min(w - 1);
                    let sum = full[y0 * w + x0]
                        + full[y0 * w + x1]
                        + full[y1 * w + x0]
                        + full[y1 * w + x1];
                    out[cy * cw + cx] = sum * 0.25;
                }
            }
            (out, cw, ch)
        }
    }
}

/// Build the quantized AVIF planes for the chosen matrix mode / range / subsampling.
fn build_avif_planes(img: &ImageBuffer<Rgba<f32>, Vec<f32>>, cfg: &HdrEncodeConfig) -> AvifPlanes {
    let w = img.width() as usize;
    let h = img.height() as usize;
    let n = w * h;

    // linear -> primaries -> transfer -> R'G'B' code in [0,1].
    let mut rgb_prime = vec![[0.0f32; 3]; n];
    for (i, px) in img.pixels().enumerate() {
        rgb_prime[i] = encode_pixel_linear_to_code_with(
            [px.0[0], px.0[1], px.0[2]],
            cfg.primaries,
            cfg.transfer,
            cfg.reference_white_nits,
            cfg.hlg_peak_ratio,
        );
    }

    match cfg.matrix {
        MatrixMode::Identity => {
            // Identity (matrix=0) stores RGB in G,B,R plane order, full 4:4:4. Quantize each
            // channel with the luma range formula.
            let mut p0 = vec![0u16; n]; // G'
            let mut p1 = vec![0u16; n]; // B'
            let mut p2 = vec![0u16; n]; // R'
            for (i, c) in rgb_prime.iter().enumerate() {
                p2[i] = quantize_luma(c[0], cfg.bit_depth, cfg.range); // R'
                p0[i] = quantize_luma(c[1], cfg.bit_depth, cfg.range); // G'
                p1[i] = quantize_luma(c[2], cfg.bit_depth, cfg.range); // B'
            }
            AvifPlanes {
                p0,
                p1,
                p2,
                chroma_w: w,
                chroma_h: h,
            }
        }
        MatrixMode::Ycbcr => {
            // Non-constant-luminance Y'CbCr. Build full-res Cb/Cr, subsample, then quantize.
            let mut y_plane = vec![0u16; n];
            let mut cb_full = vec![0.0f32; n];
            let mut cr_full = vec![0.0f32; n];
            for (i, c) in rgb_prime.iter().enumerate() {
                let [y, cb, cr] = rgb_prime_to_ycbcr(*c, cfg.primaries);
                y_plane[i] = quantize_luma(y, cfg.bit_depth, cfg.range);
                cb_full[i] = cb;
                cr_full[i] = cr;
            }
            let (cb_s, cw, ch) = subsample_chroma(&cb_full, w, h, cfg.subsampling);
            let (cr_s, _, _) = subsample_chroma(&cr_full, w, h, cfg.subsampling);
            let cb = cb_s
                .iter()
                .map(|&c| quantize_chroma(c, cfg.bit_depth, cfg.range))
                .collect();
            let cr = cr_s
                .iter()
                .map(|&c| quantize_chroma(c, cfg.bit_depth, cfg.range))
                .collect();
            AvifPlanes {
                p0: y_plane,
                p1: cb,
                p2: cr,
                chroma_w: cw,
                chroma_h: ch,
            }
        }
    }
}

/// Compute MaxCLL / MaxFALL (cd/m²) for the linear image given the reference-white anchor.
/// MaxCLL = max over pixels of the brightest channel's nits; MaxFALL = mean over pixels of the
/// brightest channel's nits. Capped at [`PQ_MAX_NITS`].
fn content_light_levels(
    img: &ImageBuffer<Rgba<f32>, Vec<f32>>,
    cfg: &HdrEncodeConfig,
) -> (u16, u16) {
    let mut max_nits = 0.0f32;
    let mut sum_nits = 0.0f64;
    let mut count = 0u64;
    for px in img.pixels() {
        let rgb = convert_primaries([px.0[0], px.0[1], px.0[2]], cfg.primaries);
        let peak = rgb[0].max(rgb[1]).max(rgb[2]).max(0.0);
        let nits = (peak * cfg.reference_white_nits).min(PQ_MAX_NITS);
        if nits > max_nits {
            max_nits = nits;
        }
        sum_nits += nits as f64;
        count += 1;
    }
    let maxfall = if count > 0 {
        (sum_nits / count as f64) as f32
    } else {
        0.0
    };
    let cap = |v: f32| v.round().clamp(0.0, u16::MAX as f32) as u16;
    (cap(max_nits), cap(maxfall))
}

/// Encode a linear `Rgba<f32>` image to a tagged HDR AVIF (10 or 12 bit) per `cfg`.
///
/// The identity matrix carries RGB transfer-encoded codes directly (no YCbCr conversion, no
/// chroma subsampling) so the round-trip is exact for every color; YCbCr converts to
/// non-constant-luminance Y'CbCr and supports 4:2:2 / 4:2:0 subsampling. CICP tags
/// (primaries / transfer / matrix / range) are written to both the AV1 stream and the container.
// rav1e's EncoderConfig is configured by mutating a Default (its own examples do the same); the
// nested color_description makes a struct-literal initializer far less readable.
#[allow(clippy::field_reassign_with_default)]
pub fn encode_avif_hdr(
    img: &ImageBuffer<Rgba<f32>, Vec<f32>>,
    cfg: &HdrEncodeConfig,
) -> Result<Vec<u8>, String> {
    use rav1e::config::SpeedSettings;
    // Explicit imports (not a glob) so this module's own ColorPrimaries/TransferFunction enums
    // are not shadowed by rav1e's same-named enums.
    use rav1e::prelude::{
        ChromaSamplePosition, ChromaSampling, ColorDescription, Config, Context, EncoderConfig,
        EncoderStatus, PixelRange,
    };

    let cfg = cfg.sanitized()?;
    let bit_depth = cfg.bit_depth;
    if cfg.transfer == TransferFunction::Srgb {
        return Err("encode_avif_hdr requires a PQ or HLG transfer".into());
    }
    let w = img.width() as usize;
    let h = img.height() as usize;
    if w == 0 || h == 0 {
        return Err("cannot encode an empty image".into());
    }

    // 4:2:2 (AV1 "Professional" profile) is fragile in rav1e: it only emits a stream strict
    // decoders accept when the frame is a *single AV1 tile*. AV1's per-tile caps (4096 px wide,
    // 4096*2304 = 9_437_184 px area) force a multi-tile layout on larger frames, and rav1e's 4:2:2
    // path mis-codes any multi-tile case (verified: even a forced 2x1 split fails to decode at
    // some geometries). We do NOT silently downgrade the user's chosen subsampling -- instead we
    // fail loudly so the export surfaces the limit (the UI auto-caps 4:2:2 resolution to keep
    // frames inside this single-tile envelope, and warns if the cap is overridden). Other formats
    // (4:2:0 / 4:4:4) have no such limit.
    if cfg.matrix == MatrixMode::Ycbcr && cfg.subsampling == ChromaSubsampling::Cs422 {
        let single_tile = w <= AVIF_422_MAX_WIDTH && w.saturating_mul(h) <= AVIF_422_MAX_PIXELS;
        if !single_tile {
            return Err(format!(
                "4:2:2 AVIF supports at most {AVIF_422_MAX_WIDTH} px wide and \
                 {AVIF_422_MAX_PIXELS} px total (this frame is {w}x{h} = {} px). \
                 Reduce the export resolution or choose 4:2:0 / 4:4:4 chroma.",
                w * h
            ));
        }
    }

    let planes = build_avif_planes(img, &cfg);

    let chroma_sampling = match cfg.matrix {
        MatrixMode::Identity => ChromaSampling::Cs444,
        MatrixMode::Ycbcr => match cfg.subsampling {
            ChromaSubsampling::Cs444 => ChromaSampling::Cs444,
            ChromaSubsampling::Cs422 => ChromaSampling::Cs422,
            ChromaSubsampling::Cs420 => ChromaSampling::Cs420,
        },
    };
    let pixel_range = match cfg.range {
        DynamicRange::Full => PixelRange::Full,
        DynamicRange::Limited => PixelRange::Limited,
    };

    let mut enc = EncoderConfig::default();
    enc.width = w;
    enc.height = h;
    enc.bit_depth = bit_depth as usize;
    enc.chroma_sampling = chroma_sampling;
    enc.chroma_sample_position = ChromaSamplePosition::Unknown;
    enc.still_picture = true;
    enc.pixel_range = pixel_range;
    enc.color_description = Some(ColorDescription {
        color_primaries: match cfg.primaries {
            ColorPrimaries::Bt2020 => rav1e::prelude::ColorPrimaries::BT2020,
            ColorPrimaries::Srgb => rav1e::prelude::ColorPrimaries::BT709,
            ColorPrimaries::DisplayP3 => rav1e::prelude::ColorPrimaries::SMPTE432,
        },
        transfer_characteristics: match cfg.transfer {
            TransferFunction::Pq => rav1e::prelude::TransferCharacteristics::SMPTE2084,
            TransferFunction::Hlg => rav1e::prelude::TransferCharacteristics::HLG,
            TransferFunction::Srgb => unreachable!(),
        },
        matrix_coefficients: match cfg.matrix {
            MatrixMode::Identity => rav1e::prelude::MatrixCoefficients::Identity,
            MatrixMode::Ycbcr => match cfg.primaries {
                ColorPrimaries::Bt2020 => rav1e::prelude::MatrixCoefficients::BT2020NCL,
                ColorPrimaries::Srgb | ColorPrimaries::DisplayP3 => {
                    rav1e::prelude::MatrixCoefficients::BT709
                }
            },
        },
    });
    enc.quantizer = quality_to_quantizer(cfg.quality);
    enc.speed_settings = SpeedSettings::from_preset(6);

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(2);
    let config = Config::new().with_encoder_config(enc).with_threads(threads);
    let mut ctx: Context<u16> = config
        .new_context()
        .map_err(|e| format!("rav1e new_context failed: {e:?}"))?;

    let mut frame = ctx.new_frame();
    // copy_from_raw_u8 writes at the plane origin (handles rav1e's internal padding), unlike a
    // raw chunks_mut over the padded buffer. Identity plane order is 0=G', 1=B', 2=R';
    // YCbCr is 0=Y', 1=Cb, 2=Cr. The samples are u16 and rav1e wants little-endian bytes; on every
    // supported (little-endian) target that's exactly the in-memory layout, so cast the plane
    // slices to bytes with no allocation instead of building a byte copy of each plane.
    frame.planes[0].copy_from_raw_u8(bytemuck::cast_slice(&planes.p0), w * 2, 2);
    frame.planes[1].copy_from_raw_u8(bytemuck::cast_slice(&planes.p1), planes.chroma_w * 2, 2);
    frame.planes[2].copy_from_raw_u8(bytemuck::cast_slice(&planes.p2), planes.chroma_w * 2, 2);
    let _ = planes.chroma_h;

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
    let sub_xy = match chroma_sampling {
        ChromaSampling::Cs444 => (false, false),
        ChromaSampling::Cs422 => (true, false),
        ChromaSampling::Cs420 => (true, true),
        ChromaSampling::Cs400 => (true, true),
    };
    let mut aviffy = Aviffy::new();
    aviffy
        .set_color_primaries(match cfg.primaries {
            ColorPrimaries::Bt2020 => AvifPrimaries::Bt2020,
            ColorPrimaries::Srgb => AvifPrimaries::Bt709,
            ColorPrimaries::DisplayP3 => AvifPrimaries::DisplayP3,
        })
        .set_transfer_characteristics(match cfg.transfer {
            TransferFunction::Pq => AvifTransfer::Smpte2084,
            TransferFunction::Hlg => AvifTransfer::Hlg,
            TransferFunction::Srgb => unreachable!(),
        })
        .set_matrix_coefficients(match cfg.matrix {
            MatrixMode::Identity => AvifMatrix::Rgb,
            MatrixMode::Ycbcr => match cfg.primaries {
                ColorPrimaries::Bt2020 => AvifMatrix::Bt2020Ncl,
                ColorPrimaries::Srgb | ColorPrimaries::DisplayP3 => AvifMatrix::Bt709,
            },
        })
        .set_full_color_range(cfg.range == DynamicRange::Full)
        .set_bit_depth(bit_depth)
        .set_chroma_subsampling(sub_xy);

    if cfg.mastering_metadata {
        let (maxcll, maxfall) = content_light_levels(img, &cfg);
        aviffy.set_content_light_level(maxcll, maxfall);
        // Mastering Display Colour Volume (SMPTE ST 2086). Primaries in CIE xy x 50000, ordered
        // [green, blue, red]; white point D65; luminance in cd/m^2 x 10000. We describe a
        // BT.2020/D65 display peaking at PQ_MAX_NITS (the PQ container max). This is informational
        // display metadata, distinct from the per-frame content light levels above.
        let xy = |x: f32, y: f32| -> (u16, u16) {
            ((x * 50000.0).round() as u16, (y * 50000.0).round() as u16)
        };
        let green = xy(0.170, 0.797);
        let blue = xy(0.131, 0.046);
        let red = xy(0.708, 0.292);
        let white = xy(0.3127, 0.3290);
        let max_lum = (PQ_MAX_NITS * 10000.0) as u32; // cd/m^2 x 10000
        let min_lum = 1u32; // 0.0001 cd/m^2
        aviffy.set_mastering_display([green, blue, red], white, max_lum, min_lum);
    }

    Ok(aviffy.to_vec(&av1_obu, None, w as u32, h as u32, bit_depth))
}

/// Map an export quality (0..=100) to a JPEG XL butteraugli distance. 100 => lossless (handled
/// separately); otherwise distance = (100 - q)/10, clamped to >= 0.1 (lower = higher quality).
pub fn quality_to_jxl_distance(quality: u8) -> f32 {
    ((100.0 - quality.min(100) as f32) / 10.0).max(0.1)
}

/// Encode a linear `Rgba<f32>` image to a tagged HDR JPEG XL (PQ or HLG), 32-bit float, per `cfg`.
/// Requires the `hdr_jxl` feature (system libjxl). Feeds transfer-encoded f32 codes with
/// `uses_original_profile` so libjxl keeps our PQ/HLG color encoding instead of converting to XYB.
/// Quality 100 selects true lossless; otherwise a butteraugli distance from the quality knob.
#[cfg(feature = "hdr_jxl")]
pub fn encode_jxl_hdr(
    img: &ImageBuffer<Rgba<f32>, Vec<f32>>,
    cfg: &HdrEncodeConfig,
) -> Result<Vec<u8>, String> {
    use jpegxl_rs::encode::{ColorEncoding, EncoderFrame, EncoderResult, EncoderSpeed};
    use jpegxl_rs::encoder_builder;
    use jpegxl_sys::color::color_encoding::{
        JxlColorEncoding, JxlColorSpace, JxlPrimaries, JxlRenderingIntent, JxlTransferFunction,
        JxlWhitePoint,
    };

    let cfg = {
        // JXL has no AVIF bit-depth constraint; only the luminance anchors need clamping.
        let mut c = *cfg;
        c.clamp_anchors();
        c
    };
    if cfg.transfer == TransferFunction::Srgb {
        return Err("encode_jxl_hdr requires a PQ or HLG transfer".into());
    }
    let (w, h) = (img.width(), img.height());

    let mut rgb: Vec<f32> = Vec::with_capacity((w * h * 3) as usize);
    for px in img.pixels() {
        let code = encode_pixel_linear_to_code_with(
            [px.0[0], px.0[1], px.0[2]],
            cfg.primaries,
            cfg.transfer,
            cfg.reference_white_nits,
            cfg.hlg_peak_ratio,
        );
        rgb.extend_from_slice(&code);
    }

    let color = JxlColorEncoding {
        color_space: JxlColorSpace::Rgb,
        white_point: JxlWhitePoint::D65,
        white_point_xy: [0.3127, 0.3290],
        primaries: match cfg.primaries {
            ColorPrimaries::Bt2020 => JxlPrimaries::Rec2100,
            ColorPrimaries::Srgb => JxlPrimaries::SRgb,
            ColorPrimaries::DisplayP3 => JxlPrimaries::P3,
        },
        primaries_red_xy: [0.0, 0.0],
        primaries_green_xy: [0.0, 0.0],
        primaries_blue_xy: [0.0, 0.0],
        transfer_function: match cfg.transfer {
            TransferFunction::Pq => JxlTransferFunction::PQ,
            TransferFunction::Hlg => JxlTransferFunction::HLG,
            TransferFunction::Srgb => unreachable!(),
        },
        gamma: 0.0,
        rendering_intent: JxlRenderingIntent::Relative,
    };

    let lossless = cfg.quality >= 100;
    let distance = quality_to_jxl_distance(cfg.quality);

    let mut encoder = encoder_builder()
        .has_alpha(false)
        .speed(EncoderSpeed::Squirrel)
        .uses_original_profile(true)
        .lossless(lossless)
        .quality(distance)
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
    fn displayp3_matrix_preserves_neutral() {
        // White-preserving: each row sums to 1.0, so neutral grey is unchanged.
        let n = rec709_to_displayp3_linear([0.5, 0.5, 0.5]);
        for c in n {
            assert!((c - 0.5).abs() < 1e-5, "P3 neutral not preserved: {c}");
        }
    }

    #[test]
    fn ycbcr_roundtrip_recovers_rgb_prime() {
        // Forward R'G'B' -> Y'CbCr then invert; channels must come back distinct and in order.
        for &prim in &[ColorPrimaries::Srgb, ColorPrimaries::Bt2020] {
            let rgbp = [0.2f32, 0.5, 0.85];
            let [y, cb, cr] = rgb_prime_to_ycbcr(rgbp, prim);
            let (_kr, _kg, _kb, cb_denom, cr_denom) = ycbcr_coefficients(prim);
            // Standard NCL inverse: R = Y + Cr*cr_denom, B = Y + Cb*cb_denom.
            let r = y + cr * cr_denom;
            let b = y + cb * cb_denom;
            assert!((r - rgbp[0]).abs() < 1e-5, "{prim:?} R recovered {r}");
            assert!((b - rgbp[2]).abs() < 1e-5, "{prim:?} B recovered {b}");
            assert!(
                r < rgbp[1] && rgbp[1] < b,
                "channel order lost: {r} {} {b}",
                rgbp[1]
            );
        }
    }

    #[test]
    fn quantize_ranges_behave() {
        // Full range: white code 1.0 -> max; limited: 219*s+16*s.
        assert_eq!(quantize_luma(1.0, 10, DynamicRange::Full), 1023);
        assert_eq!(quantize_luma(0.0, 10, DynamicRange::Full), 0);
        let s = 1u16 << 2; // 10-bit scale
        assert_eq!(
            quantize_luma(1.0, 10, DynamicRange::Limited),
            219 * s + 16 * s
        );
        assert_eq!(quantize_luma(0.0, 10, DynamicRange::Limited), 16 * s);
        // Chroma full: 0.0 -> midpoint; +0.5 -> max; -0.5 -> 0.
        assert_eq!(quantize_chroma(0.0, 10, DynamicRange::Full), 512);
        assert_eq!(quantize_chroma(0.5, 10, DynamicRange::Full), 1023);
        assert_eq!(quantize_chroma(-0.5, 10, DynamicRange::Full), 0);
        // Chroma limited: 0.0 -> 128*s.
        assert_eq!(quantize_chroma(0.0, 10, DynamicRange::Limited), 128 * s);
    }

    #[test]
    fn config_sanitize_clamps_and_forces_444() {
        let cfg = HdrEncodeConfig {
            reference_white_nits: 0.0,
            hlg_peak_ratio: -1.0,
            matrix: MatrixMode::Identity,
            subsampling: ChromaSubsampling::Cs420,
            ..Default::default()
        }
        .sanitized()
        .unwrap();
        assert_eq!(cfg.reference_white_nits, REFERENCE_WHITE_NITS);
        assert_eq!(cfg.hlg_peak_ratio, HLG_PEAK_RATIO);
        assert_eq!(cfg.subsampling, ChromaSubsampling::Cs444);
        // Bad bit depth -> Err.
        let bad = HdrEncodeConfig {
            bit_depth: 8,
            ..Default::default()
        }
        .sanitized();
        assert!(bad.is_err());
    }

    #[test]
    fn transfer_params_match_default_wrappers() {
        // The parameterized helpers with the canonical anchors must equal the legacy wrappers.
        for &l in &[0.0f32, 0.5, 1.0, 2.0, 4.0] {
            assert_eq!(
                linear_scene_to_pq_with(l, REFERENCE_WHITE_NITS),
                linear_scene_to_pq(l)
            );
            assert_eq!(
                linear_scene_to_hlg_with(l, HLG_PEAK_RATIO),
                linear_scene_to_hlg(l)
            );
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
