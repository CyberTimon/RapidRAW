import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { OperationJobs } from '../dist/operation-jobs.js';

const binary = fileURLToPath(new URL('./fixtures/operation-worker.mjs', import.meta.url));
async function setup(t, env = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rapidraw-operation-test-')));
  const bundle = join(workspace, 'bundles', 'captured');
  await mkdir(bundle, { recursive: true });
  await mkdir(join(workspace, 'models'));
  const models = { models_directory: join(workspace, 'models'), groups: {} };
  const calls = [];
  const bridge = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'models') return models;
      if (params.session_id === 'capture-failure') throw new Error('capture failed');
      return method === 'export_session_bundle'
        ? { path: bundle, manifest_sha256: '0'.repeat(64) }
        : {
            session_id: 'parent-result',
            working_path: join(workspace, 'sessions', 'parent-result', 'source.tiff'),
            revision: 3,
            alive: true,
          };
    },
  };
  const options = { binary, workspace, env: { ...process.env, ...env }, timeoutMs: 2000, log: () => {} };
  const manager = new OperationJobs(bridge, options);
  t.after(() => manager.close());
  return { manager, workspace, bridge, options, calls, models };
}
async function modelGroup(context, kind, contents) {
  const assets = [];
  for (const [name, content] of Object.entries(contents)) {
    const path = join(context.workspace, 'models', name);
    await writeFile(path, content);
    assets.push({
      name,
      path,
      expected_sha256: createHash('sha256').update(content).digest('hex'),
      present: true,
      verified: true,
      installed_app_copy_available: false,
    });
  }
  context.models.groups[kind] = { ready: true, assets };
  return assets;
}
async function wait(manager, id, predicate = (job) => job.status !== 'running') {
  for (let i = 0; i < 200; i++) {
    const job = await manager.dispatch('get_operation_job', { job_id: id });
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Worker did not reach expected state');
}
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transitionFixture(manager, operation = 'export') {
  const job = {
    job_id: '11111111-1111-4111-8111-111111111111',
    operation,
    arguments: {},
    status: 'running',
    stage: 'Captured input',
    attempt: 1,
    created_at: '',
    updated_at: '',
  };
  let durable = structuredClone(job);
  // In-memory persistence makes read/write interleavings deterministic. Native
  // process lifecycle and filesystem persistence have separate tests below.
  manager.init = async () => {};
  manager.read = async () => structuredClone(durable);
  manager.save = async (current) => {
    durable = structuredClone(current);
  };
  return job;
}
test('cancellation cannot be overwritten by a progress write already in flight', async (t) => {
  const { manager } = await setup(t);
  const job = transitionFixture(manager);
  const entered = gate(),
    release = gate();
  const save = manager.save.bind(manager);
  manager.save = async (current) => {
    if (current.stage === 'Delayed progress') {
      entered.resolve();
      await release.promise;
    }
    await save(current);
  };
  manager.active = { id: job.job_id, worker: { async close() {} }, completion: Promise.resolve() };
  const progress = manager.stage(job, 'Delayed progress');
  await entered.promise;
  const cancelling = manager.dispatch('cancel_operation_job', { job_id: job.job_id });
  // All runnable in-memory transitions drain before releasing the blocked
  // write; the old unguarded cancellation could finish its save in this turn.
  await nextTurn();
  release.resolve();
  await progress;
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, undefined);
  await assert.rejects(manager.stage(job, 'Late result'), { code: 'JOB_CANCELLED' });
  assert.equal((await manager.read(job.job_id)).status, 'cancelled');
});
test('result import and success win together over cancellation after publication starts', async (t) => {
  const { manager, workspace, bridge, calls } = await setup(t);
  const job = transitionFixture(manager, 'negative_convert');
  const bundle = join(workspace, 'operation-jobs', job.job_id, 'attempt-1', 'bundles', 'result');
  await mkdir(bundle, { recursive: true });
  const entered = gate(),
    release = gate();
  const request = bridge.request.bind(bridge);
  bridge.request = async (method, params) => {
    if (method === 'import_session_bundle') {
      entered.resolve();
      await release.promise;
    }
    return request(method, params);
  };
  const worker = {
    async request(method) {
      return method === 'export_session_bundle'
        ? { path: bundle, manifest_sha256: '0'.repeat(64) }
        : { session_id: 'worker-result' };
    },
    async close() {},
  };
  const completion = manager.run(job, worker);
  manager.active = { id: job.job_id, worker, completion };
  await entered.promise;
  const cancelling = manager.dispatch('cancel_operation_job', { job_id: job.job_id });
  await nextTurn();
  release.resolve();
  await completion;
  const completed = await cancelling;
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.session_id, 'parent-result');
  assert.equal(calls.filter((call) => call.method === 'import_session_bundle').length, 1);
});
test('cancellation before publication prevents parent import and survives the worker catch path', async (t) => {
  const { manager, workspace, calls } = await setup(t);
  const job = transitionFixture(manager, 'negative_convert');
  const bundle = join(workspace, 'operation-jobs', job.job_id, 'attempt-1', 'bundles', 'result');
  await mkdir(bundle, { recursive: true });
  const exporting = gate(),
    release = gate(),
    cancellationSaved = gate();
  const save = manager.save.bind(manager);
  manager.save = async (current) => {
    await save(current);
    if (current.status === 'cancelled') cancellationSaved.resolve();
  };
  const worker = {
    async request(method) {
      if (method === 'export_session_bundle') {
        exporting.resolve();
        await release.promise;
        return { path: bundle, manifest_sha256: '0'.repeat(64) };
      }
      return { session_id: 'worker-result' };
    },
    async close() {},
  };
  const completion = manager.run(job, worker);
  manager.active = { id: job.job_id, worker, completion };
  await exporting.promise;
  const cancelling = manager.dispatch('cancel_operation_job', { job_id: job.job_id });
  await cancellationSaved.promise;
  release.resolve();
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error, undefined);
  assert.equal(cancelled.result, undefined);
  assert.equal(calls.filter((call) => call.method === 'import_session_bundle').length, 0);
});
test('repeated immediate cancellation remains cancelled after native worker teardown', async (t) => {
  const { manager, calls } = await setup(t, { FAKE_OPERATION_STALL: '1' });
  for (let i = 0; i < 12; i++) {
    const started = await manager.dispatch('start_operation', {
      operation: 'export',
      arguments: { session_id: 'source', path: `cancel-${i}.png` },
    });
    const cancelled = await manager.dispatch('cancel_operation_job', { job_id: started.job_id });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error, undefined);
    assert.equal(cancelled.result, undefined);
    assert.equal((await manager.dispatch('get_operation_job', { job_id: started.job_id })).status, 'cancelled');
  }
  assert.equal(calls.filter((call) => call.method === 'import_session_bundle').length, 0);
});
test('enhancement captures graph and receipt, rebinds revision, and preserves options', async (t) => {
  const context = await setup(t);
  await modelGroup(context, 'enhance-upscale', {
    'swinir_lightweight_x2.onnx': 'graph',
    'swinir_lightweight_x2.onnx.json': 'receipt',
  });
  const request = { operation: 'upscale', profile: 'fast', provider: 'cpu', region: [10, 20, 100, 80] };
  const start = await context.manager.dispatch('start_operation', {
    operation: 'enhance',
    arguments: { session_id: 'source', expected_revision: 7, request },
  });
  const done = await wait(context.manager, start.job_id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(done.result.params.request, request);
  assert.equal(done.result.params.expected_revision, 11, 'Worker must use the imported snapshot revision');
  assert.deepEqual(done.result.models, {
    'swinir_lightweight_x2.onnx': 'graph',
    'swinir_lightweight_x2.onnx.json': 'receipt',
  });
  assert.equal(context.calls.find((call) => call.method === 'export_session_bundle').params.expected_revision, 7);
});
test('enhancement refuses missing revision or uninstalled models before creating a durable job', async (t) => {
  const context = await setup(t);
  await assert.rejects(
    context.manager.dispatch('start_operation', {
      operation: 'enhance',
      arguments: { session_id: 'source', request: { operation: 'deblur' } },
    }),
    /requires expected_revision/,
  );
  context.models.groups['enhance-deblur'] = { ready: false, assets: [] };
  await assert.rejects(
    context.manager.dispatch('start_operation', {
      operation: 'enhance',
      arguments: { session_id: 'source', expected_revision: 0, request: { operation: 'deblur' } },
    }),
    { code: 'MODEL_NOT_INSTALLED' },
  );
  assert.equal((await context.manager.dispatch('list_operation_jobs', {})).jobs.length, 0);
});
test('capture and invalid-input failures leave job listing and reconnect usable', async (t) => {
  const { manager, workspace, bridge, options } = await setup(t);
  await assert.rejects(
    manager.dispatch('start_operation', {
      operation: 'export',
      arguments: { session_id: 'capture-failure', path: 'delivery.png' },
    }),
    /capture failed/,
  );
  await assert.rejects(
    manager.dispatch('start_operation', { operation: 'merge', arguments: { paths: [], kind: 'hdr' } }),
  );
  assert.equal((await manager.dispatch('list_operation_jobs', {})).jobs.length, 0);
  assert.equal(
    (await readdir(join(workspace, 'operation-jobs'))).length,
    0,
    'Failed capture must not leave poisonous partial jobs',
  );
  const reopened = new OperationJobs(bridge, options);
  t.after(() => reopened.close());
  assert.equal((await reopened.dispatch('list_operation_jobs', {})).jobs.length, 0);
});
test('completed worker imports durable result and survives reconnect without replay', async (t) => {
  const { manager, bridge, options, calls } = await setup(t);
  const start = await manager.dispatch('start_operation', {
    operation: 'negative_convert',
    arguments: { session_id: 'source', parameters: {} },
  });
  const done = await wait(manager, start.job_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.session_id, 'parent-result');
  assert.equal(calls.filter((call) => call.method === 'import_session_bundle').length, 1);
  assert.equal(done.result.working_path, join(options.workspace, 'sessions', 'parent-result', 'source.tiff'));
  assert.equal(done.result.revision, 3);
  assert.equal(
    calls.find((call) => call.method === 'import_session_bundle').params.expected_manifest_sha256,
    '0'.repeat(64),
  );
  await manager.close();
  const reopened = new OperationJobs(bridge, options);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.dispatch('get_operation_job', { job_id: start.job_id })).result, done.result);
  assert.equal(calls.filter((call) => call.method === 'import_session_bundle').length, 1);
  await assert.rejects(reopened.dispatch('resume_operation_job', { job_id: start.job_id }), {
    code: 'JOB_NOT_RESUMABLE',
  });
});
test('cancel terminates only worker; parent remains available and no result publishes', async (t) => {
  const { manager, bridge } = await setup(t, { FAKE_OPERATION_STALL: '1' });
  const start = await manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'delivery.png' },
  });
  await wait(manager, start.job_id, (job) => job.stage === 'Running export');
  const cancelled = await manager.dispatch('cancel_operation_job', { job_id: start.job_id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, undefined);
  assert.equal((await bridge.request('get_session', { session_id: 'source' })).alive, true);
  assert.equal((await manager.dispatch('cancel_operation_job', { job_id: start.job_id })).status, 'cancelled');
});
test('shutdown becomes interrupted and explicit resume preserves identity and increments attempt', async (t) => {
  const { manager, options, bridge } = await setup(t, { FAKE_OPERATION_STALL: '1' });
  const start = await manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'delivery.png' },
  });
  await wait(manager, start.job_id, (job) => job.stage === 'Running export');
  await manager.close();
  const reopened = new OperationJobs(bridge, { ...options, env: { ...process.env, FAKE_OPERATION_STALL: '0' } });
  t.after(() => reopened.close());
  assert.equal((await reopened.dispatch('get_operation_job', { job_id: start.job_id })).status, 'interrupted');
  const resumed = await reopened.dispatch('resume_operation_job', { job_id: start.job_id });
  assert.equal(resumed.job_id, start.job_id);
  assert.equal(resumed.attempt, 2);
  assert.equal((await wait(reopened, start.job_id)).status, 'succeeded');
});
test('corrupt captured merge sources fail before native execution', async (t) => {
  const { manager, workspace, options, bridge } = await setup(t, { FAKE_OPERATION_STALL: '1' });
  const sources = [join(workspace, 'one.png'), join(workspace, 'two.png')];
  for (const [i, path] of sources.entries()) await writeFile(path, `fixture-${i}`);
  const start = await manager.dispatch('start_operation', {
    operation: 'merge',
    arguments: { kind: 'hdr', paths: sources },
  });
  await wait(manager, start.job_id, (job) => job.stage === 'Running merge');
  await manager.close();
  const path = join(workspace, 'operation-jobs', start.job_id, 'job.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(manifest.sources[0].path, 'corrupt');
  const reopened = new OperationJobs(bridge, { ...options, env: { ...process.env, FAKE_OPERATION_STALL: '0' } });
  t.after(() => reopened.close());
  await reopened.dispatch('resume_operation_job', { job_id: start.job_id });
  const failed = await wait(reopened, start.job_id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /hash mismatch/);
});
test('malformed manifests reject invalid status and attempt without launching', async (t) => {
  const { manager, workspace } = await setup(t);
  const id = '11111111-1111-4111-8111-111111111111';
  await mkdir(join(workspace, 'operation-jobs', id), { recursive: true });
  await writeFile(
    join(workspace, 'operation-jobs', id, 'job.json'),
    JSON.stringify({ job_id: id, operation: 'export', status: 'unexpected', attempt: -1, arguments: null }),
  );
  await assert.rejects(manager.dispatch('get_operation_job', { job_id: id }), /invalid|malformed/i);
});
test('engine settings are captured for worker and later parent edits do not affect them', async (t) => {
  const { manager, workspace } = await setup(t);
  const settings = { theme: 'dark', processingPrecision: 'f32' };
  await writeFile(join(workspace, 'engine-settings.json'), JSON.stringify(settings));
  const start = await manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'delivery.png' },
  });
  await writeFile(join(workspace, 'engine-settings.json'), JSON.stringify({ theme: 'light' }));
  const done = await wait(manager, start.job_id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result.settings, settings);
});
test('remote generation and credential arguments never persist', async (t) => {
  const { manager, workspace } = await setup(t);
  await assert.rejects(
    manager.dispatch('start_operation', {
      operation: 'retouch',
      arguments: { session_id: 'source', mode: 'generative' },
    }),
  );
  await assert.rejects(
    manager.dispatch('start_operation', {
      operation: 'export',
      arguments: { session_id: 'source', token: 'do-not-save', path: 'out.png' },
    }),
  );
  assert.equal((await readdir(join(workspace, 'operation-jobs'))).length, 0);
});
test('captured paths reject sibling prefixes, traversal and symlink substitution', async (t) => {
  const { manager, workspace, options, bridge } = await setup(t, { FAKE_OPERATION_STALL: '1' });
  const start = await manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'delivery.png' },
  });
  await wait(manager, start.job_id, (job) => job.stage === 'Running export');
  await manager.close();
  const manifestPath = join(workspace, 'operation-jobs', start.job_id, 'job.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  const escaped = join(workspace, 'bundles-escape', 'captured');
  await mkdir(escaped, { recursive: true });
  for (const path of [escaped, join(workspace, 'bundles') + '/../bundles-escape/captured']) {
    await writeFile(manifestPath, JSON.stringify({ ...original, bundle: path }));
    const reopened = new OperationJobs(bridge, options);
    t.after(() => reopened.close());
    const listing = await reopened.dispatch('list_operation_jobs', {});
    assert.equal(listing.invalid_jobs.length, 1);
    assert.match(listing.invalid_jobs[0].error.message, /managed directory|INVALID_PATH/);
    await assert.rejects(
      reopened.dispatch('resume_operation_job', { job_id: start.job_id }),
      /managed directory|INVALID_PATH/,
    );
  }
  if (process.platform !== 'win32') {
    const linked = join(workspace, 'bundles', 'linked');
    await symlink(escaped, linked);
    await writeFile(manifestPath, JSON.stringify({ ...original, bundle: linked }));
    const reopened = new OperationJobs(bridge, options);
    t.after(() => reopened.close());
    const listing = await reopened.dispatch('list_operation_jobs', {});
    assert.equal(listing.invalid_jobs.length, 1);
    assert.match(listing.invalid_jobs[0].error.message, /symlinks/);
    await assert.rejects(reopened.dispatch('resume_operation_job', { job_id: start.job_id }), /symlinks/);
  }
});

