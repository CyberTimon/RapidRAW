import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useHandleRenameFiles() {
  const { setRenameTargetPaths, setIsRenameFileModalOpen } = useAppState();

  const handleRenameFiles = useCallback(async (paths: Array<string>) => {
    if (paths && paths.length > 0) {
      setRenameTargetPaths(paths);
      setIsRenameFileModalOpen(true);
    }
  }, []);

  return handleRenameFiles;
}
