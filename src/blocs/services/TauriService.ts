import { Cubit } from '@blac/core';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getVersion as tauriGetVersion } from '@tauri-apps/api/app';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { open as tauriShellOpen } from '@tauri-apps/plugin-shell';
import type { Adjustments } from '../../types/adjustments';
import type { ImageFile, ExifData } from '../../types/library';
import type { LoadImageResult, HistogramData, ExportSettings, ImageMetadata } from '../../types/editor';
import type { AppSettings } from '../app/SettingsBloc';
import { isTauri, mockInvoke, mockListen } from '../../utils/tauriMock';

const LOG_PREFIX = '[Tauri]';

async function loggedInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const baseInvoke = isTauri() ? tauriInvoke : mockInvoke;
  console.log(`${LOG_PREFIX} ${cmd} started`);
  try {
    const result = await baseInvoke<T>(cmd, args);
    console.log(`${LOG_PREFIX} ${cmd} finished`);
    return result;
  } catch (error) {
    console.error(`${LOG_PREFIX} ${cmd} failed:`, error);
    throw error;
  }
}

async function loggedListen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  const baseListen = isTauri() ? tauriListen : mockListen;
  console.log(`${LOG_PREFIX} listen:${event} started`);
  const unlisten = await baseListen<T>(event, handler);
  console.log(`${LOG_PREFIX} listen:${event} registered`);
  return unlisten;
}

