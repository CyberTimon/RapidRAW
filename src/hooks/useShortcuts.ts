import { useMemo, useSyncExternalStore } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { shortcutReach, useShortcutScope } from '../store/videoIntegration';
import {
  ariaShortcut,
  formatShortcut,
  keyboardLayout,
  liveCombo,
  subscribeKeyboardLayout,
  type ShortcutAction,
} from '../utils/keyboardUtils';

export interface ShortcutProps {
  'data-shortcut'?: string;
  'aria-keyshortcuts'?: string;
}

const UNBOUND: ShortcutProps = {};

export function useShortcuts() {
  const keybinds = useSettingsStore((state) => state.appSettings?.keybinds);
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const scope = useShortcutScope();
  const layout = useSyncExternalStore(subscribeKeyboardLayout, keyboardLayout);
  return useMemo(() => {
    const reachable = shortcutReach(scope, keybinds, osPlatform);
    return (actions?: ShortcutAction | null): ShortcutProps => {
      const combo = actions ? liveCombo(actions, keybinds, osPlatform, reachable) : null;
      return combo
        ? { 'data-shortcut': formatShortcut(combo, osPlatform), 'aria-keyshortcuts': ariaShortcut(combo, osPlatform) }
        : UNBOUND;
    };
  }, [keybinds, osPlatform, scope, layout]);
}

export const useShortcut = (actions?: ShortcutAction | null) => useShortcuts()(actions);
