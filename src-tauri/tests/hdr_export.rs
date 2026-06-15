//! HDR export verification harness (the gate).
//!
//! Pushes the synthetic linear test image through the real HDR encoders and asserts, exiting
//! non-zero on any failure:
//!   1. CICP / nclx tags (primaries, transfer, matrix, full-range)
//!   2. bit depth (10 and 12 for AVIF)
//!   3. reference white (linear 1.0 -> 203 nits) decodes to PQ code ~594 (10-bit), +/-2
//!   4. headroom: linear 2.0 and 4.0 patches decode to strictly-increasing codes above diffuse
//!      white and below full scale (proves the look stage / encoder did not clip at 1.0)
//!
//! Tags + bit depth are parsed directly from the container bytes (independent of the encoder).
//! AVIF pixels are decoded with `avifdec` (libavif) — a decoder independent of rav1e/avif-serialize.
//! JXL (behind the `hdr_jxl` feature) is decoded with the pure-Rust jxl-oxide.

use image::{ImageBuffer, Rgba};
use rapidraw_lib::hdr::{
    self, ChromaSubsampling, ColorPrimaries, DynamicRange, HdrEncodeConfig, MatrixMode,
    TransferFunction,
};
use std::process::Command;

/// Build a config for the identity-matrix PQ/HLG path used by the existing checks: identity
/// matrix, 4:4:4, full range, default anchors. Mirrors the historical encoder defaults.
fn identity_cfg(
    bit_depth: u8,
    transfer: TransferFunction,
    primaries: ColorPrimaries,
) -> HdrEncodeConfig {
    HdrEncodeConfig {
        bit_depth,
        transfer,
        primaries,
        matrix: MatrixMode::Identity,
        subsampling: ChromaSubsampling::Cs444,
        range: DynamicRange::Full,
        reference_white_nits: hdr::REFERENCE_WHITE_NITS,
        hlg_peak_ratio: hdr::HLG_PEAK_RATIO,
        quality: 100,
        mastering_metadata: false,
    }
}

/// Parse the first ISOBMFF `colr` box of type `nclx`: (primaries, transfer, matrix, full_range).
fn parse_nclx(bytes: &[u8]) -> Option<(u16, u16, u16, bool)> {
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        if &bytes[i..i + 4] == b"colr" {
            let ct = i + 4;
            if ct + 4 <= bytes.len() && &bytes[ct..ct + 4] == b"nclx" {
                let p = ct + 4;
                if p + 7 > bytes.len() {
                    return None;
                }
                return Some((
                    u16::from_be_bytes([bytes[p], bytes[p + 1]]),
                    u16::from_be_bytes([bytes[p + 2], bytes[p + 3]]),
                    u16::from_be_bytes([bytes[p + 4], bytes[p + 5]]),
                    (bytes[p + 6] & 0x80) != 0,
                ));
            }
        }
        i += 1;
    }
    None
}

/// Parse the AV1 codec config (`av1C`) box for the coded bit depth (8/10/12), independent of
/// the nclx tag. Config byte 2 layout (MSB first): seq_tier(1) high_bitdepth(1) twelve_bit(1) ...
fn parse_av1c_depth(bytes: &[u8]) -> Option<u8> {
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        if &bytes[i..i + 4] == b"av1C" {
            let cfg = i + 4;
            if cfg + 3 > bytes.len() {
                return None;
            }
            let flags = bytes[cfg + 2];
            let high_bitdepth = (flags & 0x40) != 0;
            let twelve_bit = (flags & 0x20) != 0;
            return Some(if !high_bitdepth {
                8
            } else if twelve_bit {
                12
            } else {
                10
            });
        }
        i += 1;
    }
    None
}

