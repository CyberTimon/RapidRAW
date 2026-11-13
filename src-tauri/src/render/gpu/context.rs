#[cfg(not(target_os = "android"))]
use crate::app::settings::load_settings;
use crate::app::state::{AppState, PreviewTarget};
#[cfg(target_os = "android")]
use crate::render::gpu::display::PlatformSurface;
#[cfg(target_os = "linux")]
use crate::render::gpu::display::WGPU_DISPLAY_FAILED;
use crate::render::gpu::display::WgpuDisplay;
#[cfg(not(target_os = "android"))]
use crate::render::gpu::display::{build_wgpu_display, surface_for_window};
use crate::render::gpu::pipelines::GpuPipelines;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::Manager;

pub fn current_gpu_context(state: &AppState) -> Option<GpuContext> {
    state
        .gpu_context
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

static GPU_DEVICE_LOST: AtomicBool = AtomicBool::new(false);

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn register_app_handle(app_handle: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app_handle.clone());
}

pub fn shared_gpu_context() -> Result<GpuContext, String> {
    let app_handle = APP_HANDLE
        .get()
        .ok_or("GPU context requested before app setup")?;
    get_or_init_gpu_context(&app_handle.state::<AppState>(), app_handle)
}

pub fn get_or_init_gpu_context(
    state: &tauri::State<AppState>,
    #[cfg_attr(target_os = "android", allow(unused_variables))] app_handle: &tauri::AppHandle,
) -> Result<GpuContext, String> {
    let mut context_lock = match state.gpu_context.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!(
                "GPU context lock was poisoned (previous crash). Wiping state to self-heal."
            );
            let mut guard = poisoned.into_inner();
            *guard = None;
            guard
        }
    };
    #[cfg(target_os = "linux")]
    let mut reused_wayland = None;
    if GPU_DEVICE_LOST.load(Ordering::Acquire) {
        log::warn!("Recreating GPU context after the device was lost.");
        if let Some(context) = context_lock.take() {
            #[cfg(target_os = "linux")]
            {
                reused_wayland = context
                    .display
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                    .and_then(|mut display| display.wayland.take());
            }
            *context.display.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *context
                .viewer_display
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
        }
        *lock_or_reset(&state.gpu_processor, "GPU processor") = None;
        for target in PreviewTarget::ALL {
            *lock_or_reset(state.gpu_image_cache_for(target), "GPU image cache") = None;
        }
        GPU_DEVICE_LOST.store(false, Ordering::Release);
    }
    if let Some(context) = &*context_lock {
        return Ok(context.clone());
    }

    #[allow(unused_mut)]
    let mut instance_desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();

    #[cfg(target_os = "windows")]
    if std::env::var("WGPU_BACKEND").is_err() {
        instance_desc.backends = wgpu::Backends::PRIMARY;
    }

    let flag_path = state.gpu_crash_flag_path.lock().unwrap().clone();
    if let Some(p) = &flag_path {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, "initializing_gpu");
    }

    let instance = wgpu::Instance::new(instance_desc);

    #[cfg(not(target_os = "android"))]
    let surface_opt = {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        if settings.wgpu_renderer_enabled() {
            if let Some(window) = app_handle.get_webview_window("main") {
                #[cfg(target_os = "linux")]
                let created = match reused_wayland {
                    Some(wayland) => wayland
                        .create_surface(&instance)
                        .map(|surface| (surface, Some(wayland))),
                    None => surface_for_window(&instance, &window),
                };
                #[cfg(not(target_os = "linux"))]
                let created = surface_for_window(&instance, &window);
                match created {
                    Ok(surface) => Some(surface),
                    Err(e) => {
                        log::warn!(
                            "Failed to create surface, falling back to compute-only: {}",
                            e
                        );
                        #[cfg(target_os = "linux")]
                        WGPU_DISPLAY_FAILED.store(true, Ordering::Release);
                        if let Some(p) = &flag_path {
                            let _ = std::fs::remove_file(p);
                        }
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    };

    #[cfg(target_os = "android")]
    let surface_opt: Option<(wgpu::Surface, PlatformSurface)> = None;

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: surface_opt.as_ref().map(|(surface, _)| surface),
        ..Default::default()
    }))
    .map_err(|e| {
        if let Some(p) = &flag_path {
            let _ = std::fs::remove_file(p);
        }
        format!("Failed to find a wgpu adapter: {}", e)
    })?;

    let adapter_info = adapter.get_info();
    log::info!(
        "Using GPU adapter: {} ({:?}, {:?}, driver: {} {})",
        adapter_info.name,
        adapter_info.backend,
        adapter_info.device_type,
        adapter_info.driver,
        adapter_info.driver_info
    );

    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
    {
        required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    }

    let limits = adapter.limits();

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("Processing Device"),
        required_features,
        required_limits: limits.clone(),
        experimental_features: wgpu::ExperimentalFeatures::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .map_err(|e| {
        if let Some(p) = &flag_path {
            let _ = std::fs::remove_file(p);
        }
        e.to_string()
    })?;

    device.on_uncaptured_error(Arc::new(|err: wgpu::Error| {
        log::error!("[wgpu-error] {}", err);
    }));
    device.set_device_lost_callback(|reason, message| {
        if reason == wgpu::DeviceLostReason::Unknown {
            log::error!("GPU device lost: {}", message);
            GPU_DEVICE_LOST.store(true, Ordering::Release);
        }
    });

    if let Some(p) = &flag_path {
        let _ = std::fs::remove_file(p);
    }

    #[cfg(not(target_os = "android"))]
    let display_opt = if let Some((surface, platform)) = surface_opt {
        let window = app_handle
            .get_webview_window("main")
            .ok_or("Failed to get main window")?;
        let size = window
            .inner_size()
            .unwrap_or(tauri::PhysicalSize::new(1280, 720));
        Some(build_wgpu_display(
            surface, &adapter, &device, size, false, platform,
        )?)
    } else {
        None
    };

    #[cfg(target_os = "android")]
    let display_opt = None;

    let new_context = GpuContext {
        instance,
        adapter,
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        display: Arc::new(std::sync::Mutex::new(display_opt)),
        viewer_display: Arc::new(std::sync::Mutex::new(None)),
        pipelines: Arc::new(std::sync::OnceLock::new()),
        compute: Arc::new(std::sync::OnceLock::new()),
    };
    let device = Arc::clone(&new_context.device);
    let compute = Arc::clone(&new_context.compute);
    std::thread::spawn(move || {
        crate::decode::demosaic::warm(&device);
        crate::decode::develop::warm(&device);
        compute
            .get_or_init(|| crate::render::gpu::compute::ComputePipelines::new(&device))
            .warm(&device);
    });
    *context_lock = Some(new_context.clone());
    Ok(new_context)
}

#[derive(Clone)]
pub struct GpuContext {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub limits: wgpu::Limits,
    pub display: Arc<std::sync::Mutex<Option<WgpuDisplay>>>,
    pub viewer_display: Arc<std::sync::Mutex<Option<WgpuDisplay>>>,
    pub pipelines: Arc<OnceLock<Arc<GpuPipelines>>>,
    pub compute: Arc<OnceLock<crate::render::gpu::compute::ComputePipelines>>,
}

impl GpuContext {
    pub fn display_for_label(
        &self,
        label: &str,
    ) -> Option<&Arc<std::sync::Mutex<Option<WgpuDisplay>>>> {
        match label {
            "main" => Some(&self.display),
            crate::platform::viewer_window::VIEWER_LABEL => Some(&self.viewer_display),
            _ => None,
        }
    }
}

pub fn lock_or_reset<'a, T>(
    mutex: &'a std::sync::Mutex<Option<T>>,
    name: &str,
) -> std::sync::MutexGuard<'a, Option<T>> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::warn!("{} lock was poisoned. Resetting to self-heal.", name);
        let mut guard = poisoned.into_inner();
        *guard = None;
        guard
    })
}
