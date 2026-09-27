use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Instant;

use image::DynamicImage;
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
    pub generation: usize,
    pub input_revision: Option<u64>,
    pub render_attempt: Option<u64>,
    pub quality_tier: Option<String>,
    pub queued_at: Instant,
    pub adjustments: serde_json::Value,
    pub is_interactive: bool,
    pub compare_original: bool,
    pub target_resolution: Option<u32>,
    pub roi: Option<(f32, f32, f32, f32)>,
    pub request_analytics: bool,
    pub compute_waveform: bool,
    pub active_waveform_channel: Option<String>,
    pub responder: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
}

pub struct AnalyticsJob {
    pub generation: usize,
    pub input_revision: Option<u64>,
    pub render_attempt: Option<u64>,
    pub quality_tier: Option<String>,
    pub path: String,
    pub image: Arc<DynamicImage>,
    pub compute_waveform: bool,
    pub active_waveform_channel: Option<String>,
}

pub struct AnalyticsConfig {
    pub generation: usize,
    pub input_revision: Option<u64>,
    pub render_attempt: Option<u64>,
    pub quality_tier: Option<String>,
    pub path: String,
    pub compute_waveform: bool,
    pub active_waveform_channel: Option<String>,
    pub sender: Sender<AnalyticsJob>,
}

pub const PREVIEW_SUPERSEDED: &str = "PREVIEW_SUPERSEDED";
pub const DEFAULT_PREVIEW_ASSET_CACHE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAssetCacheUsage {
    pub retained_bytes: usize,
    pub budget_bytes: usize,
    pub entries: usize,
    pub cache_epoch: u64,
}

/// Encoded transported assets are session-scoped. Requests own cloned values
/// after hydration, so an eviction cannot invalidate an in-flight render.
pub struct PreviewAssetCache {
    entries: VecDeque<(String, HashMap<String, serde_json::Value>, usize)>,
    bytes: usize,
    max_bytes: usize,
    epoch: u64,
}

