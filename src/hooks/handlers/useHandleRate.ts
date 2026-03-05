import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { Adjustments } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { useSetAdjustments } from './useSetAdjustments';

export function useHandleRate() {
  const {
    multiSelectedPaths,
    selectedImage,
    libraryActivePath,
    adjustments,
    libraryActiveAdjustments,
    setImageRatings,
    setError,
    setLibraryActiveAdjustments,
  } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleRate = useCallback(
    (newRating: number, paths?: Array<string>) => {
      const pathsToRate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToRate.length === 0) {
        return;
      }

      let currentRating = 0;
      if (selectedImage && pathsToRate.includes(selectedImage.path)) {
        currentRating = adjustments.rating;
      } else if (libraryActivePath && pathsToRate.includes(libraryActivePath)) {
        currentRating = libraryActiveAdjustments.rating;
      }

      const finalRating = newRating === currentRating ? 0 : newRating;

      setImageRatings((prev: Record<string, number>) => {
        const newRatings = { ...prev };
        pathsToRate.forEach((path: string) => {
          newRatings[path] = finalRating;
        });
        return newRatings;
      });

      if (selectedImage && pathsToRate.includes(selectedImage.path)) {
        setAdjustments((prev: Adjustments) => ({ ...prev, rating: finalRating }));
      }

      if (libraryActivePath && pathsToRate.includes(libraryActivePath)) {
        setLibraryActiveAdjustments((prev) => ({ ...prev, rating: finalRating }));
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToRate, adjustments: { rating: finalRating } }).catch(
        (err) => {
          console.error('Failed to apply rating to paths:', err);
          setError(`Failed to apply rating: ${err}`);
        },
      );
    },
    [
      multiSelectedPaths,
      selectedImage,
      libraryActivePath,
      adjustments.rating,
      libraryActiveAdjustments.rating,
      setAdjustments,
    ],
  );

  return handleRate;
}
