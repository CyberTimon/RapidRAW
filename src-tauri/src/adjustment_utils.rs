use image::DynamicImage;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};

use crate::app_state::{AppState, PreviewAssetCache};
use crate::image_processing::{
    Crop, IntoCowImage, apply_coarse_rotation, apply_crop, apply_flip, apply_geometry_warp,
    apply_rotation,
};

struct AssetField<'a> {
    group: String,
    transport_key: String,
    field: &'static str,
    value: &'a serde_json::Value,
    required: bool,
    legacy_lookup: bool,
}

fn reference_flags(value: &serde_json::Value, field: &str) -> (bool, bool) {
    if let Some(fields) = value.get("previewAssetFields").and_then(|v| v.as_array()) {
        (
            fields.iter().any(|item| item.as_str() == Some(field)),
            false,
        )
    } else {
        (false, true)
    }
}

fn asset_id(value: &serde_json::Value, kind: &str) -> String {
    value
        .get("previewAssetKey")
        .or_else(|| value.get("id"))
        .and_then(|v| v.as_str())
        .filter(|id| !id.is_empty())
        .unwrap_or(if kind == "mask" {
            "<unkeyed-mask>"
        } else {
            "<unkeyed-patch>"
        })
        .to_string()
}

fn collect_sub_mask_fields<'a>(
    sub_masks: &'a [serde_json::Value],
    fields: &mut Vec<AssetField<'a>>,
) {
    for sub_mask in sub_masks {
        let id = asset_id(sub_mask, "mask");
        if let Some(params) = sub_mask.get("parameters").and_then(|p| p.as_object()) {
            for field in ["mask_data_base64", "maskDataBase64"] {
                if let Some(value) = params.get(field) {
                    let (required, legacy_lookup) = reference_flags(sub_mask, field);
                    fields.push(AssetField {
                        group: format!("mask:{id}"),
                        transport_key: id.clone(),
                        field,
                        value,
                        required,
                        legacy_lookup,
                    });
                }
            }
        }
    }
}

fn collect_adjustment_fields<'a>(
    adjustments: &'a serde_json::Value,
    fields: &mut Vec<AssetField<'a>>,
) {
    if let Some(patches) = adjustments.get("aiPatches").and_then(|v| v.as_array()) {
        for patch in patches {
            let id = asset_id(patch, "patch");
            if let Some(value) = patch.get("patchData") {
                let (required, legacy_lookup) = reference_flags(patch, "patchData");
                fields.push(AssetField {
                    group: format!("patch:{id}"),
                    transport_key: id,
                    field: "patchData",
                    value,
                    required,
                    legacy_lookup: legacy_lookup
                        && !patch
                            .get("isLoading")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                });
            }
            if let Some(sub_masks) = patch.get("subMasks").and_then(|v| v.as_array()) {
                collect_sub_mask_fields(sub_masks, fields);
            }
        }
    }
    if let Some(masks) = adjustments.get("masks").and_then(|v| v.as_array()) {
        for mask in masks {
            if let Some(sub_masks) = mask.get("subMasks").and_then(|v| v.as_array()) {
                collect_sub_mask_fields(sub_masks, fields);
            }
        }
    }
}

