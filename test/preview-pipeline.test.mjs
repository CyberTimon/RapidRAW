import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-preview-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'preview.mjs');
await build({
  entryPoints: ['src/utils/previewPipeline.ts'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
});
const {
  PreviewPipeline,
  PreviewRefinementScheduler,
  preparePreviewAdjustments,
  interactivePreviewResolution,
  previewMissingAssetKeys,
  retryMissingPreviewAssets,
  withClippingOverlay,
} = await import(pathToFileURL(output));
const drain = () => new Promise((resolve) => setImmediate(resolve));

function renderer() {
  const started = [];
  const completions = [];
  const pipeline = new PreviewPipeline((request) => {
    started.push(request);
    return new Promise((resolve, reject) => completions.push({ resolve, reject }));
  });
  return { pipeline, started, completions };
}

test('a slow renderer skips intermediate slider positions and renders the exact release value at full quality', async () => {
  const { pipeline, started, completions } = renderer();
  pipeline.enqueue({ exposure: 0.1, interactive: true });
  await drain();
  for (let i = 2; i <= 100; i++) pipeline.enqueue({ exposure: i / 100, interactive: true });
  pipeline.enqueue({ exposure: 1, interactive: false });
  assert.deepEqual(started, [{ exposure: 0.1, interactive: true }]);
  completions[0].resolve();
  await drain();
  assert.deepEqual(started, [
    { exposure: 0.1, interactive: true },
    { exposure: 1, interactive: false },
  ]);
  completions[1].resolve();
  await drain();
});

test('resuming a drag replaces an obsolete queued final render without waiting for another animation frame', async () => {
  const { pipeline, started, completions } = renderer();
  pipeline.enqueue('running');
  await drain();
  pipeline.enqueue('old release');
  pipeline.enqueue('new slider position');
  completions[0].resolve();
  await drain();
  assert.deepEqual(started, ['running', 'new slider position']);
  completions[1].resolve();
  await drain();
});

test('photo changes clear pending work and renderer failures do not leave the next photo stuck', async () => {
  const { pipeline, started, completions } = renderer();
  pipeline.enqueue('old photo running');
  await drain();
  pipeline.enqueue('old photo pending');
  pipeline.clear();
  pipeline.enqueue('new photo');
  completions[0].reject(new Error('old render failed'));
  await drain();
  assert.deepEqual(started, ['old photo running', 'new photo']);
  completions[1].resolve();
  await drain();
  pipeline.enqueue('later edit');
  await drain();
  assert.equal(started.at(-1), 'later edit');
  completions[2].resolve();
  await drain();
});

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('unmounting before dispatch cancels a reserved request without calling the renderer', async () => {
  const { pipeline, started } = renderer();
  pipeline.enqueue('photo being closed');
  pipeline.clear();
  await drain();
  assert.deepEqual(started, []);
});

test('refinement waits for quiet time and matching quick completion without occupying the render queue', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refined = [];
  const scheduler = new PreviewRefinementScheduler(150, (request) => refined.push(request));
  const first = { exposure: 1 };
  scheduler.schedule(first, false);
  t.mock.timers.tick(150);
  assert.deepEqual(refined, []);
  const second = { exposure: 2 };
  scheduler.schedule(second, false);
  scheduler.quickCompleted(first);
  t.mock.timers.tick(149);
  scheduler.quickCompleted(second);
  assert.deepEqual(refined, []);
  t.mock.timers.tick(1);
  assert.deepEqual(refined, [second]);
  scheduler.schedule({ exposure: 3 }, true);
  scheduler.clear();
  t.mock.timers.tick(150);
  assert.deepEqual(refined, [second]);
});

