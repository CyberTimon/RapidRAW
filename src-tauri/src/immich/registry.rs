use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug, Clone)]
pub struct RemoteImage {
    pub asset_id: String,
}

static ENTRIES: Lazy<RwLock<HashMap<PathBuf, RemoteImage>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub fn insert(path: PathBuf, image: RemoteImage) {
    ENTRIES.write().unwrap().insert(path, image);
}

pub fn get(path: &Path) -> Option<RemoteImage> {
    ENTRIES.read().unwrap().get(path).cloned()
}

pub fn is_placeholder(path: &Path) -> bool {
    let known = ENTRIES
        .read()
        .map(|entries| entries.contains_key(path))
        .unwrap_or(false);
    known && !path.exists()
}

pub fn clear() {
    ENTRIES.write().unwrap().clear();
}
