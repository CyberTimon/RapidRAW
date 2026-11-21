use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::library::file_ops::write_file_atomic;
use crate::render::gpu::context::app_handle;

const ATTEMPT_FILE: &str = "gpu_backend_attempt.json";
const BACKEND_FILE: &str = "gpu_backend_failure.json";

const BACKEND_ORDER: &[&str] = if cfg!(target_os = "windows") {
    &["dx12", "vulkan", "gl"]
} else if cfg!(any(target_os = "macos", target_os = "ios")) {
    &["metal"]
} else {
    &["vulkan", "gl"]
};

pub fn app_version() -> String {
    app_handle()
        .map(|handle| handle.package_info().version.to_string())
        .unwrap_or_default()
}

pub fn gpu_identity(adapter: &str) -> String {
    format!("{}, RapidRAW {}", adapter, app_version())
}

fn data_file(name: &str) -> Option<PathBuf> {
    Some(app_handle()?.path().app_data_dir().ok()?.join(name))
}

pub fn load_record<T: DeserializeOwned>(name: &str) -> Option<T> {
    let bytes = std::fs::read(data_file(name)?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn store_record<T: Serialize>(name: &str, record: Option<&T>) {
    let Some(path) = data_file(name) else {
        return;
    };
    match record.and_then(|record| serde_json::to_vec(record).ok()) {
        Some(json) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = write_file_atomic(&path, &json);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Attempt {
    version: String,
    backend: String,
}

#[derive(Serialize, Deserialize, Default)]
struct BackendRecord {
    version: String,
    suspected: Vec<String>,
    confirmed: Vec<String>,
}

impl BackendRecord {
    fn is_empty(&self) -> bool {
        self.suspected.is_empty() && self.confirmed.is_empty()
    }

    fn crashed(&mut self, backend: String) {
        if self.suspected.contains(&backend) {
            self.suspected.retain(|suspected| *suspected != backend);
            if !self.confirmed.contains(&backend) {
                self.confirmed.push(backend);
            }
        } else if !self.confirmed.contains(&backend) {
            self.suspected.push(backend);
        }
    }

    fn succeeded(&mut self, backend: &str) -> bool {
        let before = self.suspected.len() + self.confirmed.len();
        self.suspected.retain(|suspected| suspected != backend);
        self.confirmed.retain(|confirmed| confirmed != backend);
        before != self.suspected.len() + self.confirmed.len()
    }

    fn store(&self) {
        store_record(BACKEND_FILE, (!self.is_empty()).then_some(self));
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackendFallback {
    failed: String,
    using: String,
    retry_pending: bool,
}

static ACTIVE_BACKEND_FALLBACK: Mutex<Option<BackendFallback>> = Mutex::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);

fn current_record() -> BackendRecord {
    let version = app_version();
    load_record::<BackendRecord>(BACKEND_FILE)
        .filter(|record| record.version == version)
        .unwrap_or(BackendRecord {
            version,
            ..BackendRecord::default()
        })
}

pub fn backend_name(backend: wgpu::Backend) -> &'static str {
    match backend {
        wgpu::Backend::Vulkan => "vulkan",
        wgpu::Backend::Metal => "metal",
        wgpu::Backend::Dx12 => "dx12",
        wgpu::Backend::Gl => "gl",
        _ => "auto",
    }
}

pub fn choose_backend(setting: Option<&str>) -> Option<String> {
    let mut record = current_record();
    let crashed = load_record::<Attempt>(ATTEMPT_FILE)
        .filter(|attempt| attempt.version == record.version)
        .map(|attempt| match attempt.backend.as_str() {
            "auto" => BACKEND_ORDER[0].to_string(),
            _ => attempt.backend,
        });
    store_record::<Attempt>(ATTEMPT_FILE, None);
    if let Some(backend) = &crashed {
        log::warn!(
            "The {} backend crashed while starting the GPU last time",
            backend
        );
        record.crashed(backend.clone());
        record.store();
    }

    if let Some(explicit) = setting.filter(|backend| *backend != "auto") {
        if BACKEND_ORDER.contains(&explicit) {
            return Some(explicit.to_string());
        }
        log::warn!(
            "The {} backend is not available on this platform, using the automatic choice",
            explicit
        );
    }
    let (failed, using) = fallback_for(&record, crashed.as_deref(), BACKEND_ORDER)?;
    log::warn!(
        "Using the {} backend because {} crashed on this GPU",
        using,
        failed
    );
    *ACTIVE_BACKEND_FALLBACK
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(BackendFallback {
        failed: failed.clone(),
        using: using.to_string(),
        retry_pending: false,
    });
    Some(using.to_string())
}

fn fallback_for(
    record: &BackendRecord,
    crashed: Option<&str>,
    order: &[&'static str],
) -> Option<(String, &'static str)> {
    let avoided: Vec<&str> = record
        .confirmed
        .iter()
        .map(String::as_str)
        .chain(crashed.filter(|backend| record.suspected.iter().any(|s| s == backend)))
        .collect();
    let failed = avoided.first()?;
    let using = order.iter().find(|backend| !avoided.contains(backend))?;
    Some((failed.to_string(), using))
}

pub fn begin_attempt(backend: &str) {
    if STARTED.load(Ordering::Acquire) {
        return;
    }
    store_record(
        ATTEMPT_FILE,
        Some(&Attempt {
            version: app_version(),
            backend: backend.to_string(),
        }),
    );
}

pub fn abandon_attempt() {
    store_record::<Attempt>(ATTEMPT_FILE, None);
}

pub fn gpu_started(backend: wgpu::Backend) {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    abandon_attempt();
    let mut record = current_record();
    if record.succeeded(backend_name(backend)) {
        record.store();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuFallbacks {
    backend: Option<BackendFallback>,
    raw_decoding_megapixels: Option<f32>,
    raw_decoding_unavailable: bool,
}

#[tauri::command]
pub fn get_gpu_fallbacks() -> GpuFallbacks {
    GpuFallbacks {
        backend: ACTIVE_BACKEND_FALLBACK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        raw_decoding_megapixels: crate::decode::gpu_fallback::cpu_limit()
            .map(|pixels| pixels as f32 / 1_000_000.0),
        raw_decoding_unavailable: crate::decode::gpu_fallback::kernels_failed(),
    }
}

#[tauri::command]
pub fn reset_gpu_fallback(kind: String) {
    match kind.as_str() {
        "backend" => {
            store_record::<BackendRecord>(BACKEND_FILE, None);
            if let Some(fallback) = ACTIVE_BACKEND_FALLBACK
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
            {
                fallback.retry_pending = true;
            }
        }
        "rawDecoding" => crate::decode::gpu_fallback::reset(),
        _ => {}
    }
}
