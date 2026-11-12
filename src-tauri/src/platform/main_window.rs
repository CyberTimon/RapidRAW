#[cfg(not(target_os = "android"))]
use tauri::Manager;

use crate::app::launch_request::LaunchPayload;
use crate::app::state::AppState;
#[cfg(not(target_os = "android"))]
use crate::app::state::WindowState;

#[cfg(not(target_os = "android"))]
pub const MAIN_WINDOW_STATE_FILE: &str = "window_state.json";

#[cfg(not(target_os = "android"))]
pub const MAIN_WINDOW_MIN_SIZE: (f64, f64) = (800.0, 600.0);

#[cfg(not(target_os = "android"))]
#[derive(Clone, Copy, Debug)]
pub struct MonitorBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(not(target_os = "android"))]
pub fn available_monitor_bounds(window: &tauri::WebviewWindow) -> Vec<MonitorBounds> {
    window
        .available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|monitor| {
                    let position = monitor.position();
                    let size = monitor.size();
                    MonitorBounds {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(not(target_os = "android"))]
pub fn read_window_state(app_handle: &tauri::AppHandle, file_name: &str) -> Option<WindowState> {
    let path = app_handle.path().app_config_dir().ok()?.join(file_name);
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

#[cfg(not(target_os = "android"))]
pub fn write_window_state(app_handle: &tauri::AppHandle, file_name: &str, state: &WindowState) {
    if let Ok(config_dir) = app_handle.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&config_dir);
        if let Ok(json) = serde_json::to_string(state) {
            let _ = std::fs::write(config_dir.join(file_name), json);
        }
    }
}

#[cfg(not(target_os = "android"))]
pub fn saved_window_state_is_usable(
    state: &WindowState,
    monitors: &[MonitorBounds],
    scale_factor: f64,
    min_logical_size: (f64, f64),
) -> bool {
    let min_w = (min_logical_size.0 * scale_factor) as u32;
    let min_h = (min_logical_size.1 * scale_factor) as u32;

    if state.width < min_w || state.height < min_h {
        return false;
    }

    if monitors.is_empty() {
        return true;
    }

    let window_left = state.x as i64;
    let window_top = state.y as i64;
    let window_right = window_left + state.width as i64;
    let window_bottom = window_top + state.height as i64;

    monitors.iter().any(|monitor| {
        let monitor_left = monitor.x as i64;
        let monitor_top = monitor.y as i64;
        let monitor_right = monitor_left + monitor.width as i64;
        let monitor_bottom = monitor_top + monitor.height as i64;

        let overlap_width = window_right.min(monitor_right) - window_left.max(monitor_left);
        let overlap_height = window_bottom.min(monitor_bottom) - window_top.max(monitor_top);

        overlap_width >= 100 && overlap_height >= 100
    })
}

#[tauri::command]
pub fn frontend_ready(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<AppState>,
) -> Result<LaunchPayload, String> {
    let is_first_run = !state
        .window_setup_complete
        .swap(true, std::sync::atomic::Ordering::Relaxed);
    #[cfg(target_os = "android")]
    let _ = (is_first_run, &window, &app_handle);

    #[cfg(not(target_os = "android"))]
    {
        #[cfg(any(windows, target_os = "linux"))]
        let mut should_maximize = false;
        #[cfg(any(windows, target_os = "linux"))]
        let mut should_fullscreen = false;
        #[cfg(not(any(windows, target_os = "linux")))]
        let _ = (&app_handle, is_first_run);

        #[cfg(any(windows, target_os = "linux"))]
        if is_first_run
            && let Some(saved_state) = read_window_state(&app_handle, MAIN_WINDOW_STATE_FILE)
        {
            should_maximize = saved_state.maximized;
            should_fullscreen = saved_state.fullscreen;
        }

        if let Err(e) = window.show() {
            log::error!("Failed to show window: {}", e);
        }
        if let Err(e) = window.set_focus() {
            log::error!("Failed to focus window: {}", e);
        }
        #[cfg(any(windows, target_os = "linux"))]
        if is_first_run {
            if should_maximize {
                let _ = window.maximize();
            }
            if should_fullscreen {
                let _ = window.set_fullscreen(true);
            }
        }
    }

    let open_with_file = state.initial_file_path.lock().unwrap().take();
    let edit_session = state.pending_edit_session.lock().unwrap().take();
    if let Some(path) = &open_with_file {
        log::info!("Frontend is ready, returning initial path: {}", path);
    }
    if let Some(session) = &edit_session {
        log::info!(
            "Frontend is ready, returning external edit session for: {}",
            session.source
        );
    }
    Ok(LaunchPayload {
        open_with_file,
        edit_session,
    })
}
