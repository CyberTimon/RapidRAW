import { Ban, Flag } from 'lucide-react';
import { ImageFile, ImageFlag } from '../components/ui/AppProperties';

export const FLAG_ICONS = {
  [ImageFlag.Pick]: Flag,
  [ImageFlag.Reject]: Ban,
};

export type ScopeFlags = Record<string, ImageFlag>;

export const getScopeFlags = (files: ImageFile[]): ScopeFlags => {
  const scopeFlags: ScopeFlags = {};
  for (const file of files) {
    if (file.flag) scopeFlags[file.path] = file.flag;
  }
  return scopeFlags;
};

// The loaded image list is always newer than the scan, so it wins for the images it contains.
export const countFlaggedImages = (
  scopeFlags: ScopeFlags | null,
  imageList: ImageFile[],
  flag: ImageFlag,
): number | null => {
  if (!scopeFlags) return null;

  const flags = new Map<string, ImageFlag>(Object.entries(scopeFlags));
  for (const image of imageList) {
    if (image.flag) flags.set(image.path, image.flag);
    else flags.delete(image.path);
  }

  let count = 0;
  for (const value of flags.values()) {
    if (value === flag) count += 1;
  }
  return count;
};

export const getImageFlag = (imageList: ImageFile[], path?: string | null): ImageFlag | null =>
  imageList.find((image) => image.path === path)?.flag ?? null;
