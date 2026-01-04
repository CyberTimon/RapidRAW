import { Cubit } from '@blac/core';
import type { FolderState, ThumbnailSize, ThumbnailAspectRatio } from '../../types/library';

export interface CopyPasteSettings {
  mode: 'merge' | 'replace';
  includedAdjustments: string[];
}

export interface AppSettings {
  theme: string;
  lastRootPath: string | null;
  lastFolderState: FolderState | null;
  pinnedFolders: string[];
  editorPreviewResolution: number;
  enableZoomHifi: boolean;
  enableAiTagging: boolean;
  enableExifReading: boolean;
  thumbnailSize: ThumbnailSize;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  copyPasteSettings: CopyPasteSettings;
  comfyuiAddress?: string;
  adaptiveEditorTheme?: boolean;
  layoutConfig?: LayoutConfig;
}

interface LayoutConfig {
  layouts?: Record<string, unknown>;
  panelSizes?: Record<string, number>;
  collapsedPanels?: string[];
}

interface SettingsState {
  settings: AppSettings;
  isLoading: boolean;
  isSaving: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  lastRootPath: null,
  lastFolderState: null,
  pinnedFolders: [],
  editorPreviewResolution: 2560,
  enableZoomHifi: true,
  enableAiTagging: false,
  enableExifReading: true,
  thumbnailSize: 'medium',
  thumbnailAspectRatio: 'cover',
  copyPasteSettings: { mode: 'merge', includedAdjustments: [] },
};

export class SettingsBloc extends Cubit<SettingsState> {
  constructor() {
    super({
      settings: DEFAULT_SETTINGS,
      isLoading: false,
      isSaving: false,
    });
  }

  load = async () => {
    this.patch({ isLoading: true });
    try {
      // TODO: Use TauriService once implemented
      // const tauri = borrow(TauriService);
      // const settings = await tauri.loadSettings();
      // For now, just mark as loaded
      this.patch({ isLoading: false });
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.patch({ isLoading: false });
    }
  };

  save = async () => {
    this.patch({ isSaving: true });
    try {
      // TODO: Use TauriService once implemented
      // const tauri = borrow(TauriService);
      // await tauri.saveSettings(this.state.settings);
    } catch (error) {
      console.error('Failed to save settings:', error);
    } finally {
      this.patch({ isSaving: false });
    }
  };

  updateSettings = (partial: Partial<AppSettings>) => {
    this.emit({
      ...this.state,
      settings: { ...this.state.settings, ...partial },
    });
    this.save();
  };

  setTheme = (theme: string) => {
    this.updateSettings({ theme });
  };

  setLastRootPath = (path: string | null) => {
    this.updateSettings({ lastRootPath: path });
  };

  setPinnedFolders = (folders: string[]) => {
    this.updateSettings({ pinnedFolders: folders });
  };

  addPinnedFolder = (path: string) => {
    if (!this.state.settings.pinnedFolders.includes(path)) {
      this.updateSettings({
        pinnedFolders: [...this.state.settings.pinnedFolders, path],
      });
    }
  };

  removePinnedFolder = (path: string) => {
    this.updateSettings({
      pinnedFolders: this.state.settings.pinnedFolders.filter((p) => p !== path),
    });
  };

  setThumbnailSize = (size: ThumbnailSize) => {
    this.updateSettings({ thumbnailSize: size });
  };

  setThumbnailAspectRatio = (ratio: ThumbnailAspectRatio) => {
    this.updateSettings({ thumbnailAspectRatio: ratio });
  };

  get theme() {
    return this.state.settings.theme;
  }

  get lastRootPath() {
    return this.state.settings.lastRootPath;
  }

  get pinnedFolders() {
    return this.state.settings.pinnedFolders;
  }

  get thumbnailSize() {
    return this.state.settings.thumbnailSize;
  }

  get thumbnailAspectRatio() {
    return this.state.settings.thumbnailAspectRatio;
  }
}
