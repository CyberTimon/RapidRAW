import { useCallback } from 'react';
import { ImageDimensions } from '../useImageRenderSize';
import { useAppState } from '../../context/ContextProviders';

export function useHandleDisplaySizeChange() {
  const { setDisplaySize, setBaseRenderSize } = useAppState();

  const handleDisplaySizeChange = useCallback((size: ImageDimensions & { scale?: number }) => {
    setDisplaySize({ width: size.width, height: size.height });

    if (size.scale) {
      const baseWidth = size.width / size.scale;
      const baseHeight = size.height / size.scale;
      setBaseRenderSize({ width: baseWidth, height: baseHeight });
    }
  }, []);

  return handleDisplaySizeChange;
}
