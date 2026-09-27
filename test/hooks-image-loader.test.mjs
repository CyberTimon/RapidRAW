import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-loader-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: 'export const useEffect = (fn,deps) => globalThis.__loader.effect(fn,deps);',
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.__loader.invoke(...args);',
  'react-toastify': 'export const toast={error:()=>{}};',
  '../store/useEditorStore':
    'export const useEditorStore=selector=>selector(globalThis.__loader.editor); useEditorStore.getState=()=>globalThis.__loader.editor;',
  '../store/useLibraryStore': 'export const useLibraryStore=selector=>selector(globalThis.__loader.library);',
  '../store/useUIStore': 'export const useUIStore=selector=>selector(globalThis.__loader.ui);',
  '../store/useSettingsStore':
    'export const useSettingsStore=selector=>selector({appSettings:{editorPreviewResolution:1920}});',
  '../components/ui/AppProperties': 'export const Invokes={LoadImage:"load_image",LoadMetadata:"load_metadata"};',
  '../components/panel/right/Masks': 'export const SubMaskMode={Additive:"additive"};',
};
const output = join(directory, 'loader.mjs');
await build({
  entryPoints: ['src/hooks/useImageLoader.ts'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'loader-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
      },
    },
  ],
});
const { useImageLoader } = await import(pathToFileURL(output));
const drain = () => new Promise((resolve) => setImmediate(resolve));
function environment(t) {
  let index = 0;
  const slots = [];
  const state = {
    calls: [],
    editor: {
      selectedImage: { path: 'a', isReady: false },
      imageSession: 1,
      backendGeneration: null,
      adjustments: { exposure: 0 },
      patchesSentToBackend: new Set(),
    },
    library: {},
    ui: { activeView: 'editor' },
    thumbnailInvalidations: [],
    thumbnailNeedsRefresh: false,
    invalidateSourceThumbnails(path, sourceRevision) {
      state.thumbnailInvalidations.push({ path, sourceRevision });
    },
    needsSourceThumbnailRefresh() {
      return state.thumbnailNeedsRefresh;
    },
    effect(fn, deps) {
      const i = index++;
      if (!slots[i] || deps.some((d, j) => d !== slots[i].deps[j])) {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      }
    },
    invoke(command, payload) {
      return new Promise((resolve, reject) => state.calls.push({ command, payload, resolve, reject }));
    },
    render() {
      index = 0;
      useImageLoader({ current: null }, state.invalidateSourceThumbnails, state.needsSourceThumbnailRefresh);
    },
  };
  state.editor.setEditor = (update) =>
    Object.assign(state.editor, typeof update === 'function' ? update(state.editor) : update);
  state.editor.resetHistory = (adjustments) => {
    state.editor.history = [adjustments];
  };
  state.library.setLibrary = (update) => Object.assign(state.library, update);
  globalThis.__loader = state;
  t.after(() => slots.forEach((slot) => slot.cleanup?.()));
  return state;
}
const loaded = (generation, sourceRevision = 'source-old') => ({
  generation,
  source_revision: sourceRevision,
  width: 6000,
  height: 4000,
  is_raw: false,
  exif: {},
  metadata: {},
});

test('a cached visual remains unready until the native source is loaded, then publishes its generation', async (t) => {
  const state = environment(t);
  state.editor.finalPreviewUrl = 'cached-a';
  state.render();
  assert.equal(state.calls[0].command, 'load_metadata');
  state.calls[0].resolve({ adjustments: { exposure: 1 } });
  await drain();
  assert.equal(state.calls[1].command, 'load_image');
  assert.equal(state.editor.selectedImage.isReady, false);
  assert.equal(state.editor.finalPreviewUrl, 'cached-a');
  state.calls[1].resolve(loaded(12));
  await drain();
  assert.equal(state.editor.selectedImage.isReady, true);
  assert.equal(state.editor.backendGeneration, 12);
  assert.equal(state.editor.adjustments.exposure, 1);
});

test('old metadata and old source completion cannot mutate a new photo even before effect cleanup', async (t) => {
  const state = environment(t);
  state.render();
  state.editor.selectedImage = { path: 'b', isReady: false };
  state.editor.imageSession++;
  state.calls[0].resolve({ adjustments: { exposure: 4 } });
  await drain();
  assert.equal(state.editor.adjustments.exposure, 0);
  assert.equal(state.calls.length, 1);
  state.render();
  state.calls[1].resolve({ adjustments: { exposure: 2 } });
  await drain();
  state.editor.selectedImage = { path: 'a', isReady: false };
  state.editor.imageSession++;
  state.calls[2].resolve(loaded(13));
  await drain();
  assert.equal(state.editor.selectedImage.isReady, false);
  assert.equal(state.editor.backendGeneration, null);
});

