import { ToolType } from '../components/panel/right/Masks';
import { Panel } from '../components/ui/AppProperties';
import type { ShortcutEnvironment, CommandHandlers } from './types';
export function legacyCommands4(env: ShortcutEnvironment): CommandHandlers {
  const { handleRate, handleSetColorLabel } = env;
  return {
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
    brush_size_up: {
      shouldFire: (s) =>
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
      shouldFire: (s) =>
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
}
