use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Root directory *every* persistent app file lives under — settings,
/// presets, albums, the internal library, LUTs, ONNX models, window state,
/// and relocated `.rrdata`/`.rrexif` sidecars alike. Deliberately *not*
/// `app_data_dir()` / `app_config_dir()` directly (which nest under the full
/// Tauri bundle identifier, e.g. `io.github.CyberTimon.RapidRAW`) — instead
/// everything lives in a plain `RapidRAW` sibling folder, so the folder a
/// user finds browsing AppData actually reads "RapidRAW", not the bundle id.
/// `tauri.conf.json`'s `identifier` itself is untouched; only where files
/// are written moves. Not `app_cache_dir()` either — unlike thumbnails, none
/// of this data is regenerable.
pub fn app_root_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let base = app_data.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| app_data.clone());
    let root = base.join("RapidRAW");

    if !root.exists() && app_data.is_dir() {
        // Fresh migration: nobody has touched the RapidRAW folder yet, so
        // the entire identifier-named folder (settings, presets, albums,
        // library, luts, models, sidecars, window state, ...) can move in
        // one atomic `rename` instead of being walked entry-by-entry.
        if let Some(parent) = root.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(&app_data, &root).is_ok() {
            return Ok(root);
        }
    }

    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // Mixed case: an older release already relocated just the `sidecars`
    // folder, so `root` exists but the identifier folder still holds
    // everything else. Merge any leftover top-level entries into `root` in
    // one pass (skipping anything already present there) so an upgrade from
    // that in-between state converges on the same layout as a fresh
    // install. Cheap no-op once the identifier folder has been drained.
    if app_data.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&app_data) {
            for entry in entries.flatten() {
                let dest = root.join(entry.file_name());
                if !dest.exists() {
                    let _ = std::fs::rename(entry.path(), dest);
                }
            }
        }
        let _ = std::fs::remove_dir(&app_data);
    }

    Ok(root)
}

/// Root directory every relocated `.rrdata`/`.rrexif` sidecar lives under —
/// a subfolder of [`app_root_dir`].
pub fn sidecar_root_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let root = app_root_dir(app_handle)?.join("sidecars");
    if !root.exists() {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(root)
}

/// Root of the cosmetic "browse by month" secondary view — a sibling of
/// [`sidecar_root_dir`], so both live under the same `RapidRAW/` folder.
fn sidecar_by_month_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let root = sidecar_root_dir(app_handle)?;
    Ok(root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| root.clone())
        .join("sidecars_by_month"))
}

/// Best-effort: hard-links `sidecar_path` (which must already live under
/// [`sidecar_root_dir`]) into `sidecars_by_month/<month>/<same-mirrored-
/// relative-path>`, purely for the user's own convenience browsing Explorer
/// — grouped by the month a sidecar was *first* created (i.e. first edited),
/// never the photo's own capture date (not worth an EXIF read on every
/// write just for this). This is a second pointer at the same file, not a
/// copy and not the authoritative location — the app's own logic never
/// reads through this tree, so any failure here (unsupported filesystem,
/// cross-volume link, permissions) is safe to swallow silently rather than
/// surfacing an error for a cosmetic feature. A hard link (not a symlink)
/// is used specifically because Windows symlinks need admin/Developer Mode
/// privileges and hard links don't — and the same-volume constraint hard
/// links carry is always satisfied here since both paths live under the
/// same `RapidRAW/` tree.
fn link_into_month_view(app_handle: &AppHandle, sidecar_path: &Path, month: &str) {
    let Ok(root) = sidecar_root_dir(app_handle) else {
        return;
    };
    let Ok(relative) = sidecar_path.strip_prefix(&root) else {
        return;
    };
    let Ok(by_month_root) = sidecar_by_month_root(app_handle) else {
        return;
    };
    let link_path = by_month_root.join(month).join(relative);
    if link_path.exists() {
        return;
    }
    if let Some(parent) = link_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = std::fs::hard_link(sidecar_path, &link_path);
}

