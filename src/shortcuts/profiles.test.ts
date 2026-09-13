import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYBIND_DEFINITIONS } from './definitions';
import { effectiveCombo, conflictingCommands } from './profiles';
import { normalizeCombo } from '../utils/keyboardUtils';
import { resolveShortcuts } from './resolve';

const definition = (action: string) => KEYBIND_DEFINITIONS.find((def) => def.action === action)!;
test('old settings retain RapidRAW shortcuts; Lightroom is opt-in', () => {
  assert.deepEqual(effectiveCombo(definition('show_original'), {}), ['KeyB']);
  assert.deepEqual(effectiveCombo(definition('show_original'), { shortcutProfile: 'lightroom' }), ['Backslash']);
});
test('empty overrides disable shortcuts and profiles retain independent overrides', () => {
  const settings = {
    shortcutProfile: 'lightroom' as const,
    keybinds: { gallery: ['KeyT'] },
    lightroomKeybinds: { gallery: [] },
  };
  assert.deepEqual(effectiveCombo(definition('gallery'), settings), []);
  assert.deepEqual(effectiveCombo(definition('gallery'), { ...settings, shortcutProfile: 'rapidraw' }), ['KeyT']);
});
test('mutually exclusive tools reuse keys without conflicts', () => {
  assert.equal(conflictingCommands('crop_accept', ['Enter'], {}).length, 0);
  assert.equal(conflictingCommands('crop_lock', ['KeyA'], { shortcutProfile: 'lightroom' }).length, 0);
  assert.ok(
    conflictingCommands('gallery', ['KeyR'], { shortcutProfile: 'lightroom' }).some(
      (def) => def.action === 'toggle_crop_panel',
    ),
  );
});
test('normalizes Return on the numeric keypad', () => {
  assert.deepEqual(normalizeCombo({ code: 'NumpadEnter', key: 'Enter' } as KeyboardEvent), ['Enter']);
});
test('every command has a unique stable ID', () => {
  assert.equal(new Set(KEYBIND_DEFINITIONS.map((def) => def.action)).size, KEYBIND_DEFINITIONS.length);
});
test('Return belongs to crop in crop context and opens a photo in the library', () => {
  assert.deepEqual(resolveShortcuts(['Enter'], {}, 'crop'), ['crop_accept']);
  assert.deepEqual(resolveShortcuts(['Enter'], {}, 'library'), ['open_image']);
});
test('crop and mask commands shadow general commands without executing both', () => {
  assert.equal(resolveShortcuts(['Escape'], {}, 'crop')[0], 'crop_cancel');
  assert.equal(resolveShortcuts(['BracketRight'], { shortcutProfile: 'lightroom' }, 'mask')[0], 'brush_size_up');
  assert.equal(resolveShortcuts(['ArrowRight'], {}, 'crop')[0], 'crop_right');
});
test('disabled and immediately rebound shortcuts resolve from the latest settings', () => {
  assert.ok(!resolveShortcuts(['KeyG'], { keybinds: { gallery: [] } }, 'editor').includes('gallery'));
  assert.deepEqual(resolveShortcuts(['KeyT'], { keybinds: { gallery: ['KeyT'] } }, 'editor'), ['gallery']);
});
test('destructive and toggle commands do not repeat and People does not rate photos', () => {
  assert.equal(resolveShortcuts(['Delete'], {}, 'editor', true).length, 0);
  assert.equal(resolveShortcuts(['Digit1'], {}, 'people').length, 0);
  assert.ok(resolveShortcuts(['ArrowRight'], {}, 'library', true).includes('library_right'));
});
test('library navigation conflicts with photo commands mapped to the same key', () => {
  assert.ok(conflictingCommands('rate_1', ['ArrowRight'], {}).some((def) => def.action === 'library_right'));
});
test('shipped profiles have no ambiguous default conflicts', () => {
  for (const shortcutProfile of ['rapidraw', 'lightroom'] as const)
    for (const def of KEYBIND_DEFINITIONS) {
      assert.deepEqual(
        conflictingCommands(def.action, effectiveCombo(def, { shortcutProfile }), { shortcutProfile }).map(
          (d) => d.action,
        ),
        [],
        `${shortcutProfile}:${def.action}`,
      );
    }
});