impl PreviewAssetCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            max_bytes,
            epoch: 0,
        }
    }

    fn entry_bytes(key: &str, fields: &HashMap<String, serde_json::Value>) -> usize {
        // JSON length counts escaped encoded data. A fixed allowance covers
        // the entry and string allocation overhead without double counting a
        // request-owned clone as retained cache bytes.
        fields
            .iter()
            .fold(key.len().saturating_add(64), |bytes, (field, value)| {
                bytes
                    .saturating_add(field.len())
                    .saturating_add(serde_json::to_vec(value).map_or(0, |v| v.len()))
                    .saturating_add(16)
            })
    }

    pub fn get_field(&mut self, key: &str, field: &str) -> Option<serde_json::Value> {
        let index = self.entries.iter().position(|(k, _, _)| k == key)?;
        let entry = self.entries.remove(index)?;
        let value = entry.1.get(field).cloned();
        self.entries.push_back(entry);
        value
    }

    pub fn insert_group(
        &mut self,
        key: String,
        incoming_fields: HashMap<String, serde_json::Value>,
    ) -> bool {
        if let Some(index) = self.entries.iter().position(|(k, _, _)| k == &key) {
            let (_, _, old_bytes) = self.entries.remove(index).unwrap();
            self.bytes -= old_bytes;
            self.epoch = self.epoch.wrapping_add(1);
        }
        let fields = incoming_fields;
        let bytes = Self::entry_bytes(&key, &fields);
        if bytes > self.max_bytes {
            return false;
        }
        while self.bytes.saturating_add(bytes) > self.max_bytes {
            let Some((_, _, old_bytes)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old_bytes;
            self.epoch = self.epoch.wrapping_add(1);
        }
        self.bytes += bytes;
        self.entries.push_back((key, fields, bytes));
        true
    }

    #[cfg(test)]
    fn insert_field(&mut self, key: String, field: String, value: serde_json::Value) -> bool {
        self.insert_group(key, HashMap::from([(field, value)]))
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.epoch = self.epoch.wrapping_add(1);
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn usage(&self) -> PreviewAssetCacheUsage {
        PreviewAssetCacheUsage {
            retained_bytes: self.bytes,
            budget_bytes: self.max_bytes,
            entries: self.entries.len(),
            cache_epoch: self.epoch,
        }
    }

    pub fn retained_keys(&self, keys: &[String]) -> Vec<String> {
        keys.iter()
            .filter(|key| {
                let mask_position = key.rfind(":mask:");
                let patch_position = key.rfind(":patch:");
                let group = if mask_position.is_some_and(|m| patch_position.is_none_or(|p| m > p)) {
                    format!("mask:{key}")
                } else if patch_position.is_some() {
                    format!("patch:{key}")
                } else {
                    return self.entries.iter().any(|(stored, _, _)| {
                        stored == &format!("mask:{key}") || stored == &format!("patch:{key}")
                    });
                };
                self.entries.iter().any(|(stored, _, _)| stored == &group)
            })
            .cloned()
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewLane {
    Main,
    Overlay,
    Uncropped,
}

impl PreviewLane {
    fn index(self) -> usize {
        match self {
            Self::Main => 0,
            Self::Overlay => 1,
            Self::Uncropped => 2,
        }
    }
}

impl std::str::FromStr for PreviewLane {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "main" => Ok(Self::Main),
            "overlay" => Ok(Self::Overlay),
            "uncropped" => Ok(Self::Uncropped),
            _ => Err(format!("Unknown preview lane: {value}")),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PreviewIdentity {
    pub generation: usize,
    pub lane: PreviewLane,
    pub revision: Option<u64>,
}

#[derive(Default)]
struct PreviewIntentState {
    generation: usize,
    revisions: [u64; 3],
}

pub struct PreviewCancellation<'a> {
    pub state: &'a AppState,
    pub identity: PreviewIdentity,
}

impl PreviewCancellation<'_> {
    pub fn check(&self) -> Result<(), String> {
        self.state.ensure_preview_identity(self.identity)
    }

    /// Reject an obsolete preview before entering its next expensive stage.
    /// Work already inside the stage still relies on its own checkpoints.
    pub fn run_stage_if_current<T>(
        &self,
        stage: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.check()?;
        stage()
    }
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
    pub mask_cache: Mutex<crate::cache_utils::MaskBitmapCache<u64>>,
    pub patch_cache: Mutex<PreviewAssetCache>,
    pub geometry_cache: Mutex<HashMap<u64, DynamicImage>>,
    pub thumbnail_geometry_cache: Mutex<HashMap<String, ThumbnailGeometryEntry>>,
    pub lens_db: Mutex<Option<Arc<LensDatabase>>>,
    pub preview_session_gate: RwLock<()>,
    pub load_image_generation: Arc<AtomicUsize>,
    preview_intents: Mutex<PreviewIntentState>,
    pub full_warped_cache: Mutex<Option<(u64, Arc<DynamicImage>)>>,
    pub patched_warped_cache: Mutex<Option<(u64, Arc<DynamicImage>)>>,
    pub full_transformed_cache: Mutex<Option<TransformedImageCache>>,
    pub decoded_image_cache: Mutex<DecodedImageCache>,
    pub thumbnail_manager: Arc<ThumbnailManager>,
    pub metadata_manager: Arc<MetadataManager>,
    pub disks_cache: Mutex<Option<Disks>>,
    pub disks_cache_refreshing: AtomicBool,
    pub camera_session: Mutex<CameraSession>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            window_setup_complete: AtomicBool::new(false),
            gpu_crash_flag_path: Mutex::new(None),
            original_image: Mutex::new(None),
            cached_preview: Mutex::new(None),
            gpu_context: Mutex::new(None),
            gpu_image_cache: Mutex::new(None),
            gpu_processor: Mutex::new(None),
            ai_state: Mutex::new(None),
            ai_init_lock: TokioMutex::new(()),
            export_task_token: Arc::new(Mutex::new(None)),
            hdr_result: Arc::new(Mutex::new(None)),
            panorama_result: Arc::new(Mutex::new(None)),
            focus_stack_result: Arc::new(Mutex::new(None)),
            denoise_result: Arc::new(Mutex::new(None)),
            indexing_task_handle: Mutex::new(None),
            lut_cache: Mutex::new(HashMap::new()),
            initial_file_path: Mutex::new(None),
            pending_edit_session: Mutex::new(None),
            thumbnail_cancellation_token: Arc::new(AtomicBool::new(false)),
            thumbnail_progress: Mutex::new(ThumbnailProgressTracker {
                total: 0,
                completed: 0,
            }),
            preview_worker_tx: Mutex::new(None),
            analytics_worker_tx: Mutex::new(None),
            mask_cache: Mutex::new(crate::cache_utils::MaskBitmapCache::new(128 * 1024 * 1024)),
            patch_cache: Mutex::new(PreviewAssetCache::new(DEFAULT_PREVIEW_ASSET_CACHE_BYTES)),
            geometry_cache: Mutex::new(HashMap::new()),
            thumbnail_geometry_cache: Mutex::new(HashMap::new()),
            lens_db: Mutex::new(None),
            preview_session_gate: RwLock::new(()),
            load_image_generation: Arc::new(AtomicUsize::new(0)),
            preview_intents: Mutex::new(PreviewIntentState::default()),
            full_warped_cache: Mutex::new(None),
            patched_warped_cache: Mutex::new(None),
            full_transformed_cache: Mutex::new(None),
            decoded_image_cache: Mutex::new(DecodedImageCache::new(5)),
            thumbnail_manager: ThumbnailManager::new(),
            metadata_manager: MetadataManager::new(),
            disks_cache: Mutex::new(None),
            disks_cache_refreshing: AtomicBool::new(false),
            camera_session: Mutex::new(CameraSession::new()),
        }
    }
}

