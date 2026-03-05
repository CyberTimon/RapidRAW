import { invoke } from '@tauri-apps/api/core';
import { PinOff, Pin, FolderPlus, FileEdit, ClipboardPaste, FolderInput, Folder, Trash2, X, Check } from 'lucide-react';
import { OPTION_SEPARATOR, Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useHandleTogglePinFolder } from './useHandleTogglePinFolder';
import { useContextMenu } from '../../context/ContextMenuContext';
import { useRefreshAllFolderTrees } from './useRefreshAllFolderTrees';
import { useHandleSelectSubfolder } from './useHandleSelectSubfolder';
import { useHandleImportClick } from './useHandleImportClick';
import { useHandleLibraryRefresh } from './useHandleLibraryRefresh';

export function useHandleFolderTreeContextMenu() {
  const {
    rootPath,
    copiedFilePaths,
    setFolderActionTarget,
    setIsCreateFolderModalOpen,
    setError,
    currentFolderPath,
    setMultiSelectedPaths,
    setCopiedFilePaths,
    setIsRenameFolderModalOpen,
  } = useAppState();

  const { showContextMenu } = useContextMenu();

  const handleTogglePinFolder = useHandleTogglePinFolder();
  const refreshAllFolderTrees = useRefreshAllFolderTrees();
  const handleSelectSubfolder = useHandleSelectSubfolder();
  const handleImportClick = useHandleImportClick();
  const handleLibraryRefresh = useHandleLibraryRefresh();

  const handleFolderTreeContextMenu = (event: any, path: string, isCurrentlyPinned?: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const targetPath = path || rootPath;
    if (!targetPath) {
      return;
    }
    const isRoot = targetPath === rootPath;
    const numCopied = copiedFilePaths.length;
    const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
    const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

    const pinOption = isCurrentlyPinned
      ? {
          icon: PinOff,
          label: 'Unpin Folder',
          onClick: () => handleTogglePinFolder(targetPath),
        }
      : {
          icon: Pin,
          label: 'Pin Folder',
          onClick: () => handleTogglePinFolder(targetPath),
        };

    const options = [
      pinOption,
      { type: OPTION_SEPARATOR },
      {
        icon: FolderPlus,
        label: 'New Folder',
        onClick: () => {
          setFolderActionTarget(targetPath);
          setIsCreateFolderModalOpen(true);
        },
      },
      {
        disabled: isRoot,
        icon: FileEdit,
        label: 'Rename Folder',
        onClick: () => {
          setFolderActionTarget(targetPath);
          setIsRenameFolderModalOpen(true);
        },
      },
      { type: OPTION_SEPARATOR },
      {
        disabled: copiedFilePaths.length === 0,
        icon: ClipboardPaste,
        label: 'Paste',
        submenu: [
          {
            label: copyPastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                if (targetPath === currentFolderPath) handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to copy files: ${err}`);
              }
            },
          },
          {
            label: movePastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                setCopiedFilePaths([]);
                setMultiSelectedPaths([]);
                refreshAllFolderTrees();
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to move files: ${err}`);
              }
            },
          },
        ],
      },
      { icon: FolderInput, label: 'Import Images', onClick: () => handleImportClick(targetPath) },
      { type: OPTION_SEPARATOR },
      {
        icon: Folder,
        label: 'Show in File Explorer',
        onClick: () =>
          invoke(Invokes.ShowInFinder, { path: targetPath }).catch((err) => setError(`Could not show folder: ${err}`)),
      },
      ...(path
        ? [
            {
              disabled: isRoot,
              icon: Trash2,
              isDestructive: true,
              label: 'Delete Folder',
              submenu: [
                { label: 'Cancel', icon: X, onClick: () => {} },
                {
                  label: 'Confirm',
                  icon: Check,
                  isDestructive: true,
                  onClick: async () => {
                    try {
                      await invoke(Invokes.DeleteFolder, { path: targetPath });
                      if (currentFolderPath?.startsWith(targetPath)) await handleSelectSubfolder(rootPath);
                      refreshAllFolderTrees();
                    } catch (err) {
                      setError(`Failed to delete folder: ${err}`);
                    }
                  },
                },
              ],
            },
          ]
        : []),
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  return handleFolderTreeContextMenu;
}
