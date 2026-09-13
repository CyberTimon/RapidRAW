import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../utils/adjustments';
import { resetActionHistory, undoLastAction } from './actionHistory';
import { captureAutoBatchHistory, recordCompletedAutoBatch } from './autoBatchHistory';

type TestRuntime = typeof globalThis & {
  __rapidrawInvoke?: (command: string, args: unknown) => Promise<unknown>;
};

test('Auto records only photos it actually changed', async () => {
  resetActionHistory();
  const saved: Record<string, Adjustments> = {
    'changed.jpg': { ...INITIAL_ADJUSTMENTS },
    'protected.jpg': { ...INITIAL_ADJUSTMENTS },
  };
  (globalThis as TestRuntime).__rapidrawInvoke = async (command, rawArgs) => {
    const args = rawArgs as { path: string; adjustments?: Adjustments };
    if (command === 'load_metadata') return { adjustments: structuredClone(saved[args.path]) };
    if (command === 'save_metadata_and_update_thumbnail' && args.adjustments)
      saved[args.path] = structuredClone(args.adjustments);
  };

  const capture = await captureAutoBatchHistory(Object.keys(saved), 'Auto adjustments');
  assert.ok(capture);
  saved['changed.jpg'] = { ...INITIAL_ADJUSTMENTS, exposure: 1 };
  saved['protected.jpg'] = { ...INITIAL_ADJUSTMENTS, exposure: 2 };
  await recordCompletedAutoBatch(capture, ['changed.jpg']);
  await undoLastAction();

  assert.equal(saved['changed.jpg'].exposure, 0);
  assert.equal(saved['protected.jpg'].exposure, 2);
});
