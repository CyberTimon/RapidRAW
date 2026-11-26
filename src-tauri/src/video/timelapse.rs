use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, sync_channel};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};
use std::time::{Duration, UNIX_EPOCH};

use glam::{Mat3, Vec3};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::adjustments::lens_correction::{Shot, remember_shot};
use crate::app::memory_budget::MemoryBudget;
use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::AppState;
use crate::decode::as_shot::{self, AsShot};
use crate::decode::formats::is_raw_file;
use crate::decode::hdr_source::{pq_from_nits, pq_to_relative};
use crate::decode::image_loader::decode_pristine;
use crate::decode::white_balance::{WhiteBalance, adaptation_log_gains, rgb_to_lms};
use crate::export::geometry::resize_unclamped;
use crate::export::tasks::estimate_export_memory;
use crate::library::file_ops::read_file_mapped;
use crate::metadata::exif_processing::read_exposure_settings;
use crate::render::cache_utils::stable_decode_settings;
use crate::render::color_space::{srgb_transfer, working_luma};
use crate::render::gpu::compute::{self, Slot};
use crate::render::gpu::context::GpuContext;
use crate::render::hdr::REFERENCE_WHITE_NITS;
use crate::render::image_processing::{downscale_f32_image, into_rgb32f_parallel};
use crate::video::blocking;
use crate::video::encoders::{self, Codec, Dynamic, Intermediate};
use crate::video::ffmpeg::{self, MediaInfo};
use crate::video::jobs::{Cached, JobContext, JobManager, JobState};
use crate::video::libav::encode::{Muxer, OutputSpec, VideoInput};
use crate::video::model::{FrameRate, Item, VideoProject};
use crate::video::proxy::{cache_root, read_json_cache, write_atomically, write_json_cache};
use crate::video::stabilization::{AnalysisState, job_state};

