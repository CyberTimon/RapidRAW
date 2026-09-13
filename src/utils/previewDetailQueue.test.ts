import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailQueue, needsOriginalDetail } from './previewDetailQueue';

test('fit view never requests original detail, including Retina displays', () => {
  assert.equal(needsOriginalDetail(1, 2, 2), false);
  assert.equal(needsOriginalDetail(1.5, 0.25, 2), false);
  assert.equal(needsOriginalDetail(3, 0.25, 2), true);
});

test('detail renders serialize, skip obsolete requests, and recover after failures', async () => {
  const queue = createDetailQueue();
  const live = new AbortController();
  const obsolete = new AbortController();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue(live.signal, async () => {
    calls.push('first');
    await gate;
    return 1;
  });
  const canceled = queue(obsolete.signal, async () => {
    calls.push('obsolete');
    return 2;
  });
  const failure = queue(live.signal, async () => {
    calls.push('failure');
    throw new Error('missing original');
  });
  const failureCheck = assert.rejects(failure, /missing original/);
  const last = queue(live.signal, async () => {
    calls.push('last');
    return 3;
  });
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  obsolete.abort();
  release();
  assert.equal(await first, 1);
  assert.equal(await canceled, undefined);
  await failureCheck;
  assert.equal(await last, 3);
  assert.deepEqual(calls, ['first', 'failure', 'last']);
});
