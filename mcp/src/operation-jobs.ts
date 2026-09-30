import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, open, rename, readdir, lstat, realpath, copyFile, rm } from 'node:fs/promises';
import { join, basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { copyIndependent } from './storage.js';
import { NativeBridge, BridgeError, type BridgeOptions, type JsonObject } from './bridge.js';

const methods = new Set([
  'merge',
  'export',
  'negative_convert',
  'mask_generate',
  'generate_depth',
  'retouch',
  'enhance',
]);
const jobMethods = [
  'start_operation',
  'get_operation_job',
  'list_operation_jobs',
  'cancel_operation_job',
  'resume_operation_job',
];
type Status = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
type ModelKind = 'masks' | 'inpaint' | `enhance-${'matting' | 'face' | 'landscape' | 'deblur' | 'upscale'}`;
interface CapturedModels {
  kind: ModelKind;
  assets: { name: string; path: string; sha256: string }[];
}
const modelKind = (operation: string, args: JsonObject): ModelKind | undefined => {
  if (
    operation === 'mask_generate' &&
    (args.kind === 'normals' || args.kind === 'albedo' || (args.kind === 'depth' && args.depth_provider === 'marigold'))
  )
    return undefined;
  if (operation === 'enhance') {
    const request = args.request as JsonObject | undefined;
    if (!request || typeof request !== 'object') return fail('INVALID_ARGUMENT', 'Enhancement request is required');
    switch (request.operation) {
      case 'refine_mask':
        return 'enhance-matting';
      case 'semantic_mask':
        return request.domain === 'face' ? 'enhance-face' : 'enhance-landscape';
      case 'deblur':
        return 'enhance-deblur';
      case 'upscale':
        return 'enhance-upscale';
      default:
        return fail('INVALID_ARGUMENT', 'Unknown enhancement operation');
    }
  }
  return operation === 'mask_generate' || operation === 'generate_depth'
    ? 'masks'
    : operation === 'retouch' && args.mode === 'inpaint'
      ? 'inpaint'
      : undefined;
};
const modelName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value);
interface OperationJob {
  job_id: string;
  operation: string;
  arguments: JsonObject;
  status: Status;
  stage: string;
  attempt: number;
  created_at: string;
  updated_at: string;
  bundle?: string;
  bundle_sha256?: string;
  sources?: { path: string; sha256: string }[];
  settings_sha256?: string;
  models?: CapturedModels;
  result?: JsonObject;
  error?: string;
}
const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const fail = (code: string, message: string): never => {
  throw new BridgeError(code, message);
};
const jobId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    fail('INVALID_ARGUMENT', 'Expected a job UUID');
  return value as string;
};

/** Segment-aware containment handles sibling prefixes and Windows separators. */
const inside = (root: string, path: string): boolean => {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  const child = relative(root, path);
  return (
    child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child) && resolve(path) === path
  );
};
const confined = async (root: string, path: unknown, kind: 'file' | 'directory'): Promise<string> => {
  if (typeof path !== 'string' || !inside(root, path))
    fail('INVALID_PATH', 'Captured asset must belong to its managed directory');
  const target = path as string;
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
    fail('INVALID_PATH', 'Managed asset root cannot be a symlink');
  let current = root;
  for (const component of relative(root, target).split(sep)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) fail('INVALID_PATH', 'Captured asset paths cannot contain symlinks');
  }
  const metadata = await lstat(target);
  if (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())
    fail('INVALID_PATH', `Expected a regular ${kind}`);
  const canonical = await realpath(target);
  if (!inside(root, canonical)) fail('INVALID_PATH', 'Captured asset escapes its managed directory');
  return canonical;
};

/** Expensive native operations run in an independent process and workspace.
 * Captured bundles/inputs are immutable; cancellation terminates only the worker.
 * Work is never replayed automatically after an uncertain result or disconnect.
 */
