import test from 'node:test';
import assert from 'node:assert/strict';
import { queueAdjustmentSync } from './persistence';
import { useSyncProgressStore } from '../store/useSyncProgressStore';

test('tracks queued batches, monotonic progress, failures, and completion independently', async () => {
  const store = useSyncProgressStore.getState();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let onProgress!: (event: { payload: { jobId: string; completed: number } }) => void;
  let cleaned = 0;
  (
    globalThis as typeof globalThis & {
      __rapidrawListen: (event: string, callback: typeof onProgress) => () => void;
    }
  ).__rapidrawListen = (event, callback) => {
    assert.equal(event, 'adjustment-sync-progress');
    onProgress = callback;
    return () => {
      cleaned++;
    };
  };
  (globalThis as typeof globalThis & { __rapidrawInvoke: () => Promise<void> }).__rapidrawInvoke = async () => {
    calls++;
    if (calls === 1) {
      await gate;
      throw new Error('write failed');
    }
  };
  const first = queueAdjustmentSync(['a', 'b'], { brightness: 1 });
  const rejected = assert.rejects(first, /write failed/);
  const second = queueAdjustmentSync(['c'], { brightness: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [firstId, secondId] = Object.keys(useSyncProgressStore.getState().jobs);
  assert.equal(useSyncProgressStore.getState().jobs[firstId].status, 'running');
  assert.equal(useSyncProgressStore.getState().jobs[secondId].status, 'queued');
  onProgress({ payload: { jobId: secondId, completed: 1 } });
  assert.equal(useSyncProgressStore.getState().jobs[secondId].completed, 0);
  onProgress({ payload: { jobId: firstId, completed: 1 } });
  onProgress({ payload: { jobId: firstId, completed: 0 } });
  assert.equal(useSyncProgressStore.getState().jobs[firstId].completed, 1);
  store.dismiss();
  assert.equal(Object.keys(useSyncProgressStore.getState().jobs).length, 2);
  release();
  await rejected;
  await second;
  assert.equal(cleaned, 2);
  assert.equal(useSyncProgressStore.getState().jobs[firstId].status, 'failed');
  assert.equal(useSyncProgressStore.getState().jobs[secondId].status, 'complete');
  assert.equal(useSyncProgressStore.getState().jobs[secondId].completed, 1);
  store.advance(secondId, 0);
  assert.equal(useSyncProgressStore.getState().jobs[secondId].completed, 1);
  store.dismiss();
  assert.deepEqual(useSyncProgressStore.getState().jobs, {});
});
