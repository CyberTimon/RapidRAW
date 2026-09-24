use std::fs;
use std::path::Path;

#[test]
fn test_immunization_vault_audit_gate_41_clean_pass() {
    let vault_path = Path::new("../tests/immunization_vault.json");
    let fallback_path = Path::new("tests/immunization_vault.json");

    let final_path = if vault_path.exists() {
        vault_path
    } else if fallback_path.exists() {
        fallback_path
    } else {
        panic!("Immunization vault tests/immunization_vault.json does not exist!");
    };

    let content = fs::read_to_string(final_path)
        .expect("Failed to read immunization vault JSON");
    let json: serde_json::Value = serde_json::from_str(&content)
        .expect("Failed to parse immunization vault JSON");

    let total = json["total_audited"].as_u64().unwrap_or(0);
    let clean = json["clean_pass_count"].as_u64().unwrap_or(0);
    let flaws = json["flaw_count"].as_u64().unwrap_or(999);

    assert_eq!(total, 41, "Immunization vault must certify exactly 41 datasets");
    assert_eq!(clean, 41, "All 41 datasets in immunization vault must be clean passes");
    assert_eq!(flaws, 0, "Immunization vault must have 0 flaws");

    let results = json["results"].as_array().expect("results must be an array");
    assert_eq!(results.len(), 41, "Results array must contain 41 entries");

    for entry in results {
        let label = entry["label"].as_str().unwrap_or("unknown");
        let passed = entry["passed"].as_bool().unwrap_or(false);
        let failure_reasons = entry["failure_reasons"].as_array();
        let border_black_pct = entry["border_black_pct"].as_f64().unwrap_or(1.0);

        assert!(passed, "Dataset {} failed in immunization vault!", label);
        assert!(
            failure_reasons.map_or(false, |r| r.is_empty()),
            "Dataset {} has failure reasons: {:?}",
            label,
            failure_reasons
        );
        if label.contains("_Pano") {
            assert!(
                border_black_pct < 0.001,
                "Dataset {} has border black pixel percentage {:.4}% > 0.1%",
                label,
                border_black_pct * 100.0
            );
        }
    }
}

#[test]
fn test_adversarial_poison_rejection_suite() {
    // 1. Empty image list rejected cleanly
    let res = rapidraw_lib::panorama_stitching::stitch_images_headless(vec![], rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical, 0.5);
    assert!(res.is_err(), "Empty image paths must return Err");

    // 2. Single image list rejected cleanly
    let res = rapidraw_lib::panorama_stitching::stitch_images_headless(vec!["dummy.jpg".into()], rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical, 0.5);
    assert!(res.is_err(), "Single image path must return Err");

    // 3. Non-existent files rejected cleanly without panic
    let res = rapidraw_lib::panorama_stitching::stitch_images_headless(
        vec!["non_existent_1.cr2".into(), "non_existent_2.cr2".into()],
        rapidraw_lib::panorama_utils::camera_model::PanoramaProjection::Cylindrical,
        0.5,
    );
    assert!(res.is_err(), "Non-existent files must return Err gracefully");

    // 4. HDR Fusion with empty frames rejected cleanly without panic
    let empty_frames: Vec<image::Rgb32FImage> = vec![];
    let empty_scales: Vec<f32> = vec![];
    let options = rapidraw_lib::hdr_fusion::HdrMergeOptions::default();
    let res = rapidraw_lib::hdr_fusion::fuse_exposures_dual::<tauri::Wry>(
        &empty_frames,
        &empty_scales,
        &options,
        None,
        None,
    );
    assert!(res.is_err(), "Empty frames for HDR fusion must return Err without panic");
}
