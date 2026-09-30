//! Optional local automation bridge. The public MCP transport lives in `mcp/`.
//! All image operations reuse RapidRAW's engine; originals are copied, never edited.
mod advanced;
mod asset_library;
mod enhance;
mod geometry_review;
mod jobs;
mod model_cache;
mod operations;
mod portable;
mod render;
mod sessions;
mod validation;
mod versions;

use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use tauri::Manager;

pub struct EngineSettings(pub crate::app_settings::AppSettings);

#[derive(Clone)]
pub struct WorkspacePaths {
    pub root: PathBuf,
    pub models: PathBuf,
}

pub(super) type Result<T> = std::result::Result<T, String>;

pub fn run() {
    if let Err(error) = start() {
        eprintln!("RapidRAW bridge: {error}");
        std::process::exit(1);
    }
}

fn start() -> Result<()> {
    let mut args = std::env::args().skip(2);
    let mut workspace = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace" => workspace = args.next().map(PathBuf::from),
            _ => return Err(format!("Unknown bridge argument: {arg}")),
        }
    }
    let root = workspace.ok_or("--workspace <directory> is required")?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    // A workspace is one serialized editing authority, even across MCP hosts.
    let _workspace_lock = lock_workspace(&root)?;
    let paths = WorkspacePaths {
        models: root.join("models"),
        root,
    };
    for dir in [
        "sessions", "exports", "recipes", "cache", "models", "jobs", "bundles", "assets",
    ] {
        let path = paths.root.join(dir);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!(
                "WORKSPACE_INVALID: {dir} must be a real directory, not a symlink"
            ));
        }
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    let mut settings = crate::app_settings::AppSettings {
        tonemapper_override_enabled: Some(false),
        use_wgpu_renderer: Some(false),
        ..Default::default()
    };
    // Optional process-local settings; never migrate or overwrite GUI preferences.
    let settings_path = paths.root.join("engine-settings.json");
    if settings_path.exists() {
        let overrides: Value =
            serde_json::from_slice(&std::fs::read(&settings_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid engine-settings.json: {e}"))?;
        settings = merge_settings(settings, &overrides)?;
    }
    let _ = rayon::ThreadPoolBuilder::new()
        .stack_size(8 * 1024 * 1024)
        .build_global();
    let bootstrap_paths = paths.clone();
    let application = tauri::Builder::default()
        .manage(crate::app_state::AppState::default())
        .manage(EngineSettings(settings))
        .manage(paths)
        .setup(move |app| {
            let handle = app.handle().clone();
            crate::exif_processing::initialize_cache_dir(bootstrap_paths.root.join("cache"));
            let state = handle.state::<crate::app_state::AppState>();
            *state.lens_db.lock().unwrap() = Some(Arc::new(crate::lens_correction::load_lensfun_db(&handle)));
            let library = if cfg!(target_os = "macos") { "libonnxruntime.dylib" }
                else if cfg!(target_os = "windows") { "onnxruntime.dll" } else { "libonnxruntime.so" };
            let candidates = [
                handle.path().resource_dir().unwrap_or_default().join("resources").join(library),
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(library),
            ];
            if std::env::var_os("ORT_DYLIB_PATH").is_none()
                && let Some(path) = candidates.iter().find(|p| p.is_file())
            {
                // No worker has initialized ONNX before bridge startup.
                unsafe { std::env::set_var("ORT_DYLIB_PATH", path); }
            }
            jxl_oxide::integration::register_image_decoding_hook();
            std::thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    serve(handle.clone(), bootstrap_paths)
                })).unwrap_or_else(|_| Err("Native worker panicked; reconnect and inspect saved session state before retrying".into()));
                if let Err(error) = &result { eprintln!("RapidRAW bridge: {error}"); }
                handle.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .build(crate::application_context())
        .map_err(|e| e.to_string())?;
    application.run(|_, event| {
        if let tauri::RunEvent::ExitRequested { code, .. } = event {
            // Every reply and saved edit has already been flushed. Like the UI,
            // bypass ONNX's unsafe C++ atexit teardown on macOS, but preserve the
            // actual requested status so failures cannot become success.
            #[cfg(target_os = "macos")]
            unsafe {
                libc::_exit(code.unwrap_or(0));
            }
            #[cfg(not(target_os = "macos"))]
            std::process::exit(code.unwrap_or(0));
        }
    });
    Ok(())
}

