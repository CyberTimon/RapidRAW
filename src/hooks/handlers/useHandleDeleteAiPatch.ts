import { useCallback } from 'react';
import { Adjustments } from '../../utils/adjustments';
import { useSetAdjustments } from './useSetAdjustments';
import { useAppState } from '../../context/ContextProviders';

export function useHandleDeleteAiPatch() {
  const { activeAiPatchContainerId, setActiveAiPatchContainerId, setActiveAiSubMaskId } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleDeleteAiPatch = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
      }));
      if (activeAiPatchContainerId === patchId) {
        setActiveAiPatchContainerId(null);
        setActiveAiSubMaskId(null);
      }
    },
    [setAdjustments, activeAiPatchContainerId],
  );

  return handleDeleteAiPatch;
}
