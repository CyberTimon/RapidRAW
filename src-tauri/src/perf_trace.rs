//! Stage timing for the headless `bench` command. Spans cost one relaxed atomic load while
//! disabled; `gpu_sync` attributes queued GPU work to the span that submitted it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static ENABLED: AtomicBool = AtomicBool::new(false);
static GPU_SYNC: AtomicBool = AtomicBool::new(false);
static SAMPLES: Mutex<Vec<(&'static str, Duration)>> = Mutex::new(Vec::new());

pub fn configure(enabled: bool, gpu_sync: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    GPU_SYNC.store(enabled && gpu_sync, Ordering::Relaxed);
}

#[inline]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub struct Span {
    name: &'static str,
    start: Option<Instant>,
}

#[inline]
pub fn span(name: &'static str) -> Span {
    Span {
        name,
        start: enabled().then(Instant::now),
    }
}

impl Span {
    pub fn gpu_sync(&self, device: &wgpu::Device) {
        if self.start.is_some() && GPU_SYNC.load(Ordering::Relaxed) {
            let _ = device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(60)),
            });
        }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some(start) = self.start {
            let elapsed = start.elapsed();
            SAMPLES
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((self.name, elapsed));
        }
    }
}

pub fn take() -> Vec<(&'static str, Duration)> {
    std::mem::take(&mut *SAMPLES.lock().unwrap_or_else(|e| e.into_inner()))
}
