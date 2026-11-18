use crate::render::color_space::OutputColorSpace;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HdrDisplay {
    pub white_scale: f32,
    pub headroom: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[allow(dead_code)]
pub enum WideGamut {
    Unavailable,
    Tagged,
    Linear { white_scale: f32 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum SystemColor {
    Unmanaged,
    Managed(WideGamut),
    Profile(PathBuf),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MonitorState {
    pub hdr: Option<HdrDisplay>,
    pub color: SystemColor,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SurfaceTag {
    Unmanaged,
    Hdr,
    Space(OutputColorSpace),
}

pub fn query(window: &tauri::WebviewWindow, hdr: bool, color: bool) -> MonitorState {
    platform::query(window, hdr, color).unwrap_or(MonitorState {
        hdr: None,
        color: SystemColor::Unmanaged,
    })
}

pub fn tag_surface(surface: &wgpu::Surface, tag: SurfaceTag) {
    platform::tag_surface(surface, tag);
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{HdrDisplay, MonitorState, SurfaceTag, SystemColor, WideGamut};
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use wgpu::rwh::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Devices::Display::{
        DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
        DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_DEVICE_INFO_TYPE,
        DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
        DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS,
        QueryDisplayConfig,
    };
    use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LUID};
    use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_OUTPUT_DESC1, IDXGIFactory1, IDXGIOutput6,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateDCW, DeleteDC, GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO,
        MONITORINFOEXW, MonitorFromWindow,
    };
    use windows::Win32::UI::ColorSystem::GetICMProfileW;
    use windows::core::{Interface, PCWSTR, PWSTR};

    const SCRGB_WHITE_NITS: f32 = 80.0;
    const FALLBACK_SDR_WHITE_NITS: f32 = 200.0;
    const ADVANCED_COLOR_ACTIVE: u32 = 0b0110;
    const WIDE_RED_X: f32 = 0.66;
    const WIDE_GREEN_Y: f32 = 0.64;

    struct Monitor {
        handle: HMONITOR,
        device: [u16; 32],
        path: Option<DISPLAYCONFIG_PATH_INFO>,
    }

    unsafe fn device_info<T: Default>(
        kind: DISPLAYCONFIG_DEVICE_INFO_TYPE,
        adapter: LUID,
        id: u32,
    ) -> Option<T> {
        let mut info = T::default();
        unsafe {
            let header = core::ptr::from_mut(&mut info).cast::<DISPLAYCONFIG_DEVICE_INFO_HEADER>();
            (*header).r#type = kind;
            (*header).size = size_of::<T>() as u32;
            (*header).adapterId = adapter;
            (*header).id = id;
            (DisplayConfigGetDeviceInfo(header) == ERROR_SUCCESS.0 as i32).then_some(info)
        }
    }

    unsafe fn config_path(device: &[u16; 32]) -> Option<DISPLAYCONFIG_PATH_INFO> {
        unsafe {
            let (mut path_count, mut mode_count) = (0u32, 0u32);
            if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
                != ERROR_SUCCESS
            {
                return None;
            }
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
            if QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            ) != ERROR_SUCCESS
            {
                return None;
            }
            paths.into_iter().take(path_count as usize).find(|path| {
                device_info::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(
                    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    path.sourceInfo.adapterId,
                    path.sourceInfo.id,
                )
                .is_some_and(|source| source.viewGdiDeviceName == *device)
            })
        }
    }

    unsafe fn monitor(handle: RawWindowHandle) -> Option<Monitor> {
        let RawWindowHandle::Win32(handle) = handle else {
            return None;
        };
        let hwnd = HWND(handle.hwnd.get() as *mut core::ffi::c_void);
        unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if monitor.is_invalid() {
                return None;
            }
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            GetMonitorInfoW(
                monitor,
                core::ptr::from_mut(&mut info).cast::<MONITORINFO>(),
            )
            .as_bool()
            .then(|| Monitor {
                handle: monitor,
                device: info.szDevice,
                path: config_path(&info.szDevice),
            })
        }
    }

    unsafe fn target_info<T: Default>(
        monitor: &Monitor,
        kind: DISPLAYCONFIG_DEVICE_INFO_TYPE,
    ) -> Option<T> {
        let path = monitor.path.as_ref()?;
        unsafe { device_info(kind, path.targetInfo.adapterId, path.targetInfo.id) }
    }

    unsafe fn output(monitor: &Monitor) -> Option<DXGI_OUTPUT_DESC1> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            (0..)
                .map_while(|index| factory.EnumAdapters1(index).ok())
                .flat_map(|adapter| (0..).map_while(move |index| adapter.EnumOutputs(index).ok()))
                .filter_map(|output| output.cast::<IDXGIOutput6>().ok()?.GetDesc1().ok())
                .find(|output| output.Monitor == monitor.handle)
        }
    }

    unsafe fn sdr_white_nits(monitor: &Monitor, fallback: f32) -> f32 {
        unsafe {
            target_info::<DISPLAYCONFIG_SDR_WHITE_LEVEL>(
                monitor,
                DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
            )
            .filter(|white| white.SDRWhiteLevel > 0)
            .map_or(fallback, |white| {
                white.SDRWhiteLevel as f32 * SCRGB_WHITE_NITS / 1000.0
            })
        }
    }

    unsafe fn hdr(monitor: &Monitor, output: Option<&DXGI_OUTPUT_DESC1>) -> Option<HdrDisplay> {
        let output = output?;
        if output.ColorSpace != DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 {
            return None;
        }
        let white_nits = unsafe { sdr_white_nits(monitor, FALLBACK_SDR_WHITE_NITS) };
        let headroom = output.MaxLuminance / white_nits;
        Some(HdrDisplay {
            white_scale: white_nits / SCRGB_WHITE_NITS,
            headroom: if output.MaxLuminance > 0.0 && headroom.is_finite() {
                headroom
            } else {
                f32::INFINITY
            },
        })
    }

    unsafe fn color(monitor: &Monitor, output: Option<&DXGI_OUTPUT_DESC1>) -> Option<SystemColor> {
        unsafe {
            let advanced_color = target_info::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>(
                monitor,
                DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
            )
            .is_some_and(|info| info.Anonymous.value & ADVANCED_COLOR_ACTIVE != 0);
            if advanced_color {
                let wide_gamut = output.is_some_and(|output| {
                    output.RedPrimary[0] > WIDE_RED_X || output.GreenPrimary[1] > WIDE_GREEN_Y
                });
                return Some(SystemColor::Managed(if wide_gamut {
                    WideGamut::Linear {
                        white_scale: sdr_white_nits(monitor, SCRGB_WHITE_NITS) / SCRGB_WHITE_NITS,
                    }
                } else {
                    WideGamut::Unavailable
                }));
            }
            let device = PCWSTR(monitor.device.as_ptr());
            let dc = CreateDCW(device, device, PCWSTR::null(), None);
            if dc.is_invalid() {
                return None;
            }
            let mut name = [0u16; 1024];
            let mut length = name.len() as u32;
            let found = GetICMProfileW(dc, &mut length, Some(PWSTR(name.as_mut_ptr()))).as_bool();
            let _ = DeleteDC(dc);
            let end = name.iter().position(|unit| *unit == 0)?;
            (found && end > 0)
                .then(|| SystemColor::Profile(PathBuf::from(OsString::from_wide(&name[..end]))))
        }
    }

    pub fn query(
        window: &tauri::WebviewWindow,
        want_hdr: bool,
        want_color: bool,
    ) -> Option<MonitorState> {
        unsafe {
            let monitor = monitor(window.window_handle().ok()?.as_raw())?;
            let output = output(&monitor);
            Some(MonitorState {
                hdr: want_hdr.then(|| hdr(&monitor, output.as_ref())).flatten(),
                color: want_color
                    .then(|| color(&monitor, output.as_ref()))
                    .flatten()
                    .unwrap_or(SystemColor::Unmanaged),
            })
        }
    }

    pub fn tag_surface(surface: &wgpu::Surface, tag: SurfaceTag) {
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
        };
        let Some(surface) = (unsafe { surface.as_hal::<wgpu::hal::api::Dx12>() }) else {
            return;
        };
        let Some(swap_chain) = surface.swap_chain() else {
            return;
        };
        let space = match tag {
            SurfaceTag::Hdr => DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709,
            _ => DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
        };
        if let Err(e) = unsafe { swap_chain.SetColorSpace1(space) } {
            log::warn!("Cannot set the swap chain color space: {}", e);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{HdrDisplay, MonitorState, SurfaceTag, SystemColor, WideGamut};
    use crate::render::color_space::OutputColorSpace;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_core_graphics::{
        CGColorSpace, kCGColorSpaceAdobeRGB1998, kCGColorSpaceDisplayP3,
        kCGColorSpaceExtendedLinearSRGB, kCGColorSpaceITUR_2020, kCGColorSpaceROMMRGB,
        kCGColorSpaceSRGB,
    };
    use wgpu::rwh::{HasWindowHandle, RawWindowHandle};

    const DISPLAY_GAMUT_P3: isize = 2;

    pub fn query(
        window: &tauri::WebviewWindow,
        want_hdr: bool,
        want_color: bool,
    ) -> Option<MonitorState> {
        let RawWindowHandle::AppKit(handle) = window.window_handle().ok()?.as_raw() else {
            return None;
        };
        let view = handle.ns_view.as_ptr().cast::<AnyObject>();
        unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                return None;
            }
            let screen: *mut AnyObject = msg_send![window, screen];
            if screen.is_null() {
                return None;
            }
            let hdr = want_hdr
                .then(|| {
                    let potential_headroom: f64 = msg_send![
                        screen,
                        maximumPotentialExtendedDynamicRangeColorComponentValue
                    ];
                    (potential_headroom > 1.0).then_some(HdrDisplay {
                        white_scale: 1.0,
                        headroom: potential_headroom as f32,
                    })
                })
                .flatten();
            let color = if want_color {
                let wide_gamut: bool =
                    msg_send![screen, canRepresentDisplayGamut: DISPLAY_GAMUT_P3];
                SystemColor::Managed(if wide_gamut {
                    WideGamut::Tagged
                } else {
                    WideGamut::Unavailable
                })
            } else {
                SystemColor::Unmanaged
            };
            Some(MonitorState { hdr, color })
        }
    }

    pub fn tag_surface(surface: &wgpu::Surface, tag: SurfaceTag) {
        let name = unsafe {
            match tag {
                SurfaceTag::Unmanaged => None,
                SurfaceTag::Hdr => Some(kCGColorSpaceExtendedLinearSRGB),
                SurfaceTag::Space(OutputColorSpace::Srgb) => Some(kCGColorSpaceSRGB),
                SurfaceTag::Space(OutputColorSpace::DisplayP3) => Some(kCGColorSpaceDisplayP3),
                SurfaceTag::Space(OutputColorSpace::AdobeRgb) => Some(kCGColorSpaceAdobeRGB1998),
                SurfaceTag::Space(OutputColorSpace::ProPhotoRgb) => Some(kCGColorSpaceROMMRGB),
                SurfaceTag::Space(OutputColorSpace::Rec2020) => Some(kCGColorSpaceITUR_2020),
            }
        };
        let color_space = name.and_then(|name| CGColorSpace::with_name(Some(name)));
        if let Some(surface) = unsafe { surface.as_hal::<wgpu::hal::api::Metal>() } {
            surface
                .render_layer()
                .lock()
                .setColorspace(color_space.as_deref());
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{MonitorState, SurfaceTag, SystemColor, WideGamut};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::OwnedObjectPath;

    const COLORD: &str = "org.freedesktop.ColorManager";
    const COLORD_PATH: &str = "/org/freedesktop/ColorManager";
    const COLORD_DEVICE: &str = "org.freedesktop.ColorManager.Device";
    const COLORD_PROFILE: &str = "org.freedesktop.ColorManager.Profile";
    const LOOKUP_TIMEOUT: Duration = Duration::from_millis(500);
    const LOOKUP_INTERVAL: Duration = Duration::from_secs(5);

    fn colord_profile(model: Option<&str>) -> Option<PathBuf> {
        let connection = Connection::system().ok()?;
        let manager = Proxy::new(&connection, COLORD, COLORD_PATH, COLORD).ok()?;
        let devices: Vec<OwnedObjectPath> = manager.call("GetDevicesByKind", &("display",)).ok()?;
        let devices: Vec<Proxy> = devices
            .into_iter()
            .filter_map(|path| Proxy::new(&connection, COLORD, path, COLORD_DEVICE).ok())
            .collect();
        let device = match devices.as_slice() {
            [only] => only,
            several => {
                let model = model?;
                several.iter().find(|device| {
                    device
                        .get_property::<String>("Model")
                        .is_ok_and(|name| name == model)
                })?
            }
        };
        let profiles: Vec<OwnedObjectPath> = device.get_property("Profiles").ok()?;
        let profile = Proxy::new(
            &connection,
            COLORD,
            profiles.into_iter().next()?,
            COLORD_PROFILE,
        )
        .ok()?;
        let metadata: HashMap<String, String> = profile.get_property("Metadata").ok()?;
        if metadata
            .get("DATA_source")
            .is_some_and(|source| source == "edid")
        {
            return None;
        }
        let filename: String = profile.get_property("Filename").ok()?;
        (!filename.is_empty()).then(|| PathBuf::from(filename))
    }

    fn assigned_profile(window: &tauri::WebviewWindow) -> Option<PathBuf> {
        type Lookups = HashMap<String, (Instant, Option<PathBuf>)>;
        static LATEST: LazyLock<Mutex<Lookups>> = LazyLock::new(Default::default);
        let mut latest = LATEST.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((checked_at, profile)) = latest.get(window.label())
            && checked_at.elapsed() < LOOKUP_INTERVAL
        {
            return profile.clone();
        }
        let label = window.label().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        let window = window.clone();
        std::thread::spawn(move || {
            let model = window
                .current_monitor()
                .ok()
                .flatten()
                .and_then(|monitor| monitor.name().cloned());
            let _ = tx.send(colord_profile(model.as_deref()));
        });
        let profile = rx.recv_timeout(LOOKUP_TIMEOUT).ok().flatten();
        latest.insert(label, (Instant::now(), profile.clone()));
        profile
    }

    pub fn query(
        window: &tauri::WebviewWindow,
        _want_hdr: bool,
        want_color: bool,
    ) -> Option<MonitorState> {
        let color = if !want_color {
            SystemColor::Unmanaged
        } else if crate::platform::wayland_subsurface::compositor_manages_color() {
            SystemColor::Managed(WideGamut::Unavailable)
        } else {
            assigned_profile(window).map_or(SystemColor::Unmanaged, SystemColor::Profile)
        };
        Some(MonitorState { hdr: None, color })
    }

    pub fn tag_surface(_surface: &wgpu::Surface, _tag: SurfaceTag) {}
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::{MonitorState, SurfaceTag};

    pub fn query(
        _window: &tauri::WebviewWindow,
        _want_hdr: bool,
        _want_color: bool,
    ) -> Option<MonitorState> {
        None
    }

    pub fn tag_surface(_surface: &wgpu::Surface, _tag: SurfaceTag) {}
}
