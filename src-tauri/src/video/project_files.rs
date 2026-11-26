use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::decode::formats::VIDEO_PROJECT_EXTENSION;
use crate::library::file_ops::write_file_atomic;
use crate::video::revisions::Revision;
use crate::video::{VideoState, blocking};

const RECENT_FILE: &str = "recent.json";
const MAX_RECENT: usize = 20;
const EXIT_WAIT: Duration = Duration::from_secs(10);
const SAVE_WAIT: Duration = Duration::from_secs(30);

static RECENT_LOCK: Mutex<()> = Mutex::new(());
static WRITER: LazyLock<ProjectWriter> = LazyLock::new(ProjectWriter::default);

#[derive(Default)]
struct Writes {
    queued: Option<Arc<Revision>>,
    submitted: u64,
    written: u64,
    writing: bool,
    renaming: bool,
    error: Option<String>,
}

type Paths = HashMap<PathBuf, Writes>;

#[derive(Default)]
struct ProjectWriter {
    paths: Mutex<Paths>,
    changed: Condvar,
}

struct Renaming<'a> {
    writer: &'static ProjectWriter,
    app_handle: &'a AppHandle,
    path: &'a Path,
    target: Option<PathBuf>,
}

impl Drop for Renaming<'_> {
    fn drop(&mut self) {
        self.writer
            .end_rename(self.app_handle, self.path, self.target.take());
    }
}

impl ProjectWriter {
    fn lock(&self) -> MutexGuard<'_, Paths> {
        self.paths.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn submit(&'static self, app_handle: &AppHandle, path: PathBuf, project: Arc<Revision>) {
        let mut paths = self.lock();
        let writes = paths.entry(path.clone()).or_default();
        writes.submitted += 1;
        writes.queued = Some(project);
        self.start(app_handle, path, writes);
    }

    fn start(&'static self, app_handle: &AppHandle, path: PathBuf, writes: &mut Writes) {
        if writes.writing || writes.renaming || writes.queued.is_none() {
            return;
        }
        writes.writing = true;
        let app_handle = app_handle.clone();
        std::thread::spawn(move || self.drain(&app_handle, &path));
    }

    fn drain(&self, app_handle: &AppHandle, path: &Path) {
        loop {
            let (project, generation) = {
                let mut paths = self.lock();
                let writes = paths.entry(path.to_path_buf()).or_default();
                let Some(project) = writes.queued.take() else {
                    writes.writing = false;
                    self.changed.notify_all();
                    return;
                };
                (project, writes.submitted)
            };
            let crashed = format!("Could not save project '{}'", path.display());
            let result = crate::video::crash_safe(&crashed, || {
                write_project(app_handle, path, &project.file_json()?)
            });
            let mut paths = self.lock();
            let writes = paths.entry(path.to_path_buf()).or_default();
            writes.written = generation;
            writes.error = result.err();
            self.changed.notify_all();
        }
    }

    fn wait_until(
        &self,
        path: &Path,
        busy: impl Fn(&Writes) -> bool,
    ) -> Result<MutexGuard<'_, Paths>, String> {
        let (paths, waited) = self
            .changed
            .wait_timeout_while(self.lock(), SAVE_WAIT, |paths| {
                paths.get(path).is_some_and(&busy)
            })
            .unwrap_or_else(PoisonError::into_inner);
        if waited.timed_out() {
            return Err(format!(
                "Saving project '{}' is taking too long",
                path.display()
            ));
        }
        Ok(paths)
    }

    fn wait(&self, path: &Path) -> Result<(), String> {
        let Some(generation) = self.lock().get(path).map(|writes| writes.submitted) else {
            return Ok(());
        };
        self.wait_until(path, |writes| writes.written < generation)?
            .get(path)
            .and_then(|writes| writes.error.clone())
            .map_or(Ok(()), Err)
    }

    fn settle(&self, path: &Path) -> Result<(), String> {
        self.wait_until(path, |writes| writes.writing).map(drop)
    }

    fn begin_rename<'a>(
        &'static self,
        app_handle: &'a AppHandle,
        path: &'a Path,
    ) -> Result<Renaming<'a>, String> {
        self.wait_until(path, |writes| writes.writing || writes.renaming)?
            .entry(path.to_path_buf())
            .or_default()
            .renaming = true;
        Ok(Renaming {
            writer: self,
            app_handle,
            path,
            target: None,
        })
    }

    fn end_rename(&'static self, app_handle: &AppHandle, path: &Path, target: Option<PathBuf>) {
        let mut paths = self.lock();
        let Some(writes) = paths.get_mut(path) else {
            return;
        };
        writes.renaming = false;
        let moved = target.and_then(|target| Some((target, writes.queued.take()?)));
        if moved.is_some() {
            writes.written = writes.submitted;
            writes.error = None;
        }
        self.start(app_handle, path.to_path_buf(), writes);
        self.changed.notify_all();
        drop(paths);
        if let Some((target, project)) = moved {
            self.submit(app_handle, target, project);
        }
    }

    fn settle_all(&self, timeout: Duration) -> bool {
        !self
            .changed
            .wait_timeout_while(self.lock(), timeout, |paths| {
                paths.values().any(|writes| writes.writing)
            })
            .unwrap_or_else(PoisonError::into_inner)
            .1
            .timed_out()
    }
}

