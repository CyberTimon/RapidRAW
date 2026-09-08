import type { ImageFile } from '../components/ui/AppProperties';
export interface RatingProgress {
  scanId: string;
  checked: number;
  total: number;
  failed: number;
  done: boolean;
}
export interface RatingUpdate {
  path: string;
  rating: number;
  rating_state: 'ready' | 'failed';
  is_edited: boolean;
  tags: string[] | null;
  error?: string | null;
}
export interface RatingBatch {
  scan_id: string;
  checked: number;
  total: number;
  failed: number;
  done: boolean;
  updates: RatingUpdate[];
}
export function applyRatingBatch(
  scanId: string | undefined,
  images: ImageFile[],
  ratings: Record<string, number>,
  batch: RatingBatch,
  overrides: ReadonlySet<string>,
) {
  if (scanId !== batch.scan_id) return null;
  const updates = new Map(batch.updates.map((update) => [update.path, update]));
  const nextRatings = { ...ratings };
  const imageList = images.map((image) => {
    const update = updates.get(image.path);
    if (!update || overrides.has(image.path)) return image;
    if (update.rating_state === 'ready') nextRatings[image.path] = update.rating;
    return {
      ...image,
      rating_state: update.rating_state,
      rating_error: update.error ?? undefined,
      ...(update.rating_state === 'ready'
        ? { rating: update.rating, is_edited: update.is_edited, tags: update.tags }
        : {}),
    };
  });
  return {
    imageList,
    imageRatings: nextRatings,
    ratingProgress: {
      scanId,
      checked: batch.checked,
      total: batch.total,
      failed: batch.failed,
      done: batch.done,
    },
  };
}
export function hasKnownRating(image: ImageFile) {
  return image.rating_state === undefined || image.rating_state === 'ready';
}

export function canAcceptThumbnailRating(image: ImageFile | undefined) {
  return image !== undefined && image.rating_state === undefined;
}
