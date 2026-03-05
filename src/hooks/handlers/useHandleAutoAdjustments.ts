import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { Adjustments } from '../../utils/adjustments';
import { useSetAdjustments } from './useSetAdjustments';

export function useHandleAutoAdjustments() {
  const { selectedImage, setError } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleAutoAdjustments = async () => {
    if (!selectedImage) {
      return;
    }
    try {
      const autoAdjustments: Adjustments = await invoke(Invokes.CalculateAutoAdjustments);
      setAdjustments((prev: Adjustments) => {
        const newAdjustments = { ...prev, ...autoAdjustments };
        newAdjustments.sectionVisibility = {
          ...prev.sectionVisibility,
          ...autoAdjustments.sectionVisibility,
        };

        return newAdjustments;
      });
    } catch (err) {
      console.error('Failed to calculate auto adjustments:', err);
      setError(`Failed to apply auto adjustments: ${err}`);
    }
  };

  return handleAutoAdjustments;
}
