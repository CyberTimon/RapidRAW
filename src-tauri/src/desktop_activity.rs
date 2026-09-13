/// Keeps native, user-initiated work eligible to run while the app is not visible.
///
/// This deliberately does not prevent idle system sleep. Windows and Linux do not
/// require an equivalent assertion for native worker threads, so their guard is a
/// scoped no-op.
pub(crate) struct DesktopActivityGuard {
    release: Option<Box<dyn FnOnce() + Send>>,
}

impl DesktopActivityGuard {
    pub(crate) fn acquire_export() -> Result<Self, String> {
        platform::acquire_export()
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        acquire: impl FnOnce(),
        release: impl FnOnce() + Send + 'static,
    ) -> Self {
        acquire();
        Self {
            release: Some(Box::new(release)),
        }
    }
}

impl Drop for DesktopActivityGuard {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc::{class, msg_send, sel, sel_impl};

    use super::DesktopActivityGuard;

    // NSActivityUserInitiatedAllowingIdleSystemSleep. Unlike
    // NSActivityUserInitiated, this exempts the work from App Nap without
    // blocking normal idle system sleep.
    const USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP: u64 = 0x00efffff;

    pub(super) fn acquire_export() -> Result<DesktopActivityGuard, String> {
        unsafe {
            let process_info: *mut objc::runtime::Object =
                msg_send![class!(NSProcessInfo), processInfo];
            if process_info.is_null() {
                return Err("NSProcessInfo is unavailable".to_string());
            }

            let reason: *mut objc::runtime::Object = msg_send![class!(NSString), alloc];
            let reason: *mut objc::runtime::Object = msg_send![reason,
                initWithBytes: b"RapidRAW photo export".as_ptr()
                length: b"RapidRAW photo export".len()
                encoding: 4usize
            ];
            if reason.is_null() {
                return Err("Failed to create the export activity reason".to_string());
            }

            let activity: *mut objc::runtime::Object = msg_send![process_info,
                beginActivityWithOptions: USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP
                reason: reason
            ];
            let _: () = msg_send![reason, release];
            if activity.is_null() {
                return Err("Failed to begin the export activity".to_string());
            }

            let retained_activity: *mut objc::runtime::Object = msg_send![activity, retain];
            let process_info = process_info as usize;
            let retained_activity = retained_activity as usize;

            Ok(DesktopActivityGuard {
                release: Some(Box::new(move || unsafe {
                    let process_info = process_info as *mut objc::runtime::Object;
                    let activity = retained_activity as *mut objc::runtime::Object;
                    let _: () = msg_send![process_info, endActivity: activity];
                    let _: () = msg_send![activity, release];
                })),
            })
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::DesktopActivityGuard;

    pub(super) fn acquire_export() -> Result<DesktopActivityGuard, String> {
        Ok(DesktopActivityGuard {
            release: Some(Box::new(|| {})),
        })
    }
}
