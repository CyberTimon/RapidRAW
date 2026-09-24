//! In-App Sleep Prevention Guard for RapidRAW
//!
//! Prevents the operating system from going to sleep or throttling the CPU/GPU
//! while long-running tasks (Astro Stacking, Focus Stacking, AI Processing, Batch Export)
//! are executing. Automatically releases the wake-lock when dropped (RAII).

use log::info;

#[cfg(target_os = "windows")]
mod sys {
    const ES_CONTINUOUS: u32 = 0x80000000;
    const ES_SYSTEM_REQUIRED: u32 = 0x00000001;
    const ES_DISPLAY_REQUIRED: u32 = 0x00000002;
    const ES_AWAYMODE_REQUIRED: u32 = 0x00000040;

    unsafe extern "system" {
        fn SetThreadExecutionState(es_flags: u32) -> u32;
    }

    pub fn acquire() {
        unsafe {
            SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_AWAYMODE_REQUIRED,
            );
        }
    }

    pub fn release() {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod sys {
    pub fn acquire() {}
    pub fn release() {}
}

/// RAII Guard that prevents OS sleep while in scope.
pub struct SleepLockGuard {
    task_name: &'static str,
}

impl SleepLockGuard {
    /// Creates a new sleep prevention lock for the designated task.
    pub fn new(task_name: &'static str) -> Self {
        info!("[SleepLock] Locking OS sleep for task: {}", task_name);
        sys::acquire();
        Self { task_name }
    }
}

impl Drop for SleepLockGuard {
    fn drop(&mut self) {
        info!("[SleepLock] Releasing OS sleep lock for task: {}", self.task_name);
        sys::release();
    }
}
