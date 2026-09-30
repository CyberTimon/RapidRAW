import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolDefinitions } from '../dist/tools.js';
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const binary = fileURLToPath(new URL('./fixtures/bridge.mjs', import.meta.url));

async function connect(t) {
  const folder = await mkdtemp(join(tmpdir(), 'rapidraw-mcp-'));
  const pidFile = join(folder, 'pid');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--binary', binary, '--workspace', folder],
    env: { ...process.env, FAKE_PID_FILE: pidFile },
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr.on('data', (chunk) => {
    diagnostics += chunk;
  });
  const client = new Client({ name: 'rapidraw-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, pidFile, diagnostics: () => diagnostics };
}

test('real SDK stdio handshake exposes comprehensive strict tools, resources and workflow prompt', async (t) => {
  const { client, diagnostics } = await connect(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, toolDefinitions.length);
  for (const tool of tools) {
    assert.ok(tool.name.startsWith('rapidraw_'));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  const resources = await client.listResources();
  assert.ok(resources.resources.some((r) => r.uri === 'rapidraw://workflow'));
  const workflow = await client.readResource({ uri: 'rapidraw://workflow' });
  assert.match(workflow.contents[0].text, /native-detail/);
  const schema = await client.readResource({ uri: 'rapidraw://adjustment-schema' });
  assert.equal(JSON.parse(schema.contents[0].text).protocol_version, 1);
  const session = await client.readResource({ uri: 'rapidraw://sessions/test-session' });
  assert.equal(JSON.parse(session.contents[0].text).params.include_adjustments, true);
  const prompt = await client.getPrompt({ name: 'pro_photo_edit', arguments: { path: '/photos/test.cr3' } });
  assert.equal(prompt.messages.length, 2);
  assert.match(prompt.messages[1].content.text, /test.cr3/);
  assert.match(diagnostics(), /Native startup diagnostic/);
});

test('mask duplication and in-parent AI composition are exposed and forwarded', async (t) => {
  const { client } = await connect(t);
  const duplicate = await client.callTool({
    name: 'rapidraw_mask_duplicate',
    arguments: {
      session_id: 'test-session',
      expected_revision: 2,
      mask_id: 'subject',
      name: 'Environment',
      invert: true,
      copy_adjustments: false,
    },
  });
  assert.ok(!duplicate.isError);
  assert.equal(duplicate.structuredContent.method, 'mask_duplicate');
  assert.equal(duplicate.structuredContent.params.invert, true);
  const generated = await client.callTool({
    name: 'rapidraw_mask_generate',
    arguments: {
      session_id: 'test-session',
      expected_revision: 2,
      kind: 'depth',
      depth_provider: 'marigold',
      target_mask_id: 'subject',
      mode: 'intersect',
      parameters: { minDepth: 65, maxDepth: 100 },
    },
  });
  assert.ok(!generated.isError);
  assert.equal(generated.structuredContent.params.target_mask_id, 'subject');
  assert.equal(generated.structuredContent.params.mode, 'intersect');
  const invalid = await client.callTool({
    name: 'rapidraw_mask_generate',
    arguments: { session_id: 'test-session', kind: 'subject', target_mask_id: 'subject', mode: 'union' },
  });
  assert.equal(invalid.isError, true);
});

test('image bytes use MCP content without duplicating base64 in structured data', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: 'rapidraw_render',
    arguments: { session_id: 'test-session', long_edge: 1600 },
  });
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.image.mimeType, 'image/png');
  assert.equal(result.structuredContent.image.data, undefined);
  assert.ok(result.content.some((block) => block.type === 'image' && block.data.startsWith('iVBOR')));
  assert.ok(!result.content[0].text.includes('iVBOR'));
});

