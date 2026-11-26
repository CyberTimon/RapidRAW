use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::decode::formats::is_video_file;
use crate::decode::hdr_source::HLG_PEAK_NITS;
use crate::integrations::immich::VideoUpload;
use crate::library::sidecars::parse_virtual_path;
use crate::render::color_space::OutputColorSpace;
use crate::render::gpu::compute;
use crate::render::gpu::processor::RenderOutputPrecision;
use crate::render::hdr::{Headroom, REFERENCE_WHITE_NITS};
use crate::video::audio::{MixGraph, SAMPLE_RATE, Window};
use crate::video::compose::{PackedFrame, Packing, Subsampling, pack_frame};
use crate::video::encoders::{
    self, AudioCodec, Codec, Container, Dynamic, EncoderInfo, Format, Quality,
};
use crate::video::engine::{Engine, FrameSettings, canvas_for};
use crate::video::gpu::encode_hdr;
use crate::video::libav;
use crate::video::libav::encode::{AudioSettings, Muxer, OutputSpec, VideoInput, VideoSettings};
use crate::video::loudness;
use crate::video::model::VideoProject;
use crate::video::{VideoState, blocking, crash_safe};

const QUEUED_FRAMES: usize = 3;
const CRASHED: &str = "The export crashed";
const EXIT_WAIT: Duration = Duration::from_secs(5);
const EXIT_POLL: Duration = Duration::from_millis(50);
const MAX_NUMBERED: u32 = 1000;
const PARTIAL_SUFFIX: &str = ".part";
const STALE_PARTIAL: Duration = Duration::from_secs(24 * 60 * 60);
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_BACKOFF: Duration = Duration::from_millis(100);

static KEPT: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static EXPORTS: AtomicU64 = AtomicU64::new(0);

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    project: VideoProject,
    output_path: String,
    codec: Codec,
    #[serde(default)]
    container: Option<Format>,
    quality: Quality,
    #[serde(default)]
    bit_rate: Option<u64>,
    #[serde(default)]
    audio_codec: Option<AudioCodec>,
    #[serde(default)]
    audio_bit_rate: Option<i64>,
    #[serde(default = "yes")]
    prefer_hardware: bool,
    #[serde(default)]
    title_keys: HashMap<String, String>,
    #[serde(default)]
    range: Option<(f64, f64)>,
    #[serde(default)]
    dynamic: Dynamic,
    #[serde(default)]
    loudness: Option<f64>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    keep_folder: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFailure {
    message: String,
    kept: Option<String>,
}

impl From<String> for ExportFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            kept: None,
        }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Stage {
    Measuring,
    Encoding,
    Uploading,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    frame: u64,
    total: u64,
    stage: Stage,
}

fn upload_progress(progress: Channel<ExportProgress>) -> impl Fn(u64, u64) + Send + 'static {
    let shown = AtomicU64::new(u64::MAX);
    move |sent, total| {
        let percent = sent * 100 / total.max(1);
        if shown.swap(percent, Ordering::Relaxed) != percent {
            let _ = progress.send(ExportProgress {
                frame: sent,
                total,
                stage: Stage::Uploading,
            });
        }
    }
}

fn partial_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let run = EXPORTS.fetch_add(1, Ordering::Relaxed);
    output.with_file_name(format!(
        ".{}-{}.{}{}",
        std::process::id(),
        run,
        name,
        PARTIAL_SUFFIX
    ))
}

fn is_partial(name: &str) -> bool {
    let is_number = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    name.strip_prefix('.')
        .and_then(|name| name.strip_suffix(PARTIAL_SUFFIX))
        .and_then(|inner| inner.split_once('.'))
        .is_some_and(|(token, output)| {
            token
                .split_once('-')
                .is_some_and(|(process, run)| is_number(process) && is_number(run))
                && is_video_file(Path::new(output))
        })
}

fn is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > STALE_PARTIAL)
}

fn sweep_partials(output: &Path) {
    let Some(dir) = output.parent() else {
        return;
    };
    let kept = KEPT.lock().unwrap_or_else(PoisonError::into_inner);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if is_partial(&entry.file_name().to_string_lossy())
            && !kept.contains(&path)
            && is_stale(&path)
            && std::fs::remove_file(&path).is_ok()
        {
            log::info!("Removed an unfinished export: {}", path.display());
        }
    }
}

