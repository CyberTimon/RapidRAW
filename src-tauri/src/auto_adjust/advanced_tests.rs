use super::{advanced, analysis, correction, types::*};
use serde_json::json;

fn all_families() -> AdjustmentFamilies {
    AdjustmentFamilies {
        tone: true,
        white_balance: true,
        curves: true,
        presence: true,
        color: true,
        color_grading: true,
        color_mixer: true,
    }
}

#[test]
fn old_options_receive_safe_family_defaults() {
    let options: Options = serde_json::from_value(json!({"skipEdited":false})).unwrap();
    assert_eq!(options.adjustments, AdjustmentFamilies::default());
    assert!(options.adjustments.tone);
    assert!(options.adjustments.white_balance);
    assert!(!options.adjustments.curves);
    assert_eq!(
        options.white_balance_intent,
        WhiteBalanceIntent::PreserveAtmosphere
    );
}

#[test]
fn dedicated_white_balance_neutralizes_a_mixed_scene() {
    let analysis = Analysis {
        subject: 0.42,
        p90: 0.7,
        warmth: 0.2,
        tint: -0.12,
        neutral_confidence: 0.5,
        scene: Scene::Mixed,
        ..Analysis::default()
    };
    let group = Group {
        id: "mixed".into(),
        scene: Scene::Mixed,
        confidence: 0.5,
        paths: vec!["photo".into()],
        target: 0.42,
        warmth: analysis.warmth,
        tint: analysis.tint,
    };
    let selected = AdjustmentFamilies {
        tone: false,
        white_balance: true,
        ..AdjustmentFamilies::default()
    };
    let result = correction::propose_selected(
        &analysis,
        &group,
        &Controls::default(),
        Scene::Mixed,
        &json!({}),
        &selected,
        WhiteBalanceIntent::Neutralize,
    );
    assert!(result["temperature"].as_f64().unwrap() < 0.);
    assert!(result["tint"].as_f64().unwrap() < 0.);
}

#[test]
fn old_analysis_records_receive_new_statistic_defaults() {
    let analysis: Analysis =
        serde_json::from_value(json!({"median":0.4,"scene":"daylight"})).unwrap();
    assert_eq!(analysis.median, 0.4);
    assert!(analysis.tonal_color.is_empty());
    assert!(analysis.hue_bins.is_empty());
}

#[test]
fn disabled_families_preserve_existing_values_exactly() {
    let baseline = json!({
        "exposure": 1.2,
        "temperature": 18,
        "clarity": 9,
        "curves": {"luma":[{"x":0,"y":4},{"x":255,"y":250}]},
        "hsl": {"reds":{"hue":5,"saturation":2,"luminance":1}}
    });
    let selected = AdjustmentFamilies {
        tone: false,
        white_balance: false,
        ..AdjustmentFamilies::default()
    };
    assert_eq!(correction::neutral_selected(&baseline, &selected), baseline);

    let mut rejected = json!({"clarity":12,"structure":4,"dehaze":3});
    advanced::restore(&mut rejected, &json!({}), advanced::Family::Presence);
    assert_eq!(rejected, json!({}));
}

#[test]
fn white_balance_is_per_photo_even_inside_one_group() {
    let group = Group {
        id: "same-light".into(),
        scene: Scene::Daylight,
        confidence: 0.8,
        paths: vec!["warm".into(), "cool".into()],
        target: 0.42,
        warmth: 0.,
        tint: 0.,
    };
    let base = Analysis {
        subject: 0.42,
        p90: 0.7,
        neutral_confidence: 0.9,
        scene: Scene::Daylight,
        ..Analysis::default()
    };
    let warm = Analysis {
        warmth: 0.22,
        ..base.clone()
    };
    let cool = Analysis {
        warmth: -0.18,
        ..base
    };
    let controls = Controls::default();
    let warm_result = correction::propose(&warm, &group, &controls, Scene::Daylight, &json!({}));
    let cool_result = correction::propose(&cool, &group, &controls, Scene::Daylight, &json!({}));
    assert!(warm_result["temperature"].as_f64().unwrap() < 0.);
    assert!(cool_result["temperature"].as_f64().unwrap() > 0.);
}

#[test]
fn generated_curves_are_bounded_and_monotonic() {
    let mut out = json!({});
    let analysis = Analysis {
        median: 0.32,
        p10: 0.05,
        p90: 0.45,
        tonal_color: vec![ColorSample::default(); 3],
        ..Analysis::default()
    };
    advanced::apply(
        &mut out,
        advanced::Family::Curves,
        &analysis,
        Scene::Daylight,
    );
    for channel in ["luma", "red", "green", "blue"] {
        let points = out["curves"][channel].as_array().unwrap();
        assert_eq!(points.first().unwrap()["y"].as_f64(), Some(0.));
        assert_eq!(points.last().unwrap()["y"].as_f64(), Some(255.));
        assert!(
            points
                .windows(2)
                .all(|pair| { pair[0]["y"].as_f64().unwrap() < pair[1]["y"].as_f64().unwrap() })
        );
    }
}

#[test]
fn nested_adjustments_follow_strength_and_low_confidence_mixer_stays_neutral() {
    let baseline = correction::neutral_selected(&json!({}), &all_families());
    let mut candidate = baseline.clone();
    candidate["colorGrading"]["shadows"]["saturation"] = json!(10);
    candidate["hsl"]["blues"]["luminance"] = json!(8);
    let half = correction::blend_selected(candidate, &baseline, 0.5, &all_families());
    assert_eq!(half["colorGrading"]["shadows"]["saturation"], 5.0);
    assert_eq!(half["hsl"]["blues"]["luminance"], 4.0);

    let mut mixer = baseline;
    advanced::apply(
        &mut mixer,
        advanced::Family::ColorMixer,
        &Analysis::default(),
        Scene::Daylight,
    );
    assert!(
        mixer["hsl"]
            .as_object()
            .unwrap()
            .values()
            .all(|value| value["hue"] == 0)
    );
}

#[test]
fn color_statistics_exclude_detected_faces_from_mixer_bins() {
    let image = image::RgbImage::from_pixel(20, 20, image::Rgb([210, 80, 55]));
    let face = Face {
        bounds: [0., 0., 1., 1.],
        confidence: 0.99,
        luma: 0.,
    };
    let measured = analysis::measure(&image, vec![face], None, None, false);
    assert!(measured.hue_bins.iter().all(|bin| bin.coverage == 0.));
}