type ResolvedAssets = HashMap<(String, &'static str), serde_json::Value>;

fn resolve_references(
    fields: &[AssetField<'_>],
    cache: &mut PreviewAssetCache,
) -> Result<ResolvedAssets, String> {
    // Resolve every stripped field before inserting inline values. An inline
    // asset that evicts a second referenced asset cannot break this request.
    let inline: HashMap<(&str, &'static str), &serde_json::Value> = fields
        .iter()
        .filter(|asset| !asset.value.is_null())
        .map(|asset| ((asset.group.as_str(), asset.field), asset.value))
        .collect();
    let mut resolved = HashMap::new();
    let mut missing = BTreeSet::new();
    for asset in fields
        .iter()
        .filter(|asset| asset.value.is_null() && (asset.required || asset.legacy_lookup))
    {
        let value = inline
            .get(&(asset.group.as_str(), asset.field))
            .map(|value| (*value).clone())
            .or_else(|| cache.get_field(&asset.group, asset.field));
        if let Some(value) = value {
            resolved.insert((asset.group.clone(), asset.field), value);
        } else if asset.required {
            missing.insert(asset.transport_key.clone());
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "PREVIEW_ASSET_MISSING:{}",
            serde_json::json!({
                "cacheEpoch": cache.epoch(),
                "missingKeys": missing.into_iter().collect::<Vec<_>>()
            })
        ));
    }
    Ok(resolved)
}

fn fill_field(
    value: &mut serde_json::Value,
    group: String,
    field: &'static str,
    resolved: &ResolvedAssets,
) {
    if value.is_null()
        && let Some(retained) = resolved.get(&(group, field))
    {
        *value = retained.clone();
    }
}

fn fill_sub_masks(
    sub_masks: &mut [serde_json::Value],
    resolved: &ResolvedAssets,
    cache: &mut PreviewAssetCache,
) {
    for sub_mask in sub_masks {
        let group = format!("mask:{}", asset_id(sub_mask, "mask"));
        if let Some(params) = sub_mask
            .get_mut("parameters")
            .and_then(|p| p.as_object_mut())
        {
            let inline_fields: HashMap<String, serde_json::Value> =
                ["mask_data_base64", "maskDataBase64"]
                    .into_iter()
                    .filter_map(|field| {
                        params
                            .get(field)
                            .filter(|value| !value.is_null())
                            .map(|value| (field.to_string(), value.clone()))
                    })
                    .collect();
            for field in ["mask_data_base64", "maskDataBase64"] {
                if let Some(value) = params.get_mut(field) {
                    fill_field(value, group.clone(), field, resolved);
                }
            }
            if !inline_fields.is_empty() {
                cache.insert_group(group, inline_fields);
            }
        }
    }
}

pub fn hydrate_sub_masks(
    sub_masks: &mut [serde_json::Value],
    cache: &mut PreviewAssetCache,
) -> Result<(), String> {
    let mut fields = Vec::new();
    collect_sub_mask_fields(sub_masks, &mut fields);
    let resolved = resolve_references(&fields, cache)?;
    fill_sub_masks(sub_masks, &resolved, cache);
    Ok(())
}

pub fn hydrate_adjustments(
    state: &tauri::State<AppState>,
    adjustments: &mut serde_json::Value,
) -> Result<(), String> {
    let mut cache = state.patch_cache.lock().unwrap();
    let mut fields = Vec::new();
    collect_adjustment_fields(adjustments, &mut fields);
    let resolved = resolve_references(&fields, &mut cache)?;

    if let Some(patches) = adjustments
        .get_mut("aiPatches")
        .and_then(|v| v.as_array_mut())
    {
        for patch in patches {
            let group = format!("patch:{}", asset_id(patch, "patch"));
            if let Some(value) = patch.get_mut("patchData") {
                let inline = (!value.is_null()).then(|| value.clone());
                fill_field(value, group.clone(), "patchData", &resolved);
                if let Some(inline) = inline {
                    cache.insert_group(group, HashMap::from([("patchData".to_string(), inline)]));
                }
            }
            if let Some(sub_masks) = patch.get_mut("subMasks").and_then(|v| v.as_array_mut()) {
                fill_sub_masks(sub_masks, &resolved, &mut cache);
            }
        }
    }
    if let Some(masks) = adjustments.get_mut("masks").and_then(|v| v.as_array_mut()) {
        for mask in masks {
            if let Some(sub_masks) = mask.get_mut("subMasks").and_then(|v| v.as_array_mut()) {
                fill_sub_masks(sub_masks, &resolved, &mut cache);
            }
        }
    }
    Ok(())
}

pub fn apply_spatial_transformations<'a, I: IntoCowImage<'a>>(
    image: I,
    adjustments: &serde_json::Value,
) -> (Cow<'a, DynamicImage>, (f32, f32)) {
    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    let rotation_degrees = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
    let flip_horizontal = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);

    let coarse_rotated_image = apply_coarse_rotation(image.into_cow(), orientation_steps);
    let flipped_image = apply_flip(coarse_rotated_image, flip_horizontal, flip_vertical);
    let rotated_image = apply_rotation(flipped_image, rotation_degrees);

    let crop_data: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();
    let crop_json = serde_json::to_value(crop_data).unwrap_or(serde_json::Value::Null);
    let cropped_image = apply_crop(rotated_image, &crop_json);

    let unscaled_crop_offset = crop_data.map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));

    (cropped_image, unscaled_crop_offset)
}

