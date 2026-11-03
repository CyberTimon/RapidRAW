use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const GB: f64 = 1e9;
const TARGET: &str = "panorama";

pub struct StitchLog {
    noted: AtomicBool,
    stop: Arc<AtomicBool>,
}

impl StitchLog {
    pub fn new(stop: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            noted: AtomicBool::new(false),
            stop,
        })
    }
    pub fn halted(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn note_stop(&self) {
        if self.halted() && !self.noted.swap(true, Ordering::SeqCst) {
            phase("stopped");
        }
    }
}

pub fn line(msg: &str) {
    log::debug!(target: TARGET, "{msg}");
}

pub fn phase(msg: &str) {
    let (used, total) = super::ram::used_and_total_system();
    let ours = super::ram::process_resident_bytes();
    log::info!(
        target: TARGET,
        "[mem sys {:.2}/{:.2}GB ({:.0}%) app {:.2}GB] {msg}",
        used as f64 / GB,
        total as f64 / GB,
        if total == 0 {
            0.0
        } else {
            used as f64 / total as f64 * 100.0
        },
        ours as f64 / GB,
    );
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

pub fn current() -> Option<Arc<StitchLog>> {
    ACTIVE.with(|slot| slot.borrow().clone())
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
