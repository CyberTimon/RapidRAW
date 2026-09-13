import i18n from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { Invokes, LibraryDisplayMode, type AlbumItem, Panel } from '../components/ui/AppProperties';
import type { CommandHandlers, ShortcutEnvironment, ShortcutState } from './types';

export function workflowCommands(env: ShortcutEnvironment): CommandHandlers {
  const paths = (s: ShortcutState) =>
    s.ui.activeView === 'editor' && s.editor.selectedImage
      ? [s.editor.selectedImage.path]
      : s.library.multiSelectedPaths;
  const selected = (s: ShortcutState) => paths(s).length > 0;
  return {
    library_list: {
      execute: (_, s) => {
        if (s.settings.appSettings)
          return s.settings.handleSettingsChange({
            ...s.settings.appSettings,
            libraryDisplayMode: LibraryDisplayMode.List,
          });
      },
    },
    open_culling: {
      shouldFire: (s) => paths(s).length > 1,
      execute: (_, s) =>
        s.ui.setUI({
          cullingModalState: { isOpen: true, progress: null, suggestions: null, error: null, pathsToCull: paths(s) },
        }),
    },
    reveal_photo: {
      shouldFire: selected,
      execute: (_, s) => invoke(Invokes.ShowInFinder, { path: paths(s)[0].split('?vc=')[0] }),
    },
    create_virtual_copy: {
      shouldFire: (s) => paths(s).length === 1,
      execute: async (_, s) => {
        await invoke(Invokes.CreateVirtualCopy, {
          sourceVirtualPath: paths(s)[0],
          targetAlbumId: s.library.activeAlbumId || null,
        });
        if (s.library.activeAlbumId) s.library.setLibrary({ albumTree: await invoke<AlbumItem[]>(Invokes.GetAlbums) });
        await env.handleLibraryRefresh();
      },
    },
    open_folder: { execute: () => env.handleOpenFolder() },
    import_photos: {
      shouldFire: (s) => !!s.library.currentFolderPath && !s.library.activeAlbumId,
      execute: (_, s) => env.handleImportClick(s.library.currentFolderPath!),
    },
    rename_photos: { shouldFire: selected, execute: (_, s) => env.handleRenameFiles(paths(s)) },
    refresh_library: {
      execute: () => {
        void env.handleLibraryRefresh();
      },
    },
    create_folder: {
      shouldFire: (s) => !!s.library.currentFolderPath && !s.library.activeAlbumId,
      execute: (_, s) => s.ui.setUI({ isCreateFolderModalOpen: true }),
    },
    create_album: { execute: (_, s) => s.ui.setUI({ isCreateAlbumModalOpen: true }) },
    open_people: { execute: (_, s) => s.ui.setUI({ activeView: 'people' }) },
    toggle_tethering: {
      shouldFire: (s) => Object.values(s.ui.panelLayout).some((panels) => panels.includes(Panel.Tethering)),
      execute: (_, s) => s.ui.setPanel(Panel.Tethering),
    },
    auto_adjust: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage?.isReady,
      execute: () => {
        void env.handleAutoAdjustments();
      },
    },
    auto_lens: {
      shouldFire: selected,
      execute: (_, s) => {
        void env.handleAutoLensCorrection(paths(s));
      },
    },
    reset_adjustments: {
      shouldFire: selected,
      execute: (_, s) => {
        const target = paths(s);
        s.ui.setUI({
          confirmModalState: {
            isOpen: true,
            title: i18n.t('contextMenus.editor.resetAdjustments'),
            message: i18n.t('shortcuts.resetConfirm'),
            confirmText: i18n.t('contextMenus.editor.confirmReset'),
            onConfirm: () => env.handleResetAdjustments(target),
          },
        });
      },
    },
    open_denoise: {
      shouldFire: selected,
      execute: (_, s) =>
        s.ui.setUI({
          denoiseModalState: {
            ...s.ui.denoiseModalState,
            isOpen: true,
            isProcessing: false,
            previewBase64: null,
            error: null,
            targetPaths: paths(s),
            isRaw: !!s.editor.selectedImage?.isRaw,
          },
        }),
    },
    open_negative: {
      shouldFire: selected,
      execute: (_, s) => s.ui.setUI({ negativeModalState: { isOpen: true, targetPaths: paths(s) } }),
    },
    open_collage: {
      shouldFire: (s) => selected(s) && paths(s).length <= 9,
      execute: (_, s) =>
        s.ui.setUI({ collageModalState: { isOpen: true, sourceImages: paths(s).map((path) => ({ path })) } }),
    },
    open_panorama: {
      shouldFire: (s) => paths(s).length > 1,
      execute: (_, s) =>
        s.ui.setUI({
          panoramaModalState: {
            ...s.ui.panoramaModalState,
            isOpen: true,
            isProcessing: false,
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: paths(s),
          },
        }),
    },
    open_hdr: {
      shouldFire: (s) => paths(s).length > 1,
      execute: (_, s) =>
        s.ui.setUI({
          hdrModalState: {
            ...s.ui.hdrModalState,
            isOpen: true,
            isProcessing: false,
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: paths(s),
          },
        }),
    },
    open_focus_stack: {
      shouldFire: (s) => paths(s).length > 1,
      execute: (_, s) =>
        s.ui.setUI({
          focusStackModalState: {
            ...s.ui.focusStackModalState,
            isOpen: true,
            isProcessing: false,
            finalImageBase64: null,
            depthMapBase64: null,
            error: null,
            sourcePaths: paths(s),
          },
        }),
    },
  };
}
