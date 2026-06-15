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
use rapidraw_lib::hdr::{self, ColorPrimaries, TransferFunction};
use std::process::Command;

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

fn run_avif_pq_case(bit_depth: u8) {
    let s = hdr::synthetic_linear_image();
    let avif = hdr::encode_avif_hdr(
        &s.image,
        bit_depth,
        TransferFunction::Pq,
        ColorPrimaries::Bt2020,
        100,
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
        10,
        TransferFunction::Hlg,
        ColorPrimaries::Bt2020,
        100,
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
    let avif =
        hdr::encode_avif_hdr(&img, 10, TransferFunction::Pq, ColorPrimaries::Srgb, 100).unwrap();
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

#[cfg(feature = "hdr_jxl")]
mod jxl {
    use super::*;

    #[test]
    fn jxl_pq_tags_and_refwhite() {
        use jxl_oxide::JxlImage;

        let s = hdr::synthetic_linear_image();
        let bytes =
            hdr::encode_jxl_hdr(&s.image, TransferFunction::Pq, ColorPrimaries::Bt2020, true)
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