impl AppState {
    /// Advance the source generation under the same short lock used for final
    /// display publication. An old intent cannot reset the new source's lane.
    pub fn begin_preview_generation(&self) -> usize {
        let mut intents = self
            .preview_intents
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let generation = self.load_image_generation.fetch_add(1, Ordering::SeqCst) + 1;
        *intents = PreviewIntentState {
            generation,
            revisions: [0; 3],
        };
        generation
    }

    /// The intent signal never takes the session gate or GPU processor lock.
    /// Both signals and queued work use max semantics, so reordered IPC cannot
    /// move a lane backward. A late signal from an old photo is rejected.
    pub fn register_preview_intent(&self, identity: PreviewIdentity) -> Result<(), String> {
        let mut intents = self
            .preview_intents
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.load_image_generation.load(Ordering::SeqCst) != identity.generation {
            return Err(PREVIEW_SUPERSEDED.into());
        }
        if intents.generation != identity.generation {
            *intents = PreviewIntentState {
                generation: identity.generation,
                revisions: [0; 3],
            };
        }
        if let Some(revision) = identity.revision {
            let current = &mut intents.revisions[identity.lane.index()];
            if revision < *current {
                return Err(PREVIEW_SUPERSEDED.into());
            }
            *current = revision;
        }
        Ok(())
    }

    pub fn ensure_preview_identity(&self, identity: PreviewIdentity) -> Result<(), String> {
        let intents = self
            .preview_intents
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.ensure_preview_identity_locked(identity, &intents)
    }

    fn ensure_preview_identity_locked(
        &self,
        identity: PreviewIdentity,
        intents: &PreviewIntentState,
    ) -> Result<(), String> {
        if self.load_image_generation.load(Ordering::SeqCst) != identity.generation
            || identity.revision.is_some_and(|revision| {
                intents.generation == identity.generation
                    && intents.revisions[identity.lane.index()] != revision
            })
        {
            return Err(PREVIEW_SUPERSEDED.into());
        }
        Ok(())
    }

    /// Keep a current frame's final GPU copy and surface submission atomic
    /// with intent changes. The closure must be short and must not wait for
    /// the GPU or acquire the session gate.
    pub fn with_current_preview_identity<T>(
        &self,
        identity: PreviewIdentity,
        publish: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let intents = self
            .preview_intents
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.ensure_preview_identity_locked(identity, &intents)?;
        Ok(publish())
    }
}

