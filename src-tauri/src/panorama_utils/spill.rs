use std::fs::File;
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
    pub fn move_to_disk(&mut self, scratch: &SpillFile) -> Result<(), String> {
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
        let map = scratch.map(bytes)?;
        Ok(Store::Disk(map, PhantomData))
    }
    pub fn is_disk(&self) -> bool {
        matches!(self, Store::Disk(..))
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

impl<T: Copy + Default> From<Vec<T>> for Store<T> {
    fn from(v: Vec<T>) -> Self {
        Store::Ram(v)
    }
}

pub struct SpillFile {
    file: File,
    cursor: std::sync::atomic::AtomicU64,
    capacity: std::sync::atomic::AtomicU64,
}

impl SpillFile {
    pub fn in_dir(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create scratch folder {}: {e}", dir.display()))?;
        let file = tempfile::tempfile_in(dir)
            .map_err(|e| format!("Could not create scratch file in {}: {e}", dir.display()))?;
        Ok(SpillFile {
            file,
            cursor: std::sync::atomic::AtomicU64::new(0),
            capacity: std::sync::atomic::AtomicU64::new(0),
        })
    }
    pub fn used(&self) -> u64 {
        self.cursor.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn map(&self, bytes: usize) -> Result<memmap2::MmapMut, String> {
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
            self.file
                .set_len(want)
                .map_err(|e| format!("Could not grow the scratch file: {e}"))?;
        }
        unsafe {
            memmap2::MmapOptions::new()
                .len(bytes)
                .offset(offset)
                .map_mut(&self.file)
                .map_err(|e| format!("Could not map the scratch file: {e}"))
        }
    }
}

pub struct Scratch {
    dir: PathBuf,
    trigger_percent: u64,
    file: std::sync::OnceLock<SpillFile>,
    spilling: std::sync::atomic::AtomicBool,
    meter: std::sync::Mutex<crate::panorama_utils::ram::ResidentMeter>,
    system: std::sync::Mutex<crate::panorama_utils::ram::SystemMeter>,
    spilled_at: std::sync::atomic::AtomicU64,
}

impl Scratch {
    pub fn new(dir: &Path, trigger_percent: u64) -> Self {
        Self {
            dir: dir.to_path_buf(),
            trigger_percent,
            file: std::sync::OnceLock::new(),
            spilling: std::sync::atomic::AtomicBool::new(false),
            meter: std::sync::Mutex::new(crate::panorama_utils::ram::ResidentMeter::new()),
            system: std::sync::Mutex::new(crate::panorama_utils::ram::SystemMeter::new()),
            spilled_at: std::sync::atomic::AtomicU64::new(0),
        }
    }
    fn used_and_trigger(&self) -> (u64, u64) {
        let (used, total) = self
            .system
            .lock()
            .map(|m| m.used_and_total())
            .unwrap_or((0, 0));
        (used, total.saturating_mul(self.trigger_percent) / 100)
    }
    pub fn in_ram_only() -> Self {
        Self {
            dir: PathBuf::new(),
            trigger_percent: u64::MAX,
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
            && let Ok(file) = SpillFile::in_dir(&self.dir)
        {
            let _ = self.file.set(file);
            self.spilled_at
                .store(used, std::sync::atomic::Ordering::Relaxed);
            super::log::phase(&format!(
                "SPILL switching to disk: system {:.2} GB used of {:.2} GB ({}%), app {:.2} GB, scratch {}",
                used as f64 / 1e9,
                trigger as f64 / 1e9,
                self.trigger_percent,
                self.meter.lock().map(|m| m.resident()).unwrap_or_default() as f64 / 1e9,
                self.dir.display()
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
