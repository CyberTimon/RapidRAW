use crate::app::settings::load_settings;
use crate::decode::formats::is_raw_file;
use crate::library::presets::{PresetItem, load_presets};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Emitter};

pub const DEVELOP_DEFAULTS_CHANGED_EVENT: &str = "develop-defaults-changed";

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CameraDefaults {
    pub make: String,
    pub model: String,
    pub preset_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DevelopDefaultsSettings {
    pub preset_id: Option<String>,
    pub auto_lens_correction: bool,
    pub apply_to_non_raw: bool,
    pub cameras: Vec<CameraDefaults>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Camera {
    pub make: String,
    pub model: String,
}

impl Camera {
    fn key(make: &str, model: &str) -> CameraKey {
        let normalize = |value: &str| {
            value
                .trim()
                .trim_matches('"')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        };
        (normalize(make), normalize(model))
    }
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DefaultsSource {
    Factory,
    AllCameras,
    Camera,
}

const NON_DEFAULTABLE_KEYS: &[&str] = &[
    "masks",
    "aiPatches",
    "crop",
    "aspectRatio",
    "guidedPerspective",
    "rotation",
    "orientationSteps",
    "flipHorizontal",
    "flipVertical",
    "transformDistortion",
    "transformVertical",
    "transformHorizontal",
    "transformRotate",
    "transformAspect",
    "transformScale",
    "transformXOffset",
    "transformYOffset",
    "lensBlurDepthMap",
    "fogDepthMap",
    "motionBlurDepthMap",
    "relightNormalMap",
    "aiDenoiseEnabled",
    "aiUpscaleEnabled",
    "lensBlurEnabled",
    "fogEnabled",
    "relightEnabled",
    "motionBlurDepthEnabled",
];

type Overlay = Arc<Map<String, Value>>;
type CameraKey = (String, String);

#[derive(Debug, Default, PartialEq)]
struct DevelopDefaults {
    all_cameras: Overlay,
    cameras: Vec<(CameraKey, Overlay)>,
    apply_to_non_raw: bool,
}

impl DevelopDefaults {
    fn is_empty(&self) -> bool {
        self.all_cameras.is_empty() && self.cameras.is_empty()
    }

    fn pick(
        &self,
        is_raw: bool,
        camera: impl FnOnce() -> Option<Camera>,
    ) -> (Option<Arc<Map<String, Value>>>, DefaultsSource) {
        if !(is_raw || self.apply_to_non_raw) {
            return (None, DefaultsSource::Factory);
        }
        if !self.cameras.is_empty()
            && let Some(camera) = camera()
        {
            let key = Camera::key(&camera.make, &camera.model);
            if let Some((_, overlay)) = self.cameras.iter().find(|(rule, _)| *rule == key) {
                return (
                    (!overlay.is_empty()).then(|| overlay.clone()),
                    DefaultsSource::Camera,
                );
            }
        }
        if self.all_cameras.is_empty() {
            (None, DefaultsSource::Factory)
        } else {
            (Some(self.all_cameras.clone()), DefaultsSource::AllCameras)
        }
    }
}

static CURRENT: RwLock<Option<Arc<DevelopDefaults>>> = RwLock::new(None);

fn current() -> Option<Arc<DevelopDefaults>> {
    CURRENT.read().unwrap_or_else(|e| e.into_inner()).clone()
}

const MAX_CACHED_CAMERAS: usize = 65_536;

type FileStamp = Option<(u64, std::time::SystemTime)>;

fn file_stamp(path: &Path) -> FileStamp {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

type CameraCache = HashMap<PathBuf, (FileStamp, Option<Camera>)>;

fn camera_cache() -> &'static Mutex<CameraCache> {
    static CACHE: OnceLock<Mutex<CameraCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_camera(path: &Path) -> Option<Camera> {
    let exif = crate::metadata::exif_processing::read_rrexif_sidecar(path).or_else(|| {
        let bytes = crate::library::file_ops::read_file_mapped(path).ok()?;
        Some(crate::metadata::exif_processing::read_exif_data_from_bytes(
            &path.to_string_lossy(),
            &bytes,
        ))
    })?;
    let text = |key: &str| {
        exif.get(key)
            .map(|value| value.trim().trim_matches('"').trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(Camera {
        make: text("Make")?,
        model: text("Model")?,
    })
}

pub fn camera_of(path: &Path) -> Option<Camera> {
    let stamp = file_stamp(path);
    if let Some((cached_stamp, camera)) = camera_cache().lock().unwrap().get(path)
        && *cached_stamp == stamp
    {
        return camera.clone();
    }
    let camera = read_camera(path);
    let mut cache = camera_cache().lock().unwrap();
    if cache.len() >= MAX_CACHED_CAMERAS {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (stamp, camera.clone()));
    camera
}

pub fn auto_lens_correction_adjustments() -> [(&'static str, Value); 4] {
    [
        ("lensCorrectionMode", json!("auto")),
        ("lensDistortionEnabled", json!(true)),
        ("lensTcaEnabled", json!(true)),
        ("lensVignetteEnabled", json!(true)),
    ]
}

fn find_preset_adjustments<'a>(presets: &'a [PresetItem], id: &str) -> Option<&'a Value> {
    presets.iter().find_map(|item| match item {
        PresetItem::Preset(preset) => (preset.id == id).then_some(&preset.adjustments),
        PresetItem::Folder(folder) => folder
            .children
            .iter()
            .find(|preset| preset.id == id)
            .map(|preset| &preset.adjustments),
    })
}

fn fill_from_factory(value: &mut Value, factory: &Value) {
    if let (Some(value), Some(factory)) = (value.as_object_mut(), factory.as_object()) {
        for (key, factory_value) in factory {
            match value.get_mut(key) {
                Some(existing) => fill_from_factory(existing, factory_value),
                None => {
                    value.insert(key.clone(), factory_value.clone());
                }
            }
        }
    }
}

fn build_overlay(
    preset_id: Option<&str>,
    auto_lens_correction: bool,
    presets: &[PresetItem],
) -> Map<String, Value> {
    let mut overlay = Map::new();

    if let Some(id) = preset_id {
        match find_preset_adjustments(presets, id).and_then(Value::as_object) {
            Some(adjustments) => {
                let factory = crate::render::adjustment_utils::factory_adjustments();
                for (key, value) in adjustments {
                    if !NON_DEFAULTABLE_KEYS.contains(&key.as_str()) {
                        let mut value = value.clone();
                        if let Some(factory) = factory.and_then(|factory| factory.get(key)) {
                            fill_from_factory(&mut value, factory);
                        }
                        overlay.insert(key.clone(), value);
                    }
                }
            }
            None => log::warn!("Default preset {} not found, using factory defaults", id),
        }
    }

    if auto_lens_correction {
        for (key, value) in auto_lens_correction_adjustments() {
            overlay.insert(key.to_string(), value);
        }
    }

    overlay
}

fn build(settings: &DevelopDefaultsSettings, presets: &[PresetItem]) -> DevelopDefaults {
    DevelopDefaults {
        all_cameras: Arc::new(build_overlay(
            settings.preset_id.as_deref(),
            settings.auto_lens_correction,
            presets,
        )),
        cameras: settings
            .cameras
            .iter()
            .map(|rule| {
                let preset_id = match rule.preset_id.as_deref() {
                    Some("") => None,
                    Some(id) if find_preset_adjustments(presets, id).is_some() => Some(id),
                    _ => settings.preset_id.as_deref(),
                };
                (
                    Camera::key(&rule.make, &rule.model),
                    Arc::new(build_overlay(
                        preset_id,
                        settings.auto_lens_correction,
                        presets,
                    )),
                )
            })
            .collect(),
        apply_to_non_raw: settings.apply_to_non_raw,
    }
}

fn lookup(path: &Path) -> (Option<Arc<Map<String, Value>>>, DefaultsSource) {
    match current() {
        Some(defaults) if !defaults.is_empty() => {
            defaults.pick(is_raw_file(path), || camera_of(path))
        }
        _ => (None, DefaultsSource::Factory),
    }
}

pub fn overlay(path: &Path) -> Arc<Map<String, Value>> {
    lookup(path).0.unwrap_or_default()
}

pub fn is_customized(path: &Path) -> bool {
    lookup(path).0.is_some()
}

pub fn apply_overlay(base: &mut Value, path: &Path) {
    if let (Some(base), Some(overlay)) = (base.as_object_mut(), lookup(path).0) {
        for (key, value) in overlay.iter() {
            base.insert(key.clone(), value.clone());
        }
    }
}

pub fn resolve<'a>(adjustments: &'a Value, path: &Path) -> Cow<'a, Value> {
    if crate::render::adjustment_utils::is_unedited(adjustments) && is_customized(path) {
        Cow::Owned(crate::render::adjustment_utils::default_adjustments(path))
    } else {
        Cow::Borrowed(adjustments)
    }
}

pub fn resolve_in_place(adjustments: &mut Value, path: &Path) {
    if crate::render::adjustment_utils::is_unedited(adjustments) && is_customized(path) {
        *adjustments = crate::render::adjustment_utils::default_adjustments(path);
    }
}

pub fn refresh(app_handle: &AppHandle) {
    let settings = load_settings(app_handle.clone())
        .map(|settings| settings.develop_defaults)
        .unwrap_or_default();
    let uses_presets = settings.preset_id.is_some()
        || settings.cameras.iter().any(|rule| rule.preset_id.is_some());
    let presets = if uses_presets {
        load_presets(app_handle.clone()).unwrap_or_else(|e| {
            log::warn!("Failed to load presets for develop defaults: {}", e);
            Vec::new()
        })
    } else {
        Vec::new()
    };
    let next = build(&settings, &presets);

    let changed = {
        let mut current = CURRENT.write().unwrap_or_else(|e| e.into_inner());
        let changed = match current.as_deref() {
            Some(previous) => previous != &next,
            None => !next.is_empty(),
        };
        *current = Some(Arc::new(next));
        changed
    };

    if changed {
        let _ = app_handle.emit(DEVELOP_DEFAULTS_CHANGED_EVENT, ());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDefaults {
    adjustments: Value,
    camera: Option<Camera>,
    source: DefaultsSource,
}

#[tauri::command]
pub async fn get_default_adjustments(path: String) -> Result<ImageDefaults, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (source_path, _) = crate::library::sidecars::parse_virtual_path(&path);
        ImageDefaults {
            adjustments: crate::render::adjustment_utils::default_adjustments(&source_path),
            camera: camera_of(&source_path),
            source: lookup(&source_path).1,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::presets::{Preset, PresetFolder};

    fn preset(id: &str, adjustments: Value) -> Preset {
        Preset {
            id: id.to_string(),
            name: id.to_string(),
            adjustments,
            include_masks: None,
            include_crop_transform: None,
            preset_type: None,
        }
    }

    fn camera(make: &str, model: &str) -> Option<Camera> {
        Some(Camera {
            make: make.to_string(),
            model: model.to_string(),
        })
    }

    fn rule(make: &str, model: &str, preset_id: Option<&str>) -> CameraDefaults {
        CameraDefaults {
            make: make.to_string(),
            model: model.to_string(),
            preset_id: preset_id.map(str::to_string),
        }
    }

    #[test]
    fn overlay_is_empty_without_customisation() {
        assert!(build_overlay(None, false, &[]).is_empty());
        assert!(build(&DevelopDefaultsSettings::default(), &[]).is_empty());
    }

    #[test]
    fn overlay_takes_preset_from_folder_and_drops_per_image_keys() {
        let presets = vec![PresetItem::Folder(PresetFolder {
            id: "folder".to_string(),
            name: "folder".to_string(),
            children: vec![preset(
                "p1",
                json!({
                    "exposure": 0.5,
                    "masks": [{ "id": "m" }],
                    "aiPatches": [],
                    "crop": { "x": 10, "y": 10, "width": 100, "height": 100, "unit": "px" },
                    "aspectRatio": 1.5,
                }),
            )],
        })];
        let overlay = build_overlay(Some("p1"), false, &presets);
        assert_eq!(overlay.get("exposure"), Some(&json!(0.5)));
        for key in ["masks", "aiPatches", "crop", "aspectRatio"] {
            assert!(!overlay.contains_key(key), "{key} should not be a default");
        }
    }

    #[test]
    fn overlay_never_requests_ai_results() {
        let presets = vec![PresetItem::Preset(preset(
            "p1",
            json!({
                "aiDenoiseEnabled": true,
                "aiUpscaleEnabled": true,
                "lensBlurEnabled": true,
                "fogEnabled": true,
                "relightEnabled": true,
                "motionBlurDepthEnabled": true,
                "motionBlurAmount": 50,
                "exposure": 1.0,
            }),
        ))];
        let overlay = Value::Object(build_overlay(Some("p1"), false, &presets));
        assert!(!crate::ai::jobs::has_ai_results(&overlay));
        assert_eq!(overlay.get("exposure"), Some(&json!(1.0)));
    }

    #[test]
    fn auto_lens_correction_overrides_preset_lens_settings() {
        let presets = vec![PresetItem::Preset(preset(
            "p1",
            json!({ "lensCorrectionMode": "manual", "contrast": 10 }),
        ))];
        let overlay = build_overlay(Some("p1"), true, &presets);
        assert_eq!(overlay.get("lensCorrectionMode"), Some(&json!("auto")));
        assert_eq!(overlay.get("lensDistortionEnabled"), Some(&json!(true)));
        assert_eq!(overlay.get("contrast"), Some(&json!(10)));
    }

    #[test]
    fn missing_preset_falls_back_to_factory() {
        assert!(build_overlay(Some("gone"), false, &[]).is_empty());
    }

    #[test]
    fn camera_preset_replaces_all_cameras_preset_and_keeps_lens_correction() {
        let presets = vec![
            PresetItem::Preset(preset("all", json!({ "exposure": 0.5 }))),
            PresetItem::Preset(preset("sony", json!({ "contrast": 20 }))),
        ];
        let settings = DevelopDefaultsSettings {
            preset_id: Some("all".to_string()),
            auto_lens_correction: true,
            cameras: vec![rule("SONY", "ILCE-7M4", Some("sony"))],
            ..Default::default()
        };
        let defaults = build(&settings, &presets);

        let (overlay, source) = defaults.pick(true, || camera(" Sony ", "\"ilce-7m4\""));
        let overlay = overlay.unwrap();
        assert_eq!(source, DefaultsSource::Camera);
        assert_eq!(overlay.get("contrast"), Some(&json!(20)));
        assert!(!overlay.contains_key("exposure"));
        assert_eq!(overlay.get("lensCorrectionMode"), Some(&json!("auto")));

        let (overlay, source) = defaults.pick(true, || camera("Canon", "EOS R5"));
        assert_eq!(source, DefaultsSource::AllCameras);
        assert_eq!(overlay.unwrap().get("exposure"), Some(&json!(0.5)));

        let (overlay, source) = defaults.pick(true, || None);
        assert_eq!(source, DefaultsSource::AllCameras);
        assert!(overlay.is_some());
    }

    #[test]
    fn camera_rule_without_preset_uses_the_all_cameras_preset() {
        let presets = vec![PresetItem::Preset(preset(
            "all",
            json!({ "exposure": 0.5 }),
        ))];
        let settings = DevelopDefaultsSettings {
            preset_id: Some("all".to_string()),
            auto_lens_correction: true,
            cameras: vec![rule("Fujifilm", "X-T5", None)],
            ..Default::default()
        };
        let (overlay, source) =
            build(&settings, &presets).pick(true, || camera("FUJIFILM", "X-T5"));
        let overlay = overlay.unwrap();
        assert_eq!(source, DefaultsSource::Camera);
        assert_eq!(overlay.get("exposure"), Some(&json!(0.5)));
        assert_eq!(overlay.get("lensCorrectionMode"), Some(&json!("auto")));
    }

    #[test]
    fn camera_rule_with_deleted_preset_uses_the_all_cameras_preset() {
        let presets = vec![PresetItem::Preset(preset(
            "all",
            json!({ "exposure": 0.5 }),
        ))];
        let settings = DevelopDefaultsSettings {
            preset_id: Some("all".to_string()),
            cameras: vec![rule("Sony", "ILCE-7M4", Some("deleted"))],
            ..Default::default()
        };
        let (overlay, source) =
            build(&settings, &presets).pick(true, || camera("SONY", "ILCE-7M4"));
        assert_eq!(source, DefaultsSource::Camera);
        assert_eq!(overlay.unwrap().get("exposure"), Some(&json!(0.5)));

        let without_all_cameras = DevelopDefaultsSettings {
            preset_id: None,
            ..settings
        };
        let (overlay, _) =
            build(&without_all_cameras, &presets).pick(true, || camera("SONY", "ILCE-7M4"));
        assert!(overlay.is_none());
    }

    #[test]
    fn camera_rule_with_no_preset_means_factory_for_that_camera() {
        let presets = vec![PresetItem::Preset(preset(
            "all",
            json!({ "exposure": 0.5 }),
        ))];
        let settings = DevelopDefaultsSettings {
            preset_id: Some("all".to_string()),
            cameras: vec![rule("Fujifilm", "X-T5", Some(""))],
            ..Default::default()
        };
        let (overlay, source) =
            build(&settings, &presets).pick(true, || camera("FUJIFILM", "X-T5"));
        assert!(overlay.is_none());
        assert_eq!(source, DefaultsSource::Camera);
    }

    #[test]
    fn partial_nested_preset_values_are_completed_from_factory() {
        let presets = vec![PresetItem::Preset(preset(
            "p1",
            json!({ "hsl": { "reds": { "hue": 10 } }, "rotation": 2.0 }),
        ))];
        let overlay = build_overlay(Some("p1"), false, &presets);
        let hsl = overlay.get("hsl").and_then(Value::as_object).unwrap();
        assert_eq!(hsl["reds"]["hue"], json!(10));
        assert_eq!(hsl["reds"]["saturation"], json!(0));
        assert!(hsl.contains_key("blues"));
        assert!(!overlay.contains_key("rotation"));
    }

    #[test]
    fn baseline_only_adjustments_count_as_unedited() {
        use crate::render::adjustment_utils::is_unedited;
        assert!(is_unedited(&Value::Null));
        assert!(is_unedited(&json!({ "baselineExposure": true })));
        assert!(!is_unedited(&json!({ "baselineExposure": false })));
        assert!(!is_unedited(
            &json!({ "baselineExposure": true, "exposure": 0.5 })
        ));
    }

    #[test]
    fn non_raw_files_get_factory_unless_enabled() {
        let presets = vec![PresetItem::Preset(preset(
            "all",
            json!({ "exposure": 0.5 }),
        ))];
        let mut settings = DevelopDefaultsSettings {
            preset_id: Some("all".to_string()),
            ..Default::default()
        };
        assert!(build(&settings, &presets).pick(false, || None).0.is_none());
        settings.apply_to_non_raw = true;
        assert!(build(&settings, &presets).pick(false, || None).0.is_some());
    }

    #[test]
    fn camera_is_only_read_when_there_are_camera_rules() {
        let presets = vec![PresetItem::Preset(preset(
            "all",
            json!({ "exposure": 0.5 }),
        ))];
        let settings = DevelopDefaultsSettings {
            preset_id: Some("all".to_string()),
            ..Default::default()
        };
        let (overlay, _) = build(&settings, &presets).pick(true, || panic!("camera read"));
        assert!(overlay.is_some());
    }
}
