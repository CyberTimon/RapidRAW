# Desktop controls audit

Implemented September 12, 2026. Scope: existing RapidRAW desktop workflows and crop interaction. This is a Lightroom Classic-inspired profile, not a claim of full Lightroom feature parity.

## Result

- 135 actions share a typed registry, contextual keyboard dispatch, searchable settings, independent profile overrides, explicit disable, reset, and conflict reassignment. All 54 previous shortcut IDs remain available.
- G opens the gallery grid; D opens Adjustments; R enters or exits crop. Return accepts and opens Adjustments. Escape cancels the current pointer gesture first, then the crop session.
- Crop resizing works from all eight handles with free or locked ratios. Option/Alt resizes around the center; focused handles support arrows and Shift for larger steps.
- Crop movement can move the frame or move the photo under a stationary frame. Pointer rotation outside the frame is limited to ±45 degrees and rotates around the crop center. Shift uses whole-degree steps.
- Overlay selection includes thirds, diagonal, golden triangle, golden spiral, phi grid, armature, and none. O cycles overlays and Shift+O rotates them. Rotation can retain the selected overlay or show the dense grid.
- Crop geometry has a local draft history. Accept adds one global undo step; cancel restores geometry while preserving other edits. Draft geometry is removed from autosave and Auto Sync. Acceptance flushes the shared persistence baseline before navigation, and metadata writes are serialized.
- Keyboard handling respects text entry, native range arrows, composition, modal dialogs, local menu controls, and People review. Repeated destructive/toggle keys are suppressed.
- New shortcut hints on crop controls and editor context-menu actions use the effective profile. Tool-specific preset, mask, and tether actions run through their existing panel handlers.
- Existing settings deserialize without new fields. Shipped defaults remain RapidRAW, frame movement, and dense rotation grid. The requested personal settings were saved locally with a timestamped backup: Lightroom, photo movement, thirds, selected overlay during rotation. Relaunch applies those file-based preferences to an already running app.

## Audit findings addressed

| Finding                                                          | Change                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Scattered key handling and a hardcoded slider shortcut list      | Shared resolver and runtime dispatch; native slider handling retained                            |
| Unassigned could silently fall back to a default                 | Empty overrides explicitly disable; missing override inherits                                    |
| Gallery arrows conflicted with zoom and photo preview            | Context ordering and actual visible grid-row navigation                                          |
| Locked ratio required corners                                    | One geometry solver for edges, corners, centered resize, and keyboard handles                    |
| Crop edits were immediately committed                            | Session draft, local undo/redo, accept/cancel boundary                                           |
| Cache hydration could reset active edits                         | Cached baseline installed before ready state; background sync preserves newer edits and sessions |
| Immediate navigation could lose accepted crop or Auto Sync delta | Accepted state copied into cache and persistence flushed at the commit boundary                  |
| Invisible crop controls could still receive pointer input        | Crop viewport only mounted while crop is active                                                  |
| Older asynchronous save could finish after a newer save          | Metadata save queue preserves write order                                                        |

## Verification

49 automated controls tests pass and cover geometry, rotated boundaries, aspect preservation, session cancellation, local and global history, profiles, live rebinding, conflict precedence, keypad Return, repeat suppression, and grid navigation. Two Rust tests pass and cover old-settings migration and independent profile serialization. Production frontend and native debug app builds passed. Scoped lint has no new findings against the existing HEAD baseline; no repository-wide typecheck or lint was run.

Hands-on verification remains pending: the main development process could not be attached through the native UI tool, and the Mac became locked before the separately identified preview app could be exercised. The preview app uses an isolated settings directory and copies of the repository's photographic splash assets. No visual correctness, exported-pixel equivalence, Windows/Linux keyboard behavior, tethered camera, or AI-provider execution is claimed from automated tests.

Remaining acceptance walkthrough: open a real photo, G/D/R; resize every edge at 1:1 and 3:2; drag the photo; rotate outside each corner; Return/Escape and local/global undo; switch photos immediately; verify Auto Sync and sidecar reload; rebind, disable, reset, switch profiles, restart; type in search and numeric fields; verify light/dark contrast and pointer capture after leaving the window.

## Deliberate compatibility limits

Only existing product capabilities are exposed. Lightroom-specific modules, pick/reject metadata, comparison modes, and arbitrary numeric adjustment mappings are not fabricated. Parameter-dependent actions such as naming, mask-specific properties, export choices, and People identities remain in their existing contextual UI. Some commands start unassigned and can be bound in Settings → Keyboard shortcuts. Tethering and preset commands require their panel, and existing image/provider prerequisites still apply. OS-reserved combinations can be intercepted by macOS; shortcut recording rejects Command-Q/H/M. Cmd-M and Cmd-H in the Lightroom profile follow Adobe's merge conventions and may require reassignment on an OS that intercepts them.

