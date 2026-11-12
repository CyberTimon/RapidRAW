use crate::app::state::{AppState, LoadedImage};
use crate::library::sidecars::parse_virtual_path;
use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs::{self, File};
use std::future::Future;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const MEMORY_CACHE_CAPACITY: usize = 2;
pub const HALF_CHUNK: usize = 3 * 16 * 1024;

pub struct CachedBase {
    key: String,
    source: String,
    fingerprint: u64,
    pub width: u32,
    pub height: u32,
    pub data: Vec<f16>,
}

impl CachedBase {
    pub fn to_rgb32f(&self) -> Rgb32FImage {
        let mut expanded = vec![0.0f32; self.data.len()];
        expanded
            .par_chunks_mut(HALF_CHUNK)
            .zip(self.data.par_chunks(HALF_CHUNK))
            .for_each(|(dst, src)| src.convert_to_f32_slice(dst));
        Rgb32FImage::from_raw(self.width, self.height, expanded)
            .expect("Cached base matches its dimensions")
    }
}

#[derive(Default)]
struct CacheState {
    dir: Option<PathBuf>,
    entries: Vec<Arc<CachedBase>>,
    pending: HashSet<String>,
    epoch: u64,
}

impl CacheState {
    fn get(&mut self, key: &str) -> Option<Arc<CachedBase>> {
        let pos = self.entries.iter().position(|e| e.key == key)?;
        let entry = self.entries.remove(pos);
        self.entries.push(Arc::clone(&entry));
        Some(entry)
    }

    fn insert(&mut self, entry: Arc<CachedBase>) {
        self.entries.retain(|e| e.key != entry.key);
        if self.entries.len() >= MEMORY_CACHE_CAPACITY {
            self.entries.remove(0);
        }
        self.entries.push(entry);
    }
}

struct EntryHeader {
    source: String,
    fingerprint: u64,
    width: u32,
    height: u32,
}

pub struct BaseCache {
    dir_name: &'static str,
    extension: &'static str,
    magic: &'static [u8; 8],
    event: &'static str,
    label: &'static str,
    state: LazyLock<Mutex<CacheState>>,
    disk_limit: AtomicU64,
}

pub fn source_string(path: &str) -> String {
    parse_virtual_path(path).0.to_string_lossy().to_string()
}

pub fn entry_key(source: &str, tag: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(tag.as_bytes());
    hasher.update(source.as_bytes());
    if let Ok(meta) = fs::metadata(source) {
        hasher.update(&meta.len().to_le_bytes());
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .unwrap_or_default();
        hasher.update(&modified.as_nanos().to_le_bytes());
    }
    hasher.finalize().to_hex()[..32].to_string()
}

pub fn base_fingerprints(base: &DynamicImage) -> [u64; 2] {
    let mut hasher = blake3::Hasher::new();
    let mut legacy_hasher = blake3::Hasher::new();
    let (w, h) = base.dimensions();
    for hasher in [&mut hasher, &mut legacy_hasher] {
        hasher.update(&w.to_le_bytes());
        hasher.update(&h.to_le_bytes());
    }
    if let Some(buf) = base.as_rgb32f() {
        let raw = buf.as_raw();
        for value in raw.iter().step_by((raw.len() / 4096).max(1)) {
            hasher.update(&f16::from_f32(*value).to_bits().to_le_bytes());
            legacy_hasher.update(&value.to_bits().to_le_bytes());
        }
    }
    [hasher, legacy_hasher].map(|hasher| {
        let bytes = hasher.finalize();
        u64::from_le_bytes(bytes.as_bytes()[..8].try_into().unwrap_or_default())
    })
}

pub struct Job {
    pub key: String,
    pub source: String,
    pub fingerprint: u64,
}

impl BaseCache {
    pub const fn new(
        dir_name: &'static str,
        extension: &'static str,
        magic: &'static [u8; 8],
        event: &'static str,
        label: &'static str,
    ) -> Self {
        Self {
            dir_name,
            extension,
            magic,
            event,
            label,
            state: LazyLock::new(Default::default),
            disk_limit: AtomicU64::new(u64::MAX),
        }
    }

