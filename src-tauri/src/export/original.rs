use crate::app::settings::AppSettings;
use crate::decode::image_loader::load_base_image_from_bytes;
use crate::export::settings::OriginalExportOptions;
use crate::library::file_ops::read_file_mapped;
use image::DynamicImage;
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Deserialize)]
struct OriginalAdjustmentKeys {
    preserved: Vec<String>,
    crop: Vec<String>,
}

fn original_adjustment_keys() -> &'static OriginalAdjustmentKeys {
    static KEYS: OnceLock<OriginalAdjustmentKeys> = OnceLock::new();
    KEYS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/utils/originalAdjustmentKeys.json"
        ))
        .expect("originalAdjustmentKeys.json must be valid")
    })
}

pub fn original_export_adjustments(adjustments: &Value, options: &OriginalExportOptions) -> Value {
    let keys = original_adjustment_keys();
    let crop_keys: &[String] = if options.crop { &keys.crop } else { &[] };
    Value::Object(
        keys.preserved
            .iter()
            .chain(crop_keys)
            .map(String::as_str)
            .chain(options.keep_exposure.then_some("exposure"))
            .filter_map(|key| adjustments.get(key).map(|v| (key.to_string(), v.clone())))
            .collect(),
    )
}

pub fn original_output_path(output_path: &Path) -> PathBuf {
    let stem = output_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    let file_name = match output_path.extension().and_then(|e| e.to_str()) {
        Some(extension) => format!("{}_original.{}", stem, extension),
        None => format!("{}_original", stem),
    };
    output_path.with_file_name(file_name)
}

pub fn load_export_source_image(
    path: &str,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    match read_file_mapped(Path::new(path)) {
        Ok(mmap) => load_base_image_from_bytes(&mmap, path, false, settings, None)
            .map_err(|e| format!("Failed to load from mmap: {}", e)),
        Err(_) => {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            load_base_image_from_bytes(&bytes, path, false, settings, None)
                .map_err(|e| format!("Failed to load from bytes: {}", e))
        }
    }
}
