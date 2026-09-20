use std::collections::HashMap;

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use tauri::{AppHandle, Emitter};
use wayland_backend::client::Backend as WaylandBackend;
use wayland_client::backend::ObjectId;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::wl_surface::WlSurface;
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, delegate_noop};
use wayland_protocols_plasma::appmenu::client::org_kde_kwin_appmenu::OrgKdeKwinAppmenu;
use wayland_protocols_plasma::appmenu::client::org_kde_kwin_appmenu_manager::OrgKdeKwinAppmenuManager;
use zbus::zvariant::{OwnedValue, StructureBuilder, Value};

#[derive(Clone)]
struct MenuEntry {
    properties: HashMap<String, OwnedValue>,
    children: Vec<i32>,
    action: Option<String>,
}

struct MenuBuilder {
    entries: HashMap<i32, MenuEntry>,
    next_id: i32,
}

fn owned(value: Value<'_>) -> OwnedValue {
    OwnedValue::try_from(value).expect("primitive values always convert to OwnedValue")
}

fn parse_accelerator(accel: &str) -> Vec<Vec<String>> {
    let parts: Vec<String> = accel
        .split('+')
        .map(|token| match token {
            "Ctrl" | "CmdOrCtrl" => "Control".to_string(),
            "Shift" => "Shift".to_string(),
            "Alt" => "Alt".to_string(),
            other => other.to_string(),
        })
        .collect();
    vec![parts]
}

impl MenuBuilder {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            next_id: 1,
        }
    }

    fn alloc(&mut self) -> i32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn item(&mut self, label: &str, action: &str, accelerator: Option<&str>) -> i32 {
        let id = self.alloc();
        let mut properties = HashMap::new();
        properties.insert("label".to_string(), owned(Value::from(label)));
        properties.insert("enabled".to_string(), owned(Value::from(true)));
        if let Some(accel) = accelerator {
            properties.insert(
                "shortcut".to_string(),
                owned(Value::from(parse_accelerator(accel))),
            );
        }
        self.entries.insert(
            id,
            MenuEntry {
                properties,
                children: Vec::new(),
                action: Some(action.to_string()),
            },
        );
        id
    }

    fn separator(&mut self) -> i32 {
        let id = self.alloc();
        let mut properties = HashMap::new();
        properties.insert("type".to_string(), owned(Value::from("separator")));
        self.entries.insert(
            id,
            MenuEntry {
                properties,
                children: Vec::new(),
                action: None,
            },
        );
        id
    }

    fn submenu(&mut self, label: &str, children: Vec<i32>) -> i32 {
        let id = self.alloc();
        let mut properties = HashMap::new();
        properties.insert("label".to_string(), owned(Value::from(label)));
        properties.insert(
            "children-display".to_string(),
            owned(Value::from("submenu")),
        );
        self.entries.insert(
            id,
            MenuEntry {
                properties,
                children,
                action: None,
            },
        );
        id
    }

    fn build(mut self, top_level: Vec<i32>) -> HashMap<i32, MenuEntry> {
        self.entries.insert(
            0,
            MenuEntry {
                properties: HashMap::new(),
                children: top_level,
                action: None,
            },
        );
        self.entries
    }
}

