import test from 'node:test';
import assert from 'node:assert/strict';
import { queueThumbnails, resetThumbnailRequests, thumbnailGeneration } from './thumbnailRequests';

test('folder changes discard old requests and send reset before new work', async () => {
  const calls: { paths: string[]; requestGeneration: number; medium: boolean }[] = [];
  Object.assign(globalThis, {
    __rapidrawInvoke: async (_command: string, args: (typeof calls)[number]) => {
      calls.push(args);
    },
  });
  const old = queueThumbnails(['old']);
  const reset = resetThumbnailRequests();
  const current = queueThumbnails(['new'], true);
  await Promise.all([old, reset, current]);
  assert.deepEqual(
    calls.map((call) => call.paths),
    [[], ['new']],
  );
  assert.ok(calls.every((call) => call.requestGeneration === thumbnailGeneration()));
  assert.equal(calls[1].medium, true);
});
