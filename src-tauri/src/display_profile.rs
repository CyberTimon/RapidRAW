//! Display color management for the editor preview (Linux only).
//!
//! The GPU pipeline produces sRGB-encoded pixels. On Linux the editor shows them
//! as JPEGs inside WebKitGTK, which does no color management, so on a non-sRGB
//! monitor the edit view looks different from color-managed viewers. This module
//! resolves the monitor's ICC profile (X11 `_ICC_PROFILE` atom, colord, or a
//! user-chosen file) and converts preview pixels from sRGB into it.
//!
//! Profile detection does I/O and runs only from `refresh` (startup, settings
//! changes, background watcher). The preview hot path only reads the cached
//! transforms.

use crate::app_settings::AppSettings;
use moxcms::{
    CmsError, ColorProfile, DataColorSpace, Layout, ProfileClass, ProfileText, RenderingIntent,
    TransformExecutor, TransformOptions,
};
use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

/// Must match the event name the frontend listens to (src/hooks/useTauriListeners.ts).
const PROFILE_CHANGED_EVENT: &str = "display-profile-changed";
const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
const PIXELS_PER_CHUNK: usize = 16 * 1024;

type Executor = Arc<dyn TransformExecutor<u8> + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    X11,
    Colord,
    File,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Custom(Option<String>),
    Off,
}

