use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use tauri::ipc::Request;
use tauri::{AppHandle, Manager, State};

use crate::render::gpu::compute::{PerDevice, Slot, memory_share};
use crate::render::gpu::context::GpuContext;
use crate::video::compose::upload_rgba8;
use crate::video::{VideoState, blocking};

const PACKED_BUDGET: usize = 256 << 20;
const GPU_SHARE: u64 = 32;
const MIN_GPU_BUDGET: u64 = 32 << 20;
const MAX_GPU_BUDGET: u64 = 128 << 20;
const PACK_LEVEL: i32 = 1;

#[derive(Clone)]
pub struct TitleUnits {
    pub map: Slot,
    pub characters: u32,
    pub words: u32,
}

#[derive(Clone)]
pub struct TitleRaster {
    pub glyphs: Slot,
    pub units: Option<TitleUnits>,
}

struct Packed {
    size: (u32, u32),
    counts: Option<(u32, u32)>,
    bytes: Vec<u8>,
}

impl Packed {
    fn new(size: (u32, u32), counts: Option<(u32, u32)>, body: &[u8]) -> Result<Self, String> {
        let mut packed = Self {
            size,
            counts,
            bytes: Vec::new(),
        };
        if size.0 == 0 || size.1 == 0 || body.len() != packed.texture_bytes() {
            return Err(format!(
                "Title of {}x{} does not match {} bytes",
                size.0,
                size.1,
                body.len()
            ));
        }
        packed.bytes = zstd::bulk::compress(body, PACK_LEVEL).map_err(|e| e.to_string())?;
        Ok(packed)
    }

    fn plane(&self) -> usize {
        self.size.0 as usize * self.size.1 as usize * 4
    }

    fn texture_bytes(&self) -> usize {
        self.plane() * if self.counts.is_some() { 2 } else { 1 }
    }

    fn upload(&self, context: &GpuContext) -> Result<TitleRaster, String> {
        let body =
            zstd::bulk::decompress(&self.bytes, self.texture_bytes()).map_err(|e| e.to_string())?;
        let (glyph_bytes, unit_bytes) = body.split_at(self.plane().min(body.len()));
        let glyphs = upload_rgba8(context, self.size, glyph_bytes)?;
        let units = self
            .counts
            .map(|(characters, words)| {
                upload_rgba8(context, self.size, unit_bytes).map(|map| TitleUnits {
                    map,
                    characters,
                    words,
                })
            })
            .transpose()?;
        Ok(TitleRaster { glyphs, units })
    }
}

struct Entry {
    packed: Packed,
    used: u64,
}

struct Rasters {
    budget: usize,
    uploaded: HashMap<String, TitleRaster>,
}

impl Rasters {
    fn new(context: &GpuContext) -> Self {
        Self {
            budget: memory_share(context, GPU_SHARE, MIN_GPU_BUDGET, MAX_GPU_BUDGET) as usize,
            uploaded: HashMap::new(),
        }
    }

    fn bytes(&self, key: &str) -> usize {
        self.uploaded.get(key).map_or(0, |raster| {
            let units = raster.units.as_ref().map_or(0, |units| units.map.bytes());
            (raster.glyphs.bytes() + units) as usize
        })
    }
}

#[derive(Default)]
struct Entries {
    map: HashMap<String, Entry>,
    clock: u64,
    rasters: PerDevice<Rasters>,
}

impl Entries {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn touch(&mut self, key: &str) -> Option<&mut Entry> {
        let used = self.tick();
        let entry = self.map.get_mut(key)?;
        entry.used = used;
        Some(entry)
    }
}

fn least_used_over(
    map: &HashMap<String, Entry>,
    budget: usize,
    keep: &str,
    cost: impl Fn(&str, &Entry) -> usize,
) -> Vec<String> {
    let mut total: usize = map.iter().map(|(key, entry)| cost(key, entry)).sum();
    if total <= budget {
        return Vec::new();
    }
    let mut held: Vec<(&String, &Entry)> = map
        .iter()
        .filter(|(key, entry)| key.as_str() != keep && cost(key, entry) > 0)
        .collect();
    held.sort_unstable_by_key(|(_, entry)| entry.used);
    held.into_iter()
        .take_while(|(key, entry)| {
            let over = total > budget;
            total = total.saturating_sub(cost(key, entry));
            over
        })
        .map(|(key, _)| key.clone())
        .collect()
}

#[derive(Default)]
pub struct TitleStore {
    entries: Mutex<Entries>,
}

impl TitleStore {
    fn entries(&self) -> MutexGuard<'_, Entries> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(
        &self,
        context: &GpuContext,
        keys: &HashMap<String, String>,
        id: &str,
    ) -> Result<Option<TitleRaster>, String> {
        let Some(key) = keys.get(id) else {
            return Ok(None);
        };
        let mut entries = self.entries();
        if entries.touch(key).is_none() {
            return Ok(None);
        }
        let Entries { map, rasters, .. } = &mut *entries;
        let rasters = rasters.get_or_insert_with(context, || Rasters::new(context));
        if let Some(raster) = rasters.uploaded.get(key) {
            return Ok(Some(raster.clone()));
        }
        let raster = map[key].packed.upload(context)?;
        rasters.uploaded.insert(key.clone(), raster.clone());
        for evicted in least_used_over(map, rasters.budget, key, |key, _| rasters.bytes(key)) {
            rasters.uploaded.remove(&evicted);
        }
        Ok(Some(raster))
    }

    fn insert(&self, key: String, packed: Packed) -> Vec<String> {
        let mut entries = self.entries();
        let used = entries.tick();
        entries.map.insert(key.clone(), Entry { packed, used });
        let evicted = least_used_over(&entries.map, PACKED_BUDGET, &key, |_, entry| {
            entry.packed.bytes.len()
        });
        for stale in &evicted {
            entries.map.remove(stale);
        }
        if let Some(rasters) = entries.rasters.get_mut() {
            for stale in evicted.iter().chain([&key]) {
                rasters.uploaded.remove(stale);
            }
        }
        evicted
    }

    pub fn release(&self) {
        self.entries().rasters = PerDevice::default();
    }

    pub fn missing(&self, keys: &[String]) -> Vec<String> {
        let mut entries = self.entries();
        keys.iter()
            .filter(|key| entries.touch(key).is_none())
            .cloned()
            .collect()
    }
}

fn header<'a>(request: &'a Request, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("Missing header {}", name))
}

#[tauri::command]
pub async fn video_upload_title(
    request: Request<'_>,
    app_handle: AppHandle,
) -> Result<Vec<String>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw title pixels".to_string());
    };
    let key = header(&request, "x-title-key")?.to_string();
    let width: u32 = header(&request, "x-title-width")?
        .parse()
        .map_err(|_| "Invalid width")?;
    let height: u32 = header(&request, "x-title-height")?
        .parse()
        .map_err(|_| "Invalid height")?;
    let counts = match (
        header(&request, "x-title-characters"),
        header(&request, "x-title-words"),
    ) {
        (Ok(characters), Ok(words)) => Some((
            characters
                .parse::<u32>()
                .map_err(|_| "Invalid characters")?,
            words.parse::<u32>().map_err(|_| "Invalid words")?,
        )),
        _ => None,
    };
    let bytes = bytes.clone();
    let packed = blocking(move || Packed::new((width, height), counts, &bytes)).await??;
    Ok(app_handle.state::<VideoState>().titles.insert(key, packed))
}

#[tauri::command]
pub fn video_missing_titles(keys: Vec<String>, video: State<'_, VideoState>) -> Vec<String> {
    video.titles.missing(&keys)
}
