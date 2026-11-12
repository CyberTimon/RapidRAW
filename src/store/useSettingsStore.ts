import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { AppSettings, SupportedTypes, Invokes } from '../components/ui/AppProperties';
import { DEFAULT_THEME_ID } from '../utils/themes';
import { globalImageCache } from '../utils/ImageLRUCache';
import { useEditorStore } from './useEditorStore';

interface SettingsState {
  appSettings: AppSettings | null;
  theme: string;
  supportedTypes: SupportedTypes | null;
  osPlatform: string;
  displayProfileGeneration: number;

  // Actions
  initPlatform: () => void;
  setAppSettings: (settings: AppSettings | null) => void;
  setTheme: (theme: string) => void;
  setSupportedTypes: (types: SupportedTypes | null) => void;
  handleSettingsChange: (newSettings: AppSettings) => Promise<void>;
  setDisplayProfileGeneration: (generation: number) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appSettings: null,
  theme: DEFAULT_THEME_ID,
  supportedTypes: null,
  osPlatform: '',
  displayProfileGeneration: 0,

  initPlatform: () => {
    try {
      set({ osPlatform: platform() });
    } catch (_err) {
      set({ osPlatform: '' });
    }
  },

  setAppSettings: (settings) => set({ appSettings: settings }),

  setTheme: (theme) => set({ theme }),

  setSupportedTypes: (types) => set({ supportedTypes: types }),

  setDisplayProfileGeneration: (generation) => {
    if (generation === get().displayProfileGeneration) return;
    // Cached editor previews were rendered for the previous display profile.
    const currentPath = useEditorStore.getState().selectedImage?.path;
    globalImageCache.deleteWhere(
      (key) => !currentPath || !(key === currentPath || key.startsWith(currentPath + '?vc=')),
    );
    set({ displayProfileGeneration: generation });
  },

  handleSettingsChange: async (newSettings: AppSettings) => {
    if (!newSettings) {
      console.error('handleSettingsChange was called with null settings. Aborting save operation.');
      return;
    }

    if (newSettings.theme && newSettings.theme !== get().theme) {
      set({ theme: newSettings.theme });
    }

    const { searchCriteria: _searchCriteria, ...settingsToSave } = newSettings as any;
    set({ appSettings: newSettings });

    try {
      await invoke(Invokes.SaveSettings, { settings: settingsToSave });
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  },
}));