    fn state(&self) -> MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn initialize_dir(&self, cache_dir: &Path) {
        let dir = cache_dir.join(self.dir_name);
        let _ = fs::create_dir_all(&dir);
        self.state().dir = Some(dir);
    }

    pub fn set_disk_limit_gb(&'static self, limit_gb: u32) {
        let limit = u64::from(limit_gb.max(1)) * 1024 * 1024 * 1024;
        if self.disk_limit.swap(limit, Ordering::Relaxed) > limit
            && let Some(dir) = self.state().dir.clone()
        {
            std::thread::spawn(move || self.evict(&dir, None));
        }
    }

    pub fn epoch(&self) -> u64 {
        self.state().epoch
    }

    fn entry_path(&self, key: &str) -> Option<PathBuf> {
        self.state()
            .dir
            .as_ref()
            .map(|dir| dir.join(format!("{key}.{}", self.extension)))
    }

    fn read_header(&self, reader: &mut impl Read) -> Option<EntryHeader> {
        let mut magic = [0u8; 8];
        reader.read_exact(&mut magic).ok()?;
        if &magic != self.magic {
            return None;
        }
        let mut u32_buf = [0u8; 4];
        let mut u64_buf = [0u8; 8];
        reader.read_exact(&mut u32_buf).ok()?;
        let mut source = vec![0u8; u32::from_le_bytes(u32_buf) as usize];
        reader.read_exact(&mut source).ok()?;
        reader.read_exact(&mut u64_buf).ok()?;
        let fingerprint = u64::from_le_bytes(u64_buf);
        reader.read_exact(&mut u32_buf).ok()?;
        let width = u32::from_le_bytes(u32_buf);
        reader.read_exact(&mut u32_buf).ok()?;
        let height = u32::from_le_bytes(u32_buf);
        Some(EntryHeader {
            source: String::from_utf8(source).ok()?,
            fingerprint,
            width,
            height,
        })
    }

    fn read_disk_header(&self, key: &str) -> Option<EntryHeader> {
        let file = File::open(self.entry_path(key)?).ok()?;
        self.read_header(&mut BufReader::new(file))
    }

    fn read_from_disk(&self, key: &str, source: &str) -> Option<CachedBase> {
        let path = self.entry_path(key)?;
        let mut reader = BufReader::new(File::open(&path).ok()?);
        let header = self.read_header(&mut reader)?;
        if header.source != source {
            return None;
        }

        let mut data = vec![f16::ZERO; header.width as usize * header.height as usize * 3];
        reader
            .read_exact(bytemuck::cast_slice_mut(&mut data))
            .ok()?;

        if let Ok(file) = File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }

