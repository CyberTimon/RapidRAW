import { create } from 'zustand';

interface SyncJob {
  total: number;
  completed: number;
  status: 'queued' | 'running' | 'complete' | 'failed';
}

interface SyncProgressState {
  jobs: Record<string, SyncJob>;
  enqueue: (id: string, total: number) => void;
  start: (id: string) => void;
  advance: (id: string, completed: number) => void;
  finish: (id: string, failed?: boolean) => void;
  dismiss: () => void;
}

export const useSyncProgressStore = create<SyncProgressState>((set) => ({
  jobs: {},
  enqueue: (id, total) =>
    set((state) => {
      const active = Object.values(state.jobs).some((job) => job.status === 'queued' || job.status === 'running');
      return { jobs: { ...(active ? state.jobs : {}), [id]: { total, completed: 0, status: 'queued' } } };
    }),
  start: (id) =>
    set((state) => ({
      jobs: { ...state.jobs, [id]: { ...state.jobs[id], status: 'running' } },
    })),
  advance: (id, completed) =>
    set((state) => {
      const job = state.jobs[id];
      if (!job || job.status !== 'running') return state;
      return {
        jobs: { ...state.jobs, [id]: { ...job, completed: Math.min(job.total, Math.max(job.completed, completed)) } },
      };
    }),
  finish: (id, failed = false) =>
    set((state) => {
      const job = state.jobs[id];
      if (!job) return state;
      return {
        jobs: {
          ...state.jobs,
          [id]: {
            ...job,
            status: failed ? 'failed' : 'complete',
            completed: failed ? job.completed : job.total,
          },
        },
      };
    }),
  dismiss: () =>
    set((state) =>
      Object.values(state.jobs).some((job) => job.status === 'running' || job.status === 'queued')
        ? state
        : { jobs: {} },
    ),
}));