test('preview payloads omit only acknowledged assets and preserve frozen recipes, strokes and repair provenance', () => {
  const strokes = [{ points: [{ x: 1, y: 2 }], size: 12 }];
  const subMasks = [
    { id: 'cached-mask', parameters: { mask_data_base64: 'large snake bitmap', lines: strokes } },
    { id: 'new-mask', parameters: { maskDataBase64: 'new camel bitmap' } },
  ];
  const patchData = { color: 'large repair', mask: 'large mask', generation: { seed: 123 } };
  const adjustments = freeze({
    exposure: 1.25,
    masks: [{ id: 'mask-container', opacity: 80, subMasks }],
    aiPatches: [
      { id: 'cached-patch', patchData, subMasks },
      { id: 'new-patch', patchData, subMasks: [] },
      { id: 'loading-patch', patchData, isLoading: true, subMasks: [] },
    ],
  });
  const first = preparePreviewAdjustments(adjustments, new Set()).payload;
  const maskKey = first.masks[0].subMasks[0].previewAssetKey;
  const patchKey = first.aiPatches[0].previewAssetKey;
  const cached = new Set([maskKey, patchKey]);
  const { payload, sentAssets } = preparePreviewAdjustments(adjustments, cached);
  assert.equal(payload.masks[0].subMasks[0].parameters.mask_data_base64, null);
  assert.deepEqual(payload.masks[0].subMasks[0].previewAssetFields, ['mask_data_base64']);
  assert.equal(payload.masks[0].subMasks[1].parameters.maskDataBase64, 'new camel bitmap');
  assert.deepEqual(payload.masks[0].subMasks[1].previewAssetFields, []);
  assert.equal(payload.aiPatches[0].patchData, null);
  assert.deepEqual(payload.aiPatches[0].previewAssetFields, ['patchData']);
  assert.equal(payload.aiPatches[1].patchData, patchData);
  assert.equal(payload.aiPatches[2].patchData, patchData);
  assert.equal(payload.masks[0].subMasks[0].parameters.lines, strokes);
  assert.equal(adjustments.masks[0].subMasks[0].parameters.mask_data_base64, 'large snake bitmap');
  assert.equal(adjustments.aiPatches[0].patchData, patchData);
  assert.deepEqual(
    [...sentAssets].sort(),
    [first.masks[0].subMasks[1].previewAssetKey, first.aiPatches[1].previewAssetKey].sort(),
  );
  assert.deepEqual([...cached], [maskKey, patchKey]);
});

test('drag previews bound zoom cost while preserving smaller images and the Full quality choice', () => {
  assert.equal(interactivePreviewResolution(5120, 'high'), 1920);
  assert.equal(interactivePreviewResolution(5120, 'performance'), 1920);
  assert.equal(interactivePreviewResolution(5120), 1920);
  assert.equal(interactivePreviewResolution(960, 'high'), 960);
  assert.equal(interactivePreviewResolution(5120, 'full'), 5120);
});

test('replacing pixels under the same mask or patch ID sends a new revision and preserves the old revision for undo', () => {
  const before = {
    masks: [{ subMasks: [{ id: 'same', parameters: { maskDataBase64: 'AAAA' } }] }],
    aiPatches: [{ id: 'same', patchData: { color: 'CCCC', mask: 'MMMM' }, subMasks: [] }],
  };
  const first = preparePreviewAdjustments(before, new Set());
  const acknowledged = first.sentAssets;
  const after = {
    masks: [{ subMasks: [{ id: 'same', parameters: { maskDataBase64: 'BBBB' } }] }],
    aiPatches: [{ id: 'same', patchData: { color: 'DDDD', mask: 'MMMM' }, subMasks: [] }],
  };
  const changed = preparePreviewAdjustments(after, acknowledged);
  assert.equal(changed.payload.masks[0].subMasks[0].parameters.maskDataBase64, 'BBBB');
  assert.equal(changed.payload.aiPatches[0].patchData.color, 'DDDD');
  assert.notEqual(
    changed.payload.masks[0].subMasks[0].previewAssetKey,
    first.payload.masks[0].subMasks[0].previewAssetKey,
  );
  const undo = preparePreviewAdjustments(before, new Set([...acknowledged, ...changed.sentAssets]));
  assert.equal(undo.payload.masks[0].subMasks[0].parameters.maskDataBase64, null);
  assert.equal(undo.payload.aiPatches[0].patchData, null);
});

