use crate::library::file_ops;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone)]
struct CachedExifEntry {
    mtime_ns: u128,
    size: u64,
    data: HashMap<String, String>,
}

struct ExifCacheState {
    cache: HashMap<PathBuf, HashMap<String, CachedExifEntry>>,
    dirty: HashSet<PathBuf>,
    cache_dir: Option<PathBuf>,
}

impl ExifCacheState {
    fn get_cache_file_path(&self, folder: &Path) -> Option<PathBuf> {
        let base_dir = self.cache_dir.as_ref()?;
        let hash = blake3::hash(folder.to_string_lossy().as_bytes())
            .to_hex()
            .to_string();
        Some(base_dir.join(format!("{}.json", hash)))
    }
}

fn get_exif_cache() -> &'static Mutex<ExifCacheState> {
    static EXIF_CACHE: OnceLock<Mutex<ExifCacheState>> = OnceLock::new();
    EXIF_CACHE.get_or_init(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(3));
                flush_all_dirty_caches();
            }
        });

        Mutex::new(ExifCacheState {
            cache: HashMap::new(),
            dirty: HashSet::new(),
            cache_dir: None,
        })
    })
}

pub fn initialize_cache_dir(cache_dir: PathBuf) {
    let dir = cache_dir.join("exif");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut state) = get_exif_cache().lock() {
        state.cache_dir = Some(dir);
    }
}

pub fn flush_all_dirty_caches() {
    let mut state = match get_exif_cache().lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    let dirty_folders: Vec<PathBuf> = state.dirty.drain().collect();
    let mut to_write = Vec::new();

    for folder in &dirty_folders {
        if let Some(folder_map) = state.cache.get(folder)
            && !folder_map.is_empty()
            && let Some(cache_path) = state.get_cache_file_path(folder)
        {
            to_write.push((cache_path, folder_map.clone()));
        }
    }

    for (path, map) in to_write {
        if let Ok(json) = serde_json::to_string(&map) {
            let _ = file_ops::write_file_atomic(&path, json.as_bytes());
        }
    }
    drop(state);
}

pub fn clear_disk_cache() -> Result<(), String> {
    let mut state = get_exif_cache()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    state.cache.clear();
    state.dirty.clear();
    let Some(read_dir) = state
        .cache_dir
        .as_ref()
        .and_then(|dir| fs::read_dir(dir).ok())
    else {
        return Ok(());
    };
    for path in read_dir.filter_map(|e| e.ok()).map(|e| e.path()) {
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

fn load_rrcache_for_folder(folder: &Path) {
    let mut cache_path = None;

    if let Ok(state) = get_exif_cache().lock() {
        if state.cache.contains_key(folder) {
            return;
        }
        cache_path = state.get_cache_file_path(folder);
    }

    let Some(path) = cache_path else {
        return;
    };

    let loaded_map = if let Ok(content) = std::fs::read_to_string(&path) {
        serde_json::from_str::<HashMap<String, CachedExifEntry>>(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };

    if let Ok(mut state) = get_exif_cache().lock() {
        state
            .cache
            .entry(folder.to_path_buf())
            .or_insert(loaded_map);
    }
}

fn get_file_stamp(path: &Path) -> Option<(u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((mtime_ns, meta.len()))
}

pub fn get_exif_from_rrcache(image_path: &Path) -> Option<HashMap<String, String>> {
    let folder = image_path.parent()?;
    let filename = image_path.file_name()?.to_string_lossy().to_string();

    let (current_mtime, current_size) = get_file_stamp(image_path)?;

    load_rrcache_for_folder(folder);

    let mut state = get_exif_cache().lock().ok()?;
    let folder_map = state.cache.get_mut(folder)?;

    if let Some(entry) = folder_map.get(&filename) {
        if entry.mtime_ns == current_mtime && entry.size == current_size {
            return Some(entry.data.clone());
        }

        folder_map.remove(&filename);
        state.dirty.insert(folder.to_path_buf());
    }

    None
}

pub fn save_exif_to_rrcache(image_path: &Path, exif: HashMap<String, String>) {
    let Some(folder) = image_path.parent() else {
        return;
    };
    let Some(filename) = image_path.file_name() else {
        return;
    };

    let Some((mtime_ns, size)) = get_file_stamp(image_path) else {
        return;
    };

    load_rrcache_for_folder(folder);

    let mut state = match get_exif_cache().lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    let folder_map = state.cache.entry(folder.to_path_buf()).or_default();
    folder_map.insert(
        filename.to_string_lossy().to_string(),
        CachedExifEntry {
            mtime_ns,
            size,
            data: exif,
        },
    );
    state.dirty.insert(folder.to_path_buf());
}
