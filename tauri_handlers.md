# Tauri Command Handlers Documentation

This document lists all Tauri commands available in TauriService.ts and their corresponding Rust backend implementations.

## TauriService.ts Commands

### Image Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `loadImage` | `load_image` | `main.rs:378` |
| `applyAdjustments` | `apply_adjustments` | `main.rs:531` |
| `generateFullscreenPreview` | `generate_fullscreen_preview` | `main.rs:800` |

### File Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `listImagesInDir` | `list_images_in_dir` | `file_management.rs:425` |
| `listImagesRecursive` | `list_images_recursive` | `file_management.rs:510` |
| `copyFiles` | `copy_files` | `file_management.rs:1217` |
| `moveFiles` | `move_files` | `file_management.rs:1268` |
| `deleteFiles` | `delete_files_from_disk` | `file_management.rs:2032` |
| `renameFiles` | `rename_files` | `file_management.rs:2372` |
| `duplicateFile` | `duplicate_file` | `file_management.rs:1142` |
| `createVirtualCopy` | `create_virtual_copy` | `file_management.rs:2469` |
| `importFiles` | `import_files` | `file_management.rs:2216` |

### Folder Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `getFolderTree` | `get_folder_tree` | `file_management.rs:671` |
| `getPinnedFolderTrees` | `get_pinned_folder_trees` | `file_management.rs:680` |
| `openFolderDialog` | Uses `@tauri-apps/plugin-dialog` | N/A (Tauri API) |
| `createFolder` | `create_folder` | `file_management.rs:1088` |
| `renameFolder` | `rename_folder` | `file_management.rs:1109` |
| `deleteFolder` | `delete_folder` | `file_management.rs:1132` |
| `showInFinder` | `show_in_finder` | `file_management.rs:1996` |

### Thumbnail Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `generateThumbnails` | `generate_thumbnails` | `file_management.rs:968` |
| `generateThumbnailsProgressive` | `generate_thumbnails_progressive` | `file_management.rs:1008` |
| `cancelThumbnailGeneration` | `cancel_thumbnail_generation` | `main.rs:462` |

### Metadata Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `loadMetadata` | `load_metadata` | `file_management.rs:1706` |
| `saveMetadataAndUpdateThumbnail` | `save_metadata_and_update_thumbnail` | `file_management.rs:1322` |
| `readExifForPaths` | `read_exif_for_paths` | `file_management.rs:389` |

### Batch Adjustment Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `applyAdjustmentsToPaths` | `apply_adjustments_to_paths` | `file_management.rs:1401` |
| `resetAdjustmentsForPaths` | `reset_adjustments_for_paths` | `file_management.rs:1482` |
| `applyAutoAdjustmentsToPaths` | `apply_auto_adjustments_to_paths` | `file_management.rs:1552` |
| `setColorLabelForPaths` | `set_color_label_for_paths` | `file_management.rs:1669` |

### Export Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `exportImage` | `export_image` | `main.rs:1000` |
| `batchExportImages` | `batch_export_images` | `main.rs:1076` |
| `cancelExport` | `cancel_export` | `main.rs:1293` |
| `estimateExportSize` | `estimate_export_size` | `main.rs:1307` |
| `estimateBatchExportSize` | `estimate_batch_export_size` | `main.rs:1460` |
| `getImageDimensions` | `get_image_dimensions` | `main.rs:454` |

### Settings Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `loadSettings` | `load_settings` | `file_management.rs:1761` |
| `saveSettings` | `save_settings` | `file_management.rs:1771` |

### Preset Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `loadPresets` | `load_presets` | `file_management.rs:1731` |
| `savePresets` | `save_presets` | `file_management.rs:1741` |
| `handleImportPresetsFromFile` | `handle_import_presets_from_file` | `file_management.rs:1778` |
| `handleExportPresetsToFile` | `handle_export_presets_to_file` | `file_management.rs:1886` |

### AI Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `generateAiSubjectMask` | `generate_ai_subject_mask` | `main.rs:1916` |
| `generateAiForegroundMask` | `generate_ai_foreground_mask` | `main.rs:1862` |
| `generateAiSkyMask` | `generate_ai_sky_mask` | `main.rs:1889` |
| `invokeGenerativeReplaceWithMaskDef` | `invoke_generative_replace_with_mask_def` | `main.rs:2151` |