fn numbered(output: &Path) -> Option<PathBuf> {
    let stem = output.file_stem()?.to_string_lossy();
    let extension = output
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    (1..MAX_NUMBERED)
        .map(|n| output.with_file_name(format!("{}_{}{}", stem, n, extension)))
        .find(|path| path.try_exists().is_ok_and(|exists| !exists))
}

fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut delay = RENAME_BACKOFF;
    for _ in 1..RENAME_ATTEMPTS {
        if std::fs::rename(from, to).is_ok() {
            return Ok(());
        }
        std::thread::sleep(delay);
        delay *= 2;
    }
    std::fs::rename(from, to)
}

fn copied(partial: &Path, path: &Path) -> bool {
    if std::fs::copy(partial, path).is_err() {
        let _ = std::fs::remove_file(path);
        return false;
    }
    let _ = std::fs::remove_file(partial);
    true
}

fn publish(partial: &Path, output: &Path) -> Result<PathBuf, String> {
    let Err(error) = rename_retrying(partial, output) else {
        return Ok(output.to_path_buf());
    };
    let saved = numbered(output)
        .filter(|path| rename_retrying(partial, path).is_ok() || copied(partial, path));
    if let Some(path) = saved {
        log::warn!(
            "Could not replace '{}' ({}), saved the export as '{}'",
            output.display(),
            error,
            path.display()
        );
        return Ok(path);
    }
    KEPT.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(partial.to_path_buf());
    Err(format!(
        "Could not save the exported video as '{}': {}. The finished video was kept as '{}'.",
        output.display(),
        error,
        partial.display()
    ))
}

type Writer = std::thread::JoinHandle<Result<(), String>>;

struct Output<'a> {
    partial: &'a Path,
    creation_time: Option<&'a str>,
    container: Container,
    canvas: (u32, u32),
    frame_rate: (i32, i32),
    input_format: &'static str,
    video: &'a VideoSettings,
    audio_settings: AudioSettings,
    audio: &'a MixGraph,
}

fn finish(writer: Writer) -> Result<(), String> {
    writer
        .join()
        .map_err(|_| "The encoder crashed".to_string())?
}

fn start_encoder(output: &Output) -> Result<(SyncSender<Vec<u8>>, Writer), String> {
    let audio_settings = &output.audio_settings;
    let audio = if output.audio.is_empty() {
        None
    } else {
        let frame_size = libav::encode::audio_frame_size(audio_settings)?;
        Some((
            audio_settings,
            output.audio.open_libav(
                audio_settings.sample_format,
                SAMPLE_RATE,
                "stereo",
                frame_size,
            )?,
        ))
    };
    let container = &output.container;
    let mut muxer = Muxer::open(OutputSpec {
        path: output.partial,
        container: container.format,
        faststart: container.faststart,
        creation_time: output.creation_time,
        video: output.video,
        input: VideoInput {
            size: output.canvas,
            frame_rate: output.frame_rate,
            time_base: (output.frame_rate.1, output.frame_rate.0),
            pixel_format: output.input_format,
            rgb: false,
            filters: "",
        },
        audio,
    })?;
    let (frames, queue) = sync_channel::<Vec<u8>>(QUEUED_FRAMES);
    let writer = std::thread::spawn(move || {
        for (index, frame) in queue.into_iter().enumerate() {
            muxer.write_video(&frame, index as i64, None)?;
        }
        muxer.finish()
    });
    Ok((frames, writer))
}

