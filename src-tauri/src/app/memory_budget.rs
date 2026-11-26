use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::library::file_ops::read_file_mapped;

pub struct MemoryBudget {
    total: u64,
    available: Mutex<u64>,
    released: Condvar,
    waiting: AtomicUsize,
}

pub struct MemoryReservation {
    budget: Arc<MemoryBudget>,
    bytes: u64,
}

struct Waiting<'a>(&'a AtomicUsize);

impl<'a> Waiting<'a> {
    fn enter(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl MemoryBudget {
    pub fn new(total: u64) -> Arc<Self> {
        Arc::new(Self {
            total,
            available: Mutex::new(total),
            released: Condvar::new(),
            waiting: AtomicUsize::new(0),
        })
    }

    pub fn from_total_ram(fraction: f64) -> Arc<Self> {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        Self::new((sys.total_memory() as f64 * fraction) as u64)
    }

    pub fn reserve(
        self: &Arc<Self>,
        bytes: u64,
        cancellation_token: Option<&AtomicBool>,
    ) -> Option<MemoryReservation> {
        self.take(bytes, cancellation_token, false)
    }

    pub fn reserve_behind_waiters(
        self: &Arc<Self>,
        bytes: u64,
        cancellation_token: &AtomicBool,
    ) -> Option<MemoryReservation> {
        self.take(bytes, Some(cancellation_token), true)
    }

    fn take(
        self: &Arc<Self>,
        bytes: u64,
        cancellation_token: Option<&AtomicBool>,
        yielding: bool,
    ) -> Option<MemoryReservation> {
        let bytes = bytes.min(self.total);
        let mut available = self.available.lock().unwrap_or_else(|e| e.into_inner());
        let mut waiting = None;
        while *available < bytes || (yielding && self.waiting.load(Ordering::SeqCst) > 0) {
            if cancellation_token.is_some_and(|token| token.load(Ordering::SeqCst)) {
                return None;
            }
            if !yielding {
                waiting.get_or_insert_with(|| Waiting::enter(&self.waiting));
            }
            available = self
                .released
                .wait_timeout(available, Duration::from_millis(200))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        *available -= bytes;
        Some(MemoryReservation {
            budget: Arc::clone(self),
            bytes,
        })
    }
}

impl Drop for MemoryReservation {
    fn drop(&mut self) {
        *self
            .budget
            .available
            .lock()
            .unwrap_or_else(|e| e.into_inner()) += self.bytes;
        self.budget.released.notify_all();
    }
}

pub fn image_pixel_count(path: &Path, is_raw: bool) -> Option<u64> {
    if is_raw {
        return raw_pixel_count(&read_file_mapped(path).ok()?);
    }
    let (width, height) = image::image_dimensions(path).ok()?;
    Some(width as u64 * height as u64)
}

pub fn raw_pixel_count(file_bytes: &[u8]) -> Option<u64> {
    let (width, height) = crate::decode::raw_processing::raw_dimensions(file_bytes)?;
    Some(width as u64 * height as u64)
}
