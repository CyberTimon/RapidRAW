use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::library::sidecars::parse_virtual_path;
use crate::video::ffmpeg::{self, MediaInfo};
use crate::video::proxy::{cache_file, cache_root, fingerprint};

const KEEP_FINISHED: usize = 20;
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub progress: f32,
    pub state: JobState,
    pub error: Option<String>,
}

type Task = Box<dyn FnOnce(&JobContext) -> Result<(), String> + Send>;

struct Job {
    status: JobStatus,
    cancelled: Arc<AtomicBool>,
    task: Option<Task>,
}

#[derive(Default)]
struct Jobs {
    list: Vec<Job>,
    next_id: u64,
    last_emit: Option<Instant>,
}

impl Jobs {
    fn get_mut(&mut self, id: &str) -> Option<&mut Job> {
        self.list.iter_mut().find(|job| job.status.id == id)
    }

    fn statuses(&self) -> Vec<JobStatus> {
        self.list.iter().map(|job| job.status.clone()).collect()
    }

    fn snapshot(&mut self, force: bool) -> Option<Vec<JobStatus>> {
        let due = force
            || self
                .last_emit
                .is_none_or(|last| last.elapsed() >= EMIT_INTERVAL);
        due.then(|| {
            self.last_emit = Some(Instant::now());
            self.statuses()
        })
    }

    fn prune(&mut self) {
        let finished = self
            .list
            .iter()
            .filter(|job| !job.status.state.active())
            .count();
        let mut excess = finished.saturating_sub(KEEP_FINISHED);
        self.list.retain(|job| {
            let remove = excess > 0 && !job.status.state.active();
            excess -= remove as usize;
            !remove
        });
    }
}

#[derive(Default)]
struct Shared {
    jobs: Mutex<Jobs>,
    finished: Condvar,
    app: OnceLock<AppHandle>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Jobs> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, snapshot: Option<Vec<JobStatus>>) {
        if let (Some(statuses), Some(app)) = (snapshot, self.app.get()) {
            let _ = app.emit("video-jobs", statuses);
        }
    }
}

pub struct JobContext {
    id: String,
    cancelled: Arc<AtomicBool>,
    shared: Arc<Shared>,
}