test('missing captured dependencies stay visible as invalid jobs instead of disappearing', async (t) => {
  const { manager, workspace, options, bridge } = await setup(t, { FAKE_OPERATION_STALL: '1' });
  const start = await manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'delivery.png' },
  });
  await wait(manager, start.job_id, (job) => job.stage === 'Running export');
  await manager.close();
  await rm(join(workspace, 'bundles', 'captured'), { recursive: true });
  const reopened = new OperationJobs(bridge, options);
  t.after(() => reopened.close());
  const listing = await reopened.dispatch('list_operation_jobs', {});
  assert.equal(listing.jobs.length, 0);
  assert.equal(listing.invalid_jobs[0].job_id, start.job_id);
  assert.equal(listing.invalid_jobs[0].error.code, 'INVALID_JOB');
  await assert.rejects(reopened.dispatch('resume_operation_job', { job_id: start.job_id }), { code: 'INVALID_JOB' });
  const manifest = JSON.parse(await readFile(join(workspace, 'operation-jobs', start.job_id, 'job.json'), 'utf8'));
  assert.equal(manifest.job_id, start.job_id, 'The durable job record is retained for diagnosis');
});

test('malformed jobs do not poison reconnect, valid listing or newly captured work', async (t) => {
  const { manager, workspace, options, bridge } = await setup(t);
  const good = await manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'good.png' },
  });
  assert.equal((await wait(manager, good.job_id)).status, 'succeeded');
  await manager.close();
  const bad = '11111111-1111-4111-8111-111111111111';
  const directory = join(workspace, 'operation-jobs', bad);
  await mkdir(directory);
  const original = 'unfinished JSON {';
  await writeFile(join(directory, 'job.json'), original);
  const reopened = new OperationJobs(bridge, options);
  t.after(() => reopened.close());
  const listing = await reopened.dispatch('list_operation_jobs', {});
  assert.equal(listing.jobs[0].job_id, good.job_id);
  assert.equal(listing.invalid_jobs[0].job_id, bad);
  await assert.rejects(reopened.dispatch('get_operation_job', { job_id: bad }), { code: 'INVALID_JOB' });
  const fresh = await reopened.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'fresh.png' },
  });
  assert.equal((await wait(reopened, fresh.job_id)).status, 'succeeded');
  assert.equal(await readFile(join(directory, 'job.json'), 'utf8'), original);
});