/// Decode an AVIF byte stream to a 16-bit RGBA image using the `avifdec` CLI (libavif).
fn avifdec_to_png16(avif: &[u8], label: &str) -> ImageBuffer<Rgba<u16>, Vec<u16>> {
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    let in_path = dir.join(format!("rr_hdr_{label}_{pid}.avif"));
    let out_path = dir.join(format!("rr_hdr_{label}_{pid}.png"));
    std::fs::write(&in_path, avif).expect("write temp avif");

    let output = Command::new("avifdec")
        .arg(&in_path)
        .arg(&out_path)
        .output();
    let output = match output {
        Ok(o) => o,
        Err(e) => panic!(
            "could not run `avifdec` ({e}). Install libavif (macOS: `brew install libavif`) to run the HDR pixel checks."
        ),
    };
    assert!(
        output.status.success(),
        "avifdec failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let decoded = image::open(&out_path)
        .unwrap_or_else(|e| panic!("open decoded png {out_path:?}: {e}"))
        .into_rgba16();
    let _ = std::fs::remove_file(&in_path);
    let _ = std::fs::remove_file(&out_path);
    decoded
}

/// Recover the bit-depth-scaled integer code from a 16-bit PNG sample.
fn code_from_png16(v16: u16, bit_depth: u8) -> u16 {
    let max = ((1u32 << bit_depth) - 1) as f32;
    (v16 as f32 / 65535.0 * max).round() as u16
}

/// Decode an AVIF to y4m via `avifdec` and return the FIRST sample of plane 0 (the coded luma /
/// identity-G' plane) as a raw integer code. Unlike PNG/RGB output, y4m preserves the coded YUV
/// sample values verbatim — no limited->full range expansion and no inverse color matrix — so it
/// reflects exactly what was quantized into the bitstream.
fn avifdec_plane0_first_sample(avif: &[u8], label: &str) -> u16 {
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    let in_path = dir.join(format!("rr_hdr_{label}_{pid}.avif"));
    let out_path = dir.join(format!("rr_hdr_{label}_{pid}.y4m"));
    std::fs::write(&in_path, avif).expect("write temp avif");

    let output = Command::new("avifdec")
        .arg(&in_path)
        .arg(&out_path)
        .output()
        .expect("run avifdec for y4m");
    assert!(
        output.status.success(),
        "avifdec (y4m) failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bytes = std::fs::read(&out_path).expect("read y4m");
    let _ = std::fs::remove_file(&in_path);
    let _ = std::fs::remove_file(&out_path);

    // y4m: an ASCII header terminated by '\n', then "FRAME[params]\n", then raw plane data.
    // For depth > 8, samples are little-endian u16.
    let header_end = bytes
        .iter()
        .position(|&b| b == b'\n')
        .expect("y4m header newline");
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let depth_gt8 = header.contains("p10") || header.contains("p12") || header.contains("p16");
    // Locate the FRAME marker after the header.
    let frame_pos = bytes[header_end..]
        .windows(5)
        .position(|w| w == b"FRAME")
        .map(|p| header_end + p)
        .expect("y4m FRAME marker");
    let frame_data_start = bytes[frame_pos..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|p| frame_pos + p + 1)
        .expect("FRAME newline");
    if depth_gt8 {
        u16::from_le_bytes([bytes[frame_data_start], bytes[frame_data_start + 1]])
    } else {
        bytes[frame_data_start] as u16
    }
}

fn run_avif_pq_case(bit_depth: u8) {
    let s = hdr::synthetic_linear_image();
    let avif = hdr::encode_avif_hdr(
        &s.image,
        &identity_cfg(bit_depth, TransferFunction::Pq, ColorPrimaries::Bt2020),
    )
    .expect("encode avif");

    // (1) tags
    let (p, t, m, fr) = parse_nclx(&avif).expect("nclx box present");
    assert_eq!(
        p, 9,
        "[{bit_depth}b] colour_primaries should be BT.2020 (9), got {p}"
    );
    assert_eq!(t, 16, "[{bit_depth}b] transfer should be PQ (16), got {t}");
    assert_eq!(
        m, 0,
        "[{bit_depth}b] matrix should be Identity/RGB (0), got {m}"
    );
    assert!(fr, "[{bit_depth}b] full_range_flag should be 1");

    // (2) bit depth (independent, from av1C)
    let depth = parse_av1c_depth(&avif).expect("av1C box present");
    assert_eq!(depth, bit_depth, "av1C coded depth {depth} != {bit_depth}");

    // (3) + (4) pixels via independent decoder.
    // INDEPENDENT ground truth: these codes are computed offline from ST.2084 with the 203-nit
    // anchor (203/406/812 nits) and hardcoded here, NOT derived from the encoder's own functions,
    // so a wrong anchor/transfer in the encoder cannot make this pass circularly.
    let (exp_white, exp_rel2, exp_rel4) = match bit_depth {
        10 => (594u16, 669u16, 746u16),
        12 => (2378, 2679, 2986),
        _ => panic!("unexpected bit depth {bit_depth}"),
    };
    let dec = avifdec_to_png16(&avif, &format!("pq{bit_depth}"));
    let sample =
        |px: (u32, u32)| -> u16 { code_from_png16(dec.get_pixel(px.0, px.1).0[0], bit_depth) };

    let near = |got: u16, exp: u16, what: &str| {
        assert!(
            (got as i32 - exp as i32).abs() <= 2,
            "[{bit_depth}b] {what} code {got}, expected ~{exp} (+/-2)"
        );
    };

    let white = sample(s.diffuse_white_px);
    let black = sample(s.black_px);
    let rel2 = sample(s.rel2_px);
    let rel4 = sample(s.rel4_px);
    let full = (1u32 << bit_depth) - 1;

    near(white, exp_white, "reference-white (203 nit)");
    near(rel2, exp_rel2, "2x headroom (406 nit)");
    near(rel4, exp_rel4, "4x headroom (812 nit)");
    assert!(
        black < white,
        "[{bit_depth}b] black {black} !< white {white}"
    );
    assert!(
        white < rel2 && rel2 < rel4,
        "[{bit_depth}b] headroom not strictly increasing: white {white} rel2 {rel2} rel4 {rel4}"
    );
    assert!(
        (rel4 as u32) < full,
        "[{bit_depth}b] 4x headroom {rel4} should stay below full scale {full}"
    );

    // ramp must be non-decreasing left->right
    let ramp: Vec<u16> = s.ramp_px.iter().map(|&px| sample(px)).collect();
    for w in ramp.windows(2) {
        assert!(w[0] <= w[1] + 2, "ramp not monotonic: {ramp:?}");
    }

    eprintln!(
        "AVIF {bit_depth}-bit PQ: tags 9/16/0/full=1, depth {depth}, white={white} (exp {exp_white}), black={black} rel2={rel2} rel4={rel4} ramp={ramp:?}"
    );
}

#[test]
fn avif_pq_10bit() {
    run_avif_pq_case(10);
}

#[test]
fn avif_pq_12bit() {
    run_avif_pq_case(12);
}

#[test]
fn avif_hlg_tags() {
    let s = hdr::synthetic_linear_image();
    let avif = hdr::encode_avif_hdr(
        &s.image,
        &identity_cfg(10, TransferFunction::Hlg, ColorPrimaries::Bt2020),
    )
    .expect("encode hlg avif");
    let (p, t, m, fr) = parse_nclx(&avif).expect("nclx box present");
    assert_eq!(p, 9, "HLG primaries should be 9");
    assert_eq!(t, 18, "HLG transfer should be 18");
    assert_eq!(m, 0, "HLG matrix should be 0");
    assert!(fr, "HLG full_range_flag should be 1");
    eprintln!("AVIF 10-bit HLG: tags 9/18/0/full=1");
}

/// Identity (matrix=0) stores planes in G,B,R order. With sRGB primaries (no cross-channel
/// matrix) a pixel with distinct R<G<B must decode back with that channel ordering intact —
/// catches a wrong plane order that the neutral patches cannot.
#[test]
fn avif_identity_preserves_channel_order() {
    let mut img = ImageBuffer::<Rgba<f32>, Vec<f32>>::new(4, 4);
    // linear values chosen so PQ codes are clearly separated: R < G < B
    for px in img.pixels_mut() {
        *px = Rgba([0.05, 0.2, 0.8, 1.0]);
    }
    let avif = hdr::encode_avif_hdr(
        &img,
        &identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Srgb),
    )
    .unwrap();
    let dec = avifdec_to_png16(&avif, "order");
    let px = dec.get_pixel(1, 1).0;
    assert!(
        px[0] < px[1] && px[1] < px[2],
        "channel order lost: R={} G={} B={} (expected R<G<B)",
        px[0],
        px[1],
        px[2]
    );
    eprintln!(
        "AVIF identity plane order OK: R={} G={} B={}",
        px[0], px[1], px[2]
    );
}

/// Expected full-range 10-bit PQ code for a linear scene value at the 203-nit anchor.
/// INDEPENDENT ground truth: ST.2084 inverse-EOTF computed here, NOT via the encoder's helpers.
fn expected_pq_code10(linear: f32) -> u16 {
    const M1: f64 = 0.1593017578125;
    const M2: f64 = 78.84375;
    const C1: f64 = 0.8359375;
    const C2: f64 = 18.8515625;
    const C3: f64 = 18.6875;
    let l = (linear as f64 * 203.0 / 10000.0).max(0.0);
    let lp = l.powf(M1);
    let code = ((C1 + C2 * lp) / (1.0 + C3 * lp)).powf(M2);
    (code.clamp(0.0, 1.0) * 1023.0).round() as u16
}

fn uniform_image(w: u32, h: u32, rgb: [f32; 3]) -> ImageBuffer<Rgba<f32>, Vec<f32>> {
    ImageBuffer::from_pixel(w, h, Rgba([rgb[0], rgb[1], rgb[2], 1.0]))
}

/// YCbCr matrix at 4:4:4, full range, sRGB primaries (no cross-channel primaries matrix). A flat
/// uniform patch with distinct saturated R!=G!=B must decode back, per channel, within +/-3 codes
/// of the independently-computed R'G'B' PQ codes. Proves the YCbCr forward/inverse matrix is
/// correct AND that channels are not swapped (Cr<->R, Cb<->B).
#[test]
fn avif_ycbcr_444_colored_roundtrip() {
    let rgb = [0.1f32, 0.4, 0.9]; // R < G < B, well separated
    let img = uniform_image(8, 8, rgb);
    let cfg = HdrEncodeConfig {
        matrix: MatrixMode::Ycbcr,
        subsampling: ChromaSubsampling::Cs444,
        range: DynamicRange::Full,
        primaries: ColorPrimaries::Srgb,
        ..identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Srgb)
    };
    let avif = hdr::encode_avif_hdr(&img, &cfg).expect("encode ycbcr 444");

    let (_p, _t, m, _fr) = parse_nclx(&avif).expect("nclx box present");
    assert_eq!(
        m, 1,
        "sRGB-primaries YCbCr should tag BT.709 matrix (1), got {m}"
    );

    let dec = avifdec_to_png16(&avif, "ycbcr444");
    let px = dec.get_pixel(4, 4).0;
    let got = [
        code_from_png16(px[0], 10),
        code_from_png16(px[1], 10),
        code_from_png16(px[2], 10),
    ];
    let exp = [
        expected_pq_code10(rgb[0]),
        expected_pq_code10(rgb[1]),
        expected_pq_code10(rgb[2]),
    ];
    for c in 0..3 {
        assert!(
            (got[c] as i32 - exp[c] as i32).abs() <= 3,
            "channel {c}: got {} expected ~{} (+/-3); full got={got:?} exp={exp:?}",
            got[c],
            exp[c]
        );
    }
    assert!(
        got[0] < got[1] && got[1] < got[2],
        "channel order lost in YCbCr: {got:?}"
    );
    eprintln!("AVIF YCbCr 4:4:4 colored round-trip: got {got:?} expected {exp:?}");
}

