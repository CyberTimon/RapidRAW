use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, Once};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::app::settings::load_settings;
use crate::library::file_ops::write_file_atomic;
use crate::render::gpu::context::{DecodeGpu, app_handle, decode_gpu_context};

const RECORD_FILE: &str = "gpu_decode_failure.json";

#[derive(Clone, Copy, Serialize, Deserialize)]
pub(crate) struct Load {
    pub pixels: usize,
    pub demosaic: bool,
}

impl Load {
    fn disproved_by(self, success: Load) -> bool {
        success.pixels >= self.pixels && (success.demosaic || !self.demosaic)
    }
}

fn lowest(a: Option<Load>, b: Option<Load>) -> Option<Load> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if (b.pixels, !b.demosaic) < (a.pixels, !a.demosaic) {
            b
        } else {
            a
        }),
        (a, b) => a.or(b),
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    gpu: String,
    confirmed: Option<Load>,
    suspected: Option<Load>,
}

struct Memory {
    confirmed: Option<Load>,
    suspected: Option<Load>,
    session: Option<Load>,
    recalled: bool,
}

static MEMORY: Mutex<Memory> = Mutex::new(Memory {
    confirmed: None,
    suspected: None,
    session: None,
    recalled: false,
});

fn memory() -> MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

fn record_path() -> Option<PathBuf> {
    Some(app_handle()?.path().app_data_dir().ok()?.join(RECORD_FILE))
}

fn raw_decoding() -> String {
    app_handle()
        .and_then(|handle| load_settings(handle.clone()).ok())
        .and_then(|settings| settings.raw_decoding)
        .unwrap_or_default()
}

fn identity(context: &DecodeGpu) -> String {
    let version = app_handle()
        .map(|handle| handle.package_info().version.to_string())
        .unwrap_or_default();
    format!("{}, RapidRAW {}", context.adapter, version)
}

impl Memory {
    fn skips(&self, pixels: usize) -> bool {
        lowest(self.confirmed, self.session).is_some_and(|limit| pixels >= limit.pixels)
    }

    fn recall(&mut self, gpu: &str) {
        if std::mem::replace(&mut self.recalled, true) {
            return;
        }
        let record = record_path()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
            .filter(|record| record.gpu == gpu);
        match record {
            Some(record) => {
                self.confirmed = record.confirmed;
                self.suspected = record.suspected;
            }
            None => self.persist(gpu.to_string()),
        }
        if let Some(confirmed) = self.confirmed {
            log::info!(
                "The GPU failed to develop images of {} pixels and more before",
                confirmed.pixels
            );
        }
    }

    fn failed(&mut self, gpu: String, attempt: Load) {
        self.session = lowest(self.session, Some(attempt));
        if let Some(suspected) = self.suspected {
            let repeated = if attempt.pixels >= suspected.pixels {
                attempt
            } else {
                suspected
            };
            self.confirmed = lowest(self.confirmed, Some(repeated));
        }
        self.persist(gpu);
    }

    fn succeeded(&mut self, gpu: String, success: Load) {
        let known = [self.confirmed, self.suspected, self.session];
        if !known
            .iter()
            .flatten()
            .any(|load| load.disproved_by(success))
        {
            return;
        }
        let [confirmed, suspected, session] =
            known.map(|load| load.filter(|load| !load.disproved_by(success)));
        (self.confirmed, self.suspected, self.session) = (confirmed, suspected, session);
        self.persist(gpu);
    }

    fn persist(&self, gpu: String) {
        let Some(path) = record_path() else {
            return;
        };
        let record = Record {
            gpu,
            confirmed: self.confirmed,
            suspected: lowest(self.suspected, self.session),
        };
        if record.confirmed.is_none() && record.suspected.is_none() {
            let _ = std::fs::remove_file(path);
        } else if let Ok(json) = serde_json::to_vec(&record) {
            let _ = write_file_atomic(&path, &json);
        }
    }
}

fn scoped<T>(device: &wgpu::Device, run: impl FnOnce() -> Result<T>) -> Result<T> {
    let out_of_memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let invalid = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let result = run();
    let invalid = pollster::block_on(invalid.pop());
    if let Some(error) = pollster::block_on(out_of_memory.pop()).or(invalid) {
        return Err(anyhow!("{}", error));
    }
    result
}

pub(crate) fn on_gpu<T>(load: Load, run: impl FnOnce(&DecodeGpu) -> Result<T>) -> Option<T> {
    static UNAVAILABLE: Once = Once::new();

    let mode = raw_decoding();
    let skipped = |memory: &Memory| mode != "gpu" && memory.skips(load.pixels);
    if mode == "cpu" || skipped(&memory()) {
        return None;
    }
    let context = match decode_gpu_context() {
        Ok(context) => context,
        Err(e) => {
            UNAVAILABLE.call_once(|| log::warn!("Developing on the CPU: {}", e));
            return None;
        }
    };
    let gpu = identity(&context);
    {
        let mut memory = memory();
        memory.recall(&gpu);
        if skipped(&memory) {
            return None;
        }
    }
    match scoped(&context.device, || run(&context)) {
        Ok(result) => {
            memory().succeeded(gpu, load);
            Some(result)
        }
        Err(e) => {
            log::warn!(
                "GPU develop of {} pixels failed, continuing on the CPU: {}",
                load.pixels,
                e
            );
            memory().failed(gpu, load);
            None
        }
    }
}
