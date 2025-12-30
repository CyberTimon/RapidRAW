import { StatelessCubit, blac } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { Invokes, AppSettings, CullingSuggestions } from '../components/ui/AppProperties';
import { Adjustments } from '../utils/adjustments';

@blac({ keepAlive: true })
export class TauriService extends StatelessCubit {
  // Settings
  loadSettings = (): Promise<AppSettings | null> =>
    invoke(Invokes.LoadSettings);

  saveSettings = (settings: AppSettings): Promise<void> =>
    invoke(Invokes.SaveSettings, { settings });

  // Folder operations
  getFolderTree = (path: string): Promise<any> =>
    invoke(Invokes.GetFolderTree, { path });

  getPinnedFolderTrees = (paths: string[]): Promise<any[]> =>
    invoke(Invokes.GetPinnedFolderTrees, { paths });

  createFolder = (path: string, name: string): Promise<string> =>
    invoke(Invokes.CreateFolder, { path, name });

  renameFolder = (path: string, newName: string): Promise<string> =>
    invoke(Invokes.RenameFolder, { path, newName });

  deleteFolder = (path: string): Promise<void> =>
    invoke(Invokes.DeleteFolder, { path });

  showInFinder = (path: string): Promise<void> =>
    invoke(Invokes.ShowInFinder, { path });

  // Image listing
  listImagesInDir = (path: string): Promise<any[]> =>
    invoke(Invokes.ListImagesInDir, { path });

  listImagesRecursive = (path: string): Promise<any[]> =>
    invoke(Invokes.ListImagesRecursive, { path });

  getSupportedFileTypes = (): Promise<any> =>
    invoke(Invokes.GetSupportedFileTypes);

  // Thumbnails
  generateThumbnailsProgressive = (paths: string[]): Promise<void> =>
    invoke(Invokes.GenerateThumbnailsProgressive, { paths });

  clearThumbnailCache = (): Promise<void> =>
    invoke(Invokes.ClearThumbnailCache);

  // Image loading
  loadImage = (path: string, resolution?: number): Promise<any> =>
    invoke(Invokes.LoadImage, { path, resolution });

  loadMetadata = (path: string): Promise<any> =>
    invoke(Invokes.LoadMetadata, { path });

  // Adjustments & Processing
  applyAdjustments = (
    imagePath: string,
    adjustments: Adjustments,
    resolution?: number
  ): Promise<Uint8Array> =>
    invoke(Invokes.ApplyAdjustments, { imagePath, adjustments, resolution });

  applyAdjustmentsToPaths = (
    paths: string[],
    adjustments: Adjustments
  ): Promise<void> =>
    invoke(Invokes.ApplyAdjustmentsToPaths, { paths, adjustments });

  calculateAutoAdjustments = (imagePath: string): Promise<Partial<Adjustments>> =>
    invoke(Invokes.CalculateAutoAdjustments, { imagePath });