### Analysis Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `calculateAutoAdjustments` | `calculate_auto_adjustments` | `image_processing.rs:1522` |
| `generateHistogram` | `generate_histogram` | `image_processing.rs:1102` |
| `generateMaskOverlay` | `generate_mask_overlay` | `main.rs:1828` |

### Preview Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `generateUncroppedPreview` | `generate_uncropped_preview` | `main.rs:652` |
| `generatePreviewForPath` | `generate_preview_for_path` | `main.rs:2706` |
| `generatePresetPreview` | `generate_preset_preview` | `main.rs:2056` |

### Tagging Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `startBackgroundIndexing` | `start_background_indexing` | `tagging.rs:244` |
| `addTagForPaths` | `add_tag_for_paths` | `tagging.rs:442` |
| `removeTagForPaths` | `remove_tag_for_paths` | `tagging.rs:457` |
| `clearAiTags` | `clear_ai_tags` | `tagging.rs:470` |
| `clearAllTags` | `clear_all_tags` | `tagging.rs:509` |

### Cache Management

| Method | Rust Command | Location |
|--------|--------------|----------|
| `clearAllSidecars` | `clear_all_sidecars` | `file_management.rs:1950` |
| `clearThumbnailCache` | `clear_thumbnail_cache` | `file_management.rs:1977` |

### Utility Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `getSupportedFileTypes` | `get_supported_file_types` | `main.rs:2317` |
| `getLogFilePath` | `get_log_file_path` | `main.rs:2911` |

### ComfyUI Operations

| Method | Rust Command | Location |
|--------|--------------|----------|
| `checkComfyuiStatus` | `check_comfyui_status` | `main.rs:2120` |
| `testComfyuiConnection` | `test_comfyui_connection` | `main.rs:2134` |

### Special Processing

| Method | Rust Command | Location |
|--------|--------------|----------|
| `stitchPanorama` | `stitch_panorama` | `main.rs:2494` |
| `savePanorama` | `save_panorama` | `main.rs:2566` |
| `applyDenoising` | `apply_denoising` | `main.rs:2607` |
| `saveCollage` | `save_collage` | `main.rs:2676` |
| `loadAndParseLut` | `load_and_parse_lut` | `main.rs:2781` |

### Culling

| Method | Rust Command | Location |
|--------|--------------|----------|
| `cullImages` | `cull_images` | `culling.rs:172` |

## Event Subscriptions

| Method | Event Name | Description |
|--------|------------|-------------|
| `onPreviewUpdate` | `preview-update-final` | Final preview image update |
| `onUncroppedPreviewUpdate` | `preview-uncropped` | Uncropped preview update |
| `onHistogramUpdate` | `histogram-update` | Histogram data update |
| `onThumbnailGenerated` | `thumbnail-generated` | Single thumbnail generated |
| `onExportProgress` | `export-progress` | Export progress update |
| `onIndexingProgress` | `indexing-progress` | Background indexing progress |

## Commands Not Yet Implemented in TauriService

The following commands exist in the Rust backend but are not yet exposed in TauriService.ts:

| Rust Command | Location | Description |
|--------------|----------|-------------|
| `generate_waveform` | `image_processing.rs:1246` | Generate waveform data |
| `generate_original_transformed_preview` | `main.rs:750` | Generate original with transforms |
| `delete_files_with_associated` | `file_management.rs:2077` | Delete with sidecars |
| `handle_import_legacy_presets_from_file` | `file_management.rs:1833` | Import legacy presets |
| `save_community_preset` | `file_management.rs:1901` | Save to community |
| `fetch_community_presets` | `main.rs:2331` | Fetch community presets |
| `generate_all_community_previews` | `main.rs:2355` | Generate community previews |
| `save_temp_file` | `main.rs:2486` | Save temporary file |
| `save_denoised_image` | `main.rs:2633` | Save denoised image |
| `frontend_ready` | `main.rs:2929` | Signal frontend ready |
| `update_window_effect` | `main.rs:2115` | Update window theme/effect |
