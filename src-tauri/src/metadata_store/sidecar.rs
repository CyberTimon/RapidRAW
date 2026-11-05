//! Keeps each record in a JSON file next to its image: `a.cr3.rrdata` for the original and
//! `a.cr3.<6 hex>.rrdata` for each virtual copy, so edits travel with the photos.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::Utc;
use walkdir::WalkDir;

use super::{ImageKey, MetadataProvider, Removal};
use crate::file_management::{is_cloud_placeholder, write_file_atomic};

const EXTENSION: &str = "rrdata";

pub struct SidecarProvider;

/// Splits a sidecar file name into the image file name and the virtual copy id, if any.
pub fn parse_sidecar_name(file_name: &str) -> Option<(&str, Option<&str>)> {
    let base = file_name.strip_suffix(".rrdata")?;
    if base.len() >= 7 && base.as_bytes()[base.len() - 7] == b'.' {
        let id = &base[base.len() - 6..];
        if id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return Some((&base[..base.len() - 7], Some(id)));
        }
    }
    Some((base, None))
}

fn sidecar_path(key: &ImageKey) -> PathBuf {
    let mut file_name = key.source.file_name().unwrap_or_default().to_os_string();
    if let Some(id) = &key.copy_id {
        file_name.push(".");
        file_name.push(id);
    }
    file_name.push(".");
    file_name.push(EXTENSION);
    key.source.with_file_name(file_name)
}

fn key_for_sidecar(path: &Path) -> Option<ImageKey> {
    let name = path.file_name()?.to_str()?;
    let (source_name, copy_id) = parse_sidecar_name(name)?;
    let source = path.with_file_name(source_name);
    Some(match copy_id {
        Some(id) => ImageKey::with_copy(source, id),
        None => ImageKey::primary(source),
    })
}

fn ignore_missing(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn delete_permanently(paths: &[PathBuf]) -> io::Result<()> {
    for path in paths {
        ignore_missing(fs::remove_file(path))?;
    }
    Ok(())
}

fn sidecar_files_under(root: &Path) -> impl Iterator<Item = PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .map(walkdir::DirEntry::into_path)
        .filter(|path| {
            path.is_file() && path.extension().and_then(|s| s.to_str()) == Some(EXTENSION)
        })
}

