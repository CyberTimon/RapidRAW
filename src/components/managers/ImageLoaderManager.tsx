import { useImageLoader } from '../../hooks/useImageLoader';
import { useAutoLensCorrection } from '../../hooks/useAutoLensCorrection';

interface Props {
  cachedEditStateRef: React.RefObject<any>;
}

export default function ImageLoaderManager({ cachedEditStateRef }: Props) {
  useImageLoader(cachedEditStateRef);
  useAutoLensCorrection();

  return null;
}
