import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useSortedImageList } from '../useSortedImageList';
import { invoke } from '@tauri-apps/api/core';
import { useRefreshImageList } from './useRefreshImageList';
import { useHandleImageSelect } from './useHandleImageSelect';
import { useHandleBackToLibrary } from './useHandleBackToLibrary';

export function useExecuteDelete() {
  const { selectedImage, libraryActivePath, setMultiSelectedPaths, setLibraryActivePath, setError } = useAppState();
  const { sortedImageList } = useSortedImageList();
  const refreshImageList = useRefreshImageList();
  const handleImageSelect = useHandleImageSelect();
  const handleBackToLibrary = useHandleBackToLibrary();

  const executeDelete = useCallback(
    async (pathsToDelete: Array<string>, options = { includeAssociated: false }) => {
      if (!pathsToDelete || pathsToDelete.length === 0) {
        return;
      }

      const activePath = selectedImage ? selectedImage.path : libraryActivePath;
      let nextImagePath: string | null = null;

      if (activePath) {
        const physicalPath = activePath.split('?vc=')[0];
        const isActiveImageDeleted = pathsToDelete.some((p) => p === activePath || p === physicalPath);

        if (isActiveImageDeleted) {
          const currentIndex = sortedImageList.findIndex((img) => img.path === activePath);
          if (currentIndex !== -1) {
            const nextCandidate = sortedImageList
              .slice(currentIndex + 1)
              .find((img) => !pathsToDelete.includes(img.path));

            if (nextCandidate) {
              nextImagePath = nextCandidate.path;
            } else {
              const prevCandidate = sortedImageList
                .slice(0, currentIndex)
                .reverse()
                .find((img) => !pathsToDelete.includes(img.path));

              if (prevCandidate) {
                nextImagePath = prevCandidate.path;
              }
            }
          }
        } else {
          nextImagePath = activePath;
        }
      }

      try {
        const command = options.includeAssociated ? 'delete_files_with_associated' : 'delete_files_from_disk';
        await invoke(command, { paths: pathsToDelete });

        await refreshImageList();

        if (selectedImage) {
          const physicalPath = selectedImage.path.split('?vc=')[0];
          const isFileBeingEditedDeleted = pathsToDelete.some((p) => p === selectedImage.path || p === physicalPath);

          if (isFileBeingEditedDeleted) {
            if (nextImagePath) {
              handleImageSelect(nextImagePath);
            } else {
              handleBackToLibrary();
            }
          }
        } else {
          if (nextImagePath) {
            setMultiSelectedPaths([nextImagePath]);
            setLibraryActivePath(nextImagePath);
          } else {
            setMultiSelectedPaths([]);
            setLibraryActivePath(null);
          }
        }
      } catch (err) {
        console.error('Failed to delete files:', err);
        setError(`Failed to delete files: ${err}`);
      }
    },
    [refreshImageList, selectedImage, handleBackToLibrary, libraryActivePath, sortedImageList, handleImageSelect],
  );

  return executeDelete;
}