/// Must be checked while holding preview_session_gate before reading or writing session caches.
pub fn ensure_preview_generation(state: &AppState, expected: usize) -> Result<(), String> {
    if state
        .load_image_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        != expected
    {
        return Err(PREVIEW_SUPERSEDED.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod preview_session_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn switching_invalidates_queued_work_before_cache_clear_and_blocks_old_cache_writers() {
        let state = AppState::default();
        state.load_image_generation.store(1, Ordering::SeqCst);
        let render = state.preview_session_gate.read().unwrap();
        assert!(ensure_preview_generation(&state, 1).is_ok());
        state.load_image_generation.fetch_add(1, Ordering::SeqCst);
        assert!(ensure_preview_generation(&state, 1).is_err());
        assert!(state.preview_session_gate.try_write().is_err());
        state.patch_cache.lock().unwrap().insert_field(
            "patch:old".into(),
            "patchData".into(),
            serde_json::json!("pixels"),
        );
        drop(render);
        let _reset = state.preview_session_gate.write().unwrap();
        state.patch_cache.lock().unwrap().clear();
        assert!(ensure_preview_generation(&state, 2).is_ok());
        assert!(state.patch_cache.lock().unwrap().is_empty());
        // A -> B -> A still has a distinct generation.
        state.load_image_generation.fetch_add(1, Ordering::SeqCst);
        assert!(ensure_preview_generation(&state, 1).is_err());
        assert!(ensure_preview_generation(&state, 2).is_err());
    }

    #[test]
    fn intent_revisions_advance_per_lane_without_rollback() {
        let state = AppState::default();
        let generation = state.begin_preview_generation();
        let main = |revision| PreviewIdentity {
            generation,
            lane: PreviewLane::Main,
            revision: Some(revision),
        };
        let overlay = PreviewIdentity {
            generation,
            lane: PreviewLane::Overlay,
            revision: Some(1),
        };

        state.register_preview_intent(main(3)).unwrap();
        assert_eq!(
            state.register_preview_intent(main(2)).unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        state.register_preview_intent(main(3)).unwrap();
        state.register_preview_intent(overlay).unwrap();
        assert!(state.ensure_preview_identity(main(3)).is_ok());
        assert!(state.ensure_preview_identity(overlay).is_ok());
        assert_eq!(
            state.ensure_preview_identity(main(2)).unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        state.register_preview_intent(main(4)).unwrap();
        assert_eq!(
            state.ensure_preview_identity(main(3)).unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        assert!(state.ensure_preview_identity(overlay).is_ok());
    }

    #[test]
    fn a_late_old_photo_intent_cannot_cancel_the_new_photo() {
        let state = AppState::default();
        let first = state.begin_preview_generation();
        let old = PreviewIdentity {
            generation: first,
            lane: PreviewLane::Main,
            revision: Some(100),
        };
        state.register_preview_intent(old).unwrap();
        let next = state.begin_preview_generation();
        let current = PreviewIdentity {
            generation: next,
            lane: PreviewLane::Main,
            revision: Some(1),
        };
        state.register_preview_intent(current).unwrap();
        assert_eq!(
            state.register_preview_intent(old).unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        assert!(state.ensure_preview_identity(current).is_ok());
        assert_eq!(
            state.with_current_preview_identity(old, || ()).unwrap_err(),
            PREVIEW_SUPERSEDED
        );
    }

    #[test]
    fn publication_checks_intent_again_at_the_final_boundary() {
        let state = AppState::default();
        let generation = state.begin_preview_generation();
        let old = PreviewIdentity {
            generation,
            lane: PreviewLane::Main,
            revision: Some(1),
        };
        let new = PreviewIdentity {
            revision: Some(2),
            ..old
        };
        state.register_preview_intent(old).unwrap();
        assert!(state.ensure_preview_identity(old).is_ok());
        state.register_preview_intent(new).unwrap();
        let mut published = false;
        assert_eq!(
            state
                .with_current_preview_identity(old, || published = true)
                .unwrap_err(),
            PREVIEW_SUPERSEDED
        );
        assert!(!published);
        state
            .with_current_preview_identity(new, || published = true)
            .unwrap();
        assert!(published);
    }

    #[test]
    fn new_intent_cancels_a_worker_blocked_on_the_session_gate() {
        let state = Arc::new(AppState::default());
        let generation = state.begin_preview_generation();
        let old = PreviewIdentity {
            generation,
            lane: PreviewLane::Main,
            revision: Some(1),
        };
        state.register_preview_intent(old).unwrap();
        let gate = state.preview_session_gate.write().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _session = worker_state.preview_session_gate.read().unwrap();
            result_tx
                .send(worker_state.ensure_preview_identity(old))
                .unwrap();
        });
        started_rx.recv().unwrap();
        state
            .register_preview_intent(PreviewIdentity {
                revision: Some(2),
                ..old
            })
            .unwrap();
        drop(gate);
        assert_eq!(result_rx.recv().unwrap().unwrap_err(), PREVIEW_SUPERSEDED);
        worker.join().unwrap();
    }

    #[test]
    fn new_intent_at_pre_gpu_checkpoint_skips_old_stage_and_runs_new_stage() {
        let state = Arc::new(AppState::default());
        let generation = state.begin_preview_generation();
        let old = PreviewIdentity {
            generation,
            lane: PreviewLane::Main,
            revision: Some(1),
        };
        let new = PreviewIdentity {
            revision: Some(2),
            ..old
        };
        state.register_preview_intent(old).unwrap();

        let (at_checkpoint_tx, at_checkpoint_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let worker_state = Arc::clone(&state);
        let old_worker = std::thread::spawn(move || {
            let cancellation = PreviewCancellation {
                state: &worker_state,
                identity: old,
            };
            at_checkpoint_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            let mut entered_gpu_stage = false;
            let result = cancellation.run_stage_if_current(|| {
                entered_gpu_stage = true;
                Ok(1_u8)
            });
            (result, entered_gpu_stage)
        });

        at_checkpoint_rx.recv().unwrap();
        state.register_preview_intent(new).unwrap();
        resume_tx.send(()).unwrap();

        let newer = PreviewCancellation {
            state: &state,
            identity: new,
        };
        let mut entered_new_gpu_stage = false;
        let new_result = newer.run_stage_if_current(|| {
            entered_new_gpu_stage = true;
            Ok(2_u8)
        });
        let (old_result, entered_old_gpu_stage) = old_worker.join().unwrap();
        assert_eq!(old_result.unwrap_err(), PREVIEW_SUPERSEDED);
        assert!(!entered_old_gpu_stage);
        assert_eq!(new_result.unwrap(), 2);
        assert!(entered_new_gpu_stage);
    }
}

#[cfg(test)]
mod preview_asset_cache_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cache_evicts_least_recent_entries_with_exact_byte_accounting() {
        let small = json!("ABCD");
        let fields = HashMap::from([("patchData".to_string(), small.clone())]);
        let one = PreviewAssetCache::entry_bytes("one", &fields);
        let two = PreviewAssetCache::entry_bytes("two", &fields);
        let mut cache = PreviewAssetCache::new(one + two);
        assert!(cache.insert_field("one".into(), "patchData".into(), small.clone()));
        assert!(cache.insert_field("two".into(), "patchData".into(), small.clone()));
        assert_eq!(cache.bytes, one + two);
        assert_eq!(cache.get_field("one", "patchData"), Some(small.clone()));
        assert!(cache.insert_field("tri".into(), "patchData".into(), small.clone()));
        assert_eq!(cache.get_field("two", "patchData"), None);
        assert_eq!(cache.get_field("one", "patchData"), Some(small.clone()));
        assert_eq!(cache.get_field("tri", "patchData"), Some(small));
        assert!(cache.bytes <= cache.max_bytes);
        assert_eq!(cache.epoch(), 1);
    }

    #[test]
    fn oversized_and_replaced_assets_are_not_falsely_retained() {
        let small = json!("a");
        let fields = HashMap::from([("patchData".to_string(), small.clone())]);
        let budget = PreviewAssetCache::entry_bytes("patch:key", &fields);
        let mut cache = PreviewAssetCache::new(budget);
        assert!(cache.insert_field("patch:key".into(), "patchData".into(), small));
        let old_epoch = cache.epoch();
        assert!(!cache.insert_field(
            "patch:key".into(),
            "patchData".into(),
            json!("longer than the budget")
        ));
        assert_eq!(cache.get_field("patch:key", "patchData"), None);
        assert_eq!(cache.bytes, 0);
        assert!(cache.epoch() > old_epoch);
        assert!(cache.retained_keys(&["key".into()]).is_empty());
        cache.clear();
        assert!(cache.epoch() > old_epoch);
    }
}