impl Mode {
    pub fn from_settings(settings: &AppSettings) -> Self {
        match settings
            .display_color_management
            .as_deref()
            .unwrap_or("auto")
        {
            "off" => Mode::Off,
            "custom" => Mode::Custom(
                settings
                    .display_profile_path
                    .clone()
                    .filter(|p| !p.trim().is_empty()),
            ),
            _ => Mode::Auto,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::Custom(_) => "custom",
            Mode::Off => "off",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayProfileInfo {
    pub mode: String,
    pub source: ProfileSource,
    pub description: Option<String>,
    /// A conversion is currently applied to the edit view.
    pub active: bool,
    /// Not applied because the direct wgpu renderer draws the edit view itself.
    pub blocked_by_wgpu: bool,
    pub error: Option<String>,
    /// Changes whenever the applied conversion changes; the frontend re-renders on change.
    pub generation: u64,
}

struct Transforms {
    rgba: Executor,
    rgba_to_rgb: Executor,
}

struct State {
    info: DisplayProfileInfo,
    /// blake3 of the profile bytes + intent of the active transform, if any.
    key: Option<[u8; 32]>,
    transforms: Option<Arc<Transforms>>,
}

static STATE: LazyLock<RwLock<State>> = LazyLock::new(|| {
    RwLock::new(State {
        info: DisplayProfileInfo {
            mode: "off".to_string(),
            source: ProfileSource::None,
            description: None,
            active: false,
            blocked_by_wgpu: false,
            error: None,
            generation: 0,
        },
        key: None,
        transforms: None,
    })
});
static GENERATION: AtomicU64 = AtomicU64::new(0);
static REFRESH_LOCK: Mutex<()> = Mutex::new(());
static TRANSFORM_ERROR_LOGGED: AtomicBool = AtomicBool::new(false);

pub fn is_supported() -> bool {
    cfg!(target_os = "linux")
}

pub fn current_info() -> DisplayProfileInfo {
    STATE.read().unwrap_or_else(|e| e.into_inner()).info.clone()
}

/// Resolve the profile for `settings` and rebuild the transforms if needed.
/// Does blocking I/O (X11, D-Bus, file reads): call only from a std thread or
/// `spawn_blocking`. Returns the new info and whether the applied conversion changed.
pub fn refresh(settings: &AppSettings) -> (DisplayProfileInfo, bool) {
    let _guard = REFRESH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mode = Mode::from_settings(settings);
    // The direct wgpu renderer bypasses the JPEG preview path, so converting only the
    // remaining (crop) previews would make the views inconsistent.
    let blocked_by_wgpu = settings.wgpu_renderer_enabled();
    let resolved = if is_supported() && !blocked_by_wgpu {
        resolve(&mode)
    } else {
        Resolved::default()
    };
    let (mut info, changed) = install(mode.name(), resolved);
    info.blocked_by_wgpu = blocked_by_wgpu;
    STATE
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .info
        .blocked_by_wgpu = blocked_by_wgpu;
    (info, changed)
}

#[derive(Default)]
struct Resolved {
    source: Option<ProfileSource>,
    description: Option<String>,
    error: Option<String>,
    key: Option<[u8; 32]>,
    transforms: Option<Transforms>,
}

fn resolve(mode: &Mode) -> Resolved {
    let (bytes, source) = match mode {
        Mode::Off => return Resolved::default(),
        Mode::Custom(None) => {
            return Resolved {
                error: Some("No profile file selected".to_string()),
                ..Default::default()
            };
        }
        Mode::Custom(Some(path)) => match std::fs::read(path) {
            Ok(bytes) => (bytes, ProfileSource::File),
            Err(e) => {
                return Resolved {
                    source: Some(ProfileSource::File),
                    error: Some(format!("Cannot read '{}': {}", path, e)),
                    ..Default::default()
                };
            }
        },
        Mode::Auto => match detect_system_profile() {
            Some(found) => found,
            None => return Resolved::default(),
        },
    };

    match build(&bytes) {
        Ok(built) => Resolved {
            source: Some(source),
            description: built.description,
            error: None,
            key: built.key,
            transforms: built.transforms,
        },
        Err(e) => Resolved {
            source: Some(source),
            error: Some(e),
            ..Default::default()
        },
    }
}

fn install(mode: &str, resolved: Resolved) -> (DisplayProfileInfo, bool) {
    let mut state = STATE.write().unwrap_or_else(|e| e.into_inner());
    let changed = state.key != resolved.key;
    if changed {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        TRANSFORM_ERROR_LOGGED.store(false, Ordering::Relaxed);
    }
    let active = resolved.transforms.is_some();
    state.key = resolved.key;
    state.transforms = resolved.transforms.map(Arc::new);
    state.info = DisplayProfileInfo {
        mode: mode.to_string(),
        source: resolved.source.unwrap_or(ProfileSource::None),
        description: resolved.description,
        active,
        blocked_by_wgpu: false,
        error: resolved.error,
        generation: GENERATION.load(Ordering::SeqCst),
    };
    (state.info.clone(), changed)
}

struct Built {
    description: Option<String>,
    key: Option<[u8; 32]>,
    /// None when the profile is effectively sRGB.
    transforms: Option<Transforms>,
}

fn build(bytes: &[u8]) -> Result<Built, String> {
    let profile =
        ColorProfile::new_from_slice(bytes).map_err(|e| format!("Invalid ICC profile: {}", e))?;
    if profile.color_space != DataColorSpace::Rgb {
        return Err("Profile is not an RGB profile".to_string());
    }
    if !matches!(
        profile.profile_class,
        ProfileClass::DisplayDevice | ProfileClass::ColorSpace
    ) {
        return Err("Profile is not a display or color space profile".to_string());
    }
    let description = profile_description(&profile);

    let (rgba, intent) = create_transform(&profile, Layout::Rgba)?;
    if is_identity(rgba.as_ref()) {
        return Ok(Built {
            description,
            key: None,
            transforms: None,
        });
    }
    let (rgba_to_rgb, _) = create_transform(&profile, Layout::Rgb)?;

    let mut hasher = blake3::Hasher::new();
    hasher.update(bytes);
    hasher.update(&[intent as u8]);
    Ok(Built {
        description,
        key: Some(*hasher.finalize().as_bytes()),
        transforms: Some(Transforms { rgba, rgba_to_rgb }),
    })
}

fn create_transform(
    dst: &ColorProfile,
    dst_layout: Layout,
) -> Result<(Executor, RenderingIntent), String> {
    let srgb = ColorProfile::new_srgb();
    let make = |intent| {
        srgb.create_transform_8bit(
            Layout::Rgba,
            dst,
            dst_layout,
            TransformOptions {
                rendering_intent: intent,
                ..Default::default()
            },
        )
    };
    match make(RenderingIntent::Perceptual) {
        Ok(t) => Ok((t as Executor, RenderingIntent::Perceptual)),
        Err(CmsError::UnsupportedLutRenderingIntent(_)) => {
            make(RenderingIntent::RelativeColorimetric)
                .map(|t| (t as Executor, RenderingIntent::RelativeColorimetric))
                .map_err(|e| format!("Cannot build color transform: {}", e))
        }
        Err(e) => Err(format!("Cannot build color transform: {}", e)),
    }
}

/// True when the sRGB → profile transform changes no channel by more than 1 on a 9³ grid.
fn is_identity(transform: &(dyn TransformExecutor<u8> + Send + Sync)) -> bool {
    const LEVELS: [u8; 9] = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    let mut src = Vec::with_capacity(LEVELS.len().pow(3) * 4);
    for r in LEVELS {
        for g in LEVELS {
            for b in LEVELS {
                src.extend_from_slice(&[r, g, b, 255]);
            }
        }
    }
    let mut dst = vec![0u8; src.len()];
    if transform.transform(&src, &mut dst).is_err() {
        return false;
    }
    src.iter()
        .zip(&dst)
        .all(|(a, b)| (*a as i16 - *b as i16).abs() <= 1)
}

fn profile_description(profile: &ColorProfile) -> Option<String> {
    let text = match profile.description.as_ref()? {
        ProfileText::PlainString(s) => s.clone(),
        ProfileText::Localizable(strings) => strings
            .iter()
            .find(|s| s.language.eq_ignore_ascii_case("en"))
            .or_else(|| strings.first())?
            .value
            .clone(),
        ProfileText::Description(d) => {
            if d.unicode_string
                .trim_matches(char::from(0))
                .trim()
                .is_empty()
            {
                d.ascii_string.clone()
            } else {
                d.unicode_string.clone()
            }
        }
    };
    let text = text.trim_matches(char::from(0)).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Convert sRGB RGBA8 pixels to the display profile. Returns None when no
/// conversion is active (callers then use the input unchanged).
pub fn convert_rgba8(src: &[u8]) -> Option<Vec<u8>> {
    let transforms = active_transforms()?;
    let mut dst = vec![0u8; src.len()];
    run(&transforms.rgba, src, &mut dst, 4).then_some(dst)
}

/// Convert sRGB RGBA8 pixels to display-profile RGB8 (alpha dropped).
pub fn convert_rgba8_to_rgb8(src: &[u8]) -> Option<Vec<u8>> {
    let transforms = active_transforms()?;
    let mut dst = vec![0u8; src.len() / 4 * 3];
    run(&transforms.rgba_to_rgb, src, &mut dst, 3).then_some(dst)
}

fn active_transforms() -> Option<Arc<Transforms>> {
    STATE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .transforms
        .clone()
}

fn run(transform: &Executor, src: &[u8], dst: &mut [u8], dst_channels: usize) -> bool {
    if !src.len().is_multiple_of(4) || dst.len() != src.len() / 4 * dst_channels {
        return false;
    }
    let result = src
        .par_chunks(PIXELS_PER_CHUNK * 4)
        .zip(dst.par_chunks_mut(PIXELS_PER_CHUNK * dst_channels))
        .try_for_each(|(s, d)| transform.transform(s, d));
    if let Err(e) = result {
        if !TRANSFORM_ERROR_LOGGED.swap(true, Ordering::Relaxed) {
            log::error!("Display profile transform failed: {}", e);
        }
        return false;
    }
    true
}

/// Background watcher: re-resolves the profile in `auto` mode so profile or
/// monitor changes are picked up, and emits `display-profile-changed`.
pub fn start_watcher(app_handle: tauri::AppHandle) {
    if !is_supported() {
        return;
    }
    std::thread::spawn(move || {
        let mut first = true;
        loop {
            let settings =
                crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
            // Initial resolve happens once at startup; afterwards only `auto` is polled
            // (custom/off change only through settings → `refresh_display_profile`).
            if first || Mode::from_settings(&settings) == Mode::Auto {
                first = false;
                let (info, changed) = refresh(&settings);
                if changed {
                    emit_changed(&app_handle, &info);
                }
            }
            std::thread::sleep(WATCH_INTERVAL);
        }
    });
}

fn emit_changed(app_handle: &tauri::AppHandle, info: &DisplayProfileInfo) {
    use tauri::Emitter;
    log::info!(
        "Display profile: mode={} source={:?} active={} desc={:?} error={:?}",
        info.mode,
        info.source,
        info.active,
        info.description,
        info.error
    );
    let _ = app_handle.emit(PROFILE_CHANGED_EVENT, info);
}

#[tauri::command]
pub async fn get_display_profile_info() -> Result<DisplayProfileInfo, String> {
    Ok(current_info())
}

/// Re-resolve the profile with the saved settings (call after changing them).
#[tauri::command]
pub async fn refresh_display_profile(
    app_handle: tauri::AppHandle,
) -> Result<DisplayProfileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
        let (info, changed) = refresh(&settings);
        if changed {
            emit_changed(&app_handle, &info);
        }
        info
    })
    .await
    .map_err(|e| format!("Display profile refresh failed: {}", e))
}

#[cfg(target_os = "linux")]
fn detect_system_profile() -> Option<(Vec<u8>, ProfileSource)> {
    if let Some(bytes) = read_x11_profile() {
        return Some((bytes, ProfileSource::X11));
    }
    read_colord_profile().map(|bytes| (bytes, ProfileSource::Colord))
}

#[cfg(not(target_os = "linux"))]
fn detect_system_profile() -> Option<(Vec<u8>, ProfileSource)> {
    None
}

/// Read the `_ICC_PROFILE` property of the default root window (set by
/// GNOME/colord and other desktops for the primary output).
#[cfg(target_os = "linux")]
fn read_x11_profile() -> Option<Vec<u8>> {
    use x11_dl::xlib;
    const MAX_PROFILE_BYTES: std::os::raw::c_long = 16 * 1024 * 1024;

    std::env::var_os("DISPLAY")?;
    let xlib = xlib::Xlib::open().ok()?;
    // SAFETY: plain Xlib calls on a display connection we open and close here;
    // the property buffer is copied and freed before returning.
    unsafe {
        let display = (xlib.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let atom = (xlib.XInternAtom)(display, c"_ICC_PROFILE".as_ptr(), xlib::True);
        let mut result = None;
        if atom != 0 {
            let root = (xlib.XDefaultRootWindow)(display);
            let mut actual_type = 0;
            let mut actual_format = 0;
            let mut nitems = 0;
            let mut bytes_after = 0;
            let mut prop: *mut u8 = std::ptr::null_mut();
            let status = (xlib.XGetWindowProperty)(
                display,
                root,
                atom,
                0,
                MAX_PROFILE_BYTES / 4,
                xlib::False,
                xlib::AnyPropertyType as std::os::raw::c_ulong,
                &mut actual_type,
                &mut actual_format,
                &mut nitems,
                &mut bytes_after,
                &mut prop,
            );
            if status == xlib::Success as i32 && !prop.is_null() {
                if actual_format == 8 && nitems > 0 {
                    result = Some(std::slice::from_raw_parts(prop, nitems as usize).to_vec());
                }
                (xlib.XFree)(prop.cast());
            }
        }
        (xlib.XCloseDisplay)(display);
        result
    }
}

/// Ask colord for the profile of the primary display (fallback, e.g. Wayland).
#[cfg(target_os = "linux")]
fn read_colord_profile() -> Option<Vec<u8>> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy, proxy::Builder};
    use zbus::proxy::CacheProperties;
    use zbus::zvariant::OwnedObjectPath;

