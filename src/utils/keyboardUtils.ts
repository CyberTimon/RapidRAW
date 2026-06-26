export interface KeybindDefinition {
  action: string;
  description: string;
  defaultCombo: string[];
  section: 'library' | 'view' | 'rating' | 'panels' | 'editing' | 'adjustments';
}

export interface KeybindSection {
  id: KeybindDefinition['section'];
  label: string;
}

export const KEYBIND_SECTIONS: KeybindSection[] = [
  { id: 'library', label: 'settings.keybinds.sections.library' },
  { id: 'editing', label: 'settings.keybinds.sections.editing' },
  { id: 'adjustments', label: 'settings.keybinds.sections.adjustments' },
  { id: 'view', label: 'settings.keybinds.sections.view' },
  { id: 'rating', label: 'settings.keybinds.sections.rating' },
  { id: 'panels', label: 'settings.keybinds.sections.panels' },
];

// Capture One–inspired increase/decrease shortcuts for the core tonal and
// color sliders. The `+` (Equal) and `-` (Minus) keys set the direction, just
// like Capture One; the modifier family selects the adjustment. Each entry also
// carries the data needed to apply it (target adjustment key, step, and clamp
// range) so the dispatcher in useKeyboardShortcuts stays config-driven and the
// keybind list cannot drift out of sync with the behaviour.
export interface AdjustmentNudge {
  action: string;
  description: string;
  defaultCombo: string[];
  adjustmentKey: string;
  delta: number;
  min: number;
  max: number;
}

export const ADJUSTMENT_NUDGES: AdjustmentNudge[] = [
  // Exposure — Capture One uses Ctrl/Cmd + +/-, but that combo is bound to Zoom
  // here, so exposure moves to Alt + +/-. Step matches Capture One (0.1 EV).
  { action: 'exposure_up', description: 'settings.keybinds.actions.exposure_up', defaultCombo: ['alt', 'Equal'], adjustmentKey: 'exposure', delta: 0.1, min: -5, max: 5 },
  { action: 'exposure_down', description: 'settings.keybinds.actions.exposure_down', defaultCombo: ['alt', 'Minus'], adjustmentKey: 'exposure', delta: -0.1, min: -5, max: 5 },
  // Contrast — matches Capture One's Ctrl(+Shift+Cmd) modifier family.
  { action: 'contrast_up', description: 'settings.keybinds.actions.contrast_up', defaultCombo: ['ctrl', 'shift', 'Equal'], adjustmentKey: 'contrast', delta: 5, min: -100, max: 100 },
  { action: 'contrast_down', description: 'settings.keybinds.actions.contrast_down', defaultCombo: ['ctrl', 'shift', 'Minus'], adjustmentKey: 'contrast', delta: -5, min: -100, max: 100 },
  // Saturation — matches Capture One's Ctrl(+Alt+Cmd) modifier family.
  { action: 'saturation_up', description: 'settings.keybinds.actions.saturation_up', defaultCombo: ['ctrl', 'alt', 'Equal'], adjustmentKey: 'saturation', delta: 5, min: -100, max: 100 },
  { action: 'saturation_down', description: 'settings.keybinds.actions.saturation_down', defaultCombo: ['ctrl', 'alt', 'Minus'], adjustmentKey: 'saturation', delta: -5, min: -100, max: 100 },
  { action: 'vibrance_up', description: 'settings.keybinds.actions.vibrance_up', defaultCombo: ['shift', 'alt', 'Equal'], adjustmentKey: 'vibrance', delta: 5, min: -100, max: 100 },
  { action: 'vibrance_down', description: 'settings.keybinds.actions.vibrance_down', defaultCombo: ['shift', 'alt', 'Minus'], adjustmentKey: 'vibrance', delta: -5, min: -100, max: 100 },
  // Temperature / Tint together cover white balance. Temperature gets the
  // simpler Shift + +/- combo; tint takes the fuller modifier family.
  { action: 'temperature_up', description: 'settings.keybinds.actions.temperature_up', defaultCombo: ['shift', 'Equal'], adjustmentKey: 'temperature', delta: 5, min: -100, max: 100 },
  { action: 'temperature_down', description: 'settings.keybinds.actions.temperature_down', defaultCombo: ['shift', 'Minus'], adjustmentKey: 'temperature', delta: -5, min: -100, max: 100 },
  { action: 'tint_up', description: 'settings.keybinds.actions.tint_up', defaultCombo: ['ctrl', 'shift', 'alt', 'Equal'], adjustmentKey: 'tint', delta: 5, min: -100, max: 100 },
  { action: 'tint_down', description: 'settings.keybinds.actions.tint_down', defaultCombo: ['ctrl', 'shift', 'alt', 'Minus'], adjustmentKey: 'tint', delta: -5, min: -100, max: 100 },
];

