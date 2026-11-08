use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::cache_utils::{DecodeFingerprint, FlightRole, HalfImage};
use crate::file_management::parse_virtual_path;
use crate::image_loader::{cache_pristine, decode_pristine};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MAX_PRELOAD_TARGETS: usize = 3;
const COMPACTION_GRACE: Duration = Duration::from_millis(1500);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_millis(1000);

struct RunningPreload {
    path: String,
    cancel: Arc<AtomicUsize>,
    adopted: bool,
}

#[derive(Default)]
struct PreloadState {
    current: Option<String>,
    load_ticket: u64,
    loading: bool,
    frame_rendered: bool,
    decode_at: Option<Instant>,
    request: Option<(String, Vec<String>)>,
    targets: Vec<String>,
    queue: VecDeque<String>,
    running: Option<RunningPreload>,
    compact_at: Option<Instant>,
    boosted: bool,
}

impl PreloadState {
    fn keep(&self) -> Vec<String> {
        self.current
            .iter()
            .chain(self.targets.iter())
            .cloned()
            .collect()
    }

    fn has_current_request(&self) -> bool {
        self.request
            .as_ref()
            .is_some_and(|(anchor, _)| self.current.as_ref() == Some(anchor))
    }

    fn has_decode_work(&self) -> bool {
        !self.queue.is_empty() || self.has_current_request()
    }

    fn decode_due(&self, now: Instant) -> bool {
        self.decode_at.is_some_and(|at| at <= now)
    }

    fn wake_at(&self) -> Option<Instant> {
        if self.loading {
            return None;
        }
        let decode_at = self.decode_at.filter(|_| self.has_decode_work());
        [self.compact_at, decode_at].into_iter().flatten().min()
    }
}

enum PreloadTask {
    Compact {
        keep: Vec<String>,
        ticket: u64,
    },
    Decode {
        path: String,
        keep: Vec<String>,
        cancel: Arc<AtomicUsize>,
    },
}

#[derive(Default)]
pub struct ImagePreloader {
    state: Mutex<PreloadState>,
    wake: Condvar,
    pool: OnceLock<Option<rayon::ThreadPool>>,
    awaiting_frame: AtomicBool,
}

pub struct LoadGuard<'a> {
    preloader: &'a ImagePreloader,
    ticket: u64,
}

impl Drop for LoadGuard<'_> {
    fn drop(&mut self) {
        self.preloader.finish_load(self.ticket);
    }
}

