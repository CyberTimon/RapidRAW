use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai_commands::{self, MaskTransform};
use crate::ai_denoise::DenoiseMethod;
use crate::ai_processing::{AiDepthMaskParameters, AiMaskModel, get_or_init_ai_models};
use crate::app_state::AppState;
use crate::cache_utils::GEOMETRY_KEYS;
use crate::effect_maps::{EffectMapKind, is_map_reference, is_map_valid_for};
use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::image_processing::is_effect_enabled;

const JOURNAL_FILE: &str = "ai_jobs.json";
const MAX_ATTEMPTS: u32 = 3;
const SOURCE_ID_SAMPLE_BYTES: u64 = 64 * 1024;
const MASK_DATA_KEYS: [&str; 2] = ["maskDataBase64", "mask_data_base64"];
const AI_SOURCE_KEY: &str = "aiSource";
const TEXT_PROMPT_KEY: &str = "prompt";
const FACE_PARTS_KEY: &str = "parts";
const SUBJECT_BOX_KEYS: [&str; 4] = ["startX", "startY", "endX", "endY"];
const MASK_RESULT_KEYS: [&str; 6] = [
    "maskDataBase64",
    "aiSource",
    "rotation",
    "flipHorizontal",
    "flipVertical",
    "orientationSteps",
];
const SUBJECT_RESULT_KEYS: [&str; 6] = [
    "startX",
    "startY",
    "endX",
    "endY",
    "boxSpaceWidth",
    "boxSpaceHeight",
];

type SourceIdCache = HashMap<PathBuf, (u64, u128, String)>;

static SOURCE_IDS: LazyLock<Mutex<SourceIdCache>> = LazyLock::new(Default::default);

pub fn source_id(source_path: &Path) -> Option<String> {
    let meta = fs::metadata(source_path).ok()?;
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();

    let ids = SOURCE_IDS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached_len, cached_mtime, id)) = ids.get(source_path)
        && (*cached_len, *cached_mtime) == (len, mtime)
    {
        return Some(id.clone());
    }
    drop(ids);

    let mut file = fs::File::open(source_path).ok()?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&len.to_le_bytes());
    let mut head = Vec::new();
    (&mut file)
        .take(SOURCE_ID_SAMPLE_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    hasher.update(&head);
    if len > SOURCE_ID_SAMPLE_BYTES * 2 {
        let mut tail = Vec::new();
        file.seek(SeekFrom::End(-(SOURCE_ID_SAMPLE_BYTES as i64)))
            .ok()?;
        file.read_to_end(&mut tail).ok()?;
        hasher.update(&tail);
    }
    let id = hasher.finalize().to_hex()[..32].to_string();

    SOURCE_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(source_path.to_path_buf(), (len, mtime, id.clone()));
    Some(id)
}

