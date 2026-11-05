import { create } from 'zustand';
import { Progress } from '../components/ui/AppProperties';
import { ExportState, ImportState, Status } from '../components/ui/ExportImportProperties';

export interface ExternalEditSession {
  source: string;
  output: string;
  format: string;
  jpegQuality: number;
}

export interface AiTask {
  id: string;
  type: string;
}

export type AiJobKind =
  | 'denoise'
  | 'depthMap'
  | 'normalMap'
  | 'foregroundMask'
  | 'skyMask'
  | 'textMask'
  | 'faceMask'
  | 'depthMask'
  | 'subjectMask';

export interface AiJobsStatus {
  current: { path: string; kind: AiJobKind; maskName: string | null } | null;
  queued: number;
  completed: number;
  paused: boolean;
  failed: Array<{ path: string; error: string }>;
}

export enum JobKind {
  AiTagging = 'aiTagging',
  Copy = 'copy',
  Export = 'export',
  Import = 'import',
  ModelDownload = 'modelDownload',
  Move = 'move',
}

export enum JobStatus {
  Cancelled = 'cancelled',
  Cancelling = 'cancelling',
  Error = 'error',
  Running = 'running',
  Success = 'success',
}

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: Progress;
  detail: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export type JobUpdate = Partial<Pick<Job, 'status' | 'progress' | 'detail' | 'error'>>;

export const isJobActive = (status: JobStatus) => status === JobStatus.Running || status === JobStatus.Cancelling;

const findActiveJob = (jobs: Record<string, Job>, kind: JobKind) =>
  Object.values(jobs).find((job) => job.kind === kind && isJobActive(job.status));

export const selectAiTaggingJob = (state: ProcessState) => findActiveJob(state.jobs, JobKind.AiTagging) ?? null;

export const selectAiModelDownloadStatus = (state: ProcessState) => {
  const job = findActiveJob(state.jobs, JobKind.ModelDownload);
  if (!job?.detail) return null;
  const { current, total } = job.progress;
  return current !== undefined && total > 0 ? `${job.detail} · ${Math.round((current / total) * 100)}%` : job.detail;
};

interface ProcessState {
  exportState: ExportState;
  importState: ImportState;
  thumbnails: Record<string, string>;
  mediumThumbnails: Record<string, string>;
  thumbnailProgress: Progress;
  previews: Record<string, { url: string; thumbKey: string; timestamp: number }>;
  copiedFilePaths: Array<string>;
  isCopied: boolean;
  isPasted: boolean;
  initialFileToOpen: string | null;
  externalEditSession: ExternalEditSession | null;
  activeAiTasks: Record<string, AiTask>;
  aiJobs: AiJobsStatus;
  aiPendingPaths: Record<string, true>;
  jobs: Record<string, Job>;
  jobsSeenAt: number;

  setProcess: (state: Partial<ProcessState> | ((state: ProcessState) => Partial<ProcessState>)) => void;
  setExportState: (updater: Partial<ExportState> | ((state: ExportState) => Partial<ExportState>)) => void;
  setImportState: (updater: Partial<ImportState> | ((state: ImportState) => Partial<ImportState>)) => void;
  setPreview: (path: string, url: string, thumbKey: string) => void;
  clearPreviews: () => void;
  registerAiTask: (id: string, type: string) => void;
  unregisterAiTask: (id: string) => void;
  isAiTaskRunning: (id: string) => boolean;
  startJob: (kind: JobKind, update?: JobUpdate) => string;
  updateJob: (id: string, update: JobUpdate) => void;
  removeJob: (id: string) => void;
  clearFinishedJobs: () => void;
  runJob: <T>(kind: JobKind, update: JobUpdate, task: () => Promise<T>) => Promise<T>;
  markJobsSeen: () => void;
}

