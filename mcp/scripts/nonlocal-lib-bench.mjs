/** Benchmark-only native Nonlocal library A/B runner (one fresh job).
 *
 * Launches one fresh native engine + isolated workspace, opens a fixed RAW,
 * runs a single-pass nonlocal denoise at a fixed intensity, times
 * start→success, captures backend provenance, renders a deterministic PNG,
 * and records the engine's actually-mapped CUDA libraries from /proc maps.
 * Intended for N_S vs N_P comparisons where only process-local library
 * resolution differs (e.g. LD_LIBRARY_PATH cuDNN override for N_P).
 *
 * Env (all required unless noted):
 *   NLX_SERVER    MCP server entry (dist/index.js)
 *   NLX_BINARY    native RapidRAW engine binary
 *   NLX_RUN_DIR   fresh isolated workspace (must not exist; the runner
 *                 fails closed if it does, so cache/library state can never
 *                 be silently reused)
 *   NLX_RAW       absolute test RAW path
 *   NLX_INTENSITY denoise intensity (fixed across compared runs)
 *   NLX_TIMEOUT_MS optional (default 900000)
 *
 * The caller owns the display (xvfb), ORT_DYLIB_PATH, provider/bundle
 * policy env and any LD_LIBRARY_PATH override; everything is inherited.
 * Output: report.json + result.png under NLX_RUN_DIR. Exit nonzero on any
 * failure (no timing is reported on failure paths).
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { snapshotCudaMaps } from './cuda-lib-maps.mjs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const server = process.env.NLX_SERVER;
const binary = process.env.NLX_BINARY;
const runDir = process.env.NLX_RUN_DIR;
const raw = process.env.NLX_RAW;
const intensity = Number(process.env.NLX_INTENSITY ?? '50');
const timeoutMs = Number(process.env.NLX_TIMEOUT_MS ?? '900000');
assert.ok(server && binary && runDir && raw, 'Set NLX_SERVER/NLX_BINARY/NLX_RUN_DIR/NLX_RAW');
assert.ok(!Number.isNaN(intensity) && intensity > 0 && intensity <= 100, 'NLX_INTENSITY must be 1..100');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const binName = binary.split('/').pop();

function enginePids() {
  try {
    const out = execSync(`pgrep -x '${binName}' || true`, { encoding: 'utf8' });
    return new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function mapsSnapshot(pid) {
  return snapshotCudaMaps(pid);
}

async function requireFreshDir(path) {
  assert.ok(isAbsolute(path), 'NLX_RUN_DIR must be absolute');
  let existing = null;
  try {
    existing = await stat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  assert.equal(
    existing,
    null,
    `Refusing to reuse existing run directory (cache/library-state contamination risk): ${path}`,
  );
  await mkdir(path, { recursive: true });
}

const before = enginePids();
await requireFreshDir(runDir);
const sourceBytes = await readFile(raw);
const sourceHash = hash(sourceBytes);
let client;
const report = {
  run_dir: runDir,
  raw,
  source_sha256: sourceHash,
  intensity,
  ld_library_path: process.env.LD_LIBRARY_PATH ?? null,
  library_context: 'native-torch-free',
  nonlocal_provider: process.env.RAPIDRAW_NONLOCAL_PROVIDER ?? null,
  nonlocal_bundle: process.env.RAPIDRAW_NONLOCAL_BUNDLE ?? null,
  ort_dylib_path: process.env.ORT_DYLIB_PATH ?? null,
};
let failure;
try {
  client = new Client({ name: 'nonlocal-lib-bench', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(server), '--binary', binary, '--workspace', resolve(runDir), '--timeout-ms', String(timeoutMs)],
      stderr: 'inherit',
      env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    }),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name: `rapidraw_${name}`, arguments: args }, { timeout: timeoutMs });
    assert.equal(!!response.isError, false, JSON.stringify(response.structuredContent ?? response.content));
    return response;
  };
  const data = async (name, args) => (await call(name, args)).structuredContent;
  // capabilities takes no arguments on older servers; its result is not
  // needed for timing, so only the call's success matters here.
  await data('capabilities', {});
  const opened = await data('open_photo', { path: resolve(raw), inherit_sidecar: false });
  assert.equal(opened.is_raw, true, JSON.stringify(opened));
  report.opened = { session_id: opened.session_id, dimensions: opened.dimensions ?? null };
  const started = performance.now();
  const startedJob = await data('start_denoise', {
    session_id: opened.session_id,
    method: 'nonlocal',
    intensity,
  });
  let state;
  for (;;) {
    state = await data('get_job', { job_id: startedJob.job_id });
    if (!['running', 'cancelling'].includes(state.status)) break;
    if (performance.now() - started > timeoutMs) throw new Error('Native job exceeded timeout');
    await new Promise((r) => setTimeout(r, 1000));
  }
  report.job_wall_s = (performance.now() - started) / 1000;
  assert.equal(state.status, 'succeeded', JSON.stringify(state));
  const result = await data('get_session', { session_id: state.result_session_id, include_adjustments: true });
  report.provenance = result.metadata?.derivedFrom?.nonlocal ?? null;
  assert.equal(report.provenance?.backend, 'native-onnx-v1', JSON.stringify(report.provenance));
  assert.equal(report.provenance?.cache_hit, false, 'Fresh workspace must miss the prediction cache');
  assert.equal(report.provenance?.algorithm, 'nonlocal-raw-v1');
  report.result = { dimensions: result.dimensions, source_path: result.source_path };
  assert.deepEqual(result.dimensions, report.opened.dimensions);
  const rendered = await call('render', { session_id: state.result_session_id, format: 'png', long_edge: 1600 });
  const block = rendered.content.find((c) => c.type === 'image');
  assert.ok(block, 'Native render must return pixels');
  const pngPath = join(runDir, 'result.png');
  await writeFile(pngPath, Buffer.from(block.data, 'base64'));
  report.render_sha256 = hash(await readFile(pngPath));
  // Engine library identity while the native process is still alive.
  const after = enginePids();
  const fresh = [...after].filter((pid) => !before.has(pid));
  report.engine_pids_before = [...before];
  report.engine_pids_after = [...after];
  assert.ok(fresh.length >= 1, `Expected a fresh engine process, before=${[...before]} after=${[...after]}`);
  report.engine_pid = fresh[0];
  report.mapped_cuda_libraries = mapsSnapshot(fresh[0]);
  report.source_sha256_after = hash(await readFile(raw));
  assert.equal(report.source_sha256_after, sourceHash, 'Source RAW must be unchanged');
  await client.close();
  client = null;
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`wrote ${join(runDir, 'report.json')} wall=${report.job_wall_s.toFixed(1)}s`);
} catch (error) {
  failure = String(error?.stack ?? error);
  console.error(failure);
  try {
    await writeFile(join(runDir, 'failure.txt'), failure);
  } catch {}
  process.exitCode = 1;
} finally {
  if (client) await client.close();
}
