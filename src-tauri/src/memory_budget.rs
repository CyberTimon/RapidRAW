use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::file_management::read_file_mapped;

pub struct MemoryBudget {
    total: u64,
    available: Mutex<u64>,
    released: Condvar,
}

pub struct MemoryReservation {
    budget: Arc<MemoryBudget>,
    bytes: u64,
}

impl MemoryBudget {
    pub fn new(total: u64) -> Arc<Self> {
        Arc::new(Self {
            total,
            available: Mutex::new(total),
            released: Condvar::new(),
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
        let bytes = bytes.min(self.total);
        let mut available = self.available.lock().unwrap_or_else(|e| e.into_inner());
        while *available < bytes {
            if cancellation_token.is_some_and(|token| token.load(Ordering::SeqCst)) {
                return None;
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
    let (width, height) = if is_raw {
        let mmap = read_file_mapped(path).ok()?;
        crate::raw_processing::raw_dimensions(&mmap).map(|(w, h)| (w as u64, h as u64))?
    } else {
        image::image_dimensions(path)
            .ok()
            .map(|(w, h)| (w as u64, h as u64))?
    };
    Some(width * height)
}
