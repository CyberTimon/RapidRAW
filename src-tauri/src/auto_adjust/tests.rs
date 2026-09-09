use super::{analysis, correction, groups, storage, types::*};
use serde_json::json;
fn entry(path: &str, subject: f64) -> Entry {
    Entry {
        path: path.into(),
        fingerprint: "source".into(),
        baseline: json!({}),
        expected: json!({}),
        applied: false,
        group_id: String::new(),
        analysis: Analysis {
            subject,
            median: subject,
            p90: 0.6,
            scene: Scene::Daylight,
            confidence: 0.8,
            neutral_confidence: 0.8,
            ..Analysis::default()
        },
    }
}
#[test]
fn exposure_does_not_split_a_lighting_group_and_dark_frames_receive_more_help() {
    let mut entries = vec![entry("bright", 0.48), entry("dark", 0.12)];
    let gs = groups::establish(&mut entries);
    assert_eq!(gs.len(), 1);
    let bright =
        correction::propose(&entries[0].analysis, &gs[0], &Controls::default(), Scene::Daylight, &json!({}));
    let dark =
        correction::propose(&entries[1].analysis, &gs[0], &Controls::default(), Scene::Daylight, &json!({}));
    assert!(dark["exposure"].as_f64().unwrap() > bright["exposure"].as_f64().unwrap() + 0.5);
}
#[test]
fn groups_are_selection_order_independent_and_separate_colored_light() {
    let a = entry("a", 0.1);
    let b = entry("b", 0.5);
    let mut c = entry("c", 0.4);
    c.analysis.scene = Scene::Mixed;
    let mut forward = vec![a.clone(), b.clone(), c.clone()];
    let mut backward = vec![c, b, a];
    assert_eq!(
        serde_json::to_value(groups::establish(&mut forward)).unwrap(),
        serde_json::to_value(groups::establish(&mut backward)).unwrap()
    );
    assert_ne!(forward[0].group_id, forward[2].group_id);
}
#[test]
fn darkness_alone_is_not_night_and_night_has_lower_targets() {
    let mut a = Analysis { median: 0.05, shadows: 0.8, p99: 0.3, ..Analysis::default() };
    assert_eq!(analysis::classify(&a).0, Scene::Uncertain);
    a.p99 = 0.95;
    assert_eq!(analysis::classify(&a).0, Scene::Night);
    assert!(analysis::default_target(Scene::Night, true) < analysis::default_target(Scene::Daylight, true));
}
#[test]
fn neutralization_preserves_manual_work_and_replaces_only_owned_masks() {
    let before = json!({"exposure":1.,"temperature":12,"crop":{"x":5},"clarity":8,"masks":[{"id":"manual"},{"id":"auto","autoOwner":"old"}]});
    let after = correction::neutral(&before);
    assert_eq!(after["crop"], before["crop"]);
    assert_eq!(after["clarity"], 8);
    assert_eq!(after["masks"], json!([{"id":"manual"}]));
    assert_eq!(after["temperature"], 0);
    assert_eq!(correction::blend(after.clone(), &before, 0.), before);
    let once = correction::blend(after.clone(), &before, 0.5);
    assert_eq!(once, correction::blend(after, &before, 0.5));
}
#[test]
fn mixed_lighting_is_not_forced_to_neutral_and_uncertain_color_is_conservative() {
    let mut e = vec![entry("one", 0.4)];
    let gs = groups::establish(&mut e);
    let mut a = e[0].analysis.clone();
    a.warmth = 0.3;
    a.tint = 0.1;
    let mixed = correction::propose(&a, &gs[0], &Controls::default(), Scene::Mixed, &json!({}));
    assert_eq!(mixed["temperature"].as_f64(), Some(0.));
    assert_eq!(mixed["tint"].as_f64(), Some(0.));
    a.neutral_confidence = 0.;
    let unknown = correction::propose(&a, &gs[0], &Controls::default(), Scene::Uncertain, &json!({}));
    assert_eq!(unknown["temperature"].as_f64(), Some(0.));
}
#[test]
fn actual_image_statistics_handle_empty_and_measure_a_dark_face_separately() {
    let empty = analysis::measure(&image::RgbImage::new(0, 0), vec![], None, None, true);
    assert!(empty.median.is_finite());
    let mut image = image::RgbImage::from_pixel(100, 100, image::Rgb([190, 190, 190]));
    for y in 25..75 {
        for x in 25..75 {
            image.put_pixel(x, y, image::Rgb([45, 40, 35]));
        }
    }
    let a = analysis::measure(
        &image,
        vec![Face { bounds: [0.25, 0.25, 0.5, 0.5], confidence: 0.99, luma: 0. }],
        None,
        None,
        false,
    );
    assert!(a.subject + 0.4 < a.background);
    assert!(a.noise < 0.1);
}
#[test]
fn uncertain_or_noisy_subject_masks_are_skipped_and_existing_masks_survive() {
    let mut a = entry("a", 0.1).analysis;
    a.p90 = 0.9;
    a.p99 = 0.95;
    a.faces = vec![Face { bounds: [0.2, 0.2, 0.2, 0.2], confidence: 0.99, luma: 0.1 }];
    let mut out = json!({"masks":[{"id":"manual"}]});
    correction::add_subject_masks(&mut out, &a, 0.48, (1000., 800.), (0., 0.), "batch");
    assert_eq!(out["masks"].as_array().unwrap().len(), 2);
    assert_eq!(out["masks"][0]["id"], "manual");
    a.reduced = true;
    let mut fallback = json!({"masks":[]});
    correction::add_subject_masks(&mut fallback, &a, 0.48, (1000., 800.), (0., 0.), "batch");
    assert!(fallback["masks"].as_array().unwrap().is_empty());
}
#[test]
fn sidecar_conflicts_are_rejected_without_touching_the_newer_edit() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("photo.jpg");
    std::fs::write(&source, b"source").unwrap();
    let path = source.to_str().unwrap();
    let (_, sidecar) = crate::file_management::parse_virtual_path(path);
    let original = crate::image_processing::ImageMetadata::default();
    let bytes = serde_json::to_vec(&original).unwrap();
    std::fs::write(&sidecar, &bytes).unwrap();
    let mut newer = original.clone();
    newer.adjustments = json!({"exposure":2});
    std::fs::write(&sidecar, serde_json::to_vec(&newer).unwrap()).unwrap();
    assert!(storage::commit(path, &original, &Some(bytes)).is_err());
    assert_eq!(storage::metadata(path).unwrap().0.adjustments, newer.adjustments);
    std::fs::write(&sidecar, b"broken json").unwrap();
    assert!(storage::metadata(path).is_err());
}
#[test]
fn semantic_numbers_compare_equal_but_manual_changes_and_masks_do_not() {
    assert!(storage::same(&json!({"exposure":0}), &json!({"exposure":0.0})));
    assert!(!storage::same(&json!({"exposure":0}), &json!({"exposure":0.1})));
    assert!(!storage::same(&json!({"masks":[]}), &json!({"masks":[{"id":"manual"}]})));
}
#[test]
fn invalid_controls_are_rejected() {
    assert!(Controls { strength: f64::NAN, ..Controls::default() }.validate().is_err());
    assert!(Controls { warmth: 2., ..Controls::default() }.validate().is_err());
}

