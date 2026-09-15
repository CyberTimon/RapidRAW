import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../store/useUIStore';
import { Invokes } from '../components/ui/AppProperties';

export function useProductivityActions(refreshImageList: () => Promise<void> = async () => {}) {
  const setUI = useUIStore((state) => state.setUI);

  const handleStartPanorama = useCallback(
    (
      paths: string[],
      projection: 'cylindrical' | 'spherical' | 'planar' = 'cylindrical',
      isHdr: boolean = false,
      boundaryWarp: number = 0.5,
      halfSize: boolean = false,
    ) => {
      setUI((state) => ({
        panoramaModalState: {
          ...state.panoramaModalState,
          isProcessing: true,
          error: null,
          finalImageBase64: null,
          progressMessage: isHdr ? 'Starting HDR Panorama merge & stitch...' : 'Starting panorama process...',
        },
      }));
      const command = isHdr ? Invokes.StitchHdrPanorama : Invokes.StitchPanorama;
      invoke(command, { paths, projection, boundaryWarp, halfSize }).catch((err) => {
        setUI((state) => ({
          panoramaModalState: { ...state.panoramaModalState, isProcessing: false, error: String(err) },
        }));
      });
    },
    [setUI],
  );

  const handleSavePanorama = useCallback(async (format: string = 'jpeg'): Promise<string> => {
    const { panoramaModalState } = useUIStore.getState();
    if (panoramaModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for panorama not found.';
      setUI((state) => ({ panoramaModalState: { ...state.panoramaModalState, error: err } }));
      throw new Error(err);
    }
    try {
      const savedPath: string = await invoke(Invokes.SavePanorama, {
        firstPathStr: panoramaModalState.stitchingSourcePaths[0],
        format,
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save panorama:', err);
      throw err;
    }
  }, [refreshImageList]);

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
    (paths: string[], options?: {
      profile?: 'natural' | 'vivid' | 'interior' | 'dramatic' | 'portra' | 'velvia' | 'cinestill' | 'monochromeHdr';
      deghostSensitivity?: 'off' | 'low' | 'medium' | 'high';
      referenceIndex?: number;
      autoSemantic?: boolean;
      exposureBias?: number;
      highlightRecovery?: number;
      shadowLift?: number;
      detailBoost?: number;
      halfSize?: boolean;
    }) => {
      setUI((state) => ({
        hdrModalState: {
          ...state.hdrModalState,
          isProcessing: true,
          error: null,
          finalImageBase64: null,
          progressMessage: 'Starting HDR process...',
        },
      }));
      invoke(Invokes.MergeHdr, { paths, options }).catch((err) => {
        setUI((state) => ({ hdrModalState: { ...state.hdrModalState, isProcessing: false, error: String(err) } }));
      });
    },
    [setUI],
  );

  const handleSaveHdr = useCallback(async (formatOrSaveAsDng: string | boolean = 'dng', customSuffix?: string): Promise<string> => {
    const { hdrModalState } = useUIStore.getState();
    if (hdrModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for HDR not found.';
      setUI((state) => ({ hdrModalState: { ...state.hdrModalState, error: err } }));
      throw new Error(err);
    }
    try {
      const formatStr = typeof formatOrSaveAsDng === 'string'
        ? formatOrSaveAsDng
        : formatOrSaveAsDng
        ? 'dng'
        : 'tiff';
      const savedPath: string = await invoke(Invokes.SaveHdr, {
        firstPathStr: hdrModalState.stitchingSourcePaths[0],
        format: formatStr,
        saveAsDng: formatStr === 'dng',
        customSuffix: customSuffix ?? undefined,
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save HDR image:', err);
      throw err;
    }
  }, [refreshImageList]);

  const handleApplyDenoise = useCallback(
    async (
      intensity: number,
      method: 'ai' | 'bm3d',
      healDust: boolean = true,
      visualizeDefects: boolean = false,
      protectStars: boolean = true,
      preserveDetails: number = 0.25,
      chromaIntensity: number = 1.0,
      shadowBoost: number = 0.0,
      deband: boolean = false,
      filmGrain: number = 0.0
    ) => {
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
          healDust,
          visualizeDefects,
          protectStars,
          preserveDetails,
          chromaIntensity,
          shadowBoost,
          deband,
          filmGrain,
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
    async (
      intensity: number,
      method: 'ai' | 'bm3d',
      paths: string[],
      healDust: boolean = true,
      protectStars: boolean = true,
      preserveDetails: number = 0.25,
      chromaIntensity: number = 1.0,
      shadowBoost: number = 0.0,
      deband: boolean = false,
      filmGrain: number = 0.0
    ) => {
      try {
        const savedPaths: string[] = await invoke('batch_denoise_images', {
          paths,
          intensity,
          method,
          healDust,
          protectStars,
          preserveDetails,
          chromaIntensity,
          shadowBoost,
          deband,
          filmGrain,
        });
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

  const handleStartStockPhotoPrep = useCallback(
    async (
      paths: string[],
      outputDir: string,
      customOptions?: {
        enableBm3dTriad?: boolean;
        enableReflector?: boolean;
        enableAutoFraming?: boolean;
        enableDustScrubbing?: boolean;
        enableMultiCrop?: boolean;
        enableBlinkGate?: boolean;
        enableAgencyDispatch?: boolean;
      },
    ) => {
      try {
        const result: any = await invoke('batch_stock_photo_prep', {
          options: {
            input_paths: paths,
            output_dir: outputDir,
            format: 'jpg',
            quality: 95,
            enable_bm3d_triad: customOptions?.enableBm3dTriad ?? true,
            enable_reflector: customOptions?.enableReflector ?? true,
            enable_auto_framing: customOptions?.enableAutoFraming ?? true,
            enable_dust_scrubbing: customOptions?.enableDustScrubbing ?? true,
            enable_multi_crop: customOptions?.enableMultiCrop ?? false,
            enable_blink_gate: customOptions?.enableBlinkGate ?? true,
            enable_agency_dispatch: customOptions?.enableAgencyDispatch ?? false,
          },
        });
        if (refreshImageList) await refreshImageList();
        return result;
      } catch (err) {
        console.error('Stock photo auto-prep error:', err);
        throw err;
      }
    },
    [refreshImageList],
  );

  const handleProcessNightSkySession = useCallback(
    async (
      paths: string[],
      options?: {
        freezeGround?: boolean;
        removeLightPollution?: boolean;
        sigmaClip?: number;
        starTrailsMode?: boolean;
        cometDecay?: boolean;
        decayRate?: number;
        fillGaps?: boolean;
        useGpu?: boolean;
      }
    ) => {
      if (paths.length < 2) return;
      setUI((state) => ({
        nightSkyState: {
          ...state.nightSkyState,
          isProcessing: true,
          error: null,
          progressMessage: options?.starTrailsMode ? 'Initializing Star Trails Engine...' : 'Initializing Night Sky Stacker...',
        },
      }));
      try {
        if (options?.starTrailsMode) {
          await invoke('stack_star_trails', {
            paths,
            cometDecay: options?.cometDecay ?? true,
            decayRate: options?.decayRate ?? 0.08,
            fillGaps: options?.fillGaps ?? true,
          });
        } else {
          await invoke('stack_astro_frames', {
            options: {
              paths,
              sigma_clip: options?.sigmaClip ?? 2.5,
              stack_mode: 'kappa_sigma',
              auto_dark_subtract: true,
              remove_light_pollution: options?.removeLightPollution ?? true,
              freeze_ground: options?.freezeGround ?? true,
              use_gpu: options?.useGpu ?? true,
            },
          });
        }
        setUI((state) => ({
          nightSkyState: {
            ...state.nightSkyState,
            isProcessing: false,
            progressMessage: 'Session Stack Complete!',
          },
          hdrModalState: {
            ...state.hdrModalState,
            isOpen: true,
            stitchingSourcePaths: paths,
          },
        }));
      } catch (err) {
        setUI((state) => ({
          nightSkyState: {
            ...state.nightSkyState,
            isProcessing: false,
            error: String(err),
          },
        }));
      }
    },
    [setUI],
  );

  return {
    handleStartPanorama,
    handleSavePanorama,
    handleStartHdr,
    handleSaveHdr,
    handleProcessNightSkySession,
    handleStartStockPhotoPrep,
    handleApplyDenoise,
    handleBatchDenoise,
    handleSaveDenoisedImage,
    handleSaveCollage,
    handleStartFocusStack,
    handleSaveFocusStack,
  };
}
