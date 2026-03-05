import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useHandleFullResolutionLogic } from './useHandleFullResolutionLogic';

export function useHandleZoomChange() {
  const { adjustments, originalSize, baseRenderSize, isProgrammaticZoom, setZoom } = useAppState();
  const handleFullResolutionLogic = useHandleFullResolutionLogic();

  const handleZoomChange = useCallback(
    (zoomValue: number, fitToWindow: boolean = false) => {
      let targetZoomPercent: number;
      const orientationSteps = adjustments.orientationSteps || 0;
      const isSwapped = orientationSteps === 1 || orientationSteps === 3;
      const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;
      const effectiveOriginalHeight = isSwapped ? originalSize.width : originalSize.height;
      if (fitToWindow) {
        if (
          effectiveOriginalWidth > 0 &&
          effectiveOriginalHeight > 0 &&
          baseRenderSize.width > 0 &&
          baseRenderSize.height > 0
        ) {
          const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
          const baseAspect = baseRenderSize.width / baseRenderSize.height;
          if (originalAspect > baseAspect) {
            targetZoomPercent = baseRenderSize.width / effectiveOriginalWidth;
          } else {
            targetZoomPercent = baseRenderSize.height / effectiveOriginalHeight;
          }
        } else {
          targetZoomPercent = 1.0;
        }
      } else {
        targetZoomPercent = zoomValue;
      }
      targetZoomPercent = Math.max(0.1, Math.min(2.0, targetZoomPercent));
      let transformZoom = 1.0;
      if (
        effectiveOriginalWidth > 0 &&
        effectiveOriginalHeight > 0 &&
        baseRenderSize.width > 0 &&
        baseRenderSize.height > 0
      ) {
        const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
        const baseAspect = baseRenderSize.width / baseRenderSize.height;
        if (originalAspect > baseAspect) {
          transformZoom = (targetZoomPercent * effectiveOriginalWidth) / baseRenderSize.width;
        } else {
          transformZoom = (targetZoomPercent * effectiveOriginalHeight) / baseRenderSize.height;
        }
      }
      isProgrammaticZoom.current = true;
      setZoom(transformZoom);
      handleFullResolutionLogic(targetZoomPercent);
    },
    [originalSize, baseRenderSize, handleFullResolutionLogic, adjustments.orientationSteps],
  );

  return handleZoomChange;
}
