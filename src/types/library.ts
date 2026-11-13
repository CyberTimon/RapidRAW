export enum RawStatus {
  All = 'all',
  NonRawOnly = 'nonRawOnly',
  RawOnly = 'rawOnly',
}

export enum SortDirection {
  Ascending = 'asc',
  Descending = 'desc',
}

export const EditedStatus = {
  All: 'all',
  EditedOnly: 'editedOnly',
  UneditedOnly: 'uneditedOnly',
} as const;

export type EditedStatus = (typeof EditedStatus)[keyof typeof EditedStatus];

export const ImageFlag = {
  Pick: 'pick',
  Reject: 'reject',
} as const;

export type ImageFlag = (typeof ImageFlag)[keyof typeof ImageFlag];

export const FlagStatus = {
  All: 'all',
  Picked: 'picked',
  ExcludeRejected: 'excludeRejected',
  Rejected: 'rejected',
} as const;

export type FlagStatus = (typeof FlagStatus)[keyof typeof FlagStatus];

export type RatingOperator = 'gte' | 'eq' | 'lte';

export const RATING_OPERATORS = {
  lte: {
    symbol: '≤',
    next: 'eq',
    labelKey: 'library.header.viewOptions.ratingOperator.lte',
    suffixKey: 'library.filters.rating.andDownSuffix',
  },
  eq: {
    symbol: '=',
    next: 'gte',
    labelKey: 'library.header.viewOptions.ratingOperator.eq',
    suffixKey: 'library.filters.rating.onlySuffix',
  },
  gte: {
    symbol: '≥',
    next: 'lte',
    labelKey: 'library.header.viewOptions.ratingOperator.gte',
    suffixKey: 'library.filters.rating.andUpSuffix',
  },
} as const;

export interface FilterCriteria {
  colors: Array<string>;
  rating: number;
  ratingOperator?: RatingOperator;
  rawStatus: RawStatus;
  editedStatus?: EditedStatus;
  flagStatus?: FlagStatus;
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
  rating: number;
  flag: ImageFlag | null;
  tags: Array<string> | null;
  exif: { [key: string]: string } | null;
  is_virtual_copy: boolean;
  is_cloud_placeholder: boolean;
  is_raw: boolean;
  group_id: string | null;
  needs_ai: boolean;
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

export interface Progress {
  completed?: number;
  current?: number;
  stage?: string;
  total: number;
}

export interface CullingSettings {
  similarityThreshold: number;
  blurThreshold: number;
  groupSimilar: boolean;
  filterBlurry: boolean;
}

interface ImageAnalysisResult {
  path: string;
  qualityScore: number;
  sharpnessMetric: number;
  centerFocusMetric: number;
  exposureMetric: number;
  width: number;
  height: number;
}

interface CullGroup {
  representative: ImageAnalysisResult;
  duplicates: ImageAnalysisResult[];
}

export interface CullingSuggestions {
  similarGroups: CullGroup[];
  blurryImages: ImageAnalysisResult[];
  failedPaths: string[];
}

export type AlbumItem = Album | AlbumGroup;

export interface Album {
  type: 'album';
  id: string;
  name: string;
  icon?: string;
  images: string[];
}

export interface AlbumGroup {
  type: 'group';
  id: string;
  name: string;
  icon?: string;
  children: AlbumItem[];
}

export interface FolderNode {
  children: FolderNode[];
  isDir: boolean;
  name: string;
  path: string;
  imageCount?: number;
  hasSubdirs?: boolean;
  modified?: number;
  created?: number;
}

export interface ColumnWidths {
  thumbnail: number;
  name: number;
  date: number;
  rating: number;
  color: number;
  shutter: number;
  aperture: number;
  iso: number;
  focal: number;
}