pub fn apply_all_transformations<'a, I: IntoCowImage<'a>>(
    image: I,
    adjustments: &serde_json::Value,
) -> (Cow<'a, DynamicImage>, (f32, f32)) {
    let start_time = std::time::Instant::now();
    let image = image.into_cow();

    let warped_image = apply_geometry_warp(image, adjustments);
    let blurred_image = crate::lens_blur::apply_lens_blur(warped_image, adjustments);

    let (cropped_image, unscaled_crop_offset) =
        apply_spatial_transformations(blurred_image, adjustments);

    let total_duration = start_time.elapsed();
    log::info!("apply_all_transformations took {:.2?}", total_duration);

    (cropped_image, unscaled_crop_offset)
}

#[cfg(test)]
mod preview_asset_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn older_mask_requests_cannot_overwrite_newer_acknowledged_pixels() {
        let mut cache = PreviewAssetCache::new(1024);
        let mut old = vec![
            json!({"id":"mask", "previewAssetKey":"mask:1", "parameters":{"maskDataBase64":"AAAA"}}),
        ];
        let mut new = vec![
            json!({"id":"mask", "previewAssetKey":"mask:2", "parameters":{"maskDataBase64":"BBBB"}}),
        ];
        hydrate_sub_masks(&mut new, &mut cache).unwrap();
        hydrate_sub_masks(&mut old, &mut cache).unwrap();
        let mut reference = vec![
            json!({"id":"mask", "previewAssetKey":"mask:2", "parameters":{"maskDataBase64":null}}),
        ];
        hydrate_sub_masks(&mut reference, &mut cache).unwrap();
        assert_eq!(reference[0]["parameters"]["maskDataBase64"], "BBBB");
        reference[0]["previewAssetKey"] = json!("mask:1");
        reference[0]["parameters"]["maskDataBase64"] = serde_json::Value::Null;
        hydrate_sub_masks(&mut reference, &mut cache).unwrap();
        assert_eq!(reference[0]["parameters"]["maskDataBase64"], "AAAA");
    }

    #[test]
    fn bitmap_fields_and_patch_ids_do_not_share_cache_entries() {
        let mut cache = PreviewAssetCache::new(1024);
        cache.insert_group(
            "patch:same".into(),
            HashMap::from([("patchData".into(), json!({"color":"PATCH"}))]),
        );
        let mut masks = vec![
            json!({"id":"same", "parameters":{"maskDataBase64":"CAMEL","mask_data_base64":"SNAKE"}}),
        ];
        hydrate_sub_masks(&mut masks, &mut cache).unwrap();
        masks[0]["parameters"] = json!({"maskDataBase64":null,"mask_data_base64":null});
        hydrate_sub_masks(&mut masks, &mut cache).unwrap();
        assert_eq!(masks[0]["parameters"]["maskDataBase64"], "CAMEL");
        assert_eq!(masks[0]["parameters"]["mask_data_base64"], "SNAKE");
        assert_eq!(
            cache.get_field("patch:same", "patchData").unwrap()["color"],
            "PATCH"
        );
    }

    #[test]
    fn evicted_or_oversized_mask_is_reported_before_rendering() {
        let mut cache = PreviewAssetCache::new(1);
        let mut full = vec![
            json!({"id":"m", "previewAssetKey":"m:mask:v1", "parameters":{"maskDataBase64":"AAAA"}}),
        ];
        hydrate_sub_masks(&mut full, &mut cache).unwrap();
        assert!(cache.retained_keys(&["m:mask:v1".into()]).is_empty());

        let mut stripped = vec![
            json!({"id":"m", "previewAssetKey":"m:mask:v1", "previewAssetFields":["maskDataBase64"], "parameters":{"maskDataBase64":null}}),
        ];
        let error = hydrate_sub_masks(&mut stripped, &mut cache).unwrap_err();
        assert!(error.starts_with("PREVIEW_ASSET_MISSING:"));
        let detail: serde_json::Value =
            serde_json::from_str(error.strip_prefix("PREVIEW_ASSET_MISSING:").unwrap()).unwrap();
        assert_eq!(detail["missingKeys"], json!(["m:mask:v1"]));
        assert!(stripped[0]["parameters"]["maskDataBase64"].is_null());
    }

    #[test]
    fn same_request_refs_are_pinned_before_inline_insertions_evict_them() {
        let mut cache = PreviewAssetCache::new(150);
        let mut first = vec![
            json!({"id":"a", "previewAssetKey":"a:mask:v1", "parameters":{"maskDataBase64":"AAAA"}}),
        ];
        hydrate_sub_masks(&mut first, &mut cache).unwrap();
        let mut next = vec![
            json!({"id":"b", "previewAssetKey":"b:mask:v1", "parameters":{"maskDataBase64":"BBBB"}}),
            json!({"id":"a", "previewAssetKey":"a:mask:v1", "previewAssetFields":["maskDataBase64"], "parameters":{"maskDataBase64":null}}),
        ];
        hydrate_sub_masks(&mut next, &mut cache).unwrap();
        assert_eq!(next[1]["parameters"]["maskDataBase64"], "AAAA");
        assert!(cache.retained_keys(&["a:mask:v1".into()]).is_empty());
        assert_eq!(
            cache.retained_keys(&["b:mask:v1".into()]),
            vec!["b:mask:v1"]
        );
    }

    #[test]
    fn mixed_size_mask_fields_are_retained_together_or_not_at_all() {
        let mut cache = PreviewAssetCache::new(180);
        let mut full = vec![json!({
            "id":"m", "previewAssetKey":"m:mask:v1",
            "parameters":{"mask_data_base64":"X".repeat(300),"maskDataBase64":"Y"}
        })];
        hydrate_sub_masks(&mut full, &mut cache).unwrap();
        assert!(cache.retained_keys(&["m:mask:v1".into()]).is_empty());
        assert_eq!(cache.get_field("mask:m:mask:v1", "maskDataBase64"), None);

        let mut stripped = vec![json!({
            "id":"m", "previewAssetKey":"m:mask:v1",
            "previewAssetFields":["mask_data_base64","maskDataBase64"],
            "parameters":{"mask_data_base64":null,"maskDataBase64":null}
        })];
        assert!(
            hydrate_sub_masks(&mut stripped, &mut cache)
                .unwrap_err()
                .contains("m:mask:v1")
        );
    }

    #[test]
    fn eviction_after_ack_requires_a_full_resend() {
        let mut cache = PreviewAssetCache::new(150);
        let mut a = vec![
            json!({"id":"a", "previewAssetKey":"a:mask:v1", "parameters":{"maskDataBase64":"AAAA"}}),
        ];
        let mut b = vec![
            json!({"id":"b", "previewAssetKey":"b:mask:v1", "parameters":{"maskDataBase64":"BBBB"}}),
        ];
        hydrate_sub_masks(&mut a, &mut cache).unwrap();
        assert_eq!(
            cache.retained_keys(&["a:mask:v1".into()]),
            vec!["a:mask:v1"]
        );
        hydrate_sub_masks(&mut b, &mut cache).unwrap();
        assert!(cache.retained_keys(&["a:mask:v1".into()]).is_empty());
        let mut stripped = vec![
            json!({"id":"a", "previewAssetKey":"a:mask:v1", "previewAssetFields":["maskDataBase64"], "parameters":{"maskDataBase64":null}}),
        ];
        assert!(
            hydrate_sub_masks(&mut stripped, &mut cache)
                .unwrap_err()
                .contains("a:mask:v1")
        );
        hydrate_sub_masks(&mut a, &mut cache).unwrap();
        assert_eq!(
            cache.retained_keys(&["a:mask:v1".into()]),
            vec!["a:mask:v1"]
        );
    }

    #[test]
    fn intentional_null_mask_and_loading_patch_are_not_missing_assets() {
        let recipe = json!({
            "masks":[{"subMasks":[{
                "id":"radial", "previewAssetKey":"radial:mask:none",
                "previewAssetFields":[], "parameters":{"maskDataBase64":null}
            }]}],
            "aiPatches":[{
                "id":"loading", "isLoading":true,
                "previewAssetFields":[], "patchData":null
            }]
        });
        let mut fields = Vec::new();
        collect_adjustment_fields(&recipe, &mut fields);
        let mut cache = PreviewAssetCache::new(1);
        assert!(resolve_references(&fields, &mut cache).unwrap().is_empty());

        let mut masks = recipe["masks"][0]["subMasks"].as_array().unwrap().clone();
        hydrate_sub_masks(&mut masks, &mut cache).unwrap();
        assert!(masks[0]["parameters"]["maskDataBase64"].is_null());
    }
}
