import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: `export * from './src/utils/influencePreview'; export * from './src/utils/influencePreviewState'; export * from './src/utils/influencePreviewProtocol'; export * from './src/utils/curveMath';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
let count = 0;
function test(name, run) {
  run();
  count++;
  console.log(`ok ${count} - ${name}`);
}
const target = { kind: 'scalar', control: 'highlights', scope: { kind: 'global' } };
const reduce = api.reduceInfluenceState;
const active = () => reduce(api.initialInfluenceState(), { type: 'activate', target });
const requested = () => reduce(active(), { type: 'request', resolution: 960 });
const ready = () => {
  const state = requested();
  return reduce(state, { type: 'resolved', identity: state.request });
};
test('strict target schema accepts only current Alt-slider families', () => {
  assert.equal(api.isInfluenceTarget(target), true);
  for (const invalid of [
    null,
    [],
    {},
    { ...target, lightId: 'x' },
    { ...target, control: 'unknown' },
    { ...target, scope: { kind: 'mask', containerId: '' } },
    { kind: 'geometry', control: 'crop' },
    { kind: 'patch', patchId: 'x' },
    { kind: 'curve', channel: 'luma', scope: { kind: 'global' } },
    { kind: 'effect', effect: 'toneMapper' },
    { kind: 'hsl', band: 'red', component: 'hue', scope: { kind: 'global' } },
  ])
    assert.equal(api.isInfluenceTarget(invalid), false, JSON.stringify(invalid));
});
test('canonical target identity ignores property insertion order', () =>
  assert.equal(
    api.influenceTargetKey(target),
    api.influenceTargetKey({ scope: { kind: 'global' }, control: 'highlights', kind: 'scalar' }),
  ));
test('request identity rejects every mismatched transport field', () => {
  const state = requested();
  for (const key of ['imageEpoch', 'recipeRevision', 'generation', 'resolution', 'targetKey'])
    assert.equal(
      reduce(state, {
        type: 'resolved',
        identity: { ...state.request, [key]: key === 'targetKey' ? 'other' : state.request[key] + 1 },
      }),
      state,
    );
  assert.equal(ready().status, 'ready');
});
test('image changes and closed sessions reject late results', () => {
  for (const type of ['imageChanged', 'clear']) {
    const previous = ready(),
      state = reduce(previous, { type });
    assert.equal(state.target, null);
    assert.equal(reduce(state, { type: 'resolved', identity: previous.result }), state);
  }
});
test('canvas interaction tokens prevent publication until the interaction ends', () => {
  let state = ready();
  state = reduce(state, { type: 'interaction', token: 'canvas', active: true });
  assert.equal(reduce(state, { type: 'request', resolution: 960 }), state);
  state = reduce(state, { type: 'clear' });
  state = reduce(state, { type: 'activate', target });
  assert.equal(state.interactions.length, 1);
  state = reduce(state, { type: 'interaction', token: 'canvas', active: false });
  assert.ok(reduce(state, { type: 'request', resolution: 960 }).request);
});
test('new recipe samples reject old results and preserve the selected target', () => {
  const before = ready(),
    state = reduce(before, { type: 'recipeChanged' });
  assert.equal(state.target, target);
  assert.equal(reduce(state, { type: 'resolved', identity: before.result }), state);
});
test('invalid and oversized resolutions are rejected', () => {
  const state = active();
  for (const resolution of [0, -1, NaN, Infinity, 1.5, 4097])
    assert.equal(reduce(state, { type: 'request', resolution }), state);
});
test('parametric baseline compilation preserves identity and changes only the selected settings', () => {
  const settings = {
    darks: 0,
    shadows: 0,
    highlights: 0,
    lights: 0,
    whiteLevel: 0,
    blackLevel: 0,
    split1: 25,
    split2: 50,
    split3: 75,
  };
  const points = api.buildParametricPoints(settings);
  assert.ok(points.every((p) => p.x === p.y));
  const changed = api.buildParametricPoints({ ...settings, shadows: 50 });
  assert.ok(changed.some((p, i) => p.y !== points[i].y));
  assert.deepEqual(settings, {
    darks: 0,
    shadows: 0,
    highlights: 0,
    lights: 0,
    whiteLevel: 0,
    blackLevel: 0,
    split1: 25,
    split2: 50,
    split3: 75,
  });
});
test('bounded binary protocol rejects stale, malformed and excessive images', () => {
  const identity = requested().request;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=',
    'base64',
  );
  const encode = (metadata, body = png) => {
    const header = Buffer.from(JSON.stringify(metadata));
    const prefix = Buffer.alloc(8);
    prefix.write('RIF1');
    prefix.writeUInt32LE(header.length, 4);
    const bytes = Buffer.concat([prefix, header, body]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  };
  const metadata = { identity, generation: 22, status: 'ready', width: 1, height: 1 };
  assert.ok(api.decodeInfluencePreview(encode(metadata), identity, 22).size > 0);
  assert.throws(() => api.decodeInfluencePreview(encode({ ...metadata, generation: 21 }), identity, 22));
  assert.throws(() => api.decodeInfluencePreview(encode({ ...metadata, width: 100 }), identity, 22));
  const broken = encode(metadata);
  new Uint8Array(broken)[0] = 0;
  assert.throws(() => api.decodeInfluencePreview(broken, identity, 22));
  assert.throws(() => api.decodeInfluencePreview(new ArrayBuffer(4), identity, 22));
  const huge = Buffer.from(png);
  huge.writeUInt32BE(17000, 16);
  assert.throws(() => api.decodeInfluencePreview(encode({ ...metadata, width: 17000 }, huge), identity, 22));
});

console.log(`${count} influence contract tests passed`);
