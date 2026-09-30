import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-preview-listeners-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: `export const useRef = value => ({current:value});
    export const useEffect = fn => {const cleanup=fn(); if (cleanup) globalThis.__listenerTest.cleanups.push(cleanup);};`,
  '@tauri-apps/api/event':
    'export const listen = (name, callback) => {globalThis.__listenerTest.listeners.set(name, callback); return Promise.resolve(() => {});};',
  '@tauri-apps/api/core':
    'export const invoke = (name, payload) => {globalThis.__listenerTest.invokes.push({name,payload}); return Promise.resolve();}; export const convertFileSrc = value => value;',
  '../components/ui/ExportImportProperties': 'export const Status = {};',
  '../components/ui/AppProperties': 'export const ImageFile = {};',
};
for (const name of ['Process', 'Editor', 'UI', 'Library']) {
  stubs[`../store/use${name}Store`] =
    `export const use${name}Store = {getState: () => globalThis.__listenerTest.${name}};`;
}
const output = join(directory, 'listeners.mjs');
await build({
  stdin: {
    contents: `export {useTauriListeners} from './src/hooks/useTauriListeners';
      export {reservePreviewRevision} from './src/utils/previewIntent';`,
    resolveDir: process.cwd(),
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'listener-boundaries',
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
const { useTauriListeners, reservePreviewRevision } = await import(pathToFileURL(output));

test('WGPU and analytics events require current source, revision and newest accepted attempt', async () => {
  const state = {
    listeners: new Map(),
    invokes: [],
    cleanups: [],
    Editor: {
      selectedImage: { path: 'photo-a' },
      backendGeneration: 3,
      imageSession: 1,
      hasRenderedFirstFrame: false,
      histogram: null,
      waveform: null,
      setEditor(update) {
        Object.assign(this, update);
      },
    },
    Process: {},
    UI: {},
    Library: {},
  };
  globalThis.__listenerTest = state;
  useTauriListeners({
    refreshAllFolderTrees() {},
    handleSelectSubfolder() {},
    refreshImageList() {},
    markGenerated() {},
  });
  const emit = (name, payload) => state.listeners.get(name)({ payload });
  const revision = reservePreviewRevision('main', 3);
  const frame = { path: 'photo-a', generation: 3, inputRevision: revision, renderAttempt: 1, qualityTier: 'quick' };
  reservePreviewRevision('overlay', 3);
  reservePreviewRevision('uncropped', 3);
  emit('wgpu-frame-ready', frame);
  assert.equal(state.Editor.hasRenderedFirstFrame, true);
  emit('analytics-update', { ...frame, histogram: 'quick-histogram' });
  assert.equal(state.Editor.histogram, 'quick-histogram');
  emit('analytics-update', { ...frame, renderAttempt: 2, qualityTier: 'detail', histogram: 'detail-histogram' });
  emit('analytics-update', { ...frame, histogram: 'late-quick-histogram' });
  assert.equal(state.Editor.histogram, 'detail-histogram');

  state.Editor.hasRenderedFirstFrame = false;
  const nextRevision = reservePreviewRevision('main', 3);
  emit('wgpu-frame-ready', frame);
  assert.equal(state.Editor.hasRenderedFirstFrame, false);
  emit('wgpu-frame-ready', { ...frame, inputRevision: nextRevision, generation: 2 });
  assert.equal(state.Editor.hasRenderedFirstFrame, false);
  emit('wgpu-frame-ready', { ...frame, inputRevision: nextRevision, renderAttempt: undefined });
  assert.equal(state.Editor.hasRenderedFirstFrame, false);
  emit('wgpu-frame-ready', { ...frame, inputRevision: nextRevision });
  assert.equal(state.Editor.hasRenderedFirstFrame, true);

  state.cleanups.forEach((cleanup) => cleanup());
  await Promise.resolve();
  state.Editor.hasRenderedFirstFrame = false;
  emit('wgpu-frame-ready', { ...frame, inputRevision: nextRevision });
  assert.equal(state.Editor.hasRenderedFirstFrame, false);
  delete globalThis.__listenerTest;
});
