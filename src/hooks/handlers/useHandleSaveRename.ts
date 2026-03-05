import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useHandleImageSelect } from './useHandleImageSelect';
import { useHandleBackToLibrary } from './useHandleBackToLibrary';
import { useRefreshImageList } from './useRefreshImageList';

export function useHandleSaveRename() {
  const {
    renameTargetPaths,
    selectedImage,
    libraryActivePath,
    setLibraryActivePath,
    setMultiSelectedPaths,
    setError,
    setRenameTargetPaths,
  } = useAppState();

  const handleImageSelect = useHandleImageSelect();
  const handleBackToLibrary = useHandleBackToLibrary();
  const refreshImageList = useRefreshImageList();

  const handleSaveRename = useCallback(
    async (nameTemplate: string) => {
      if (renameTargetPaths.length > 0 && nameTemplate) {
        try {
          const newPaths: Array<string> = await invoke(Invokes.RenameFiles, {
            nameTemplate,
            paths: renameTargetPaths,
          });

          await refreshImageList();

          if (selectedImage && renameTargetPaths.includes(selectedImage.path)) {
            const oldPathIndex = renameTargetPaths.indexOf(selectedImage.path);

            if (newPaths[oldPathIndex]) {
              handleImageSelect(newPaths[oldPathIndex]);
            } else {
              handleBackToLibrary();
            }
          }

          if (libraryActivePath && renameTargetPaths.includes(libraryActivePath)) {
            const oldPathIndex = renameTargetPaths.indexOf(libraryActivePath);

            if (newPaths[oldPathIndex]) {
              setLibraryActivePath(newPaths[oldPathIndex]);
            } else {
              setLibraryActivePath(null);
            }
          }

          setMultiSelectedPaths(newPaths);
        } catch (err) {
          setError(`Failed to rename files: ${err}`);
        }
      }

      setRenameTargetPaths([]);
    },
    [renameTargetPaths, refreshImageList, selectedImage, libraryActivePath, handleImageSelect, handleBackToLibrary],
  );

  return handleSaveRename;
}
