use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, ipc::Response};

use crate::gpu_processing::current_gpu_context;
use crate::{AppState, ViewerState, load_settings};

pub const VIEWER_LABEL: &str = "viewer";
const RESIZE_SETTLE_DELAY: Duration = Duration::from_millis(100);
static RESIZE_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(not(target_os = "android"))]
const VIEWER_STATE_FILE: &str = "viewer_window_state.json";
#[cfg(not(target_os = "android"))]
const VIEWER_MIN_SIZE: (f64, f64) = (320.0, 240.0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerInfo {
    native: bool,
    background: [f32; 4],
}

fn viewer_state(state: &AppState) -> std::sync::MutexGuard<'_, ViewerState> {
    state.viewer.lock().unwrap_or_else(|e| e.into_inner())
}

fn viewer_is_open(app_handle: &AppHandle) -> bool {
    app_handle.get_webview_window(VIEWER_LABEL).is_some()
}

fn notify_viewer(app_handle: &AppHandle) {
    let _ = app_handle.emit_to(VIEWER_LABEL, "viewer-updated", ());
}

pub fn publish_viewer_frame(app_handle: &AppHandle, jpeg_bytes: &[u8]) {
    if !viewer_is_open(app_handle) {
        return;
    }
    viewer_state(&app_handle.state::<AppState>()).frame = Some(jpeg_bytes.to_vec());
    notify_viewer(app_handle);
}

pub fn set_viewer_background(app_handle: &AppHandle, color: [f32; 4]) {
    let state = app_handle.state::<AppState>();
    {
        let mut viewer = viewer_state(&state);
        if viewer.background == color {
            return;
        }
        viewer.background = color;
    }
    if !viewer_is_open(app_handle) {
        return;
    }
    if let Some(ctx) = current_gpu_context(&state)
        && let Some(display) = ctx
            .viewer_display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
    {
        display.set_background(color);
        display.flush(&ctx.device, &ctx.queue);
    }
    notify_viewer(app_handle);
}

pub fn handle_viewer_resized(window: &tauri::Window, size: tauri::PhysicalSize<u32>) {
    let generation = RESIZE_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESIZE_SETTLE_DELAY).await;
        if RESIZE_GENERATION.load(Ordering::Relaxed) == generation {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                crate::gpu_processing::redraw_display(&window, size)
            })
            .await;
        }
    });
}

fn release_viewer_display(app_handle: &AppHandle) {
    if let Some(ctx) = current_gpu_context(&app_handle.state::<AppState>()) {
        ctx.viewer_display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

pub fn close_viewer(app_handle: &AppHandle) {
    let window = app_handle.get_webview_window(VIEWER_LABEL);
    #[cfg(not(target_os = "android"))]
    if let Some(window) = &window {
        save_viewer_state(app_handle, window);
    }
    release_viewer_display(app_handle);
    if let Some(window) = window {
        let _ = window.destroy();
    }
}

pub fn handle_viewer_destroyed(app_handle: &AppHandle) {
    release_viewer_display(app_handle);
    viewer_state(&app_handle.state::<AppState>()).frame = None;
    let _ = app_handle.emit_to("main", "viewer-closed", ());
}

pub fn handle_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    match window.label() {
        VIEWER_LABEL => api.prevent_close(),
        "main" => {}
        _ => return,
    }
    let app_handle = window.app_handle().clone();
    std::thread::spawn(move || close_viewer(&app_handle));
}

#[cfg(not(target_os = "android"))]
fn save_viewer_state(app_handle: &AppHandle, window: &tauri::WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    if let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) {
        crate::write_window_state(
            app_handle,
            VIEWER_STATE_FILE,
            &crate::WindowState {
                width: size.width,
                height: size.height,
                x: position.x,
                y: position.y,
                maximized: window.is_maximized().unwrap_or(false),
                fullscreen: window.is_fullscreen().unwrap_or(false),
            },
        );
    }
}

