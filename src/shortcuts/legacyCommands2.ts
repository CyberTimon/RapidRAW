import { Panel } from '../components/ui/AppProperties';
import type { ShortcutEnvironment, CommandHandlers } from './types';
export function legacyCommands2(env: ShortcutEnvironment): CommandHandlers {
  const { handleZoomChange, handleRotate, handleToggleFullScreen, toggleShowOriginal } = env;
  return {
    zoom_in: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
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
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
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
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (e) => {
        e.preventDefault();
        handleZoomChange(0, true);
      },
    },
    zoom_100: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (e) => {
        e.preventDefault();
        handleZoomChange(1.0);
      },
    },
    rotate_left: {
      shouldFire: (s) => !!s.editor.selectedImage || !!s.library.libraryActivePath,
      execute: (e) => {
        e.preventDefault();
        handleRotate(-90);
      },
    },
    rotate_right: {
      shouldFire: (s) => !!s.editor.selectedImage || !!s.library.libraryActivePath,
      execute: (e) => {
        e.preventDefault();
        handleRotate(90);
      },
    },
    toggle_fullscreen: {
      shouldFire: (s) => !!s.editor.selectedImage,
      execute: (e) => {
        e.preventDefault();
        handleToggleFullScreen();
      },
    },
    show_original: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (e) => {
        e.preventDefault();
        toggleShowOriginal();
      },
    },
    toggle_adjustments: {
      shouldFire: () => true,
      execute: (e, s) => {
        e.preventDefault();
        s.ui.setPanel(Panel.Adjustments);
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
  };
}