fn build_menu_entries() -> HashMap<i32, MenuEntry> {
    let mut b = MenuBuilder::new();

    let file_items = vec![
        b.item("Open Folder…", "menu_open_folder", Some("Ctrl+O")),
        b.item("Import Images…", "menu_import_images", Some("Ctrl+Shift+I")),
        b.item("Camera Tethering", "menu_tethering", None),
        b.separator(),
        b.item("Export…", "toggle_export", Some("Ctrl+Shift+E")),
        b.item("Copy Image Path", "copy_image_path", Some("Ctrl+L")),
        b.item(
            "Show in File Manager",
            "menu_show_in_finder",
            Some("Ctrl+Shift+R"),
        ),
        b.separator(),
        b.item("Settings…", "open_settings", Some("Ctrl+,")),
        b.separator(),
        b.item("Quit", "menu_quit", None),
    ];
    let file_menu = b.submenu("File", file_items);

    let edit_items = vec![
        b.item("Undo", "undo", Some("Ctrl+Z")),
        b.item("Redo", "redo", Some("Ctrl+Y")),
        b.separator(),
        b.item("Copy Edit Settings", "copy_adjustments", Some("Ctrl+C")),
        b.item("Paste Edit Settings", "paste_adjustments", Some("Ctrl+V")),
        b.item("Reset Adjustments", "menu_reset_adjustments", None),
        b.separator(),
        b.item("Select All", "select_all", Some("Ctrl+A")),
        b.item("Delete", "delete_selected", None),
    ];
    let edit_menu = b.submenu("Edit", edit_items);

    let image_items = vec![
        b.item("Rotate Left", "rotate_left", None),
        b.item("Rotate Right", "rotate_right", None),
        b.separator(),
        b.item("Auto Adjust", "menu_auto_adjust", None),
        b.item("Auto Lens Correction", "menu_auto_lens_correction", None),
        b.separator(),
        b.item("Denoise…", "menu_denoise", None),
        b.item("Convert Negative…", "menu_convert_negative", None),
        b.separator(),
        b.item("Crop & Straighten", "toggle_crop_panel", None),
        b.item("Masks", "toggle_masks", None),
        b.item("AI Tools", "toggle_ai", None),
    ];
    let image_menu = b.submenu("Image", image_items);

    let stack_items = vec![
        b.item("Stitch Panorama…", "menu_stitch_panorama", None),
        b.item("Merge to HDR…", "menu_merge_hdr", None),
        b.item("Focus Stack…", "menu_focus_stack", None),
        b.separator(),
        b.item("Create Collage…", "menu_frame_collage", None),
        b.separator(),
        b.item("Cull Selected Photos…", "menu_cull_selected", None),
        b.item("Presets", "toggle_presets", None),
    ];
    let stack_menu = b.submenu("Stack", stack_items);

    let view_items = vec![
        b.item("Zoom In", "zoom_in", Some("Ctrl+=")),
        b.item("Zoom Out", "zoom_out", Some("Ctrl+-")),
        b.item("Zoom to Fit", "zoom_fit", Some("Ctrl+0")),
        b.item("Zoom 100%", "zoom_100", Some("Ctrl+1")),
        b.separator(),
        b.item("Show Original", "show_original", None),
        b.item("Toggle Fullscreen", "toggle_fullscreen", None),
        b.separator(),
        b.item("Toggle Sidebar", "toggle_left_panel", Some("Ctrl+Shift+B")),
        b.item("Toggle Right Panel", "toggle_right_panel", Some("Ctrl+B")),
        b.item("Toggle Filmstrip", "toggle_bottom_panel", Some("Ctrl+J")),
        b.item("Toggle Folder Tree", "toggle_folder_tree", None),
        b.separator(),
        b.item("Previous Photo", "preview_prev", None),
        b.item("Next Photo", "preview_next", None),
        b.separator(),
        b.item("Search Library", "focus_search", Some("Ctrl+F")),
    ];
    let view_menu = b.submenu("View", view_items);

    let help_items = vec![
        b.item("RapidRAW on GitHub", "menu_open_github", None),
        b.item("Report an Issue…", "menu_report_issue", None),
    ];
    let help_menu = b.submenu("Help", help_items);

    b.build(vec![
        file_menu, edit_menu, image_menu, stack_menu, view_menu, help_menu,
    ])
}

struct DBusMenuServer {
    entries: HashMap<i32, MenuEntry>,
    app_handle: AppHandle,
}

type LayoutEntry = (i32, HashMap<String, OwnedValue>, Vec<OwnedValue>);

