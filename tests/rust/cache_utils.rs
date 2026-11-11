// The editor caches intermediate images under hashes of the adjustments. An edit applied before a
// cached stage must change that stage's hash, or the editor shows a stale image. An edit applied in
// the final pass must change none of them, or every slider move recomputes the whole image.
//
// The hash values change between Rust releases, so the tests only compare them with each other.

use rapidraw_lib::cache_utils;
use serde_json::{Value, json};

type HashFn = fn(&Value) -> u64;

const HASHES: [(&str, HashFn); 6] = [
    ("patch", cache_utils::calculate_patch_hash),
    ("geometry", cache_utils::calculate_geometry_hash),
    ("effects", cache_utils::calculate_effects_hash),
    ("patched_warped", cache_utils::calculate_patched_warped_hash),
    ("thumbnail_base", cache_utils::calculate_thumbnail_base_hash),
    ("transform", cache_utils::calculate_transform_hash),
];

const NO_STAGES: &[&str] = &[];
const PATCH_STAGES: &[&str] = &[
    "patch",
    "geometry",
    "patched_warped",
    "thumbnail_base",
    "transform",
];
const GEOMETRY_STAGES: &[&str] = &["geometry", "patched_warped", "thumbnail_base", "transform"];
const EFFECT_STAGES: &[&str] = &["effects", "patched_warped", "thumbnail_base", "transform"];

// The keys the geometry warp reads.
const GEOMETRY_KEYS: &[&str] = &[
    "transformDistortion",
    "transformVertical",
    "transformHorizontal",
    "transformRotate",
    "transformAspect",
    "transformScale",
    "transformXOffset",
    "transformYOffset",
    "lensDistortionAmount",
    "lensVignetteAmount",
    "lensTcaAmount",
    "lensDistortionParams",
    "lensDistortionEnabled",
    "lensTcaEnabled",
    "lensVignetteEnabled",
    "guidedPerspective",
];
const LENS_BLUR_KEYS: &[&str] = &[
    "lensBlurAmount",
    "lensBlurDiffusion",
    "lensBlurShape",
    "lensBlurMinDepth",
    "lensBlurMaxDepth",
    "lensBlurMinFade",
    "lensBlurMaxFade",
    "lensBlurDepthMap",
];
const RELIGHT_KEYS: &[&str] = &[
    "relightLights",
    "relightAmbient",
    "relightSoftness",
    "relightShine",
    "relightShadows",
    "relightShadowSoftness",
    "relightNormalMap",
];
const FOG_KEYS: &[&str] = &[
    "fogAmount",
    "fogStart",
    "fogDensity",
    "fogHeight",
    "fogVariation",
    "fogGlow",
    "fogTemperature",
    "fogTint",
    "fogDepthMap",
];
const FOG_ORIENTATION_KEYS: &[&str] = &["orientationSteps", "flipHorizontal", "flipVertical"];
const DENOISE_KEYS: &[&str] = &["aiDenoiseMethod", "aiDenoiseAmount", "aiDenoiseDetail"];
const NEGATIVE_KEYS: &[&str] = &[
    "negativeRedWeight",
    "negativeGreenWeight",
    "negativeBlueWeight",
    "negativeExposure",
    "negativeContrast",
];

