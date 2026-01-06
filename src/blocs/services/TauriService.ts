import { Cubit } from '@blac/core';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import type { Adjustments } from '../../types/adjustments';
import type { ImageFile, ExifData } from '../../types/library';
import type { LoadImageResult, HistogramData, ExportSettings, ImageMetadata } from '../../types/editor';
import type { AppSettings } from '../app/SettingsBloc';
import { isTauri, mockInvoke, mockListen } from '../../utils/tauriMock';

// Use real Tauri APIs or mocks depending on environment
const invoke = isTauri() ? tauriInvoke : mockInvoke;
const listen = isTauri() ? tauriListen : mockListen;

interface ThumbnailEvent {
  path: string;
  data: string;
  rating: number;
}

interface ExportProgressEvent {
  current: number;
  total: number;
  currentFile: string;
}

interface TauriServiceState {
  isConnected: boolean;
}

interface MaskDefinition {
  type: string;
  parameters: Record<string, unknown>;
}

export class TauriService extends Cubit<TauriServiceState> {
  private tauriListeners: UnlistenFn[] = [];

  constructor() {
    super({ isConnected: true });
  }

  // Image Operations
  loadImage = (path: string): Promise<LoadImageResult> => invoke<LoadImageResult>('load_image', { path });

  applyAdjustments = (adjustments: Adjustments): Promise<void> =>
    invoke('apply_adjustments', { jsAdjustments: adjustments });

  generateFullscreenPreview = (adjustments: Adjustments): Promise<Uint8Array> =>
    invoke<Uint8Array>('generate_fullscreen_preview', { jsAdjustments: adjustments });

  // File Operations
  listImagesInDir = (path: string): Promise<ImageFile[]> => invoke<ImageFile[]>('list_images_in_dir', { path });

  listImagesRecursive = (path: string): Promise<ImageFile[]> => invoke<ImageFile[]>('list_images_recursive', { path });

  copyFiles = (sourcePaths: string[], destinationFolder: string): Promise<void> =>
    invoke('copy_files', { sourcePaths, destinationFolder });

  moveFiles = (sourcePaths: string[], destinationFolder: string): Promise<void> =>
    invoke('move_files', { sourcePaths, destinationFolder });

  deleteFiles = (paths: string[]): Promise<void> => invoke('delete_files_from_disk', { paths });

  renameFiles = (paths: string[], nameTemplate: string): Promise<string[]> =>
    invoke<string[]>('rename_files', { paths, nameTemplate });

  // Folder Operations
  getFolderTree = (rootPath: string): Promise<unknown> => invoke('get_folder_tree', { rootPath });

  getPinnedFolderTrees = (paths: string[]): Promise<unknown[]> =>
    invoke<unknown[]>('get_pinned_folder_trees', { paths });

  openFolderDialog = async (): Promise<string | null> => {
    if (!isTauri()) {
      console.log('[TauriService] Mock: openFolderDialog called');
      return null;
    }
    const result = await tauriOpen({ directory: true });
    return result as string | null;
  };

  createFolder = (path: string): Promise<void> => invoke('create_folder', { path });

  renameFolder = (path: string, newName: string): Promise<void> => invoke('rename_folder', { path, newName });

  deleteFolder = (path: string): Promise<void> => invoke('delete_folder', { path });

  showInFinder = (path: string): Promise<void> => invoke('show_in_finder', { path });

  // Thumbnail Operations
  generateThumbnails = (paths: string[]): Promise<void> => invoke('generate_thumbnails', { paths });

  generateThumbnailsProgressive = (paths: string[]): Promise<void> =>
    invoke('generate_thumbnails_progressive', { paths });

  cancelThumbnailGeneration = (): Promise<void> => invoke('cancel_thumbnail_generation');

  // Metadata Operations
  loadMetadata = (path: string): Promise<ImageMetadata> => invoke<ImageMetadata>('load_metadata', { path });

