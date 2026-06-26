use tauri::{Runtime, Webview, plugin::Plugin};

pub struct PinchZoomDisablePlugin;

#[cfg(target_os = "macos")]
const MACOS_WINDOW_RADIUS: f64 = 14.0;

#[cfg(target_os = "macos")]
unsafe fn apply_macos_window_rounding(ns_view_ptr: *mut std::ffi::c_void) {
    use objc2::{msg_send, runtime::AnyObject};

    if ns_view_ptr.is_null() {
        return;
    }

    let ns_view = ns_view_ptr as *mut AnyObject;

    let ns_window: *mut AnyObject = msg_send![ns_view, window];
    if ns_window.is_null() {
        return;
    }

    let _: () = msg_send![ns_window, setOpaque: false];
    let _: () = msg_send![ns_window, setHasShadow: true];

    let content_view: *mut AnyObject = msg_send![ns_window, contentView];
    if !content_view.is_null() {
        let _: () = msg_send![content_view, setWantsLayer: true];
        let content_layer: *mut AnyObject = msg_send![content_view, layer];
        if !content_layer.is_null() {
            let _: () = msg_send![content_layer, setCornerRadius: MACOS_WINDOW_RADIUS];
            let _: () = msg_send![content_layer, setMasksToBounds: true];
        }
    }

    let _: () = msg_send![ns_view, setWantsLayer: true];
    let webview_layer: *mut AnyObject = msg_send![ns_view, layer];
    if !webview_layer.is_null() {
        let _: () = msg_send![webview_layer, setCornerRadius: MACOS_WINDOW_RADIUS];
        let _: () = msg_send![webview_layer, setMasksToBounds: true];
    }

    let _: () = msg_send![ns_window, invalidateShadow];
}

impl Default for PinchZoomDisablePlugin {
    fn default() -> Self {
        Self
    }
}

impl<R: Runtime> Plugin<R> for PinchZoomDisablePlugin {
    fn name(&self) -> &'static str {
        "Does not matter here"
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        let _ = webview.with_webview(|_webview| {
            #[cfg(target_os = "macos")]
            unsafe {
                apply_macos_window_rounding(_webview.inner().cast());
            }

            #[cfg(target_os = "linux")]
            unsafe {
                use gtk::GestureZoom;
                use gtk::glib::ObjectExt;
                use webkit2gtk::glib::gobject_ffi;

                if let Some(data) = _webview.inner().data::<GestureZoom>("wk-view-zoom-gesture") {
                    gobject_ffi::g_signal_handlers_destroy(data.as_ptr().cast());
                }
            }
        });
    }
}
