import { commandContext, supportsLibrary } from './contexts';
export { commandContext } from './contexts';
import { KEYBIND_DEFINITIONS, type CommandId, type KeybindDefinition } from './definitions';

export type ShortcutProfile = 'rapidraw' | 'lightroom';
export interface ShortcutSettings {
  shortcutProfile?: ShortcutProfile;
  keybinds?: Record<string, string[]>;
  lightroomKeybinds?: Record<string, string[]>;
}

const lightroom: Partial<Record<CommandId, string[]>> = {
  develop: ['KeyD'],
  toggle_adjustments: [],
  toggle_crop_panel: ['KeyR'],
  crop_lock: ['KeyA'],
  crop_orientation: ['KeyX'],
  crop_reset: ['ctrl', 'alt', 'KeyR'],
  show_original: ['Backslash'],
  cycle_zoom: ['KeyZ'],
  redo: ['ctrl', 'shift', 'KeyZ'],
  copy_adjustments: ['ctrl', 'shift', 'KeyC'],
  paste_adjustments: ['ctrl', 'shift', 'KeyV'],
  copy_files: ['ctrl', 'KeyC'],
  paste_files: ['ctrl', 'KeyV'],
  toggle_export: ['ctrl', 'shift', 'KeyE'],
  rotate_left: ['ctrl', 'BracketLeft'],
  rotate_right: ['ctrl', 'BracketRight'],
  toggle_side_panels: ['Tab'],
  toggle_all_panels: ['shift', 'Tab'],
  toggle_bottom_panel: ['F6'],
  toggle_left_panel: ['F7'],
  toggle_right_panel: ['F8'],
  toggle_metadata: [],
  toggle_library_exif: ['KeyI'],
  toggle_masks: ['shift', 'KeyW'],
  toggle_ai: [],
  toggle_presets: [],
  toggle_folder_tree: [],
  toggle_crop: [],
  toggle_analytics: [],
  color_label_red: ['Digit6'],
  color_label_yellow: ['Digit7'],
  color_label_green: ['Digit8'],
  color_label_blue: ['Digit9'],
  color_label_none: [],
  color_label_purple: [],
  rating_up: ['BracketRight'],
  rating_down: ['BracketLeft'],
  brush_size_up: ['BracketRight'],
  brush_size_down: ['BracketLeft'],
  brush_feather_up: ['shift', 'BracketRight'],
  brush_feather_down: ['shift', 'BracketLeft'],
  white_balance: ['KeyW'],
  auto_adjust: ['ctrl', 'KeyU'],
  reset_adjustments: ['ctrl', 'shift', 'KeyR'],
  import_photos: ['ctrl', 'shift', 'KeyI'],
  rename_photos: ['F2'],
  create_folder: ['ctrl', 'shift', 'KeyN'],
  create_album: ['ctrl', 'KeyN'],
  open_people: ['KeyO'],
  deselect_all: ['ctrl', 'KeyD'],
  select_active: ['ctrl', 'shift', 'KeyD'],
  open_panorama: ['ctrl', 'KeyM'],
  open_hdr: ['ctrl', 'KeyH'],
  shortcut_help: ['ctrl', 'Slash'],
};
for (let rating = 0; rating <= 5; rating++)
  lightroom[`rate_advance_${rating}` as CommandId] = ['shift', `Digit${rating}`];

export function profileOverrides(settings: ShortcutSettings | null | undefined) {
  return (settings?.shortcutProfile === 'lightroom' ? settings.lightroomKeybinds : settings?.keybinds) ?? {};
}
export function effectiveCombo(def: KeybindDefinition, settings?: ShortcutSettings | null): string[] {
  const overrides = profileOverrides(settings);
  if (Object.prototype.hasOwnProperty.call(overrides, def.action)) return overrides[def.action];
  return settings?.shortcutProfile === 'lightroom' ? (lightroom[def.action] ?? def.defaultCombo) : def.defaultCombo;
}
export function shortcutLabel(action: string, settings?: ShortcutSettings | null) {
  const def = KEYBIND_DEFINITIONS.find((item) => item.action === action);
  return def ? effectiveCombo(def, settings) : [];
}

export function contextsOverlap(a: CommandId, b: CommandId) {
  // Specific tool commands intentionally shadow an editor binding (e.g. brush size versus rating).
  if ([a, b].includes('go_back') && [a, b].includes('crop_cancel')) return false;
  const ca = commandContext(a),
    cb = commandContext(b);
  return (
    ca === cb ||
    ca === 'global' ||
    cb === 'global' ||
    (ca === 'library' && supportsLibrary(b)) ||
    (cb === 'library' && supportsLibrary(a))
  );
}
export function conflictingCommands(action: CommandId, combo: string[], settings: ShortcutSettings) {
  if (!combo.length) return [];
  return KEYBIND_DEFINITIONS.filter(
    (def) =>
      def.action !== action &&
      contextsOverlap(action, def.action) &&
      effectiveCombo(def, settings).join('+') === combo.join('+'),
  );
}
