use crate::baseline_exposure::RawExposure;
use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::formats::is_raw_file;
use crate::white_balance::WhiteBalance;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug)]
pub struct AsShot {
    pub white_balance: WhiteBalance,
    pub exposure: RawExposure,
}

impl AsShot {
    pub fn reference() -> Self {
        Self {
            white_balance: WhiteBalance::reference(),
            exposure: RawExposure::default(),
        }
    }
}

fn as_shot_cache() -> &'static Mutex<HashMap<String, AsShot>> {
    static CACHE: OnceLock<Mutex<HashMap<String, AsShot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn as_shot(path: &str) -> AsShot {
    cached_or_read(path, |source_path| {
        read_file_mapped(Path::new(source_path))
            .ok()
            .and_then(|mmap| crate::raw_processing::read_as_shot(&mmap))
    })
}

pub fn as_shot_from_bytes(path: &str, file_bytes: &[u8]) -> AsShot {
    cached_or_read(path, |_| crate::raw_processing::read_as_shot(file_bytes))
}

fn cached_or_read(path: &str, read: impl FnOnce(&str) -> Option<AsShot>) -> AsShot {
    let (source_path, _) = parse_virtual_path(path);
    let source_path = source_path.to_string_lossy().to_string();
    if !is_raw_file(&source_path) {
        return AsShot::reference();
    }
    if let Some(cached) = as_shot_cache().lock().unwrap().get(&source_path) {
        return *cached;
    }

    let as_shot = read(&source_path).unwrap_or_else(AsShot::reference);

    as_shot_cache().lock().unwrap().insert(source_path, as_shot);
    as_shot
}
