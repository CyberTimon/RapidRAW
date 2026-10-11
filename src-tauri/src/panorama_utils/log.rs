use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

const GB: f64 = 1e9;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::Local;

pub struct StitchLog {
    file: Mutex<std::fs::File>,
    started: Instant,
    noted: AtomicBool,
    stop: Arc<AtomicBool>,
}

impl StitchLog {
    pub fn create(path: &Path, stop: Arc<AtomicBool>) -> Result<Arc<Self>, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create the log folder: {e}"))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        let log = Arc::new(Self {
            file: Mutex::new(file),
            started: Instant::now(),
            noted: AtomicBool::new(false),
            stop,
        });
        log.line(&format!("log {}", path.display()));
        Ok(log)
    }
    pub fn append(path: &Path, stop: Arc<AtomicBool>) -> Result<Arc<Self>, String> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        let log = Arc::new(Self {
            file: Mutex::new(file),
            started: Instant::now(),
            noted: AtomicBool::new(false),
            stop,
        });
        log.line("continue");
        Ok(log)
    }
    pub fn append_since(
        path: &Path,
        stop: Arc<AtomicBool>,
        started: Instant,
    ) -> Result<Arc<Self>, String> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        Ok(Arc::new(Self {
            file: Mutex::new(file),
            started,
            noted: AtomicBool::new(false),
            stop,
        }))
    }
    pub fn origin(&self) -> Instant {
        self.started
    }
    pub fn line(&self, msg: &str) {
        let stamp = Local::now().format("%H:%M:%S");
        let elapsed = self.started.elapsed().as_secs_f32();
        let (used, total) = super::ram::used_and_total_system();
        let ours = super::ram::process_resident_bytes();
        let text = format!(
            "[{stamp}] +{elapsed:.1}s [mem sys {:.2}/{:.2}GB ({:.0}%) app {:.2}GB] {msg}\n",
            used as f64 / GB,
            total as f64 / GB,
            if total == 0 {
                0.0
            } else {
                used as f64 / total as f64 * 100.0
            },
            ours as f64 / GB,
        );
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(text.as_bytes());
            let _ = file.flush();
        }
    }
    pub fn halted(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn note_stop(&self) {
        if self.halted() && !self.noted.swap(true, Ordering::SeqCst) {
            self.line("stopped");
        }
    }
}

std::thread_local! {
    static ACTIVE: std::cell::RefCell<Option<Arc<StitchLog>>> = const { std::cell::RefCell::new(None) };
}

pub struct LogGuard;

impl Drop for LogGuard {
    fn drop(&mut self) {
        ACTIVE.with(|slot| *slot.borrow_mut() = None);
    }
}

pub fn install(log: Arc<StitchLog>) -> LogGuard {
    ACTIVE.with(|slot| *slot.borrow_mut() = Some(log));
    LogGuard
}

pub fn line(msg: &str) {
    ACTIVE.with(|slot| {
        if let Some(log) = slot.borrow().as_ref() {
            log.line(msg);
        }
    });
}

pub fn current() -> Option<Arc<StitchLog>> {
    ACTIVE.with(|slot| slot.borrow().clone())
}

pub fn started() -> Option<Instant> {
    ACTIVE.with(|slot| slot.borrow().as_ref().map(|log| log.origin()))
}

pub fn halted() -> bool {
    ACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|log| log.halted())
            .unwrap_or(false)
    })
}

pub fn note_stop() {
    ACTIVE.with(|slot| {
        if let Some(log) = slot.borrow().as_ref() {
            log.note_stop();
        }
    });
}

pub fn gate() -> Result<(), String> {
    if halted() {
        note_stop();
        Err("stopped".into())
    } else {
        Ok(())
    }
}
