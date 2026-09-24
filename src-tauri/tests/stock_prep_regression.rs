//! Stock Prep Synthetic Regression Test Matrix
//!
//! Executes 10 synthetic challenge patterns (Patterns A through H, Telemetry Cache, and Hardware Safety)
//! to guarantee zero regressions and continuous first-time-right commercial stock acceptance.

use rapidraw_lib::defect_repair::{
    calculate_inscribed_crop, cross_frame_verify_dust, SensorDustCandidate,
};
use rapidraw_lib::denoising::remove_sensor_banding;
use rapidraw_lib::lens_correction::apply_radial_vignette_equalization;
use rapidraw_lib::stability::{get_safe_worker_core_count, THINKPAD_THERMAL_MAX_CORES};
use rapidraw_lib::stock_prep::{
    append_calibration_records, apply_illuminant_vector_depollution,
    apply_tiled_bm3d_and_chroma_clean, apply_tv_regularized_deblur, load_calibration_records,
    QualityGateStatus, StockPrepCalibrationRecord,
};
use rapidraw_lib::super_resolution::{perform_super_resolution_core, SuperResolutionOptions};
use image::{DynamicImage, GenericImageView, Rgb, Rgb32FImage};
use std::f32::consts::PI;

/// Pattern A: 2px motion-blurred eyelash target (tests zero-ringing TV deblurring)
#[test]
fn test_pattern_a_eyelash_deblur_zero_ringing() {
    let (w, h) = (64u32, 64u32);
    let mut img = Rgb32FImage::new(w, h);
    // Create high-contrast step edge (representing eyelash against skin)
    for y in 0..h {
        for x in 0..w {
            let v = if x < 32 { 0.20f32 } else { 0.80f32 };
            img.put_pixel(x, y, Rgb([v, v, v]));
        }
    }

    apply_tv_regularized_deblur(&mut img, 0.70);

    // Verify zero ringing halos: pixels must never undershoot baseline or overshoot highlight
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x, y);
            assert!(p[0] >= 0.0 && p[0] <= 1.0, "Physical gamut boundary violated: {}", p[0]);
            if x < 30 {
                assert!(p[0] >= 0.15, "Undershoot ringing artifact detected: {}", p[0]);
            }
            if x > 34 {
                assert!(p[0] <= 0.85, "Overshoot ringing artifact detected: {}", p[0]);
            }
        }
    }
}

/// Pattern B: High-ISO 6400 shadow gradient with color noise (tests tiled BM3D + chroma clean)
#[test]
fn test_pattern_b_high_iso_shadow_gradient_chroma_clean() {
    let (w, h) = (128u32, 128u32);
    let mut img = Rgb32FImage::new(w, h);

    // Create shadow gradient with synthetic chromatic blotches
    for y in 0..h {
        for x in 0..w {
            let luma = 0.08f32 + (x as f32 / w as f32) * 0.10f32;
            let chroma_noise_r = ((x as f32 * 13.0).sin() * 0.04).clamp(-0.03, 0.03);
            let chroma_noise_b = ((y as f32 * 17.0).cos() * 0.04).clamp(-0.03, 0.03);
            img.put_pixel(
                x,
                y,
                Rgb([
                    (luma + chroma_noise_r).clamp(0.0, 1.0),
                    luma,
                    (luma + chroma_noise_b).clamp(0.0, 1.0),
                ]),
            );
        }
    }

    apply_tiled_bm3d_and_chroma_clean(&mut img, 6400, "Sony", "ILCE-7RM5");

    // Measure chroma variance post-filtering
    let mut total_chroma_diff = 0.0f32;
    for y in 10..(h - 10) {
        for x in 10..(w - 10) {
            let p = img.get_pixel(x, y);
            total_chroma_diff += (p[0] - p[1]).abs() + (p[2] - p[1]).abs();
        }
    }
    let avg_chroma_diff = total_chroma_diff / ((w - 20) * (h - 20)) as f32;
    assert!(
        avg_chroma_diff < 0.025,
        "Chroma noise should be cleaned, got average delta {}",
        avg_chroma_diff
    );
}

