use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, ipc::Response};

use crate::cache_utils::clear_preview_slot;
use crate::gpu_processing::{DisplayView, WgpuDisplay, current_gpu_context};
use crate::{
    AppState, FrameContent, PreviewTarget, PreviewTask, ShownFrame, ViewerImage, ViewerSession,
    ViewerSource, ViewerState, load_settings,
};

pub const VIEWER_LABEL: &str = "viewer";
const RESIZE_SETTLE_DELAY: Duration = Duration::from_millis(100);
const RENDER_SETTLE_DELAY: Duration = Duration::from_millis(250);
const OVERSAMPLE_LIMIT: u32 = 2;
const UNDERSAMPLE_LIMIT: f32 = 0.8;
static RESIZE_GENERATION: AtomicU64 = AtomicU64::new(0);
static RENDER_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(not(target_os = "android"))]
const VIEWER_STATE_FILE: &str = "viewer_window_state.json";
#[cfg(not(target_os = "android"))]
const VIEWER_MIN_SIZE: (f64, f64) = (320.0, 240.0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerInfo {
    native: bool,
    background: [f32; 4],
    image: Option<ViewerImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerViewPayload {
    path: String,
    view: DisplayView,
    target_resolution: u32,
}

fn viewer_state(state: &AppState) -> std::sync::MutexGuard<'_, ViewerState> {
    state.viewer.lock().unwrap_or_else(|e| e.into_inner())
}

fn viewer_is_open(app_handle: &AppHandle) -> bool {
    app_handle.get_webview_window(VIEWER_LABEL).is_some()
}

fn notify_viewer(app_handle: &AppHandle, event: &str) {
    let _ = app_handle.emit_to(VIEWER_LABEL, event, ());
}

fn update_viewer_display(state: &AppState, update: impl FnOnce(&mut WgpuDisplay)) {
    if let Some(ctx) = current_gpu_context(state)
        && let Some(display) = ctx
            .viewer_display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
    {
        update(display);
        display.flush(&ctx.device, &ctx.queue);
    }
}

fn after_settling(
    generation: &'static AtomicU64,
    delay: Duration,
    task: impl FnOnce() + Send + 'static,
) {
    let current = generation.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if generation.load(Ordering::Relaxed) == current {
            let _ = tauri::async_runtime::spawn_blocking(task).await;
        }
    });
}

fn resolution_gap(session: &ViewerSession, resolution: u32) -> u32 {
    let full = session
        .image
        .as_ref()
        .map_or(u32::MAX, |image| image.width.max(image.height));
    let resolution = resolution.min(full);
    match session.target_resolution {
        Some(target) => {
            let floor = if target >= full {
                full
            } else {
                (target as f32 * UNDERSAMPLE_LIMIT) as u32
            };
            floor.saturating_sub(resolution)
                + resolution.saturating_sub(target.saturating_mul(OVERSAMPLE_LIMIT))
        }
        None => u32::MAX - resolution,
    }
}

fn render_target(session: &ViewerSession) -> Option<u32> {
    let source = session
        .source
        .as_ref()
        .filter(|source| !source.interactive)?;
    session
        .image
        .as_ref()
        .filter(|image| image.path == source.path)?;
    let target = session.target_resolution?;
    let satisfied = session.shown.is_some_and(|shown| {
        shown.content == source.content && resolution_gap(session, shown.resolution) == 0
    });
    (!satisfied).then_some(target)
}

pub fn pending_viewer_render(app_handle: &AppHandle) -> Option<(serde_json::Value, u32)> {
    if !viewer_is_open(app_handle) {
        return None;
    }
    let state = app_handle.state::<AppState>();
    let loaded_path = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|image| image.path.clone())?;
    let viewer = viewer_state(&state);
    let target = render_target(&viewer.session)?;
    let source = viewer
        .session
        .source
        .as_ref()
        .filter(|source| source.path == loaded_path)?;
    Some((source.adjustments.clone(), target))
}

pub fn schedule_viewer_render(app_handle: &AppHandle) {
    if !viewer_is_open(app_handle) {
        return;
    }
    let app_handle = app_handle.clone();
    after_settling(&RENDER_GENERATION, RENDER_SETTLE_DELAY, move || {
        if pending_viewer_render(&app_handle).is_some()
            && let Some(sender) = app_handle
                .state::<AppState>()
                .preview_worker_tx
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
        {
            let _ = sender.send(PreviewTask::Viewer);
        }
    });
}

pub fn record_editor_source(
    app_handle: &AppHandle,
    path: &str,
    adjustments: &serde_json::Value,
    content: FrameContent,
    interactive: bool,
) {
    if !viewer_is_open(app_handle) {
        return;
    }
    viewer_state(&app_handle.state::<AppState>()).session.source = Some(ViewerSource {
        path: path.to_string(),
        adjustments: adjustments.clone(),
        content,
        interactive,
    });
}

