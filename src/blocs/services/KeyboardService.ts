import { Cubit } from '@blac/core';

export type ModifierKey = 'ctrl' | 'meta' | 'shift' | 'alt';

export interface ShortcutDefinition {
  key: string;
  modifiers?: ModifierKey[];
  description: string;
  category: ShortcutCategory;
  action: () => void;
  enabled?: () => boolean;
}

export type ShortcutCategory =
  | 'navigation'
  | 'editor'
  | 'selection'
  | 'rating'
  | 'zoom'
  | 'panels'
  | 'file'
  | 'general';

interface KeyboardServiceState {
  isEnabled: boolean;
  shortcuts: Map<string, ShortcutDefinition>;
  activeModifiers: Set<ModifierKey>;
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  const keyMap: Record<string, string> = {
    arrowup: 'arrowup',
    arrowdown: 'arrowdown',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright',
    ' ': 'space',
    escape: 'escape',
    enter: 'enter',
    backspace: 'backspace',
    delete: 'delete',
    tab: 'tab',
  };
  return keyMap[lower] ?? lower;
}

function createShortcutId(key: string, modifiers: ModifierKey[] = []): string {
  const sortedMods = [...modifiers].sort();
  const normalizedKey = normalizeKey(key);
  return sortedMods.length > 0 ? `${sortedMods.join('+')}+${normalizedKey}` : normalizedKey;
}

export class KeyboardService extends Cubit<KeyboardServiceState> {
  private boundHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    super({
      isEnabled: true,
      shortcuts: new Map(),
      activeModifiers: new Set(),
    });
  }

  initialize = () => {
    if (this.boundHandler) return;

    this.boundHandler = this.handleKeyDown.bind(this);
    window.addEventListener('keydown', this.boundHandler);
    window.addEventListener('keyup', this.handleKeyUp.bind(this));
  };

  cleanup = () => {
    if (this.boundHandler) {
      window.removeEventListener('keydown', this.boundHandler);
      this.boundHandler = null;
    }
  };

  enable = () => {
    this.patch({ isEnabled: true });
  };

  disable = () => {
    this.patch({ isEnabled: false });
  };

  registerShortcut = (shortcut: ShortcutDefinition): (() => void) => {
    const id = createShortcutId(shortcut.key, shortcut.modifiers);
    const newShortcuts = new Map(this.state.shortcuts);
    newShortcuts.set(id, shortcut);
    this.patch({ shortcuts: newShortcuts });

    return () => this.unregisterShortcut(shortcut.key, shortcut.modifiers);
  };

  registerShortcuts = (shortcuts: ShortcutDefinition[]): (() => void) => {
    const newShortcuts = new Map(this.state.shortcuts);
    shortcuts.forEach((shortcut) => {
      const id = createShortcutId(shortcut.key, shortcut.modifiers);
      newShortcuts.set(id, shortcut);
    });
    this.patch({ shortcuts: newShortcuts });

    return () => {
      shortcuts.forEach((s) => this.unregisterShortcut(s.key, s.modifiers));
    };
  };

  unregisterShortcut = (key: string, modifiers?: ModifierKey[]) => {
    const id = createShortcutId(key, modifiers);
    const newShortcuts = new Map(this.state.shortcuts);
    newShortcuts.delete(id);
    this.patch({ shortcuts: newShortcuts });
  };

  getShortcutsByCategory = (category: ShortcutCategory): ShortcutDefinition[] => {
    return Array.from(this.state.shortcuts.values()).filter((s) => s.category === category);
  };

  getAllShortcuts = (): ShortcutDefinition[] => {
    return Array.from(this.state.shortcuts.values());
  };

  formatShortcut = (key: string, modifiers?: ModifierKey[]): string => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const modSymbols: Record<ModifierKey, string> = isMac
      ? { ctrl: '⌃', meta: '⌘', shift: '⇧', alt: '⌥' }
      : { ctrl: 'Ctrl', meta: 'Win', shift: 'Shift', alt: 'Alt' };

    const parts: string[] = [];
    if (modifiers) {
      if (modifiers.includes('ctrl')) parts.push(modSymbols.ctrl);
      if (modifiers.includes('meta')) parts.push(modSymbols.meta);
      if (modifiers.includes('shift')) parts.push(modSymbols.shift);
      if (modifiers.includes('alt')) parts.push(modSymbols.alt);
    }

    const keyDisplay = this.formatKeyDisplay(key);
    parts.push(keyDisplay);

    return isMac ? parts.join('') : parts.join('+');
  };

  private formatKeyDisplay = (key: string): string => {
    const displayMap: Record<string, string> = {
      arrowup: '↑',
      arrowdown: '↓',
      arrowleft: '←',
      arrowright: '→',
      space: 'Space',
      escape: 'Esc',
      enter: '↵',
      backspace: '⌫',
      delete: 'Del',
      tab: 'Tab',
    };
    const normalized = normalizeKey(key);
    return displayMap[normalized] ?? key.toUpperCase();
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.state.isEnabled) return;

    if (this.shouldIgnoreEvent(e)) return;

    const modifiers: ModifierKey[] = [];
    if (e.ctrlKey) modifiers.push('ctrl');
    if (e.metaKey) modifiers.push('meta');
    if (e.shiftKey) modifiers.push('shift');
    if (e.altKey) modifiers.push('alt');

    const id = createShortcutId(e.key, modifiers);
    const shortcut = this.state.shortcuts.get(id);

    if (shortcut) {
      if (shortcut.enabled && !shortcut.enabled()) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      shortcut.action();
    }
  };

  private handleKeyUp = (_e: KeyboardEvent) => {
    // Could track modifier releases if needed
  };

  private shouldIgnoreEvent = (e: KeyboardEvent): boolean => {
    const target = e.target as HTMLElement;
    const tagName = target.tagName.toLowerCase();

    if (tagName === 'input' || tagName === 'textarea') {
      return true;
    }

    if (target.isContentEditable) {
      return true;
    }

    return false;
  };

  get isMac(): boolean {
    return navigator.platform.toLowerCase().includes('mac');
  }

  get ctrlOrCmd(): ModifierKey {
    return this.isMac ? 'meta' : 'ctrl';
  }
}