test('AI workers receive verified parent-only models and preserve captured bytes after parent edits', async (t) => {
  for (const operation of ['mask_generate', 'generate_depth'])
    await t.test(operation, async (t) => {
      const context = await setup(t);
      const contents = { 'encoder.onnx': 'encoder-v1', 'decoder.onnx': 'decoder-v1' };
      const assets = await modelGroup(context, 'masks', contents);
      const started = await context.manager.dispatch('start_operation', {
        operation,
        arguments: { session_id: 'source', kind: 'sky' },
      });
      for (const asset of assets) await writeFile(asset.path, 'new-parent-model');
      const done = await wait(context.manager, started.job_id);
      assert.equal(done.status, 'succeeded');
      assert.deepEqual(done.result.models, contents);
      assert.deepEqual(done.captured_models, { kind: 'masks', count: 2 });
      assert.equal(
        context.calls.some((call) => call.method === 'install_model'),
        false,
        'Capture must never request model downloads',
      );
    });
});

test('inpaint captures only its required model group and model-free retouch remains independent', async (t) => {
  const context = await setup(t);
  const contents = { 'lama.onnx': 'inpaint-only' };
  await modelGroup(context, 'inpaint', contents);
  const started = await context.manager.dispatch('start_operation', {
    operation: 'retouch',
    arguments: { session_id: 'source', mode: 'inpaint', sub_masks: [] },
  });
  const done = await wait(context.manager, started.job_id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result.models, contents);
  const modelCalls = context.calls.filter((call) => call.method === 'models').length;
  const local = await context.manager.dispatch('start_operation', {
    operation: 'retouch',
    arguments: { session_id: 'source', mode: 'clone', sub_masks: [] },
  });
  assert.equal((await wait(context.manager, local.job_id)).status, 'succeeded');
  assert.equal(context.calls.filter((call) => call.method === 'models').length, modelCalls);
});

