import test from 'node:test';
import assert from 'node:assert/strict';
import { verticalTarget } from './libraryNavigation';
test('vertical navigation follows displayed columns and short rows', () => {
  const rows = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g']];
  assert.equal(verticalTarget(rows, 'b', 1), 'e');
  assert.equal(verticalTarget(rows, 'e', -1), 'b');
  assert.equal(verticalTarget(rows, 'f', 1), 'g');
  assert.equal(verticalTarget(rows, 'a', -1), 'a');
});
test('list, empty library, and missing selection remain bounded', () => {
  assert.equal(verticalTarget([['a'], ['b']], 'a', 1), 'b');
  assert.equal(verticalTarget([], null, 1), null);
  assert.equal(verticalTarget([['a']], null, 1), 'a');
});
