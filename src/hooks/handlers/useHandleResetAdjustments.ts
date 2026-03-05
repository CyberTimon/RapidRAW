import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { useDebouncedSetHistory } from './useDebouncedSetHistory';

export function useHandleResetAdjustments() {
  const {
    multiSelectedPaths,
    libraryActivePath,
    selectedImage,
    history,
    setLibraryActiveAdjustments,
    adjustments,
    setError,
  } = useAppState();
  const { resetHistory: resetAdjustmentsHistory } = history;
  const debouncedSetHistory = useDebouncedSetHistory();

  const handleResetAdjustments = useCallback(
    (paths?: Array<string>) => {
      const pathsToReset = paths || multiSelectedPaths;
      if (pathsToReset.length === 0) {
        return;
      }

      debouncedSetHistory.cancel();

      invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset })
        .then(() => {
          if (libraryActivePath && pathsToReset.includes(libraryActivePath)) {
            setLibraryActiveAdjustments((prev: Adjustments) => ({ ...INITIAL_ADJUSTMENTS, rating: prev.rating }));
          }
          if (selectedImage && pathsToReset.includes(selectedImage.path)) {
            const currentRating = adjustments.rating;

            const originalAspectRatio =
              selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;

            resetAdjustmentsHistory({
              ...INITIAL_ADJUSTMENTS,
              aspectRatio: originalAspectRatio,
              rating: currentRating,
              aiPatches: [],
            });
          }
        })
        .catch((err) => {
          console.error('Failed to reset adjustments:', err);
          setError(`Failed to reset adjustments: ${err}`);
        });
    },
    [
      multiSelectedPaths,
      libraryActivePath,
      selectedImage,
      adjustments.rating,
      resetAdjustmentsHistory,
      debouncedSetHistory,
    ],
  );

  return handleResetAdjustments;
}