fn export(
    app_handle: &AppHandle,
    request: &ExportRequest,
    output: &Path,
    partial: &Path,
    creation_time: Option<&str>,
    cancel: &Arc<AtomicBool>,
    progress: &Channel<ExportProgress>,
) -> Result<(), String> {
    libav::require()?;
    let project = &request.project;
    let fps = project.fps();
    let (start_time, end_time) = request
        .range
        .unwrap_or((0.0, project.frame_count() as f64 / fps));
    let (first, last) = project.frame_range(start_time, end_time);
    if last <= first {
        return Err("The timeline is empty".to_string());
    }
    let total = last - first;
    if project.media.iter().any(|media| {
        std::path::absolute(parse_virtual_path(&media.path).0).is_ok_and(|source| source == output)
    }) {
        return Err(
            "The export would overwrite a file used in the project. Choose another file name."
                .to_string(),
        );
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the export folder: {}", e))?;
    }
    crate::video::timelapse::ensure(app_handle, project, cancel)?;
    crate::video::reverse::ensure(app_handle, project, cancel)?;

    let hdr = request.dynamic != Dynamic::Sdr;
    let ten_bit = hdr || request.codec == Codec::ProRes;
    let encoder = encoders::select(request.codec, request.prefer_hardware, ten_bit)?;
    let canvas = canvas_for(project, None);
    app_handle.state::<VideoState>().release_engines();
    let mut engine = Engine::new(app_handle)?;
    engine.preempt_on(Some(Arc::clone(cancel)));
    let settings = FrameSettings {
        canvas,
        output_space: hdr.then_some(OutputColorSpace::Rec2020),
        headroom: hdr.then(|| Headroom::from_stops((HLG_PEAK_NITS / REFERENCE_WHITE_NITS).log2())),
        precision: if hdr {
            RenderOutputPrecision::Float
        } else {
            RenderOutputPrecision::EightBit
        },
        hwaccel: true,
        preview: false,
        use_proxies: false,
        title_keys: request.title_keys.clone(),
        look_overrides: HashMap::new(),
    };

    let duration = total as f64 / fps;
    let mut audio = MixGraph::new(
        project,
        Some(Window {
            start: first as f64 / fps,
            duration,
        }),
    );
    if let Some(target) = request.loudness
        && !audio.is_empty()
        && let Some(gain) = loudness::normalization_gain(&audio, duration, target, |done| {
            if cancel.load(Ordering::Relaxed) {
                return Err("Export cancelled".to_string());
            }
            let _ = progress.send(ExportProgress {
                frame: (done * total as f64) as u64,
                total,
                stage: Stage::Measuring,
            });
            Ok(())
        })?
    {
        audio = audio.normalized(gain);
    }
    let titles = &app_handle.state::<VideoState>().titles;
    let start = |encoder: &EncoderInfo| {
        let container = encoders::container(request.codec, request.container);
        let mut video_settings = encoders::video_settings(
            encoder,
            request.quality,
            request.dynamic,
            fps,
            canvas,
            request.bit_rate,
        );
        if !container.keeps_codec_tag() {
            video_settings.codec_tag = None;
        }
        let layout = encoders::packed_layout(video_settings.pixel_format)
            .ok_or_else(|| format!("{} input is not supported", video_settings.pixel_format))?;
        start_encoder(&Output {
            partial,
            creation_time,
            container,
            canvas,
            frame_rate: (
                project.settings.fps.num as i32,
                project.settings.fps.den.max(1) as i32,
            ),
            input_format: video_settings.pixel_format,
            video: &video_settings,
            audio_settings: encoders::audio_settings(
                request.codec,
                request.audio_codec,
                request.audio_bit_rate,
            ),
            audio: &audio,
        })
        .map(|(frames, writer)| (frames, writer, layout))
    };
    let (frames, writer, layout) =
        start(&encoder).or_else(
            |error| match encoders::select(request.codec, false, ten_bit) {
                Ok(software) if encoder.hardware && !software.hardware => {
                    log::warn!("{}, exporting with {} instead", error, software.encoder);
                    start(&software)
                }
                _ => Err(error),
            },
        )?;
    let packing = Packing::Yuv {
        layout,
        matrix: request.dynamic.color().matrix,
        subsampling: if hdr {
            Subsampling::Swscale
        } else {
            Subsampling::LeftSited
        },
    };

    let rendered = crash_safe(CRASHED, || -> Result<(), String> {
        let mut pending: Option<PackedFrame> = None;
        let mut delivered = 0;
        for frame in (first..last).map(Some).chain([None]) {
            if cancel.load(Ordering::Relaxed) {
                return Err("Export cancelled".to_string());
            }
            let next = match frame {
                Some(frame) => {
                    let mut slot = engine.render(project, frame, &settings, titles)?;
                    let missing = engine.take_missing_maps();
                    if !missing.is_empty() {
                        crate::video::ai_maps::wait(app_handle, &missing, cancel, &|_| {})?;
                        slot = engine.render(project, frame, &settings, titles)?;
                    }
                    if hdr {
                        let pq = request.dynamic == Dynamic::Pq;
                        slot = compute::encode(engine.context(), |enc| {
                            encode_hdr(enc, &slot, OutputColorSpace::Rec2020, pq).detach()
                        })?;
                    }
                    Some(pack_frame(engine.context(), &slot, packing)?)
                }
                None => None,
            };
            let Some(packed) = std::mem::replace(&mut pending, next) else {
                continue;
            };
            let bytes = packed.read(engine.context())?;
            if frames.send(bytes).is_err() {
                break;
            }
            delivered += 1;
            let _ = progress.send(ExportProgress {
                frame: delivered,
                total,
                stage: Stage::Encoding,
            });
        }
        Ok(())
    });
    drop(frames);
    let written = finish(writer);
    rendered?;
    written
}

