import { resolveShortcuts } from '../shortcuts/resolve';
import { shouldIgnoreShortcut, hasOpenDialog } from '../shortcuts/focus';
import { installCommandDispatch, panelCommand } from '../shortcuts/runtime';
import type { CommandId } from '../shortcuts/definitions';
import { finishCropSession } from '../crop/lifecycle';
import { extraCommands } from '../shortcuts/extraCommands';
import { workflowCommands } from '../shortcuts/workflowCommands';
import { legacyCommands1 } from '../shortcuts/legacyCommands1';
import { legacyCommands2 } from '../shortcuts/legacyCommands2';
import { legacyCommands3 } from '../shortcuts/legacyCommands3';
import { legacyCommands4 } from '../shortcuts/legacyCommands4';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { ImageFile, Panel } from '../components/ui/AppProperties';
import { normalizeCombo } from '../utils/keyboardUtils';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { debouncedSetHistory, useEditorActions } from './useEditorActions';
import { useLibraryActions } from './useLibraryActions';

export interface KeyboardShortcutsProps {
  handleOpenFolder(): void;
  handleImportClick(path: string): void;
  handleRenameFiles(paths: string[]): void;
  handleLibraryRefresh(): Promise<void>;
  handleCreateAlbumItem(name: string, type: 'album' | 'group'): Promise<void>;
  sortedImageList: Array<ImageFile>;
  handleBackToLibrary(): void;
  handleDeleteSelected(): void;
  handleGoHome(): void;
  handleImageSelect(path: string, openInEditor?: boolean): void;
  handlePasteFiles(str: string): void;
  handleToggleFullScreen(): void;
  handleZoomChange(zoomValue: number, fitToWindow?: boolean): void;
}

