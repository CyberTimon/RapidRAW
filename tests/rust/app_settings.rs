// Settings files written by older and newer versions must still parse. A field that fails to parse
// makes the app fall back to default settings or stop saving them.

use rapidraw_lib::AppSettings;
use serde_json::{Value, json};

fn parse(value: Value) -> AppSettings {
    serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("settings did not parse: {error}\n{value}"))
}

fn defaults_json() -> Value {
    serde_json::to_value(AppSettings::default()).unwrap()
}

// HashSet fields serialize in random order.
fn sort_string_arrays(value: &mut Value) {
    match value {
        Value::Array(items) => {
            items.iter_mut().for_each(sort_string_arrays);
            if items.iter().all(Value::is_string) {
                items.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
        }
        Value::Object(map) => map.values_mut().for_each(sort_string_arrays),
        _ => {}
    }
}

#[test]
fn empty_settings_parse() {
    let settings = parse(json!({}));
    assert!(settings.root_folders.is_empty());
    assert_eq!(settings.open_tree_sections, vec!["current".to_string()]);
    assert!(!settings.export_presets.is_empty());
}

#[test]
fn default_settings_round_trip() {
    let mut saved = defaults_json();
    let mut reloaded = serde_json::to_value(parse(saved.clone())).unwrap();
    sort_string_arrays(&mut saved);
    sort_string_arrays(&mut reloaded);
    assert_eq!(saved, reloaded);
}

#[test]
fn old_and_unknown_keys_parse() {
    let settings = parse(json!({
        "comfyuiAddress": "127.0.0.1:8188",
        "someSettingFromANewerVersion": { "enabled": true },
    }));
    assert_eq!(
        settings.ai_connector_address.as_deref(),
        Some("127.0.0.1:8188")
    );
}

#[test]
fn partial_nested_settings_parse() {
    parse(json!({
        "filterCriteria": { "rating": -1, "rawStatus": "all" },
        "exportPresets": [{
            "id": "old",
            "name": "Preset saved before the optional fields existed",
            "fileFormat": "jpeg",
            "jpegQuality": 90,
            "enableResize": false,
            "resizeMode": "longEdge",
            "resizeValue": 2048,
            "dontEnlarge": true,
            "keepMetadata": true,
            "stripGps": false,
            "filenameTemplate": "{original_filename}",
            "enableWatermark": false,
            "watermarkPath": null,
            "watermarkAnchor": "bottomRight",
            "watermarkScale": 10,
            "watermarkSpacing": 5,
            "watermarkOpacity": 75,
        }],
    }));
}

const NOT_NULLABLE: &[&str] = &[
    "adjustmentLayout",
    "aiGpuAcceleration",
    "baselineExposure",
    "compensateHighlightPreservation",
    "copyPasteSettings",
    "customAspectRatios",
    "enableBaselineExposure",
    "exportPresets",
    "immich",
    "keybinds",
    "linearRawMode",
    "openTreeSections",
    "pinnedFolders",
    "rootFolders",
    "workspace",
];

#[test]
fn only_known_fields_reject_null() {
    let defaults = defaults_json();
    let mut rejected: Vec<&str> = defaults
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| {
            let mut settings = defaults.clone();
            settings[key.as_str()] = Value::Null;
            serde_json::from_value::<AppSettings>(settings).is_err()
        })
        .map(String::as_str)
        .collect();
    rejected.sort_unstable();
    assert_eq!(
        rejected, NOT_NULLABLE,
        "a null in any of these fields makes the whole settings file fail to parse; \
         make a new field an Option, or add it to NOT_NULLABLE if the frontend never sends null"
    );
}
