import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';
import { ExportSettings, Status } from '../components/ui/ExportImportProperties';
import { useProcessStore } from './useProcessStore';

export interface ExportRequest {
  paths: string[];
  outputFolderOrFile: string;
  isExplicitFilePath: boolean;
  baseOriginFolders: string[];
  exportSettings: ExportSettings;
  outputFormat: string;
  currentEditPath: string | null;
  currentEditAdjustments: unknown;
}

export interface ExportJob {
  id: string;
  request: ExportRequest;
  status: Status | 'queued';
  current: number;
  path?: string;
  error: string;
}

interface ExportQueueState {
  jobs: ExportJob[];
  activeId: string | null;
  enqueue: (request: ExportRequest) => void;
  cancel: (id: string) => Promise<void>;
  dismiss: (id: string) => void;
}

const terminal = (status: Status) => [Status.Success, Status.Error, Status.Cancelled].includes(status);
const busy = (status: Status) => [Status.Exporting, Status.Cancelling].includes(status);

export const useExportQueueStore = create<ExportQueueState>((set, get) => ({
  jobs: [],
  activeId: null,
  enqueue: (request) => {
    const job: ExportJob = {
      id: crypto.randomUUID(),
      request: structuredClone(request),
      status: 'queued',
      current: 0,
      error: '',
    };
    set({ jobs: [...get().jobs, job] });
    pump();
  },
  cancel: async (id) => {
    const job = get().jobs.find((entry) => entry.id === id);
    if (!job) return;
    if (job.status === 'queued') {
      set({ jobs: get().jobs.map((entry) => (entry.id === id ? { ...entry, status: Status.Cancelled } : entry)) });
    } else if (get().activeId === id && job.status === Status.Exporting) {
      useProcessStore.getState().setExportState({ status: Status.Cancelling });
      try {
        await invoke(Invokes.CancelExport);
      } catch (error) {
        if (get().activeId !== id) return;
        useProcessStore.getState().setExportState({ status: Status.Exporting });
        set({ jobs: get().jobs.map((entry) => (entry.id === id ? { ...entry, error: String(error) } : entry)) });
      }
    }
  },
  dismiss: (id) =>
    set({ jobs: get().jobs.filter((job) => job.id !== id || job.status === 'queued' || busy(job.status)) }),
}));

function pump() {
  const queue = useExportQueueStore.getState();
  if (queue.activeId || busy(useProcessStore.getState().exportState.status)) return;
  const job = queue.jobs.find((entry) => entry.status === 'queued');
  if (!job) return;
  useExportQueueStore.setState({
    activeId: job.id,
    jobs: queue.jobs.map((entry) => (entry.id === job.id ? { ...entry, status: Status.Exporting } : entry)),
  });
  useProcessStore.getState().setExportState({
    status: Status.Exporting,
    progress: { current: 0, total: job.request.paths.length },
    errorMessage: '',
  });
  void invoke(Invokes.ExportImages, { ...job.request }).catch((error: unknown) => {
    if (useExportQueueStore.getState().activeId === job.id) {
      useProcessStore.getState().setExportState({ status: Status.Error, errorMessage: String(error) });
    }
  });
}

// App-level events remain the authority: invoke resolves when workers start, not when they finish.
useProcessStore.subscribe((state, previous) => {
  if (state.exportState === previous.exportState) return;
  const queue = useExportQueueStore.getState();
  const { status, progress, errorMessage } = state.exportState;
  if (queue.activeId) {
    useExportQueueStore.setState({
      activeId: terminal(status) ? null : queue.activeId,
      jobs: queue.jobs.map((job) =>
        job.id === queue.activeId
          ? {
              ...job,
              status,
              current: Math.max(job.current, progress.current),
              path: (progress as { path?: string }).path || job.path,
              error: errorMessage,
            }
          : job,
      ),
    });
  }
  if (terminal(status)) queueMicrotask(pump);
});
