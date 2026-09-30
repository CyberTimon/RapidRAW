import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-image-processing-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: `export default {};
    export const useRef = value => globalThis.__previewTest.hook(() => ({current:value}));
    export const useMemo = (fn, deps) => globalThis.__previewTest.hook(fn, deps);
    export const useCallback = (fn, deps) => useMemo(() => fn, deps);
    export const useEffect = (fn, deps) => globalThis.__previewTest.effect(fn, deps);`,
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__previewTest.invoke(...args);',
  './useEditorActions': 'export const debouncedSave = () => {};',
  '../components/panel/right/Masks':
    'export const SubMaskMode = {Additive:"additive", Subtractive:"subtractive", Intersect:"intersect"};',
  '../components/ui/AppProperties':
    'export const Panel = {Crop:"crop"}; export const Invokes = {ApplyAdjustments:"apply_adjustments", GenerateUncroppedPreview:"generate_uncropped_preview", GenerateComparisonPreview:"generate_comparison_preview", ApplyAdjustmentsToPaths:"apply_adjustments_to_paths", GetPreviewAssetCacheStatus:"get_preview_asset_cache_status"};',
};
for (const name of ['Editor', 'UI', 'Settings', 'Library']) {
  stubs[`../store/use${name}Store`] = `export const use${name}Store = fn => fn(globalThis.__previewTest.${name});
     use${name}Store.getState = () => globalThis.__previewTest.${name};`;
}
stubs['../store/useEditorStore'] += '\nuseEditorStore.subscribe = fn => globalThis.__previewTest.subscribe(fn);';
const output = join(directory, 'processing.mjs');
await build({
  stdin: {
    contents: `export {useImageProcessing} from './src/hooks/useImageProcessing';
      export {INITIAL_ADJUSTMENTS} from './src/utils/adjustments';`,
    resolveDir: process.cwd(),
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'preview-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
      },
    },
  ],
});
const { useImageProcessing, INITIAL_ADJUSTMENTS } = await import(pathToFileURL(output));
const drain = () => new Promise((resolve) => setImmediate(resolve));

function environment(t) {
  const slots = [];
  let index = 0;
  let effects = [];
  const same = (a, b) => a?.length === b?.length && a?.every((value, i) => Object.is(value, b[i]));
  const state = {
    calls: [],
    uncroppedCalls: [],
    comparisonCalls: [],
    intents: [],
    retainAssets: true,
    subscribers: new Set(),
    subscribe(fn) {
      state.subscribers.add(fn);
      return () => state.subscribers.delete(fn);
    },
    Editor: {
      imageSession: 1,
      backendGeneration: 11,
      selectedImage: { path: 'a.png', isReady: true },
      adjustments: structuredClone(INITIAL_ADJUSTMENTS),
      previewOverride: null,
      showOriginal: false,
      hasRenderedFirstFrame: true,
      histogram: null,
      waveform: null,
      isWaveformVisible: false,
      activeWaveformChannel: 'luma',
      displaySize: { width: 0, height: 0 },
      baseRenderSize: null,
      originalSize: { width: 6000, height: 4000 },
      isSliderDragging: true,
      patchesSentToBackend: new Set(),
      interactivePatch: null,
    },
    UI: { activeView: 'editor', activePanel: 'adjustments' },
    Settings: { appSettings: { editorPreviewResolution: 5120, livePreviewQuality: 'high' } },
    Library: { multiSelectedPaths: [] },
    hook(factory, deps) {
      const i = index++;
      if (!slots[i] || (deps && !same(slots[i].deps, deps))) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    effect(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        effects.push(() => {
          slots[i]?.cleanup?.();
          slots[i] = { deps, cleanup: fn() };
        });
      }
    },
    invoke(command, payload) {
      if (command === 'set_preview_intent') {
        state.intents.push(payload);
        return Promise.resolve();
      }
      if (command === 'generate_comparison_preview')
        return new Promise((resolve, reject) => state.comparisonCalls.push({ payload, resolve, reject }));
      if (command === 'generate_uncropped_preview')
        return new Promise((resolve, reject) => state.uncroppedCalls.push({ payload, resolve, reject }));
      if (command === 'get_preview_asset_cache_status')
        return Promise.resolve({ cacheEpoch: 1, retainedKeys: state.retainAssets ? payload.keys : [] });
      if (command !== 'apply_adjustments') return Promise.resolve();
      return new Promise((resolve, reject) => state.calls.push({ payload, resolve, reject }));
    },
  };
  state.Editor.setEditor = (value) => {
    const previous = { ...state.Editor };
    Object.assign(state.Editor, typeof value === 'function' ? value(state.Editor) : value);
    state.subscribers.forEach((listener) => listener(state.Editor, previous));
  };
  globalThis.__previewTest = state;
  const refs = {
    previewJobIdRef: { current: 0 },
    latestRenderedJobIdRef: { current: 0 },
    currentResRef: { current: 0 },
  };
  const transform = { current: null };
  const previous = { current: null };
  state.transform = transform;
  state.render = () => {
    index = 0;
    effects = [];
    const result = useImageProcessing(transform, previous, refs);
    effects.forEach((effect) => effect());
    return result;
  };
  state.finish = (i) => state.calls[i].resolve(new TextEncoder().encode('WGPU_RENDER').buffer);
  t.after(() => slots.forEach((slot) => slot?.cleanup?.()));
  return state;
}