export class OperationJobs {
  static readonly methods = jobMethods;
  private root: string;
  private workspace: string;
  private active: { id: string; worker: NativeBridge; completion: Promise<void> } | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private transitions: Promise<unknown> = Promise.resolve();
  private initialized?: Promise<void>;
  private closing = false;
  constructor(
    private readonly bridge: NativeBridge,
    private readonly options: BridgeOptions,
  ) {
    this.workspace = options.workspace;
    this.root = join(options.workspace, 'operation-jobs');
  }
  private async init(): Promise<void> {
    this.initialized ??= (async () => {
      await mkdir(this.options.workspace, { recursive: true });
      this.workspace = await realpath(this.options.workspace);
      this.root = join(this.workspace, 'operation-jobs');
      await mkdir(this.root, { recursive: true });
      if ((await lstat(this.root)).isSymbolicLink() || (await realpath(this.root)) !== this.root)
        fail('INVALID_PATH', 'Operation jobs require a real directory inside the workspace');
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
        const job = await this.read(entry.name).catch((error) => {
          if (!(error instanceof BridgeError && error.code === 'JOB_NOT_FOUND'))
            this.options.log?.(`Operation job ${entry.name} requires repair: ${this.diagnostic(error).message}`);
          return undefined;
        });
        if (!job) continue;
        if (job.status === 'running') {
          job.status = 'interrupted';
          job.stage = 'Explicit resume required; captured work will restart';
          await this.save(job);
        }
      }
    })();
    await this.initialized;
  }
  private async read(id: string): Promise<OperationJob> {
    id = jobId(id);
    const directory = join(this.root, id);
    let manifestFound = false;
    try {
      await confined(this.root, directory, 'directory');
      const manifest = await confined(directory, join(directory, 'job.json'), 'file');
      if ((await lstat(manifest)).size > 64 * 1024 * 1024) fail('INVALID_JOB', 'Job manifest exceeds 64 MiB');
      const job = JSON.parse(await readFile(manifest, 'utf8')) as OperationJob;
      manifestFound = true;
      if (
        job.job_id !== id ||
        !methods.has(job.operation) ||
        !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status) ||
        !Number.isSafeInteger(job.attempt) ||
        job.attempt < 1 ||
        job.attempt > 1000 ||
        !job.arguments ||
        typeof job.arguments !== 'object' ||
        Array.isArray(job.arguments)
      )
        fail('INVALID_JOB', 'Invalid job identity, operation, attempt, state or arguments');
      if ('token' in job.arguments || job.arguments.mode === 'generative')
        fail('INVALID_JOB', 'Job cannot contain provider credentials or remote generation');
      if (job.bundle !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(job.bundle_sha256 ?? ''))
          fail('INVALID_JOB', 'Captured bundle must have a manifest SHA-256');
        await confined(join(this.workspace, 'bundles'), job.bundle, 'directory');
      }
      if (job.sources !== undefined) {
        if (!Array.isArray(job.sources) || job.sources.length < 2 || job.sources.length > 100)
          fail('INVALID_JOB', 'Invalid captured merge sources');
        for (const source of job.sources) {
          if (!source || !/^[a-f0-9]{64}$/.test(source.sha256)) fail('INVALID_JOB', 'Invalid captured source hash');
          await confined(join(directory, 'sources'), source.path, 'file');
        }
      }
      if (job.operation === 'merge' ? !job.sources || !!job.bundle : !job.bundle || !!job.sources)
        fail('INVALID_JOB', 'Captured inputs do not match operation');
      if (job.settings_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(job.settings_sha256))
        fail('INVALID_JOB', 'Invalid captured settings hash');
      if (job.models !== undefined) {
        const requiredKind = modelKind(job.operation, job.arguments);
        if (
          !requiredKind ||
          !job.models ||
          job.models.kind !== requiredKind ||
          !Array.isArray(job.models.assets) ||
          !job.models.assets.length ||
          job.models.assets.length > 32
        )
          fail('INVALID_JOB', 'Invalid captured model group');
        const names = new Set<string>();
        for (const asset of job.models.assets) {
          if (
            !asset ||
            !modelName(asset.name) ||
            names.has(asset.name) ||
            !/^[a-f0-9]{64}$/.test(asset.sha256) ||
            asset.path !== join(directory, 'models', asset.name)
          )
            fail('INVALID_JOB', 'Invalid captured model identity, path or hash');
          names.add(asset.name);
          await confined(join(directory, 'models'), asset.path, 'file');
        }
      }
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (manifestFound) fail('INVALID_JOB', `Operation job ${id} is missing a captured input or dependency`);
        fail('JOB_NOT_FOUND', `No operation job ${id}`);
      }
      if (error instanceof SyntaxError) fail('INVALID_JOB', `Operation job ${id} has invalid JSON`);
      throw error;
    }
  }
  private diagnostic(error: unknown): { code: string; message: string } {
    return {
      code: error instanceof BridgeError ? error.code : 'INVALID_JOB',
      message: error instanceof Error ? error.message : 'Invalid operation job',
    };
  }
  private async save(job: OperationJob): Promise<void> {
    job.updated_at = new Date().toISOString();
    const path = join(this.root, job.job_id, 'job.json');
    const temp = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temp, 'wx');
      await file.writeFile(JSON.stringify(job, null, 2));
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temp, path);
    } finally {
      await file?.close();
      await rm(temp, { force: true });
    }
  }
  private transition<T>(action: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(action);
    this.transitions = next.catch(() => undefined);
    return next;
  }
  private info(job: OperationJob): JsonObject {
    const { arguments: _arguments, bundle: _bundle, sources: _sources, models, ...info } = job;
    return {
      ...info,
      ...(models ? { captured_models: { kind: models.kind, count: models.assets.length } } : {}),
      progress: { kind: 'stage', stage: job.stage },
      recoverable: ['interrupted', 'failed', 'cancelled'].includes(job.status),
      recovery:
        'Explicit resume recomputes captured work in a new worker workspace. Cancellation terminates only the operation worker.',
    };
  }
  dispatch(method: string, params: JsonObject): Promise<JsonObject> {
    const task = this.serial.then(async () => {
      await this.init();
      if (this.closing) fail('BRIDGE_CLOSED', 'Operation job manager is closing');
      switch (method) {
        case 'start_operation':
          return this.start(params);
        case 'get_operation_job':
          return this.info(await this.read(jobId(params.job_id)));
        case 'list_operation_jobs': {
          const jobs = [],
            invalid_jobs = [];
          for (const entry of await readdir(this.root, { withFileTypes: true }))
            if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)) {
              try {
                jobs.push(this.info(await this.read(entry.name)));
              } catch (error) {
                if (!(error instanceof BridgeError && error.code === 'JOB_NOT_FOUND'))
                  invalid_jobs.push({ job_id: entry.name, error: this.diagnostic(error), recoverable: false });
              }
            }
          return { jobs, count: jobs.length, invalid_jobs };
        }
        case 'cancel_operation_job': {
          const id = jobId(params.job_id);
          const active = await this.transition(async () => {
            const job = await this.read(id);
            if (job.status !== 'running' || this.active?.id !== id) return undefined;
            job.status = 'cancelled';
            job.stage = 'Cancelled by caller';
            await this.save(job);
            return this.active;
          });
          // Worker completion may need the same transition queue for its catch
          // path. Release the state guard before waiting for process teardown.
          if (active) {
            await active.worker.close();
            await active.completion;
          }
          return this.info(await this.read(id));
        }
        case 'resume_operation_job': {
          await this.waitForFinishedWorker();
          const job = await this.read(jobId(params.job_id));
          if (!['interrupted', 'failed', 'cancelled'].includes(job.status))
            fail('JOB_NOT_RESUMABLE', 'Only interrupted, failed or cancelled work can restart');
          if (job.attempt >= 1000) fail('JOB_NOT_RESUMABLE', 'Operation job attempt limit reached');
          await this.verifyModels(job);
          job.attempt++;
          job.status = 'running';
          job.stage = 'Starting captured operation';
          delete job.error;
          delete job.result;
          await this.save(job);
          this.launch(job);
          return this.info(job);
        }
        default:
          return fail('UNKNOWN_METHOD', method);
      }
    });
    this.serial = task.catch(() => undefined);
    return task;
  }
  private async waitForFinishedWorker(): Promise<void> {
    if (!this.active) return;
    const previous = this.active;
    const state = await this.read(previous.id);
    // A reported terminal job may still be closing its native subprocess.
    // Complete that teardown before allowing either a new start or resume.
    if (state.status !== 'running') await previous.completion;
    if (this.active) fail('WORKER_BUSY', 'One operation worker may run at a time');
  }
  private async start(params: JsonObject): Promise<JsonObject> {
    await this.waitForFinishedWorker();
    const operation = String(params.operation);
    if (!methods.has(operation)) fail('INVALID_ARGUMENT', 'Unsupported background operation');
    if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))
      fail('INVALID_ARGUMENT', 'arguments must be an object');
    const args = structuredClone(params.arguments) as JsonObject;
    if (
      operation === 'enhance' &&
      (!Number.isSafeInteger(args.expected_revision) || (args.expected_revision as number) < 0)
    )
      fail('INVALID_ARGUMENT', 'Enhancement requires expected_revision before capturing its parent snapshot');
    if (
      operation === 'mask_generate' &&
      (args.refine !== undefined || args.target_mask_id !== undefined) &&
      (!Number.isSafeInteger(args.expected_revision) || (args.expected_revision as number) < 0)
    )
      fail(
        'INVALID_ARGUMENT',
        'In-parent mask generation requires expected_revision before capturing its parent snapshot',
      );
    if (operation === 'retouch' && args.mode === 'generative')
      fail(
        'INVALID_ARGUMENT',
        'Remote generation must use the explicit synchronous retouch call; credentials are never persisted in jobs',
      );
    if ('token' in args) fail('INVALID_ARGUMENT', 'Tokens cannot be stored in background jobs');
    const id = randomUUID();
    const directory = join(this.root, id);
    await mkdir(directory);
    const job: OperationJob = {
      job_id: id,
      operation,
      arguments: args,
      status: 'running',
      stage: 'Captured input',
      attempt: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      const kind = modelKind(operation, args);
      if (kind) {
        const captured = await this.captureModels(directory, kind);
        if (captured) job.models = captured;
      }
      const settings = join(this.workspace, 'engine-settings.json');
      const settingsInfo = await lstat(settings).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (settingsInfo) {
        if (!settingsInfo.isFile() || settingsInfo.isSymbolicLink())
          fail('INVALID_PATH', 'Engine settings must be a regular file');
        const target = join(directory, 'engine-settings.json');
        await copyFile(settings, target);
        job.settings_sha256 = await hashFile(target);
      }
      if (operation === 'merge') {
        if (
          !Array.isArray(args.paths) ||
          args.paths.length < 2 ||
          args.paths.length > 100 ||
          !['hdr', 'focus', 'panorama'].includes(String(args.kind))
        )
          fail('INVALID_ARGUMENT', 'Merge needs a valid kind and 2–100 absolute source paths');
        await mkdir(join(directory, 'sources'));
        job.sources = [];
        const paths = args.paths as string[];
        for (let i = 0; i < paths.length; i++) {
          const source = paths[i]!;
          if (typeof source !== 'string' || !isAbsolute(source) || !(await lstat(source)).isFile())
            fail('INVALID_PATH', 'Merge inputs must be absolute regular files');
          const target = join(directory, 'sources', `${i}-${basename(source)}`);
          const before = await hashFile(source);
          await copyIndependent(source, target);
          if ((await hashFile(target)) !== before || (await hashFile(source)) !== before)
            fail('SOURCE_CHANGED', 'Source changed during capture');
          job.sources.push({ path: target, sha256: before });
        }
        args.paths = job.sources.map((source) => source.path);
      } else {
        if (typeof args.session_id !== 'string') fail('INVALID_ARGUMENT', 'Operation needs session_id');
        const bundle = await this.bridge.request('export_session_bundle', {
          session_id: args.session_id,
          ...(args.expected_revision === undefined ? {} : { expected_revision: args.expected_revision }),
          name: `job-${id}`,
        });
        job.bundle = String(bundle.path ?? bundle.bundle_path);
        job.bundle_sha256 = String(bundle.manifest_sha256 ?? '');
        if (!/^[a-f0-9]{64}$/.test(job.bundle_sha256))
          fail('INVALID_BUNDLE', 'Native bundle export returned no valid manifest SHA-256');
        job.bundle = await confined(join(this.workspace, 'bundles'), job.bundle, 'directory');
        delete args.expected_revision;
        // Delivery paths always belong to this attempt's worker exports.
        if (operation === 'export') {
          if (typeof args.path !== 'string' || !basename(args.path))
            fail('INVALID_ARGUMENT', 'Export needs a filename');
          args.path = basename(args.path as string);
          args.overwrite = false;
        }
      }
      await this.save(job);
      this.launch(job);
      return this.info(job);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private async captureModels(directory: string, kind: ModelKind): Promise<CapturedModels | undefined> {
    const status = await this.bridge.request('models', {});
    const groups = status.groups as Record<string, unknown> | undefined;
    const group = groups?.[kind] as { ready?: unknown; assets?: unknown } | undefined;
    if (kind.startsWith('enhance-') && group?.ready === false)
      return fail(
        'MODEL_NOT_INSTALLED',
        `Install enhancement model '${kind.slice(8)}' before starting this operation.`,
      );
    if (
      status.models_directory !== join(this.workspace, 'models') ||
      !group ||
      !Array.isArray(group.assets) ||
      !group.assets.length ||
      group.assets.length > 32
    )
      fail('INVALID_MODEL_STATUS', 'Native models response lacks the required workspace model group');
    const modelRoot = await confined(this.workspace, status.models_directory, 'directory');
    const names = new Set<string>();
    const assets: {
      name: string;
      path: string;
      sha256: string;
      present: boolean;
      verified: boolean;
      installed: boolean;
    }[] = [];
    for (const raw of group!.assets as unknown[]) {
      const asset = raw as Record<string, unknown>;
      if (
        !asset ||
        !modelName(asset.name) ||
        names.has(asset.name) ||
        typeof asset.expected_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(asset.expected_sha256) ||
        asset.path !== join(modelRoot, asset.name) ||
        typeof asset.present !== 'boolean' ||
        typeof asset.verified !== 'boolean' ||
        typeof asset.installed_app_copy_available !== 'boolean'
      )
        fail('INVALID_MODEL_STATUS', 'Native model asset must have a safe name, confined path and expected SHA-256');
      const name = asset.name as string;
      names.add(name);
      const metadata = await lstat(asset.path as string).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (metadata && (!metadata.isFile() || metadata.isSymbolicLink()))
        fail('INVALID_PATH', `Workspace model ${asset.name} must be a regular file`);
      assets.push({
        name,
        path: asset.path as string,
        sha256: asset.expected_sha256 as string,
        present: !!metadata,
        verified: asset.verified === true && asset.present === !!metadata,
        installed: asset.installed_app_copy_available === true,
      });
    }
    if (assets.every((asset) => !asset.present) && assets.every((asset) => asset.installed)) {
      // The native worker retains its existing local installed-app fallback and
      // verifies each model hash before copying it; no download is requested.
      return undefined;
    }
    if (group!.ready !== true || assets.some((asset) => !asset.present || !asset.verified))
      fail(
        'MODEL_NOT_INSTALLED',
        `Required ${kind} model set is missing, partial or corrupt. Call install_model with kind='${kind}' in the parent workspace before starting this operation.`,
      );
    await mkdir(join(directory, 'models'));
    const captured: CapturedModels = { kind, assets: [] };
    for (const asset of assets) {
      const source = await confined(modelRoot, asset.path, 'file');
      if ((await hashFile(source)) !== asset.sha256)
        fail(
          'MODEL_CHANGED',
          `Workspace model ${asset.name} differs from its expected SHA-256; run install_model with kind='${kind}' before retrying.`,
        );
      const target = join(directory, 'models', asset.name);
      await copyIndependent(source, target);
      if ((await hashFile(target)) !== asset.sha256 || (await hashFile(source)) !== asset.sha256)
        fail(
          'MODEL_CHANGED',
          `Workspace model ${asset.name} changed during capture; run install_model with kind='${kind}' before retrying.`,
        );
      captured.assets.push({ name: asset.name, path: target, sha256: asset.sha256 });
    }
    return captured;
  }
  private async verifyModels(job: OperationJob): Promise<void> {
    const root = join(this.root, job.job_id, 'models');
    for (const asset of job.models?.assets ?? []) {
      await confined(root, asset.path, 'file');
      if ((await hashFile(asset.path)) !== asset.sha256)
        fail(
          'MODEL_CHANGED',
          `Captured model ${asset.name} has a SHA-256 mismatch. Start a new operation after repairing parent models with install_model; the captured job is preserved.`,
        );
    }
  }
  private launch(job: OperationJob): void {
    const workspace = join(this.root, job.job_id, `attempt-${job.attempt}`);
    const worker = new NativeBridge({ ...this.options, workspace, timeoutMs: 1_800_000 });
    const completion = this.run(job, worker)
      .catch((error: unknown) => {
        this.options.log?.(
          `Operation job ${job.job_id} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.active?.id === job.job_id) this.active = undefined;
      });
    this.active = { id: job.job_id, worker, completion };
  }
  private async stage(job: OperationJob, stage: string): Promise<void> {
    await this.transition(async () => {
      const current = await this.read(job.job_id);
      if (current.status !== 'running' || current.attempt !== job.attempt || this.closing)
        fail('JOB_CANCELLED', 'Worker result cannot publish after cancellation or shutdown');
      current.stage = stage;
      await this.save(current);
    });
  }
  private async run(job: OperationJob, worker: NativeBridge): Promise<void> {
    try {
      await this.stage(job, 'Restoring captured inputs');
      await this.verifyModels(job);
      if (job.models) {
        const modelRoot = join(this.root, job.job_id, `attempt-${job.attempt}`, 'models');
        await mkdir(modelRoot, { recursive: true });
        await confined(join(this.root, job.job_id), modelRoot, 'directory');
        for (const asset of job.models.assets) {
          const target = join(modelRoot, asset.name);
          await copyIndependent(asset.path, target);
          if ((await hashFile(target)) !== asset.sha256)
            fail('MODEL_CHANGED', `Captured model ${asset.name} changed while preparing the worker`);
        }
      }
      if (job.settings_sha256) {
        const directory = join(this.root, job.job_id);
        const settings = await confined(directory, join(directory, 'engine-settings.json'), 'file');
        if ((await hashFile(settings)) !== job.settings_sha256)
          fail('SETTINGS_CHANGED', 'Captured engine settings hash mismatch');
        const workspace = join(this.root, job.job_id, `attempt-${job.attempt}`);
        await mkdir(workspace, { recursive: true });
        await copyFile(settings, join(workspace, 'engine-settings.json'));
      }
      const args = structuredClone(job.arguments);
      for (const source of job.sources ?? [])
        if ((await hashFile(source.path)) !== source.sha256)
          fail('SOURCE_CHANGED', 'Captured merge input hash mismatch');
      if (job.sources) args.paths = job.sources.map((source) => source.path);
      if (job.bundle) {
        const imported = await worker.request('import_session_bundle', {
          path: job.bundle,
          ...(job.bundle_sha256 ? { expected_manifest_sha256: job.bundle_sha256 } : {}),
        });
        args.session_id = imported.session_id;
        if (
          job.operation === 'enhance' ||
          (job.operation === 'mask_generate' && (args.refine !== undefined || args.target_mask_id !== undefined))
        ) {
          // The parent revision guarded bundle capture. Refinement now guards
          // this independent imported snapshot, whose revision can differ.
          if (!Number.isSafeInteger(imported.revision) || (imported.revision as number) < 0)
            fail('INVALID_BUNDLE', 'Imported mask snapshot lacks its revision');
          args.expected_revision = imported.revision;
        }
      }
      await this.stage(job, `Running ${job.operation}`);
      const result = await worker.request(job.operation, args, 1_800_000);
      await this.stage(job, 'Persisting result');
      let publication: { path: string; expected_manifest_sha256: string } | undefined;
      if (job.operation !== 'export' && typeof result.session_id === 'string') {
        const bundle = await worker.request('export_session_bundle', { session_id: result.session_id });
        // Result import is serialized with edits by the parent NativeBridge.
        const bundlePath = await confined(
          join(this.root, job.job_id, `attempt-${job.attempt}`, 'bundles'),
          bundle.path ?? bundle.bundle_path,
          'directory',
        );
        if (typeof bundle.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.manifest_sha256))
          return fail('INVALID_BUNDLE', 'Worker result bundle lacks a valid manifest SHA-256');
        publication = { path: bundlePath, expected_manifest_sha256: bundle.manifest_sha256 };
      }
      // Parent import and successful publication are one state transition. A
      // cancellation that wins first prevents import; once import starts,
      // completion wins so a late cancel cannot orphan the imported session.
      await this.transition(async () => {
        const current = await this.read(job.job_id);
        if (current.status !== 'running' || current.attempt !== job.attempt || this.closing)
          fail('JOB_CANCELLED', 'Worker result cannot publish after cancellation or shutdown');
        if (publication) {
          const imported = await this.bridge.request('import_session_bundle', publication);
          const workerSessionId = result.session_id;
          Object.assign(result, imported, { worker_session_id: workerSessionId });
        }
        current.stage = 'Complete';
        current.result = result;
        current.status = 'succeeded';
        await this.save(current);
      });
    } catch (error) {
      await this.transition(async () => {
        const current = await this.read(job.job_id).catch(() => undefined);
        if (current?.status === 'running' && current.attempt === job.attempt) {
          current.status = this.closing ? 'interrupted' : 'failed';
          current.stage = 'Stopped';
          current.error = error instanceof Error ? error.message : String(error);
          await this.save(current);
        }
      });
    } finally {
      await worker.close();
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.active) {
      await this.active.worker.close();
      await this.active.completion;
    }
  }
}