impl JobContext {
    pub fn progress(&self, value: f32) {
        let mut jobs = self.shared.lock();
        if let Some(job) = jobs.get_mut(&self.id) {
            job.status.progress = value.clamp(0.0, 1.0);
        }
        let snapshot = jobs.snapshot(false);
        drop(jobs);
        self.shared.emit(snapshot);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

#[derive(Default)]
pub struct JobManager {
    shared: Arc<Shared>,
}

impl JobManager {
    pub fn submit(
        &self,
        app: &AppHandle,
        kind: &str,
        key: &str,
        label: &str,
        run: impl FnOnce(&JobContext) -> Result<(), String> + Send + 'static,
    ) -> String {
        self.submit_grouped(app, kind, key, label, None, run)
    }

    pub fn submit_grouped(
        &self,
        app: &AppHandle,
        kind: &str,
        key: &str,
        label: &str,
        group: Option<String>,
        run: impl FnOnce(&JobContext) -> Result<(), String> + Send + 'static,
    ) -> String {
        let _ = self.shared.app.set(app.clone());
        let mut jobs = self.shared.lock();
        if let Some(job) = jobs.list.iter().find(|job| {
            job.status.state.active()
                && !job.cancelled.load(Ordering::Relaxed)
                && job.status.kind == kind
                && job.status.key == key
        }) {
            return job.status.id.clone();
        }
        jobs.next_id += 1;
        let id = format!("{}-{}", kind, jobs.next_id);
        jobs.list.push(Job {
            status: JobStatus {
                id: id.clone(),
                kind: kind.to_string(),
                key: key.to_string(),
                label: label.to_string(),
                group,
                progress: 0.0,
                state: JobState::Queued,
                error: None,
            },
            cancelled: Arc::default(),
            task: Some(Box::new(run)),
        });
        let snapshot = jobs.snapshot(true);
        drop(jobs);
        self.shared.emit(snapshot);
        start_next(&self.shared);
        id
    }

    pub fn cancel(&self, id: &str) {
        let mut jobs = self.shared.lock();
        let Some(job) = jobs.get_mut(id).filter(|job| job.status.state.active()) else {
            return;
        };
        job.cancelled.store(true, Ordering::Relaxed);
        if job.status.state == JobState::Queued {
            job.status.state = JobState::Cancelled;
            job.task = None;
        }
        jobs.prune();
        let snapshot = jobs.snapshot(true);
        drop(jobs);
        self.shared.emit(snapshot);
    }

    pub fn cancel_and_wait(&self, kinds: &[&str], timeout: Duration) -> bool {
        let active: Vec<String> = self
            .list()
            .into_iter()
            .filter(|status| status.state.active() && kinds.contains(&status.kind.as_str()))
            .map(|status| status.id)
            .collect();
        for id in active {
            self.cancel(&id);
        }
        let jobs = self.shared.lock();
        !self
            .shared
            .finished
            .wait_timeout_while(jobs, timeout, |jobs| {
                jobs.list.iter().any(|job| {
                    job.status.state == JobState::Running
                        && kinds.contains(&job.status.kind.as_str())
                })
            })
            .unwrap_or_else(|e| e.into_inner())
            .1
            .timed_out()
    }

    pub fn list(&self) -> Vec<JobStatus> {
        self.shared.lock().statuses()
    }
}

pub enum Cached {
    Missing,
    Ready,
    Job(JobState, f32),
}

type Prepared = Option<(Arc<MediaInfo>, String)>;
type CacheTask = fn(&Path, &MediaInfo, &Path, &JobContext) -> Result<(), String>;

pub fn prepare_video(source: &Path) -> Result<Prepared, String> {
    let info = ffmpeg::probe(source)?;
    if info.is_still || !info.has_video {
        return Ok(None);
    }
    fingerprint(source).map(|key| Some((info, key)))
}

pub struct CachedJob {
    pub kind: &'static str,
    pub dir: &'static str,
    pub extension: &'static str,
}

impl CachedJob {
    pub fn file(&self, app: &AppHandle, key: &str) -> Result<PathBuf, String> {
        cache_file(app, self.dir, key, self.extension)
    }

    pub fn file_for(&self, app: &AppHandle, source: &Path) -> Option<PathBuf> {
        self.file(app, &fingerprint(source).ok()?).ok()
    }

    pub fn submit(
        &self,
        app: &AppHandle,
        paths: &[String],
        prepare: impl Fn(&Path) -> Result<Prepared, String>,
        run: CacheTask,
    ) -> Result<(), String> {
        crate::video::libav::require()?;
        std::fs::create_dir_all(cache_root(app)?.join(self.dir)).map_err(|e| e.to_string())?;
        let jobs = app.state::<JobManager>();
        for path in paths {
            let source = parse_virtual_path(path).0;
            let (info, key) = match prepare(&source) {
                Ok(Some(prepared)) => prepared,
                Ok(None) => continue,
                Err(e) => {
                    log::warn!("Skipping {} for '{}': {}", self.kind, source.display(), e);
                    continue;
                }
            };
            let target = self.file(app, &key)?;
            if target.is_file() {
                continue;
            }
            let label = source
                .file_name()
                .unwrap_or(source.as_os_str())
                .to_string_lossy()
                .into_owned();
            jobs.submit(app, self.kind, &key, &label, move |job| {
                run(&source, &info, &target, job)
            });
        }
        Ok(())
    }

    pub fn states<T>(
        &self,
        app: &AppHandle,
        paths: Vec<String>,
        state: impl Fn(Cached) -> T,
    ) -> HashMap<String, T> {
        let active: HashMap<String, (JobState, f32)> = app
            .state::<JobManager>()
            .list()
            .into_iter()
            .filter(|status| status.kind == self.kind)
            .map(|status| (status.key, (status.state, status.progress)))
            .collect();
        paths
            .into_iter()
            .map(|path| {
                let cached = match fingerprint(&parse_virtual_path(&path).0) {
                    Err(_) => Cached::Missing,
                    Ok(key) if self.file(app, &key).is_ok_and(|file| file.is_file()) => {
                        Cached::Ready
                    }
                    Ok(key) => active
                        .get(&key)
                        .map_or(Cached::Missing, |&(state, progress)| {
                            Cached::Job(state, progress)
                        }),
                };
                (path, state(cached))
            })
            .collect()
    }
}

fn start_next(shared: &Arc<Shared>) {
    let mut jobs = shared.lock();
    let mut busy: HashSet<String> = jobs
        .list
        .iter()
        .filter(|job| job.status.state == JobState::Running)
        .map(|job| job.status.kind.clone())
        .collect();
    let mut started = Vec::new();
    for job in jobs
        .list
        .iter_mut()
        .filter(|job| job.status.state == JobState::Queued)
    {
        if busy.contains(&job.status.kind) {
            continue;
        }
        let Some(task) = job.task.take() else {
            continue;
        };
        busy.insert(job.status.kind.clone());
        job.status.state = JobState::Running;
        started.push((
            JobContext {
                id: job.status.id.clone(),
                cancelled: Arc::clone(&job.cancelled),
                shared: Arc::clone(shared),
            },
            task,
        ));
    }
    let snapshot = (!started.is_empty()).then(|| jobs.snapshot(true)).flatten();
    drop(jobs);
    shared.emit(snapshot);
    for (context, task) in started {
        std::thread::spawn(move || {
            let result = crate::video::crash_safe("The job crashed", || task(&context));
            finish(&context, result);
        });
    }
}

fn finish(context: &JobContext, result: Result<(), String>) {
    let shared = &context.shared;
    let mut jobs = shared.lock();
    if let Some(job) = jobs.get_mut(&context.id) {
        match result {
            Ok(()) => {
                job.status.state = JobState::Done;
                job.status.progress = 1.0;
            }
            Err(_) if context.is_cancelled() => job.status.state = JobState::Cancelled,
            Err(error) => {
                job.status.state = JobState::Failed;
                job.status.error = Some(error);
            }
        }
    }
    jobs.prune();
    let snapshot = jobs.snapshot(true);
    drop(jobs);
    shared.finished.notify_all();
    shared.emit(snapshot);
    start_next(shared);
}

#[tauri::command]
pub fn video_jobs(jobs: State<JobManager>) -> Vec<JobStatus> {
    jobs.list()
}

#[tauri::command]
pub fn video_cancel_job(id: String, jobs: State<JobManager>) {
    jobs.cancel(&id);
}
