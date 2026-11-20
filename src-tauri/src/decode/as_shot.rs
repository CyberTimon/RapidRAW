use crate::decode::baseline_exposure::RawExposure;
use crate::decode::formats::is_raw_file;
use crate::decode::white_balance::WhiteBalance;

use crate::library::file_ops::read_file_mapped;
use crate::library::sidecars::parse_virtual_path;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

type Fingerprint = Option<(u64, Option<SystemTime>, bool)>;

#[derive(Clone, Copy, Debug)]
pub struct AsShot {
    pub white_balance: WhiteBalance,
    pub exposure: RawExposure,
    pub source_peak: f32,
}

impl AsShot {
    pub fn reference() -> Self {
        Self {
            white_balance: WhiteBalance::reference(),
            exposure: RawExposure::default(),
            source_peak: 1.0,
        }
    }
}

fn as_shot_cache() -> &'static Mutex<HashMap<String, (Fingerprint, AsShot)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Fingerprint, AsShot)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn as_shot(path: &str) -> AsShot {
    cached_or_read(path, |source_path| {
        let mmap = read_file_mapped(Path::new(source_path)).ok()?;
        read_from_bytes(source_path, &mmap)
    })
}

pub fn as_shot_from_bytes(path: &str, file_bytes: &[u8]) -> AsShot {
    cached_or_read(path, |source_path| read_from_bytes(source_path, file_bytes))
}

fn read_from_bytes(source_path: &str, file_bytes: &[u8]) -> Option<AsShot> {
    if is_raw_file(source_path) {
        return crate::decode::raw_processing::read_as_shot(file_bytes);
    }
    Some(AsShot {
        source_peak: crate::decode::hdr_source::source_peak(file_bytes),
        ..AsShot::reference()
    })
}

fn may_have_gain_map(source_path: &str) -> bool {
    Path::new(source_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["jpg", "jpeg", "avif"].contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn fingerprint(source_path: &str) -> Fingerprint {
    if is_raw_file(source_path) {
        return None;
    }
    std::fs::metadata(source_path).ok().map(|metadata| {
        (
            metadata.len(),
            metadata.modified().ok(),
            may_have_gain_map(source_path) && crate::decode::hdr_source::gain_maps_enabled(),
        )
    })
}

pub fn record_source_peak(path: &str, peak: f32) {
    let (source_path, _) = parse_virtual_path(path);
    let source_path = source_path.to_string_lossy().to_string();
    let fingerprint = fingerprint(&source_path);
    let mut cache = as_shot_cache().lock().unwrap();
    let as_shot = cache
        .get(&source_path)
        .filter(|(cached_fingerprint, _)| *cached_fingerprint == fingerprint)
        .map_or_else(AsShot::reference, |(_, as_shot)| *as_shot);
    cache.insert(
        source_path,
        (
            fingerprint,
            AsShot {
                source_peak: peak,
                ..as_shot
            },
        ),
    );
}

fn cached_or_read(path: &str, read: impl FnOnce(&str) -> Option<AsShot>) -> AsShot {
    let (source_path, _) = parse_virtual_path(path);
    let source_path = source_path.to_string_lossy().to_string();
    let fingerprint = fingerprint(&source_path);
    if let Some((cached_fingerprint, cached)) = as_shot_cache().lock().unwrap().get(&source_path)
        && *cached_fingerprint == fingerprint
    {
        return *cached;
    }

    let as_shot = read(&source_path).unwrap_or_else(AsShot::reference);

    as_shot_cache()
        .lock()
        .unwrap()
        .insert(source_path, (fingerprint, as_shot));
    as_shot
}