impl ImagePreloader {
    fn lock(&self) -> MutexGuard<'_, PreloadState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pool(&self) -> Option<&rayon::ThreadPool> {
        self.pool
            .get_or_init(|| {
                rayon::ThreadPoolBuilder::new()
                    .stack_size(8 * 1024 * 1024)
                    .thread_name(|index| format!("image-preload-{index}"))
                    .start_handler(|_| set_current_thread_background(true))
                    .build()
                    .ok()
            })
            .as_ref()
    }

    fn in_background<R: Send>(&self, work: impl FnOnce() -> R + Send) -> R {
        match self.pool() {
            Some(pool) => pool.install(work),
            None => work(),
        }
    }

    fn set_boosted(&self, state: &mut PreloadState, boosted: bool) {
        if state.boosted == boosted {
            return;
        }
        state.boosted = boosted;
        if let Some(pool) = self.pool() {
            pool.spawn_broadcast(move |_| set_current_thread_background(!boosted));
        }
    }

    pub fn begin_load(&self, source_path: &str) -> LoadGuard<'_> {
        let mut state = self.lock();
        state.load_ticket += 1;
        state.current = Some(source_path.to_string());
        state.loading = true;
        state.frame_rendered = false;
        state.decode_at = None;
        state.targets.clear();
        state.queue.clear();
        state.compact_at = None;
        if !state.has_current_request() {
            state.request = None;
        }
        self.awaiting_frame.store(true, Ordering::Relaxed);

        if let Some(running) = state.running.as_mut() {
            let adopted = running.path == source_path;
            running.adopted = adopted;
            running
                .cancel
                .store(usize::from(!adopted), Ordering::SeqCst);
            self.set_boosted(&mut state, adopted);
        }

        LoadGuard {
            preloader: self,
            ticket: state.load_ticket,
        }
    }

    fn finish_load(&self, ticket: u64) {
        let mut state = self.lock();
        if state.load_ticket != ticket {
            return;
        }
        let now = Instant::now();
        state.loading = false;
        state.compact_at = Some(now + COMPACTION_GRACE);
        state.decode_at = Some(if state.frame_rendered {
            now
        } else {
            now + FIRST_FRAME_TIMEOUT
        });
        self.wake.notify_all();
    }

    pub fn is_awaiting_frame(&self) -> bool {
        self.awaiting_frame.load(Ordering::Relaxed)
    }

    pub fn frame_rendered(&self, path: &str) {
        let source_path = parse_virtual_path(path).0.to_string_lossy().to_string();
        let mut state = self.lock();
        if state.current.as_deref() != Some(source_path.as_str()) || state.frame_rendered {
            return;
        }
        state.frame_rendered = true;
        self.awaiting_frame.store(false, Ordering::Relaxed);
        if !state.loading {
            state.decode_at = Some(Instant::now());
            self.wake.notify_all();
        }
    }

    pub fn request(&self, anchor: &str, paths: Vec<String>) {
        let mut state = self.lock();
        let mut targets: Vec<String> = Vec::with_capacity(MAX_PRELOAD_TARGETS);
        for path in paths {
            if targets.len() == MAX_PRELOAD_TARGETS {
                break;
            }
            if path != anchor && !targets.contains(&path) {
                targets.push(path);
            }
        }

        let is_current = state.current.as_deref() == Some(anchor);
        if (is_current && state.request.is_none() && state.targets == targets)
            || (!is_current && state.has_current_request())
        {
            return;
        }
        if is_current
            && let Some(running) = &state.running
            && !running.adopted
        {
            let wanted = targets.contains(&running.path);
            running.cancel.store(usize::from(!wanted), Ordering::SeqCst);
        }
        state.request = Some((anchor.to_string(), targets));
        self.wake.notify_all();
    }

    fn take_task(&self, state: &mut PreloadState) -> Option<PreloadTask> {
        state.current.as_ref()?;
        let ticket = state.load_ticket;
        let now = Instant::now();

        if state.decode_due(now)
            && state.has_current_request()
            && let Some((_, targets)) = state.request.take()
        {
            state.queue = targets.iter().cloned().collect();
            state.targets = targets;
            state.compact_at = Some(now);
        }

        if state.decode_due(now)
            && let Some(path) = state.queue.pop_front()
        {
            let cancel = Arc::new(AtomicUsize::new(0));
            state.running = Some(RunningPreload {
                path: path.clone(),
                cancel: Arc::clone(&cancel),
                adopted: false,
            });
            self.set_boosted(state, false);
            let keep = state
                .current
                .iter()
                .chain(state.targets.iter().take_while(|target| **target != path))
                .cloned()
                .collect();
            return Some(PreloadTask::Decode { path, keep, cancel });
        }

        if state.compact_at.is_some_and(|at| at <= now) && !state.has_decode_work() {
            state.compact_at = None;
            self.set_boosted(state, false);
            return Some(PreloadTask::Compact {
                keep: state.keep(),
                ticket,
            });
        }

        None
    }

    fn next_task(&self) -> PreloadTask {
        let mut state = self.lock();
        loop {
            if !state.loading
                && let Some(task) = self.take_task(&mut state)
            {
                return task;
            }
            state = match state.wake_at() {
                Some(at) => {
                    let timeout = at.saturating_duration_since(Instant::now());
                    self.wake
                        .wait_timeout(state, timeout)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
    }

    fn run_task(&self, app_handle: &AppHandle, app_state: &AppState, task: PreloadTask) {
        match task {
            PreloadTask::Compact { keep, ticket } => self.compact(app_state, &keep, ticket),
            PreloadTask::Decode { path, keep, cancel } => {
                self.decode(app_handle, app_state, &path, &keep, &cancel);
                self.lock().running = None;
            }
        }
    }

    fn compact(&self, app_state: &AppState, keep: &[String], ticket: u64) {
        let cache = || {
            app_state
                .decoded_image_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
        };
        let candidates = cache().compaction_candidates(keep);
        for path in candidates {
            if self.lock().load_ticket != ticket {
                return;
            }
            let Some(source) = cache().take_for_compaction(&path) else {
                continue;
            };
            if let Some(half) = self.in_background(|| HalfImage::from_image(&source)) {
                cache().store_compacted(&path, &source, half);
            }
        }
    }

    fn decode(
        &self,
        app_handle: &AppHandle,
        app_state: &AppState,
        path: &str,
        keep: &[String],
        cancel: &Arc<AtomicUsize>,
    ) {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let source_path = Path::new(path);
        let Some(fingerprint) = DecodeFingerprint::for_file(source_path, &settings) else {
            return;
        };
        let is_cached = || {
            app_state
                .decoded_image_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(path, &fingerprint)
        };
        let has_room = || {
            app_state
                .decoded_image_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .has_room_for(keep)
        };
        if is_cached() || !has_room() {
            return;
        }
        let FlightRole::Leader(_flight) = app_state.decode_flights.begin(path) else {
            return;
        };
        if is_cached() {
            return;
        }

        let cancel_token = Some((Arc::clone(cancel), 0));
        match self.in_background(|| decode_pristine(source_path, path, &settings, cancel_token)) {
            Ok((image, exif)) => {
                cache_pristine(app_state, path.to_string(), Some(fingerprint), image, exif);
            }
            Err(e) if !e.contains("cancelled") => {
                log::debug!("Preloading '{}' failed: {}", path, e);
            }
            Err(_) => {}
        }
    }
}

pub fn start_preload_worker(app_handle: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("image-preloader".to_string())
        .spawn(move || {
            let app_state = app_handle.state::<AppState>();
            let preloader = &app_state.image_preloader;
            loop {
                let task = preloader.next_task();
                preloader.run_task(&app_handle, &app_state, task);
            }
        });
    if let Err(e) = spawned {
        log::error!("Failed to start image preload worker: {}", e);
    }
}

#[tauri::command]
pub fn preload_images(anchor: String, paths: Vec<String>, state: tauri::State<'_, AppState>) {
    let source = |path: &str| parse_virtual_path(path).0.to_string_lossy().to_string();
    state.image_preloader.request(
        &source(&anchor),
        paths.iter().map(|path| source(path)).collect(),
    );
}

#[cfg(target_os = "windows")]
fn set_current_thread_background(background: bool) {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, SetThreadPriorityBoost, THREAD_PRIORITY_LOWEST,
        THREAD_PRIORITY_NORMAL,
    };
    let priority = if background {
        THREAD_PRIORITY_LOWEST
    } else {
        THREAD_PRIORITY_NORMAL
    };
    unsafe {
        let thread = GetCurrentThread();
        let _ = SetThreadPriority(thread, priority);
        let _ = SetThreadPriorityBoost(thread, background);
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn set_current_thread_background(background: bool) {
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, if background { 10 } else { 0 });
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn set_current_thread_background(background: bool) {
    let class = if background {
        libc::qos_class_t::QOS_CLASS_UTILITY
    } else {
        libc::qos_class_t::QOS_CLASS_USER_INITIATED
    };
    unsafe {
        libc::pthread_set_qos_class_self_np(class, 0);
    }
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
)))]
fn set_current_thread_background(_background: bool) {}
