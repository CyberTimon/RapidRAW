use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use image::{DynamicImage, GrayImage};
use serde::{Deserialize, Serialize};
use sysinfo::Disks;
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;
use wgpu::{Texture, TextureView};

use crate::ai_processing::AiState;
use crate::cache_utils::DecodedImageCache;
use crate::camera_tethering::CameraSession;
use crate::gpu_processing::GpuProcessor;
use crate::image_processing::GpuContext;
use crate::launch_request::ExternalEditSession;
use crate::lens_correction::LensDatabase;
use crate::lut_processing::Lut;

#[derive(Serialize, Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
    pub fullscreen: bool,
}

#[derive(Clone)]
pub struct LoadedImage {
    pub path: String,
    pub image: Arc<DynamicImage>,
    pub is_raw: bool,
}

#[derive(Clone)]
pub struct CachedPreview {
    pub image: Arc<DynamicImage>,
    pub small_image: Arc<DynamicImage>,
    pub transform_hash: u64,
    pub scale: f32,
    pub unscaled_crop_offset: (f32, f32),
    pub preview_dim: u32,
    pub interactive_divisor: f32,
}

pub struct GpuImageCache {
    pub texture: Texture,
    pub texture_view: TextureView,
    pub width: u32,
    pub height: u32,
    pub transform_hash: u64,
}

pub struct GpuProcessorState {
    pub processor: GpuProcessor,
    pub width: u32,
    pub height: u32,
}

pub struct PreviewJob {
    pub adjustments: serde_json::Value,
    pub is_interactive: bool,
    pub target_resolution: Option<u32>,
    pub roi: Option<(f32, f32, f32, f32)>,
    pub request_analytics: bool,
    pub compute_waveform: bool,
    pub active_waveform_channel: Option<String>,
    pub responder: tokio::sync::oneshot::Sender<Vec<u8>>,
    pub gpu_work_ticket: GpuWorkTicket,
}

pub struct AnalyticsJob {
    pub path: String,
    pub image: Arc<DynamicImage>,
    pub compute_waveform: bool,
    pub active_waveform_channel: Option<String>,
}

pub struct AnalyticsConfig {
    pub path: String,
    pub compute_waveform: bool,
    pub active_waveform_channel: Option<String>,
    pub sender: Sender<AnalyticsJob>,
}

pub struct ThumbnailProgressTracker {
    pub total: usize,
    pub completed: usize,
}

pub struct ThumbnailManager {
    pub queue: Mutex<VecDeque<String>>,
    pub cvar: Condvar,
    pub processing_now: Mutex<HashSet<String>>,
    pub rotational_disk: AtomicBool,
    pub io_gate: Mutex<()>,
}

impl ThumbnailManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            cvar: Condvar::new(),
            processing_now: Mutex::new(HashSet::new()),
            rotational_disk: AtomicBool::new(false),
            io_gate: Mutex::new(()),
        })
    }
}

pub struct PendingMetadata {
    pub virtual_path: String,
    pub image_path: PathBuf,
    pub sidecar_path: PathBuf,
}

pub struct MetadataManager {
    pub queue: Mutex<VecDeque<PendingMetadata>>,
    pub cvar: Condvar,
    pub pending: Mutex<HashSet<PathBuf>>,
}

impl MetadataManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            cvar: Condvar::new(),
            pending: Mutex::new(HashSet::new()),
        })
    }
}

pub const ADJUSTED_THUMBNAIL_IDLE_DELAY: Duration = Duration::from_millis(1_500);

#[derive(Clone, Copy)]
struct PendingAdjustedThumbnail {
    ready_at: Instant,
    token: ThumbnailRevision,
    sequence: u64,
}

struct AdjustedThumbnailQueueState {
    pending: HashMap<String, PendingAdjustedThumbnail>,
    latest_revision: HashMap<String, u64>,
    epoch: u64,
    last_editor_activity: Instant,
    next_sequence: u64,
}

impl AdjustedThumbnailQueueState {
    fn new(now: Instant) -> Self {
        Self {
            pending: HashMap::new(),
            latest_revision: HashMap::new(),
            epoch: 0,
            last_editor_activity: now,
            next_sequence: 0,
        }
    }

