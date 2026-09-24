#[cfg(test)]
mod tests {
    use crate::default_presets::get_default_curated_presets;
    use crate::file_management::PresetItem;

    #[test]
    fn test_gate0_preset_schema_integrity() {
        let presets = get_default_curated_presets();
        assert!(!presets.is_empty(), "Curated preset list must not be empty");

        for item in presets {
            match item {
                PresetItem::Folder(folder) => {
                    assert!(!folder.id.is_empty(), "Folder ID must not be empty");
                    assert!(!folder.name.is_empty(), "Folder name must not be empty");
                    assert!(!folder.children.is_empty(), "Folder {} must contain presets", folder.name);

                    for preset in folder.children {
                        assert!(!preset.id.is_empty(), "Preset ID must not be empty in {}", folder.name);
                        assert!(!preset.name.is_empty(), "Preset name must not be empty in {}", folder.name);

                        let obj = preset.adjustments.as_object().expect("Adjustments must be a JSON object");
                        
                        // Check bounds on numeric fields if present
                        if let Some(contrast) = obj.get("contrast").and_then(|v| v.as_f64()) {
                            assert!(contrast >= -100.0 && contrast <= 100.0, "Contrast out of bounds in {}", preset.name);
                        }
                        if let Some(grain) = obj.get("grain").and_then(|v| v.as_f64()) {
                            assert!(grain >= 0.0 && grain <= 100.0, "Grain out of bounds in {}", preset.name);
                        }
                        if let Some(sat) = obj.get("saturation").and_then(|v| v.as_f64()) {
                            assert!(sat >= -100.0 && sat <= 100.0, "Saturation out of bounds in {}", preset.name);
                        }
                    }
                }
                PresetItem::Preset(preset) => {
                    assert!(!preset.id.is_empty());
                    assert!(!preset.name.is_empty());
                }
            }
        }
    }

    #[test]
    fn test_gate1_log_singularity_safety() {
        let test_inputs = vec![0.0f32, 1e-7f32, 0.5f32, 1.0f32];
        for val in test_inputs {
            let clamped = val.clamp(1e-6, 1.0);
            let log_val = -clamped.log10();
            assert!(log_val.is_finite(), "Logarithm computation produced NaN/Inf for input {}", val);
            assert!(log_val >= 0.0, "Optical density logarithm must be non-negative");
        }
    }
}
