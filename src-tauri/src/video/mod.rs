pub mod ai_frames;
pub mod ai_maps;
pub mod ai_masks;
pub mod audio;
pub mod beats;
pub mod camera_log;
pub mod captions;
pub mod commands;
pub mod compose;
pub mod encoders;
pub mod engine;
pub mod export;
pub mod ffmpeg;
pub mod frames;
pub mod geometry;
pub mod gpu;
pub mod jobs;
pub mod libav;
pub mod loudness;
pub mod media;
pub mod metadata;
pub mod model;
pub mod playback;
pub mod project_files;
pub mod proxy;
pub mod reframe;
pub mod retime;
pub mod reverse;
pub mod revisions;
pub mod scopes;
pub mod speech;
pub mod stabilization;
pub mod timelapse;
pub mod tracking;
pub mod vision;

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use image::DynamicImage;
use tauri::{AppHandle, Manager};

use crate::app::state::{AppState, LoadedImage};
use crate::render::gpu::compute::PerDevice;
use crate::render::gpu::context::get_or_init_gpu_context;

const POSTER_MAX_SECONDS: f64 = 1.0;
const BUSY_POLL: Duration = Duration::from_millis(100);
const ENGINE_POLL: Duration = Duration::from_millis(10);
const ENGINE_PATIENCE: Duration = Duration::from_secs(10);
const BATCH_IDLE: Duration = Duration::from_secs(10);
const ENGINE_BUSY: &str = "The video engine is busy";

static BUSY: AtomicUsize = AtomicUsize::new(0);
static WARM_UP: std::sync::Once = std::sync::Once::new();

pub struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn busy() -> BusyGuard {
    BUSY.fetch_add(1, Ordering::SeqCst);
    BusyGuard
}

pub fn warm_up() {
    WARM_UP.call_once(|| {
        std::thread::spawn(|| {
            if let Ok(context) = crate::render::gpu::context::shared_gpu_context()
                && !context.shares_one_gl_context()
            {
                let _ = gpu::convert(&context, &ffmpeg::VideoColor::default(), (2, 2), &[0; 6]);
                let _ = crate::render::gpu::compute::encode(&context, |enc| {
                    compose::fill(enc, (2, 2), [0.0; 4]).detach()
                });
            }
            libav::video::warm_hardware();
        });
    });
}

pub fn wait_while_busy() {
    while BUSY.load(Ordering::SeqCst) > 0 {
        std::thread::sleep(BUSY_POLL);
    }
}

pub async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|e| format!("Video task failed: {}", e))
}

pub fn crash_safe<T>(crashed: &str, task: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(task))
        .unwrap_or_else(|_| Err(crashed.to_string()))
}

pub fn hash_of(value: impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn poster_time(info: &ffmpeg::MediaInfo) -> f64 {
    (info.duration * 0.1).min(POSTER_MAX_SECONDS)
}

pub fn poster_frame(path: &Path, at: Option<f64>) -> Result<DynamicImage, String> {
    let info = ffmpeg::probe(path)?;
    let frame = match at.filter(|time| time.is_finite() && *time >= 0.0) {
        Some(time) => {
            frames::decode_frame(path, &info, time.min((info.duration - 0.05).max(0.0)), None)
        }
        None => frames::decode_poster(path, &info, poster_time(&info), None),
    };
    frame.map(Arc::unwrap_or_clone)
}

pub fn thumbnail_frame(path: &Path, longest: u32) -> Result<DynamicImage, String> {
    let info = ffmpeg::probe(path)?;
    let size = media::even_fit((info.width, info.height), longest, 2);
    let mut image = Arc::unwrap_or_clone(frames::decode_poster(
        path,
        &info,
        poster_time(&info),
        Some(size),
    )?);
    crate::render::image_processing::apply_working_display_to_srgb(&mut image, false);
    Ok(image)
}

pub fn poster_seconds(adjustments: &serde_json::Value) -> Option<f64> {
    adjustments.get("video")?.get("poster")?.as_f64()
}

pub fn decode_pristine(path: &Path) -> Result<(DynamicImage, HashMap<String, String>), String> {
    let info = ffmpeg::probe(path)?;
    Ok((
        Arc::unwrap_or_clone(frames::decode_poster(
            path,
            &info,
            poster_time(&info),
            None,
        )?),
        info.as_exif(),
    ))
}

#[derive(Default)]
struct Held {
    engine: PerDevice<engine::Engine>,
    leased: bool,
    released: bool,
    returned: Option<Instant>,
}

#[derive(Default)]
struct EngineSlot {
    held: Mutex<Held>,
    returned: Condvar,
    expiring: AtomicBool,
}

pub struct EngineLease<'a> {
    slot: &'a EngineSlot,
    engine: PerDevice<engine::Engine>,
}