impl DBusMenuServer {
    fn layout_entry(&self, id: i32, recursion_depth: i32) -> LayoutEntry {
        let entry = self.entries.get(&id);
        let properties: HashMap<String, OwnedValue> =
            entry.map(|e| e.properties.clone()).unwrap_or_default();
        let children_ids: Vec<i32> = entry.map(|e| e.children.clone()).unwrap_or_default();

        let children: Vec<OwnedValue> = if recursion_depth == 0 {
            Vec::new()
        } else {
            let next_depth = if recursion_depth < 0 {
                -1
            } else {
                recursion_depth - 1
            };
            children_ids
                .into_iter()
                .map(|child_id| {
                    let (cid, cprops, cchildren) = self.layout_entry(child_id, next_depth);
                    let structure = StructureBuilder::new()
                        .add_field(cid)
                        .append_field(Value::from(cprops))
                        .append_field(Value::from(cchildren))
                        .build()
                        .expect("statically-shaped (i,a{sv},av) structure always builds");
                    owned(Value::Structure(structure))
                })
                .collect()
        };

        (id, properties, children)
    }
}

#[zbus::interface(name = "com.canonical.dbusmenu")]
impl DBusMenuServer {
    #[zbus(name = "GetLayout")]
    async fn get_layout(
        &self,
        parent_id: i32,
        recursion_depth: i32,
        _property_names: Vec<String>,
    ) -> zbus::fdo::Result<(u32, LayoutEntry)> {
        Ok((1, self.layout_entry(parent_id, recursion_depth)))
    }

    #[zbus(name = "GetGroupProperties")]
    async fn get_group_properties(
        &self,
        ids: Vec<i32>,
        _property_names: Vec<String>,
    ) -> zbus::fdo::Result<Vec<(i32, HashMap<String, OwnedValue>)>> {
        Ok(ids
            .into_iter()
            .filter_map(|id| self.entries.get(&id).map(|e| (id, e.properties.clone())))
            .collect())
    }

    #[zbus(name = "GetProperty")]
    async fn get_property(&self, id: i32, name: String) -> zbus::fdo::Result<OwnedValue> {
        self.entries
            .get(&id)
            .and_then(|e| e.properties.get(&name))
            .cloned()
            .ok_or_else(|| {
                zbus::fdo::Error::Failed(format!("unknown property {name} on item {id}"))
            })
    }

    #[zbus(name = "Event")]
    async fn event(&self, id: i32, event_id: String, _data: OwnedValue, _timestamp: u32) {
        if event_id != "clicked" {
            return;
        }
        let Some(entry) = self.entries.get(&id) else {
            return;
        };
        let Some(action) = &entry.action else { return };

        if action == "menu_quit" {
            self.app_handle.exit(0);
            return;
        }

        let _ = self.app_handle.emit("menu-action", action.clone());
    }

    #[zbus(name = "AboutToShow")]
    async fn about_to_show(&self, _id: i32) -> bool {
        false
    }

    #[zbus(property, name = "Version")]
    fn version(&self) -> u32 {
        3
    }

    #[zbus(property, name = "TextDirection")]
    fn text_direction(&self) -> String {
        "ltr".to_string()
    }

    #[zbus(property, name = "Status")]
    fn status(&self) -> String {
        "normal".to_string()
    }

    #[zbus(property, name = "IconThemePath")]
    fn icon_theme_path(&self) -> Vec<String> {
        Vec::new()
    }
}

struct AppMenuState;

delegate_noop!(AppMenuState: ignore wayland_client::protocol::wl_surface::WlSurface);
delegate_noop!(AppMenuState: ignore OrgKdeKwinAppmenuManager);
delegate_noop!(AppMenuState: ignore OrgKdeKwinAppmenu);

impl Dispatch<wayland_client::protocol::wl_registry::WlRegistry, GlobalListContents>
    for AppMenuState
{
    fn event(
        _state: &mut Self,
        _proxy: &wayland_client::protocol::wl_registry::WlRegistry,
        _event: wayland_client::protocol::wl_registry::Event,
        _data: &GlobalListContents,
        _conn: &Connection,
        _qhandle: &QueueHandle<Self>,
    ) {
    }
}