#[tauri::command]
pub async fn video_export(
    request: ExportRequest,
    on_progress: Channel<ExportProgress>,
    app_handle: AppHandle,
) -> Result<String, ExportFailure> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let video = app_handle.state::<VideoState>();
        let mut running = video.export.lock().unwrap_or_else(PoisonError::into_inner);
        if running.is_some() {
            return Err("A video export is already running".to_string().into());
        }
        *running = Some(Arc::clone(&cancel));
    }
    let handle = app_handle.clone();
    let result = blocking(move || -> Result<String, ExportFailure> {
        let busy = crate::video::busy();
        let output = std::path::absolute(&request.output_path).map_err(|e| e.to_string())?;
        let upload = VideoUpload::prepare(
            &handle,
            request.source.as_deref().unwrap_or_default(),
            &output,
        )?;
        let creation_time = upload
            .as_ref()
            .and_then(VideoUpload::created_at)
            .and_then(container_time);
        let partial = partial_path(&output);
        sweep_partials(&output);
        let rendered = crash_safe(CRASHED, || {
            export(
                &handle,
                &request,
                &output,
                &partial,
                creation_time.as_deref(),
                &cancel,
                &on_progress,
            )
        });
        if let Err(error) = rendered {
            let _ = std::fs::remove_file(&partial);
            return Err(error.into());
        }
        let saved = publish(&partial, &output)?;
        drop(busy);
        if let Some(upload) = upload
            && let Err(message) = upload.run(&handle, &saved, &cancel, upload_progress(on_progress))
        {
            let kept = keep(&handle, &saved, request.keep_folder.as_deref());
            return Err(ExportFailure {
                message,
                kept: Some(kept.to_string_lossy().into_owned()),
            });
        }
        Ok(saved.to_string_lossy().into_owned())
    })
    .await;
    *app_handle
        .state::<VideoState>()
        .export
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = None;
    result.map_err(ExportFailure::from)?
}

fn container_time(created_at: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(created_at)
        .ok()
        .map(|time| {
            time.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%S%.6fZ")
                .to_string()
        })
}

fn keep(app_handle: &AppHandle, saved: &Path, folder: Option<&str>) -> PathBuf {
    let folder = folder
        .filter(|folder| !folder.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| app_handle.path().video_dir().ok());
    folder
        .zip(saved.file_name())
        .filter(|(folder, _)| std::fs::create_dir_all(folder).is_ok())
        .map(|(folder, name)| folder.join(name))
        .and_then(|target| match target.try_exists() {
            Ok(false) => Some(target),
            _ => numbered(&target),
        })
        .filter(|target| std::fs::rename(saved, target).is_ok() || copied(saved, target))
        .unwrap_or_else(|| saved.to_path_buf())
}

pub fn cancel_for_exit(app_handle: &AppHandle) {
    let video = app_handle.state::<VideoState>();
    let deadline = Instant::now() + EXIT_WAIT;
    loop {
        match video
            .export
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            Some(cancel) => cancel.store(true, Ordering::Relaxed),
            None => return,
        }
        if Instant::now() >= deadline {
            log::warn!("The video export did not stop before exit");
            return;
        }
        std::thread::sleep(EXIT_POLL);
    }
}

#[tauri::command]
pub fn video_cancel_export(app_handle: AppHandle) {
    if let Some(cancel) = app_handle
        .state::<VideoState>()
        .export
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        cancel.store(true, Ordering::Relaxed);
    }
}
