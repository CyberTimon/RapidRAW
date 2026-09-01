import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useProcessStore } from '../store/useProcessStore';
import { useUIStore } from '../store/useUIStore';
import {
  Adjustments,
  INITIAL_ADJUSTMENTS,
  COPYABLE_ADJUSTMENT_KEYS,
  PasteMode,
  LensAdjustment,
  normalizeLoadedAdjustments,
} from '../utils/adjustments';
import { calculateCenteredCrop, guidedCropToPixelCrop } from '../utils/cropUtils';
import { Invokes, Panel } from '../components/ui/AppProperties';
import { globalImageCache } from '../utils/ImageLRUCache';

export const debouncedSetHistory = debounce((newAdj: Adjustments) => {
  useEditorStore.getState().pushHistory(newAdj);
}, 500);

export const debouncedSave = debounce((path: string, adjustmentsToSave: Adjustments) => {
  invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments: adjustmentsToSave }).catch((err) => {
    console.error('Auto-save failed:', err);
    toast.error(`Failed to save changes: ${err}`);
  });
}, 300);

export function useEditorActions() {
  const { t } = useTranslation();
  const setEditor = useEditorStore((s) => s.setEditor);

  const setAdjustments = useCallback(
    (value: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => {
      setEditor((state) => {
        const prev = state.adjustments;
        const newAdjustments = typeof value === 'function' ? value(prev) : { ...prev, ...value };
        debouncedSetHistory(newAdjustments);
        return {
          adjustments: newAdjustments,
          ...(state.showOriginal ? { showOriginal: false, previewOverride: null } : {}),
        };
      });
    },
    [setEditor],
  );

  const handleRotate = useCallback(
    (degrees: number) => {
      const { selectedImage, adjustments } = useEditorStore.getState();
      const increment = degrees > 0 ? 1 : 3;
      const newAspectRatio =
        adjustments.aspectRatio && adjustments.aspectRatio !== 0 ? 1 / adjustments.aspectRatio : null;
      const newOrientationSteps = ((adjustments.orientationSteps || 0) + increment) % 4;
      const newCrop =
        selectedImage?.width && selectedImage?.height
          ? calculateCenteredCrop(selectedImage.width, selectedImage.height, newOrientationSteps, newAspectRatio)
          : null;

      setAdjustments((prev) => ({
        ...prev,
        aspectRatio: newAspectRatio,
        orientationSteps: newOrientationSteps,
        rotation: 0,
        crop: newCrop,
      }));
    },
    [setAdjustments],
  );

  const handleAutoAdjustments = useCallback(async () => {
    const selectedImage = useEditorStore.getState().selectedImage;
    if (!selectedImage?.isReady) return;
    try {
      const autoAdjustments: Adjustments = await invoke(Invokes.CalculateAutoAdjustments);
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...autoAdjustments,
        sectionVisibility: { ...prev.sectionVisibility, ...autoAdjustments.sectionVisibility },
      }));
    } catch (err) {
      toast.error(`Failed to apply auto adjustments: ${err}`);
    }
  }, [setAdjustments]);

  const toggleShowOriginal = useCallback(() => {
    setEditor((state) => {
      const isShowing = !state.showOriginal;

      if (isShowing) {
        const override = { ...INITIAL_ADJUSTMENTS };
        const geometryKeys: Array<keyof Adjustments> = [
          'crop',
          'rotation',
          'flipHorizontal',
          'flipVertical',
          'orientationSteps',
          'aspectRatio',
          'transformDistortion',
          'transformVertical',
          'transformHorizontal',
          'transformRotate',
          'transformAspect',
          'transformScale',
          'transformXOffset',
          'transformYOffset',
          'lensDistortionAmount',
          'lensVignetteAmount',
          'lensTcaAmount',
          'lensDistortionParams',
          'lensMaker',
          'lensModel',
          'lensDistortionEnabled',
          'lensTcaEnabled',
          'lensVignetteEnabled',
          'guidedPerspective',
        ];

        geometryKeys.forEach((key) => {
          (override as any)[key] = state.adjustments[key];
        });

        return { showOriginal: true, previewOverride: override };
      } else {
        return { showOriginal: false, previewOverride: null };
      }
    });
  }, [setEditor]);

  const handleLutSelect = useCallback(
    async (path: string, isBuiltIn: boolean = false) => {
      const isAndroid = useSettingsStore.getState().osPlatform === 'android';
      try {
        const result: { size: number } = await invoke('load_and_parse_lut', { path });
        const name =
          isAndroid && path.startsWith('content://')
            ? await invoke<string>('resolve_android_content_uri_name', { uriStr: path })
            : path.split(/[\\/]/).pop() || 'LUT';
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          lutPath: path,
          lutName: name,
          lutSize: result.size,
          lutIntensity: 100,
          lutIsSceneReferred: isBuiltIn,
          sectionVisibility: {
            ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
            effects: true,
          },
        }));
      } catch (err) {
        toast.error(`Failed to load LUT: ${err}`);
      }
    },
    [setAdjustments],
  );

  const setLutPreviewOverride = useCallback(
    (path: string | null, isBuiltIn: boolean = false) => {
      setEditor((state) => {
        if (!path) return { previewOverride: null };
        const name = path.split(/[\\/]/).pop() || 'LUT';
        return {
          previewOverride: {
            ...state.adjustments,
            lutPath: path,
            lutName: name,
            lutIntensity: state.adjustments.lutIntensity,
            lutIsSceneReferred: isBuiltIn,
          },
        };
      });
    },
    [setEditor],
  );

  const handleResetAdjustments = useCallback(
    (paths?: string[]) => {
      const { multiSelectedPaths, libraryActivePath, setLibrary } = useLibraryStore.getState();
      const { selectedImage, resetHistory } = useEditorStore.getState();
      const pathsToReset = paths || multiSelectedPaths;
      if (pathsToReset.length === 0) return;

      pathsToReset.forEach((p) => globalImageCache.delete(p));
      debouncedSetHistory.cancel();

      invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset })
        .then(() => {
          if (libraryActivePath && pathsToReset.includes(libraryActivePath))
            setLibrary({ libraryActiveAdjustments: { ...INITIAL_ADJUSTMENTS } });
          if (selectedImage && pathsToReset.includes(selectedImage.path)) {
            const aspect =
              selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;
            const resetData = { ...INITIAL_ADJUSTMENTS, aspectRatio: aspect, aiPatches: [] };
            resetHistory(resetData);
            setEditor({ adjustments: resetData });
          }
        })
        .catch((err) => toast.error(`Failed to reset adjustments: ${err}`));
    },
    [setEditor],
  );

  const handleCopyAdjustments = useCallback(async (pathOrEvent?: string | any) => {
    const pathOverride = typeof pathOrEvent === 'string' ? pathOrEvent : undefined;
    const { selectedImage, adjustments } = useEditorStore.getState();
    const { libraryActivePath, multiSelectedPaths } = useLibraryStore.getState();
    let sourceAdjustments: any = null;

    const pathToCopyFrom =
      pathOverride || (selectedImage ? selectedImage.path : libraryActivePath || multiSelectedPaths[0]);

    if (selectedImage && pathToCopyFrom === selectedImage.path) {
      sourceAdjustments = adjustments;
    } else if (pathToCopyFrom) {
      try {
        const meta: any = await invoke(Invokes.LoadMetadata, { path: pathToCopyFrom });
        if (meta?.adjustments && !meta.adjustments.is_null) {
          sourceAdjustments = normalizeLoadedAdjustments(meta.adjustments);
        } else {
          sourceAdjustments = INITIAL_ADJUSTMENTS;
        }
      } catch (err) {
        toast.error(`Failed to load metadata for copying: ${err}`);
        return;
      }
    }

    if (!sourceAdjustments) return;

    const adjustmentsToCopy: any = {};

    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
        adjustmentsToCopy[key] = structuredClone(sourceAdjustments[key]);
      }
    }
    useEditorStore.getState().setEditor({ copiedAdjustments: adjustmentsToCopy });
    useProcessStore.getState().setProcess({ isCopied: true });
  }, []);

  const handlePasteAdjustments = useCallback(
    (paths?: string[]) => {
      const { copiedAdjustments, selectedImage, adjustments } = useEditorStore.getState();
      const { multiSelectedPaths } = useLibraryStore.getState();
      const { appSettings } = useSettingsStore.getState();
      const { setProcess } = useProcessStore.getState();

      if (!copiedAdjustments || !appSettings) return;

      const { mode, includedAdjustments } = appSettings.copyPasteSettings;
      const adjustmentsToApply: Partial<Adjustments> = {};

      for (const key of includedAdjustments) {
        if (Object.prototype.hasOwnProperty.call(copiedAdjustments, key)) {
          const value = copiedAdjustments[key as keyof Adjustments];
          if (mode === PasteMode.Merge) {
            const defaultValue = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            if (JSON.stringify(value) !== JSON.stringify(defaultValue))
              adjustmentsToApply[key as keyof Adjustments] = value;
          } else {
            adjustmentsToApply[key as keyof Adjustments] = value;
          }
        }
      }

      if (includedAdjustments.includes(LensAdjustment.LensMaker)) {
        if (!adjustmentsToApply.lensMaker) {
          adjustmentsToApply.lensDistortionParams = null;
        }
      }

      if (Object.keys(adjustmentsToApply).length === 0) {
        setProcess({ isPasted: true });
        return;
      }

      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) return;

      pathsToUpdate.forEach((p) => globalImageCache.delete(p));

      if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
        setAdjustments({ ...adjustments, ...adjustmentsToApply });
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToUpdate, adjustments: adjustmentsToApply })
        .then(() => {
          if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
            invoke('load_metadata', { path: selectedImage.path }).then((meta: any) => {
              if (meta.adjustments) {
                setAdjustments((prev: any) => ({
                  ...prev,
                  lensMaker: meta.adjustments.lensMaker,
                  lensModel: meta.adjustments.lensModel,
                  lensDistortionParams: meta.adjustments.lensDistortionParams,
                }));
              }
            });
          }
        })
        .catch((err) => toast.error(`Failed to paste adjustments: ${err}`));

      setProcess({ isPasted: true });
    },
    [setAdjustments],
  );

  const handleZoomChange = useCallback((zoomValue: number, fitToWindow: boolean = false) => {
    const { originalSize, baseRenderSize, adjustments } = useEditorStore.getState();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    let targetZoomPercent: number;

    const orientationSteps = adjustments.orientationSteps || 0;
    const isSwapped = orientationSteps === 1 || orientationSteps === 3;
    const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;
    const effectiveOriginalHeight = isSwapped ? originalSize.width : originalSize.height;

    if (fitToWindow) {
      if (
        effectiveOriginalWidth > 0 &&
        effectiveOriginalHeight > 0 &&
        baseRenderSize.width > 0 &&
        baseRenderSize.height > 0
      ) {
        const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
        const baseAspect = baseRenderSize.width / baseRenderSize.height;
        targetZoomPercent =
          originalAspect > baseAspect
            ? baseRenderSize.width / effectiveOriginalWidth
            : baseRenderSize.height / effectiveOriginalHeight;
      } else {
        targetZoomPercent = 1.0;
      }
    } else {
      targetZoomPercent = zoomValue / dpr;
    }

    targetZoomPercent = Math.max(0.1 / dpr, Math.min(2.0, targetZoomPercent));

    let transformZoom = 1.0;
    if (
      effectiveOriginalWidth > 0 &&
      effectiveOriginalHeight > 0 &&
      baseRenderSize.width > 0 &&
      baseRenderSize.height > 0
    ) {
      const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
      const baseAspect = baseRenderSize.width / baseRenderSize.height;
      if (originalAspect > baseAspect) {
        transformZoom = (targetZoomPercent * effectiveOriginalWidth) / baseRenderSize.width;
      } else {
        transformZoom = (targetZoomPercent * effectiveOriginalHeight) / baseRenderSize.height;
      }
    }
    useEditorStore.getState().setEditor({ zoom: transformZoom });
  }, []);

  const handleEnterGuided = useCallback(() => {
    const { adjustments } = useEditorStore.getState();
    const committed = adjustments.guidedPerspective;
    useUIStore.getState().setPanel(Panel.Crop);
    setEditor({
      isGuidedPerspectiveActive: true,
      guidedLines: committed?.lines ? structuredClone(committed.lines) : [],
      selectedGuideLineId: null,
      guidedResult: null,
      guidedPreviewUrl: null,
      guidedAutoCrop: committed?.autoCrop ?? true,
      isStraightenActive: false,
      isRotationActive: false,
      isWbPickerActive: false,
      activeMaskId: null,
      activeMaskContainerId: null,
    });
  }, [setEditor]);

  const handleCancelGuided = useCallback(() => {
    setEditor({
      isGuidedPerspectiveActive: false,
      guidedLines: [],
      selectedGuideLineId: null,
      guidedResult: null,
      guidedPreviewUrl: null,
    });
  }, [setEditor]);

  const handleApplyGuided = useCallback(() => {
    const { guidedLines, guidedResult, guidedAutoCrop, selectedImage } = useEditorStore.getState();
    if (!guidedResult?.valid) {
      toast.error(t('editor.guided.toast.needTwoLines'));
      return;
    }
    const [_cx, _cy, cw, ch] = guidedResult.crop;
    if (cw * ch < 0.5) {
      toast.warn(t('editor.guided.toast.aggressiveCrop'));
    }
    setAdjustments((prev) => {
      const next: Adjustments = {
        ...prev,
        transformVertical: 0,
        transformHorizontal: 0,
        transformRotate: 0,
        transformDistortion: 0,
        transformScale: 100,
        transformAspect: 0,
        transformXOffset: 0,
        transformYOffset: 0,
        guidedPerspective: { enabled: true, lines: guidedLines, autoCrop: guidedAutoCrop },
      };
      if (guidedAutoCrop && selectedImage?.width && selectedImage?.height) {
        next.crop = guidedCropToPixelCrop(guidedResult.crop, prev, selectedImage);
      }
      return next;
    });
    handleCancelGuided();
  }, [setAdjustments, handleCancelGuided, t]);

  return {
    setAdjustments,
    handleRotate,
    handleAutoAdjustments,
    handleLutSelect,
    setLutPreviewOverride,
    handleResetAdjustments,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleZoomChange,
    toggleShowOriginal,
    handleEnterGuided,
    handleCancelGuided,
    handleApplyGuided,
  };
}
