import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../store/useUIStore';
import { Invokes } from '../components/ui/AppProperties';

export function useProductivityActions(refreshImageList: () => Promise<void>) {
  const setUI = useUIStore((state) => state.setUI);

  const handleStartPanorama = useCallback(
    (paths: string[]) => {
      setUI((state) => ({
        panoramaModalState: {
          ...state.panoramaModalState,
          isProcessing: true,
          error: null,
          finalImageBase64: null,
          progressMessage: 'Starting panorama process...',
        },
      }));
      invoke(Invokes.StitchPanorama, { paths }).catch((err) => {
        setUI((state) => ({
          panoramaModalState: { ...state.panoramaModalState, isProcessing: false, error: String(err) },
        }));
      });
    },
    [setUI],
  );

  const handleSavePanorama = useCallback(async (): Promise<string> => {
    const { panoramaModalState } = useUIStore.getState();
    if (panoramaModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for panorama not found.';
      setUI((state) => ({ panoramaModalState: { ...state.panoramaModalState, error: err } }));
      throw new Error(err);
    }
    try {
      const savedPath: string = await invoke(Invokes.SavePanorama, {
        firstPathStr: panoramaModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save panorama:', err);
      setUI((state) => ({ panoramaModalState: { ...state.panoramaModalState, error: String(err) } }));
      throw err;
    }
  }, [refreshImageList, setUI]);

  const handleStartHdr = useCallback(
    (paths: string[]) => {
      setUI((state) => ({
        hdrModalState: {
          ...state.hdrModalState,
          isProcessing: true,
          error: null,
          finalImageBase64: null,
          progressMessage: 'Starting HDR process...',
        },
      }));
      invoke(Invokes.MergeHdr, { paths }).catch((err) => {
        setUI((state) => ({ hdrModalState: { ...state.hdrModalState, isProcessing: false, error: String(err) } }));
      });
    },
    [setUI],
  );

  const handleSaveHdr = useCallback(async (): Promise<string> => {
    const { hdrModalState } = useUIStore.getState();
    if (hdrModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for HDR not found.';
      setUI((state) => ({ hdrModalState: { ...state.hdrModalState, error: err } }));
      throw new Error(err);
    }
    try {
      const savedPath: string = await invoke(Invokes.SaveHdr, { firstPathStr: hdrModalState.stitchingSourcePaths[0] });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save HDR image:', err);
      setUI((state) => ({ hdrModalState: { ...state.hdrModalState, error: String(err) } }));
      throw err;
    }
  }, [refreshImageList, setUI]);

  const handleApplyDenoise = useCallback(
    async (intensity: number, method: 'ai' | 'bm3d') => {
      const { denoiseModalState } = useUIStore.getState();
      if (denoiseModalState.targetPaths.length === 0) return;

      setUI((state) => ({
        denoiseModalState: {
          ...state.denoiseModalState,
          isProcessing: true,
          error: null,
          progressMessage: 'Starting engine...',
        },
      }));

      try {
        await invoke(Invokes.ApplyDenoising, {
          path: denoiseModalState.targetPaths[0],
          intensity: intensity,
          method: method,
        });
      } catch (err) {
        setUI((state) => ({
          denoiseModalState: { ...state.denoiseModalState, isProcessing: false, error: String(err) },
        }));
      }
    },
    [setUI],
  );

  const handleBatchDenoise = useCallback(
    async (intensity: number, method: 'ai' | 'bm3d', paths: string[]) => {
      try {
        const savedPaths: string[] = await invoke('batch_denoise_images', { paths, intensity, method });
        await refreshImageList();
        return savedPaths;
      } catch (err) {
        setUI((state) => ({ denoiseModalState: { ...state.denoiseModalState, error: String(err) } }));
        throw err;
      }
    },
    [refreshImageList, setUI],
  );

  const handleSaveDenoisedImage = useCallback(async (): Promise<string> => {
    const { denoiseModalState } = useUIStore.getState();
    if (denoiseModalState.targetPaths.length === 0) throw new Error('No target path');
    const savedPath = await invoke<string>(Invokes.SaveDenoisedImage, {
      originalPathStr: denoiseModalState.targetPaths[0],
    });
    await refreshImageList();
    return savedPath;
  }, [refreshImageList]);

  const handleSaveCollage = useCallback(
    async (base64Data: string, firstPath: string): Promise<string> => {
      try {
        const savedPath: string = await invoke(Invokes.SaveCollage, { base64Data, firstPathStr: firstPath });
        await refreshImageList();
        return savedPath;
      } catch (err) {
        console.error('Failed to save collage:', err);
        throw err;
      }
    },
    [refreshImageList],
  );

  return {
    handleStartPanorama,
    handleSavePanorama,
    handleStartHdr,
    handleSaveHdr,
    handleApplyDenoise,
    handleBatchDenoise,
    handleSaveDenoisedImage,
    handleSaveCollage,
  };
}
