import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { INITIAL_ADJUSTMENTS } from '../../utils/adjustments';

export function useHandleBackToLibrary() {
  const {
    selectedImage,
    setSelectedImage,
    setFinalPreviewUrl,
    setUncroppedAdjustedPreviewUrl,
    setHistogram,
    setWaveform,
    setIsWaveformVisible,
    setActiveMaskId,
    setActiveMaskContainerId,
    setActiveAiPatchContainerId,
    setIsWbPickerActive,
    setActiveAiSubMaskId,
    setLibraryActivePath,
    setSlideDirection,
    setAdjustments,
    history,
  } = useAppState();

  const { resetHistory } = history;

  const handleBackToLibrary = useCallback(() => {
    const lastActivePath = selectedImage?.path ?? null;
    setSelectedImage(null);
    setFinalPreviewUrl(null);
    setUncroppedAdjustedPreviewUrl(null);
    setHistogram(null);
    setWaveform(null);
    setIsWaveformVisible(false);
    setActiveMaskId(null);
    setActiveMaskContainerId(null);
    setActiveAiPatchContainerId(null);
    setIsWbPickerActive(false);
    setActiveAiSubMaskId(null);
    setLibraryActivePath(lastActivePath);
    setSlideDirection(1);
    setAdjustments(INITIAL_ADJUSTMENTS);
    resetHistory(INITIAL_ADJUSTMENTS);
  }, [selectedImage?.path]);

  return handleBackToLibrary;
}
