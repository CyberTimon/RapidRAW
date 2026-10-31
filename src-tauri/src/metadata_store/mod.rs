//! The one place per-image metadata (edits, rating, flag, tags, cached EXIF) is read and
//! written. Callers address images by `ImageKey`; the `MetadataProvider` decides where
//! records live, today `.rrdata` sidecars next to the images.
//!
//! Rules that hold for every provider live here: per-record locking, pruning records that
//! only hold defaults, healing oversized EXIF values, and keeping virtual copies consistent.

mod sidecar;

pub use sidecar::SidecarProvider;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use crate::image_processing::ImageMetadata;

/// Identifies one metadata record: an image file, optionally one of its virtual copies.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ImageKey {
    pub source: PathBuf,
    pub copy_id: Option<String>,
}

impl ImageKey {
    pub fn primary(source: impl Into<PathBuf>) -> Self {
        Self {
            source: source.into(),
            copy_id: None,
        }
    }

    pub fn with_copy(source: impl Into<PathBuf>, copy_id: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            copy_id: Some(copy_id.into()),
        }
    }

    /// Parses a library path such as `/photos/a.cr3` or `/photos/a.cr3?vc=1a2b3c`.
    pub fn parse(virtual_path: &str) -> Self {
        match virtual_path.rsplit_once("?vc=") {
            Some((source, copy_id)) => Self::with_copy(source, copy_id),
            None => Self::primary(virtual_path),
        }
    }

    pub fn is_primary(&self) -> bool {
        self.copy_id.is_none()
    }

    pub fn virtual_path(&self) -> String {
        match &self.copy_id {
            Some(id) => format!("{}?vc={}", self.source.to_string_lossy(), id),
            None => self.source.to_string_lossy().into_owned(),
        }
    }

    /// The same record (original or copy) for another image file.
    pub fn for_source(&self, source: &Path) -> Self {
        Self {
            source: source.to_path_buf(),
            copy_id: self.copy_id.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    Trash,
    Permanent,
}

/// Where records are kept. Records are opaque JSON documents to a provider; the
/// format and the rules on top of it belong to this module.
pub trait MetadataProvider: Send + Sync {
    /// The stored JSON, or `None` when the image has no record.
    fn read(&self, key: &ImageKey) -> io::Result<Option<String>>;
    fn write(&self, key: &ImageKey, json: &str) -> io::Result<()>;
    /// Writes only when no record exists yet and reports whether it did.
    fn create(&self, key: &ImageKey, json: &str) -> io::Result<bool>;
    /// Missing records are not an error.
    fn remove(&self, keys: &[ImageKey], removal: Removal) -> io::Result<()>;
    /// Overwrites `to`; does nothing when `from` has no record.
    fn copy(&self, from: &ImageKey, to: &ImageKey) -> io::Result<()>;
    /// Overwrites `to`; does nothing when `from` has no record.
    fn rename(&self, from: &ImageKey, to: &ImageKey) -> io::Result<()>;
    fn exists(&self, key: &ImageKey) -> bool;
    /// Changes every time the record is written.
    fn modified_ms(&self, key: &ImageKey) -> Option<u64>;
    /// Moves an unreadable record aside so a fresh one can take its place.
    fn quarantine(&self, key: &ImageKey, reason: &str);
    /// The original and every virtual copy stored for `source`.
    fn records_for(&self, source: &Path) -> io::Result<Vec<ImageKey>>;
    /// Every record for images in `root` or its subfolders.
    fn records_under(&self, root: &Path) -> Vec<ImageKey>;
    /// Deletes every record under `root` and returns how many it deleted.
    fn clear_under(&self, root: &Path) -> io::Result<usize>;

    /// Called for each file a folder listing walks over, so providers that keep records
    /// next to the images are found in the same pass over the disk.
    fn record_for_file(&self, _path: &Path) -> Option<ImageKey> {
        None
    }
    /// Records a folder listing cannot see on disk.
    fn records_in_folder(&self, _dir: &Path, _recursive: bool) -> Vec<ImageKey> {
        Vec::new()
    }
    /// True when the record exists but must be downloaded before it can be read.
    fn is_placeholder(&self, _key: &ImageKey) -> bool {
        false
    }
    /// Folder hooks for providers that keep records away from the images. Sidecars move
    /// and disappear with their folder, so they need neither.
    fn folder_renamed(&self, _old: &Path, _new: &Path) -> io::Result<()> {
        Ok(())
    }
    fn folder_removed(&self, _dir: &Path) -> io::Result<()> {
        Ok(())
    }
}

static PROVIDER: LazyLock<Arc<dyn MetadataProvider>> = LazyLock::new(|| Arc::new(SidecarProvider));

fn provider() -> Arc<dyn MetadataProvider> {
    PROVIDER.clone()
}

const LOCK_STRIPES: usize = 64;
static LOCKS: [Mutex<()>; LOCK_STRIPES] = [const { Mutex::new(()) }; LOCK_STRIPES];

// Serializes changes to which records an image has, so the original is never pruned while
// a virtual copy that depends on it is being created.
static LAYOUT_LOCK: Mutex<()> = Mutex::new(());

fn lock_stripe(key: &ImageKey) -> &'static Mutex<()> {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    &LOCKS[hasher.finish() as usize % LOCK_STRIPES]
}

