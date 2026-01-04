export interface ExifData {
  Make?: string;
  Model?: string;
  LensModel?: string;
  DateTimeOriginal?: string;
  ExposureTime?: string;
  FNumber?: number;
  ISO?: number;
  FocalLength?: number;
  FocalLengthIn35mmFormat?: number;
  ExposureBiasValue?: number;
  MeteringMode?: string;
  Flash?: string;
  WhiteBalance?: string;
  ImageWidth?: number;
  ImageHeight?: number;
  Orientation?: number;
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;
}

export interface ImageFile {
  path: string;
  name: string;
  extension: string;
  size: number;
  modified: number;
  created: number;
  isRaw: boolean;
  exif?: ExifData;
  tags?: string[];
  virtualCopyId?: string;
}

export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
  isExpanded: boolean;
  imageCount?: number;
}

export interface FolderState {
  expandedPaths: string[];
  scrollPosition: number;
}

export type SortKey =
  | 'name'
  | 'date'
  | 'rating'
  | 'date_taken'
  | 'iso'
  | 'shutter_speed'
  | 'aperture'
  | 'focal_length'
  | 'size';

export type SortDirection = 'asc' | 'desc';

export interface SortCriteria {
  key: SortKey;
  direction: SortDirection;
}

export type RawStatusFilter = 'all' | 'raw' | 'nonRaw';

export interface FilterCriteria {
  minRating: number;
  colors: string[];
  rawStatus: RawStatusFilter;
}

export type ThumbnailSize = 'small' | 'medium' | 'large';
export type ThumbnailAspectRatio = 'cover' | 'contain';

export const THUMBNAIL_SIZES: Record<ThumbnailSize, number> = {
  small: 120,
  medium: 180,
  large: 240,
};

export const RAW_EXTENSIONS = [
  'raw',
  'cr2',
  'cr3',
  'nef',
  'nrw',
  'arw',
  'srf',
  'sr2',
  'orf',
  'pef',
  'raf',
  'rw2',
  'dng',
  'rwl',
  'srw',
  'x3f',
  'erf',
  'mrw',
  'dcr',
  '3fr',
  'mef',
  'mos',
  'kdc',
  'fff',
  'iiq',
];

export const IMAGE_EXTENSIONS = [
  ...RAW_EXTENSIONS,
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'tiff',
  'tif',
  'bmp',
  'heic',
  'heif',
  'avif',
];

export interface ColorLabel {
  name: string;
  color: string;
  shortcut?: string;
}

export const COLOR_LABELS: ColorLabel[] = [
  { name: 'red', color: '#ef4444', shortcut: '6' },
  { name: 'orange', color: '#f97316', shortcut: '7' },
  { name: 'yellow', color: '#eab308', shortcut: '8' },
  { name: 'green', color: '#22c55e', shortcut: '9' },
  { name: 'blue', color: '#3b82f6' },
  { name: 'purple', color: '#a855f7' },
  { name: 'none', color: '#9ca3af' },
];

export type SearchMode = 'simple' | 'advanced';

export interface SearchTag {
  type: 'filename' | 'exif' | 'tag' | 'rating' | 'color';
  value: string;
  operator?: 'equals' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte';
}

export interface SearchCriteria {
  query: string;
  tags: SearchTag[];
  mode: SearchMode;
}