/// Same colored patch but 4:2:0 subsampling. On a UNIFORM patch there are no chroma edges, so even
/// 2x2 averaging is lossless and the channels must still round-trip within tolerance.
#[test]
fn avif_ycbcr_420_uniform_roundtrip() {
    let rgb = [0.1f32, 0.4, 0.9];
    let img = uniform_image(8, 8, rgb);
    let cfg = HdrEncodeConfig {
        matrix: MatrixMode::Ycbcr,
        subsampling: ChromaSubsampling::Cs420,
        range: DynamicRange::Full,
        primaries: ColorPrimaries::Srgb,
        ..identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Srgb)
    };
    let avif = hdr::encode_avif_hdr(&img, &cfg).expect("encode ycbcr 420");
    let dec = avifdec_to_png16(&avif, "ycbcr420");
    let px = dec.get_pixel(4, 4).0;
    let got = [
        code_from_png16(px[0], 10),
        code_from_png16(px[1], 10),
        code_from_png16(px[2], 10),
    ];
    let exp = [
        expected_pq_code10(rgb[0]),
        expected_pq_code10(rgb[1]),
        expected_pq_code10(rgb[2]),
    ];
    for c in 0..3 {
        assert!(
            (got[c] as i32 - exp[c] as i32).abs() <= 3,
            "4:2:0 channel {c}: got {} expected ~{} (+/-3); full got={got:?} exp={exp:?}",
            got[c],
            exp[c]
        );
    }
    eprintln!("AVIF YCbCr 4:2:0 uniform round-trip: got {got:?} expected {exp:?}");
}

