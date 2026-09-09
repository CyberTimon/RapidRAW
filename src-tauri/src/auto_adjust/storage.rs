use super::types::*;
use crate::{file_management::parse_virtual_path, image_processing::ImageMetadata};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

// Shared with the ordinary editor save boundary. Disk bytes are checked again at commit.
pub static WRITE_LOCK: Mutex<()> = Mutex::new(());
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("scene-auto-v1");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().context("Missing parent")?)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}
pub fn save(app: &tauri::AppHandle, batch: &Batch) -> Result<()> {
    atomic(&root(app)?.join(format!("{}.json", batch.id)), &serde_json::to_vec(batch)?)
}
pub fn load(app: &tauri::AppHandle, id: &str) -> Result<Batch> {
    uuid::Uuid::parse_str(id)?;
    let batch: Batch = serde_json::from_slice(&fs::read(root(app)?.join(format!("{id}.json")))?)?;
    Ok(batch)
}
pub fn metadata(path: &str) -> Result<(ImageMetadata, Option<Vec<u8>>)> {
    let (source, sidecar) = parse_virtual_path(path);
    let bytes = match fs::read(sidecar) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    // Never silently replace malformed/unreadable sidecars.
    let mut meta: ImageMetadata = match &bytes {
        Some(v) => serde_json::from_slice(v)?,
        None => ImageMetadata::default(),
    };
    crate::exif_processing::inherit_embedded_rating(&source, &mut meta);
    Ok((meta, bytes))
}
pub fn fingerprint(path: &str, settings: &crate::app_settings::AppSettings) -> Result<String> {
    let (source, _) = parse_virtual_path(path);
    let meta = fs::metadata(&source)?;
    let stamp = meta.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_nanos();
    Ok(blake3::hash(
        format!("{}:{}:{stamp}:{}", source.display(), meta.len(), decode_key(settings)?).as_bytes(),
    )
    .to_hex()
    .to_string())
}
pub fn current_fingerprint(app: &tauri::AppHandle, path: &str) -> Result<String> {
    let settings = crate::app_settings::load_settings(app.clone()).map_err(anyhow::Error::msg)?;
    fingerprint(path, &settings)
}
fn decode_key(settings: &crate::app_settings::AppSettings) -> Result<String> {
    let all = serde_json::to_value(settings)?;
    let keys = [
        "rawHighlightCompression",
        "linearRawMode",
        "rawPreprocessingColorNr",
        "rawPreprocessingSharpening",
        "applyPreprocessingToNonRaws",
        "tonemapperOverrideEnabled",
        "defaultRawTonemapper",
        "defaultNonRawTonemapper",
    ];
    let filtered: serde_json::Map<String, Value> =
        keys.into_iter().map(|k| (k.into(), all[k].clone())).collect();
    Ok(serde_json::to_string(&filtered)?)
}
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|other| same(v, other)))
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        _ => a == b,
    }
}
pub fn commit(path: &str, meta: &ImageMetadata, expected_bytes: &Option<Vec<u8>>) -> Result<()> {
    let (_, sidecar) = parse_virtual_path(path);
    let current = match fs::read(&sidecar) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    ensure!(&current == expected_bytes, "Photo metadata changed during Auto; skipped");
    atomic(&sidecar, &serde_json::to_vec_pretty(meta)?)
}

pub fn save_entry(app: &tauri::AppHandle, id: &str, entry: &Entry) -> Result<()> {
    let dir = root(app)?.join(id);
    fs::create_dir_all(&dir)?;
    let name = blake3::hash(entry.path.as_bytes()).to_hex();
    atomic(&dir.join(format!("{name}.json")), &serde_json::to_vec(entry)?)
}
pub fn restore_entries(app: &tauri::AppHandle, batch: &mut Batch) -> Result<()> {
    for entry in &mut batch.entries {
        let name = blake3::hash(entry.path.as_bytes()).to_hex();
        let path = root(app)?.join(&batch.id).join(format!("{name}.json"));
        match fs::read(path) {
            Ok(bytes) => {
                let saved: Entry = serde_json::from_slice(&bytes)?;
                ensure!(saved.path == entry.path, "Invalid Auto journal");
                *entry = saved;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
