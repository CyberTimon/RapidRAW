import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_UNIT, MIN_COLUMN_WIDTHS, getLibraryColumnWidths, libraryTableWidth } from './libraryColumns';

test('compressed stored columns retain readable minimum widths', () => {
  const stored = Object.fromEntries(Object.keys(MIN_COLUMN_WIDTHS).map(key => [key, 1]));
  const widths = getLibraryColumnWidths(stored as typeof MIN_COLUMN_WIDTHS);
  assert.deepEqual(widths, MIN_COLUMN_WIDTHS);
  assert.ok(libraryTableWidth(widths, false) > 600);
  assert.ok(libraryTableWidth(widths, true) > libraryTableWidth(widths, false));
});

test('resizing one column expands the table without compressing its neighbors', () => {
  const stored = Object.fromEntries(Object.keys(MIN_COLUMN_WIDTHS).map(key => [key, 1])) as typeof MIN_COLUMN_WIDTHS;
  const before = getLibraryColumnWidths(stored);
  const after = getLibraryColumnWidths({ ...stored, name: 600 / COLUMN_UNIT });
  assert.equal(after.name, 600);
  assert.equal(after.date, before.date);
  assert.equal(libraryTableWidth(after, true) - libraryTableWidth(before, true), 600 - before.name);
});