test('partial, corrupt and stale parent model sets fail capture before worker execution', async (t) => {
  for (const condition of ['partial', 'corrupt', 'stale-hash'])
    await t.test(condition, async (t) => {
      const context = await setup(t);
      const assets = await modelGroup(context, 'masks', { 'one.onnx': 'one', 'two.onnx': 'two' });
      if (condition === 'partial') {
        await rm(assets[1].path);
        assets[1].present = false;
        assets[1].verified = false;
        context.models.groups.masks.ready = false;
        for (const asset of assets) asset.installed_app_copy_available = true;
      } else {
        await writeFile(assets[0].path, 'corrupt');
        if (condition === 'corrupt') {
          assets[0].verified = false;
          context.models.groups.masks.ready = false;
        }
      }
      await assert.rejects(
        context.manager.dispatch('start_operation', {
          operation: 'mask_generate',
          arguments: { session_id: 'source', kind: 'sky' },
        }),
        { code: condition === 'stale-hash' ? 'MODEL_CHANGED' : 'MODEL_NOT_INSTALLED' },
      );
      assert.equal((await readdir(join(context.workspace, 'operation-jobs'))).length, 0);
      assert.equal(
        context.calls.some((call) => call.method === 'export_session_bundle'),
        false,
      );
    });
});

