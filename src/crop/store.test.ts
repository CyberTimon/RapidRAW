import test from 'node:test';
import assert from 'node:assert/strict';
import { useEditorStore } from '../store/useEditorStore';
import { INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import type { SelectedImage } from '../components/ui/AppProperties';
import { resetActionHistory, undoLastAction } from '../history/actionHistory';

function reset() {
  const store = useEditorStore.getState();
  store.resetHistory({ ...INITIAL_ADJUSTMENTS, rotation: 0 });
  store.setEditor({ selectedImage: { path: 'photo-a', width: 1000, height: 800, isReady: true } as SelectedImage });
  store.beginCrop();
}
test('cancel restores geometry without undoing exposure', () => {
  reset();
  let store = useEditorStore.getState();
  store.setEditor({ adjustments: { ...store.adjustments, rotation: 20, exposure: 1 } });
  store = useEditorStore.getState();
  store.pushHistory(store.adjustments);
  store.finishCrop(false);
  store = useEditorStore.getState();
  assert.equal(store.adjustments.rotation, 0);
  assert.equal(store.adjustments.exposure, 1);
  assert.equal(store.cropSession, null);
  assert.ok(store.history.every((entry) => entry.rotation === 0));
});
test('accepted crop adds one global history entry and supports undo/redo', () => {
  reset();
  const store = useEditorStore.getState();
  for (const rotation of [10, 20, 30])
    store.setEditor({ adjustments: { ...useEditorStore.getState().adjustments, rotation } });
  store.finishCrop(true);
  assert.equal(useEditorStore.getState().history.length, 2);
  store.undo();
  assert.equal(useEditorStore.getState().adjustments.rotation, 0);
  store.redo();
  assert.equal(useEditorStore.getState().adjustments.rotation, 30);
});
test('draft undo preserves non-geometric adjustments', () => {
  reset();
  const store = useEditorStore.getState();
  store.setEditor({ adjustments: { ...store.adjustments, rotation: 10 } });
  store.setEditor({ adjustments: { ...useEditorStore.getState().adjustments, rotation: 20, exposure: 2 } });
  store.undo();
  assert.equal(useEditorStore.getState().adjustments.rotation, 10);
  assert.equal(useEditorStore.getState().adjustments.exposure, 2);
  store.redo();
  assert.equal(useEditorStore.getState().adjustments.rotation, 20);
});
test('unchanged session adds no history and a new image clears the session', () => {
  reset();
  const store = useEditorStore.getState();
  store.finishCrop(true);
  assert.equal(useEditorStore.getState().history.length, 1);
  store.beginCrop();
  store.resetHistory(INITIAL_ADJUSTMENTS);
  assert.equal(useEditorStore.getState().cropSession, null);
});

test('history menu selects local crop steps while preserving exposure', () => {
  reset();
  const store = useEditorStore.getState();
  store.setEditor({ adjustments: { ...store.adjustments, rotation: 10 } });
  store.setEditor({ adjustments: { ...useEditorStore.getState().adjustments, rotation: 20, exposure: 2 } });
  store.goToHistoryIndex(1);
  assert.equal(useEditorStore.getState().adjustments.rotation, 10);
  assert.equal(useEditorStore.getState().adjustments.exposure, 2);
  assert.equal(useEditorStore.getState().cropSession?.index, 1);
  assert.equal(useEditorStore.getState().historyIndex, 0);
  store.finishCrop(false);
  assert.equal(useEditorStore.getState().adjustments.rotation, 0);
});

test('history menu jumps are globally undoable outside crop', async () => {
  resetActionHistory();
  const store = useEditorStore.getState();
  store.resetHistory({ ...INITIAL_ADJUSTMENTS });
  store.setEditor({ selectedImage: { path: 'photo-a', width: 1, height: 1, isReady: true } as SelectedImage });
  store.pushHistory({ ...INITIAL_ADJUSTMENTS, exposure: 1 });
  store.pushHistory({ ...INITIAL_ADJUSTMENTS, exposure: 2 });

  store.goToHistoryIndex(0);
  assert.equal(useEditorStore.getState().adjustments.exposure, 0);
  await undoLastAction();
  assert.equal(useEditorStore.getState().adjustments.exposure, 2);
});
