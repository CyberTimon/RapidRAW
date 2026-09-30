import type { DirectoryTree, ImageFile, ImageMetadata, SelectedImage } from '../components/ui/AppProperties';
import type { Adjustments } from '../utils/adjustments';

export interface PreloadedData {
  rootPaths?: string[];
  currentPath?: string;
  trees?: Promise<DirectoryTree[]>;
  images?: Promise<ImageFile[]>;
}

export interface PreviousAdjustments {
  path: string;
  adjustments: Adjustments;
}

export interface LoadImageResult {
  generation: number;
  source_revision: string;
  width: number;
  height: number;
  is_raw: boolean;
  exif: SelectedImage['exif'];
  metadata: ImageMetadata;
}

export interface ImportSettings {
  filenameTemplate: string;
  organizeByDate: boolean;
  dateFolderFormat: string;
  deleteAfterImport: boolean;
}