test('captured models survive reconnect and resume independently of parent assets', async (t) => {
  const context = await setup(t, { FAKE_OPERATION_STALL: '1' });
  const contents = { 'depth.onnx': 'captured-depth' };
  const assets = await modelGroup(context, 'masks', contents);
  const start = await context.manager.dispatch('start_operation', {
    operation: 'generate_depth',
    arguments: { session_id: 'source' },
  });
  await wait(context.manager, start.job_id, (job) => job.stage === 'Running generate_depth');
  await context.manager.close();
  await rm(assets[0].path);
  const reopened = new OperationJobs(context.bridge, {
    ...context.options,
    env: { ...process.env, FAKE_OPERATION_STALL: '0' },
  });
  t.after(() => reopened.close());
  await reopened.dispatch('resume_operation_job', { job_id: start.job_id });
  const done = await wait(reopened, start.job_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.attempt, 2);
  assert.deepEqual(done.result.models, contents);
});

test('changed captured model hashes block resume without altering the durable attempt', async (t) => {
  const context = await setup(t, { FAKE_OPERATION_STALL: '1' });
  await modelGroup(context, 'masks', { 'depth.onnx': 'captured-depth' });
  const start = await context.manager.dispatch('start_operation', {
    operation: 'generate_depth',
    arguments: { session_id: 'source' },
  });
  await wait(context.manager, start.job_id, (job) => job.stage === 'Running generate_depth');
  await context.manager.close();
  const manifestPath = join(context.workspace, 'operation-jobs', start.job_id, 'job.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifest.models.assets[0].path, 'changed-capture');
  const reopened = new OperationJobs(context.bridge, context.options);
  t.after(() => reopened.close());
  await assert.rejects(reopened.dispatch('resume_operation_job', { job_id: start.job_id }), { code: 'MODEL_CHANGED' });
  const kept = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(kept.attempt, 1);
  assert.equal(kept.status, 'interrupted');
  await assert.rejects(readFile(join(context.workspace, 'operation-jobs', start.job_id, 'attempt-2', 'worker.pid')), {
    code: 'ENOENT',
  });
});

test('empty parent model workspace retains native installed-app fallback without downloads', async (t) => {
  const context = await setup(t);
  const assets = await modelGroup(context, 'masks', { 'depth.onnx': 'app-model' });
  await rm(assets[0].path);
  Object.assign(assets[0], { present: false, verified: false, installed_app_copy_available: true });
  context.models.groups.masks.ready = false;
  const started = await context.manager.dispatch('start_operation', {
    operation: 'generate_depth',
    arguments: { session_id: 'source' },
  });
  const done = await wait(context.manager, started.job_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.captured_models, undefined);
  assert.deepEqual(done.result.models, {});
  assert.equal(
    context.calls.some((call) => call.method === 'install_model'),
    false,
  );
});

test('subject refinement guards parent capture then uses imported worker revision', async (t) => {
  const context = await setup(t);
  await modelGroup(context, 'masks', { 'encoder.onnx': 'encoder', 'decoder.onnx': 'decoder' });
  const args = {
    session_id: 'parent',
    kind: 'subject',
    expected_revision: 7,
    refine: { mask_id: 'mask', sub_mask_id: 'subject' },
    exclude_points: [{ x: 8, y: 9 }],
  };
  await assert.rejects(
    context.manager.dispatch('start_operation', {
      operation: 'mask_generate',
      arguments: { ...args, expected_revision: undefined },
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.equal(context.calls.filter((call) => call.method === 'export_session_bundle').length, 0);
  const start = await context.manager.dispatch('start_operation', { operation: 'mask_generate', arguments: args });
  const done = await wait(context.manager, start.job_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(context.calls.find((call) => call.method === 'export_session_bundle').params.expected_revision, 7);
  assert.equal(done.result.params.expected_revision, 11);
  assert.deepEqual(done.result.params.refine, args.refine);
  assert.deepEqual(done.result.params.exclude_points, args.exclude_points);
});

test('in-parent AI generation guards capture and uses the imported worker revision', async (t) => {
  const context = await setup(t);
  await modelGroup(context, 'masks', { 'encoder.onnx': 'encoder', 'decoder.onnx': 'decoder' });
  const args = {
    session_id: 'parent',
    kind: 'subject',
    target_mask_id: 'depth-parent',
    mode: 'intersect',
    expected_revision: 7,
    region: { x: 1, y: 2, width: 20, height: 30 },
  };
  await assert.rejects(
    context.manager.dispatch('start_operation', {
      operation: 'mask_generate',
      arguments: { ...args, expected_revision: undefined },
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  const start = await context.manager.dispatch('start_operation', { operation: 'mask_generate', arguments: args });
  const done = await wait(context.manager, start.job_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(context.calls.find((call) => call.method === 'export_session_bundle').params.expected_revision, 7);
  assert.equal(done.result.params.expected_revision, 11);
  assert.equal(done.result.params.target_mask_id, 'depth-parent');
  assert.equal(done.result.params.mode, 'intersect');
});

test('starting after terminal status waits for prior native process teardown', async (t) => {
  const context = await setup(t, { FAKE_CLOSE_DELAY_MS: '250' });
  const first = await context.manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'one.png' },
  });
  const done = await wait(context.manager, first.job_id);
  assert.equal(done.status, 'succeeded');
  const pid = Number(
    await readFile(join(context.workspace, 'operation-jobs', first.job_id, 'attempt-1', 'worker.pid'), 'utf8'),
  );
  const second = await context.manager.dispatch('start_operation', {
    operation: 'export',
    arguments: { session_id: 'source', path: 'two.png' },
  });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.notEqual(second.job_id, first.job_id);
  assert.equal((await wait(context.manager, second.job_id)).status, 'succeeded');
});
