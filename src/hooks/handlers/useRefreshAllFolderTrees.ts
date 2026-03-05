import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';

export function useRefreshAllFolderTrees() {
  const { rootPath, setFolderTree, setError, appSettings, setPinnedFolderTrees } = useAppState();

  const refreshAllFolderTrees = useCallback(async () => {
    if (rootPath) {
      try {
        const treeData = await invoke(Invokes.GetFolderTree, { path: rootPath });
        setFolderTree(treeData);
      } catch (err) {
        console.error('Failed to refresh main folder tree:', err);
        setError(`Failed to refresh folder tree: ${err}.`);
      }
    }

    const currentPins = appSettings?.pinnedFolders || [];
    if (currentPins.length > 0) {
      try {
        const trees = await invoke(Invokes.GetPinnedFolderTrees, { paths: currentPins });
        setPinnedFolderTrees(trees);
      } catch (err) {
        console.error('Failed to refresh pinned folder trees:', err);
      }
    }
  }, [rootPath, appSettings?.pinnedFolders]);

  return refreshAllFolderTrees;
}