fn write_project(app_handle: &AppHandle, path: &Path, json: &[u8]) -> Result<(), String> {
    write_file_atomic(path, json)
        .map_err(|e| format!("Could not save project '{}': {}", path.display(), e))?;
    update_recent(app_handle, &path.to_string_lossy())
}

pub fn finish_writes() {
    if !WRITER.settle_all(EXIT_WAIT) {
        log::warn!("Video project saves did not finish before exit");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    path: String,
    name: String,
    modified: u64,
    cover: Option<String>,
    missing: bool,
}

fn projects_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("video_projects"))
}

fn read_project(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Could not open project '{}': {}", path.display(), e))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| format!("Could not read project '{}': {}", path.display(), e))
}

pub fn cover_media(project: &Value) -> Option<String> {
    let media = project["media"].as_array()?;
    let visual = |entry: &&Value| entry["kind"] != "audio" && entry["kind"] != "sequence";
    project["videoTracks"][0]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|item| item["media"].as_str())
        .and_then(|id| media.iter().find(|entry| entry["id"] == id))
        .filter(visual)
        .or_else(|| media.iter().find(visual))
        .and_then(|entry| entry["path"].as_str())
        .map(str::to_string)
}

pub fn project_cover(path: &Path) -> Option<String> {
    read_project(path).ok().as_ref().and_then(cover_media)
}

fn media_paths(project: &Value) -> impl Iterator<Item = &str> {
    project["media"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|media| media["path"].as_str())
}

