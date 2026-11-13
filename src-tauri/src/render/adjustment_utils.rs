use image::DynamicImage;
use std::borrow::Cow;
use std::collections::HashMap;

use crate::app::state::AppState;
use crate::decode::as_shot::AsShot;
use crate::decode::baseline_exposure::BaselineOptions;
use crate::render::geometry::{Crop, IntoCowImage, apply_coarse_rotation, apply_flip, crop_rect};
use serde_json::{Value, json};
use std::sync::OnceLock;

const EFFECT_MAP_KEYS: [&str; 4] = [
    "lensBlurDepthMap",
    "fogDepthMap",
    "motionBlurDepthMap",
    "relightNormalMap",
];
const CACHED_EFFECT_MAP_PREFIX: &str = "__cached__:";

pub fn hydrate_sub_masks(
    sub_masks: &mut Vec<serde_json::Value>,
    cache: &mut HashMap<String, serde_json::Value>,
) {
    for sub_mask in sub_masks {
        let id = sub_mask
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if id.is_empty() {
            continue;
        }

        if let Some(params) = sub_mask
            .get_mut("parameters")
            .and_then(|p| p.as_object_mut())
        {
            let keys_to_check = ["mask_data_base64", "maskDataBase64"];
            for key in keys_to_check {
                if params.contains_key(key) {
                    let val = params.get(key).unwrap();
                    if !val.is_null() {
                        cache.insert(id.clone(), val.clone());
                    } else {
                        if let Some(cached_data) = cache.get(&id) {
                            params.insert(key.to_string(), cached_data.clone());
                        }
                    }
                }
            }
        }
    }
}

pub fn hydrate_adjustments(state: &tauri::State<AppState>, adjustments: &mut serde_json::Value) {
    let mut cache = state.patch_cache.lock().unwrap();

    if let Some(patches) = adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        for patch in patches {
            let id = patch
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();

            if !id.is_empty() {
                let has_data = patch.get("patchData").is_some_and(|v| !v.is_null());

                if has_data {
                    if let Some(data) = patch.get("patchData") {
                        cache.insert(id.clone(), data.clone());
                    }
                } else {
                    if let Some(cached_data) = cache.get(&id) {
                        patch["patchData"] = cached_data.clone();
                    }
                }
            }

            if let Some(sub_masks) = patch.get_mut("subMasks").and_then(|v| v.as_array_mut()) {
                hydrate_sub_masks(sub_masks, &mut cache);
            }
        }
    }

    if let Some(masks) = adjustments.get_mut("masks").and_then(|v| v.as_array_mut()) {
        for mask_container in masks {
            if let Some(sub_masks) = mask_container
                .get_mut("subMasks")
                .and_then(|v| v.as_array_mut())
            {
                hydrate_sub_masks(sub_masks, &mut cache);
            }
        }
    }

    let effect_map_ids = adjustments
        .as_object_mut()
        .and_then(|obj| obj.remove("effectMapIds"));

    for key in EFFECT_MAP_KEYS {
        let cached_id = adjustments
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(|v| v.strip_prefix(CACHED_EFFECT_MAP_PREFIX))
            .map(str::to_owned);

        if let Some(id) = cached_id {
            adjustments[key] = cache
                .get(&format!("effectMap:{}", id))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
        } else if let Some(id) = effect_map_ids
            .as_ref()
            .and_then(|ids| ids.get(key))
            .and_then(|v| v.as_u64())
            && let Some(value) = adjustments.get(key).filter(|v| v.is_string())
        {
            cache.insert(format!("effectMap:{}", id), value.clone());
        }
    }
}

pub fn apply_orientation_and_flip<'a, I: IntoCowImage<'a>>(
    image: I,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    let flip_horizontal = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);

    let coarse_rotated_image = apply_coarse_rotation(image.into_cow(), orientation_steps);
    apply_flip(coarse_rotated_image, flip_horizontal, flip_vertical)
}

pub fn transformed_dimensions(
    width: u32,
    height: u32,
    adjustments: &serde_json::Value,
) -> (u32, u32) {
    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    let (w, h) = if matches!(orientation_steps, 1 | 3) {
        (height, width)
    } else {
        (width, height)
    };

    serde_json::from_value::<Crop>(adjustments["crop"].clone())
        .ok()
        .and_then(|crop| crop_rect(&crop, (w, h)))
        .map_or((w, h), |(_, _, width, height)| (width, height))
}