test('the editor sends a bounded drag render, skips obsolete values and restores requested detail on release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = environment(t);
  state.render();
  await drain();
  assert.equal(state.calls[0].payload.targetResolution, 1920);
  assert.equal(state.calls[0].payload.isInteractive, true);
  for (const exposure of [0.25, 0.5, 0.75]) {
    state.Editor.adjustments = { ...state.Editor.adjustments, exposure };
    state.render();
  }
  state.Editor.isSliderDragging = false;
  state.render();
  assert.equal(state.calls.length, 1);
  state.finish(0);
  await drain();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.jsAdjustments.exposure, 0.75);
  assert.equal(state.calls[1].payload.targetResolution, 1920);
  assert.equal(state.calls[1].payload.isInteractive, true);
  state.finish(1);
  await drain();
  assert.equal(state.calls.length, 2);
  t.mock.timers.tick(149);
  await drain();
  assert.equal(state.calls.length, 2);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(state.calls[2].payload.targetResolution, 5120);
  assert.equal(state.calls[2].payload.isInteractive, false);
  state.finish(2);
  await drain();
});

test('failed old-photo renders cannot clear the next photo preview or stall its pending render', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  state.Editor.imageSession += 1;
  state.Editor.selectedImage = { path: 'b.png', isReady: true };
  const currentPatch = { url: 'current-photo-preview' };
  state.Editor.interactivePatch = currentPatch;
  state.render();
  state.calls[0].reject(new Error('previous photo failed'));
  await drain();
  assert.equal(state.Editor.interactivePatch, currentPatch);
  assert.equal(state.calls.length, 2);
  state.finish(1);
  await drain();
});

test('returning to the same filename cannot accept a response from the earlier photo session', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  state.Editor.imageSession += 1;
  state.Editor.selectedImage = { path: 'b.png', isReady: true };
  state.render();
  state.Editor.imageSession += 1;
  state.Editor.selectedImage = { path: 'a.png', isReady: true };
  state.render();
  const currentPatch = { url: 'reopened-photo-preview' };
  state.Editor.interactivePatch = currentPatch;
  state.finish(0);
  await drain();
  assert.equal(state.Editor.interactivePatch, currentPatch);
  assert.equal(state.calls.length, 2);
  state.finish(1);
  await drain();
});

