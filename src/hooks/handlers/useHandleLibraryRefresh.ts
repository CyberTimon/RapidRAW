import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useHandleSelectSubfolder } from './useHandleSelectSubfolder';

export function useHandleLibraryRefresh() {
  const { currentFolderPath } = useAppState();
  const handleSelectSubfolder = useHandleSelectSubfolder();

  const handleLibraryRefresh = useCallback(() => {
    if (currentFolderPath) handleSelectSubfolder(currentFolderPath, false);
  }, [currentFolderPath, handleSelectSubfolder]);

  return handleLibraryRefresh;
}
