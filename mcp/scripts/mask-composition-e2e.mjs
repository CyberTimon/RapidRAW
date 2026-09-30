/** Native MCP acceptance for in-parent AI generation and independent mask duplication. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const binary = process.env.RAPIDRAW_BINARY;
const source = process.env.RAPIDRAW_TEST_IMAGE;
const workspace = process.env.RAPIDRAW_WORKSPACE;
assert.ok(binary && isAbsolute(binary), 'Set RAPIDRAW_BINARY to the absolute native executable');
assert.ok(source && isAbsolute(source), 'Set RAPIDRAW_TEST_IMAGE to an absolute source image');
assert.ok(workspace && isAbsolute(workspace), 'Set RAPIDRAW_WORKSPACE to an absolute isolated workspace');
await mkdir(workspace, { recursive: true });
const originalHash = createHash('sha256')
  .update(await readFile(source))
  .digest('hex');
let client;

async function connect() {
  client = new Client({ name: 'rapidraw-mask-composition-e2e', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--binary', binary, '--workspace', workspace],
      env: { ...process.env },
      stderr: 'inherit',
    }),
  );
}

async function call(method, args = {}) {
  const result = await client.callTool({ name: `rapidraw_${method}`, arguments: args }, { timeout: 600000 });
  assert.equal(result.isError, undefined, `${method}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  return result;
}

async function state(session_id) {
  return (await call('get_session', { session_id, include_adjustments: true })).structuredContent;
}

async function maskPixels(session_id, mask_id) {
  const result = await call('render', { session_id, mask_id, mask_mode: 'grayscale', long_edge: 512 });
  const image = result.content.find((block) => block.type === 'image');
  assert.ok(image?.data);
  return image.data;
}

function selectionParameters(mask) {
  return mask.subMasks.map((part) => {
    const parameters = structuredClone(part.parameters);
    if (parameters.maskDataBase64?._rapidraw_asset) {
      // Asset descriptors point to their position in the current state tree.
      delete parameters.maskDataBase64.state_path;
    }
    return parameters;
  });
}

try {
  await connect();
  const methods = (await call('capabilities', { detail: 'overview' })).structuredContent.methods;
  assert.ok(methods.includes('mask_duplicate') && methods.includes('mask_generate'));
  let models = (await call('models')).structuredContent.groups.masks;
  if (!models.ready) {
    assert.equal(
      process.env.RAPIDRAW_ALLOW_MODEL_INSTALL,
      '1',
      'Mask models are missing. Set RAPIDRAW_ALLOW_MODEL_INSTALL=1 only when local installation is intended.',
    );
    assert.ok(models.assets.every((asset) => asset.installed_app_copy_available));
    await call('install_model', { kind: 'masks' });
    models = (await call('models')).structuredContent.groups.masks;
  }
  assert.equal(models.ready, true);
  const opened = (await call('open_photo', { path: source, inherit_sidecar: false })).structuredContent;
  const session_id = opened.session_id;
  const width = opened.dimensions.width;
  const height = opened.dimensions.height;
  const created = (
    await call('mask_create', {
      session_id,
      expected_revision: opened.revision,
      name: 'Spatial selection',
      type: 'radial',
      parameters: {
        centerX: width / 2,
        centerY: height / 2,
        radiusX: width / 3,
        radiusY: height / 3,
        rotation: 0,
        feather: 0.4,
      },
      adjustments: { exposure: 0.2 },
    })
  ).structuredContent;
  const generated = (
    await call('mask_generate', {
      session_id,
      expected_revision: created.revision,
      kind: 'depth',
      target_mask_id: created.mask_id,
      mode: 'intersect',
      parameters: { minDepth: 0, maxDepth: 100, minFade: 0, maxFade: 0, feather: 0 },
    })
  ).structuredContent;
  assert.equal(generated.mask_id, created.mask_id);
  const combined = await state(session_id);
  const parent = combined.adjustments.masks.find((mask) => mask.id === created.mask_id);
  assert.equal(parent.subMasks.length, 2);
  assert.equal(parent.subMasks[1].id, generated.sub_mask_id);
  assert.equal(parent.subMasks[1].type, 'ai-depth');
  assert.equal(parent.subMasks[1].mode, 'intersect');
  assert.equal(parent.adjustments.exposure, 0.2);
  const direct = await maskPixels(session_id, created.mask_id);
  const duplicate = (
    await call('mask_duplicate', {
      session_id,
      expected_revision: combined.revision,
      mask_id: created.mask_id,
      name: 'Inverse selection',
      invert: true,
    })
  ).structuredContent;
  assert.notEqual(duplicate.mask_id, created.mask_id);
  assert.equal(duplicate.source_mask_id, created.mask_id);
  const withCopy = await state(session_id);
  const copy = withCopy.adjustments.masks.find((mask) => mask.id === duplicate.mask_id);
  assert.equal(copy.invert, !parent.invert);
  assert.equal(copy.adjustments.exposure ?? 0, 0);
  assert.deepEqual(selectionParameters(copy), selectionParameters(parent));
  assert.ok(copy.subMasks.every((part, index) => part.id !== parent.subMasks[index].id));
  const inverse = await maskPixels(session_id, duplicate.mask_id);
  assert.notEqual(inverse, direct);
  await call('save_session', { session_id });
  await call('close_session', { session_id });
  await client.close();
  await connect();
  const reopened = await state(session_id);
  assert.deepEqual(reopened.adjustments.masks, withCopy.adjustments.masks);
  assert.equal(await maskPixels(session_id, created.mask_id), direct);
  assert.equal(await maskPixels(session_id, duplicate.mask_id), inverse);
  assert.equal(
    createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
    originalHash,
  );
  console.log(JSON.stringify({ status: 'passed', masks: 2, generated_components: 1, source_unchanged: true }));
} finally {
  await client?.close();
}