  saveMetadataAndUpdateThumbnail = (path: string, adjustments: Adjustments): Promise<void> =>
    invoke('save_metadata_and_update_thumbnail', { path, adjustments });

  readExifForPaths = (paths: string[]): Promise<Record<string, ExifData>> =>
    invoke<Record<string, ExifData>>('read_exif_for_paths', { paths });

  // Batch Adjustment Operations
  applyAdjustmentsToPaths = (paths: string[], adjustments: Partial<Adjustments>): Promise<void> =>
    invoke('apply_adjustments_to_paths', { paths, adjustments });

  resetAdjustmentsForPaths = (paths: string[]): Promise<void> => invoke('reset_adjustments_for_paths', { paths });

  applyAutoAdjustmentsToPaths = (paths: string[]): Promise<void> =>
    invoke('apply_auto_adjustments_to_paths', { paths });

  setColorLabelForPaths = (paths: string[], color: string | null): Promise<void> =>
    invoke('set_color_label_for_paths', { paths, color });

  // Export Operations
  exportImage = (path: string, settings: ExportSettings, adjustments: Adjustments): Promise<string> =>
    invoke<string>('export_image', { path, settings, adjustments });

  batchExportImages = (paths: string[], settings: ExportSettings, outputFolder: string): Promise<void> =>
    invoke('batch_export_images', { paths, settings, outputFolder });

  cancelExport = (): Promise<void> => invoke('cancel_export');

  estimateExportSize = (path: string, settings: ExportSettings, adjustments: Adjustments): Promise<number> =>
    invoke<number>('estimate_export_size', { path, settings, adjustments });

  estimateBatchExportSize = (paths: string[], settings: ExportSettings): Promise<number> =>
    invoke<number>('estimate_batch_export_size', { paths, settings });

  getImageDimensions = (path: string): Promise<{ width: number; height: number }> =>
    invoke<{ width: number; height: number }>('get_image_dimensions', { path });

  // Settings Operations
  loadSettings = (): Promise<AppSettings> => invoke<AppSettings>('load_settings');

  saveSettings = (settings: AppSettings): Promise<void> => invoke('save_settings', { settings });

  // Preset Operations
  loadPresets = (): Promise<unknown[]> => invoke<unknown[]>('load_presets');

  savePresets = (presets: unknown[]): Promise<void> => invoke('save_presets', { presets });

  handleImportPresetsFromFile = (): Promise<unknown[]> => invoke<unknown[]>('handle_import_presets_from_file');

  handleExportPresetsToFile = (presets: unknown[]): Promise<void> =>
    invoke('handle_export_presets_to_file', { presets });

  // AI Operations
  generateAiSubjectMask = (path: string): Promise<string> => invoke<string>('generate_ai_subject_mask', { path });

  generateAiForegroundMask = (path: string): Promise<string> => invoke<string>('generate_ai_foreground_mask', { path });

  generateAiSkyMask = (path: string): Promise<string> => invoke<string>('generate_ai_sky_mask', { path });

  invokeGenerativeReplaceWithMaskDef = (imagePath: string, maskDef: MaskDefinition, prompt: string): Promise<string> =>
    invoke<string>('invoke_generative_replace_with_mask_def', { imagePath, maskDef, prompt });

  // Analysis Operations
  calculateAutoAdjustments = (): Promise<Partial<Adjustments>> =>
    invoke<Partial<Adjustments>>('calculate_auto_adjustments');

  generateHistogram = (): Promise<HistogramData> => invoke<HistogramData>('generate_histogram');

  generateMaskOverlay = (maskParams: Record<string, unknown>, width: number, height: number): Promise<string> =>
    invoke<string>('generate_mask_overlay', { maskParams, width, height });

  // Preview Operations
  generateUncroppedPreview = (adjustments: Adjustments): Promise<void> =>
    invoke('generate_uncropped_preview', { jsAdjustments: adjustments });

  generatePreviewForPath = (path: string, adjustments: Adjustments): Promise<Uint8Array> =>
    invoke<Uint8Array>('generate_preview_for_path', { path, jsAdjustments: adjustments });