test('stdio tools and resources redact native assets and reject summary recipes before dispatch', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: 'rapidraw_get_session',
    arguments: { session_id: 'asset-state', include_adjustments: true },
  });
  assert.ok(!result.isError);
  assert.ok(result.content[0].text.length < 3000);
  const resource = await client.readResource({ uri: 'rapidraw://sessions/asset-state' });
  const state = JSON.parse(resource.contents[0].text);
  assert.deepEqual(state.adjustments, result.structuredContent.adjustments);
  assert.equal(state.state_representation.omitted_assets, 4);
  const complete = await client.callTool({
    name: 'rapidraw_get_session',
    arguments: {
      session_id: 'asset-state',
      include_adjustments: true,
      include_assets: true,
    },
  });
  assert.equal(
    complete.structuredContent.adjustments.masks[0].subMasks[0].parameters.samRefinement.logitsBase64.length,
    349528,
  );
  assert.equal(complete.structuredContent.params.include_assets, undefined);
  // A fresh read-back round-trips: descriptors resolve against live state.
  const roundtrip = await client.callTool({
    name: 'rapidraw_set_adjustments',
    arguments: {
      session_id: 'asset-state',
      mode: 'replace',
      patch: state.adjustments,
    },
  });
  assert.ok(!roundtrip.isError);
  // A tampered descriptor digest still fails closed without mutating.
  const tampered = structuredClone(state.adjustments);
  tampered.masks[0].subMasks[0].parameters.maskDataBase64.sha256 = '0'.repeat(64);
  const invalid = await client.callTool({
    name: 'rapidraw_set_adjustments',
    arguments: {
      session_id: 'asset-state',
      mode: 'replace',
      patch: tampered,
    },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.structuredContent.error.message, /No mutation was requested/);
  const valid = await client.callTool({
    name: 'rapidraw_set_adjustments',
    arguments: { session_id: 'asset-state', patch: { exposure: 0.5 } },
  });
  assert.ok(!valid.isError);
});

test('native tool discovery supports bounded schema reads with legacy full compatibility', async (t) => {
  const { client } = await connect(t);
  const get = (args) => client.callTool({ name: 'rapidraw_capabilities', arguments: args });
  const overview = (await get({ detail: 'overview' })).structuredContent;
  const selected = (await get({ schema_paths: ['properties.temperature'] })).structuredContent;
  const full = (await get({})).structuredContent;
  assert.equal(overview.adjustment_schema, undefined);
  assert.equal(overview.schema_id, full.schema_id);
  assert.deepEqual(selected.schemas['properties.temperature'], full.adjustment_schema.properties.temperature);
  assert.deepEqual(selected.coordinate_space, full.coordinate_space);
  for (const args of [{ schema_paths: ['properties.bad'] }, { schema_paths: [] }, { detail: 'brief' }])
    assert.equal((await get(args)).isError, true);
});

test('invalid tool arguments and engine errors remain actionable errors', async (t) => {
  const { client } = await connect(t);
  const invalid = await client.callTool({
    name: 'rapidraw_export',
    arguments: { session_id: 'test-session', path: '/tmp/a.jpg', quality: 101 },
  });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({
    name: 'rapidraw_render',
    arguments: { session_id: 'test-session', typo: true },
  });
  assert.equal(unknown.isError, true);
  const error = await client.callTool({
    name: 'rapidraw_set_adjustments',
    arguments: { session_id: 'test-session', patch: { bad: 1 } },
  });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent.error.code, 'INVALID_ADJUSTMENT');
  const followup = await client.callTool({ name: 'rapidraw_get_session', arguments: { session_id: 'test-session' } });
  assert.ok(!followup.isError);
});

test('preset saves expose and forward explicit adjustment selection', async (t) => {
  const { client } = await connect(t);
  const selection = ['lutPath', 'lutIntensity', 'lutIsSceneReferred', 'contrast', 'curves'];
  const { tools } = await client.listTools();
  const presetTool = tools.find((tool) => tool.name === 'rapidraw_manage_presets');
  assert.equal(presetTool.inputSchema.properties.adjustment_keys.type, 'array');
  const result = await client.callTool({
    name: presetTool.name,
    arguments: { action: 'save', session_id: 'test-session', adjustment_keys: selection },
  });
  assert.ok(!result.isError);
  assert.deepEqual(result.structuredContent.params.adjustment_keys, selection);
  for (const invalid of [[], ['contrast', 'contrast'], [''], [1], Array.from({ length: 101 }, (_, i) => `key${i}`)]) {
    const rejected = await client.callTool({
      name: presetTool.name,
      arguments: { action: 'save', session_id: 'test-session', adjustment_keys: invalid },
    });
    assert.equal(rejected.isError, true, JSON.stringify(invalid));
  }
});