pub async fn install(app_handle: AppHandle, window: tauri::Window) {
    let raw_display = match window.display_handle() {
        Ok(h) => h.as_raw(),
        Err(e) => {
            log::warn!("KDE global menu: could not get display handle: {e}");
            return;
        }
    };
    let raw_window = match window.window_handle() {
        Ok(h) => h.as_raw(),
        Err(e) => {
            log::warn!("KDE global menu: could not get window handle: {e}");
            return;
        }
    };

    let (display_addr, surface_addr) = match (raw_display, raw_window) {
        (RawDisplayHandle::Wayland(d), RawWindowHandle::Wayland(w)) => {
            (d.display.as_ptr() as usize, w.surface.as_ptr() as usize)
        }
        _ => {
            log::info!("KDE global menu: not a Wayland session, skipping.");
            return;
        }
    };

    let entries = build_menu_entries();
    let server = DBusMenuServer {
        entries,
        app_handle: app_handle.clone(),
    };

    let dbus_conn = match zbus::connection::Builder::session() {
        Ok(builder) => builder,
        Err(e) => {
            log::warn!("KDE global menu: failed to prepare D-Bus session connection: {e}");
            return;
        }
    };
    let dbus_conn = match dbus_conn.serve_at("/MenuBar", server) {
        Ok(builder) => builder,
        Err(e) => {
            log::warn!("KDE global menu: failed to register DBusMenu object: {e}");
            return;
        }
    };
    let dbus_conn = match dbus_conn.build().await {
        Ok(conn) => conn,
        Err(e) => {
            log::warn!("KDE global menu: failed to connect to D-Bus session bus: {e}");
            return;
        }
    };
    let service_name = dbus_conn.unique_name().map(|n| n.to_string());
    let Some(service_name) = service_name else {
        log::warn!("KDE global menu: D-Bus connection has no unique name.");
        return;
    };

    let service_name_for_wayland = service_name.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let service_name = service_name_for_wayland;

        let display_ptr = display_addr as *mut std::ffi::c_void;
        let surface_ptr = surface_addr as *mut std::ffi::c_void;
        let backend = unsafe { WaylandBackend::from_foreign_display(display_ptr.cast()) };
        let conn = Connection::from_backend(backend);

        let (globals, mut queue) = registry_queue_init::<AppMenuState>(&conn)
            .map_err(|e| format!("registry init failed: {e}"))?;
        let qh = queue.handle();

        let manager: OrgKdeKwinAppmenuManager = globals
            .bind(&qh, 1..=2, ())
            .map_err(|e| format!("org_kde_kwin_appmenu_manager not available: {e}"))?;

        let surface_interface = WlSurface::interface();
        let surface_id = unsafe { ObjectId::from_ptr(surface_interface, surface_ptr.cast()) }
            .map_err(|e| format!("failed to wrap wl_surface: {e}"))?;
        let surface = WlSurface::from_id(&conn, surface_id)
            .map_err(|e| format!("failed to wrap wl_surface: {e}"))?;

        let appmenu: OrgKdeKwinAppmenu = manager.create(&surface, &qh, ());
        appmenu.set_address(service_name.clone(), "/MenuBar".to_string());

        queue
            .roundtrip(&mut AppMenuState)
            .map_err(|e| format!("wayland roundtrip failed: {e}"))?;

        std::mem::forget(manager);
        std::mem::forget(appmenu);
        std::mem::forget(conn);

        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => {
            log::info!("KDE global menu registered on D-Bus service {service_name} at /MenuBar.");
            
            std::mem::forget(dbus_conn);
        }
        Ok(Err(e)) => log::warn!("KDE global menu: {e}"),
        Err(e) => log::warn!("KDE global menu: setup task panicked: {e}"),
    }
}
