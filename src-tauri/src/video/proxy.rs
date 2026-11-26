use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use crate::app::storage::{CacheEntries, mark_used, prune_video_cache, record_video_cache_write};
use crate::decode::formats::is_video_file;
use crate::library::file_ops::write_file_atomic;
use crate::library::sidecars::parse_virtual_path;
use crate::video::blocking;
use crate::video::encoders::Intermediate;
use crate::video::ffmpeg::{self, FileKey, MediaInfo};
use crate::video::jobs::{Cached, CachedJob, JobContext, JobManager, JobState, prepare_video};
use crate::video::libav::encode::{Muxer, OutputSpec, VideoInput};
use crate::video::libav::video::{VideoPipe, VideoSpec};
use crate::video::media::even_fit;

const JOB: CachedJob = CachedJob {
    kind: "proxy",
    dir: "proxies",
    extension: "mov",
};
const LONG_SIDE: u32 = 1920;
const MIN_SIDE: u32 = 2;
pub const PROXY_FORMAT: &str = "yuv422p10le";
const PROXY_PROFILE: &str = "0";
const PROXY_QUALITY: i32 = 12;
const LONG_GOP_CODECS: &[&str] = &["h264", "hevc", "av1", "vp9", "vp8", "mpeg2video", "mpeg4"];
const SAMPLE_BYTES: u64 = 1 << 20;
const CANCEL_TIMEOUT: Duration = Duration::from_secs(10);
const PIN_PREFIX: usize = 16;
const TEMP_EXTENSIONS: [&str; 2] = ["tmp", "part"];

static FINGERPRINTS: LazyLock<Mutex<HashMap<PathBuf, (FileKey, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PINNED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ProxyState {
    None,
    Queued,
    Running { progress: f32 },
    Ready,
}

pub fn fingerprint(path: &Path) -> Result<String, String> {
    let key = ffmpeg::file_key(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    if let Some((cached, fingerprint)) = FINGERPRINTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
        && *cached == key
    {
        return Ok(fingerprint.clone());
    }
    let mtime = key
        .1
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    let mut hasher = blake3::Hasher::new();
    hasher.update(&key.0.to_le_bytes());
    hasher.update(&mtime.to_le_bytes());
    let mut file = File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    for from in [
        SeekFrom::Start(0),
        SeekFrom::End(-(SAMPLE_BYTES.min(key.0) as i64)),
    ] {
        file.seek(from)
            .and_then(|_| hasher.update_reader((&file).take(SAMPLE_BYTES)))
            .map_err(|e| format!("{}: {}", path.display(), e))?;
    }
    let fingerprint = hasher.finalize().to_hex().to_string();
    FINGERPRINTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path.to_path_buf(), (key, fingerprint.clone()));
    Ok(fingerprint)
}

pub fn cache_root_in(cache_dir: &Path) -> PathBuf {
    cache_dir.join("video-cache")
}

pub fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| cache_root_in(&dir))
        .map_err(|e| e.to_string())
}

pub fn cache_file(
    app: &AppHandle,
    dir: &str,
    key: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    Ok(cache_root(app)?
        .join(dir)
        .join(format!("{}.{}", key, extension)))
}

pub fn write_cache_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_file_atomic(path, contents)?;
    record_video_cache_write(contents.len() as u64);
    Ok(())
}

pub fn read_json_cache<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    mark_used(path);
    Some(value)
}

pub fn write_json_cache(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    write_cache_file(path, &serde_json::to_vec(value)?)
}

pub fn decode_path(app: &AppHandle, source: &Path, use_proxies: bool) -> PathBuf {
    use_proxies
        .then(|| JOB.file_for(app, source))
        .flatten()
        .filter(|path| path.is_file())
        .unwrap_or_else(|| source.to_path_buf())
}

fn wants_proxy(info: &MediaInfo) -> bool {
    let long_gop = info
        .codec
        .as_deref()
        .is_some_and(|codec| LONG_GOP_CODECS.contains(&codec));
    info.width.max(info.height) > LONG_SIDE
        || (long_gop && (info.color.high_bit_depth() || info.width.min(info.height) >= 1080))
}

