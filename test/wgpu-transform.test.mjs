import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-wgpu-transform-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'transform.mjs');
await build({
  entryPoints: ['src/utils/wgpuTransform.ts'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
});
const { wgpuTransformGeneration, wgpuTransformRequest } = await import(pathToFileURL(output));

test('WGPU transforms carry the current generation, including a zero sentinel while switching photos', () => {
  const visibleGeometry = { x: 40, y: 25, width: 600, height: 400, pixelated: false };
  const previous = wgpuTransformRequest(visibleGeometry, wgpuTransformGeneration(7));
  const switching = wgpuTransformRequest({ ...visibleGeometry, x: -999999, y: -999999 }, wgpuTransformGeneration(null));
  const newPhoto = wgpuTransformRequest(visibleGeometry, wgpuTransformGeneration(8));

  assert.equal(previous.payload.expectedGeneration, 7);
  assert.equal(switching.payload.expectedGeneration, 0);
  assert.equal(newPhoto.payload.expectedGeneration, 8);
  assert.notEqual(previous.key, newPhoto.key);
  assert.notEqual(previous.key, switching.key);
  assert.equal('expectedGeneration' in visibleGeometry, false);
});
