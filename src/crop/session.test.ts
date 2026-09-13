import test from 'node:test';
import assert from 'node:assert/strict';
import type { Adjustments } from '../utils/adjustments';
import { beginSession, committedAdjustments, recordGeometry } from './session';

const original = {
  crop: { unit: 'px', x: 20, y: 30, width: 600, height: 400 },
  rotation: 0,
  aspectRatio: 1.5,
  exposure: 0,
} as Adjustments;
test('crop and rotation drafts never enter persisted adjustments', () => {
  const session = beginSession('photo-a', original);
  const draft = { ...original, rotation: 20, crop: { ...original.crop!, x: 90 }, exposure: 1 };
  const saved = committedAdjustments(draft, session);
  assert.equal(saved.rotation, 0);
  assert.equal(saved.crop?.x, 20);
  assert.equal(saved.exposure, 1);
  assert.equal(draft.rotation, 20);
  assert.equal(committedAdjustments(draft, null), draft);
});
test('session history deduplicates and branches after undo', () => {
  const start = beginSession('photo-a', original);
  const first = recordGeometry(start, { ...original, rotation: 10 });
  assert.equal(recordGeometry(first, { ...original, rotation: 10 }), first);
  const branch = recordGeometry({ ...first, index: 0 }, { ...original, rotation: -10 });
  assert.equal(branch.history.length, 2);
  assert.equal(branch.history[1].rotation, -10);
  assert.deepEqual(branch.original, start.original);
});
