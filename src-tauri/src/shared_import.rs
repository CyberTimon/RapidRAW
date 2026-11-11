//! Photos handed to RapidRAW by Android ("Share" → RapidRAW, "Open with" → RapidRAW).
//!
//! MainActivity.kt receives the intent (cold start in onCreate, running app in onNewIntent), copies every file
//! into the app's library folder, `<library>/Imports/Shared/YYYY-MM-DD/<original name>` (an identical file that is
//! already there is reused, not copied again), and then drops one small JSON note per intent into an inbox folder
//! next to the library (`<external media dir>/shared-inbox/*.json`, written as `.tmp` and renamed). It then pokes
//! the UI (`window.__rapidrawSharedImports()`), which calls [take_shared_imports]: the notes are claimed (renamed,
//! read, deleted), so each shared batch is opened exactly once, also when the UI only asks at its start.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Folder next to the library (`<external media dir>/<INBOX_DIR>`) where MainActivity.kt leaves its notes.
pub const INBOX_DIR: &str = "shared-inbox";

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
struct InboxNote {
    /// absolute paths of the copies, in the order they were shared
    paths: Vec<String>,
    /// files Android could not hand over (no permission, gone, disk full…)
    failed: u32,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedImports {
    /// Copies RapidRAW can open, in order, without duplicates.
    pub paths: Vec<String>,
    /// Folder to show in the library: the folder of the first photo.
    pub folder: Option<String>,
    /// Names of shared files RapidRAW can't open (their copies are removed again).
    pub unsupported: Vec<String>,
    /// Files that could not be copied.
    pub failed: u32,
}

#[cfg(test)]
impl SharedImports {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.unsupported.is_empty() && self.failed == 0
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Claims and reads every note in `inbox` (oldest first) and merges them.
pub fn take_from_inbox(inbox: &Path) -> SharedImports {
    let mut out = SharedImports::default();
    let Ok(entries) = fs::read_dir(inbox) else {
        return out;
    };
    let mut notes: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    // MainActivity names them <epoch millis>-<n>.json: by name = by arrival
    notes.sort();

    for note in notes {
        // claimed by renaming first, so a note is never handled twice (two calls racing)
        let claimed = note.with_extension("taken");
        if fs::rename(&note, &claimed).is_err() {
            continue;
        }
        let text = fs::read_to_string(&claimed).unwrap_or_default();
        let _ = fs::remove_file(&claimed);
        let parsed: InboxNote = match serde_json::from_str(&text) {
            Ok(n) => n,
            Err(e) => {
                log::warn!(
                    "Ignoring unreadable shared-inbox note {}: {}",
                    claimed.display(),
                    e
                );
                continue;
            }
        };
        out.failed += parsed.failed;
        for p in parsed.paths {
            if out.paths.contains(&p) {
                continue;
            }
            let path = Path::new(&p);
            if !path.is_file() {
                out.failed += 1;
                continue;
            }
            if crate::formats::is_supported_image_file(path) {
                out.paths.push(p);
            } else {
                let name = file_name_of(path);
                if !out.unsupported.contains(&name) {
                    out.unsupported.push(name);
                }
                // only RapidRAW writes into Imports/Shared: nothing else loses a file here
                let _ = fs::remove_file(path);
            }
        }
    }

    out.folder = out
        .paths
        .first()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string());
    out
}

/// What the UI gets for the photos shared with the app since it last asked. Only Android writes notes; elsewhere
/// the inbox in the app data folder stays empty.
#[tauri::command]
pub fn take_shared_imports(app_handle: tauri::AppHandle) -> Result<SharedImports, String> {
    #[cfg(target_os = "android")]
    let base = {
        let _ = &app_handle;
        let library = crate::android_integration::get_android_internal_library_root()?;
        library
            .parent()
            .ok_or_else(|| "The app's library folder has no parent".to_string())?
            .to_path_buf()
    };
    #[cfg(not(target_os = "android"))]
    let base = {
        use tauri::Manager;
        app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
    };
    Ok(take_from_inbox(&base.join(INBOX_DIR)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn takes_notes_once_in_order_without_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let day = tmp.path().join(".library/Imports/Shared/2026-11-06");
        let raf = day.join("DSCF0001.RAF");
        let jpg = day.join("IMG_0002.jpg");
        let pdf = day.join("menu.pdf");
        for f in [&raf, &jpg, &pdf] {
            write(f, "x");
        }
        let inbox = tmp.path().join(INBOX_DIR);
        let s = |p: &Path| p.to_string_lossy().to_string();
        write(
            &inbox.join("1000-1.json"),
            &serde_json::json!({ "paths": [s(&raf), s(&pdf)], "failed": 1 }).to_string(),
        );
        write(
            &inbox.join("1001-1.json"),
            &serde_json::json!({ "paths": [s(&jpg), s(&raf), s(&day.join("gone.jpg"))] })
                .to_string(),
        );
        write(&inbox.join("1002-1.json.tmp"), "{\"paths\":[]}"); // still being written
        write(&inbox.join("0999-1.json"), "not json");

        let got = take_from_inbox(&inbox);
        assert_eq!(got.paths, vec![s(&raf), s(&jpg)]);
        assert_eq!(got.folder, Some(s(&day)));
        assert_eq!(got.unsupported, vec!["menu.pdf".to_string()]);
        assert_eq!(got.failed, 2);
        assert!(!pdf.exists(), "unsupported copy is removed");
        assert!(raf.exists() && jpg.exists());

        // notes are gone; the half-written one stays for later
        let left: Vec<String> = fs::read_dir(&inbox)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec!["1002-1.json.tmp".to_string()]);
        assert!(take_from_inbox(&inbox).is_empty());
    }

    #[test]
    fn missing_inbox_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let got = take_from_inbox(&tmp.path().join("nope"));
        assert!(got.is_empty());
        assert_eq!(got.folder, None);
    }
}
