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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn gdk_backend_first_recognised_entry_wins() {
        assert_eq!(session_from(Some("x11"), true, true), Session::X11);
        assert_eq!(session_from(Some("wayland"), false, true), Session::Wayland);
        assert_eq!(
            session_from(Some("broadway, x11,wayland"), true, true),
            Session::X11
        );
        assert_eq!(session_from(Some("*"), true, true), Session::Wayland);
    }

    #[test]
    fn sockets_decide_without_gdk_backend() {
        assert_eq!(session_from(None, true, true), Session::Wayland);
        assert_eq!(session_from(None, false, true), Session::X11);
        assert_eq!(session_from(None, false, false), Session::Unknown);
    }

    #[test]
    fn only_effective_user_variables_count_as_override() {
        assert!(!user_override(None, None));
        assert!(!user_override(None, Some("0")));
        assert!(user_override(None, Some("1")));
        assert!(user_override(Some("1"), None));
        assert!(user_override(Some("0"), None));
    }

    #[test]
    fn user_override_beats_compat_mode_and_detection() {
        assert_eq!(
            decide(true, true, Session::X11, true),
            TransportDecision::UserOverride
        );
    }

    #[test]
    fn compat_mode_applies_in_every_session() {
        for session in [Session::Wayland, Session::X11, Session::Unknown] {
            for nvidia in [true, false] {
                assert_eq!(
                    decide(false, true, session, nvidia),
                    TransportDecision::CompatibilityMode
                );
            }
        }
    }

    #[test]
    fn only_x11_with_nvidia_is_changed_automatically() {
        assert_eq!(
            decide(false, false, Session::X11, true),
            TransportDecision::X11Nvidia
        );
        assert_eq!(
            decide(false, false, Session::X11, false),
            TransportDecision::Unchanged
        );
        assert_eq!(
            decide(false, false, Session::Wayland, true),
            TransportDecision::Unchanged
        );
        assert_eq!(
            decide(false, false, Session::Unknown, true),
            TransportDecision::Unchanged
        );
    }

    fn fake_drm(name: &str, cards: &[(&str, &str, Option<&str>)]) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("rapidraw-drm-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&root);
        for (card, vendor, driver) in cards {
            let device = root.join(card).join("device");
            std::fs::create_dir_all(&device).unwrap();
            std::fs::write(device.join("vendor"), format!("{vendor}\n")).unwrap();
            if let Some(driver) = driver {
                std::os::unix::fs::symlink(
                    format!("../../../bus/pci/drivers/{driver}"),
                    device.join("driver"),
                )
                .unwrap();
            }
        }
        root
    }

    #[test]
    fn detects_proprietary_nvidia_on_any_card() {
        let root = fake_drm(
            "hybrid",
            &[
                ("card0", "0x8086", Some("i915")),
                ("card1", NVIDIA_VENDOR, Some("nvidia")),
            ],
        );
        assert!(has_nvidia_gpu(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_nouveau_unbound_cards_and_connectors() {
        let root = fake_drm(
            "nouveau",
            &[
                ("card0", NVIDIA_VENDOR, Some("nouveau")),
                ("card1", NVIDIA_VENDOR, None),
                ("card0-DP-1", NVIDIA_VENDOR, Some("nvidia")),
            ],
        );
        assert!(!has_nvidia_gpu(&root));
        let _ = std::fs::remove_dir_all(root);
        assert!(!has_nvidia_gpu(Path::new("/nonexistent/drm")));
    }
}