test('same-path selection starts a new load when the image session changes before readiness', async (t) => {
  const state = environment(t);
  state.render();
  state.calls[0].resolve({});
  await drain();
  assert.equal(state.calls[1].command, 'load_image');

  // A library selection followed by an editor double-click can replace the
  // unready image in the same React batch. Path and readiness remain equal.
  state.editor.imageSession += 2;
  state.render();
  assert.equal(state.calls[2].command, 'load_metadata');

  state.calls[1].resolve(loaded(11));
  await drain();
  assert.equal(state.editor.selectedImage.isReady, false);
  assert.equal(state.editor.backendGeneration, null);

  state.calls[2].resolve({});
  await drain();
  assert.equal(state.calls[3].command, 'load_image');
  state.calls[3].resolve(loaded(12));
  await drain();
  assert.equal(state.editor.selectedImage.isReady, true);
  assert.equal(state.editor.backendGeneration, 12);
});

test('edits made while metadata is loading survive its completion', async (t) => {
  const state = environment(t);
  state.render();
  state.editor.adjustments = { exposure: 3 };
  state.calls[0].resolve({ adjustments: { exposure: 1 } });
  await drain();
  assert.equal(state.editor.adjustments.exposure, 3);
  state.calls[1].resolve(loaded(14));
  await drain();
  assert.equal(state.editor.adjustments.exposure, 3);
});

test('a failed current load clears loading state before deselecting the photo', async (t) => {
  const state = environment(t);
  state.library.isViewLoading = true;
  state.render();
  state.calls[0].resolve({});
  await drain();
  const error = console.error;
  console.error = () => {};
  try {
    state.calls[1].reject(new Error('decode failed'));
    await drain();
  } finally {
    console.error = error;
  }
  assert.equal(state.editor.selectedImage, null);
  assert.equal(state.library.isViewLoading, false);
});

test('a source replaced after cache preflight clears old pixels but preserves the in-memory recipe', async (t) => {
  const state = environment(t);
  state.editor.selectedImage = {
    path: 'a?vc=1',
    isReady: false,
    preserveCachedAdjustments: true,
    cachedSourceRevision: 'source-old',
  };
  state.editor.adjustments = { exposure: 3 };
  state.editor.finalPreviewUrl = 'old-source-pixels';
  state.editor.histogram = { bins: [1] };
  state.render();
  state.calls[0].resolve({ adjustments: { exposure: 1 } });
  await drain();
  assert.equal(state.editor.adjustments.exposure, 3);
  state.calls[1].resolve(loaded(15, 'source-new'));
  await drain();
  assert.equal(state.editor.finalPreviewUrl, null);
  assert.equal(state.editor.histogram, null);
  assert.equal(state.editor.adjustments.exposure, 3);
  assert.equal(state.editor.selectedImage.sourceRevision, 'source-new');
  assert.equal(state.editor.selectedImage.isReady, true);
  assert.deepEqual(state.thumbnailInvalidations, [{ path: 'a?vc=1', sourceRevision: 'source-new' }]);
});

test('a stale thumbnail revision triggers regeneration even without an editor snapshot', async (t) => {
  const state = environment(t);
  state.thumbnailNeedsRefresh = true;
  state.render();
  state.calls[0].resolve({});
  await drain();
  state.calls[1].resolve(loaded(17, 'source-new'));
  await drain();
  assert.deepEqual(state.thumbnailInvalidations, [{ path: 'a', sourceRevision: 'source-new' }]);
});

test('a source replaced after thumbnail preflight cannot keep the verified old thumbnail', async (t) => {
  const state = environment(t);
  state.render();
  state.calls[0].resolve({});
  await drain();
  assert.equal(state.calls[1].command, 'load_image');

  // Preflight completes after the load effect captured its initial placeholder.
  state.editor.selectedImage = {
    ...state.editor.selectedImage,
    thumbnailUrl: 'verified-old-thumbnail',
    cachedSourceRevision: 'source-old',
  };
  state.calls[1].resolve(loaded(18, 'source-new'));
  await drain();

  assert.equal(state.editor.selectedImage.isReady, true);
  assert.equal(state.editor.selectedImage.thumbnailUrl, '');
  assert.equal(state.editor.selectedImage.sourceRevision, 'source-new');
  assert.deepEqual(state.thumbnailInvalidations, [{ path: 'a', sourceRevision: 'source-new' }]);
});

test('a sidecar-only metadata change does not replace the cached in-memory recipe', async (t) => {
  const state = environment(t);
  state.editor.selectedImage = {
    path: 'a',
    isReady: false,
    preserveCachedAdjustments: true,
    cachedSourceRevision: 'source-old',
  };
  state.editor.adjustments = { exposure: 3 };
  state.editor.finalPreviewUrl = 'cached-pixels';
  state.render();
  state.calls[0].resolve({ adjustments: { exposure: 1 } });
  await drain();
  state.calls[1].resolve(loaded(16, 'source-old'));
  await drain();
  assert.equal(state.editor.adjustments.exposure, 3);
  assert.equal(state.editor.finalPreviewUrl, 'cached-pixels');
  assert.equal(state.editor.selectedImage.sourceRevision, 'source-old');
});