pub(crate) const KIND: &str = "timelapse";
pub(crate) const DIR: &str = "timelapses";
const VERSION: u32 = 2;
const KEY_LENGTH: usize = 32;
const VIDEO_SUFFIX: &str = ".plain.mov";
const RGB_FORMAT: &str = "rgb48le";
const CACHE_PROFILE: &str = "5";
const CODE_MAX: f32 = 65535.0;
const MEASURE_MARGIN: f32 = 0.1;
const MEASURE_BLOCKS: u32 = 192;
const TRIM: f64 = 0.1;
const SCENE_WINDOW: usize = 15;
const SETTINGS_WINDOW: usize = 30;
const ROBUST_PASSES: usize = 2;
const ROBUST_SPREAD: f64 = 6.0;
const MIN_SPREAD: f64 = 0.03;
const MAX_CORRECTION: f32 = 1.0;
const DARK_FLOOR: f32 = -15.0;
const DARK_FULL: f32 = -11.0;
const BLACK_LEVEL: f32 = -40.0;
const WORKERS: usize = 3;
const WAIT_INTERVAL: Duration = Duration::from_millis(250);
const CANCELLED: &str = "Timelapse cancelled";
const MISSING: &str = "This photo is missing";
const MIXED: &str = "A timelapse can't mix raw files with other photos";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseSource {
    frames: Vec<String>,
    fps: FrameRate,
    pub(crate) deflicker: bool,
    size: (u32, u32),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    path: String,
    info: MediaInfo,
    ready: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FrameShot {
    as_shot: AsShot,
    lens: Shot,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Record {
    frames: Vec<String>,
    fps: [i64; 2],
    #[serde(default)]
    levels: Vec<f32>,
    #[serde(default)]
    exposures: Vec<f32>,
    #[serde(default)]
    shots: Vec<FrameShot>,
    #[serde(skip)]
    steady: OnceLock<Option<Steady>>,
}

struct Steady {
    transforms: Arc<[Mat3]>,
    whites: Option<Vec<WhiteBalance>>,
}

impl Record {
    fn fps(&self) -> f64 {
        self.fps[0] as f64 / self.fps[1].max(1) as f64
    }

    fn index_at(&self, time: Option<f64>) -> usize {
        let index = time.map_or(0.0, |time| (time * self.fps() + 1e-3).floor().max(0.0)) as usize;
        index.min(self.frames.len().saturating_sub(1))
    }

    fn frame_at(&self, time: Option<f64>) -> Option<&String> {
        self.frames.get(self.index_at(time))
    }

    fn is_measured(&self) -> bool {
        !self.frames.is_empty() && self.levels.len() == self.frames.len()
    }

    fn steady(&self) -> Option<&Steady> {
        self.steady
            .get_or_init(|| {
                self.is_measured().then(|| {
                    let whites = (self.shots.len() == self.frames.len())
                        .then(|| steady_whites(&self.shots))
                        .flatten();
                    let transforms = corrections(&self.levels, &self.exposures)
                        .into_iter()
                        .enumerate()
                        .map(|(index, correction)| {
                            let gain = Mat3::IDENTITY * correction.exp2();
                            match &whites {
                                Some(whites) => {
                                    gain * white_shift(
                                        self.shots[index].as_shot.white_balance,
                                        whites[index],
                                    )
                                }
                                None => gain,
                            }
                        })
                        .collect();
                    Steady { transforms, whites }
                })
            })
            .as_ref()
    }

    fn remember(&self) {
        for (frame, shot) in self.frames.iter().zip(&self.shots) {
            as_shot::remember(frame, shot.as_shot);
            remember_shot(frame, shot.lens.clone());
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Deflicker {
    transforms: Arc<[Mat3]>,
    fps: f64,
    reversed: bool,
}

impl Hash for Deflicker {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.transforms
            .iter()
            .flat_map(|transform| transform.to_cols_array())
            .for_each(|value| value.to_bits().hash(state));
        self.fps.to_bits().hash(state);
        self.reversed.hash(state);
    }
}

impl Deflicker {
    fn transform_at(&self, time: Option<f64>) -> Option<Mat3> {
        let last = self.transforms.len() - 1;
        let index = ((time? * self.fps).round().max(0.0) as usize).min(last);
        Some(self.transforms[if self.reversed { last - index } else { index }])
            .filter(|transform| *transform != Mat3::IDENTITY)
    }

    pub fn apply(&self, image: DynamicImage, time: Option<f64>) -> DynamicImage {
        let Some(transform) = self.transform_at(time) else {
            return image;
        };
        let transfer = srgb_transfer();
        let mut rgb = image.into_rgb32f();
        rgb.as_chunks_mut::<3>().0.par_iter_mut().for_each(|pixel| {
            let linear = transform * Vec3::from_array(pixel.map(|value| transfer.decode(value)));
            *pixel = linear.to_array().map(|value| transfer.encode(value));
        });
        DynamicImage::ImageRgb32F(rgb)
    }

    pub fn apply_slot(
        &self,
        context: &GpuContext,
        slot: Slot,
        time: Option<f64>,
    ) -> Result<Slot, String> {
        let Some(transform) = self.transform_at(time) else {
            return Ok(slot);
        };
        compute::encode(context, |enc| {
            crate::video::gpu::transform_working(enc, &slot, transform).detach()
        })
    }

    pub fn apply_codes(&self, codes: &mut [u8], time: Option<f64>) {
        let Some(transform) = self.transform_at(time) else {
            return;
        };
        let relative: Vec<f32> = (0..=u8::MAX)
            .map(|code| pq_to_relative(code as f32 / 255.0))
            .collect();
        codes
            .as_chunks_mut::<3>()
            .0
            .par_iter_mut()
            .for_each(|pixel| {
                let linear =
                    transform * Vec3::from_array(pixel.map(|code| relative[code as usize]));
                *pixel = linear.to_array().map(|value| {
                    (pq_from_nits(value.max(0.0) * REFERENCE_WHITE_NITS) * 255.0).round() as u8
                });
            });
    }
}

static RECORDS: LazyLock<Mutex<HashMap<PathBuf, Arc<Record>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RECORD_FILES: Mutex<()> = Mutex::new(());
static FOLDER: OnceLock<PathBuf> = OnceLock::new();

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = FOLDER.get() {
        return Ok(dir.clone());
    }
    let dir = cache_root(app)?.join(DIR);
    Ok(FOLDER.get_or_init(|| dir).clone())
}

fn key_of(source: &TimelapseSource, settings: &AppSettings) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&VERSION.to_le_bytes());
    for value in [
        source.size.0 as i64,
        source.size.1 as i64,
        source.fps.num,
        source.fps.den,
    ] {
        hasher.update(&value.to_le_bytes());
    }
    hasher.update(stable_decode_settings(settings).as_bytes());
    for frame in &source.frames {
        let path = Path::new(frame);
        let missing = || format!("{}: {}", frame, MISSING);
        let metadata = std::fs::metadata(path).map_err(|_| missing())?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos());
        let name = path.file_name().ok_or_else(missing)?.as_encoded_bytes();
        hasher.update(&(name.len() as u64).to_le_bytes());
        hasher.update(name);
        hasher.update(&metadata.len().to_le_bytes());
        hasher.update(&modified.to_le_bytes());
    }
    Ok(hasher.finalize().to_hex()[..KEY_LENGTH].to_string())
}