    const SERVICE: &str = "org.freedesktop.ColorManager";
    let conn = Connection::system().ok()?;
    let proxy = |path: &str, interface: &'static str| -> Option<Proxy<'static>> {
        Builder::new(&conn)
            .destination(SERVICE)
            .ok()?
            .path(path.to_string())
            .ok()?
            .interface(interface)
            .ok()?
            .cache_properties(CacheProperties::No)
            .build()
            .ok()
    };

    let manager = proxy("/org/freedesktop/ColorManager", SERVICE)?;
    let devices: Vec<OwnedObjectPath> = manager.call("GetDevicesByKind", &("display",)).ok()?;

    let mut chosen: Option<OwnedObjectPath> = None;
    for device_path in devices {
        let Some(device) = proxy(device_path.as_str(), "org.freedesktop.ColorManager.Device")
        else {
            continue;
        };
        let profiles: Vec<OwnedObjectPath> = device.get_property("Profiles").unwrap_or_default();
        let Some(profile) = profiles.into_iter().next() else {
            continue;
        };
        let metadata: HashMap<String, String> = device.get_property("Metadata").unwrap_or_default();
        let is_primary = metadata
            .get("OutputPriority")
            .is_some_and(|v| v == "primary");
        if is_primary || chosen.is_none() {
            chosen = Some(profile);
        }
        if is_primary {
            break;
        }
    }

