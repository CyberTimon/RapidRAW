# Tauri Command Handlers Documentation

This document compares the TauriService.ts implementation against the Rust backend commands and the legacy implementation.

## TauriService.ts Command Status

### Implemented Commands (Working)

| TauriService Method | Rust Command | Location |
|---------------------|--------------|----------|
| `loadImage` | `load_image` | `main.rs:378` |
| `applyAdjustments` | `apply_adjustments` | `main.rs:531` |
| `generateFullscreenPreview` | `generate_fullscreen_preview` | `main.rs:800` |
| `listImagesInDir` | `list_images_in_dir` | `file_management.rs:425` |
| `listImagesRecursive` | `list_images_recursive` | `file_management.rs:510` |
| `copyFiles` | `copy_files` | `file_management.rs:1217` |
| `moveFiles` | `move_files` | `file_management.rs:1268` |
| `deleteFiles` | `delete_files_from_disk` | `file_management.rs:2032` |
| `getFolderTree` | `get_folder_tree` | `file_management.rs:671` |
| `generateThumbnails` | `generate_thumbnails` | `file_management.rs:968` |
| `generateThumbnailsProgressive` | `generate_thumbnails_progressive` | `file_management.rs:1008` |
| `loadMetadata` | `load_metadata` | `file_management.rs:1706` |
| `saveMetadataAndUpdateThumbnail` | `save_metadata_and_update_thumbnail` | `file_management.rs:1322` |
| `exportImage` | `export_image` | `main.rs:1000` |
| `loadSettings` | `load_settings` | `file_management.rs:1761` |
| `saveSettings` | `save_settings` | `file_management.rs:1771` |
| `loadPresets` | `load_presets` | `file_management.rs:1731` |
| `savePresets` | `save_presets` | `file_management.rs:1741` |
| `generateAiSubjectMask` | `generate_ai_subject_mask` | `main.rs:1916` |
| `startBackgroundIndexing` | `start_background_indexing` | `tagging.rs:244` |

### Commands with Wrong Names (Will Fail)

| TauriService Method | Wrong Command | Correct Command |
|---------------------|---------------|-----------------|
| `renameFile` | `rename_file` | `rename_files` |
| `exportImages` | `export_images` | `batch_export_images` |
| `loadExif` | `load_exif` | `read_exif_for_paths` |
| `setRating` | `set_rating` | Use `apply_adjustments_to_paths` with rating field |
| `setColorLabel` | `set_color_label` | `set_color_label_for_paths` |
| `saveMetadata` | `save_metadata` | `save_metadata_and_update_thumbnail` |
| `invokeGenerativeReplace` | `invoke_generative_replace` | `invoke_generative_replace_with_mask_def` |

### Commands Not in Backend (Will Fail)

| TauriService Method | Command | Notes |
|---------------------|---------|-------|
| `openFolderDialog` | `open_folder_dialog` | Does not exist in Rust backend - use Tauri dialog API instead |

## Missing Commands (In Legacy, Not in TauriService)

### Batch Operations

| Command | Location | Description |
|---------|----------|-------------|
| `apply_adjustments_to_paths` | `file_management.rs:1401` | Apply adjustments to multiple images |
| `reset_adjustments_for_paths` | `file_management.rs:1482` | Reset edits on multiple images |
| `apply_auto_adjustments_to_paths` | `file_management.rs:1552` | Auto-enhance multiple images |
| `set_color_label_for_paths` | `file_management.rs:1669` | Set color labels on multiple images |

### Analysis & Preview

| Command | Location | Description |
|---------|----------|-------------|
| `calculate_auto_adjustments` | `image_processing.rs:1522` | Calculate auto-enhance values |
| `generate_histogram` | `image_processing.rs:1102` | Generate histogram data |
| `generate_waveform` | `image_processing.rs:1246` | Generate waveform data |
| `generate_mask_overlay` | `main.rs:1828` | Generate mask visualization |
| `generate_preset_preview` | `main.rs:2056` | Generate preset thumbnail |
| `generate_uncropped_preview` | `main.rs:652` | Generate uncropped preview |
| `generate_preview_for_path` | `main.rs:2706` | Generate preview for specific path |
| `generate_original_transformed_preview` | `main.rs:750` | Generate original with transforms |

### Export Operations

| Command | Location | Description |
|---------|----------|-------------|
| `batch_export_images` | `main.rs:1076` | Export multiple images |
| `cancel_export` | `main.rs:1293` | Cancel ongoing export |
| `estimate_export_size` | `main.rs:1307` | Preview single export size |
| `estimate_batch_export_size` | `main.rs:1460` | Preview batch export size |
| `get_image_dimensions` | `main.rs:454` | Get image dimensions |

### File Management

