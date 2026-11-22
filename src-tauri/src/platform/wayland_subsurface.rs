use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use gtk::glib::ControlFlow;
use gtk::prelude::*;
use tauri::Manager;
use wayland_backend::client::{Backend, ObjectId};
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{
    wl_compositor::WlCompositor, wl_region::WlRegion, wl_registry::WlRegistry,
    wl_subcompositor::WlSubcompositor, wl_subsurface::WlSubsurface, wl_surface::WlSurface,
};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, delegate_noop};
use wayland_protocols::wp::color_management::v1::client::{
    wp_color_management_surface_feedback_v1::{self, WpColorManagementSurfaceFeedbackV1},
    wp_color_manager_v1::WpColorManagerV1,
    wp_image_description_info_v1::{self, WpImageDescriptionInfoV1},
    wp_image_description_v1::{self, WpImageDescriptionV1},
};
use wayland_protocols::wp::viewporter::client::{
    wp_viewport::WpViewport, wp_viewporter::WpViewporter,
};
use wgpu::rwh::{
    HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle,
    WaylandWindowHandle,
};

static COMPOSITOR_MANAGES_COLOR: AtomicBool = AtomicBool::new(false);
static PREFERRED: LazyLock<Mutex<HashMap<String, Preferred>>> = LazyLock::new(Default::default);
const COLOR_FEEDBACK_INTERVAL: Duration = Duration::from_millis(250);

pub fn compositor_manages_color() -> bool {
    COMPOSITOR_MANAGES_COLOR.load(Ordering::Acquire)
}

pub fn hdr_headroom(label: &str) -> Option<f32> {
    PREFERRED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(label)?
        .headroom()
}

#[derive(Default)]
struct Luminances {
    reference: Option<u32>,
    max: Option<u32>,
    target_max: Option<u32>,
}

impl Luminances {
    fn headroom(&self) -> Option<f32> {
        let reference = self.reference.filter(|&nits| nits > 0)?;
        let peak = self.target_max.or(self.max)?;
        Some(peak as f32 / reference as f32)
    }
}

#[derive(Default)]
struct PreferredDescription {
    pending: Mutex<Luminances>,
    headroom: Mutex<Option<f32>>,
    changed: AtomicBool,
}

impl PreferredDescription {
    fn headroom(&self) -> Option<f32> {
        *self.headroom.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_headroom(&self, headroom: Option<f32>) {
        let mut current = self.headroom.lock().unwrap_or_else(|e| e.into_inner());
        if *current != headroom {
            *current = headroom;
            self.changed.store(true, Ordering::Release);
        }
    }

    fn take_changed(&self) -> bool {
        self.changed.swap(false, Ordering::AcqRel)
    }
}

type Preferred = Arc<PreferredDescription>;

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
delegate_noop!(State: ignore WpColorManagerV1);

impl Dispatch<WpColorManagementSurfaceFeedbackV1, Preferred> for State {
    fn event(
        _: &mut Self,
        feedback: &WpColorManagementSurfaceFeedbackV1,
        event: wp_color_management_surface_feedback_v1::Event,
        preferred: &Preferred,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wp_color_management_surface_feedback_v1::Event::PreferredChanged { .. }
            | wp_color_management_surface_feedback_v1::Event::PreferredChanged2 { .. } => {
                feedback.get_preferred(qh, Arc::clone(preferred));
            }
            _ => {}
        }
    }
}

impl Dispatch<WpImageDescriptionV1, Preferred> for State {
    fn event(
        _: &mut Self,
        description: &WpImageDescriptionV1,
        event: wp_image_description_v1::Event,
        preferred: &Preferred,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wp_image_description_v1::Event::Ready { .. }
            | wp_image_description_v1::Event::Ready2 { .. } => {
                description.get_information(qh, Arc::clone(preferred));
                description.destroy();
            }
            wp_image_description_v1::Event::Failed { .. } => {
                preferred.set_headroom(None);
                description.destroy();
            }
            _ => {}
        }
    }
}

impl Dispatch<WpImageDescriptionInfoV1, Preferred> for State {
    fn event(
        _: &mut Self,
        _: &WpImageDescriptionInfoV1,
        event: wp_image_description_info_v1::Event,
        preferred: &Preferred,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let mut pending = preferred.pending.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            wp_image_description_info_v1::Event::Luminances {
                max_lum,
                reference_lum,
                ..
            } => {
                pending.max = Some(max_lum);
                pending.reference = Some(reference_lum);
            }
            wp_image_description_info_v1::Event::TargetLuminance { max_lum, .. } => {
                pending.target_max = Some(max_lum);
            }
            wp_image_description_info_v1::Event::Done => {
                let luminances = std::mem::take(&mut *pending);
                preferred.set_headroom(luminances.headroom());
            }
            _ => {}
        }
    }
}

