import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const result = await build({
  stdin: {
    contents:
      "export * from './src/store/useInfluencePreviewStore';export * from './src/utils/previewPump';export * from './src/utils/altPreviewTarget';export * from './src/utils/altPreviewPolicy';export * from './src/utils/curvePointProbe';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
await mkdir('bench/out', { recursive: true });
await writeFile('bench/out/alt-drag-tests.cjs', result.outputFiles[0].text);
const {
  useInfluencePreviewStore: store,
  startPreviewPump,
  altPreviewTarget,
  altPreviewPolicy,
  curvePointProbe,
} = createRequire(import.meta.url)('./out/alt-drag-tests.cjs');
for (const control of ['exposure', 'brightness', 'contrast', 'hue', 'saturation', 'vibrance']) {
  for (const scope of [{ kind: 'global' }, { kind: 'mask', containerId: 'm' }]) {
    const target = altPreviewTarget(control, scope, 'owner', {});
    assert.deepEqual(target, { kind: 'scalar', control, scope });
    assert.equal(altPreviewPolicy(target, control), ['hue', 'saturation', 'vibrance'].includes(control) ? 2 : 1);
  }
}
assert.equal(altPreviewTarget('grainAmount', { kind: 'global' }, 'global', {}), null);
assert.equal(altPreviewTarget('exposure', { kind: 'mask', containerId: 'm' }, 'mask:m', {}).scope.containerId, 'm');
assert.equal(altPreviewTarget('highlights', { kind: 'global' }, 'global', {}).control, 'highlights');
assert.equal(
  altPreviewTarget('hsl.hue', { kind: 'global' }, 'global', { 'global:colorMixer': 'greens' }).band,
  'greens',
);
for (const control of ['highlights', 'shadows', 'whites', 'blacks'])
  assert.equal(altPreviewPolicy({ kind: 'scalar', control, scope: { kind: 'global' } }, control), 1);
for (const control of ['clarity', 'dehaze', 'sharpness', 'structure'])
  assert.equal(altPreviewPolicy({ kind: 'scalar', control, scope: { kind: 'global' } }, control), 0);
for (const component of ['hue', 'saturation', 'luminance'])
  assert.equal(
    altPreviewPolicy({ kind: 'hsl', band: 'greens', component, scope: { kind: 'global' } }, 'hsl.' + component),
    2,
  );
assert.equal(
  altPreviewPolicy({ kind: 'parametric', channel: 'red', parameter: 'shadows', scope: { kind: 'global' } }),
  2,
);
assert.equal(
  altPreviewPolicy({ kind: 'parametric', channel: 'luma', parameter: 'shadows', scope: { kind: 'global' } }),
  1,
);
for (const control of ['vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather'])
  assert.equal(altPreviewPolicy({ kind: 'effect', effect: 'vignette' }, control), 3);
assert.equal(altPreviewPolicy({ kind: 'effect', effect: 'vignette' }, 'vignetteAmount'), 1);
assert.equal(altPreviewPolicy({ kind: 'light', lightId: 'x' }, 'light.x|intensity'), 1);
assert.equal(altPreviewPolicy({ kind: 'light', lightId: 'x' }, 'light.x|temperature'), 2);
assert.equal(altPreviewPolicy({ kind: 'light', lightId: 'x' }, 'light.x|depth'), 3);
for (const control of ['lumaNoiseReduction', 'colorNoiseReduction', 'aiDenoiseAmount', 'aiDenoiseDetail'])
  for (const scope of [{ kind: 'global' }, { kind: 'mask', containerId: 'm' }])
    assert.equal(altPreviewTarget(control, scope, 'global', {}), null);
for (const control of ['relightAmbient', 'relightSoftness', 'relightShine', 'relightShadowSoftness'])
  assert.equal(altPreviewTarget(control, { kind: 'global' }, 'global', {}).kind, 'parameter');
assert.equal(altPreviewPolicy({ kind: 'parameter', control: 'relightAmbient' }), 1);
assert.equal(altPreviewPolicy({ kind: 'parameter', control: 'relightSoftness' }), 0);
assert.equal(altPreviewTarget('grading.midtones.wheel', { kind: 'global' }, 'global', {}).range, 'midtones');
assert.equal(altPreviewTarget('curvePoint.red.1', { kind: 'mask', containerId: 'm' }, 'mask:m', {}).kind, 'curvePoint');
assert.equal(altPreviewPolicy({ kind: 'curvePoint', channel: 'red', index: 1, scope: { kind: 'global' } }), 2);
const points = [
  { x: 0, y: 0 },
  { x: 128, y: 170 },
  { x: 255, y: 255 },
];
const a = curvePointProbe(points, 1),
  b = curvePointProbe(
    [
      { x: 0, y: 0 },
      { x: 128, y: 90 },
      { x: 255, y: 255 },
    ],
    1,
  );
assert.deepEqual(a, b, 'Anchor coverage is independent of dragged output value');
assert.notDeepEqual(
  a,
  curvePointProbe(
    [
      { x: 0, y: 0 },
      { x: 160, y: 170 },
      { x: 255, y: 255 },
    ],
    1,
  ),
  'Coverage follows the anchor input position',
);
assert.equal(points[1].y, 170);
assert.equal(curvePointProbe(points, 5), null);
const target = { kind: 'hsl', band: 'greens', component: 'hue', scope: { kind: 'global' } };
store.getState().beginDrag(target, false);
assert.equal(store.getState().preview.target, null);
store.getState().setAlt(true);
assert.deepEqual(store.getState().preview.target, target);
store.getState().dispatch({ type: 'request', resolution: 960 });
const identity = store.getState().preview.request;
store.getState().setAlt(false);
assert.equal(store.getState().publish(identity, 'late'), false);
store.getState().setAlt(true);
assert.deepEqual(store.getState().preview.target, target);
store.getState().endDrag();
store.getState().setAlt(true);
assert.equal(store.getState().preview.target, null);
store.getState().beginDrag(null, true);
assert.equal(store.getState().preview.target, null);
let value = 0;
const samples = [];
let finish;
let inFlight = 0;
let maxInFlight = 0;
const stop = startPreviewPump(
  () => value,
  async (sample) => {
    samples.push(sample);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((resolve) => {
      finish = resolve;
    });
    inFlight--;
  },
  (error) => {
    throw error;
  },
);
assert.deepEqual(samples, [0]);
for (let i = 1; i <= 100; i++) value = i;
finish();
await new Promise((resolve) => setTimeout(resolve, 35));
assert.deepEqual(samples, [0, 100]);
assert.equal(maxInFlight, 1);
stop();
finish();
value = 101;
await new Promise((resolve) => setTimeout(resolve, 35));
assert.deepEqual(samples, [0, 100]);
console.log('Alt-drag lifecycle and bounded continuous-render tests passed.');
