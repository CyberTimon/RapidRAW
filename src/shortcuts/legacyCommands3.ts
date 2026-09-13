import { Panel, ExifOverlay } from '../components/ui/AppProperties';
import type { ShortcutEnvironment, CommandHandlers } from './types';
export function legacyCommands3(env: ShortcutEnvironment): CommandHandlers {
  const { handleRate } = env;
  return {
    toggle_presets: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setPanel(Panel.Presets);
      },
    },
    toggle_metadata: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setPanel(Panel.Metadata);
      },
    },
    toggle_folder_tree: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setPanel(Panel.FolderTree);
      },
    },
    toggle_analytics: {
      shouldFire: (s) => !!s.editor.selectedImage,
      execute: (e, s) => {
        e.preventDefault();
        const nextVisibility = !s.editor.isWaveformVisible;
        s.editor.setEditor({ isWaveformVisible: nextVisibility });
        s.settings.handleSettingsChange({
          ...s.settings.appSettings,
          isWaveformVisible: nextVisibility,
        });
      },
    },
    toggle_export: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setPanel(Panel.Export);
      },
    },
    toggle_left_panel: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        const isOpening = !s.ui.uiVisibility.leftPanel;
        s.ui.setUI((state) => ({
          uiVisibility: { ...state.uiVisibility, leftPanel: isOpening },
          leftPanelWidth: isOpening && state.leftPanelWidth < 250 ? 350 : state.leftPanelWidth,
        }));
      },
    },
    toggle_right_panel: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        const isOpening = !s.ui.uiVisibility.rightPanel;
        s.ui.setUI((state) => ({
          uiVisibility: { ...state.uiVisibility, rightPanel: isOpening },
          rightPanelWidth: isOpening && state.rightPanelWidth < 250 ? 350 : state.rightPanelWidth,
        }));
      },
    },
    toggle_bottom_panel: {
      shouldFire: (s) => s.ui.activeView !== 'library',
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setUI((state) => ({
          uiVisibility: { ...state.uiVisibility, filmstrip: !state.uiVisibility.filmstrip },
        }));
      },
    },
    toggle_library_exif: {
      shouldFire: (s) => s.ui.activeView === 'library',
      execute: (e, s) => {
        e.preventDefault();
        const current = s.settings.appSettings?.exifOverlay || ExifOverlay.Off;
        const nextState = {
          [ExifOverlay.Off]: ExifOverlay.Hover,
          [ExifOverlay.Hover]: ExifOverlay.Always,
          [ExifOverlay.Always]: ExifOverlay.Off,
        }[current as ExifOverlay];
        s.settings.handleSettingsChange({ ...s.settings.appSettings, exifOverlay: nextState });
      },
    },
    open_settings: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setUI({ isSettingsOpen: true });
      },
    },
    focus_search: {
      shouldFire: (s) => s.ui.activeView === 'library',
      execute: (e, s) => {
        e.preventDefault();
        s.ui.requestSearchFocus();
      },
    },
    toggle_crop: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (e, s) => {
        e.preventDefault();
        if (s.ui.activePanel === Panel.Crop) {
          s.editor.setEditor({ isStraightenActive: !s.editor.isStraightenActive });
        } else {
          s.ui.setPanel(Panel.Crop);
          s.editor.setEditor({ isStraightenActive: true });
        }
      },
    },
    rate_0: {
      shouldFire: () => true,
      execute: (e) => {
        e.preventDefault();
        handleRate(0);
      },
    },
    rate_1: {
      shouldFire: () => true,
      execute: (e) => {
        e.preventDefault();
        handleRate(1);
      },
    },
  };
}
