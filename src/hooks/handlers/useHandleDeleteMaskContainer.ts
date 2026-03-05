import { useCallback } from 'react';
import { Adjustments } from '../../utils/adjustments';
import { useSetAdjustments } from './useSetAdjustments';
import { useAppState } from '../../context/ContextProviders';

export function useHandleDeleteMaskContainer() {
  const { activeMaskContainerId, setActiveMaskContainerId, setActiveMaskId } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        setActiveMaskContainerId(null);
        setActiveMaskId(null);
      }
    },
    [setAdjustments, activeMaskContainerId],
  );

  return handleDeleteMaskContainer;
}