fn read_recent(dir: &Path) -> Vec<String> {
    std::fs::read(dir.join(RECENT_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn edit_recent(app_handle: &AppHandle, edit: impl FnOnce(&mut Vec<String>)) -> Result<(), String> {
    let _recent = RECENT_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let dir = projects_dir(app_handle)?;
    let before = read_recent(&dir);
    let mut recent = before.clone();
    edit(&mut recent);
    recent.truncate(MAX_RECENT);
    if recent == before {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(&recent).map_err(|e| e.to_string())?;
    write_file_atomic(&dir.join(RECENT_FILE), &json).map_err(|e| e.to_string())
}

pub fn recent_media(app_handle: &AppHandle) -> Vec<PathBuf> {
    let Ok(dir) = projects_dir(app_handle) else {
        return Vec::new();
    };
    read_recent(&dir)
        .iter()
        .filter_map(|path| read_project(Path::new(path)).ok())
        .flat_map(|project| media_paths(&project).map(PathBuf::from).collect::<Vec<_>>())
        .collect()
}

fn forget_recent(recent: &mut Vec<String>, path: &str) {
    recent.retain(|entry| Path::new(entry) != Path::new(path));
}

fn update_recent(app_handle: &AppHandle, path: &str) -> Result<(), String> {
    edit_recent(app_handle, |recent| {
        forget_recent(recent, path);
        recent.insert(0, path.to_string());
    })
}

fn follow_recent(
    app_handle: &AppHandle,
    moved: impl Fn(&Path) -> Option<PathBuf>,
) -> Result<(), String> {
    edit_recent(app_handle, |recent| {
        let targets: Vec<Option<PathBuf>> =
            recent.iter().map(|entry| moved(Path::new(entry))).collect();
        let taken = |entry: &str| {
            targets
                .iter()
                .flatten()
                .any(|target| target == Path::new(entry))
        };
        *recent = recent
            .iter()
            .zip(&targets)
            .filter_map(|(entry, target)| match target {
                Some(target) => Some(target.to_string_lossy().into_owned()),
                None if taken(entry) => None,
                None => Some(entry.clone()),
            })
            .collect();
    })
}

pub fn follow_moved_projects(
    app_handle: &AppHandle,
    renames: Option<&HashMap<String, String>>,
    folder_rename: Option<(&str, &str)>,
) {
    let moved = |entry: &Path| {
        renames
            .into_iter()
            .flatten()
            .find(|(from, _)| Path::new(from) == entry)
            .map(|(_, to)| PathBuf::from(to))
            .or_else(|| {
                folder_rename.and_then(|(from, to)| {
                    entry
                        .strip_prefix(from)
                        .ok()
                        .map(|rest| Path::new(to).join(rest))
                })
            })
    };
    if let Err(err) = follow_recent(app_handle, moved) {
        log::warn!("Could not update recent projects: {}", err);
    }
}

fn describe(path: String) -> RecentProject {
    let file = Path::new(&path);
    let metadata = std::fs::metadata(file).ok();
    let project = metadata.as_ref().and_then(|_| read_project(file).ok());
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    RecentProject {
        name: stem,
        modified: metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis() as u64),
        cover: project.as_ref().and_then(cover_media),
        missing: metadata.is_none(),
        path,
    }
}

fn sanitized_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub fn video_save_project(
    path: String,
    revision: u64,
    app_handle: AppHandle,
    video: State<'_, VideoState>,
) -> Result<(), String> {
    let revision = video.revisions.get(revision)?;
    crate::video::proxy::pin_project(
        &app_handle,
        revision
            .project
            .media
            .iter()
            .map(|media| media.path.as_str()),
    );
    WRITER.submit(&app_handle, PathBuf::from(path), revision);
    Ok(())
}

#[tauri::command]
pub async fn video_project_saved(path: String) -> Result<(), String> {
    blocking(move || WRITER.wait(Path::new(&path))).await?
}

#[tauri::command]
pub async fn video_load_project(path: String, app_handle: AppHandle) -> Result<Value, String> {
    blocking(move || {
        crate::video::libav::require()?;
        WRITER.settle(Path::new(&path))?;
        let project = read_project(Path::new(&path))?;
        update_recent(&app_handle, &path)?;
        crate::video::proxy::pin_project(&app_handle, media_paths(&project));
        Ok(project)
    })
    .await?
}

#[tauri::command]
pub async fn video_recent_projects(app_handle: AppHandle) -> Result<Vec<RecentProject>, String> {
    blocking(move || {
        let dir = projects_dir(&app_handle)?;
        Ok(read_recent(&dir).into_iter().map(describe).collect())
    })
    .await?
}

#[tauri::command]
pub async fn video_remove_recent_project(
    path: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    blocking(move || edit_recent(&app_handle, |recent| forget_recent(recent, &path))).await?
}

fn is_same_file(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(a), Ok(b)) if a == b
        )
}

fn free_project_path(dir: &Path, name: &str, own: Option<&Path>) -> Result<PathBuf, String> {
    let stem = sanitized_name(name);
    (1u32..)
        .map(|n| match n {
            1 => dir.join(format!("{}.{}", stem, VIDEO_PROJECT_EXTENSION)),
            n => dir.join(format!("{} {}.{}", stem, n, VIDEO_PROJECT_EXTENSION)),
        })
        .find(|path| !path.exists() || own.is_some_and(|own| is_same_file(path, own)))
        .ok_or_else(|| "No free project file name".to_string())
}

#[tauri::command]
pub fn video_new_project_path(
    folder: String,
    name: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    crate::video::libav::require()?;
    let dir = Path::new(&folder);
    if !dir.is_dir() {
        return Err(format!("The folder '{}' does not exist", folder));
    }
    if crate::integrations::immich::is_in_cache(&app_handle, dir) {
        return Err("Projects can't be saved in the Immich cache".to_string());
    }
    Ok(free_project_path(dir, &name, None)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn video_rename_project(
    path: String,
    name: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    blocking(move || {
        let current = Path::new(&path);
        let mut renaming = WRITER.begin_rename(&app_handle, current)?;
        let dir = current.parent().ok_or("Invalid project path")?;
        let target = free_project_path(dir, &name, Some(current))?;
        if target == current {
            return Ok(path.clone());
        }
        std::fs::rename(current, &target)
            .map_err(|e| format!("Could not rename project '{}': {}", path, e))?;
        renaming.target = Some(target.clone());
        if let Err(err) = follow_recent(&app_handle, |entry| {
            (entry == current).then(|| target.clone())
        }) {
            log::warn!("Could not update recent projects: {}", err);
        }
        Ok(target.to_string_lossy().into_owned())
    })
    .await?
}