// Every cached effect is enabled, and the AI patch has a stored mask.
fn base() -> Value {
    json!({
        "exposure": 0.0,
        "contrast": 0.0,
        "temperature": 0.0,
        "curves": { "luma": [{ "x": 0, "y": 0 }, { "x": 255, "y": 255 }] },
        "hsl": { "reds": { "hue": 0, "saturation": 0, "luminance": 0 } },
        "masks": [],
        "lutPath": null,
        "orientationSteps": 0,
        "rotation": 0.0,
        "flipHorizontal": false,
        "flipVertical": false,
        "crop": { "x": 0, "y": 0, "width": 100, "height": 100, "unit": "%" },
        "transformDistortion": 0,
        "transformVertical": 0,
        "transformHorizontal": 0,
        "transformRotate": 0,
        "transformAspect": 0,
        "transformScale": 100,
        "transformXOffset": 0,
        "transformYOffset": 0,
        "lensDistortionAmount": 100,
        "lensVignetteAmount": 100,
        "lensTcaAmount": 100,
        "lensDistortionParams": null,
        "lensMaker": "Lens maker",
        "lensModel": "Lens model",
        "lensDistortionEnabled": true,
        "lensTcaEnabled": true,
        "lensVignetteEnabled": true,
        "guidedPerspective": null,
        "lensBlurEnabled": true,
        "lensBlurAmount": 50,
        "lensBlurDiffusion": 50,
        "lensBlurShape": "circle",
        "lensBlurMinDepth": 0,
        "lensBlurMaxDepth": 100,
        "lensBlurMinFade": 0,
        "lensBlurMaxFade": 0,
        "lensBlurDepthMap": "depth map",
        "relightEnabled": true,
        "relightLights": [{ "x": 0.5, "y": 0.5 }],
        "relightAmbient": 50,
        "relightSoftness": 50,
        "relightShine": 0,
        "relightShadows": false,
        "relightShadowSoftness": 50,
        "relightNormalMap": "normal map",
        "fogEnabled": true,
        "fogAmount": 50,
        "fogStart": 0,
        "fogDensity": 50,
        "fogHeight": 50,
        "fogVariation": 0,
        "fogGlow": 0,
        "fogTemperature": 0,
        "fogTint": 0,
        "fogDepthMap": "depth map",
        "aiDenoiseEnabled": true,
        "aiDenoiseMethod": "nind",
        "aiDenoiseAmount": 50,
        "aiDenoiseDetail": 50,
        "negativeConversionEnabled": true,
        "negativeRedWeight": 1.0,
        "negativeGreenWeight": 1.0,
        "negativeBlueWeight": 1.0,
        "negativeExposure": 0.0,
        "negativeContrast": 0.0,
        "aiPatches": [{
            "id": "patch-1",
            "visible": true,
            "invert": false,
            "patchData": { "color": "color", "mask": "mask" },
        }],
    })
}

fn with(adjustments: &Value, key: &str, value: Value) -> Value {
    let mut changed = adjustments.clone();
    changed[key] = value;
    changed
}

fn edit(adjustments: &Value, key: &str) -> Value {
    let value = match &adjustments[key] {
        Value::Bool(b) => json!(!b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => json!(i + 1),
            None => json!(n.as_f64().unwrap() + 1.0),
        },
        Value::String(s) => json!(format!("{s}, edited")),
        Value::Array(items) => {
            let mut items = items.clone();
            items.push(json!({}));
            Value::Array(items)
        }
        _ => json!("edited"),
    };
    with(adjustments, key, value)
}

fn changed_hashes(before: &Value, after: &Value) -> Vec<&'static str> {
    let changed: Vec<_> = HASHES
        .iter()
        .filter(|(_, hash)| hash(before) != hash(after))
        .map(|(name, _)| *name)
        .collect();
    assert!(
        changed.is_empty() || changed.contains(&"transform"),
        "{changed:?} changed but the transform hash did not, so the editor reuses a stale preview"
    );
    changed
}

#[test]
fn final_pass_edits_keep_every_cache() {
    let base = base();
    for (key, value) in [
        ("exposure", json!(1.0)),
        ("contrast", json!(20)),
        ("temperature", json!(-15)),
        (
            "curves",
            json!({ "luma": [{ "x": 0, "y": 20 }, { "x": 255, "y": 255 }] }),
        ),
        (
            "hsl",
            json!({ "reds": { "hue": 10, "saturation": 0, "luminance": 0 } }),
        ),
        (
            "masks",
            json!([{ "id": "mask-1", "adjustments": { "exposure": 1.0 } }]),
        ),
        ("lutPath", json!("film.cube")),
    ] {
        assert_eq!(
            changed_hashes(&base, &with(&base, key, value)),
            NO_STAGES,
            "{key}"
        );
    }
}

