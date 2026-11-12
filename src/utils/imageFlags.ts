import { Ban, Flag } from 'lucide-react';
import { ImageFile, ImageFlag } from '../types/library';

export const FLAG_ICONS = {
  [ImageFlag.Pick]: Flag,
  [ImageFlag.Reject]: Ban,
};

export const getImageFlag = (imageList: ImageFile[], path?: string | null): ImageFlag | null =>
  imageList.find((image) => image.path === path)?.flag ?? null;
