const SIX_HOURS_SECS: u64 = 6 * 60 * 60;

use std::fs::{File, OpenOptions};
use std::marker::PhantomData;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};

pub enum Store<T> {

    Ram(Vec<T>),
    Disk(memmap2::MmapMut, PhantomData<T>),
}

impl<T: Copy + Default> Store<T> {

    pub fn zeroes(len: usize) -> Self {
        Store::Ram(vec![T::default(); len])
    }
    pub fn ram(v: Vec<T>) -> Self {
        Store::Ram(v)
    }
    pub fn empty() -> Self {
        Store::Ram(Vec::new())
    }
    pub fn try_zeroes(len: usize) -> Result<Self, String> {
        let mut data: Vec<T> = Vec::new();
        data.try_reserve_exact(len)
            .map_err(|_| format!("Not enough memory to allocate {} elements.", len))?;
        data.resize(len, T::default());
        Ok(Store::Ram(data))
    }
    pub fn try_mapped(len: usize, scratch: Option<&SpillFile>) -> Result<Self, String> {
        match scratch {
            Some(file) => Store::mapped(len, file),
            None => Store::try_zeroes(len),
        }
    }
    pub fn to_disk(&mut self, scratch: &SpillFile) -> Result<(), String> {
        let Store::Ram(data) = self else {
            return Ok(());
        };
        if data.is_empty() {
            return Ok(());
        }
        let bytes = data.len() * std::mem::size_of::<T>();
        let mut map = scratch.map(bytes)?;
        let dst =
            unsafe { std::slice::from_raw_parts_mut(map.as_mut_ptr().cast::<T>(), data.len()) };
        dst.copy_from_slice(data);
        *self = Store::Disk(map, PhantomData);
        Ok(())
    }
    pub fn mapped(len: usize, scratch: &SpillFile) -> Result<Self, String> {
        if len == 0 {
            return Ok(Store::Ram(Vec::new()));
        }
        let bytes = len
            .checked_mul(std::mem::size_of::<T>())
            .ok_or_else(|| "Spill buffer size overflows.".to_string())?;
        if bytes > i64::MAX as usize {
            return Ok(Store::Ram(vec![T::default(); len]));
        }
        if !scratch.is_some() {
            return Ok(Store::Ram(vec![T::default(); len]));
        }
        let map = scratch.map(bytes)?;
        Ok(Store::Disk(map, PhantomData))
    }
    pub fn is_disk(&self) -> bool {
        matches!(self, Store::Disk(..))
    }
    pub fn bytes(&self) -> usize {
        self.len() * std::mem::size_of::<T>()
    }

}

impl<T: Copy + Default> Default for Store<T> {
    fn default() -> Self {
        Store::Ram(Vec::new())
    }
}

impl<T: Copy + Default> Clone for Store<T> {
    fn clone(&self) -> Self {
        Store::Ram(self[..].to_vec())
    }
}

impl<T: Copy + Default + PartialEq> PartialEq for Store<T> {
    fn eq(&self, other: &Self) -> bool {
        self[..] == other[..]
    }
}

impl<T: Copy + Default> std::fmt::Debug for Store<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Store(len={}, on_disk={})", self.len(), self.is_disk())
    }
}

impl<T> Deref for Store<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        match self {
            Store::Ram(v) => v,
            Store::Disk(m, _) => {
                let n = m.len() / std::mem::size_of::<T>().max(1);
                unsafe { std::slice::from_raw_parts(m.as_ptr() as *const T, n) }
            }
        }
    }
}

impl<T> DerefMut for Store<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        match self {
            Store::Ram(v) => v,
            Store::Disk(m, _) => {
                let n = m.len() / std::mem::size_of::<T>().max(1);
                unsafe { std::slice::from_raw_parts_mut(m.as_ptr() as *mut T, n) }
            }
        }
    }
}

impl<T: Copy + Default> Store<T> {

    pub fn to_vec(&self) -> Vec<T> {
        self[..].to_vec()
    }
}

impl<T: Copy + Default> From<Vec<T>> for Store<T> {
    fn from(v: Vec<T>) -> Self {
        Store::Ram(v)
    }
}

pub struct SpillFile {
    path: Option<PathBuf>,
    file: Option<File>,
    cursor: std::sync::atomic::AtomicU64,
    capacity: std::sync::atomic::AtomicU64,
}

impl SpillFile {

    pub fn beside(output_path: &Path) -> Result<Self, String> {
        let dir = output_path
            .parent()
            .ok_or_else(|| "Could not determine the output directory.".to_string())?;
        let stem = output_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("panorama");
        let swept = sweep_stale_spill(dir, SIX_HOURS_SECS);
        if swept > 0 {
            super::log::line(&format!(
                "SPILL removed {swept} stale scratch file(s) from {}",
                dir.display()
            ));
        }
        let path = dir.join(format!("{stem}.spill"));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| format!("Could not create scratch file {}: {e}", path.display()))?;
        Ok(SpillFile {
            path: Some(path),
            file: Some(file),
            cursor: std::sync::atomic::AtomicU64::new(0),
            capacity: std::sync::atomic::AtomicU64::new(0),
        })
    }
    pub fn none() -> Self {
        SpillFile {
            path: None,
            file: None,
            cursor: std::sync::atomic::AtomicU64::new(0),
            capacity: std::sync::atomic::AtomicU64::new(0),
        }
    }
    pub fn is_some(&self) -> bool {
        self.file.is_some()
    }
    pub fn used(&self) -> u64 {
        self.cursor.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn map(&self, bytes: usize) -> Result<memmap2::MmapMut, String> {
        let file = self.file.as_ref().ok_or("No scratch file open.")?;
        let offset = self
            .cursor
            .fetch_add(bytes as u64, std::sync::atomic::Ordering::Relaxed);
        let total = offset.saturating_add(bytes as u64);
        super::log::line(&format!(
            "SPILL map off={offset} bytes={bytes} total={total}"
        ));
        let want = total;
        if want > self.capacity.load(std::sync::atomic::Ordering::Relaxed) {
            self.capacity
                .store(want, std::sync::atomic::Ordering::Relaxed);
            file.set_len(want)
                .map_err(|e| format!("Could not grow the scratch file: {e}"))?;
        }
        unsafe {
            memmap2::MmapOptions::new()
                .len(bytes)
                .offset(offset)
                .map_mut(file)
                .map_err(|e| format!("Could not map the scratch file: {e}"))
        }
    }
}

