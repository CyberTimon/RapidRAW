import { Cubit } from '@blac/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Progress } from '../components/ui/AppProperties';

export interface IndexingState {
  isIndexing: boolean;
  progress: Progress;
}

const INITIAL_STATE: IndexingState = {
  isIndexing: false,
  progress: { current: 0, total: 0 },
};

export class IndexingCubit extends Cubit<IndexingState> {
  private unlistenFns: UnlistenFn[] = [];
  private onIndexingFinished?: () => void;
  private listenersSetup = false;

  constructor() {
    super(INITIAL_STATE);
  }

  setOnIndexingFinished = (callback: () => void) => {
    this.onIndexingFinished = callback;
  };

  setupEventListeners = async () => {
    if (this.listenersSetup) return;
    this.listenersSetup = true;

    const unlistenStarted = await listen('indexing-started', () => {
      this.patch({ isIndexing: true, progress: { current: 0, total: 0 } });
    });

    const unlistenProgress = await listen('indexing-progress', (event: any) => {
      this.patch({ progress: event.payload });
    });

    const unlistenFinished = await listen('indexing-finished', () => {
      this.patch({ isIndexing: false, progress: { current: 0, total: 0 } });
      this.onIndexingFinished?.();
    });

    this.unlistenFns = [unlistenStarted, unlistenProgress, unlistenFinished];
  };

  dispose = () => {
    this.unlistenFns.forEach(fn => fn());
    this.unlistenFns = [];
    this.listenersSetup = false;
  };

  setIsIndexing = (indexing: boolean) => {
    this.patch({ isIndexing: indexing });
  };

  setProgress = (progress: Progress) => {
    this.patch({ progress });
  };

  updateProgress = (current: number, total: number) => {
    this.patch({
      isIndexing: current < total,
      progress: { current, total },
    });
  };

  startIndexing = (total: number) => {
    this.patch({
      isIndexing: true,
      progress: { current: 0, total },
    });
  };

  finishIndexing = () => {
    this.patch({
      isIndexing: false,
      progress: { current: this.state.progress.total, total: this.state.progress.total },
    });
  };

  reset = () => {
    this.emit(INITIAL_STATE);
  };
}