test('a final JPEG publishes its frame and clears the quick patch in one state update', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  state.Editor.interactivePatch = { url: 'blob:quick-patch' };
  const publications = [];
  state.subscribe((current, previous) => {
    if (current.finalPreviewUrl !== previous.finalPreviewUrl) {
      publications.push({ url: current.finalPreviewUrl, patch: current.interactivePatch });
    }
  });

  state.render();
  await drain();
  assert.equal(state.calls[0].payload.isInteractive, false);
  state.calls[0].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();

  assert.equal(publications.length, 1);
  assert.match(publications[0].url, /^blob:/);
  assert.equal(publications[0].patch, null);
  assert.equal(state.Editor.interactivePatch, null);
  t.after(() => URL.revokeObjectURL(publications[0].url));
});

test('leaving Show Original reuses the unchanged edited WGPU frame and restores analytics', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  const editedHistogram = { channel: 'edited' };
  state.Editor.histogram = editedHistogram;
  state.render();
  await drain();
  state.finish(0);
  await drain();

  state.Editor.setEditor({
    showOriginal: true,
    previewOverride: { ...INITIAL_ADJUSTMENTS },
  });
  state.render();
  await drain();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.compareOriginal, true);
  assert.equal(state.calls[1].payload.roi, null);
  state.calls[1].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();
  assert.match(state.Editor.comparisonPreviewUrl, /^blob:/);
  assert.equal(state.Editor.finalPreviewUrl, undefined);

  state.Editor.histogram = { channel: 'original' };
  state.Editor.setEditor({ showOriginal: false, previewOverride: null, comparisonPreviewUrl: null });
  state.render();
  await drain();
  assert.equal(state.calls.length, 2);
  assert.equal(state.Editor.histogram, editedHistogram);
});

test('Show Original falls back to rendering if the edited adjustments changed', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  state.render();
  await drain();
  state.finish(0);
  await drain();

  state.Editor.setEditor({ showOriginal: true, previewOverride: { ...INITIAL_ADJUSTMENTS } });
  state.render();
  await drain();
  state.calls[1].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();

  state.Editor.setEditor({
    showOriginal: false,
    previewOverride: null,
    adjustments: { ...state.Editor.adjustments, exposure: 1 },
  });
  state.render();
  await drain();
  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[2].payload.compareOriginal, false);
  assert.equal(state.calls[2].payload.jsAdjustments.exposure, 1);
  state.finish(2);
  await drain();
});

test('leaving Show Original keeps the existing JPEG preview URL', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  state.render();
  await drain();
  state.calls[0].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();
  const editedUrl = state.Editor.finalPreviewUrl;
  assert.match(editedUrl, /^blob:/);

  state.Editor.setEditor({ showOriginal: true, previewOverride: { ...INITIAL_ADJUSTMENTS } });
  state.render();
  await drain();
  state.calls[1].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();
  assert.equal(state.Editor.finalPreviewUrl, editedUrl);
  assert.match(state.Editor.comparisonPreviewUrl, /^blob:/);

  state.Editor.setEditor({ showOriginal: false, previewOverride: null, comparisonPreviewUrl: null });
  state.render();
  await drain();
  assert.equal(state.calls.length, 2);
  assert.equal(state.Editor.finalPreviewUrl, editedUrl);
  t.after(() => URL.revokeObjectURL(editedUrl));
});

test('leaving Show Original reuses a settled higher-resolution frame after fitting the view', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  state.render();
  await drain();
  assert.equal(state.calls[0].payload.targetResolution, 5120);
  state.finish(0);
  await drain();

  state.Editor.setEditor({ showOriginal: true, previewOverride: { ...INITIAL_ADJUSTMENTS } });
  state.render();
  await drain();
  state.calls[1].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();

  state.Editor.displaySize = { width: 600, height: 400 };
  state.Editor.setEditor({ showOriginal: false, previewOverride: null, comparisonPreviewUrl: null });
  state.render();
  await drain();
  assert.equal(state.calls.length, 2);
});

