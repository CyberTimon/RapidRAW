import { Cubit } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Adjustments } from '../../types/adjustments';
import type { ImageFile, ExifData } from '../../types/library';
import type {
  LoadImageResult,
  HistogramData,
  ExportSettings,
  ImageMetadata,
} from '../../types/editor';
import type { AppSettings } from '../app/SettingsBloc';

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

export class TauriService extends Cubit<TauriServiceState> {
  private tauriListeners: UnlistenFn[] = [];

  constructor() {
    super({ isConnected: true });
  }

  // Image Operations
  loadImage = (path: string): Promise<LoadImageResult> =>
    invoke<LoadImageResult>('load_image', { path });

  applyAdjustments = (adjustments: Adjustments): Promise<void> =>
    invoke('apply_adjustments', { jsAdjustments: adjustments });

  generateFullscreenPreview = (adjustments: Adjustments): Promise<Uint8Array> =>
    invoke<Uint8Array>('generate_fullscreen_preview', { jsAdjustments: adjustments });

  // File Operations
  listImagesInDir = (path: string): Promise<ImageFile[]> =>
    invoke<ImageFile[]>('list_images_in_dir', { path });

  listImagesRecursive = (path: string): Promise<ImageFile[]> =>
    invoke<ImageFile[]>('list_images_recursive', { path });

  copyFiles = (sourcePaths: string[], destinationFolder: string): Promise<void> =>
    invoke('copy_files', { sourcePaths, destinationFolder });

  moveFiles = (sourcePaths: string[], destinationFolder: string): Promise<void> =>
    invoke('move_files', { sourcePaths, destinationFolder });

  deleteFiles = (paths: string[]): Promise<void> =>
    invoke('delete_files_from_disk', { paths });

  renameFile = (oldPath: string, newName: string): Promise<string> =>
    invoke<string>('rename_file', { oldPath, newName });

  // Folder Operations
  getFolderTree = (rootPath: string): Promise<unknown> =>
    invoke('get_folder_tree', { rootPath });

  openFolderDialog = (): Promise<string | null> => invoke<string | null>('open_folder_dialog');

  // Thumbnail Operations
  generateThumbnails = (paths: string[]): Promise<void> =>
    invoke('generate_thumbnails', { paths });

  generateThumbnailsProgressive = (paths: string[]): Promise<void> =>
    invoke('generate_thumbnails_progressive', { paths });

  // Metadata Operations
  loadMetadata = (path: string): Promise<ImageMetadata> =>
    invoke<ImageMetadata>('load_metadata', { path });

  saveMetadata = (path: string, metadata: ImageMetadata): Promise<void> =>
    invoke('save_metadata', { path, metadata });

  saveMetadataAndUpdateThumbnail = (
    path: string,
    adjustments: Adjustments
  ): Promise<void> =>
    invoke('save_metadata_and_update_thumbnail', { path, adjustments });

  loadExif = (path: string): Promise<ExifData> => invoke<ExifData>('load_exif', { path });

  // Rating Operations
  setRating = (path: string, rating: number): Promise<void> =>
    invoke('set_rating', { path, rating });

  setColorLabel = (path: string, color: string): Promise<void> =>
    invoke('set_color_label', { path, color });

  // Export Operations
  exportImage = (
    path: string,
    settings: ExportSettings,
    adjustments: Adjustments
  ): Promise<string> =>
    invoke<string>('export_image', { path, settings, adjustments });

  exportImages = (
    paths: string[],
    settings: ExportSettings,
    outputFolder: string
  ): Promise<void> => invoke('export_images', { paths, settings, outputFolder });

  // Settings Operations
  loadSettings = (): Promise<AppSettings> => invoke<AppSettings>('load_settings');

  saveSettings = (settings: AppSettings): Promise<void> =>
    invoke('save_settings', { settings });

  // Preset Operations
  loadPresets = (): Promise<unknown[]> => invoke<unknown[]>('load_presets');

  savePresets = (presets: unknown[]): Promise<void> => invoke('save_presets', { presets });

  // AI Operations
  generateAiSubjectMask = (path: string): Promise<string> =>
    invoke<string>('generate_ai_subject_mask', { path });

  invokeGenerativeReplace = (
    imagePath: string,
    maskPath: string,
    prompt: string
  ): Promise<string> =>
    invoke<string>('invoke_generative_replace', { imagePath, maskPath, prompt });

  // Indexing
  startBackgroundIndexing = (path: string): Promise<void> =>
    invoke('start_background_indexing', { path });

  // Event Subscriptions
  onPreviewUpdate = async (callback: (data: Uint8Array) => void): Promise<UnlistenFn> => {
    const unlisten = await listen<Uint8Array>('preview-update-final', (e) =>
      callback(e.payload)
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onUncroppedPreviewUpdate = async (
    callback: (data: Uint8Array) => void
  ): Promise<UnlistenFn> => {
    const unlisten = await listen<Uint8Array>('preview-uncropped', (e) =>
      callback(e.payload)
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onHistogramUpdate = async (
    callback: (data: HistogramData) => void
  ): Promise<UnlistenFn> => {
    const unlisten = await listen<HistogramData>('histogram-update', (e) =>
      callback(e.payload)
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onThumbnailGenerated = async (
    callback: (data: ThumbnailEvent) => void
  ): Promise<UnlistenFn> => {
    const unlisten = await listen<ThumbnailEvent>('thumbnail-generated', (e) =>
      callback(e.payload)
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onExportProgress = async (
    callback: (data: ExportProgressEvent) => void
  ): Promise<UnlistenFn> => {
    const unlisten = await listen<ExportProgressEvent>('export-progress', (e) =>
      callback(e.payload)
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  onIndexingProgress = async (
    callback: (data: { current: number; total: number }) => void
  ): Promise<UnlistenFn> => {
    const unlisten = await listen<{ current: number; total: number }>(
      'indexing-progress',
      (e) => callback(e.payload)
    );
    this.tauriListeners.push(unlisten);
    return unlisten;
  };

  cleanup = () => {
    this.tauriListeners.forEach((unlisten) => unlisten());
    this.tauriListeners = [];
  };
}
