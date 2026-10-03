use tauri::menu::{AboutMetadataBuilder, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// Builds RapidRAW's native application menu (macOS menu bar / Linux global menu).
///
/// Item ids mirror the `action` ids used by the frontend's keybind system
/// (`src/utils/keyboardUtils.ts` / `src/hooks/useKeyboardShortcuts.ts`) wherever an action
/// already exists there, so a single `menu-action` event on the frontend can dispatch both.
/// Ids prefixed with `menu_` have no equivalent keybind and are handled only via this menu.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let version = app.package_info().version.to_string();
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("RapidRAW"))
        .version(Some(version))
        .website(Some("https://github.com/CyberTimon/RapidRAW"))
        .website_label(Some("GitHub"))
        .build();

    let app_menu = SubmenuBuilder::new(app, "RapidRAW")
        .about_with_text("About RapidRAW", Some(about_metadata))
        .separator()
        .item(&MenuItem::with_id(
            app,
            "open_settings",
            "Settings…",
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit_with_text("Quit RapidRAW")
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItem::with_id(
            app,
            "menu_open_folder",
            "Open Folder…",
            true,
            Some("CmdOrCtrl+O"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_import_images",
            "Import Images…",
            true,
            Some("CmdOrCtrl+Shift+I"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_tethering",
            "Camera Tethering",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "toggle_export",
            "Export…",
            true,
            Some("CmdOrCtrl+Shift+E"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "copy_image_path",
            "Copy Image Path",
            true,
            Some("CmdOrCtrl+L"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_show_in_finder",
            "Show in Finder",
            true,
            Some("CmdOrCtrl+Shift+R"),
        )?)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&MenuItem::with_id(
            app,
            "undo",
            "Undo",
            true,
            Some("CmdOrCtrl+Z"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "redo",
            "Redo",
            true,
            Some("CmdOrCtrl+Y"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "copy_adjustments",
            "Copy Edit Settings",
            true,
            Some("CmdOrCtrl+C"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "paste_adjustments",
            "Paste Edit Settings",
            true,
            Some("CmdOrCtrl+V"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_reset_adjustments",
            "Reset Adjustments",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "select_all",
            "Select All",
            true,
            Some("CmdOrCtrl+A"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "delete_selected",
            "Delete",
            true,
            None::<&str>,
        )?)
        .build()?;

    let image_menu = SubmenuBuilder::new(app, "Image")
        .item(&MenuItem::with_id(
            app,
            "rotate_left",
            "Rotate Left",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "rotate_right",
            "Rotate Right",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu_auto_adjust",
            "Auto Adjust",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_auto_lens_correction",
            "Auto Lens Correction",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu_denoise",
            "Denoise…",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_convert_negative",
            "Convert Negative…",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "toggle_crop_panel",
            "Crop & Straighten",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_masks",
            "Masks",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_ai",
            "AI Tools",
            true,
            None::<&str>,
        )?)
        .build()?;

    let stack_menu = SubmenuBuilder::new(app, "Stack")
        .item(&MenuItem::with_id(
            app,
            "menu_stitch_panorama",
            "Stitch Panorama…",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_merge_hdr",
            "Merge to HDR…",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_focus_stack",
            "Focus Stack…",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu_frame_collage",
            "Create Collage…",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu_cull_selected",
            "Cull Selected Photos…",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_presets",
            "Presets",
            true,
            None::<&str>,
        )?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItem::with_id(
            app,
            "zoom_in",
            "Zoom In",
            true,
            Some("CmdOrCtrl+="),
        )?)
        .item(&MenuItem::with_id(
            app,
            "zoom_out",
            "Zoom Out",
            true,
            Some("CmdOrCtrl+-"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "zoom_fit",
            "Zoom to Fit",
            true,
            Some("CmdOrCtrl+0"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "zoom_100",
            "Zoom 100%",
            true,
            Some("CmdOrCtrl+1"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "show_original",
            "Show Original",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_fullscreen",
            "Toggle Fullscreen",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "toggle_left_panel",
            "Toggle Sidebar",
            true,
            Some("CmdOrCtrl+Shift+B"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_right_panel",
            "Toggle Right Panel",
            true,
            Some("CmdOrCtrl+B"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_bottom_panel",
            "Toggle Filmstrip",
            true,
            Some("CmdOrCtrl+J"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "toggle_folder_tree",
            "Toggle Folder Tree",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "preview_prev",
            "Previous Photo",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "preview_next",
            "Next Photo",
            true,
            None::<&str>,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "focus_search",
            "Search Library",
            true,
            Some("CmdOrCtrl+F"),
        )?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItem::with_id(
            app,
            "menu_open_github",
            "RapidRAW on GitHub",
            true,
            None::<&str>,
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu_report_issue",
            "Report an Issue…",
            true,
            None::<&str>,
        )?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &image_menu,
            &stack_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}
