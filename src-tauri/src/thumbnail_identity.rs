use super::{AppSettings, parse_virtual_path};
use std::fs;

pub(super) fn compute_thumbnail_cache_hash(
    path_str: &str,
    adjustments_bytes: &[u8],
    settings: &AppSettings,
) -> Option<String> {
    let (source_path, _) = parse_virtual_path(path_str);
    let metadata = fs::metadata(&source_path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"rapidraw-preview-v2");
    hasher.update(path_str.as_bytes());
    hasher.update(&metadata.len().to_le_bytes());
    hasher.update(&modified.as_nanos().to_le_bytes());
    hasher.update(adjustments_bytes);
    hasher.update(&thumbnail_render_settings(settings));
    Some(hasher.finalize().to_hex().to_string())
}

fn thumbnail_render_settings(settings: &AppSettings) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!([
        settings.small_thumbnail_resolution.unwrap_or(480),
        settings.medium_thumbnail_resolution.unwrap_or(1280),
        settings.always_decode_raw_thumbnails.unwrap_or(false),
        settings.raw_highlight_compression,
        settings.linear_raw_mode,
        settings.raw_preprocessing_color_nr,
        settings.raw_preprocessing_sharpening,
        settings.apply_preprocessing_to_non_raws,
        settings.tonemapper_override_enabled,
        settings.default_raw_tonemapper,
        settings.default_non_raw_tonemapper,
        settings.processing_backend
    ]))
    .unwrap_or_default()
}

/// Stable on cache hits, different when a renderer replaces an existing file.
pub(super) fn thumbnail_revision(path: &str) -> String {
    let stamp = fs::metadata(path).ok().and_then(|meta| {
        Some((
            meta.len(),
            meta.modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_nanos(),
        ))
    });
    format!("{:?}", stamp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn identity_tracks_source_precision_edits_copies_and_settings() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("photo.raw");
        fs::write(&source, b"source").unwrap();
        let path = source.to_str().unwrap();
        let mut settings = AppSettings::default();
        let set_time = |nanos| {
            fs::File::open(&source)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(UNIX_EPOCH + Duration::new(1_700_000_000, nanos)),
                )
                .unwrap()
        };
        set_time(100_000_000);
        let first = compute_thumbnail_cache_hash(path, b"{}", &settings).unwrap();
        assert_eq!(
            Some(first.clone()),
            compute_thumbnail_cache_hash(path, b"{}", &settings)
        );
        set_time(200_000_000);
        assert_ne!(
            Some(first.clone()),
            compute_thumbnail_cache_hash(path, b"{}", &settings)
        );
        set_time(100_000_000);
        assert_ne!(
            Some(first.clone()),
            compute_thumbnail_cache_hash(path, br#"{"crop":{}}"#, &settings)
        );
        assert_ne!(
            Some(first.clone()),
            compute_thumbnail_cache_hash(&format!("{path}?vc=copy"), b"{}", &settings)
        );
        settings.medium_thumbnail_resolution = Some(1920);
        assert_ne!(
            Some(first.clone()),
            compute_thumbnail_cache_hash(path, b"{}", &settings)
        );
        settings = AppSettings::default();
        settings.always_decode_raw_thumbnails = Some(true);
        assert_ne!(
            Some(first.clone()),
            compute_thumbnail_cache_hash(path, b"{}", &settings)
        );
        settings = AppSettings::default();
        fs::write(&source, b"larger source").unwrap();
        set_time(100_000_000);
        assert_ne!(
            Some(first),
            compute_thumbnail_cache_hash(path, b"{}", &settings)
        );
    }

    #[test]
    fn disk_revision_is_stable_until_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preview.jpg");
        fs::write(&path, b"preview").unwrap();
        let first = thumbnail_revision(path.to_str().unwrap());
        assert_eq!(first, thumbnail_revision(path.to_str().unwrap()));
        fs::write(&path, b"replacement preview").unwrap();
        assert_ne!(first, thumbnail_revision(path.to_str().unwrap()));
    }
}
