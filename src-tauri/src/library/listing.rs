use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::{AppState, PendingMetadata};
use crate::decode::formats::is_supported_image_file;
use crate::library::file_ops::{is_cloud_placeholder, read_file_mapped};
use crate::library::sidecars::{parse_sidecar_name, parse_virtual_path};
use crate::metadata::sidecar::{ImageFlag, ImageMetadata, is_image_edited};
use crate::metadata::xmp::{resolve_xmp_path, sync_metadata_from_xmp};
use crate::render::options::resolve_tonemapper_override;
use anyhow::Result;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::{fs, thread};
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

struct ImageFileMetadata {
    is_edited: bool,
    tags: Option<Vec<String>>,
    rating: u8,
    flag: Option<ImageFlag>,
    is_raw: bool,
    needs_ai: bool,
}

pub fn rating_and_edited(path_str: &str, settings: &AppSettings) -> (u8, bool) {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);
    let metadata = resolve_image_metadata(
        &source_path,
        &sidecar_path,
        sidecar_path.exists(),
        false,
        settings,
    );
    (metadata.rating, metadata.is_edited)
}

fn resolve_image_metadata(
    image_path: &Path,
    sidecar_path: &Path,
    sidecar_exists: bool,
    enable_xmp_sync: bool,
    settings: &AppSettings,
) -> ImageFileMetadata {
    let mut metadata = if sidecar_exists {
        crate::metadata::sidecar::load_sidecar(sidecar_path)
    } else {
        ImageMetadata::default()
    };

    if enable_xmp_sync && sync_metadata_from_xmp(image_path, sidecar_path, &mut metadata) {
        let _ = crate::metadata::sidecar::update_sidecar(sidecar_path, image_path, |current| {
            sync_metadata_from_xmp(image_path, sidecar_path, current);
        });
    }

    let is_raw = crate::decode::formats::is_raw_file(image_path);
    let tm_override = resolve_tonemapper_override(settings, is_raw);
    let is_edited = is_image_edited(&metadata.adjustments, is_raw, tm_override);
    let needs_ai = crate::ai::jobs::needs_generation(&metadata.adjustments, image_path);
    ImageFileMetadata {
        is_edited,
        tags: metadata.tags,
        rating: metadata.rating,
        flag: metadata.flag,
        is_raw,
        needs_ai,
    }
}

fn emit_image_metadata_loaded(app_handle: &AppHandle, path: &str, metadata: &ImageFileMetadata) {
    let _ = app_handle.emit(
        "image-metadata-loaded",
        serde_json::json!({
            "path": path,
            "rating": metadata.rating,
            "flag": metadata.flag,
            "is_edited": metadata.is_edited,
            "tags": metadata.tags,
            "needs_ai": metadata.needs_ai,
        }),
    );
}

pub fn enqueue_metadata(
    app_handle: &AppHandle,
    virtual_path: String,
    image_path: PathBuf,
    sidecar_path: PathBuf,
) {
    let state = app_handle.state::<AppState>();
    let manager = &state.metadata_manager;

    let mut pending = manager.pending.lock().unwrap();
    if !pending.insert(sidecar_path.clone()) {
        return;
    }
    drop(pending);

    manager.queue.lock().unwrap().push_back(PendingMetadata {
        virtual_path,
        image_path,
        sidecar_path,
    });
    manager.cvar.notify_one();
}

// Not compute-heavy — these threads mostly block waiting on iCloud to
// materialize a file, not burning CPU — so a small fixed pool is enough and
// doesn't need a user-facing setting the way thumbnail_worker_threads does.
const METADATA_WORKER_THREADS: usize = 4;