fn merge_settings(
    settings: crate::app_settings::AppSettings,
    overrides: &Value,
) -> Result<crate::app_settings::AppSettings> {
    let overrides = overrides
        .as_object()
        .ok_or("INVALID_SETTINGS: engine-settings.json must be an object")?;
    let mut effective = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    let map = effective.as_object_mut().unwrap();
    for (key, value) in overrides {
        if !map.contains_key(key) {
            return Err(format!(
                "INVALID_SETTINGS: Unknown engine setting {key}; use names returned by get_engine_settings"
            ));
        }
        map.insert(key.clone(), value.clone());
    }
    serde_json::from_value(effective).map_err(|e| format!("INVALID_SETTINGS: {e}"))
}

fn lock_workspace(root: &std::path::Path) -> Result<std::fs::File> {
    let path = root.join(".bridge.lock");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("WORKSPACE_INVALID: Lock file must not be a symlink".into());
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("WORKSPACE_INVALID: Cannot open workspace lock: {e}"))?;
    lock.try_lock().map_err(|e| format!("WORKSPACE_BUSY: Cannot exclusively lock workspace ({e}); close its other MCP connection or use a different workspace"))?;
    Ok(lock)
}

fn serve(handle: tauri::AppHandle, paths: WorkspacePaths) -> Result<()> {
    let mut bridge = sessions::Bridge::new(handle, paths)?;
    let input = std::io::stdin();
    let mut input = input.lock();
    let output = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        if Read::by_ref(&mut input)
            .take(64 * 1024 * 1024 + 1)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        if line.len() > 64 * 1024 * 1024 {
            return Err("Request exceeds 64 MiB".into());
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let mut output = output.lock();
                writeln!(
                    output,
                    "{}",
                    json!({"id":null,"error":{"code":"PARSE_ERROR","message":error.to_string()}})
                )
                .map_err(|e| e.to_string())?;
                output.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request["method"].as_str().unwrap_or("");
        if method == "shutdown" {
            let mut output = output.lock();
            writeln!(output, "{}", json!({"id":id,"result":{"closed":true}}))
                .map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
            break;
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = tauri::async_runtime::block_on(bridge.dispatch(method, params));
        let reply = match result {
            Ok(result) => json!({"id":id,"result":result}),
            Err(message) => {
                let (code, detail) = message
                    .split_once(": ")
                    .filter(|(code, _)| code.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
                    .unwrap_or(("ENGINE_ERROR", &message));
                json!({"id":id,"error":{"code":code,"message":detail}})
            }
        };
        // Native workers can emit diagnostics to stdout. Hold the lock only while
        // writing a complete reply, never while awaiting engine work.
        let mut output = output.lock();
        serde_json::to_writer(&mut output, &reply).map_err(|e| e.to_string())?;
        writeln!(output).map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("INVALID_ARGUMENT: {key} must be a nonempty string"))
}

pub(super) fn number(params: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64> {
    let n = if let Some(value) = params.get(key) {
        value
            .as_f64()
            .ok_or_else(|| format!("INVALID_ARGUMENT: {key} must be numeric"))?
    } else {
        default
    };
    if !n.is_finite() || n < min || n > max {
        return Err(format!(
            "INVALID_ARGUMENT: {key} must be between {min} and {max}"
        ));
    }
    Ok(n)
}

pub(super) fn flag(params: &Value, key: &str, default: bool) -> Result<bool> {
    params
        .get(key)
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| format!("INVALID_ARGUMENT: {key} must be boolean"))
        })
        .unwrap_or(Ok(default))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_engine_settings_keep_defaults_and_reject_typoes() {
        let settings = crate::app_settings::AppSettings::default();
        let expected_resolution = settings.editor_preview_resolution;
        let merged = merge_settings(
            settings,
            &json!({"aiProvider":"ai-connector","aiConnectorAddress":"127.0.0.1:8188"}),
        )
        .unwrap();
        assert_eq!(merged.ai_provider.as_deref(), Some("ai-connector"));
        assert_eq!(merged.editor_preview_resolution, expected_resolution);
        assert!(
            merge_settings(Default::default(), &json!({"aiProvidr":"cloud"}))
                .unwrap_err()
                .starts_with("INVALID_SETTINGS:")
        );
    }

    #[test]
    fn workspace_is_exclusive_and_reusable_after_close() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_workspace(dir.path()).unwrap();
        assert!(
            lock_workspace(dir.path())
                .unwrap_err()
                .starts_with("WORKSPACE_BUSY:")
        );
        drop(first);
        assert!(lock_workspace(dir.path()).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn workspace_lock_rejects_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(other.path(), dir.path().join(".bridge.lock")).unwrap();
        assert!(
            lock_workspace(dir.path())
                .unwrap_err()
                .starts_with("WORKSPACE_INVALID:")
        );
    }
}