    fn invalidate(&mut self, path: &str) -> ThumbnailRevision {
        let revision = self
            .latest_revision
            .get(path)
            .copied()
            .unwrap_or(0)
            .wrapping_add(1);
        self.latest_revision.insert(path.to_string(), revision);
        self.pending.remove(path);
        ThumbnailRevision {
            epoch: self.epoch,
            revision,
        }
    }

    fn arm_deferred(&mut self, path: String, token: ThumbnailRevision, now: Instant) {
        if self.snapshot(&path) != token {
            return;
        }
        self.next_sequence = self.next_sequence.wrapping_add(1);
        self.pending.insert(
            path,
            PendingAdjustedThumbnail {
                ready_at: now + ADJUSTED_THUMBNAIL_IDLE_DELAY,
                token,
                sequence: self.next_sequence,
            },
        );
    }

    fn schedule(&mut self, path: String, now: Instant) -> ThumbnailRevision {
        let token = self.invalidate(&path);
        self.arm_deferred(path, token, now);
        token
    }

    fn note_editor_activity(&mut self, now: Instant) {
        self.last_editor_activity = now;
    }

    fn take_ready(&mut self, now: Instant) -> Option<AdjustedThumbnailJob> {
        if now < self.last_editor_activity + ADJUSTED_THUMBNAIL_IDLE_DELAY {
            return None;
        }

        let (path, pending) = self
            .pending
            .iter()
            .filter(|(_, job)| job.ready_at <= now)
            .max_by_key(|(_, job)| job.sequence)
            .map(|(path, job)| (path.clone(), *job))?;
        self.pending.remove(&path);
        Some(AdjustedThumbnailJob {
            path,
            token: pending.token,
            sequence: pending.sequence,
        })
    }

    fn wait_duration(&self, now: Instant) -> Option<Duration> {
        let earliest_job = self.pending.values().map(|job| job.ready_at).min()?;
        let editor_idle_at = self.last_editor_activity + ADJUSTED_THUMBNAIL_IDLE_DELAY;
        let wake_at = earliest_job.max(editor_idle_at);
        Some(wake_at.saturating_duration_since(now))
    }

    fn is_current(&self, job: &AdjustedThumbnailJob) -> bool {
        self.snapshot(&job.path) == job.token
    }

    fn snapshot(&self, path: &str) -> ThumbnailRevision {
        ThumbnailRevision {
            epoch: self.epoch,
            revision: self.latest_revision.get(path).copied().unwrap_or(0),
        }
    }

    fn requeue(&mut self, job: &AdjustedThumbnailJob, now: Instant, delay: Duration) {
        if self.is_current(job) {
            self.pending.insert(
                job.path.clone(),
                PendingAdjustedThumbnail {
                    ready_at: now + delay,
                    token: job.token,
                    sequence: job.sequence,
                },
            );
        }
    }

