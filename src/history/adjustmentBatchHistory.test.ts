import test from 'node:test';
import assert from 'node:assert/strict';
import type { SelectedImage } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../utils/adjustments';
import { redoLastAction, resetActionHistory, undoLastAction } from './actionHistory';
import { captureAdjustmentSnapshots, recordAdjustmentBatch } from './adjustmentBatchHistory';

type TestRuntime = typeof globalThis & {
  __rapidrawInvoke?: (command: string, args: unknown) => Promise<unknown>;
};

test('batch history restores each photo adjustment snapshot', async () => {
  resetActionHistory();
  const saved: Record<string, Adjustments> = {
    'a.jpg': { ...INITIAL_ADJUSTMENTS, exposure: 1 },
    'b.jpg': { ...INITIAL_ADJUSTMENTS, exposure: 2 },
  };
  (globalThis as TestRuntime).__rapidrawInvoke = async (command, rawArgs) => {
    const args = rawArgs as { path: string; adjustments?: Adjustments };
    if (command === 'load_metadata') return { adjustments: structuredClone(saved[args.path]) };
    if (command === 'save_metadata_and_update_thumbnail' && args.adjustments)
      saved[args.path] = structuredClone(args.adjustments);
  };
  useEditorStore.setState({
    selectedImage: { path: 'a.jpg', width: 1, height: 1, isReady: true, isRaw: false } as SelectedImage,
  });
  useLibraryStore.setState({ libraryActivePath: 'b.jpg' });

  const before = await captureAdjustmentSnapshots(['a.jpg', 'b.jpg']);
  saved['a.jpg'] = { ...saved['a.jpg'], exposure: 4 };
  saved['b.jpg'] = { ...saved['b.jpg'], exposure: 4 };
  const after = await captureAdjustmentSnapshots(['a.jpg', 'b.jpg']);
  recordAdjustmentBatch('Paste adjustments', before, after);

  assert.equal(useEditorStore.getState().adjustments.exposure, 4);
  assert.equal(useLibraryStore.getState().libraryActiveAdjustments.exposure, 4);
  await undoLastAction();
  assert.equal(saved['a.jpg'].exposure, 1);
  assert.equal(saved['b.jpg'].exposure, 2);
  assert.equal(useEditorStore.getState().adjustments.exposure, 1);
  assert.equal(useLibraryStore.getState().libraryActiveAdjustments.exposure, 2);
  await redoLastAction();
  assert.equal(saved['a.jpg'].exposure, 4);
  assert.equal(saved['b.jpg'].exposure, 4);
});
