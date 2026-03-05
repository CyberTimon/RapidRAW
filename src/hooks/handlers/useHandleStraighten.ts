import { useCallback } from 'react';
import { Adjustments } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { useSetAdjustments } from './useSetAdjustments';

export function useHandleStraighten() {
  const { setIsStraightenActive } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleStraighten = useCallback(
    (angleCorrection: number) => {
      setAdjustments((prev: Partial<Adjustments>) => {
        const newRotation = (prev.rotation || 0) + angleCorrection;
        return { ...prev, rotation: newRotation, crop: null };
      });

      setIsStraightenActive(false);
    },
    [setAdjustments],
  );

  return handleStraighten;
}
