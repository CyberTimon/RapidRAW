use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::AppState;
use crate::app_settings::{AppSettings, load_settings};
use crate::cache_utils::DecodeFingerprint;
use crate::file_management::parse_virtual_path;
use crate::image_loader::get_or_decode_pristine;

pub struct PreloadJob {
    paths: Vec<String>,
    generation: usize,
}

const PRELOAD_MIN_CACHE_SIZE: u32 = 4;

pub fn start_preload_worker(app_handle: tauri::AppHandle) {
    let (tx, rx): (Sender<PreloadJob>, Receiver<PreloadJob>) = mpsc::channel();
    *app_handle
        .state::<AppState>()
        .preload_worker_tx
        .lock()
        .unwrap() = Some(tx);

    std::thread::spawn(move || {
        let mut pool = None;
        while let Ok(mut job) = rx.recv() {
            while let Ok(latest) = rx.try_recv() {
                job = latest;
            }
            let settings = load_settings(app_handle.clone()).unwrap_or_default();
            if !preload_enabled(&settings) {
                continue;
            }
            if pool.is_none() {
                match preload_pool() {
                    Ok(built) => pool = Some(built),
                    Err(e) => {
                        log::error!("Failed to start the image preload pool: {}", e);
                        return;
                    }
                }
            }
            if let Some(pool) = &pool {
                let state = app_handle.state::<AppState>();
                run_preload(&state, pool, &settings, &job.paths, job.generation);
            }
        }
    });
}

fn preload_enabled(settings: &AppSettings) -> bool {
    settings.image_cache_size.unwrap_or(5) >= PRELOAD_MIN_CACHE_SIZE
}

fn preload_pool() -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError> {
    let threads = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).max(1))
        .unwrap_or(2);
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .stack_size(8 * 1024 * 1024)
        .thread_name(|i| format!("image-preload-{}", i))
        .build()
}

fn run_preload(
    state: &AppState,
    pool: &rayon::ThreadPool,
    settings: &AppSettings,
    paths: &[String],
    generation: usize,
) {
    let cancelled = || state.preload_generation.load(Ordering::SeqCst) != generation;
    for path in paths {
        let (source_path, _) = parse_virtual_path(path);
        if !source_path.exists() || crate::file_management::is_cloud_placeholder(&source_path) {
            continue;
        }
        let path_str = source_path.to_string_lossy().to_string();
        let cached = DecodeFingerprint::for_file(&source_path, settings).is_some_and(|fp| {
            state
                .decoded_image_cache
                .lock()
                .unwrap()
                .contains(&path_str, &fp)
        });
        if cached {
            continue;
        }
        while !state.decode_flights.is_idle() && !cancelled() {
            std::thread::sleep(Duration::from_millis(20));
        }
        if cancelled() {
            return;
        }

        *state.preloading_path.lock().unwrap() = Some(path_str);
        let start = Instant::now();
        let cancel_token = Some((state.preload_generation.clone(), generation));
        let result =
            pool.install(|| get_or_decode_pristine(state, &source_path, settings, cancel_token));
        *state.preloading_path.lock().unwrap() = None;
        match result {
            Ok(_) => log::info!(
                "Preloaded '{}' in {:?}",
                source_path.display(),
                start.elapsed()
            ),
            Err(_) if cancelled() => return,
            Err(e) => log::warn!("Preloading '{}' failed: {}", source_path.display(), e),
        }
    }
}

pub fn cancel_unless_preloading(state: &AppState, path: &str) {
    if state.preloading_path.lock().unwrap().as_deref() != Some(path) {
        state.preload_generation.fetch_add(1, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn preload_images(paths: Vec<String>, state: tauri::State<'_, AppState>) {
    let generation = state.preload_generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(tx) = state.preload_worker_tx.lock().unwrap().as_ref() {
        let _ = tx.send(PreloadJob { paths, generation });
    }
}
