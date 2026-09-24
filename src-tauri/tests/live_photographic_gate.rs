use std::path::Path;
use image::{Rgb, Rgb32FImage};
use rapidraw_lib::hdr_panorama::cluster_hdr_brackets_robust;
use rapidraw_lib::quality_shield::{
    enforce_photographic_quality_invariants, measure_photographic_histogram,
    validate_panorama_geometry, QualityGateOptions,
};

#[test]
fn test_hdr_bracket_clustering_real_4029_to_4034() {
    let raw_dir = Path::new("D:/neapdirbti");
    if !raw_dir.exists() {
        eprintln!("Skipping test_hdr_bracket_clustering_real_4029_to_4034: D:/neapdirbti not present");
        return;
    }

    let paths: Vec<String> = (4029..=4034)
        .map(|i| raw_dir.join(format!("IMG_{}.CR2", i)).to_string_lossy().to_string())
        .filter(|p| Path::new(p).exists())
        .collect();

    if paths.len() < 6 {
        eprintln!("Skipping: 4029..4034 not completely present in D:/neapdirbti");
        return;
    }

    let (panels, outliers) = cluster_hdr_brackets_robust(&paths);
    println!("4029..4034 panels ({}):", panels.len());
    for (i, p) in panels.iter().enumerate() {
        println!("  Panel {}: {:?}", i, p.paths);
    }
    for p in &paths {
        let file_bytes = std::fs::read(p).unwrap_or_default();
        let exp = rapidraw_lib::exif_processing::read_exposure_time_secs(p, &file_bytes).unwrap_or(0.0);
        let iso = rapidraw_lib::exif_processing::read_iso(p, &file_bytes).unwrap_or(0);
        let f = rapidraw_lib::exif_processing::read_f_number(p, &file_bytes).unwrap_or(0.0);
        let scale = rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(std::time::Duration::from_secs_f32(exp), iso as f32, f);
        println!("  {}: exp={:.5}s, iso={}, f={:.1}, scale={:.5}", p, exp, iso, f, scale);
    }

    assert_eq!(outliers.len(), 0, "4029..4034 burst should have no temporal outliers");
    assert_eq!(panels.len(), 2, "4029..4034 (f/8 vs f/11) should cluster into exactly 2 panels");
    for panel in &panels {
        assert_eq!(panel.paths.len(), 3, "Each panel should contain a 3-exposure bracket");
    }
}

#[test]
fn test_hdr_bracket_clustering_real_4053_to_4055() {
    let raw_dir = Path::new("D:/neapdirbti");
    if !raw_dir.exists() {
        return;
    }

    let paths: Vec<String> = (4053..=4055)
        .map(|i| raw_dir.join(format!("IMG_{}.CR2", i)).to_string_lossy().to_string())
        .filter(|p| Path::new(p).exists())
        .collect();

    if paths.len() < 3 {
        return;
    }

    let (panels, outliers) = cluster_hdr_brackets_robust(&paths);
    println!("4053..4055 panels ({}):", panels.len());
    for (i, p) in panels.iter().enumerate() {
        println!("  Panel {}: {:?}", i, p.paths);
    }
    for p in &paths {
        let file_bytes = std::fs::read(p).unwrap_or_default();
        let exp = rapidraw_lib::exif_processing::read_exposure_time_secs(p, &file_bytes).unwrap_or(0.0);
        let iso = rapidraw_lib::exif_processing::read_iso(p, &file_bytes).unwrap_or(0);
        let f = rapidraw_lib::exif_processing::read_f_number(p, &file_bytes).unwrap_or(0.0);
        let scale = rapidraw_lib::hdr_deghosting::compute_physical_exposure_scale(std::time::Duration::from_secs_f32(exp), iso as f32, f);
        println!("  {}: exp={:.5}s, iso={}, f={:.1}, scale={:.5}", p, exp, iso, f, scale);
    }
    assert_eq!(outliers.len(), 0);
    assert_eq!(panels.len(), 1, "4053..4055 should cluster into exactly 1 HDR panel");
    assert_eq!(panels[0].paths.len(), 3);
}

#[test]
fn test_hdr_pano_temporal_outlier_rejection_4065_to_4089() {
    let raw_dir = Path::new("D:/neapdirbti");
    if !raw_dir.exists() {
        return;
    }

    let paths: Vec<String> = (4065..=4089)
        .map(|i| raw_dir.join(format!("IMG_{}.CR2", i)).to_string_lossy().to_string())
        .filter(|p| Path::new(p).exists())
        .collect();

    if paths.len() < 25 {
        return;
    }

    let (panels, outliers) = cluster_hdr_brackets_robust(&paths);
    println!("4065..4089 panels: {}, outliers: {:?}", panels.len(), outliers);

    // IMG_4089 was shot 17 minutes later with a large timestamp disconnect
    let has_4089_outlier = outliers.iter().any(|p| p.contains("IMG_4089"));
    assert!(
        has_4089_outlier,
        "IMG_4089 must be detected and pruned as a temporal outlier from the burst sweep"
    );

    assert_eq!(
        panels.len(),
        8,
        "The 24 remaining images in 4065..4088 must form exactly 8 HDR panorama angle panels"
    );
    for panel in &panels {
        assert_eq!(panel.paths.len(), 3, "Each panorama panel should have 3 bracketed exposures");
    }
}

