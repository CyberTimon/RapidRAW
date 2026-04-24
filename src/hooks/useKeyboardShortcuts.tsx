import { useEffect } from 'react';
import { ImageFile, Panel, SelectedImage, NumpadSettings } from '../components/ui/AppProperties';
import { BrushSettings } from '../components/ui/AppProperties';
import { Adjustments, INITIAL_FILM_OFFSETS } from '../utils/adjustments';

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
  isViewLoading: boolean;
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
  numpadSettings?: NumpadSettings;
  setNumpadSettings?: (settings: NumpadSettings) => void;
  handleExportCurrent?: () => void;
  handleInstantExport?: () => Promise<boolean>;
  adjustments: Adjustments;
  setAdjustments: (adjustments: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => void;
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
  isViewLoading,
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
  numpadSettings,
  setNumpadSettings,
  handleExportCurrent,
  handleInstantExport,
  adjustments,
  setAdjustments,
}: KeyboardShortcutsProps) => {
  useEffect(() => {
    const handleKeyDown = (event: any) => {
      if (isModalOpen) {
        return;
      }

      const isInputFocused =
        document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if (isInputFocused) {
        return;
      }
      const isCtrl = event.ctrlKey || event.metaKey;
      const isShift = event.shiftKey;
      const key = event.key.toLowerCase();
      const code = event.code;

      if (selectedImage) {
        if (key === 'escape') {
          event.preventDefault();
          if (isStraightenActive) {
            setIsStraightenActive(false);
          } else if (customEscapeHandler) {
            customEscapeHandler();
          } else if (activeAiSubMaskId) {
            setActiveAiSubMaskId(null);
          } else if (activeAiPatchContainerId && onSelectPatchContainer) {
            onSelectPatchContainer(null);
          } else if (activeMaskId) {
            setActiveMaskId(null);
          } else if (activeMaskContainerId) {
            setActiveMaskContainerId(null);
          } else if (activeRightPanel === Panel.Crop) {
            handleRightPanelSelect(Panel.Adjustments);
          } else if (isFullScreen) {
            handleToggleFullScreen();
          } else {
            handleBackToLibrary();
          }
          return;
        }
        if (key === ' ' && !isCtrl) {
          event.preventDefault();

          // Calculate current zoom percentage relative to original
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? Math.round(((displaySize.width * dpr) / originalSize.width) * 100)
              : 100;

          // Toggle between fit-to-window, 2x fit-to-window (if < 100%), and 100%
          let fitPercent = 100;
          if (
            originalSize &&
            originalSize.width > 0 &&
            originalSize.height > 0 &&
            baseRenderSize &&
            baseRenderSize.width > 0 &&
            baseRenderSize.height > 0
          ) {
            const originalAspect = originalSize.width / originalSize.height;
            const baseAspect = baseRenderSize.width / baseRenderSize.height;

            if (originalAspect > baseAspect) {
              // Width is limiting (landscape)
              fitPercent = Math.round(((baseRenderSize.width * dpr) / originalSize.width) * 100);
            } else {
              // Height is limiting (portrait)
              fitPercent = Math.round(((baseRenderSize.height * dpr) / originalSize.height) * 100);
            }
          }

          const doubleFitPercent = fitPercent * 2;
          if (Math.abs(currentPercent - fitPercent) < 5) {
            // Zoom 2x FitToWindows
            handleZoomChange(doubleFitPercent < 100 ? doubleFitPercent / 100 : 1.0);
          } else if (Math.abs(currentPercent - doubleFitPercent) < 5 && doubleFitPercent < 100) {
            // Zoom 100%
            handleZoomChange(1.0);
          } else {
            // Zoom FitToWindows
            handleZoomChange(0, true);
          }
          return;
        }
        if (key === 'f' && !isCtrl) {
          event.preventDefault();
          handleToggleFullScreen();
        }
        if (key === 'b' && !isCtrl) {
          event.preventDefault();
          setShowOriginal((prev: boolean) => !prev);
        }
        if (key === 'd' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Adjustments);
        }
        if (key === 'r' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Crop);
        }
        if (key === 'm' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Masks);
        }
        if (key === 'k' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Ai);
        }
        if (key === 'p' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Presets);
        }
        if (key === 'i' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Metadata);
        }
        if (key === 'e' && !isCtrl) {
          event.preventDefault();
          handleRightPanelSelect(Panel.Export);
        }
        if (key === 'a' && !isCtrl) {
          event.preventDefault();
          setIsWaveformVisible((prev: boolean) => !prev);
        }
        if (key === 's' && !isCtrl) {
          event.preventDefault();
          if (activeRightPanel === Panel.Crop) {
            setIsStraightenActive((prev: boolean) => !prev);
          } else {
            handleRightPanelSelect(Panel.Crop);
            setIsStraightenActive(true);
          }
        }
      } else {
        if ((key === 'enter' || key === ' ') && !isCtrl && code !== 'NumpadEnter') {
          event.preventDefault();
          if (libraryActivePath) {
            handleImageSelect(libraryActivePath);
          }
          return;
        }
      }

      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();

        if (!isCtrl) {
          if (selectedImage) {
            if (key === 'arrowup' || key === 'arrowdown') {
              const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
              // Calculate current zoom percentage relative to original
              const currentPercent =
                originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
                  ? (displaySize.width * dpr) / originalSize.width
                  : 1.0;

              const step = 0.1; // 10% steps
              const newPercent = key === 'arrowup' ? currentPercent + step : currentPercent - step;

              // Clamp to 10%-200% of original size
              const clampedPercent = Math.max(0.1, Math.min(newPercent, 2.0));
              handleZoomChange(clampedPercent);
            } else {
              const isNext = key === 'arrowright';
              const currentIndex = sortedImageList.findIndex((img: ImageFile) => img.path === selectedImage.path);
              if (currentIndex === -1) {
                return;
              }
              let nextIndex = isNext ? currentIndex + 1 : currentIndex - 1;
              if (nextIndex >= sortedImageList.length) {
                nextIndex = 0;
              }
              if (nextIndex < 0) {
                nextIndex = sortedImageList.length - 1;
              }
              const nextImage = sortedImageList[nextIndex];
              if (nextImage) {
                handleImageSelect(nextImage.path);
              }
            }
          } else {
            const isNext = key === 'arrowright' || key === 'arrowdown';
            const activePath = libraryActivePath;
            if (!activePath || sortedImageList.length === 0) {
              return;
            }
            const currentIndex = sortedImageList.findIndex((img: ImageFile) => img.path === activePath);
            if (currentIndex === -1) {
              return;
            }
            let nextIndex = isNext ? currentIndex + 1 : currentIndex - 1;
            if (nextIndex >= sortedImageList.length) {
              nextIndex = 0;
            }
            if (nextIndex < 0) {
              nextIndex = sortedImageList.length - 1;
            }
            const nextImage = sortedImageList[nextIndex];
            if (nextImage) {
              setLibraryActivePath(nextImage.path);
              setMultiSelectedPaths([nextImage.path]);
            }
          }
        }
      }

      if (code.startsWith('Digit') && !isCtrl && !code.startsWith('Numpad')) {
        event.preventDefault();
        const keyNum = parseInt(code.replace('Digit', ''), 10);

        if (isShift) {
          if (keyNum === 0) {
            handleSetColorLabel(null);
          } else if (keyNum >= 1 && keyNum <= 5) {
            const colors = ['red', 'yellow', 'green', 'blue', 'purple'];
            handleSetColorLabel(colors[keyNum - 1]);
          }
        } else {
          if (keyNum >= 0 && keyNum <= 5) {
            handleRate(keyNum);
          }
        }
      } else if (['0', '1', '2', '3', '4', '5'].includes(key) && !isCtrl && !code.startsWith('Numpad')) {
        event.preventDefault();
        handleRate(parseInt(key, 10));
      }

      if (key === '[' && !isCtrl && selectedImage) {
        event.preventDefault();
        handleRotate(-90);
      }
      if (key === ']' && !isCtrl && selectedImage) {
        event.preventDefault();
        handleRotate(90);
      }

      // On macOS the physical ⌫ key sends Backspace, not Delete.
      // File deletion follows macOS convention: Cmd + Delete (i.e. Cmd + Backspace).
      // Non-destructive mask/patch deletion uses plain Backspace on macOS.
      // On all other platforms the existing plain Delete behaviour is preserved.
      const isMacOS = osPlatform === 'macos';
      const isDeletePressed = isMacOS ? key === 'backspace' : key === 'delete';

      if (isDeletePressed) {
        event.preventDefault();
        if (activeMaskContainerId) {
          handleDeleteMaskContainer(activeMaskContainerId);
        } else if (activeAiPatchContainerId) {
          handleDeleteAiPatch(activeAiPatchContainerId);
        } else if (!isMacOS || isCtrl) {
          // macOS: Cmd modifier required for (destructive) file deletion
          // Other platforms: plain Delete triggers file deletion
          handleDeleteSelected();
        }
      }

      // Numpad shortcuts for film-style adjustments
      if (numpadSettings?.enabled && selectedImage) {
        const stepSizes = numpadSettings.stepSizes;
        const mode = numpadSettings.mode;

        // Handle numpad keys
        if (code.startsWith('Numpad') && !isCtrl) {
          event.preventDefault();

          switch (code) {
            case 'Numpad7':
              // - Yellow / + Blue
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  temperature: (prev.temperature || 0) - stepSizes.rgbCmy,
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: {
                    ...(prev.filmColorOffsets || INITIAL_FILM_OFFSETS),
                    yellowBlue: (prev.filmColorOffsets?.yellowBlue || 0) - stepSizes.rgbCmy,
                  },
                }));
              }
              break;
            case 'Numpad4':
              // + Yellow / - Blue
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  temperature: (prev.temperature || 0) + stepSizes.rgbCmy,
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: {
                    ...(prev.filmColorOffsets || INITIAL_FILM_OFFSETS),
                    yellowBlue: (prev.filmColorOffsets?.yellowBlue || 0) + stepSizes.rgbCmy,
                  },
                }));
              }
              break;
            case 'Numpad8':
              // - Magenta / + Green
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  tint: (prev.tint || 0) - stepSizes.rgbCmy,
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: {
                    ...(prev.filmColorOffsets || INITIAL_FILM_OFFSETS),
                    magentaGreen: (prev.filmColorOffsets?.magentaGreen || 0) - stepSizes.rgbCmy,
                  },
                }));
              }
              break;
            case 'Numpad5':
              // + Magenta / - Green
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  tint: (prev.tint || 0) + stepSizes.rgbCmy,
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: {
                    ...(prev.filmColorOffsets || INITIAL_FILM_OFFSETS),
                    magentaGreen: (prev.filmColorOffsets?.magentaGreen || 0) + stepSizes.rgbCmy,
                  },
                }));
              }
              break;
            case 'Numpad9':
              // - Cyan / + Red (Film mode only)
              if (mode === 'film') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: {
                    ...(prev.filmColorOffsets || INITIAL_FILM_OFFSETS),
                    cyanRed: (prev.filmColorOffsets?.cyanRed || 0) - stepSizes.rgbCmy,
                  },
                }));
              }
              break;
            case 'Numpad6':
              // + Cyan / - Red (Film mode only)
              if (mode === 'film') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: {
                    ...(prev.filmColorOffsets || INITIAL_FILM_OFFSETS),
                    cyanRed: (prev.filmColorOffsets?.cyanRed || 0) + stepSizes.rgbCmy,
                  },
                }));
              }
              break;
            case 'Numpad1':
              // - Density (brighten)
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  exposure: Math.max(-5, Math.min(5, (prev.exposure || 0) + stepSizes.exposure)),
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  exposure: Math.max(-5, Math.min(5, (prev.exposure || 0) + stepSizes.exposure)),
                  blacks: (prev.blacks || 0) + 2,
                }));
              }
              break;
            case 'NumpadDecimal':
              // + Density (darken)
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  exposure: Math.max(-5, Math.min(5, (prev.exposure || 0) - stepSizes.exposure)),
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  exposure: Math.max(-5, Math.min(5, (prev.exposure || 0) - stepSizes.exposure)),
                  blacks: (prev.blacks || 0) - 2,
                }));
              }
              break;
            case 'Numpad2':
              // - Contrast (soften)
              setAdjustments((prev: Adjustments) => ({
                ...prev,
                contrast: Math.max(-100, Math.min(100, (prev.contrast || 0) - stepSizes.contrast)),
              }));
              break;
            case 'Numpad3':
              // + Contrast (harden)
              setAdjustments((prev: Adjustments) => ({
                ...prev,
                contrast: Math.max(-100, Math.min(100, (prev.contrast || 0) + stepSizes.contrast)),
              }));
              break;
            case 'Numpad0':
              // Reset color adjustments
              if (mode === 'digital') {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  temperature: 0,
                  tint: 0,
                }));
              } else {
                setAdjustments((prev: Adjustments) => ({
                  ...prev,
                  filmColorOffsets: { ...INITIAL_FILM_OFFSETS },
                }));
              }
              break;
            case 'NumpadEnter':
              // Handle based on enterKeyMode
              switch (numpadSettings.enterKeyMode) {
                case 'next':
                  // Move to next image
                  const nextIndex = sortedImageList.findIndex(
                    (img: ImageFile) => img.path === selectedImage.path
                  );
                  if (nextIndex !== -1) {
                    let newIndex = nextIndex + 1;
                    if (newIndex >= sortedImageList.length) {
                      newIndex = 0;
                    }
                    const nextImage = sortedImageList[newIndex];
                    if (nextImage) {
                      handleImageSelect(nextImage.path);
                    }
                  }
                  break;
                case 'instant-export':
                  // Export and move to next after completion
                  if (handleInstantExport) {
                    (async () => {
                      const exportSuccess = await handleInstantExport();
                      if (exportSuccess) {
                        const currentIndex = sortedImageList.findIndex(
                          (img: ImageFile) => img.path === selectedImage.path
                        );
                        if (currentIndex !== -1) {
                          let newIndex = currentIndex + 1;
                          if (newIndex >= sortedImageList.length) {
                            newIndex = 0;
                          }
                          const nextImage = sortedImageList[newIndex];
                          if (nextImage) {
                            handleImageSelect(nextImage.path);
                          }
                        }
                      }
                      // If export failed, stay on current image (error shown in handleInstantExport)
                    })();
                  }
                  break;
                case 'skip-move':
                  // Just move to next (revert metadata changes)
                  const skipIndex = sortedImageList.findIndex(
                    (img: ImageFile) => img.path === selectedImage.path
                  );
                  if (skipIndex !== -1) {
                    let newIndex = skipIndex + 1;
                    if (newIndex >= sortedImageList.length) {
                      newIndex = 0;
                    }
                    const nextImage = sortedImageList[newIndex];
                    if (nextImage) {
                      handleImageSelect(nextImage.path);
                    }
                  }
                  break;
              }
              break;
            default:
              break;
          }
        }
      }

      if (isCtrl) {
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const currentPercent =
          originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
            ? (displaySize.width * dpr) / originalSize.width
            : 1.0;

        switch (key) {
          case 'c':
            event.preventDefault();
            if (event.shiftKey) {
              if (multiSelectedPaths.length > 0) {
                setCopiedFilePaths(multiSelectedPaths);
              }
            } else {
              handleCopyAdjustments();
            }
            break;
          case 'v':
            event.preventDefault();
            if (event.shiftKey) {
              handlePasteFiles('copy');
            } else {
              handlePasteAdjustments();
            }
            break;
          case 'a':
            event.preventDefault();
            if (sortedImageList.length > 0) {
              setMultiSelectedPaths(sortedImageList.map((f: ImageFile) => f.path));
              if (!selectedImage) {
                setLibraryActivePath(sortedImageList[sortedImageList.length - 1].path);
              }
            }
            break;
          case 'z':
            if (selectedImage) {
              event.preventDefault();
              undo();
            }
            break;
          case 'y':
            if (selectedImage) {
              event.preventDefault();
              redo();
            }
            break;
          case '0':
          case ')':
            event.preventDefault();
            handleZoomChange(0, true); // Fit to window
            break;
          case '1':
          case '!':
            event.preventDefault();
            handleZoomChange(1.0); // 100%
            break;
          case '=':
          case '+':
            event.preventDefault();
            handleZoomChange(Math.min(currentPercent * 1.2, 2.0));
            break;
          case '-':
          case '_':
            event.preventDefault();
            handleZoomChange(Math.max(currentPercent / 1.2, 0.1));
            break;
          case 'arrowup':
            event.preventDefault();
            if (brushSettings && activeRightPanel === Panel.Masks) {
              const newSize = Math.min((brushSettings.size || 50) + 10, 200);
              setBrushSettings({ ...brushSettings, size: newSize });
            }
            break;
          case 'arrowdown':
            event.preventDefault();
            if (brushSettings && activeRightPanel === Panel.Masks) {
              const newSize = Math.max((brushSettings.size || 50) - 10, 1);
              setBrushSettings({ ...brushSettings, size: newSize });
            }
            break;
          default:
            break;
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
    isViewLoading,
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
    numpadSettings,
    setNumpadSettings,
    handleExportCurrent,
    adjustments,
    setAdjustments,
  ]);
};