        Some(CachedBase {
            key: key.to_string(),
            source: header.source,
            fingerprint: header.fingerprint,
            width: header.width,
            height: header.height,
            data,
        })
    }

    fn write_to_disk(&self, entry: &CachedBase) -> Result<(), String> {
        let path = self
            .entry_path(&entry.key)
            .ok_or_else(|| format!("{} cache directory is not initialized", self.label))?;
        let tmp_path = path.with_extension("tmp");

        let mut file = BufWriter::new(File::create(&tmp_path).map_err(|e| e.to_string())?);
        let source = entry.source.as_bytes();
        file.write_all(self.magic)
            .and_then(|_| file.write_all(&(source.len() as u32).to_le_bytes()))
            .and_then(|_| file.write_all(source))
            .and_then(|_| file.write_all(&entry.fingerprint.to_le_bytes()))
            .and_then(|_| file.write_all(&entry.width.to_le_bytes()))
            .and_then(|_| file.write_all(&entry.height.to_le_bytes()))
            .and_then(|_| file.write_all(bytemuck::cast_slice(&entry.data)))
            .and_then(|_| file.flush())
            .map_err(|e| e.to_string())?;
        drop(file);

        fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            self.evict(dir, Some(&path));
        }
        Ok(())
    }

    fn evict(&self, dir: &Path, keep: Option<&Path>) {
        let Ok(read_dir) = fs::read_dir(dir) else {
            return;
        };
        let limit = self.disk_limit.load(Ordering::Relaxed);

        let mut entries: Vec<(PathBuf, u64, SystemTime)> = read_dir
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .is_some_and(|ext| ext == self.extension)
            })
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((e.path(), meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)))
            })
            .collect();

        let mut total: u64 = entries.iter().map(|(_, len, _)| len).sum();
        entries.sort_by_key(|(_, _, modified)| *modified);

        for (path, len, _) in entries {
            if total <= limit {
                break;
            }
            if Some(path.as_path()) != keep && fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(len);
            }
        }
    }

    pub fn load(&self, key: &str, source: &str) -> Option<Arc<CachedBase>> {
        if let Some(entry) = self.state().get(key) {
            return (entry.source == source).then_some(entry);
        }

        let entry = Arc::new(self.read_from_disk(key, source)?);
        self.state().insert(Arc::clone(&entry));
        Some(entry)
    }

    pub fn is_ready(&self, key: &str, source: &str, fingerprints: [u64; 2]) -> bool {
        if let Some(entry) = self.state().get(key) {
            return entry.source == source && fingerprints.contains(&entry.fingerprint);
        }
        self.read_disk_header(key)
            .is_some_and(|h| h.source == source && fingerprints.contains(&h.fingerprint))
    }

    pub fn has_entry(&self, key: &str, source: &str) -> bool {
        self.state().get(key).is_some_and(|e| e.source == source)
            || self
                .read_disk_header(key)
                .is_some_and(|h| h.source == source)
    }

    pub fn is_pending(&self, key: &str) -> bool {
        self.state().pending.contains(key)
    }

    fn store(&self, job: Job, image: Rgb32FImage) {
        let (width, height) = image.dimensions();
        let mut data = vec![f16::ZERO; image.as_raw().len()];
        data.par_chunks_mut(HALF_CHUNK)
            .zip(image.as_raw().par_chunks(HALF_CHUNK))
            .for_each(|(dst, src)| dst.convert_from_f32_slice(src));
        drop(image);

        let entry = Arc::new(CachedBase {
            key: job.key,
            source: job.source,
            fingerprint: job.fingerprint,
            width,
            height,
            data,
        });
        if let Err(e) = self.write_to_disk(&entry) {
            log::warn!("Failed to persist {} cache: {}", self.label, e);
        }

        let mut state = self.state();
        state.insert(entry);
        state.epoch += 1;
    }

    fn emit_progress(&self, app_handle: &tauri::AppHandle, path: &str, progress: f32) {
        let _ = app_handle.emit(
            &format!("{}-progress", self.event),
            serde_json::json!({ "path": path, "progress": progress }),
        );
    }

    fn emit_result(&self, app_handle: &tauri::AppHandle, path: &str, result: &Result<(), String>) {
        match result {
            Ok(()) => {
                let _ = app_handle.emit(&format!("{}-ready", self.event), path);
            }
            Err(error) => {
                let _ = app_handle.emit(
                    &format!("{}-error", self.event),
                    serde_json::json!({ "path": path, "error": error }),
                );
            }
        }
    }

    pub fn job(&self, key: String, base: &DynamicImage, source: String) -> Option<Job> {
        if self.is_pending(&key) || self.is_ready(&key, &source, base_fingerprints(base)) {
            return None;
        }
        let [fingerprint, _] = base_fingerprints(base);
        Some(Job {
            key,
            source,
            fingerprint,
        })
    }

    pub fn spawn<S, L, R>(
        &'static self,
        app_handle: &tauri::AppHandle,
        loaded_image: &LoadedImage,
        job: Job,
        refresh_thumbnail: bool,
        load: L,
        run: R,
    ) where
        S: Send + 'static,
        L: Future<Output = Result<S, String>> + Send + 'static,
        R: FnOnce(S, &DynamicImage, &(dyn Fn(f32) + Sync)) -> Result<Rgb32FImage, String>
            + Send
            + 'static,
    {
        if !self.state().pending.insert(job.key.clone()) {
            return;
        }

        let app_handle = app_handle.clone();
        let loaded_image = loaded_image.clone();
        let path = loaded_image.path.clone();
        self.emit_progress(&app_handle, &path, 0.0);

        tauri::async_runtime::spawn(async move {
            let key = job.key.clone();
            let result = self
                .generate(&app_handle, loaded_image, job, refresh_thumbnail, load, run)
                .await;
            self.state().pending.remove(&key);
            crate::ai::jobs::release_deferred(&path);
            if let Err(error) = &result {
                log::error!("{} failed for {}: {}", self.label, path, error);
            }
            self.emit_result(&app_handle, &path, &result);
        });
    }

    async fn generate<S, L, R>(
        &'static self,
        app_handle: &tauri::AppHandle,
        loaded_image: LoadedImage,
        job: Job,
        refresh_thumbnail: bool,
        load: L,
        run: R,
    ) -> Result<(), String>
    where
        S: Send + 'static,
        L: Future<Output = Result<S, String>> + Send + 'static,
        R: FnOnce(S, &DynamicImage, &(dyn Fn(f32) + Sync)) -> Result<Rgb32FImage, String>
            + Send
            + 'static,
    {
        let state = app_handle.state::<AppState>();
        let session = load.await?;

        let progress_handle = app_handle.clone();
        let loaded_path = loaded_image.path.clone();
        tokio::task::spawn_blocking(move || {
            let image = run(session, &loaded_image.image, &|progress| {
                self.emit_progress(&progress_handle, &loaded_image.path, progress)
            })?;
            self.store(job, image);
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("{} task failed: {}", self.label, e))??;

        let is_open = state
            .original_image
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|loaded| loaded.path == loaded_path);
        if refresh_thumbnail && !is_open {
            let thumbnail_handle = app_handle.clone();
            crate::library::thumbnails::add_to_thumbnail_queue(&state, 1, app_handle);
            tauri::async_runtime::spawn_blocking(move || {
                let settings = crate::app::settings::load_settings(thumbnail_handle.clone())
                    .unwrap_or_default();
                crate::library::thumbnails::regenerate_thumbnails(
                    std::iter::once(loaded_path),
                    &thumbnail_handle,
                    &settings,
                    true,
                );
            });
        }

        Ok(())
    }

    pub fn generate_blocking<S, L, R>(
        &self,
        app_handle: &tauri::AppHandle,
        path: &str,
        base: &DynamicImage,
        key: String,
        load: L,
        run: R,
    ) -> Result<bool, String>
    where
        L: Future<Output = Result<S, String>>,
        R: FnOnce(S, &DynamicImage, &(dyn Fn(f32) + Sync)) -> Result<Rgb32FImage, String>,
    {
        let source = source_string(path);
        if !self.state().pending.insert(key.clone()) {
            return Ok(false);
        }

        let fingerprints = base_fingerprints(base);
        if self.is_ready(&key, &source, fingerprints) {
            self.state().pending.remove(&key);
            return Ok(true);
        }

        self.emit_progress(app_handle, path, 0.0);
        let job = Job {
            key: key.clone(),
            source,
            fingerprint: fingerprints[0],
        };
        let result = tauri::async_runtime::block_on(load).and_then(|session| {
            let image = run(session, base, &|progress| {
                self.emit_progress(app_handle, path, progress)
            })?;
            self.store(job, image);
            Ok(())
        });

        self.state().pending.remove(&key);
        self.emit_result(app_handle, path, &result);
        result.map(|()| true)
    }

    fn files(&self) -> Vec<PathBuf> {
        let Some(read_dir) = self
            .state()
            .dir
            .clone()
            .and_then(|dir| fs::read_dir(dir).ok())
        else {
            return Vec::new();
        };
        read_dir
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|ext| ext == self.extension || ext == "tmp")
            })
            .collect()
    }

    pub fn clear(&self) -> Result<(), String> {
        for path in self.files() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
        }
        let mut state = self.state();
        state.entries.clear();
        state.epoch += 1;
        Ok(())
    }
}
