import { useCallback } from 'react';
import { TransformState } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useHandleFullResolutionLogic } from './useHandleFullResolutionLogic';

export function useHandleUserTransform() {
  const { isProgrammaticZoom, setZoom, originalSize, baseRenderSize, adjustments } = useAppState();
  const handleFullResolutionLogic = useHandleFullResolutionLogic();

  const handleUserTransform = useCallback(
    (transformState: TransformState) => {
      if (isProgrammaticZoom.current) {
        isProgrammaticZoom.current = false;
        return;
      }

      setZoom(transformState.scale);

      if (originalSize.width > 0 && baseRenderSize.width > 0) {
        const orientationSteps = adjustments.orientationSteps || 0;
        const isSwapped = orientationSteps === 1 || orientationSteps === 3;
        const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;

        const targetZoomPercent = (baseRenderSize.width * transformState.scale) / effectiveOriginalWidth;
        handleFullResolutionLogic(targetZoomPercent);
      }
    },
    [originalSize, baseRenderSize, handleFullResolutionLogic, adjustments.orientationSteps],
  );

  return handleUserTransform;
}
