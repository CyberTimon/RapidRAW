import { Cubit } from '@blac/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Progress } from '../components/ui/AppProperties';

export const EXPORT_TIMEOUT = 4000;
export const IMPORT_TIMEOUT = 5000;

export enum Status {
  Cancelled = 'cancelled',
  Exporting = 'exporting',
  Error = 'error',
  Idle = 'idle',
  Importing = 'importing',
  Success = 'success',
}

export interface ExportState {
  errorMessage: string;
  progress: Progress;
  status: Status;
}

export interface ImportState {
  errorMessage: string;
  path: string;
  progress: Progress;
  status: Status;
}

export interface ExportImportState {
  export: ExportState;
  import: ImportState;
}

const INITIAL_EXPORT_STATE: ExportState = {
  errorMessage: '',
  progress: { current: 0, total: 0 },
  status: Status.Idle,
};

const INITIAL_IMPORT_STATE: ImportState = {
  errorMessage: '',
  path: '',
  progress: { current: 0, total: 0 },
  status: Status.Idle,
};

export class ExportImportCubit extends Cubit<ExportImportState> {
  private unlistenFns: UnlistenFn[] = [];
  private listenersSetup = false;
  private onImportComplete?: () => void;

  constructor() {
    super({
      export: INITIAL_EXPORT_STATE,
      import: INITIAL_IMPORT_STATE,
    });
  }

  setOnImportComplete = (callback: () => void) => {
    this.onImportComplete = callback;
  };

  setupEventListeners = async () => {
    if (this.listenersSetup) return;
    this.listenersSetup = true;

    const listeners = await Promise.all([
      listen('batch-export-progress', (event: any) => {
        this.setExportState({ progress: event.payload });
      }),
      listen('export-complete', () => {
        this.setExportState({ status: Status.Success });
      }),
      listen('export-error', (event: any) => {
        this.setExportState({
          status: Status.Error,
          errorMessage: typeof event.payload === 'string' ? event.payload : 'An unknown export error occurred.',
        });
      }),
      listen('export-cancelled', () => {
        this.setExportState({ status: Status.Cancelled });
      }),
      listen('import-start', (event: any) => {
        this.setImportState({
          errorMessage: '',
          path: '',
          progress: { current: 0, total: event.payload.total },
          status: Status.Importing,
        });
      }),
      listen('import-progress', (event: any) => {
        this.setImportState({
          path: event.payload.path,
          progress: { current: event.payload.current, total: event.payload.total },
        });
      }),
      listen('import-complete', () => {
        this.setImportState({ status: Status.Success });
        this.onImportComplete?.();
      }),
      listen('import-error', (event: any) => {
        this.setImportState({
          errorMessage: typeof event.payload === 'string' ? event.payload : 'An unknown import error occurred.',
          status: Status.Error,
        });
      }),
    ]);

    this.unlistenFns = listeners;
  };

  dispose = () => {
    this.unlistenFns.forEach(fn => fn());
    this.unlistenFns = [];
    this.listenersSetup = false;
  };

  setExportState = (exportState: Partial<ExportState>) => {
    this.patch({
      export: { ...this.state.export, ...exportState },
    });
  };

  setImportState = (importState: Partial<ImportState>) => {
    this.patch({
      import: { ...this.state.import, ...importState },
    });
  };

  setExportStatus = (status: Status) => {
    this.setExportState({ status });
  };

  setImportStatus = (status: Status) => {
    this.setImportState({ status });
  };

  setExportProgress = (progress: Progress) => {
    this.setExportState({ progress });
  };

  setImportProgress = (progress: Progress) => {
    this.setImportState({ progress });
  };

  setExportError = (errorMessage: string) => {
    this.setExportState({ errorMessage, status: Status.Error });
  };

  setImportError = (errorMessage: string) => {
    this.setImportState({ errorMessage, status: Status.Error });
  };

  resetExport = () => {
    this.patch({ export: INITIAL_EXPORT_STATE });
  };

  resetImport = () => {
    this.patch({ import: INITIAL_IMPORT_STATE });
  };

  reset = () => {
    this.emit({
      export: INITIAL_EXPORT_STATE,
      import: INITIAL_IMPORT_STATE,
    });
  };
}
