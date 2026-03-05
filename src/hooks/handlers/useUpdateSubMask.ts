import { SubMask } from '../../components/panel/right/Masks';
import { Adjustments, MaskContainer, AiPatch } from '../../utils/adjustments';
import { useSetAdjustments } from './useSetAdjustments';

export function useUpdateSubMask() {
  const setAdjustments = useSetAdjustments();

  const updateSubMask = (subMaskId: string, updatedData: any) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((c: MaskContainer) => ({
        ...c,
        subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
      aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
        ...p,
        subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
    }));
  };
  return updateSubMask;
}
