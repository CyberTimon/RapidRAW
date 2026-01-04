import { Cubit } from '@blac/core';
import type { ExportSettings, ExportProgress } from '../../types/editor.js';
import { DEFAULT_EXPORT_SETTINGS } from '../../types/editor.js';

export type ExportStatus = 'idle' | 'exporting' | 'completed' | 'error' | 'cancelled';

export type ResizeMode = 'longEdge' | 'shortEdge' | 'width' | 'height';

export interface ExportState {
  settings: ExportSettings;
  status: ExportStatus;
  progress: ExportProgress;
  estimatedSize: number | null;
  isEstimating: boolean;
  resizeMode: ResizeMode;
  resizeValue: number;
  dontEnlarge: boolean;
  stripGps: boolean;
  filenameTemplate: string;
}

const INITIAL_STATE: ExportState = {
  settings: { ...DEFAULT_EXPORT_SETTINGS },
  status: 'idle',
  progress: {
    current: 0,
    total: 0,
    currentFile: '',
    status: 'idle',
  },
  estimatedSize: null,
  isEstimating: false,
  resizeMode: 'longEdge',
  resizeValue: 2048,
  dontEnlarge: true,
  stripGps: true,
  filenameTemplate: '{original_filename}_edited',
};

export const FILE_FORMATS = [
  { id: 'jpeg', name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { id: 'png', name: 'PNG', extensions: ['png'] },
  { id: 'tiff', name: 'TIFF', extensions: ['tiff', 'tif'] },
  { id: 'webp', name: 'WebP', extensions: ['webp'] },
] as const;

export const FILENAME_VARIABLES = [
  '{original_filename}',
  '{date}',
  '{time}',
  '{sequence}',
  '{width}',
  '{height}',
] as const;

export const RESIZE_MODE_OPTIONS = [
  { label: 'Long Edge', value: 'longEdge' },
  { label: 'Short Edge', value: 'shortEdge' },
  { label: 'Width', value: 'width' },
  { label: 'Height', value: 'height' },
] as const;

export class ExportBloc extends Cubit<ExportState> {
  constructor() {
    super({ ...INITIAL_STATE });
  }

  setFormat = (format: ExportSettings['format']) => {
    this.patch({
      settings: { ...this.state.settings, format },
    });
  };

  setQuality = (quality: number) => {
    this.patch({
      settings: { ...this.state.settings, quality: Math.max(1, Math.min(100, quality)) },
    });
  };

  setResizeEnabled = (resizeEnabled: boolean) => {
    this.patch({
      settings: { ...this.state.settings, resizeEnabled },
    });
  };

  setResizeMode = (resizeMode: ResizeMode) => {
    this.patch({ resizeMode });
  };

  setResizeValue = (resizeValue: number) => {
    this.patch({ resizeValue: Math.max(1, resizeValue) });
  };

  setDontEnlarge = (dontEnlarge: boolean) => {
    this.patch({ dontEnlarge });
  };

  setPreserveMetadata = (preserveMetadata: boolean) => {
    this.patch({
      settings: { ...this.state.settings, preserveMetadata },
    });
  };

  setStripGps = (stripGps: boolean) => {
    this.patch({ stripGps });
  };

  setWatermarkEnabled = (watermarkEnabled: boolean) => {
    this.patch({
      settings: { ...this.state.settings, watermarkEnabled },
    });
  };

  setWatermarkText = (watermarkText: string) => {
    this.patch({
      settings: { ...this.state.settings, watermarkText },
    });
  };

  setFilenameTemplate = (filenameTemplate: string) => {
    this.patch({ filenameTemplate });
  };

  setOutputFolder = (outputFolder: string) => {
    this.patch({
      settings: { ...this.state.settings, outputFolder },
    });
  };

  setColorSpace = (colorSpace: ExportSettings['colorSpace']) => {
    this.patch({
      settings: { ...this.state.settings, colorSpace },
    });
  };

  setBitDepth = (bitDepth: ExportSettings['bitDepth']) => {
    this.patch({
      settings: { ...this.state.settings, bitDepth },
    });
  };

  startExport = (totalImages: number) => {
    this.patch({
      status: 'exporting',
      progress: {
        current: 0,
        total: totalImages,
        currentFile: '',
        status: 'exporting',
      },
    });
  };

  updateProgress = (current: number, currentFile: string) => {
    this.patch({
      progress: {
        ...this.state.progress,
        current,
        currentFile,
      },
    });
  };

  completeExport = () => {
    this.patch({
      status: 'completed',
      progress: {
        ...this.state.progress,
        status: 'completed',
      },
    });
  };

  setError = (error: string) => {
    this.patch({
      status: 'error',
      progress: {
        ...this.state.progress,
        status: 'error',
        error,
      },
    });
  };

  cancelExport = () => {
    this.patch({
      status: 'cancelled',
      progress: {
        ...this.state.progress,
        status: 'idle',
      },
    });
  };

  resetStatus = () => {
    this.patch({
      status: 'idle',
      progress: {
        current: 0,
        total: 0,
        currentFile: '',
        status: 'idle',
      },
    });
  };

  setEstimatedSize = (size: number | null) => {
    this.patch({ estimatedSize: size, isEstimating: false });
  };

  setIsEstimating = (isEstimating: boolean) => {
    this.patch({ isEstimating });
  };

  resetSettings = () => {
    this.emit({ ...INITIAL_STATE });
  };

  get isExporting(): boolean {
    return this.state.status === 'exporting';
  }

  get isCompleted(): boolean {
    return this.state.status === 'completed';
  }

  get hasError(): boolean {
    return this.state.status === 'error';
  }

  get isCancelled(): boolean {
    return this.state.status === 'cancelled';
  }

  get progressPercentage(): number {
    const { current, total } = this.state.progress;
    if (total === 0) return 0;
    return Math.round((current / total) * 100);
  }

  get currentFormatExtension(): string {
    const format = FILE_FORMATS.find((f) => f.id === this.state.settings.format);
    return format?.extensions[0] || 'jpg';
  }
}