impl Drop for SpillFile {
    fn drop(&mut self) {
        self.file = None;
        if let Some(p) = self.path.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub fn disk_free_space(path: &Path) -> Option<u64> {
    let target = std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .or_else(|| path.parent().map(|d| d.to_path_buf()))?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for disk in &disks {
        let mount = disk.mount_point();
        let matches = target.starts_with(mount)
            || std::fs::canonicalize(mount)
                .map(|m| target.starts_with(m))
                .unwrap_or(false);
        if !matches {
            continue;
        }
        let len = mount.as_os_str().len();
        if best.is_none_or(|(bl, _)| len > bl) {
            best = Some((len, disk.available_space()));
        }
    }
    best.map(|(_, free)| free)
}

pub fn sweep_stale_spill(dir: &Path, older_than_secs: u64) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_spill = path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("spill"));
        if !is_spill {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .is_ok_and(|d| d.as_secs() > older_than_secs)
            && std::fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

pub struct Scratch {
    path: std::path::PathBuf,
    trigger_percent: u64,
    forced_used: std::sync::atomic::AtomicU64,
    file: std::sync::OnceLock<SpillFile>,
    spilling: std::sync::atomic::AtomicBool,
    meter: std::sync::Mutex<crate::panorama_utils::ram::ResidentMeter>,
    system: std::sync::Mutex<crate::panorama_utils::ram::SystemMeter>,
    spilled_at: std::sync::atomic::AtomicU64,
}

impl Scratch {

    pub fn new(output_path: &std::path::Path, trigger_percent: u64) -> Self {
        Self {
            path: output_path.to_path_buf(),
            trigger_percent,
            forced_used: std::sync::atomic::AtomicU64::new(0),
            file: std::sync::OnceLock::new(),
            spilling: std::sync::atomic::AtomicBool::new(false),
            meter: std::sync::Mutex::new(crate::panorama_utils::ram::ResidentMeter::new()),
            system: std::sync::Mutex::new(crate::panorama_utils::ram::SystemMeter::new()),
            spilled_at: std::sync::atomic::AtomicU64::new(0),
        }
    }
    pub fn force_used(&self, bytes: u64) {
        self.forced_used
            .store(bytes, std::sync::atomic::Ordering::Relaxed);
    }
    fn used_and_trigger(&self) -> (u64, u64) {
        let (used, total) = self
            .system
            .lock()
            .map(|m| m.used_and_total())
            .unwrap_or((0, 0));
        let forced = self.forced_used.load(std::sync::atomic::Ordering::Relaxed);
        let used = used.max(forced);
        (used, total.saturating_mul(self.trigger_percent) / 100)
    }
    pub fn in_ram_only() -> Self {
        Self {
            path: std::path::PathBuf::new(),
            trigger_percent: u64::MAX,
            forced_used: std::sync::atomic::AtomicU64::new(0),
            file: std::sync::OnceLock::new(),
            spilling: std::sync::atomic::AtomicBool::new(false),
            meter: std::sync::Mutex::new(crate::panorama_utils::ram::ResidentMeter::new()),
            system: std::sync::Mutex::new(crate::panorama_utils::ram::SystemMeter::new()),
            spilled_at: std::sync::atomic::AtomicU64::new(0),
        }
    }
    pub fn check(&self) {
        if self.spilling.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let (used, trigger) = self.used_and_trigger();
        if used < trigger {
            return;
        }
        if self.file.get().is_some() {
            self.spilling
                .store(true, std::sync::atomic::Ordering::Relaxed);
            return;
        }
        if self
            .spilling
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
            && let Ok(file) = SpillFile::beside(&self.path)
        {
            let _ = self.file.set(file);
            self.spilled_at
                .store(used, std::sync::atomic::Ordering::Relaxed);
            super::log::line(&format!(
                "SPILL switching to disk: system {:.2} GB used of {:.2} GB ({}%), app {:.2} GB, scratch {}",
                used as f64 / 1e9,
                trigger as f64 / 1e9,
                self.trigger_percent,
                self.meter.lock().map(|m| m.resident()).unwrap_or_default() as f64 / 1e9,
                self.path.display()
            ));
        }
    }
    pub fn file(&self) -> Option<&SpillFile> {
        self.file.get()
    }
    pub fn is_spilling(&self) -> bool {
        self.file.get().is_some()
    }
    pub fn spilled_at(&self) -> Option<u64> {
        match self.spilled_at.load(std::sync::atomic::Ordering::Relaxed) {
            0 => None,
            v => Some(v),
        }
    }
    pub fn peak_resident(&self) -> u64 {
        self.meter.lock().map(|m| m.peak()).unwrap_or_default()
    }
    pub fn disk_bytes(&self) -> u64 {
        self.file.get().map_or(0, |f| f.used())
    }
    pub fn over_by(&self) -> u64 {
        let (used, trigger) = self.used_and_trigger();
        used.saturating_sub(trigger)
    }
}
