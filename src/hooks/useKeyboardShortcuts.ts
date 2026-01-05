import { useEffect, useCallback, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description?: string;
  allowWhenInputFocused?: boolean;
}

interface UseKeyboardShortcutsOptions {
  enabled?: boolean;
  ignoreWhenModalOpen?: boolean;
}

export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  options: UseKeyboardShortcutsOptions = {}
) {
  const { enabled = true, ignoreWhenModalOpen = true } = options;
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      if (ignoreWhenModalOpen) {
        const hasOpenModal = document.querySelector('[role="dialog"]');
        if (hasOpenModal) return;
      }

      const isInputFocused =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        document.activeElement?.hasAttribute('contenteditable');

      const key = event.key.toLowerCase();
      const isCtrl = event.ctrlKey || event.metaKey;
      const isShift = event.shiftKey;
      const isAlt = event.altKey;

      for (const shortcut of shortcutsRef.current) {
        if (isInputFocused && !shortcut.allowWhenInputFocused) {
          continue;
        }

        const keyMatches = shortcut.key.toLowerCase() === key;
        const ctrlMatches = (shortcut.ctrl ?? false) === isCtrl;
        const shiftMatches = (shortcut.shift ?? false) === isShift;
        const altMatches = (shortcut.alt ?? false) === isAlt;

        if (keyMatches && ctrlMatches && shiftMatches && altMatches) {
          event.preventDefault();
          event.stopPropagation();
          shortcut.action();
          return;
        }
      }
    },
    [enabled, ignoreWhenModalOpen]
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);
}

export function normalizeKey(key: string): string {
  const keyMap: Record<string, string> = {
    escape: 'Escape',
    esc: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    space: ' ',
    spacebar: ' ',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    delete: 'Delete',
    backspace: 'Backspace',
    tab: 'Tab',
  };

  return keyMap[key.toLowerCase()] || key;
}

export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];
  
  if (shortcut.ctrl) {
    parts.push(navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl');
  }
  if (shortcut.alt) {
    parts.push(navigator.platform.includes('Mac') ? '\u2325' : 'Alt');
  }
  if (shortcut.shift) {
    parts.push('\u21e7');
  }

  const displayKey = shortcut.key.length === 1 
    ? shortcut.key.toUpperCase() 
    : shortcut.key;
  parts.push(displayKey);

  return parts.join(navigator.platform.includes('Mac') ? '' : '+');
}
