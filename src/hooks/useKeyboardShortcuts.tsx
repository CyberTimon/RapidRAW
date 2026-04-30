import { useEffect, useMemo } from 'react';
import { KeybindHandler, ImageFile, Panel, SelectedImage } from '../components/ui/AppProperties';
import { BrushSettings } from '../components/ui/AppProperties';
import { KeybindDefinition, KEYBIND_DEFINITIONS, normalizeCombo } from '../utils/keyboardUtils';

interface KeyboardShortcutsProps {
  activeAiPatchContainerId?: string | null;
  activeAiSubMaskId: string | null;
  osPlatform: string;
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeRightPanel: Panel | null;
  canRedo: boolean;
  canUndo: boolean;
  copiedFilePaths: Array<string>;
  customEscapeHandler: any;
  handleBackToLibrary(): void;
  handleCopyAdjustments(): void;
  handleDeleteAiPatch(patchId: string): void;
  handleDeleteMaskContainer(containerId: string): void;
  handleDeleteSelected(): void;
  handleImageSelect(path: string): void;
  handlePasteAdjustments(): void;
  handlePasteFiles(str: string): void;
  handleRate(rate: number): void;
  handleRightPanelSelect(panel: Panel): void;
  handleRotate(degrees: number): void;
  handleSetColorLabel(label: string | null): void;
  handleToggleFullScreen(): void;
  handleZoomChange(zoomValue: number, fitToWindow?: boolean): void;
  isFullScreen: boolean;
  isModalOpen: boolean;
  isStraightenActive: boolean;
  keybinds?: { [action: string]: string[] };
  libraryActivePath: string | null;
  multiSelectedPaths: Array<string>;
  onSelectPatchContainer?(container: string | null): void;
  redo(): void;
  selectedImage: SelectedImage | null;
  setActiveAiSubMaskId(id: string | null): void;
  setActiveMaskContainerId(id: string | null): void;
  setActiveMaskId(id: string | null): void;
  setCopiedFilePaths(paths: Array<string>): void;
  setIsStraightenActive(active: any): void;
  setIsWaveformVisible(visible: any): void;
  setLibraryActivePath(path: string): void;
  setMultiSelectedPaths(paths: Array<string>): void;
  setShowOriginal(show: any): void;
  sortedImageList: Array<ImageFile>;
  undo(): void;
  zoom: number;
  displaySize?: { width: number; height: number };
  baseRenderSize?: { width: number; height: number };
  originalSize?: { width: number; height: number };
  brushSettings: BrushSettings | null;
  setBrushSettings: (settings: BrushSettings) => void;
}

