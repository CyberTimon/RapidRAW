use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static GENERATION: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Serialize)]
pub struct RatingUpdate {
    path: String,
    rating: u8,
    rating_state: &'static str,
    is_edited: bool,
    tags: Option<Vec<String>>,
    error: Option<String>,
}
#[derive(Clone, Serialize)]
struct Batch {
    scan_id: String,
    checked: usize,
    total: usize,
    failed: usize,
    done: bool,
    updates: Vec<RatingUpdate>,
}

pub fn resolve(path: &str, settings: &crate::app_settings::AppSettings) -> RatingUpdate {
    let result = (|| -> Result<_, String> {
        let (source, sidecar) = crate::file_management::parse_virtual_path(path);
        if crate::file_management::is_cloud_placeholder(&source)
            || crate::file_management::is_cloud_placeholder(&sidecar)
        {
            return Err("File must be downloaded before its rating can be read".into());
        }
        let mut metadata = if sidecar.exists() {
            serde_json::from_slice::<crate::image_processing::ImageMetadata>(
                &std::fs::read(&sidecar).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?
        } else {
            crate::image_processing::ImageMetadata::default()
        };
        if settings.enable_xmp_sync.unwrap_or(false) {
            if let Some(xmp) = crate::file_management::resolve_xmp_path(&source) {
                if crate::file_management::is_cloud_placeholder(&xmp) {
                    return Err("XMP sidecar is not downloaded".into());
                }
            }
            crate::file_management::sync_metadata_from_xmp(&source, &mut metadata);
        }
        if !metadata.rating_is_explicit && metadata.rating == 0 {
            metadata.rating = crate::rating_cache::read(&source)
                .map_err(|e| e.to_string())?
                .unwrap_or(0);
        }
        let raw = crate::formats::is_raw_file(&source);
        let tm = crate::image_processing::resolve_tonemapper_override(settings, raw);
        Ok((
            metadata.rating,
            crate::image_processing::is_image_edited(&metadata.adjustments, raw, tm),
            metadata.tags,
        ))
    })();
    match result {
        Ok((rating, is_edited, tags)) => RatingUpdate {
            path: path.into(),
            rating,
            rating_state: "ready",
            is_edited,
            tags,
            error: None,
        },
        Err(error) => RatingUpdate {
            path: path.into(),
            rating: 0,
            rating_state: "failed",
            is_edited: false,
            tags: None,
            error: Some(error),
        },
    }
}
#[tauri::command]
pub fn cancel_rating_scan() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub async fn scan_library_ratings(
    paths: Vec<String>,
    scan_id: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let settings = crate::load_settings(app_handle.clone()).unwrap_or_default();
    let hdd = app_handle
        .state::<crate::AppState>()
        .thumbnail_manager
        .rotational_disk
        .load(Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let workers = if hdd { 1 } else { 4 };
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(workers)
            .build()
            .map_err(|e| e.to_string())?;
        let total = paths.len();
        let mut checked = 0;
        let mut failed = 0;
        // Small bounded batches provide prompt progress even on a slow removable disk.
        for chunk in paths.chunks(workers * 4) {
            if GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            let updates: Vec<_> = pool.install(|| {
                chunk
                    .par_iter()
                    .filter_map(|path| {
                        if GENERATION.load(Ordering::SeqCst) != generation {
                            None
                        } else {
                            Some(resolve(path, &settings))
                        }
                    })
                    .collect()
            });
            if GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            checked += updates.len();
            failed += updates
                .iter()
                .filter(|r| r.rating_state == "failed")
                .count();
            if checked == total || checked % 128 == 0 {
                crate::rating_cache::flush();
            }
            let _ = app_handle.emit(
                "library-rating-batch",
                Batch {
                    scan_id: scan_id.clone(),
                    checked,
                    total,
                    failed,
                    done: checked == total,
                    updates,
                },
            );
        }
        if total == 0 && GENERATION.load(Ordering::SeqCst) == generation {
            let _ = app_handle.emit(
                "library-rating-batch",
                Batch {
                    scan_id,
                    checked: 0,
                    total: 0,
                    failed: 0,
                    done: true,
                    updates: vec![],
                },
            );
        }
        crate::rating_cache::flush();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires RAPIDRAW_FULL_RATING_TEST_DIR"]
    fn rating_full_camera_folder() {
        let root = std::env::var("RAPIDRAW_FULL_RATING_TEST_DIR").unwrap();
        let cache = tempfile::tempdir().unwrap();
        crate::rating_cache::initialize(cache.path().to_path_buf());
        let paths: Vec<_> = walkdir::WalkDir::new(&root)
            .into_iter()
            .map(|e| e.unwrap().into_path())
            .filter(|p| {
                p.extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("cr2") || e.eq_ignore_ascii_case("cr3"))
            })
            .collect();
        assert_eq!(paths.len(), 3208);
        let settings = crate::app_settings::AppSettings::default();
        for pass in 0..2 {
            let start = std::time::Instant::now();
            let mut rated = 0;
            let mut unrated = 0;
            for path in &paths {
                if pass == 1 {
                    assert!(crate::rating_cache::peek(path).is_some());
                }
                let result = resolve(path.to_str().unwrap(), &settings);
                assert_eq!(
                    result.rating_state,
                    "ready",
                    "{}: {:?}",
                    path.display(),
                    result.error
                );
                match result.rating {
                    0 => unrated += 1,
                    1 => rated += 1,
                    value => panic!("Unexpected rating {value}"),
                }
            }
            assert_eq!((rated, unrated), (314, 2894));
            crate::rating_cache::flush();
            println!(
                "Rating pass {pass}: {rated} rated, {unrated} unrated in {:?}",
                start.elapsed()
            );
        }
    }
}
