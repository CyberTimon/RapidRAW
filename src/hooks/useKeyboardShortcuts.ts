import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { ImageFile, Panel, ExifOverlay } from '../components/ui/AppProperties';
import { KEYBIND_DEFINITIONS, normalizeCombo } from '../utils/keyboardUtils';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { ToolType } from '../components/panel/right/Masks';
import { useEditorActions } from './useEditorActions';
import { useLibraryActions } from './useLibraryActions';

interface KeyboardShortcutsProps {
  sortedImageList: Array<ImageFile>;
  handleBackToLibrary(): void;
  handleDeleteSelected(): void;
  handleGoHome(): void;
  handleImageSelect(path: string, openInEditor?: boolean): void;
  handlePasteFiles(str: string): void;
  handleZoomChange(zoomValue: number, fitToWindow?: boolean): void;
}

export const useKeyboardShortcuts = ({
  sortedImageList,
  handleBackToLibrary,
  handleDeleteSelected,
  handleGoHome,
  handleImageSelect,
  handlePasteFiles,
  handleZoomChange,
}: KeyboardShortcutsProps) => {
  const { handleRotate, handleCopyAdjustments, handlePasteAdjustments, toggleShowOriginal } = useEditorActions();
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

    type ShortcutState = ReturnType<typeof getStoreState>;
    interface ShortcutAction {
      shouldFire?: (state: ShortcutState) => boolean;
      execute: (event: KeyboardEvent, state: ShortcutState) => void;
    }

    const comboMap = new Map<string, string>();
    const keybinds = useSettingsStore.getState().appSettings?.keybinds;

    for (const def of KEYBIND_DEFINITIONS) {
      const userCombo = keybinds?.[def.action];
      const effective = userCombo && userCombo.length > 0 ? userCombo : def.defaultCombo;
      if (effective) {
        comboMap.set(effective.join('+'), def.action);
      }
    }

    const getImagePathsForCopy = (s: ShortcutState): Array<string> => {
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

    const actions: Record<string, ShortcutAction> = {
      open_image: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'library' && s.library.libraryActivePath !== null,
        execute: (e, s) => {
          e.preventDefault();
          handleImageSelect(s.library.libraryActivePath!, true);
        },
      },
      copy_adjustments: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleCopyAdjustments();
        },
      },
      paste_adjustments: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handlePasteAdjustments();
        },
      },
      copy_image_path: {
        shouldFire: (s: ShortcutState) => getImagePathsForCopy(s).length > 0,
        execute: (e, s) => {
          e.preventDefault();
          handleCopyImagePaths(getImagePathsForCopy(s));
        },
      },
      copy_files: {
        shouldFire: (s: ShortcutState) => s.library.multiSelectedPaths.length > 0,
        execute: (e, s) => {
          e.preventDefault();
          s.process.setProcess({ copiedFilePaths: s.library.multiSelectedPaths });
        },
      },
      paste_files: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handlePasteFiles('copy');
        },
      },
      select_all: {
        shouldFire: () => sortedListRef.current.length > 0,
        execute: (e, s) => {
          e.preventDefault();
          s.library.setLibrary({ multiSelectedPaths: sortedListRef.current.map((f: ImageFile) => f.path) });
          if (s.ui.activeView === 'library') {
            const lastPath = sortedListRef.current[sortedListRef.current.length - 1].path;
            s.library.setLibrary({ libraryActivePath: lastPath });
            handleImageSelect(lastPath, false);
          }
        },
      },
      delete_selected: {
        shouldFire: (s: ShortcutState) => !s.editor.activeMaskContainerId && !s.editor.activeAiPatchContainerId,
        execute: (e) => {
          e.preventDefault();
          handleDeleteSelected();
        },
      },
      preview_prev: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const currentIndex = sortedListRef.current.findIndex((img) => img.path === s.editor.selectedImage!.path);
          if (currentIndex === -1) return;
          const nextIndex = currentIndex - 1 < 0 ? sortedListRef.current.length - 1 : currentIndex - 1;
          handleImageSelect(sortedListRef.current[nextIndex].path, true);
        },
      },
      preview_next: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const currentIndex = sortedListRef.current.findIndex((img) => img.path === s.editor.selectedImage!.path);
          if (currentIndex === -1) return;
          const nextIndex = currentIndex + 1 >= sortedListRef.current.length ? 0 : currentIndex + 1;
          handleImageSelect(sortedListRef.current[nextIndex].path, true);
        },
      },
      zoom_in_step: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.min(currentPercent + 0.1, 2.0));
        },
      },
      zoom_out_step: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.max(currentPercent - 0.1, 0.1));
        },
      },
      cycle_zoom: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const { originalSize, displaySize, baseRenderSize } = s.editor;
          const currentPercent =
            originalSize?.width > 0 && displaySize?.width > 0
              ? Math.round(((displaySize.width * dpr) / originalSize.width) * 100)
              : 100;
          let fitPercent = 100;

          if (originalSize?.width > 0 && baseRenderSize?.width > 0) {
            const originalAspect = originalSize.width / originalSize.height;
            const baseAspect = baseRenderSize.width / baseRenderSize.height;
            fitPercent =
              originalAspect > baseAspect
                ? Math.round(((baseRenderSize.width * dpr) / originalSize.width) * 100)
                : Math.round(((baseRenderSize.height * dpr) / originalSize.height) * 100);
          }

          const doubleFitPercent = fitPercent * 2;
          if (Math.abs(currentPercent - fitPercent) < 5) {
            handleZoomChange(doubleFitPercent < 100 ? doubleFitPercent / 100 : 1.0);
          } else if (Math.abs(currentPercent - doubleFitPercent) < 5 && doubleFitPercent < 100) {
            handleZoomChange(1.0);
          } else {
            handleZoomChange(0, true);
          }
        },
      },
      zoom_in: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.min(currentPercent * 1.2, 2.0));
        },
      },
      zoom_out: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            s.editor.originalSize?.width > 0 && s.editor.displaySize?.width > 0
              ? (s.editor.displaySize.width * dpr) / s.editor.originalSize.width
              : 1.0;
          handleZoomChange(Math.max(currentPercent / 1.2, 0.1));
        },
      },
      zoom_fit: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e) => {
          e.preventDefault();
          handleZoomChange(0, true);
        },
      },
      zoom_100: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e) => {
          e.preventDefault();
          handleZoomChange(1.0);
        },
      },
      rotate_left: {
        shouldFire: (s: ShortcutState) => !!s.editor.selectedImage || !!s.library.libraryActivePath,
        execute: (e) => {
          e.preventDefault();
          handleRotate(-90);
        },
      },
      rotate_right: {
        shouldFire: (s: ShortcutState) => !!s.editor.selectedImage || !!s.library.libraryActivePath,
        execute: (e) => {
          e.preventDefault();
          handleRotate(90);
        },
      },
      undo: {
        shouldFire: (s: ShortcutState) =>
          s.ui.activeView === 'editor' && !!s.editor.selectedImage && s.editor.historyIndex > 0,
        execute: (e, s) => {
          e.preventDefault();
          s.editor.undo();
        },
      },
      redo: {
        shouldFire: (s: ShortcutState) =>
          s.ui.activeView === 'editor' &&
          !!s.editor.selectedImage &&
          s.editor.historyIndex < s.editor.history.length - 1,
        execute: (e, s) => {
          e.preventDefault();
          s.editor.redo();
        },
      },
      toggle_fullscreen: {
        shouldFire: (s: ShortcutState) => !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          s.ui.toggleFullScreen();
        },
      },
      show_original: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e) => {
          e.preventDefault();
          toggleShowOriginal();
        },
      },
      toggle_clipping: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          s.editor.setEditor((state) => ({ showClipping: !state.showClipping }));
        },
      },
      toggle_split_compare: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          s.editor.setEditor((state) => ({ splitCompare: !state.splitCompare }));
        },
      },
      toggle_adjustments: {
        shouldFire: () => true,
        execute: (e, s) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Adjustments);
        },
      },
      toggle_crop_panel: {
        shouldFire: () => true,
        execute: (e, s) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Crop);
        },
      },
      toggle_masks: {
        shouldFire: () => true,
        execute: (e, s) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Masks);
        },
      },
      toggle_ai: {
        shouldFire: () => true,
        execute: (e, s) => {
          e.preventDefault();
          s.ui.setPanel(Panel.Ai);
        },
      },
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
        shouldFire: (s: ShortcutState) => !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          const nextVisibility = !s.editor.isWaveformVisible;
          s.editor.setEditor({ isWaveformVisible: nextVisibility });
          if (s.settings.appSettings)
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
        shouldFire: (s: ShortcutState) => s.ui.activeView !== 'library',
        execute: (e, s) => {
          e.preventDefault();
          s.ui.setUI((state) => ({
            uiVisibility: { ...state.uiVisibility, filmstrip: !state.uiVisibility.filmstrip },
          }));
        },
      },
      toggle_library_exif: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'library',
        execute: (e, s) => {
          e.preventDefault();
          const current = s.settings.appSettings?.exifOverlay || ExifOverlay.Off;
          const nextState = {
            [ExifOverlay.Off]: ExifOverlay.Hover,
            [ExifOverlay.Hover]: ExifOverlay.Always,
            [ExifOverlay.Always]: ExifOverlay.Off,
          }[current as ExifOverlay];
          if (s.settings.appSettings)
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
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'library',
        execute: (e, s) => {
          e.preventDefault();
          s.ui.requestSearchFocus();
        },
      },
      toggle_crop: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
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
      rate_2: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleRate(2);
        },
      },
      rate_3: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleRate(3);
        },
      },
      rate_4: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleRate(4);
        },
      },
      rate_5: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleRate(5);
        },
      },
      color_label_none: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleSetColorLabel(null);
        },
      },
      color_label_red: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleSetColorLabel('red');
        },
      },
      color_label_yellow: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleSetColorLabel('yellow');
        },
      },
      color_label_green: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleSetColorLabel('green');
        },
      },
      color_label_blue: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleSetColorLabel('blue');
        },
      },
      color_label_purple: {
        shouldFire: () => true,
        execute: (e) => {
          e.preventDefault();
          handleSetColorLabel('purple');
        },
      },
      toggle_patch_markers: {
        shouldFire: (s: ShortcutState) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
        execute: (e, s) => {
          e.preventDefault();
          s.editor.setEditor({ showPatchMarkers: !(s.editor.showPatchMarkers ?? true) });
        },
      },
      brush_size_up: {
        shouldFire: (s: ShortcutState) =>
          s.ui.activeView === 'editor' &&
          !!s.editor.selectedImage &&
          (s.ui.activePanel === Panel.Masks || s.ui.activePanel === Panel.Ai),
        execute: (e, s) => {
          e.preventDefault();
          const currentSettings = s.editor.brushSettings || { size: 50, feather: 50, tool: ToolType.Brush };
          const newSize = Math.min((currentSettings.size || 50) + 10, 200);
          s.editor.setEditor({
            brushSettings: { ...currentSettings, size: newSize },
          });
        },
      },
      brush_size_down: {
        shouldFire: (s: ShortcutState) =>
          s.ui.activeView === 'editor' &&
          !!s.editor.selectedImage &&
          (s.ui.activePanel === Panel.Masks || s.ui.activePanel === Panel.Ai),
        execute: (e, s) => {
          e.preventDefault();
          const currentSettings = s.editor.brushSettings || { size: 50, feather: 50, tool: ToolType.Brush };
          const newSize = Math.max((currentSettings.size || 50) - 10, 1);
          s.editor.setEditor({
            brushSettings: { ...currentSettings, size: newSize },
          });
        },
      },
    };

    const builtinShortcuts = [
      {
        match: (e: KeyboardEvent) => e.code === 'Escape',
        execute: (e: KeyboardEvent, s: ShortcutState) => {
          e.preventDefault();
          if (s.editor.isStraightenActive) s.editor.setEditor({ isStraightenActive: false });
          else if (s.ui.customEscapeHandler) s.ui.customEscapeHandler();
          else if (
            (s.ui.activePanel === Panel.Ai ||
              (s.ui.activePanel === Panel.Masks && s.editor.activeLocalEditKind === 'repair')) &&
            s.editor.activeAiSubMaskId
          )
            s.editor.setEditor({ activeAiSubMaskId: null });
          else if (
            (s.ui.activePanel === Panel.Ai ||
              (s.ui.activePanel === Panel.Masks && s.editor.activeLocalEditKind === 'repair')) &&
            s.editor.activeAiPatchContainerId
          )
            s.editor.setEditor({ activeAiPatchContainerId: null, activeLocalEditKind: null });
          else if (
            s.ui.activePanel === Panel.Masks &&
            s.editor.activeLocalEditKind === 'adjustment' &&
            s.editor.activeMaskId
          )
            s.editor.setEditor({ activeMaskId: null });
          else if (
            s.ui.activePanel === Panel.Masks &&
            s.editor.activeLocalEditKind === 'adjustment' &&
            s.editor.activeMaskContainerId
          )
            s.editor.setEditor({ activeMaskContainerId: null, activeLocalEditKind: null });
          else if (s.ui.activePanel === Panel.Crop) s.ui.setPanel(Panel.Adjustments);
          else if (s.ui.isFullScreen) s.ui.toggleFullScreen();
          else if (s.ui.activeView === 'editor') handleBackToLibrary();
          else if (s.ui.activeView === 'library' && s.library.rootPaths?.length > 0) handleGoHome();
        },
      },
      {
        match: (e: KeyboardEvent, s: ShortcutState) => {
          const isDeleteKey = s.settings.osPlatform === 'macos' ? e.code === 'Backspace' : e.code === 'Delete';
          return (
            isDeleteKey &&
            ((s.ui.activePanel === Panel.Masks &&
              s.editor.activeLocalEditKind === 'adjustment' &&
              !!s.editor.activeMaskContainerId) ||
              ((s.ui.activePanel === Panel.Ai ||
                (s.ui.activePanel === Panel.Masks && s.editor.activeLocalEditKind === 'repair')) &&
                !!s.editor.activeAiPatchContainerId))
          );
        },
        execute: (e: KeyboardEvent, s: ShortcutState) => {
          e.preventDefault();
          if (
            s.ui.activePanel === Panel.Masks &&
            s.editor.activeLocalEditKind === 'adjustment' &&
            s.editor.activeMaskContainerId
          ) {
            s.editor.setEditor((state) => ({
              adjustments: {
                ...state.adjustments,
                masks: state.adjustments.masks.filter((c) => c.id !== s.editor.activeMaskContainerId),
              },
              activeMaskContainerId: null,
              activeMaskId: null,
              activeLocalEditKind: null,
            }));
          } else if (s.editor.activeAiPatchContainerId) {
            s.editor.setEditor((state) => ({
              adjustments: {
                ...state.adjustments,
                aiPatches: state.adjustments.aiPatches.filter((c) => c.id !== s.editor.activeAiPatchContainerId),
              },
              activeAiPatchContainerId: null,
              activeAiSubMaskId: null,
              activeLocalEditKind: null,
            }));
          }
        },
      },
      {
        match: (e: KeyboardEvent, s: ShortcutState) =>
          s.ui.activeView === 'library' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code),
        execute: (e: KeyboardEvent, s: ShortcutState) => {
          e.preventDefault();
          const isNext = e.code === 'ArrowRight' || e.code === 'ArrowDown';
          const activePath = s.library.libraryActivePath;
          if (!activePath || sortedListRef.current.length === 0) return;
          const currentIndex = sortedListRef.current.findIndex((img) => img.path === activePath);
          if (currentIndex === -1) return;
          let nextIndex = isNext ? currentIndex + 1 : currentIndex - 1;
          if (nextIndex >= sortedListRef.current.length) nextIndex = 0;
          if (nextIndex < 0) nextIndex = sortedListRef.current.length - 1;
          const nextImage = sortedListRef.current[nextIndex];
          if (nextImage) {
            s.library.setLibrary({ libraryActivePath: nextImage.path, multiSelectedPaths: [nextImage.path] });
            handleImageSelect(nextImage.path, false);
          }
        },
      },
    ];

    const handleKeyDown = (event: KeyboardEvent) => {
      const state = getStoreState();

      const isModalOpen =
        state.ui.isCreateFolderModalOpen ||
        state.ui.isRenameFolderModalOpen ||
        state.ui.isRenameFileModalOpen ||
        state.ui.isImportModalOpen ||
        state.ui.isCopyPasteSettingsModalOpen ||
        state.ui.confirmModalState.isOpen ||
        state.ui.panoramaModalState.isOpen ||
        state.ui.cullingModalState.isOpen ||
        state.ui.collageModalState.isOpen ||
        state.ui.denoiseModalState.isOpen ||
        state.ui.negativeModalState.isOpen;

      if (isModalOpen) return;

      if (state.ui.isSettingsOpen) {
        if (event.code === 'Escape') {
          event.preventDefault();
          state.ui.setUI({ isSettingsOpen: false });
        }
        return;
      }

      const isInputFocused =
        document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if (isInputFocused) return;

      for (const builtin of builtinShortcuts) {
        if (builtin.match(event, state)) {
          builtin.execute(event, state);
          return;
        }
      }

      const normalized = normalizeCombo(event, state.settings.osPlatform);
      const action = comboMap.get(normalized.join('+'));

      if (action) {
        const handler = actions[action];
        if (handler && (!handler.shouldFire || handler.shouldFire(state))) {
          handler.execute(event, state);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    handleBackToLibrary,
    handleDeleteSelected,
    handleGoHome,
    handleImageSelect,
    handlePasteFiles,
    handleZoomChange,
    handleRotate,
    handleCopyAdjustments,
    handleCopyImagePaths,
    handlePasteAdjustments,
    handleRate,
    handleSetColorLabel,
    toggleShowOriginal,
  ]);
};
