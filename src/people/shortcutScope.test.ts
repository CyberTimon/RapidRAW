import { describe, expect, it } from 'vitest';
import { peopleShortcutScope, usablePeopleShortcut } from './shortcutScope';

describe('people shortcut scope', () => {
  it('prefers the active album, then folder, then global scope', () => {
    expect(peopleShortcutScope('/photos', 'favorites')).toBe('album:favorites');
    expect(peopleShortcutScope('/photos', null)).toBe('folder:/photos');
    expect(peopleShortcutScope(null, null)).toBe('global');
  });

  it('accepts plain letters and numbers outside editable controls', () => {
    const event = (key: string, target: unknown = null) =>
      ({ key, target, repeat: false, metaKey: false, ctrlKey: false, altKey: false }) as KeyboardEvent;
    expect(usablePeopleShortcut(event('D'))).toBe('d');
    expect(usablePeopleShortcut(event('7'))).toBe('7');
    expect(usablePeopleShortcut(event('D', { tagName: 'INPUT', isContentEditable: false }))).toBeNull();
    expect(usablePeopleShortcut({ ...event('D'), metaKey: true })).toBeNull();
  });

  it('accepts plain letters and numbers away from editable controls', () => {
    const event = (key: string, target: object | null = null, extra = {}) =>
      ({ key, target, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...extra }) as KeyboardEvent;
    expect(usablePeopleShortcut(event('D'))).toBe('d');
    expect(usablePeopleShortcut(event('7'))).toBe('7');
    expect(usablePeopleShortcut(event('D', { tagName: 'INPUT', isContentEditable: false }))).toBeNull();
    expect(usablePeopleShortcut(event('D', null, { metaKey: true }))).toBeNull();
    expect(usablePeopleShortcut(event('ArrowRight'))).toBeNull();
  });
});
