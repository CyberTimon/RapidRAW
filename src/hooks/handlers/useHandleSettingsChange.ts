import { setTheme } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { AppSettings, Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';

export function useHandleSettingsChange() {
  const { setAppSettings, theme } = useAppState();

  const handleSettingsChange = useCallback(
    (newSettings: AppSettings) => {
      if (!newSettings) {
        console.error('handleSettingsChange was called with null settings. Aborting save operation.');
        return;
      }
      if (newSettings.theme && newSettings.theme !== theme) {
        setTheme(newSettings.theme);
      }

      const { searchCriteria: _searchCriteria, ...settingsToSave } = newSettings as any;
      setAppSettings(newSettings);
      invoke(Invokes.SaveSettings, { settings: settingsToSave }).catch((err) => {
        console.error('Failed to save settings:', err);
      });
    },
    [theme],
  );

  return handleSettingsChange;
}