test('leaving Show Original renders again when the visible region has changed', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  state.render();
  await drain();
  state.finish(0);
  await drain();

  state.Editor.setEditor({ showOriginal: true, previewOverride: { ...INITIAL_ADJUSTMENTS } });
  state.render();
  await drain();
  state.calls[1].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();

  state.Editor.baseRenderSize = {
    width: 800,
    height: 600,
    offsetX: 0,
    offsetY: 0,
    containerWidth: 800,
    containerHeight: 600,
  };
  state.transform.current = {
    instance: { transformState: { scale: 2, positionX: 0, positionY: 0 } },
  };
  state.Editor.setEditor({ showOriginal: false, previewOverride: null, comparisonPreviewUrl: null });
  state.render();
  await drain();
  assert.equal(state.calls.length, 3);
  assert.notEqual(state.calls[2].payload.roi, null);
  state.finish(2);
  await drain();
});

test('returning from Show Original at a different preview resolution re-renders', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Settings.appSettings.livePreviewQuality = 'full';
  state.render();
  await drain();
  state.finish(0);
  await drain();
  state.Editor.setEditor({ showOriginal: true, previewOverride: { ...INITIAL_ADJUSTMENTS } });
  state.render();
  await drain();
  state.calls[1].resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
  await drain();

  state.Settings.appSettings = { ...state.Settings.appSettings, editorPreviewResolution: 4096 };
  state.Editor.setEditor({ showOriginal: false, previewOverride: null, comparisonPreviewUrl: null });
  state.render();
  await drain();
  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[2].payload.targetResolution, 4096);
  state.finish(2);
  await drain();
});

test('crop previews coalesce slow work and reject responses from an earlier image session', async (t) => {
  const state = environment(t);
  state.UI.activePanel = 'crop';
  state.render();
  await drain();
  assert.equal(state.uncroppedCalls.length, 1);
  for (const exposure of [0.25, 0.5, 0.75]) {
    state.Editor.adjustments = { ...state.Editor.adjustments, exposure };
    state.render();
  }
  assert.equal(state.uncroppedCalls.length, 1);
  state.uncroppedCalls[0].resolve('first-preview');
  await drain();
  assert.equal(state.uncroppedCalls.length, 2);
  assert.equal(state.uncroppedCalls[1].payload.jsAdjustments.exposure, 0.75);
  state.Editor.imageSession += 1;
  state.Editor.selectedImage = { path: 'b.png', isReady: true };
  state.render();
  state.Editor.imageSession += 1;
  state.Editor.selectedImage = { path: 'a.png', isReady: true };
  state.render();
  state.Editor.uncroppedAdjustedPreviewUrl = 'reopened-preview';
  state.uncroppedCalls[1].resolve('stale-preview');
  await drain();
  assert.equal(state.Editor.uncroppedAdjustedPreviewUrl, 'reopened-preview');
  assert.equal(state.uncroppedCalls.length, 3);
  state.uncroppedCalls[2].resolve('current-preview');
  await drain();
  assert.equal(state.Editor.uncroppedAdjustedPreviewUrl, 'current-preview');
});

test('a new edit supersedes full-detail refinement and store switches reject results before React effects', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.render();
  await drain();
  assert.equal(state.calls[0].payload.expectedGeneration, 11);
  state.Editor.adjustments = { ...state.Editor.adjustments, exposure: 2 };
  state.render();
  state.finish(0);
  await drain();
  assert.equal(state.calls[1].payload.isInteractive, true);
  assert.equal(state.calls[1].payload.jsAdjustments.exposure, 2);
  state.Editor.imageSession += 1;
  state.Editor.selectedImage = { path: 'b.png', isReady: false };
  const patch = { url: 'new-photo' };
  state.Editor.interactivePatch = patch;
  state.finish(1);
  await drain();
  assert.equal(state.Editor.interactivePatch, patch);
});

