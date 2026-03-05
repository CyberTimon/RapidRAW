import { useCallback } from 'react';
import { COPYABLE_ADJUSTMENT_KEYS } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';

export function useHandleCopyAdjustments() {
  const { selectedImage, adjustments, libraryActiveAdjustments, setCopiedAdjustments, setIsCopied } = useAppState();

  const handleCopyAdjustments = useCallback(() => {
    const sourceAdjustments = selectedImage ? adjustments : libraryActiveAdjustments;
    const adjustmentsToCopy: any = {};
    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
        adjustmentsToCopy[key] = sourceAdjustments[key];
      }
    }
    setCopiedAdjustments(adjustmentsToCopy);
    setIsCopied(true);
  }, [selectedImage, adjustments, libraryActiveAdjustments]);

  return handleCopyAdjustments;
}