/// Holds off every other writer of this record until the guard drops.
pub fn lock(key: &ImageKey) -> MutexGuard<'static, ()> {
    lock_stripe(key)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn layout_lock() -> MutexGuard<'static, ()> {
    LAYOUT_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

fn encode(metadata: &impl serde::Serialize) -> io::Result<String> {
    serde_json::to_string_pretty(metadata).map_err(io::Error::other)
}

fn heal_bloated_exif(meta: &mut ImageMetadata) -> bool {
    let mut healed = false;
    if let Some(ref mut exif_map) = meta.exif {
        for val in exif_map.values_mut() {
            if val.len() > 500 {
                *val = crate::exif_processing::truncate_large_exif(val);
                healed = true;
            }
        }
    }
    healed
}

fn decode(provider: &dyn MetadataProvider, key: &ImageKey) -> io::Result<(ImageMetadata, bool)> {
    let Some(content) = provider.read(key)? else {
        return Ok((ImageMetadata::default(), false));
    };
    match serde_json::from_str::<ImageMetadata>(&content) {
        Ok(mut meta) => {
            let healed = heal_bloated_exif(&mut meta);
            Ok((meta, healed))
        }
        Err(e) => {
            provider.quarantine(key, &e.to_string());
            Ok((ImageMetadata::default(), false))
        }
    }
}

fn has_virtual_copies(provider: &dyn MetadataProvider, source: &Path) -> bool {
    provider
        .records_for(source)
        .map(|records| records.iter().any(|key| !key.is_primary()))
        .unwrap_or(true)
}

fn store(
    provider: &dyn MetadataProvider,
    key: &ImageKey,
    metadata: &ImageMetadata,
) -> io::Result<()> {
    if key.is_primary() && crate::exif_processing::is_default_metadata(&key.source, metadata) {
        let _layout = layout_lock();
        if !has_virtual_copies(provider, &key.source) {
            return provider.remove(std::slice::from_ref(key), Removal::Permanent);
        }
    }
    provider.write(key, &encode(metadata)?)
}

/// The record's metadata, or defaults when there is none or it cannot be read.
pub fn load(key: &ImageKey) -> ImageMetadata {
    let provider = provider();
    let (meta, healed) = decode(&*provider, key).unwrap_or_else(|e| {
        log::warn!("Failed to read metadata for {}: {}", key.virtual_path(), e);
        (ImageMetadata::default(), false)
    });

    if healed
        && let Ok(_guard) = lock_stripe(key).try_lock()
        && let Ok((current, true)) = decode(&*provider, key)
        && encode(&current)
            .and_then(|json| provider.write(key, &json))
            .is_ok()
    {
        log::info!("Auto-healed bloated metadata for: {}", key.virtual_path());
    }

    meta
}

/// Reads the record without repairing or quarantining anything.
pub fn peek(key: &ImageKey) -> Option<ImageMetadata> {
    serde_json::from_str(&provider().read(key).ok()??).ok()
}