/// Limited range must produce a smaller luma code than full range for the same input. A very
/// bright neutral patch saturates PQ to ~1.0: full range -> 1023, limited range -> ~940.
#[test]
fn avif_limited_range_is_smaller_than_full() {
    let img = uniform_image(8, 8, [50.0, 50.0, 50.0]); // PQ code clamps to ~1.0
    let base = identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Srgb);

    let full_cfg = HdrEncodeConfig {
        range: DynamicRange::Full,
        ..base
    };
    let lim_cfg = HdrEncodeConfig {
        range: DynamicRange::Limited,
        ..base
    };
    let full = hdr::encode_avif_hdr(&img, &full_cfg).expect("full");
    let lim = hdr::encode_avif_hdr(&img, &lim_cfg).expect("limited");

    let (_, _, _, full_fr) = parse_nclx(&full).expect("full nclx");
    let (_, _, _, lim_fr) = parse_nclx(&lim).expect("lim nclx");
    assert!(full_fr, "full-range flag should be set");
    assert!(!lim_fr, "limited-range flag should be clear");

    // Read the RAW coded sample (no decoder range-expansion) from the y4m plane 0.
    let fcode = avifdec_plane0_first_sample(&full, "rfull");
    let lcode = avifdec_plane0_first_sample(&lim, "rlim");
    assert!(
        (fcode as i32 - 1023).abs() <= 3,
        "full-range white should be ~1023, got {fcode}"
    );
    assert!(
        (lcode as i32 - 940).abs() <= 4,
        "limited-range white should be ~940, got {lcode}"
    );
    assert!(
        lcode < fcode,
        "limited code {lcode} must be smaller than full code {fcode}"
    );
    eprintln!("AVIF range: full white={fcode} (exp ~1023), limited white={lcode} (exp ~940)");
}