pub fn source_id_for(path: &str) -> Option<String> {
    source_id(&parse_virtual_path(path).0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MaskKind {
    Foreground,
    Sky,
    Text,
    Face,
    Depth,
    Subject,
}

impl MaskKind {
    fn from_type(mask_type: &str) -> Option<Self> {
        match mask_type {
            "ai-foreground" => Some(MaskKind::Foreground),
            "ai-sky" => Some(MaskKind::Sky),
            "ai-text" => Some(MaskKind::Text),
            "ai-face" => Some(MaskKind::Face),
            "ai-depth" => Some(MaskKind::Depth),
            "ai-subject" => Some(MaskKind::Subject),
            _ => None,
        }
    }
}

enum Job {
    Denoise(DenoiseMethod),
    EffectMap(EffectMapKind),
    Mask {
        sub_mask_id: String,
        kind: MaskKind,
        name: String,
    },
}

impl Job {
    fn kind_label(&self) -> &'static str {
        match self {
            Job::Denoise(_) => "denoise",
            Job::EffectMap(EffectMapKind::Depth) => "depthMap",
            Job::EffectMap(EffectMapKind::Normal) => "normalMap",
            Job::Mask { kind, .. } => match kind {
                MaskKind::Foreground => "foregroundMask",
                MaskKind::Sky => "skyMask",
                MaskKind::Text => "textMask",
                MaskKind::Face => "faceMask",
                MaskKind::Depth => "depthMask",
                MaskKind::Subject => "subjectMask",
            },
        }
    }
}

fn mask_data(params: &Value) -> Option<&str> {
    MASK_DATA_KEYS
        .iter()
        .find_map(|key| params.get(*key).and_then(Value::as_str))
        .filter(|data| !data.is_empty())
}

fn text_prompt(params: &Value) -> Option<&str> {
    params
        .get(TEXT_PROMPT_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
}

fn face_parts(params: &Value) -> Vec<String> {
    params
        .get(FACE_PARTS_KEY)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.as_str().map(str::to_string))
        .collect()
}

fn has_subject_box(params: &Value) -> bool {
    let coords: Vec<f64> = SUBJECT_BOX_KEYS
        .iter()
        .filter_map(|key| params.get(*key).and_then(Value::as_f64))
        .collect();
    coords.len() == 4 && coords.iter().all(|c| *c > -9999.0) && coords[..2] != coords[2..]
}

fn is_mask_valid_for(params: &Value, source_id: &str, trust_unstamped: bool) -> bool {
    mask_data(params).is_some()
        && match params.get(AI_SOURCE_KEY).and_then(Value::as_str) {
            Some(stamp) => stamp == source_id,
            None => trust_unstamped,
        }
}

fn needs_mask_generation(kind: MaskKind, params: &Value, source_id: &str) -> bool {
    !is_mask_valid_for(params, source_id, true)
        && match kind {
            MaskKind::Subject => has_subject_box(params),
            MaskKind::Text => text_prompt(params).is_some(),
            MaskKind::Face => !face_parts(params).is_empty(),
            _ => true,
        }
}

fn ai_sub_masks_mut(adjustments: &mut Value) -> impl Iterator<Item = (MaskKind, &mut Value)> {
    adjustments
        .get_mut("masks")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter_map(|container| container.get_mut("subMasks").and_then(Value::as_array_mut))
        .flatten()
        .filter_map(|sub_mask| {
            let kind = MaskKind::from_type(sub_mask.get("type")?.as_str()?)?;
            Some((kind, sub_mask))
        })
}

fn ai_sub_masks(adjustments: &Value) -> impl Iterator<Item = (MaskKind, &Value)> {
    adjustments["masks"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|container| container["subMasks"].as_array().into_iter().flatten())
        .filter_map(|sub_mask| Some((MaskKind::from_type(sub_mask["type"].as_str()?)?, sub_mask)))
}

pub fn has_ai_results(adjustments: &Value) -> bool {
    ai_sub_masks(adjustments).next().is_some()
        || adjustments["aiDenoiseEnabled"].as_bool().unwrap_or(false)
        || EffectMapKind::ALL
            .iter()
            .flat_map(|map| map.adjustment_keys())
            .any(|(_, enabled_key, _)| adjustments[*enabled_key].as_bool().unwrap_or(false))
}

fn sub_mask_id(sub_mask: &Value) -> Option<&str> {
    sub_mask.get("id").and_then(Value::as_str)
}

fn plan(adjustments: &Value, path: &str, source_id: &str) -> Vec<Job> {
    let mut jobs = Vec::new();

    let denoise_method = DenoiseMethod::from_adjustments(adjustments);
    if crate::ai_denoise::is_enabled(adjustments)
        && !crate::ai_denoise::has_cached_entry(path, denoise_method)
    {
        jobs.push(Job::Denoise(denoise_method));
    }

    for map in EffectMapKind::ALL {
        let needed = map
            .adjustment_keys()
            .iter()
            .any(|(tool, enabled_key, map_key)| {
                is_effect_enabled(adjustments, tool, enabled_key)
                    && !is_map_valid_for(&adjustments[*map_key], map, source_id)
            });
        if needed {
            jobs.push(Job::EffectMap(map));
        }
    }

    let containers = adjustments
        .get("masks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for container in containers {
        let name = container["name"].as_str().unwrap_or_default();
        for sub_mask in container["subMasks"].as_array().into_iter().flatten() {
            let (Some(kind), Some(id)) = (
                sub_mask["type"].as_str().and_then(MaskKind::from_type),
                sub_mask_id(sub_mask),
            ) else {
                continue;
            };
            if needs_mask_generation(kind, &sub_mask["parameters"], source_id) {
                jobs.push(Job::Mask {
                    sub_mask_id: id.to_string(),
                    kind,
                    name: name.to_string(),
                });
            }
        }
    }

    jobs
}

fn strip_mask_result(params: &mut Value) {
    if let Some(params) = params.as_object_mut() {
        for key in MASK_DATA_KEYS.iter().chain([&AI_SOURCE_KEY]) {
            params.remove(*key);
        }
    }
}

fn same_mask_inputs(a: &Value, b: &Value) -> bool {
    let (mut a, mut b) = (a.clone(), b.clone());
    strip_mask_result(&mut a);
    strip_mask_result(&mut b);
    a == b
}

fn box_space(params: &Value) -> Option<(f64, f64)> {
    Some((
        params.get("boxSpaceWidth")?.as_f64()?,
        params.get("boxSpaceHeight")?.as_f64()?,
    ))
}

fn scaled_subject_box(params: &Value, target_space: Option<(f64, f64)>) -> Option<[f64; 4]> {
    let mut coords = [0.0; 4];
    for (coord, key) in coords.iter_mut().zip(SUBJECT_BOX_KEYS) {
        *coord = params.get(key)?.as_f64()?;
    }
    if let (Some((from_w, from_h)), Some((to_w, to_h))) = (box_space(params), target_space)
        && from_w > 0.0
        && from_h > 0.0
    {
        let (sx, sy) = (to_w / from_w, to_h / from_h);
        coords = [
            coords[0] * sx,
            coords[1] * sy,
            coords[2] * sx,
            coords[3] * sy,
        ];
    }
    Some(coords)
}

fn same_subject_box(incoming: &Value, existing: &Value) -> bool {
    match (
        scaled_subject_box(incoming, box_space(existing)),
        scaled_subject_box(existing, None),
    ) {
        (Some(a), Some(b)) => a.iter().zip(b).all(|(a, b)| (a - b).abs() < 0.5),
        _ => false,
    }
}

fn copy_mask_result(kind: MaskKind, target: &mut Value, result: &Value) {
    let keys = MASK_RESULT_KEYS.iter().chain(if kind == MaskKind::Subject {
        SUBJECT_RESULT_KEYS.iter()
    } else {
        [].iter()
    });
    for key in keys {
        if let Some(value) = result.get(*key) {
            target[*key] = value.clone();
        }
    }
}

pub fn reconcile_ai_results(
    incoming: &mut Value,
    existing: &Value,
    source_id: &str,
    trust_unstamped: bool,
) -> bool {
    let existing_sub_masks: HashMap<&str, (MaskKind, &Value)> = ai_sub_masks(existing)
        .filter_map(|(kind, sub_mask)| {
            Some((sub_mask_id(sub_mask)?, (kind, &sub_mask["parameters"])))
        })
        .collect();

    let mut stripped = false;
    for (kind, sub_mask) in ai_sub_masks_mut(incoming) {
        let existing = sub_mask_id(sub_mask).and_then(|id| existing_sub_masks.get(id));
        let params = &mut sub_mask["parameters"];
        if is_mask_valid_for(params, source_id, trust_unstamped) {
            params[AI_SOURCE_KEY] = json!(source_id);
            continue;
        }

        let carried_over = existing.filter(|(existing_kind, existing)| {
            *existing_kind == kind
                && is_mask_valid_for(existing, source_id, true)
                && match kind {
                    MaskKind::Subject => same_subject_box(params, existing),
                    MaskKind::Text => text_prompt(params) == text_prompt(existing),
                    MaskKind::Face => face_parts(params) == face_parts(existing),
                    _ => true,
                }
        });
        match carried_over {
            Some((_, existing)) => {
                copy_mask_result(kind, params, existing);
                params[AI_SOURCE_KEY] = json!(source_id);
            }
            None if mask_data(params).is_some() => {
                strip_mask_result(params);
                stripped = true;
            }
            None => {}
        }
    }

    for map in EffectMapKind::ALL {
        for (_, _, map_key) in map.adjustment_keys() {
            let Some(value) = incoming.get(*map_key) else {
                continue;
            };
            let trusted = trust_unstamped || is_map_reference(value);
            if trusted && is_map_valid_for(value, map, source_id) {
                continue;
            }
            if is_map_valid_for(&existing[*map_key], map, source_id) {
                incoming[*map_key] = existing[*map_key].clone();
            } else if !value.is_null() {
                incoming[*map_key] = Value::Null;
                stripped = true;
            }
        }
    }

    stripped
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiJobsStatus {
    current: Option<CurrentAiJob>,
    queued: usize,
    completed: usize,
    paused: bool,
    failed: Vec<FailedAiJob>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CurrentAiJob {
    path: String,
    kind: &'static str,
    mask_name: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FailedAiJob {
    path: String,
    error: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Journal {
    pending: Vec<String>,
    paused: bool,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<String>,
    reserved: HashSet<String>,
    deferred: HashSet<String>,
    journal_path: Option<PathBuf>,
    processing: Option<String>,
    requeue_processing: bool,
    attempts: HashMap<String, u32>,
    status: AiJobsStatus,
}

enum Outcome {
    Finished,
    Interrupted,
    Deferred,
}

impl Queue {
    fn next_path(&self, open_path: Option<String>) -> Option<String> {
        let mut ready = self
            .pending
            .iter()
            .filter(|path| !self.deferred.contains(*path));
        if !self.status.paused {
            return ready.next().cloned();
        }
        open_path.filter(|open| ready.any(|path| path == open))
    }

    fn persist(&self) {
        let Some(path) = &self.journal_path else {
            return;
        };
        let mut pending: Vec<String> = self.pending.iter().cloned().collect();
        pending.extend(self.reserved.iter().cloned());
        let journal = Journal {
            pending,
            paused: self.status.paused,
        };
        if let Ok(json) = serde_json::to_vec(&journal) {
            let _ = crate::file_management::write_file_atomic(path, &json);
        }
    }
}

struct AiJobs {
    queue: Mutex<Queue>,
    wake: Condvar,
    lane: Mutex<()>,
    interrupt_generation: AtomicU64,
}

static JOBS: LazyLock<AiJobs> = LazyLock::new(|| AiJobs {
    queue: Mutex::new(Queue::default()),
    wake: Condvar::new(),
    lane: Mutex::new(()),
    interrupt_generation: AtomicU64::new(0),
});

fn queue() -> MutexGuard<'static, Queue> {
    JOBS.queue.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit_status(app_handle: &AppHandle, queue: &mut Queue) {
    queue.status.queued = queue.pending.len();
    let _ = app_handle.emit("ai-jobs-status", &queue.status);
}

fn emit_pending_change(
    app_handle: &AppHandle,
    added: &[String],
    removed: &[String],
    resolved: bool,
) {
    if !added.is_empty() || !removed.is_empty() {
        let _ = app_handle.emit(
            "ai-jobs-pending",
            json!({ "added": added, "removed": removed, "resolved": resolved }),
        );
    }
}

pub fn reserve(paths: &[String]) {
    let mut queue = queue();
    queue.reserved.extend(paths.iter().cloned());
    queue.persist();
}

pub fn release(paths: &[String]) {
    let mut queue = queue();
    for path in paths {
        queue.reserved.remove(path);
    }
    queue.persist();
}

pub fn needs_generation(adjustments: &Value, source_path: &Path) -> bool {
    has_ai_results(adjustments)
        && source_id(source_path)
            .is_some_and(|id| has_pending_jobs(adjustments, &source_path.to_string_lossy(), &id))
}

pub fn has_pending_jobs(adjustments: &Value, path: &str, source_id: &str) -> bool {
    !plan(adjustments, path, source_id).is_empty()
}

pub fn enqueue(app_handle: &AppHandle, paths: &[String], front: bool) {
    if paths.is_empty() {
        return;
    }

    let mut queue = queue();
    for path in paths {
        queue.reserved.remove(path);
    }
    if queue.processing.as_ref().is_some_and(|p| paths.contains(p)) {
        queue.requeue_processing = true;
    }
    let mut queued: HashSet<String> = queue.pending.iter().cloned().collect();
    let added: Vec<String> = paths
        .iter()
        .filter(|p| !queued.contains(*p))
        .cloned()
        .collect();
    if front {
        let processing = queue.processing.clone();
        queue
            .pending
            .retain(|p| !paths.contains(p) || processing.as_ref() == Some(p));
        for path in paths.iter().rev() {
            if processing.as_ref() != Some(path) {
                queue.pending.push_front(path.clone());
            }
        }
    } else {
        let open_path = open_image_path(app_handle);
        for path in paths {
            if !queued.insert(path.clone()) {
                continue;
            }
            if open_path.as_ref() == Some(path) {
                queue.pending.push_front(path.clone());
            } else {
                queue.pending.push_back(path.clone());
            }
        }
    }

    queue.persist();
    emit_status(app_handle, &mut queue);
    emit_pending_change(app_handle, &added, &[], false);
    JOBS.wake.notify_one();
}

pub fn prioritize(app_handle: &AppHandle, path: &str) {
    let (_, sidecar_path) = parse_virtual_path(path);
    let metadata = crate::exif_processing::load_sidecar(&sidecar_path);
    let has_jobs =
        source_id_for(path).is_some_and(|id| has_pending_jobs(&metadata.adjustments, path, &id));
    if has_jobs {
        enqueue(app_handle, &[path.to_string()], true);
    }
}

pub fn start_worker(app_handle: AppHandle) {
    if let Ok(dir) = app_handle.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let journal_path = dir.join(JOURNAL_FILE);
        let journal: Journal = fs::read(&journal_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();

        let mut queue = queue();
        queue.journal_path = Some(journal_path);
        queue.pending.extend(journal.pending);
        queue.status.paused = journal.paused && !queue.pending.is_empty();
    }

    std::thread::spawn(move || {
        loop {
            let path = {
                let mut queue = queue();
                let path = loop {
                    if let Some(path) = queue.next_path(open_image_path(&app_handle)) {
                        break path;
                    }
                    queue = JOBS.wake.wait(queue).unwrap_or_else(|e| e.into_inner());
                };
                queue.processing = Some(path.clone());
                path
            };

            let generation = JOBS.interrupt_generation.load(Ordering::SeqCst);
            let result = {
                let _lane = JOBS.lane.lock().unwrap_or_else(|e| e.into_inner());
                process_path(&app_handle, &path, Some(generation))
            };
            finish_path(&app_handle, &path, result);
        }
    });
}

fn finish_path(app_handle: &AppHandle, path: &str, result: Result<Outcome, String>) {
    let mut queue = queue();
    let mut requeue = false;
    if queue.processing.as_deref() == Some(path) {
        queue.processing = None;
        requeue = std::mem::take(&mut queue.requeue_processing);
    }
    if queue
        .status
        .current
        .as_ref()
        .is_some_and(|c| c.path == path)
    {
        queue.status.current = None;
    }
    let Some(pos) = queue.pending.iter().position(|p| p == path) else {
        emit_status(app_handle, &mut queue);
        return;
    };
    queue.pending.remove(pos);

    match result {
        _ if requeue => queue.pending.push_back(path.to_string()),
        Ok(Outcome::Interrupted) => queue.pending.push_front(path.to_string()),
        Ok(Outcome::Deferred) => {
            queue.pending.push_back(path.to_string());
            if crate::ai_denoise::is_generating(path) {
                queue.deferred.insert(path.to_string());
            }
        }
        Ok(Outcome::Finished) => {
            queue.attempts.remove(path);
            queue.status.completed += 1;
            emit_pending_change(app_handle, &[], &[path.to_string()], true);
        }
        Err(error) => {
            let attempts = queue.attempts.entry(path.to_string()).or_default();
            *attempts += 1;
            let attempts = *attempts;
            log::warn!(
                "AI job for {} failed (attempt {}): {}",
                path,
                attempts,
                error
            );
            if attempts >= MAX_ATTEMPTS {
                queue.attempts.remove(path);
                queue.status.failed.push(FailedAiJob {
                    path: path.to_string(),
                    error,
                });
                emit_pending_change(app_handle, &[], &[path.to_string()], false);
            } else {
                queue.pending.push_back(path.to_string());
            }
        }
    }

    if queue.pending.is_empty() {
        queue.status.completed = 0;
        queue.status.paused = false;
    }
    queue.persist();
    emit_status(app_handle, &mut queue);
}

pub fn resolve(app_handle: &AppHandle, paths: &[String]) {
    if paths.is_empty() {
        return;
    }

    let resolved: HashSet<&String> = paths.iter().collect();
    let mut queue = queue();
    let processing = queue.processing.clone();
    queue
        .pending
        .retain(|path| !resolved.contains(path) || processing.as_ref() == Some(path));
    queue.deferred.retain(|path| !resolved.contains(path));
    queue.attempts.retain(|path, _| !resolved.contains(path));
    queue
        .status
        .failed
        .retain(|job| !resolved.contains(&job.path));
    if queue.pending.is_empty() {
        queue.status.completed = 0;
        queue.status.paused = false;
    }
    queue.persist();

    let removed: Vec<String> = paths
        .iter()
        .filter(|path| processing.as_ref() != Some(*path))
        .cloned()
        .collect();
    emit_pending_change(app_handle, &[], &removed, true);
    emit_status(app_handle, &mut queue);
}

pub fn release_deferred(path: &str) {
    let source = parse_virtual_path(path).0;
    let mut queue = queue();
    let before = queue.deferred.len();
    queue
        .deferred
        .retain(|deferred| parse_virtual_path(deferred).0 != source);
    if queue.deferred.len() != before {
        JOBS.wake.notify_one();
    }
}

pub fn ensure_ready(app_handle: &AppHandle, path: &str) -> Result<(), String> {
    let result = {
        let _lane = JOBS.lane.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let result = process_path(app_handle, path, None);
            if !matches!(result, Ok(Outcome::Deferred)) {
                break result;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    };
    if result.is_ok() {
        finish_path(app_handle, path, Ok(Outcome::Finished));
    }
    result.map(|_| ())
}

#[derive(Default)]
struct JobResults {
    sub_masks: HashMap<String, (Value, Value)>,
    no_results: HashMap<String, String>,
    maps: Vec<(EffectMapKind, String)>,
}

fn decode_source(app_handle: &AppHandle, source_path: &Path) -> Result<Arc<DynamicImage>, String> {
    let state = app_handle.state::<AppState>();
    let source_path_str = source_path.to_string_lossy().to_string();
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    if let Some(fingerprint) =
        crate::cache_utils::DecodeFingerprint::for_file(source_path, &settings)
        && let Some((image, _)) = state
            .decoded_image_cache
            .lock()
            .unwrap()
            .get(&source_path_str, &fingerprint)
    {
        return Ok(image);
    }

    let image = match read_file_mapped(source_path) {
        Ok(mmap) => crate::image_loader::load_base_image_from_bytes(
            &mmap,
            &source_path_str,
            false,
            &settings,
            None,
        ),
        Err(_) => {
            let bytes = fs::read(source_path).map_err(|e| e.to_string())?;
            crate::image_loader::load_base_image_from_bytes(
                &bytes,
                &source_path_str,
                false,
                &settings,
                None,
            )
        }
    }
    .map_err(|e| e.to_string())?;
    Ok(Arc::new(image))
}

fn open_image_path(app_handle: &AppHandle) -> Option<String> {
    app_handle
        .state::<AppState>()
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|loaded| loaded.path.clone())
}

fn process_path(
    app_handle: &AppHandle,
    path: &str,
    interrupt_generation: Option<u64>,
) -> Result<Outcome, String> {
    let (source_path, sidecar_path) = parse_virtual_path(path);
    if !source_path.exists() {
        return Ok(Outcome::Finished);
    }
    let source_id = source_id(&source_path).ok_or("Unable to read the source image")?;
    let adjustments = crate::exif_processing::load_sidecar(&sidecar_path).adjustments;

    let jobs = plan(&adjustments, path, &source_id);
    if jobs.is_empty() {
        return Ok(Outcome::Finished);
    }

    let base = decode_source(app_handle, &source_path)?;
    let is_raw = crate::formats::is_raw_file(&source_path);
    let mut warped_image: Option<DynamicImage> = None;
    let mut results = JobResults::default();
    let mut errors = Vec::new();
    let mut generated_any = false;
    let mut outcome = Outcome::Finished;

    for job in jobs {
        if interrupt_generation.is_some_and(|generation| {
            generation != JOBS.interrupt_generation.load(Ordering::SeqCst)
        }) {
            outcome = Outcome::Interrupted;
            break;
        }
        {
            let mut queue = queue();
            queue.status.current = Some(CurrentAiJob {
                path: path.to_string(),
                kind: job.kind_label(),
                mask_name: match &job {
                    Job::Mask { name, .. } => Some(name.clone()),
                    _ => None,
                },
            });
            emit_status(app_handle, &mut queue);
        }

        let job_result = match &job {
            Job::Denoise(method) => {
                match crate::ai_denoise::generate_for_base(app_handle, path, &base, *method) {
                    Ok(false) => {
                        outcome = Outcome::Deferred;
                        continue;
                    }
                    result => result.map(|_| ()),
                }
            }
            Job::EffectMap(map) => {
                let source_image = crate::mask_generation::build_converted_source_image(
                    &base,
                    is_raw,
                    &adjustments,
                );
                tauri::async_runtime::block_on(ai_commands::generate_effect_map(
                    app_handle,
                    *map,
                    &source_image,
                    &source_id,
                ))
                .map(|reference| results.maps.push((*map, reference)))
            }
            Job::Mask {
                sub_mask_id, kind, ..
            } => {
                let warped = warped_image.get_or_insert_with(|| {
                    crate::build_ai_source_image(&base, is_raw, &geometry_adjustments(&adjustments))
                });
                generate_mask(
                    app_handle,
                    path,
                    &adjustments,
                    sub_mask_id,
                    *kind,
                    warped,
                    &source_id,
                )
                .map(|(original, result, no_result)| {
                    if let Some(no_result) = no_result {
                        results.no_results.insert(sub_mask_id.clone(), no_result);
                    }
                    results
                        .sub_masks
                        .insert(sub_mask_id.clone(), (original, result));
                })
            }
        };
        match job_result {
            Ok(()) => generated_any = true,
            Err(e) => errors.push(e),
        }
    }
    drop(warped_image);
    drop(base);

    if !results.sub_masks.is_empty() || !results.maps.is_empty() {
        commit_results(app_handle, path, &source_id, results)?;
    }

    if generated_any {
        let state = app_handle.state::<AppState>();
        crate::file_management::add_to_thumbnail_queue(&state, 1, app_handle);
        let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
        crate::file_management::regenerate_thumbnails(
            std::iter::once(path.to_string()),
            app_handle,
            &settings,
            true,
        );
    }

    match errors.into_iter().next() {
        Some(error) => Err(error),
        None => Ok(outcome),
    }
}

fn generate_mask(
    app_handle: &AppHandle,
    path: &str,
    adjustments: &Value,
    id: &str,
    kind: MaskKind,
    warped_image: &DynamicImage,
    source_id: &str,
) -> Result<(Value, Value, Option<String>), String> {
    let state = app_handle.state::<AppState>();
    let original = ai_sub_masks(adjustments)
        .find(|(_, sub_mask)| sub_mask_id(sub_mask) == Some(id))
        .map(|(_, sub_mask)| sub_mask["parameters"].clone())
        .ok_or("Sub-mask disappeared before it was generated")?;

    let model = match kind {
        MaskKind::Foreground => AiMaskModel::Foreground,
        MaskKind::Sky => AiMaskModel::Sky,
        MaskKind::Text => AiMaskModel::Text,
        MaskKind::Face => AiMaskModel::Face,
        MaskKind::Depth => AiMaskModel::Depth,
        MaskKind::Subject => AiMaskModel::Subject,
    };
    let models = tauri::async_runtime::block_on(get_or_init_ai_models(
        app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        model,
    ))
    .map_err(|e| e.to_string())?;
    let transform = MaskTransform::from_adjustments(adjustments);
    let ai_source = Some(source_id.to_string());
    let cache_key = ai_commands::ai_cache_key(
        &parse_virtual_path(path).0.to_string_lossy(),
        &geometry_adjustments(adjustments),
    );

    let result = match kind {
        MaskKind::Foreground => ai_commands::generate_foreground_mask(
            &models,
            warped_image,
            transform,
            ai_source.clone(),
        )
        .and_then(ai_commands::to_json),
        MaskKind::Sky => ai_commands::generate_sky_mask(
            &state.ai_state,
            &models,
            &cache_key,
            warped_image,
            transform,
            ai_source.clone(),
        )
        .and_then(ai_commands::to_json),
        MaskKind::Text => ai_commands::generate_text_mask(
            &state.ai_state,
            &models,
            &cache_key,
            warped_image,
            text_prompt(&original).ok_or("Text prompt missing")?,
            transform,
            ai_source.clone(),
        )
        .and_then(ai_commands::to_json),
        MaskKind::Face => ai_commands::generate_face_mask(
            &state.ai_state,
            &models,
            &cache_key,
            warped_image,
            &face_parts(&original),
            transform,
            ai_source.clone(),
        )
        .and_then(ai_commands::to_json),
        MaskKind::Depth => {
            let params: AiDepthMaskParameters =
                serde_json::from_value(original.clone()).unwrap_or_default();
            ai_commands::generate_depth_mask(
                &state.ai_state,
                &models,
                &cache_key,
                warped_image,
                params,
                transform,
                ai_source.clone(),
            )
            .and_then(ai_commands::to_json)
        }
        MaskKind::Subject => {
            let (width, height) = transform.box_space(warped_image.dimensions());
            let [start_x, start_y, end_x, end_y] =
                scaled_subject_box(&original, Some((width as f64, height as f64)))
                    .ok_or("Subject box missing")?;
            ai_commands::generate_subject_mask(
                &state.ai_state,
                &models,
                &cache_key,
                warped_image,
                (start_x, start_y),
                (end_x, end_y),
                false,
                transform,
                ai_source.clone(),
            )
            .and_then(ai_commands::to_json)
        }
    };
    let (result, no_result) = ai_commands::or_empty_mask(result, transform, ai_source)?;

    Ok((original, result, no_result))
}

fn geometry_adjustments(adjustments: &Value) -> Value {
    GEOMETRY_KEYS
        .iter()
        .filter_map(|key| Some((key.to_string(), adjustments.get(*key)?.clone())))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

fn apply_results(
    adjustments: &mut Value,
    source_id: &str,
    results: &JobResults,
) -> (
    serde_json::Map<String, Value>,
    serde_json::Map<String, Value>,
) {
    let mut committed_sub_masks = serde_json::Map::new();
    let mut committed_maps = serde_json::Map::new();

    for (map, reference) in &results.maps {
        for (tool, enabled_key, map_key) in map.adjustment_keys() {
            if is_effect_enabled(adjustments, tool, enabled_key)
                && !is_map_valid_for(&adjustments[*map_key], *map, source_id)
            {
                adjustments[*map_key] = json!(reference);
                committed_maps.insert(map_key.to_string(), json!(reference));
            }
        }
    }

    for (kind, sub_mask) in ai_sub_masks_mut(adjustments) {
        let Some(id) = sub_mask_id(sub_mask).map(str::to_string) else {
            continue;
        };
        if let Some((original, result)) = results.sub_masks.get(&id)
            && !is_mask_valid_for(&sub_mask["parameters"], source_id, true)
            && same_mask_inputs(&sub_mask["parameters"], original)
        {
            copy_mask_result(kind, &mut sub_mask["parameters"], result);
            let mut committed = json!({});
            copy_mask_result(kind, &mut committed, result);
            committed_sub_masks.insert(id, committed);
        }
    }

    (committed_sub_masks, committed_maps)
}

fn commit_results(
    app_handle: &AppHandle,
    path: &str,
    source_id: &str,
    results: JobResults,
) -> Result<(), String> {
    let (source_path, sidecar_path) = parse_virtual_path(path);
    let mut committed = Default::default();
    crate::exif_processing::update_sidecar(&sidecar_path, &source_path, |metadata| {
        committed = apply_results(&mut metadata.adjustments, source_id, &results);
    })
    .map_err(|e| e.to_string())?;

    let (sub_masks, maps) = committed;
    let no_results: Vec<&String> = results
        .no_results
        .iter()
        .filter(|(id, _)| sub_masks.contains_key(*id))
        .map(|(_, no_result)| no_result)
        .collect();
    let _ = app_handle.emit(
        "ai-job-result",
        json!({ "path": path, "subMasks": sub_masks, "maps": maps, "noResults": no_results }),
    );
    Ok(())
}

#[tauri::command]
pub fn get_ai_jobs_status() -> AiJobsStatus {
    let mut queue = queue();
    queue.status.queued = queue.pending.len();
    queue.status.clone()
}

#[tauri::command]
pub fn get_pending_ai_paths() -> Vec<String> {
    queue().pending.iter().cloned().collect()
}

#[tauri::command]
pub async fn pause_ai_jobs(app_handle: AppHandle) {
    let mut queue = queue();
    if queue.pending.is_empty() {
        return;
    }
    JOBS.interrupt_generation.fetch_add(1, Ordering::SeqCst);
    queue.status.paused = true;
    queue.persist();
    emit_status(&app_handle, &mut queue);
}

#[tauri::command]
pub async fn resume_ai_jobs(app_handle: AppHandle) {
    let mut queue = queue();
    queue.status.paused = false;
    queue.persist();
    emit_status(&app_handle, &mut queue);
    JOBS.wake.notify_one();
}

#[tauri::command]
pub async fn discard_ai_jobs(app_handle: AppHandle) {
    JOBS.interrupt_generation.fetch_add(1, Ordering::SeqCst);
    let mut queue = queue();
    let removed: Vec<String> = queue.pending.drain(..).collect();
    queue.deferred.clear();
    queue.attempts.clear();
    queue.status.completed = 0;
    queue.status.paused = false;
    queue.persist();
    emit_pending_change(&app_handle, &[], &removed, false);
    emit_status(&app_handle, &mut queue);
}

#[tauri::command]
pub async fn queue_ai_jobs(paths: Vec<String>, app_handle: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (with_work, resolved): (Vec<String>, Vec<String>) =
            paths.into_iter().partition(|path| {
                let metadata = crate::exif_processing::load_sidecar(&parse_virtual_path(path).1);
                source_id_for(path)
                    .is_some_and(|id| has_pending_jobs(&metadata.adjustments, path, &id))
            });
        emit_pending_change(&app_handle, &[], &resolved, true);
        enqueue(&app_handle, &with_work, false);
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_failed_ai_jobs(app_handle: AppHandle) {
    let failed: Vec<String> = queue()
        .status
        .failed
        .drain(..)
        .map(|job| job.path)
        .collect();
    enqueue(&app_handle, &failed, false);
}
