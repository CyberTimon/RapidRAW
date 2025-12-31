import { useEffect } from 'react';
import { useBloc } from '@blac/react';
import { EditorCubit, LibraryCubit, MasksCubit, ModalsCubit } from '../cubits';
import { ImageFile, Panel } from '../components/ui/AppProperties';

interface KeyboardShortcutsProps {
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
  handleSetColorLabel(label: string | null): void;
  handleToggleFullScreen(): void;
  handleZoomChange(zoomValue: number, fitToWindow?: boolean): void;
  setCopiedFilePaths(paths: Array<string>): void;
  onSelectPatchContainer?(container: string | null): void;
}

export const useKeyboardShortcuts = ({
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
  handleSetColorLabel,
  handleToggleFullScreen,
  handleZoomChange,
  setCopiedFilePaths,
  onSelectPatchContainer,
}: KeyboardShortcutsProps) => {
  // Get state and actions from cubits
  const [editorState, editorCubit] = useBloc(EditorCubit);
  const [libraryState, libraryCubit] = useBloc(LibraryCubit);
  const [masksState, masksCubit] = useBloc(MasksCubit);
  const [modalsState] = useBloc(ModalsCubit);

  // Destructure needed state from cubits
  const {
    selectedImage,
    activeRightPanel,
    isStraightenActive,
    isFullScreen,
    displaySize,
    baseRenderSize,
    originalSize,
    libraryActivePath,
  } = editorState;

  const canUndo = editorCubit.canUndo;
  const canRedo = editorCubit.canRedo;

  const { multiSelectedPaths } = libraryState;
  const sortedImageList = libraryCubit.sortedImageList;

  const {
    activeMaskContainerId,
    activeMaskId,
    activeAiPatchContainerId,
    activeAiSubMaskId,
  } = masksState;

  // Check if any modal is open
  const isModalOpen =
    modalsState.createFolder.isOpen ||
    modalsState.renameFolder.isOpen ||
    modalsState.renameFile.isOpen ||
    modalsState.import.isOpen ||
    modalsState.copyPasteSettings.isOpen ||
    modalsState.denoise.isOpen ||
    modalsState.confirm.isOpen ||
    modalsState.panorama.isOpen ||
    modalsState.culling.isOpen ||
    modalsState.collage.isOpen;

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
            editorCubit.setIsStraightenActive(false);
          } else if (customEscapeHandler) {
            customEscapeHandler();
          } else if (activeAiSubMaskId) {
            masksCubit.setActiveAiSubMask(null);
          } else if (activeAiPatchContainerId && onSelectPatchContainer) {
            onSelectPatchContainer(null);
          } else if (activeMaskId) {
            masksCubit.setActiveMask(null);
          } else if (activeMaskContainerId) {
            masksCubit.setActiveMaskContainer(null);
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
          const currentPercent =
            originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
              ? Math.round((displaySize.width / originalSize.width) * 100)
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
              fitPercent = Math.round((baseRenderSize.width / originalSize.width) * 100);
            } else {
              // Height is limiting (portrait)
              fitPercent = Math.round((baseRenderSize.height / originalSize.height) * 100);
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
          editorCubit.toggleShowOriginal();
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
        if (key === 'w' && !isCtrl) {
          event.preventDefault();
          editorCubit.toggleWaveform();
        }
      } else {
        if ((key === 'enter' || key === ' ') && !isCtrl) {
          event.preventDefault();
          if (libraryActivePath) {
            handleImageSelect(libraryActivePath);
          }
          return;
        }
      }

      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();

        if (selectedImage) {
          if (key === 'arrowup' || key === 'arrowdown') {
            // Calculate current zoom percentage relative to original
            const currentPercent =
              originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
                ? displaySize.width / originalSize.width
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
            editorCubit.setLibraryActivePath(nextImage.path);
            libraryCubit.setSelection([nextImage.path]);
          }
        }
      }

      if (code.startsWith('Digit') && !isCtrl) {
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
      } else if (['0', '1', '2', '3', '4', '5'].includes(key) && !isCtrl) {
        event.preventDefault();
        handleRate(parseInt(key, 10));
      }

      if (key === 'delete') {
        event.preventDefault();
        if (activeMaskContainerId) {
          handleDeleteMaskContainer(activeMaskContainerId);
        } else if (activeAiPatchContainerId) {
          handleDeleteAiPatch(activeAiPatchContainerId);
        } else {
          handleDeleteSelected();
        }
      }

      if (isCtrl) {
        const currentPercent =
          originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0
            ? displaySize.width / originalSize.width
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
              libraryCubit.setSelection(sortedImageList.map((f: ImageFile) => f.path));
              if (!selectedImage) {
                editorCubit.setLibraryActivePath(sortedImageList[sortedImageList.length - 1].path);
              }
            }
            break;
          case 'z':
            if (selectedImage) {
              event.preventDefault();
              editorCubit.undo();
            }
            break;
          case 'y':
            if (selectedImage) {
              event.preventDefault();
              editorCubit.redo();
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
    canRedo,
    canUndo,
    copiedFilePaths,
    customEscapeHandler,
    editorCubit,
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
    handleSetColorLabel,
    handleToggleFullScreen,
    handleZoomChange,
    isFullScreen,
    isModalOpen,
    isStraightenActive,
    libraryCubit,
    libraryActivePath,
    masksCubit,
    multiSelectedPaths,
    onSelectPatchContainer,
    selectedImage,
    setCopiedFilePaths,
    sortedImageList,
    displaySize,
    baseRenderSize,
    originalSize,
  ]);
};
