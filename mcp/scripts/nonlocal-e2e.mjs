/** Real Bayer/CUDA acceptance. Requires RAPIDRAW_TEST_RAW and an isolated workspace. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { requireFreeSpace } from '../dist/storage.js';

const binary = process.env.RAPIDRAW_BINARY;
const source = process.env.RAPIDRAW_TEST_RAW;
assert.ok(binary && source, 'Set RAPIDRAW_BINARY and RAPIDRAW_TEST_RAW');
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? 'test-output/nonlocal');
await mkdir(workspace, { recursive: true });
await requireFreeSpace(workspace, 22);
const review = join(workspace, 'native-review');
await mkdir(review, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(await readFile(source));
let client;
const records = [];
async function connect() {
  client = new Client({ name: 'nonlocal-native-acceptance', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../dist/index.js', import.meta.url)),
        '--binary',
        binary,
        '--workspace',
        workspace,
        '--timeout-ms',
        '900000',
      ],
      stderr: 'inherit',
      env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    }),
  );
}
async function call(name, args = {}, expectError = false) {
  const started = performance.now();
  const response = await client.callTool({ name: `rapidraw_${name}`, arguments: args }, { timeout: 900000 });
  records.push({
    name,
    args,
    elapsed_ms: Math.round(performance.now() - started),
    result: response.structuredContent,
    isError: !!response.isError,
  });
  assert.equal(!!response.isError, expectError, JSON.stringify(response.structuredContent ?? response.content));
  return response;
}
async function data(name, args) {
  return (await call(name, args)).structuredContent;
}
async function waitJob(id) {
  const start = performance.now();
  let reported = '';
  while (performance.now() - start < 900000) {
    const state = await data('get_job', { job_id: id });
    const report = `${state.status} ${Math.floor(state.progress_percent / 10) * 10}% ${state.stage}`;
    if (report !== reported) {
      console.log(report);
      reported = report;
    }
    if (!['running', 'cancelling'].includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Job did not finish within 15 minutes');
}
async function render(session, label, region) {
  const response = await call('render', {
    session_id: session,
    format: 'png',
    long_edge: region ? 768 : 1600,
    ...(region ? { region } : {}),
  });
  const block = response.content.find((c) => c.type === 'image');
  assert.ok(block, 'Native render must return pixels');
  const path = join(review, `${label}.png`);
  await writeFile(path, Buffer.from(block.data, 'base64'));
  return path;
}
let failure;
try {
  await connect();
  await data('capabilities', { detail: 'overview' });
  const settings = await data('get_engine_settings');
  const models = await data('models');
  assert.equal(models.groups?.nonlocal?.configured ?? models.nonlocal?.configured, true, JSON.stringify(models));
  const opened = await data('open_photo', { path: resolve(source), inherit_sidecar: false });
  assert.equal(opened.is_raw, true);
  await data('set_adjustments', { session_id: opened.session_id, patch: { exposure: 0.35, temperature: 8 } });
  const parent = await data('get_session', { session_id: opened.session_id, include_adjustments: true });
  const zero = await data('start_denoise', {
    session_id: parent.session_id,
    method: 'nonlocal',
    intensity: 0,
    expected_revision: parent.revision,
  });
  const zeroJob = await waitJob(zero.job_id);
  assert.equal(zeroJob.status, 'succeeded', JSON.stringify(zeroJob));
  const baseline = await render(parent.session_id, 'original');
  await render(zeroJob.result_session_id, 'zero-strength');
  const rejected = await call(
    'start_denoise',
    { session_id: parent.session_id, method: 'nonlocal', quality: 'maximum' },
    true,
  );
  assert.match(JSON.stringify(rejected), /quality/i);
  // Cancel after CUDA begins, then restart the same immutable snapshot with
  // resume_job.
  let job = await data('start_denoise', {
    session_id: parent.session_id,
    method: 'nonlocal',
    expected_revision: parent.revision,
  });
  for (let i = 0; i < 120; i++) {
    const state = await data('get_job', { job_id: job.job_id });
    if (state.stage.includes('CUDA') || state.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const cancellation = await data('cancel_job', { job_id: job.job_id });
  assert.equal(cancellation.status, 'cancelling', 'Use a fresh workspace to exercise uncached cancellation');
  const cancelled = await waitJob(job.job_id);
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  job = await data('resume_job', { job_id: job.job_id });
  assert.equal(job.attempt, 2);
  await data('set_adjustments', { session_id: parent.session_id, patch: { exposure: 0.8 } });
  const completed = await waitJob(job.job_id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  const result = await data('get_session', { session_id: completed.result_session_id, include_adjustments: true });
  assert.equal(result.is_raw, true);
  assert.match(result.source_path, /\.dng$/);
  assert.deepEqual(result.dimensions, parent.dimensions);
  assert.deepEqual(result.adjustments, parent.adjustments, 'Result must retain captured edits');
  assert.equal(result.metadata.derivedFrom.nonlocal.cache_hit, false);
  // Native provenance carries backend generation instead of the retired
  // Python-worker sampler field. Assert the generation matches the provider
  // under test so CPU and CoreML runs are distinguishable.
  const expectedBackend =
    (process.env.RAPIDRAW_NONLOCAL_PROVIDER ?? 'cpu') === 'coreml' ? 'native-coreml-v1' : 'native-onnx-v1';
  assert.equal(result.metadata.derivedFrom.nonlocal.backend, expectedBackend);
  assert.equal(result.metadata.derivedFrom.nonlocal.algorithm, 'nonlocal-raw-v1');
  assert.equal(hash(await readFile(source)), originalHash);
  await data('set_adjustments', { session_id: parent.session_id, patch: { exposure: 0.35 } });
  const width = result.dimensions.width,
    height = result.dimensions.height;
  const region = { x: Math.floor(width / 2 - 384), y: Math.floor(height / 2 - 384), width: 768, height: 768 };
  await render(parent.session_id, 'original-detail', region);
  const denoised = await render(result.session_id, 'nonlocal');
  await render(result.session_id, 'nonlocal-detail', region);
  // DNG standalone open and durable derived session must use the same pipeline.
  const reopened = await data('open_photo', { path: result.source_path, inherit_sidecar: false });
  await data('set_adjustments', { session_id: reopened.session_id, patch: result.adjustments, mode: 'replace' });
  const standalone = await render(reopened.session_id, 'standalone-dng');
  assert.equal(hash(await readFile(standalone)), hash(await readFile(denoised)));
  const cached = await data('start_denoise', { session_id: parent.session_id, method: 'nonlocal', intensity: 50 });
  const cachedJob = await waitJob(cached.job_id);
  assert.equal(cachedJob.status, 'succeeded', JSON.stringify(cachedJob));
  const half = await data('get_session', { session_id: cachedJob.result_session_id, include_adjustments: true });
  assert.equal(half.metadata.derivedFrom.nonlocal.cache_hit, true);
  await render(half.session_id, 'nonlocal-half');
  await client.close();
  await connect();
  assert.equal((await data('get_job', { job_id: completed.job_id })).status, 'succeeded');
  const persisted = await render(result.session_id, 'persisted');
  assert.equal(hash(await readFile(persisted)), hash(await readFile(denoised)));
  const jpeg = await data('open_photo', { path: baseline, inherit_sidecar: false });
  await call('start_denoise', { session_id: jpeg.session_id, method: 'nonlocal' }, true);
  assert.equal(hash(await readFile(source)), originalHash);
  await writeFile(
    join(review, 'result.json'),
    JSON.stringify(
      { parent, result, half, settings, models, source_sha256: originalHash, completed, cache_job: cachedJob },
      null,
      2,
    ),
  );
  console.log(
    'PASS: native Bayer DNG, captured edits, standalone reopen, CUDA cancellation/resume, cache blend, persistence, RGB rejection, source identity',
  );
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  if (client) await client.close();
  await writeFile(join(review, 'calls.json'), JSON.stringify({ passed: !failure, failure, records }, null, 2));
}