let exportTimeout: ReturnType<typeof setTimeout>;
let importTimeout: ReturnType<typeof setTimeout>;
let copyTimeout: ReturnType<typeof setTimeout>;
let pasteTimeout: ReturnType<typeof setTimeout>;
let exportJobId: string | null = null;
let importJobId: string | null = null;
let jobCounter = 0;

const MAX_PREVIEW_CACHE_SIZE = 10;
const MAX_FINISHED_JOBS = 10;

const JOB_STATUSES: Partial<Record<Status, JobStatus>> = {
  [Status.Exporting]: JobStatus.Running,
  [Status.Importing]: JobStatus.Running,
  [Status.Cancelling]: JobStatus.Cancelling,
  [Status.Success]: JobStatus.Success,
  [Status.Error]: JobStatus.Error,
  [Status.Cancelled]: JobStatus.Cancelled,
};

const pruneFinishedJobs = (jobs: Record<string, Job>) => {
  const expired = Object.values(jobs)
    .filter((job) => job.finishedAt !== null)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(MAX_FINISHED_JOBS);
  if (expired.length === 0) return jobs;
  const next = { ...jobs };
  expired.forEach((job) => delete next[job.id]);
  return next;
};

const syncStatusJob = (
  kind: JobKind,
  jobId: string | null,
  previousStatus: Status,
  { status, progress, errorMessage, destination }: ExportState | ImportState,
) => {
  const jobStatus = JOB_STATUSES[status];
  if (!jobStatus) return jobId;

  const { jobs, startJob, updateJob } = useProcessStore.getState();
  const update = {
    status: jobStatus,
    progress: progress ?? { current: 0, total: 0 },
    error: errorMessage || null,
    detail: destination ?? null,
  };
  const job = jobId ? jobs[jobId] : undefined;
  if (jobId && job && isJobActive(job.status)) {
    updateJob(jobId, update);
    return jobId;
  }
  return previousStatus === status ? jobId : startJob(kind, update);
};