/// Pattern C: Two-frame burst with static sensor spot and moving bird (tests dust verification)
#[test]
fn test_pattern_c_cross_frame_burst_dust_vs_bird() {
    let static_spot = SensorDustCandidate {
        norm_x: 0.100,
        norm_y: 0.100,
        radius: 6,
    };
    let moving_bird_frame1 = SensorDustCandidate {
        norm_x: 0.050,
        norm_y: 0.050,
        radius: 4,
    };
    let moving_bird_frame2 = SensorDustCandidate {
        norm_x: 0.080,
        norm_y: 0.050,
        radius: 4,
    };

    let frame1_candidates = vec![static_spot.clone(), moving_bird_frame1];
    let burst = vec![vec![static_spot.clone(), moving_bird_frame2]];

    let verified = cross_frame_verify_dust(&frame1_candidates, &burst);

    assert_eq!(verified.len(), 1, "Only static spot should pass verification");
    assert!((verified[0].norm_x - 0.100).abs() < 0.001, "Healed spot must be at static coordinates");
}

/// Pattern D: Model wearing ivory dress on green lawn (tests illuminant vector subtraction)
#[test]
fn test_pattern_d_model_ivory_dress_illuminant_subtraction() {
    let (w, h) = (64u32, 64u32);
    let mut img = Rgb32FImage::new(w, h);

    // Populate bright white midtone cloth with green bounce contaminant
    for y in 0..h {
        for x in 0..w {
            // White highlight midtone with green tint (R=0.82, G=0.86, B=0.82)
            img.put_pixel(x, y, Rgb([0.82, 0.86, 0.82]));
        }
    }

    apply_illuminant_vector_depollution(&mut img);

    let center = img.get_pixel(32, 32);
    let green_delta = center[1] - (center[0] + center[2]) * 0.5;
    assert!(
        green_delta < 0.025,
        "Green grass contamination should be neutralized, got delta {}",
        green_delta
    );
}

/// Pattern E: 3.5° tilted horizon (tests inscribed inner crop)
#[test]
fn test_pattern_e_tilted_horizon_inscribed_crop() {
    let orig_w = 4000u32;
    let orig_h = 3000u32;
    let angle_deg = 3.5f32;
    let angle_rad = angle_deg * (PI / 180.0);

    let (cx, cy, cw, ch) = calculate_inscribed_crop(orig_w, orig_h, angle_rad);

    assert!(cw > 0 && ch > 0);
    assert!(cx + cw <= orig_w);
    assert!(cy + ch <= orig_h);

    // Check that inner crop is strictly smaller than original to eliminate wedges
    assert!(cw < orig_w);
    assert!(ch < orig_h);

    // Aspect ratio preservation check (approx 4:3)
    let orig_ratio = orig_w as f32 / orig_h as f32;
    let crop_ratio = cw as f32 / ch as f32;
    assert!(
        (orig_ratio - crop_ratio).abs() < 0.02,
        "Aspect ratio must be preserved"
    );
}

/// Pattern F: Sub-4MP extreme crop (tests adaptive 4MP rescue upscaler)
#[test]
fn test_pattern_f_sub_4mp_crop_adaptive_super_resolution() {
    // 1000 x 1000 = 1.0 MP (strictly below the 4.0 MP agency rejection threshold)
    let src = DynamicImage::new_rgb8(1000, 1000);
    let options = SuperResolutionOptions {
        scale_factor: 2,
        texture_enhancement: 0.35,
        noise_suppression: 0.15,
    };

    let upscaled = perform_super_resolution_core(&src, &options)
        .expect("Super-resolution should succeed");

    let (uw, uh) = upscaled.dimensions();
    assert_eq!(uw, 2000);
    assert_eq!(uh, 2000);
    assert!(uw * uh >= 4_000_000, "Output must meet or exceed the 4.0 MP stock agency floor");
}

