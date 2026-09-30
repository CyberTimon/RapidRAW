//! Decodes the editor's neighbouring photos in the background so stepping to
//! the next or previous photo can skip the RAW decode.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use tauri::Manager;

use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::cache_utils::SourceRevision;
use crate::file_management::parse_virtual_path;

pub struct PrefetchState {
    /// Bumped by every new request and by a foreground open; running decodes
    /// observe it through their cancel token.
    generation: Arc<AtomicUsize>,
    in_flight: Mutex<Option<PathBuf>>,
    finished: Condvar,
    requests: Mutex<Option<Sender<Request>>>,
}

impl Default for PrefetchState {
    fn default() -> Self {
        Self {
            generation: Arc::new(AtomicUsize::new(0)),
            in_flight: Mutex::new(None),
            finished: Condvar::new(),
            requests: Mutex::new(None),
        }
    }
}

struct Request {
    generation: usize,
    paths: Vec<String>,
}

impl PrefetchState {
    fn cancel(&self) -> usize {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Called by a foreground open that missed the decoded cache. Waits while
    /// `source` is being prefetched; otherwise cancels prefetching to free the
    /// CPU. The caller re-checks the cache afterwards, which also covers a
    /// prefetch that finished just before this call.
    pub fn wait_or_cancel(&self, source: &Path, still_wanted: impl Fn() -> bool) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if in_flight.as_deref() != Some(source) {
            drop(in_flight);
            self.cancel();
            return;
        }
        while in_flight.as_deref() == Some(source) && still_wanted() {
            in_flight = self
                .finished
                .wait_timeout(in_flight, Duration::from_millis(50))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    fn set_in_flight(&self, source: Option<PathBuf>) {
        *self.in_flight.lock().unwrap_or_else(|e| e.into_inner()) = source;
        self.finished.notify_all();
    }
}

/// Replaces any pending prefetch with `paths`, in priority order. An empty
/// list only cancels.
#[tauri::command]
pub fn prefetch_images(paths: Vec<String>, app_handle: tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let prefetch = &state.prefetch;
    let generation = prefetch.cancel();
    if paths.is_empty() {
        return;
    }
    let mut requests = prefetch.requests.lock().unwrap_or_else(|e| e.into_inner());
    let sender = requests.get_or_insert_with(|| start_worker(app_handle.clone()));
    let _ = sender.send(Request { generation, paths });
}

fn start_worker(app_handle: tauri::AppHandle) -> Sender<Request> {
    let (sender, receiver): (Sender<Request>, Receiver<Request>) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("rapidraw-prefetch".into())
        .spawn(move || {
            lower_thread_priority();
            while let Ok(mut request) = receiver.recv() {
                while let Ok(newer) = receiver.try_recv() {
                    request = newer;
                }
                let state = app_handle.state::<AppState>();
                for path in &request.paths {
                    if state.prefetch.generation.load(Ordering::SeqCst) != request.generation {
                        break;
                    }
                    if let Err(error) = prefetch_one(&app_handle, &state, path, request.generation)
                    {
                        log::debug!("Prefetch skipped '{path}': {error}");
                    }
                }
            }
        });
    if let Err(error) = spawned {
        log::warn!("Could not start the photo prefetch worker: {error}");
    }
    sender
}

fn prefetch_one(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    path: &str,
    generation: usize,
) -> Result<(), String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    if settings.image_cache_size.unwrap_or(5) < 2 {
        return Ok(());
    }
    let (source_path, _) = parse_virtual_path(path);
    if crate::file_management::is_cloud_placeholder(&source_path) {
        return Ok(());
    }
    let revision = SourceRevision::read(&source_path)?;
    if state
        .decoded_image_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&revision)
    {
        return Ok(());
    }

    state
        .prefetch
        .set_in_flight(Some(revision.canonical_path().to_path_buf()));
    // Clear the marker even if decoding panics, so a waiting open resumes.
    struct InFlight<'a>(&'a PrefetchState);
    impl Drop for InFlight<'_> {
        fn drop(&mut self) {
            self.0.set_in_flight(None);
        }
    }
    let _in_flight = InFlight(&state.prefetch);

    let started = std::time::Instant::now();
    let source = source_path.to_string_lossy().into_owned();
    let cancel_token = Some((Arc::clone(&state.prefetch.generation), generation));
    let decode = || crate::image_loader::decode_source_image(&source, &settings, cancel_token);
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match decode_pool() {
        Some(pool) => pool.install(decode),
        None => decode(),
    }))
    .unwrap_or_else(|_| Err("decoder panicked".to_string()));
    decoded.and_then(|(image, exif)| {
        if SourceRevision::read(&source_path)? != revision {
            return Err("source changed during prefetch".to_string());
        }
        let open_image = state
            .original_image
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|loaded| Arc::clone(&loaded.image));
        let retained = state
            .decoded_image_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert_prefetched(revision, Arc::new(image), exif, open_image.as_ref());
        log::info!(
            "[prefetch] decoded '{}' in {:.0} ms (retained: {retained})",
            source,
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(())
    })
}

/// Decodes run on their own low-priority threads so interactive editing,
/// which uses the global pool, keeps precedence.
fn decode_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).max(1));
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|index| format!("rapidraw-prefetch-{index}"))
            .start_handler(|_| lower_thread_priority())
            .build()
            .inspect_err(|error| log::warn!("Prefetch pool unavailable: {error}"))
            .ok()
    })
    .as_ref()
}

fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    // SAFETY: Adjusts only the calling thread's scheduling class.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(target_os = "linux")]
    // SAFETY: Adjusts only the calling thread's nice value.
    unsafe {
        let thread_id = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, thread_id, 10);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_open_waits_for_its_own_prefetch_and_cancels_others() {
        let state = Arc::new(PrefetchState::default());
        let target = PathBuf::from("/photos/next.cr3");

        let before = state.generation.load(Ordering::SeqCst);
        state.wait_or_cancel(Path::new("/photos/other.cr3"), || true);
        assert_eq!(state.generation.load(Ordering::SeqCst), before + 1);

        state.set_in_flight(Some(target.clone()));
        let finisher = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                state.set_in_flight(None);
            })
        };
        let started = std::time::Instant::now();
        let generation = state.generation.load(Ordering::SeqCst);
        state.wait_or_cancel(&target, || true);
        assert!(started.elapsed() >= Duration::from_millis(90));
        assert_eq!(state.generation.load(Ordering::SeqCst), generation);
        finisher.join().unwrap();

        // Navigating away stops the wait without waiting for the decode.
        state.set_in_flight(Some(target.clone()));
        let started = std::time::Instant::now();
        state.wait_or_cancel(&target, || false);
        assert!(started.elapsed() < Duration::from_millis(50));
    }
}