#[test]
fn stage_edits_change_their_caches() {
    let base = base();
    let groups = [
        (GEOMETRY_KEYS, GEOMETRY_STAGES),
        (LENS_BLUR_KEYS, EFFECT_STAGES),
        (RELIGHT_KEYS, EFFECT_STAGES),
        (FOG_KEYS, EFFECT_STAGES),
        // Fog lays out its noise in display orientation.
        (FOG_ORIENTATION_KEYS, EFFECT_STAGES),
        (DENOISE_KEYS, PATCH_STAGES),
        (NEGATIVE_KEYS, PATCH_STAGES),
    ];
    for (keys, stages) in groups {
        for key in keys {
            assert_eq!(changed_hashes(&base, &edit(&base, key)), stages, "{key}");
        }
    }

    let crop = json!({ "x": 10, "y": 0, "width": 50, "height": 100, "unit": "%" });
    assert_eq!(
        changed_hashes(&base, &with(&base, "crop", crop)),
        ["transform"]
    );
}

#[test]
fn ai_patch_edits_change_their_caches() {
    let base = base();
    for (key, value) in [("visible", json!(false)), ("invert", json!(true))] {
        let mut changed = base.clone();
        changed["aiPatches"][0][key] = value;
        assert_eq!(changed_hashes(&base, &changed), PATCH_STAGES, "{key}");
    }
}

#[test]
fn orientation_moves_generated_patch_masks() {
    let mut base = with(&base(), "fogEnabled", json!(false));
    assert_eq!(
        changed_hashes(&base, &edit(&base, "rotation")),
        ["transform"]
    );

    // A patch without a stored mask is generated from its sub-masks in image coordinates.
    base["aiPatches"][0]["patchData"]
        .as_object_mut()
        .unwrap()
        .remove("mask");
    assert_eq!(
        changed_hashes(&base, &edit(&base, "rotation")),
        PATCH_STAGES
    );
}

#[test]
fn disabled_effects_ignore_their_settings() {
    let base = base();
    for (tool, enabled_key, keys) in [
        ("lensBlur", "lensBlurEnabled", LENS_BLUR_KEYS),
        ("relight", "relightEnabled", RELIGHT_KEYS),
        ("fog", "fogEnabled", FOG_KEYS),
        ("noiseReduction", "aiDenoiseEnabled", DENOISE_KEYS),
        (
            "negativeConversion",
            "negativeConversionEnabled",
            NEGATIVE_KEYS,
        ),
    ] {
        let switched_off = with(&base, enabled_key, json!(false));
        let hidden = with(&base, "activeTools", json!({ tool: false }));
        assert!(
            changed_hashes(&base, &switched_off).contains(&"transform"),
            "{enabled_key}"
        );
        assert!(
            changed_hashes(&base, &hidden).contains(&"transform"),
            "{tool}"
        );
        for key in keys {
            for disabled in [&switched_off, &hidden] {
                assert_eq!(
                    changed_hashes(disabled, &edit(disabled, key)),
                    NO_STAGES,
                    "{key}"
                );
            }
        }
    }
}

#[test]
fn legacy_section_visibility_hides_effects() {
    // Sidecars saved before activeTools existed hide whole panel sections instead.
    let base = base();
    for (section, key) in [
        ("effects", "lensBlurAmount"),
        ("details", "aiDenoiseAmount"),
    ] {
        let hidden = with(&base, "sectionVisibility", json!({ section: false }));
        assert!(
            changed_hashes(&base, &hidden).contains(&"transform"),
            "{section}"
        );
        assert_eq!(
            changed_hashes(&hidden, &edit(&hidden, key)),
            NO_STAGES,
            "{key}"
        );
    }
}
