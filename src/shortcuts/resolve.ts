import { KEYBIND_DEFINITIONS, type CommandId } from './definitions';
import { effectiveCombo, type ShortcutSettings } from './profiles';
import { commandContext, supportsLibrary } from './contexts';

export function resolveShortcuts(
  combo: string[],
  settings: ShortcutSettings | null,
  context: string,
  repeat = false,
): CommandId[] {
  if (!combo.length) return [];
  return KEYBIND_DEFINITIONS.filter((def) => {
    if (effectiveCombo(def, settings).join('+') !== combo.join('+')) return false;
    const scope = commandContext(def.action);
    if (context === 'people' && scope !== 'global') return false;
    if (context === 'library' && scope === 'editor' && !supportsLibrary(def.action)) return false;
    if (['crop', 'mask', 'library'].includes(scope) && scope !== context) return false;
    return !repeat || /^(crop_(left|right|up|down)|library_|preview_|zoom_|brush_)/.test(def.action);
  })
    .sort((a, b) => Number(commandContext(b.action) === context) - Number(commandContext(a.action) === context))
    .map((def) => def.action);
}
