import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-thumbnail-freshness-'));
after(() => rm(directory, { recursive: true, force: true }));

const stubs = {
  react: `export const useRef = value => ({current:value});
    export const useCallback = callback => callback;
    export const useMemo = factory => factory();
    export const useEffect = callback => {
      const cleanup = callback();
      if (cleanup) globalThis.__thumbnailTest.cleanups.push(cleanup);
    };`,
  '@tauri-apps/api/core':
    'export const invoke = (name, payload) => {globalThis.__thumbnailTest.invokes.push({name, payload}); return Promise.resolve();}; export const convertFileSrc = path => path;',
  '@tauri-apps/api/event':
    'export const listen = (name, callback) => {globalThis.__thumbnailTest.listeners.set(name, callback); return Promise.resolve(() => {});};',
  'lodash.debounce': `export default function debounce(callback) {
    const debounced = (...args) => callback(...args);
    debounced.cancel = () => {};
    debounced.flush = () => {};
    return debounced;
  }`,
  '../store/useProcessStore': `export const useProcessStore = Object.assign(
    selector => selector(globalThis.__thumbnailTest.process),
    {getState: () => globalThis.__thumbnailTest.process},
  );`,
  '../store/useLibraryStore': 'export const useLibraryStore = {getState: () => globalThis.__thumbnailTest.library};',
  '../store/useEditorStore': 'export const useEditorStore = {getState: () => globalThis.__thumbnailTest.editor};',
  '../store/useUIStore': 'export const useUIStore = {getState: () => globalThis.__thumbnailTest.ui};',
  '../components/ui/ExportImportProperties': 'export const Status = {};',
  '../components/ui/AppProperties': 'export const ImageFile = {};',
  '../utils/previewIntent': 'export const acceptMainPreviewAttempt = () => true;',
  '../utils/previewDiagnostics': 'export const tracePreview = () => {};',
};