    fn cancel_all(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.pending.clear();
        self.latest_revision.clear();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThumbnailRevision {
    epoch: u64,
    revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdjustedThumbnailJob {
    path: String,
    token: ThumbnailRevision,
    sequence: u64,
}

impl AdjustedThumbnailJob {
    pub fn path(&self) -> &str {
        &self.path
    }
}

pub struct AdjustedThumbnailManager {
    state: Mutex<AdjustedThumbnailQueueState>,
    cvar: Condvar,
}

impl AdjustedThumbnailManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(AdjustedThumbnailQueueState::new(Instant::now())),
            cvar: Condvar::new(),
        })
    }

    pub fn schedule(&self, path: String) {
        self.state.lock().unwrap().schedule(path, Instant::now());
        self.cvar.notify_one();
    }

    pub fn invalidate(&self, path: &str) -> ThumbnailRevision {
        let token = self.state.lock().unwrap().invalidate(path);
        self.cvar.notify_all();
        token
    }

    pub fn arm_deferred(&self, path: String, token: ThumbnailRevision) {
        self.state
            .lock()
            .unwrap()
            .arm_deferred(path, token, Instant::now());
        self.cvar.notify_one();
    }

    pub fn note_editor_activity(&self) {
        self.state
            .lock()
            .unwrap()
            .note_editor_activity(Instant::now());
        self.cvar.notify_all();
    }

    pub fn wait_for_ready(&self) -> AdjustedThumbnailJob {
        let mut state = self.state.lock().unwrap();
        loop {
            let now = Instant::now();
            if let Some(path) = state.take_ready(now) {
                return path;
            }

            state = if let Some(wait_duration) = state.wait_duration(now) {
                self.cvar.wait_timeout(state, wait_duration).unwrap().0
            } else {
                self.cvar.wait(state).unwrap()
            };
        }
    }

    pub fn is_current(&self, job: &AdjustedThumbnailJob) -> bool {
        self.state.lock().unwrap().is_current(job)
    }

    pub fn snapshot_revision(&self, path: &str) -> ThumbnailRevision {
        self.state.lock().unwrap().snapshot(path)
    }

    pub fn revision_is_current(&self, path: &str, revision: ThumbnailRevision) -> bool {
        self.snapshot_revision(path) == revision
    }

    pub fn requeue(&self, job: &AdjustedThumbnailJob, delay: Duration) {
        self.state
            .lock()
            .unwrap()
            .requeue(job, Instant::now(), delay);
        self.cvar.notify_one();
    }

    pub fn cancel_all(&self) {
        self.state.lock().unwrap().cancel_all();
        self.cvar.notify_all();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum GpuWorkPriority {
    Export,
    Background,
    VisibleThumbnail,
    SelectedThumbnail,
    Interactive,
}

impl GpuWorkPriority {
    const COUNT: usize = 5;

    fn index(self) -> usize {
        self as usize
    }
}

struct GpuWorkQueueState {
    active: bool,
    waiting: [usize; GpuWorkPriority::COUNT],
}

impl GpuWorkQueueState {
    fn can_acquire(&self, priority: GpuWorkPriority) -> bool {
        !self.active
            && self.waiting[(priority.index() + 1)..]
                .iter()
                .all(|count| *count == 0)
    }
}

pub struct GpuWorkScheduler {
    state: Mutex<GpuWorkQueueState>,
    cvar: Condvar,
}

impl GpuWorkScheduler {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(GpuWorkQueueState {
                active: false,
                waiting: [0; GpuWorkPriority::COUNT],
            }),
            cvar: Condvar::new(),
        })
    }

    pub fn ticket(self: &Arc<Self>, priority: GpuWorkPriority) -> GpuWorkTicket {
        let priority_index = priority.index();
        self.state.lock().unwrap().waiting[priority_index] += 1;
        self.cvar.notify_all();
        GpuWorkTicket {
            scheduler: Some(Arc::clone(self)),
            priority,
        }
    }

    pub fn acquire(self: &Arc<Self>, priority: GpuWorkPriority) -> GpuWorkPermit {
        self.ticket(priority).acquire()
    }
}

pub struct GpuWorkTicket {
    scheduler: Option<Arc<GpuWorkScheduler>>,
    priority: GpuWorkPriority,
}

impl GpuWorkTicket {
    pub fn acquire(mut self) -> GpuWorkPermit {
        let scheduler = self.scheduler.take().unwrap();
        let priority_index = self.priority.index();
        let mut state = scheduler.state.lock().unwrap();

        while !state.can_acquire(self.priority) {
            state = scheduler.cvar.wait(state).unwrap();
        }

        state.waiting[priority_index] -= 1;
        state.active = true;
        drop(state);
        GpuWorkPermit { scheduler }
    }
}

impl Drop for GpuWorkTicket {
    fn drop(&mut self) {
        if let Some(scheduler) = self.scheduler.take() {
            let mut state = scheduler.state.lock().unwrap();
            state.waiting[self.priority.index()] -= 1;
            drop(state);
            scheduler.cvar.notify_all();
        }
    }
}

pub struct GpuWorkPermit {
    scheduler: Arc<GpuWorkScheduler>,
}

