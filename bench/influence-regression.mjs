// Same-machine output regression, with generated public-domain fixtures only.
// node bench/influence-regression.mjs <pinned-before-exe> <after-exe>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [before, after] = process.argv.slice(2).map((p) => resolve(p));
if (!before || !after) throw new Error('Pass before and after executable paths');
const out = resolve('bench/out/influence-regression');
mkdirSync(out, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
const width = 513,
  height = 341,
  raw = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    raw[i] = x % 256;
    raw[i + 1] = y % 256;
    raw[i + 2] = (x * 17 + y * 13) % 256;
  }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const fixture = join(out, 'fixture.png');
writeFileSync(
  fixture,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
const defaults = JSON.parse(readFileSync('src/utils/defaultAdjustments.json', 'utf8'));
const encodedFixture = readFileSync(fixture).toString('base64');
const depthMap = `data:image/png;base64,${encodedFixture}`;
const recipes = {
  neutral: defaults,
  colour: {
    ...defaults,
    exposure: 0.7,
    contrast: 23,
    saturation: 17,
    vibrance: 12,
    hsl: { ...defaults.hsl, reds: { hue: 17, saturation: 20, luminance: 11 } },
    colorGrading: { ...defaults.colorGrading, shadows: { hue: 223, saturation: 31, luminance: 8 } },
    vignetteAmount: -35,
    vignetteMidpoint: 42,
    vignetteFeather: 58,
    grainAmount: 17,
  },
  masked: {
    ...defaults,
    masks: [
      {
        id: 'fixture-mask',
        name: 'fixture',
        visible: true,
        invert: false,
        opacity: 73,
        adjustments: {
          ...defaults,
          exposure: 0.4,
          contrast: 12,
          colorGrading: { ...defaults.colorGrading, midtones: { hue: 42, saturation: 23, luminance: -8 } },
        },
        subMasks: [
          {
            id: 'fixture-all',
            type: 'all',
            visible: true,
            invert: false,
            opacity: 61,
            mode: 'additive',
            parameters: {},
          },
        ],
      },
    ],
  },
  geometry: { ...defaults, transformHorizontal: 7, transformVertical: -5, transformRotate: 2, transformScale: 105 },
  spatial: {
    ...defaults,
    relightEnabled: true,
    relightNormalMap: depthMap,
    relightAmbient: 10,
    relightLights: [
      { id: 'fixture-light', type: 'directional', intensity: 35, angle: 20, elevation: 65, color: '#ffeedd' },
    ],
    fogEnabled: true,
    fogDepthMap: depthMap,
    fogAmount: 23,
    fogTemperature: 12,
    lensBlurEnabled: true,
    lensBlurDepthMap: depthMap,
    lensBlurAmount: 35,
  },
  monochrome: {
    ...defaults,
    monochromeEnabled: true,
    monochromeMix: { ...defaults.monochromeMix, reds: 30, blues: -20 },
    monochromeToning: {
      ...defaults.monochromeToning,
      shadowHue: 225,
      shadowSaturation: 25,
      highlightHue: 42,
      highlightSaturation: 17,
    },
  },
  patch: {
    ...defaults,
    aiPatches: [
      {
        id: 'fixture-patch',
        name: 'fixture',
        visible: true,
        subMasks: [],
        patchData: { color: encodedFixture, mask: encodedFixture, isSrgbEncoded: true },
      },
    ],
  },
};
const evidence = [];
if (process.env.INFLUENCE_CASES) {
  recipes.relight = { ...recipes.spatial, fogEnabled: false, lensBlurEnabled: false };
  recipes.fog = { ...recipes.spatial, relightEnabled: false, lensBlurEnabled: false };
  recipes.blur = { ...recipes.spatial, relightEnabled: false, fogEnabled: false };
}
for (const [name, recipe] of Object.entries(recipes)) {
  if (process.env.INFLUENCE_CASES && !process.env.INFLUENCE_CASES.split(',').includes(name)) continue;
  const adjustments = join(out, `${name}.json`);
  writeFileSync(adjustments, JSON.stringify(recipe));
  for (const format of ['jpeg', 'tiff']) {
    const hashes = [];
    for (const [label, exe] of [
      ['before', before],
      ['after', after],
    ]) {
      const output = join(out, `${name}-${label}.${format === 'jpeg' ? 'jpg' : 'tiff'}`);
      const start = performance.now();
      const result = spawnSync(
        exe,
        [
          'export',
          fixture,
          '--output',
          output,
          '--format',
          format,
          '--quality',
          '95',
          '--tiff-bit-depth',
          '16',
          '--adjustments',
          adjustments,
        ],
        // Upstream fog uses a parallel floating-point reduction whose merge order
        // varies across runs. Pin CPU reduction order for strict file equality.
        { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, RAYON_NUM_THREADS: '1' } },
      );
      writeFileSync(join(out, `${name}-${format}-${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
      assert.equal(result.status, 0, `${name}/${format}/${label}: ${result.error ?? result.stderr}`);
      hashes.push(createHash('sha256').update(readFileSync(output)).digest('hex'));
      evidence.push({ name, format, label, elapsedMs: performance.now() - start, sha256: hashes.at(-1) });
    }
    assert.equal(hashes[0], hashes[1], `${name}/${format} differs`);
    console.log(`${name}/${format}: byte-identical`);
  }
}
writeFileSync(join(out, 'results.json'), JSON.stringify(evidence, null, 2));
console.log(`Evidence: ${out}`);
