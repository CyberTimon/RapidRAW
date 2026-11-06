use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use rawler::decoders::{RawDecodeParams, WellKnownIFD};
use rawler::rawsource::RawSource;
use rawler::tags::{DngTag, TiffCommonTag};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::AppState;
use crate::app_settings::{EditInApp, EditInMode};
use crate::export_processing::{
    ExportAdjustmentsMode, ExportSettings, TiffBitDepth, export_images_and_wait,
};
use crate::file_management::parse_virtual_path;
use crate::formats::{is_raw_file, is_supported_image_file};
use crate::lut_processing::unique_destination;

type Fingerprint = (SystemTime, u64);

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const LAUNCHER_HANDOFF: Duration = Duration::from_secs(10);

static ACTIVE_SESSION: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);

fn is_dng(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("dng"))
}

fn read_entries(dir: &Path) -> Vec<fs::DirEntry> {
    fs::read_dir(dir).into_iter().flatten().flatten().collect()
}

fn snapshot_images(dir: &Path) -> HashMap<PathBuf, Fingerprint> {
    let mut entries = read_entries(dir);
    let nested: Vec<fs::DirEntry> = entries
        .iter()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .flat_map(|entry| read_entries(&entry.path()))
        .collect();
    entries.extend(nested);

    entries
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| is_supported_image_file(path))
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            Some((path, (metadata.modified().ok()?, metadata.len())))
        })
        .collect()
}

fn raw_size(path: &Path) -> Option<(usize, usize)> {
    let source = RawSource::new(path).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    if is_dng(path) {
        let ifd = decoder.ifd(WellKnownIFD::Raw).ok()??;
        return Some(match ifd.get_entry(DngTag::DefaultCropSize) {
            Some(size) => (size.force_usize(0), size.force_usize(1)),
            None => (
                ifd.get_entry(TiffCommonTag::ImageWidth)?.force_usize(0),
                ifd.get_entry(TiffCommonTag::ImageLength)?.force_usize(0),
            ),
        });
    }
    let raw = decoder
        .raw_image(&source, &RawDecodeParams::default(), true)
        .ok()?;
    Some(
        raw.crop_area
            .map_or((raw.width, raw.height), |area| (area.d.w, area.d.h)),
    )
}

fn image_size(path: &Path) -> Option<(usize, usize)> {
    let (w, h) = if is_raw_file(path) {
        raw_size(path)?
    } else {
        let (w, h) = image::image_dimensions(path).ok()?;
        (w as usize, h as usize)
    };
    Some((w.max(h), w.min(h)))
}

fn was_resized(source: &Path, output: &Path) -> bool {
    let (Some(before), Some(after)) = (image_size(source), image_size(output)) else {
        return false;
    };
    let differs = |a: usize, b: usize| a.abs_diff(b) as f64 > a as f64 * 0.05;
    differs(before.0, after.0) || differs(before.1, after.1)
}