export const useKeyboardShortcuts = ({
  sortedImageList,
  handleOpenFolder,
  handleImportClick,
  handleRenameFiles,
  handleLibraryRefresh,
  handleCreateAlbumItem,
  handleBackToLibrary,
  handleDeleteSelected,
  handleGoHome,
  handleImageSelect,
  handlePasteFiles,
  handleToggleFullScreen,
  handleZoomChange,
}: KeyboardShortcutsProps) => {
  const {
    handleRotate,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleSyncAdjustments,
    toggleShowOriginal,
    handleAutoAdjustments,
    handleAutoLensCorrection,
    handleResetAdjustments,
  } = useEditorActions();
  const { handleRate, handleSetColorLabel } = useLibraryActions();

  const sortedListRef = useRef(sortedImageList);
  useEffect(() => {
    sortedListRef.current = sortedImageList;
  }, [sortedImageList]);

  const handleCopyImagePaths = useCallback(async (paths: Array<string>) => {
    const physicalPaths = [...new Set(paths.map((path) => path.split('?vc=')[0]))];
    if (physicalPaths.length === 0) {
      return;
    }
    try {
      await navigator.clipboard.writeText(physicalPaths.join('\n'));
    } catch (err) {
      console.error('Failed to copy image path to clipboard', err);
      toast.error(`Failed to copy path: ${err}`);
    }
  }, []);

  useEffect(() => {
    const getStoreState = () => ({
      editor: useEditorStore.getState(),
      library: useLibraryStore.getState(),
      ui: useUIStore.getState(),
      settings: useSettingsStore.getState(),
      process: useProcessStore.getState(),
    });

    const getImagePathsForCopy = (s: ReturnType<typeof getStoreState>): Array<string> => {
      if (s.editor.selectedImage) {
        return [s.editor.selectedImage.path];
      }
      const { libraryActivePath, multiSelectedPaths } = s.library;
      if (multiSelectedPaths.length > 0) {
        const listOrder = new Map(sortedListRef.current.map((image: ImageFile, index: number) => [image.path, index]));
        return [...multiSelectedPaths].sort(
          (a: string, b: string) =>
            (listOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (listOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      return libraryActivePath ? [libraryActivePath] : [];
    };

    const env = {
      sortedListRef,
      handleImageSelect,
      handleCopyAdjustments,
      handlePasteAdjustments,
      handleSyncAdjustments,
      handleCopyImagePaths,
      getImagePathsForCopy,
      handlePasteFiles,
      handleDeleteSelected,
      handleZoomChange,
      handleRotate,
      handleToggleFullScreen,
      toggleShowOriginal,
      handleRate,
      handleSetColorLabel,
      handleBackToLibrary,
      handleGoHome,
      handleOpenFolder,
      handleImportClick,
      handleRenameFiles,
      handleLibraryRefresh,
      handleCreateAlbumItem,
      handleAutoAdjustments,
      handleAutoLensCorrection,
      handleResetAdjustments,
    };
    const actions = {
      ...legacyCommands1(env),
      ...legacyCommands2(env),
      ...legacyCommands3(env),
      ...legacyCommands4(env),
      ...extraCommands(env),
      ...workflowCommands(env),
    };
    const run = (action: CommandId, event: KeyboardEvent) => {
      const state = getStoreState();
      const handler = panelCommand(action) ?? actions[action];
      if (!handler || (handler.shouldFire && !handler.shouldFire(state))) return false;
      if (['undo', 'redo'].includes(action)) debouncedSetHistory.flush();
      const leavesCrop =
        [
          'gallery',
          'develop',
          'go_back',
          'toggle_crop_panel',
          'toggle_adjustments',
          'toggle_masks',
          'toggle_ai',
          'toggle_presets',
          'toggle_metadata',
          'toggle_folder_tree',
          'toggle_export',
          'toggle_tethering',
          'open_folder',
          'auto_adjust',
          'auto_lens',
          'reset_adjustments',
          'white_balance',
          'paste_adjustments',
          'sync_adjustments',
          'copy_adjustments',
          'open_denoise',
          'open_negative',
          'open_collage',
          'finish_external_edit',
          'delete_selected',
        ].includes(action) || action.startsWith('preview_');
      if (state.editor.cropSession && leavesCrop) {
        finishCropSession();
        if (action !== 'toggle_crop_panel') state.ui.setPanel(Panel.Adjustments);
      }
      try {
        const result = handler.execute(event, getStoreState());
        void Promise.resolve(result).catch((error) => toast.error(String(error)));
      } catch (error) {
        toast.error(String(error));
      }
      event.preventDefault();
      return true;
    };
    const uninstall = installCommandDispatch((action) =>
      run(action, new KeyboardEvent('keydown', { cancelable: true })),
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      const state = getStoreState();
      if (shouldIgnoreShortcut(event) || hasOpenDialog(state.ui)) return;
      if (state.ui.isSettingsOpen) {
        if (event.code === 'Escape') {
          event.preventDefault();
          state.ui.setUI({ isSettingsOpen: false });
        }
        return;
      }
      const combo = normalizeCombo(event, state.settings.osPlatform);
      const context =
        state.ui.activePanel === Panel.Crop && state.ui.activeView === 'editor'
          ? 'crop'
          : state.ui.activeView === 'editor' &&
              (state.ui.activePanel === Panel.Masks || state.ui.activePanel === Panel.Ai)
            ? 'mask'
            : state.ui.activeView;
      for (const action of resolveShortcuts(combo, state.settings.appSettings, context, event.repeat)) {
        if (run(action, event)) break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      uninstall();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    handleBackToLibrary,
    handleDeleteSelected,
    handleGoHome,
    handleImageSelect,
    handlePasteFiles,
    handleToggleFullScreen,
    handleZoomChange,
    handleRotate,
    handleCopyAdjustments,
    handleCopyImagePaths,
    handlePasteAdjustments,
    handleSyncAdjustments,
    handleRate,
    handleSetColorLabel,
    toggleShowOriginal,
    handleOpenFolder,
    handleImportClick,
    handleRenameFiles,
    handleLibraryRefresh,
    handleCreateAlbumItem,
    handleAutoAdjustments,
    handleAutoLensCorrection,
    handleResetAdjustments,
  ]);
};