struct Inner {
    label: String,
    conn: Connection,
    queue: Mutex<EventQueue<State>>,
    surface: WlSurface,
    subsurface: WlSubsurface,
    viewport: WpViewport,
    color: Option<(WpColorManagementSurfaceFeedbackV1, Preferred)>,
    geometry: Mutex<Option<(i32, i32, i32, i32)>>,
}

impl Inner {
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
        toplevel.queue_draw();
    }

    fn dispatch_color_feedback(&self) -> bool {
        let Some((_, preferred)) = &self.color else {
            return false;
        };
        if let Ok(mut queue) = self.queue.lock() {
            let _ = queue.dispatch_pending(&mut State);
        }
        let _ = self.conn.flush();
        preferred.take_changed()
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some((feedback, preferred)) = &self.color {
            feedback.destroy();
            let mut registered = PREFERRED.lock().unwrap_or_else(|e| e.into_inner());
            if registered
                .get(&self.label)
                .is_some_and(|current| Arc::ptr_eq(current, preferred))
            {
                registered.remove(&self.label);
            }
        }
        self.viewport.destroy();
        self.subsurface.destroy();
        self.surface.destroy();
        let _ = self.conn.flush();
    }
}

pub struct WaylandSubsurface {
    inner: Arc<Inner>,
}

impl WaylandSubsurface {
    pub fn create_surface(
        &self,
        instance: &wgpu::Instance,
    ) -> Result<wgpu::Surface<'static>, String> {
        let display = NonNull::new(self.inner.conn.backend().display_ptr() as *mut c_void)
            .ok_or("Wayland connection has no wl_display")?;
        let surface = NonNull::new(self.inner.surface.id().as_ptr() as *mut c_void)
            .ok_or("Subsurface has no wl_surface")?;
        unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                    display,
                ))),
                raw_window_handle: RawWindowHandle::Wayland(WaylandWindowHandle::new(surface)),
            })
        }
        .map_err(|e| e.to_string())
    }
}

pub fn create(window: &tauri::WebviewWindow) -> Result<WaylandSubsurface, String> {
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
    COMPOSITOR_MANAGES_COLOR.store(
        globals.contents().with_list(|list| {
            list.iter()
                .any(|global| global.interface == "wp_color_manager_v1")
        }),
        Ordering::Release,
    );
    let compositor: WlCompositor = globals.bind(&qh, 1..=4, ()).map_err(|e| e.to_string())?;
    let subcompositor: WlSubcompositor = globals.bind(&qh, 1..=1, ()).map_err(|e| e.to_string())?;
    let viewporter: WpViewporter = globals
        .bind(&qh, 1..=1, ())
        .map_err(|_| "Compositor lacks wp_viewporter".to_string())?;

    let surface = compositor.create_surface(&qh, ());
    let subsurface = subcompositor.get_subsurface(&surface, &parent, &qh, ());
    subsurface.place_below(&parent);
    subsurface.set_desync();

    let region = compositor.create_region(&qh, ());
    surface.set_input_region(Some(&region));
    region.destroy();

    let viewport = viewporter.get_viewport(&surface, &qh, ());
    let color = globals
        .bind::<WpColorManagerV1, _, _>(&qh, 1..=2, ())
        .ok()
        .map(|manager| {
            let preferred = Preferred::default();
            let feedback = manager.get_surface_feedback(&surface, &qh, Arc::clone(&preferred));
            feedback.get_preferred(&qh, Arc::clone(&preferred));
            manager.destroy();
            (feedback, preferred)
        });
    queue.roundtrip(&mut State).map_err(|e| e.to_string())?;
    if color.is_some() {
        queue.roundtrip(&mut State).map_err(|e| e.to_string())?;
    }

    let inner = Arc::new(Inner {
        label: window.label().to_string(),
        conn,
        queue: Mutex::new(queue),
        surface,
        subsurface,
        viewport,
        color,
        geometry: Mutex::new(None),
    });
    if let Some((_, preferred)) = &inner.color {
        preferred.take_changed();
        PREFERRED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(inner.label.clone(), Arc::clone(preferred));
        let weak = Arc::downgrade(&inner);
        let app_handle = window.app_handle().clone();
        gtk::glib::timeout_add_local(COLOR_FEEDBACK_INTERVAL, move || {
            let Some(inner) = weak.upgrade() else {
                return ControlFlow::Break;
            };
            if inner.dispatch_color_feedback() {
                crate::render::gpu::display::request_display_refresh(&app_handle);
            }
            ControlFlow::Continue
        });
    }
    inner.sync_geometry(&content, &toplevel);

    let weak: Weak<Inner> = Arc::downgrade(&inner);
    let signal_toplevel = toplevel.clone();
    content.connect_size_allocate(move |content, _| {
        if let Some(inner) = weak.upgrade() {
            inner.sync_geometry(content, &signal_toplevel);
        }
    });

    log::info!("Created Wayland subsurface for WGPU display");
    Ok(WaylandSubsurface { inner })
}
