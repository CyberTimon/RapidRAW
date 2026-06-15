import { Progress } from './AppProperties';

export const EXPORT_TIMEOUT = 4000;
export const IMPORT_TIMEOUT = 5000;

export enum FileFormats {
  Jpeg = 'jpeg',
  Png = 'png',
  Tiff = 'tiff',
  Webp = 'webp',
  Jxl = 'jxl',
  Avif = 'avif',
  Cube = 'cube',
}

export const FILE_FORMATS: Array<FileFormat> = [
  { id: FileFormats.Jpeg, name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { id: FileFormats.Png, name: 'PNG', extensions: ['png'] },
  { id: FileFormats.Tiff, name: 'TIFF', extensions: ['tiff'] },
  { id: FileFormats.Webp, name: 'WebP', extensions: ['webp'] },
  { id: FileFormats.Jxl, name: 'JPEG XL', extensions: ['jxl'] },
  { id: FileFormats.Avif, name: 'AVIF', extensions: ['avif'] },
  { id: FileFormats.Cube, name: 'CUBE LUT', extensions: ['cube'] },
];

export const FILENAME_VARIABLES: Array<string> = [
  '{original_filename}',
  '{sequence}',
  '{YYYY}',
  '{MM}',
  '{DD}',
  '{hh}',
  '{mm}',
];

export interface ExportSettings {
  filenameTemplate: string | null;
  jpegQuality: number;
  keepMetadata: boolean;
  preserveTimestamps: boolean;
  resize: {
    mode: string;
    value: number;
    dontEnlarge: boolean;
  } | null;
  stripGps: boolean;
  watermark: WatermarkSettings | null;
  exportMasks?: boolean;
  preserveFolders?: boolean;
  /** HDR export (AVIF/JXL): 8 = SDR, 10/12 = HDR. */
  bitDepth?: number;
  /** HDR transfer function: 'srgb' | 'pq' | 'hlg'. */
  transferFunction?: string;
  /** HDR primaries: 'srgb' | 'bt2020' | 'displayp3'. */
  primaries?: string;
  /** Color encoding matrix: 'identity' (RGB) | 'ycbcr'. */
  matrix?: string;
  /** Chroma subsampling: '444' | '422' | '420'. */
  chromaSubsampling?: string;
  /** Signal range: 'full' | 'limited'. */
  range?: string;
  /** Reference (paper) white in nits. Default 203. */
  referenceWhiteNits?: number;
  /** HLG peak luminance headroom above paper white. Default 12. */
  hlgPeakRatio?: number;
  /** Embed mastering display metadata (MaxCLL/MaxFALL). Default false. */
  masteringMetadata?: boolean;
}

export enum WatermarkAnchor {
  TopLeft = 'topLeft',
  TopCenter = 'topCenter',
  TopRight = 'topRight',
  CenterLeft = 'centerLeft',
  Center = 'center',
  CenterRight = 'centerRight',
  BottomLeft = 'bottomLeft',
  BottomCenter = 'bottomCenter',
  BottomRight = 'bottomRight',
}

export interface WatermarkSettings {
  path: string;
  anchor: WatermarkAnchor;
  scale: number;
  spacing: number;
  opacity: number;
}

export interface ExportState {
  errorMessage: string;
  progress: Progress;
  status: Status;
}

export interface FileFormat {
  extensions: Array<string>;
  id: string;
  name: string;
}

export interface ImportState {
  errorMessage: string;
  path?: string;
  progress?: Progress;
  status: Status;
}

export enum Status {
  Cancelled = 'cancelled',
  Exporting = 'exporting',
  Error = 'error',
  Idle = 'idle',
  Importing = 'importing',
  Success = 'success',
}

export interface ExportPreset {
  id: string;
  name: string;
  fileFormat: string;
  jpegQuality: number;
  enableResize: boolean;
  resizeMode: string;
  resizeValue: number;
  dontEnlarge: boolean;
  keepMetadata: boolean;
  preserveTimestamps: boolean;
  stripGps: boolean;
  exportMasks?: boolean;
  preserveFolders?: boolean;
  filenameTemplate: string;
  enableWatermark: boolean;
  watermarkPath: string | null;
  watermarkAnchor: string;
  watermarkScale: number;
  watermarkSpacing: number;
  watermarkOpacity: number;
  lastExportPath?: string;
  bitDepth?: number;
  transferFunction?: string;
  primaries?: string;
  matrix?: string;
  chromaSubsampling?: string;
  range?: string;
  referenceWhiteNits?: number;
  hlgPeakRatio?: number;
  masteringMetadata?: boolean;
}