#[cfg(not(target_os = "android"))]
fn place_viewer(
    app_handle: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<crate::WindowState> {
    let monitors = crate::available_monitor_bounds(window);
    let scale = window.scale_factor().unwrap_or(1.0);

    if let Some(saved) = crate::read_window_state(app_handle, VIEWER_STATE_FILE)
        && crate::saved_window_state_is_usable(&saved, &monitors, scale, VIEWER_MIN_SIZE)
    {
        let _ = window.set_size(tauri::PhysicalSize::new(saved.width, saved.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(saved.x, saved.y));
        return Some(saved);
    }

    let main_center = app_handle.get_webview_window("main").and_then(|main| {
        let position = main.outer_position().ok()?;
        let size = main.outer_size().ok()?;
        Some((
            position.x as i64 + size.width as i64 / 2,
            position.y as i64 + size.height as i64 / 2,
        ))
    });
    let contains_main = |m: &&crate::MonitorBounds| {
        main_center.is_some_and(|(cx, cy)| {
            cx >= m.x as i64
                && cx < m.x as i64 + m.width as i64
                && cy >= m.y as i64
                && cy < m.y as i64 + m.height as i64
        })
    };
    let (target, fraction) = match monitors.iter().find(|m| !contains_main(m)) {
        Some(other) => (Some(other), 0.8),
        None => (monitors.iter().find(contains_main), 0.6),
    };

    if let Some(monitor) = target {
        let width = (monitor.width as f64 * fraction) as u32;
        let height = (monitor.height as f64 * fraction) as u32;
        let _ = window.set_size(tauri::PhysicalSize::new(width, height));
        let _ = window.set_position(tauri::PhysicalPosition::new(
            monitor.x + ((monitor.width - width) / 2) as i32,
            monitor.y + ((monitor.height - height) / 2) as i32,
        ));
    }
    None
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
fn attach_viewer_display(
    app_handle: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let ctx = crate::gpu_processing::get_or_init_gpu_context(&state, app_handle)?;
    let surface = crate::gpu_processing::create_window_surface(&ctx.instance, window)?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let mut display =
        crate::gpu_processing::build_wgpu_display(surface, &ctx.adapter, &ctx.device, size, true)?;
    display.set_background(viewer_state(&state).background);
    display.flush(&ctx.device, &ctx.queue);
    *ctx.viewer_display.lock().unwrap_or_else(|e| e.into_inner()) = Some(display);
    Ok(())
}

#[tauri::command]
pub async fn open_viewer_window(title: String, app_handle: AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(VIEWER_LABEL) {
        return window.set_focus().map_err(|e| e.to_string());
    }

    #[cfg(target_os = "android")]
    {
        let _ = title;
        Err("A second window is not supported on this platform".to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let window = tauri::WebviewWindowBuilder::new(
            &app_handle,
            VIEWER_LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title(title)
        .transparent(true)
        .decorations(true)
        .focused(false)
        .visible(false)
        .min_inner_size(VIEWER_MIN_SIZE.0, VIEWER_MIN_SIZE.1)
        .build()
        .map_err(|e| e.to_string())?;

        let saved = place_viewer(&app_handle, &window);

        #[cfg(not(target_os = "linux"))]
        if load_settings(app_handle.clone())
            .unwrap_or_default()
            .wgpu_renderer_enabled()
            && let Err(e) = attach_viewer_display(&app_handle, &window)
        {
            let _ = window.destroy();
            return Err(e);
        }

        window.show().map_err(|e| e.to_string())?;
        if let Some(saved) = saved {
            if saved.maximized {
                let _ = window.maximize();
            }
            if saved.fullscreen {
                let _ = window.set_fullscreen(true);
            }
        }
        if let Some(main) = app_handle.get_webview_window("main") {
            let _ = main.set_focus();
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn close_viewer_window(app_handle: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || close_viewer(&app_handle))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_viewer_info(app_handle: AppHandle, state: tauri::State<AppState>) -> ViewerInfo {
    ViewerInfo {
        native: load_settings(app_handle)
            .unwrap_or_default()
            .wgpu_renderer_enabled(),
        background: viewer_state(&state).background,
    }
}

#[tauri::command]
pub fn get_viewer_frame(state: tauri::State<AppState>) -> Response {
    Response::new(viewer_state(&state).frame.clone().unwrap_or_default())
}
