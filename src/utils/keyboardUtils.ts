import type { ParseKeys } from 'i18next';

export type KeybindContext = 'photo' | 'video' | 'media';

export interface KeybindDefinition {
  action: string;
  description: string;
  defaultCombo: string[];
  macDefaultCombo?: string[];
  section:
    | 'library'
    | 'view'
    | 'rating'
    | 'panels'
    | 'editing'
    | 'videoPlayback'
    | 'videoEditing'
    | 'videoTimeline'
    | 'videoPanels';
  context?: KeybindContext;
  tooltip?: ParseKeys;
}

export interface KeybindSection {
  id: KeybindDefinition['section'];
  label: string;
  tooltip?: ParseKeys;
}

export const KEYBIND_SECTIONS: KeybindSection[] = [
  { id: 'library', label: 'settings.keybinds.sections.library' },
  { id: 'editing', label: 'settings.keybinds.sections.editing' },
  { id: 'view', label: 'settings.keybinds.sections.view' },
  { id: 'rating', label: 'settings.keybinds.sections.rating' },
  { id: 'panels', label: 'settings.keybinds.sections.panels' },
  { id: 'videoPlayback', label: 'settings.keybinds.sections.videoPlayback', tooltip: 'settings.keybinds.videoHint' },
  { id: 'videoEditing', label: 'settings.keybinds.sections.videoEditing' },
  { id: 'videoTimeline', label: 'settings.keybinds.sections.videoTimeline' },
  { id: 'videoPanels', label: 'settings.keybinds.sections.videoPanels' },
];