export const useKeyboardShortcuts = ({
  activeAiPatchContainerId,
  activeAiSubMaskId,
  activeMaskContainerId,
  activeMaskId,
  activeRightPanel,
  osPlatform,
  canRedo,
  canUndo,
  copiedFilePaths,
  customEscapeHandler,
  handleBackToLibrary,
  handleCopyAdjustments,
  handleDeleteAiPatch,
  handleDeleteMaskContainer,
  handleDeleteSelected,
  handleImageSelect,
  handlePasteAdjustments,
  handlePasteFiles,
  handleRate,
  handleRightPanelSelect,
  handleRotate,
  handleSetColorLabel,
  handleToggleFullScreen,
  handleZoomChange,
  isFullScreen,
  isModalOpen,
  isStraightenActive,
  keybinds,
  libraryActivePath,
  multiSelectedPaths,
  onSelectPatchContainer,
  redo,
  selectedImage,
  setActiveAiSubMaskId,
  setActiveMaskContainerId,
  setActiveMaskId,
  setCopiedFilePaths,
  setIsStraightenActive,
  setIsWaveformVisible,
  setLibraryActivePath,
  setMultiSelectedPaths,
  setShowOriginal,
  sortedImageList,
  undo,
  zoom,
  displaySize,
  baseRenderSize,
  originalSize,
  brushSettings,
  setBrushSettings,
}: KeyboardShortcutsProps) => {
  function getEffectiveCombo(def: KeybindDefinition): string[] | null {
    const userCombo = keybinds?.[def.action];
    if (userCombo !== undefined) {
      return userCombo.length > 0 ? userCombo : null;
    }
    return def.defaultCombo;
  }

  const comboMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const def of KEYBIND_DEFINITIONS) {
      const effective = getEffectiveCombo(def);
      if (effective) {
        map.set(effective.join('+'), def.action);
      }
    }
    return map;
  }, [keybinds]);

  useEffect(() => {
    const actions: Record<string, KeybindHandler> = {
      open_image: {
        shouldFire: () => !selectedImage && libraryActivePath !== null,
        execute: (event) => { event.preventDefault(); handleImageSelect(libraryActivePath!); },
      },
      copy_adjustments: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleCopyAdjustments(); },
      },
      paste_adjustments: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handlePasteAdjustments(); },
      },
      copy_files: {
        shouldFire: () => multiSelectedPaths.length > 0,
        execute: (event) => { event.preventDefault(); setCopiedFilePaths(multiSelectedPaths); },
      },
      paste_files: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handlePasteFiles('copy'); },
      },
      select_all: {
        shouldFire: () => sortedImageList.length > 0,
        execute: (event) => {
          event.preventDefault();
          setMultiSelectedPaths(sortedImageList.map((f: ImageFile) => f.path));
          if (!selectedImage) {
            setLibraryActivePath(sortedImageList[sortedImageList.length - 1].path);
          }
        },
      },
      delete_selected: {
        shouldFire: () => {
          if (activeMaskContainerId || activeAiPatchContainerId) return false;
          return true;
        },
        execute: (event) => { event.preventDefault(); handleDeleteSelected(); },
      },
      preview_prev: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const currentIndex = sortedImageList.findIndex((img: ImageFile) => img.path === selectedImage!.path);
          if (currentIndex === -1) return;
          let nextIndex = currentIndex - 1;
          if (nextIndex < 0) nextIndex = sortedImageList.length - 1;
          handleImageSelect(sortedImageList[nextIndex].path);
        },
      },
      preview_next: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const currentIndex = sortedImageList.findIndex((img: ImageFile) => img.path === selectedImage!.path);
          if (currentIndex === -1) return;
          let nextIndex = currentIndex + 1;
          if (nextIndex >= sortedImageList.length) nextIndex = 0;
          handleImageSelect(sortedImageList[nextIndex].path);
        },
      },
      zoom_in_step: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? (displaySize.width * dpr) / originalSize.width
              : 1.0;
          handleZoomChange(Math.min(currentPercent + 0.1, 2.0));
        },
      },
      zoom_out_step: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? (displaySize.width * dpr) / originalSize.width
              : 1.0;
          handleZoomChange(Math.max(currentPercent - 0.1, 0.1));
        },
      },
      cycle_zoom: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? Math.round(((displaySize.width * dpr) / originalSize.width) * 100)
              : 100;
          let fitPercent = 100;
          if (originalSize && originalSize.width > 0 && originalSize.height > 0 && baseRenderSize && baseRenderSize.width > 0 && baseRenderSize.height > 0) {
            const originalAspect = originalSize.width / originalSize.height;
            const baseAspect = baseRenderSize.width / baseRenderSize.height;
            if (originalAspect > baseAspect) {
              fitPercent = Math.round(((baseRenderSize.width * dpr) / originalSize.width) * 100);
            } else {
              fitPercent = Math.round(((baseRenderSize.height * dpr) / originalSize.height) * 100);
            }
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
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? (displaySize.width * dpr) / originalSize.width
              : 1.0;
          handleZoomChange(Math.min(currentPercent * 1.2, 2.0));
        },
      },
      zoom_out: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? (displaySize.width * dpr) / originalSize.width
              : 1.0;
          handleZoomChange(Math.max(currentPercent / 1.2, 0.1));
        },
      },
      zoom_fit: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleZoomChange(0, true); },
      },
      zoom_100: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleZoomChange(1.0); },
      },
      rotate_left: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRotate(-90); },
      },
      rotate_right: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRotate(90); },
      },
      undo: {
        shouldFire: () => !!selectedImage && canUndo,
        execute: (event) => { event.preventDefault(); undo(); },
      },
      redo: {
        shouldFire: () => !!selectedImage && canRedo,
        execute: (event) => { event.preventDefault(); redo(); },
      },
      toggle_fullscreen: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleToggleFullScreen(); },
      },
      show_original: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); setShowOriginal((prev: boolean) => !prev); },
      },
      toggle_adjustments: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Adjustments); },
      },
      toggle_crop_panel: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Crop); },
      },
      toggle_masks: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Masks); },
      },
      toggle_ai: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Ai); },
      },
      toggle_presets: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Presets); },
      },
      toggle_metadata: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Metadata); },
      },
      toggle_analytics: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); setIsWaveformVisible((prev: boolean) => !prev); },
      },
      toggle_export: {
        shouldFire: () => !!selectedImage,
        execute: (event) => { event.preventDefault(); handleRightPanelSelect(Panel.Export); },
      },
      toggle_crop: {
        shouldFire: () => !!selectedImage,
        execute: (event) => {
          event.preventDefault();
          if (activeRightPanel === Panel.Crop) {
            setIsStraightenActive((prev: boolean) => !prev);
          } else {
            handleRightPanelSelect(Panel.Crop);
            setIsStraightenActive(true);
          }
        },
      },
      rate_0: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleRate(0); },
      },
      rate_1: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleRate(1); },
      },
      rate_2: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleRate(2); },
      },
      rate_3: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleRate(3); },
      },
      rate_4: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleRate(4); },
      },
      rate_5: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleRate(5); },
      },
      color_label_none: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleSetColorLabel(null); },
      },
      color_label_red: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleSetColorLabel('red'); },
      },
      color_label_yellow: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleSetColorLabel('yellow'); },
      },
      color_label_green: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleSetColorLabel('green'); },
      },
      color_label_blue: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleSetColorLabel('blue'); },
      },
      color_label_purple: {
        shouldFire: () => true,
        execute: (event) => { event.preventDefault(); handleSetColorLabel('purple'); },
      },
      brush_size_up: {
        shouldFire: () => !!selectedImage && !!brushSettings && activeRightPanel === Panel.Masks,
        execute: (event) => {
          event.preventDefault();
          if (!brushSettings) return;
          const newSize = Math.min((brushSettings.size || 50) + 10, 200);
          setBrushSettings({ feather: brushSettings.feather, size: newSize, tool: brushSettings.tool });
        },
      },
      brush_size_down: {
        shouldFire: () => !!selectedImage && !!brushSettings && activeRightPanel === Panel.Masks,
        execute: (event) => {
          event.preventDefault();
          if (!brushSettings) return;
          const newSize = Math.max((brushSettings.size || 50) - 10, 1);
          setBrushSettings({ feather: brushSettings.feather, size: newSize, tool: brushSettings.tool });
        },
      },
    };

    type BuiltInMatch = (e: KeyboardEvent) => boolean;
    type BuiltInExec = (e: KeyboardEvent) => void;

    const builtinShortcuts: Array<{ match: BuiltInMatch; execute: BuiltInExec }> = [
      {
        match: (e) => e.code === 'Escape',
        execute: (e) => {
          e.preventDefault();
          if (isStraightenActive) setIsStraightenActive(false);
          else if (customEscapeHandler) customEscapeHandler();
          else if (activeAiSubMaskId) setActiveAiSubMaskId(null);
          else if (activeAiPatchContainerId && onSelectPatchContainer) onSelectPatchContainer(null);
          else if (activeMaskId) setActiveMaskId(null);
          else if (activeMaskContainerId) setActiveMaskContainerId(null);
          else if (activeRightPanel === Panel.Crop) handleRightPanelSelect(Panel.Adjustments);
          else if (isFullScreen) handleToggleFullScreen();
          else if (selectedImage) handleBackToLibrary();
        },
      },
      {
        match: (e) => {
          if (osPlatform === 'macos') return e.code === 'Backspace';
          return e.code === 'Delete';
        },
        execute: (e) => {
          e.preventDefault();
          if (activeMaskContainerId) handleDeleteMaskContainer(activeMaskContainerId);
          else if (activeAiPatchContainerId) handleDeleteAiPatch(activeAiPatchContainerId);
        },
      },
      {
        match: (e) => !selectedImage && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code),
        execute: (e) => {
          e.preventDefault();
          const isNext = e.code === 'ArrowRight' || e.code === 'ArrowDown';
          const activePath = libraryActivePath;
          if (!activePath || sortedImageList.length === 0) return;
          const currentIndex = sortedImageList.findIndex((img: ImageFile) => img.path === activePath);
          if (currentIndex === -1) return;
          let nextIndex = isNext ? currentIndex + 1 : currentIndex - 1;
          if (nextIndex >= sortedImageList.length) nextIndex = 0;
          if (nextIndex < 0) nextIndex = sortedImageList.length - 1;
          const nextImage = sortedImageList[nextIndex];
          if (nextImage) {
            setLibraryActivePath(nextImage.path);
            setMultiSelectedPaths([nextImage.path]);
          }
        },
      },
    ];

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isModalOpen) return;

      const isInputFocused =
        document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if (isInputFocused) return;

      for (const builtin of builtinShortcuts) {
        if (builtin.match(event)) {
          builtin.execute(event);
          return;
        }
      }

      const normalized = normalizeCombo(event, osPlatform);
      const action = comboMap.get(normalized.join('+'));
      if (action) {
        const handler = actions[action];
        if (handler && (!handler.shouldFire || handler.shouldFire())) {
          handler.execute(event);
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    activeAiPatchContainerId,
    activeAiSubMaskId,
    activeMaskContainerId,
    activeMaskId,
    activeRightPanel,
    osPlatform,
    canRedo,
    canUndo,
    copiedFilePaths,
    customEscapeHandler,
    handleBackToLibrary,
    handleCopyAdjustments,
    handleDeleteAiPatch,
    handleDeleteMaskContainer,
    handleDeleteSelected,
    handleImageSelect,
    handlePasteAdjustments,
    handlePasteFiles,
    handleRate,
    handleRightPanelSelect,
    handleRotate,
    handleSetColorLabel,
    handleToggleFullScreen,
    handleZoomChange,
    isFullScreen,
    isStraightenActive,
    keybinds,
    libraryActivePath,
    multiSelectedPaths,
    onSelectPatchContainer,
    redo,
    selectedImage,
    setActiveAiSubMaskId,
    setActiveMaskContainerId,
    setActiveMaskId,
    setCopiedFilePaths,
    setIsStraightenActive,
    setIsWaveformVisible,
    setLibraryActivePath,
    setMultiSelectedPaths,
    setShowOriginal,
    sortedImageList,
    undo,
    zoom,
    displaySize,
    baseRenderSize,
    originalSize,
    brushSettings,
    setBrushSettings,
  ]);
};