/// Read-modify-write under the record's lock. A primary record left holding only
/// defaults is removed, unless virtual copies still depend on it.
pub fn update(
    key: &ImageKey,
    update: impl FnOnce(&mut ImageMetadata),
) -> io::Result<ImageMetadata> {
    let provider = provider();
    let _guard = lock(key);
    let (mut metadata, _) = decode(&*provider, key)?;
    update(&mut metadata);
    store(&*provider, key, &metadata)?;
    Ok(metadata)
}

/// Like `update`, but always keeps the record, e.g. to cache EXIF next to defaults.
pub fn update_keeping_record(
    key: &ImageKey,
    update: impl FnOnce(&mut ImageMetadata),
) -> io::Result<()> {
    let provider = provider();
    let _guard = lock(key);
    let (mut metadata, _) = decode(&*provider, key)?;
    update(&mut metadata);
    provider.write(key, &encode(&metadata)?)
}

/// The record as raw JSON, for callers that sync it elsewhere untouched.
pub fn read_json(key: &ImageKey) -> Option<Value> {
    serde_json::from_str(&provider().read(key).ok()??).ok()
}

/// Replaces the record with raw JSON. Callers hold `lock(key)` when they need read-modify-write.
pub fn write_json(key: &ImageKey, value: &Value) -> io::Result<()> {
    let json = encode(value)?;
    let _layout = layout_lock();
    provider().write(key, &json)
}

pub fn modified_ms(key: &ImageKey) -> Option<u64> {
    provider().modified_ms(key)
}

pub fn exists(key: &ImageKey) -> bool {
    provider().exists(key)
}

pub fn is_placeholder(key: &ImageKey) -> bool {
    provider().is_placeholder(key)
}

fn new_copy_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}

/// Adds a virtual copy that starts from `source`'s current edits.
pub fn create_virtual_copy(source: &ImageKey) -> io::Result<ImageKey> {
    let provider = provider();
    let copy = ImageKey::with_copy(&source.source, new_copy_id());
    let default_json = encode(&ImageMetadata::default())?;

    let _layout = layout_lock();
    if provider.exists(source) {
        provider.copy(source, &copy)?;
    } else {
        provider.write(&copy, &default_json)?;
    }
    // The library hides the original when only virtual copy records exist.
    provider.create(&ImageKey::primary(&source.source), &default_json)?;
    Ok(copy)
}

/// Adds a virtual copy holding `value` as-is.
pub fn add_virtual_copy(source: &Path, value: &Value) -> io::Result<ImageKey> {
    let copy = ImageKey::with_copy(source, new_copy_id());
    let json = encode(value)?;
    let _layout = layout_lock();
    provider().write(&copy, &json)?;
    Ok(copy)
}

/// Copies one record; does nothing when `from` has none.
pub fn copy(from: &ImageKey, to: &ImageKey) -> io::Result<()> {
    provider().copy(from, to)
}

pub fn has_records(source: &Path) -> bool {
    provider()
        .records_for(source)
        .is_ok_and(|records| !records.is_empty())
}

pub fn records_for(source: &Path) -> Vec<ImageKey> {
    provider().records_for(source).unwrap_or_default()
}

/// Copies the original's record and every virtual copy from one image file to another.
pub fn copy_all(from: &Path, to: &Path) -> io::Result<()> {
    let provider = provider();
    for key in provider.records_for(from)? {
        provider.copy(&key, &key.for_source(to))?;
    }
    Ok(())
}

/// Follows an image file that was moved or renamed.
pub fn move_all(from: &Path, to: &Path) -> io::Result<()> {
    let provider = provider();
    for key in provider.records_for(from)? {
        provider.rename(&key, &key.for_source(to))?;
    }
    Ok(())
}

pub fn remove(keys: &[ImageKey], removal: Removal) -> io::Result<()> {
    provider().remove(keys, removal)
}

pub fn records_under(root: &Path) -> Vec<ImageKey> {
    provider().records_under(root)
}

pub fn clear_under(root: &Path) -> io::Result<usize> {
    provider().clear_under(root)
}

pub fn record_for_file(path: &Path) -> Option<ImageKey> {
    provider().record_for_file(path)
}

pub fn records_in_folder(dir: &Path, recursive: bool) -> Vec<ImageKey> {
    provider().records_in_folder(dir, recursive)
}

pub fn folder_renamed(old: &Path, new: &Path) {
    if let Err(e) = provider().folder_renamed(old, new) {
        log::error!(
            "Failed to move metadata from {} to {}: {}",
            old.display(),
            new.display(),
            e
        );
    }
}

