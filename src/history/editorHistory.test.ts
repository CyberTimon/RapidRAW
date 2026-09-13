import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../utils/adjustments';
import { getActionHistorySnapshot, resetActionHistory, undoLastAction } from './actionHistory';
import { recordAdjustmentChange } from './editorHistory';

type TestRuntime = typeof globalThis & {
  __rapidrawInvoke?: () => Promise<unknown>;
};

test('failed persisted editor undo restores the visible state and remains retryable', async () => {
  resetActionHistory();
  let visible: Adjustments = { ...INITIAL_ADJUSTMENTS, exposure: 1 };
  (globalThis as TestRuntime).__rapidrawInvoke = async () => {
    throw new Error('write failed');
  };
  recordAdjustmentChange({
    path: 'photo.jpg',
    before: { ...INITIAL_ADJUSTMENTS },
    beforeIndex: 0,
    after: visible,
    afterIndex: 1,
    apply: (adjustments) => {
      visible = adjustments;
    },
  });

  await assert.rejects(undoLastAction(), /write failed/);
  assert.equal(visible.exposure, 1);
  assert.equal(getActionHistorySnapshot().canUndo, true);
});