    let profile = proxy(chosen?.as_str(), "org.freedesktop.ColorManager.Profile")?;
    let filename: String = profile.get_property("Filename").ok()?;
    std::fs::read(filename).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saturation(rgb: &[u8]) -> f32 {
        let max = *rgb.iter().max().unwrap() as f32;
        let min = *rgb.iter().min().unwrap() as f32;
        if max == 0.0 { 0.0 } else { (max - min) / max }
    }

    fn convert_with(built: &Built, src: &[u8]) -> Vec<u8> {
        let t = built.transforms.as_ref().expect("transform expected");
        let mut dst = vec![0u8; src.len()];
        assert!(run(&t.rgba, src, &mut dst, 4));
        dst
    }

    #[test]
    fn srgb_profile_needs_no_transform() {
        let bytes = ColorProfile::new_srgb().encode().unwrap();
        let built = build(&bytes).unwrap();
        assert!(built.transforms.is_none());
        assert!(built.key.is_none());
    }

    #[test]
    fn wide_gamut_profile_lowers_saturation_and_keeps_neutrals() {
        let bytes = ColorProfile::new_adobe_rgb().encode().unwrap();
        let built = build(&bytes).unwrap();
        assert!(built.key.is_some());
        let src = [
            200, 40, 30, 255, 30, 180, 60, 128, 128, 128, 128, 7, 255, 255, 255, 0,
        ];
        let dst = convert_with(&built, &src);
        assert!(saturation(&dst[0..3]) < saturation(&src[0..3]));
        assert!(saturation(&dst[4..7]) < saturation(&src[4..7]));
        let grey = &dst[8..11];
        assert!(grey.iter().all(|&c| (c as i16 - grey[0] as i16).abs() <= 1));
        assert!(dst[12..15].iter().all(|&c| c >= 254));
        assert_eq!(
            [dst[3], dst[7], dst[11], dst[15]],
            [255, 128, 7, 0],
            "alpha preserved"
        );
    }

