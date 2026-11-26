const SERVICE: &str = "io.github.CyberTimon.RapidRAW.immich";
const ACCOUNT: &str = "api-key";

#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    target_os = "android"
))]
mod store {
    use std::sync::OnceLock;

    fn init() -> bool {
        static READY: OnceLock<bool> = OnceLock::new();
        *READY.get_or_init(|| {
            #[cfg(target_os = "linux")]
            let store = zbus_secret_service_keyring_store::Store::new();
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            #[cfg(target_os = "windows")]
            let store = windows_native_keyring_store::Store::new();
            #[cfg(target_os = "android")]
            let store = android_native_keyring_store::Store::new();
            match store {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(e) => {
                    log::info!(
                        "No credential store available, keeping the Immich key in a file: {e}"
                    );
                    false
                }
            }
        })
    }

    pub fn with_entry<T: Send + 'static>(
        f: impl FnOnce(&keyring_core::Entry) -> keyring_core::Result<T> + Send + 'static,
    ) -> Option<keyring_core::Result<T>> {
        std::thread::spawn(move || {
            if !init() {
                return None;
            }
            Some(keyring_core::Entry::new(super::SERVICE, super::ACCOUNT).and_then(|e| f(&e)))
        })
        .join()
        .ok()
        .flatten()
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    target_os = "android"
))]
pub fn save(api_key: &str) -> bool {
    let api_key = api_key.to_string();
    let result = store::with_entry(move |entry| {
        if api_key.is_empty() {
            match entry.delete_credential() {
                Err(keyring_core::Error::NoEntry) => Ok(()),
                other => other,
            }
        } else {
            entry.set_password(&api_key)
        }
    });
    match result {
        Some(Ok(())) => true,
        Some(Err(e)) => {
            log::warn!("Could not store the Immich key in the credential store: {e}");
            false
        }
        None => false,
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    target_os = "android"
))]
pub fn load() -> Option<String> {
    match store::with_entry(|entry| entry.get_password())? {
        Ok(key) => Some(key),
        Err(keyring_core::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("Could not read the Immich key from the credential store: {e}");
            None
        }
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    target_os = "android"
)))]
pub fn save(_api_key: &str) -> bool {
    false
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    target_os = "android"
)))]
pub fn load() -> Option<String> {
    None
}
