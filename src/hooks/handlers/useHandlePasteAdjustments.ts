import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { Adjustments, PasteMode, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { useSetAdjustments } from './useSetAdjustments';

export function useHandlePasteAdjustments() {
  const { copiedAdjustments, appSettings, setIsPasted, multiSelectedPaths, selectedImage, adjustments, setError } =
    useAppState();

  const setAdjustments = useSetAdjustments();

  const handlePasteAdjustments = useCallback(
    (paths?: Array<string>) => {
      if (!copiedAdjustments || !appSettings) {
        return;
      }

      const { mode, includedAdjustments } = appSettings.copyPasteSettings;

      const adjustmentsToApply: Partial<Adjustments> = {};

      for (const key of includedAdjustments) {
        if (Object.prototype.hasOwnProperty.call(copiedAdjustments, key)) {
          const value = copiedAdjustments[key as keyof Adjustments];

          if (mode === PasteMode.Merge) {
            const defaultValue = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
              adjustmentsToApply[key as keyof Adjustments] = value;
            }
          } else {
            adjustmentsToApply[key as keyof Adjustments] = value;
          }
        }
      }

      if (Object.keys(adjustmentsToApply).length === 0) {
        setIsPasted(true);
        return;
      }

      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) {
        return;
      }

      if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
        const newAdjustments = { ...adjustments, ...adjustmentsToApply };
        setAdjustments(newAdjustments);
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToUpdate, adjustments: adjustmentsToApply }).catch(
        (err) => {
          console.error('Failed to paste adjustments to multiple images:', err);
          setError(`Failed to paste adjustments: ${err}`);
        },
      );
      setIsPasted(true);
    },
    [copiedAdjustments, appSettings, multiSelectedPaths, selectedImage, adjustments, setAdjustments],
  );

  return handlePasteAdjustments;
}