/// Each primaries selection must tag the correct CICP colour_primaries (sRGB=1, Bt2020=9,
/// DisplayP3=12), and a saturated-green patch must store different codes under different primaries
/// (proving the primaries matrix is actually applied to the pixels, not just tagged).
#[test]
fn avif_primaries_tagged_and_applied() {
    let green = [0.0f32, 0.9, 0.0];
    let img = uniform_image(8, 8, green);

    let cases = [
        (ColorPrimaries::Srgb, 1u16, "srgb"),
        (ColorPrimaries::Bt2020, 9, "bt2020"),
        (ColorPrimaries::DisplayP3, 12, "p3"),
    ];

    let mut decoded_codes = Vec::new();
    for (prim, expected_cicp, label) in cases {
        let cfg = identity_cfg(10, TransferFunction::Pq, prim);
        let avif = hdr::encode_avif_hdr(&img, &cfg).unwrap_or_else(|e| panic!("{label}: {e}"));
        let (p, _t, _m, _fr) = parse_nclx(&avif).expect("nclx box present");
        assert_eq!(
            p, expected_cicp,
            "{label}: colour_primaries should be {expected_cicp}, got {p}"
        );
        let dec = avifdec_to_png16(&avif, label);
        let px = dec.get_pixel(4, 4).0;
        decoded_codes.push((
            label,
            [
                code_from_png16(px[0], 10),
                code_from_png16(px[1], 10),
                code_from_png16(px[2], 10),
            ],
        ));
    }

    // sRGB primaries keep pure green in G only (R=B=0); wide-gamut conversions spread energy into
    // the other channels, so the stored triples must differ between primaries.
    let srgb = decoded_codes[0].1;
    let bt2020 = decoded_codes[1].1;
    let p3 = decoded_codes[2].1;
    assert_ne!(
        srgb, bt2020,
        "sRGB vs Bt2020 codes identical: {decoded_codes:?}"
    );
    assert_ne!(
        srgb, p3,
        "sRGB vs DisplayP3 codes identical: {decoded_codes:?}"
    );
    assert_ne!(
        bt2020, p3,
        "Bt2020 vs DisplayP3 codes identical: {decoded_codes:?}"
    );
    eprintln!("AVIF primaries tagged 1/9/12 and applied: {decoded_codes:?}");
}

