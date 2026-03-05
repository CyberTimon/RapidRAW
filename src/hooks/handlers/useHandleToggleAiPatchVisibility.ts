import { useCallback } from 'react';
import { Adjustments, AiPatch } from '../../utils/adjustments';
import { useSetAdjustments } from './useSetAdjustments';

export function useHandleToggleAiPatchVisibility() {
  const setAdjustments = useSetAdjustments();

  const handleToggleAiPatchVisibility = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, visible: !p.visible } : p)),
      }));
    },
    [setAdjustments],
  );

  return handleToggleAiPatchVisibility;
}
