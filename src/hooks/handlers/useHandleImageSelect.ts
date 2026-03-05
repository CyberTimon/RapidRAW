import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useDebouncedSave } from './useDebounce';
import { INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useApplyAdjustments } from './useApplyAdjustments';

export function useHandleImageSelect() {
  const {
    selectedImage,
    patchesSentToBackend,
    imageRatings,
    setAdjustments,
    history,
    setSelectedImage,
    thumbnails,
    setOriginalSize,
    setPreviewSize,
    setMultiSelectedPaths,
    setLibraryActivePath,
    setIsViewLoading,
    setError,
    setHistogram,
    setFinalPreviewUrl,
    setUncroppedAdjustedPreviewUrl,
    setTransformedOriginalUrl,
    setShowOriginal,
    setActiveMaskId,
    setActiveMaskContainerId,
    setActiveAiPatchContainerId,
    setActiveAiSubMaskId,
    setIsWbPickerActive,
    setIsHighResNeeded,
    transformWrapperRef,
    setZoom,
    setIsLibraryExportPanelVisible,
    fullResCacheKeyRef,
  } = useAppState();
  const { resetHistory } = history;
  const debouncedSave = useDebouncedSave();
  const applyAdjustments = useApplyAdjustments();

  const handleImageSelect = useCallback(
    (path: string) => {
      if (selectedImage?.path === path) {
        return;
      }
      debouncedSave.cancel();
      patchesSentToBackend.current.clear();

      const knownRating = imageRatings[path] ?? 0;
      const placeholderAdjustments = {
        ...INITIAL_ADJUSTMENTS,
        rating: knownRating,
      };

      setAdjustments(placeholderAdjustments);
      resetHistory(placeholderAdjustments);

      setSelectedImage({
        exif: null,
        height: 0,
        isRaw: false,
        isReady: false,
        metadata: null,
        originalUrl: null,
        path,
        thumbnailUrl: thumbnails[path],
        width: 0,
      });
      setOriginalSize({ width: 0, height: 0 });
      setPreviewSize({ width: 0, height: 0 });
      setMultiSelectedPaths([path]);
      setLibraryActivePath(null);
      setIsViewLoading(true);
      setError(null);
      setHistogram(null);
      setFinalPreviewUrl(null);
      setUncroppedAdjustedPreviewUrl(null);
      setTransformedOriginalUrl(null);
      setShowOriginal(false);
      setActiveMaskId(null);
      setActiveMaskContainerId(null);
      setActiveAiPatchContainerId(null);
      setActiveAiSubMaskId(null);
      setIsWbPickerActive(false);
      setIsHighResNeeded(false);

      if (transformWrapperRef.current) {
        transformWrapperRef.current.resetTransform(0);
      }

      setZoom(1);
      setIsLibraryExportPanelVisible(false);

      fullResCacheKeyRef.current = null;
      setFinalPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
    },
    [selectedImage?.path, applyAdjustments, debouncedSave, thumbnails, imageRatings, resetHistory],
  );

  return handleImageSelect;
}