fn record_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", key))
}

fn video_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}{}", key, VIDEO_SUFFIX))
}

fn cache_record(file: &Path, record: Record) -> Arc<Record> {
    let record = Arc::new(record);
    record.remember();
    RECORDS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(file.to_path_buf(), Arc::clone(&record));
    record
}

fn save_record(file: &Path, record: &Record) -> Result<(), String> {
    write_json_cache(file, record).map_err(|e| format!("Could not save the timelapse: {}", e))
}

fn write_record(file: &Path, record: Record) -> Result<Arc<Record>, String> {
    save_record(file, &record)?;
    Ok(cache_record(file, record))
}

fn load_record(file: &Path) -> Option<Arc<Record>> {
    if let Some(record) = RECORDS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(file)
    {
        return Some(Arc::clone(record));
    }
    Some(cache_record(file, read_json_cache(file)?))
}

fn sync_record(file: &Path, source: &TimelapseSource) -> Result<(), String> {
    let _files = RECORD_FILES.lock().unwrap_or_else(PoisonError::into_inner);
    match read_json_cache::<Record>(file) {
        Some(record) if record.frames == source.frames => Ok(()),
        Some(record) => write_record(
            file,
            Record {
                frames: source.frames.clone(),
                ..record
            },
        )
        .map(drop),
        None if file.exists() => Ok(()),
        None => {
            let kept = RECORDS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(file)
                .filter(|record| record.is_measured() && record.frames == source.frames)
                .cloned();
            match kept {
                Some(record) => save_record(file, &record),
                None => write_record(
                    file,
                    Record {
                        frames: source.frames.clone(),
                        fps: [source.fps.num, source.fps.den],
                        ..Record::default()
                    },
                )
                .map(drop),
            }
        }
    }
}

