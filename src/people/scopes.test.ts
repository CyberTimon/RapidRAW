import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolvePeopleScope } from './scopes';
test('selection takes priority and virtual copies scan once', () => {
  assert.deepEqual(resolvePeopleScope('context', ['a.jpg', 'a.jpg?vc=123', 'b.jpg'], ['c.jpg'], [], []).paths, [
    'a.jpg',
    'b.jpg',
  ]);
});
test('filtered results remain exact even when the source contains other images', () => {
  assert.deepEqual(resolvePeopleScope('context', [], ['rated.jpg'], ['rated.jpg', 'unrated.jpg'], []).paths, [
    'rated.jpg',
  ]);
  assert.deepEqual(resolvePeopleScope('results', ['unrated.jpg'], ['rated.jpg'], [], []).paths, ['rated.jpg']);
});
test('source and roots are explicit and force is carried separately', () => {
  assert.deepEqual(resolvePeopleScope('source', [], [], ['a'], ['/photos'], true), {
    paths: ['a'],
    recursive: false,
    force: true,
  });
  assert.deepEqual(resolvePeopleScope('roots', [], [], ['a'], ['/photos']), {
    paths: ['/photos'],
    recursive: true,
    force: false,
  });
});
