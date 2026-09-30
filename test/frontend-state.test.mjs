import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-state-test-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const output = join(directory, 'state.cjs');
await build({
  stdin: {
    contents: `
      export { useEditorStore } from './src/store/useEditorStore';
      export { globalImageCache, ImageLRUCache } from './src/utils/ImageLRUCache';
      export { useUIStore, reconcileWorkspace } from './src/store/useUIStore';
      export { Panel } from './src/components/ui/AppProperties';
      export { normalizeLoadedAdjustments } from './src/utils/adjustments';
    `,
    resolveDir: resolve('.'),
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const {
  globalImageCache,
  ImageLRUCache,
  useEditorStore,
  useUIStore,
  reconcileWorkspace,
  Panel,
  normalizeLoadedAdjustments,
} = createRequire(import.meta.url)(output);

for (const method of ['movePanel', 'movePanelToIndex']) {
  test(`${method} selects a remaining source tab and the moved destination tab`, () => {
    useUIStore.setState(reconcileWorkspace(undefined, false));
    useUIStore.getState()[method](Panel.FolderTree, 'rightBottom', 0);
    const state = useUIStore.getState();
    assert.equal(state.activePanels.leftTop, Panel.Metadata);
    assert.equal(state.activePanels.rightBottom, Panel.FolderTree);
    assert.deepEqual(state.panelLayout.rightBottom, [Panel.FolderTree]);
    assert.equal(state.panelLayout.leftTop.includes(Panel.FolderTree), false);
    assert.equal(
      Object.values(state.panelLayout)
        .flat()
        .filter((panel) => panel === Panel.FolderTree).length,
      1,
    );
  });

  test(`${method} clears the active source tab after moving its final panel`, () => {
    useUIStore.setState(reconcileWorkspace(undefined, false));
    useUIStore.getState().movePanel(Panel.FolderTree, 'leftBottom');
    useUIStore.getState()[method](Panel.FolderTree, 'rightBottom', 0);
    assert.deepEqual(useUIStore.getState().panelLayout.leftBottom, []);
    assert.equal(useUIStore.getState().activePanels.leftBottom, null);
  });
}

test('legacy saved masks receive missing defaults without replacing explicit false or zero', () => {
  const saved = {
    exposure: 1.25,
    masks: [
      {
        id: 'mask',
        subMasks: [
          { id: 'legacy', type: 'brush' },
          {
            id: 'hidden',
            type: 'radial',
            visible: false,
            invert: true,
            opacity: 0,
            mode: 'subtractive',
            parameters: { centerX: 100, centerY: 120 },
          },
        ],
      },
    ],
    aiPatches: [
      {
        id: 'patch',
        visible: false,
        subMasks: [],
        patchData: {
          color: 'saved-color',
          mask: 'saved-mask',
          generation: { processing: 'tiled', tileSize: 512 },
        },
      },
    ],
  };
  const original = structuredClone(saved);
  const normalized = normalizeLoadedAdjustments({ ...saved, showClipping: true });
  assert.equal(normalized.exposure, 1.25);
  assert.equal('showClipping' in normalized, false, 'the clipping overlay is view state, not part of the edit');
  assert.deepEqual(normalized.masks[0].subMasks[0], {
    id: 'legacy',
    type: 'brush',
    visible: true,
    mode: 'additive',
    invert: false,
    opacity: 100,
    parameters: {},
  });
  assert.deepEqual(normalized.masks[0].subMasks[1], saved.masks[0].subMasks[1]);
  assert.equal(normalized.aiPatches[0].visible, false);
  assert.deepEqual(normalized.aiPatches[0].patchData, saved.aiPatches[0].patchData);
  assert.deepEqual(saved, original);
});

test('null sidecar adjustments and partial presets receive complete editor defaults', () => {
  const defaults = normalizeLoadedAdjustments(null);
  assert.equal(defaults.exposure, 0);
  assert.deepEqual(defaults.masks, []);
  const partial = normalizeLoadedAdjustments({ exposure: 2, temperature: -8 });
  assert.equal(partial.exposure, 2);
  assert.equal(partial.temperature, -8);
  assert.deepEqual(partial.curves, defaults.curves);
  assert.notEqual(partial.curves, defaults.curves);
});

test('same-size cached photo switches reset GPU readiness, patches and asset acknowledgements atomically', () => {
  const editor = useEditorStore.getState();
  editor.setEditor({ selectedImage: { path: 'a', isReady: true, width: 6000, height: 4000 } });
  editor.setEditor({
    hasRenderedFirstFrame: true,
    backendGeneration: 4,
    interactivePatch: { url: 'blob:old' },
    patchesSentToBackend: new Set(['old']),
    isSliderDragging: true,
  });
  const session = useEditorStore.getState().imageSession;
  editor.setEditor({
    selectedImage: { path: 'b', isReady: false, width: 6000, height: 4000 },
    finalPreviewUrl: 'cached-b',
  });
  const switched = useEditorStore.getState();
  assert.equal(switched.imageSession, session + 1);
  assert.equal(switched.hasRenderedFirstFrame, false);
  assert.equal(switched.backendGeneration, null);
  assert.equal(switched.interactivePatch, null);
  assert.equal(switched.patchesSentToBackend.size, 0);
  assert.equal(switched.isSliderDragging, false);
  assert.equal(switched.finalPreviewUrl, 'cached-b');
  editor.setEditor({ selectedImage: { ...switched.selectedImage, isReady: true }, backendGeneration: 5 });
  assert.equal(useEditorStore.getState().imageSession, session + 1);
  assert.equal(useEditorStore.getState().backendGeneration, 5);
});

test('rapid navigation cannot cache the previous photo snapshot under the new filename', () => {
  globalImageCache.clear();
  const snapshot = {
    selectedImage: { path: 'a', isReady: true },
    finalPreviewUrl: 'a-pixels',
    uncroppedPreviewUrl: null,
  };
  globalImageCache.set('b', snapshot);
  assert.equal(globalImageCache.get('b'), undefined);
  globalImageCache.set('a', snapshot);
  assert.equal(globalImageCache.get('a').finalPreviewUrl, 'a-pixels');
  globalImageCache.clear();
});

test('snapshot bytes evict inactive photos while a displayed Blob stays pinned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const revoked = [];
  const oldRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    URL.revokeObjectURL = oldRevoke;
  });
  const entry = (path) => ({
    adjustments: { exposure: 1 },
    histogram: null,
    waveform: null,
    finalPreviewUrl: `blob:${path}`,
    uncroppedPreviewUrl: null,
    selectedImage: { path, isReady: true, thumbnailUrl: '' },
    originalSize: { width: 100, height: 100 },
    previewSize: { width: 100, height: 100 },
    sourceRevision: 'revision',
  });
  const probe = new ImageLRUCache(5, 100_000);
  probe.registerBlobSize('blob:a', 1000);
  probe.set('a', entry('a'));
  const onePhotoBytes = probe.getStats().accountedBytes;
  const cache = new ImageLRUCache(5, onePhotoBytes * 2 + 20);
  for (const path of ['a', 'b', 'c']) cache.registerBlobSize(`blob:${path}`, 1000);
  cache.set('a', entry('a'));
  cache.setDisplayed('a', 'blob:a', null);
  cache.set('b', entry('b'));
  cache.set('c', entry('c'));
  assert.ok(cache.peek('a'));
  assert.equal(cache.peek('b'), undefined);
  assert.ok(cache.peek('c'));
  assert.ok(cache.getStats().accountedBytes <= cache.getStats().maxBytes);
  t.mock.timers.tick(500);
  assert.deepEqual(revoked, ['blob:b']);
  cache.clear();
  t.mock.timers.tick(500);
  assert.equal(revoked.includes('blob:a'), false);
  cache.setDisplayed(null, null, null);
  t.mock.timers.tick(500);
  assert.equal(revoked.includes('blob:a'), true);
});

test('oversized and unknown Blob snapshots are not retained', () => {
  const entry = (url) => ({
    adjustments: { exposure: 0 },
    finalPreviewUrl: url,
    uncroppedPreviewUrl: null,
    selectedImage: { path: 'photo', isReady: true, thumbnailUrl: '' },
  });
  const cache = new ImageLRUCache(2, 1000);
  assert.equal(cache.set('photo', entry('blob:unknown')), false);
  cache.registerBlobSize('blob:oversized', 2000);
  assert.equal(cache.set('photo', entry('blob:oversized')), false);
  assert.equal(cache.getStats().entries, 0);
});