#[test]
fn severely_underexposed_daylight_stays_with_related_daylight_without_exif() {
    let mut photos = vec![entry("dark", 0.05), entry("light", 0.5)];
    for (e, value) in photos.iter_mut().zip([12, 128]) {
        e.analysis = analysis::measure(
            &image::RgbImage::from_pixel(40, 40, image::Rgb([value, value, value])),
            vec![],
            None,
            None,
            false,
        );
    }
    assert_eq!(photos[0].analysis.scene, Scene::Uncertain);
    let groups = groups::establish(&mut photos);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].scene, Scene::Daylight);
}

#[test]
fn bright_lamps_do_not_veto_recovery_but_new_face_clipping_does() {
    let before = image::RgbImage::from_pixel(20, 20, image::Rgb([240, 240, 240]));
    let after = image::RgbImage::from_pixel(20, 20, image::Rgb([255, 255, 255]));
    assert!(super::quality::clipping_cost(&before, &after, &[]) > 0.5);
    let mut lamp_before = image::RgbImage::from_pixel(20, 20, image::Rgb([120, 120, 120]));
    lamp_before.put_pixel(0, 0, image::Rgb([240, 240, 240]));
    let mut lamp_after = lamp_before.clone();
    lamp_after.put_pixel(0, 0, image::Rgb([255, 255, 255]));
    assert_eq!(super::quality::clipping_cost(&lamp_before, &lamp_after, &[]), 0.);
    let face = Face { bounds: [0., 0., 1., 1.], confidence: 0.99, luma: 0.9 };
    assert!(super::quality::clipping_cost(&before, &after, &[face]) > 0.4);
    let dark = image::RgbImage::from_pixel(20, 20, image::Rgb([120, 120, 120]));
    assert!(super::quality::clipping_cost(&dark, &after, &[]) > 2.);
}

