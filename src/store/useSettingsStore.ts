import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { AppSettings, SupportedTypes, Invokes, Theme } from '../components/ui/AppProperties';
import { DEFAULT_THEME_ID } from '../utils/themes';

interface SettingsState {
  appSettings: AppSettings | null;
  theme: string;
  supportedTypes: SupportedTypes | null;
  osPlatform: string;
  systemThemeSubscription?: () => void;

  // Actions
  initPlatform: () => void;
  setAppSettings: (settings: AppSettings | null) => void;
  setTheme: (theme: string) => void;
  setSupportedTypes: (types: SupportedTypes | null) => void;
  handleSettingsChange: (newSettings: AppSettings) => Promise<void>;
  cleanupSystemThemeListener: () => void;
}

// Helper function to detect system theme preference
const getSystemTheme = (): Theme.Dark | Theme.Light => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? Theme.Dark : Theme.Light;
  }
  return Theme.Dark; // Default to dark if detection fails
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appSettings: null,
  theme: DEFAULT_THEME_ID,
  supportedTypes: null,
  osPlatform: '',

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

  cleanupSystemThemeListener: () => {
    const { systemThemeSubscription } = get();
    if (systemThemeSubscription) {
      systemThemeSubscription();
      set({ systemThemeSubscription: undefined });
    }
  },

  handleSettingsChange: async (newSettings: AppSettings) => {
    if (!newSettings) {
      console.error('handleSettingsChange was called with null settings. Aborting save operation.');
      return;
    }

    // Handle system theme changes
    const previousTheme = get().theme;
    const newTheme = newSettings.theme;

    // Clean up old system theme listener if switching away from System theme
    if (previousTheme === Theme.System && newTheme !== Theme.System) {
      get().cleanupSystemThemeListener();
    }

    // Set up system theme listener if switching to System theme
    if (newTheme === Theme.System && previousTheme !== Theme.System) {
      if (typeof window !== 'undefined' && window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        
        // Apply initial system theme
        const systemTheme = getSystemTheme();
        set({ theme: systemTheme });

        // Listen for system theme changes
        const handler = (e: MediaQueryListEvent) => {
          const newSystemTheme = e.matches ? Theme.Dark : Theme.Light;
          set({ theme: newSystemTheme });
        };

        mediaQuery.addEventListener('change', handler);

        // Store cleanup function
        set({
          systemThemeSubscription: () => {
            mediaQuery.removeEventListener('change', handler);
          },
        });
      }
    } else if (newTheme !== Theme.System) {
      // For non-system themes, just set the theme directly
      set({ theme: newTheme });
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