export const useProcessStore = create<ProcessState>((set, get) => ({
  exportState: { errorMessage: '', progress: { current: 0, total: 0 }, status: Status.Idle },
  importState: { errorMessage: '', path: '', progress: { current: 0, total: 0 }, status: Status.Idle },
  thumbnails: {},
  mediumThumbnails: {},
  thumbnailProgress: { current: 0, total: 0 },
  previews: {},
  copiedFilePaths: [],
  isCopied: false,
  isPasted: false,
  initialFileToOpen: null,
  externalEditSession: null,
  activeAiTasks: {},
  aiJobs: { current: null, queued: 0, completed: 0, paused: false, failed: [] },
  aiPendingPaths: {},
  jobs: {},
  jobsSeenAt: Date.now(),

  setProcess: (updater) => {
    let nextState: Partial<ProcessState> = {};
    set((prev) => {
      nextState = typeof updater === 'function' ? updater(prev) : updater;
      return nextState;
    });

    if (nextState.isCopied) {
      clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => set({ isCopied: false }), 1000);
    }
    if (nextState.isPasted) {
      clearTimeout(pasteTimeout);
      pasteTimeout = setTimeout(() => set({ isPasted: false }), 1000);
    }
  },

  setExportState: (updater) => {
    const previousStatus = get().exportState.status;
    set((prev) => ({
      exportState: { ...prev.exportState, ...(typeof updater === 'function' ? updater(prev.exportState) : updater) },
    }));

    const status = get().exportState.status;
    exportJobId = syncStatusJob(JobKind.Export, exportJobId, previousStatus, get().exportState);

    clearTimeout(exportTimeout);

    if ([Status.Success, Status.Error, Status.Cancelled].includes(status)) {
      exportTimeout = setTimeout(() => {
        set((prev) => ({
          exportState: {
            ...prev.exportState,
            status: Status.Idle,
            errorMessage: '',
            progress: { current: 0, total: 0 },
          },
        }));
      }, 5000);
    }
  },

  setImportState: (updater) => {
    const previousStatus = get().importState.status;
    set((prev) => ({
      importState: { ...prev.importState, ...(typeof updater === 'function' ? updater(prev.importState) : updater) },
    }));

    const status = get().importState.status;
    importJobId = syncStatusJob(JobKind.Import, importJobId, previousStatus, get().importState);

    clearTimeout(importTimeout);

    if ([Status.Success, Status.Error, Status.Cancelled].includes(status)) {
      importTimeout = setTimeout(() => {
        set((prev) => ({
          importState: {
            ...prev.importState,
            status: Status.Idle,
            errorMessage: '',
            progress: { current: 0, total: 0 },
          },
        }));
      }, 5000);
    }
  },

  setPreview: (path, url, thumbKey) => {
    set((state) => {
      const newPreviews = { ...state.previews };

      if (newPreviews[path] && newPreviews[path].url !== url) {
        URL.revokeObjectURL(newPreviews[path].url);
      }

      newPreviews[path] = { url, thumbKey, timestamp: Date.now() };

      const keys = Object.keys(newPreviews);
      if (keys.length > MAX_PREVIEW_CACHE_SIZE) {
        let oldestPath = keys[0];
        let oldestTime = newPreviews[oldestPath].timestamp;

        for (let i = 1; i < keys.length; i++) {
          const key = keys[i];
          if (newPreviews[key].timestamp < oldestTime) {
            oldestTime = newPreviews[key].timestamp;
            oldestPath = key;
          }
        }

        if (oldestPath !== path) {
          URL.revokeObjectURL(newPreviews[oldestPath].url);
          delete newPreviews[oldestPath];
        }
      }

      return { previews: newPreviews };
    });
  },

  clearPreviews: () => {
    set((state) => {
      Object.values(state.previews).forEach((p) => URL.revokeObjectURL(p.url));
      return { previews: {} };
    });
  },

  registerAiTask: (id, type) =>
    set((state) => ({
      activeAiTasks: { ...state.activeAiTasks, [id]: { id, type } },
    })),

  unregisterAiTask: (id) =>
    set((state) => {
      const next = { ...state.activeAiTasks };
      delete next[id];
      return { activeAiTasks: next };
    }),

  isAiTaskRunning: (id) => !!get().activeAiTasks[id],

  startJob: (kind, update = {}) => {
    const id = `${kind}-${++jobCounter}`;
    set((state) => ({
      jobs: {
        ...state.jobs,
        [id]: {
          id,
          kind,
          status: JobStatus.Running,
          progress: { current: 0, total: 0 },
          detail: null,
          error: null,
          startedAt: Date.now(),
          finishedAt: null,
        },
      },
    }));
    get().updateJob(id, update);
    return id;
  },

  updateJob: (id, update) =>
    set((state) => {
      const job = state.jobs[id];
      if (!job) return {};

      const next = { ...job, ...update };
      if (next.status === JobStatus.Success) {
        next.progress = { ...next.progress, current: next.progress.total };
      }
      next.finishedAt = isJobActive(next.status) ? null : (job.finishedAt ?? Date.now());
      return { jobs: pruneFinishedJobs({ ...state.jobs, [id]: next }) };
    }),

  removeJob: (id) =>
    set((state) => {
      if (!state.jobs[id]) return {};
      const { [id]: _, ...jobs } = state.jobs;
      return { jobs };
    }),

  clearFinishedJobs: () =>
    set((state) => ({
      jobs: Object.fromEntries(Object.entries(state.jobs).filter(([, job]) => isJobActive(job.status))),
    })),

  runJob: async (kind, update, task) => {
    const id = get().startJob(kind, update);
    try {
      const result = await task();
      get().updateJob(id, { status: JobStatus.Success });
      return result;
    } catch (err) {
      get().updateJob(id, { status: JobStatus.Error, error: String(err) });
      throw err;
    }
  },

  markJobsSeen: () => set({ jobsSeenAt: Date.now() }),
}));