pub fn start_metadata_workers(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let manager = state.metadata_manager.clone();

    for _ in 0..METADATA_WORKER_THREADS {
        let app_clone = app_handle.clone();
        let manager_clone = manager.clone();

        std::thread::spawn(move || {
            loop {
                let item = {
                    let mut queue = manager_clone.queue.lock().unwrap();
                    while queue.is_empty() {
                        queue = manager_clone.cvar.wait(queue).unwrap();
                    }
                    queue.pop_front().unwrap()
                };

                let settings = load_settings(app_clone.clone()).unwrap_or_default();
                let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

                let metadata = resolve_image_metadata(
                    &item.image_path,
                    &item.sidecar_path,
                    true,
                    enable_xmp_sync,
                    &settings,
                );

                emit_image_metadata_loaded(&app_clone, &item.virtual_path, &metadata);

                manager_clone
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&item.sidecar_path);
            }
        });
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageFile {
    pub path: String,
    modified: u64,
    is_edited: bool,
    rating: u8,
    flag: Option<ImageFlag>,
    tags: Option<Vec<String>>,
    exif: Option<HashMap<String, String>>,
    is_virtual_copy: bool,
    is_cloud_placeholder: bool,
    is_raw: bool,
    group_id: Option<String>,
    #[serde(default)]
    needs_ai: bool,
}

impl ImageFile {
    pub fn placeholder(path: String, modified: u64) -> Self {
        let is_raw = crate::decode::formats::is_raw_file(&path);
        Self {
            path,
            modified,
            is_edited: false,
            rating: 0,
            flag: None,
            tags: None,
            exif: None,
            is_virtual_copy: false,
            is_cloud_placeholder: true,
            is_raw,
            group_id: None,
            needs_ai: false,
        }
    }
}

fn make_group_key(source_path: &Path) -> String {
    let parent = source_path.parent().unwrap_or(Path::new(""));
    let stem = source_path.file_stem().unwrap_or_default();
    format!("{}/{}", parent.to_string_lossy(), stem.to_string_lossy())
}

pub fn assign_group_ids(files: &mut [ImageFile], settings: &AppSettings) {
    let require_matching_exif = settings.require_matching_exif.unwrap_or(false);
    let group_edited_files = settings.group_edited_files.unwrap_or(true);

    #[derive(Clone)]
    struct Candidate {
        index: usize,
        source_path: PathBuf,
        key: String,
    }

    let candidates: Vec<Candidate> = files
        .iter()
        .enumerate()
        .filter(|(_, file)| !file.is_virtual_copy && (group_edited_files || !file.is_edited))
        .map(|(index, file)| {
            let (source_path, _) = parse_virtual_path(&file.path);
            let key = make_group_key(&source_path);
            Candidate {
                index,
                source_path,
                key,
            }
        })
        .collect();

    let mut stem_groups: HashMap<String, Vec<Candidate>> = HashMap::new();
    for candidate in candidates {
        stem_groups
            .entry(candidate.key.clone())
            .or_default()
            .push(candidate);
    }

    if require_matching_exif {
        let groupable_paths: Vec<PathBuf> = stem_groups
            .values()
            .filter(|candidates| candidates.len() >= 2)
            .flat_map(|candidates| candidates.iter().map(|c| c.source_path.clone()))
            .collect();
        let exif_dates: HashMap<PathBuf, Option<chrono::DateTime<chrono::Utc>>> = groupable_paths
            .par_iter()
            .map(|p| {
                (
                    p.clone(),
                    crate::metadata::exif_processing::try_get_exif_creation_date(p),
                )
            })
            .collect();

        stem_groups.retain(|_, candidates| {
            if candidates.len() < 2 {
                return false;
            }
            let first = exif_dates
                .get(&candidates[0].source_path)
                .copied()
                .flatten();
            if first.is_none() {
                return false;
            }
            candidates
                .iter()
                .skip(1)
                .all(|c| exif_dates.get(&c.source_path).copied().flatten() == first)
        });
    } else {
        stem_groups.retain(|_, candidates| candidates.len() >= 2);
    }

    for (key, candidates) in stem_groups {
        for candidate in candidates {
            files[candidate.index].group_id = Some(key.clone());
        }
    }
}

fn exif_read_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: std::sync::OnceLock<Option<rayon::ThreadPool>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(rayon::current_num_threads())
            .build()
            .ok()
    })
    .as_ref()
}