  generatePresetPreview = (adjustments: Adjustments): Promise<Uint8Array> =>
    invoke<Uint8Array>('generate_preset_preview', { jsAdjustments: adjustments });

  // Tagging Operations
  startBackgroundIndexing = (folderPath: string): Promise<void> => invoke('start_background_indexing', { folderPath });

  addTagForPaths = (paths: string[], tag: string): Promise<void> => invoke('add_tag_for_paths', { paths, tag });

  removeTagForPaths = (paths: string[], tag: string): Promise<void> => invoke('remove_tag_for_paths', { paths, tag });

  clearAiTags = (rootPath: string): Promise<number> => invoke<number>('clear_ai_tags', { rootPath });

  clearAllTags = (rootPath: string): Promise<number> => invoke<number>('clear_all_tags', { rootPath });

  // File Utilities
  duplicateFile = (path: string): Promise<void> => invoke('duplicate_file', { path });

  createVirtualCopy = (sourceVirtualPath: string): Promise<string> =>
    invoke<string>('create_virtual_copy', { sourceVirtualPath });

  importFiles = (sourcePaths: string[], destinationFolder: string, nameTemplate?: string): Promise<void> =>
    invoke('import_files', { sourcePaths, destinationFolder, nameTemplate });

  // Cache Management
  clearAllSidecars = (rootPath: string): Promise<number> => invoke<number>('clear_all_sidecars', { rootPath });

  clearThumbnailCache = (): Promise<void> => invoke('clear_thumbnail_cache');

  // Utility Operations
  getSupportedFileTypes = (): Promise<{ raw: string[]; nonRaw: string[] }> =>
    invoke<{ raw: string[]; nonRaw: string[] }>('get_supported_file_types');

  getLogFilePath = (): Promise<string> => invoke<string>('get_log_file_path');

  // ComfyUI Operations
  checkComfyuiStatus = (): Promise<void> => invoke('check_comfyui_status');

  testComfyuiConnection = (address: string): Promise<void> => invoke('test_comfyui_connection', { address });

  // Special Processing
  stitchPanorama = (paths: string[]): Promise<void> => invoke('stitch_panorama', { paths });

  savePanorama = (base64Data: string, firstPathStr: string, format: string): Promise<string> =>
    invoke<string>('save_panorama', { base64Data, firstPathStr, format });

  applyDenoising = (strength: number, preserveDetails: number): Promise<Uint8Array> =>
    invoke<Uint8Array>('apply_denoising', { strength, preserveDetails });

  saveCollage = (base64Data: string, firstPathStr: string): Promise<string> =>
    invoke<string>('save_collage', { base64Data, firstPathStr });

  loadAndParseLut = (path: string): Promise<unknown> => invoke<unknown>('load_and_parse_lut', { path });

  // Culling
  cullImages = (
    paths: string[],
    settings: {
      similarityThreshold: number;
      blurThreshold: number;
      groupSimilar: boolean;
      filterBlurry: boolean;
    },
  ): Promise<unknown> => invoke<unknown>('cull_images', { paths, settings });

  // Event Subscriptions
  onPreviewUpdate = async (callback: (data: Uint8Array) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<Uint8Array>('preview-update-final', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onUncroppedPreviewUpdate = async (callback: (data: Uint8Array) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<Uint8Array>('preview-uncropped', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onHistogramUpdate = async (callback: (data: HistogramData) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<HistogramData>('histogram-update', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onThumbnailGenerated = async (callback: (data: ThumbnailEvent) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<ThumbnailEvent>('thumbnail-generated', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onExportProgress = async (callback: (data: ExportProgressEvent) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<ExportProgressEvent>('export-progress', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onIndexingProgress = async (callback: (data: { current: number; total: number }) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<{ current: number; total: number }>('indexing-progress', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  cleanup = () => {
    this.tauriListeners.forEach((unlisten) => unlisten());
    this.tauriListeners = [];
  };
}