impl MetadataProvider for SidecarProvider {
    fn read(&self, key: &ImageKey) -> io::Result<Option<String>> {
        match fs::read_to_string(sidecar_path(key)) {
            Ok(content) => Ok(Some(content)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write(&self, key: &ImageKey, json: &str) -> io::Result<()> {
        let path = sidecar_path(key);
        // Remote images get their folder on first write.
        if crate::immich::is_placeholder(&key.source)
            && let Some(parent) = path.parent()
        {
            fs::create_dir_all(parent)?;
        }
        write_file_atomic(&path, json.as_bytes())
    }

    fn create(&self, key: &ImageKey, json: &str) -> io::Result<bool> {
        use std::io::Write;

        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(sidecar_path(key))
        {
            Ok(mut file) => {
                file.write_all(json.as_bytes())?;
                Ok(true)
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn remove(&self, keys: &[ImageKey], removal: Removal) -> io::Result<()> {
        let paths: Vec<PathBuf> = keys
            .iter()
            .map(sidecar_path)
            .filter(|path| path.exists())
            .collect();
        if paths.is_empty() {
            return Ok(());
        }

        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        if removal == Removal::Trash {
            return match trash::delete_all(&paths) {
                Ok(()) => Ok(()),
                Err(e) => {
                    log::warn!("Failed to move sidecars to trash: {e}. Deleting permanently.");
                    delete_permanently(&paths)
                }
            };
        }

        let _ = removal;
        delete_permanently(&paths)
    }

    fn copy(&self, from: &ImageKey, to: &ImageKey) -> io::Result<()> {
        let from = sidecar_path(from);
        if !from.exists() {
            return Ok(());
        }
        fs::copy(&from, sidecar_path(to)).map(drop)
    }

    fn rename(&self, from: &ImageKey, to: &ImageKey) -> io::Result<()> {
        let from = sidecar_path(from);
        if !from.exists() {
            return Ok(());
        }
        let to = sidecar_path(to);
        if fs::rename(&from, &to).is_err() {
            fs::copy(&from, &to)?;
            if let Err(e) = fs::remove_file(&from) {
                log::warn!(
                    "Moved sidecar, but failed to delete original {}: {}",
                    from.display(),
                    e
                );
            }
        }
        Ok(())
    }

    fn exists(&self, key: &ImageKey) -> bool {
        sidecar_path(key).exists()
    }

    fn modified_ms(&self, key: &ImageKey) -> Option<u64> {
        let modified = fs::metadata(sidecar_path(key)).ok()?.modified().ok()?;
        Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
    }

    fn quarantine(&self, key: &ImageKey, reason: &str) {
        let path = sidecar_path(key);
        let mut quarantined = path.as_os_str().to_os_string();
        quarantined.push(format!(".corrupt-{}", Utc::now().format("%Y%m%d%H%M%S")));
        match fs::rename(&path, &quarantined) {
            Ok(()) => log::error!(
                "Unreadable sidecar {} ({}), moved to {}",
                path.display(),
                reason,
                Path::new(&quarantined).display()
            ),
            Err(e) => log::error!(
                "Unreadable sidecar {} ({}), could not move it aside: {}",
                path.display(),
                reason,
                e
            ),
        }
    }

    fn records_for(&self, source: &Path) -> io::Result<Vec<ImageKey>> {
        let (Some(parent), Some(file_name)) = (source.parent(), source.file_name()) else {
            return Ok(Vec::new());
        };
        let file_name = file_name.to_string_lossy();
        let parent = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };

        let entries = match fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        Ok(entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                match parse_sidecar_name(&name.to_string_lossy()) {
                    Some((base, None)) if base == file_name => Some(ImageKey::primary(source)),
                    Some((base, Some(id))) if base == file_name => {
                        Some(ImageKey::with_copy(source, id))
                    }
                    _ => None,
                }
            })
            .collect())
    }

    fn records_under(&self, root: &Path) -> Vec<ImageKey> {
        sidecar_files_under(root)
            .filter_map(|path| key_for_sidecar(&path))
            .collect()
    }

    fn clear_under(&self, root: &Path) -> io::Result<usize> {
        let mut deleted = 0;
        for path in sidecar_files_under(root) {
            match fs::remove_file(&path) {
                Ok(()) => deleted += 1,
                Err(e) => log::warn!("Failed to delete sidecar {}: {}", path.display(), e),
            }
        }
        Ok(deleted)
    }

    fn record_for_file(&self, path: &Path) -> Option<ImageKey> {
        key_for_sidecar(path)
    }

    fn is_placeholder(&self, key: &ImageKey) -> bool {
        is_cloud_placeholder(&sidecar_path(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn sorted(keys: Vec<ImageKey>) -> Vec<String> {
        let mut paths: Vec<String> = keys.iter().map(ImageKey::virtual_path).collect();
        paths.sort();
        paths
    }

    #[test]
    fn parses_sidecar_names() {
        assert_eq!(parse_sidecar_name("a.cr3.rrdata"), Some(("a.cr3", None)));
        assert_eq!(
            parse_sidecar_name("a.cr3.1a2b3c.rrdata"),
            Some(("a.cr3", Some("1a2b3c")))
        );
        assert_eq!(
            parse_sidecar_name("my photo.final.jpg.0f9e8d.rrdata"),
            Some(("my photo.final.jpg", Some("0f9e8d")))
        );
    }

    #[test]
    fn only_six_lowercase_hex_digits_make_a_copy_id() {
        for name in [
            "a.cr3.1A2B3C.rrdata",
            "a.cr3.1a2b3.rrdata",
            "a.cr3.1a2b3cd.rrdata",
            "a.cr3.1a2b3g.rrdata",
            "a.cr3_1a2b3c.rrdata",
        ] {
            let base = name.strip_suffix(".rrdata").unwrap();
            assert_eq!(parse_sidecar_name(name), Some((base, None)), "{name}");
        }
    }

    #[test]
    fn other_files_are_not_sidecars() {
        for name in [
            "a.cr3",
            "a.cr3.rrexif",
            "a.cr3.xmp",
            "a.cr3.rrdata.bak",
            "a.cr3.rrdata.corrupt-20240101120000",
            "a.cr3.RRDATA",
        ] {
            assert_eq!(parse_sidecar_name(name), None, "{name}");
        }
    }

    #[test]
    fn sidecar_paths_sit_next_to_the_image_and_round_trip() {
        let primary = ImageKey::primary("/photos/2024/a.cr3");
        let copy = ImageKey::with_copy("/photos/2024/a.cr3", "1a2b3c");

        assert_eq!(
            sidecar_path(&primary),
            PathBuf::from("/photos/2024/a.cr3.rrdata")
        );
        assert_eq!(
            sidecar_path(&copy),
            PathBuf::from("/photos/2024/a.cr3.1a2b3c.rrdata")
        );
        assert_eq!(key_for_sidecar(&sidecar_path(&primary)), Some(primary));
        assert_eq!(key_for_sidecar(&sidecar_path(&copy)), Some(copy));
        assert_eq!(key_for_sidecar(Path::new("/photos/2024/a.cr3")), None);
    }

    #[test]
    fn read_tells_a_missing_record_from_an_unreadable_one() {
        let dir = tempfile::tempdir().unwrap();
        let missing = ImageKey::primary(dir.path().join("a.jpg"));
        assert_eq!(SidecarProvider.read(&missing).unwrap(), None);

        // An error other than "not found" must not look like an empty record, or the next
        // save would overwrite edits it could not read.
        let blocked = ImageKey::primary(dir.path().join("b.jpg"));
        fs::create_dir(sidecar_path(&blocked)).unwrap();
        assert!(SidecarProvider.read(&blocked).is_err());
    }

    #[test]
    fn write_replaces_the_file_and_leaves_nothing_else_behind() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("a.jpg"));

        SidecarProvider.write(&key, r#"{"rating":1}"#).unwrap();
        SidecarProvider.write(&key, r#"{"rating":2}"#).unwrap();

        assert_eq!(
            fs::read_to_string(sidecar_path(&key)).unwrap(),
            r#"{"rating":2}"#
        );
        assert_eq!(names_in(dir.path()), vec!["a.jpg.rrdata"]);
    }

    #[test]
    fn write_does_not_create_folders_for_local_images() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("gone").join("a.jpg"));
        assert!(SidecarProvider.write(&key, "{}").is_err());
        assert!(!dir.path().join("gone").exists());
    }

    #[test]
    fn create_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("a.jpg"));

        assert!(SidecarProvider.create(&key, r#"{"rating":1}"#).unwrap());
        assert!(!SidecarProvider.create(&key, r#"{"rating":2}"#).unwrap());
        assert_eq!(
            SidecarProvider.read(&key).unwrap().as_deref(),
            Some(r#"{"rating":1}"#)
        );
    }

    #[test]
    fn remove_deletes_only_the_given_records() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.jpg");
        let primary = ImageKey::primary(&image);
        let copy = ImageKey::with_copy(&image, "1a2b3c");
        let other = ImageKey::primary(dir.path().join("b.jpg"));
        for key in [&primary, &copy, &other] {
            SidecarProvider.write(key, "{}").unwrap();
        }

        let never_written = ImageKey::with_copy(&image, "ffffff");
        SidecarProvider
            .remove(&[copy.clone(), never_written], Removal::Permanent)
            .unwrap();
        SidecarProvider.remove(&[], Removal::Permanent).unwrap();

        assert!(!SidecarProvider.exists(&copy));
        assert!(SidecarProvider.exists(&primary));
        assert!(SidecarProvider.exists(&other));
    }

    #[test]
    fn copy_overwrites_the_target_and_keeps_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = ImageKey::primary(dir.path().join("a.jpg"));
        let to = ImageKey::with_copy(dir.path().join("b.jpg"), "1a2b3c");
        SidecarProvider.write(&from, r#"{"rating":4}"#).unwrap();
        SidecarProvider.write(&to, r#"{"rating":1}"#).unwrap();

        SidecarProvider.copy(&from, &to).unwrap();

        assert_eq!(
            SidecarProvider.read(&to).unwrap().as_deref(),
            Some(r#"{"rating":4}"#)
        );
        assert!(SidecarProvider.exists(&from));
    }

    #[test]
    fn copy_and_rename_without_a_source_record_do_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let from = ImageKey::primary(dir.path().join("a.jpg"));
        let to = ImageKey::primary(dir.path().join("b.jpg"));

        SidecarProvider.copy(&from, &to).unwrap();
        SidecarProvider.rename(&from, &to).unwrap();

        assert!(names_in(dir.path()).is_empty());
    }

    #[test]
    fn rename_moves_the_record_and_overwrites_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let from = ImageKey::with_copy(dir.path().join("a.jpg"), "1a2b3c");
        let to = ImageKey::with_copy(dir.path().join("b.jpg"), "1a2b3c");
        SidecarProvider.write(&from, r#"{"rating":4}"#).unwrap();
        SidecarProvider.write(&to, r#"{"rating":1}"#).unwrap();

        SidecarProvider.rename(&from, &to).unwrap();

        assert!(!SidecarProvider.exists(&from));
        assert_eq!(
            SidecarProvider.read(&to).unwrap().as_deref(),
            Some(r#"{"rating":4}"#)
        );
    }

    #[test]
    fn rename_follows_an_image_into_another_folder() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("moved");
        fs::create_dir(&target).unwrap();
        let from = ImageKey::primary(dir.path().join("a.jpg"));
        let to = ImageKey::primary(target.join("a.jpg"));
        SidecarProvider.write(&from, "{}").unwrap();

        SidecarProvider.rename(&from, &to).unwrap();

        assert_eq!(names_in(dir.path()), vec!["moved"]);
        assert_eq!(names_in(&target), vec!["a.jpg.rrdata"]);
    }

    #[test]
    fn modified_ms_is_the_sidecar_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("a.jpg"));
        assert_eq!(SidecarProvider.modified_ms(&key), None);

        SidecarProvider.write(&key, "{}").unwrap();
        let mtime = fs::metadata(sidecar_path(&key))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert_eq!(SidecarProvider.modified_ms(&key), Some(mtime));
    }

    #[test]
    fn quarantine_keeps_the_unreadable_file_aside() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("a.jpg"));
        SidecarProvider.write(&key, "not json").unwrap();

        SidecarProvider.quarantine(&key, "test");

        assert!(!SidecarProvider.exists(&key));
        let names = names_in(dir.path());
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("a.jpg.rrdata.corrupt-"), "{names:?}");
        assert_eq!(
            fs::read_to_string(dir.path().join(&names[0])).unwrap(),
            "not json"
        );
        assert_eq!(
            SidecarProvider.record_for_file(&dir.path().join(&names[0])),
            None
        );
    }

    #[test]
    fn quarantining_a_missing_record_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        SidecarProvider.quarantine(&ImageKey::primary(dir.path().join("a.jpg")), "test");
        assert!(names_in(dir.path()).is_empty());
    }

    #[test]
    fn records_for_matches_the_exact_image_name() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "a.cr3",
            "a.cr3.rrdata",
            "a.cr3.1a2b3c.rrdata",
            "a.cr3.0f9e8d.rrdata",
            "aa.cr3.rrdata",
            "a.cr3x.rrdata",
            "a.cr.rrdata",
            "b.cr3.1a2b3c.rrdata",
            "a.cr3.rrexif",
            "a.cr3.rrdata.corrupt-20240101120000",
        ] {
            fs::write(dir.path().join(name), "{}").unwrap();
        }
        let image = dir.path().join("a.cr3");

        assert_eq!(
            sorted(SidecarProvider.records_for(&image).unwrap()),
            sorted(vec![
                ImageKey::primary(&image),
                ImageKey::with_copy(&image, "1a2b3c"),
                ImageKey::with_copy(&image, "0f9e8d"),
            ])
        );
        assert!(
            SidecarProvider
                .records_for(&dir.path().join("c.cr3"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn records_for_reports_folders_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_folder = dir.path().join("file");
        fs::write(&not_a_folder, "").unwrap();

        // The layer keeps a record when it cannot tell whether virtual copies need it.
        assert!(
            SidecarProvider
                .records_for(&not_a_folder.join("a.jpg"))
                .is_err()
        );
        assert!(
            SidecarProvider
                .records_for(&dir.path().join("missing").join("a.jpg"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn records_under_walks_subfolders_and_skips_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("2024").join("trip");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(dir.path().join("folder.rrdata")).unwrap();
        for path in [
            dir.path().join("a.jpg.rrdata"),
            nested.join("b.jpg.rrdata"),
            nested.join("b.jpg.1a2b3c.rrdata"),
            nested.join("b.jpg"),
            nested.join("b.jpg.rrexif"),
            nested.join("b.jpg.xmp"),
            nested.join("b.jpg.rrdata.corrupt-20240101120000"),
        ] {
            fs::write(path, "{}").unwrap();
        }

        assert_eq!(
            sorted(SidecarProvider.records_under(dir.path())),
            sorted(vec![
                ImageKey::primary(dir.path().join("a.jpg")),
                ImageKey::primary(nested.join("b.jpg")),
                ImageKey::with_copy(nested.join("b.jpg"), "1a2b3c"),
            ])
        );
        assert_eq!(SidecarProvider.records_under(&nested).len(), 2);
        assert!(
            SidecarProvider
                .records_under(&dir.path().join("missing"))
                .is_empty()
        );
    }

    #[test]
    fn clear_under_deletes_only_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("2024");
        fs::create_dir(&nested).unwrap();
        fs::create_dir(dir.path().join("folder.rrdata")).unwrap();
        for name in [
            "a.jpg",
            "a.jpg.rrdata",
            "a.jpg.1a2b3c.rrdata",
            "a.jpg.rrexif",
            "a.jpg.xmp",
            "a.jpg.rrdata.corrupt-20240101120000",
        ] {
            fs::write(dir.path().join(name), "{}").unwrap();
        }
        fs::write(nested.join("b.jpg.rrdata"), "{}").unwrap();

        assert_eq!(SidecarProvider.clear_under(dir.path()).unwrap(), 3);

        assert_eq!(
            names_in(dir.path()),
            vec![
                "2024",
                "a.jpg",
                "a.jpg.rrdata.corrupt-20240101120000",
                "a.jpg.rrexif",
                "a.jpg.xmp",
                "folder.rrdata",
            ]
        );
        assert!(names_in(&nested).is_empty());
        assert_eq!(SidecarProvider.clear_under(dir.path()).unwrap(), 0);
    }

    #[test]
    fn record_for_file_recognises_sidecars_only() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("a.jpg");

        assert_eq!(
            SidecarProvider.record_for_file(&dir.path().join("a.jpg.rrdata")),
            Some(ImageKey::primary(&image))
        );
        assert_eq!(
            SidecarProvider.record_for_file(&dir.path().join("a.jpg.1a2b3c.rrdata")),
            Some(ImageKey::with_copy(&image, "1a2b3c"))
        );
        assert_eq!(SidecarProvider.record_for_file(&image), None);
        assert_eq!(
            SidecarProvider.record_for_file(&dir.path().join("a.jpg.rrexif")),
            None
        );
    }

    #[test]
    fn local_sidecars_are_not_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("a.jpg"));
        assert!(!SidecarProvider.is_placeholder(&key));
        SidecarProvider.write(&key, "{}").unwrap();
        assert!(!SidecarProvider.is_placeholder(&key));
    }

    #[test]
    fn folder_hooks_leave_sidecars_alone() {
        let dir = tempfile::tempdir().unwrap();
        let key = ImageKey::primary(dir.path().join("a.jpg"));
        SidecarProvider.write(&key, "{}").unwrap();

        SidecarProvider
            .folder_renamed(dir.path(), &dir.path().join("renamed"))
            .unwrap();
        SidecarProvider.folder_removed(dir.path()).unwrap();

        assert!(SidecarProvider.exists(&key));
        assert!(
            SidecarProvider
                .records_in_folder(dir.path(), true)
                .is_empty()
        );
    }
}
