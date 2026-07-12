import { useImageLoader } from '../../hooks/useImageLoader';

interface Props {
  cachedEditStateRef: React.RefObject<any>;
}

export default function ImageLoaderManager({ cachedEditStateRef }: Props) {
  useImageLoader(cachedEditStateRef);

  return null;
}