fn intermediate(path: &Path) -> Option<PathBuf> {
    let app = crate::render::gpu::context::app_handle()?;
    let dir = path.parent()?;
    if dir != folder(app).ok()? {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    Some(record_file(dir, name.split('.').next()?))
}

pub fn is_pending(path: &str) -> bool {
    let file = Path::new(path);
    intermediate(file).is_some() && !file.is_file()
}

pub fn frame_path(path: &Path, time: Option<f64>) -> Option<String> {
    load_record(&intermediate(path)?)?.frame_at(time).cloned()
}

fn deflickered(path: &Path, enabled: bool) -> Option<Arc<Record>> {
    if !enabled || !path.to_string_lossy().ends_with(VIDEO_SUFFIX) {
        return None;
    }
    load_record(&intermediate(path)?)
}

pub fn deflicker(path: &Path, enabled: bool, reversed: bool) -> Option<Deflicker> {
    let record = deflickered(path, enabled)?;
    Some(Deflicker {
        transforms: Arc::clone(&record.steady()?.transforms),
        fps: record.fps(),
        reversed,
    })
}

pub fn white_balance(path: &Path, time: Option<f64>, deflicker: bool) -> Option<WhiteBalance> {
    let record = deflickered(path, deflicker)?;
    let whites = record.steady()?.whites.as_ref()?;
    whites.get(record.index_at(time)).copied()
}

pub fn probe(path: &Path) -> Result<MediaInfo, String> {
    let info = (*ffmpeg::probe(path)?).clone();
    Ok(match frame_path(path, None) {
        Some(frame) => {
            let is_raw = is_raw_file(frame.as_str());
            MediaInfo {
                is_raw,
                hdr: is_raw,
                ..info
            }
        }
        None => info,
    })
}

pub fn linearized(image: &DynamicImage) -> DynamicImage {
    let transfer = srgb_transfer();
    let mut rgb = image.to_rgb32f();
    rgb.par_iter_mut()
        .for_each(|value| *value = transfer.decode(*value));
    DynamicImage::ImageRgb32F(rgb)
}

fn exposure_of(path: &str) -> Option<f32> {
    let bytes = read_file_mapped(Path::new(path)).ok()?;
    let settings = read_exposure_settings(path, &bytes);
    let time = settings.seconds.filter(|time| *time > 0.0)? as f64;
    let iso = settings.iso.filter(|iso| *iso > 0)? as f64;
    let aperture = settings.f_number.filter(|aperture| *aperture > 0.0)? as f64;
    Some((time * iso / (aperture * aperture)).log2() as f32)
}

fn fit(image: DynamicImage, size: (u32, u32)) -> Rgb32FImage {
    let (width, height) = image.dimensions();
    let scale = (size.0 as f32 / width.max(1) as f32).max(size.1 as f32 / height.max(1) as f32);
    let cover = (
        ((width as f32 * scale).ceil() as u32).max(size.0),
        ((height as f32 * scale).ceil() as u32).max(size.1),
    );
    let scaled = into_rgb32f_parallel(if scale > 1.0 {
        resize_unclamped(image, |image| {
            image.resize_exact(cover.0, cover.1, FilterType::Lanczos3)
        })
    } else {
        downscale_f32_image(&image, cover.0, cover.1)
    });
    if scaled.dimensions() == size {
        return scaled;
    }
    let (sw, sh) = scaled.dimensions();
    let offset = |source: u32, target: u32| (source as i64 - target as i64) / 2;
    let (ox, oy) = (offset(sw, size.0), offset(sh, size.1));
    let mut out = Rgb32FImage::new(size.0, size.1);
    out.par_chunks_mut(size.0 as usize * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let sy = y as i64 + oy;
            if !(0..sh as i64).contains(&sy) {
                return;
            }
            for (x, pixel) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let sx = x as i64 + ox;
                if (0..sw as i64).contains(&sx) {
                    pixel.copy_from_slice(&scaled.get_pixel(sx as u32, sy as u32).0);
                }
            }
        });
    out
}

struct Developed {
    bytes: Vec<u8>,
    level: f32,
    shot: FrameShot,
    exposure: Option<f32>,
}

fn develop_frame(
    path: &str,
    settings: &AppSettings,
    size: (u32, u32),
    halt: &Arc<AtomicUsize>,
) -> Result<Developed, String> {
    let (image, exif) =
        decode_pristine(Path::new(path), path, settings, Some((Arc::clone(halt), 0)))?;
    let mut rgb = fit(image, size);
    if !is_raw_file(path) {
        let transfer = srgb_transfer();
        rgb.par_iter_mut()
            .for_each(|value| *value = transfer.decode(*value));
    }
    Ok(Developed {
        bytes: pack(&rgb),
        level: level(&rgb),
        shot: FrameShot {
            as_shot: as_shot::as_shot(path),
            lens: Shot::from_exif(&exif),
        },
        exposure: exposure_of(path),
    })
}

