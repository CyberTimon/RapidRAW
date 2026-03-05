import { invoke } from '@tauri-apps/api/core';
import { useAppState } from '../../context/ContextProviders';
import { Invokes, AppSettings } from '../../components/ui/AppProperties';
import { getParentDir } from '../../utils/helpers';
import { useHandleSettingsChange } from './useHandleSettingsChange';
import { useRefreshAllFolderTrees } from './useRefreshAllFolderTrees';

export function useHandleRenameFolder() {
  const { setError, folderActionTarget, appSettings, setCurrentFolderPath, currentFolderPath, setRootPath, rootPath } =
    useAppState();

  const handleSettingsChange = useHandleSettingsChange();
  const refreshAllFolderTrees = useRefreshAllFolderTrees();

  const handleRenameFolder = async (newName: string) => {
    if (newName && newName.trim() !== '' && folderActionTarget) {
      try {
        const oldPath = folderActionTarget;
        const trimmedNewName = newName.trim();

        await invoke(Invokes.RenameFolder, { path: oldPath, newName: trimmedNewName });

        const parentDir = getParentDir(oldPath);
        const separator = oldPath.includes('/') ? '/' : '\\';
        const newPath = parentDir ? `${parentDir}${separator}${trimmedNewName}` : trimmedNewName;

        const newAppSettings = { ...appSettings } as AppSettings;
        let settingsChanged = false;

        if (rootPath === oldPath) {
          setRootPath(newPath);
          newAppSettings.lastRootPath = newPath;
          settingsChanged = true;
        }
        if (currentFolderPath?.startsWith(oldPath)) {
          const newCurrentPath = currentFolderPath.replace(oldPath, newPath);
          setCurrentFolderPath(newCurrentPath);
        }

        const currentPins = appSettings?.pinnedFolders || [];
        if (currentPins.includes(oldPath)) {
          const newPins = currentPins.map((p) => (p === oldPath ? newPath : p)).sort((a, b) => a.localeCompare(b));
          newAppSettings.pinnedFolders = newPins;
          settingsChanged = true;
        }

        if (settingsChanged) {
          handleSettingsChange(newAppSettings);
        }

        await refreshAllFolderTrees();
      } catch (err) {
        setError(`Failed to rename folder: ${err}`);
      }
    }
  };
  return handleRenameFolder;
}
