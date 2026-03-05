import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useHandleFullResolutionLogic() {
  const { appSettings, initialFitScale, previewSize, originalSize, setIsHighResNeeded } = useAppState();

  const handleFullResolutionLogic = useCallback(
    (targetZoomPercent: number) => {
      if (appSettings?.enableZoomHifi === false) {
        return;
      }

      if (!initialFitScale) {
        return;
      }
      const highResThreshold = Math.max(initialFitScale * 2, 0.5);
      const needsFullRes = targetZoomPercent > highResThreshold;
      const previewIsAlreadyFullRes = previewSize.width >= originalSize.width;

      if (needsFullRes && !previewIsAlreadyFullRes) {
        setIsHighResNeeded(true);
      } else {
        setIsHighResNeeded(false);
      }
    },
    [initialFitScale, previewSize.width, originalSize.width, appSettings],
  );

  return handleFullResolutionLogic;
}
