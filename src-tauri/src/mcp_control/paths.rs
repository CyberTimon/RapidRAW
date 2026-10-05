use std::path::{Component, Path, PathBuf};

use crate::app_settings::AppSettings;

use super::types::ApiErrorBody;

/// Normalize and validate a user-supplied path against configured library roots.
pub fn validate_library_path(path: &str, settings: &AppSettings) -> Result<PathBuf, ApiErrorBody> {
    if path.is_empty() {
        return Err(ApiErrorBody::new("invalid_path", "Path must not be empty"));
    }
    if path.contains('\0') {
        return Err(ApiErrorBody::new(
            "invalid_path",
            "Path contains null bytes",
        ));
    }

    let raw = Path::new(path);
    if matches!(
        raw.components().next(),
        Some(Component::Prefix(_) | Component::RootDir)
    ) {
        // absolute ok
    } else {
        return Err(ApiErrorBody::new("invalid_path", "Path must be absolute"));
    }

    let canonical = std::fs::canonicalize(raw)
        .map_err(|e| ApiErrorBody::new("path_not_found", format!("Cannot resolve path: {e}")))?;

    if !is_under_allowed_roots(&canonical, settings) {
        return Err(ApiErrorBody::new(
            "path_forbidden",
            "Path is outside configured library folders. Add the folder in RapidRAW library settings.",
        ));
    }

    Ok(canonical)
}

pub fn validate_output_path(path: &str, settings: &AppSettings) -> Result<PathBuf, ApiErrorBody> {
    let canonical = validate_library_path(path, settings)?;
    if let Some(parent) = canonical.parent() {
        if !parent.exists() {
            return Err(ApiErrorBody::new(
                "path_not_found",
                "Output directory does not exist",
            ));
        }
    }
    Ok(canonical)
}

fn is_under_allowed_roots(canonical: &Path, settings: &AppSettings) -> bool {
    let mut roots: Vec<PathBuf> = settings
        .root_folders
        .iter()
        .filter_map(|p| canonicalize_root(p))
        .collect();
    if let Some(last) = &settings.last_root_path {
        if let Some(c) = canonicalize_root(last) {
            roots.push(c);
        }
    }

    // No HOME fallback: without configured library roots, refuse all paths.
    if roots.is_empty() {
        return false;
    }

    roots.iter().any(|root| canonical.starts_with(root))
}

fn canonicalize_root(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    std::fs::canonicalize(p).ok().or_else(|| {
        if p.is_absolute() {
            Some(p.to_path_buf())
        } else {
            None
        }
    })
}

const PRESET_EXTENSIONS: &[&str] = &["rrpreset", "xmp", "lrtemplate", "json"];

/// Allow reading preset files from absolute paths under $HOME or system temp.
pub fn validate_preset_file_path(path: &str) -> Result<PathBuf, ApiErrorBody> {
    if path.is_empty() {
        return Err(ApiErrorBody::new("invalid_path", "Path must not be empty"));
    }
    if path.contains('\0') {
        return Err(ApiErrorBody::new(
            "invalid_path",
            "Path contains null bytes",
        ));
    }
    let raw = Path::new(path);
    if !matches!(
        raw.components().next(),
        Some(Component::Prefix(_) | Component::RootDir)
    ) {
        return Err(ApiErrorBody::new("invalid_path", "Path must be absolute"));
    }

    let canonical = std::fs::canonicalize(raw)
        .map_err(|e| ApiErrorBody::new("path_not_found", format!("Cannot resolve path: {e}")))?;

    if !canonical.is_file() {
        return Err(ApiErrorBody::new(
            "path_not_found",
            "Preset path is not a file",
        ));
    }

    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !PRESET_EXTENSIONS.iter().any(|ok| *ok == ext) {
        return Err(ApiErrorBody::new(
            "invalid_preset",
            format!(
                "Unsupported preset extension '.{ext}'. Allowed: {}",
                PRESET_EXTENSIONS.join(", ")
            ),
        ));
    }

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| std::fs::canonicalize(&h).ok().or(Some(h)));
    let under_home = home
        .as_ref()
        .map(|h| canonical.starts_with(h))
        .unwrap_or(false);
    let tmp = std::env::temp_dir();
    let tmp = std::fs::canonicalize(&tmp).unwrap_or(tmp);
    let under_tmp = canonical.starts_with(&tmp);
    if !under_home && !under_tmp {
        return Err(ApiErrorBody::new(
            "path_forbidden",
            "Preset file must be under $HOME or the system temp directory",
        ));
    }

    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn settings_with_root(root: &Path) -> AppSettings {
        let mut s = AppSettings::default();
        s.root_folders = vec![root.to_string_lossy().into_owned()];
        s.last_root_path = Some(root.to_string_lossy().into_owned());
        s
    }

    #[test]
    fn rejects_when_no_library_roots() {
        let settings = AppSettings::default();
        let err = validate_library_path("/tmp/photo.dng", &settings).unwrap_err();
        assert!(
            err.code == "path_forbidden" || err.code == "path_not_found",
            "unexpected code: {}",
            err.code
        );
    }

    #[test]
    fn rejects_empty_and_relative_paths() {
        let settings = AppSettings::default();
        assert_eq!(
            validate_library_path("", &settings).unwrap_err().code,
            "invalid_path"
        );
        assert_eq!(
            validate_library_path("relative/photo.dng", &settings)
                .unwrap_err()
                .code,
            "invalid_path"
        );
    }

    #[test]
    fn rejects_null_byte_path() {
        let settings = AppSettings::default();
        let err = validate_library_path("/tmp/foo\0bar.dng", &settings).unwrap_err();
        assert_eq!(err.code, "invalid_path");
    }

    #[test]
    fn allows_path_under_configured_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("photo.dng");
        fs::write(&file, b"raw").unwrap();
        let settings = settings_with_root(dir.path());
        let got = validate_library_path(file.to_str().unwrap(), &settings).unwrap();
        assert_eq!(got, fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn rejects_path_outside_configured_root() {
        let allowed = tempfile::tempdir().expect("allowed");
        let other = tempfile::tempdir().expect("other");
        let file = other.path().join("photo.dng");
        fs::write(&file, b"raw").unwrap();
        let settings = settings_with_root(allowed.path());
        let err = validate_library_path(file.to_str().unwrap(), &settings).unwrap_err();
        assert_eq!(err.code, "path_forbidden");
    }

    #[test]
    fn validate_preset_file_accepts_json_under_temp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("demo.json");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "{{}}").unwrap();
        let got = validate_preset_file_path(file.to_str().unwrap()).unwrap();
        assert_eq!(got, fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn validate_preset_file_rejects_bad_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("demo.exe");
        fs::write(&file, b"x").unwrap();
        let err = validate_preset_file_path(file.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "invalid_preset");
    }
}