const videoKeybind = (
  action: string,
  defaultCombo: string[],
  section: KeybindDefinition['section'],
  context: KeybindContext = 'video',
): KeybindDefinition => ({
  action,
  description: `settings.keybinds.actions.${action}`,
  defaultCombo,
  section,
  context,
});

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
    action: 'copy_image_path',
    description: 'settings.keybinds.actions.copy_image_path',
    defaultCombo: ['ctrl', 'KeyL'],
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
    action: 'delete_rejected',
    description: 'settings.keybinds.actions.delete_rejected',
    defaultCombo: ['ctrl', 'Backspace'],
    macDefaultCombo: ['alt', 'Delete'],
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
    tooltip: 'settings.keybinds.tips.cycle_zoom',
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
    action: 'toggle_viewer_window',
    description: 'settings.keybinds.actions.toggle_viewer_window',
    defaultCombo: ['shift', 'KeyF'],
    section: 'view',
  },
  {
    action: 'show_original',
    description: 'settings.keybinds.actions.show_original',
    tooltip: 'settings.keybinds.tips.show_original',
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
    action: 'toggle_pick',
    description: 'settings.keybinds.actions.toggle_pick',
    defaultCombo: ['shift', 'KeyP'],
    section: 'rating',
  },
  {
    action: 'toggle_reject',
    description: 'settings.keybinds.actions.toggle_reject',
    defaultCombo: ['KeyX'],
    section: 'rating',
  },
  {
    action: 'unflag',
    description: 'settings.keybinds.actions.unflag',
    defaultCombo: ['KeyU'],
    section: 'rating',
  },
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
    action: 'toggle_folder_tree',
    description: 'settings.keybinds.actions.toggle_folder_tree',
    defaultCombo: ['KeyL'],
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
    action: 'toggle_left_panel',
    description: 'settings.keybinds.actions.toggle_left_panel',
    defaultCombo: ['ctrl', 'shift', 'KeyB'],
    section: 'panels',
  },
  {
    action: 'toggle_right_panel',
    description: 'settings.keybinds.actions.toggle_right_panel',
    defaultCombo: ['ctrl', 'KeyB'],
    section: 'panels',
  },
  {
    action: 'toggle_bottom_panel',
    description: 'settings.keybinds.actions.toggle_bottom_panel',
    defaultCombo: ['ctrl', 'KeyJ'],
    section: 'panels',
  },
  {
    action: 'toggle_library_exif',
    description: 'settings.keybinds.actions.toggle_library_exif',
    defaultCombo: ['KeyT'],
    section: 'library',
  },
  {
    action: 'open_settings',
    description: 'settings.keybinds.actions.open_settings',
    defaultCombo: ['ctrl', 'Comma'],
    section: 'library',
  },
  {
    action: 'focus_search',
    description: 'settings.keybinds.actions.focus_search',
    defaultCombo: ['ctrl', 'KeyF'],
    section: 'library',
  },
  {
    action: 'new_video_project',
    description: 'contextMenus.library.newVideoProject',
    defaultCombo: ['ctrl', 'shift', 'KeyN'],
    section: 'library',
  },
  {
    action: 'open_recent_project',
    description: 'video.project.openRecent',
    defaultCombo: ['ctrl', 'shift', 'KeyO'],
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
    action: 'auto_straighten',
    description: 'settings.keybinds.actions.auto_straighten',
    defaultCombo: ['shift', 'KeyS'],
    section: 'editing',
  },
  {
    action: 'toggle_black_white',
    description: 'settings.keybinds.actions.toggle_black_white',
    defaultCombo: ['KeyV'],
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
  videoKeybind('video_play_pause', ['Space'], 'videoPlayback'),
  videoKeybind('video_play', ['KeyL'], 'videoPlayback'),
  videoKeybind('video_pause', ['KeyK'], 'videoPlayback'),
  videoKeybind('video_play_in_out', ['ctrl', 'shift', 'Space'], 'videoPlayback'),
  videoKeybind('video_loop', ['ctrl', 'KeyL'], 'videoPlayback'),
  videoKeybind('video_jump_back', ['KeyJ'], 'videoPlayback'),
  videoKeybind('video_prev_frame', ['ArrowLeft'], 'videoPlayback'),
  videoKeybind('video_next_frame', ['ArrowRight'], 'videoPlayback'),
  videoKeybind('video_prev_frame_alt', ['Comma'], 'videoPlayback'),
  videoKeybind('video_next_frame_alt', ['Period'], 'videoPlayback'),
  videoKeybind('video_back_second', ['shift', 'ArrowLeft'], 'videoPlayback'),
  videoKeybind('video_forward_second', ['shift', 'ArrowRight'], 'videoPlayback'),
  videoKeybind('video_back_second_alt', ['shift', 'Comma'], 'videoPlayback'),
  videoKeybind('video_forward_second_alt', ['shift', 'Period'], 'videoPlayback'),
  videoKeybind('video_go_start', ['Home'], 'videoPlayback'),
  videoKeybind('video_go_end', ['End'], 'videoPlayback'),
  videoKeybind('video_prev_edit', ['ArrowUp'], 'videoPlayback'),
  videoKeybind('video_next_edit', ['ArrowDown'], 'videoPlayback'),
  videoKeybind('video_prev_marker', ['ctrl', 'shift', 'KeyM'], 'videoPlayback'),
  videoKeybind('video_next_marker', ['shift', 'KeyM'], 'videoPlayback'),
  videoKeybind('video_prev_keyframe', ['alt', 'BracketLeft'], 'videoPlayback'),
  videoKeybind('video_next_keyframe', ['alt', 'BracketRight'], 'videoPlayback'),
  videoKeybind('video_save_project', ['ctrl', 'KeyS'], 'videoEditing'),
  videoKeybind('video_undo', ['ctrl', 'KeyZ'], 'videoEditing'),
  videoKeybind('video_redo', ['ctrl', 'KeyY'], 'videoEditing'),
  videoKeybind('video_redo_alt', ['ctrl', 'shift', 'KeyZ'], 'videoEditing'),
  videoKeybind('video_split', ['ctrl', 'KeyK'], 'videoEditing'),
  videoKeybind('video_split_all', ['ctrl', 'shift', 'KeyK'], 'videoEditing'),
  videoKeybind('video_delete', ['Delete'], 'videoEditing'),
  videoKeybind('video_delete_alt', ['Backspace'], 'videoEditing'),
  videoKeybind('video_ripple_delete', ['shift', 'Delete'], 'videoEditing'),
  videoKeybind('video_ripple_delete_alt', ['shift', 'Backspace'], 'videoEditing'),
  videoKeybind('video_copy', ['ctrl', 'KeyC'], 'videoEditing'),
  videoKeybind('video_paste', ['ctrl', 'KeyV'], 'videoEditing'),
  videoKeybind('video_copy_adjustments', ['ctrl', 'alt', 'KeyC'], 'videoEditing'),
  videoKeybind('video_paste_adjustments', ['ctrl', 'alt', 'KeyV'], 'videoEditing'),
  videoKeybind('video_duplicate', ['ctrl', 'KeyD'], 'videoEditing'),
  videoKeybind('video_freeze_frame', ['shift', 'KeyR'], 'videoEditing'),
  videoKeybind('video_insert', ['Comma'], 'videoEditing', 'media'),
  videoKeybind('video_overwrite', ['Period'], 'videoEditing', 'media'),
  videoKeybind('video_select_all', ['ctrl', 'KeyA'], 'videoEditing'),
  videoKeybind('video_select_at_playhead', ['KeyC'], 'videoEditing'),
  videoKeybind('video_add_title', ['KeyT'], 'videoEditing'),
  videoKeybind('video_toggle_keyframe', ['shift', 'KeyK'], 'videoEditing'),
  videoKeybind('video_record_keyframes', ['shift', 'alt', 'KeyK'], 'videoEditing'),
  videoKeybind('video_trim_start', ['KeyQ'], 'videoEditing'),
  videoKeybind('video_trim_end', ['KeyW'], 'videoEditing'),
  videoKeybind('video_nudge_left', ['alt', 'ArrowLeft'], 'videoEditing'),
  videoKeybind('video_nudge_right', ['alt', 'ArrowRight'], 'videoEditing'),
  videoKeybind('video_nudge_left_more', ['shift', 'alt', 'ArrowLeft'], 'videoEditing'),
  videoKeybind('video_nudge_right_more', ['shift', 'alt', 'ArrowRight'], 'videoEditing'),
  videoKeybind('video_nest', ['alt', 'KeyG'], 'videoEditing'),
  videoKeybind('video_unnest', ['shift', 'alt', 'KeyG'], 'videoEditing'),
  videoKeybind('video_export_frame', ['ctrl', 'shift', 'KeyE'], 'videoEditing'),
  videoKeybind('video_set_in', ['KeyI'], 'videoTimeline'),
  videoKeybind('video_set_out', ['KeyO'], 'videoTimeline'),
  videoKeybind('video_clear_range', ['ctrl', 'shift', 'KeyX'], 'videoTimeline'),
  videoKeybind('video_add_marker', ['KeyM'], 'videoTimeline'),
  videoKeybind('video_toggle_snapping', ['KeyS'], 'videoTimeline'),
  videoKeybind('video_zoom_in', ['Equal'], 'videoTimeline'),
  videoKeybind('video_zoom_out', ['Minus'], 'videoTimeline'),
  videoKeybind('video_zoom_fit', ['Backslash'], 'videoTimeline'),
  videoKeybind('video_panel_project', ['shift', 'Digit1'], 'videoPanels'),
  videoKeybind('video_panel_captions', ['shift', 'Digit2'], 'videoPanels'),
  videoKeybind('video_panel_inspector', ['shift', 'Digit3'], 'videoPanels'),
  videoKeybind('video_panel_effects', ['shift', 'Digit4'], 'videoPanels'),
  videoKeybind('video_panel_mixer', ['shift', 'Digit5'], 'videoPanels'),
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

export function getDefaultCombo(def: KeybindDefinition, osPlatform?: string): string[] {
  return (osPlatform === 'macos' && def.macDefaultCombo) || def.defaultCombo;
}

export function getEffectiveCombo(
  def: KeybindDefinition,
  keybinds: Record<string, string[]> | undefined,
  osPlatform?: string,
): string[] {
  return keybinds?.[def.action] ?? getDefaultCombo(def, osPlatform);
}

export const keybindContext = (def: KeybindDefinition): KeybindContext => def.context ?? 'photo';

export function comboMapFor(
  context: KeybindContext,
  keybinds: Record<string, string[]> | undefined,
  osPlatform?: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const def of KEYBIND_DEFINITIONS) {
    const combo = keybindContext(def) === context ? getEffectiveCombo(def, keybinds, osPlatform) : [];
    if (combo.length > 0) map.set(combo.join('+'), def.action);
  }
  return map;
}

