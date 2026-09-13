import { verticalTarget } from './libraryNavigation';
import { useEditorStore } from '../store/useEditorStore';
import { LibraryDisplayMode, Panel } from '../components/ui/AppProperties';
import type { CommandHandlers, ShortcutEnvironment, ShortcutState } from './types';
import { cropCommands } from './cropCommands';

export function extraCommands(env: ShortcutEnvironment): CommandHandlers {
  const activePath = (s: ShortcutState) =>
    s.ui.activeView === 'editor' ? s.editor.selectedImage?.path : s.library.libraryActivePath;
  const navigate = (s: ShortcutState, delta: number, extend = false, endpoint?: 'first' | 'last') => {
    const list = env.sortedListRef.current;
    if (!list.length) return;
    const previous = Math.max(
      0,
      list.findIndex((image) => image.path === activePath(s)),
    );
    const index =
      endpoint === 'first'
        ? 0
        : endpoint === 'last'
          ? list.length - 1
          : Math.max(0, Math.min(list.length - 1, previous + delta));
    const path = list[index].path;
    const anchor = Math.max(
      0,
      list.findIndex((image) => image.path === (s.library.selectionAnchorPath || activePath(s))),
    );
    const selected = extend
      ? list.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((image) => image.path)
      : [path];
    s.library.setLibrary({
      libraryActivePath: path,
      multiSelectedPaths: selected,
      selectionAnchorPath: extend ? list[anchor].path : path,
    });
    env.handleImageSelect(path, s.ui.activeView === 'editor');
  };
  const result: CommandHandlers = {
    ...cropCommands(),
    gallery: {
      execute: (_, s) => {
        if (s.ui.activeView === 'editor') env.handleBackToLibrary();
        else s.ui.setUI({ activeView: 'library' });
        if (s.settings.appSettings)
          void s.settings.handleSettingsChange({
            ...s.settings.appSettings,
            libraryDisplayMode: LibraryDisplayMode.Grid,
          });
      },
    },
    develop: {
      shouldFire: (s) => !!activePath(s),
      execute: (_, s) => {
        env.handleImageSelect(activePath(s)!, true);
        s.ui.setPanel(Panel.Adjustments);
      },
    },
    toggle_crop_panel: {
      shouldFire: (s) => !!activePath(s),
      execute: (_, s) => {
        if (s.ui.activeView !== 'editor') env.handleImageSelect(activePath(s)!, true);
        s.ui.setPanel(s.ui.activePanel === Panel.Crop && s.ui.activeView === 'editor' ? Panel.Adjustments : Panel.Crop);
      },
    },
    deselect_all: { execute: (_, s) => s.library.setLibrary({ multiSelectedPaths: [], selectionAnchorPath: null }) },
    select_active: {
      shouldFire: (s) => !!activePath(s),
      execute: (_, s) => s.library.setLibrary({ multiSelectedPaths: [activePath(s)!] }),
    },
    toggle_side_panels: {
      execute: (_, s) => {
        const visible = !(s.ui.uiVisibility.leftPanel || s.ui.uiVisibility.rightPanel);
        s.ui.setUI({ uiVisibility: { ...s.ui.uiVisibility, leftPanel: visible, rightPanel: visible } });
      },
    },
    toggle_all_panels: {
      execute: (_, s) => {
        const visible = !(s.ui.uiVisibility.leftPanel || s.ui.uiVisibility.rightPanel || s.ui.uiVisibility.filmstrip);
        s.ui.setUI({
          uiVisibility: { ...s.ui.uiVisibility, leftPanel: visible, rightPanel: visible, filmstrip: visible },
        });
      },
    },
    white_balance: {
      shouldFire: (s) => s.ui.activeView === 'editor' && !!s.editor.selectedImage,
      execute: (_, s) => {
        s.ui.setPanel(Panel.Adjustments);
        s.editor.setEditor({ isWbPickerActive: !s.editor.isWbPickerActive });
      },
    },
    shortcut_help: { execute: (_, s) => s.ui.setUI({ isSettingsOpen: true, settingsSection: 'shortcuts' }) },
    undo: {
      shouldFire: (s) =>
        s.editor.cropSession
          ? s.editor.cropSession.index > 0
          : s.ui.activeView === 'editor' && s.editor.historyIndex > 0,
      execute: (_, s) => s.editor.undo(),
    },
    redo: {
      shouldFire: (s) =>
        s.editor.cropSession
          ? s.editor.cropSession.index < s.editor.cropSession.history.length - 1
          : s.ui.activeView === 'editor' && s.editor.historyIndex < s.editor.history.length - 1,
      execute: (_, s) => s.editor.redo(),
    },
    mask_delete: {
      shouldFire: (s) => !!(s.editor.activeMaskContainerId || s.editor.activeAiPatchContainerId),
      execute: (_, s) => {
        const a = s.editor.adjustments;
        s.editor.setEditor({
          adjustments: {
            ...a,
            masks: a.masks.filter((m) => m.id !== s.editor.activeMaskContainerId),
            aiPatches: a.aiPatches.filter((m) => m.id !== s.editor.activeAiPatchContainerId),
          },
          activeMaskContainerId: null,
          activeMaskId: null,
          activeAiPatchContainerId: null,
          activeAiSubMaskId: null,
        });
        s.editor.pushHistory(useEditorStore.getState().adjustments);
      },
    },
    go_back: {
      execute: (_, s) => {
        if (s.ui.customEscapeHandler) s.ui.customEscapeHandler();
        else if (s.editor.isWbPickerActive) s.editor.setEditor({ isWbPickerActive: false });
        else if (s.editor.activeMaskId || s.editor.activeAiSubMaskId)
          s.editor.setEditor({ activeMaskId: null, activeAiSubMaskId: null });
        else if (s.editor.activeMaskContainerId || s.editor.activeAiPatchContainerId)
          s.editor.setEditor({ activeMaskContainerId: null, activeAiPatchContainerId: null });
        else if (s.ui.isFullScreen) env.handleToggleFullScreen();
        else if (s.ui.activeView !== 'library') env.handleBackToLibrary();
        else env.handleGoHome();
      },
    },
  };
  for (const [action, delta] of [
    ['library_left', -1],
    ['library_right', 1],
    ['library_up', -1],
    ['library_down', 1],
    ['extend_prev', -1],
    ['extend_next', 1],
    ['library_first', 0],
    ['library_last', 0],
  ] as const) {
    result[action] = {
      shouldFire: (s) => s.ui.activeView === 'library',
      execute: (_, s) => {
        if ((action === 'library_up' || action === 'library_down') && s.library.keyboardRows.length) {
          const target = verticalTarget(s.library.keyboardRows, s.library.libraryActivePath, delta);
          if (target) {
            s.library.setLibrary({
              libraryActivePath: target,
              multiSelectedPaths: [target],
              selectionAnchorPath: target,
            });
            env.handleImageSelect(target, false);
          }
        } else
          navigate(
            s,
            delta,
            action.startsWith('extend'),
            action === 'library_first' ? 'first' : action === 'library_last' ? 'last' : undefined,
          );
      },
    };
  }
  for (let rating = 0; rating <= 5; rating++)
    result[`rate_advance_${rating}` as keyof CommandHandlers] = {
      shouldFire: (s) => !!activePath(s),
      execute: async (_, s) => {
        await env.handleRate(rating, [activePath(s)!]);
        navigate(s, 1);
      },
    };
  for (const [action, delta] of [
    ['rating_up', 1],
    ['rating_down', -1],
  ] as const)
    result[action] = {
      shouldFire: (s) => !!activePath(s),
      execute: (_, s) => {
        const rating = s.library.imageRatings[activePath(s)!] || 0;
        void env.handleRate(Math.max(0, Math.min(5, rating + delta)));
      },
    };
  for (const [action, delta] of [
    ['brush_feather_up', 5],
    ['brush_feather_down', -5],
  ] as const)
    result[action] = {
      shouldFire: (s) => !!s.editor.brushSettings,
      execute: (_, s) => {
        const brush = s.editor.brushSettings!;
        s.editor.setEditor({ brushSettings: { ...brush, feather: Math.max(0, Math.min(100, brush.feather + delta)) } });
      },
    };
  return result;
}