async function loggedCall<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`${LOG_PREFIX} ${name} started`);
  try {
    const result = await fn();
    console.log(`${LOG_PREFIX} ${name} finished`);
    return result;
  } catch (error) {
    console.error(`${LOG_PREFIX} ${name} failed:`, error);
    throw error;
  }
}

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
  private window: TauriWindow | null = null;

  constructor() {
    super({ isConnected: true });
    if (isTauri()) {
      this.window = getCurrentWindow();
    }
  }

  // Image Operations
  loadImage = (path: string): Promise<LoadImageResult> => loggedInvoke<LoadImageResult>('load_image', { path });

  applyAdjustments = (adjustments: Adjustments): Promise<void> =>
    loggedInvoke('apply_adjustments', { jsAdjustments: adjustments });

  generateFullscreenPreview = (adjustments: Adjustments): Promise<Uint8Array> =>
    loggedInvoke<Uint8Array>('generate_fullscreen_preview', { jsAdjustments: adjustments });

  // File Operations
  listImagesInDir = (path: string): Promise<ImageFile[]> => loggedInvoke<ImageFile[]>('list_images_in_dir', { path });

  listImagesRecursive = (path: string): Promise<ImageFile[]> =>
    loggedInvoke<ImageFile[]>('list_images_recursive', { path });

  copyFiles = (sourcePaths: string[], destinationFolder: string): Promise<void> =>
    loggedInvoke('copy_files', { sourcePaths, destinationFolder });

  moveFiles = (sourcePaths: string[], destinationFolder: string): Promise<void> =>
    loggedInvoke('move_files', { sourcePaths, destinationFolder });

  deleteFiles = (paths: string[]): Promise<void> => loggedInvoke('delete_files_from_disk', { paths });

  renameFiles = (paths: string[], nameTemplate: string): Promise<string[]> =>
    loggedInvoke<string[]>('rename_files', { paths, nameTemplate });

  // Folder Operations
  getFolderTree = (rootPath: string): Promise<unknown> => loggedInvoke('get_folder_tree', { path: rootPath });

  getPinnedFolderTrees = (paths: string[]): Promise<unknown[]> =>
    loggedInvoke<unknown[]>('get_pinned_folder_trees', { paths });

  openFolderDialog = (): Promise<string | null> =>
    loggedCall('openFolderDialog', async () => {
      if (!isTauri()) return null;
      const result = await tauriOpen({ directory: true });
      return result as string | null;
    });

  createFolder = (path: string): Promise<void> => loggedInvoke('create_folder', { path });

  renameFolder = (path: string, newName: string): Promise<void> => loggedInvoke('rename_folder', { path, newName });

  deleteFolder = (path: string): Promise<void> => loggedInvoke('delete_folder', { path });

  showInFinder = (path: string): Promise<void> => loggedInvoke('show_in_finder', { path });

  // Thumbnail Operations
  generateThumbnails = (paths: string[]): Promise<void> => loggedInvoke('generate_thumbnails', { paths });

  generateThumbnailsProgressive = (paths: string[]): Promise<void> =>
    loggedInvoke('generate_thumbnails_progressive', { paths });

  cancelThumbnailGeneration = (): Promise<void> => loggedInvoke('cancel_thumbnail_generation');

  // Metadata Operations
  loadMetadata = (path: string): Promise<ImageMetadata> => loggedInvoke<ImageMetadata>('load_metadata', { path });

  saveMetadataAndUpdateThumbnail = (path: string, adjustments: Adjustments): Promise<void> =>
    loggedInvoke('save_metadata_and_update_thumbnail', { path, adjustments });

  readExifForPaths = (paths: string[]): Promise<Record<string, ExifData>> =>
    loggedInvoke<Record<string, ExifData>>('read_exif_for_paths', { paths });

  // Batch Adjustment Operations
  applyAdjustmentsToPaths = (paths: string[], adjustments: Partial<Adjustments>): Promise<void> =>
    loggedInvoke('apply_adjustments_to_paths', { paths, adjustments });

  resetAdjustmentsForPaths = (paths: string[]): Promise<void> => loggedInvoke('reset_adjustments_for_paths', { paths });

  applyAutoAdjustmentsToPaths = (paths: string[]): Promise<void> =>
    loggedInvoke('apply_auto_adjustments_to_paths', { paths });

  setColorLabelForPaths = (paths: string[], color: string | null): Promise<void> =>
    loggedInvoke('set_color_label_for_paths', { paths, color });

  // Export Operations
  exportImage = (path: string, settings: ExportSettings, adjustments: Adjustments): Promise<string> =>
    loggedInvoke<string>('export_image', { path, settings, adjustments });

  batchExportImages = (paths: string[], settings: ExportSettings, outputFolder: string): Promise<void> =>
    loggedInvoke('batch_export_images', { paths, settings, outputFolder });

  cancelExport = (): Promise<void> => loggedInvoke('cancel_export');

  estimateExportSize = (path: string, settings: ExportSettings, adjustments: Adjustments): Promise<number> =>
    loggedInvoke<number>('estimate_export_size', { path, settings, adjustments });

  estimateBatchExportSize = (paths: string[], settings: ExportSettings): Promise<number> =>
    loggedInvoke<number>('estimate_batch_export_size', { paths, settings });

  getImageDimensions = (path: string): Promise<{ width: number; height: number }> =>
    loggedInvoke<{ width: number; height: number }>('get_image_dimensions', { path });

  // Settings Operations
  loadSettings = (): Promise<AppSettings> => loggedInvoke<AppSettings>('load_settings');

  saveSettings = (settings: AppSettings): Promise<void> => loggedInvoke('save_settings', { settings });

  // Preset Operations
  loadPresets = (): Promise<unknown[]> => loggedInvoke<unknown[]>('load_presets');

  savePresets = (presets: unknown[]): Promise<void> => loggedInvoke('save_presets', { presets });

  handleImportPresetsFromFile = (): Promise<unknown[]> => loggedInvoke<unknown[]>('handle_import_presets_from_file');

  handleExportPresetsToFile = (presets: unknown[]): Promise<void> =>
    loggedInvoke('handle_export_presets_to_file', { presets });

  // AI Operations
  generateAiSubjectMask = (path: string): Promise<string> => loggedInvoke<string>('generate_ai_subject_mask', { path });

  generateAiForegroundMask = (path: string): Promise<string> =>
    loggedInvoke<string>('generate_ai_foreground_mask', { path });

  generateAiSkyMask = (path: string): Promise<string> => loggedInvoke<string>('generate_ai_sky_mask', { path });

  invokeGenerativeReplaceWithMaskDef = (imagePath: string, maskDef: MaskDefinition, prompt: string): Promise<string> =>
    loggedInvoke<string>('invoke_generative_replace_with_mask_def', { imagePath, maskDef, prompt });

  // Analysis Operations
  calculateAutoAdjustments = (): Promise<Partial<Adjustments>> =>
    loggedInvoke<Partial<Adjustments>>('calculate_auto_adjustments');

  generateHistogram = (): Promise<HistogramData> => loggedInvoke<HistogramData>('generate_histogram');

  generateMaskOverlay = (maskParams: Record<string, unknown>, width: number, height: number): Promise<string> =>
    loggedInvoke<string>('generate_mask_overlay', { maskParams, width, height });

  // Preview Operations
  generateUncroppedPreview = (adjustments: Adjustments): Promise<void> =>
    loggedInvoke('generate_uncropped_preview', { jsAdjustments: adjustments });

  generatePreviewForPath = (path: string, adjustments: Adjustments): Promise<Uint8Array> =>
    loggedInvoke<Uint8Array>('generate_preview_for_path', { path, jsAdjustments: adjustments });

  generatePresetPreview = (adjustments: Adjustments): Promise<Uint8Array> =>
    loggedInvoke<Uint8Array>('generate_preset_preview', { jsAdjustments: adjustments });

  // Tagging Operations
  startBackgroundIndexing = (folderPath: string): Promise<void> =>
    loggedInvoke('start_background_indexing', { folderPath });

  addTagForPaths = (paths: string[], tag: string): Promise<void> => loggedInvoke('add_tag_for_paths', { paths, tag });

  removeTagForPaths = (paths: string[], tag: string): Promise<void> =>
    loggedInvoke('remove_tag_for_paths', { paths, tag });

  clearAiTags = (rootPath: string): Promise<number> => loggedInvoke<number>('clear_ai_tags', { rootPath });

  clearAllTags = (rootPath: string): Promise<number> => loggedInvoke<number>('clear_all_tags', { rootPath });

  // File Utilities
  duplicateFile = (path: string): Promise<void> => loggedInvoke('duplicate_file', { path });

  createVirtualCopy = (sourceVirtualPath: string): Promise<string> =>
    loggedInvoke<string>('create_virtual_copy', { sourceVirtualPath });

  importFiles = (sourcePaths: string[], destinationFolder: string, nameTemplate?: string): Promise<void> =>
    loggedInvoke('import_files', { sourcePaths, destinationFolder, nameTemplate });

  // Cache Management
  clearAllSidecars = (rootPath: string): Promise<number> => loggedInvoke<number>('clear_all_sidecars', { rootPath });

  clearThumbnailCache = (): Promise<void> => loggedInvoke('clear_thumbnail_cache');

  // Utility Operations
  getSupportedFileTypes = (): Promise<{ raw: string[]; nonRaw: string[] }> =>
    loggedInvoke<{ raw: string[]; nonRaw: string[] }>('get_supported_file_types');

  getLogFilePath = (): Promise<string> => loggedInvoke<string>('get_log_file_path');

  // ComfyUI Operations
  checkComfyuiStatus = (): Promise<void> => loggedInvoke('check_comfyui_status');

  testComfyuiConnection = (address: string): Promise<void> => loggedInvoke('test_comfyui_connection', { address });

  // Special Processing
  stitchPanorama = (paths: string[]): Promise<void> => loggedInvoke('stitch_panorama', { paths });

  savePanorama = (base64Data: string, firstPathStr: string, format: string): Promise<string> =>
    loggedInvoke<string>('save_panorama', { base64Data, firstPathStr, format });

  applyDenoising = (strength: number, preserveDetails: number): Promise<Uint8Array> =>
    loggedInvoke<Uint8Array>('apply_denoising', { strength, preserveDetails });

  saveCollage = (base64Data: string, firstPathStr: string): Promise<string> =>
    loggedInvoke<string>('save_collage', { base64Data, firstPathStr });

  loadAndParseLut = (path: string): Promise<unknown> => loggedInvoke<unknown>('load_and_parse_lut', { path });

  // Culling
  cullImages = (
    paths: string[],
    settings: {
      similarityThreshold: number;
      blurThreshold: number;
      groupSimilar: boolean;
      filterBlurry: boolean;
    },
  ): Promise<unknown> => loggedInvoke<unknown>('cull_images', { paths, settings });

  // App Operations
  getAppVersion = (): Promise<string> =>
    loggedCall('getAppVersion', async () => {
      if (!isTauri()) return '0.0.0-dev';
      return await tauriGetVersion();
    });

  openUrl = (url: string): Promise<void> =>
    loggedCall('openUrl', async () => {
      if (!isTauri()) {
        window.open(url, '_blank');
        return;
      }
      await tauriShellOpen(url);
    });

  // File Dialog Operations
  openFileDialog = (options: {
    filters?: { name: string; extensions: string[] }[];
    multiple?: boolean;
  }): Promise<string | null> =>
    loggedCall('openFileDialog', async () => {
      if (!isTauri()) return null;
      const result = await tauriOpen({
        multiple: options.multiple ?? false,
        filters: options.filters,
      });
      return typeof result === 'string' ? result : null;
    });

  // Window Operations
  minimizeWindow = (): Promise<void> =>
    loggedCall('minimizeWindow', async () => {
      if (!this.window) return;
      await this.window.minimize();
    });

  toggleMaximizeWindow = (): Promise<void> =>
    loggedCall('toggleMaximizeWindow', async () => {
      if (!this.window) return;
      await this.window.toggleMaximize();
    });

  closeWindow = (): Promise<void> =>
    loggedCall('closeWindow', async () => {
      if (!this.window) return;
      await this.window.close();
    });

  isWindowMaximized = (): Promise<boolean> =>
    loggedCall('isWindowMaximized', async () => {
      if (!this.window) return false;
      return await this.window.isMaximized();
    });

  onWindowResized = async (callback: () => void): Promise<UnlistenFn> => {
    const previousSize = await this.window?.innerSize();
    console.log(`${LOG_PREFIX} onWindowResized started`);
    if (!this.window) return () => {};
    const unlisten = await this.window.onResized(
      ({ payload: size }: { payload: { width: number; height: number } }) => {
        const changed = previousSize.width !== size.width || previousSize.height !== size.height;
        if (changed) {
          previousSize.width = size.width;
          previousSize.height = size.height;
          callback();
        }
      },
    );
    this.tauriListeners.push(unlisten);
    console.log(`${LOG_PREFIX} onWindowResized registered`);
    return unlisten;
  };

  // Event Subscriptions
  onPreviewUpdate = async (callback: (data: Uint8Array) => void): Promise<UnlistenFn> => {
    const unlisten = await loggedListen<Uint8Array>('preview-update-final', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onUncroppedPreviewUpdate = async (callback: (data: Uint8Array) => void): Promise<UnlistenFn> => {
    const unlisten = await loggedListen<Uint8Array>('preview-uncropped', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onHistogramUpdate = async (callback: (data: HistogramData) => void): Promise<UnlistenFn> => {
    const unlisten = await loggedListen<HistogramData>('histogram-update', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onThumbnailGenerated = async (callback: (data: ThumbnailEvent) => void): Promise<UnlistenFn> => {
    const unlisten = await loggedListen<ThumbnailEvent>('thumbnail-generated', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onExportProgress = async (callback: (data: ExportProgressEvent) => void): Promise<UnlistenFn> => {
    const unlisten = await loggedListen<ExportProgressEvent>('export-progress', (e) => callback(e.payload));
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onIndexingProgress = async (callback: (data: { current: number; total: number }) => void): Promise<UnlistenFn> => {
    const unlisten = await loggedListen<{ current: number; total: number }>('indexing-progress', (e) =>
      callback(e.payload),
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  cleanup = () => {
    console.log(`${LOG_PREFIX} cleanup started`);
    this.tauriListeners.forEach((unlisten) => unlisten());
    this.tauriListeners = [];
    console.log(`${LOG_PREFIX} cleanup finished`);
  };
}
