import test from 'node:test';
import assert from 'node:assert/strict';
import { protectAutoEdit, markAutoHydration, isAutoHydration } from './editSafety';
import type { Adjustments, MaskContainer } from '../utils/adjustments';

function adjustments(masks: MaskContainer[]): Adjustments {
  return { masks, autoProvenance: { batchId: 'batch', version: '1', groupId: 'group', reduced: false } } as Adjustments;
}
const mask = {
  id: 'auto-face',
  autoOwner: 'batch',
  opacity: 100,
  adjustments: { exposure: 0.4 },
  subMasks: [],
} as unknown as MaskContainer;

test('editing an Auto mask detaches ownership and protects the photo', () => {
  const before = adjustments([mask]);
  const after = protectAutoEdit(before, adjustments([{ ...mask, opacity: 70 }]));
  assert.equal(after.masks[0].autoOwner, undefined);
  assert.equal(after.autoProvenance?.manual, true);
  assert.equal(before.masks[0].autoOwner, 'batch');
});
test('editing global tone leaves untouched Auto masks owned', () => {
  const before = adjustments([mask]);
  const after = protectAutoEdit(before, { ...before, exposure: 1 });
  assert.equal(after.masks[0].autoOwner, 'batch');
  assert.equal(after.autoProvenance?.manual, true);
});
test('normalizing equivalent mask objects does not detach ownership', () => {
  const before = adjustments([mask]);
  const after = protectAutoEdit(before, adjustments([structuredClone(mask)]));
  assert.equal(after.masks[0].autoOwner, 'batch');
});
test('saved batch hydration is distinguishable from subsequent manual edits', () => {
  const saved = markAutoHydration(adjustments([mask]));
  assert.equal(isAutoHydration(saved), true);
  const manual = protectAutoEdit(saved, { ...saved, exposure: 0.2 });
  assert.equal(isAutoHydration(manual), false);
  assert.equal(isAutoHydration({ ...saved }), false);
});
