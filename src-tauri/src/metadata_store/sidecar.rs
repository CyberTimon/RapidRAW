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

        Ok(fs::read_dir(parent)?
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
        WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().is_file()
                    && entry.path().extension().and_then(|s| s.to_str()) == Some(EXTENSION)
            })
            .filter_map(|entry| key_for_sidecar(entry.path()))
            .collect()
    }

    fn clear_under(&self, root: &Path) -> io::Result<usize> {
        let mut deleted = 0;
        for key in self.records_under(root) {
            let path = sidecar_path(&key);
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