    #[test]
    fn rgb_output_matches_rgba_output() {
        let bytes = ColorProfile::new_display_p3().encode().unwrap();
        let built = build(&bytes).unwrap();
        let t = built.transforms.as_ref().unwrap();
        let src: Vec<u8> = (0..4096u32)
            .flat_map(|i| [(i * 7) as u8, (i * 13) as u8, (i * 29) as u8, 255])
            .collect();
        let mut rgba = vec![0u8; src.len()];
        let mut rgb = vec![0u8; src.len() / 4 * 3];
        assert!(run(&t.rgba, &src, &mut rgba, 4));
        assert!(run(&t.rgba_to_rgb, &src, &mut rgb, 3));
        for (a, b) in rgba.chunks(4).zip(rgb.chunks(3)) {
            assert_eq!(&a[..3], b);
        }
    }

    #[test]
    fn invalid_profile_is_rejected() {
        assert!(build(b"not an icc profile").is_err());
        assert!(build(&[]).is_err());
    }

    #[test]
    fn non_rgb_profile_is_rejected() {
        let bytes = ColorProfile::new_lab().encode();
        if let Ok(bytes) = bytes {
            assert!(build(&bytes).is_err());
        }
    }

    #[test]
    fn missing_custom_file_reports_error() {
        let r = resolve(&Mode::Custom(Some("/nonexistent/profile.icc".into())));
        assert!(r.transforms.is_none());
        assert!(r.error.is_some());
        let r = resolve(&Mode::Custom(None));
        assert!(r.error.is_some());
    }

    #[test]
    fn mode_defaults_to_auto() {
        let mut s = AppSettings {
            display_color_management: None,
            ..Default::default()
        };
        assert_eq!(Mode::from_settings(&s), Mode::Auto);
        s.display_color_management = Some("off".into());
        assert_eq!(Mode::from_settings(&s), Mode::Off);
        s.display_color_management = Some("custom".into());
        s.display_profile_path = Some("  ".into());
        assert_eq!(Mode::from_settings(&s), Mode::Custom(None));
    }