fn encode(source: &Path, info: &MediaInfo, output: &Path, job: &JobContext) -> Result<(), String> {
    let (filter, encoding) = intermediate(info, LONG_SIDE, PROXY_PROFILE, Some(PROXY_QUALITY));
    let mut pipe = VideoPipe::open(&VideoSpec {
        path: source,
        start: 0.0,
        timing: "",
        filters: &filter,
        pixel_format: PROXY_FORMAT,
        frames: None,
        hwaccel: true,
        keyframes_only: false,
        low_delay: false,
        device_scale: None,
    })?;
    let mut buffer = Vec::new();
    let Some(first) = pipe.read(&mut buffer)? else {
        return Err("The video has no frames".to_string());
    };
    let mut muxer = open_intermediate(
        output,
        &encoding,
        (first.width, first.height),
        info.fps,
        (first.time_base.num, first.time_base.den),
    )?;
    let seconds =
        |pts: i64| pts as f64 * first.time_base.num as f64 / first.time_base.den.max(1) as f64;
    let mut frame = Some(first);
    while let Some(current) = frame {
        if job.is_cancelled() {
            return Err("Proxy creation cancelled".to_string());
        }
        muxer.write_video(&buffer, current.pts, None)?;
        job.progress((seconds(current.pts) / info.duration.max(1e-3)) as f32);
        frame = pipe.read(&mut buffer)?;
    }
    muxer.finish()
}

pub fn intermediate(
    info: &MediaInfo,
    longest: u32,
    profile: &'static str,
    quality_scale: Option<i32>,
) -> (String, Intermediate) {
    let (width, height) = even_fit((info.width, info.height), longest, MIN_SIDE);
    let matrix = info.color.matrix.unwrap_or("bt709");
    let tags = info.color.tags();
    let filter = format!(
        "setparams=color_primaries={}:color_trc={},scale={}:{}:flags=bicubic:in_color_matrix={}:out_color_matrix={}:out_range=tv",
        tags.primaries, tags.transfer, width, height, matrix, matrix
    );
    let encoding = Intermediate {
        profile,
        full_chroma: false,
        quality_scale,
        color: tags,
    };
    (filter, encoding)
}

pub fn open_intermediate(
    output: &Path,
    encoding: &Intermediate,
    size: (u32, u32),
    fps: f64,
    time_base: (i32, i32),
) -> Result<Muxer, String> {
    encoding.open(|settings| {
        Muxer::open(OutputSpec {
            path: output,
            container: "mov",
            faststart: false,
            creation_time: None,
            video: settings,
            input: VideoInput {
                size,
                frame_rate: ((fps * 1000.0).round() as i32, 1000),
                time_base,
                pixel_format: PROXY_FORMAT,
                rgb: false,
                filters: "",
            },
            audio: None,
        })
    })
}

pub fn write_atomically(
    target: &Path,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let temp = target.with_extension("tmp");
    let result =
        write(&temp).and_then(|()| std::fs::rename(&temp, target).map_err(|e| e.to_string()));
    match &result {
        Ok(()) => record_video_cache_write(std::fs::metadata(target).map_or(0, |meta| meta.len())),
        Err(_) => {
            let _ = std::fs::remove_file(&temp);
        }
    }
    result
}

fn build(source: &Path, info: &MediaInfo, target: &Path, job: &JobContext) -> Result<(), String> {
    write_atomically(target, |temp| encode(source, info, temp, job))
}

fn create_proxies(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    JOB.submit(
        app,
        paths,
        |source| {
            if !is_video_file(source) {
                return Ok(None);
            }
            Ok(prepare_video(source)?.filter(|(info, _)| wants_proxy(info)))
        },
        build,
    )
}

fn proxy_states(app: &AppHandle, paths: Vec<String>) -> HashMap<String, ProxyState> {
    JOB.states(app, paths, |cached| match cached {
        Cached::Ready => ProxyState::Ready,
        Cached::Job(JobState::Queued, _) => ProxyState::Queued,
        Cached::Job(JobState::Running, progress) => ProxyState::Running { progress },
        _ => ProxyState::None,
    })
}

