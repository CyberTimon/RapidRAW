import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-navigation-cache-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: 'export const useCallback = fn => fn;',
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__navigation.invoke(...args);',
  '@tauri-apps/plugin-dialog': 'export const open = () => null;',
  '@tauri-apps/api/path': 'export const homeDir = () => "/";',
  'react-toastify': 'export const toast = {error() {}};',
  '../store/useLibraryStore': 'export const useLibraryStore = {getState: () => globalThis.__navigation.library};',
  '../store/useEditorStore': 'export const useEditorStore = {getState: () => globalThis.__navigation.editor};',
  '../store/useUIStore': 'export const useUIStore = {getState: () => globalThis.__navigation.ui};',
  '../store/useProcessStore': 'export const useProcessStore = {getState: () => globalThis.__navigation.process};',
  '../store/useSettingsStore': 'export const useSettingsStore = {getState: () => globalThis.__navigation.settings};',
  '../components/ui/AppProperties':
    'export const Invokes = {GetSourceRevision:"get_source_revision"}; export const LibraryViewMode = {};',
  '../utils/adjustments': 'export const INITIAL_ADJUSTMENTS = {exposure:0};',
  './useEditorActions':
    'export const debouncedSave = Object.assign(() => {}, {flush: () => {}, cancel: () => {}}); export const debouncedSetHistory = {cancel: () => {}};',
};
const output = join(directory, 'navigation.mjs');
await build({
  stdin: {
    contents: `export {useAppNavigation} from './src/hooks/useAppNavigation';
      export {globalImageCache} from './src/utils/ImageLRUCache';`,
    resolveDir: process.cwd(),
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'navigation-boundaries',
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
const { useAppNavigation, globalImageCache } = await import(pathToFileURL(output));

function environment(t) {
  globalImageCache.clear();
  const state = {
    calls: [],
    editor: {
      selectedImage: null,
      imageSession: 0,
      adjustments: { exposure: 0 },
      patchesSentToBackend: new Set(),
      finalPreviewUrl: null,
      interactivePatch: null,
    },
    library: {
      imageList: [],
      multiSelectedPaths: [],
    },
    ui: { activeView: 'library' },
    process: { thumbnails: {}, mediumThumbnails: {}, thumbnailSourceRevisions: {} },
    thumbnailInvalidations: [],
    settings: { appSettings: {} },
    invoke(command, payload) {
      return new Promise((resolve, reject) => state.calls.push({ command, payload, resolve, reject }));
    },
  };
  state.editor.setEditor = (update) => {
    const next = typeof update === 'function' ? update(state.editor) : update;
    if ('selectedImage' in next && next.selectedImage?.path !== state.editor.selectedImage?.path) {
      state.editor.imageSession++;
      state.editor.finalPreviewUrl = null;
    }
    Object.assign(state.editor, next);
  };
  state.editor.resetHistory = (adjustments) => {
    state.editor.history = [adjustments];
  };
  state.library.setLibrary = (update) =>
    Object.assign(state.library, typeof update === 'function' ? update(state.library) : update);
  state.ui.setUI = (update) => Object.assign(state.ui, update);
  const refs = {
    transformWrapperRef: { current: null },
    preloadedDataRef: { current: null },
    cachedEditStateRef: { current: null },
    selectedImagePathRef: { current: null },
    latestRenderedJobIdRef: { current: 0 },
    previewJobIdRef: { current: 0 },
    currentResRef: { current: 0 },
    prevAdjustmentsRef: { current: null },
  };
  globalThis.__navigation = state;
  state.navigation = useAppNavigation({
    clearThumbnailQueue() {},
    invalidateSourceThumbnails(path, sourceRevision) {
      state.thumbnailInvalidations.push({ path, sourceRevision });
      const source = path.split('?vc=')[0];
      for (const key of Object.keys(state.process.thumbnails)) {
        if (key === source || key.startsWith(`${source}?vc=`)) delete state.process.thumbnails[key];
      }
      for (const key of Object.keys(state.process.mediumThumbnails)) {
        if (key === source || key.startsWith(`${source}?vc=`)) delete state.process.mediumThumbnails[key];
      }
    },
    needsSourceThumbnailRefresh(path, sourceRevision) {
      return (
        !!(state.process.thumbnails[path] || state.process.mediumThumbnails[path]) &&
        state.process.thumbnailSourceRevisions[path] !== sourceRevision
      );
    },
    refs,
  });
  t.after(() => {
    globalImageCache.clear();
    delete globalThis.__navigation;
  });
  return state;
}

function snapshot(path, sourceRevision = 'source-old') {
  return {
    adjustments: { exposure: 2.5 },
    histogram: { bins: [1, 2] },
    waveform: null,
    finalPreviewUrl: `${path}-cached-pixels`,
    uncroppedPreviewUrl: null,
    selectedImage: { path, isReady: true, thumbnailUrl: `${path}-thumbnail`, width: 6000, height: 4000 },
    originalSize: { width: 6000, height: 4000 },
    previewSize: { width: 1920, height: 1280 },
    sourceRevision,
  };
}

test('cached pixels appear only after a matching physical source revision', async (t) => {
  const state = environment(t);
  globalImageCache.set('/photo', snapshot('/photo'));
  state.process.mediumThumbnails['/photo'] = 'stale-medium-thumbnail';
  const selecting = state.navigation.handleImageSelect('/photo');
  assert.equal(state.editor.selectedImage.path, '/photo');
  assert.equal(state.editor.finalPreviewUrl, null);
  assert.equal(state.editor.selectedImage.thumbnailUrl, '');
  assert.equal(state.editor.adjustments.exposure, 2.5);
  assert.equal(state.calls[0].command, 'get_source_revision');
  state.calls[0].resolve('source-old');
  await selecting;
  assert.equal(state.editor.finalPreviewUrl, '/photo-cached-pixels');
  assert.equal(state.editor.selectedImage.thumbnailUrl, '/photo-thumbnail');
  assert.equal(state.editor.selectedImage.isReady, false);
  assert.equal(state.editor.selectedImage.preserveCachedAdjustments, true);
});

test('changed or deleted physical sources drop all virtual-copy pixels but keep the selected recipe', async (t) => {
  const state = environment(t);
  globalImageCache.set('/photo', snapshot('/photo'));
  globalImageCache.set('/photo?vc=1', snapshot('/photo?vc=1'));
  const selecting = state.navigation.handleImageSelect('/photo?vc=1');
  state.calls[0].resolve('source-new');
  await selecting;
  assert.equal(state.editor.finalPreviewUrl, null);
  assert.equal(state.editor.adjustments.exposure, 2.5);
  assert.equal(globalImageCache.peek('/photo'), undefined);
  assert.equal(globalImageCache.peek('/photo?vc=1'), undefined);

  globalImageCache.set('/missing', snapshot('/missing'));
  const missing = state.navigation.handleImageSelect('/missing');
  state.calls[1].reject(new Error('source deleted'));
  await missing;
  assert.equal(state.editor.finalPreviewUrl, null);
  assert.equal(state.editor.adjustments.exposure, 2.5);
  assert.equal(globalImageCache.peek('/missing'), undefined);
});

test('late preflight cannot restore an older A after navigation to B and back to A', async (t) => {
  const state = environment(t);
  globalImageCache.set('/a', snapshot('/a'));
  const oldA = state.navigation.handleImageSelect('/a');
  await state.navigation.handleImageSelect('/b');
  const newA = state.navigation.handleImageSelect('/a');
  state.calls[0].resolve('source-old');
  await oldA;
  assert.equal(state.editor.finalPreviewUrl, null);
  state.calls[1].resolve('source-old');
  await newA;
  assert.equal(state.editor.finalPreviewUrl, '/a-cached-pixels');
});

test('late preflight cannot rewind thumbnails after native load confirms a newer source', async (t) => {
  const state = environment(t);
  globalImageCache.set('/photo', snapshot('/photo', 'source-old'));
  state.process.thumbnails['/photo'] = 'old-thumbnail';
  const selecting = state.navigation.handleImageSelect('/photo');
  assert.equal(state.calls[0].command, 'get_source_revision');

  // load_image completes while the preflight IPC response is still pending.
  globalImageCache.deleteByPrefix('/photo');
  state.editor.setEditor({
    selectedImage: { ...state.editor.selectedImage, isReady: true, sourceRevision: 'source-new' },
    finalPreviewUrl: 'new-source-pixels',
  });
  state.process.thumbnails['/photo'] = 'new-thumbnail';
  state.process.thumbnailSourceRevisions['/photo'] = 'source-new';
  state.thumbnailInvalidations.push({ path: '/photo', sourceRevision: 'source-new' });

  state.calls[0].resolve('source-old');
  await selecting;
  assert.deepEqual(state.thumbnailInvalidations, [{ path: '/photo', sourceRevision: 'source-new' }]);
  assert.equal(state.process.thumbnails['/photo'], 'new-thumbnail');
  assert.equal(state.editor.finalPreviewUrl, 'new-source-pixels');
  assert.equal(state.editor.selectedImage.sourceRevision, 'source-new');
});

test('reopening the same path creates a fresh session and keeps unsaved edits on source replacement', async (t) => {
  const state = environment(t);
  globalImageCache.set('/photo', snapshot('/photo'));
  const unsaved = { exposure: 4 };
  state.editor.selectedImage = { path: '/photo', isReady: true, sourceRevision: 'source-old' };
  state.editor.adjustments = unsaved;
  state.editor.finalPreviewUrl = '/photo-cached-pixels';
  state.editor.history = [{ exposure: 0 }, unsaved];
  const initialSession = state.editor.imageSession;

  const reopening = state.navigation.handleImageSelect('/photo');
  assert.ok(state.editor.imageSession > initialSession);
  assert.equal(state.editor.selectedImage.isReady, false);
  assert.equal(state.editor.selectedImage.thumbnailUrl, '');
  assert.equal(state.editor.finalPreviewUrl, null);
  assert.equal(state.editor.adjustments, unsaved);
  assert.equal(state.editor.history.length, 2);
  assert.equal(state.calls[0].command, 'get_source_revision');

  state.calls[0].resolve('source-new');
  await reopening;
  assert.equal(globalImageCache.peek('/photo'), undefined);
  assert.equal(state.editor.adjustments, unsaved);
  assert.equal(state.editor.history.length, 2);
  assert.equal(state.editor.selectedImage.cachedSourceRevision, 'source-old');
});

test('a path-keyed thumbnail is not displayed before source freshness is known', async (t) => {
  const state = environment(t);
  state.process.mediumThumbnails['/photo'] = 'stale-thumbnail';
  const selecting = state.navigation.handleImageSelect('/photo');
  assert.equal(state.editor.selectedImage.thumbnailUrl, '');
  assert.equal(state.editor.finalPreviewUrl, null);
  state.calls[0].resolve('source-new');
  await selecting;
  assert.deepEqual(state.thumbnailInvalidations, [{ path: '/photo', sourceRevision: 'source-new' }]);
  assert.equal(state.editor.selectedImage.thumbnailUrl, '');
});

test('an uncached photo reveals its medium thumbnail only after matching source verification', async (t) => {
  const state = environment(t);
  state.process.mediumThumbnails['/photo?vc=1'] = 'verified-medium-thumbnail';
  state.process.thumbnailSourceRevisions['/photo?vc=1'] = 'source-current';

  const selecting = state.navigation.handleImageSelect('/photo?vc=1');
  assert.equal(state.editor.selectedImage.thumbnailUrl, '');
  state.calls[0].resolve('source-current');
  await selecting;

  assert.equal(state.editor.selectedImage.thumbnailUrl, 'verified-medium-thumbnail');
  assert.equal(state.editor.selectedImage.cachedSourceRevision, 'source-current');
  assert.equal(state.editor.selectedImage.isReady, false);
  assert.equal(state.library.isViewLoading, true);
  assert.deepEqual(state.thumbnailInvalidations, []);
});