/// The month (`YYYY-MM`, local time) a sidecar was first created — `now` for
/// a fresh write ([`write_sidecar`]), or the file's own modified time for a
/// pre-existing file being migrated ([`migrate_legacy_rrdata`]), falling
/// back to `now` if that metadata can't be read.
fn month_of(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(|t| {
            let datetime: chrono::DateTime<chrono::Local> = t.into();
            datetime.format("%Y-%m").to_string()
        })
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m").to_string())
}

/// Writes a sidecar's contents and, only the first time this exact file is
/// created, adds it to the cosmetic by-month view above — every write site
/// funnels through this (instead of a bare `fs::write`) so that view can't
/// silently miss a sidecar. Safe/cheap to call on every save: the `exists()`
/// check means re-saving an already-edited photo just overwrites the real
/// file and skips the link step entirely.
pub fn write_sidecar(app_handle: &AppHandle, sidecar_path: &Path, contents: &str) -> std::io::Result<()> {
    let is_new = !sidecar_path.exists();
    std::fs::write(sidecar_path, contents)?;
    if is_new {
        link_into_month_view(app_handle, sidecar_path, &chrono::Local::now().format("%Y-%m").to_string());
    }
    Ok(())
}

/// Sanitizes one path component into something valid as a plain directory
/// name on every platform — in particular a Windows drive prefix (`C:`, or
/// the `\\?\C:` verbatim form `Path::canonicalize()` returns) collapses to
/// just `C` here, since filtering to alphanumeric characters strips the
/// `\`/`?`/`:` either way regardless of which prefix form was given.
fn sanitize_component(component: Component) -> Option<String> {
    match component {
        Component::Prefix(prefix) => {
            let raw = prefix.as_os_str().to_string_lossy();
            let cleaned: String = raw.chars().filter(|c| c.is_alphanumeric()).collect();
            if cleaned.is_empty() { None } else { Some(cleaned) }
        }
        Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
        Component::RootDir | Component::CurDir | Component::ParentDir => None,
    }
}

/// Maps a photo's own directory to the mirrored directory under the
/// centralized sidecar root its sidecar(s) now live in — e.g.
/// `C:\Users\vini\Photos\trip` -> `<sidecar_root>\C\Users\vini\Photos\trip`.
/// Only the *directory* a sidecar is considered to live in moves; the
/// sidecar's own filename-construction rules (below) are unchanged, so this
/// is a pure relocation, not a renaming — and because the mirrored tree's
/// structure exactly parallels the source tree's, folder-level sidecar
/// *discovery* (`list_images_in_dir`/`list_images_recursive`) keeps working
/// by scanning the mirrored directory instead of the photo's own — same
/// bucket-and-match logic, just pointed at a different root.
pub fn mirrored_sidecar_dir(sidecar_root: &Path, photo_dir: &Path) -> PathBuf {
    let mut result = sidecar_root.to_path_buf();
    for component in photo_dir.components() {
        if let Some(part) = sanitize_component(component) {
            result.push(part);
        }
    }
    result
}

/// The centralized sidecar directory for the folder containing `photo_path`
/// — canonicalizes first so the same photo always mirrors to the same
/// location regardless of how it was navigated to (symlink, differing case
/// on Windows, `.`/`..` in the input path); falls back to the raw,
/// non-canonicalized parent if canonicalization fails (e.g. the photo was
/// deleted between being listed and being looked up here — rare, but this
/// should degrade gracefully rather than error).
pub fn sidecar_dir_for_photo(app_handle: &AppHandle, photo_path: &Path) -> Result<PathBuf, String> {
    let root = sidecar_root_dir(app_handle)?;
    let photo_dir = photo_path.parent().unwrap_or_else(|| Path::new(""));
    let canonical_dir = photo_dir.canonicalize().unwrap_or_else(|_| photo_dir.to_path_buf());
    Ok(mirrored_sidecar_dir(&root, &canonical_dir))
}

