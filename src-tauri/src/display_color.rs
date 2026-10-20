use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayColorInfo {
    pub platform: String,
    pub icc_profile_path: Option<String>,
    pub icc_status: String,
    pub cpu_name: String,
    pub logical_cpu_count: usize,
    pub gpu_name: Option<String>,
    pub gpu_backend: Option<String>,
    pub gpu_device_type: Option<String>,
    pub gpu_status: String,
    pub optimization_profile: String,
    pub note: String,
}

#[tauri::command]
pub async fn get_display_color_info() -> Result<DisplayColorInfo, String> {
    let cpu = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_cpu(sysinfo::CpuRefreshKind::everything()),
    );
    let cpu_name = cpu.cpus().first().map(|c| c.brand().to_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "CPU name unavailable".to_string());
    let logical_cpu_count = std::thread::available_parallelism().map(usize::from).unwrap_or(1);

    #[cfg(target_os = "windows")]
    let (icc_profile_path, icc_status) = windows_icc_profile();
    #[cfg(target_os = "macos")]
    let (icc_profile_path, icc_status) = (None, "Managed by macOS ColorSync; direct profile lookup is not enabled in this build.".to_string());
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let (icc_profile_path, icc_status) = (None, "ICC profile lookup is supported here only on Windows; other platforms are intentionally not targeted.".to_string());

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }).await;

    let (gpu_name, gpu_backend, gpu_device_type, gpu_status, optimization_profile) = match adapter {
        Ok(adapter) => {
            let info = adapter.get_info();
            let device_type = format!("{:?}", info.device_type);
            let profile = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                "apple-silicon-metal".to_string()
            } else if info.device_type == wgpu::DeviceType::IntegratedGpu {
                "integrated-gpu-low-power".to_string()
            } else if info.device_type == wgpu::DeviceType::DiscreteGpu {
                "discrete-gpu-performance".to_string()
            } else {
                "cpu-safe-default".to_string()
            };
            (Some(info.name), Some(format!("{:?}", info.backend)), Some(device_type),
             "Detected through WGPU; renderer remains enabled.".to_string(), profile)
        }
        Err(_) => (None, None, None,
            "No hardware WGPU adapter found; use CPU-safe settings.".to_string(),
            if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                "apple-silicon-cpu-fallback".to_string()
            } else { "cpu-safe-default".to_string() }),
    };

    let platform = if cfg!(target_os = "windows") { "windows" }
        else if cfg!(target_os = "macos") { "macos" }
        else { std::env::consts::OS }.to_string();

    Ok(DisplayColorInfo {
        platform,
        icc_profile_path,
        icc_status,
        cpu_name,
        logical_cpu_count,
        gpu_name,
        gpu_backend,
        gpu_device_type,
        gpu_status,
        optimization_profile,
        note: "ICC detection identifies the Windows profile; full wide-gamut output also requires an ICC transform in the final WGPU display pipeline. This command does not change Windows display settings.".to_string(),
    })
}

#[cfg(target_os = "windows")]
fn windows_icc_profile() -> (Option<String>, String) {
    use std::ptr::null_mut;
    use windows_sys::Win32::Graphics::Gdi::{GetDC, GetICMProfileW, ReleaseDC};

    unsafe {
        let dc = GetDC(null_mut());
        if dc.is_null() {
            return (None, "Could not open the Windows display device context.".to_string());
        }
        let mut chars: u32 = 0;
        let first = GetICMProfileW(dc, &mut chars, null_mut());
        if first == 0 && chars == 0 {
            ReleaseDC(null_mut(), dc);
            return (None, "Windows did not return an ICC profile; sRGB/system color management may be active.".to_string());
        }
        if chars == 0 || chars > 32768 {
            ReleaseDC(null_mut(), dc);
            return (None, "Windows returned an invalid ICC profile path length.".to_string());
        }
        let mut buffer = vec![0u16; chars as usize + 1];
        let ok = GetICMProfileW(dc, &mut chars, buffer.as_mut_ptr());
        ReleaseDC(null_mut(), dc);
        if ok == 0 {
            return (None, "Windows could not resolve the active display ICC profile.".to_string());
        }
        let path = String::from_utf16_lossy(&buffer[..(chars as usize).min(buffer.len())])
            .trim_end_matches('\0').to_string();
        if path.is_empty() {
            (None, "Windows returned an empty ICC profile path.".to_string())
        } else {
            (Some(path), "Active Windows display ICC profile detected.".to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn _windows_icc_profile_not_available() {}
