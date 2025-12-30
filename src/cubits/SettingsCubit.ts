import { Cubit, blac } from '@blac/core';
import debounce from 'lodash.debounce';
import { invoke } from '@tauri-apps/api/core';
import {
  AppSettings,
  Theme,
  FilterCriteria,
  SortCriteria,
  ThumbnailSize,
  ThumbnailAspectRatio,
  UiVisibility,
  RawStatus,
  SortDirection,
  Invokes,
} from '../components/ui/AppProperties';

export interface SettingsState {
  isLoaded: boolean;
  theme: Theme;
  appSettings: AppSettings;
}

const defaultFilterCriteria: FilterCriteria = {
  colors: [],
  rating: 0,
  rawStatus: RawStatus.All,
};

const defaultSortCriteria: SortCriteria = {
  key: 'name',
  order: SortDirection.Ascending,
};

const defaultUiVisibility: UiVisibility = {
  folderTree: true,
  filmstrip: true,
};

const defaultAppSettings: AppSettings = {
  lastRootPath: null,
  theme: Theme.Dark,
  filterCriteria: defaultFilterCriteria,
  sortCriteria: defaultSortCriteria,
  thumbnailSize: ThumbnailSize.Medium,
  thumbnailAspectRatio: ThumbnailAspectRatio.Cover,
  uiVisibility: defaultUiVisibility,
  adjustmentVisibility: {},
  activeTreeSection: 'current',
  editorPreviewResolution: 2048,
  enableZoomHifi: true,
  enableAiTagging: false,
  enableExifReading: true,
  rawHighlightCompression: 0,
  processingBackend: 'auto',
  linuxGpuOptimization: false,
};

const defaultState: SettingsState = {
  isLoaded: false,
  theme: Theme.Dark,
  appSettings: defaultAppSettings,
};

@blac({ keepAlive: true })
export class SettingsCubit extends Cubit<SettingsState> {
  private debouncedSave: ReturnType<typeof debounce>;

  constructor() {
    super(defaultState);

    this.debouncedSave = debounce(this.saveSettings, 500);

    this.onSystemEvent('stateChanged', ({ state, previousState }: { state: SettingsState; previousState: SettingsState }) => {
      if (state.isLoaded && previousState.isLoaded) {
        this.debouncedSave();
      }
    });
  }

  loadSettings = async () => {
    try {
      const loaded = await invoke<AppSettings | null>(Invokes.LoadSettings);

      if (loaded) {
        this.emit({
          isLoaded: true,
          theme: loaded.theme ?? Theme.Dark,
          appSettings: {
            ...defaultAppSettings,
            ...loaded,
          },
        });
      } else {
        this.patch({ isLoaded: true });
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.patch({ isLoaded: true });
    }
  };

  private saveSettings = async () => {
    try {
      const settingsToSave: AppSettings = {
        ...this.state.appSettings,
        theme: this.state.theme,
      };
      await invoke(Invokes.SaveSettings, { settings: settingsToSave });
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  };

  setTheme = (theme: Theme) => {
    this.patch({ theme });
    this.update((state) => ({
      ...state,
      appSettings: { ...state.appSettings, theme },
    }));
  };

  updateAppSettings = (updates: Partial<AppSettings>) => {
    this.update((state) => ({
      ...state,
      appSettings: { ...state.appSettings, ...updates },
    }));
  };

  setLastRootPath = (path: string | null) => {
    this.updateAppSettings({ lastRootPath: path });
  };

  setFilterCriteria = (criteria: FilterCriteria) => {
    this.updateAppSettings({ filterCriteria: criteria });
  };

  setSortCriteria = (criteria: SortCriteria) => {
    this.updateAppSettings({ sortCriteria: criteria });
  };

  setThumbnailSize = (size: ThumbnailSize) => {
    this.updateAppSettings({ thumbnailSize: size });
  };

  setThumbnailAspectRatio = (ratio: ThumbnailAspectRatio) => {
    this.updateAppSettings({ thumbnailAspectRatio: ratio });
  };

  setUiVisibility = (visibility: Partial<UiVisibility>) => {
    this.update((state) => {
      const currentVisibility = state.appSettings.uiVisibility ?? defaultUiVisibility;
      return {
        ...state,
        appSettings: {
          ...state.appSettings,
          uiVisibility: {
            folderTree: visibility.folderTree ?? currentVisibility.folderTree,
            filmstrip: visibility.filmstrip ?? currentVisibility.filmstrip,
          },
        },
      };
    });
  };

  toggleFolderTree = () => {
    const current = this.state.appSettings.uiVisibility?.folderTree ?? true;
    this.setUiVisibility({ folderTree: !current });
  };

  toggleFilmstrip = () => {
    const current = this.state.appSettings.uiVisibility?.filmstrip ?? true;
    this.setUiVisibility({ filmstrip: !current });
  };

  setAdjustmentVisibility = (key: string, visible: boolean) => {
    this.update((state) => ({
      ...state,
      appSettings: {
        ...state.appSettings,
        adjustmentVisibility: {
          ...state.appSettings.adjustmentVisibility,
          [key]: visible,
        },
      },
    }));
  };

  setActiveTreeSection = (section: string | null) => {
    this.updateAppSettings({ activeTreeSection: section });
  };

  setEditorPreviewResolution = (resolution: number) => {
    this.updateAppSettings({ editorPreviewResolution: resolution });
  };

  setEnableZoomHifi = (enabled: boolean) => {
    this.updateAppSettings({ enableZoomHifi: enabled });
  };

  setEnableAiTagging = (enabled: boolean) => {
    this.updateAppSettings({ enableAiTagging: enabled });
  };

  setEnableExifReading = (enabled: boolean) => {
    this.updateAppSettings({ enableExifReading: enabled });
  };

  setRawHighlightCompression = (value: number) => {
    this.updateAppSettings({ rawHighlightCompression: value });
  };

  setProcessingBackend = (backend: string) => {
    this.updateAppSettings({ processingBackend: backend });
  };

  setLinuxGpuOptimization = (enabled: boolean) => {
    this.updateAppSettings({ linuxGpuOptimization: enabled });
  };

  setComfyuiAddress = (address: string) => {
    this.updateAppSettings({ comfyuiAddress: address });
  };

  setComfyuiWorkflowConfig = (config: AppSettings['comfyuiWorkflowConfig']) => {
    this.updateAppSettings({ comfyuiWorkflowConfig: config });
  };

  setPinnedFolders = (folders: any) => {
    this.updateAppSettings({ pinnedFolders: folders });
  };

  setLastFolderState = (state: any) => {
    this.updateAppSettings({ lastFolderState: state });
  };

  setAdaptiveEditorTheme = (theme: Theme | undefined) => {
    this.updateAppSettings({ adaptiveEditorTheme: theme });
  };

  resetSettings = () => {
    this.emit({
      isLoaded: true,
      theme: Theme.Dark,
      appSettings: defaultAppSettings,
    });
  };
}