#[test]
fn test_photographic_quality_shield_invariants_elevation_fix() {
    let width = 256;
    let height = 256;
    let mut washed_out = Rgb32FImage::new(width, height);

    // Simulate Flaw 3 (washed out veil: minimum luminance around 165 DN in 8-bit, 0.65 in 32F)
    for y in 0..height {
        for x in 0..width {
            let base_val = 0.65 + (x as f32 / width as f32) * 0.25; // values in [0.65, 0.90]
            washed_out.put_pixel(x, y, Rgb([base_val, base_val, base_val]));
        }
    }

    let pre_stats = measure_photographic_histogram(&washed_out);
    let pre_min_dn = pre_stats.min_luminance * 255.0;
    assert!(
        pre_min_dn > 150.0,
        "Pre-condition: minimum luminance must be elevated before quality shield"
    );

    // Enforce photographic quality invariants
    let options = QualityGateOptions::default();
    let post_stats = enforce_photographic_quality_invariants(&mut washed_out, &options);

    let post_min_dn = post_stats.min_luminance * 255.0;
    let post_std_dn = post_stats.std_luminance * 255.0;
    println!(
        "Quality Shield Post-stats: min_luma={:.1} DN, max_luma={:.1} DN, mean_luma={:.1} DN, std={:.1} DN, was_stretched={}",
        post_min_dn, post_stats.max_luminance * 255.0, post_stats.mean_luminance * 255.0, post_std_dn, post_stats.was_stretched
    );

    assert!(
        post_min_dn <= 10.0,
        "Post-condition: black point must be anchored to true photographic black (Ansel Adams Zone 0 <= 10 DN), got {:.1}",
        post_min_dn
    );
    assert!(
        post_std_dn >= 35.0,
        "Post-condition: dynamic range must be expanded with contrast std >= 35 DN, got {:.1}",
        post_std_dn
    );
    assert!(
        post_stats.was_stretched,
        "Quality shield must record that histogram stretch was applied"
    );
}

#[test]
fn test_panorama_geometry_validation() {
    // 1. Valid horizontal panorama (e.g. 5000 x 2000, ratio 2.5) with 45° horizontal sweep
    let good_report = validate_panorama_geometry(5000, 2000, Some(45.0));
    assert!(good_report.is_ok(), "Horizontal panorama (W > H) must pass geometry validation");

    // 2. Vertical collapsed panorama (e.g. 2000 x 3000, ratio 0.67, simulating Flaw 4 inverted sweep)
    let collapsed_report = validate_panorama_geometry(2000, 3000, Some(45.0));
    assert!(
        collapsed_report.is_err(),
        "Vertical collapsed sweep (W < H for horizontal sweep) must be rejected"
    );
    let err_msg = collapsed_report.unwrap_err();
    assert!(
        err_msg.contains("Geometric anomaly detected") && err_msg.contains("collapsed to vertical"),
        "Failure reasons must cite vertical collapse: {}",
        err_msg
    );
}

#[test]
fn test_photographic_critic_and_auto_loop_certification() {
    let raw_path = Path::new("D:/neapdirbti/IMG_4053_Certified.jpg");
    if !raw_path.exists() {
        eprintln!("Skipping test_photographic_critic_and_auto_loop_certification: IMG_4053_Certified.jpg not present");
        return;
    }

    let img_bytes = std::fs::read(raw_path).unwrap();
    let dyn_img = image::load_from_memory(&img_bytes).unwrap();
    let mut rgb32f = dyn_img.to_rgb32f();

    // 1. Initial critic evaluation
    let pre_report = rapidraw_lib::photographic_critic::evaluate_photographic_quality(&rgb32f);
    println!("Pre-Optimization Critic Report: {}", pre_report.diagnostic_summary);

    // 2. Run closed-loop auto-tuning
    let post_report = rapidraw_lib::auto_tune_loop::optimize_photographic_rendering(&mut rgb32f, Some("test_4053_loop"));
    println!("Post-Optimization Critic Report: {}", post_report.diagnostic_summary);

    assert!(
        post_report.overall_score >= 98.0,
        "Post-optimization score must meet Studio Certified standard (>= 98.0), got {:.1}",
        post_report.overall_score
    );
    assert!(
        post_report.halo_score >= 98.0,
        "Halo score must be >= 98.0 (zero boundary halos), got {:.1}",
        post_report.halo_score
    );
    assert!(
        post_report.highlight_score >= 98.0,
        "Highlight rolloff score must be >= 98.0 (filmic shoulder), got {:.1}",
        post_report.highlight_score
    );
    assert!(
        post_report.shadow_score >= 98.0,
        "Shadow score must be >= 98.0 (Zone 0 anchoring), got {:.1}",
        post_report.shadow_score
    );
    assert!(
        post_report.color_score >= 98.0,
        "Color harmony score must be >= 98.0 (OkLab neutral shadows), got {:.1}",
        post_report.color_score
    );
    assert!(
        post_report.is_studio_certified,
        "Image must be certified as commercial studio grade across all dimensions (>= 98.0)"
    );
}