pub fn folder_removed(dir: &Path) {
    if let Err(e) = provider().folder_removed(dir) {
        log::error!("Failed to remove metadata under {}: {}", dir.display(), e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut keys: Vec<ImageKey>) -> Vec<String> {
        let mut paths: Vec<String> = keys.drain(..).map(|key| key.virtual_path()).collect();
        paths.sort();
        paths
    }

    // The behaviour every provider has to share.
    fn exercise(provider: &dyn MetadataProvider, root: &Path) {
        let folder = root.join("shoot");
        std::fs::create_dir_all(&folder).unwrap();
        let image = folder.join("a.cr3");
        let other = folder.join("b.cr3");
        let primary = ImageKey::primary(&image);
        let copy = ImageKey::with_copy(&image, "1a2b3c");

        assert_eq!(provider.read(&primary).unwrap(), None);
        assert!(!provider.exists(&primary));

        provider.write(&primary, r#"{"rating":3}"#).unwrap();
        assert_eq!(
            provider.read(&primary).unwrap().as_deref(),
            Some(r#"{"rating":3}"#)
        );
        assert!(provider.exists(&primary));
        assert!(provider.modified_ms(&primary).is_some());

        assert!(!provider.create(&primary, "{}").unwrap());
        assert!(provider.create(&copy, r#"{"rating":1}"#).unwrap());
        assert_eq!(
            sorted(provider.records_for(&image).unwrap()),
            sorted(vec![primary.clone(), copy.clone()])
        );

        provider.copy(&primary, &ImageKey::primary(&other)).unwrap();
        assert_eq!(
            provider
                .read(&ImageKey::primary(&other))
                .unwrap()
                .as_deref(),
            Some(r#"{"rating":3}"#)
        );

        provider.rename(&copy, &copy.for_source(&other)).unwrap();
        assert_eq!(
            sorted(provider.records_for(&image).unwrap()),
            sorted(vec![primary.clone()])
        );
        assert_eq!(provider.records_for(&other).unwrap().len(), 2);
        assert_eq!(provider.records_under(root).len(), 3);

        provider.write(&primary, "not json").unwrap();
        provider.quarantine(&primary, "test");
        assert_eq!(provider.read(&primary).unwrap(), None);

        provider
            .remove(
                &[ImageKey::primary(&other), primary.clone()],
                Removal::Permanent,
            )
            .unwrap();
        assert_eq!(provider.records_under(root).len(), 1);
        assert_eq!(provider.clear_under(root).unwrap(), 1);
        assert!(provider.records_under(root).is_empty());
    }

    #[test]
    fn sidecar_provider_contract() {
        let dir = tempfile::tempdir().unwrap();
        exercise(&SidecarProvider, dir.path());
    }

    #[test]
    fn update_prunes_defaults_unless_virtual_copies_exist() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.jpg");
        let primary = ImageKey::primary(&image);

        update(&primary, |meta| meta.rating = 4).unwrap();
        assert_eq!(load(&primary).rating, 4);

        update(&primary, |meta| meta.rating = 0).unwrap();
        assert!(
            !exists(&primary),
            "a record holding only defaults is removed"
        );

        let copy = create_virtual_copy(&primary).unwrap();
        assert!(exists(&primary) && exists(&copy));
        update(&primary, |meta| meta.rating = 0).unwrap();
        assert!(
            exists(&primary),
            "the original stays while a virtual copy needs it"
        );
    }

    #[test]
    fn virtual_copies_start_from_the_current_edits() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        update(&primary, |meta| meta.rating = 2).unwrap();

        let copy = create_virtual_copy(&primary).unwrap();
        assert_eq!(load(&copy).rating, 2);
        update(&copy, |meta| meta.rating = 5).unwrap();
        assert_eq!(load(&primary).rating, 2);
        assert_eq!(
            sorted(records_for(&primary.source)),
            sorted(vec![primary.clone(), copy])
        );
    }

    #[test]
    fn copy_all_and_move_all_carry_virtual_copies() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.jpg");
        let copied = dir.path().join("copied.jpg");
        let moved = dir.path().join("moved.jpg");
        let primary = ImageKey::primary(&image);
        update(&primary, |meta| meta.rating = 3).unwrap();
        let copy = create_virtual_copy(&primary).unwrap();

        copy_all(&image, &copied).unwrap();
        assert_eq!(records_for(&image).len(), 2);
        assert_eq!(load(&copy.for_source(&copied)).rating, 3);

        move_all(&image, &moved).unwrap();
        assert!(!has_records(&image));
        assert_eq!(
            sorted(records_for(&moved)),
            sorted(vec![ImageKey::primary(&moved), copy.for_source(&moved)])
        );
    }

    #[test]
    fn unreadable_records_are_quarantined_and_read_as_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        provider().write(&primary, "not json").unwrap();

        assert_eq!(load(&primary).rating, 0);
        assert!(!exists(&primary));
        update(&primary, |meta| meta.rating = 1).unwrap();
        assert_eq!(load(&primary).rating, 1);
    }

    #[test]
    fn a_missing_folder_has_no_records() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("missing");
        let image = folder.join("a.jpg");
        assert!(SidecarProvider.records_for(&image).unwrap().is_empty());

        update(&ImageKey::primary(&image), |meta| meta.rating = 0).unwrap();
        assert!(!folder.exists(), "defaults are not written anywhere");
    }

    #[test]
    fn virtual_copy_records_are_never_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let copy = ImageKey::with_copy(dir.path().join("a.jpg"), "1a2b3c");
        update(&copy, |meta| meta.rating = 0).unwrap();
        assert!(exists(&copy));
    }

    #[test]
    fn exif_that_cannot_be_checked_against_the_image_keeps_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("missing.jpg"));
        update(&primary, |meta| {
            meta.exif = Some([("Model".to_string(), "X100V".to_string())].into());
        })
        .unwrap();
        assert!(exists(&primary));
    }

    #[test]
    fn update_keeping_record_keeps_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        update_keeping_record(&primary, |meta| meta.rating = 0).unwrap();
        assert!(exists(&primary));
    }

    #[test]
    fn update_returns_what_it_stored() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        let stored = update(&primary, |meta| meta.tags = Some(vec!["dog".into()])).unwrap();
        assert_eq!(stored.tags, load(&primary).tags);
    }

    #[test]
    fn update_fails_without_touching_a_record_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        let blocked = dir.path().join("a.jpg.rrdata");
        std::fs::create_dir(&blocked).unwrap();

        assert!(update(&primary, |meta| meta.rating = 5).is_err());
        assert!(blocked.is_dir());
    }

    #[test]
    fn concurrent_updates_are_not_lost() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));

        std::thread::scope(|scope| {
            for i in 0..16 {
                let primary = &primary;
                scope.spawn(move || {
                    update(primary, |meta| {
                        meta.tags.get_or_insert_default().push(format!("tag{i}"));
                    })
                    .unwrap();
                });
            }
        });

        assert_eq!(load(&primary).tags.map(|tags| tags.len()), Some(16));
    }

    #[test]
    fn load_heals_oversized_exif_values() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        let bloated = "x".repeat(2000);
        let meta = ImageMetadata {
            exif: Some([("MakerNote".to_string(), bloated.clone())].into()),
            ..ImageMetadata::default()
        };
        provider().write(&primary, &encode(&meta).unwrap()).unwrap();

        let healed = load(&primary).exif.unwrap()["MakerNote"].clone();
        assert!(healed.len() < bloated.len());

        let on_disk = peek(&primary).unwrap().exif.unwrap()["MakerNote"].clone();
        assert_eq!(on_disk, healed, "the healed value is written back");
    }

    #[test]
    fn peek_neither_repairs_nor_quarantines() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        assert!(peek(&primary).is_none());

        provider().write(&primary, "not json").unwrap();
        assert!(peek(&primary).is_none());
        assert!(exists(&primary));
    }

    #[test]
    fn raw_json_keeps_fields_the_app_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        assert!(read_json(&primary).is_none());

        let value = serde_json::json!({ "rating": 2, "fromANewerVersion": { "x": 1 } });
        write_json(&primary, &value).unwrap();

        assert_eq!(read_json(&primary), Some(value));
        assert_eq!(load(&primary).rating, 2);
        assert!(modified_ms(&primary).is_some());
    }

    #[test]
    fn add_virtual_copy_stores_the_value_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.jpg");
        let value = serde_json::json!({ "rating": 4, "adjustments": { "exposure": 1.0 } });

        let copy = add_virtual_copy(&image, &value).unwrap();

        assert_eq!(copy.source, image);
        let id = copy.copy_id.as_deref().unwrap();
        assert!(
            id.len() == 6 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
            "{id}"
        );
        assert_eq!(read_json(&copy), Some(value));
        assert!(!exists(&ImageKey::primary(&image)));
    }

    #[test]
    fn create_virtual_copy_of_an_unedited_image() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));

        let copy = create_virtual_copy(&primary).unwrap();

        assert_eq!(load(&copy).rating, 0);
        assert!(
            exists(&primary),
            "the original stays listed next to its copy"
        );
        assert_ne!(copy, create_virtual_copy(&primary).unwrap());
    }

    #[test]
    fn create_virtual_copy_of_a_virtual_copy() {
        let dir = tempfile::tempdir().unwrap();
        let primary = ImageKey::primary(dir.path().join("a.jpg"));
        update(&primary, |meta| meta.rating = 1).unwrap();
        let first = create_virtual_copy(&primary).unwrap();
        update(&first, |meta| meta.rating = 5).unwrap();

        let second = create_virtual_copy(&first).unwrap();

        assert!(second.copy_id.is_some() && second.source == primary.source);
        assert_eq!(load(&second).rating, 5);
        assert_eq!(load(&primary).rating, 1, "the original is not overwritten");
    }

    #[test]
    fn single_record_copy_and_removal() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.jpg");
        let other = dir.path().join("b.jpg");
        let primary = ImageKey::primary(&image);
        assert!(!has_records(&image));

        copy(&primary, &ImageKey::primary(&other)).unwrap();
        assert!(!has_records(&other), "nothing to copy");

        update(&primary, |meta| meta.rating = 3).unwrap();
        let copy_key = create_virtual_copy(&primary).unwrap();
        copy(&copy_key, &ImageKey::primary(&other)).unwrap();
        assert_eq!(load(&ImageKey::primary(&other)).rating, 3);

        remove(std::slice::from_ref(&copy_key), Removal::Permanent).unwrap();
        assert_eq!(sorted(records_for(&image)), sorted(vec![primary.clone()]));
    }

    #[test]
    fn folder_level_helpers_cover_subfolders() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("2024");
        std::fs::create_dir(&nested).unwrap();
        update(&ImageKey::primary(dir.path().join("a.jpg")), |meta| {
            meta.rating = 1
        })
        .unwrap();
        update(&ImageKey::primary(nested.join("b.jpg")), |meta| {
            meta.rating = 2
        })
        .unwrap();

        assert_eq!(records_under(dir.path()).len(), 2);
        assert_eq!(
            record_for_file(&nested.join("b.jpg.rrdata")),
            Some(ImageKey::primary(nested.join("b.jpg")))
        );
        assert_eq!(clear_under(dir.path()).unwrap(), 2);
        assert!(records_under(dir.path()).is_empty());
    }

    #[test]
    fn key_round_trips_virtual_paths() {
        let key = ImageKey::parse("/photos/a.cr3?vc=1a2b3c");
        assert_eq!(key.source, PathBuf::from("/photos/a.cr3"));
        assert_eq!(key.copy_id.as_deref(), Some("1a2b3c"));
        assert_eq!(key.virtual_path(), "/photos/a.cr3?vc=1a2b3c");
        assert!(ImageKey::parse("/photos/a.cr3").is_primary());
        assert_eq!(
            ImageKey::parse("/photos/a.cr3").virtual_path(),
            "/photos/a.cr3"
        );
    }

    #[test]
    fn key_for_another_source_keeps_the_copy_id() {
        let copy = ImageKey::with_copy("/photos/a.cr3", "1a2b3c");
        assert_eq!(
            copy.for_source(Path::new("/archive/a.cr3")),
            ImageKey::with_copy("/archive/a.cr3", "1a2b3c")
        );
        assert!(
            ImageKey::primary("/photos/a.cr3")
                .for_source(Path::new("/archive/a.cr3"))
                .is_primary()
        );
    }
}
