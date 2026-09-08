//! Embedded ratings only: never confuse this cache with complete EXIF or user overrides.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const VERSION: u32 = 1;
#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    version: u32,
    mtime: u128,
    size: u64,
    rating: Option<u8>,
}
#[derive(Default)]
struct Cache {
    root: Option<PathBuf>,
    folders: HashMap<PathBuf, HashMap<String, Entry>>,
    dirty: HashSet<PathBuf>,
}
fn state() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}
fn cache_path(root: &Path, folder: &Path) -> PathBuf {
    root.join(format!(
        "{}.json",
        blake3::hash(folder.to_string_lossy().as_bytes()).to_hex()
    ))
}
pub fn initialize(root: PathBuf) {
    let root = root.join("ratings");
    let _ = std::fs::create_dir_all(&root);
    state().lock().unwrap().root = Some(root);
}
fn stamp(path: &Path) -> std::io::Result<(u128, u64)> {
    let metadata = path.metadata()?;
    let time = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_nanos();
    Ok((time, metadata.len()))
}
pub fn peek(path: &Path) -> Option<Option<u8>> {
    let (mtime, size) = stamp(path).ok()?;
    let folder = path.parent()?;
    let name = path.file_name()?.to_string_lossy();
    let mut cache = state().lock().unwrap();
    if !cache.folders.contains_key(folder) {
        let entries = cache
            .root
            .as_ref()
            .and_then(|root| std::fs::read(cache_path(root, folder)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        cache.folders.insert(folder.to_path_buf(), entries);
    }
    cache
        .folders
        .get(folder)?
        .get(name.as_ref())
        .filter(|entry| entry.version == VERSION && entry.mtime == mtime && entry.size == size)
        .map(|entry| entry.rating)
}
pub fn read(path: &Path) -> std::io::Result<Option<u8>> {
    if let Some(rating) = peek(path) {
        return Ok(rating);
    }
    let (mtime, size) = stamp(path)?;
    let rating = crate::embedded_rating::read_rating_checked(path)?;
    // A concurrent external edit must not be cached under an obsolete stamp.
    if stamp(path)? == (mtime, size) {
        if let (Some(folder), Some(name)) = (path.parent(), path.file_name()) {
            let mut cache = state().lock().unwrap();
            cache
                .folders
                .entry(folder.to_path_buf())
                .or_default()
                .insert(
                    name.to_string_lossy().into_owned(),
                    Entry {
                        version: VERSION,
                        mtime,
                        size,
                        rating,
                    },
                );
            cache.dirty.insert(folder.to_path_buf());
        }
    }
    Ok(rating)
}
pub fn flush() {
    static FLUSH: Mutex<()> = Mutex::new(());
    let _guard = FLUSH.lock().unwrap();
    let pending = {
        let mut cache = state().lock().unwrap();
        let Some(root) = cache.root.clone() else {
            return;
        };
        let dirty: Vec<_> = cache.dirty.drain().collect();
        dirty
            .into_iter()
            .filter_map(|folder| {
                let entries = cache.folders.get(&folder)?.clone();
                Some((folder.clone(), cache_path(&root, &folder), entries))
            })
            .collect::<Vec<_>>()
    };
    for (folder, path, entries) in pending {
        let result = (|| -> std::io::Result<()> {
            let bytes = serde_json::to_vec(&entries)?;
            let temporary = path.with_extension("tmp");
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(temporary, path)
        })();
        if result.is_err() {
            state().lock().unwrap().dirty.insert(folder);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn rating_cache_invalidates_and_does_not_cache_errors() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"notaraw!").unwrap();
        assert_eq!(read(file.path()).unwrap(), None);
        assert_eq!(peek(file.path()), Some(None));
        file.as_file().set_len(2).unwrap();
        assert_eq!(peek(file.path()), None);
        assert!(read(file.path()).is_err());
        assert_eq!(peek(file.path()), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut unreadable = tempfile::NamedTempFile::new().unwrap();
            unreadable.write_all(b"notaraw!").unwrap();
            let permissions = unreadable.path().metadata().unwrap().permissions();
            std::fs::set_permissions(unreadable.path(), std::fs::Permissions::from_mode(0)).unwrap();
            let result = read(unreadable.path());
            std::fs::set_permissions(unreadable.path(), permissions).unwrap();
            assert!(result.is_err());
            assert_eq!(peek(unreadable.path()), None);
        }
    }
}
