use sysinfo::System;

pub const RAM_CRITICAL_THRESHOLD_GB: f64 = 1.5;
pub const RAM_LOW_THRESHOLD_GB: f64 = 2.5;

/// Returns the available system RAM in Gigabytes (GB).
pub fn get_available_system_memory_gb() -> f64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.available_memory() as f64 / 1024.0 / 1024.0 / 1024.0
}

/// Returns a safe number of worker threads that always reserves at least 1-2 CPU cores
/// for the operating system and other foreground user applications.
pub fn get_safe_worker_core_count() -> usize {
    let available_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    
    if available_cores <= 2 {
        1
    } else if available_cores <= 4 {
        available_cores - 1
    } else {
        // For 6+ cores, reserve 2 cores for OS / active apps (Photoshop, Chrome, Premiere, etc.)
        available_cores - 2
    }
}

/// Checks current system RAM pressure. If available memory is critically low,
/// flushes caches in AppState to prevent OS Out-Of-Memory (OOM) termination.
pub fn check_and_mitigate_memory_pressure(state: &crate::AppState) -> bool {
    let free_ram_gb = get_available_system_memory_gb();
    if free_ram_gb < RAM_CRITICAL_THRESHOLD_GB {
        log::warn!(
            "[MemoryGovernor] Low system memory detected ({:.2} GB free). Actively pruning caches...",
            free_ram_gb
        );
        crate::cache_utils::clear_session_caches_internal(state);
        crate::cache_utils::clear_image_caches_internal(state);
        true
    } else {
        false
    }
}

// Windows native OS thread priority management
#[cfg(target_os = "windows")]
mod win32_priority {
    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;

    const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    const THREAD_PRIORITY_NORMAL: i32 = 0;

    unsafe extern "system" {
        fn GetCurrentThread() -> HANDLE;
        fn SetThreadPriority(hThread: HANDLE, nPriority: i32) -> BOOL;
    }

    pub fn set_thread_below_normal() {
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }

    pub fn set_thread_normal() {
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
        }
    }
}

/// Sets the current background worker thread to below-normal OS priority on Windows.
/// This guarantees that active foreground apps (browsers, editors, games) never stutter.
pub fn set_background_thread_priority() {
    #[cfg(target_os = "windows")]
    win32_priority::set_thread_below_normal();
}

/// Restores normal thread priority.
pub fn set_normal_thread_priority() {
    #[cfg(target_os = "windows")]
    win32_priority::set_thread_normal();
}

/// RAII Guard that automatically applies below-normal thread priority and restores normal priority when dropped.
pub struct BackgroundPriorityGuard;

impl BackgroundPriorityGuard {
    pub fn new() -> Self {
        set_background_thread_priority();
        Self
    }
}

impl Drop for BackgroundPriorityGuard {
    fn drop(&mut self) {
        set_normal_thread_priority();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_worker_core_count_reserves_cores() {
        let cores = get_safe_worker_core_count();
        assert!(cores >= 1);
        let total = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        if total > 1 {
            assert!(cores < total);
        }
    }

    #[test]
    fn test_memory_inspection_returns_positive() {
        let mem = get_available_system_memory_gb();
        assert!(mem > 0.0);
    }
}
