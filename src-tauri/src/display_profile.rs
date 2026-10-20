use serde::Serialize;

/// The profile currently associated with the Windows display device.
///
/// The path is useful for diagnostics; the embedded bytes let the frontend or
/// rendering layer consume the profile without depending on filesystem access.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayIccProfile {
    pub supported: bool,
    pub path: Option<String>,
    pub profile_base64: Option<String>,
    pub error: Option<String>,
}

#[cfg(target_os = "windows")]
fn query_windows_display_profile() -> Result<DisplayIccProfile, String> {
    use std::ffi::c_void;
    use std::ptr;

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateDCW(
            driver: *const u16,
            device: *const u16,
            output: *const u16,
            init_data: *const c_void,
        ) -> *mut c_void;
        fn GetICMProfileW(hdc: *mut c_void, size: *mut u32, filename: *mut u16) -> i32;
        fn DeleteDC(hdc: *mut c_void) -> i32;
    }

    let driver: Vec<u16> = "DISPLAY\0".encode_utf16().collect();
    // Ask GDI for the active display DC. Windows resolves the display's
    // configured ICC profile through its color-management settings.
    let hdc = unsafe { CreateDCW(driver.as_ptr(), ptr::null(), ptr::null(), ptr::null()) };
    if hdc.is_null() {
        return Err("Windows could not create a display device context".into());
    }

    let mut size: u32 = 32_768;
    let mut path_buffer = vec![0u16; size as usize];
    let ok = unsafe { GetICMProfileW(hdc, &mut size, path_buffer.as_mut_ptr()) };
    unsafe { DeleteDC(hdc) };

    if ok == 0 || size == 0 {
        return Err("Windows did not return an ICC profile for the display".into());
    }
    let used = (size as usize).min(path_buffer.len());
    let path = String::from_utf16_lossy(&path_buffer[..used])
        .trim_end_matches('\0')
        .to_owned();
    if path.is_empty() {
        return Err("Windows returned an empty display ICC profile path".into());
    }

    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Could not read display ICC profile at {path}: {e}"))?;
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(DisplayIccProfile {
        supported: true,
        path: Some(path),
        profile_base64: Some(encoded),
        error: None,
    })
}

/// Detect the ICC profile assigned to the active Windows display.
///
/// This detects and returns the profile; it does not by itself apply a color
/// transform to image pixels. Other platforms report that this API is not yet
/// implemented rather than guessing a profile.
#[tauri::command]
pub fn get_display_icc_profile() -> DisplayIccProfile {
    #[cfg(target_os = "windows")]
    {
        return query_windows_display_profile().unwrap_or_else(|error| DisplayIccProfile {
            supported: true,
            path: None,
            profile_base64: None,
            error: Some(error),
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        DisplayIccProfile {
            supported: false,
            path: None,
            profile_base64: None,
            error: Some("Display ICC profile detection is currently implemented for Windows only".into()),
        }
    }
}