#[tauri::command]
pub async fn read_exif_for_paths(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, HashMap<String, String>>, String> {
    let is_hdd = state
        .thumbnail_manager
        .rotational_disk
        .load(Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        let process_path = |virtual_path: &String| {
            let (source_path, _) = parse_virtual_path(virtual_path);
            let source_path_str = source_path.to_string_lossy().to_string();

            let map = if let Some(sidecar_exif) =
                crate::metadata::exif_processing::read_rrexif_sidecar(&source_path)
            {
                sidecar_exif
            } else if is_cloud_placeholder(&source_path) {
                HashMap::new()
            } else if let Ok(mmap) = read_file_mapped(&source_path) {
                crate::metadata::sidecar::read_exif_data(&source_path_str, &mmap)
            } else if let Ok(bytes) = fs::read(&source_path) {
                crate::metadata::sidecar::read_exif_data(&source_path_str, &bytes)
            } else {
                HashMap::new()
            };

            if map.is_empty() {
                None
            } else {
                Some((virtual_path.clone(), map))
            }
        };

        let exif_data: HashMap<String, HashMap<String, String>> = if is_hdd {
            paths.iter().filter_map(process_path).collect()
        } else if let Some(pool) = exif_read_pool() {
            pool.install(|| paths.par_iter().filter_map(process_path).collect())
        } else {
            paths.par_iter().filter_map(process_path).collect()
        };

        Ok(exif_data)
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
}

#[tauri::command]
pub async fn update_exif_fields(
    paths: Vec<String>,
    updates: HashMap<String, String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.par_iter().for_each(|path| {
            let original_path = Path::new(&path);
            let primary_path = crate::metadata::sidecar::get_primary_sidecar_path(original_path);

            let _ = crate::metadata::sidecar::update_sidecar(
                &primary_path,
                original_path,
                |metadata| {
                    crate::metadata::sidecar::fill_missing_exif(metadata, original_path);
                    let exif_data = metadata.exif.get_or_insert_default();

                    for (k, v) in &updates {
                        let trimmed = v.trim();
                        if trimmed.is_empty() {
                            exif_data.remove(k);
                        } else {
                            exif_data.insert(k.clone(), trimmed.to_string());
                        }
                    }
                },
            );
            crate::adjustments::lens_correction::forget_lens_profiles(path);
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn match_disk_kind(disks: &Disks, canonical: &Path) -> Option<bool> {
    let mut best_match: Option<(&Path, bool)> = None;

    for disk in disks.list() {
        let mount_point = disk.mount_point();
        if canonical.starts_with(mount_point) {
            let is_longer_match = best_match
                .map(|(current, _)| mount_point.as_os_str().len() > current.as_os_str().len())
                .unwrap_or(true);
            if is_longer_match {
                best_match = Some((mount_point, disk.kind() == sysinfo::DiskKind::HDD));
            }
        }
    }

    best_match.map(|(_, is_hdd)| is_hdd)
}

fn update_rotational_disk_flag(path: &str, app_handle: &AppHandle) {
    let state = app_handle.state::<AppState>();
    let Ok(canonical) = Path::new(path).canonicalize() else {
        return;
    };

    let cached_match = {
        let cache = state.disks_cache.lock().unwrap();
        cache
            .as_ref()
            .and_then(|disks| match_disk_kind(disks, &canonical))
    };

    match cached_match {
        Some(is_hdd) => {
            state
                .thumbnail_manager
                .rotational_disk
                .store(is_hdd, Ordering::Relaxed);
        }
        None => {
            if !state.disks_cache_refreshing.swap(true, Ordering::Relaxed) {
                let refresh_app_handle = app_handle.clone();
                thread::spawn(move || {
                    let disks = Disks::new_with_refreshed_list();
                    let state = refresh_app_handle.state::<AppState>();
                    *state.disks_cache.lock().unwrap() = Some(disks);
                    state.disks_cache_refreshing.store(false, Ordering::Relaxed);
                });
            }
        }
    }
}

pub fn modified_secs(metadata: std::io::Result<fs::Metadata>, path: &Path) -> u64 {
    let metadata = match metadata {
        Ok(m) if m.file_type().is_symlink() => fs::metadata(path),
        other => other,
    };
    metadata
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

struct ListedImage {
    path: PathBuf,
    file_name: String,
    modified: u64,
}

#[allow(clippy::too_many_arguments)]
pub fn build_image_file(
    app_handle: &AppHandle,
    settings: &AppSettings,
    source_path: &Path,
    virtual_path: String,
    sidecar_path: &Path,
    sidecar_exists: bool,
    modified: u64,
    is_cloud_placeholder: bool,
) -> ImageFile {
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let is_virtual_copy = virtual_path.contains("?vc=");

    let xmp_is_placeholder = enable_xmp_sync
        && resolve_xmp_path(source_path).is_some_and(|p| self::is_cloud_placeholder(&p));

    let metadata =
        if (sidecar_exists && self::is_cloud_placeholder(sidecar_path)) || xmp_is_placeholder {
            enqueue_metadata(
                app_handle,
                virtual_path.clone(),
                source_path.to_path_buf(),
                sidecar_path.to_path_buf(),
            );
            ImageFileMetadata {
                is_edited: false,
                tags: None,
                rating: 0,
                flag: None,
                is_raw: crate::decode::formats::is_raw_file(source_path),
                needs_ai: false,
            }
        } else {
            resolve_image_metadata(
                source_path,
                sidecar_path,
                sidecar_exists,
                enable_xmp_sync,
                settings,
            )
        };

    ImageFile {
        path: virtual_path,
        modified,
        is_edited: metadata.is_edited,
        tags: metadata.tags,
        exif: None,
        is_virtual_copy,
        is_raw: metadata.is_raw,
        group_id: None,
        rating: metadata.rating,
        flag: metadata.flag,
        is_cloud_placeholder,
        needs_ai: metadata.needs_ai,
    }
}

fn collect_image_files<E: Send>(
    entries: Vec<E>,
    describe: impl Fn(E) -> ListedImage + Sync + Send,
    mut sidecars_by_path: HashMap<PathBuf, Vec<Option<String>>>,
    app_handle: &AppHandle,
) -> Vec<ImageFile> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let listed: Vec<ListedImage> = entries.into_par_iter().map(describe).collect();
    let tasks: Vec<_> = listed
        .into_iter()
        .map(|image| {
            let sidecars = sidecars_by_path.remove(&image.path);
            (image, sidecars)
        })
        .collect();

    let mut result_list: Vec<ImageFile> = tasks
        .into_par_iter()
        .flat_map_iter(|(image, sidecars)| {
            let path_str = image.path.to_string_lossy().into_owned();
            let is_cloud_placeholder = is_cloud_placeholder(&image.path);
            let sidecar_exists = sidecars.is_some();

            sidecars
                .unwrap_or_else(|| vec![None])
                .into_iter()
                .map(|copy_id| {
                    let (virtual_path, sidecar_filename) = match copy_id {
                        Some(id) => (
                            format!("{}?vc={}", path_str, id),
                            format!("{}.{}.rrdata", image.file_name, id),
                        ),
                        None => (path_str.clone(), format!("{}.rrdata", image.file_name)),
                    };
                    let sidecar_path = image.path.with_file_name(sidecar_filename);

                    build_image_file(
                        app_handle,
                        &settings,
                        &image.path,
                        virtual_path,
                        &sidecar_path,
                        sidecar_exists,
                        image.modified,
                        is_cloud_placeholder,
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect();

    assign_group_ids(&mut result_list, &settings);
    result_list
}

#[tauri::command]
pub async fn list_images_in_dir(
    path: String,
    app_handle: AppHandle,
) -> Result<Vec<ImageFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_rotational_disk_flag(&path, &app_handle);

        let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
        let mut images = Vec::new();
        let mut sidecars_by_path: HashMap<PathBuf, Vec<Option<String>>> = HashMap::new();

        for entry in entries.filter_map(Result::ok) {
            let file_name = entry
                .file_name()
                .into_string()
                .unwrap_or_else(|os| os.to_string_lossy().into_owned());

            if let Some((source_filename, copy_id)) = parse_sidecar_name(&file_name) {
                sidecars_by_path
                    .entry(entry.path().with_file_name(source_filename))
                    .or_default()
                    .push(copy_id.map(str::to_string));
            } else if is_supported_image_file(&file_name) {
                images.push((entry, file_name));
            }
        }

        Ok(collect_image_files(
            images,
            |(entry, file_name)| {
                let path = entry.path();
                ListedImage {
                    modified: modified_secs(entry.metadata(), &path),
                    path,
                    file_name,
                }
            },
            sidecars_by_path,
            &app_handle,
        ))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn list_images_recursive(
    path: String,
    app_handle: AppHandle,
) -> Result<Vec<ImageFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_rotational_disk_flag(&path, &app_handle);

        let mut images = Vec::new();
        let mut sidecars_by_path: HashMap<PathBuf, Vec<Option<String>>> = HashMap::new();

        for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
            let file_type = entry.file_type();
            if !(file_type.is_file() || (file_type.is_symlink() && entry.path().is_file())) {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy();
            if let Some((source_filename, copy_id)) = parse_sidecar_name(&file_name) {
                sidecars_by_path
                    .entry(entry.path().with_file_name(source_filename))
                    .or_default()
                    .push(copy_id.map(str::to_string));
            } else if is_supported_image_file(file_name.as_ref()) {
                images.push(entry);
            }
        }

        Ok(collect_image_files(
            images,
            |entry| ListedImage {
                modified: modified_secs(
                    entry.metadata().map_err(std::io::Error::from),
                    entry.path(),
                ),
                file_name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.into_path(),
            },
            sidecars_by_path,
            &app_handle,
        ))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub fn get_supported_file_types() -> Result<serde_json::Value, String> {
    let raw_extensions: Vec<&str> = crate::decode::formats::RAW_EXTENSIONS
        .iter()
        .map(|(ext, _)| *ext)
        .collect();
    let non_raw_extensions: Vec<&str> = crate::decode::formats::NON_RAW_EXTENSIONS.to_vec();

    Ok(serde_json::json!({
        "raw": raw_extensions,
        "nonRaw": non_raw_extensions
    }))
}
