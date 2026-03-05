import { invoke } from '@tauri-apps/api/core';
import { useAppState } from '../../context/ContextProviders';
import { Invokes } from '../../components/ui/AppProperties';
import { useRefreshAllFolderTrees } from './useRefreshAllFolderTrees';

export function useHandleCreateFolder() {
  const { folderActionTarget, setError } = useAppState();
  const refreshAllFolderTrees = useRefreshAllFolderTrees();

  const handleCreateFolder = async (folderName: string) => {
    if (folderName && folderName.trim() !== '' && folderActionTarget) {
      try {
        await invoke(Invokes.CreateFolder, { path: `${folderActionTarget}/${folderName.trim()}` });
        refreshAllFolderTrees();
      } catch (err) {
        setError(`Failed to create folder: ${err}`);
      }
    }
  };

  return handleCreateFolder;
}