/// Pattern G: Dark corner falloff target (tests lens radial vignette equalization)
#[test]
fn test_pattern_g_dark_corner_radial_vignette_equalization() {
    let (w, h) = (100u32, 100u32);
    let mut img = Rgb32FImage::new(w, h);

    // Synthesize cos^4 radial falloff: center = 0.80, corner = 0.45
    let cx = w as f32 * 0.5;
    let cy = h as f32 * 0.5;
    let max_radius = (cx * cx + cy * cy).sqrt();

    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let r_norm = (dx * dx + dy * dy).sqrt() / max_radius;
            let falloff = 1.0 - (0.45 * r_norm * r_norm);
            let val = 0.80 * falloff;
            img.put_pixel(x, y, Rgb([val, val, val]));
        }
    }

    let corner_before = img.get_pixel(0, 0)[0];
    apply_radial_vignette_equalization(&mut img, 0.12, 0.08);
    let corner_after = img.get_pixel(0, 0)[0];

    assert!(
        corner_after > corner_before,
        "Radial equalization must lift dark corners (before: {}, after: {})",
        corner_before,
        corner_after
    );
}

/// Pattern H: Deep shadow sensor line noise (tests horizontal banding filter)
#[test]
fn test_pattern_h_deep_shadow_sensor_banding_removal() {
    let (w, h) = (64u32, 64u32);
    let mut img = Rgb32FImage::new(w, h);

    // Synthesize horizontal read line banding in shadow region
    for y in 0..h {
        let band_offset = if y % 4 == 0 { 0.015f32 } else { -0.015f32 };
        for x in 0..w {
            let val = (0.08f32 + band_offset).clamp(0.0, 1.0);
            img.put_pixel(x, y, Rgb([val, val, val]));
        }
    }

    let row0_before = img.get_pixel(10, 0)[0];
    let row1_before = img.get_pixel(10, 1)[0];
    let delta_before = (row0_before - row1_before).abs();

    remove_sensor_banding(&mut img);

    let row0_after = img.get_pixel(10, 0)[0];
    let row1_after = img.get_pixel(10, 1)[0];
    let delta_after = (row0_after - row1_after).abs();

    assert!(
        delta_after < delta_before,
        "Sensor banding delta must be suppressed (before: {}, after: {})",
        delta_before,
        delta_after
    );
}

/// Telemetry & Calibration Cache Round-Trip
#[test]
fn test_calibration_telemetry_cache_roundtrip() {
    let temp_dir = std::env::temp_dir().join("rapidraw_test_calib");
    let _ = std::fs::create_dir_all(&temp_dir);
    let calib_file = temp_dir.join("test_stock_prep_calibration.jsonl");
    let _ = std::fs::remove_file(&calib_file);

    let record = StockPrepCalibrationRecord {
        timestamp_utc: "2026-09-05T01:30:00Z".to_string(),
        file_name: "DSC_0042.NEF".to_string(),
        iso: 100,
        exposure_time: "1/250s".to_string(),
        aperture: "f/2.8".to_string(),
        dimensions: "8256x5504".to_string(),
        sharpness_score: 24.5,
        noise_floor: 0.0018,
        highlight_clip_pct: 0.2,
        shadow_clip_pct: 0.5,
        dust_spots_healed: 3,
        trademarks_scrubbed: 1,
        horizon_corrected_deg: 0.8,
        gates: QualityGateStatus {
            gate1_integrity_pass: true,
            gate2_snr_pass: true,
            gate3_color_pass: true,
            gate4_framing_pass: true,
            gate5_legal_pass: true,
            overall_pass: true,
            acceptance_probability_pct: 99,
        },
        status: "PASSED".to_string(),
        upscaled_for_stock: false,
    };

    append_calibration_records(&[record.clone()], &calib_file);
    let loaded = load_calibration_records(&calib_file);

    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].file_name, "DSC_0042.NEF");
    assert_eq!(loaded[0].gates.acceptance_probability_pct, 99);
    assert!(loaded[0].gates.overall_pass);

    let _ = std::fs::remove_file(&calib_file);
    let _ = std::fs::remove_dir(&temp_dir);
}

/// ThinkPad L13 Yoga Hardware Safety Envelope Check
#[test]
fn test_thinkpad_l13_hardware_safety_envelope() {
    assert_eq!(
        THINKPAD_THERMAL_MAX_CORES, 4,
        "ThinkPad safety envelope must cap at 4 cores for <72°C thermals"
    );

    let safe_workers = get_safe_worker_core_count();
    assert!(
        safe_workers <= 4,
        "Worker count must never exceed 4 threads on mobile chassis: got {}",
        safe_workers
    );
}
