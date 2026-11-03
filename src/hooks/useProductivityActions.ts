import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../store/useUIStore';
import { Invokes } from '../components/ui/AppProperties';
import { toPanoramaMessage, type PanoramaCropRect, type PanoramaProjection } from '../utils/panorama';

export function useProductivityActions(refreshImageList: () => Promise<void>) {
  const setUI = useUIStore((state) => state.setUI);

  const handleStartPanorama = useCallback(
    (paths: string[]) => {
      setUI((state) => ({
        panoramaModalState: {
          ...state.panoramaModalState,
          isProcessing: true,
          error: null,
          preview: null,
          progressMessage: { code: 'starting' },
        },
      }));
      invoke(Invokes.StitchPanorama, { paths }).catch((err) => {
        setUI((state) => {
          if (!state.panoramaModalState.isOpen) return state;
          return {
            panoramaModalState: {
              ...state.panoramaModalState,
              isProcessing: false,
              error: toPanoramaMessage(err, 'taskFailed'),
            },
          };
        });
      });
    },
    [setUI],
  );

  const handleReprojectPanorama = useCallback(
    (projection: PanoramaProjection) => {
      setUI((state) => ({
        panoramaModalState: {
          ...state.panoramaModalState,
          pendingProjection: projection,
          previewError: null,
          progressMessage: { code: 'reprojecting' },
        },
      }));
      invoke(Invokes.ReprojectPanorama, { projection }).catch((err) => {
        setUI((state) => {
          if (!state.panoramaModalState.isOpen) return state;
          return {
            panoramaModalState: {
              ...state.panoramaModalState,
              pendingProjection: null,
              previewError: toPanoramaMessage(err, 'reprojectFailed'),
            },
          };
        });
      });
    },
    [setUI],
  );

  const handleCancelPanorama = useCallback((keepSession: boolean) => {
    invoke(Invokes.CancelPanorama, { keepSession }).catch(() => {});
  }, []);

  const handleSavePanorama = useCallback(
    async (crop: PanoramaCropRect, quality: number): Promise<string> => {
      try {
        setUI((state) => ({
          panoramaModalState: {
            ...state.panoramaModalState,
            saveProgressPercent: 0,
            saveProgressMessage: null,
            previewError: null,
          },
        }));
        const savedPath: string = await invoke(Invokes.SavePanorama, { crop, quality });
        await refreshImageList();
        setUI((state) => ({
          panoramaModalState: {
            ...state.panoramaModalState,
            saveProgressPercent: null,
            saveProgressMessage: null,
          },
        }));
        return savedPath;
      } catch (err) {
        console.error('Failed to save panorama:', err);
        setUI((state) => {
          if (!state.panoramaModalState.isOpen) return state;
          return {
            panoramaModalState: {
              ...state.panoramaModalState,
              previewError: toPanoramaMessage(err, 'saveFailed'),
              saveProgressPercent: null,
              saveProgressMessage: null,
            },
          };
        });
        throw err;
      }
    },
    [refreshImageList, setUI],
  );

  const handleStartFocusStack = useCallback(
    (paths: string[]) => {
      setUI((state) => ({
        focusStackModalState: {
          ...state.focusStackModalState,
          isProcessing: true,
          error: null,
          finalImageBase64: null,
          depthMapBase64: null,
          progressMessage: 'Starting focus stacking process...',
        },
      }));
      invoke(Invokes.StitchFocusStack, { paths }).catch((err) => {
        setUI((state) => ({
          focusStackModalState: { ...state.focusStackModalState, isProcessing: false, error: String(err) },
        }));
      });
    },
    [setUI],
  );

  const handleSaveFocusStack = useCallback(async (): Promise<string> => {
    const { focusStackModalState } = useUIStore.getState();
    if (focusStackModalState.sourcePaths.length === 0) {
      const err = 'Source paths for focus stack not found.';
      setUI((state) => ({ focusStackModalState: { ...state.focusStackModalState, error: err } }));
      throw new Error(err);
    }
    try {
      const savedPath: string = await invoke(Invokes.SaveFocusStack, {
        firstPathStr: focusStackModalState.sourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save focus stack:', err);
      setUI((state) => ({ focusStackModalState: { ...state.focusStackModalState, error: String(err) } }));
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
    handleReprojectPanorama,
    handleCancelPanorama,
    handleSavePanorama,
    handleStartHdr,
    handleSaveHdr,
    handleSaveCollage,
    handleStartFocusStack,
    handleSaveFocusStack,
  };
}