/// With mastering metadata enabled, the AVIF must carry a `clli` (Content Light Level) box.
#[test]
fn avif_mastering_metadata_emits_clli() {
    let s = hdr::synthetic_linear_image();
    let cfg = HdrEncodeConfig {
        mastering_metadata: true,
        ..identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Bt2020)
    };
    let avif = hdr::encode_avif_hdr(&s.image, &cfg).expect("encode with mastering metadata");
    let has_clli = avif.windows(4).any(|w| w == b"clli");
    assert!(
        has_clli,
        "expected a `clli` box when mastering_metadata is on"
    );

    // Sanity: without it the box should be absent.
    let cfg_off = identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Bt2020);
    let avif_off = hdr::encode_avif_hdr(&s.image, &cfg_off).expect("encode without metadata");
    let has_clli_off = avif_off.windows(4).any(|w| w == b"clli");
    assert!(
        !has_clli_off,
        "`clli` box should be absent when metadata is off"
    );
    eprintln!("AVIF mastering metadata: clli present when on, absent when off");
}

/// Bad input must return an Err, not panic.
#[test]
fn avif_rejects_bad_bit_depth() {
    let img = uniform_image(4, 4, [0.5, 0.5, 0.5]);
    let cfg = identity_cfg(8, TransferFunction::Pq, ColorPrimaries::Srgb);
    assert!(
        hdr::encode_avif_hdr(&img, &cfg).is_err(),
        "8-bit AVIF HDR should be rejected"
    );
}

/// Build a gradient test image of the given size (real residual, like photo content).
fn gradient_image(w: u32, h: u32) -> ImageBuffer<Rgba<f32>, Vec<f32>> {
    let mut img = ImageBuffer::<Rgba<f32>, Vec<f32>>::new(w, h);
    for (x, _y, px) in img.enumerate_pixels_mut() {
        let v = x as f32 / w as f32; // 0..1 ramp, well inside diffuse white
        *px = Rgba([v, v * 0.5, 1.0 - v, 1.0]);
    }
    img
}

/// Large 4:2:0 / 4:4:4 frames must produce an AV1-conformant bitstream that a strict decoder
/// (dav1d, via `avifdec`) decodes. AV1 forces a multi-tile layout once a frame exceeds 4096 px
/// wide or 4096*2304 = 9_437_184 px in area; 4:2:0 and 4:4:4 tile correctly, so real full-res
/// exports (e.g. 6177x4118) must round-trip. (4:2:2 is special-cased; see the test below.)
#[test]
fn avif_large_frame_is_av1_conformant() {
    // 6177x4118 = 25.4M px: the exact size of a real export that previously failed to decode.
    let (w, h) = (6177u32, 4118u32);
    let img = gradient_image(w, h);
    for sub in [ChromaSubsampling::Cs420, ChromaSubsampling::Cs444] {
        let cfg = HdrEncodeConfig {
            matrix: MatrixMode::Ycbcr,
            subsampling: sub,
            ..identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Bt2020)
        };
        let avif = hdr::encode_avif_hdr(&img, &cfg).expect("encode large frame");
        // avifdec_to_png16 asserts avifdec exits 0; a non-conformant stream fails here.
        let dec = avifdec_to_png16(&avif, "largeframe");
        assert_eq!(
            dec.dimensions(),
            (w, h),
            "decoded dims must match for {sub:?}"
        );
    }
}

/// rav1e only emits conformant 4:2:2 for a *single* AV1 tile (verified: even forced 2x1 splits
/// fail to decode at some geometries). The encoder must therefore (a) round-trip 4:2:2 inside the
/// single-tile envelope and (b) refuse — loudly, not silently downgrade — anything larger, so the
/// UI's resolution cap is the only place that decides the trade-off. No hidden chroma changes.
#[test]
fn avif_422_single_tile_roundtrips_oversize_errors() {
    let base = HdrEncodeConfig {
        matrix: MatrixMode::Ycbcr,
        subsampling: ChromaSubsampling::Cs422,
        ..identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Bt2020)
    };

    // Dimensions are derived from the single-source-of-truth constants, not re-typed literals.
    let max_w = hdr::AVIF_422_MAX_WIDTH as u32;
    let boundary_h = (hdr::AVIF_422_MAX_PIXELS / hdr::AVIF_422_MAX_WIDTH) as u32; // = 2304

    // (a) at the single-tile boundary (max width, exactly max pixels) 4:2:2 must encode + decode.
    let ok = gradient_image(max_w, boundary_h);
    let avif = hdr::encode_avif_hdr(&ok, &base).expect("single-tile 4:2:2 must encode");
    let dec = avifdec_to_png16(&avif, "s422ok");
    assert_eq!(dec.dimensions(), (max_w, boundary_h));

    // (b) one pixel past the area cap, and past the width cap, must error (NOT silently re-chroma).
    for (w, h) in [(max_w, boundary_h + 1), (max_w + 1, 16)] {
        let big = gradient_image(w, h);
        let err = hdr::encode_avif_hdr(&big, &base)
            .expect_err("oversize 4:2:2 must error, not silently downgrade");
        assert!(
            err.contains("4:2:2"),
            "error should explain the 4:2:2 limit, got: {err}"
        );
    }
}

