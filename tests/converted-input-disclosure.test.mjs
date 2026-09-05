import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const bundle = await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL('../src/hooks/convertedInputSupport.ts', import.meta.url))],
  format: 'esm',
  platform: 'node',
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`;
const { CONVERTED_INPUT_DISCLOSURE_VERSION, fileExtension, requiresConvertedInputDisclosure } = await import(moduleUrl);

test('recognizes converted-input paths case-insensitively', () => {
  assert.equal(fileExtension('/photos/IMG_0001.HEIC'), 'heic');
  assert.equal(fileExtension('C:\\photos\\IMG_0002.HEIF?vc=preview'), 'heif');
});

test('shows the HEIC disclosure before it has been acknowledged', () => {
  assert.equal(requiresConvertedInputDisclosure(['/photos/image.heic'], undefined, 'macos', 0), true);
  assert.equal(requiresConvertedInputDisclosure(['/photos/image.jpg'], undefined, 'macos', 0), false);
});

test('does not show the disclosure again for the acknowledged version', () => {
  assert.equal(
    requiresConvertedInputDisclosure(
      ['/photos/image.heif'],
      ['heic', 'heif', 'hif'],
      'macos',
      CONVERTED_INPUT_DISCLOSURE_VERSION,
    ),
    false,
  );
});

test('uses the backend-provided converted-input registry on other platforms', () => {
  assert.equal(requiresConvertedInputDisclosure(['/photos/image.HIF'], ['hif'], 'windows', 0), true);
  assert.equal(requiresConvertedInputDisclosure(['/photos/image.heic'], undefined, 'windows', 0), false);
});