// Canonical identifiers keep stored shortcuts compatible while the symbol
// comes from the active keyboard layout rather than a physical QWERTY key.
const punctuationCodes: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '\\': 'Backslash',
};

const punctuationSymbols: Record<string, string> = Object.fromEntries(
  Object.entries(punctuationCodes).map(([symbol, code]) => [code, symbol]),
);

const DEAD_KEY = /^[\^~¨´¸ˇ˘-˝]$/;

let layoutKeys: ReadonlyMap<string, string> | null = null;
const layoutListeners = new Set<() => void>();

export const keyboardLayout = () => layoutKeys;

export const subscribeKeyboardLayout = (listener: () => void) => {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
};

type LayoutNavigator = Navigator & { keyboard?: { getLayoutMap?(): Promise<ReadonlyMap<string, string>> } };

export const refreshKeyboardLayout = async () => {
  const map = await (navigator as LayoutNavigator).keyboard?.getLayoutMap?.().catch(() => null);
  if (!map) return;
  const next = new Map(map);
  if (layoutKeys?.size === next.size && [...next].every(([code, key]) => layoutKeys?.get(code) === key)) return;
  layoutKeys = next;
  layoutListeners.forEach((listener) => listener());
};

const modifierParts = (event: KeyboardEvent, isMacDelete: boolean) => {
  const parts: string[] = [];
  if ((event.ctrlKey || event.metaKey) && !isMacDelete) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  return parts;
};