impl Drop for GpuWorkPermit {
    fn drop(&mut self) {
        let mut state = self.scheduler.state.lock().unwrap();
        state.active = false;
        drop(state);
        self.scheduler.cvar.notify_all();
    }
}

pub type ThumbnailGeometryEntry = (u64, Arc<DynamicImage>, f32);
pub type TransformedImageCache = (u64, Arc<DynamicImage>, (f32, f32));

pub struct AppState {
    pub window_setup_complete: AtomicBool,
    pub gpu_crash_flag_path: Mutex<Option<PathBuf>>,
    pub original_image: Mutex<Option<LoadedImage>>,
    pub cached_preview: Mutex<Option<CachedPreview>>,
    pub gpu_context: Mutex<Option<GpuContext>>,
    pub gpu_image_cache: Mutex<Option<GpuImageCache>>,
    pub gpu_processor: Mutex<Option<GpuProcessorState>>,
    pub ai_state: Mutex<Option<AiState>>,
    pub ai_init_lock: TokioMutex<()>,
    pub export_task_token: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    pub hdr_result: Arc<Mutex<Option<DynamicImage>>>,
    pub panorama_result: Arc<Mutex<Option<DynamicImage>>>,
    pub focus_stack_result: Arc<Mutex<Option<DynamicImage>>>,
    pub denoise_result: Arc<Mutex<Option<DynamicImage>>>,
    pub indexing_task_handle: Mutex<Option<JoinHandle<()>>>,
    pub lut_cache: Mutex<HashMap<String, Arc<Lut>>>,
    pub initial_file_path: Mutex<Option<String>>,
    pub pending_edit_session: Mutex<Option<ExternalEditSession>>,
    pub thumbnail_cancellation_token: Arc<AtomicBool>,
    pub thumbnail_progress: Mutex<ThumbnailProgressTracker>,
    pub preview_worker_tx: Mutex<Option<Sender<PreviewJob>>>,
    pub analytics_worker_tx: Mutex<Option<Sender<AnalyticsJob>>>,
    pub mask_cache: Mutex<HashMap<u64, GrayImage>>,
    pub patch_cache: Mutex<HashMap<String, serde_json::Value>>,
    pub geometry_cache: Mutex<HashMap<u64, DynamicImage>>,
    pub thumbnail_geometry_cache: Mutex<HashMap<String, ThumbnailGeometryEntry>>,
    pub lens_db: Mutex<Option<Arc<LensDatabase>>>,
    pub load_image_generation: Arc<AtomicUsize>,
    pub full_warped_cache: Mutex<Option<(u64, Arc<DynamicImage>)>>,
    pub full_transformed_cache: Mutex<Option<TransformedImageCache>>,
    pub decoded_image_cache: Mutex<DecodedImageCache>,
    pub thumbnail_manager: Arc<ThumbnailManager>,
    pub adjusted_thumbnail_manager: Arc<AdjustedThumbnailManager>,
    pub metadata_manager: Arc<MetadataManager>,
    pub gpu_work_scheduler: Arc<GpuWorkScheduler>,
    pub disks_cache: Mutex<Option<Disks>>,
    pub disks_cache_refreshing: AtomicBool,
    pub camera_session: Mutex<CameraSession>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn adjusted_thumbnail_saves_coalesce_by_path() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);

        state.schedule("one.raw".to_string(), now);
        state.schedule("one.raw".to_string(), now + Duration::from_millis(250));

        assert_eq!(state.pending.len(), 1);
        assert!(
            state
                .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY)
                .is_none()
        );
        let job = state
            .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY + Duration::from_millis(250))
            .unwrap();
        assert_eq!(job.path(), "one.raw");
    }

    #[test]
    fn editor_activity_postpones_adjusted_thumbnail_work() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        state.schedule("one.raw".to_string(), now);
        state.note_editor_activity(now + Duration::from_millis(1_000));

        assert!(
            state
                .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY)
                .is_none()
        );
        let job = state
            .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY + Duration::from_millis(1_000))
            .unwrap();
        assert_eq!(job.path(), "one.raw");
    }

    #[test]
    fn newest_ready_adjusted_thumbnail_runs_first() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        state.schedule("older.raw".to_string(), now);
        state.schedule("selected.raw".to_string(), now + Duration::from_millis(10));

        let job = state
            .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY + Duration::from_millis(10))
            .unwrap();
        assert_eq!(job.path(), "selected.raw");
    }

    #[test]
    fn virtual_copy_thumbnail_revisions_are_independent() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        let base_revision = state.schedule("one.raw".to_string(), now);
        let copy_revision = state.schedule("one.raw?vc=copy".to_string(), now);

        state.schedule("one.raw".to_string(), now + Duration::from_millis(1));

        assert_ne!(state.snapshot("one.raw"), base_revision);
        assert_eq!(state.snapshot("one.raw?vc=copy"), copy_revision);
    }

    #[test]
    fn newer_save_invalidates_an_inflight_adjusted_thumbnail() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        state.schedule("one.raw".to_string(), now);
        let inflight = state
            .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY)
            .unwrap();

        state.schedule(
            "one.raw".to_string(),
            now + ADJUSTED_THUMBNAIL_IDLE_DELAY + Duration::from_millis(1),
        );

        assert!(!state.is_current(&inflight));
        assert_eq!(state.pending.len(), 1);
    }

    #[test]
    fn cancellation_invalidates_pending_and_inflight_jobs() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        state.schedule("one.raw".to_string(), now);
        let inflight = state
            .take_ready(now + ADJUSTED_THUMBNAIL_IDLE_DELAY)
            .unwrap();
        state.schedule("two.raw".to_string(), now);

        state.cancel_all();

        assert!(!state.is_current(&inflight));
        assert!(state.pending.is_empty());
    }

    #[test]
    fn cancellation_invalidates_unedited_visible_thumbnail_tokens() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        let visible_worker_token = state.snapshot("never-edited.raw");

        state.cancel_all();

        assert_ne!(state.snapshot("never-edited.raw"), visible_worker_token);
    }

    #[test]
    fn invalidation_precedes_persistence_and_arming() {
        let now = Instant::now();
        let mut state = AdjustedThumbnailQueueState::new(now);
        let old_visible_worker_token = state.snapshot("one.raw");
        let save_token = state.invalidate("one.raw");

        assert_ne!(state.snapshot("one.raw"), old_visible_worker_token);
        assert!(state.pending.is_empty());

        state.arm_deferred("one.raw".to_string(), save_token, now);
        assert_eq!(state.pending.len(), 1);
    }

    #[test]
    fn gpu_scheduler_prefers_higher_waiting_priorities() {
        let mut state = GpuWorkQueueState {
            active: false,
            waiting: [0; GpuWorkPriority::COUNT],
        };
        state.waiting[GpuWorkPriority::VisibleThumbnail.index()] = 1;
        state.waiting[GpuWorkPriority::Interactive.index()] = 1;

        assert!(!state.can_acquire(GpuWorkPriority::VisibleThumbnail));
        assert!(state.can_acquire(GpuWorkPriority::Interactive));
    }

    #[test]
    fn queued_interactive_ticket_acquires_before_background() {
        let scheduler = GpuWorkScheduler::new();
        let initial_permit = scheduler.acquire(GpuWorkPriority::Background);
        let background_ticket = scheduler.ticket(GpuWorkPriority::Background);
        let interactive_ticket = scheduler.ticket(GpuWorkPriority::Interactive);
        let (acquired_tx, acquired_rx) = mpsc::channel();

        let background_tx = acquired_tx.clone();
        let background_thread = std::thread::spawn(move || {
            let _permit = background_ticket.acquire();
            background_tx.send("background").unwrap();
        });
        let interactive_thread = std::thread::spawn(move || {
            let _permit = interactive_ticket.acquire();
            acquired_tx.send("interactive").unwrap();
        });

        drop(initial_permit);

        assert_eq!(
            acquired_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            "interactive"
        );
        interactive_thread.join().unwrap();
        background_thread.join().unwrap();
    }
}
