import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';

export function useHandleApplyDenoise() {
  const { denoiseModalState, setDenoiseModalState } = useAppState();

  const handleApplyDenoise = useCallback(
    async (intensity: number) => {
      if (!denoiseModalState.targetPath) return;

      setDenoiseModalState((prev) => ({
        ...prev,
        isProcessing: true,
        error: null,
        progressMessage: 'Starting engine...',
      }));

      try {
        await invoke(Invokes.ApplyDenoising, {
          path: denoiseModalState.targetPath,
          intensity: intensity,
        });
      } catch (err) {
        setDenoiseModalState((prev) => ({
          ...prev,
          isProcessing: false,
          error: String(err),
        }));
      }
    },
    [denoiseModalState.targetPath],
  );

  return handleApplyDenoise;
}