fn copy_sidecar(source: &Path, dest: &Path, drop_crop: bool) -> Result<(), String> {
    if !drop_crop {
        return fs::copy(source, dest)
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    let content = fs::read_to_string(source).map_err(|e| e.to_string())?;
    let mut metadata: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if let Some(adjustments) = metadata
        .get_mut("adjustments")
        .and_then(|a| a.as_object_mut())
    {
        adjustments.insert("crop".to_string(), Value::Null);
    }
    let json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(dest, json).map_err(|e| e.to_string())
}

fn output_destination(app: &EditInApp, source_path: &Path, extension: &str) -> PathBuf {
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let suffix: String = app.name.chars().filter(|c| c.is_alphanumeric()).collect();
    let suffix = if suffix.is_empty() { "edit" } else { &suffix };
    unique_destination(
        source_path.parent().unwrap_or(Path::new("")),
        &format!("{}_{}", stem, suffix),
        extension,
    )
}

fn launch(app: &EditInApp, file: &Path) -> Result<Child, String> {
    let file = file.to_string_lossy();
    let mut args: Vec<String> = app
        .args
        .split_whitespace()
        .map(|arg| arg.replace("{file}", &file))
        .collect();
    if !app.args.contains("{file}") {
        args.push(file.into_owned());
    }

    let exe = app.path.trim().trim_matches('"');
    let mut command = if cfg!(target_os = "macos") && exe.ends_with(".app") {
        let mut command = Command::new("open");
        command.args(["-W", "-a", exe]);
        command
    } else {
        Command::new(exe)
    };
    command
        .args(args)
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {}", app.name, e))
}

fn wait_for_output(
    app: &EditInApp,
    launch_target: &Path,
    dir: &Path,
    accept: impl Fn(&Path) -> bool,
    cancelled: &AtomicBool,
) -> Result<Option<PathBuf>, String> {
    let before = snapshot_images(dir);
    let mut child = launch(app, launch_target)?;
    let started = Instant::now();
    let mut child_running = true;
    let mut pending: Option<(PathBuf, Fingerprint)> = None;

    loop {
        std::thread::sleep(POLL_INTERVAL);
        if cancelled.load(Ordering::SeqCst) {
            return Ok(None);
        }

        let changed = snapshot_images(dir)
            .into_iter()
            .filter(|(path, fingerprint)| {
                accept(path) && before.get(path).is_none_or(|prev| prev != fingerprint)
            })
            .max_by_key(|(_, (modified, _))| *modified);

        match (&changed, &pending) {
            (Some(current), Some(previous)) if current == previous => {
                return Ok(Some(current.0.clone()));
            }
            _ => pending = changed,
        }

        if pending.is_none()
            && child_running
            && let Ok(Some(status)) = child.try_wait()
        {
            child_running = false;
            if started.elapsed() > LAUNCHER_HANDOFF {
                return Ok(None);
            }
            if !status.success() {
                return Err(format!("the program quit early ({})", status));
            }
        }
    }
}

fn finish_original(
    app: &EditInApp,
    source_path: &Path,
    source_sidecar: &Path,
    output: &Path,
) -> Result<PathBuf, String> {
    let extension = output
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("tif")
        .to_lowercase();
    let output_path = output_destination(app, source_path, &extension);
    fs::rename(output, &output_path)
        .map_err(|e| format!("Failed to rename {} output: {}", app.name, e))?;

    let _ =
        crate::exif_processing::write_rrexif_sidecar(&source_path.to_string_lossy(), &output_path);

    if source_sidecar.exists() {
        let (_, dest_sidecar) = parse_virtual_path(&output_path.to_string_lossy());
        let drop_crop = was_resized(source_path, &output_path);
        if let Err(e) = copy_sidecar(source_sidecar, &dest_sidecar, drop_crop) {
            log::warn!("Failed to copy sidecar file for {} output: {}", app.name, e);
        }
    }

    Ok(output_path)
}

async fn render_tiff(
    path: String,
    output: &Path,
    current_edit_adjustments: Option<Value>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let export_settings = ExportSettings {
        jpeg_quality: 100,
        tiff_bit_depth: TiffBitDepth::Sixteen,
        resize: None,
        border: None,
        pad: None,
        keep_metadata: true,
        preserve_timestamps: false,
        strip_gps: false,
        filename_template: None,
        watermark: None,
        export_masks: false,
        preserve_folders: false,
        destination_type: None,
        subfolder: None,
        dpi: None,
    };
    export_images_and_wait(
        vec![path.clone()],
        output.to_string_lossy().to_string(),
        true,
        Vec::new(),
        export_settings,
        "tif".to_string(),
        ExportAdjustmentsMode::UseSidecars {
            active_path: current_edit_adjustments
                .as_ref()
                .map(|_| parse_virtual_path(&path).0.to_string_lossy().to_string()),
            active_adjustments: current_edit_adjustments,
        },
        state,
        app_handle,
    )
    .await
}

#[tauri::command]
pub async fn edit_in_app(
    path: String,
    app: EditInApp,
    session_id: String,
    current_edit_adjustments: Option<Value>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Option<String>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE_SESSION.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return Err("another Edit In session is still running".to_string());
        }
        *active = Some((session_id, Arc::clone(&cancelled)));
    }

    let result = run_edit_in(
        path,
        app,
        current_edit_adjustments,
        cancelled,
        state,
        app_handle,
    )
    .await;

    *ACTIVE_SESSION.lock().unwrap_or_else(|e| e.into_inner()) = None;
    result
}

async fn run_edit_in(
    path: String,
    app: EditInApp,
    current_edit_adjustments: Option<Value>,
    cancelled: Arc<AtomicBool>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<Option<String>, String> {
    let (source_path, source_sidecar) = parse_virtual_path(&path);
    let dir = source_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory.".to_string())?
        .to_path_buf();

    let launch_target = match app.mode {
        EditInMode::Original => source_path.clone(),
        EditInMode::Rendered => {
            let target = output_destination(&app, &source_path, "tif");
            render_tiff(path, &target, current_edit_adjustments, state, app_handle).await?;
            target
        }
    };

    if cancelled.load(Ordering::SeqCst) {
        return Ok(None);
    }

    tokio::task::spawn_blocking(move || {
        let output = match app.mode {
            EditInMode::Original => {
                wait_for_output(&app, &launch_target, &dir, |p| p != source_path, &cancelled)?
                    .map(|output| finish_original(&app, &source_path, &source_sidecar, &output))
                    .transpose()?
            }
            EditInMode::Rendered => wait_for_output(
                &app,
                &launch_target,
                &dir,
                |p| p == launch_target,
                &cancelled,
            )?,
        };
        Ok(output.map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("Edit task failed: {}", e))?
}

#[tauri::command]
pub fn cancel_edit_in_app(session_id: String) {
    if let Some((active_id, cancelled)) = ACTIVE_SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        && *active_id == session_id
    {
        cancelled.store(true, Ordering::SeqCst);
    }
}