const keyCode = (event: KeyboardEvent, osPlatform: string | undefined, isMacDelete: boolean) => {
  const code = isMacDelete ? 'Delete' : event.code;
  const symbol = event.shiftKey ? layoutKeys?.get(event.code) : event.key;
  if (event.key && /^[a-zA-Z]$/.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^Numpad[0-9]$/.test(code)) return `Digit${code.slice(-1)}`;
  if (code === 'NumpadAdd') return 'Equal';
  if (code === 'NumpadSubtract') return 'Minus';
  if (
    !code.startsWith('Numpad') &&
    !(/^Digit[0-9]$/.test(code) && !event.ctrlKey && !event.metaKey && !event.altKey) &&
    !(osPlatform === 'macos' && event.altKey) &&
    symbol &&
    punctuationCodes[symbol]
  ) {
    return punctuationCodes[symbol];
  }
  return code;
};

const plusCombo = (combo: string[]) => [...combo.slice(0, -1).filter((part) => part !== 'shift'), 'Equal'];

export function comboCandidates(event: KeyboardEvent, osPlatform?: string): string[][] {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process') return [];
  const isMacDelete = osPlatform === 'macos' && event.code === 'Backspace' && (event.ctrlKey || event.metaKey);
  const modifiers = modifierParts(event, isMacDelete);
  const code = keyCode(event, osPlatform, isMacDelete);
  const combo = isValidShortcutKey(code) ? [...modifiers, code] : modifiers;
  if (event.key !== '+') return [combo];
  const plus = plusCombo([...modifiers, 'Equal']);
  return plus.join('+') === combo.join('+') ? [combo] : [plus, combo];
}

