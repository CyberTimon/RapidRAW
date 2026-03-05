import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useHandleToggleFolder() {
  const { setExpandedFolders } = useAppState();

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  }, []);

  return handleToggleFolder;
}