Reference: [Adobe keyboard shortcuts](https://helpx.adobe.com/lightroom-classic/desktop/introduction-to-lightroom-classic/keyboard-shortcuts.html) and [Adobe crop and straighten](https://helpx.adobe.com/lightroom-classic/desktop/help/crop-rotate-straighten.html). The Escape session-cancel behavior and persistent thirds grid follow the requested preferences.

## Command inventory

Bindings below are macOS labels; Command becomes Ctrl on Windows/Linux. Tool contexts take precedence over general editor commands. Availability is further checked by the command's existing handler.

| Action                                             | Context          | RapidRAW      | Lightroom profile |
| -------------------------------------------------- | ---------------- | ------------- | ----------------- |
| Open selected image (`open_image`)                 | library          | Enter         | Enter             |
| Copy selected file(s) (`copy_files`)               | library          | ⌘ + Shift + C | ⌘ + C             |
| Paste file(s) to current folder (`paste_files`)    | library          | ⌘ + Shift + V | ⌘ + V             |
| Copy path of selected image(s) (`copy_image_path`) | editor + library | ⌘ + L         | ⌘ + L             |
| Select all images (`select_all`)                   | editor + library | ⌘ + A         | ⌘ + A             |
| Delete selected file(s) (`delete_selected`)        | editor + library | Delete / ⌘+⌫  | Delete / ⌘+⌫      |
| Previous image (`preview_prev`)                    | editor           | ←             | ←                 |
| Next image (`preview_next`)                        | editor           | →             | →                 |
| Zoom in (by step) (`zoom_in_step`)                 | editor           | ↑             | ↑                 |
| Zoom out (by step) (`zoom_out_step`)               | editor           | ↓             | ↓                 |
| Cycle zoom (Fit, 2x Fit, 100%) (`cycle_zoom`)      | editor           | Space         | Z                 |
| Zoom in (`zoom_in`)                                | editor           | ⌘ + +         | ⌘ + +             |
| Zoom out (`zoom_out`)                              | editor           | ⌘ + -         | ⌘ + -             |
| Zoom to fit (`zoom_fit`)                           | editor           | ⌘ + 0         | ⌘ + 0             |
| Zoom to 100% (`zoom_100`)                          | editor           | ⌘ + 1         | ⌘ + 1             |
| Toggle fullscreen (`toggle_fullscreen`)            | editor           | F             | F                 |
| Show original (before/after) (`show_original`)     | editor           | B             | \                 |
| Star rating: 0 (`rate_0`)                          | editor + library | 0             | 0                 |
| Star rating: 1 (`rate_1`)                          | editor + library | 1             | 1                 |
| Star rating: 2 (`rate_2`)                          | editor + library | 2             | 2                 |
| Star rating: 3 (`rate_3`)                          | editor + library | 3             | 3                 |
| Star rating: 4 (`rate_4`)                          | editor + library | 4             | 4                 |
| Star rating: 5 (`rate_5`)                          | editor + library | 5             | 5                 |
| Color label: None (`color_label_none`)             | editor + library | Shift + 0     | Unassigned        |
| Color label: Red (`color_label_red`)               | editor + library | Shift + 1     | 6                 |
| Color label: Yellow (`color_label_yellow`)         | editor + library | Shift + 2     | 7                 |
| Color label: Green (`color_label_green`)           | editor + library | Shift + 3     | 8                 |
| Color label: Blue (`color_label_blue`)             | editor + library | Shift + 4     | 9                 |
| Color label: Purple (`color_label_purple`)         | editor + library | Shift + 5     | Unassigned        |
| Toggle Adjustments panel (`toggle_adjustments`)    | editor + library | D             | Unassigned        |
| Toggle Crop panel (`toggle_crop_panel`)            | editor + library | R             | R                 |
| Toggle Masks panel (`toggle_masks`)                | editor           | M             | Shift + W         |
| Toggle AI panel (`toggle_ai`)                      | editor           | K             | Unassigned        |
| Toggle Presets panel (`toggle_presets`)            | editor + library | P             | Unassigned        |
| Toggle Metadata panel (`toggle_metadata`)          | editor + library | I             | Unassigned        |
| Toggle Folder Tree panel (`toggle_folder_tree`)    | editor + library | L             | Unassigned        |
| Toggle Analytics display (`toggle_analytics`)      | editor           | A             | Unassigned        |
| Toggle Export panel (`toggle_export`)              | editor + library | E             | ⌘ + Shift + E     |
| Toggle Left Panel (`toggle_left_panel`)            | global           | ⌘ + Shift + B | F7                |
| Toggle Right Panel (`toggle_right_panel`)          | global           | ⌘ + B         | F8                |
| Toggle Filmstrip (`toggle_bottom_panel`)           | editor           | ⌘ + J         | F6                |
| Toggle EXIF overlay (`toggle_library_exif`)        | library          | T             | I                 |
| Open settings (`open_settings`)                    | global           | ⌘ + ,         | ⌘ + ,             |
| Focus search field (`focus_search`)                | library          | ⌘ + F         | ⌘ + F             |
| Undo adjustment (`undo`)                           | editor           | ⌘ + Z         | ⌘ + Z             |
| Redo adjustment (`redo`)                           | editor           | ⌘ + Y         | ⌘ + Shift + Z     |
| Copy selected adjustments (`copy_adjustments`)     | editor + library | ⌘ + C         | ⌘ + Shift + C     |
| Paste copied adjustments (`paste_adjustments`)     | editor + library | ⌘ + V         | ⌘ + Shift + V     |
| Auto-sync adjustments (`sync_adjustments`)         | editor + library | ⌘ + Shift + S | ⌘ + Shift + S     |
| Rotate 90° counter-clockwise (`rotate_left`)       | editor + library | [             | ⌘ + [             |
| Rotate 90° clockwise (`rotate_right`)              | editor + library | ]             | ⌘ + ]             |
| Toggle Crop / Straighten (`toggle_crop`)           | editor           | S             | Unassigned        |
| Increase brush size (`brush_size_up`)              | mask             | ⌘ + ↑         | ]                 |
| Decrease brush size (`brush_size_down`)            | mask             | ⌘ + ↓         | [                 |
| Go to gallery (`gallery`)                          | global           | G             | G                 |
| Open Adjustments (`develop`)                       | global           | Unassigned    | D                 |
| Apply crop (`crop_accept`)                         | crop             | Enter         | Enter             |
| Cancel crop (`crop_cancel`)                        | crop             | Esc           | Esc               |
| Lock aspect ratio (`crop_lock`)                    | crop             | Unassigned    | A                 |
| Swap crop orientation (`crop_orientation`)         | crop             | Unassigned    | X                 |
| Cycle crop overlay (`crop_overlay`)                | crop             | O             | O                 |
| Rotate crop overlay (`crop_overlay_rotate`)        | crop             | Shift + O     | Shift + O         |
| Crop reset (`crop_reset`)                          | crop             | Unassigned    | ⌘ + ⌥ + R         |
| Crop flip h (`crop_flip_h`)                        | crop             | Unassigned    | Unassigned        |
| Crop flip v (`crop_flip_v`)                        | crop             | Unassigned    | Unassigned        |
| Switch crop dragging (`crop_drag_mode`)            | crop             | Unassigned    | Unassigned        |
| Move crop left (`crop_left`)                       | crop             | ←             | ←                 |
| Move crop right (`crop_right`)                     | crop             | →             | →                 |
| Move crop up (`crop_up`)                           | crop             | ↑             | ↑                 |
| Move crop down (`crop_down`)                       | crop             | ↓             | ↓                 |
| Library left (`library_left`)                      | library          | ←             | ←                 |
| Library right (`library_right`)                    | library          | →             | →                 |
| Library up (`library_up`)                          | library          | ↑             | ↑                 |
| Library down (`library_down`)                      | library          | ↓             | ↓                 |
| Library first (`library_first`)                    | library          | Home          | Home              |
| Library last (`library_last`)                      | library          | End           | End               |
| Extend prev (`extend_prev`)                        | library          | Shift + ←     | Shift + ←         |
| Extend next (`extend_next`)                        | library          | Shift + →     | Shift + →         |
| Deselect all (`deselect_all`)                      | library          | Unassigned    | ⌘ + D             |
| Select active (`select_active`)                    | library          | Unassigned    | ⌘ + Shift + D     |
| Toggle side panels (`toggle_side_panels`)          | global           | Unassigned    | Tab               |
| Toggle all panels (`toggle_all_panels`)            | global           | Unassigned    | Shift + Tab       |
| White balance picker (`white_balance`)             | editor           | Unassigned    | W                 |
| Auto adjustments (`auto_adjust`)                   | editor           | Unassigned    | ⌘ + U             |
| Auto lens correction (`auto_lens`)                 | editor + library | Unassigned    | Unassigned        |
| Reset adjustments (`reset_adjustments`)            | editor + library | Unassigned    | ⌘ + Shift + R     |
| Brush feather up (`brush_feather_up`)              | mask             | Unassigned    | Shift + ]         |
| Brush feather down (`brush_feather_down`)          | mask             | Unassigned    | Shift + [         |
| Delete selected mask (`mask_delete`)               | mask             | Delete / ⌘+⌫  | Delete / ⌘+⌫      |
| Open folder (`open_folder`)                        | global           | Unassigned    | Unassigned        |
| Import photos (`import_photos`)                    | library          | Unassigned    | ⌘ + Shift + I     |
| Rename photos (`rename_photos`)                    | library          | Unassigned    | F2                |
| Refresh library (`refresh_library`)                | library          | Unassigned    | Unassigned        |
| Open people (`open_people`)                        | library          | Unassigned    | O                 |
| Toggle tethering (`toggle_tethering`)              | editor           | Unassigned    | Unassigned        |
| Create folder (`create_folder`)                    | library          | Unassigned    | ⌘ + Shift + N     |
| Create album (`create_album`)                      | library          | Unassigned    | ⌘ + N             |
| Denoise (`open_denoise`)                           | editor + library | Unassigned    | Unassigned        |
| Convert negative (`open_negative`)                 | editor + library | Unassigned    | Unassigned        |
| Create collage (`open_collage`)                    | editor + library | Unassigned    | Unassigned        |
| Stitch panorama (`open_panorama`)                  | library          | Unassigned    | ⌘ + M             |
| Merge HDR (`open_hdr`)                             | library          | Unassigned    | ⌘ + H             |
| Focus stack (`open_focus_stack`)                   | library          | Unassigned    | Unassigned        |
| Customize shortcuts (`shortcut_help`)              | global           | Unassigned    | ⌘ + /             |
| Rating up (`rating_up`)                            | editor + library | Unassigned    | ]                 |
| Rating down (`rating_down`)                        | editor + library | Unassigned    | [                 |
| Go back (`go_back`)                                | global           | Esc           | Esc               |
| Clear rating and advance (`rate_advance_0`)        | editor + library | Unassigned    | Shift + 0         |
| Set 1 stars and advance (`rate_advance_1`)         | editor + library | Unassigned    | Shift + 1         |
| Set 2 stars and advance (`rate_advance_2`)         | editor + library | Unassigned    | Shift + 2         |
| Set 3 stars and advance (`rate_advance_3`)         | editor + library | Unassigned    | Shift + 3         |
| Set 4 stars and advance (`rate_advance_4`)         | editor + library | Unassigned    | Shift + 4         |
| Set 5 stars and advance (`rate_advance_5`)         | editor + library | Unassigned    | Shift + 5         |
| New preset (`preset_create`)                       | editor           | Unassigned    | Unassigned        |
| New preset folder (`preset_folder`)                | editor           | Unassigned    | Unassigned        |
| Import presets (`preset_import`)                   | editor           | Unassigned    | Unassigned        |
| Export presets (`preset_export`)                   | editor           | Unassigned    | Unassigned        |
| Sort presets (`preset_sort`)                       | editor           | Unassigned    | Unassigned        |
| New brush mask (`mask_brush`)                      | mask             | Unassigned    | Unassigned        |
| New linear gradient mask (`mask_linear`)           | mask             | Unassigned    | Unassigned        |
| New radial gradient mask (`mask_radial`)           | mask             | Unassigned    | Unassigned        |
| New subject mask (`mask_subject`)                  | mask             | Unassigned    | Unassigned        |
| New sky mask (`mask_sky`)                          | mask             | Unassigned    | Unassigned        |
| New luminance mask (`mask_luminance`)              | mask             | Unassigned    | Unassigned        |
| New color mask (`mask_color`)                      | mask             | Unassigned    | Unassigned        |
| Capture photo (`tether_capture`)                   | editor           | Unassigned    | Unassigned        |
| Camera autofocus (`tether_autofocus`)              | editor           | Unassigned    | Unassigned        |
| Detect cameras (`tether_detect`)                   | editor           | Unassigned    | Unassigned        |
| Toggle live view (`tether_liveview`)               | editor           | Unassigned    | Unassigned        |
| Toggle ghost image (`tether_ghost`)                | editor           | Unassigned    | Unassigned        |
| Finish external edit (`finish_external_edit`)      | editor           | Unassigned    | Unassigned        |
| List view (`library_list`)                         | library          | Unassigned    | Unassigned        |
| Cull selected photos (`open_culling`)              | library          | Unassigned    | Unassigned        |
| Create virtual copy (`create_virtual_copy`)        | library          | Unassigned    | Unassigned        |
| Reveal photo in file manager (`reveal_photo`)      | library          | Unassigned    | Unassigned        |
