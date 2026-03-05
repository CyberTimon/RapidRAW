import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { Invokes } from '../../components/ui/AppProperties';

export function useRequestFullResolution() {
  const {
    selectedImage,
    previewJobIdRef,
    latestRenderedJobIdRef,
    setFinalPreviewUrl,
    fullResCacheKeyRef,
    setIsLoadingFullRes,
  } = useAppState();

  const requestFullResolution = useCallback(
    debounce((currentAdjustments: any, key: string) => {
      if (!selectedImage?.path) return;

      const jobId = ++previewJobIdRef.current;

      invoke<ArrayBuffer>(Invokes.GenerateFullscreenPreview, {
        jsAdjustments: currentAdjustments,
      })
        .then((buffer) => {
          if (jobId >= latestRenderedJobIdRef.current) {
            latestRenderedJobIdRef.current = jobId;
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            setFinalPreviewUrl((prevUrl) => {
              if (prevUrl && prevUrl.startsWith('blob:')) URL.revokeObjectURL(prevUrl);
              return url;
            });

            fullResCacheKeyRef.current = key;
            setIsLoadingFullRes(false);
          }
        })
        .catch((error: any) => {
          if (jobId >= latestRenderedJobIdRef.current) {
            console.error('Failed to generate high resolution preview:', error);
            fullResCacheKeyRef.current = null;
            setIsLoadingFullRes(false);
          }
        });
    }, 100),
    [selectedImage?.path],
  );

  return requestFullResolution;
}
