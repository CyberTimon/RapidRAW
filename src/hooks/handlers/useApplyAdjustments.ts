import { useCallback } from 'react';
import { Adjustments } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../components/ui/AppProperties';

export function useApplyAdjustments() {
  const {
    selectedImage,
    patchesSentToBackend,
    previewJobIdRef,
    selectedImagePathRef,
    latestRenderedJobIdRef,
    setFinalPreviewUrl,
  } = useAppState();

  const applyAdjustments = useCallback(
    async (currentAdjustments: Adjustments, dragging: boolean = false) => {
      if (!selectedImage?.isReady) return;
      const currentPath = selectedImage.path;

      const payload = JSON.parse(JSON.stringify(currentAdjustments));

      if (payload.aiPatches && Array.isArray(payload.aiPatches)) {
        payload.aiPatches.forEach((p: any) => {
          if (p.id && p.patchData && !p.isLoading) {
            if (patchesSentToBackend.current.has(p.id)) {
              p.patchData = null;
            } else {
              patchesSentToBackend.current.add(p.id);
            }
          }
        });
      }

      if (payload.masks && Array.isArray(payload.masks)) {
        payload.masks.forEach((container: any) => {
          if (container.subMasks && Array.isArray(container.subMasks)) {
            container.subMasks.forEach((sm: any) => {
              if (sm.id && sm.parameters && sm.parameters.mask_data_base64) {
                if (patchesSentToBackend.current.has(sm.id)) {
                  sm.parameters.mask_data_base64 = null;
                } else {
                  patchesSentToBackend.current.add(sm.id);
                }
              }
            });
          }
        });
      }

      const jobId = ++previewJobIdRef.current;

      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          isInteractive: dragging,
        });

        if (currentPath !== selectedImagePathRef.current) return;

        if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobIdRef.current) {
          latestRenderedJobIdRef.current = jobId;
          const blob = new Blob([buffer], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);

          setFinalPreviewUrl((prevUrl) => {
            if (prevUrl && prevUrl.startsWith('blob:')) URL.revokeObjectURL(prevUrl);
            return url;
          });
        }
      } catch (err) {
        if (err !== 'Superseded or worker failed') {
          console.error('Failed to apply adjustments:', err);
        }
      }
    },
    [selectedImage?.isReady, selectedImage?.path],
  );

  return applyAdjustments;
}