fn level(rgb: &Rgb32FImage) -> f32 {
    let (width, height) = rgb.dimensions();
    let margin = |side: u32| (side as f32 * MEASURE_MARGIN) as u32;
    let (x0, y0) = (margin(width), margin(height));
    let (inner_w, inner_h) = (width - 2 * x0, height - 2 * y0);
    let block = (inner_w.max(inner_h) / MEASURE_BLOCKS).max(1);
    let (columns, rows) = (inner_w / block, inner_h / block);
    let luma = Vec3::from(working_luma());
    let mut values: Vec<f64> = (0..rows * columns)
        .into_par_iter()
        .map(|index| {
            let (bx, by) = (
                x0 + (index % columns) * block,
                y0 + (index / columns) * block,
            );
            let mut sum = Vec3::ZERO;
            for y in by..by + block {
                for x in bx..bx + block {
                    sum += Vec3::from_array(rgb.get_pixel(x, y).0);
                }
            }
            (luma.dot(sum) as f64 / (block * block) as f64).cbrt()
        })
        .collect();
    if values.is_empty() {
        return BLACK_LEVEL;
    }
    values.sort_by(f64::total_cmp);
    let trim = (values.len() as f64 * TRIM) as usize;
    let kept = &values[trim..values.len() - trim];
    let mean = kept.iter().sum::<f64>() / kept.len().max(1) as f64;
    if mean > 0.0 {
        (3.0 * mean.log2()) as f32
    } else {
        BLACK_LEVEL
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(0.0)
}

fn local_linear(values: &[f32], weights: &[f64], center: usize, window: usize) -> f32 {
    let low = center.saturating_sub(window);
    let high = (center + window).min(values.len() - 1);
    let span = (window + 1) as f64;
    let (mut sw, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for index in low..=high {
        let x = index as f64 - center as f64;
        let distance = (x / span).abs();
        let w = (1.0 - distance.powi(3)).powi(3) * weights[index];
        let y = values[index] as f64;
        sw += w;
        sx += w * x;
        sy += w * y;
        sxx += w * x * x;
        sxy += w * x * y;
    }
    if sw <= 0.0 {
        return values[center];
    }
    let determinant = sw * sxx - sx * sx;
    if determinant.abs() < 1e-9 {
        return (sy / sw) as f32;
    }
    ((sy * sxx - sx * sxy) / determinant) as f32
}

fn smooth(values: &[f32], window: usize, robust: bool) -> Vec<f32> {
    let mut weights = vec![1.0; values.len()];
    let mut fitted: Vec<f32> = Vec::new();
    for pass in 0..=if robust { ROBUST_PASSES } else { 0 } {
        if pass > 0 {
            let residuals: Vec<f64> = values
                .iter()
                .zip(&fitted)
                .map(|(value, fit)| (value - fit).abs() as f64)
                .collect();
            let spread = (ROBUST_SPREAD * median(residuals.clone())).max(MIN_SPREAD);
            weights = residuals
                .iter()
                .map(|residual| (1.0 - (residual / spread).min(1.0).powi(2)).powi(2))
                .collect();
        }
        fitted = (0..values.len())
            .map(|center| local_linear(values, &weights, center, window))
            .collect();
    }
    fitted
}

pub fn corrections(levels: &[f32], exposures: &[f32]) -> Vec<f32> {
    if levels.len() < 3 {
        return vec![0.0; levels.len()];
    }
    let exposures = if exposures.len() == levels.len() {
        exposures.to_vec()
    } else {
        vec![0.0; levels.len()]
    };
    let scene: Vec<f32> = levels.iter().zip(&exposures).map(|(l, e)| l - e).collect();
    let scene_trend = smooth(&scene, SCENE_WINDOW, true);
    let exposure_trend = smooth(&exposures, SETTINGS_WINDOW, false);
    levels
        .iter()
        .enumerate()
        .map(|(index, &level)| {
            let target = scene_trend[index] + exposure_trend[index];
            let fade =
                ((target.min(level) - DARK_FLOOR) / (DARK_FULL - DARK_FLOOR)).clamp(0.0, 1.0);
            ((target - level) * fade).clamp(-MAX_CORRECTION, MAX_CORRECTION)
        })
        .collect()
}

fn steady_whites(shots: &[FrameShot]) -> Option<Vec<WhiteBalance>> {
    let whites: Vec<WhiteBalance> = shots
        .iter()
        .map(|shot| shot.as_shot.white_balance)
        .collect();
    if whites.len() < 3 || whites.iter().all(|white| *white == whites[0]) {
        return None;
    }
    let mireds: Vec<f32> = whites
        .iter()
        .map(|white| (1.0e6 / white.temperature) as f32)
        .collect();
    let tints: Vec<f32> = whites.iter().map(|white| white.tint as f32).collect();
    Some(
        smooth(&mireds, SCENE_WINDOW, true)
            .into_iter()
            .zip(smooth(&tints, SCENE_WINDOW, true))
            .map(|(mired, tint)| WhiteBalance {
                temperature: 1.0e6 / mired as f64,
                tint: tint as f64,
            })
            .collect(),
    )
}

fn white_shift(from: WhiteBalance, to: WhiteBalance) -> Mat3 {
    let to_lms = rgb_to_lms();
    let gains = Vec3::from_array(adaptation_log_gains(from, to).map(f32::exp));
    let shift = to_lms.inverse() * Mat3::from_diagonal(gains) * to_lms;
    shift / Vec3::from(working_luma()).dot(shift * Vec3::ONE)
}

fn open_output(path: &Path, size: (u32, u32), fps: FrameRate) -> Result<Muxer, String> {
    let filters = encoders::rgb_input_filter(Dynamic::Pq);
    let container = encoders::container(Codec::ProRes, None);
    let encoding = Intermediate {
        profile: CACHE_PROFILE,
        full_chroma: true,
        quality_scale: None,
        color: Dynamic::Pq.color().tags(),
    };
    encoding.open(|settings| {
        Muxer::open(OutputSpec {
            path,
            container: container.format,
            faststart: container.faststart,
            creation_time: None,
            video: settings,
            input: VideoInput {
                size,
                frame_rate: (fps.num as i32, fps.den.max(1) as i32),
                time_base: (fps.den.max(1) as i32, fps.num as i32),
                pixel_format: RGB_FORMAT,
                rgb: true,
                filters: &filters,
            },
            audio: None,
        })
    })
}

fn pq_code(relative: f32) -> u16 {
    (pq_from_nits(relative.max(0.0) * REFERENCE_WHITE_NITS) * CODE_MAX).round() as u16
}

fn pack(rgb: &Rgb32FImage) -> Vec<u8> {
    let mut bytes = vec![0u8; rgb.as_raw().len() * 2];
    bytes
        .par_chunks_exact_mut(2)
        .zip(rgb.as_raw().par_iter())
        .for_each(|(out, &value)| out.copy_from_slice(&pq_code(value).to_le_bytes()));
    bytes
}

fn receive<T>(lane: &Receiver<T>, job: &JobContext) -> Result<T, String> {
    loop {
        match lane.recv_timeout(WAIT_INTERVAL) {
            Ok(value) => return Ok(value),
            Err(RecvTimeoutError::Timeout) if !job.is_cancelled() => {}
            Err(_) => return Err(CANCELLED.to_string()),
        }
    }
}

fn develop(
    source: &TimelapseSource,
    output: &Path,
    settings: &AppSettings,
    budget: &Arc<MemoryBudget>,
    job: &JobContext,
) -> Result<Record, String> {
    let mut muxer = open_output(output, source.size, source.fps)?;
    let total = source.frames.len();
    let workers = WORKERS.min(total);
    let mut levels = Vec::with_capacity(total);
    let mut shots = Vec::with_capacity(total);
    let mut exposures = Vec::with_capacity(total);
    let halt = Arc::new(AtomicUsize::new(0));
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let lanes: Vec<_> = (0..workers)
            .map(|lane| {
                let (finish, results) = sync_channel(1);
                let (halt, stop) = (&halt, &stop);
                scope.spawn(move || {
                    for frame in source.frames.iter().skip(lane).step_by(workers) {
                        let estimate =
                            estimate_export_memory(frame, is_raw_file(frame), None, 1, 0, "", 0);
                        let Some(memory) = budget.reserve_behind_waiters(estimate, stop) else {
                            break;
                        };
                        let developed = develop_frame(frame, settings, source.size, halt)
                            .map_err(|e| format!("{}: {}", frame, e));
                        drop(memory);
                        if finish.send(developed).is_err() {
                            break;
                        }
                    }
                });
                results
            })
            .collect();
        let written = (0..total).try_for_each(|index| -> Result<(), String> {
            let developed = receive(&lanes[index % workers], job)??;
            muxer.write_video(&developed.bytes, index as i64, None)?;
            levels.push(developed.level);
            shots.push(developed.shot);
            exposures.push(developed.exposure);
            job.progress((index + 1) as f32 / total as f32);
            Ok(())
        });
        halt.store(1, Ordering::Relaxed);
        stop.store(true, Ordering::Relaxed);
        written
    })?;
    muxer.finish()?;
    Ok(Record {
        frames: source.frames.clone(),
        fps: [source.fps.num, source.fps.den],
        levels,
        exposures: exposures
            .into_iter()
            .collect::<Option<Vec<f32>>>()
            .unwrap_or_default(),
        shots,
        ..Record::default()
    })
}

