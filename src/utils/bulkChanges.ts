import i18n from 'i18next';
import { ImageFile, ImageFlag } from '../components/ui/AppProperties';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';

export const DEFAULT_BULK_CHANGE_THRESHOLD = 6;
export const MIN_BULK_CHANGE_THRESHOLD = 2;
export const MAX_BULK_CHANGE_THRESHOLD = 50;

export const BulkChange = {
  Rating: 'rating',
  Flag: 'flag',
  ColorLabel: 'colorLabel',
  Reset: 'reset',
} as const;

export type BulkChange = (typeof BulkChange)[keyof typeof BulkChange];

export interface BulkChangeOptions {
  // Applies the change without asking.
  skipBulkConfirm?: boolean;
}

interface BulkChangePrompt {
  confirmText: string;
  message: string;
  title: string;
}

const BULK_CHANGE_PROMPTS: Record<BulkChange, (count: number) => BulkChangePrompt> = {
  [BulkChange.Rating]: (count) => ({
    confirmText: i18n.t('modals.bulkChange.ratings.confirm'),
    message: i18n.t('modals.bulkChange.ratings.message', { count }),
    title: i18n.t('modals.bulkChange.ratings.title', { count }),
  }),
  [BulkChange.Flag]: (count) => ({
    confirmText: i18n.t('modals.bulkChange.flags.confirm'),
    message: i18n.t('modals.bulkChange.flags.message', { count }),
    title: i18n.t('modals.bulkChange.flags.title', { count }),
  }),
  [BulkChange.ColorLabel]: (count) => ({
    confirmText: i18n.t('modals.bulkChange.colorLabels.confirm'),
    message: i18n.t('modals.bulkChange.colorLabels.message', { count }),
    title: i18n.t('modals.bulkChange.colorLabels.title', { count }),
  }),
  [BulkChange.Reset]: (count) => ({
    confirmText: i18n.t('modals.bulkChange.reset.confirm'),
    message: i18n.t('modals.bulkChange.reset.message', { count }),
    title: i18n.t('modals.bulkChange.reset.title', { count }),
  }),
};

export const getColorLabel = (image?: ImageFile): string | null =>
  image?.tags?.find((tag) => tag.startsWith('color:'))?.substring(6) ?? null;

const countImagesWhere = (imageList: ImageFile[], paths: string[], predicate: (image: ImageFile) => boolean) => {
  const pathSet = new Set(paths);
  return imageList.filter((image) => pathSet.has(image.path) && predicate(image)).length;
};

export const countReplacedRatings = (
  imageList: ImageFile[],
  imageRatings: Record<string, number>,
  paths: string[],
  rating: number,
) => {
  const rejectedPaths = new Set(
    imageList.filter((image) => image.flag === ImageFlag.Reject).map((image) => image.path),
  );
  return paths.filter((path) => {
    const currentRating = imageRatings[path] || 0;
    const clearsReject = rating > 0 && rejectedPaths.has(path);
    return clearsReject || (currentRating !== 0 && currentRating !== rating);
  }).length;
};

export const countReplacedFlags = (imageList: ImageFile[], paths: string[], flag: ImageFlag | null) =>
  countImagesWhere(imageList, paths, (image) => !!image.flag && image.flag !== flag);

export const countReplacedColorLabels = (imageList: ImageFile[], paths: string[], color: string | null) =>
  countImagesWhere(imageList, paths, (image) => {
    const currentColor = getColorLabel(image);
    return currentColor !== null && currentColor !== color;
  });

export const countEditedImages = (imageList: ImageFile[], paths: string[]) =>
  countImagesWhere(imageList, paths, (image) => image.is_edited);

// Asks first when the change replaces enough existing values.
export const applyWithBulkConfirm = (
  change: BulkChange,
  replacedCount: number,
  options: BulkChangeOptions | undefined,
  applyChange: () => void,
) => {
  const { appSettings } = useSettingsStore.getState();
  const threshold = Math.max(
    appSettings?.bulkChangeThreshold ?? DEFAULT_BULK_CHANGE_THRESHOLD,
    MIN_BULK_CHANGE_THRESHOLD,
  );

  if (options?.skipBulkConfirm || !appSettings?.confirmBulkChanges || replacedCount < threshold) {
    applyChange();
    return;
  }

  useUIStore.getState().setUI({
    confirmModalState: {
      ...BULK_CHANGE_PROMPTS[change](replacedCount),
      confirmVariant: 'destructive',
      isOpen: true,
      onConfirm: applyChange,
    },
  });
};
