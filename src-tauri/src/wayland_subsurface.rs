// On Wayland, GTK draws the transparent webview into the toplevel wl_surface. If wgpu
// presents to that same surface, every GTK commit overwrites the image. Instead wgpu
// renders into its own wl_subsurface stacked below the toplevel, so the image shows
// through the transparent parts of the webview.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex, Weak};

use gtk::prelude::*;
use wayland_backend::client::{Backend, ObjectId};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{
    wl_compositor::WlCompositor, wl_region::WlRegion, wl_registry::WlRegistry,
    wl_subcompositor::WlSubcompositor, wl_subsurface::WlSubsurface, wl_surface::WlSurface,
};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, delegate_noop};
use wayland_protocols::wp::viewporter::client::{
    wp_viewport::WpViewport, wp_viewporter::WpViewporter,
};
use wgpu::rwh::{
    HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle,
    WaylandWindowHandle,
};

struct State;

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

delegate_noop!(State: WlCompositor);
delegate_noop!(State: WlSubcompositor);
delegate_noop!(State: WlSubsurface);
delegate_noop!(State: WlRegion);
delegate_noop!(State: WpViewporter);
delegate_noop!(State: WpViewport);
delegate_noop!(State: ignore WlSurface);

struct Inner {
    conn: Connection,
    queue: Mutex<EventQueue<State>>,
    surface: WlSurface,
    subsurface: WlSubsurface,
    viewport: WpViewport,
    geometry: Mutex<Option<(i32, i32, i32, i32)>>,
}

impl Inner {
    // Places the subsurface exactly under the webview container. With client-side
    // decorations GTK draws the title bar and shadow inside the toplevel surface, so the
    // container is offset from the surface origin. The viewport keeps the on-screen size
    // in logical pixels while wgpu renders at the physical size.
    fn sync_geometry(&self, content: &gtk::Box, toplevel: &gtk::ApplicationWindow) {
        let (x, y) = content
            .translate_coordinates(toplevel, 0, 0)
            .unwrap_or((0, 0));
        let allocation = content.allocation();
        let geometry = (x, y, allocation.width().max(1), allocation.height().max(1));
        if let Ok(mut last) = self.geometry.lock() {
            if *last == Some(geometry) {
                return;
            }
            *last = Some(geometry);
        }
        self.subsurface.set_position(x, y);
        self.viewport.set_destination(geometry.2, geometry.3);
        self.surface.commit();
        if let Ok(mut queue) = self.queue.lock() {
            let _ = queue.dispatch_pending(&mut State);
        }
        let _ = self.conn.flush();
        // The position is applied on the parent's next commit.
        toplevel.queue_draw();
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.viewport.destroy();
        self.subsurface.destroy();
        self.surface.destroy();
        let _ = self.conn.flush();
    }
}

pub struct WaylandSubsurface {
    _inner: Arc<Inner>,
}

/// Must run on the GTK main thread. Fails when the window is not on Wayland.
pub fn create(
    instance: &wgpu::Instance,
    window: &tauri::WebviewWindow,
) -> Result<(wgpu::Surface<'static>, WaylandSubsurface), String> {
    let RawDisplayHandle::Wayland(display) =
        window.display_handle().map_err(|e| e.to_string())?.as_raw()
    else {
        return Err("WGPU display requires a Wayland session".to_string());
    };
    let RawWindowHandle::Wayland(parent) =
        window.window_handle().map_err(|e| e.to_string())?.as_raw()
    else {
        return Err("WGPU display requires a Wayland session".to_string());
    };
    let toplevel = window.gtk_window().map_err(|e| e.to_string())?;
    let content = window.default_vbox().map_err(|e| e.to_string())?;

    let conn = Connection::from_backend(unsafe {
        Backend::from_foreign_display(display.display.as_ptr() as *mut _)
    });
    let parent_id =
        unsafe { ObjectId::from_ptr(WlSurface::interface(), parent.surface.as_ptr() as *mut _) }
            .map_err(|e| e.to_string())?;
    let parent = WlSurface::from_id(&conn, parent_id).map_err(|e| e.to_string())?;

    let (globals, mut queue) = registry_queue_init::<State>(&conn).map_err(|e| e.to_string())?;
    let qh = queue.handle();
    let compositor: WlCompositor = globals.bind(&qh, 1..=4, ()).map_err(|e| e.to_string())?;
    let subcompositor: WlSubcompositor = globals.bind(&qh, 1..=1, ()).map_err(|e| e.to_string())?;
    // Without a viewport the buffer size would have to be a multiple of the scale, and
    // getting that wrong is a protocol error that takes down GTK's connection too.
    let viewporter: WpViewporter = globals
        .bind(&qh, 1..=1, ())
        .map_err(|_| "Compositor lacks wp_viewporter".to_string())?;

    let surface = compositor.create_surface(&qh, ());
    let subsurface = subcompositor.get_subsurface(&surface, &parent, &qh, ());
    subsurface.place_below(&parent);
    subsurface.set_desync();

    // Let all input fall through to the webview above.
    let region = compositor.create_region(&qh, ());
    surface.set_input_region(Some(&region));
    region.destroy();

    let viewport = viewporter.get_viewport(&surface, &qh, ());
    queue.roundtrip(&mut State).map_err(|e| e.to_string())?;

    let wgpu_surface = unsafe {
        instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                display.display,
            ))),
            raw_window_handle: RawWindowHandle::Wayland(WaylandWindowHandle::new(
                NonNull::new(surface.id().as_ptr() as *mut c_void)
                    .ok_or("Subsurface has no wl_surface")?,
            )),
        })
    }
    .map_err(|e| e.to_string())?;

    let inner = Arc::new(Inner {
        conn,
        queue: Mutex::new(queue),
        surface,
        subsurface,
        viewport,
        geometry: Mutex::new(None),
    });
    inner.sync_geometry(&content, &toplevel);

    // Follows resizes, maximize/fullscreen and decoration changes. Holds only a weak
    // reference so the handler goes inert once the display is dropped.
    let weak: Weak<Inner> = Arc::downgrade(&inner);
    let signal_toplevel = toplevel.clone();
    content.connect_size_allocate(move |content, _| {
        if let Some(inner) = weak.upgrade() {
            inner.sync_geometry(content, &signal_toplevel);
        }
    });

    log::info!("Created Wayland subsurface for WGPU display");
    Ok((wgpu_surface, WaylandSubsurface { _inner: inner }))
}
