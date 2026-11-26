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
use std::sync::{Arc, Mutex, OnceLock};
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

pub fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

pub fn shared_gpu_context() -> Result<GpuContext, String> {
    let app_handle = app_handle().ok_or("GPU context requested before app setup")?;
    get_or_init_gpu_context(&app_handle.state::<AppState>(), app_handle)
}

#[derive(Clone)]
pub struct DecodeGpu {
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub limits: wgpu::Limits,
    pub adapter: String,
}

struct DecodeSlot {
    owner: Arc<wgpu::Device>,
    gpu: DecodeGpu,
    lean: bool,
}

static DECODE_GPU: Mutex<Option<DecodeSlot>> = Mutex::new(None);
static DECODE_DEVICE_LOST: AtomicBool = AtomicBool::new(false);

pub fn adapter_label(adapter: &wgpu::Adapter) -> String {
    let info = adapter.get_info();
    format!(
        "{} ({:?}, {} {})",
        info.name, info.backend, info.driver, info.driver_info
    )
}

pub fn decode_gpu_context() -> Result<DecodeGpu, String> {
    let context = shared_gpu_context()?;
    if context.shares_one_gl_context() {
        return Err("the GL backend cannot run decoding next to rendering".into());
    }
    Ok(decode_gpu_for(&context))
}

pub fn release_decode_gpu(failed: &Arc<wgpu::Device>) -> bool {
    let mut slot = DECODE_GPU.lock().unwrap_or_else(|e| e.into_inner());
    let released = slot.as_ref().is_some_and(|slot| {
        !slot.lean
            && Arc::ptr_eq(&slot.gpu.device, failed)
            && !Arc::ptr_eq(&slot.gpu.device, &slot.owner)
    });
    if released {
        *slot = None;
    }
    released
}

fn decode_gpu_for(context: &GpuContext) -> DecodeGpu {
    let mut slot = DECODE_GPU.lock().unwrap_or_else(|e| e.into_inner());
    if DECODE_DEVICE_LOST.swap(false, Ordering::AcqRel) {
        *slot = None;
    }
    if let Some(existing) = slot.as_ref()
        && Arc::ptr_eq(&existing.owner, &context.device)
    {
        return existing.gpu.clone();
    }
    let adapter = adapter_label(&context.adapter);
    let lean = crate::decode::gpu_fallback::has_failed(&adapter);
    let opened = open_device(
        &context.adapter,
        "Decode Device",
        wgpu::Features::empty(),
        &context.limits,
        if lean {
            wgpu::MemoryHints::MemoryUsage
        } else {
            wgpu::MemoryHints::Performance
        },
        &DECODE_DEVICE_LOST,
    );
    let (device, queue) = opened.unwrap_or_else(|e| {
        log::warn!("Decoding on the display queue: {}", e);
        (Arc::clone(&context.device), Arc::clone(&context.queue))
    });
    let gpu = DecodeGpu {
        device,
        queue,
        limits: context.limits.clone(),
        adapter,
    };
    *slot = Some(DecodeSlot {
        owner: Arc::clone(&context.device),
        gpu: gpu.clone(),
        lean,
    });
    gpu
}

fn open_device(
    adapter: &wgpu::Adapter,
    label: &'static str,
    required_features: wgpu::Features,
    limits: &wgpu::Limits,
    memory_hints: wgpu::MemoryHints,
    lost: &'static AtomicBool,
) -> Result<(Arc<wgpu::Device>, Arc<wgpu::Queue>), String> {
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some(label),
        required_features,
        required_limits: limits.clone(),
        experimental_features: wgpu::ExperimentalFeatures::default(),
        memory_hints,
        trace: wgpu::Trace::Off,
    }))
    .map_err(|e| e.to_string())?;
    device.on_uncaptured_error(Arc::new(move |err: wgpu::Error| {
        log::error!("[wgpu-error] {}: {}", label, err);
    }));
    device.set_device_lost_callback(move |reason, message| {
        if reason == wgpu::DeviceLostReason::Unknown {
            log::error!("{} lost: {}", label, message);
            lost.store(true, Ordering::Release);
        }
    });
    Ok((Arc::new(device), Arc::new(queue)))
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

    crate::render::gpu::fallback::begin_attempt(
        &std::env::var("WGPU_BACKEND").unwrap_or_else(|_| "auto".to_string()),
    );

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
        crate::render::gpu::fallback::abandon_attempt();
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
    crate::render::gpu::fallback::begin_attempt(crate::render::gpu::fallback::backend_name(
        adapter_info.backend,
    ));

    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
    {
        required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    }

    let limits = adapter.limits();

    let (device, queue) = open_device(
        &adapter,
        "Processing Device",
        required_features,
        &limits,
        wgpu::MemoryHints::Performance,
        &GPU_DEVICE_LOST,
    )
    .inspect_err(|_| crate::render::gpu::fallback::abandon_attempt())?;

    #[cfg(not(target_os = "android"))]
    let display_opt = if let Some((surface, platform)) = surface_opt {
        let window = app_handle
            .get_webview_window("main")
            .ok_or("Failed to get main window")?;
        let size = window
            .inner_size()
            .unwrap_or(tauri::PhysicalSize::new(1280, 720));
        Some(build_wgpu_display(
            surface, &adapter, &device, &queue, size, false, platform,
        )?)
    } else {
        None
    };

    #[cfg(target_os = "android")]
    let display_opt = None;

    let new_context = GpuContext {
        instance,
        adapter,
        device,
        queue,
        limits,
        backend: adapter_info.backend,
        display: Arc::new(std::sync::Mutex::new(display_opt)),
        viewer_display: Arc::new(std::sync::Mutex::new(None)),
        pipelines: Arc::new(std::sync::OnceLock::new()),
        compute: Arc::new(std::sync::OnceLock::new()),
    };
    if !new_context.shares_one_gl_context() {
        let warm = new_context.clone();
        std::thread::spawn(move || {
            crate::decode::gpu_fallback::prepare(&decode_gpu_for(&warm));
            warm.compute
                .get_or_init(|| crate::render::gpu::compute::ComputePipelines::new(&warm.device))
                .warm(&warm.device);
        });
    }
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
    pub backend: wgpu::Backend,
    pub display: Arc<std::sync::Mutex<Option<WgpuDisplay>>>,
    pub viewer_display: Arc<std::sync::Mutex<Option<WgpuDisplay>>>,
    pub pipelines: Arc<OnceLock<Arc<GpuPipelines>>>,
    pub compute: Arc<OnceLock<crate::render::gpu::compute::ComputePipelines>>,
}

impl GpuContext {
    pub fn shares_one_gl_context(&self) -> bool {
        self.backend == wgpu::Backend::Gl
    }

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