  applyAutoAdjustmentsToPaths = (paths: string[]): Promise<void> =>
    invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths });

  resetAdjustmentsForPaths = (paths: string[]): Promise<void> =>
    invoke(Invokes.ResetAdjustmentsForPaths, { paths });

  // Preview generation
  generatePreviewForPath = (path: string, adjustments: Adjustments): Promise<Uint8Array> =>
    invoke(Invokes.GeneratePreviewForPath, { path, adjustments });

  generateUncroppedPreview = (
    imagePath: string,
    adjustments: Adjustments,
    resolution?: number
  ): Promise<Uint8Array> =>
    invoke(Invokes.GenerateUncroppedPreview, { imagePath, adjustments, resolution });

  generateFullscreenPreview = (
    imagePath: string,
    adjustments: Adjustments,
    width: number,
    height: number
  ): Promise<Uint8Array> =>
    invoke(Invokes.GenerateFullscreenPreview, { imagePath, adjustments, width, height });

  generateHistogram = (imagePath: string, adjustments: Adjustments): Promise<any> =>
    invoke(Invokes.GenerateHistogram, { imagePath, adjustments });

  generateWaveform = (imagePath: string, adjustments: Adjustments): Promise<any> =>
    invoke(Invokes.GenerateWaveform, { imagePath, adjustments });

  // Metadata operations
  saveMetadataAndUpdateThumbnail = (
    path: string,
    adjustments: Adjustments,
    rating: number,
    tags: string[] | null
  ): Promise<void> =>
    invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments, rating, tags });

  readExifForPaths = (paths: string[]): Promise<any> =>
    invoke(Invokes.ReadExifForPaths, { paths });

  // Export
  exportImage = (options: any): Promise<void> =>
    invoke(Invokes.ExportImage, options);

  batchExportImages = (options: any): Promise<void> =>
    invoke(Invokes.BatchExportImages, options);

  cancelExport = (): Promise<void> =>
    invoke(Invokes.CancelExport);

  estimateExportSize = (options: any): Promise<number> =>
    invoke(Invokes.EstimateExportSize, options);

  estimateBatchExportSize = (options: any): Promise<number> =>
    invoke(Invokes.EstimateBatchExportSize, options);

  // File operations
  copyFiles = (sourcePaths: string[], destFolder: string): Promise<void> =>
    invoke(Invokes.CopyFiles, { sourcePaths, destFolder });

  moveFiles = (sourcePaths: string[], destFolder: string): Promise<void> =>
    invoke(Invokes.MoveFiles, { sourcePaths, destFolder });

  renameFiles = (paths: string[], newNames: string[]): Promise<void> =>
    invoke(Invokes.RenameFiles, { paths, newNames });

  duplicateFile = (path: string): Promise<string> =>
    invoke(Invokes.DuplicateFile, { path });

  createVirtualCopy = (path: string): Promise<string> =>
    invoke(Invokes.CreateVirtualCopy, { path });

  importFiles = (sourcePaths: string[], destFolder: string): Promise<void> =>
    invoke(Invokes.ImportFiles, { sourcePaths, destFolder });

  // Masks
  generateMaskOverlay = (
    imagePath: string,
    maskData: any,
    width: number,
    height: number
  ): Promise<Uint8Array> =>
    invoke(Invokes.GenerateMaskOverlay, { imagePath, maskData, width, height });

  generateAiForegroundMask = (imagePath: string): Promise<any> =>
    invoke(Invokes.GenerateAiForegroundMask, { imagePath });

  generateAiSkyMask = (imagePath: string): Promise<any> =>
    invoke(Invokes.GenerateAiSkyMask, { imagePath });

  generateAiSubjectMask = (imagePath: string): Promise<any> =>
    invoke(Invokes.GenerateAiSubjectMask, { imagePath });

  // AI / ComfyUI
  checkComfyuiStatus = (): Promise<boolean> =>
    invoke(Invokes.CheckComfyuiStatus);

  testComfyuiConnection = (address: string): Promise<boolean> =>
    invoke(Invokes.TestComfyuiConnection, { address });

  invokeGenerativeReplace = (options: any): Promise<any> =>
    invoke(Invokes.InvokeGenerativeReplace, options);

  invokeGenerativeReplaceWithMaskDef = (options: any): Promise<any> =>
    invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, options);

  // Tags
  addTagForPaths = (paths: string[], tag: string): Promise<void> =>
    invoke(Invokes.AddTagForPaths, { paths, tag });

  removeTagForPaths = (paths: string[], tag: string): Promise<void> =>
    invoke(Invokes.RemoveTagForPaths, { paths, tag });

  clearAiTags = (paths: string[]): Promise<void> =>
    invoke(Invokes.ClearAiTags, { paths });

  clearAllTags = (paths: string[]): Promise<void> =>
    invoke(Invokes.ClearAllTags, { paths });

  setColorLabelForPaths = (paths: string[], color: string | null): Promise<void> =>
    invoke(Invokes.SetColorLabelForPaths, { paths, color });

  // Presets
  loadPresets = (): Promise<any> =>
    invoke(Invokes.LoadPresets);

  savePresets = (presets: any): Promise<void> =>
    invoke(Invokes.SavePresets, { presets });

  generatePresetPreview = (
    imagePath: string,
    adjustments: Adjustments
  ): Promise<Uint8Array> =>
    invoke(Invokes.GeneratePresetPreview, { imagePath, adjustments });

  handleExportPresetsToFile = (presets: any): Promise<void> =>
    invoke(Invokes.HandleExportPresetsToFile, { presets });

  handleImportPresetsFromFile = (): Promise<any> =>
    invoke(Invokes.HandleImportPresetsFromFile);

  handleImportLegacyPresetsFromFile = (): Promise<any> =>
    invoke(Invokes.HandleImportLegacyPresetsFromFile);

  // Panorama
  stitchPanorama = (paths: string[]): Promise<string> =>
    invoke(Invokes.StitchPanorama, { paths });

  savePanorama = (base64: string, outputPath: string): Promise<void> =>
    invoke(Invokes.SavePanorama, { base64, outputPath });

  // Denoising
  applyDenoising = (imagePath: string, strength: number): Promise<Uint8Array> =>
    invoke(Invokes.ApplyDenoising, { imagePath, strength });

  saveDenoisedImage = (imagePath: string, imageData: Uint8Array): Promise<string> =>
    invoke<string>(Invokes.SaveDenoisedImage, { imagePath, imageData: Array.from(imageData) });

  // Culling
  cullImages = (paths: string[], settings: any): Promise<CullingSuggestions> =>
    invoke(Invokes.CullImages, { paths, settings });

  // Collage
  saveCollage = (options: any): Promise<void> =>
    invoke(Invokes.SaveCollage, options);

  // Indexing
  startBackgroundIndexing = (path: string): Promise<void> =>
    invoke(Invokes.StartBackgroundIndexing, { path });

  // Window
  updateWindowEffect = (effect: any): Promise<void> =>
    invoke(Invokes.UpdateWindowEffect, { effect });

  // Community
  fetchCommunityPresets = (): Promise<any> =>
    invoke(Invokes.FetchCommunityPresets);

  generateAllCommunityPreviews = (
    imagePath: string,
    presets: any[]
  ): Promise<any> =>
    invoke(Invokes.GenerateAllCommunityPreviews, { imagePath, presets });

  saveCommunityPreset = (preset: any): Promise<void> =>
    invoke(Invokes.SaveCommunityPreset, { preset });

  // Misc
  getLogFilePath = (): Promise<string> =>
    invoke(Invokes.GetLogFilePath);

  clearAllSidecars = (paths: string[]): Promise<void> =>
    invoke(Invokes.ClearAllSidecars, { paths });

  saveTempFile = (data: Uint8Array, extension: string): Promise<string> =>
    invoke(Invokes.SaveTempFile, { data: Array.from(data), extension });
}
