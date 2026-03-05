import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { Adjustments } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';

export function useGenerateUncroppedPreview() {
  const { selectedImage } = useAppState();

  const generateUncroppedPreview = useCallback(
    (currentAdjustments: Adjustments) => {
      if (!selectedImage?.isReady) {
        return;
      }
      invoke(Invokes.GenerateUncroppedPreview, { jsAdjustments: currentAdjustments }).catch((err) =>
        console.error('Failed to generate uncropped preview:', err),
      );
    },
    [selectedImage?.isReady],
  );

  return generateUncroppedPreview;
}
