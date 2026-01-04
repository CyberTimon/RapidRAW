import type { Adjustments } from './adjustments';
import type { ExifData } from './library';

export interface ImageMetadata {
  adjustments?: Partial<Adjustments>;
  tags?: string[];
  colorLabel?: string;
  rating?: number;
  createdAt?: string;
  modifiedAt?: string;
}

export interface SelectedImage {
  path: string;
  width: number;
  height: number;
  isRaw: boolean;
  isReady: boolean;
  exif?: ExifData;
  metadata?: ImageMetadata;
  originalUrl?: string;
  thumbnailUrl?: string;
}

export interface HistogramChannel {
  data: number[];
  min: number;
  max: number;
  mean: number;
}

export interface HistogramData {
  red: HistogramChannel;
  green: HistogramChannel;
  blue: HistogramChannel;
  luminance: HistogramChannel;
}

export interface WaveformData {
  width: number;
  height: number;
  red: number[];
  green: number[];
  blue: number[];
  luma: number[];
}

export type WaveformDisplayMode = 'rgb' | 'luma' | 'red' | 'green' | 'blue';

export interface LoadImageResult {
  width: number;
  height: number;
  is_raw: boolean;
  original_image_bytes: Uint8Array;
  exif?: ExifData;
  metadata?: ImageMetadata;
}

export interface ZoomState {
  scale: number;
  positionX: number;
  positionY: number;
  isFullResolution: boolean;
  isLoadingFullRes: boolean;
}

export interface ImageRenderSize {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

export type MaskType = 'brush' | 'gradient' | 'radial' | 'luminosity' | 'color' | 'ai';

export interface SubMaskBase {
  id: string;
  type: MaskType;
  inverted: boolean;
  feather: number;
  opacity: number;
}

export interface BrushSubMask extends SubMaskBase {
  type: 'brush';
  strokes: BrushStroke[];
}

export interface BrushStroke {
  points: { x: number; y: number }[];
  size: number;
  hardness: number;
  isErase: boolean;
}

export interface GradientSubMask extends SubMaskBase {
  type: 'gradient';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface RadialSubMask extends SubMaskBase {
  type: 'radial';
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
}

export interface LuminositySubMask extends SubMaskBase {
  type: 'luminosity';
  range: [number, number];
}

export interface ColorSubMask extends SubMaskBase {
  type: 'color';
  targetColor: string;
  tolerance: number;
}

export interface AISubMask extends SubMaskBase {
  type: 'ai';
  prompt?: string;
  maskData?: string;
}

export type SubMask =
  | BrushSubMask
  | GradientSubMask
  | RadialSubMask
  | LuminositySubMask
  | ColorSubMask
  | AISubMask;

export interface MaskContainer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  subMasks: SubMask[];
  adjustments: Partial<Adjustments>;
  isLoading: boolean;
  patchData: string | null;
  prompt: string;
}

export interface ExportSettings {
  format: 'jpeg' | 'png' | 'tiff' | 'webp';
  quality: number;
  resizeEnabled: boolean;
  resizeWidth?: number;
  resizeHeight?: number;
  resizeMode: 'fit' | 'fill' | 'exact';
  colorSpace: 'srgb' | 'adobe-rgb' | 'prophoto-rgb';
  bitDepth: 8 | 16;
  preserveMetadata: boolean;
  watermarkEnabled: boolean;
  watermarkText?: string;
  outputFolder?: string;
  namingPattern: string;
}

export interface ExportProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'idle' | 'exporting' | 'completed' | 'error';
  error?: string;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'jpeg',
  quality: 90,
  resizeEnabled: false,
  resizeMode: 'fit',
  colorSpace: 'srgb',
  bitDepth: 8,
  preserveMetadata: true,
  watermarkEnabled: false,
  namingPattern: '{filename}_{date}',
};