/// Builds the sidecar filename for `photo_path` (and, for a virtual copy,
/// its `copy_id`) — identical construction rules to what
/// `file_management.rs`'s `parse_virtual_path` and `exif_processing.rs`'s
/// `get_primary_sidecar_path`/`get_rrexif_path` always used, kept exactly
/// the same here so relocating sidecars doesn't also rename them.
pub fn sidecar_filename(photo_path: &Path, copy_id: Option<&str>, extension: &str) -> String {
    let base = photo_path.file_name().unwrap_or_default().to_string_lossy();
    match copy_id {
        Some(id) => format!("{}.{}.{}", base, id, extension),
        None => format!("{}.{}", base, extension),
    }
}

/// Full centralized path for `photo_path`'s primary (`copy_id: None`) or
/// virtual-copy sidecar, of the given `extension` (`"rrdata"` or, during the
/// legacy-migration window, `"rrexif"`).
pub fn sidecar_path_for(
    app_handle: &AppHandle,
    photo_path: &Path,
    copy_id: Option<&str>,
    extension: &str,
) -> Result<PathBuf, String> {
    let dir = sidecar_dir_for_photo(app_handle, photo_path)?;
    Ok(dir.join(sidecar_filename(photo_path, copy_id, extension)))
}

/// The mirrored sidecar directory for an entire source directory (not a
/// specific photo) — same mirroring as [`sidecar_dir_for_photo`], just
/// applied to a folder the caller already has (e.g. a library root a bulk
/// operation was asked to walk) instead of deriving it from a photo's
/// parent. Also returns the canonicalized source directory the mapping was
/// computed from, since callers that need to walk the mirrored tree and
/// map results back to source paths (see `tagging.rs`'s
/// `clear_ai_tags`/`clear_all_tags`) need both ends of the mapping to agree
/// on the exact same canonical form.
pub fn mirrored_root_for_source_dir(
    app_handle: &AppHandle,
    source_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let root = sidecar_root_dir(app_handle)?;
    let canonical_dir = source_dir
        .canonicalize()
        .unwrap_or_else(|_| source_dir.to_path_buf());
    let mirrored = mirrored_sidecar_dir(&root, &canonical_dir);
    Ok((mirrored, canonical_dir))
}

/// Moves one legacy (pre-relocation) `.rrdata` file found directly next to
/// a photo into its new centralized, mirrored location — called from
/// `list_images_in_dir`/`list_images_recursive` for every `.rrdata` they
/// encounter while scanning a photo's own folder, so migration happens
/// automatically and incrementally on ordinary folder browsing (no
/// separate "have I migrated this folder yet" flag needed: a folder with
/// nothing left to migrate is just a fast, do-nothing scan). Returns the
/// new path on success, so the caller can fold the migrated sidecar
/// straight into whatever it's already doing without a second lookup.
/// `.rrexif` is *not* migrated here — it already has its own
/// merge-into-`.rrdata`-then-delete migration path
/// (`exif_processing.rs`'s `read_rrexif_sidecar`) and stays adjacent to
/// the photo by design (see `legacy_sidecar_path`'s doc comment).
pub fn migrate_legacy_rrdata(
    app_handle: &AppHandle,
    legacy_path: &Path,
    photo_path: &Path,
    copy_id: Option<&str>,
) -> Option<PathBuf> {
    let new_path = sidecar_path_for(app_handle, photo_path, copy_id, "rrdata").ok()?;
    if new_path.exists() {
        // Something's already at the new location (e.g. re-migrated on a
        // previous run that failed to remove the legacy file) — don't
        // clobber it, just leave the legacy copy for the user/a future
        // pass to reconcile manually rather than silently losing data.
        return None;
    }
    let parent = new_path.parent()?;
    std::fs::create_dir_all(parent).ok()?;
    std::fs::rename(legacy_path, &new_path).ok()?;
    link_into_month_view(app_handle, &new_path, &month_of(&new_path));
    Some(new_path)
}

/// The pre-relocation sidecar path (next to the photo) — used only by the
/// one-time bulk migration (`migrate_sidecars_in_dir`) and the lazy
/// fallback lookup, both of which need to find sidecars a pre-update
/// install of the app already wrote in the old location.
pub fn legacy_sidecar_path(photo_path: &Path, copy_id: Option<&str>, extension: &str) -> PathBuf {
    photo_path.with_file_name(sidecar_filename(photo_path, copy_id, extension))
}
