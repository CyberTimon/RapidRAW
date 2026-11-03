use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const GB: f64 = 1e9;
const TARGET: &str = "panorama";

pub struct StitchLog {
    noted: AtomicBool,
    stop: Arc<AtomicBool>,
}

impl StitchLog {
    pub fn new(stop: Arc<AtomicBool>) -> Self {
        Self {
            noted: AtomicBool::new(false),
            stop,
        }
    }
    pub fn halted(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn note_stop(&self) {
        if self.halted() && !self.noted.swap(true, Ordering::SeqCst) {
            phase("stopped");
        }
    }
    pub fn gate(&self) -> Result<(), String> {
        if self.halted() {
            self.note_stop();
            Err("stopped".into())
        } else {
            Ok(())
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