export const normalizeCombo = (event: KeyboardEvent, osPlatform?: string): string[] =>
  comboCandidates(event, osPlatform)[0] ?? [];

const typedOnLayout = (symbol: string) =>
  [...(layoutKeys ?? [])].some(([code, key]) => key === symbol && !/^Digit[0-9]$/.test(code));

function keyLabel(code: string): string | null {
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)) {
    return code[code.length - 1].toUpperCase();
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Numpad ${code.slice(-1)}`;
  }
  const symbol = punctuationSymbols[code];
  if (!symbol || code === 'Equal' || !layoutKeys || typedOnLayout(symbol)) return symMap[code] ?? code;
  const own = layoutKeys.get(code);
  return own && !DEAD_KEY.test(own) && !/^[a-z0-9]$/i.test(own) && !punctuationCodes[own] ? own : null;
}

const pressedCombo = (combo: string[]) => (keyLabel(combo[combo.length - 1]) === '+' ? plusCombo(combo) : combo);

function isValidShortcutKey(code: string): boolean {
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
  return keyLabel(key) ?? symMap[key] ?? key;
}

export function formatCombo(combo: string[], osPlatform: string): string {
  return combo.map((key) => formatKeyCode(key, osPlatform)).join(' + ');
}

export type ShortcutAction = string | Array<string>;

const definitionsByAction = new Map(KEYBIND_DEFINITIONS.map((def) => [def.action, def]));

export function liveCombo(
  actions: ShortcutAction,
  keybinds: Record<string, string[]> | undefined,
  osPlatform: string,
  reachable: (action: string, combo: string) => boolean,
): string[] | null {
  for (const action of typeof actions === 'string' ? [actions] : actions) {
    const def = definitionsByAction.get(action);
    if (!def) continue;
    const combo = getEffectiveCombo(def, keybinds, osPlatform);
    if (combo.length === 0 || keyLabel(combo[combo.length - 1]) === null) continue;
    const key = combo.join('+');
    const pressed = pressedCombo(combo).join('+');
    const map = comboMapFor(keybindContext(def), keybinds, osPlatform);
    if (
      reachable(action, key) &&
      map.get(key) === action &&
      (pressed === key || (reachable(action, pressed) && !map.has(pressed)))
    ) {
      return combo;
    }
  }
  return null;
}

const MAC_MODIFIERS: Array<[string, string]> = [
  ['alt', '⌥'],
  ['shift', '⇧'],
  ['ctrl', '⌘'],
];

const MAC_KEYS: Record<string, string> = { Enter: '↩', Escape: '⎋', Tab: '⇥', Delete: '⌦' };

export function formatShortcut(combo: string[], osPlatform: string): string {
  if (osPlatform !== 'macos') return combo.map((key) => formatKeyCode(key, osPlatform)).join('+');
  const key = combo[combo.length - 1];
  const commandDelete = key === 'Delete' && !combo.includes('ctrl');
  const modifiers = MAC_MODIFIERS.filter(([name]) => combo.includes(name) || (commandDelete && name === 'ctrl'))
    .map(([, symbol]) => symbol)
    .join('');
  return modifiers + (commandDelete ? '⌫' : (MAC_KEYS[key] ?? formatKeyCode(key, osPlatform)));
}

const ariaModifiers: Record<string, string> = { ctrl: 'Control', shift: 'Shift', alt: 'Alt' };

export function ariaShortcut(combo: string[], osPlatform: string): string {
  return combo
    .map((key) => {
      if (key === 'ctrl' && osPlatform === 'macos') return 'Meta';
      if (ariaModifiers[key]) return ariaModifiers[key];
      if (/^(Key[A-Z]|Digit[0-9])$/.test(key)) return key.slice(-1);
      return punctuationSymbols[key] ?? key;
    })
    .join('+');
}
