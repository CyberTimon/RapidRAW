//! One background native denoise worker per workspace. Manifests survive client
//! disconnects; interrupted work can restart from its immutable input snapshot.
use super::{
    Result, number, required,
    sessions::{Bridge, Session, Snapshot, atomic_write, restore_session},
};
use crate::{
    app_state::AppState,
    denoising::{DenoiseControl, denoise_source_image_controlled},
};
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Running,
    Cancelling,
    Succeeded,
    Cancelled,
    Failed,
    Interrupted,
}
impl Status {
    fn active(self) -> bool {
        matches!(self, Self::Running | Self::Cancelling)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Job {
    job_id: String,
    status: Status,
    progress_percent: u32,
    stage: String,
    method: String,
    intensity: f32,
    /// Backend generation that owns unfinished work. Absent on manifests
    /// written before the native ONNX switch; serde default keeps those
    /// manifests listable, and resume rejects them explicitly below.
    #[serde(default = "legacy_backend_generation")]
    backend: String,
    input: Session,
    result_session_id: String,
    error: Option<String>,
    attempt: u32,
}
fn legacy_backend_generation() -> String {
    String::new()
}
/// Native runtime generations that own resumable Nonlocal work. Both the
/// user-visible info and the resume guards classify backends through this
/// predicate so ONNX and CoreML cannot be treated inconsistently.
fn is_native_nonlocal_backend(backend: &str) -> bool {
    backend == crate::nonlocal_onnx::BACKEND_GENERATION
        || backend == crate::nonlocal_coreml::COREML_BACKEND_GENERATION
}
fn is_legacy_nonlocal(job: &Job) -> bool {
    job.method == "nonlocal" && !is_native_nonlocal_backend(&job.backend)
}
impl Job {
    fn info(&self) -> Value {
        let legacy = is_legacy_nonlocal(self);
        let recoverable = matches!(
            self.status,
            Status::Interrupted | Status::Failed | Status::Cancelled
        ) && !legacy;
        let recovery = if legacy {
            "This Nonlocal job predates the native Nonlocal runtimes and cannot resume; start a new denoise job."
        } else {
            "Completed results persist without polling. After process interruption, resume_job restarts computation from the captured input; partial tiles are not checkpoints."
        };
        json!({"job_id":self.job_id,"status":self.status,"progress_percent":self.progress_percent,"stage":self.stage,
            "method":self.method,"intensity":self.intensity,"backend":self.backend,"parent_session_id":self.input.id,"parent_revision":self.input.revision,
            "result_session_id":if self.status==Status::Succeeded { Some(&self.result_session_id) } else { None },
            "error":self.error,"attempt":self.attempt,"recoverable":recoverable,
            "recovery":recovery})
    }
}
struct Entry {
    job: Job,
    imported: bool,
    cancel: Arc<AtomicBool>,
}
#[derive(Clone)]
pub(super) struct Jobs {
    root: PathBuf,
    entries: Arc<Mutex<BTreeMap<String, Entry>>>,
}

fn uuid_id(value: &str) -> Result<String> {
    Ok(uuid::Uuid::parse_str(value)
        .map_err(|_| "INVALID_ARGUMENT: Expected UUID")?
        .to_string())
}

/// Unfinished Nonlocal jobs from before the native runtimes must not
/// silently resume under a new runtime; succeeded jobs stay readable.
fn legacy_nonlocal_resume_rejected(previous: &Job) -> Option<&'static str> {
    if is_legacy_nonlocal(previous) {
        Some(
            "JOB_NOT_RESUMABLE: This Nonlocal job predates the native Nonlocal runtimes and cannot resume; start a new denoise job",
        )
    } else {
        None
    }
}

/// Backend generation newly requested for Nonlocal jobs. Falls back to the
/// ONNX generation when the provider itself is unparseable; job startup
/// still fails closed at full configuration validation when inference is
/// actually required.
fn nonlocal_generation_for_new_job() -> String {
    crate::nonlocal_onnx::provider_from_env()
        .map(|provider| provider.generation().to_owned())
        .unwrap_or_else(|_| crate::nonlocal_onnx::BACKEND_GENERATION.to_owned())
}

/// An unfinished ONNX job must not resume as CoreML and a CoreML job must
/// not resume as ONNX merely because environment configuration changed.
/// Pre-provider native ONNX jobs keep their cpu/cuda behavior within the
/// shared `native-onnx-v1` generation.
fn cross_family_resume_rejected(previous: &Job, current_generation: &str) -> Option<String> {
    if previous.method == "nonlocal"
        && is_native_nonlocal_backend(&previous.backend)
        && previous.backend != current_generation
    {
        Some(format!(
            "JOB_NOT_RESUMABLE: This Nonlocal job used backend {} and cannot resume as {current_generation}; start a new denoise job",
            previous.backend
        ))
    } else {
        None
    }
}
fn save(root: &Path, job: &Job) -> Result<()> {
    atomic_write(
        &root.join("jobs").join(format!("{}.json", job.job_id)),
        &serde_json::to_vec_pretty(job).map_err(|e| e.to_string())?,
        true,
    )
}

impl Jobs {
    pub fn load(root: &Path) -> Result<Self> {
        fs::create_dir_all(root.join("jobs")).map_err(|e| e.to_string())?;
        let mut entries = BTreeMap::new();
        for entry in fs::read_dir(root.join("jobs")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                return Err("INVALID_JOB: Manifest must be a regular file".into());
            }
            let mut job: Job = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("INVALID_JOB: {e}"))?;
            if uuid_id(&job.job_id)? != path.file_stem().unwrap().to_string_lossy()
                || uuid_id(&job.result_session_id)? != job.result_session_id
                || uuid_id(&job.input.id)? != job.input.id
            {
                return Err("INVALID_JOB: Invalid job or session identity".into());
            }
            job.input
                .validate_restored(&root.join("sessions").join(&job.input.id))?;
            if !["ai", "bm3d", "nonlocal"].contains(&job.method.as_str())
                || !job.intensity.is_finite()
                || !(0.0..=100.0).contains(&job.intensity)
            {
                return Err("INVALID_JOB: Invalid denoise parameters".into());
            }
            let result_dir = root.join("sessions").join(&job.result_session_id);
            if job.status.active() {
                // The session commit precedes the completion manifest. Recover
                // that tiny crash window without computing or writing twice.
                if result_dir.join("session.json").exists() {
                    let result = restore_session(&result_dir)?;
                    if result.current().metadata["derivedFrom"]["job_id"] != job.job_id {
                        return Err("INVALID_JOB: Result provenance mismatch".into());
                    }
                    job.status = Status::Succeeded;
                    job.progress_percent = 100;
                    job.stage = "complete".into();
                } else {
                    job.status = if job.status == Status::Cancelling {
                        Status::Cancelled
                    } else {
                        Status::Interrupted
                    };
                    job.stage = "engine stopped".into();
                }
                save(root, &job)?;
            }
            if job.status == Status::Succeeded {
                restore_session(&result_dir)?;
            }
            entries.insert(
                job.job_id.clone(),
                Entry {
                    imported: true,
                    job,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        Ok(Self {
            root: root.into(),
            entries: Arc::new(Mutex::new(entries)),
        })
    }
    fn ensure_idle(&self) -> Result<()> {
        if self
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .any(|e| e.job.status.active())
        {
            return Err(
                "JOB_BUSY: One denoise job may run per workspace; inspect or cancel it first"
                    .into(),
            );
        }
        Ok(())
    }
    fn record(&self, id: &str) -> Result<Job> {
        let id = uuid_id(id)?;
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(&id)
            .map(|e| e.job.clone())
            .ok_or_else(|| format!("JOB_NOT_FOUND: {id}"))
    }
    pub fn list(&self) -> Result<Value> {
        Ok(
            json!({"jobs":self.entries.lock().map_err(|e| e.to_string())?.values().map(|e| e.job.info()).collect::<Vec<_>>()}),
        )
    }
    pub fn get(&self, params: &Value) -> Result<Value> {
        Ok(self.record(required(params, "job_id")?)?.info())
    }
    pub fn cancel(&self, params: &Value) -> Result<Value> {
        let id = uuid_id(required(params, "job_id")?)?;
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        let entry = entries.get_mut(&id).ok_or("JOB_NOT_FOUND: Unknown job")?;
        if entry.job.status.active() {
            let mut updated = entry.job.clone();
            updated.status = Status::Cancelling;
            updated.stage = "cancellation requested".into();
            save(&self.root, &updated)?;
            entry.job = updated;
            entry.cancel.store(true, Ordering::Release);
        }
        Ok(entry.job.info())
    }
    fn progress(&self, id: &str, fraction: f32, stage: &str) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let Some(entry) = entries.get_mut(id) else {
            return;
        };
        if entry.job.status != Status::Running {
            return;
        }
        let percent = (fraction.clamp(0.0, 1.0) * 90.0).floor() as u32;
        if percent <= entry.job.progress_percent && stage == entry.job.stage {
            return;
        }
        entry.job.progress_percent = entry.job.progress_percent.max(percent);
        entry.job.stage = stage.into();
        if let Err(error) = save(&self.root, &entry.job) {
            entry.job.error = Some(format!("JOB_PERSIST_FAILED: {error}"));
            entry.cancel.store(true, Ordering::Release);
        }
    }
    fn finish_error(&self, id: &str, error: String) {
        if let Ok(mut entries) = self.entries.lock()
            && let Some(entry) = entries.get_mut(id)
        {
            if entry.job.status == Status::Succeeded {
                entry.job.error = Some(error);
                let _ = save(&self.root, &entry.job);
                return;
            }
            entry.job.status = if entry.cancel.load(Ordering::Acquire) && entry.job.error.is_none()
            {
                Status::Cancelled
            } else {
                Status::Failed
            };
            entry.job.stage = if entry.job.status == Status::Cancelled {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            if entry.job.error.is_none() {
                entry.job.error = Some(error);
            }
            if let Err(e) = save(&self.root, &entry.job) {
                entry.job.error = Some(format!("JOB_PERSIST_FAILED: {e}"));
            }
        }
    }
    fn publish(
        &self,
        job: &Job,
        image: DynamicImage,
        range: (f32, f32),
        control: &DenoiseControl,
    ) -> Result<()> {
        control.check()?;
        self.progress(&job.job_id, 1.0, "encoding result");
        let mut bytes = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgb32F(image.to_rgb32f())
            .write_to(&mut bytes, image::ImageFormat::Tiff)
            .map_err(|e| e.to_string())?;
        control.check()?;
        let bytes = bytes.into_inner();
        let derived = self
            .root
            .join("exports")
            .join(format!("denoise-{}.tiff", job.result_session_id));
        atomic_write(&derived, &bytes, false)?;
        control.check()?;
        let directory = self.root.join("sessions").join(&job.result_session_id);
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let working = directory.join("source.tiff");
        atomic_write(&working, &bytes, false)?;
        let mut metadata = job.input.current().metadata.clone();
        metadata["mcpSourceDomain"] = json!(if job.input.is_raw {
            "linear-raw"
        } else {
            "srgb"
        });
        metadata["derivedFrom"] = json!({"session_id":job.input.id,"revision":job.input.revision,"job_id":job.job_id,
            "operation":"denoise","method":job.method,"intensity":job.intensity,"source_domain_preserved":true,"normalization_range":range});
        let result = Session {
            id: job.result_session_id.clone(),
            source_path: derived.to_string_lossy().into_owned(),
            source_sha256: hex::encode(Sha256::digest(&bytes)),
            working_path: working.to_string_lossy().into_owned(),
            dimensions: job.input.dimensions,
            is_raw: job.input.is_raw,
            revision: 0,
            cursor: 0,
            history: vec![Snapshot {
                label: "Background denoise with captured edits".into(),
                adjustments: job.input.current().adjustments.clone(),
                metadata,
            }],
        };
        result.validate_restored(&directory)?;
        // Linearize cancellation against the final result commit. Large pixel
        // encoding/writes happen above, without holding the status mutex.
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        let entry = entries
            .get_mut(&job.job_id)
            .ok_or("JOB_NOT_FOUND: Unknown job")?;
        control.check()?;
        atomic_write(
            &directory.join("session.json"),
            &super::sessions::session_manifest_bytes(&result, true)?,
            false,
        )?;
        entry.job.status = Status::Succeeded;
        entry.job.progress_percent = 100;
        entry.job.stage = "complete".into();
        entry.job.error = None;
        save(&self.root, &entry.job)?;
        Ok(())
    }

    fn publish_raw(
        &self,
        job: &Job,
        output: crate::raw_denoise::Output,
        control: &DenoiseControl,
    ) -> Result<()> {
        control.check()?;
        self.progress(&job.job_id, 1.0, "publishing Bayer DNG");
        let derived = self
            .root
            .join("exports")
            .join(format!("denoise-{}.dng", job.result_session_id));
        crate::storage_copy::copy_new(&output.path(), &derived).map_err(|e| e.to_string())?;
        control.check()?;
        let directory = self.root.join("sessions").join(&job.result_session_id);
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let working = directory.join("source.dng");
        crate::storage_copy::copy_new(&derived, &working).map_err(|e| e.to_string())?;
        let mut metadata = job.input.current().metadata.clone();
        if let Some(object) = metadata.as_object_mut() {
            object.remove("mcpSourceDomain");
        }
        metadata["derivedFrom"] = json!({"session_id":job.input.id,"revision":job.input.revision,"job_id":job.job_id,
            "operation":"denoise","method":"nonlocal","intensity":job.intensity,
            "source_domain_preserved":true,"nonlocal":output.provenance});
        let source_sha256 = crate::raw_denoise::hash_file(&derived).map_err(|e| e.to_string())?;
        let result = Session {
            id: job.result_session_id.clone(),
            source_path: derived.to_string_lossy().into_owned(),
            source_sha256,
            working_path: working.to_string_lossy().into_owned(),
            dimensions: job.input.dimensions,
            is_raw: true,
            revision: 0,
            cursor: 0,
            history: vec![Snapshot {
                label: "Nonlocal Bayer denoise with captured edits".into(),
                adjustments: job.input.current().adjustments.clone(),
                metadata,
            }],
        };
        result.validate_restored(&directory)?;
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        let entry = entries
            .get_mut(&job.job_id)
            .ok_or("JOB_NOT_FOUND: Unknown job")?;
        control.check()?;
        atomic_write(
            &directory.join("session.json"),
            &super::sessions::session_manifest_bytes(&result, true)?,
            false,
        )?;
        entry.job.status = Status::Succeeded;
        entry.job.progress_percent = 100;
        entry.job.stage = "complete".into();
        entry.job.error = None;
        save(&self.root, &entry.job)
    }
}

impl Bridge {
    pub(super) fn refresh_job_results(&mut self) -> Result<()> {
        let mut entries = self.jobs.entries.lock().map_err(|e| e.to_string())?;
        for entry in entries
            .values_mut()
            .filter(|e| e.job.status == Status::Succeeded && !e.imported)
        {
            let id = &entry.job.result_session_id;
            if !self.sessions.contains_key(id) {
                let session = restore_session(&self.paths.root.join("sessions").join(id))?;
                self.sessions.insert(id.clone(), session);
            }
            // Do not reopen an explicitly closed result on every later call.
            entry.imported = true;
        }
        Ok(())
    }
    pub(super) async fn start_denoise_job(
        &mut self,
        params: &Value,
        resume: bool,
    ) -> Result<Value> {
        self.jobs.ensure_idle()?;
        let mut job = if resume {
            let previous = self.jobs.record(required(params, "job_id")?)?;
            if !matches!(
                previous.status,
                Status::Interrupted | Status::Failed | Status::Cancelled
            ) {
                return Err(
                    "JOB_NOT_RESUMABLE: Only interrupted, failed or cancelled jobs can restart"
                        .into(),
                );
            }
            if previous.method == "nonlocal" {
                if let Some(rejection) = legacy_nonlocal_resume_rejected(&previous) {
                    return Err(rejection.into());
                }
                let current = crate::nonlocal_onnx::provider_from_env()
                    .map(|provider| provider.generation().to_owned())
                    .map_err(|e| e.to_string())?;
                if let Some(rejection) = cross_family_resume_rejected(&previous, &current) {
                    return Err(rejection);
                }
            }
            Job {
                status: Status::Running,
                progress_percent: 0,
                stage: "starting".into(),
                result_session_id: uuid::Uuid::new_v4().to_string(),
                error: None,
                attempt: previous.attempt + 1,
                ..previous
            }
        } else {
            let mut input = self.session(params)?.clone();
            input.check_revision(params)?;
            input.history = vec![input.current().clone()];
            input.cursor = 0;
            let method = params
                .get("method")
                .map(|v| {
                    v.as_str()
                        .ok_or("INVALID_ARGUMENT: method must be a string")
                })
                .transpose()?
                .unwrap_or("ai");
            if !["ai", "bm3d", "nonlocal"].contains(&method) {
                return Err("INVALID_ARGUMENT: method must be ai, bm3d or nonlocal".into());
            }
            Job {
                job_id: uuid::Uuid::new_v4().to_string(),
                status: Status::Running,
                progress_percent: 0,
                stage: "starting".into(),
                method: method.into(),
                intensity: number(
                    params,
                    "intensity",
                    if method == "nonlocal" { 100.0 } else { 50.0 },
                    0.0,
                    100.0,
                )? as f32,
                backend: if method == "nonlocal" {
                    nonlocal_generation_for_new_job()
                } else {
                    String::new()
                },
                input,
                result_session_id: uuid::Uuid::new_v4().to_string(),
                error: None,
                attempt: 1,
            }
        };
        // Captured pixels are immutable. Never substitute the parent's current
        // adjustment state when resuming after further edits or undo.
        job.input
            .validate_restored(&self.paths.root.join("sessions").join(&job.input.id))?;
        let bytes = fs::read(&job.input.working_path).map_err(|e| e.to_string())?;
        if hex::encode(Sha256::digest(&bytes)) != job.input.source_sha256 {
            return Err("SOURCE_CHANGED: Captured job source no longer matches its hash".into());
        }
        drop(bytes);
        if job.method == "nonlocal" {
            if !job.input.is_raw || !crate::formats::is_raw_file(Path::new(&job.input.working_path))
            {
                return Err("NONLOCAL_UNSUPPORTED: Nonlocal requires a Bayer RAW source".into());
            }
            if job.intensity > 0.0 {
                crate::raw_denoise::configuration_with_models(Some(&self.paths.models))
                    .map_err(|e| e.to_string())?;
            }
        }
        if job.method == "ai" && job.intensity > 0.0 {
            self.ensure_models("denoise", false).await?;
        }
        if !self.sessions.contains_key(&job.input.id) {
            let current = restore_session(&self.paths.root.join("sessions").join(&job.input.id))?;
            self.sessions.insert(current.id.clone(), current);
        }
        let source = if job.method == "nonlocal" {
            None
        } else {
            self.activate(&job.input.id).await?;
            let state = self.handle.state::<AppState>();
            let image = state
                .original_image
                .lock()
                .map_err(|e| e.to_string())?
                .as_ref()
                .ok_or("IMAGE_NOT_LOADED: Missing job source")?
                .image
                .clone();
            Some(image)
        };
        job.stage = "queued for worker".into();
        let cancel = Arc::new(AtomicBool::new(false));
        save(&self.paths.root, &job)?;
        let response = job.info();
        self.jobs.entries.lock().map_err(|e| e.to_string())?.insert(
            job.job_id.clone(),
            Entry {
                imported: false,
                job: job.clone(),
                cancel: cancel.clone(),
            },
        );
        let jobs = self.jobs.clone();
        let handle = self.handle.clone();
        let progress_jobs = jobs.clone();
        let progress_id = job.job_id.clone();
        let control = DenoiseControl {
            cancelled: cancel,
            progress: Arc::new(move |fraction, stage| {
                progress_jobs.progress(&progress_id, fraction, stage)
            }),
        };
        let worker_id = job.job_id.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("mcp-denoise".into())
            .spawn(move || {
                let outcome =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
                        control.check()?;
                        control.report(0.0, "initializing");
                        if job.method == "nonlocal" {
                            let output = crate::raw_denoise::denoise(
                                Path::new(&job.input.working_path),
                                &job.input.source_sha256,
                                &jobs.root,
                                job.intensity / 100.,
                                &control,
                            )
                            .map_err(|e| format!("{e:#}"))?;
                            return jobs.publish_raw(&job, output, &control);
                        }
                        let ai_session = if job.method == "ai" && job.intensity > 0.0 {
                            let state = handle.state::<AppState>();
                            Some(
                                tauri::async_runtime::block_on(
                                    crate::ai_processing::get_or_init_denoise_model(
                                        &handle,
                                        &state.ai_state,
                                        &state.ai_init_lock,
                                    ),
                                )
                                .map_err(|e| e.to_string())?,
                            )
                        } else {
                            None
                        };
                        control.check()?;
                        let (image, range) = denoise_source_image_controlled(
                            source
                                .as_ref()
                                .ok_or("IMAGE_NOT_LOADED: Missing job source")?,
                            job.intensity / 100.0,
                            &job.method,
                            &handle,
                            ai_session,
                            Some(&control),
                        )?;
                        jobs.publish(&job, image, range, &control)
                    }))
                    .unwrap_or_else(|_| Err("JOB_FAILED: Native denoise worker panicked".into()));
                if let Err(error) = outcome {
                    // Only remove this attempt's unpublished files. A committed
                    // result remains recoverable even if its final status write failed.
                    let directory = jobs.root.join("sessions").join(&job.result_session_id);
                    if !directory.join("session.json").exists() {
                        let _ = fs::remove_file(directory.join("source.tiff"));
                        let _ = fs::remove_file(directory.join("source.dng"));
                        let _ = fs::remove_dir(&directory);
                        let _ = fs::remove_file(
                            jobs.root
                                .join("exports")
                                .join(format!("denoise-{}.tiff", job.result_session_id)),
                        );
                        let _ = fs::remove_file(
                            jobs.root
                                .join("exports")
                                .join(format!("denoise-{}.dng", job.result_session_id)),
                        );
                    }
                    jobs.finish_error(&job.job_id, error);
                }
            })
        {
            self.jobs.finish_error(&worker_id, error.to_string());
            return Err(format!("JOB_START_FAILED: {error}"));
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Job) {
        let root = tempfile::tempdir().unwrap();
        for name in ["sessions", "jobs", "exports"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = root.path().join("sessions").join(&id);
        fs::create_dir(&dir).unwrap();
        let source = root.path().join("original.jpg");
        fs::write(&source, b"source").unwrap();
        let working = dir.join("source.jpg");
        fs::write(&working, b"source").unwrap();
        let input = Session {
            id,
            source_path: source.to_string_lossy().into_owned(),
            working_path: working.to_string_lossy().into_owned(),
            source_sha256: hex::encode(Sha256::digest(b"source")),
            dimensions: (32, 32),
            is_raw: true,
            revision: 7,
            cursor: 0,
            history: vec![Snapshot {
                label: "captured".into(),
                adjustments: super::super::validation::default_adjustments(),
                metadata: json!({}),
            }],
        };
        let job = Job {
            job_id: uuid::Uuid::new_v4().to_string(),
            status: Status::Running,
            progress_percent: 42,
            stage: "AI tiles".into(),
            method: "bm3d".into(),
            intensity: 50.0,
            backend: String::new(),
            input,
            result_session_id: uuid::Uuid::new_v4().to_string(),
            error: None,
            attempt: 1,
        };
        (root, job)
    }
    #[test]
    fn restart_preserves_input_and_marks_unfinished_jobs_interrupted() {
        let (root, job) = fixture();
        save(root.path(), &job).unwrap();
        let jobs = Jobs::load(root.path()).unwrap();
        let recovered = jobs.record(&job.job_id).unwrap();
        assert_eq!(recovered.status, Status::Interrupted);
        assert_eq!(recovered.input.revision, 7);
        assert!(recovered.input.is_raw);
        assert_eq!(
            recovered.input.current().adjustments,
            job.input.current().adjustments
        );
        assert!(jobs.ensure_idle().is_ok());
    }
    #[test]
    fn cancellation_is_cooperative_persistent_and_does_not_regress_progress() {
        let (root, job) = fixture();
        let jobs = Jobs::load(root.path()).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.entries.lock().unwrap().insert(
            job.job_id.clone(),
            Entry {
                imported: false,
                job: job.clone(),
                cancel: cancel.clone(),
            },
        );
        assert!(jobs.ensure_idle().is_err());
        jobs.progress(&job.job_id, 0.9, "tiles");
        jobs.progress(&job.job_id, 0.1, "tiles");
        assert_eq!(jobs.record(&job.job_id).unwrap().progress_percent, 81);
        jobs.cancel(&json!({"job_id":job.job_id})).unwrap();
        assert!(cancel.load(Ordering::Acquire));
        jobs.progress(&job.job_id, 1.0, "complete");
        assert_eq!(jobs.record(&job.job_id).unwrap().status, Status::Cancelling);
        let recovered = Jobs::load(root.path()).unwrap();
        assert_eq!(
            recovered.record(&job.job_id).unwrap().status,
            Status::Cancelled
        );
        jobs.finish_error(&job.job_id, "JOB_CANCELLED".into());
        assert!(jobs.ensure_idle().is_ok());
    }
    #[test]
    fn result_commit_wins_over_interrupted_job_manifest() {
        let (root, job) = fixture();
        save(root.path(), &job).unwrap();
        let dir = root.path().join("sessions").join(&job.result_session_id);
        fs::create_dir(&dir).unwrap();
        let working = dir.join("source.tiff");
        fs::write(&working, b"derived").unwrap();
        let mut result = job.input.clone();
        result.id = job.result_session_id.clone();
        result.working_path = working.to_string_lossy().into_owned();
        result.history[0].metadata = json!({"derivedFrom":{"job_id":job.job_id}});
        atomic_write(
            &dir.join("session.json"),
            &serde_json::to_vec(&result).unwrap(),
            false,
        )
        .unwrap();
        let jobs = Jobs::load(root.path()).unwrap();
        assert_eq!(jobs.record(&job.job_id).unwrap().status, Status::Succeeded);
        assert_eq!(jobs.record(&job.job_id).unwrap().progress_percent, 100);
    }
    #[test]
    fn unsafe_job_paths_fail_before_loading_captured_sources() {
        let (root, mut job) = fixture();
        job.result_session_id = "../../elsewhere".into();
        save(root.path(), &job).unwrap();
        assert!(Jobs::load(root.path()).is_err());
    }
    #[test]
    fn legacy_worker_manifests_stay_readable_but_refuse_resume() {
        let (root, mut job) = fixture();
        job.method = "nonlocal".into();
        // A manifest written before the backend field existed.
        let mut raw = serde_json::to_vec_pretty(&job).unwrap();
        let mut value: Value = serde_json::from_slice(&raw).unwrap();
        value.as_object_mut().unwrap().remove("backend");
        raw = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(
            root.path()
                .join("jobs")
                .join(format!("{}.json", job.job_id)),
            raw,
        )
        .unwrap();
        let jobs = Jobs::load(root.path()).unwrap();
        let recovered = jobs.record(&job.job_id).unwrap();
        assert_eq!(recovered.backend, "");
        assert_eq!(recovered.status, Status::Interrupted);
        let err = legacy_nonlocal_resume_rejected(&recovered).unwrap();
        assert!(err.starts_with("JOB_NOT_RESUMABLE"), "{err}");
        // User-visible info must agree with the resume guard.
        let info = recovered.info();
        assert_eq!(info["recoverable"], json!(false));
        assert!(
            info["recovery"]
                .as_str()
                .unwrap()
                .contains("start a new denoise job"),
            "{}",
            info["recovery"]
        );
        // Native-generation jobs and unrelated methods are unaffected.
        let mut native = recovered.clone();
        native.backend = crate::nonlocal_onnx::BACKEND_GENERATION.into();
        assert!(legacy_nonlocal_resume_rejected(&native).is_none());
        let native_info = native.info();
        assert_eq!(native_info["recoverable"], json!(true));
        assert!(
            native_info["recovery"]
                .as_str()
                .unwrap()
                .contains("resume_job restarts"),
            "{}",
            native_info["recovery"]
        );
        let mut bm3d = recovered;
        bm3d.method = "bm3d".into();
        bm3d.backend = String::new();
        assert!(legacy_nonlocal_resume_rejected(&bm3d).is_none());
        assert_eq!(bm3d.info()["recoverable"], json!(true));
    }

    #[test]
    fn nonlocal_backends_reject_cross_family_resume() {
        let onnx = crate::nonlocal_onnx::BACKEND_GENERATION;
        let coreml = crate::nonlocal_coreml::COREML_BACKEND_GENERATION;
        let (_, job) = fixture();
        // Same-generation resume is allowed and user-visible recoverability
        // agrees with the resume guard for both native families.
        for backend in [onnx, coreml] {
            assert!(is_native_nonlocal_backend(backend));
            let mut same = job.clone();
            same.method = "nonlocal".into();
            same.backend = backend.into();
            assert!(!is_legacy_nonlocal(&same));
            for status in [Status::Interrupted, Status::Failed, Status::Cancelled] {
                let mut unfinished = same.clone();
                unfinished.status = status;
                let info = unfinished.info();
                assert_eq!(info["recoverable"], json!(true), "{backend} {status:?}");
                assert!(
                    info["recovery"]
                        .as_str()
                        .unwrap()
                        .contains("resume_job restarts"),
                    "{backend} {status:?}: {}",
                    info["recovery"]
                );
            }
            assert!(legacy_nonlocal_resume_rejected(&same).is_none());
            assert!(cross_family_resume_rejected(&same, backend).is_none());
            assert_eq!(same.info()["backend"], json!(backend));
        }
        // Cross-family resume is rejected in both directions.
        let mut from_onnx = job.clone();
        from_onnx.method = "nonlocal".into();
        from_onnx.backend = onnx.into();
        let err = cross_family_resume_rejected(&from_onnx, coreml).unwrap();
        assert!(err.starts_with("JOB_NOT_RESUMABLE"), "{err}");
        assert!(err.contains(coreml), "{err}");
        let mut from_coreml = job.clone();
        from_coreml.method = "nonlocal".into();
        from_coreml.backend = coreml.into();
        let err = cross_family_resume_rejected(&from_coreml, onnx).unwrap();
        assert!(err.starts_with("JOB_NOT_RESUMABLE"), "{err}");
        assert!(err.contains(onnx), "{err}");
        // Legacy worker jobs keep their own rejection and never claim
        // recoverability; unrelated methods are never affected by the
        // family guard.
        let mut legacy = job.clone();
        legacy.method = "nonlocal".into();
        legacy.backend = String::new();
        legacy.status = Status::Interrupted;
        assert!(is_legacy_nonlocal(&legacy));
        assert!(legacy_nonlocal_resume_rejected(&legacy).is_some());
        let legacy_info = legacy.info();
        assert_eq!(legacy_info["recoverable"], json!(false));
        assert!(
            legacy_info["recovery"]
                .as_str()
                .unwrap()
                .contains("start a new denoise job"),
            "{}",
            legacy_info["recovery"]
        );
        let mut bm3d = job;
        bm3d.method = "bm3d".into();
        bm3d.backend = String::new();
        assert!(cross_family_resume_rejected(&bm3d, coreml).is_none());
    }
}
