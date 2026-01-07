import { Cubit, borrow, borrowSafe, globalRegistry } from '@blac/core';
import type { HistogramData, WaveformData } from '../../types/editor.js';
import { TauriService } from '../services/TauriService';
import { AdjustmentsBloc } from './AdjustmentsBloc';
import { EditorBloc } from './EditorBloc';

interface PreviewState {
  previewUrl: string | null;
  originalUrl: string | null;
  histogramData: HistogramData | null;
  waveformData: WaveformData | null;
  isGenerating: boolean;
  isHistogramLoading: boolean;
  isWaveformLoading: boolean;
  renderQuality: 'preview' | 'full';
  lastRenderTime: number | null;
  error: string | null;
  viewportWidth: number | null;
  isViewportReady: boolean;
}

function revokeBlobUrl(url: string | null): void {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export class PreviewBloc extends Cubit<PreviewState> {
  private isRunning = false;
  private hasPending = false;
  private previewResolver: (() => void) | null = null;

  constructor() {
    super({
      previewUrl: null,
      originalUrl: null,
      histogramData: null,
      waveformData: null,
      isGenerating: false,
      isHistogramLoading: false,
      isWaveformLoading: false,
      renderQuality: 'preview',
      lastRenderTime: null,
      error: null,
      viewportWidth: null,
      isViewportReady: false,
    });

    globalRegistry.on('stateChanged', (container) => {
      if (container instanceof AdjustmentsBloc || container instanceof EditorBloc) {
        const editorResult = borrowSafe(EditorBloc);
        if (!editorResult.error && editorResult.instance.state.selectedImage) {
          this.schedulePreview();
        }
      }
    });
  }

  private schedulePreview = () => {
    if (this.isRunning) {
      this.hasPending = true;
      return;
    }
    this.runPreview();
  };

  private runPreview = async () => {
    this.isRunning = true;
    this.hasPending = false;

    await this.generatePreview();

    this.isRunning = false;

    if (this.hasPending) {
      this.hasPending = false;
      this.runPreview();
    }
  };

  setPreviewUrl = (url: string | null) => {
    revokeBlobUrl(this.state.previewUrl);
    this.patch({ previewUrl: url });

    if (this.previewResolver) {
      this.previewResolver();
      this.previewResolver = null;
    }
  };

  setOriginalUrl = (url: string | null) => {
    revokeBlobUrl(this.state.originalUrl);
    this.patch({ originalUrl: url });
  };

  setViewportWidth = (width: number) => {
    const wasReady = this.state.isViewportReady;
    this.patch({ viewportWidth: width, isViewportReady: true });
    if (!wasReady) {
      this.schedulePreview();
    }
  };

  requestPreview = () => {
    this.schedulePreview();
  };

  private generatePreview = async () => {
    if (!this.state.isViewportReady || this.state.viewportWidth === null) {
      return;
    }

    const editorResult = borrowSafe(EditorBloc);
    if (editorResult.error || !editorResult.instance.state.selectedImage) {
      return;
    }

    this.patch({ isGenerating: true, error: null });

    try {
      const tauri = borrow(TauriService);
      const adjustmentsBloc = borrow(AdjustmentsBloc);
      const startTime = Date.now();

      const previewPromise = new Promise<void>((resolve) => {
        this.previewResolver = resolve;
      });

      await tauri.applyAdjustments(adjustmentsBloc.current, this.state.viewportWidth);
      await previewPromise;

      this.patch({
        isGenerating: false,
        isHistogramLoading: false,
        isWaveformLoading: false,
        lastRenderTime: Date.now() - startTime,
      });
    } catch (error) {
      this.previewResolver = null;
      this.patch({
        isGenerating: false,
        isHistogramLoading: false,
        isWaveformLoading: false,
        error: `Preview generation failed: ${error}`,
      });
    }
  };

  requestHistogram = () => {
    this.patch({ isHistogramLoading: true });
    this.schedulePreview();
  };

  requestWaveform = () => {
    this.patch({ isWaveformLoading: true });
    this.schedulePreview();
  };

  setHistogram = (data: HistogramData) => {
    this.patch({ histogramData: data });
  };

  setWaveform = (data: WaveformData) => {
    this.patch({ waveformData: data });
  };

  setRenderQuality = (quality: 'preview' | 'full') => {
    this.patch({ renderQuality: quality });
    this.schedulePreview();
  };

  clearPreview = () => {
    revokeBlobUrl(this.state.previewUrl);
    revokeBlobUrl(this.state.originalUrl);

    this.emit({
      previewUrl: null,
      originalUrl: null,
      histogramData: null,
      waveformData: null,
      isGenerating: false,
      isHistogramLoading: false,
      isWaveformLoading: false,
      renderQuality: 'preview',
      lastRenderTime: null,
      error: null,
      viewportWidth: this.state.viewportWidth,
      isViewportReady: this.state.isViewportReady,
    });
  };

  clearError = () => {
    this.patch({ error: null });
  };

  get hasPreview(): boolean {
    return this.state.previewUrl !== null;
  }

  get hasHistogram(): boolean {
    return this.state.histogramData !== null;
  }

  get hasWaveform(): boolean {
    return this.state.waveformData !== null;
  }

  get isLoading(): boolean {
    return this.state.isGenerating || this.state.isHistogramLoading || this.state.isWaveformLoading;
  }
}