test('changing selection parameters keeps the same pixel revision without growing the native asset cache', () => {
  const recipe = { masks: [{ subMasks: [{ id: 'depth', parameters: { maskDataBase64: 'UNCHANGED', near: 0.2 } }] }] };
  const initial = preparePreviewAdjustments(recipe, new Set());
  const edited = { masks: [{ subMasks: [{ id: 'depth', parameters: { maskDataBase64: 'UNCHANGED', near: 0.7 } }] }] };
  const next = preparePreviewAdjustments(edited, initial.sentAssets);
  assert.equal(next.payload.masks[0].subMasks[0].parameters.maskDataBase64, null);
  assert.equal(next.payload.masks[0].subMasks[0].parameters.near, 0.7);
  assert.equal(next.sentAssets.size, 0);
});

test('intentional null bitmap fields are not marked as stripped cache references', () => {
  const recipe = {
    masks: [{ subMasks: [{ id: 'radial', parameters: { maskDataBase64: null, radius: 0.5 } }] }],
    aiPatches: [{ id: 'loading', patchData: null, isLoading: true, subMasks: [] }],
  };
  const prepared = preparePreviewAdjustments(recipe, new Set());
  assert.deepEqual(prepared.payload.masks[0].subMasks[0].previewAssetFields, []);
  assert.deepEqual(prepared.payload.aiPatches[0].previewAssetFields, []);
  assert.equal(prepared.sentAssets.size, 0);
});

test('an evicted acknowledged asset is resent once from the still-current recipe', async () => {
  const error = 'PREVIEW_ASSET_MISSING:{"cacheEpoch":4,"missingKeys":["mask:old"]}';
  assert.deepEqual(previewMissingAssetKeys(error), ['mask:old']);
  const sends = [];
  const forgotten = [];
  const result = await retryMissingPreviewAssets(
    async (forceInline) => {
      sends.push(forceInline);
      if (!forceInline) throw error;
      return 'current frame';
    },
    () => true,
    (keys) => forgotten.push(...keys),
  );
  assert.equal(result, 'current frame');
  assert.deepEqual(sends, [false, true]);
  assert.deepEqual(forgotten, ['mask:old']);
});

test('eviction retry is bounded and stale work never resends pixels', async () => {
  const error = 'PREVIEW_ASSET_MISSING:{"cacheEpoch":5,"missingKeys":["patch:old"]}';
  let attempts = 0;
  await assert.rejects(
    retryMissingPreviewAssets(
      async () => {
        attempts++;
        throw error;
      },
      () => true,
      () => {},
    ),
    (actual) => actual === error,
  );
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(
    retryMissingPreviewAssets(
      async () => {
        attempts++;
        throw error;
      },
      () => false,
      () => assert.fail('stale request must not mutate acknowledgement state'),
    ),
    (actual) => actual === error,
  );
  assert.equal(attempts, 1);
});

test('clipping overlay is added to preview input without changing the edit', () => {
  const edit = { exposure: 1 };
  assert.equal(withClippingOverlay(edit, false), edit);
  const shown = withClippingOverlay(edit, true);
  assert.deepEqual(shown, { exposure: 1, showClipping: true });
  assert.equal(edit.showClipping, undefined);
  // Stable identity lets unchanged input skip a re-render.
  assert.equal(withClippingOverlay(edit, true), shown);

  // A stray saved flag cannot enable the overlay while it is switched off.
  const legacy = { exposure: 1, showClipping: true };
  assert.equal(withClippingOverlay(legacy, true), legacy);
  assert.equal(withClippingOverlay(legacy, false).showClipping, false);
});
