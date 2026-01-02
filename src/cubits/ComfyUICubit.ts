import { Cubit, blac } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Invokes } from '../components/ui/AppProperties';

export interface ComfyUIState {
  isConnected: boolean;
  isGenerating: boolean;
  modelDownloadStatus: string | null;
}

const INITIAL_STATE: ComfyUIState = {
  isConnected: false,
  isGenerating: false,
  modelDownloadStatus: null,
};

@blac({ keepAlive: true })
export class ComfyUICubit extends Cubit<ComfyUIState> {
  private unlistenFns: UnlistenFn[] = [];
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super(INITIAL_STATE);
    this.init();

    this.onSystemEvent('dispose', () => {
      this.cleanup();
    });
  }

  private init = async () => {
    const unlistenStatus = await listen('comfyui-status-update', (event: any) => {
      this.patch({ isConnected: event.payload.connected });
    });

    const unlistenDownloadStart = await listen('ai-model-download-start', (event: any) => {
      this.patch({ modelDownloadStatus: event.payload });
    });

    const unlistenDownloadFinish = await listen('ai-model-download-finish', () => {
      this.patch({ modelDownloadStatus: null });
    });

    this.unlistenFns = [unlistenStatus, unlistenDownloadStart, unlistenDownloadFinish];

    invoke(Invokes.CheckComfyuiStatus).catch(console.error);

    this.pollInterval = setInterval(() => {
      invoke(Invokes.CheckComfyuiStatus).catch(console.error);
    }, 3000);
  };

  private cleanup = () => {
    this.unlistenFns.forEach((fn) => fn());
    this.unlistenFns = [];
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  };

  setIsConnected = (connected: boolean) => {
    this.patch({ isConnected: connected });
  };

  setIsGenerating = (generating: boolean) => {
    this.patch({ isGenerating: generating });
  };

  setModelDownloadStatus = (status: string | null) => {
    this.patch({ modelDownloadStatus: status });
  };

  startGenerating = () => {
    this.patch({ isGenerating: true });
  };

  stopGenerating = () => {
    this.patch({ isGenerating: false });
  };
}