test('the first render after a photo switch fills the whole texture even at retained zoom', async (t) => {
  const state = environment(t);
  state.Editor.baseRenderSize = {
    width: 1000,
    height: 600,
    offsetX: 0,
    offsetY: 0,
    containerWidth: 500,
    containerHeight: 300,
  };
  state.transform.current = { instance: { transformState: { scale: 2, positionX: 0, positionY: 0 } } };
  state.render();
  await drain();
  assert.equal(state.calls[0].payload.roi, null);
  state.finish(0);
  await drain();
  state.Editor.adjustments = { ...state.Editor.adjustments, exposure: 0.5 };
  state.render();
  await drain();
  assert.ok(state.calls[1].payload.roi);
  state.finish(1);
  await drain();
  state.Editor.selectedImage = { path: 'b.png', isReady: true };
  state.Editor.imageSession++;
  state.render();
  await drain();
  assert.equal(state.calls[2].payload.roi, null);
  state.finish(2);
  await drain();
});

test('new input sends intent before the running render resolves and cancelled assets are retransmitted', async (t) => {
  const state = environment(t);
  const makeAdjustments = (pixels) => ({
    ...state.Editor.adjustments,
    masks: [{ id: 'layer', subMasks: [{ id: 'brush', parameters: { maskDataBase64: pixels } }] }],
  });
  state.Editor.adjustments = makeAdjustments('OLD_PIXELS');
  state.render();
  await drain();
  const oldKey = state.calls[0].payload.jsAdjustments.masks[0].subMasks[0].previewAssetKey;
  const firstIntent = state.intents.find((intent) => intent.lane === 'main');
  state.Editor.adjustments = makeAdjustments('NEW_PIXELS');
  state.render();
  const nextIntent = state.intents.filter((intent) => intent.lane === 'main').at(-1);
  assert.equal(state.calls.length, 1);
  assert.ok(nextIntent.inputRevision > firstIntent.inputRevision);
  state.calls[0].reject('PREVIEW_SUPERSEDED');
  await drain();
  assert.equal(state.Editor.patchesSentToBackend.has(oldKey), false);
  assert.equal(state.calls[1].payload.jsAdjustments.masks[0].subMasks[0].parameters.maskDataBase64, 'NEW_PIXELS');
  assert.equal(state.calls[1].payload.inputRevision, nextIntent.inputRevision);
  state.finish(1);
  await drain();
});

test('an acknowledged asset evicted before render is resent inline once for the current input', async (t) => {
  const state = environment(t);
  const recipe = {
    ...state.Editor.adjustments,
    masks: [{ id: 'layer', subMasks: [{ id: 'brush', parameters: { maskDataBase64: 'PIXELS' } }] }],
  };
  state.Editor.adjustments = recipe;
  state.render();
  await drain();
  state.finish(0);
  await drain();
  const key = state.calls[0].payload.jsAdjustments.masks[0].subMasks[0].previewAssetKey;
  assert.equal(state.Editor.patchesSentToBackend.has(key), true);

  state.Editor.adjustments = { ...recipe, exposure: 0.5 };
  state.render();
  await drain();
  const stripped = state.calls[1].payload.jsAdjustments.masks[0].subMasks[0];
  assert.equal(stripped.parameters.maskDataBase64, null);
  assert.deepEqual(stripped.previewAssetFields, ['maskDataBase64']);
  state.calls[1].reject(`PREVIEW_ASSET_MISSING:{"cacheEpoch":2,"missingKeys":["${key}"]}`);
  await drain();
  const inline = state.calls[2].payload.jsAdjustments.masks[0].subMasks[0];
  assert.equal(inline.parameters.maskDataBase64, 'PIXELS');
  assert.deepEqual(inline.previewAssetFields, []);
  state.finish(2);
  await drain();
  assert.equal(state.Editor.patchesSentToBackend.has(key), true);
});

test('release reuses the matching quick pass and queues detail only after quiet time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = environment(t);
  state.render();
  await drain();
  const revision = state.calls[0].payload.inputRevision;
  state.finish(0);
  await drain();
  state.Editor.isSliderDragging = false;
  state.render();
  assert.equal(state.calls.length, 1);
  assert.equal(state.intents.filter((intent) => intent.lane === 'main').length, 1);
  t.mock.timers.tick(150);
  await drain();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.inputRevision, revision);
  assert.equal(state.calls[1].payload.targetResolution, 5120);
  state.finish(1);
  await drain();
});