const BASELINE_EXPOSURE_KEY: &str = "baselineExposure";

pub fn mark_baseline_exposure(adjustments: &mut Value) {
    if let Some(object) = adjustments.as_object_mut() {
        object.insert(BASELINE_EXPOSURE_KEY.to_string(), Value::Bool(true));
    }
}

pub fn default_adjustments() -> Value {
    let mut adjustments = json!({});
    mark_baseline_exposure(&mut adjustments);
    adjustments
}

fn default_adjustment_values() -> Option<&'static serde_json::Map<String, Value>> {
    static DEFAULTS: OnceLock<Option<serde_json::Map<String, Value>>> = OnceLock::new();
    DEFAULTS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../src/utils/defaultAdjustments.json"))
                .map_err(|e| log::error!("Failed to parse defaultAdjustments.json: {}", e))
                .ok()
        })
        .as_ref()
}

fn json_values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| json_values_equal(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, x)| y.get(key).is_some_and(|y| json_values_equal(x, y)))
        }
        _ => a == b,
    }
}

fn is_null_or_all_true(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(map) => map.values().all(|v| v.as_bool() == Some(true)),
        _ => false,
    }
}

pub fn is_default_adjustments(adjustments: &Value) -> bool {
    let map = match adjustments {
        Value::Null => return true,
        Value::Object(map) => map,
        _ => return false,
    };
    let Some(defaults) = default_adjustment_values() else {
        return false;
    };

    if map.get(BASELINE_EXPOSURE_KEY).and_then(Value::as_bool) != Some(true) {
        return false;
    }

    map.iter().all(|(key, value)| match key.as_str() {
        BASELINE_EXPOSURE_KEY => true,
        "activeTools" => is_null_or_all_true(value),
        _ => defaults
            .get(key)
            .is_some_and(|default| json_values_equal(value, default)),
    })
}

fn uses_baseline_exposure(adjustments: &Value) -> bool {
    adjustments.is_null()
        || adjustments
            .get(BASELINE_EXPOSURE_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

pub fn effective_baseline_exposure(
    adjustments: &Value,
    as_shot: AsShot,
    options: BaselineOptions,
) -> f32 {
    if uses_baseline_exposure(adjustments) {
        as_shot.exposure.compensation(options)
    } else {
        0.0
    }
}

fn is_section_visible(adjustments: &serde_json::Value, section: &str) -> bool {
    adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get(section))
        .and_then(|s| s.as_bool())
        .unwrap_or(true)
}

const LEGACY_SECTION_TOOLS: &[(&str, &[&str])] = &[
    ("basic", &["basic"]),
    ("curves", &["curves"]),
    (
        "color",
        &[
            "whiteBalance",
            "colorPresence",
            "hue",
            "colorGrading",
            "colorMixer",
            "colorCalibration",
        ],
    ),
    (
        "details",
        &[
            "sharpening",
            "presence",
            "noiseReduction",
            "superResolution",
            "chromaticAberration",
            "negativeConversion",
        ],
    ),
    (
        "effects",
        &[
            "creative",
            "motionBlur",
            "lensBlur",
            "relight",
            "fog",
            "lut",
            "vignette",
            "grain",
        ],
    ),
];

pub fn is_tool_active(adjustments: &serde_json::Value, tool: &str) -> bool {
    match adjustments.get("activeTools") {
        Some(active_tools) => active_tools
            .get(tool)
            .and_then(|active| active.as_bool())
            .unwrap_or(true),
        None => LEGACY_SECTION_TOOLS
            .iter()
            .find(|(_, tools)| tools.contains(&tool))
            .is_none_or(|(section, _)| is_section_visible(adjustments, section)),
    }
}

pub fn active_tools(adjustments: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    match adjustments
        .get("activeTools")
        .and_then(|tools| tools.as_object())
    {
        Some(active_tools) => active_tools.clone(),
        None => LEGACY_SECTION_TOOLS
            .iter()
            .flat_map(|(_, tools)| tools.iter())
            .map(|tool| (tool.to_string(), json!(is_tool_active(adjustments, tool))))
            .collect(),
    }
}

pub fn is_effect_enabled(adjustments: &serde_json::Value, tool: &str, enabled_key: &str) -> bool {
    adjustments[enabled_key].as_bool().unwrap_or(false) && is_tool_active(adjustments, tool)
}
