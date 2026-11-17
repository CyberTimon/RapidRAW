use wgpu::rwh::{HasWindowHandle, RawWindowHandle};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HdrDisplay {
    pub white_scale: f32,
    pub headroom: f32,
}

pub fn query(window: &impl HasWindowHandle) -> Option<HdrDisplay> {
    platform::query(window.window_handle().ok()?.as_raw())
}

pub fn prepare_surface(surface: &wgpu::Surface, hdr: bool) {
    platform::prepare_surface(surface, hdr);
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{HdrDisplay, RawWindowHandle};
    use windows::Win32::Devices::Display::{
        DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SDR_WHITE_LEVEL,
        DISPLAYCONFIG_SOURCE_DEVICE_NAME, DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes,
        QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
    };
    use windows::Win32::Foundation::{ERROR_SUCCESS, HWND};
    use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MONITORINFOEXW,
        MonitorFromWindow,
    };
    use windows::core::Interface;

    const SCRGB_WHITE_NITS: f32 = 80.0;
    const FALLBACK_SDR_WHITE_NITS: f32 = 200.0;

    pub fn query(handle: RawWindowHandle) -> Option<HdrDisplay> {
        let RawWindowHandle::Win32(handle) = handle else {
            return None;
        };
        let hwnd = HWND(handle.hwnd.get() as *mut core::ffi::c_void);
        unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if monitor.is_invalid() {
                return None;
            }
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let output = (0..)
                .map_while(|index| factory.EnumAdapters1(index).ok())
                .flat_map(|adapter| (0..).map_while(move |index| adapter.EnumOutputs(index).ok()))
                .filter_map(|output| output.cast::<IDXGIOutput6>().ok()?.GetDesc1().ok())
                .find(|output| output.Monitor == monitor)?;
            if output.ColorSpace != DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 {
                return None;
            }
            let white_nits = sdr_white_nits(monitor).unwrap_or(FALLBACK_SDR_WHITE_NITS);
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
    }

    unsafe fn sdr_white_nits(monitor: HMONITOR) -> Option<f32> {
        unsafe {
            let mut monitor_info = MONITORINFOEXW::default();
            monitor_info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            let info = core::ptr::from_mut(&mut monitor_info).cast::<MONITORINFO>();
            if !GetMonitorInfoW(monitor, info).as_bool() {
                return None;
            }

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

            let succeeded = |status: i32| status == ERROR_SUCCESS.0 as i32;
            paths.iter().take(path_count as usize).find_map(|path| {
                let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
                source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
                source.header.size = size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
                source.header.adapterId = path.sourceInfo.adapterId;
                source.header.id = path.sourceInfo.id;
                if !succeeded(DisplayConfigGetDeviceInfo(&mut source.header))
                    || source.viewGdiDeviceName != monitor_info.szDevice
                {
                    return None;
                }

                let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL::default();
                white.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL;
                white.header.size = size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32;
                white.header.adapterId = path.targetInfo.adapterId;
                white.header.id = path.targetInfo.id;
                (succeeded(DisplayConfigGetDeviceInfo(&mut white.header))
                    && white.SDRWhiteLevel > 0)
                    .then(|| white.SDRWhiteLevel as f32 * SCRGB_WHITE_NITS / 1000.0)
            })
        }
    }

    pub fn prepare_surface(_surface: &wgpu::Surface, _hdr: bool) {}
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{HdrDisplay, RawWindowHandle};
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_core_graphics::{CGColorSpace, kCGColorSpaceExtendedLinearSRGB};

    pub fn query(handle: RawWindowHandle) -> Option<HdrDisplay> {
        let RawWindowHandle::AppKit(handle) = handle else {
            return None;
        };
        let view = handle.ns_view.as_ptr().cast::<AnyObject>();
        let potential_headroom: f64 = unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                return None;
            }
            let screen: *mut AnyObject = msg_send![window, screen];
            if screen.is_null() {
                return None;
            }
            msg_send![
                screen,
                maximumPotentialExtendedDynamicRangeColorComponentValue
            ]
        };
        (potential_headroom > 1.0).then_some(HdrDisplay {
            white_scale: 1.0,
            headroom: potential_headroom as f32,
        })
    }

    pub fn prepare_surface(surface: &wgpu::Surface, hdr: bool) {
        let color_space = hdr
            .then(|| unsafe { CGColorSpace::with_name(Some(kCGColorSpaceExtendedLinearSRGB)) })
            .flatten();
        if let Some(surface) = unsafe { surface.as_hal::<wgpu::hal::api::Metal>() } {
            surface
                .render_layer()
                .lock()
                .setColorspace(color_space.as_deref());
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{HdrDisplay, RawWindowHandle};

    pub fn query(_handle: RawWindowHandle) -> Option<HdrDisplay> {
        None
    }

    pub fn prepare_surface(_surface: &wgpu::Surface, _hdr: bool) {}
}
