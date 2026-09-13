import { useImageLoader } from '../../hooks/useImageLoader';
import type { Adjustments } from '../../utils/adjustments';

interface Props {
  cachedEditStateRef: React.RefObject<any>;
  prevAdjustmentsRef: React.RefObject<{ path: string; adjustments: Adjustments } | null>;
}

export default function ImageLoaderManager({ cachedEditStateRef, prevAdjustmentsRef }: Props) {
  useImageLoader(cachedEditStateRef, prevAdjustmentsRef);

  return null;
}