fn is_developed(dir: &Path, key: &str) -> bool {
    video_file(dir, key).is_file()
        && load_record(&record_file(dir, key)).is_some_and(|record| record.is_measured())
}

fn build(
    app: &AppHandle,
    source: &TimelapseSource,
    key: &str,
    settings: &AppSettings,
    job: &JobContext,
) -> Result<(), String> {
    crate::video::libav::require()?;
    let dir = folder(app)?;
    if is_developed(&dir, key) {
        return Ok(());
    }
    let budget = &app.state::<AppState>().memory_budget;
    let mut record = None;
    write_atomically(&video_file(&dir, key), |temp| {
        record = Some(develop(source, temp, settings, budget, job)?);
        Ok(())
    })?;
    let record = record.ok_or("The timelapse has no frames")?;
    let _files = RECORD_FILES.lock().unwrap_or_else(PoisonError::into_inner);
    write_record(&record_file(&dir, key), record).map(drop)
}

fn pending_info(source: &TimelapseSource, is_raw: bool) -> MediaInfo {
    let fps = source.fps.value();
    MediaInfo {
        duration: source.frames.len() as f64 / fps,
        fps,
        codec: Some("prores".to_string()),
        hdr: is_raw,
        is_still: false,
        ..MediaInfo::still(source.size.0, source.size.1, is_raw)
    }
}