#[tauri::command]
pub async fn video_proxy_status(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> HashMap<String, ProxyState> {
    blocking(move || proxy_states(&app_handle, paths))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn video_create_proxies(paths: Vec<String>, app_handle: AppHandle) -> Result<(), String> {
    blocking(move || create_proxies(&app_handle, &paths)).await?
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CachePart {
    Proxies,
    Reversed,
    Analysis,
    Timelapses,
}

impl CachePart {
    fn job_kinds(self) -> &'static [&'static str] {
        match self {
            Self::Proxies => &[JOB.kind],
            Self::Reversed => &[crate::video::reverse::JOB.kind],
            Self::Analysis => &[
                crate::video::stabilization::JOB.kind,
                crate::video::ai_maps::KINDS[0],
                crate::video::ai_maps::KINDS[1],
                crate::video::reframe::KIND,
            ],
            Self::Timelapses => &[crate::video::timelapse::KIND],
        }
    }

    fn of(dir: &str) -> Self {
        match dir {
            "proxies" => Self::Proxies,
            "reversed" => Self::Reversed,
            crate::video::timelapse::DIR => Self::Timelapses,
            _ => Self::Analysis,
        }
    }
}

fn part_dirs(root: &Path) -> impl Iterator<Item = (CachePart, PathBuf)> {
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| {
            let part = CachePart::of(&entry.file_name().to_string_lossy());
            (part, entry.path())
        })
}

fn pin_prefixes(sources: &[PathBuf]) -> HashSet<String> {
    sources
        .iter()
        .filter_map(|source| fingerprint(source).ok())
        .map(|fingerprint| fingerprint[..PIN_PREFIX].to_string())
        .collect()
}

fn is_pinned(prefixes: &HashSet<String>, path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str()?.get(..PIN_PREFIX))
        .is_some_and(|prefix| prefixes.contains(prefix))
}

fn cache_files(root: &Path) -> impl Iterator<Item = (PathBuf, std::fs::Metadata)> {
    WalkDir::new(root)
        .min_depth(2)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| Some((entry.path().to_path_buf(), entry.metadata().ok()?)))
        .filter(|(_, metadata)| metadata.is_file())
}

pub fn pin_project<'a>(app: &AppHandle, paths: impl IntoIterator<Item = &'a str>) {
    let sources: Vec<PathBuf> = paths
        .into_iter()
        .map(|path| parse_virtual_path(path).0)
        .collect();
    {
        let mut pinned = PINNED.lock().unwrap_or_else(PoisonError::into_inner);
        if *pinned == sources {
            return;
        }
        pinned.clone_from(&sources);
    }
    let Ok(root) = cache_root(app) else {
        return;
    };
    std::thread::spawn(move || {
        let prefixes = pin_prefixes(&sources);
        for (path, _) in cache_files(&root).filter(|(path, _)| is_pinned(&prefixes, path)) {
            mark_used(&path);
        }
    });
}

pub fn prune_cache(root: &Path, limit: u64, session_start: SystemTime) -> u64 {
    let sources = PINNED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let prefixes = pin_prefixes(&sources);
    let timelapses = root.join(crate::video::timelapse::DIR);
    let mut entries = CacheEntries::default();
    for (path, metadata) in cache_files(root) {
        let temporary = path
            .extension()
            .is_some_and(|extension| TEMP_EXTENSIONS.iter().any(|temp| extension == *temp));
        if temporary
            && std::fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| modified < session_start)
        {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if path.starts_with(&timelapses) {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let key = path
            .with_file_name(name.split('.').next().unwrap_or_default())
            .to_string_lossy()
            .into_owned();
        entries.add(key, path, &metadata);
    }
    entries.evict(limit, limit / 10 * 9, |entry| {
        entry.last_used() >= session_start
            || entry
                .files()
                .any(|path| is_pinned(&prefixes, path) || crate::video::ai_frames::in_use(path))
    })
}

pub fn cache_usage(root: &Path) -> [u64; 4] {
    let mut usage = [0; 4];
    for (part, dir) in part_dirs(root) {
        usage[part as usize] += WalkDir::new(dir)
            .into_iter()
            .filter_map(|entry| entry.ok()?.metadata().ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum::<u64>();
    }
    usage
}

#[tauri::command]
pub async fn video_clear_cache(part: CachePart, app_handle: AppHandle) -> Result<(), String> {
    blocking(move || {
        if !app_handle
            .state::<JobManager>()
            .cancel_and_wait(part.job_kinds(), CANCEL_TIMEOUT)
        {
            return Err("Background video jobs did not stop in time".to_string());
        }
        let mut locked = 0usize;
        for (_, dir) in part_dirs(&cache_root(&app_handle)?).filter(|(kind, _)| *kind == part) {
            for entry in WalkDir::new(&dir).into_iter().flatten() {
                if entry.file_type().is_file() && std::fs::remove_file(entry.path()).is_err() {
                    locked += 1;
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        if part == CachePart::Analysis {
            crate::video::ai_frames::forget_all();
        }
        if locked > 0 {
            log::warn!("{} video cache files were in use and were kept", locked);
        }
        prune_video_cache();
        Ok(())
    })
    .await?
}
