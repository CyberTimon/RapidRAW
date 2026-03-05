import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useHandleActiveTreeSectionChange } from './useHandleActiveTreeSectionChange';
import { useHandleSettingsChange } from './useHandleSettingsChange';

export function useHandleTogglePinFolder() {
  const { appSettings, currentFolderPath, setPinnedFolderTrees } = useAppState();
  const handleActiveTreeSectionChange = useHandleActiveTreeSectionChange();
  const handleSettingsChange = useHandleSettingsChange();

  const handleTogglePinFolder = useCallback(
    async (path: string) => {
      if (!appSettings) return;
      const currentPins = appSettings.pinnedFolders || [];
      const isPinned = currentPins.includes(path);
      const newPins = isPinned
        ? currentPins.filter((p) => p !== path)
        : [...currentPins, path].sort((a, b) => a.localeCompare(b));

      if (!isPinned && path === currentFolderPath) {
        handleActiveTreeSectionChange('pinned');
      }

      handleSettingsChange({ ...appSettings, pinnedFolders: newPins });

      try {
        const trees = await invoke(Invokes.GetPinnedFolderTrees, { paths: newPins });
        setPinnedFolderTrees(trees);
      } catch (err) {
        console.error('Failed to refresh pinned folders:', err);
      }
    },
    [appSettings, handleSettingsChange],
  );

  return handleTogglePinFolder;
}