const output = join(directory, 'thumbnail-boundaries.mjs');
await build({
  stdin: {
    contents: `export {useThumbnails} from './src/hooks/useThumbnails';
      export {useTauriListeners} from './src/hooks/useTauriListeners';`,
    resolveDir: process.cwd(),
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'thumbnail-boundaries',
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
const { useThumbnails, useTauriListeners } = await import(pathToFileURL(output));

function setup(t) {
  const physical = '/photos/bird.CR3';
  const copy = `${physical}?vc=1`;
  const unrelated = '/photos/bird.CR3.backup';
  const state = {
    invokes: [],
    listeners: new Map(),
    cleanups: [],
    library: {
      imageList: [{ path: physical }, { path: copy }, { path: unrelated }],
      imageRatings: {},
      setLibrary(update) {
        Object.assign(this, typeof update === 'function' ? update(this) : update);
      },
    },
    editor: { selectedImage: null, setEditor() {} },
    ui: { setUI() {} },
    process: {
      thumbnails: { [physical]: 'old-small', [copy]: 'old-copy-small', [unrelated]: 'other-small' },
      mediumThumbnails: { [physical]: 'old-medium', [copy]: 'old-copy-medium', [unrelated]: 'other-medium' },
      thumbnailSourceRevisions: { [physical]: 'source-old', [copy]: 'source-old', [unrelated]: 'other-source' },
      setProcess(update) {
        Object.assign(this, typeof update === 'function' ? update(this) : update);
      },
    },
  };
  globalThis.__thumbnailTest = state;
  t.after(() => {
    state.cleanups.forEach((cleanup) => cleanup());
    delete globalThis.__thumbnailTest;
  });
  return { state, hook: useThumbnails(), physical, copy, unrelated };
}

function requestedPaths(state) {
  return state.invokes.filter(({ name }) => name === 'update_thumbnail_queue').flatMap(({ payload }) => payload.paths);
}

test('source replacement clears physical and virtual thumbnails and permits fresh requests', (t) => {
  const { state, hook, physical, copy, unrelated } = setup(t);
  hook.markGenerated(physical);
  hook.markGenerated(copy);
  hook.requestThumbnails([physical, copy]);
  assert.deepEqual(requestedPaths(state), []);

  hook.invalidateSourceThumbnails(physical, 'source-new');
  assert.equal(state.process.thumbnails[physical], undefined);
  assert.equal(state.process.thumbnails[copy], undefined);
  assert.equal(state.process.mediumThumbnails[physical], undefined);
  assert.equal(state.process.mediumThumbnails[copy], undefined);
  assert.equal(state.process.thumbnailSourceRevisions[physical], undefined);
  assert.equal(state.process.thumbnailSourceRevisions[copy], undefined);
  assert.equal(state.process.thumbnails[unrelated], 'other-small');
  assert.equal(state.process.mediumThumbnails[unrelated], 'other-medium');
  assert.deepEqual(new Set(requestedPaths(state)), new Set([physical, copy]));

  state.invokes.length = 0;
  hook.requestThumbnails([physical, copy]);
  assert.deepEqual(new Set(requestedPaths(state)), new Set([physical, copy]));
  assert.equal(hook.shouldAcceptGenerated(physical, 'source-old'), false);
  assert.equal(hook.shouldAcceptGenerated(copy, 'source-old'), false);
  assert.equal(hook.shouldAcceptGenerated(physical, 'source-new'), true);
  assert.equal(hook.shouldAcceptGenerated(copy, 'source-new'), true);
});

test('deletion or failed source read rejects late thumbnails until a valid source revision is known', (t) => {
  const { state, hook, physical, copy } = setup(t);
  hook.invalidateSourceThumbnails(copy, null);

  assert.equal(state.process.thumbnails[physical], undefined);
  assert.equal(state.process.mediumThumbnails[copy], undefined);
  assert.equal(hook.shouldAcceptGenerated(physical, 'source-old'), false);
  assert.equal(hook.shouldAcceptGenerated(copy, 'source-new'), false);
  assert.equal(hook.shouldAcceptGenerated(copy, undefined), false);

  hook.invalidateSourceThumbnails(physical, 'source-restored');
  assert.equal(hook.shouldAcceptGenerated(copy, 'source-old'), false);
  assert.equal(hook.shouldAcceptGenerated(copy, 'source-restored'), true);
});

test('a changed source rejects unversioned events while unrelated paths keep their thumbnails', (t) => {
  const { state, hook, physical, unrelated } = setup(t);
  hook.invalidateSourceThumbnails(physical, 'source-new');

  assert.equal(hook.shouldAcceptGenerated(physical, undefined), false);
  assert.equal(state.process.thumbnails[unrelated], 'other-small');
  assert.equal(state.process.thumbnailSourceRevisions[unrelated], 'other-source');
});

test('a buffered old thumbnail cannot return after source invalidation', (t) => {
  const { state, hook, physical } = setup(t);
  const frames = new Map();
  let nextFrame = 0;
  const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
  const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => {
    globalThis.requestAnimationFrame = oldRequestAnimationFrame;
    globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
  });

  useTauriListeners({
    refreshAllFolderTrees() {},
    handleSelectSubfolder() {},
    refreshImageList() {},
    markGenerated: hook.markGenerated,
    shouldAcceptGenerated: hook.shouldAcceptGenerated,
    retryStaleGenerated: hook.retryStaleGenerated,
  });
  const emit = (sourceRevision, thumbnailPath) =>
    state.listeners.get('thumbnail-generated')({
      payload: { path: physical, thumbnailPath, previewPath: `${thumbnailPath}-medium`, sourceRevision },
    });
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };

  emit('source-old', 'late-old-small');
  assert.equal(frames.size, 1);
  hook.invalidateSourceThumbnails(physical, 'source-new');
  flushFrames();
  assert.equal(state.process.thumbnails[physical], undefined);
  assert.equal(state.process.mediumThumbnails[physical], undefined);

  emit('source-old', 'later-old-small');
  assert.equal(frames.size, 0);
  emit('source-new', 'fresh-small');
  flushFrames();
  assert.equal(state.process.thumbnails[physical], 'fresh-small');
  assert.equal(state.process.mediumThumbnails[physical], 'fresh-small-medium');
  assert.equal(state.process.thumbnailSourceRevisions[physical], 'source-new');
});
