use super::AppSettings;

#[test]
fn old_settings_preserve_defaults_and_existing_shortcuts() {
    let old = AppSettings::default();
    let mut value = serde_json::to_value(&old).unwrap();
    for key in [
        "shortcutProfile",
        "lightroomKeybinds",
        "cropDragMode",
        "cropOverlay",
        "cropRotationGrid",
    ] {
        value.as_object_mut().unwrap().remove(key);
    }
    value["keybinds"] = serde_json::json!({ "gallery": ["KeyT"], "show_original": [] });
    let loaded: AppSettings = serde_json::from_value(value).unwrap();
    assert!(loaded.shortcut_profile.is_none());
    assert!(loaded.crop_drag_mode.is_none());
    assert_eq!(loaded.keybinds["gallery"], vec!["KeyT"]);
    assert!(loaded.keybinds["show_original"].is_empty());
}

#[test]
fn personal_controls_round_trip_without_changing_the_other_profile() {
    let mut settings = AppSettings::default();
    settings.shortcut_profile = Some("lightroom".into());
    settings.crop_drag_mode = Some("photo".into());
    settings.crop_overlay = Some("thirds".into());
    settings.crop_rotation_grid = Some("selected".into());
    settings
        .keybinds
        .insert("gallery".into(), vec!["KeyT".into()]);
    settings.lightroom_keybinds.insert("gallery".into(), vec![]);
    let json = serde_json::to_string(&settings).unwrap();
    let result: AppSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(result.shortcut_profile.as_deref(), Some("lightroom"));
    assert_eq!(result.crop_drag_mode.as_deref(), Some("photo"));
    assert_eq!(result.crop_rotation_grid.as_deref(), Some("selected"));
    assert_eq!(result.keybinds["gallery"], vec!["KeyT"]);
    assert!(result.lightroom_keybinds["gallery"].is_empty());
}
