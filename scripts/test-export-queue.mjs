import { build } from 'esbuild';
import assert from 'node:assert/strict';

const result = await build({
  stdin: {
    contents: `export { useExportQueueStore } from './src/store/useExportQueueStore';
      export { useProcessStore } from './src/store/useProcessStore';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'tauri-test-boundary',
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: `export const invoke = (...args) => globalThis.exportTestInvoke(...args);`,
        }));
      },
    },
  ],
});
const calls = [];
let failNext = false;
globalThis.exportTestInvoke = (name, args) => {
  calls.push({ name, args });
  if (failNext) {
    failNext = false;
    return Promise.reject('Cannot start');
  }
  return Promise.resolve();
};
const module = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, () => {
  throw Error('Unexpected require');
});
const { useExportQueueStore: queue, useProcessStore: processStore } = module.exports;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const request = {
  paths: ['one.raw'],
  outputFolderOrFile: '/exports',
  isExplicitFilePath: false,
  baseOriginFolders: [],
  exportSettings: { jpegQuality: 95 },
  outputFormat: 'jpeg',
  currentEditPath: 'one.raw',
  currentEditAdjustments: { exposure: 1 },
};
queue.getState().enqueue(request);
queue.getState().enqueue(request);
request.currentEditAdjustments.exposure = 9;
assert.equal(calls.length, 1, 'Only one job starts');
assert.equal(calls[0].args.currentEditAdjustments.exposure, 1, 'Edits are snapshotted');
await tick();
assert.equal(calls.length, 1, 'Invoke resolution does not advance queue');
processStore.getState().setExportState({ progress: { current: 1, total: 1 } });
assert.equal(queue.getState().jobs[0].current, 1);
processStore.getState().setExportState({ status: 'success' });
await tick();
assert.equal(calls.length, 2, 'Completion advances queue');
queue.getState().enqueue(request);
const queued = queue.getState().jobs[2].id;
await queue.getState().cancel(queued);
assert.equal(queue.getState().jobs[2].status, 'cancelled');
const active = queue.getState().activeId;
await queue.getState().cancel(active);
assert.equal(queue.getState().jobs[1].status, 'cancelling');
queue.getState().enqueue(request);
assert.equal(calls.filter((call) => call.name === 'export_images').length, 2, 'Cancellation waits for worker cleanup');
processStore.getState().setExportState({ status: 'cancelled' });
await tick();
assert.equal(calls.filter((call) => call.name === 'export_images').length, 3);
queue.getState().enqueue(request);
queue.getState().enqueue(request);
failNext = true;
processStore.getState().setExportState({ status: 'error', errorMessage: 'Worker failed' });
await tick();
assert.equal(queue.getState().jobs[4].status, 'error', 'Start failure is recorded');
assert.equal(queue.getState().jobs[5].status, 'exporting', 'Queue continues after failure');
processStore.getState().setExportState({ status: 'success' });
await tick();
assert.equal(queue.getState().activeId, null);
queue.getState().dismiss(queued);
assert.ok(!queue.getState().jobs.some((job) => job.id === queued));
processStore.getState().setExportState({ status: 'exporting' });
const beforeExternal = calls.length;
queue.getState().enqueue(request);
assert.equal(calls.length, beforeExternal, 'Queue waits for an existing external export');
processStore.getState().setExportState({ status: 'success' });
await tick();
assert.equal(calls.length, beforeExternal + 1);
failNext = true;
await queue.getState().cancel(queue.getState().activeId);
assert.equal(queue.getState().jobs.at(-1).status, 'exporting', 'Cancellation failure keeps the job active');
assert.equal(queue.getState().jobs.at(-1).error, 'Cannot start');
processStore.getState().setExportState({ status: 'success' });
await tick();
// Clear terminal reset timer so this script exits immediately.
processStore.getState().setExportState({ status: 'idle' });
console.log('Export queue: snapshots, sequencing, progress, cancellation, failure recovery, dismissal passed.');