test('a later edit cancels deferred detail and Full quality keeps its requested resolution', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.render();
  await drain();
  state.finish(0);
  await drain();
  state.Editor.adjustments = { ...state.Editor.adjustments, exposure: 0.5 };
  state.render();
  await drain();
  state.finish(1);
  await drain();
  t.mock.timers.tick(150);
  await drain();
  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[2].payload.jsAdjustments.exposure, 0.5);
  state.finish(2);
  await drain();

  state.Settings.appSettings.livePreviewQuality = 'full';
  state.Editor.adjustments = { ...state.Editor.adjustments, exposure: 1 };
  state.render();
  await drain();
  assert.equal(state.calls[3].payload.targetResolution, 5120);
  assert.equal(state.calls[3].payload.isInteractive, false);
  state.finish(3);
  await drain();
  t.mock.timers.tick(150);
  await drain();
  assert.equal(state.calls.length, 4);
});

test('photo selection invalidates the old generation before metadata or React rendering', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  const count = state.intents.length;
  state.Editor.setEditor({
    selectedImage: { path: 'b.png', isReady: false },
    backendGeneration: null,
    imageSession: 2,
  });
  const invalidation = state.intents.slice(count);
  assert.deepEqual(
    invalidation.map((intent) => intent.lane),
    ['main', 'overlay', 'uncropped', 'comparison'],
  );
  assert.ok(invalidation.every((intent) => intent.expectedGeneration === 11));
  state.calls[0].reject('PREVIEW_SUPERSEDED');
  await drain();
});

test('an adjustment store update signals supersession synchronously and reuses that revision in the invoke', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  const count = state.intents.length;
  state.Editor.setEditor({ adjustments: { ...state.Editor.adjustments, exposure: 1.5 } });
  assert.equal(state.intents.length, count + 1);
  const revision = state.intents.at(-1).inputRevision;
  state.render();
  state.calls[0].reject('PREVIEW_SUPERSEDED');
  await drain();
  assert.equal(state.calls[1].payload.inputRevision, revision);
  assert.equal(state.calls[1].payload.jsAdjustments.exposure, 1.5);
  state.finish(1);
  await drain();
});

test('split view renders the unedited side only for geometry changes and ignores superseded results', async (t) => {
  const state = environment(t);
  state.Editor.isSliderDragging = false;
  state.Editor.splitCompare = true;
  state.Editor.splitComparisonUrl = null;
  state.Editor.adjustments = { ...state.Editor.adjustments, exposure: 1.5 };
  state.render();
  await drain();
  assert.equal(state.comparisonCalls.length, 1);
  assert.equal(state.comparisonCalls[0].payload.jsAdjustments.exposure, 0, 'the unedited side ignores tone edits');

  state.Editor.adjustments = { ...state.Editor.adjustments, exposure: 2 };
  state.render();
  await drain();
  assert.equal(state.comparisonCalls.length, 1, 'tone edits do not re-render the unedited side');

  state.Editor.adjustments = { ...state.Editor.adjustments, rotation: 3 };
  state.render();
  await drain();
  state.comparisonCalls[0].resolve(new Uint8Array([1]).buffer);
  await drain();
  assert.equal(state.Editor.splitComparisonUrl, null, 'a superseded comparison is discarded');
  assert.equal(state.comparisonCalls.length, 2);
  assert.equal(state.comparisonCalls[1].payload.jsAdjustments.rotation, 3);
  state.comparisonCalls[1].resolve(new Uint8Array([2]).buffer);
  await drain();
  assert.match(state.Editor.splitComparisonUrl, /^blob:/);
  URL.revokeObjectURL(state.Editor.splitComparisonUrl);
});
