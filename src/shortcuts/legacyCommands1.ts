import { type ImageFile } from '../components/ui/AppProperties';
import type { ShortcutEnvironment, CommandHandlers } from './types';
export function legacyCommands1(env: ShortcutEnvironment): CommandHandlers {
  const {
    handleImageSelect,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleSyncAdjustments,
    handleCopyImagePaths,
    getImagePathsForCopy,
    handlePasteFiles,
    handleDeleteSelected,
    sortedListRef,
    handleZoomChange,
  } = env;
  return {
    open_image: {
      shouldFire: (s) => s.ui.activeView === 'library' && s.library.libraryActivePath !== null,
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
    sync_adjustments: {
      shouldFire: (s) => s.library.multiSelectedPaths.length > 1,
      execute: (e) => {
        e.preventDefault();
        void handleSyncAdjustments();
      },
    },
    copy_image_path: {
      shouldFire: (s) => getImagePathsForCopy(s).length > 0,
      execute: (e, s) => {
        e.preventDefault();
        handleCopyImagePaths(getImagePathsForCopy(s));
      },
    },
    copy_files: {
      shouldFire: (s) => s.library.multiSelectedPaths.length > 0,
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
        const sourcePath = s.library.libraryActivePath || s.editor.selectedImage?.path || sortedListRef.current[0].path;
        const allPaths = sortedListRef.current.map((file: ImageFile) => file.path);
        s.library.setLibrary({
          multiSelectedPaths: [sourcePath, ...allPaths.filter((path: string) => path !== sourcePath)],
          libraryActivePath: sourcePath,
          selectionAnchorPath: sourcePath,
        });
      },
    },
    delete_selected: {
      shouldFire: (s) => !s.editor.activeMaskContainerId && !s.editor.activeAiPatchContainerId,
      execute: (e) => {
        e.preventDefault();
        handleDeleteSelected();
      },
    },
    preview_prev: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (e, s) => {
        e.preventDefault();
        const currentIndex = sortedListRef.current.findIndex((img) => img.path === s.editor.selectedImage!.path);
        if (currentIndex === -1) return;
        const nextIndex = currentIndex - 1 < 0 ? sortedListRef.current.length - 1 : currentIndex - 1;
        handleImageSelect(sortedListRef.current[nextIndex].path, true);
      },
    },
    preview_next: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (e, s) => {
        e.preventDefault();
        const currentIndex = sortedListRef.current.findIndex((img) => img.path === s.editor.selectedImage!.path);
        if (currentIndex === -1) return;
        const nextIndex = currentIndex + 1 >= sortedListRef.current.length ? 0 : currentIndex + 1;
        handleImageSelect(sortedListRef.current[nextIndex].path, true);
      },
    },
    zoom_in_step: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
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
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
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
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
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
  };
}