test('background operation arguments receive the same strict native tool schema validation', async (t) => {
  const { client } = await connect(t);
  for (const args of [
    { operation: 'export', arguments: { session_id: 'source', path: 'out.png', quality: 101 } },
    { operation: 'export', arguments: { session_id: 'source', path: 'out.png', misspelled: true } },
    { operation: 'merge', arguments: { kind: 'hdr', paths: ['/one.png'] } },
    { operation: 'retouch', arguments: { session_id: 'source', mode: 'generative', sub_masks: [] } },
  ]) {
    const result = await client.callTool({ name: 'rapidraw_start_operation', arguments: args });
    assert.equal(result.isError, true);
  }
  const jobs = await client.callTool({ name: 'rapidraw_list_operation_jobs', arguments: {} });
  assert.equal(jobs.isError, undefined);
  assert.deepEqual(jobs.structuredContent.jobs, []);
});

test('client disconnect terminates the owned native process', async (t) => {
  const { client, pidFile } = await connect(t);
  await client.callTool({ name: 'rapidraw_capabilities', arguments: {} });
  const pid = Number(await readFile(pidFile, 'utf8'));
  process.kill(pid, 0);
  await client.close();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Native process ${pid} remained alive after client disconnect`);
});

test('batch partial failure is an MCP tool error with successful item evidence preserved', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: 'rapidraw_batch_export',
    arguments: {
      items: [
        { session_id: 'good', path: '/tmp/ok.jpg' },
        { session_id: 'missing', path: '/tmp/bad.jpg' },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.failed, 1);
  assert.equal(result.structuredContent.succeeded, 1);
  assert.equal(result.structuredContent.results[0].ok, true);
});

test('official legacy SDK v1 client interoperates through the MCP 2025 initialize flow', async (t) => {
  const { Client: LegacyClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport: LegacyTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const folder = await mkdtemp(join(tmpdir(), 'rapidraw-mcp-legacy-'));
  const transport = new LegacyTransport({
    command: process.execPath,
    args: [serverPath, '--binary', binary, '--workspace', folder],
    stderr: 'pipe',
  });
  transport.stderr.on('data', () => {});
  let offeredVersion;
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (message.method === 'initialize') offeredVersion = message.params.protocolVersion;
    return send(message, options);
  };
  const client = new LegacyClient({ name: 'rapidraw-legacy-compatibility', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.match(offeredVersion, /^2025-/);
  assert.equal((await client.listTools()).tools.length, toolDefinitions.length);
  const preview = await client.callTool({
    name: 'rapidraw_render',
    arguments: { session_id: 'legacy-test', long_edge: 1600 },
  });
  assert.ok(preview.content.some((item) => item.type === 'image'));
  assert.equal(preview.structuredContent.width, 1);
  const workflow = await client.readResource({ uri: 'rapidraw://workflow' });
  assert.match(workflow.contents[0].text, /professional/);
  const prompt = await client.getPrompt({ name: 'pro_photo_edit', arguments: { path: '/photos/legacy.cr3' } });
  assert.equal(prompt.messages.length, 2);
});

test('export resize options validate dimensions and default to no enlargement', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: 'rapidraw_export',
    arguments: { session_id: 'test-session', path: '/tmp/resize.jpg', resize: { mode: 'width', value: 1200 } },
  });
  assert.ok(!result.isError);
  assert.deepEqual(result.structuredContent.params.resize, { mode: 'width', value: 1200, dont_enlarge: true });
  const invalid = await client.callTool({
    name: 'rapidraw_export',
    arguments: { session_id: 'test-session', path: '/tmp/resize.jpg', resize: { mode: 'height', value: 0 } },
  });
  assert.equal(invalid.isError, true);
});

test('comparison tools keep image arrays in ordered MCP blocks with metadata only in text', async (t) => {
  const { toolResult } = await import('../dist/server.js');
  const native = {
    session_id: 'test',
    images: [
      { label: 'Reference', mimeType: 'image/png', data: 'AAA' },
      { label: 'Cooler', mimeType: 'image/png', data: 'BBB' },
    ],
  };
  const response = toolResult(native);
  assert.deepEqual(
    response.content.slice(1).map((b) => b.data),
    ['AAA', 'BBB'],
  );
  assert.deepEqual(
    response.structuredContent.images.map((b) => b.content_index),
    [1, 2],
  );
  assert.ok(response.structuredContent.images.every((b) => b.data === undefined));
  assert.ok(!response.content[0].text.includes('AAA'));
  assert.equal(native.images[0].data, 'AAA', 'Conversion must not mutate the engine response');
  const { client } = await connect(t);
  for (const args of [
    { variants: [{ label: 'one' }] },
    { variants: [{ label: 'one', typo: true }, { label: 'two' }] },
    { variants: [{ label: 'one' }, { label: 'two' }], long_edge: 2049 },
  ]) {
    const result = await client.callTool({
      name: 'rapidraw_render_compare',
      arguments: { session_id: 'test', ...args },
    });
    assert.equal(result.isError, true);
  }
  const accepted = await client.callTool({
    name: 'rapidraw_render_compare',
    arguments: {
      session_id: 'test',
      variants: [{ label: 'Reference' }, { label: 'Cooler', patch: { temperature: -10 }, disabled_masks: ['mask-1'] }],
    },
  });
  assert.ok(!accepted.isError);
});

test('job and named-version contracts reject invalid identifiers and expose correct annotations', async (t) => {
  const { client } = await connect(t);
  for (const name of ['get_job', 'cancel_job', 'resume_job']) {
    const result = await client.callTool({ name: `rapidraw_${name}`, arguments: { job_id: '../escape' } });
    assert.equal(result.isError, true);
  }
  const invalid = await client.callTool({
    name: 'rapidraw_save_version',
    arguments: { session_id: 'test', label: '   ' },
  });
  assert.equal(invalid.isError, true);
  const { tools } = await client.listTools();
  for (const name of ['render_compare', 'inspect_adjustments', 'list_versions', 'get_job', 'list_jobs']) {
    assert.equal(tools.find((tool) => tool.name === `rapidraw_${name}`).annotations.readOnlyHint, true);
  }
  assert.equal(tools.find((tool) => tool.name === 'rapidraw_cancel_job').annotations.idempotentHint, true);
  assert.equal(tools.find((tool) => tool.name === 'rapidraw_start_denoise').annotations.readOnlyHint, false);
});

test('oversized multi-image responses return a bounded error and preserve default SDK stdio connection', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: 'rapidraw_render',
    arguments: { session_id: 'oversized-images', format: 'png' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'RESPONSE_TOO_LARGE');
  assert.equal(result.structuredContent.error.max_response_bytes, 8 * 1024 * 1024);
  assert.ok(result.structuredContent.error.response_bytes > 10 * 1024 * 1024);
  assert.equal(result.structuredContent.recovery.request_completed, true);
  assert.equal(result.structuredContent.recovery.mutation_may_have_completed, false);
  assert.equal(result.structuredContent.recovery.session_id, 'oversized-images');
  assert.ok(result.content.every((block) => block.type === 'text'));
  assert.match(result.structuredContent.recovery.next_step, /smaller long_edge/);
  const followup = await client.callTool({
    name: 'rapidraw_get_session',
    arguments: { session_id: 'oversized-images', include_adjustments: false },
  });
  assert.ok(!followup.isError);
  const preview = await client.callTool({
    name: 'rapidraw_render',
    arguments: { session_id: 'bounded-retry', format: 'jpeg', long_edge: 800 },
  });
  assert.ok(!preview.isError);
  assert.ok(preview.content.some((block) => block.type === 'image'));
  assert.equal(
    (await client.callTool({ name: 'rapidraw_capabilities', arguments: {} })).structuredContent.transport_limits
      .max_response_bytes,
    8 * 1024 * 1024,
  );
});

test('oversized completed mutation preserves recovery IDs/revision without replaying the mutation', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: 'rapidraw_mask_generate',
    arguments: { session_id: 'oversized-mutation', kind: 'foreground' },
  });
  assert.equal(result.structuredContent.error.code, 'RESPONSE_TOO_LARGE');
  const recovery = result.structuredContent.recovery;
  assert.equal(recovery.mutation_may_have_completed, true);
  assert.equal(recovery.retry_mutation, false);
  assert.equal(recovery.mask_id, 'mask-created');
  assert.equal(recovery.revision, 3);
  const state = await client.callTool({
    name: 'rapidraw_get_session',
    arguments: { session_id: recovery.session_id, include_adjustments: false },
  });
  assert.equal(state.structuredContent.mutation_count, 1);
  assert.equal(state.structuredContent.revision, 3);
});

test('oversized UTF-8 metadata and resources preserve the connection and permit smaller state reads', async (t) => {
  const { client } = await connect(t);
  const state = await client.callTool({
    name: 'rapidraw_get_session',
    arguments: { session_id: 'oversized-state', include_adjustments: true },
  });
  assert.equal(state.structuredContent.error.code, 'RESPONSE_TOO_LARGE');
  assert.ok(state.structuredContent.error.response_bytes > 10 * 1024 * 1024);
  // A resource stores JSON once, so the same state can fit while its duplicated
  // tool metadata exceeds the limit. A larger resource must fail safely too.
  const resource = await client.readResource({ uri: 'rapidraw://sessions/oversized-state' });
  assert.ok(resource.contents[0].text.length > 3 * 1024 * 1024);
  await assert.rejects(client.readResource({ uri: 'rapidraw://sessions/oversized-resource' }), /RESPONSE_TOO_LARGE/);
  assert.ok(
    !(
      await client.callTool({
        name: 'rapidraw_get_session',
        arguments: { session_id: 'oversized-state', include_adjustments: false },
      })
    ).isError,
  );
});

test('long native errors and excessive prompt arguments cannot overflow outbound stdio', async (t) => {
  const { client } = await connect(t);
  const error = await client.callTool({ name: 'rapidraw_render', arguments: { session_id: 'oversized-error' } });
  assert.equal(error.structuredContent.error.code, 'NATIVE_FAILURE');
  assert.equal(error.structuredContent.error.message_truncated, true);
  assert.equal(error.structuredContent.error.message.length, 4096);
  await assert.rejects(
    client.getPrompt({ name: 'pro_photo_edit', arguments: { path: '/fixture.png', intent: 'x'.repeat(65537) } }),
  );
  assert.ok(
    !(await client.callTool({ name: 'rapidraw_get_session', arguments: { session_id: 'still-alive' } })).isError,
  );
});

test('oversized batches keep bounded item IDs and explicitly disclose truncated recovery details', async () => {
  const { toolResult, MCP_RESPONSE_BUDGET_BYTES } = await import('../dist/server.js');
  const result = toolResult(
    {
      payload: 'x'.repeat(6 * 1024 * 1024),
      total: 20,
      items: Array.from({ length: 20 }, (_, i) => ({
        ok: true,
        result: { session_id: `result-${i}`, path: `/exports/${i}.png`, submask_ids: ['one', 'two'] },
      })),
    },
    { method: 'batch_export', readOnly: false },
  );
  assert.equal(result.structuredContent.error.code, 'RESPONSE_TOO_LARGE');
  assert.equal(result.structuredContent.recovery.items_count, 20);
  assert.equal(result.structuredContent.recovery.items_truncated, true);
  assert.equal(result.structuredContent.recovery.items.length, 16);
  assert.equal(result.structuredContent.recovery.items[0].result.session_id, 'result-0');
  assert.deepEqual(result.structuredContent.recovery.items[0].result.submask_ids, ['one', 'two']);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < MCP_RESPONSE_BUDGET_BYTES);
});

test('subject point and prior reference schema reaches native without losing coordinates', async (t) => {
  const { client } = await connect(t);
  const args = {
    session_id: 'subject',
    expected_revision: 4,
    kind: 'subject',
    include_points: [{ x: 12.5, y: 17 }],
    exclude_points: [{ x: 2, y: 3 }],
    region: { x: 1, y: 2, width: 30, height: 40 },
    refine: { mask_id: 'parent', sub_mask_id: 'child' },
  };
  const response = await client.callTool({ name: 'rapidraw_mask_generate', arguments: args });
  assert.ok(!response.isError);
  assert.deepEqual(response.structuredContent.params, args);
  for (const patch of [
    { include_points: [{ x: -1, y: 0 }] },
    { exclude_points: Array(65).fill({ x: 1, y: 2 }) },
    { refine: { mask_id: 'parent', typo: 'child' } },
    { include_points: [{ x: 1, y: 2, label: 0 }] },
  ]) {
    const error = await client.callTool({ name: 'rapidraw_mask_generate', arguments: { ...args, ...patch } });
    assert.equal(error.isError, true);
  }
  const next = await client.callTool({ name: 'rapidraw_get_session', arguments: { session_id: 'subject' } });
  assert.ok(!next.isError);
});