export const KEYBIND_DEFINITIONS: KeybindDefinition[] = [
  {
    action: 'open_image',
    description: 'settings.keybinds.actions.open_image',
    defaultCombo: ['Enter'],
    section: 'library',
  },
  {
    action: 'copy_files',
    description: 'settings.keybinds.actions.copy_files',
    defaultCombo: ['ctrl', 'shift', 'KeyC'],
    section: 'library',
  },
  {
    action: 'paste_files',
    description: 'settings.keybinds.actions.paste_files',
    defaultCombo: ['ctrl', 'shift', 'KeyV'],
    section: 'library',
  },
  {
    action: 'select_all',
    description: 'settings.keybinds.actions.select_all',
    defaultCombo: ['ctrl', 'KeyA'],
    section: 'library',
  },
  {
    action: 'delete_selected',
    description: 'settings.keybinds.actions.delete_selected',
    defaultCombo: ['Delete'],
    section: 'library',
  },
  {
    action: 'preview_prev',
    description: 'settings.keybinds.actions.preview_prev',
    defaultCombo: ['ArrowLeft'],
    section: 'library',
  },
  {
    action: 'preview_next',
    description: 'settings.keybinds.actions.preview_next',
    defaultCombo: ['ArrowRight'],
    section: 'library',
  },
  {
    action: 'zoom_in_step',
    description: 'settings.keybinds.actions.zoom_in_step',
    defaultCombo: ['ArrowUp'],
    section: 'view',
  },
  {
    action: 'zoom_out_step',
    description: 'settings.keybinds.actions.zoom_out_step',
    defaultCombo: ['ArrowDown'],
    section: 'view',
  },
  {
    action: 'cycle_zoom',
    description: 'settings.keybinds.actions.cycle_zoom',
    defaultCombo: ['Space'],
    section: 'view',
  },
  {
    action: 'zoom_in',
    description: 'settings.keybinds.actions.zoom_in',
    defaultCombo: ['ctrl', 'Equal'],
    section: 'view',
  },
  {
    action: 'zoom_out',
    description: 'settings.keybinds.actions.zoom_out',
    defaultCombo: ['ctrl', 'Minus'],
    section: 'view',
  },
  {
    action: 'zoom_fit',
    description: 'settings.keybinds.actions.zoom_fit',
    defaultCombo: ['ctrl', 'Digit0'],
    section: 'view',
  },
  {
    action: 'zoom_100',
    description: 'settings.keybinds.actions.zoom_100',
    defaultCombo: ['ctrl', 'Digit1'],
    section: 'view',
  },
  {
    action: 'toggle_fullscreen',
    description: 'settings.keybinds.actions.toggle_fullscreen',
    defaultCombo: ['KeyF'],
    section: 'view',
  },
  {
    action: 'show_original',
    description: 'settings.keybinds.actions.show_original',
    defaultCombo: ['KeyB'],
    section: 'view',
  },
  { action: 'rate_0', description: 'settings.keybinds.actions.rate_0', defaultCombo: ['Digit0'], section: 'rating' },
  { action: 'rate_1', description: 'settings.keybinds.actions.rate_1', defaultCombo: ['Digit1'], section: 'rating' },
  { action: 'rate_2', description: 'settings.keybinds.actions.rate_2', defaultCombo: ['Digit2'], section: 'rating' },
  { action: 'rate_3', description: 'settings.keybinds.actions.rate_3', defaultCombo: ['Digit3'], section: 'rating' },
  { action: 'rate_4', description: 'settings.keybinds.actions.rate_4', defaultCombo: ['Digit4'], section: 'rating' },
  { action: 'rate_5', description: 'settings.keybinds.actions.rate_5', defaultCombo: ['Digit5'], section: 'rating' },
  {
    action: 'color_label_none',
    description: 'settings.keybinds.actions.color_label_none',
    defaultCombo: ['shift', 'Digit0'],
    section: 'rating',
  },
  {
    action: 'color_label_red',
    description: 'settings.keybinds.actions.color_label_red',
    defaultCombo: ['shift', 'Digit1'],
    section: 'rating',
  },
  {
    action: 'color_label_yellow',
    description: 'settings.keybinds.actions.color_label_yellow',
    defaultCombo: ['shift', 'Digit2'],
    section: 'rating',
  },
  {
    action: 'color_label_green',
    description: 'settings.keybinds.actions.color_label_green',
    defaultCombo: ['shift', 'Digit3'],
    section: 'rating',
  },
  {
    action: 'color_label_blue',
    description: 'settings.keybinds.actions.color_label_blue',
    defaultCombo: ['shift', 'Digit4'],
    section: 'rating',
  },
  {
    action: 'color_label_purple',
    description: 'settings.keybinds.actions.color_label_purple',
    defaultCombo: ['shift', 'Digit5'],
    section: 'rating',
  },
  {
    action: 'toggle_adjustments',
    description: 'settings.keybinds.actions.toggle_adjustments',
    defaultCombo: ['KeyD'],
    section: 'panels',
  },
  {
    action: 'toggle_crop_panel',
    description: 'settings.keybinds.actions.toggle_crop_panel',
    defaultCombo: ['KeyR'],
    section: 'panels',
  },
  {
    action: 'toggle_masks',
    description: 'settings.keybinds.actions.toggle_masks',
    defaultCombo: ['KeyM'],
    section: 'panels',
  },
  {
    action: 'toggle_ai',
    description: 'settings.keybinds.actions.toggle_ai',
    defaultCombo: ['KeyK'],
    section: 'panels',
  },
  {
    action: 'toggle_presets',
    description: 'settings.keybinds.actions.toggle_presets',
    defaultCombo: ['KeyP'],
    section: 'panels',
  },
  {
    action: 'toggle_metadata',
    description: 'settings.keybinds.actions.toggle_metadata',
    defaultCombo: ['KeyI'],
    section: 'panels',
  },
  {
    action: 'toggle_analytics',
    description: 'settings.keybinds.actions.toggle_analytics',
    defaultCombo: ['KeyA'],
    section: 'panels',
  },
  {
    action: 'toggle_export',
    description: 'settings.keybinds.actions.toggle_export',
    defaultCombo: ['KeyE'],
    section: 'panels',
  },
  {
    action: 'toggle_library_exif',
    description: 'settings.keybinds.actions.toggle_library_exif',
    defaultCombo: ['KeyT'],
    section: 'library',
  },
  { action: 'undo', description: 'settings.keybinds.actions.undo', defaultCombo: ['ctrl', 'KeyZ'], section: 'editing' },
  { action: 'redo', description: 'settings.keybinds.actions.redo', defaultCombo: ['ctrl', 'KeyY'], section: 'editing' },
  {
    action: 'copy_adjustments',
    description: 'settings.keybinds.actions.copy_adjustments',
    defaultCombo: ['ctrl', 'KeyC'],
    section: 'editing',
  },
  {
    action: 'paste_adjustments',
    description: 'settings.keybinds.actions.paste_adjustments',
    defaultCombo: ['ctrl', 'KeyV'],
    section: 'editing',
  },
  {
    action: 'rotate_left',
    description: 'settings.keybinds.actions.rotate_left',
    defaultCombo: ['BracketLeft'],
    section: 'editing',
  },
  {
    action: 'rotate_right',
    description: 'settings.keybinds.actions.rotate_right',
    defaultCombo: ['BracketRight'],
    section: 'editing',
  },
  {
    action: 'toggle_crop',
    description: 'settings.keybinds.actions.toggle_crop',
    defaultCombo: ['KeyS'],
    section: 'editing',
  },
  {
    action: 'brush_size_up',
    description: 'settings.keybinds.actions.brush_size_up',
    defaultCombo: ['ctrl', 'ArrowUp'],
    section: 'editing',
  },
  {
    action: 'brush_size_down',
    description: 'settings.keybinds.actions.brush_size_down',
    defaultCombo: ['ctrl', 'ArrowDown'],
    section: 'editing',
  },
  ...ADJUSTMENT_NUDGES.map(
    (n): KeybindDefinition => ({
      action: n.action,
      description: n.description,
      defaultCombo: n.defaultCombo,
      section: 'adjustments',
    }),
  ),
];