/// The frontend caps 4:2:2 export resolution by long edge; the cap value must be DERIVED from the
/// area/width caps (not a hand-typed mirror). This locks the relationship the `avif_422_limits`
/// command relies on: a long edge of `floor(sqrt(max_pixels))` keeps any aspect ratio within BOTH
/// the area cap and the width cap. Guards against drift if the constants ever change.
#[test]
fn avif_422_long_edge_cap_is_derivable_from_caps() {
    let max_pixels = hdr::AVIF_422_MAX_PIXELS;
    let max_width = hdr::AVIF_422_MAX_WIDTH;
    let long_edge = (max_pixels as f64).sqrt().floor() as usize;
    // square is the worst case for area at a given long edge: long_edge^2 must fit the area cap.
    assert!(
        long_edge * long_edge <= max_pixels,
        "long-edge^2 exceeds area cap"
    );
    assert!(long_edge <= max_width, "long-edge exceeds width cap");
    // and it should be the LARGEST such value (one more would break the area cap).
    assert!(
        (long_edge + 1) * (long_edge + 1) > max_pixels,
        "cap is not maximal"
    );
}

#[cfg(feature = "hdr_jxl")]
mod jxl {
    use super::*;

    #[test]
    fn jxl_pq_tags_and_refwhite() {
        use jxl_oxide::JxlImage;

        let s = hdr::synthetic_linear_image();
        let bytes = hdr::encode_jxl_hdr(
            &s.image,
            &identity_cfg(10, TransferFunction::Pq, ColorPrimaries::Bt2020),
        )
        .expect("encode jxl");

        let dir = std::env::temp_dir();
        let path = dir.join(format!("rr_hdr_pq_{}.jxl", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();

        let image = JxlImage::builder().open(&path).expect("jxl-oxide open");
        // (1) tags: jxl-oxide classifies PQ HDR
        assert_eq!(
            image.hdr_type(),
            Some(jxl_oxide::HdrType::Pq),
            "jxl should be tagged PQ; colour_encoding = {:?}",
            image.image_header().metadata.colour_encoding
        );

        // (3)+(4) pixels: decode and read the PQ codes back
        let render = image.render_frame(0).expect("render frame");
        let fb = render.image_all_channels();
        let w = fb.width();
        let ch = fb.channels();
        let buf = fb.buf();
        let sample = |px: (u32, u32)| -> f32 {
            buf[((px.1 * w as u32 + px.0) as usize) * ch] // first (R) channel
        };
        // INDEPENDENT ground truth (ST.2084, 203/406/812 nit), not derived from the encoder.
        const EXP_WHITE: f32 = 0.580_690; // 203 nit
        const EXP_REL2: f32 = 0.654_177; // 406 nit
        const EXP_REL4: f32 = 0.729_146; // 812 nit
        let white = sample(s.diffuse_white_px);
        let w2 = sample(s.rel2_px);
        let w4 = sample(s.rel4_px);
        assert!(
            (white - EXP_WHITE).abs() < 0.005,
            "jxl reference-white PQ code {white}, expected ~{EXP_WHITE}"
        );
        assert!(
            (w2 - EXP_REL2).abs() < 0.005 && (w4 - EXP_REL4).abs() < 0.005,
            "jxl headroom codes {w2}/{w4}, expected ~{EXP_REL2}/{EXP_REL4}"
        );
        assert!(
            white < w2 && w2 < w4 && w4 < 1.0,
            "jxl headroom not increasing: {white} {w2} {w4}"
        );
        let _ = std::fs::remove_file(&path);
        eprintln!("JXL PQ: tagged PQ, white={white} (exp {EXP_WHITE}), rel2={w2} rel4={w4}");
    }
}
