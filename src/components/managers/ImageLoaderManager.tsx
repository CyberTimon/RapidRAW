import { useImageLoader } from '../../hooks/useImageLoader';

interface Props {
  cachedEditStateRef: Parameters<typeof useImageLoader>[0];
  invalidateSourceThumbnails: NonNullable<Parameters<typeof useImageLoader>[1]>;
  needsSourceThumbnailRefresh: NonNullable<Parameters<typeof useImageLoader>[2]>;
}

export default function ImageLoaderManager({
  cachedEditStateRef,
  invalidateSourceThumbnails,
  needsSourceThumbnailRefresh,
}: Props) {
  useImageLoader(cachedEditStateRef, invalidateSourceThumbnails, needsSourceThumbnailRefresh);

  return null;
}
