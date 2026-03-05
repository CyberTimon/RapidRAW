import { invoke } from '@tauri-apps/api/core';
import { ClipboardPaste, FolderInput } from 'lucide-react';
import { Invokes } from '../../components/ui/AppProperties';
import { useContextMenu } from '../../context/ContextMenuContext';
import { useAppState } from '../../context/ContextProviders';
import { useHandleImportClick } from './useHandleImportClick';
import { useHandleLibraryRefresh } from './useHandleLibraryRefresh';
import { useRefreshAllFolderTrees } from './useRefreshAllFolderTrees';

export function useHandleMainLibraryContextMenu() {
  const { copiedFilePaths, currentFolderPath, setError, setMultiSelectedPaths, setCopiedFilePaths } = useAppState();

  const { showContextMenu } = useContextMenu();

  const handleImportClick = useHandleImportClick();
  const handleLibraryRefresh = useHandleLibraryRefresh();
  const refreshAllFolderTrees = useRefreshAllFolderTrees();

  const handleMainLibraryContextMenu = (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    const numCopied = copiedFilePaths.length;
    const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
    const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

    const options = [
      {
        label: 'Paste',
        icon: ClipboardPaste,
        disabled: copiedFilePaths.length === 0,
        submenu: [
          {
            label: copyPastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to copy files: ${err}`);
              }
            },
          },
          {
            label: movePastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
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
      {
        icon: FolderInput,
        label: 'Import Images',
        onClick: () => handleImportClick(currentFolderPath as string),
        disabled: !currentFolderPath,
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  return handleMainLibraryContextMenu;
}