pub fn sync_viewer_image(app_handle: &AppHandle, path: &str, base_size: (u32, u32), scale: f32) {
    if !viewer_is_open(app_handle) || scale <= 0.0 {
        return;
    }
    let image = ViewerImage {
        path: path.to_string(),
        width: (base_size.0 as f32 / scale).round() as u32,
        height: (base_size.1 as f32 / scale).round() as u32,
    };
    let state = app_handle.state::<AppState>();
    {
        let mut viewer = viewer_state(&state);
        if viewer.session.image.as_ref() == Some(&image) {
            return;
        }
        let path_changed = viewer
            .session
            .image
            .as_ref()
            .is_none_or(|current| current.path != image.path);
        if path_changed {
            viewer.session = ViewerSession {
                source: viewer.session.source.take(),
                image: Some(image),
                ..Default::default()
            };
        } else {
            viewer.session.image = Some(image);
        }
    }
    notify_viewer(app_handle, "viewer-info");
}

pub fn accepts_editor_frame(
    app_handle: &AppHandle,
    content: &FrameContent,
    resolution: u32,
) -> bool {
    if !viewer_is_open(app_handle) {
        return false;
    }
    let state = app_handle.state::<AppState>();
    let viewer = viewer_state(&state);
    let session = &viewer.session;
    session.shown.is_none_or(|shown| {
        shown.content != *content
            || resolution_gap(session, resolution) < resolution_gap(session, shown.resolution)
    })
}

pub fn record_viewer_frame(
    app_handle: &AppHandle,
    content: FrameContent,
    resolution: u32,
    jpeg_bytes: Option<&[u8]>,
) {
    {
        let state = app_handle.state::<AppState>();
        let mut viewer = viewer_state(&state);
        viewer.session.shown = Some(ShownFrame {
            content,
            resolution,
        });
        if let Some(bytes) = jpeg_bytes {
            viewer.session.frame = Some(bytes.to_vec());
        }
    }
    if jpeg_bytes.is_some() {
        notify_viewer(app_handle, "viewer-updated");
    }
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
    update_viewer_display(&state, |display| display.set_background(color));
    notify_viewer(app_handle, "viewer-info");
}

fn apply_viewer_view(app_handle: &AppHandle, payload: ViewerViewPayload) {
    let state = app_handle.state::<AppState>();
    let max_dimension =
        current_gpu_context(&state).map_or(u32::MAX, |ctx| ctx.limits.max_texture_dimension_2d);
    {
        let mut viewer = viewer_state(&state);
        if viewer
            .session
            .image
            .as_ref()
            .is_none_or(|image| image.path != payload.path)
        {
            return;
        }
        viewer.session.target_resolution = Some(payload.target_resolution.min(max_dimension));
    }
    update_viewer_display(&state, |display| display.set_view(payload.view));
    schedule_viewer_render(app_handle);
}

pub fn handle_viewer_resized(window: &tauri::Window, size: tauri::PhysicalSize<u32>) {
    let window = window.clone();
    after_settling(&RESIZE_GENERATION, RESIZE_SETTLE_DELAY, move || {
        crate::gpu_processing::redraw_display(&window, size)
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
    let state = app_handle.state::<AppState>();
    viewer_state(&state).session = ViewerSession::default();
    clear_preview_slot(&state, PreviewTarget::Viewer);
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

#[cfg(not(target_os = "android"))]
fn attach_viewer_display(
    app_handle: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let ctx = crate::gpu_processing::get_or_init_gpu_context(&state, app_handle)?;
    let (surface, platform) = crate::gpu_processing::create_window_surface(&ctx.instance, window)?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let mut display = crate::gpu_processing::build_wgpu_display(
        surface,
        &ctx.adapter,
        &ctx.device,
        size,
        true,
        platform,
    )?;
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
pub async fn set_viewer_view(
    payload: ViewerViewPayload,
    app_handle: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || apply_viewer_view(&app_handle, payload))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_viewer_info(app_handle: AppHandle, state: tauri::State<AppState>) -> ViewerInfo {
    let native = load_settings(app_handle)
        .unwrap_or_default()
        .wgpu_renderer_enabled();
    let viewer = viewer_state(&state);
    ViewerInfo {
        native,
        background: viewer.background,
        image: viewer.session.image.clone(),
    }
}

#[tauri::command]
pub fn get_viewer_frame(state: tauri::State<AppState>) -> Response {
    Response::new(
        viewer_state(&state)
            .session
            .frame
            .clone()
            .unwrap_or_default(),
    )
}
