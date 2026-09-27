/** Real engine acceptance test. Requires a built fork, never a fake native renderer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { inspectTiff16 } from './tiff-inspect.mjs';
import { createNativeHarness } from './coverage-evidence.mjs';

const binary = process.env.RAPIDRAW_BINARY;
const sources = process.env.RAPIDRAW_TEST_IMAGES
  ? JSON.parse(process.env.RAPIDRAW_TEST_IMAGES)
  : [process.env.RAPIDRAW_TEST_IMAGE, process.env.RAPIDRAW_TEST_IMAGE_2].filter(Boolean);
const workspace = process.env.RAPIDRAW_WORKSPACE ?? resolve('test-output/engine-e2e');
assert.ok(binary && isAbsolute(binary), 'Set RAPIDRAW_BINARY to the absolute built fork executable');
assert.ok(
  Array.isArray(sources) && sources.length > 0 && sources.every((p) => typeof p === 'string' && isAbsolute(p)),
  'Set RAPIDRAW_TEST_IMAGE (+ optional RAPIDRAW_TEST_IMAGE_2), or RAPIDRAW_TEST_IMAGES as a JSON array of absolute photo paths',
);
assert.ok(isAbsolute(workspace), 'RAPIDRAW_WORKSPACE must be absolute');
await mkdir(workspace, { recursive: true });
const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const sidecarDigest = async (source) => {
  try {
    return await digest(`${source}.rrdata`);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const originals = await Promise.all(
  sources.map(async (source) => ({
    source,
    sha256: await digest(source),
    sidecar_sha256: await sidecarDigest(source),
  })),
);
const records = [];
const outputId = Date.now();
const evidencePath = join(workspace, `${outputId}-evidence.jsonl`);
function sanitize(value, key = '') {
  if (/token|password|secret/i.test(key)) return '[redacted]';
  if (typeof value === 'string' && (value.length > 4096 || /base64/i.test(key)))
    return `[omitted ${value.length} characters]`;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return value;
}
const coverageEnabled = process.env.RAPIDRAW_COVERAGE === '1';
let client, coverage, failure;
async function evidenceCheck(name, requirements, run, level = 'native_assertion') {
  if (coverage) return coverage.check(name, requirements, run, level);
  return run();
}
async function reconnect() {
  if (coverage) {
    await coverage.reconnect();
    client = coverage.client;
  } else {
    await client.close();
    await connect();
  }
}
async function connect() {
  if (coverageEnabled) {
    coverage = await createNativeHarness({ suite: 'engine-regression', workspace, binary });
    client = coverage.client;
    for (const original of originals) {
      await coverage.fixture(original.source, 'photographic-engine-regression');
      if (original.sidecar_sha256) await coverage.fixture(`${original.source}.rrdata`, 'original-sidecar');
    }
    return;
  }
  client = new Client({ name: 'rapidraw-real-engine-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--binary', binary, '--workspace', workspace],
    stderr: 'inherit',
    // SDK v2 only inherits a safe allowlist; forward the full environment so
    // headless runners keep DISPLAY/GDK_BACKEND/ORT_DYLIB_PATH for the native engine.
    env: { ...process.env },
  });
  await client.connect(transport);
}
async function call(method, args = {}, expectError = false) {
  const start = performance.now();
  const sequence = records.length + 1;
  console.error(`[engine-e2e ${sequence}] ${method} started`);
  const result = coverage
    ? (await coverage.call(method, args, { expectError })).result
    : await client.callTool({ name: `rapidraw_${method}`, arguments: args }, { timeout: 300000 });
  const record = sanitize({
    sequence,
    method,
    args,
    elapsed_ms: Math.round(performance.now() - start),
    is_error: !!result.isError,
    result: result.structuredContent,
  });
  records.push(record);
  await appendFile(evidencePath, `${JSON.stringify(record)}\n`);
  console.error(`[engine-e2e ${sequence}] ${method} ${result.isError ? 'ERROR' : 'OK'} ${record.elapsed_ms} ms`);
  assert.equal(
    !!result.isError,
    expectError,
    `${method}: ${JSON.stringify(result.structuredContent ?? result.content)}`,
  );
  return result;
}
function data(result) {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}
async function writePreview(result, filename) {
  const block = result.content.find((item) => item.type === 'image');
  assert.ok(block, 'Renderer must return a native MCP image block');
  assert.ok(block.data.length > 100, 'Preview must contain encoded image bytes');
  assert.equal(result.structuredContent.image.data, undefined, 'Base64 must not be duplicated in structured data');
  await writeFile(join(workspace, filename), Buffer.from(block.data, 'base64'));
  return block.data;
}
const completed = [];
try {
  await connect();
  const discoveredTools = (await client.listTools()).tools;
  const capabilities = data(await call('capabilities'));
  assert.deepEqual(
    new Set(discoveredTools.map((tool) => tool.name.replace(/^rapidraw_/, ''))),
    new Set(capabilities.methods),
  );
  assert.equal(capabilities.protocol_version, 1);
  assert.ok(capabilities.methods.includes('mask_generate'));
  for (const [index, source] of sources.entries()) {
    const prefix = `${outputId}-${index + 1}`;
    const opened = data(await call('open_photo', { path: source }));
    const session_id = opened.session_id;
    assert.ok(typeof session_id === 'string');
    assert.notEqual(opened.working_path, source);
    const state = data(await call('get_session', { session_id, include_adjustments: true }));
    const original = await writePreview(
      await call('render', { session_id, original: true, long_edge: 1200 }),
      `${prefix}-original.jpg`,
    );
    const changed = data(
      await call('set_adjustments', {
        session_id,
        expected_revision: state.revision,
        patch: { exposure: 0.4, highlights: -15, shadows: 10 },
      }),
    );
    assert.ok(changed.revision > state.revision);
    await call('set_adjustments', { session_id, expected_revision: state.revision, patch: { exposure: 0.8 } }, true);
    await call('set_adjustments', { session_id, patch: { definitely_not_a_native_adjustment: 1 } }, true);
    const edited = await writePreview(await call('render', { session_id, long_edge: 1200 }), `${prefix}-edited.jpg`);
    await evidenceCheck(
      `exposure_preview_${index}`,
      ['tool:set_adjustments', 'tool:render', 'adjustment:exposure'],
      () => {
        assert.notEqual(edited, original, 'Real exposure edit must change rendered pixels');
        return { encoded_preview_changed: true };
      },
    );
    await call('analyze', { session_id, long_edge: 800, histogram: true, scopes: true });
    await writePreview(
      await call('render', { session_id, region: { x: 0, y: 0, width: 256, height: 256 } }),
      `${prefix}-detail.jpg`,
    );
    const { width, height } = state.dimensions;
    const mask = data(
      await call('mask_create', {
        session_id,
        name: 'E2E local correction',
        type: 'radial',
        parameters: {
          centerX: width / 2,
          centerY: height / 2,
          radiusX: width / 5,
          radiusY: height / 5,
          rotation: 0,
          feather: 0.6,
        },
        adjustments: { exposure: 0.25 },
      }),
    );
    assert.ok(typeof mask.mask_id === 'string', 'Mask creation must identify the new mask');
    await writePreview(
      await call('render', { session_id, mask_id: mask.mask_id, long_edge: 800 }),
      `${prefix}-mask.jpg`,
    );
    await call('mask_update', { session_id, mask_id: mask.mask_id, patch: { opacity: 80 } });
    const directMask = await writePreview(
      await call('render', { session_id, mask_id: mask.mask_id, mask_mode: 'grayscale', long_edge: 800 }),
      `${prefix}-direct-mask.png`,
    );
    const beforeDuplicate = data(await call('get_session', { session_id, include_adjustments: true }));
    const duplicate = data(
      await call('mask_duplicate', {
        session_id,
        expected_revision: beforeDuplicate.revision,
        mask_id: mask.mask_id,
        name: 'E2E complementary selection',
        invert: true,
      }),
    );
    const afterDuplicate = data(await call('get_session', { session_id, include_adjustments: true }));
    const sourceMask = beforeDuplicate.adjustments.masks.find((item) => item.id === mask.mask_id);
    const copiedMask = afterDuplicate.adjustments.masks.find((item) => item.id === duplicate.mask_id);
    assert.ok(copiedMask && sourceMask);
    assert.notEqual(duplicate.mask_id, mask.mask_id);
    assert.equal(duplicate.source_mask_id, mask.mask_id);
    assert.equal(copiedMask.invert, !sourceMask.invert);
    assert.equal(copiedMask.subMasks.length, sourceMask.subMasks.length);
    assert.deepEqual(
      copiedMask.subMasks.map((item) => item.parameters),
      sourceMask.subMasks.map((item) => item.parameters),
    );
    assert.ok(copiedMask.subMasks.every((item, index) => item.id !== sourceMask.subMasks[index].id));
    assert.equal(copiedMask.adjustments.exposure ?? 0, 0);
    const inverseMask = await writePreview(
      await call('render', { session_id, mask_id: duplicate.mask_id, mask_mode: 'grayscale', long_edge: 800 }),
      `${prefix}-inverse-mask.png`,
    );
    assert.notEqual(inverseMask, directMask);
    await call('history', { session_id });
    await call('undo', { session_id });
    await call('redo', { session_id });
    await call('set_metadata', { session_id, rating: 4, tags: ['mcp-e2e'] });
    await evidenceCheck(`metadata_roundtrip_${index}`, ['tool:set_metadata', 'tool:get_metadata'], async () => {
      const metadata = data(await call('get_metadata', { session_id })).metadata;
      assert.equal(metadata.rating, 4);
      assert.deepEqual(metadata.tags, ['mcp-e2e']);
      return { rating: metadata.rating, tags: metadata.tags };
    });
    const recipePath = join(workspace, 'recipes', `${prefix}-recipe.json`);
    await call('save_recipe', { session_id, path: recipePath });
    JSON.parse(await readFile(recipePath, 'utf8'));
    await call('save_session', { session_id });
    const exportPath = join(workspace, 'exports', `${prefix}-delivery.jpg`);
    await call('export', { session_id, path: exportPath, format: 'jpeg', quality: 92, long_edge: 1600 });
    assert.ok((await stat(exportPath)).size > 1000);
    await call('export', { session_id, path: exportPath, format: 'jpeg' }, true);
    await call('export', { session_id, path: source, overwrite: true }, true);
    const masterPath = join(workspace, 'exports', `${prefix}-master.tiff`);
    await call('export', { session_id, path: masterPath, format: 'tiff', bit_depth: 16, keep_metadata: false });
    const precision = await evidenceCheck(
      `full_resolution_tiff_precision_${index}`,
      ['tool:export', 'parameter:export.format="tiff"', 'parameter:export.bit_depth=16'],
      async () => inspectTiff16(await readFile(masterPath)),
      'pixel_assertion',
    );
    const finalState = data(await call('get_session', { session_id, include_adjustments: true }));
    const beforeRestart = await writePreview(
      await call('render', { session_id, long_edge: 800 }),
      `${prefix}-final.jpg`,
    );
    await call('close_session', { session_id });
    await reconnect();
    const restoredSessions = data(await call('list_sessions'));
    assert.ok(
      restoredSessions.sessions.some((session) => session.session_id === session_id),
      'Saved session must return after process restart',
    );
    const restored = data(await call('get_session', { session_id, include_adjustments: true }));
    assert.deepEqual(restored.adjustments, finalState.adjustments);
    assert.deepEqual(restored.metadata, finalState.metadata);
    assert.equal(restored.revision, finalState.revision);
    const afterRestart = await writePreview(
      await call('render', { session_id, long_edge: 800 }),
      `${prefix}-restored.jpg`,
    );
    await evidenceCheck(
      `session_restart_${index}`,
      ['tool:close_session', 'tool:list_sessions', 'tool:get_session', 'tool:render', 'tool:save_session'],
      () => {
        assert.equal(afterRestart, beforeRestart, 'Restored session must render identical pixels');
        assert.deepEqual(restored.adjustments, finalState.adjustments);
        assert.deepEqual(restored.metadata, finalState.metadata);
        assert.equal(restored.revision, finalState.revision);
        return { identical_encoded_preview: true, restored_revision: restored.revision };
      },
      'pixel_assertion',
    );
    const batchPath = join(workspace, 'exports', `${prefix}-batch.jpg`);
    const batch = data(
      await call(
        'batch_export',
        {
          items: [
            { session_id, path: batchPath },
            { session_id: 'missing-session', path: join(workspace, 'exports', `${prefix}-missing.jpg`) },
          ],
          options: { format: 'jpeg', long_edge: 800 },
        },
        true,
      ),
    );
    await evidenceCheck(`batch_outcomes_${index}`, ['tool:batch_export'], async () => {
      assert.equal(batch.succeeded, 1);
      assert.equal(batch.failed, 1);
      const successPath = join(workspace, 'exports', `${prefix}-batch-success.jpg`);
      const success = data(
        await call('batch_export', {
          items: [{ session_id, path: successPath }],
          options: { format: 'jpeg', long_edge: 800 },
        }),
      );
      assert.equal(success.succeeded, 1);
      assert.equal(success.failed, 0);
      assert.ok((await stat(successPath)).size > 1000);
      return { mixed: { succeeded: batch.succeeded, failed: batch.failed }, all_succeeded: true };
    });
    completed.push({
      source,
      session_id,
      export_path: exportPath,
      master_path: masterPath,
      recipe_path: recipePath,
      precision,
    });
  }
  for (const method of ['models', 'list_presets', 'list_luts', 'get_engine_settings']) await call(method);
  for (const original of originals) {
    assert.equal(await digest(original.source), original.sha256, 'Source bytes must remain unchanged');
    assert.equal(
      await sidecarDigest(original.source),
      original.sidecar_sha256,
      'Original sidecar bytes/existence must remain unchanged',
    );
  }
  await writeFile(
    join(workspace, `${outputId}-evidence.json`),
    JSON.stringify({ originals, sources_unchanged: true, completed, records }, null, 2),
  );
  console.log(JSON.stringify({ status: 'passed', workspace, completed, calls: records.length }, null, 2));
} catch (error) {
  failure = error;
  throw error;
} finally {
  let closingError;
  try {
    if (coverage) await coverage.close(failure);
    else await client?.close();
  } catch (error) {
    closingError = error;
    failure ??= error;
  }
  for (const original of originals) {
    assert.equal(await digest(original.source), original.sha256, 'Source changed during the workflow');
    assert.equal(
      await sidecarDigest(original.source),
      original.sidecar_sha256,
      'Original sidecar changed during the workflow',
    );
  }
  if (closingError) throw closingError;
}