fn photos_of(frames: Vec<String>) -> Result<Vec<String>, String> {
    let shot = |path: &str| Path::new(path).with_extension("");
    let raw_shots: HashSet<PathBuf> = frames
        .iter()
        .filter(|frame| is_raw_file(frame.as_str()))
        .map(|frame| shot(frame))
        .collect();
    let photos: Vec<String> = frames
        .into_iter()
        .filter(|frame| is_raw_file(frame.as_str()) || !raw_shots.contains(&shot(frame)))
        .collect();
    let raws = photos
        .iter()
        .filter(|frame| is_raw_file(frame.as_str()))
        .count();
    if raws > 0 && raws < photos.len() {
        return Err(MIXED.to_string());
    }
    Ok(photos)
}

fn prepare(app: &AppHandle, mut source: TimelapseSource) -> Result<Prepared, String> {
    source.frames = photos_of(source.frames)?;
    if source.frames.is_empty() {
        return Err("A timelapse needs photos".to_string());
    }
    crate::video::libav::require()?;
    let dir = folder(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let settings = load_settings(app.clone()).unwrap_or_default();
    let key = key_of(&source, &settings)?;
    sync_record(&record_file(&dir, &key), &source)?;
    let target = video_file(&dir, &key);
    let path = target.to_string_lossy().into_owned();
    if is_developed(&dir, &key) {
        return Ok(Prepared {
            info: probe(&target)?,
            path,
            ready: true,
        });
    }
    let is_raw = is_raw_file(&source.frames[0]);
    let label = Path::new(&source.frames[0]).file_name().map_or_else(
        || source.frames[0].clone(),
        |name| name.to_string_lossy().into_owned(),
    );
    let job_key = job_key(&target).unwrap_or_default();
    let info = pending_info(&source, is_raw);
    let handle = app.clone();
    app.state::<JobManager>()
        .submit(app, KIND, &job_key, &label, move |job| {
            build(&handle, &source, &key, &settings, job)
        });
    Ok(Prepared {
        path,
        info,
        ready: false,
    })
}

fn job_key(path: &Path) -> Option<String> {
    Some(path.file_stem()?.to_string_lossy().into_owned())
}

fn states(app: &AppHandle, paths: Vec<String>) -> HashMap<String, AnalysisState> {
    let jobs: HashMap<String, (JobState, f32)> = app
        .state::<JobManager>()
        .list()
        .into_iter()
        .filter(|status| status.kind == KIND)
        .map(|status| (status.key, (status.state, status.progress)))
        .collect();
    paths
        .into_iter()
        .map(|path| {
            let file = PathBuf::from(&path);
            let cached = if file.is_file() {
                Cached::Ready
            } else {
                job_key(&file)
                    .and_then(|key| jobs.get(&key))
                    .map_or(Cached::Missing, |&(state, progress)| {
                        Cached::Job(state, progress)
                    })
            };
            (path, job_state(cached))
        })
        .collect()
}

pub fn ensure(app: &AppHandle, project: &VideoProject, cancel: &AtomicBool) -> Result<(), String> {
    let used: HashSet<&str> = project
        .items()
        .filter_map(|item| match item {
            Item::Clip(clip) => Some(clip.media.as_str()),
            _ => None,
        })
        .collect();
    let pending: Vec<String> = project
        .media
        .iter()
        .filter(|media| used.contains(media.id.as_str()) && is_pending(&media.path))
        .map(|media| media.path.clone())
        .collect();
    if pending.is_empty() {
        return Ok(());
    }
    loop {
        let states = states(app, pending.clone());
        if states.values().all(|state| *state == AnalysisState::Ready) {
            return Ok(());
        }
        if states
            .values()
            .any(|state| matches!(state, AnalysisState::Failed | AnalysisState::None))
        {
            return Err("A timelapse could not be prepared".to_string());
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Export cancelled".to_string());
        }
        std::thread::sleep(WAIT_INTERVAL);
    }
}

#[tauri::command]
pub async fn video_timelapse_prepare(
    source: TimelapseSource,
    app_handle: AppHandle,
) -> Result<Prepared, String> {
    blocking(move || prepare(&app_handle, source)).await?
}

#[tauri::command]
pub async fn video_timelapse_status(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<HashMap<String, AnalysisState>, String> {
    blocking(move || states(&app_handle, paths)).await
}