    #[test]
    fn settings_back_compat() {
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(Mode::from_settings(&s), Mode::Auto);
        let s: AppSettings = serde_json::from_str(
            r#"{"displayColorManagement":"custom","displayProfilePath":"/x/y.icc"}"#,
        )
        .unwrap();
        assert_eq!(
            Mode::from_settings(&s),
            Mode::Custom(Some("/x/y.icc".into()))
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["displayColorManagement"], "custom");
        assert_eq!(v["displayProfilePath"], "/x/y.icc");
        let s: AppSettings = serde_json::from_str(r#"{"displayColorManagement":"bogus"}"#).unwrap();
        assert_eq!(Mode::from_settings(&s), Mode::Auto);
    }

    #[test]
    fn mismatched_buffers_are_rejected() {
        let bytes = ColorProfile::new_adobe_rgb().encode().unwrap();
        let built = build(&bytes).unwrap();
        let t = built.transforms.as_ref().unwrap();
        let src = [10u8; 40];
        assert!(!run(&t.rgba, &src, &mut [0u8; 39], 4));
        assert!(!run(&t.rgba, &src, &mut [0u8; 41], 4));
        assert!(!run(&t.rgba_to_rgb, &src, &mut [0u8; 40], 3));
        assert!(!run(&t.rgba, &src[..39], &mut [0u8; 39], 4));
        // Larger than one parallel chunk, not a multiple of it.
        let src: Vec<u8> = (0..(PIXELS_PER_CHUNK + 7) * 4)
            .map(|i| (i * 31) as u8)
            .collect();
        assert!(run(&t.rgba, &src, &mut vec![0u8; src.len()], 4));
    }

    /// The only test touching the global state; keep all such checks here.
    #[test]
    fn generation_changes_only_with_the_applied_transform() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: Vec<u8>| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        };
        let adobe = write("adobe.icc", ColorProfile::new_adobe_rgb().encode().unwrap());
        let adobe_copy = write(
            "adobe-copy.icc",
            ColorProfile::new_adobe_rgb().encode().unwrap(),
        );
        let p3 = write("p3.icc", ColorProfile::new_display_p3().encode().unwrap());
        let srgb = write("srgb.icc", ColorProfile::new_srgb().encode().unwrap());
        let custom = |path: &str| AppSettings {
            display_color_management: Some("custom".into()),
            display_profile_path: Some(path.into()),
            ..Default::default()
        };
        let off = AppSettings {
            display_color_management: Some("off".into()),
            ..Default::default()
        };

        let g0 = refresh(&off).0.generation;
        let (info, changed) = refresh(&custom(&adobe));
        assert!(changed && info.active && info.generation == g0 + 1);
        assert_eq!(info.source, ProfileSource::File);
        assert!(!refresh(&custom(&adobe)).1, "same profile must not bump");
        assert!(
            !refresh(&custom(&adobe_copy)).1,
            "same bytes via other path must not bump"
        );
        assert!(refresh(&custom(&p3)).1);
        let (info, changed) = refresh(&custom(&srgb));
        assert!(changed && !info.active && info.error.is_none());
        assert!(convert_rgba8(&[1, 2, 3, 4]).is_none());

        refresh(&custom(&adobe));
        let (info, _) = refresh(&custom("/nonexistent/profile.icc"));
        assert!(info.error.is_some() && !info.active);
        let g = info.generation;
        for _ in 0..3 {
            let (info, changed) = refresh(&custom("/nonexistent/profile.icc"));
            assert!(
                !changed && info.generation == g,
                "repeated failures must not bump"
            );
        }

        // Concurrent conversions while the profile flips: every output must come
        // entirely from one of the two transforms.
        let src: Arc<Vec<u8>> = Arc::new((0..512 * 300 * 4).map(|i| (i * 7) as u8).collect());
        refresh(&custom(&adobe));
        let ref_a = Arc::new(convert_rgba8(&src).unwrap());
        refresh(&custom(&p3));
        let ref_b = Arc::new(convert_rgba8(&src).unwrap());
        assert_ne!(ref_a, ref_b);
        let stop = Arc::new(AtomicBool::new(false));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let (src, a, b, stop) = (src.clone(), ref_a.clone(), ref_b.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let out = convert_rgba8(&src).expect("a transform is active");
                        assert!(out == *a || out == *b, "mixed output");
                    }
                })
            })
            .collect();
        for i in 0..40 {
            refresh(&custom(if i % 2 == 0 { &adobe } else { &p3 }));
        }
        stop.store(true, Ordering::Relaxed);
        for w in workers {
            w.join().unwrap();
        }
        refresh(&off);
    }

    /// Machine-specific: every edid-*.icc in ~/.local/share/icc must build.
    #[test]
    #[ignore]
    fn local_edid_profiles_build() {
        let dir = std::path::Path::new(&std::env::var("HOME").unwrap()).join(".local/share/icc");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "icc") {
                let built = build(&std::fs::read(&path).unwrap())
                    .unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
                eprintln!(
                    "{} -> active={} desc={:?}",
                    path.display(),
                    built.transforms.is_some(),
                    built.description
                );
            }
        }
    }

    /// Machine-specific: needs a live X11 session with _ICC_PROFILE set.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn x11_detect_reads_root_profile() {
        let bytes = read_x11_profile().expect("no _ICC_PROFILE on root window");
        assert!(bytes.len() > 128 && &bytes[36..40] == b"acsp");
        eprintln!("x11 profile: {} bytes", bytes.len());
    }
}