#[test]
fn dark_people_use_midtone_recovery_without_flattening_deep_shadows() {
    let mut entries = vec![entry("person", 0.08)];
    entries[0].analysis.faces = vec![Face { bounds: [0.2, 0.2, 0.2, 0.2], confidence: 0.99, luma: 0.08 }];
    let gs = groups::establish(&mut entries);
    let result =
        correction::propose(&entries[0].analysis, &gs[0], &Controls::default(), Scene::Daylight, &json!({}));
    assert!(result["brightness"].as_f64().unwrap() > 2.);
    assert!(result["exposure"].as_f64().unwrap() <= 0.8);
    assert!(result["shadows"].as_f64().unwrap() <= 16.);
}

#[test]
fn local_masks_preserve_differences_when_group_subject_brightness_is_already_met() {
    let a = Analysis {
        subject: 0.6,
        p99: 0.95,
        faces: vec![Face { bounds: [0.2, 0.2, 0.2, 0.2], confidence: 0.99, luma: 0.3 }],
        ..Analysis::default()
    };
    let mut out = json!({"masks":[]});
    correction::add_subject_masks(&mut out, &a, 0.6, (1000., 800.), (0., 0.), "batch");
    assert!(out["masks"].as_array().unwrap().is_empty());
}

#[test]
fn saturated_stage_lighting_preserves_color_and_limits_global_recovery() {
    let mut photos = vec![entry("stage", 0.18)];
    let a = &mut photos[0].analysis;
    a.saturation = 0.65;
    a.color_variance = 1.16;
    a.warmth = 0.24;
    a.faces = vec![Face { bounds: [0.2, 0.2, 0.2, 0.2], confidence: 0.99, luma: 0.18 }];
    a.scene = analysis::classify(a).0;
    assert_eq!(a.scene, Scene::Mixed);
    let groups = groups::establish(&mut photos);
    let result =
        correction::propose(&photos[0].analysis, &groups[0], &Controls::default(), Scene::Mixed, &json!({}));
    assert_eq!(result["temperature"].as_f64(), Some(0.));
    assert!(result["exposure"].as_f64().unwrap() <= 0.4);
    assert!(result["brightness"].as_f64().unwrap() <= 0.8);
}

#[test]
fn detected_silhouettes_without_subject_detail_receive_conservative_recovery() {
    let mut photos = vec![entry("silhouette", 0.01)];
    photos[0].analysis.faces = vec![Face { bounds: [0.2, 0.2, 0.2, 0.2], confidence: 0.99, luma: 0.01 }];
    let groups = groups::establish(&mut photos);
    let result =
        correction::propose(&photos[0].analysis, &groups[0], &Controls::default(), Scene::Night, &json!({}));
    assert_eq!(result["brightness"].as_f64(), Some(0.));
    assert!(result["exposure"].as_f64().unwrap() <= 0.4);
}

#[test]
fn high_iso_dark_subject_recovery_is_capped_even_with_detected_faces() {
    let mut photos = vec![entry("noisy", 0.08)];
    photos[0].analysis.iso = Some(12800);
    photos[0].analysis.faces = vec![Face { bounds: [0.2, 0.2, 0.2, 0.2], confidence: 0.99, luma: 0.08 }];
    let groups = groups::establish(&mut photos);
    let a = &photos[0].analysis;
    let result = correction::propose(a, &groups[0], &Controls::default(), Scene::Daylight, &json!({}));
    assert!(result["brightness"].as_f64().unwrap() <= 1.2);
    assert!(result["exposure"].as_f64().unwrap() <= 0.4);
}
