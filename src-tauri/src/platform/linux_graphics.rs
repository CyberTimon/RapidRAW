use std::path::Path;

const FORCE_SHM: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";
const DISABLE_DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const NVIDIA_VENDOR: &str = "0x10de";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportDecision {
    UserOverride,
    CompatibilityMode,
    X11Nvidia,
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Session {
    Wayland,
    X11,
    Unknown,
}

fn session_from(gdk_backend: Option<&str>, wayland_socket: bool, x11_display: bool) -> Session {
    let preferred = gdk_backend.and_then(|list| {
        list.split(',')
            .map(str::trim)
            .find_map(|backend| match backend {
                "wayland" => Some(Session::Wayland),
                "x11" => Some(Session::X11),
                _ => None,
            })
    });
    preferred.unwrap_or(if wayland_socket {
        Session::Wayland
    } else if x11_display {
        Session::X11
    } else {
        Session::Unknown
    })
}

fn session() -> Session {
    let has_env = |name| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    session_from(
        std::env::var("GDK_BACKEND").ok().as_deref(),
        has_env("WAYLAND_DISPLAY") || has_env("WAYLAND_SOCKET"),
        has_env("DISPLAY"),
    )
}

pub fn is_wayland_session() -> bool {
    session() == Session::Wayland
}

fn user_override(force_shm: Option<&str>, disable_dmabuf: Option<&str>) -> bool {
    force_shm.is_some() || disable_dmabuf.is_some_and(|value| value != "0")
}

fn has_nvidia_gpu(drm_root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(drm_root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") || name.contains('-') {
            return false;
        }
        let device = entry.path().join("device");
        let vendor = std::fs::read_to_string(device.join("vendor")).unwrap_or_default();
        let driver = std::fs::read_link(device.join("driver")).ok();
        vendor.trim() == NVIDIA_VENDOR
            && driver
                .as_deref()
                .and_then(Path::file_name)
                .is_some_and(|driver| driver == "nvidia")
    })
}

fn decide(
    user_override: bool,
    compat_mode: bool,
    session: Session,
    nvidia: bool,
) -> TransportDecision {
    if user_override {
        TransportDecision::UserOverride
    } else if compat_mode {
        TransportDecision::CompatibilityMode
    } else if session == Session::X11 && nvidia {
        TransportDecision::X11Nvidia
    } else {
        TransportDecision::Unchanged
    }
}

pub fn configure_webkit_transport(compat_mode: bool) -> TransportDecision {
    let decision = decide(
        user_override(
            std::env::var(FORCE_SHM).ok().as_deref(),
            std::env::var(DISABLE_DMABUF).ok().as_deref(),
        ),
        compat_mode,
        session(),
        has_nvidia_gpu(Path::new("/sys/class/drm")),
    );
    if matches!(
        decision,
        TransportDecision::CompatibilityMode | TransportDecision::X11Nvidia
    ) {
        unsafe {
            std::env::set_var(FORCE_SHM, "1");
        }
    }
    decision
}

pub fn webkit_version() -> String {
    use webkit2gtk::ffi;
    unsafe {
        format!(
            "{}.{}.{}",
            ffi::webkit_get_major_version(),
            ffi::webkit_get_minor_version(),
            ffi::webkit_get_micro_version()
        )
    }
}
