use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::Value;
use tauri::Manager;

use crate::app::settings::AppSettings;
use crate::export::settings::ExportSettings;
use crate::render::cache_utils::DecodeFingerprint;
use crate::render::options::resolve_render_options;

const RECORDS_FILE: &str = "export_records.json";

pub struct ExportRecords {
    file: Option<PathBuf>,
    app_version: String,
    previous: HashMap<String, String>,
    updated: Mutex<HashMap<String, Option<String>>>,
}

impl ExportRecords {
    pub fn load(app_handle: &tauri::AppHandle) -> Self {
        let file = app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(RECORDS_FILE));
        Self {
            previous: file.as_deref().map(read_records).unwrap_or_default(),
            file,
            app_version: app_handle.package_info().version.to_string(),
            updated: Mutex::default(),
        }
    }

    pub fn fingerprint(
        &self,
        source_path: &Path,
        adjustments: &Value,
        output_format: &str,
        export_settings: &ExportSettings,
        app_settings: &AppSettings,
        is_raw: bool,
    ) -> String {
        let settings = ExportSettings {
            on_conflict: None,
            ..export_settings.clone()
        };
        let watermark = export_settings
            .watermark
            .as_ref()
            .map(|watermark| file_stamp(Path::new(&watermark.path)));
        let context = serde_json::json!({
            "version": self.app_version,
            "source": record_key(source_path),
            "decode": format!("{:?}", DecodeFingerprint::for_file(source_path, app_settings)),
            "render": format!("{:?}", resolve_render_options(app_settings, is_raw)),
            "format": output_format,
            "settings": settings,
            "watermark": watermark,
        });
        let mut hasher = blake3::Hasher::new();
        hash_canonical(&mut hasher, &context);
        hash_canonical(&mut hasher, adjustments);
        hasher.finalize().to_hex().to_string()
    }

    pub fn is_current(&self, output_path: &Path, fingerprint: &str) -> bool {
        self.previous
            .get(&record_key(output_path))
            .is_some_and(|previous| previous == fingerprint)
    }

    pub fn record(&self, output_path: &Path, fingerprint: String) {
        self.updated
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(record_key(output_path), Some(fingerprint));
    }

    pub fn forget(&self, output_path: &Path) {
        let key = record_key(output_path);
        if self.previous.contains_key(&key) {
            self.updated
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key, None);
        }
    }

    pub fn save(&self) {
        let updated =
            std::mem::take(&mut *self.updated.lock().unwrap_or_else(PoisonError::into_inner));
        let Some(file) = self.file.as_deref().filter(|_| !updated.is_empty()) else {
            return;
        };
        let mut records = read_records(file);
        for (path, fingerprint) in updated {
            match fingerprint {
                Some(fingerprint) => records.insert(path, fingerprint),
                None => records.remove(&path),
            };
        }
        let mut reachable_roots: HashMap<PathBuf, bool> = HashMap::new();
        records.retain(|path, _| {
            let path = Path::new(path);
            let root = path.ancestors().last().unwrap_or(path);
            let root_reachable = *reachable_roots
                .entry(root.to_path_buf())
                .or_insert_with(|| root.exists());
            !root_reachable || path.exists()
        });
        let result = serde_json::to_vec(&records)
            .map_err(std::io::Error::other)
            .and_then(|json| {
                if let Some(dir) = file.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                crate::library::file_ops::write_file_atomic(file, &json)
            });
        if let Err(e) = result {
            log::warn!("Failed to save export records to {}: {}", file.display(), e);
        }
    }
}

fn hash_canonical(hasher: &mut blake3::Hasher, value: &Value) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            hasher.update(b"{");
            for (key, value) in entries {
                let _ = serde_json::to_writer(&mut *hasher, key);
                hasher.update(b":");
                hash_canonical(hasher, value);
                hasher.update(b",");
            }
            hasher.update(b"}");
        }
        Value::Array(items) => {
            hasher.update(b"[");
            for item in items {
                hash_canonical(hasher, item);
                hasher.update(b",");
            }
            hasher.update(b"]");
        }
        scalar => {
            let _ = serde_json::to_writer(&mut *hasher, scalar);
        }
    }
}

fn read_records(file: &Path) -> HashMap<String, String> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn record_key(path: &Path) -> String {
    std::path::absolute(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn file_stamp(path: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((metadata.len(), modified))
}