| Command | Location | Description |
|---------|----------|-------------|
| `create_folder` | `file_management.rs:1088` | Create new folder |
| `delete_folder` | `file_management.rs:1132` | Delete folder |
| `rename_folder` | `file_management.rs:1109` | Rename folder |
| `rename_files` | `file_management.rs:2372` | Batch rename files |
| `duplicate_file` | `file_management.rs:1142` | Duplicate a file |
| `create_virtual_copy` | `file_management.rs:2469` | Create virtual copy |
| `import_files` | `file_management.rs:2216` | Import files to folder |
| `delete_files_with_associated` | `file_management.rs:2077` | Delete with sidecars |
| `show_in_finder` | `file_management.rs:1996` | Show in Finder/Explorer |
| `get_pinned_folder_trees` | `file_management.rs:680` | Get pinned folder trees |

### Metadata & EXIF

| Command | Location | Description |
|---------|----------|-------------|
| `read_exif_for_paths` | `file_management.rs:389` | Batch read EXIF data |
| `get_supported_file_types` | `main.rs:2317` | Get supported file types |
| `get_log_file_path` | `main.rs:2911` | Get log file location |

### Tagging

| Command | Location | Description |
|---------|----------|-------------|
| `add_tag_for_paths` | `tagging.rs:442` | Add tags to images |
| `remove_tag_for_paths` | `tagging.rs:457` | Remove tags from images |
| `clear_ai_tags` | `tagging.rs:470` | Clear AI-generated tags |
| `clear_all_tags` | `tagging.rs:509` | Clear all tags |

### AI Features

| Command | Location | Description |
|---------|----------|-------------|
| `generate_ai_foreground_mask` | `main.rs:1862` | Generate foreground mask |
| `generate_ai_sky_mask` | `main.rs:1889` | Generate sky mask |
| `invoke_generative_replace_with_mask_def` | `main.rs:2151` | AI generative replace |
| `cull_images` | `culling.rs:172` | AI-powered culling |

### ComfyUI Integration

| Command | Location | Description |
|---------|----------|-------------|
| `check_comfyui_status` | `main.rs:2120` | Check ComfyUI connection |
| `test_comfyui_connection` | `main.rs:2134` | Test ComfyUI connection |

### Special Processing

| Command | Location | Description |
|---------|----------|-------------|
| `stitch_panorama` | `main.rs:2494` | Stitch panorama images |
| `save_panorama` | `main.rs:2566` | Save stitched panorama |
| `apply_denoising` | `main.rs:2607` | Apply denoising |
| `save_denoised_image` | `main.rs:2633` | Save denoised image |
| `save_collage` | `main.rs:2676` | Save collage image |
| `load_and_parse_lut` | `main.rs:2781` | Load LUT file |

### Community Features

| Command | Location | Description |
|---------|----------|-------------|
| `fetch_community_presets` | `main.rs:2331` | Fetch community presets |
| `generate_all_community_previews` | `main.rs:2355` | Generate community previews |
| `save_community_preset` | `file_management.rs:1901` | Save to community |
| `save_temp_file` | `main.rs:2486` | Save temporary file |

### Presets

| Command | Location | Description |
|---------|----------|-------------|
| `handle_import_presets_from_file` | `file_management.rs:1778` | Import presets from file |
| `handle_import_legacy_presets_from_file` | `file_management.rs:1833` | Import legacy presets |
| `handle_export_presets_to_file` | `file_management.rs:1886` | Export presets to file |

### Cache Management

| Command | Location | Description |
|---------|----------|-------------|
| `clear_all_sidecars` | `file_management.rs:1950` | Clear all sidecar files |
| `clear_thumbnail_cache` | `file_management.rs:1977` | Clear thumbnail cache |
| `cancel_thumbnail_generation` | `main.rs:462` | Cancel thumbnail generation |

### Window Management

| Command | Location | Description |
|---------|----------|-------------|
| `update_window_effect` | `main.rs:2115` | Update window theme/effect |
| `frontend_ready` | `main.rs:2929` | Signal frontend ready |

## Event Subscriptions (In TauriService)

| Event Name | Description |
|------------|-------------|
| `preview-update-final` | Final preview image update |
| `preview-uncropped` | Uncropped preview update |
| `histogram-update` | Histogram data update |
| `thumbnail-generated` | Single thumbnail generated |
| `export-progress` | Export progress update |
| `indexing-progress` | Background indexing progress |

## Recommendations

1. **Fix misnamed commands** - Update TauriService.ts to use correct command names
2. **Remove `openFolderDialog`** - Use Tauri's dialog API (`@tauri-apps/plugin-dialog`) instead
3. **Add missing commands** - Prioritize based on feature requirements:
   - High priority: batch operations, histogram, file management
   - Medium priority: AI features, tagging, export controls
   - Lower priority: community features, special processing
