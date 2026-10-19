use image::DynamicImage;
use std::borrow::Cow;
use std::collections::HashMap;

use crate::app_state::AppState;
use crate::image_processing::{
    Crop, IntoCowImage, apply_coarse_rotation, apply_crop, apply_flip, apply_geometry_warp,
    apply_rotation,
};

const EFFECT_MAP_KEYS: [&str; 3] = ["lensBlurDepthMap", "fogDepthMap", "relightNormalMap"];
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

pub fn apply_spatial_transformations<'a, I: IntoCowImage<'a>>(
    image: I,
    adjustments: &serde_json::Value,
) -> (Cow<'a, DynamicImage>, (f32, f32)) {
    let rotation_degrees = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;

    let flipped_image = apply_orientation_and_flip(image, adjustments);
    let rotated_image = apply_rotation(flipped_image, rotation_degrees);

    let crop_data: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();
    let crop_json = serde_json::to_value(crop_data).unwrap_or(serde_json::Value::Null);
    let cropped_image = apply_crop(rotated_image, &crop_json);

    let unscaled_crop_offset = crop_data.map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));

    (cropped_image, unscaled_crop_offset)
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

    let crop: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();
    crop.and_then(|c| {
        let (x, y) = (c.x.round() as u32, c.y.round() as u32);
        let (crop_w, crop_h) = (c.width.round() as u32, c.height.round() as u32);
        (crop_w > 0 && crop_h > 0 && x < w && y < h)
            .then(|| ((w - x).min(crop_w), (h - y).min(crop_h)))
    })
    .unwrap_or((w, h))
}

pub fn apply_all_transformations<'a, I: IntoCowImage<'a>>(
    image: I,
    adjustments: &serde_json::Value,
) -> (Cow<'a, DynamicImage>, (f32, f32)) {
    let start_time = std::time::Instant::now();
    let image = image.into_cow();

    let warped_image = apply_geometry_warp(image, adjustments);
    let relit_image = crate::relight::apply_relight(warped_image, adjustments);
    let fogged_image = crate::fog::apply_fog(relit_image, adjustments);
    let blurred_image = crate::lens_blur::apply_lens_blur(fogged_image, adjustments);

    let (cropped_image, unscaled_crop_offset) =
        apply_spatial_transformations(blurred_image, adjustments);

    let total_duration = start_time.elapsed();
    log::info!("apply_all_transformations took {:.2?}", total_duration);

    (cropped_image, unscaled_crop_offset)
}