impl EngineSlot {
    fn lock(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lease(
        &self,
        app: &AppHandle,
        give_up: impl Fn() -> bool,
        patience: Option<Duration>,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Option<EngineLease<'_>>, String> {
        let waiting = Instant::now();
        let mut held = self.lock();
        loop {
            if give_up() || patience.is_some_and(|patience| waiting.elapsed() >= patience) {
                return Ok(None);
            }
            if !held.leased {
                break;
            }
            held = self
                .returned
                .wait_timeout(held, ENGINE_POLL)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        held.leased = true;
        let mut lease = EngineLease {
            slot: self,
            engine: std::mem::take(&mut held.engine),
        };
        drop(held);
        let context = get_or_init_gpu_context(&app.state::<AppState>(), app)?;
        lease
            .engine
            .get_or_try_insert_with(&context, || engine::Engine::new(app))?
            .preempt_on(cancel);
        Ok(Some(lease))
    }

    fn give_back(&self, engine: PerDevice<engine::Engine>) {
        let mut held = self.lock();
        if !std::mem::take(&mut held.released) {
            held.engine = engine;
        }
        held.leased = false;
        held.returned = Some(Instant::now());
        self.returned.notify_all();
    }

    fn release(&self) {
        let engine = {
            let mut held = self.lock();
            held.released = held.leased;
            std::mem::take(&mut held.engine)
        };
        drop(engine);
    }

    fn expire(&self, idle: Duration) -> Option<Duration> {
        let mut held = self.lock();
        let waited = held
            .returned
            .map_or(Duration::ZERO, |returned| returned.elapsed());
        if held.leased {
            return Some(idle);
        }
        if waited < idle {
            return Some(idle - waited);
        }
        self.expiring.store(false, Ordering::SeqCst);
        let engine = std::mem::take(&mut held.engine);
        drop(held);
        drop(engine);
        None
    }
}

impl std::ops::Deref for EngineLease<'_> {
    type Target = engine::Engine;

    fn deref(&self) -> &engine::Engine {
        self.engine.get().expect("a lease holds its engine")
    }
}

impl std::ops::DerefMut for EngineLease<'_> {
    fn deref_mut(&mut self) -> &mut engine::Engine {
        self.engine.get_mut().expect("a lease holds its engine")
    }
}

impl Drop for EngineLease<'_> {
    fn drop(&mut self) {
        let mut engine = std::mem::take(&mut self.engine);
        if std::thread::panicking() {
            log::error!("A video engine task crashed; the engine is rebuilt on next use");
            engine = PerDevice::default();
        }
        if let Some(engine) = engine.get_mut() {
            engine.preempt_on(None);
        }
        self.slot.give_back(engine);
    }
}

#[derive(Default)]
pub struct VideoState {
    playback: Mutex<Option<playback::Playback>>,
    export: Mutex<Option<Arc<AtomicBool>>>,
    play_pending: Arc<AtomicBool>,
    preview: EngineSlot,
    batch: EngineSlot,
    titles: engine::titles::TitleStore,
    revisions: revisions::Revisions,
}

impl VideoState {
    pub fn preview(&self, app: &AppHandle) -> Result<Option<EngineLease<'_>>, String> {
        self.preview.lease(
            app,
            || self.play_pending.load(Ordering::SeqCst) || playback::is_playing(self),
            Some(ENGINE_PATIENCE),
            Some(Arc::clone(&self.play_pending)),
        )
    }

    fn player(
        &self,
        app: &AppHandle,
        stop: &Arc<AtomicBool>,
    ) -> Result<Option<EngineLease<'_>>, String> {
        self.preview.lease(
            app,
            || stop.load(Ordering::SeqCst),
            None,
            Some(Arc::clone(stop)),
        )
    }

    pub fn batch(&self, app: &AppHandle) -> Result<EngineLease<'_>, String> {
        let lease = self
            .batch
            .lease(app, || false, None, None)?
            .ok_or_else(|| ENGINE_BUSY.to_string())?;
        if !self.batch.expiring.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            std::thread::spawn(move || {
                let video = app.state::<VideoState>();
                while let Some(wait) = video.batch.expire(BATCH_IDLE) {
                    std::thread::sleep(wait);
                }
            });
        }
        Ok(lease)
    }

    pub fn release_engines(&self) {
        self.preview.release();
        self.batch.release();
        self.titles.release();
    }

    pub fn release(&self) {
        self.release_engines();
        self.revisions.release();
    }
}

pub fn frame_source(
    path: &str,
    image: Arc<DynamicImage>,
    time: f64,
    deflicker: bool,
) -> LoadedImage {
    let (source_path, _) = crate::library::sidecars::parse_virtual_path(path);
    let reference = timelapse::frame_path(&source_path, Some(time));
    let source = reference
        .clone()
        .unwrap_or_else(|| source_path.to_string_lossy().into_owned());
    let is_raw = crate::decode::formats::is_raw_file(&source);
    let as_shot = crate::decode::as_shot::as_shot(&source);
    LoadedImage {
        path: path.to_string(),
        image: if is_raw && reference.is_some() {
            Arc::new(timelapse::linearized(&image))
        } else {
            image
        },
        is_raw,
        as_shot: crate::decode::as_shot::AsShot {
            white_balance: timelapse::white_balance(&source_path, Some(time), deflicker)
                .unwrap_or(as_shot.white_balance),
            ..as_shot
        },
        has_gain_map: false,
        source_time: Some(time),
        lens_source: reference,
    }
}

pub fn frame_adjustments(
    app: &tauri::AppHandle,
    frame: &LoadedImage,
    adjustments: &mut serde_json::Value,
) {
    let Some(time) = frame.source_time else {
        return;
    };
    let path = frame.lens_path();
    for (key, map) in ai_maps::frame_overrides(app, path, adjustments, time) {
        adjustments[key] = serde_json::Value::String(map);
    }
    let size = image::GenericImageView::dimensions(&*frame.image);
    if let Some(masks) = engine::look::masks_at(app, path, adjustments, time, size) {
        adjustments["masks"] = masks;
    }
}

pub fn install_frame(state: &AppState, frame: LoadedImage, load_epoch: usize) -> bool {
    if state.image_load_epoch.load(Ordering::SeqCst) != load_epoch {
        return false;
    }
    crate::render::cache_utils::clear_source_caches(state);
    state.load_image_generation.fetch_add(1, Ordering::SeqCst);
    *state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(frame);
    true
}
