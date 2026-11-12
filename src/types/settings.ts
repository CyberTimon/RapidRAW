import type { CopyPasteSettings } from '../utils/adjustments';
import type { WhiteBalanceMode } from '../utils/whiteBalance';
import type { ExportPreset } from './export';
import type { FilterCriteria, SortCriteria, SortDirection } from './library';
import type { CollapsibleSectionsState, Panel, PanelRegion, UiVisibility } from './ui';

export enum ExifOverlay {
  Off = 'off',
  Hover = 'hover',
  Always = 'always',
}

type FolderSortKey = 'name' | 'modified' | 'created' | 'imageCount';

export interface FolderTreeSort {
  key: FolderSortKey;
  order: SortDirection;
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
  Justified = 'justified',
}

export interface WorkspaceState {
  leftPanelWidth: number;
  rightPanelWidth: number;
  leftTopHeight: number;
  rightTopHeight: number;
  panelLayout: Record<PanelRegion, Panel[]>;
  activePanels: Record<PanelRegion, Panel | null>;
  panelSwitcherPlacement: Record<PanelRegion, 'left' | 'right' | 'top' | 'bottom'>;
}

export interface CustomAspectRatio {
  width: number;
  height: number;
}

export enum EditInMode {
  Original = 'original',
  Rendered = 'rendered',
}

export interface EditInApp {
  name: string;
  path: string;
  args: string;
  mode: EditInMode;
}

export type GroupPreference = 'jpeg' | 'raw';

export type GroupingMode = 'off' | GroupPreference;

export type CompareView = 'off' | 'vertical' | 'horizontal' | 'sideBySide';

export type CompareMode = 'toggle' | Exclude<CompareView, 'off'>;

export interface AppSettings {
  aiCacheLimitGb?: number;
  aiMapsCacheLimitGb?: number;
  aiUpscaleCacheLimitGb?: number;
  thumbnailCacheLimitGb?: number;
  aiConnectorAddress?: string;
  aiGpuAcceleration?: boolean;
  aiProvider?: string;
  decorations?: any;
  editorPreviewResolution?: number;
  smallThumbnailResolution?: number;
  mediumThumbnailResolution?: number;
  enableZoomHifi?: boolean;
  useFullDpiRendering?: boolean;
  uiScale?: number;
  highResZoomMultiplier?: number;
  enableLivePreviews?: boolean;
  livePreviewQuality?: string;
  exportWorkerThreads?: number;
  exportMemoryLimit?: number;
  enableAiTagging?: boolean;
  aiTagCount?: number;
  customAiTags?: string[];
  filterCriteria?: FilterCriteria;
  lastFolderState?: any;
  pinnedFolders?: any;
  lastRootPath: string | null;
  rootFolders?: string[];
  libraryViewMode?: LibraryViewMode;
  sortCriteria?: SortCriteria;
  theme: Theme;
  thumbnailSize?: ThumbnailSize;
  thumbnailAspectRatio?: ThumbnailAspectRatio;
  uiVisibility?: UiVisibility;
  rawHighlightCompression?: number;
  processingBackend?: string;
  linuxGpuOptimization?: boolean;
  exportPresets?: ExportPreset[];
  myLenses?: any;
  customAspectRatios?: CustomAspectRatio[];
  editInApps?: EditInApp[];
  adjustmentLayout?: AdjustmentLayout;
  enableFolderImageCounts?: boolean;
  displayEditIcon?: boolean;
  linearRawMode?: string;
  enableXmpSync?: boolean;
  createXmpIfMissing?: boolean;
  isWaveformVisible?: boolean;
  waveformHeight?: number;
  activeWaveformChannel?: string;
  useWgpuRenderer?: boolean;
  editorNeutralGreyBg?: boolean;
  canvasInputMode?: 'mouse' | 'trackpad';
  compareMode?: CompareMode;
  whiteBalanceMode?: WhiteBalanceMode;
  zoomSpeedMultiplier?: number;
  zoomPhotoToPixelClick?: boolean;
  keybinds?: { [action: string]: string[] };
  speedEditAdjustments?: string[];
  enableBaselineExposure?: boolean;
  baselineExposure?: number;
  compensateHighlightPreservation?: boolean;
  tonemapperOverrideEnabled?: boolean;
  defaultRawTonemapper?: string;
  defaultNonRawTonemapper?: string;
  copyPasteSettings?: CopyPasteSettings;
  enableFocusMode?: boolean;
  enableToolFocusMode?: boolean;
  hideCollapsedPanels?: boolean;
  openTreeSections?: string[];
  folderIcons?: Record<string, string>;
  exifOverlay?: ExifOverlay;
  language?: string;
  fontFamily?: string;
  folderTreeSort?: FolderTreeSort;
  taggingShortcuts?: string[];
  libraryDisplayMode?: LibraryDisplayMode;
  grouping?: GroupingMode;
  requireMatchingExif?: boolean;
  groupEditedFiles?: boolean;
  groupPreferredType?: GroupPreference; // legacy
  alwaysDecodeRawThumbnails?: boolean;
  workspace?: WorkspaceState;
  immich?: ImmichSettings;
}

export enum LibraryViewMode {
  Flat = 'flat',
  Recursive = 'recursive',
}

export enum LibraryDisplayMode {
  Grid = 'grid',
  Cull = 'cull',
  List = 'list',
  Map = 'map',
}

export enum ThumbnailSize {
  Large = 'large',
  Medium = 'medium',
  Small = 'small',
}

export interface AdjustmentLayout {
  collapsedTools?: string[];
  hiddenSections?: string[];
  hiddenTools?: string[];
  openSections?: Partial<CollapsibleSectionsState>;
  sectionOrder?: string[];
  toolOrder?: Record<string, string[]>;
}

export interface ImmichSettings {
  serverUrl: string;
  cacheLimitGb: number;
  exportAlbum: string;
  exportWithOriginal: boolean;
}
