import { Blac, Cubit } from '@blac/core';
import type { HistogramData, WaveformData } from '../../types/editor.js';
import { TauriService } from '../services/TauriService';
import { AdjustmentsBloc } from './AdjustmentsBloc';

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
}

function revokeBlobUrl(url: string | null): void {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export class PreviewBloc extends Cubit<PreviewState> {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 100;

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
    });
  }

  setPreviewUrl = (url: string | null) => {
    revokeBlobUrl(this.state.previewUrl);
    this.patch({ previewUrl: url });
  };

  setOriginalUrl = (url: string | null) => {
    revokeBlobUrl(this.state.originalUrl);
    this.patch({ originalUrl: url });
  };

  requestPreview = (immediate = false) => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (immediate) {
      this.generatePreview();
    } else {
      this.debounceTimer = setTimeout(() => {
        this.generatePreview();
        this.debounceTimer = null;
      }, this.debounceMs);
    }
  };

  private generatePreview = async () => {
    this.patch({ isGenerating: true, error: null });

    try {
      const tauri = Blac.getBloc(TauriService);
      const adjustmentsBloc = Blac.getBloc(AdjustmentsBloc);
      const startTime = Date.now();

      await tauri.applyAdjustments(adjustmentsBloc.current);

      this.patch({
        isGenerating: false,
        lastRenderTime: Date.now() - startTime,
      });
    } catch (error) {
      this.patch({
        isGenerating: false,
        error: `Preview generation failed: ${error}`,
      });
    }
  };

  requestHistogram = async () => {
    this.patch({ isHistogramLoading: true });

    try {
      const tauri = Blac.getBloc(TauriService);
      const adjustmentsBloc = Blac.getBloc(AdjustmentsBloc);
      await tauri.applyAdjustments(adjustmentsBloc.current);
      this.patch({ isHistogramLoading: false });
    } catch {
      this.patch({ isHistogramLoading: false });
    }
  };

  requestWaveform = async () => {
    this.patch({ isWaveformLoading: true });

    try {
      const tauri = Blac.getBloc(TauriService);
      const adjustmentsBloc = Blac.getBloc(AdjustmentsBloc);
      await tauri.applyAdjustments(adjustmentsBloc.current);
      this.patch({ isWaveformLoading: false });
    } catch {
      this.patch({ isWaveformLoading: false });
    }
  };

  setHistogram = (data: HistogramData) => {
    this.patch({ histogramData: data });
  };

  setWaveform = (data: WaveformData) => {
    this.patch({ waveformData: data });
  };

  setRenderQuality = (quality: 'preview' | 'full') => {
    this.patch({ renderQuality: quality });
    this.requestPreview(true);
  };

  setDebounceMs = (ms: number) => {
    this.debounceMs = Math.max(0, ms);
  };

  clearPreview = () => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

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
    return (
      this.state.isGenerating ||
      this.state.isHistogramLoading ||
      this.state.isWaveformLoading
    );
  }
}
