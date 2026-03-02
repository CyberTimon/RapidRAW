import { ExportPreset } from './ExportImportProperties';
import { Adjustments } from '../../utils/adjustments';
import { ToolType } from '../panel/right/Masks';

export const GLOBAL_KEYS = [' ', 'ArrowUp', 'ArrowDown', 'f', 'b', 'w'];
export const OPTION_SEPARATOR = 'separator';

export enum Panel {
  Adjustments = 'adjustments',
  Ai = 'ai',
  Crop = 'crop',
  Export = 'export',
  Masks = 'masks',
  Metadata = 'metadata',
  Presets = 'presets',
}

export enum RawStatus {
  All = 'all',
  NonRawOnly = 'nonRawOnly',
  RawOnly = 'rawOnly',
  RawOverNonRaw = 'rawOverNonRaw',
}

export enum SortDirection {
  Ascending = 'asc',
  Descening = 'desc',
}

export enum Theme {
  Arctic = 'arctic',
  Blue = 'blue',
  Dark = 'dark',
  Grey = 'grey',
  Light = 'light',
  MutedGreen = 'muted-green',
  Sepia = 'sepia',
  Snow = 'snow',
}

export enum ThumbnailAspectRatio {
  Cover = 'cover',
  Contain = 'contain',
}

export interface AppSettings {
  adaptiveEditorTheme?: Theme;
  aiConnectorAddress?: string;
  decorations?: any;
  editorPreviewResolution?: number;
  enableZoomHifi?: boolean;
  enableLivePreviews?: boolean;
  enableHighQualityLivePreviews?: boolean;
  enableAiTagging?: boolean;
  enableExifReading?: boolean;
  filterCriteria?: FilterCriteria;
  lastFolderState?: any;
  pinnedFolders?: any;
  lastRootPath: string | null;
  libraryViewMode?: LibraryViewMode;
  sortCriteria?: SortCriteria;
  theme: Theme;
  thumbnailSize?: ThumbnailSize;
  thumbnailAspectRatio?: ThumbnailAspectRatio;
  uiVisibility?: UiVisibility;
  adjustmentVisibility?: { [key: string]: boolean };
  activeTreeSection?: string | null;
  rawHighlightCompression?: number;
  processingBackend?: string;
  linuxGpuOptimization?: boolean;
  exportPresets?: ExportPreset[];
  myLenses?: any;
  enableFolderImageCounts?: boolean;
  linearRawMode?: string;
  enableXmpSync?: boolean;
  createXmpIfMissing?: boolean;
}

export interface BrushSettings {
  feather: number;
  size: number;
  tool: ToolType;
}

export enum LibraryViewMode {
  Flat = 'flat',
  Recursive = 'recursive',
}

export interface FilterCriteria {
  colors: Array<string>;
  rating: number;
  rawStatus: RawStatus;
}

export interface Folder {
  children: any;
  id?: string | undefined;
  name?: string | undefined;
  imageCount?: number;
}

export interface ImageFile {
  is_edited: boolean;
  modified: number;
  path: string;
  tags: Array<string> | null;
  exif: { [key: string]: string } | null;
  is_virtual_copy: boolean;
}

export interface Option {
  color?: string;
  disabled?: boolean;
  icon?: any;
  isDestructive?: boolean;
  label?: string;
  onClick?(): void;
  submenu?: any;
  type?: string;
}

export enum Orientation {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

export interface Preset {
  adjustments: Partial<Adjustments>;
  folder?: Folder;
  id: string;
  name: string;
}

export interface Progress {
  completed?: number;
  current?: number;
  total: number;
}

export interface SelectedImage {
  exif: any;
  height: number;
  isRaw: boolean;
  isReady: boolean;
  metadata?: any;
  original_base64?: string;
  originalUrl: string | null;
  path: string;
  thumbnailUrl: string;
  width: number;
}

export interface SortCriteria {
  key: string;
  label?: string;
  order: string;
}

export interface SupportedTypes {
  nonRaw: Array<string>;
  raw: Array<string>;
}

export enum ThumbnailSize {
  Large = 'large',
  Medium = 'medium',
  Small = 'small',
}

export interface TransformState {
  positionX: number;
  positionY: number;
  scale: number;
}

export interface UiVisibility {
  folderTree: boolean;
  filmstrip: boolean;
}

export interface WaveformData {
  [index: string]: Array<number> | number;
  blue: Array<number>;
  green: Array<number>;
  height: number;
  luma: Array<number>;
  red: Array<number>;
  width: number;
}

export interface CullingSettings {
  similarityThreshold: number;
  blurThreshold: number;
  groupSimilar: boolean;
  filterBlurry: boolean;
}

export interface ImageAnalysisResult {
  path: string;
  qualityScore: number;
  sharpnessMetric: number;
  centerFocusMetric: number;
  exposureMetric: number;
  width: number;
  height: number;
}

export interface CullGroup {
  representative: ImageAnalysisResult;
  duplicates: ImageAnalysisResult[];
}

export interface CullingSuggestions {
  similarGroups: CullGroup[];
  blurryImages: ImageAnalysisResult[];
  failedPaths: string[];
}