const symMap: Record<string, string> = {
  Space: 'Space',
  Backspace: '⌫',
  Enter: 'Enter',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '+',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  Tab: 'Tab',
  Escape: 'Esc',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  NumpadAdd: 'Numpad +',
  NumpadMultiply: 'Numpad *',
  NumpadDivide: 'Numpad /',
  NumpadSubtract: 'Numpad -',
  NumpadDecimal: 'Numpad .',
  NumpadComma: 'Numpad ,',
  NumpadEnter: 'Numpad Enter',
  NumpadEqual: 'Numpad =',
  CapsLock: 'Caps Lock',
  PrintScreen: 'PrtSc',
};

export function normalizeCombo(event: KeyboardEvent, osPlatform?: string): string[] {
  const isMacDelete = osPlatform === 'macos' && event.code === 'Backspace' && (event.ctrlKey || event.metaKey);
  const parts: string[] = [];
  if ((event.ctrlKey || event.metaKey) && !isMacDelete) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  let code = isMacDelete ? 'Delete' : event.code;
  if (/^Numpad[0-9]$/.test(code)) {
    code = `Digit${code.slice(-1)}`;
  } else if (code === 'NumpadAdd') {
    code = 'Equal';
  } else if (code === 'NumpadSubtract') {
    code = 'Minus';
  }
  if (isValidShortcutKey(code)) {
    parts.push(code);
  }
  return parts;
}

export function codeToDisplayLabel(code: string): string | null {
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)) {
    return code[code.length - 1].toUpperCase();
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Numpad ${code.slice(-1)}`;
  }
  return symMap[code] ?? null;
}

export function isValidShortcutKey(code: string): boolean {
  if (code.startsWith('Key') || code.startsWith('Digit')) return true;
  if (code.startsWith('F') && /^\d+$/.test(code.slice(1))) return true;
  if (/^Numpad[0-9]$/.test(code)) return true;
  return code in symMap;
}

export function formatKeyCode(key: string, osPlatform: string): string {
  if (key === 'ctrl') return osPlatform === 'macos' ? '⌘' : 'Ctrl';
  if (key === 'shift') return 'Shift';
  if (key === 'alt') return osPlatform === 'macos' ? '⌥' : 'Alt';
  if (key === 'Delete' && osPlatform === 'macos') return 'Delete / ⌘+⌫';
  const label = codeToDisplayLabel(key);
  return label || key;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
